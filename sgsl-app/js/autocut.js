/* ============================================================
   SgSL — auto-cut: detect when a sign ends and trim idle frames
   ============================================================
   Pure functions/state machine over RECORDED frames (the shape built by
   recorder.js extractFrame: {t, rightHand, leftHand, pose, ...}), so the
   whole thing is unit-testable in Node (test/autocut.test.mjs) without a
   browser.

   Signal: hand motion energy = mean 2D inter-frame delta over the hand
   landmarks (same math as quality.js jitter, streamed). A sign ENDS when
   energy stays below endThresh for endHoldMs AND the signer reads as
   at-rest (hands undetected or wrists below shoulders) — the rest gate
   matters because HOLDS are part of signs: a static handshape held UP in
   signing space must not stop the recording.
   ============================================================ */

export const AUTOCUT_DEFAULTS = {
  startThresh: 0.012,  // normalized units/frame: motion above this = signing started
  endThresh: 0.006,    // below this = candidate idle
  endHoldMs: 700,      // sustained idle+rest this long = sign is done
  minSignMs: 800,      // ignore end-candidates before the sign is at least this long
  maxMs: 20000,        // hard stop — nobody signs for 20 s straight
  padMs: 150,          // trim padding kept around the detected motion span
};

/** Mean 2D delta of the hand landmarks between two recorded frames.
 *  null = no hand visible in both frames (unknowable, treated as rest-ish). */
export function frameEnergy(prev, cur) {
  if (!prev || !cur) return null;
  let sum = 0, n = 0;
  for (const key of ['rightHand', 'leftHand']) {
    const a = prev[key], b = cur[key];
    if (!a || !b || !a.length || a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      sum += Math.hypot(b[i][0] - a[i][0], b[i][1] - a[i][1]);
      n++;
    }
  }
  return n ? sum / n : null;
}

const noHands = (f) => !f.rightHand && !f.leftHand;

/** Wrists below the shoulder line (image y is down)? true=rest-ish; null=no pose signal. */
function wristsBelowShoulders(f) {
  const p = f.pose;
  if (!p || !p[11] || !p[12]) return null;
  const shoulderY = Math.max(p[11][1], p[12][1]);
  const below = (i) => !p[i] || p[i][1] > shoulderY + 0.08;
  return below(15) && below(16);
}

/** Streaming end-of-sign detector. Feed frames as they are recorded. */
export class AutoCut {
  constructor(opts = {}) {
    this.o = { ...AUTOCUT_DEFAULTS, ...opts };
    this.state = 'waiting';   // waiting -> signing (end-candidate tracked inside)
    this.prev = null;
    this.signStartT = null;
    this.lowSinceT = null;
  }

  /** Returns {state, shouldStop, countdownMs|null}. */
  update(frame) {
    const t = frame.t ?? 0;
    const en = frameEnergy(this.prev, frame);
    this.prev = frame;

    if (t >= this.o.maxMs) return { state: this.state, shouldStop: true, countdownMs: 0 };

    if (this.state === 'waiting') {
      if (en != null && en > this.o.startThresh) {
        this.state = 'signing';
        this.signStartT = t;
      }
      return { state: this.state, shouldStop: false, countdownMs: null };
    }

    // signing: watch for a sustained idle+rest window
    const low = en == null || en < this.o.endThresh;
    const rest = noHands(frame) || wristsBelowShoulders(frame) !== false;
    if (low && rest) {
      this.lowSinceT ??= t;
      const held = t - this.lowSinceT;
      const longEnough = t - this.signStartT >= this.o.minSignMs;
      if (held >= this.o.endHoldMs && longEnough) return { state: 'done', shouldStop: true, countdownMs: 0 };
      return { state: 'ending', shouldStop: false, countdownMs: longEnough ? Math.max(0, this.o.endHoldMs - held) : null };
    }
    this.lowSinceT = null;
    return { state: 'signing', shouldStop: false, countdownMs: null };
  }
}

/** Trim leading/trailing idle from a recorded sequence (padMs kept on both ends).
 *  Times are re-based to start at 0. Returns the original array if trimming would
 *  leave fewer than minFrames. */
export function trimFrames(frames, opts = {}) {
  const o = { ...AUTOCUT_DEFAULTS, ...opts };
  const minFrames = opts.minFrames ?? 5;
  if (!frames || frames.length < minFrames) return frames;
  let first = -1, last = -1;
  for (let i = 1; i < frames.length; i++) {
    const en = frameEnergy(frames[i - 1], frames[i]);
    if (en != null && en > o.endThresh) {
      if (first < 0 && en > o.startThresh) first = i;
      last = i;
    }
  }
  if (first < 0 || last < 0) return frames;   // never saw motion — keep as-is
  const t0 = frames[first].t - o.padMs, t1 = frames[last].t + o.padMs;
  const kept = frames.filter((f) => f.t >= t0 && f.t <= t1);
  if (kept.length < minFrames) return frames;
  const base = kept[0].t;
  return kept.map((f) => ({ ...f, t: f.t - base }));
}
