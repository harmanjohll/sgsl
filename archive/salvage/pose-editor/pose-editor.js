/* ============================================================
   SgSL Pose Editor
   ============================================================
   Authoring UI for "curated" signs (schema v3). The editor:

   - Loads Mei (reuses SMPLXAvatar).
   - Exposes per-bone XYZ sliders (degrees) for the bones a
     signer cares about: arms + hands + neck + chest. Sliders
     drive the bone's local quaternion directly. No retargeting.
   - Lets the author set a time t (ms) and snapshot the current
     bone state as a keyframe.
   - Plays back the keyframe sequence using the same slerp
     interpolation the viewer uses, so what you see here is what
     ships.
   - Saves to /api/sign/curated.

   Curated signs play back via the player.js curated branch and
   bypass the retargeter entirely — that's the whole point.
   ============================================================ */

import { SMPLXAvatar } from './avatar.js';

// Bones the editor exposes, grouped for the UI. PascalCase here
// matches the backend's REQUIRED_CURATED_BONES check and the
// player's quaternion writer. Required-by-backend bones live in
// "Arms" and "Hands"; everything else is optional but useful for
// SgSL hand-shape configuration (the "and" sign and similar).
const BONE_GROUPS = [
  {
    id: 'arms', label: 'Arms', defaultOpen: true,
    bones: ['RightUpperArm', 'LeftUpperArm', 'RightLowerArm', 'LeftLowerArm'],
  },
  {
    id: 'hands', label: 'Wrists', defaultOpen: true,
    bones: ['RightHand', 'LeftHand'],
  },
  {
    id: 'fingers_r', label: 'Right hand fingers', defaultOpen: false,
    bones: [
      'RightThumbProximal',  'RightThumbIntermediate',  'RightThumbDistal',
      'RightIndexProximal',  'RightIndexIntermediate',  'RightIndexDistal',
      'RightMiddleProximal', 'RightMiddleIntermediate', 'RightMiddleDistal',
      'RightRingProximal',   'RightRingIntermediate',   'RightRingDistal',
      'RightLittleProximal', 'RightLittleIntermediate', 'RightLittleDistal',
    ],
  },
  {
    id: 'fingers_l', label: 'Left hand fingers', defaultOpen: false,
    bones: [
      'LeftThumbProximal',  'LeftThumbIntermediate',  'LeftThumbDistal',
      'LeftIndexProximal',  'LeftIndexIntermediate',  'LeftIndexDistal',
      'LeftMiddleProximal', 'LeftMiddleIntermediate', 'LeftMiddleDistal',
      'LeftRingProximal',   'LeftRingIntermediate',   'LeftRingDistal',
      'LeftLittleProximal', 'LeftLittleIntermediate', 'LeftLittleDistal',
    ],
  },
  {
    id: 'torso', label: 'Torso & neck', defaultOpen: false,
    bones: ['Neck', 'Chest', 'Spine'],
  },
];

// Flat list of every editable bone, derived from the groups above.
// Exported for save/load + reset/mirror operations that need a
// single linear bone roster.
const EDITABLE_BONES = BONE_GROUPS.flatMap(g => g.bones);

// Mirror pairs for the "Mirror L↔R" quick action. Right→Left only;
// invoking the action copies right-side rotation to left side with
// the appropriate axis flip. Includes fingers.
const MIRROR_PAIRS = [
  ['RightUpperArm', 'LeftUpperArm'],
  ['RightLowerArm', 'LeftLowerArm'],
  ['RightHand',     'LeftHand'],
];
for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
  for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
    MIRROR_PAIRS.push([`Right${finger}${seg}`, `Left${finger}${seg}`]);
  }
}

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

let avatar = null;
let keyframes = [];        // [{ t, bones: { Name: [x,y,z,w] } }]
let activeKfIdx = -1;
let previewing = false;
let previewStart = 0;
let rafId = null;

// ─── UI bootstrap ───────────────────────────────────────────
function init() {
  avatar = new SMPLXAvatar('ed-viewport');

  // Wait for VRM load before building bone controls (the bones
  // need to exist for getBoneNode to work).
  const wait = setInterval(() => {
    if (!avatar.loaded || !avatar.vrm) return;
    clearInterval(wait);
    buildBoneControls();
    setStatus('Ready. Pose Mei, set a t, click "Add keyframe".', 'info');
  }, 100);

  document.getElementById('btn-reset-pose').addEventListener('click', resetToRest);
  document.getElementById('btn-mirror-pose').addEventListener('click', mirrorLR);
  document.getElementById('btn-add-kf').addEventListener('click', addKeyframe);
  document.getElementById('btn-play-preview').addEventListener('click', startPreview);
  document.getElementById('btn-stop-preview').addEventListener('click', stopPreview);
  document.getElementById('btn-load-existing').addEventListener('click', loadExisting);
  document.getElementById('btn-save-curated').addEventListener('click', saveCurated);
}

function buildBoneControls() {
  const container = document.getElementById('bone-controls');
  container.innerHTML = '';

  for (const group of BONE_GROUPS) {
    const groupEl = document.createElement('details');
    groupEl.className = 'bone-group';
    if (group.defaultOpen) groupEl.open = true;
    const summary = document.createElement('summary');
    summary.className = 'bone-group-title';
    summary.textContent = group.label;
    groupEl.appendChild(summary);

    let rendered = 0;
    for (const boneName of group.bones) {
      const node = getBoneNode(boneName);
      if (!node) continue;  // VRM may not have every finger bone — silently skip
      groupEl.appendChild(buildBoneRow(boneName, node));
      rendered++;
    }
    if (rendered === 0) {
      const empty = document.createElement('p');
      empty.className = 'ed-hint';
      empty.textContent = 'No bones in this group on this VRM.';
      groupEl.appendChild(empty);
    }
    container.appendChild(groupEl);
  }
}

function buildBoneRow(boneName, node) {
  const row = document.createElement('div');
  row.className = 'bone-row';
  row.innerHTML = `<div class="bone-name">${boneName}</div>`;

  for (const axis of ['x', 'y', 'z']) {
    const initialDeg = (node.rotation[axis] || 0) * RAD2DEG;
    const axisRow = document.createElement('div');
    axisRow.className = 'bone-axis-row';
    axisRow.innerHTML = `
      <span>${axis.toUpperCase()}</span>
      <input type="range" min="-180" max="180" step="1" value="${initialDeg.toFixed(0)}"
             data-bone="${boneName}" data-axis="${axis}">
      <span class="axis-val">${initialDeg.toFixed(0)}°</span>
    `;
    const input = axisRow.querySelector('input');
    const valEl = axisRow.querySelector('.axis-val');
    input.addEventListener('input', () => {
      const deg = parseFloat(input.value);
      valEl.textContent = `${deg.toFixed(0)}°`;
      const n = getBoneNode(boneName);
      if (!n) return;
      n.rotation[axis] = deg * DEG;
    });
    row.appendChild(axisRow);
  }
  return row;
}

function getBoneNode(boneName) {
  if (!avatar?.vrm) return null;
  const BN = THREE.VRMSchema.HumanoidBoneName;
  return avatar.vrm.humanoid.getBoneNode(BN[boneName]);
}

function getCurrentBoneQuats() {
  const out = {};
  for (const boneName of EDITABLE_BONES) {
    const node = getBoneNode(boneName);
    if (!node) continue;
    const q = node.quaternion;
    out[boneName] = [q.x, q.y, q.z, q.w];
  }
  return out;
}

function setBoneQuats(bonesDict) {
  for (const [name, q] of Object.entries(bonesDict)) {
    const node = getBoneNode(name);
    if (!node || !q || q.length !== 4) continue;
    node.quaternion.set(q[0], q[1], q[2], q[3]);
  }
  syncSlidersFromBones();
}

function syncSlidersFromBones() {
  const inputs = document.querySelectorAll('#bone-controls input[type="range"]');
  for (const input of inputs) {
    const name = input.dataset.bone;
    const axis = input.dataset.axis;
    const node = getBoneNode(name);
    if (!node) continue;
    const deg = (node.rotation[axis] || 0) * RAD2DEG;
    input.value = deg.toFixed(0);
    const valEl = input.parentElement.querySelector('.axis-val');
    if (valEl) valEl.textContent = `${deg.toFixed(0)}°`;
  }
}

// ─── Quick actions ──────────────────────────────────────────
function resetToRest() {
  if (!avatar?.vrm || !avatar._restTargets) return;
  const BN = THREE.VRMSchema.HumanoidBoneName;
  for (const boneName of EDITABLE_BONES) {
    const key = BN[boneName];
    const rest = avatar._restTargets[key];
    const node = avatar.vrm.humanoid.getBoneNode(key);
    if (rest && node) node.quaternion.copy(rest);
  }
  syncSlidersFromBones();
}

function mirrorLR() {
  // Copy each Right* bone's local rotation to its Left* counterpart
  // with Y and Z negated. This mirrors a humanoid limb across the
  // vertical body plane in VRM 0.x rigs (verified empirically on
  // arms — fingers follow the same convention because they're built
  // off the hand bone). Coarse helper; manual cleanup may still be
  // needed for asymmetric thumb poses.
  for (const [r, l] of MIRROR_PAIRS) {
    const rNode = getBoneNode(r);
    const lNode = getBoneNode(l);
    if (!rNode || !lNode) continue;
    const e = new THREE.Euler().setFromQuaternion(rNode.quaternion, 'XYZ');
    lNode.rotation.set(e.x, -e.y, -e.z);
  }
  syncSlidersFromBones();
}

// ─── Keyframes ──────────────────────────────────────────────
function addKeyframe() {
  const t = parseFloat(document.getElementById('ed-t').value || 0);
  if (!Number.isFinite(t) || t < 0) {
    setStatus('Set a non-negative t (ms) before adding a keyframe.', 'error');
    return;
  }

  const bones = getCurrentBoneQuats();

  // If a keyframe at this t already exists, overwrite it.
  const existingIdx = keyframes.findIndex(k => k.t === t);
  if (existingIdx >= 0) {
    keyframes[existingIdx] = { t, bones };
    activeKfIdx = existingIdx;
  } else {
    keyframes.push({ t, bones });
    keyframes.sort((a, b) => a.t - b.t);
    activeKfIdx = keyframes.findIndex(k => k.t === t);
  }
  renderKfList();
  setStatus(`Keyframe @ ${t}ms ${existingIdx >= 0 ? 'updated' : 'added'} (${keyframes.length} total).`, 'success');
}

function renderKfList() {
  const list = document.getElementById('kf-list');
  if (!keyframes.length) {
    list.innerHTML = '<p class="ed-hint">No keyframes yet. Pose Mei, set a t, click "Add keyframe".</p>';
    return;
  }
  list.innerHTML = '';
  keyframes.forEach((kf, i) => {
    const row = document.createElement('div');
    row.className = 'kf-row' + (i === activeKfIdx ? ' active' : '');
    const boneCount = Object.keys(kf.bones).length;
    row.innerHTML = `
      <span class="kf-t">${kf.t}ms</span>
      <span class="kf-meta">${boneCount} bones</span>
      <button class="kf-action" data-act="goto" title="Load this pose into the editor">Go</button>
      <button class="kf-action" data-act="overwrite" title="Overwrite with current pose">Save</button>
      <button class="kf-action" data-act="delete" title="Delete keyframe">×</button>
    `;
    row.querySelector('[data-act="goto"]').addEventListener('click', () => {
      activeKfIdx = i;
      document.getElementById('ed-t').value = kf.t;
      setBoneQuats(kf.bones);
      renderKfList();
    });
    row.querySelector('[data-act="overwrite"]').addEventListener('click', () => {
      keyframes[i] = { t: kf.t, bones: getCurrentBoneQuats() };
      setStatus(`Keyframe @ ${kf.t}ms overwritten.`, 'success');
      renderKfList();
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', () => {
      keyframes.splice(i, 1);
      if (activeKfIdx === i) activeKfIdx = -1;
      renderKfList();
      setStatus('Keyframe deleted.', 'info');
    });
    list.appendChild(row);
  });
}

// ─── Preview playback ───────────────────────────────────────
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function startPreview() {
  if (keyframes.length < 2) {
    setStatus('Need at least 2 keyframes to preview.', 'error');
    return;
  }
  previewing = true;
  previewStart = performance.now();
  if (rafId) cancelAnimationFrame(rafId);
  setStatus('Previewing...', 'info');
  tickPreview();
}

function stopPreview() {
  previewing = false;
  if (rafId) cancelAnimationFrame(rafId);
  setStatus('Preview stopped.', 'info');
}

function tickPreview() {
  if (!previewing) return;
  const tNow = performance.now() - previewStart;
  const last = keyframes[keyframes.length - 1].t;

  if (tNow >= last) {
    applyKeyframeAt(last);
    previewing = false;
    setStatus('Preview complete.', 'success');
    return;
  }
  applyKeyframeAt(tNow);
  rafId = requestAnimationFrame(tickPreview);
}

function applyKeyframeAt(t) {
  if (!keyframes.length) return;
  let i = 0;
  while (i < keyframes.length - 2 && keyframes[i + 1].t <= t) i++;
  const a = keyframes[i];
  const b = keyframes[Math.min(i + 1, keyframes.length - 1)];
  if (a === b || b.t <= a.t) {
    setBoneQuats(a.bones);
    return;
  }
  const u = Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1);
  const allBones = new Set([
    ...Object.keys(a.bones || {}),
    ...Object.keys(b.bones || {}),
  ]);
  for (const bone of allBones) {
    const qa = a.bones?.[bone];
    const qb = b.bones?.[bone];
    const node = getBoneNode(bone);
    if (!node) continue;
    if (qa && qb) {
      _qa.set(qa[0], qa[1], qa[2], qa[3]);
      _qb.set(qb[0], qb[1], qb[2], qb[3]);
      _qa.slerp(_qb, u);
      node.quaternion.copy(_qa);
    } else if (qa) {
      node.quaternion.set(qa[0], qa[1], qa[2], qa[3]);
    } else if (qb) {
      node.quaternion.set(qb[0], qb[1], qb[2], qb[3]);
    }
  }
  syncSlidersFromBones();
}

// ─── Save / load ────────────────────────────────────────────
async function saveCurated() {
  const label = (document.getElementById('ed-label').value || '').trim().toLowerCase();
  if (!label) {
    setStatus('Enter a sign label first.', 'error');
    return;
  }
  if (keyframes.length < 2) {
    setStatus('Need at least 2 keyframes (start + end) to save.', 'error');
    return;
  }

  const duration_ms = keyframes[keyframes.length - 1].t;
  setStatus('Saving...', 'loading');
  try {
    const res = await fetch('/api/sign/curated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, duration_ms, keyframes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Save failed' }));
      throw new Error(err.detail || 'Save failed');
    }
    setStatus(`Saved "${label}" (${keyframes.length} keyframes, ${duration_ms}ms).`, 'success');
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, 'error');
  }
}

async function loadExisting() {
  const label = (document.getElementById('ed-label').value || '').trim().toLowerCase();
  if (!label) {
    setStatus('Enter the label of the existing curated sign to load.', 'error');
    return;
  }
  setStatus('Loading...', 'loading');
  try {
    const res = await fetch(`/api/sign/${label}`);
    if (!res.ok) throw new Error(`Sign "${label}" not found`);
    const data = await res.json();
    if (data.type !== 'curated' && data.schema_version < 3) {
      setStatus(`"${label}" is a recorded sign, not curated — can't edit here.`, 'error');
      return;
    }
    keyframes = (data.keyframes || []).map(k => ({ t: k.t, bones: { ...k.bones } }));
    activeKfIdx = -1;
    renderKfList();
    if (keyframes.length) {
      document.getElementById('ed-t').value = keyframes[0].t;
      setBoneQuats(keyframes[0].bones);
    }
    setStatus(`Loaded "${label}" (${keyframes.length} keyframes).`, 'success');
  } catch (err) {
    setStatus(`Load failed: ${err.message}`, 'error');
  }
}

// ─── Helpers ────────────────────────────────────────────────
function setStatus(msg, type) {
  const el = document.getElementById('ed-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `status status-${type}`;
}

init();
