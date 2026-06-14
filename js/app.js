/* ============================================================
   SgSL — App Controller
   ============================================================
   Tab switching + per-tab UI wiring. Three tabs:
     - Sign It : text -> SgSL gloss -> chained avatar playback
     - Record  : webcam -> MediaPipe Holistic -> record a sign
     - Library : browse + play the recorded sign library

   Heavy modules (each owns a WebGL avatar) are lazy-initialised the
   first time their tab is opened.
   ============================================================ */

import { Playback } from './player.js';
import * as signsSource from './signs-source.js';
import { signText, resolveLabels } from './sentence-engine.js';
import { parseSentence } from './gloss.js';

// ─── Tab switching ──────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const contents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    contents.forEach(c => c.classList.toggle('active', c.id === `tab-${target}`));

    if (target === 'signit' && !signitLoaded) initSignIt();
    if (target === 'library' && !libraryLoaded) initLibrary();
    if (target === 'record' && !recorderLoaded) initRecorder();
  });
});

function setStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status status-${type}`;
}

// ─── Sign It tab (text -> sign) ─────────────────────────────
let signitLoaded = false;
let signitPlayback = null;

function initSignIt() {
  signitLoaded = true;
  signitPlayback = new Playback('signit-viewport');
  signitPlayback.on('status', (m, t) => setStatus('signit-status', m, t));

  const input = document.getElementById('signit-input');
  const btn = document.getElementById('btn-signit-play');
  const chips = document.getElementById('signit-chips');

  // Live coverage preview as the user types.
  async function refreshChips() {
    const text = input?.value || '';
    if (!text.trim()) { if (chips) chips.innerHTML = ''; return; }
    const manifest = await signsSource.getManifest();
    const resolved = resolveLabels(parseSentence(text), manifest.map(s => s.label));
    if (chips) {
      chips.innerHTML = resolved.map(r =>
        `<span class="chip ${r.available ? 'chip-on' : 'chip-off'}" title="${r.available ? 'in library' : 'not in library — will be skipped'}">${r.sign}</span>`
      ).join('') || '<span class="hint">No signable tokens.</span>';
    }
  }
  input?.addEventListener('input', () => { clearTimeout(refreshChips._t); refreshChips._t = setTimeout(refreshChips, 200); });

  async function play() {
    const text = input?.value?.trim();
    if (!text) { setStatus('signit-status', 'Type something for Fumi to sign.', 'error'); return; }
    if (!signitPlayback.ready) { setStatus('signit-status', 'Avatar still loading…', 'loading'); }
    setStatus('signit-status', 'Building sentence…', 'loading');
    const resolved = await signText(text, signitPlayback);
    const have = resolved.filter(r => r.available).length;
    if (!have) {
      setStatus('signit-status', 'None of those words are in the library yet. Record them in the Record tab.', 'error');
    } else {
      const missing = resolved.filter(r => !r.available).map(r => r.sign);
      setStatus('signit-status',
        `Signing ${have} sign(s).` + (missing.length ? ` Skipped (not in library): ${missing.join(', ')}.` : ''),
        'info');
    }
    refreshChips();
  }

  btn?.addEventListener('click', play);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') play(); });

  document.getElementById('btn-signit-replay')?.addEventListener('click', () => signitPlayback.replay());
  document.getElementById('btn-signit-stop')?.addEventListener('click', () => signitPlayback.stop());
  wireSpeed('signit-speed', 'signit-speed-label', signitPlayback);

  setStatus('signit-status', 'Type a word or phrase and press Sign.', 'info');
}

// ─── Library tab ────────────────────────────────────────────
let libraryLoaded = false;
let libraryPlayback = null;

async function initLibrary() {
  libraryLoaded = true;
  libraryPlayback = new Playback('lib-viewport');
  libraryPlayback.on('status', (m, t) => setStatus('lib-status', m, t))
    .on('progress', (fi, n) => {
      const prog = document.getElementById('lib-progress-fill');
      const info = document.getElementById('lib-frame-info');
      if (prog) prog.style.width = `${(fi / Math.max(n - 1, 1)) * 100}%`;
      if (info) info.textContent = `${fi + 1} / ${n}`;
    });

  await renderLibraryList();

  document.getElementById('btn-lib-replay')?.addEventListener('click', () => libraryPlayback.replay());
  document.getElementById('btn-lib-pause')?.addEventListener('click', () => libraryPlayback.togglePause());
  document.getElementById('btn-lib-stop')?.addEventListener('click', () => libraryPlayback.stop());
  wireSpeed('lib-speed', 'lib-speed-label', libraryPlayback);
}

async function renderLibraryList() {
  const list = document.getElementById('lib-sign-list');
  if (!list) return;
  let manifest = [];
  try { manifest = await signsSource.getManifest(); }
  catch (err) { setStatus('lib-status', `Failed to load signs: ${err.message}`, 'error'); return; }

  list.innerHTML = '';
  if (!manifest.length) {
    list.innerHTML = '<p class="hint">No signs yet. Record one in the Record tab.</p>';
    return;
  }
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
      libraryPlayback.playLabel(s.label);
    });

    const tag = document.createElement('span');
    tag.className = `src-tag src-${s.source}`;
    tag.textContent = s.source === 'local' ? 'device' : s.source;

    row.appendChild(btn);
    row.appendChild(tag);

    if (s.source === 'local') {
      const del = document.createElement('button');
      del.className = 'sign-del';
      del.textContent = '×';
      del.title = `Delete local "${s.label}"`;
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete your device recording of "${s.label}"?`)) return;
        const res = await signsSource.deleteSign(s.label);
        if (res.ok) { row.remove(); setStatus('lib-status', `"${s.label}" removed from this device.`, 'info'); }
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  }
  setStatus('lib-status', `${manifest.length} signs loaded. Click one to play.`, 'success');
}

// ─── Record tab ─────────────────────────────────────────────
let recorderLoaded = false;
async function initRecorder() {
  recorderLoaded = true;
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

// Open Sign-It by default.
initSignIt();
