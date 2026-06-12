/**
 * BodyAvatar: upper-body signing avatar.
 *
 * Tweens between sign keyframes (handshape morph + position + orientation
 * + facial expression), paints the primitives composed by body-model.js,
 * and falls back to fingerspelling on the raised dominant hand for words
 * without a lexical sign.
 */

import { composeScene, placeHand, ANCHORS } from "./body-model.js";
import { resolvePhrase } from "./signs.js";
import { poseFor } from "./poses.js";

const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const REST = { rh: "rest", lh: "rest", face: {} };

/** Resolve a hand spec to placed landmark points (or rest pose).
 *  Exported for the offline preview renderer and tests. */
export function resolveHand(hand, spec) {
  if (!spec || spec === "rest") {
    // Arms hang naturally: fingers point down, so the wrist sits above
    // the hand and stays within arm's reach of the shoulder.
    return placeHand(
      hand,
      hand === "r"
        ? { shape: "flat", at: "REST_R", orient: 172, palm: "in" }
        : { shape: "flat", at: "REST_L", orient: -172, palm: "in" }
    ).pts;
  }
  return placeHand(hand, spec).pts;
}

function lerpPts(a, b, t) {
  return a.map((p, i) => [
    lerp(p[0], b[i][0], t),
    lerp(p[1], b[i][1], t),
    lerp(p[2], b[i][2], t),
  ]);
}

function lerpFace(a = {}, b = {}, t) {
  // Discrete states switch at the midpoint; numeric offsets tween.
  return {
    brows: t < 0.5 ? a.brows : b.brows,
    mouth: t < 0.5 ? a.mouth : b.mouth,
    headDx: lerp(a.headDx || 0, b.headDx || 0, t),
    headDy: lerp(a.headDy || 0, b.headDy || 0, t),
  };
}

export class BodyAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.caption = "";
    this.speed = 1;
    this.onItem = null; // callback(label, kind) per word/letter
    this.onDone = null;
    this._raf = null;
    this._timer = null;
    this._queue = [];
    this.playing = false;
    // Current rendered state: landmark points per hand + face.
    this._cur = {
      rh: resolveHand("r", "rest"),
      lh: resolveHand("l", "rest"),
      face: {},
    };
    this._paint();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._timer) clearTimeout(this._timer);
    this._raf = null;
    this._timer = null;
    this._queue = [];
    this.playing = false;
  }

  rest() {
    this.stop();
    this.caption = "";
    this._tweenTo(REST, 400, () => {});
  }

  /**
   * Sign a phrase: lexical signs where known, fingerspelling otherwise.
   * Returns the resolution list so the UI can explain what was used.
   */
  sign(text) {
    this.stop();
    const items = resolvePhrase(text);
    if (!items.length) return [];
    this._queue = [...items];
    this.playing = true;
    this._next();
    return items;
  }

  _next() {
    if (!this._queue.length) {
      this.playing = false;
      this.caption = "";
      this._tweenTo(REST, 450, () => {
        if (this.onDone) this.onDone();
      });
      return;
    }
    const item = this._queue.shift();
    if (item.kind === "sign") {
      this.caption = item.word.toUpperCase();
      if (this.onItem) this.onItem(item.word, "sign");
      this._playFrames([...item.sign.frames], () => {
        this._timer = setTimeout(() => this._next(), 350 / this.speed);
      });
    } else {
      if (this.onItem) this.onItem(item.text, "spell");
      this._playSpelling(item.text, () => {
        this._timer = setTimeout(() => this._next(), 450 / this.speed);
      });
    }
  }

  _playFrames(frames, done) {
    if (!frames.length) {
      done();
      return;
    }
    const f = frames.shift();
    this._tweenTo(f, (f.dur || 400) / this.speed, () =>
      this._playFrames(frames, done)
    );
  }

  /** Fingerspell on the raised dominant hand, letter by letter. */
  _playSpelling(text, done) {
    const letters = text.split("").filter((c) => poseFor(c));
    const step = (idx) => {
      if (idx >= letters.length) {
        done();
        return;
      }
      const ch = letters[idx];
      this.caption = letters
        .map((c, i) => (i === idx ? c.toUpperCase() : c.toLowerCase()))
        .join("");
      // Letters use the alphabet poses via a "letter:" pseudo-handshape.
      const state = {
        rh: { shape: `letter:${ch}`, at: "FS" },
        lh: "rest",
        face: {},
      };
      this._tweenTo(state, 260 / this.speed, () => {
        this._timer = setTimeout(() => step(idx + 1), 420 / this.speed);
      });
    };
    step(0);
  }

  _tweenTo(state, ms, doneCb) {
    const from = this._cur;
    const target = {
      rh: resolveHand("r", state.rh),
      lh: resolveHand("l", state.lh),
      face: state.face || {},
    };
    const start = performance.now();
    const stepFrame = (now) => {
      const t = Math.min(1, (now - start) / Math.max(1, ms));
      const e = easeInOut(t);
      this._cur = {
        rh: lerpPts(from.rh, target.rh, e),
        lh: lerpPts(from.lh, target.lh, e),
        face: lerpFace(from.face, target.face, e),
      };
      this._paint();
      if (t < 1) this._raf = requestAnimationFrame(stepFrame);
      else doneCb();
    };
    this._raf = requestAnimationFrame(stepFrame);
  }

  /* ---------------- painting ---------------- */
  _project(p) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const S = Math.min(w, h) * 0.28;
    return [w * 0.5 + S * p[0], h * 0.45 - S * p[1]];
  }

  _paint() {
    const prims = composeScene({
      rhPts: this._cur.rh,
      lhPts: this._cur.lh,
      face: this._cur.face,
    });
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const S = Math.min(w, h) * 0.28;
    ctx.clearRect(0, 0, w, h);
    for (const pr of prims) {
      ctx.lineCap = pr.cap || "round";
      ctx.lineJoin = "round";
      if (pr.type === "line") {
        const a = this._project(pr.a);
        const b = this._project(pr.b);
        ctx.strokeStyle = pr.color;
        ctx.lineWidth = pr.w * S;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      } else if (pr.type === "circle") {
        const c = this._project(pr.c);
        ctx.fillStyle = pr.fill;
        ctx.beginPath();
        ctx.arc(c[0], c[1], pr.r * S, 0, Math.PI * 2);
        ctx.fill();
      } else if (pr.type === "arc") {
        const c = this._project(pr.c);
        ctx.strokeStyle = pr.color;
        ctx.lineWidth = pr.w * S;
        ctx.beginPath();
        // canvas y is flipped vs body space → mirror the angles
        ctx.arc(c[0], c[1], pr.r * S, -pr.a1, -pr.a0);
        ctx.stroke();
      } else if (pr.type === "poly") {
        const pts = pr.pts.map((p) => this._project(p));
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        if (pr.stroke) {
          ctx.strokeStyle = pr.stroke;
          ctx.lineWidth = (pr.w || 0.03) * S;
          ctx.stroke();
        }
        if (pr.fill) {
          ctx.fillStyle = pr.fill;
          ctx.fill();
        }
      }
    }
    if (this.caption) {
      ctx.font = `700 ${Math.round(h * 0.075)}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(122, 224, 196, 0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(this.caption, w / 2, h - 8);
    }
  }
}
