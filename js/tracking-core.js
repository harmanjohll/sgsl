/* ============================================================
   SgSL — TrackingCore: camera + tracking + live retarget
   ============================================================
   Reusable webcam→avatar pipeline for camera-on modes (Test mode; the
   Contribute recorder keeps its own copy for now — a deliberate, low-risk
   split: this module is the clean home the recorder migrates to later).

   Owns its own SMPLXAvatar + SMPLXRetarget in a caller-given viewport,
   runs the SAME tracking as the recorder (Tasks-Vision worker by default,
   legacy Holistic fallback, 3D HandLandmarker fusion via the shared
   HandRouter), drives the avatar, and emits per frame:
     onFrame(results, frame)   // results = MediaPipe shape; frame = extractFrame
   extractFrame is the exact recorder shape, so recognition.js consumes it
   directly.
   ============================================================ */

import { SMPLXAvatar } from './avatar.js';
import { SMPLXRetarget } from './retarget.js';
import { HandRouter } from './hand-router.js';
import { toResults } from './tasks-adapter.js';

const HAND_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const SWAP_HANDEDNESS = false;

export class TrackingCore {
  constructor({ videoId, viewportId, onFrame = () => {}, onStatus = () => {} }) {
    this.video = document.getElementById(videoId);
    this.avatar = new SMPLXAvatar(viewportId);
    this.retarget = new SMPLXRetarget();
    this.retarget.setVideo(this.video);
    this.retarget.setAvatar(this.avatar);
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.trackerMode = new URLSearchParams(location.search).get('tracker') || 'worker';
    this._router = new HandRouter();
    this._worker = null; this._workerInFlight = false; this._stream = null;
    this._camera = null; this._holistic = null; this._hand = null; this._lastHand = null;
    this._handCtr = 0; this._stopped = false; this.ready = false;
  }

  async start() {
    this._stopped = false;
    if (this.trackerMode !== 'legacy') {
      const ok = await this._startWorker().catch((e) => { console.warn('[TrackingCore] worker failed:', e); return false; });
      if (ok) { this.ready = true; return true; }
      this.onStatus('Worker tracking unavailable — using the legacy tracker.');
    }
    const ok = await this._startLegacy();
    this.ready = ok;
    return ok;
  }

  stop() {
    this._stopped = true;
    try { this._worker?.terminate(); } catch {}
    try { this._camera?.stop?.(); } catch {}
    try { this._stream?.getTracks().forEach((t) => t.stop()); } catch {}
    if (this.video) this.video.srcObject = null;
    this._worker = null; this._camera = null; this.ready = false;
  }

  _onResults(results) {
    if (this._stopped) return;
    this._merge(results, this._lastHand);
    if (this.avatar?.vrm) this.retarget.applyFromMediaPipe(this.avatar.vrm, results);
    // extractFrame AFTER the drive so any consumer scoring sees the same data the avatar did.
    this.onFrame(results, extractFrame(results));
  }

  async _startWorker() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    this._stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    const worker = new Worker(new URL('./track-worker.js', import.meta.url));
    const ready = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 60000);
      worker.onerror = () => { clearTimeout(to); resolve(false); };
      worker.onmessage = (e) => {
        const m = e.data; if (!m) return;
        if (m.type === 'status') { this.onStatus(`Loading tracking — ${m.message}`); return; }
        if (m.type === 'ready') { clearTimeout(to); resolve(true); }
        if (m.type === 'error') { clearTimeout(to); resolve(false); }
      };
      worker.postMessage({ type: 'init' });
    });
    if (!ready) { worker.terminate(); stream.getTracks().forEach((t) => t.stop()); this.video.srcObject = null; return false; }
    this._worker = worker;
    worker.onmessage = (e) => {
      const m = e.data; if (!m) return;
      if (m.type === 'result') { this._workerInFlight = false; this._onResults(toResults(m)); }
    };
    const pump = async () => {
      if (this._stopped) return;
      if (!this._workerInFlight && this.video.readyState >= 2) {
        this._workerInFlight = true;
        try {
          const bitmap = await createImageBitmap(this.video);
          worker.postMessage({ type: 'frame', bitmap, ts: Math.round(performance.now()) }, [bitmap]);
        } catch { this._workerInFlight = false; }
      }
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    return true;
  }

  async _startLegacy() {
    try {
      this._holistic = new window.Holistic({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${f}` });
      this._holistic.setOptions({ modelComplexity: 0, smoothLandmarks: true, enableSegmentation: false, smoothSegmentation: false, refineFaceLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      this._holistic.onResults((r) => this._onResults(r));
      this._loadHandLandmarker();
      this._camera = new window.Camera(this.video, {
        onFrame: async () => {
          if (this._stopped) return;
          if (this._hand && this.video.readyState >= 2 && (this._handCtr++ & 1) === 0) {
            try { this._lastHand = this._hand.detectForVideo(this.video, performance.now()); } catch {}
          }
          if (this._holistic) await this._holistic.send({ image: this.video });
        }, width: 640, height: 480,
      });
      await this._camera.start();
      return true;
    } catch (e) { this.onStatus(`Camera failed: ${e.message}`); return false; }
  }

  async _loadHandLandmarker() {
    try {
      const vision = await import(`${HAND_CDN}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${HAND_CDN}/wasm`);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      try { this._hand = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { this._hand = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU')); }
    } catch (e) { console.warn('[TrackingCore] HandLandmarker failed:', e); }
  }

  _merge(results, hr) {
    if (!hr || !hr.landmarks || !hr.landmarks.length) return;
    const dets = [];
    for (let i = 0; i < hr.landmarks.length; i++) {
      let side = hr.handedness?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
      if (SWAP_HANDEDNESS) side = side === 'Right' ? 'Left' : 'Right';
      dets.push({ categoryName: side, landmarks: hr.landmarks[i], worldLandmarks: hr.worldLandmarks?.[i] || null });
    }
    const routed = this._router.route(dets);
    if (routed.Right) { results.rightHandLandmarks = routed.Right.landmarks; results.rightHandWorldLandmarks = routed.Right.worldLandmarks; }
    if (routed.Left) { results.leftHandLandmarks = routed.Left.landmarks; results.leftHandWorldLandmarks = routed.Left.worldLandmarks; }
  }
}

/** The recorder's per-frame landmark shape (recognition.js + Contribute consume it). */
export function extractFrame(results) {
  const frame = { t: 0, rightHand: null, leftHand: null, face: null, pose: null, poseWorld: null };
  if (results.rightHandLandmarks) frame.rightHand = results.rightHandLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
  if (results.leftHandLandmarks) frame.leftHand = results.leftHandLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
  if (results.rightHandWorldLandmarks) frame.rightHandWorld = results.rightHandWorldLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
  if (results.leftHandWorldLandmarks) frame.leftHandWorld = results.leftHandWorldLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
  if (results.poseLandmarks) frame.pose = results.poseLandmarks.map((lm) => [lm.x, lm.y, lm.z, lm.visibility ?? 0]);
  const pw = results.za || results.ea;
  if (pw) frame.poseWorld = pw.map((lm) => [lm.x, lm.y, lm.z, lm.visibility ?? 0]);
  if (results.faceLandmarks && results.faceLandmarks.length >= 468) frame.face = results.faceLandmarks.map((lm) => [lm.x, lm.y, lm.z]);
  return frame;
}
