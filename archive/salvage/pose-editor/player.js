/* ============================================================
   SgSL Avatar — Playback Engine
   ============================================================
   Drives sign playback on the VRM avatar. Handles two distinct
   sign formats with separate playback paths:

   * Schema v2 ("recorded"): each frame is a MediaPipe-landmark
     snapshot { t, pose, poseWorld, face, leftHand, rightHand }.
     Playback runs frames through the retargeting layer just like
     live capture — same quality / same limitations.

   * Schema v3 ("curated"): each keyframe is a dict of VRM
     humanoid-bone names → quaternions [x,y,z,w] at time t (ms).
     Playback slerps quaternions directly onto bones — bypasses
     the retargeter entirely. What was authored is exactly what
     plays back. This is the path the curated library uses for
     accuracy.

   Real-timestamp-driven playback (no fixed-fps assumption) for both.
   ============================================================ */

import { SMPLXAvatar } from './avatar.js';
import { SMPLXRetarget } from './retarget.js';

// ─── Min-jerk interpolation ─────────────────────────────────
function mjEval(x0, xf, t) {
  const t3 = t * t * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  return x0 + (xf - x0) * (10 * t3 - 15 * t4 + 6 * t5);
}

function lerpLM(a, b, t) {
  if (!a) return b;
  if (!b) return a;
  return b.map((lm, i) => {
    const pa = a[i] || lm;
    const out = [
      mjEval(pa[0] ?? lm[0], lm[0], t),
      mjEval(pa[1] ?? lm[1], lm[1], t),
      mjEval(pa[2] ?? 0, lm[2] ?? 0, t),
    ];
    if (lm.length > 3) out.push(lm[3]);  // preserve visibility unchanged
    return out;
  });
}

function lerpFrame(a, b, t) {
  if (!a) return b;
  return {
    leftHand:  lerpLM(a.leftHand, b.leftHand, t),
    rightHand: lerpLM(a.rightHand, b.rightHand, t),
    face:      lerpLM(a.face, b.face, t),
    pose:      lerpLM(a.pose, b.pose, t),
    poseWorld: lerpLM(a.poseWorld, b.poseWorld, t),
  };
}

// ─── Main application ───────────────────────────────────────

let avatar = null;
let retarget = null;
let signs = [];

// Playback state (timestamp-driven)
let seq = [];           // recorded: array of frames; curated: array of keyframes
let playMode = 'recorded';  // 'recorded' or 'curated'
let playing = false;
let paused = false;
let fi = 0;
let speed = 1;
let startWall = 0;   // performance.now() at playback start
let startT = 0;      // seq[0].t at playback start
let rafId = null;

// ─── API ────────────────────────────────────────────────────

async function fetchSigns() {
  const res = await fetch('/api/signs');
  if (!res.ok) throw new Error('Failed to load signs');
  return res.json();
}

async function fetchSign(label) {
  const res = await fetch(`/api/sign/${label}`);
  if (!res.ok) throw new Error(`Sign "${label}" not found`);
  return res.json();
}

// ─── Playback ───────────────────────────────────────────────

function currentTargetT() {
  return startT + (performance.now() - startWall) * speed;
}

function tick() {
  if (!playing || paused) return;

  const targetT = currentTargetT();
  const lastT = seq[seq.length - 1].t;

  // Advance fi cursor (used by progress bar + by both render paths).
  while (fi < seq.length - 2 && seq[fi + 1].t <= targetT) fi++;

  const prog = document.getElementById('progress-fill');
  const info = document.getElementById('frame-info');
  if (prog) prog.style.width = `${(fi / Math.max(seq.length - 1, 1)) * 100}%`;
  if (info) {
    const denom = playMode === 'curated' ? 'kf' : 'fr';
    info.textContent = `${fi + 1} / ${seq.length} ${denom}`;
  }

  if (targetT >= lastT) {
    if (playMode === 'curated') {
      renderCuratedAt(lastT);
    } else {
      renderFrame(seq[seq.length - 1]);
    }
    playing = false;
    avatar.setPlaying(false);
    updatePlayBtn();
    setStatus('Playback complete.', 'success');
    return;
  }

  if (playMode === 'curated') {
    renderCuratedAt(targetT);
  } else {
    const a = seq[fi];
    const b = seq[fi + 1];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(Math.max((targetT - a.t) / span, 0), 1);
    renderFrame(lerpFrame(a, b, u));
  }
  rafId = requestAnimationFrame(tick);
}

function renderFrame(frame) {
  if (!avatar?.vrm || !retarget || !frame) return;

  // Kalidokit.Pose.solve(world3D, screen2D).
  // Kalidokit.Face.solve needs 478 face landmarks.
  // Kalidokit.Hand.solve is passed raw MediaPipe-side labels; the
  // retarget layer swaps to the signer's own-side perspective.
  const toMP = (arr) => arr ? arr.map(p => ({
    x: p[0],
    y: p[1],
    z: p[2] ?? 0,
    visibility: p[3] ?? 1,
  })) : null;

  const fakeResults = {
    poseLandmarks: toMP(frame.pose),
    za: toMP(frame.poseWorld || frame.pose),
    faceLandmarks: toMP(frame.face),
    rightHandLandmarks: toMP(frame.rightHand),
    leftHandLandmarks: toMP(frame.leftHand),
  };

  retarget.applyFromMediaPipe(avatar.vrm, fakeResults);
}

// ─── Curated playback path ──────────────────────────────────
//
// Curated signs are quaternion-keyframed. Between two adjacent
// keyframes we slerp each bone independently. Bones present in only
// one of the two surrounding keyframes are written from whichever
// keyframe has them (no half-defined slerp). Bones absent from BOTH
// surrounding keyframes are left untouched — the avatar's rest pose
// (or the previous frame's value) carries through naturally.
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function _writeBoneQuat(boneName, qArr) {
  if (!avatar?.vrm || !qArr || qArr.length !== 4) return;
  const BN = THREE.VRMSchema.HumanoidBoneName;
  const node = avatar.vrm.humanoid.getBoneNode(BN[boneName]);
  if (!node) return;
  node.quaternion.set(qArr[0], qArr[1], qArr[2], qArr[3]);
}

function _slerpBoneQuat(boneName, qaArr, qbArr, u) {
  if (!avatar?.vrm) return;
  const BN = THREE.VRMSchema.HumanoidBoneName;
  const node = avatar.vrm.humanoid.getBoneNode(BN[boneName]);
  if (!node) return;
  _qa.set(qaArr[0], qaArr[1], qaArr[2], qaArr[3]);
  _qb.set(qbArr[0], qbArr[1], qbArr[2], qbArr[3]);
  _qa.slerp(_qb, u);
  node.quaternion.copy(_qa);
}

function renderCuratedAt(targetT) {
  if (!avatar?.vrm || !seq.length) return;

  // Locate surrounding keyframes a, b such that a.t <= targetT < b.t.
  while (fi < seq.length - 2 && seq[fi + 1].t <= targetT) fi++;
  const a = seq[fi];
  const b = seq[Math.min(fi + 1, seq.length - 1)];

  if (a === b || b.t <= a.t) {
    // At/past the last keyframe: write a's bones verbatim.
    for (const [bone, q] of Object.entries(a.bones || {})) {
      _writeBoneQuat(bone, q);
    }
    return;
  }

  const u = Math.min(Math.max((targetT - a.t) / (b.t - a.t), 0), 1);
  const aBones = a.bones || {};
  const bBones = b.bones || {};
  // Union: bone written by either keyframe gets driven; absent bones
  // keep whatever quaternion the play-start rest-slerp set them to.
  const allBones = new Set([...Object.keys(aBones), ...Object.keys(bBones)]);
  for (const bone of allBones) {
    const qa = aBones[bone];
    const qb = bBones[bone];
    if (qa && qb) _slerpBoneQuat(bone, qa, qb, u);
    else if (qa)  _writeBoneQuat(bone, qa);
    else if (qb)  _writeBoneQuat(bone, qb);
  }
}

async function playSign(label) {
  setStatus(`Loading "${label}"...`, 'loading');
  try {
    const data = await fetchSign(label);
    const isCurated = data.type === 'curated' || data.schema_version >= 3;

    if (isCurated) {
      const kfs = (data.keyframes || []).filter(k => k && typeof k.t === 'number' && k.bones);
      if (kfs.length < 2) {
        setStatus(`Curated sign "${label}" has too few keyframes.`, 'error');
        avatar.setPlaying(false);
        return;
      }
      seq = kfs;
      playMode = 'curated';
      // Reset pose to baseline before keyframe slerp takes over,
      // so any bone the curated set doesn't animate sits at rest.
      if (avatar.slerpToRest && avatar._restTargets) {
        const BN = THREE.VRMSchema.HumanoidBoneName;
        const restNames = Object.entries(BN)
          .filter(([_, key]) => avatar._restTargets[key])
          .map(([name]) => name);
        avatar.slerpToRest(restNames, 1.0);  // hard snap, not slerp toward
      }
      fi = 0;
      playing = true; paused = false;
      avatar.setPlaying(true);
      startWall = performance.now();
      startT = seq[0].t;
      if (rafId) cancelAnimationFrame(rafId);
      updatePlayBtn();
      const durS = ((seq[seq.length - 1].t - seq[0].t) / 1000).toFixed(1);
      setStatus(`Playing "${label}" (curated, ${seq.length} keyframes, ${durS}s)`, 'info');
      tick();
      return;
    }

    // Recorded (landmark capture) path — schema v2.
    const frames = (data.landmarks || []).filter(f => f && (f.pose || f.leftHand || f.rightHand));
    if (!frames.length) {
      setStatus(`No valid frames for "${label}".`, 'error');
      avatar.setPlaying(false);
      return;
    }

    // Backfill timestamps if missing (schema v1). Assume 30 fps as a
    // last resort so legacy signs still play back at ~roughly the right
    // speed. New recordings (schema v2) carry real timestamps.
    const hasT = frames.every(f => typeof f.t === 'number');
    if (!hasT) {
      for (let i = 0; i < frames.length; i++) frames[i] = { ...frames[i], t: i * (1000 / 30) };
    }

    seq = frames;
    playMode = 'recorded';
    retarget.reset();
    // Honor the per-signer calibration baked into the sign so
    // playback uses the same arm-reach normalization the
    // recorder did. Falls back to no calibration for v1 signs.
    retarget.setCalibration(data.calibration || null);
    fi = 0;
    playing = true; paused = false;
    avatar.setPlaying(true);
    startWall = performance.now();
    startT = seq[0].t;
    if (rafId) cancelAnimationFrame(rafId);
    updatePlayBtn();
    const durS = ((seq[seq.length - 1].t - seq[0].t) / 1000).toFixed(1);
    setStatus(`Playing "${label}" (${seq.length} frames, ${durS}s)`, 'info');
    tick();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function togglePause() {
  if (!playing) return;
  if (!paused) {
    // pausing: remember the elapsed logical time
    startT = currentTargetT();
    paused = true;
  } else {
    // resuming: reset wall anchor so elapsed logical time continues
    startWall = performance.now();
    paused = false;
    tick();
  }
  updatePlayBtn();
}

function replay() {
  if (!seq.length) return;
  retarget.reset();
  fi = 0;
  paused = false; playing = true;
  startWall = performance.now();
  startT = seq[0].t;
  if (rafId) cancelAnimationFrame(rafId);
  updatePlayBtn();
  tick();
}

function stopPlayback() {
  playing = false;
  paused = false;
  if (avatar) avatar.setPlaying(false);
  if (rafId) cancelAnimationFrame(rafId);
  updatePlayBtn();
}

// ─── UI helpers ─────────────────────────────────────────────

function renderSignLists(allSigns) {
  const curatedList  = document.getElementById('sign-list-curated');
  const recordedList = document.getElementById('sign-list-recorded');
  // Backward-compat with any cached HTML that still has the old single list.
  const legacyList   = document.getElementById('sign-list');

  const curated  = allSigns.filter(s => s.type === 'curated');
  const recorded = allSigns.filter(s => s.type !== 'curated');

  if (curatedList)  populate(curatedList,  curated,  'No curated signs yet. Author one in the Pose Editor.');
  if (recordedList) populate(recordedList, recorded, 'No recordings yet.');
  if (legacyList && !curatedList && !recordedList) populate(legacyList, allSigns, 'No signs yet.');

  function populate(listEl, rows, emptyMsg) {
    listEl.innerHTML = '';
    if (!rows.length) {
      listEl.innerHTML = `<p class="hint">${emptyMsg}</p>`;
      return;
    }
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'sign-row';

      const btn = document.createElement('button');
      btn.className = 'sign-btn';
      btn.textContent = s.label;
      btn.title = s.type === 'curated'
        ? `${s.keyframes ?? '?'} keyframes · ${Math.round(s.duration_ms ?? 0)}ms · curated`
        : `${s.frames ?? '?'} frames · recorded`;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sign-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        playSign(s.label);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'sign-del';
      delBtn.textContent = '\u00d7';
      delBtn.title = `Delete "${s.label}"`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete sign "${s.label}"?`)) return;
        try {
          const res = await fetch(`/api/sign/${s.label}`, { method: 'DELETE' });
          if (res.ok) {
            row.remove();
            setStatus(`"${s.label}" deleted.`, 'info');
          }
        } catch (err) {
          setStatus(`Delete failed: ${err.message}`, 'error');
        }
      });

      row.appendChild(btn);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }
}

function setStatus(msg, type) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.className = `status status-${type}`;
}

function updatePlayBtn() {
  const btn = document.getElementById('btn-pause');
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
}

// ─── Init ───────────────────────────────────────────────────

async function init() {
  avatar = new SMPLXAvatar('avatar-viewport');
  retarget = new SMPLXRetarget();
  retarget.setVideo(null);  // viewer has no camera feed
  retarget.setAvatar(avatar);

  try {
    signs = await fetchSigns();
    renderSignLists(signs);
    const curatedCount = signs.filter(s => s.type === 'curated').length;
    const recordedCount = signs.length - curatedCount;
    setStatus(
      `Loaded ${curatedCount} curated, ${recordedCount} recorded sign${signs.length === 1 ? '' : 's'}. Click one to play.`,
      'success',
    );
  } catch (err) {
    setStatus(`Failed to load signs: ${err.message}`, 'error');
  }

  document.getElementById('btn-pause')?.addEventListener('click', togglePause);
  document.getElementById('btn-replay')?.addEventListener('click', replay);
  document.getElementById('btn-stop')?.addEventListener('click', stopPlayback);

  const speedSlider = document.getElementById('speed-slider');
  const speedLabel = document.getElementById('speed-label');
  if (speedSlider) {
    speedSlider.addEventListener('input', () => {
      // Rebase time anchors so mid-play speed change doesn't jump.
      if (playing && !paused) {
        startT = currentTargetT();
        startWall = performance.now();
      }
      speed = parseFloat(speedSlider.value);
      if (speedLabel) speedLabel.textContent = `${speed.toFixed(1)}x`;
    });
  }
}

init();
