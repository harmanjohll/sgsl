/**
 * Signing avatar: renders the parametric hand on a 2D canvas and animates
 * fingerspelling sequences (letters, digits, whole phrases), including the
 * tracing motions for the dynamic letters J and Z.
 */

import { handLandmarks } from "./hand-model.js";
import { poseFor, REST_POSE } from "./poses.js";

const FINGER_CHAINS = [
  [0, 1, 2, 3, 4], // thumb
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const PALM_OUTLINE = [0, 1, 5, 9, 13, 17, 0];

const SKIN = "#e0ac69";
const SKIN_DARK = "#b07b45";
const SKIN_LIGHT = "#f1c27d";

const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function lerpLandmarks(a, b, t) {
  return a.map((p, i) => [
    lerp(p[0], b[i][0], t),
    lerp(p[1], b[i][1], t),
    lerp(p[2], b[i][2], t),
  ]);
}

/** Motion paths for dynamic letters: list of {t, dx, dy, rot} keyframes. */
const MOTIONS = {
  j: [
    { t: 0, dx: 0, dy: 0, rot: 0 },
    { t: 0.45, dx: 0.05, dy: -0.45, rot: -10 },
    { t: 1, dx: -0.45, dy: -0.6, rot: -55 },
  ],
  z: [
    { t: 0, dx: -0.35, dy: 0, rot: 0 },
    { t: 0.33, dx: 0.35, dy: 0, rot: 0 },
    { t: 0.66, dx: -0.35, dy: -0.55, rot: 0 },
    { t: 1, dx: 0.35, dy: -0.55, rot: 0 },
  ],
};

function sampleMotion(path, t) {
  for (let i = 1; i < path.length; i++) {
    if (t <= path[i].t) {
      const a = path[i - 1];
      const b = path[i];
      const u = (t - a.t) / (b.t - a.t || 1);
      return {
        dx: lerp(a.dx, b.dx, u),
        dy: lerp(a.dy, b.dy, u),
        rot: lerp(a.rot, b.rot, u),
      };
    }
  }
  return path[path.length - 1];
}

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.current = handLandmarks(REST_POSE);
    this.caption = "";
    this.queue = [];
    this.playing = false;
    this.speed = 1;
    this.onLetter = null; // callback(label) when a letter starts
    this.onDone = null;
    this._raf = null;
    this.draw(this.current);
  }

  /** Queue a word/phrase for fingerspelling. Non-signable chars are skipped. */
  spell(text) {
    this.stop();
    const items = [];
    for (const ch of text) {
      if (ch === " ") {
        items.push({ pause: 550 });
        continue;
      }
      const p = poseFor(ch);
      if (p) items.push(p);
    }
    if (!items.length) return false;
    this.queue = items;
    this.playing = true;
    this._playNext();
    return true;
  }

  /** Show a single letter/digit statically (used in practice mode). */
  show(ch) {
    this.stop();
    const p = poseFor(ch);
    if (!p) return false;
    const target = handLandmarks(p.pose);
    this.caption = p.label;
    this._animateTo(target, 220, () => {
      if (p.pose.motion) this._playMotion(p.pose, target, () => {});
    });
    return true;
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.queue = [];
    this.playing = false;
  }

  rest() {
    this.stop();
    this.caption = "";
    this._animateTo(handLandmarks(REST_POSE), 300, () => {});
  }

  _playNext() {
    if (!this.queue.length) {
      this.playing = false;
      this.caption = "";
      this._animateTo(handLandmarks(REST_POSE), 350, () => {
        if (this.onDone) this.onDone();
      });
      return;
    }
    const item = this.queue.shift();
    if (item.pause) {
      this.caption = "";
      this.draw(this.current);
      setTimeout(() => this._playNext(), item.pause / this.speed);
      return;
    }
    const target = handLandmarks(item.pose);
    this.caption = item.label;
    if (this.onLetter) this.onLetter(item.label);
    this._animateTo(target, 300 / this.speed, () => {
      if (item.pose.motion) {
        this._playMotion(item.pose, target, () =>
          setTimeout(() => this._playNext(), 250 / this.speed)
        );
      } else {
        setTimeout(() => this._playNext(), 650 / this.speed);
      }
    });
  }

  _animateTo(target, ms, done) {
    const from = this.current;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      this.current = lerpLandmarks(from, target, easeInOut(t));
      this.draw(this.current);
      if (t < 1) this._raf = requestAnimationFrame(step);
      else done();
    };
    this._raf = requestAnimationFrame(step);
  }

  /** Animate the J/Z trace: translate+rotate the held handshape, drawing a trail. */
  _playMotion(pose, base, done) {
    const path = MOTIONS[pose.motion];
    const ms = 900 / this.speed;
    const start = performance.now();
    const trail = [];
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const m = sampleMotion(path, easeInOut(t));
      const a = (m.rot * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const pts = base.map((p) => [
        p[0] * c - p[1] * s + m.dx,
        p[0] * s + p[1] * c + m.dy,
        p[2],
      ]);
      this.current = pts;
      // Trail follows the signing fingertip (pinky for J, index for Z).
      const tipIdx = pose.motion === "j" ? 20 : 8;
      trail.push(pts[tipIdx]);
      this.draw(pts, trail);
      if (t < 1) this._raf = requestAnimationFrame(step);
      else done();
    };
    this._raf = requestAnimationFrame(step);
  }

  /** Project local hand coords to canvas pixels (wrist near centre so
   *  upright, sideways and downward poses all stay in frame). */
  _project(p) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const S = Math.min(w, h) * 0.22;
    return [w * 0.58 + S * p[0], h * 0.55 - S * p[1], p[2]];
  }

  draw(pts, trail = null) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const P = pts.map((p) => this._project(p));
    const S = Math.min(w, h) * 0.22;

    // Forearm extends away from the fingers (wrist → opposite of middle MCP).
    let fx = pts[0][0] - pts[9][0];
    let fy = pts[0][1] - pts[9][1];
    const flen = Math.hypot(fx, fy) || 1;
    fx /= flen;
    fy /= flen;
    const armEnd = this._project([pts[0][0] + fx * 1.0, pts[0][1] + fy * 1.0, 0]);
    ctx.strokeStyle = SKIN;
    ctx.lineCap = "round";
    ctx.lineWidth = S * 0.42;
    ctx.beginPath();
    ctx.moveTo(armEnd[0], armEnd[1]);
    ctx.lineTo(P[0][0], P[0][1]);
    ctx.stroke();

    // Palm
    ctx.beginPath();
    ctx.moveTo(P[PALM_OUTLINE[0]][0], P[PALM_OUTLINE[0]][1]);
    for (const i of PALM_OUTLINE.slice(1)) ctx.lineTo(P[i][0], P[i][1]);
    ctx.closePath();
    ctx.fillStyle = SKIN;
    ctx.strokeStyle = SKIN;
    ctx.lineWidth = S * 0.3;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();

    // Fingers, far to near so overlaps look right.
    const chains = [...FINGER_CHAINS].sort((a, b) => {
      const za = pts[a[a.length - 1]][2];
      const zb = pts[b[b.length - 1]][2];
      return za - zb;
    });
    for (const chain of chains) {
      for (let i = 0; i < chain.length - 1; i++) {
        const a = P[chain[i]];
        const b = P[chain[i + 1]];
        const depth = (pts[chain[i + 1]][2] + 0.4) / 1.4;
        const shade = Math.max(0, Math.min(1, depth));
        ctx.strokeStyle = shade > 0.55 ? SKIN_LIGHT : shade < 0.3 ? SKIN_DARK : SKIN;
        ctx.lineWidth = S * (0.155 + 0.04 * shade);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }

    // Motion trail (J/Z traces)
    if (trail && trail.length > 1) {
      ctx.strokeStyle = "rgba(122, 224, 196, 0.85)";
      ctx.lineWidth = 3;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      const t0 = this._project(trail[0]);
      ctx.moveTo(t0[0], t0[1]);
      for (const p of trail.slice(1)) {
        const q = this._project(p);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Caption
    if (this.caption) {
      ctx.font = `700 ${Math.round(h * 0.14)}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(122, 224, 196, 0.95)";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(this.caption, w * 0.05, h * 0.05);
    }
  }
}
