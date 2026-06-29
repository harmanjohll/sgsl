/* ============================================================
   SgSL v2 — Tracking Web Worker (MediaPipe Tasks-Vision)
   ============================================================
   Runs ALL landmark extraction OFF the main thread. The main
   thread only captures frames (ImageBitmap, transferable) and
   renders the avatar — which is the fix for v1's long-session
   slowdown (two heavy models on the main thread starving the
   render loop). Legacy Holistic could not do this (DOM/main-
   thread-bound); Tasks-Vision is WASM and worker-safe.

   Protocol
     main -> worker : {type:'init'}
                      {type:'frame', bitmap, ts}   (bitmap is transferred)
     worker -> main : {type:'ready'}
                      {type:'error', message}
                      {type:'result', ts, pose, poseWorld, face, hands}
       pose      : [{x,y,z,visibility}]   normalized image landmarks (33)
       poseWorld : [{x,y,z,visibility}]   metric world landmarks (33)  -> results.za
       face      : [{x,y,z}]              face mesh (478) or null
       hands     : [{categoryName, landmarks, worldLandmarks}]  (0..2)

   The adapter on the main thread (adapter.js) folds this into the
   exact `results` shape retarget.applyFromMediaPipe() consumes,
   replicating recorder.js::mergeHandLandmarker's L/R routing so
   chirality/thumb match v1 precisely.
   ============================================================ */

// Same pinned builds + model weights as sgsl-app/js/recorder.js, so fidelity matches v1.
const TASKS_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let pose = null, hand = null, face = null;
let ready = false;
let handFrameCtr = 0;          // throttle the hand model to every other frame (matches v1)
let lastHands = [];            // reuse last hand detection on the skipped frame
let lastTs = 0;                // Tasks landmarkers require strictly-increasing timestamps

async function init() {
  try {
    const vision = await import(`${TASKS_CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_CDN}/wasm`);

    // GPU delegate where available, else CPU — same fallback ladder as v1's HandLandmarker.
    const make = async (Cls, baseOpts) => {
      try { return await Cls.createFromOptions(fileset, { ...baseOpts, baseOptions: { ...baseOpts.baseOptions, delegate: 'GPU' } }); }
      catch { return await Cls.createFromOptions(fileset, { ...baseOpts, baseOptions: { ...baseOpts.baseOptions, delegate: 'CPU' } }); }
    };

    pose = await make(vision.PoseLandmarker, {
      baseOptions: { modelAssetPath: POSE_MODEL },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    hand = await make(vision.HandLandmarker, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    // Face is best-effort: if it fails the rest of the pipeline still runs (face only drives
    // head/expression, not the signing hands).
    try {
      face = await make(vision.FaceLandmarker, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false,
      });
    } catch (e) { face = null; }

    ready = true;
    self.postMessage({ type: 'ready' });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
}

function detect(bitmap, ts) {
  // Strictly-increasing timestamp per landmarker (Tasks throws otherwise).
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;

  let poseRes = null, faceRes = null;
  try { poseRes = pose.detectForVideo(bitmap, ts); } catch (e) { /* transient */ }
  if (face) { try { faceRes = face.detectForVideo(bitmap, ts); } catch (e) { /* transient */ } }

  // Hands every OTHER frame; reuse last between (halves the cost of the two heavy models, the
  // same tactic v1 uses — smoothing on the main thread hides the gap).
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

  const poseLms = poseRes?.landmarks?.[0] || null;
  const poseWorld = poseRes?.worldLandmarks?.[0] || null;
  const faceLms = faceRes?.faceLandmarks?.[0] || null;

  self.postMessage({
    type: 'result', ts,
    pose: poseLms, poseWorld, face: faceLms, hands: lastHands,
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
    finally { bmp.close?.(); }   // release the transferred bitmap every frame (no leak)
  }
};
