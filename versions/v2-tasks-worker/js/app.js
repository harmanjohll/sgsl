/* ============================================================
   SgSL v2 — main thread (live mirror)
   ============================================================
   Off-thread tracking experiment. The main thread ONLY:
     - grabs webcam frames -> createImageBitmap -> transfer to worker
     - on each worker result: adapt -> retarget.applyFromMediaPipe -> draw overlay
     - renders the avatar + a compact calibration panel + HUD + a SESSION RECORDER
   All landmark ML runs in track-worker.js (off-thread), so the
   render loop never starves -> targets v1's long-session slowdown.

   Reuses the SAME tuned modules as the live app (single source, no
   drift): ../../../sgsl-app/js/{avatar.js,retarget.js}.
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

// Surface worker-load failures that would otherwise be SILENT.
worker.onerror = (e) => setStatus(`Worker error: ${e.message || 'failed to load track-worker.js'} (open DevTools console)`, 'error');
worker.onmessageerror = () => setStatus('Worker message error (serialization).', 'error');

// ── Session recorder (measures FPS-over-time so the soak test is objective) ──
const rec = {
  on: false, start: 0, lastSample: 0,
  rafCount: 0, resultCount: 0, lastLatency: 0,
  handR: false, handL: false,
  sendTimes: new Map(), samples: [],
};

worker.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'status') {
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
    rec.resultCount++;
    const sent = rec.sendTimes.get(msg.ts);
    if (sent != null) { rec.lastLatency = performance.now() - sent; rec.sendTimes.delete(msg.ts); }
    const results = toResults(msg);
    rec.handR = !!results.rightHandWorldLandmarks;
    rec.handL = !!results.leftHandWorldLandmarks;
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
// rather than queueing). Also the rAF heartbeat for the session recorder — the rate
// of these callbacks IS the main-thread-responsiveness signal we care about.
async function pump() {
  const now = performance.now();
  rec.rafCount++;
  if (workerReady && !inFlight && video.readyState >= 2) {
    inFlight = true;
    try {
      const ts = ++tsCtr * 33;
      rec.sendTimes.set(ts, now);
      const bitmap = await createImageBitmap(video);
      worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
    } catch (e) { inFlight = false; }
  }
  // Once per second, snapshot render fps / track fps / latency.
  if (rec.on && now - rec.lastSample >= 1000) {
    const dt = (now - rec.lastSample) / 1000;
    rec.samples.push({
      t: Math.round(now - rec.start),
      renderFps: +(rec.rafCount / dt).toFixed(1),
      trackFps: +(rec.resultCount / dt).toFixed(1),
      latencyMs: Math.round(rec.lastLatency),
      handR: rec.handR, handL: rec.handL,
    });
    rec.rafCount = 0; rec.resultCount = 0; rec.lastSample = now;
    setStatus(`Recording session… ${rec.samples.length}s (render ${rec.samples.at(-1).renderFps} fps)`, 'loading');
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

// ── Record session -> JSON (the soak-test instrument) ──────────────────────
function startRec() {
  const now = performance.now();
  rec.on = true; rec.start = now; rec.lastSample = now;
  rec.rafCount = 0; rec.resultCount = 0; rec.samples = [];
  const btn = document.getElementById('v2-rec');
  if (btn) { btn.textContent = '■ Stop & save JSON'; btn.classList.remove('btn-record'); }
  setStatus('Recording session… sign continuously for a few minutes.', 'loading');
}
function stopRec() {
  rec.on = false;
  const btn = document.getElementById('v2-rec');
  if (btn) { btn.textContent = '● Record session'; btn.classList.add('btn-record'); }
  const s = rec.samples;
  if (!s.length) { setStatus('Session too short — nothing saved. Record for at least a few seconds.', 'error'); return; }
  const fps = s.map(x => x.renderFps), trk = s.map(x => x.trackFps);
  const avg = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0;
  const head = (a) => a.slice(0, Math.max(1, Math.floor(a.length * 0.25)));
  const tail = (a) => a.slice(-Math.max(1, Math.floor(a.length * 0.25)));
  const summary = {
    durationSec: Math.round((performance.now() - rec.start) / 1000),
    renderFps: { avg: avg(fps), first25pct: avg(head(fps)), last25pct: avg(tail(fps)), min: Math.min(...fps) },
    trackFps: { avg: avg(trk), first25pct: avg(head(trk)), last25pct: avg(tail(trk)) },
    maxLatencyMs: Math.max(...s.map(x => x.latencyMs)),
    // >20% render-fps drop from start to end = the v1 "degrades over time" signature.
    degraded: avg(tail(fps)) < avg(head(fps)) * 0.8,
  };
  const payload = {
    kind: 'sgsl-v2-session', version: 1,
    userAgent: navigator.userAgent,
    durationMs: Math.round(performance.now() - rec.start),
    calibrationSettings: calib,
    summary, samples: s,
  };
  download(JSON.stringify(payload), 'sgsl-v2-session.json', 'application/json');
  setStatus(`Session saved: ${summary.durationSec}s · render ${summary.renderFps.first25pct}→${summary.renderFps.last25pct} fps · ${summary.degraded ? '⚠ DEGRADED' : 'stable'}. Send me sgsl-v2-session.json.`, summary.degraded ? 'error' : 'success');
}

// ── Screenshot: camera | avatar + metrics footer (like v1) ─────────────────
function screenshot() {
  const av = avatar.captureCanvas();
  const camW = video.videoWidth || 640, camH = video.videoHeight || 480;
  const c = document.createElement('canvas');
  c.width = camW * 2 + 20; c.height = camH + 76;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0f1129'; ctx.fillRect(0, 0, c.width, c.height);
  // camera (mirror to match what you see on screen)
  ctx.save(); ctx.translate(camW, 0); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, camW, camH); ctx.restore();
  if (av) ctx.drawImage(av, camW + 20, 0, camW, camH);
  ctx.fillStyle = '#88aacc'; ctx.font = '12px monospace';
  (retarget._lastDebug || '').split('\n').slice(0, 4).forEach((ln, i) => ctx.fillText(ln.slice(0, 180), 8, camH + 18 + i * 15));
  c.toBlob((b) => { if (b) download(b, 'sgsl-v2-shot.png'); }, 'image/png');
}

function download(data, name, type) {
  const blob = (data instanceof Blob) ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Calibration panel (same setters as v1 -> tuning carries) ───────────────
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
    const refresh = () => { el.value = cur()[key]; if (lab) lab.textContent = fmt(cur()[key]); };
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

  const recBtn = document.getElementById('v2-rec');
  if (recBtn) recBtn.addEventListener('click', () => (rec.on ? stopRec() : startRec()));
  const shotBtn = document.getElementById('v2-shot');
  if (shotBtn) shotBtn.addEventListener('click', screenshot);
}

loadCalib();
applyCalib();
wireCalib();
startCamera();
