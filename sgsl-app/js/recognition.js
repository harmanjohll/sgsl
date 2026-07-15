/* ============================================================
   SgSL — sign→text recognition (pure geometric baseline)
   ============================================================
   Scores a performed sign against reference recording(s):
     normalize → DTW time-align → per-part distance → 0-100 + grade.

   Why geometric (not ML): each sign has ONE reference recording, so a
   normalize+DTW nearest-template baseline is the right first step (ML —
   TF.js GRU/CNN — waits until we have many examples per sign). This is
   the HANDOFF's intended baseline.

   Frame shape (recorder.extractFrame): { t, rightHand:[21×[x,y,z]],
   leftHand, rightHandWorld, leftHandWorld, pose:[33×[x,y,z,vis]], ... }.
   Reference: { landmarks:[frame…], calibration:{shoulderWidth, shoulderMid} }.

   NORMALISATION makes the score framing/position/scale/speed invariant:
   - hand LOCATION → body frame: (hand wrist − shoulderMid) / shoulderWidth.
   - hand SHAPE → re-anchored to its own wrist, scaled by hand span, and
     ROTATED so the wrist→middle-knuckle axis points up — the same handshape
     held at a slightly different wrist angle is the same handshape, not a
     different sign.
   - TRANSITIONS → open-ended DTW: raising the hand into the sign and
     dropping it after match for free (only the sign itself is scored).
   - HANDEDNESS → the attempt is also scored mirrored (hands swapped), and
     the better orientation counts, so left-handed signers can pass.
   - SPEED → DTW.
   Everything here is pure + Node-tested (test/recognition.test.mjs).
   ============================================================ */

import { dtw } from './dtw.js';

// Cost weights + score mapping — a tuned geometric baseline (thresholds are
// meant to be re-tuned against real attempts; the tests assert ORDERING and
// INVARIANCE, not absolute calibration).
const W = { loc: 1.0, shape: 2.2, presence: 1.4, shapeMissing: 0.5 };
const SCORE_TAU = 0.42;    // score = 100·exp(−normDistance / TAU)
const PASS_SCORE = 55;     // grade C — "close enough to pass"

// Strictness presets — how much deviation from the reference is tolerated. `normal` IS the tuned
// baseline (unchanged): a bigger tau is more forgiving (a given deviation scores higher), and pass
// is the grade-C boundary. This is the user-facing "allowance for deviation" knob (Test mode).
export const TOLERANCE = {
  easy:   { tau: 0.65, pass: 45 },
  normal: { tau: SCORE_TAU, pass: PASS_SCORE },
  strict: { tau: 0.32, pass: 62 },
};
const tolOf = (level) => TOLERANCE[level] || TOLERANCE.normal;

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** shoulder frame {mid:[x,y], sw} from calibration, else from pose 11/12. */
function bodyFrame(frame, calib) {
  if (calib && calib.shoulderMid && calib.shoulderWidth > 0.02) {
    return { mid: calib.shoulderMid, sw: calib.shoulderWidth };
  }
  const p = frame.pose, L = p?.[11], R = p?.[12];
  // Gate on shoulder visibility, matching normHand / calibFromFrames — an occluded
  // shoulder must NOT silently anchor the body frame.
  if (L && R && (L[3] ?? 1) >= 0.5 && (R[3] ?? 1) >= 0.5) {
    return { mid: [(L[0] + R[0]) / 2, (L[1] + R[1]) / 2], sw: Math.hypot(L[0] - R[0], L[1] - R[1]) || 0.2 };
  }
  return null;
}

/** One hand → {loc:[x,y] body-frame|null, shape:[21×[x,y]] wrist-anchored+scaled}|null.
 *  With no body frame (v1 hand-only recordings) the hand still normalizes: `loc` is
 *  null and scoring falls back to the hand-intrinsic SHAPE channel only — handshape
 *  is wrist-anchored and span-scaled, so it needs no body reference. */
function normHand(hand2d, poseWrist, bf) {
  const poseOk = poseWrist && (poseWrist[3] ?? 1) >= 0.5;   // visibility gate (no phantom hands)
  const wrist = hand2d?.[0] || (poseOk ? [poseWrist[0], poseWrist[1]] : null);
  if (!wrist) return null;
  const loc = bf ? [(wrist[0] - bf.mid[0]) / bf.sw, (wrist[1] - bf.mid[1]) / bf.sw] : null;
  let shape = null;
  if (hand2d && hand2d.length >= 21) {
    const vx = hand2d[9][0] - hand2d[0][0], vy = hand2d[9][1] - hand2d[0][1];
    const span = Math.hypot(vx, vy) || 1e-3;
    // Rotate so wrist→middle-MCP points up: wrist tilt must not read as a wrong
    // handshape (a 10° tilt used to score like a different sign entirely).
    const ang = Math.atan2(vx, -vy), c = Math.cos(ang), s = Math.sin(ang);
    shape = hand2d.map(p => {
      const x = (p[0] - hand2d[0][0]) / span, y = (p[1] - hand2d[0][1]) / span;
      return [x * c + y * s, y * c - x * s];
    });
  }
  if (!loc && !shape) return null;
  return { loc, shape };
}

export function normalizeFrame(frame, calib) {
  const bf = bodyFrame(frame, calib);
  return {
    R: normHand(frame.rightHand, frame.pose?.[16], bf),
    L: normHand(frame.leftHand, frame.pose?.[15], bf),
  };
}
export function normalizeSequence(frames, calib) {
  return (frames || []).filter(f => f && (f.rightHand || f.leftHand || f.pose)).map(f => normalizeFrame(f, calib));
}

/** A hand present in under `minRatio` of a sequence's frames is tracker noise
 *  (stray detections), not signing — drop it rather than fine every frame of
 *  the other, real hand for a "missing" hand that was never part of the sign. */
function stripRareHands(seq, minRatio = 0.25) {
  if (!seq.length) return seq;
  for (const side of ['R', 'L']) {
    const n = seq.filter(f => f[side]).length;
    if (n > 0 && n < seq.length * minRatio) for (const f of seq) f[side] = null;
  }
  return seq;
}

/** Mirror a normalized sequence: swap hands, negate x (loc and shape). Rotation
 *  normalisation commutes with reflection, so mirroring post-normalisation is
 *  exactly the score of the x-flipped raw performance. */
function mirrorSeq(seq) {
  const flip = (h) => h && {
    loc: h.loc ? [-h.loc[0], h.loc[1]] : null,
    shape: h.shape ? h.shape.map(p => [-p[0], p[1]]) : null,
  };
  return seq.map(f => ({ R: flip(f.L), L: flip(f.R) }));
}

function shapeDist(a, b) {
  if (!a && !b) return 0;              // neither side carries a handshape -> nothing to diverge
  if (!a || !b) return W.shapeMissing; // one has a shape, the other doesn't
  const n = Math.min(a.length, b.length);
  let s = 0; for (let i = 0; i < n; i++) s += dist2(a[i], b[i]);
  return s / n;
}

/** Per-frame cost + a per-part breakdown (accumulated by scoreAttempt for feedback). */
function frameCost(fa, fb, acc) {
  let total = 0;
  for (const side of ['R', 'L']) {
    const a = fa[side], b = fb[side];
    if (a && b) {
      // Location only compares when BOTH sides carry a body frame — a v1 hand-only
      // reference scores on handshape alone rather than failing outright.
      const ld = (a.loc && b.loc) ? dist2(a.loc, b.loc) : 0;
      const sd = shapeDist(a.shape, b.shape);
      total += W.loc * ld + W.shape * sd;
      if (acc) { acc[side].loc += ld; acc[side].shape += sd; acc[side].n++; }
    } else if (a || b) {
      total += W.presence;
      if (acc) { acc[side].presence++; acc[side].n++; }
    }
  }
  return total;
}

const gradeFor = (score, pass = PASS_SCORE) =>
  score >= 85 ? 'A' : score >= 70 ? 'B' : score >= pass ? 'C' : score >= 40 ? 'D' : 'F';

/** Score a performed attempt against ONE reference. Both are raw frame arrays
 *  plus their calibration. `level` (easy|normal|strict) sets the tolerance; default
 *  `normal` reproduces the original constants. Returns { score, grade, pass, distance, feedback }. */
export function scoreAttempt(attempt, attemptCalib, reference, refCalib, level = 'normal') {
  const { tau, pass: passScore } = tolOf(level);
  const A = stripRareHands(normalizeSequence(attempt, attemptCalib));
  const B = stripRareHands(normalizeSequence(reference, refCalib));
  const withHand = (seq) => seq.filter(f => f.R || f.L).length;
  if (A.length < 3 || B.length < 3) return { score: 0, grade: 'F', pass: false, distance: Infinity, feedback: ['Not enough frames captured.'] };
  // A sequence of body-less / hand-less frames normalizes to all-null (frameCost 0),
  // which would score a perfect match on garbage. Require real hand content on both.
  if (withHand(A) < 3 || withHand(B) < 3) return { score: 0, grade: 'F', pass: false, distance: Infinity, feedback: ['No hands were clearly visible — step into frame and try again.'] };

  // Score as performed AND mirrored (hands swapped, x flipped) — take the better.
  // A left-handed signer performing a right-handed reference is signing correctly.
  const straight = dtw(A, B, frameCost, { openEnds: true });
  const Am = mirrorSeq(A);
  const mirror = dtw(Am, B, frameCost, { openEnds: true });
  const mirrored = mirror.normDistance < straight.normDistance;
  const { normDistance, path } = mirrored ? mirror : straight;
  const used = mirrored ? Am : A;
  const score = Math.round(100 * Math.exp(-normDistance / tau));

  // Per-channel breakdown along the ALIGNMENT PATH only (accumulating inside the
  // DTW cost function counted every explored cell and blamed the wrong things).
  const acc = { R: { loc: 0, shape: 0, presence: 0, n: 0 }, L: { loc: 0, shape: 0, presence: 0, n: 0 } };
  for (const [i, j] of path) frameCost(used[i], B[j], acc);

  // Feedback: name the worst channel per active hand. Sides are named from the
  // signer's point of view — if the mirrored orientation won, acc's R is their left.
  const feedback = [];
  for (const side of ['R', 'L']) {
    const c = acc[side]; if (!c.n) continue;
    const label = (side === 'R') !== mirrored ? 'right' : 'left';
    if (c.presence > c.n * 0.4) feedback.push(`Your ${label} hand was missing for much of the sign.`);
    else if (c.shape / Math.max(1, c.n) > 0.14) feedback.push(`Your ${label} handshape drifted from the target.`);
    else if (c.loc / Math.max(1, c.n) > 0.3) feedback.push(`Your ${label} hand's placement/movement was off.`);
  }
  if (!feedback.length && score >= passScore) feedback.push('Clean — that matches the reference well.');
  else if (!feedback.length && score < passScore) feedback.push('Close, but not close enough — watch the reference again and match the handshape through the whole sign.');

  return { score, grade: gradeFor(score, passScore), pass: score >= passScore, distance: +normDistance.toFixed(4), mirrored, feedback };
}

/** Rank a performed attempt against MANY references. templates: [{label, frames, calibration}].
 *  Returns { ranked:[{label,score,distance}…], best, margin }. */
export function classify(attempt, attemptCalib, templates, level = 'normal') {
  const ranked = templates.map(t => {
    const r = scoreAttempt(attempt, attemptCalib, t.frames, t.calibration, level);
    return { label: t.label, score: r.score, distance: r.distance };
  }).sort((a, b) => b.score - a.score);
  return { ranked, best: ranked[0] || null, margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0]?.score || 0 };
}

/** Test-mode verdict against a PROMPTED target: pass only if the attempt clears the
 *  bar AND the prompted sign is the nearest template (kills "any wiggle passes"). */
export function verifyAgainstTarget(attempt, attemptCalib, targetLabel, templates, level = 'normal') {
  const target = templates.find(t => t.label === targetLabel);
  if (!target) return { score: 0, grade: 'F', pass: false, feedback: ['No reference for this sign yet.'], nearest: null };
  const scored = scoreAttempt(attempt, attemptCalib, target.frames, target.calibration, level);
  const { best } = classify(attempt, attemptCalib, templates, level);
  // Co-nearest counts: integer scores can tie, and classify's stable sort would arbitrarily
  // put another sign first — don't reject a correctly-performed target on array order.
  const isNearest = best && (best.label === targetLabel || best.score === scored.score);
  const pass = scored.pass && isNearest;
  const feedback = [...scored.feedback];
  if (scored.pass && !isNearest) feedback.push(`That looked more like "${best.label}" than "${targetLabel}".`);
  return { ...scored, pass, nearest: best?.label || null, nearestScore: best?.score ?? 0, feedback };
}
