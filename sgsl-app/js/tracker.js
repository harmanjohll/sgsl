/**
 * Webcam hand tracking via MediaPipe Hand Landmarker (tasks-vision).
 *
 * Loaded dynamically from CDN so the rest of the app (avatar, dictionary)
 * still works offline — only the camera modes need the network once.
 */

const CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class Tracker {
  constructor(video, overlay) {
    this.video = video;
    this.overlay = overlay;
    this.ctx = overlay.getContext("2d");
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this.onFrame = null; // callback(landmarks | null)
    this._lastVideoTime = -1;
  }

  async init(statusCb = () => {}) {
    if (this.landmarker) return;
    statusCb("Loading hand-tracking model…");
    const vision = await import(`${CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await vision.HandLandmarker.createFromOptions(
        fileset,
        opts("GPU")
      );
    } catch {
      this.landmarker = await vision.HandLandmarker.createFromOptions(
        fileset,
        opts("CPU")
      );
    }
    statusCb("");
  }

  async start(statusCb = () => {}) {
    await this.init(statusCb);
    if (!this.stream) {
      statusCb("Requesting camera…");
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.overlay.width = this.video.videoWidth || 640;
      this.overlay.height = this.video.videoHeight || 480;
    }
    statusCb("");
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      this.video.srcObject = null;
    }
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  _loop() {
    if (!this.running) return;
    const tick = () => {
      if (!this.running) return;
      if (
        this.video.readyState >= 2 &&
        this.video.currentTime !== this._lastVideoTime
      ) {
        this._lastVideoTime = this.video.currentTime;
        const res = this.landmarker.detectForVideo(
          this.video,
          performance.now()
        );
        const lms =
          res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
        this._drawOverlay(lms);
        if (this.onFrame) this.onFrame(lms);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _drawOverlay(lms) {
    const { width: w, height: h } = this.overlay;
    this.ctx.clearRect(0, 0, w, h);
    if (!lms) return;
    this.ctx.strokeStyle = "rgba(122, 224, 196, 0.9)";
    this.ctx.lineWidth = 3;
    for (const [a, b] of CONNECTIONS) {
      this.ctx.beginPath();
      this.ctx.moveTo(lms[a].x * w, lms[a].y * h);
      this.ctx.lineTo(lms[b].x * w, lms[b].y * h);
      this.ctx.stroke();
    }
    this.ctx.fillStyle = "#ffd166";
    for (const p of lms) {
      this.ctx.beginPath();
      this.ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
}
