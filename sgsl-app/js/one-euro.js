/* ============================================================
   SgSL — One-Euro filter (input landmark de-jitter)
   ============================================================
   Standard One-Euro (Casiez et al.): a low-pass whose cutoff rises
   with speed — still hands stop trembling, fast signs stay snappy
   (unlike plain smoothing, which trades one for the other).

   Used by retarget.applyFromMediaPipe on the INPUT landmarks (world
   hands + the pose points the arm solver reads), upstream of all
   bone math, so every consumer (live, replay, harness) benefits.
   Pure module — unit-tested via the harness noise scenarios.
   ============================================================ */

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  /** minCutoff Hz: jitter floor; beta: speed responsiveness; dCutoff Hz: derivative LP. */
  constructor({ minCutoff = 1.2, beta = 0.4, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0;
  }
  filter(v, dtSec) {
    if (this.x == null || !isFinite(this.x)) { this.x = v; this.dx = 0; return v; }
    const dxRaw = (v - this.x) / dtSec;
    this.dx += (dxRaw - this.dx) * alpha(this.dCutoff, dtSec);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * alpha(cutoff, dtSec);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

/** Filters a whole landmark array ({x,y,z}[]) in place-safe copies, with
 *  automatic state reset after `resetAfter` missed frames (a reappearing
 *  hand must not get dragged from its stale pre-dropout position). */
export class LandmarkFilter {
  constructor(opts = {}) {
    this.opts = opts;
    this.resetAfter = opts.resetAfter ?? 5;
    this._f = [];        // per index: {x,y,z} OneEuro triple
    this._missed = 0;
  }
  apply(landmarks, dtSec) {
    if (!landmarks || !landmarks.length) {
      if (++this._missed > this.resetAfter) { this._f = []; this._missed = 0; }
      return landmarks;
    }
    this._missed = 0;
    return landmarks.map((lm, i) => {
      let f = this._f[i];
      if (!f) f = this._f[i] = { x: new OneEuro(this.opts), y: new OneEuro(this.opts), z: new OneEuro(this.opts) };
      const out = { ...lm, x: f.x.filter(lm.x, dtSec), y: f.y.filter(lm.y, dtSec), z: f.z.filter(lm.z, dtSec) };
      return out;
    });
  }
}
