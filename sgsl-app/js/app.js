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
import { getEditsFor, saveEditsFor } from './sign-edits.js';
import { signText, resolveLabels } from './sentence-engine.js';
import { parseSentence } from './gloss.js';
import { LearnController } from './learn.js';

// ─── Tab switching ──────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const contents = document.querySelectorAll('.tab-content');

let activeTab = 'learn';
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    // Release the Test camera+worker when leaving Test — otherwise it keeps running and,
    // opening Contribute, a SECOND camera+worker would spin up on the same device.
    if (activeTab === 'test' && target !== 'test') { testCtl?.stop(); resetTestUI(); }
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    contents.forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));
    if (target === 'learn' && !learnLoaded) initLearn();
    if (target === 'test') { if (!testLoaded) initTest(); else resetTestUI(); }
    if (target === 'contribute' && !contributeLoaded) initContribute();
    activeTab = target;
  });
});

// Reset the Test controls to their pre-camera state (start enabled, attempt/done off).
function resetTestUI() {
  const b = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
  b('btn-test-start', false); b('btn-test-attempt', true); b('btn-test-done', true);
  document.getElementById('test-camera-status')?.classList.remove('hidden');
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
  await renderLibraryList('learn-list', learnPlayback);
}

// ── Per-sign edit panel (trim/speed overlay; replays live on change) ─────────
let editLabel = null;
let editReplayTimer = null;
let editPlaybackRef = () => null;
function selectSignForEdit(label) {
  editLabel = label;
  const panel = document.getElementById('lib-edit');
  if (!panel) return;
  panel.classList.remove('hidden');
  const e = getEditsFor(label) || {};
  setEditControl('lib-trim-start', e.trimStartMs || 0, (v) => `${(v / 1000).toFixed(2)}s`);
  setEditControl('lib-trim-end', e.trimEndMs || 0, (v) => `${(v / 1000).toFixed(2)}s`);
  setEditControl('lib-sign-speed', e.speed || 1, (v) => `${v.toFixed(2)}x`);
  const lab = document.getElementById('lib-edit-label');
  if (lab) lab.textContent = `Edit "${label}":`;
}
function setEditControl(id, value, fmt) {
  const el = document.getElementById(id), lb = document.getElementById(id + '-label');
  if (el) el.value = value;
  if (lb) lb.textContent = fmt(Number(value));
}
function wireEditPanel(playbackRef) {
  editPlaybackRef = playbackRef;
  const read = () => ({
    trimStartMs: Number(document.getElementById('lib-trim-start')?.value || 0),
    trimEndMs: Number(document.getElementById('lib-trim-end')?.value || 0),
    speed: Number(document.getElementById('lib-sign-speed')?.value || 1),
  });
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
  document.getElementById('lib-edit-reset')?.addEventListener('click', () => {
    if (!editLabel) return;
    saveEditsFor(editLabel, null);
    selectSignForEdit(editLabel);
    editPlaybackRef()?.playLabel(editLabel);
  });
}

async function renderLibraryList(listId, playback) {
  const list = document.getElementById(listId);
  if (!list) return;
  let manifest = [];
  try { manifest = await signsSource.getManifest(); }
  catch (err) { setStatus('learn-status', `Failed to load signs: ${err.message}`, 'error'); return; }
  list.innerHTML = '';
  if (!manifest.length) { list.innerHTML = '<p class="hint">No signs yet. Record one in Contribute.</p>'; return; }
  for (const s of manifest) {
    const row = document.createElement('div');
    row.className = 'sign-row';
    const btn = document.createElement('button');
    btn.className = 'sign-btn';
    btn.textContent = s.label;
    btn.title = `${s.frames} frames · ${s.source}`;
    btn.addEventListener('click', () => {
      list.querySelectorAll('.sign-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectSignForEdit(s.label);
      playback.playLabel(s.label);
    });
    const tag = document.createElement('span');
    tag.className = `src-tag src-${s.source}`;
    tag.textContent = s.source === 'local' ? 'device' : s.source;
    row.appendChild(btn); row.appendChild(tag);
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
    if (!labels.length) { list.innerHTML = '<p class="hint">No testable signs yet. Record some in Contribute (they need the new format).</p>'; return; }
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
async function initContribute() {
  contributeLoaded = true;
  await import('./recorder.js');
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

// Release the camera if the page is hidden/closed (privacy + no zombie stream).
window.addEventListener('pagehide', () => testCtl?.stop());

// Open Learn by default.
initLearn();
