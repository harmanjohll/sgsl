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
import { drawSkeleton, clearCanvas } from './dots.js';

// ─── State ──────────────────────────────────────────────────
let avatar = null;
let retarget = null;
let holisticModel = null;
let camera = null;
let recording = false;
let frames = [];
let startTime = 0;          // performance.now() at record start
let timerInterval = null;
let lastQuality = null;
let inited = false;

// Framing gate state.
let framingOk = false;
let framingStreak = 0;       // consecutive frames in the target box
const FRAMING_STREAK_REQUIRED = 30;  // ~1s at 30fps
let latestFraming = null;    // {ok, score, reasons[]}

// Calibration state.
//
// We capture a small library of "anchor poses" — known body
// positions the user holds for ~1s each. These anchors give the
// retargeting layer (and quality scoring) a personal reference for
// what the user's body actually looks like at signing extremes
// instead of guessing from per-frame geometry alone.
//
// CALIB_POSES is the script the user steps through. Each entry:
//   { id, label, instruction, holdMs }
// id is short (saved with the calibration), label is what the
// button shows during that step, instruction is the user prompt.
//
// Hold time is 3.5s per step — deliberately long enough to read
// the instruction, get into the pose, and hold steady for the
// sample. The user fed back that 1500ms was so fast they couldn't
// even read the instructions.
const CALIB_POSES = [
  { id: 'rest',     label: 'Step 1/5: arms at sides',        instruction: 'Stand naturally. Arms relaxed at your sides. Hold still.', holdMs: 3500 },
  { id: 'r_chest',  label: 'Step 2/5: right hand at chest',  instruction: 'Right hand flat at your chest, palm toward camera. Hold still.', holdMs: 3500 },
  { id: 'r_face',   label: 'Step 3/5: right hand at face',   instruction: 'Right hand at face level, palm toward camera. Hold still.', holdMs: 3500 },
  { id: 'l_chest',  label: 'Step 4/5: left hand at chest',   instruction: 'Left hand flat at your chest, palm toward camera. Hold still.', holdMs: 3500 },
  { id: 'l_face',   label: 'Step 5/5: left hand at face',    instruction: 'Left hand at face level, palm toward camera. Hold still.', holdMs: 3500 },
];

let calibrating = false;
let calibStepIdx = 0;        // which CALIB_POSES entry we're on
let calibStepBuf = [];       // pose frames captured during the current step
let calibBaseline = null;    // full calibration profile for this session

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
  document.getElementById('btn-rec-discard')?.addEventListener('click', discardRecording);

  // Dots-review controls (right pane).
  document.getElementById('btn-review-play')?.addEventListener('click', startReviewPlayback);
  document.getElementById('btn-review-scrub')?.addEventListener('click', stopReviewPlayback);
  document.getElementById('btn-map-to-mei')?.addEventListener('click', mapToMei);
  document.getElementById('btn-review-keep-dots')?.addEventListener('click', saveDotsOnly);
  document.getElementById('btn-review-rerecord')?.addEventListener('click', discardAndReRecord);
  document.getElementById('btn-calibrate')?.addEventListener('click', startCalibration);

  // Record is disabled until framing is good AND calibration exists.
  const startBtn = document.getElementById('btn-rec-start');
  if (startBtn) startBtn.disabled = true;

  setRecStatus('Stand so the green guide turns solid. Then calibrate (you will be guided through 5 quick poses).', 'info');
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

  try {
    // @ts-ignore — loaded via CDN
    camera = new window.Camera(videoEl, {
      onFrame: async () => { if (holisticModel) await holisticModel.send({ image: videoEl }); },
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

// ─── MediaPipe Results Handler ──────────────────────────────
function onHolisticResults(results) {
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

  // 3b) Live dots on the right-pane comparison canvas. Skip when
  // we're playing back a saved recording (reviewPlaybackState.rafId
  // is non-null then and owns the canvas).
  if (!reviewPlaybackState.rafId) {
    const dotsCanvas = document.getElementById('rec-dots-canvas');
    if (dotsCanvas) drawSkeleton(dotsCanvas, results);
  }

  // 4) Capture: record frame or calibration sample.
  const frame = extractFrame(results);
  if (calibrating && frame?.pose) {
    calibStepBuf.push(frame);
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
//
// Multi-pose calibration: walk the user through CALIB_POSES,
// holding each for ~1.5s. For each, average a small window of
// pose+hand landmarks to get a stable anchor sample. The full
// set of anchors is stored as calibBaseline.poses[] so future
// passes (and recorded signs) can normalize against the user's
// own body proportions and range of motion instead of guessing
// from per-frame geometry.

function startCalibration() {
  if (!framingOk || recording) return;
  calibrating = true;
  calibStepIdx = 0;
  calibStepBuf = [];
  // Start the first step on next tick to give the user a moment
  // to read the instruction before frames are captured.
  calibBaseline = {
    poses: [],
    capturedAt: new Date().toISOString(),
  };
  runCalibrationStep();
}

function runCalibrationStep() {
  if (!calibrating) return;
  if (calibStepIdx >= CALIB_POSES.length) {
    finishCalibration();
    return;
  }
  const step = CALIB_POSES[calibStepIdx];
  calibStepBuf = [];

  // Show a live countdown so the user can see how much longer to
  // hold the pose. Tick once per 100ms; status bar carries the
  // instruction plus a "N.Ns remaining" tail. Previous version
  // ran a single setTimeout with no countdown and the instruction
  // text disappeared faster than you could read it.
  const startAt = performance.now();
  const renderCountdown = () => {
    if (!calibrating) return;
    const elapsed = performance.now() - startAt;
    const remaining = Math.max(0, step.holdMs - elapsed);
    setRecStatus(
      `${step.label} — ${step.instruction} (${(remaining / 1000).toFixed(1)}s)`,
      'loading',
    );
    if (remaining <= 0) {
      captureCalibrationStep();
      return;
    }
    setTimeout(renderCountdown, 100);
  };
  renderCountdown();
}

function captureCalibrationStep() {
  if (!calibrating) return;
  const step = CALIB_POSES[calibStepIdx];
  const buf = calibStepBuf;

  if (buf.length < 5) {
    setRecStatus(`Calibration step "${step.id}" failed — not enough pose frames. Restarting calibration.`, 'error');
    calibrating = false;
    calibBaseline = null;
    updateFramingGate(latestFraming);
    return;
  }

  // Aggregate this step into one anchor sample.
  // Averages: shoulder positions, wrist positions per side,
  // shoulder width, head-to-shoulder distance, shoulder midpoint.
  // Pose landmark indices: 0 nose, 11 L-shoulder, 12 R-shoulder,
  // 13 L-elbow, 14 R-elbow, 15 L-wrist, 16 R-wrist.
  const acc = {
    nose: [0, 0], lSh: [0, 0], rSh: [0, 0],
    lEl: [0, 0], rEl: [0, 0], lWr: [0, 0], rWr: [0, 0],
    sw: 0, hsd: 0,
  };
  let n = 0;
  for (const f of buf) {
    const p = f.pose;
    if (!p || !p[0] || !p[11] || !p[12]) continue;
    const N = p[0], L = p[11], R = p[12];
    acc.nose[0] += N[0]; acc.nose[1] += N[1];
    acc.lSh[0] += L[0]; acc.lSh[1] += L[1];
    acc.rSh[0] += R[0]; acc.rSh[1] += R[1];
    if (p[13]) { acc.lEl[0] += p[13][0]; acc.lEl[1] += p[13][1]; }
    if (p[14]) { acc.rEl[0] += p[14][0]; acc.rEl[1] += p[14][1]; }
    if (p[15]) { acc.lWr[0] += p[15][0]; acc.lWr[1] += p[15][1]; }
    if (p[16]) { acc.rWr[0] += p[16][0]; acc.rWr[1] += p[16][1]; }
    acc.sw += Math.hypot(L[0] - R[0], L[1] - R[1]);
    const mx = (L[0] + R[0]) / 2, my = (L[1] + R[1]) / 2;
    acc.hsd += Math.hypot(mx - N[0], my - N[1]);
    n++;
  }

  if (!n) {
    setRecStatus(`Calibration step "${step.id}" failed — no valid pose. Restarting.`, 'error');
    calibrating = false;
    calibBaseline = null;
    updateFramingGate(latestFraming);
    return;
  }

  const norm = (v) => [v[0] / n, v[1] / n];
  calibBaseline.poses.push({
    id: step.id,
    nose: norm(acc.nose),
    leftShoulder:  norm(acc.lSh),
    rightShoulder: norm(acc.rSh),
    leftElbow:     norm(acc.lEl),
    rightElbow:    norm(acc.rEl),
    leftWrist:     norm(acc.lWr),
    rightWrist:    norm(acc.rWr),
    shoulderWidth:  acc.sw / n,
    headToShoulder: acc.hsd / n,
    samples: n,
  });

  calibStepIdx++;
  // Brief pause so the user can transition to the next pose.
  setTimeout(() => runCalibrationStep(), 600);
}

function finishCalibration() {
  calibrating = false;
  // Derive top-level summary fields for backward compat with
  // older quality-gate code that read shoulderWidth / shoulderMid
  // straight off calibBaseline.
  const rest = calibBaseline.poses.find(p => p.id === 'rest') || calibBaseline.poses[0];
  if (rest) {
    calibBaseline.shoulderWidth  = rest.shoulderWidth;
    calibBaseline.headToShoulder = rest.headToShoulder;
    calibBaseline.shoulderMid    = [
      (rest.leftShoulder[0] + rest.rightShoulder[0]) / 2,
      (rest.leftShoulder[1] + rest.rightShoulder[1]) / 2,
    ];
  }
  // Per-arm reach extents derived from the anchors. Used by the
  // retargeter to normalize a frame's shoulder→wrist length to a
  // [0..1] reach scalar (helps invariance to user height /
  // distance from the camera).
  calibBaseline.armReach = computeArmReach(calibBaseline.poses);

  // Per-segment rest offsets. These are the 2D image-space vectors
  // from shoulder→elbow and elbow→wrist WHEN THE USER IS AT REST
  // (arms at sides). The retargeter subtracts these from the live
  // per-frame shoulder→elbow and elbow→wrist vectors to produce
  // "deflection from rest" — so that (a) Mei's arm sits at rest
  // when the user's arm is at rest regardless of camera framing,
  // and (b) raising the user's arm produces a direction that's
  // already rest-relative.
  //
  // Naming: "left*" and "right*" match MediaPipe's anatomical side
  // labels (leftShoulder = MP[11] = user's anatomical left). The
  // retargeter looks these up via its own side accounting.
  calibBaseline.restOffsets = computeRestOffsets(calibBaseline.poses);

  setRecStatus(`Calibration complete (${calibBaseline.poses.length} anchors). You can record now.`, 'success');
  // Push reach data into the live retarget so the next frame
  // benefits immediately; for playback it travels with the saved
  // sign JSON.
  if (retarget) retarget.setCalibration(calibBaseline);
  updateFramingGate(latestFraming);
}

/**
 * Per-segment rest offsets from the rest anchor. Each offset is a
 * {dx, dy} pair in normalized image coordinates representing where
 * the next joint sits relative to the parent joint at rest.
 *
 * Fallback: if the elbow landmark wasn't captured (MP sometimes
 * misses it at laptop crops), we split the shoulder→wrist vector
 * in half — not anatomically exact but a reasonable straight-arm
 * approximation. The retargeter falls back further to no
 * subtraction at all if a key is missing.
 */
function computeRestOffsets(poses) {
  const rest = poses.find(p => p.id === 'rest');
  if (!rest) return null;

  const seg = (from, to) => ({
    dx: to[0] - from[0],
    dy: to[1] - from[1],
  });
  const halfway = (sh, wr) => ({
    dx: (wr[0] - sh[0]) / 2,
    dy: (wr[1] - sh[1]) / 2,
  });

  // Elbow presence check: at laptop crops, MP sometimes returns
  // elbow landmarks that averaged to (0, 0) over the calibration
  // window (i.e., it never saw them). Treat near-zero elbow as
  // missing and substitute the midpoint fallback.
  const elbowOk = (el, sh) => el && !(Math.abs(el[0]) < 1e-6 && Math.abs(el[1]) < 1e-6)
                           && Math.abs(el[0] - sh[0]) + Math.abs(el[1] - sh[1]) > 1e-4;

  const out = {};
  if (elbowOk(rest.leftElbow, rest.leftShoulder)) {
    out.leftShoulderElbow = seg(rest.leftShoulder, rest.leftElbow);
    out.leftElbowWrist    = seg(rest.leftElbow,    rest.leftWrist);
  } else {
    out.leftShoulderElbow = halfway(rest.leftShoulder, rest.leftWrist);
    out.leftElbowWrist    = halfway(rest.leftShoulder, rest.leftWrist);
  }
  if (elbowOk(rest.rightElbow, rest.rightShoulder)) {
    out.rightShoulderElbow = seg(rest.rightShoulder, rest.rightElbow);
    out.rightElbowWrist    = seg(rest.rightElbow,    rest.rightWrist);
  } else {
    out.rightShoulderElbow = halfway(rest.rightShoulder, rest.rightWrist);
    out.rightElbowWrist    = halfway(rest.rightShoulder, rest.rightWrist);
  }
  return out;
}

/**
 * From the captured anchors, find the longest shoulder→wrist
 * length on each side. That length corresponds to "fully
 * extended" for this user at this distance from the camera.
 * The retargeter uses it to scale per-frame reach into a
 * normalized 0..1 range.
 */
function computeArmReach(poses) {
  let leftMax = 0, rightMax = 0;
  for (const p of poses) {
    const lL = Math.hypot(p.leftWrist[0] - p.leftShoulder[0],
                          p.leftWrist[1] - p.leftShoulder[1]);
    const rL = Math.hypot(p.rightWrist[0] - p.rightShoulder[0],
                          p.rightWrist[1] - p.rightShoulder[1]);
    if (lL > leftMax) leftMax = lL;
    if (rL > rightMax) rightMax = rL;
  }
  // Floor at the rest shoulder width × 0.6 to avoid divide-by-tiny
  // when calibration was done with arms barely raised.
  const rest = poses.find(p => p.id === 'rest');
  const minReach = rest ? rest.shoulderWidth * 0.6 : 0.15;
  return {
    left:  Math.max(leftMax, minReach),
    right: Math.max(rightMax, minReach),
  };
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

  // Starting a fresh recording: hide the post-record review
  // controls, stop any lingering review playback, and clear the
  // smoothed-frames cache (else stale smoothed data from a prior
  // session would leak into the next Map-to-Mei click). Live dots
  // will resume populating the right-pane canvas via
  // onHolisticResults for the duration of the capture.
  stopReviewPlayback();
  smoothedFrames = null;
  showReviewControls(false);
  const dotsC = document.getElementById('rec-dots-canvas');
  if (dotsC) clearCanvas(dotsC);

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

  // Show review controls + start a synced dots + Mei playback of
  // the recording. Both panes play in lockstep so the user can
  // compare "what MediaPipe caught" (dots) against "how Mei renders
  // it" (avatar) on the same recording. The save decision is made
  // on the dots side — it's the ground truth — but seeing Mei
  // next to it tells the user whether Map-to-Mei will be useful.
  showReviewControls(true);
  startReviewPlayback();
  setRecStatus(
    `Recording captured (${frames.length} frames, ${((frames[frames.length-1].t - frames[0].t)/1000).toFixed(1)}s). `
    + 'Both panes play the same recording. Map to Mei to regenerate the avatar animation from these frames.',
    lastQuality.pass ? 'success' : 'info',
  );
}

// ─── Review playback: dots + Mei in lockstep ───────────────
//
// Both the Mei viewport and the dots canvas are always visible
// (side-by-side in the HTML). Their playback is driven from a
// single RAF loop so they stay in sync: at each frame we draw
// the dots AND push the same frame through the retargeter for
// Mei. This is the multi-panel test the user asked for — you
// see what MediaPipe captured and how Mei renders it, at once.
//
// Before recording: nothing is playing. Mei viewport live-mirrors
// the camera (handled by onHolisticResults → retarget.applyFromMediaPipe).
// The dots canvas also gets drawn from the same onHolisticResults
// so live capture shows both panes in real time.
//
// After Stop: live flow stops. reviewPlaybackState.rafId owns the
// playback loop. When it's null, no playback is running.

let reviewPlaybackState = { rafId: null, start: 0, i: 0 };

// Populated by mapToMei(): same shape as `frames` (array of
// { t, pose, poseWorld, face, leftHand, rightHand }), but with
// landmarks temporally smoothed via a centered moving average.
// The Mei pane reads from this when non-null so the user sees
// the smoothed version; the dots pane always reads raw `frames`
// so it stays a ground-truth reference.
let smoothedFrames = null;

function showReviewControls(show) {
  const el = document.getElementById('rec-review-controls');
  if (el) el.classList.toggle('hidden', !show);
}

// ─── Temporal smoothing for Map-to-Mei ─────────────────────
//
// Centered moving average with window radius 3 → 7-frame kernel
// centered on each frame. Applied per-landmark, per-channel
// (x, y, z). Visibility is copied straight through from the
// center frame (averaging visibility produces weird in-between
// values at detection-loss boundaries).
//
// Kernel choice rationale: at 30 fps, 7 frames = ~233 ms. SgSL
// transitions happen on a similar timescale, so this smooths
// per-landmark jitter (few-pixel noise between adjacent frames)
// without destroying intentional motion shape. Moving average is
// deliberately simple — if later we want a one-euro filter or
// Kalman, we replace this function and callers don't change.
function smoothFrames(srcFrames, radius = 3) {
  if (!srcFrames || srcFrames.length === 0) return srcFrames;
  const channels = ['pose', 'poseWorld', 'face', 'leftHand', 'rightHand'];
  const out = [];
  const N = srcFrames.length;

  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(N - 1, i + radius);
    const center = srcFrames[i];
    const smoothed = { t: center.t };

    for (const ch of channels) {
      // Reference shape from the center frame tells us how many
      // landmarks to expect. Landmarks that are null on the
      // center frame stay null in the output (we don't invent
      // data that MediaPipe didn't detect on this frame).
      const ref = center[ch];
      if (!ref) { smoothed[ch] = null; continue; }
      const chOut = new Array(ref.length);
      for (let k = 0; k < ref.length; k++) {
        let sx = 0, sy = 0, sz = 0, count = 0;
        for (let j = lo; j <= hi; j++) {
          const lm = srcFrames[j]?.[ch]?.[k];
          if (!lm) continue;
          sx += lm[0];
          sy += lm[1];
          sz += lm[2] ?? 0;
          count++;
        }
        if (count === 0) {
          // Neighbor window had no data for this landmark — fall
          // back to the center frame so we don't emit null where
          // the raw had data.
          chOut[k] = ref[k];
          continue;
        }
        const avg = [sx / count, sy / count, sz / count];
        // Preserve the visibility tag from the center frame
        // unchanged (don't average it).
        if (ref[k].length > 3) avg.push(ref[k][3]);
        chOut[k] = avg;
      }
      smoothed[ch] = chOut;
    }
    out.push(smoothed);
  }
  return out;
}

function startReviewPlayback() {
  if (!frames.length) return;
  const canvas = document.getElementById('rec-dots-canvas');
  if (!canvas) return;
  stopReviewPlayback();

  reviewPlaybackState.start = performance.now();
  reviewPlaybackState.i = 0;
  const baseT = frames[0].t ?? 0;
  const lastT = frames[frames.length - 1].t ?? 0;

  // Mei side: reset the retarget state so playback starts from
  // rest rather than wherever the live mirror left her.
  if (retarget) retarget.reset();
  if (avatar) avatar.setPlaying(true);

  // Source for the Mei pane: smoothed frames after Map-to-Mei has
  // computed them, else fall back to raw. Dots pane always uses raw
  // `frames` so the user has a ground-truth reference to compare
  // against whatever Mei is rendering.
  const meiSrc = smoothedFrames || frames;

  const tick = () => {
    const target = performance.now() - reviewPlaybackState.start + baseT;
    while (reviewPlaybackState.i < frames.length - 1
           && frames[reviewPlaybackState.i + 1].t <= target) {
      reviewPlaybackState.i++;
    }
    const info = document.getElementById('rec-review-info');
    if (info) info.textContent = `${reviewPlaybackState.i + 1} / ${frames.length}`;

    if (target >= lastT) {
      const lastDots = frames[frames.length - 1];
      const lastMei  = meiSrc[meiSrc.length - 1];
      drawSkeleton(canvas, lastDots);
      renderPreviewFrame(lastMei);
      if (avatar) avatar.setPlaying(false);
      reviewPlaybackState.rafId = null;
      setRecStatus('Playback complete. Map to Mei, or save as dots.', 'info');
      return;
    }

    const i = reviewPlaybackState.i;
    const a  = frames[i];
    const b  = frames[i + 1];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(Math.max((target - a.t) / span, 0), 1);

    drawSkeleton(canvas, interp(a, b, u));
    // Mei uses the parallel-indexed smoothed pair when available.
    // smoothFrames preserves length + timestamps so i/i+1 align.
    const aMei = meiSrc[i];
    const bMei = meiSrc[Math.min(i + 1, meiSrc.length - 1)];
    renderPreviewFrame(interp(aMei, bMei, u));

    reviewPlaybackState.rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopReviewPlayback() {
  if (reviewPlaybackState.rafId) cancelAnimationFrame(reviewPlaybackState.rafId);
  reviewPlaybackState.rafId = null;
  if (avatar) avatar.setPlaying(false);
}

// ─── Map-to-Mei compute step ───────────────────────────────
//
// Applies centered moving-average smoothing to the captured
// landmarks and stores the result in module-scope `smoothedFrames`.
// startReviewPlayback() reads smoothedFrames for the Mei pane when
// it's non-null, so the user visibly sees the compute's effect:
// dots continue to jitter at per-frame noise scale; Mei animates
// smoothly.
//
// Next: replace smoothFrames with library-matching (if recording
// is close to a known canonical, play the canonical) or a learned
// classifier — both swap in here without changing the UI path.
async function mapToMei() {
  if (!frames.length) return;
  const N = frames.length;
  setRecStatus(`Map-to-Mei: smoothing ${N} frames…`, 'loading');
  stopReviewPlayback();
  // Small await so the status text paints before the (fast)
  // smoothing runs — purely cosmetic.
  await new Promise(r => setTimeout(r, 20));

  const radius = 3;
  const t0 = performance.now();
  smoothedFrames = smoothFrames(frames, radius);
  const elapsed = (performance.now() - t0).toFixed(0);
  setRecStatus(
    `Map-to-Mei: smoothed ${N} frames (${2 * radius + 1}-frame window, ${elapsed}ms). Playing.`,
    'success',
  );
  startReviewPlayback();
}

function saveDotsOnly() {
  // Same save path as the existing Save button — the stored JSON
  // contains raw landmarks; "dots only" vs "mapped to Mei" is a
  // viewer-side rendering choice, not a schema difference. This
  // button exists so the user can commit without running another
  // Map-to-Mei pass first.
  saveRecording();
}

function discardAndReRecord() {
  stopReviewPlayback();
  smoothedFrames = null;
  const canvas = document.getElementById('rec-dots-canvas');
  if (canvas) clearCanvas(canvas);
  showReviewControls(false);
  discardRecording();
  setRecStatus('Ready. Press Record to try again.', 'info');
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
    renderPreviewFrame(interp(a, b, u));
    requestAnimationFrame(step);
  };
  step();
}

function interp(a, b, u) {
  const iLM = (la, lb) => {
    if (!la || !lb) return lb || la;
    return lb.map((pt, j) => {
      const pa = la[j] || pt;
      const out = [
        (pa[0] ?? pt[0]) + ((pt[0] - (pa[0] ?? pt[0])) * u),
        (pa[1] ?? pt[1]) + ((pt[1] - (pa[1] ?? pt[1])) * u),
        (pa[2] ?? 0) + ((pt[2] ?? 0) - (pa[2] ?? 0)) * u,
      ];
      if (pt.length > 3) out.push(pt[3]);
      return out;
    });
  };
  return {
    pose:      iLM(a.pose, b.pose),
    poseWorld: iLM(a.poseWorld, b.poseWorld),
    face:      iLM(a.face, b.face),
    leftHand:  iLM(a.leftHand, b.leftHand),
    rightHand: iLM(a.rightHand, b.rightHand),
  };
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

async function saveRecording() {
  const label = document.getElementById('rec-label')?.value.trim();
  if (!label || !frames.length) return;

  setRecStatus('Saving...', 'loading');

  try {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        schema_version: 2,
        landmarks: frames,
        calibration: calibBaseline,
        quality: lastQuality ? {
          overall: lastQuality.overall,
          grade: lastQuality.grade,
          details: lastQuality.details,
        } : null,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Save failed' }));
      throw new Error(err.detail || 'Save failed');
    }

    setRecStatus(`Sign "${label}" saved successfully!`, 'success');
    discardRecording();
  } catch (err) {
    setRecStatus(`Save failed: ${err.message}`, 'error');
  }
}

function discardRecording() {
  frames = [];
  lastQuality = null;
  document.getElementById('quality-panel')?.classList.add('hidden');
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
