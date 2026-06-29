/* ============================================================
   SgSL v2 — main thread (live mirror)
   ============================================================
   Off-thread tracking experiment. The main thread ONLY:
     - grabs webcam frames -> createImageBitmap -> transfer to worker
     - on each worker result: adapt -> retarget.applyFromMediaPipe -> draw overlay
     - renders the avatar + a compact calibration panel + HUD
   All landmark ML runs in track-worker.js (off-thread), so the
   render loop never starves -> targets v1's long-session slowdown.

   Reuses the SAME tuned modules as the live app (single source, no
   drift): ../../../sgsl-app/js/{avatar.js,retarget.js}. Those load
   `assets/mei.vrm` RELATIVE TO THIS PAGE -> the `assets` symlink in
   this folder points at ../../sgsl-app/assets.
   ============================================================ */

import { SMPLXAvatar } from '../../../sgsl-app/js/avatar.js';
import { SMPLXRetarget } from '../../../sgsl-app/js/retarget.js';
import { toResults } from './adapter.js';

const video = document.getElementById('v2-video');
const overlay = document.getElementById('v2-overlay');
const statusEl = document.getElementById('v2-status');
const dbgEl = document.getElementById('v2-debug');

const setStatus = (msg, kind = 'info') => {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `status status-${kind}`;
};

// ── Avatar + tuned retarget (identical objects to v1) ──────────────────────
const avatar = new SMPLXAvatar('v2-avatar-viewport');
const retarget = new SMPLXRetarget();
retarget.setVideo(video);
retarget.setAvatar(avatar);

// ── Worker ─────────────────────────────────────────────────────────────────
// Classic worker (NOT { type: 'module' }): MediaPipe Tasks-Vision calls importScripts()
// internally, which module workers forbid. Classic workers allow it, and Chromium still
// permits the dynamic import() we use inside the worker.
const worker = new Worker(new URL('./track-worker.js', import.meta.url));
let workerReady = false;
let inFlight = false;   // one frame in the worker at a time (backpressure)
let tsCtr = 0;

// Surface worker-load failures that would otherwise be SILENT (e.g. the module
// worker failing to instantiate, or a bad MIME type from the static server).
worker.onerror = (e) => setStatus(`Worker error: ${e.message || 'failed to load track-worker.js'} (open DevTools console for details)`, 'error');
worker.onmessageerror = () => setStatus('Worker message error (serialization).', 'error');

worker.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'status') {
    // Show load progress so a stall is visible (which model, GPU/CPU, etc.).
    if (!workerReady) setStatus(`Loading tracking model — ${msg.message}`, 'loading');
    if (dbgEl) dbgEl.textContent = `[worker] ${msg.message}\n` + (dbgEl.textContent || '');
    return;
  }
  if (msg.type === 'ready') {
    workerReady = true;
    setStatus('Tracking ready — raise a hand; the avatar mirrors you.', 'success');
    return;
  }
  if (msg.type === 'error') {
    setStatus(`Tracking worker failed: ${msg.message}`, 'error');
    return;
  }
  if (msg.type === 'result') {
    inFlight = false;
    const results = toResults(msg);
    if (avatar.vrm) retarget.applyFromMediaPipe(avatar.vrm, results);
    drawOverlay(results);
    if (dbgEl && retarget._lastDebug) dbgEl.textContent = retarget._lastDebug;
  }
};
worker.postMessage({ type: 'init' });

// ── Camera ───────────────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setStatus('Camera on — loading tracking model…', 'loading');
    requestAnimationFrame(pump);
  } catch (err) {
    setStatus(`Camera failed: ${err.message}`, 'error');
  }
}

// Frame pump: at most one outstanding bitmap in the worker (drop frames under load
// rather than queueing — keeps latency low and avoids the backlog that makes motion
// feel "random" once it falls behind).
async function pump() {
  if (workerReady && !inFlight && video.readyState >= 2) {
    inFlight = true;
    try {
      const bitmap = await createImageBitmap(video);
      worker.postMessage({ type: 'frame', bitmap, ts: ++tsCtr * 33 }, [bitmap]);
    } catch (e) { inFlight = false; }
  }
  requestAnimationFrame(pump);
}

// ── Overlay (simple landmark dots; mirrored by CSS like v1) ────────────────
function drawOverlay(results) {
  if (!overlay || !video) return;
  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const dots = (lms, color, r = 3) => {
    if (!lms) return;
    ctx.fillStyle = color;
    for (const lm of lms) {
      ctx.beginPath();
      ctx.arc(lm.x * overlay.width, lm.y * overlay.height, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  dots(results.rightHandLandmarks, '#00ff88');
  dots(results.leftHandLandmarks, '#ff8800');
  if (results.poseLandmarks) dots(results.poseLandmarks.slice(11, 17), 'rgba(136,170,238,0.8)', 4);
}

// ── Calibration panel (same setters as v1 -> tuning carries) ───────────────
// Persisted per-side under a v2-specific key so it doesn't clobber v1's settings.
const CALIB_KEY = 'sgsl.v2.calib.v1';
const DEFAULTS = {
  rollDeg: -170, pitchDeg: 10, yawDeg: 25, wristFlip: true, deformGuard: true,
  curlGain: 0.70, spreadGain: 0.80, smoothing: 0.75,
};
let side = 'Right';
let calib = { Right: { ...DEFAULTS }, Left: { ...DEFAULTS } };

function loadCalib() {
  try {
    const raw = JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
    if (raw && raw.Right && raw.Left) { calib = raw; side = raw.side || 'Right'; }
  } catch (e) { /* defaults */ }
}
function saveCalib() {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify({ ...calib, side })); } catch (e) {}
}
function applyCalib() {
  retarget.setHandTuning('Right', calib.Right);
  retarget.setHandTuning('Left', calib.Left);
}
const cur = () => calib[side];

function wireCalib() {
  const bind = (id, key, fmt) => {
    const el = document.getElementById(id);
    const lab = document.getElementById(id + '-label');
    if (!el) return;
    const refresh = () => {
      el.value = cur()[key];
      if (lab) lab.textContent = fmt(cur()[key]);
    };
    el.addEventListener('input', () => {
      cur()[key] = parseFloat(el.value);
      if (lab) lab.textContent = fmt(cur()[key]);
      applyCalib(); saveCalib();
    });
    refresh();
    bind._refreshers.push(refresh);
  };
  bind._refreshers = [];

  bind('v2-roll', 'rollDeg', (v) => `${Math.round(v)}°`);
  bind('v2-pitch', 'pitchDeg', (v) => `${Math.round(v)}°`);
  bind('v2-yaw', 'yawDeg', (v) => `${Math.round(v)}°`);
  bind('v2-curl', 'curlGain', (v) => `${v.toFixed(2)}×`);
  bind('v2-spread', 'spreadGain', (v) => `${v.toFixed(2)}×`);
  bind('v2-smooth', 'smoothing', (v) => `${Math.round(v * 100)}%`);

  const handBtn = document.getElementById('v2-handsel');
  if (handBtn) {
    const refreshHand = () => { handBtn.textContent = `Calibrating: ${side} hand ⇄`; bind._refreshers.forEach(f => f()); };
    handBtn.addEventListener('click', () => { side = side === 'Right' ? 'Left' : 'Right'; refreshHand(); saveCalib(); });
    refreshHand();
  }
  const flipBtn = document.getElementById('v2-wristflip');
  if (flipBtn) {
    const refreshFlip = () => { flipBtn.textContent = `Wrist rotation: ${cur().wristFlip ? 'Flipped' : 'Normal'}`; };
    flipBtn.addEventListener('click', () => { cur().wristFlip = !cur().wristFlip; refreshFlip(); applyCalib(); saveCalib(); });
    refreshFlip();
    bind._refreshers.push(refreshFlip);
  }
  const guardBtn = document.getElementById('v2-guard');
  if (guardBtn) {
    const refreshGuard = () => { guardBtn.textContent = `Deformation guard: ${cur().deformGuard ? 'On' : 'Off'}`; };
    guardBtn.addEventListener('click', () => { cur().deformGuard = !cur().deformGuard; refreshGuard(); applyCalib(); saveCalib(); });
    refreshGuard();
    bind._refreshers.push(refreshGuard);
  }
  const resetBtn = document.getElementById('v2-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    calib[side] = { ...DEFAULTS };
    bind._refreshers.forEach(f => f());
    applyCalib(); saveCalib();
  });
}

loadCalib();
applyCalib();
wireCalib();
startCamera();
