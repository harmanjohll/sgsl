/* ============================================================
   SgSL — App Controller
   ============================================================
   Two learner blocks + one contributor function:
     - Learn      : text → sign. Guided lessons + type-anything + the
                    library browser, all on ONE avatar (camera-off).
     - Test       : sign → text. Camera on; perform a sign, get scored.
     - Contribute : webcam → record a sign into the library.

   Heavy modules (each owns a WebGL avatar / camera) lazy-init the first
   time their tab is opened.
   ============================================================ */

import { Playback } from './player.js';
import * as signsSource from './signs-source.js';
import * as store from './store.js';
import { getEditsFor, saveEditsFor } from './sign-edits.js';
import { loadFineTune, saveFineTune } from './calib-profile.js';
import { signText, resolveLabels } from './sentence-engine.js';
import { parseSentence } from './gloss.js';
import { LearnController } from './learn.js';

// Bump on every deploy — the header label is how users see the site updated.
// Set from JS so a stale cached bundle shows its own (old) number.
const APP_VERSION = 'v1.1.0 · 15 Jul 2026';
document.getElementById('app-version').textContent = APP_VERSION;

// ─── Tab switching ──────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const contents = document.querySelectorAll('.tab-content');

let activeTab = 'learn';
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    if (target === activeTab) return;
    // Release cameras when their tab is left — the webcam must not stay live in the
    // background (privacy), and two live pipelines on one device wreck tracking.
    if (activeTab === 'test') { testCtl?.stop(); resetTestUI(); }
    if (activeTab === 'contribute') recorderMod?.suspend();
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    contents.forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));
    if (target === 'learn') { if (!learnLoaded) initLearn(); else refreshLearn(); }
    if (target === 'test') { if (!testLoaded) initTest(); else resetTestUI(); }
    if (target === 'contribute') { if (!contributeLoaded) initContribute(); else recorderMod?.resume(); }
    activeTab = target;
  });
});

// Reset the Test controls to their pre-camera state (start enabled, attempt/done off).
function resetTestUI() {
  const b = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
  b('btn-test-start', false); b('btn-test-attempt', true); b('btn-test-done', true);
  document.getElementById('test-camera-status')?.classList.remove('hidden');
  // Stale sign buttons from the previous camera session would call setTarget on a
  // stopped core and re-enable Attempt — clear them until the camera restarts.
  const list = document.getElementById('test-signlist');
  if (list) list.innerHTML = '<p class="hint">Start the camera to load testable signs…</p>';
  setStatus('test-status', 'Camera stopped. Press "Start camera" to test again.', 'info');
}

function setStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status status-${type}`;
}

// ─── Learn block (lessons + type→sign + library, one avatar) ─
let learnLoaded = false;
let learnPlayback = null;
let learn = null;
let startLessonRef = () => {};

// Re-entering Learn re-snapshots the library: signs recorded in Contribute since
// initLearn must show up without a page reload (list, lesson availability, chips).
async function refreshLearn() {
  if (!learn) return;
  await learn.load();
  if (!learn.current) learn.renderLessonList(document.getElementById('learn-lessons'), startLessonRef);
  await renderLibraryList('learn-list', learnPlayback);
}

async function initLearn() {
  learnLoaded = true;
  learnPlayback = new Playback('learn-viewport');
  learnPlayback.on('status', (m, t) => setStatus('learn-status', m, t))
    .on('progress', (fi, n) => {
      const prog = document.getElementById('learn-progress-fill');
      const info = document.getElementById('learn-frame-info');
      if (prog) prog.style.width = `${(fi / Math.max(n - 1, 1)) * 100}%`;
      if (info) info.textContent = `${fi + 1} / ${n}`;
    });

  // ── Guided lessons ──
  learn = new LearnController(learnPlayback, { statusId: 'learn-status' });
  await learn.load();
  const lessonList = document.getElementById('learn-lessons');
  const lessonPanel = document.getElementById('learn-lesson');
  const prompt = document.getElementById('learn-prompt');
  const showStep = (step) => {
    if (!step || step.done) {
      lessonPanel?.classList.add('hidden');
      learn.renderLessonList(lessonList, startLesson);
      return;
    }
    lessonPanel?.classList.remove('hidden');
    if (prompt) prompt.innerHTML = `<span class="lesson-word">${step.label}</span><span class="lesson-count">${step.index + 1} / ${step.total}</span>`;
  };
  const startLesson = (id) => { const step = learn.startLesson(id); if (step) showStep(step); };
  startLessonRef = startLesson;
  learn.renderLessonList(lessonList, startLesson);
  document.getElementById('btn-learn-practice')?.addEventListener('click', () => learn.replay());
  document.getElementById('btn-learn-gotit')?.addEventListener('click', () => showStep(learn.gotIt()));
  document.getElementById('btn-learn-exit')?.addEventListener('click', () => { learn.current = null; showStep({ done: true }); });

  // ── Type → sign ──
  const input = document.getElementById('learn-input');
  const chips = document.getElementById('learn-chips');
  async function refreshChips() {
    const text = input?.value || '';
    if (!text.trim()) { if (chips) chips.innerHTML = ''; return; }
    const manifest = await signsSource.getManifest();
    const resolved = resolveLabels(parseSentence(text), manifest.map(s => s.label));
    if (chips) chips.innerHTML = resolved.map(r =>
      `<span class="chip ${r.available ? 'chip-on' : 'chip-off'}" title="${r.available ? 'in library' : 'not recorded yet — skipped'}">${r.sign}</span>`
    ).join('') || '<span class="hint">No signable tokens.</span>';
  }
  input?.addEventListener('input', () => { clearTimeout(refreshChips._t); refreshChips._t = setTimeout(refreshChips, 200); });
  async function playText() {
    const text = input?.value?.trim();
    if (!text) { setStatus('learn-status', 'Type something for Fumi to sign.', 'error'); return; }
    setStatus('learn-status', 'Building sentence…', 'loading');
    const resolved = await signText(text, learnPlayback);
    const have = resolved.filter(r => r.available).length;
    const missing = resolved.filter(r => !r.available).map(r => r.sign);
    setStatus('learn-status', have
      ? `Signing ${have} sign(s).` + (missing.length ? ` Skipped: ${missing.join(', ')}.` : '')
      : 'None of those words are in the library yet — record them in Contribute.', have ? 'info' : 'error');
    refreshChips();
  }
  document.getElementById('btn-learn-sign')?.addEventListener('click', playText);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') playText(); });

  // ── Playback controls + library ──
  document.getElementById('btn-learn-replay')?.addEventListener('click', () => learnPlayback.replay());
  document.getElementById('btn-learn-stop')?.addEventListener('click', () => learnPlayback.stop());
  wireSpeed('learn-speed', 'learn-speed-label', learnPlayback);
  wireEditPanel(() => learnPlayback);
  wireFineTunePanel(() => learnPlayback);
  await renderLibraryList('learn-list', learnPlayback);
}

// ── Global fine-tune (this device): height/depth/extension/smoothing ─────────
// Saved to sgsl.finetune.v1 and applied by calib-profile.js to EVERY renderer.
// Only values moved off neutral are stored, so recordings' own settings still win
// wherever the user hasn't overridden.
const FT_NEUTRAL = { heightOffset: 0, reachDepth: 0.9, reachGain: 1, smoothing: 0.5 };
const FT_SLIDERS = [
  ['ft-height', 'heightOffset', (v) => v.toFixed(2)],
  ['ft-depth', 'reachDepth', (v) => v.toFixed(2)],
  ['ft-ext', 'reachGain', (v) => v.toFixed(2)],
  ['ft-smooth', 'smoothing', (v) => `${Math.round(v * 100)}%`],
];
function wireFineTunePanel(playbackRef) {
  const setUI = (ft) => {
    for (const [id, key, fmt] of FT_SLIDERS) {
      const el = document.getElementById(id), lb = document.getElementById(id + '-label');
      const v = typeof ft[key] === 'number' ? ft[key] : FT_NEUTRAL[key];
      if (el) el.value = v;
      if (lb) lb.textContent = fmt(v);
    }
  };
  setUI(loadFineTune());
  const readAndSave = () => {
    const ft = {};
    for (const [id, key] of FT_SLIDERS) {
      const v = Number(document.getElementById(id)?.value);
      if (isFinite(v) && Math.abs(v - FT_NEUTRAL[key]) > 1e-9) ft[key] = v;
    }
    saveFineTune(ft);
    // Preview the change: replay whatever sign is selected (profile re-applies on play).
    if (editLabel) {
      clearTimeout(editReplayTimer);
      editReplayTimer = setTimeout(() => playbackRef()?.playLabel(editLabel), 250);
    }
  };
  for (const [id, , fmt] of FT_SLIDERS) {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => {
      const lb = document.getElementById(id + '-label');
      if (lb) lb.textContent = fmt(Number(el.value));
      readAndSave();
    });
  }
  document.getElementById('ft-reset')?.addEventListener('click', () => {
    saveFineTune({});
    setUI({});
    if (editLabel) playbackRef()?.playLabel(editLabel);
  });
}

// ── Per-sign edit panel (trim/speed + render overrides; replays live on change) ──
let editLabel = null;
let editMeta = null;   // { label, source, tags } of the selected sign
let editReplayTimer = null;
let editPlaybackRef = () => null;
async function selectSignForEdit(meta) {
  const m = typeof meta === 'string' ? { label: meta, source: 'library', tags: [] } : meta;
  editLabel = m.label;
  editMeta = m;
  const panel = document.getElementById('lib-edit');
  if (!panel) return;
  panel.classList.remove('hidden');
  const e = getEditsFor(m.label) || {};
  setEditControl('lib-trim-start', e.trimStartMs || 0, (v) => `${(v / 1000).toFixed(2)}s`);
  setEditControl('lib-trim-end', e.trimEndMs || 0, (v) => `${(v / 1000).toFixed(2)}s`);
  setEditControl('lib-sign-speed', e.speed || 1, (v) => `${v.toFixed(2)}x`);
  setEditControl('lib-height', e.heightOffset ?? 0, (v) => v.toFixed(2));
  setEditControl('lib-depth', e.reachDepth ?? 0.9, (v) => v.toFixed(2));
  setEditControl('lib-ext', e.reachGain ?? 1, (v) => v.toFixed(2));
  const lab = document.getElementById('lib-edit-label');
  if (lab) lab.textContent = `Edit "${m.label}":`;
  // Tags: editable for device recordings (rewrites the stored record); read-only
  // for committed library signs (their tags live in the repo JSON).
  const tagsRow = document.getElementById('lib-tags-row');
  const tagsInput = document.getElementById('lib-tags');
  if (tagsRow && tagsInput) {
    tagsRow.classList.remove('hidden');
    tagsInput.value = (m.tags || []).join(', ');
    tagsInput.disabled = m.source !== 'local';
    tagsInput.placeholder = m.source === 'local'
      ? 'tags, comma-separated — press Enter to save'
      : 'tags of built-in signs are set in the repo';
  }
}
function setEditControl(id, value, fmt) {
  const el = document.getElementById(id), lb = document.getElementById(id + '-label');
  if (el) el.value = value;
  if (lb) lb.textContent = fmt(Number(value));
}
function wireEditPanel(playbackRef) {
  editPlaybackRef = playbackRef;
  const read = () => {
    const out = {
      trimStartMs: Number(document.getElementById('lib-trim-start')?.value || 0),
      trimEndMs: Number(document.getElementById('lib-trim-end')?.value || 0),
      speed: Number(document.getElementById('lib-sign-speed')?.value || 1),
    };
    // Render overrides only count when moved off neutral — otherwise the record's
    // own calibration (or the global fine-tune) keeps deciding.
    const h = Number(document.getElementById('lib-height')?.value ?? 0);
    if (Math.abs(h) > 1e-9) out.heightOffset = h;
    const d = Number(document.getElementById('lib-depth')?.value ?? 0.9);
    if (Math.abs(d - 0.9) > 1e-9) out.reachDepth = d;
    const g = Number(document.getElementById('lib-ext')?.value ?? 1);
    if (Math.abs(g - 1) > 1e-9) out.reachGain = g;
    return out;
  };
  const onChange = (id, fmt) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', () => {
      const lb = document.getElementById(id + '-label');
      if (lb) lb.textContent = fmt(Number(el.value));
      if (!editLabel) return;
      saveEditsFor(editLabel, read());
      clearTimeout(editReplayTimer);
      editReplayTimer = setTimeout(() => editPlaybackRef()?.playLabel(editLabel), 250);
    });
  };
  onChange('lib-trim-start', (v) => `${(v / 1000).toFixed(2)}s`);
  onChange('lib-trim-end', (v) => `${(v / 1000).toFixed(2)}s`);
  onChange('lib-sign-speed', (v) => `${v.toFixed(2)}x`);
  onChange('lib-height', (v) => v.toFixed(2));
  onChange('lib-depth', (v) => v.toFixed(2));
  onChange('lib-ext', (v) => v.toFixed(2));
  document.getElementById('lib-edit-reset')?.addEventListener('click', () => {
    if (!editLabel) return;
    saveEditsFor(editLabel, null);
    selectSignForEdit(editMeta || editLabel);
    editPlaybackRef()?.playLabel(editLabel);
  });
  // Save tags on a device recording (Enter/blur) — rewrites the stored record.
  document.getElementById('lib-tags')?.addEventListener('change', async (ev) => {
    if (!editMeta || editMeta.source !== 'local') return;
    const rec = await store.getSign(editMeta.label).catch(() => null);
    if (!rec) return;
    rec.tags = [...new Set(ev.target.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
    await store.putSign(rec);
    editMeta.tags = rec.tags;
    setStatus('learn-status', `Tags saved for "${editMeta.label}".`, 'success');
    renderLibraryList('learn-list', editPlaybackRef());
  });
}

// Active library tag filter (chip bar above the list); null = show everything.
let activeTagFilter = null;

function renderTagBar(manifest, listId, playback) {
  const bar = document.getElementById('learn-tagbar');
  if (!bar) return;
  const tags = [...new Set(manifest.flatMap(s => s.tags || []))].sort();
  bar.innerHTML = '';
  if (!tags.length) { bar.classList.add('hidden'); activeTagFilter = null; return; }
  bar.classList.remove('hidden');
  if (activeTagFilter && !tags.includes(activeTagFilter)) activeTagFilter = null;
  const mkChip = (label, val) => {
    const c = document.createElement('button');
    c.className = `chip tag-chip ${activeTagFilter === val ? 'chip-on' : ''}`;
    c.textContent = label;
    c.addEventListener('click', () => {
      activeTagFilter = (activeTagFilter === val) ? null : val;
      renderLibraryList(listId, playback);
    });
    bar.appendChild(c);
  };
  mkChip('all', null);
  for (const t of tags) mkChip(t, t);
}

async function renderLibraryList(listId, playback) {
  const list = document.getElementById(listId);
  if (!list) return;
  let manifest = [];
  try { manifest = await signsSource.getManifest(); }
  catch (err) { setStatus('learn-status', `Failed to load signs: ${err.message}`, 'error'); return; }
  renderTagBar(manifest, listId, playback);
  list.innerHTML = '';
  if (!manifest.length) { list.innerHTML = '<p class="hint">No signs yet. Record one in Contribute.</p>'; return; }
  const shown = activeTagFilter ? manifest.filter(s => (s.tags || []).includes(activeTagFilter)) : manifest;
  if (!shown.length) { list.innerHTML = `<p class="hint">No signs tagged "${activeTagFilter}".</p>`; return; }
  for (const s of shown) {
    const row = document.createElement('div');
    row.className = 'sign-row';
    const btn = document.createElement('button');
    btn.className = 'sign-btn';
    btn.textContent = s.label;
    btn.title = `${s.frames} frames · ${s.source}`
      + (s.tags?.length ? ` · ${s.tags.join(', ')}` : '');
    // Click = SELECT (highlight + open the edit panel). Playing is the ▶ button —
    // browsing the library must not blast a sign on every click.
    btn.addEventListener('click', () => {
      list.querySelectorAll('.sign-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectSignForEdit(s);
    });
    const tag = document.createElement('span');
    tag.className = `src-tag src-${s.source}`;
    tag.textContent = s.source === 'local' ? 'device' : s.source;
    const play = document.createElement('button');
    play.className = 'sign-play';
    play.textContent = '▶';
    play.title = `Play "${s.label}"`;
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      list.querySelectorAll('.sign-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectSignForEdit(s);
      playback.playLabel(s.label);
    });
    row.appendChild(btn); row.appendChild(tag); row.appendChild(play);
    const del = document.createElement('button');
    del.className = 'sign-del';
    del.textContent = '×';
    const isLocal = s.source === 'local';
    const delTitle = isLocal
      ? `Delete your device recording of "${s.label}"`
      : `Hide "${s.label}" on this device`;
    del.title = delTitle;
    // Two-step inline confirm — NO native confirm(). A browser's "prevent this page
    // from creating additional dialogs" tick makes confirm() always return false,
    // which used to silently block deleting/hiding. First click arms (× → ✓),
    // a second click within 3s performs it; otherwise it disarms.
    let armTimer = null;
    const disarm = () => {
      del.classList.remove('armed'); del.textContent = '×'; del.title = delTitle;
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!del.classList.contains('armed')) {
        del.classList.add('armed'); del.textContent = '✓';
        del.title = `Click again to ${isLocal ? 'delete' : 'hide'} "${s.label}"`;
        armTimer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      if (isLocal) {
        const res = await signsSource.deleteSign(s.label);
        if (res.ok) { row.remove(); setStatus('learn-status', `"${s.label}" removed from this device.`, 'info'); }
        else setStatus('learn-status', `Couldn't remove "${s.label}".`, 'error');
      } else {
        signsSource.hideSign(s.label); row.remove();
        setStatus('learn-status', `"${s.label}" hidden on this device.`, 'info');
      }
    });
    row.appendChild(del);
    list.appendChild(row);
  }
}

// ─── Test block (sign → text) ───────────────────────────────
let testLoaded = false;
let testCtl = null;
let testSession = { attempts: 0, passed: 0 };
async function initTest() {
  testLoaded = true;
  const { TestController } = await import('./test-mode.js');
  testCtl = new TestController({
    viewportId: 'test-viewport', videoId: 'test-video', overlayId: 'test-overlay', statusId: 'test-status',
    onResult: (v) => {
      testSession.attempts++; if (v.pass) testSession.passed++;
      const res = document.getElementById('test-result');
      if (res) res.innerHTML = `<span class="q-grade ${v.pass ? 'q-good' : 'q-bad'}">${v.grade}</span>`
        + `<span class="q-overall-text">${v.score}/100 · ${v.feedback.join(' ')}</span>`;
      setStatus('test-score', `Session: ${testSession.passed}/${testSession.attempts} passed.`, 'info');
    },
  });

  const startBtn = document.getElementById('btn-test-start');
  const attemptBtn = document.getElementById('btn-test-attempt');
  const doneBtn = document.getElementById('btn-test-done');
  startBtn?.addEventListener('click', async () => {
    startBtn.disabled = true;
    // Fresh camera session = fresh session tally (it read "3/7 passed" forever otherwise).
    testSession = { attempts: 0, passed: 0 };
    setStatus('test-score', 'Session: 0/0 passed.', 'info');
    setStatus('test-status', 'Starting camera…', 'loading');
    const ok = await testCtl.start();
    document.getElementById('test-camera-status')?.classList.add('hidden');
    if (!ok) { startBtn.disabled = false; return; }
    const labels = await testCtl.loadTemplates();
    renderTestList(labels);
  });
  attemptBtn?.addEventListener('click', () => { testCtl.beginAttempt(); doneBtn.disabled = false; });
  doneBtn?.addEventListener('click', () => testCtl.endAttempt());

  const STRICT_LEVELS = ['easy', 'normal', 'strict'];
  const STRICT_LABELS = ['Easy', 'Normal', 'Strict'];
  const strictSlider = document.getElementById('test-strictness');
  const strictLabel = document.getElementById('test-strictness-label');
  strictSlider?.addEventListener('input', () => {
    const i = parseInt(strictSlider.value, 10) || 0;
    testCtl.setStrictness(STRICT_LEVELS[i]);
    if (strictLabel) strictLabel.textContent = STRICT_LABELS[i];
  });

  function renderTestList(labels) {
    const list = document.getElementById('test-signlist');
    if (!list) return;
    list.innerHTML = '';
    if (!labels.length) { list.innerHTML = '<p class="hint">No signs in the library yet. Record one in Contribute.</p>'; return; }
    for (const label of labels) {
      const btn = document.createElement('button');
      btn.className = 'sign-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        list.querySelectorAll('.sign-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        testCtl.setTarget(label);
        attemptBtn.disabled = false;
        setStatus('test-status', `Ready — press "Sign the word" and perform "${label}".`, 'info');
      });
      list.appendChild(btn);
    }
    setStatus('test-status', `${labels.length} testable sign(s). Pick one.`, 'success');
  }
}

// ─── Contribute (record) ────────────────────────────────────
let contributeLoaded = false;
let recorderMod = null;   // module handle for camera suspend/resume on tab switches
async function initContribute() {
  contributeLoaded = true;
  recorderMod = await import('./recorder.js');
}

// ─── Shared speed-slider wiring ─────────────────────────────
function wireSpeed(sliderId, labelId, playback) {
  const slider = document.getElementById(sliderId);
  const label = document.getElementById(labelId);
  if (!slider) return;
  slider.addEventListener('input', () => {
    const s = parseFloat(slider.value);
    playback.setSpeed(s);
    if (label) label.textContent = `${s.toFixed(1)}x`;
  });
}

// Release the cameras if the page is hidden/closed (privacy + no zombie stream).
window.addEventListener('pagehide', () => { testCtl?.stop(); recorderMod?.suspend(); });

// Open Learn by default.
initLearn();
