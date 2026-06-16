/* ============================================================
   SgSL Avatar — Sign Recorder
   ============================================================
   - Live MediaPipe Holistic capture with VRM avatar preview.
   - Deterministic framing gate: signer must be centered and at
     the right distance before Record is enabled. No more guessing
     and re-recording.
   - Calibration pose: 1.5s "hold still, arms at sides" baseline
     captured when starting a session. Stored with each sign so
     future ML pipelines can normalize across signers.
   - Per-frame timestamps (schema v2) so playback stays at the
     signer's real cadence.
   ============================================================ */

import { SMPLXAvatar } from './avatar.js';
import { SMPLXRetarget } from './retarget.js';
import { QualityGate, framingScore } from './quality.js';
import { lerpFrame } from './interp.js';
import * as signsSource from './signs-source.js';
import { exportSign, importFile } from './export-import.js';
import { reconstructionError } from './metrics.js';

// ─── State ──────────────────────────────────────────────────
let avatar = null;
let retarget = null;
let holisticModel = null;
let camera = null;
// MediaPipe Tasks HandLandmarker — true 3D (metric) world landmarks for the
// hands, fused into the Holistic results each frame. Holistic still drives
// pose + face. Loaded lazily; hands fall back to Holistic if it fails.
let handLandmarker = null;
let lastHandResult = null;
const HAND_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// Flip if the live diagnostic shows the hands reversed (MediaPipe handedness
// assumes a mirrored selfie image; our input to the model is raw).
const SWAP_HANDEDNESS = false;
let recording = false;
let frames = [];
let startTime = 0;          // performance.now() at record start
let timerInterval = null;
let lastQuality = null;
let lastFidelity = null;
let fidelityTolerance = 8;   // % of shoulder-width; the "margin of error"
let inited = false;

// Temporary live IK diagnostic (set false to hide). Draws a ring on each
// hand showing which avatar arm it drives and whether that arm is "on".
const DEBUG_OVERLAY = true;

// Framing gate state.
let framingOk = false;
let framingStreak = 0;       // consecutive frames in the target box
const FRAMING_STREAK_REQUIRED = 30;  // ~1s at 30fps
let latestFraming = null;    // {ok, score, reasons[]}

// Calibration state.
let calibrating = false;
let calibBuf = [];           // pose frames captured during calibration
let calibBaseline = null;    // persisted baseline for this session

// ─── Init ───────────────────────────────────────────────────
export async function init() {
  if (inited) return;
  inited = true;

  avatar = new SMPLXAvatar('rec-avatar-viewport');
  retarget = new SMPLXRetarget();
  retarget.setVideo(document.getElementById('rec-video'));
  retarget.setAvatar(avatar);

  await setupMediaPipe();

  document.getElementById('btn-rec-start')?.addEventListener('click', startRecording);
  document.getElementById('btn-rec-stop')?.addEventListener('click', stopRecording);
  document.getElementById('btn-rec-preview')?.addEventListener('click', previewRecording);
  document.getElementById('btn-rec-save')?.addEventListener('click', saveRecording);
  document.getElementById('btn-rec-export')?.addEventListener('click', exportRecording);
  document.getElementById('btn-rec-discard')?.addEventListener('click', discardRecording);
  document.getElementById('btn-calibrate')?.addEventListener('click', startCalibration);

  const tol = document.getElementById('tolerance-slider');
  const tolLabel = document.getElementById('tolerance-label');
  if (tol) {
    fidelityTolerance = parseFloat(tol.value);
    if (tolLabel) tolLabel.textContent = `${fidelityTolerance.toFixed(0)}%`;
    tol.addEventListener('input', () => {
      fidelityTolerance = parseFloat(tol.value);
      if (tolLabel) tolLabel.textContent = `${fidelityTolerance.toFixed(0)}%`;
      if (lastFidelity) renderFidelity(lastFidelity);
    });
  }

  const imp = document.getElementById('rec-import');
  if (imp) imp.addEventListener('change', importRecording);

  if (signsSource.isApiMode()) {
    setRecStatus('Dev API mode — recordings POST to the backend.', 'info');
  }

  // Record is disabled until framing is good AND calibration exists.
  const startBtn = document.getElementById('btn-rec-start');
  if (startBtn) startBtn.disabled = true;

  if (DEBUG_OVERLAY) addHandDumpButton();

  setRecStatus('Stand so the green guide turns solid, then calibrate, then record.', 'info');
}

// Auto-init when module is imported
init();

// ─── MediaPipe Setup ────────────────────────────────────────
async function setupMediaPipe() {
  const videoEl = document.getElementById('rec-video');
  const statusEl = document.getElementById('rec-camera-status');
  if (!videoEl) return;

  // @ts-ignore — loaded via CDN
  holisticModel = new window.Holistic({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${file}`,
  });
  holisticModel.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    smoothSegmentation: false,
    refineFaceLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  holisticModel.onResults(onHolisticResults);
  loadHandLandmarker(); // fire-and-forget; onFrame guards on readiness

  try {
    // @ts-ignore — loaded via CDN
    camera = new window.Camera(videoEl, {
      onFrame: async () => {
        if (handLandmarker && videoEl.readyState >= 2) {
          try { lastHandResult = handLandmarker.detectForVideo(videoEl, performance.now()); }
          catch (e) { /* transient — keep last result */ }
        }
        if (holisticModel) await holisticModel.send({ image: videoEl });
      },
      width: 640,
      height: 480,
    });
    await camera.start();
    if (statusEl) statusEl.classList.add('hidden');
  } catch (err) {
    if (statusEl) statusEl.textContent = `Camera error: ${err.message}`;
    setRecStatus(`Camera failed: ${err.message}`, 'error');
  }
}

// Load the Tasks HandLandmarker (reuses the legacy/js/tracker.js pattern).
async function loadHandLandmarker() {
  try {
    const vision = await import(`${HAND_CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${HAND_CDN}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
    console.log('[Recorder] HandLandmarker ready (3D hands)');
  } catch (e) {
    console.warn('[Recorder] HandLandmarker failed; hands fall back to Holistic:', e);
  }
}

// Fuse HandLandmarker output into the Holistic results object: route each hand
// to a signer side by handedness, providing both image landmarks (arm target +
// gating) and 3D world landmarks (palm/curl). Overrides Holistic's weaker hands;
// if HandLandmarker has no detection this frame, Holistic's hands remain.
function mergeHandLandmarker(results, hr) {
  if (!hr || !hr.landmarks || !hr.landmarks.length) return;
  for (let i = 0; i < hr.landmarks.length; i++) {
    let side = hr.handedness?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
    if (SWAP_HANDEDNESS) side = side === 'Right' ? 'Left' : 'Right';
    const lm = hr.landmarks[i];
    const world = hr.worldLandmarks?.[i] || null;
    if (side === 'Right') { results.rightHandLandmarks = lm; results.rightHandWorldLandmarks = world; }
    else { results.leftHandLandmarks = lm; results.leftHandWorldLandmarks = world; }
  }
}

// ── Debug: compact world-hand-landmark dump for offline tuning ──────────────
// Captures ~14 s of WORLD hand landmarks only (no face/pose), downsampled, as a
// small JSON. Lets us iterate hand fidelity on the user's REAL data offline.
let dumping = false, dumpFrames = [], dumpStart = 0, dumpLastT = -1e9, dumpDbgLogged = false;
const DUMP_MS = 30000, DUMP_INTERVAL = 150; // ~6.7 fps

function startHandDump() {
  if (dumping) return;
  dumping = true; dumpFrames = []; dumpStart = performance.now(); dumpLastT = -1e9; dumpDbgLogged = false;
  setRecStatus('Dumping 30s — slowly cycle: open palm · fist · V · point · OK · thumb, then rotate palm toward/away.', 'loading');
  setTimeout(stopHandDump, DUMP_MS);
}
function captureDumpFrame(results) {
  if (!dumping) return;
  const now = performance.now() - dumpStart;
  if (now - dumpLastT < DUMP_INTERVAL) return;
  dumpLastT = now;
  const enc = (lms) => (lms && lms.length) ? lms.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]) : null;
  // Source 1: merged results (what the avatar actually drove from).
  const rW = enc(results.rightHandWorldLandmarks), lW = enc(results.leftHandWorldLandmarks);
  // Source 2: raw HandLandmarker output (bypasses the merge), with handedness.
  const hr = lastHandResult, raw = [];
  if (hr && hr.worldLandmarks) for (let i = 0; i < hr.worldLandmarks.length; i++)
    raw.push({ side: hr.handedness?.[i]?.[0]?.categoryName || '?', w: enc(hr.worldLandmarks[i]) });
  if (!dumpDbgLogged) { dumpDbgLogged = true; console.log('[dump] merged R/L:', !!rW, !!lW, '| raw hands:', raw.length, '| hr keys:', hr ? Object.keys(hr).join(',') : 'none'); }
  dumpFrames.push({ t: Math.round(now), rW, lW, raw });
  if (dumpFrames.length % 6 === 0) {
    const withH = dumpFrames.filter(f => f.rW || f.lW || (f.raw && f.raw.length)).length;
    setRecStatus(`Dumping… ${dumpFrames.length} frames, ${withH} with a hand — keep cycling shapes.`, 'loading');
  }
}
function stopHandDump() {
  if (!dumping) return;
  dumping = false;
  const payload = { kind: 'sgsl-hand-dump', interval_ms: DUMP_INTERVAL, frames: dumpFrames };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'hand-dump.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const withHand = dumpFrames.filter(f => f.rW || f.lW).length;
  setRecStatus(`Hand dump saved: ${dumpFrames.length} frames (${withHand} with a hand). Send me hand-dump.json.`, 'success');
}
function addHandDumpButton() {
  if (document.getElementById('btn-hand-dump')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-hand-dump';
  btn.textContent = '⬇ Dump hands (14s)';
  btn.style.cssText = 'position:fixed;left:16px;bottom:56px;z-index:9999;padding:9px 13px;'
    + 'background:#33aa77;color:#fff;border:none;border-radius:7px;font:600 13px Inter,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  btn.addEventListener('click', startHandDump);
  document.body.appendChild(btn);
}

// ─── MediaPipe Results Handler ──────────────────────────────
function onHolisticResults(results) {
  // 0) Fuse in the dedicated 3D hand landmarks before anything reads hands.
  mergeHandLandmarker(results, lastHandResult);
  captureDumpFrame(results); // debug: world-hand dump (no-op unless dumping)

  // 1) Evaluate framing (needed by overlay + by gate).
  latestFraming = framingScore(results.poseLandmarks);
  updateFramingGate(latestFraming);

  // 2) Draw overlay (framing box color reflects gate state).
  drawOverlay(results, latestFraming);

  // 3) Live avatar preview.
  if (avatar?.vrm && retarget) {
    retarget.applyFromMediaPipe(avatar.vrm, results);
  }
  const dbg = document.getElementById('rec-debug');
  if (dbg && retarget._lastDebug) dbg.textContent = retarget._lastDebug;

  // 4) Capture: record frame or calibration sample.
  const frame = extractFrame(results);
  if (calibrating && frame?.pose) {
    calibBuf.push(frame);
  } else if (recording && frame) {
    frame.t = performance.now() - startTime;
    frames.push(frame);
  }
}

function extractFrame(results) {
  const frame = {
    t: 0,
    rightHand: null,
    leftHand: null,
    face: null,
    pose: null,
    poseWorld: null,
  };

  if (results.rightHandLandmarks) {
    frame.rightHand = results.rightHandLandmarks.map(lm => [lm.x, lm.y, lm.z]);
  }
  if (results.leftHandLandmarks) {
    frame.leftHand = results.leftHandLandmarks.map(lm => [lm.x, lm.y, lm.z]);
  }
  // 3D world hand landmarks (HandLandmarker) — drive palm facing + curl on replay.
  if (results.rightHandWorldLandmarks) {
    frame.rightHandWorld = results.rightHandWorldLandmarks.map(lm => [lm.x, lm.y, lm.z]);
  }
  if (results.leftHandWorldLandmarks) {
    frame.leftHandWorld = results.leftHandWorldLandmarks.map(lm => [lm.x, lm.y, lm.z]);
  }
  if (results.poseLandmarks) {
    frame.pose = results.poseLandmarks.map(lm => [lm.x, lm.y, lm.z, lm.visibility ?? 0]);
  }
  const poseWorld = results.za || results.ea;
  if (poseWorld) {
    frame.poseWorld = poseWorld.map(lm => [lm.x, lm.y, lm.z, lm.visibility ?? 0]);
  }
  if (results.faceLandmarks && results.faceLandmarks.length >= 468) {
    frame.face = results.faceLandmarks.map(lm => [lm.x, lm.y, lm.z]);
  }
  return frame;
}

// ─── Framing gate ───────────────────────────────────────────
function updateFramingGate(fr) {
  if (fr?.ok) framingStreak++; else framingStreak = 0;
  framingOk = framingStreak >= FRAMING_STREAK_REQUIRED;

  // Surface state.
  const fel = document.getElementById('rec-framing');
  if (fel) {
    const pct = Math.round((fr?.score ?? 0) * 100);
    fel.textContent = `Framing: ${pct}%`
      + (fr?.ok
          ? ` • ready in ${Math.max(0, FRAMING_STREAK_REQUIRED - framingStreak)}`
          : (fr?.reasons?.length ? ` • ${fr.reasons[0]}` : ''));
    fel.className = 'framing-badge ' + (framingOk ? 'ok' : (fr?.ok ? 'warming' : 'bad'));
  }

  const startBtn = document.getElementById('btn-rec-start');
  const calBtn = document.getElementById('btn-calibrate');
  if (startBtn) startBtn.disabled = !(framingOk && calibBaseline && !recording && !calibrating);
  if (calBtn) calBtn.disabled = !framingOk || recording || calibrating;
}

// ─── Calibration ────────────────────────────────────────────
const CALIB_MS = 1500;
function startCalibration() {
  if (!framingOk || recording) return;
  calibBuf = [];
  calibrating = true;
  setRecStatus('Calibrating — hold still with arms at sides...', 'loading');
  setTimeout(() => finishCalibration(), CALIB_MS);
}

function finishCalibration() {
  calibrating = false;
  if (calibBuf.length < 10) {
    setRecStatus('Calibration failed (not enough pose frames). Try again.', 'error');
    return;
  }

  // Average shoulder width + head-to-shoulder distance + shoulder midpoint.
  // Landmarks: 11 L-shoulder, 12 R-shoulder, 0 nose.
  let sw = 0, hsd = 0, midx = 0, midy = 0, n = 0;
  for (const f of calibBuf) {
    const p = f.pose;
    if (!p || !p[11] || !p[12] || !p[0]) continue;
    const L = p[11], R = p[12], N = p[0];
    sw  += Math.hypot(L[0] - R[0], L[1] - R[1]);
    const mx = (L[0] + R[0]) / 2, my = (L[1] + R[1]) / 2;
    hsd += Math.hypot(mx - N[0], my - N[1]);
    midx += mx; midy += my;
    n++;
  }
  if (!n) {
    setRecStatus('Calibration failed (no valid pose). Try again.', 'error');
    return;
  }
  calibBaseline = {
    shoulderWidth: sw / n,
    headToShoulder: hsd / n,
    shoulderMid: [midx / n, midy / n],
    frames: n,
    capturedAt: new Date().toISOString(),
  };
  calibBuf = [];
  setRecStatus('Calibration captured. You can record now.', 'success');
  updateFramingGate(latestFraming);  // re-enable record button
}

// ─── Camera Overlay ─────────────────────────────────────────
function drawOverlay(results, fr) {
  const canvas = document.getElementById('rec-overlay');
  const video = document.getElementById('rec-video');
  if (!canvas || !video) return;

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const drawPts = (landmarks, color, r = 3) => {
    if (!landmarks) return;
    ctx.fillStyle = color;
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  drawPts(results.rightHandLandmarks, '#00ff88');
  drawPts(results.leftHandLandmarks, '#ff8800');

  if (results.faceLandmarks) {
    ctx.fillStyle = 'rgba(136, 170, 238, 0.6)';
    const faceKeys = [10, 67, 109, 338, 297, 159, 145, 386, 374, 1, 4, 61, 291, 13, 14, 33, 133, 362, 263];
    for (const idx of faceKeys) {
      const lm = results.faceLandmarks[idx];
      if (lm) {
        ctx.beginPath();
        ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Framing guide — color reflects gate state.
  const color = fr?.ok
    ? (framingOk ? 'rgba(80, 220, 120, 0.85)' : 'rgba(220, 200, 80, 0.7)')
    : 'rgba(230, 90, 90, 0.8)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(fr?.ok ? [] : [6, 4]);

  // Live-anchored guide: ellipse hugs the actual head, signing-space
  // box drops from the shoulders. When pose isn't detected, fall back
  // to a faint centered hint so the user still knows roughly where to
  // stand.
  const nose = results.poseLandmarks?.[0];
  const ls = results.poseLandmarks?.[11];
  const rs = results.poseLandmarks?.[12];

  if (nose && ls && rs) {
    const noseX = nose.x * canvas.width;
    const noseY = nose.y * canvas.height;
    const shoulderMidX = ((ls.x + rs.x) / 2) * canvas.width;
    const shoulderMidY = ((ls.y + rs.y) / 2) * canvas.height;
    const shoulderWidthPx = Math.abs(ls.x - rs.x) * canvas.width;

    // Head ellipse sized to shoulder width (~0.85x wide, 1.1x tall).
    const headRx = Math.max(40, shoulderWidthPx * 0.45);
    const headRy = headRx * 1.25;
    ctx.beginPath();
    ctx.ellipse(noseX, noseY, headRx, headRy, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Shoulder line.
    const halfSh = shoulderWidthPx / 2;
    ctx.beginPath();
    ctx.moveTo(shoulderMidX - halfSh, shoulderMidY);
    ctx.lineTo(shoulderMidX + halfSh, shoulderMidY);
    ctx.stroke();

    // Signing-space box: from just above shoulders down to ~belt line,
    // as wide as 1.8x shoulder width. This is where hands need to land.
    const boxW = shoulderWidthPx * 1.8;
    const boxTop = shoulderMidY - shoulderWidthPx * 0.2;
    const boxHeight = shoulderWidthPx * 2.2;
    ctx.strokeRect(shoulderMidX - boxW / 2, boxTop, boxW, boxHeight);

    // Label the signing space so the user knows what the box means.
    ctx.fillStyle = color;
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('Signing space — place hands here', shoulderMidX - boxW / 2 + 6, boxTop + 14);
  } else {
    // No pose: dim dashed center hint.
    const cx = canvas.width * 0.5;
    ctx.strokeStyle = 'rgba(200, 200, 220, 0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, canvas.height * 0.3, canvas.width * 0.1, canvas.height * 0.13, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Arm connections.
  if (results.poseLandmarks) {
    ctx.strokeStyle = '#4488ff';
    ctx.lineWidth = 2;
    const pairs = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12]];
    for (const [a, b] of pairs) {
      const la = results.poseLandmarks[a];
      const lb = results.poseLandmarks[b];
      if (la && lb) {
        ctx.beginPath();
        ctx.moveTo(la.x * canvas.width, la.y * canvas.height);
        ctx.lineTo(lb.x * canvas.width, lb.y * canvas.height);
        ctx.stroke();
      }
    }
  }

  // ── Temporary IK diagnostic: ring each arm's target, colored by on/off. ──
  if (DEBUG_OVERLAY) {
    const W = canvas.width, H = canvas.height;
    const pl = results.poseLandmarks;
    // Reflection routing (see retarget.js): the signer's RIGHT hand (green)
    // drives the avatar's LEFT arm; the signer's LEFT hand (orange) drives the
    // avatar's RIGHT arm. Pose-wrist fallbacks: 16 → avatar-left, 15 → -right.
    const lTgt = results.rightHandLandmarks?.[0] || pl?.[16];
    const rTgt = results.leftHandLandmarks?.[0]  || pl?.[15];
    const lOn = (retarget?._leftArmStreak  ?? 0) > 0;
    const rOn = (retarget?._rightArmStreak ?? 0) > 0;
    // Counter-flip text so it reads correctly on the scaleX(-1) canvas.
    const label = (cx, cy, s, color) => {
      ctx.save(); ctx.translate(cx, cy); ctx.scale(-1, 1);
      ctx.fillStyle = color; ctx.font = 'bold 13px Inter, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText(s, 18, 0); ctx.restore();
    };
    const ring = (lm, text, on) => {
      if (!lm) return;
      const x = lm.x * W, y = lm.y * H;
      const col = on ? 'rgba(60, 230, 120, 0.95)' : 'rgba(165, 165, 190, 0.85)';
      ctx.lineWidth = 3; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke();
      label(x, y, text, col);
    };
    ring(lTgt, `${lOn ? 'ON' : 'off'} → avatar LEFT`, lOn);
    ring(rTgt, `${rOn ? 'ON' : 'off'} → avatar RIGHT`, rOn);
  }

  if (recording) {
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.arc(20, 20, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText('REC', 34, 25);
  }
  if (calibrating) {
    ctx.fillStyle = 'rgba(80, 140, 220, 0.95)';
    ctx.font = 'bold 16px Inter, sans-serif';
    ctx.fillText('CALIBRATING', canvas.width - 140, 24);
  }
}

// ─── Recording Controls ─────────────────────────────────────
function startRecording() {
  const label = document.getElementById('rec-label')?.value.trim();
  if (!label) { setRecStatus('Please enter a sign label first.', 'error'); return; }
  if (!framingOk) { setRecStatus('Framing not ready — align with the guide.', 'error'); return; }
  if (!calibBaseline) { setRecStatus('Please calibrate first (arms at sides).', 'error'); return; }

  frames = [];
  recording = true;
  startTime = performance.now();
  retarget.reset();

  document.getElementById('btn-rec-start').disabled = true;
  document.getElementById('btn-rec-stop').disabled = false;
  document.getElementById('quality-panel')?.classList.add('hidden');

  const timerEl = document.getElementById('rec-timer');
  timerInterval = setInterval(() => {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    if (timerEl) timerEl.textContent = `${elapsed}s (${frames.length} frames)`;
  }, 100);

  setRecStatus(`Recording "${label}"... Perform the sign now.`, 'loading');
}

function stopRecording() {
  recording = false;
  clearInterval(timerInterval);

  document.getElementById('btn-rec-start').disabled = false;
  document.getElementById('btn-rec-stop').disabled = true;

  if (frames.length < 5) {
    setRecStatus('Too few frames. Try again — hold the sign longer.', 'error');
    return;
  }

  lastQuality = QualityGate.analyze(frames);
  showQualityResults(lastQuality);

  // Objective replay-fidelity number (how faithfully the engine can
  // reproduce this recording). Drives the "loop till perfected" cycle.
  lastFidelity = reconstructionError({ landmarks: frames, calibration: calibBaseline });
  renderFidelity(lastFidelity);

  setRecStatus(lastQuality.message, lastQuality.pass ? 'success' : 'error');
}

function renderFidelity(fid) {
  const el = document.getElementById('fidelity-readout');
  if (!el) return;
  if (fid.overall == null) {
    el.innerHTML = `<span class="q-grade q-bad">–</span> <span class="q-overall-text">Fidelity: ${fid.note || 'n/a'}</span>`;
    return;
  }
  const pass = fid.overall <= fidelityTolerance;
  const cls = pass ? 'good' : 'bad';
  const parts = ['rightHand', 'leftHand', 'pose']
    .filter(k => fid.perChannel[k] != null)
    .map(k => `${k.replace('Hand', ' hand')}: ${fid.perChannel[k]}%`)
    .join(' · ');
  el.innerHTML =
    `<span class="q-grade q-${cls}">${fid.grade}</span> ` +
    `<span class="q-overall-text">Replay error ${fid.overall}% of shoulder-width ` +
    `— ${pass ? 'within' : 'OVER'} ${fidelityTolerance}% tolerance</span>` +
    (parts ? `<div class="q-issues" style="margin-top:4px">${parts}</div>` : '');
}

function showQualityResults(report) {
  const panel = document.getElementById('quality-panel');
  const scoresEl = document.getElementById('quality-scores');
  const overallEl = document.getElementById('quality-overall');
  const saveBtn = document.getElementById('btn-rec-save');
  if (!panel) return;
  panel.classList.remove('hidden');

  const channels = [
    { key: 'rightHand', label: 'Right Hand' },
    { key: 'leftHand',  label: 'Left Hand' },
    { key: 'pose',      label: 'Body Pose' },
    { key: 'face',      label: 'Face' },
    { key: 'jitter',    label: 'Stability' },
    { key: 'framing',   label: 'Framing' },
  ];

  let html = '';
  for (const ch of channels) {
    const d = report.details[ch.key];
    const score = d?.score ?? 0;
    const pct = Math.round(score * 100);
    const cls = pct >= 70 ? 'good' : pct >= 40 ? 'ok' : 'bad';
    const extra = d?.completeness !== undefined
      ? ` (${Math.round(d.completeness * 100)}% present)` : '';
    html += `<div class="q-row">
      <span class="q-label">${ch.label}</span>
      <div class="q-bar"><div class="q-fill q-${cls}" style="width:${pct}%"></div></div>
      <span class="q-pct">${pct}%${extra}</span>
    </div>`;
  }
  if (scoresEl) scoresEl.innerHTML = html;

  const cls = report.grade === 'A' ? 'good' : (report.grade === 'B' || report.grade === 'C') ? 'ok' : 'bad';
  if (overallEl) {
    overallEl.innerHTML = `
      <span class="q-grade q-${cls}">${report.grade}</span>
      <span class="q-overall-text">${report.overall}% — ${report.details.frameCount} frames, ${report.details.duration}</span>
    `;
  }
  if (report.issues?.length) {
    const issueHtml = report.issues.map(i => `<li>${i}</li>`).join('');
    if (overallEl) overallEl.innerHTML += `<ul class="q-issues">${issueHtml}</ul>`;
  }
  if (saveBtn) saveBtn.disabled = !report.pass;
}

function previewRecording() {
  if (!frames.length || !avatar?.loaded) return;

  setRecStatus(`Previewing (${frames.length} frames)...`, 'info');
  retarget.reset();
  avatar.setPlaying(true);

  // Real-time preview driven by stored frame timestamps.
  const t0 = performance.now();
  const baseT = frames[0].t ?? 0;
  let i = 0;

  const step = () => {
    const target = performance.now() - t0 + baseT;
    while (i < frames.length - 1 && frames[i + 1].t <= target) i++;

    if (i >= frames.length - 1) {
      renderPreviewFrame(frames[frames.length - 1]);
      avatar.setPlaying(false);
      setRecStatus('Preview complete. Save or discard.', 'success');
      return;
    }

    const a = frames[i], b = frames[i + 1];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(Math.max((target - a.t) / span, 0), 1);
    renderPreviewFrame(lerpFrame(a, b, u));
    requestAnimationFrame(step);
  };
  step();
}

function renderPreviewFrame(frame) {
  if (!avatar?.vrm || !retarget || !frame) return;
  const toMP = (arr) => arr ? arr.map(p => ({ x: p[0], y: p[1], z: p[2] ?? 0, visibility: p[3] ?? 1 })) : null;
  retarget.applyFromMediaPipe(avatar.vrm, {
    poseLandmarks: toMP(frame.pose),
    za: toMP(frame.poseWorld || frame.pose),
    faceLandmarks: toMP(frame.face),
    rightHandLandmarks: toMP(frame.rightHand),
    leftHandLandmarks: toMP(frame.leftHand),
  });
}

// Build the canonical sign record — identical shape to the committed
// signs/<label>.json files and the (future) Postgres `signs` row.
function buildRecord(label) {
  return {
    label,
    schema_version: 2,
    landmarks: frames,
    calibration: calibBaseline,
    quality: lastQuality ? {
      overall: lastQuality.overall,
      grade: lastQuality.grade,
      details: lastQuality.details,
    } : null,
    fidelity: lastFidelity ? {
      overall: lastFidelity.overall,
      grade: lastFidelity.grade,
      perChannel: lastFidelity.perChannel,
    } : null,
    createdAt: new Date().toISOString(),
    source: 'recorded',
  };
}

async function saveRecording() {
  const label = document.getElementById('rec-label')?.value.trim();
  if (!label || !frames.length) return;

  setRecStatus('Saving to this device...', 'loading');
  try {
    await signsSource.saveSign(buildRecord(label));
    setRecStatus(
      `Sign "${label}" saved on this device. Use Export to add it to the shared library (PR the file into sgsl-app/signs/).`,
      'success',
    );
    discardRecording();
  } catch (err) {
    setRecStatus(`Save failed: ${err.message}`, 'error');
  }
}

// One-click download of the current recording as <label>.json.
function exportRecording() {
  const label = document.getElementById('rec-label')?.value.trim();
  if (!label || !frames.length) { setRecStatus('Nothing to export.', 'error'); return; }
  exportSign(buildRecord(label));
  setRecStatus(`Exported "${label}.json". Drop it into sgsl-app/signs/ and open a PR.`, 'info');
}

// Import a sign JSON file straight into this device's library.
async function importRecording(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const rec = await importFile(file);
    await signsSource.saveSign(rec);
    setRecStatus(`Imported "${rec.label}" into this device's library.`, 'success');
  } catch (err) {
    setRecStatus(`Import failed: ${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
}

function discardRecording() {
  frames = [];
  lastQuality = null;
  lastFidelity = null;
  document.getElementById('quality-panel')?.classList.add('hidden');
  const fid = document.getElementById('fidelity-readout');
  if (fid) fid.innerHTML = '';
  const timerEl = document.getElementById('rec-timer');
  if (timerEl) timerEl.textContent = '';
  const saveBtn = document.getElementById('btn-rec-save');
  if (saveBtn) saveBtn.disabled = true;
}

// ─── Helpers ────────────────────────────────────────────────
function setRecStatus(msg, type) {
  const el = document.getElementById('rec-status');
  if (el) {
    el.textContent = msg;
    el.className = `status status-${type}`;
  }
}
