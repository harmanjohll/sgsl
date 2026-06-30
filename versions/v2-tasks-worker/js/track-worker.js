/* ============================================================
   SgSL v2 — Tracking Web Worker (MediaPipe Tasks-Vision)
   ============================================================
   Runs ALL landmark extraction OFF the main thread. The main
   thread only captures frames (ImageBitmap, transferable) and
   renders the avatar — the fix for v1's long-session slowdown.
   Legacy Holistic couldn't do this (DOM/main-thread-bound);
   Tasks-Vision is WASM and worker-safe.

   Robustness (we can't browser-test here, so fail LOUD + fast):
     - posts {type:'status'} progress so the UI shows where it is
     - posts {type:'ready'} as soon as POSE+HAND are up (the
       signing-critical models); FACE loads after and never blocks
     - each model load has a timeout -> a GPU hang in a worker falls
       back to CPU instead of hanging "loading…" forever
     - any fatal error -> {type:'error', message}

   Protocol
     main -> worker : {type:'init'} / {type:'frame', bitmap, ts}
     worker -> main : {type:'status', message}
                      {type:'ready'}
                      {type:'error', message}
                      {type:'result', ts, pose, poseWorld, face, hands}
   ============================================================ */

const TASKS_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let vision = null, fileset = null;
let pose = null, hand = null, face = null;
let ready = false;
let handFrameCtr = 0;          // throttle the hand model to every other frame (matches v1)
let lastHands = [];            // reuse last hand detection on the skipped frame
let lastTs = 0;                // Tasks landmarkers require strictly-increasing timestamps

const status = (m) => self.postMessage({ type: 'status', message: m });

// A GPU-delegate create can HANG in a worker on some GPUs; race it against a
// timeout so we fall back to CPU instead of stalling forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function makeOne(Cls, baseOpts, label) {
  const gpu = { ...baseOpts, baseOptions: { ...baseOpts.baseOptions, delegate: 'GPU' } };
  const cpu = { ...baseOpts, baseOptions: { ...baseOpts.baseOptions, delegate: 'CPU' } };
  try {
    status(`loading ${label} (GPU)…`);
    return await withTimeout(Cls.createFromOptions(fileset, gpu), 15000, `${label} GPU`);
  } catch (e) {
    status(`${label} GPU unavailable (${e.message}); trying CPU…`);
  }
  return await withTimeout(Cls.createFromOptions(fileset, cpu), 30000, `${label} CPU`);
}

async function init() {
  try {
    status('importing tasks-vision…');
    vision = await import(`${TASKS_CDN}/vision_bundle.mjs`);
    status('loading wasm runtime…');
    fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_CDN}/wasm`);

    pose = await makeOne(vision.PoseLandmarker, {
      baseOptions: { modelAssetPath: POSE_MODEL },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    }, 'pose');
    status('pose ✓');

    hand = await makeOne(vision.HandLandmarker, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    }, 'hand');
    status('hand ✓');

    // Signing-critical models are up — start mirroring NOW; face is a bonus.
    ready = true;
    self.postMessage({ type: 'ready' });

    loadFace();   // fire-and-forget; never blocks the hands
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
}

async function loadFace() {
  try {
    face = await makeOne(vision.FaceLandmarker, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false,
    }, 'face');
    status('face ✓ — full tracking');
  } catch (e) {
    face = null;
    status(`face unavailable (${e.message}); head/expression off, hands OK`);
  }
}

function detect(bitmap, ts) {
  if (ts <= lastTs) ts = lastTs + 1;   // strictly-increasing per landmarker
  lastTs = ts;

  let poseRes = null, faceRes = null;
  try { poseRes = pose.detectForVideo(bitmap, ts); } catch (e) { /* transient */ }
  if (face) { try { faceRes = face.detectForVideo(bitmap, ts); } catch (e) { /* transient */ } }

  // Hands every OTHER frame; reuse last between (halves the two-model cost — same as v1).
  if ((handFrameCtr++ & 1) === 0) {
    try {
      const hr = hand.detectForVideo(bitmap, ts);
      lastHands = [];
      if (hr && hr.landmarks) {
        for (let i = 0; i < hr.landmarks.length; i++) {
          lastHands.push({
            categoryName: hr.handedness?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left'),
            landmarks: hr.landmarks[i] || null,
            worldLandmarks: hr.worldLandmarks?.[i] || null,
          });
        }
      }
    } catch (e) { /* keep lastHands */ }
  }

  self.postMessage({
    type: 'result', ts,
    pose: poseRes?.landmarks?.[0] || null,
    poseWorld: poseRes?.worldLandmarks?.[0] || null,
    face: faceRes?.faceLandmarks?.[0] || null,
    hands: lastHands,
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') { init(); return; }
  if (msg.type === 'frame') {
    const bmp = msg.bitmap;
    if (!ready || !bmp) { if (bmp) bmp.close?.(); return; }
    try { detect(bmp, msg.ts || 0); }
    finally { bmp.close?.(); }
  }
};
