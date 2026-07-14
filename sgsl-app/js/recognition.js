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
   - hand SHAPE → re-anchored to its own wrist, scaled by hand span, so the
     handshape is compared regardless of where/how big the hand is on screen.
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

/** One hand → {loc:[x,y] body-frame, shape:[21×[x,y]] wrist-anchored+scaled}|null. */
function normHand(hand2d, poseWrist, bf) {
  const poseOk = poseWrist && (poseWrist[3] ?? 1) >= 0.5;   // visibility gate (no phantom hands)
  const wrist = hand2d?.[0] || (poseOk ? [poseWrist[0], poseWrist[1]] : null);
  if (!wrist || !bf) return null;
  const loc = [(wrist[0] - bf.mid[0]) / bf.sw, (wrist[1] - bf.mid[1]) / bf.sw];
  let shape = null;
  if (hand2d && hand2d.length >= 21) {
    const span = Math.hypot(hand2d[9][0] - hand2d[0][0], hand2d[9][1] - hand2d[0][1]) || 1e-3;
    shape = hand2d.map(p => [(p[0] - hand2d[0][0]) / span, (p[1] - hand2d[0][1]) / span]);
  }
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
      const ld = dist2(a.loc, b.loc), sd = shapeDist(a.shape, b.shape);
      total += W.loc * ld + W.shape * sd;
      if (acc) { acc[side].loc += ld; acc[side].shape += sd; acc[side].n++; }
    } else if (a || b) {
      total += W.presence;
      if (acc) { acc[side].presence++; acc[side].n++; }
    }
  }
  return total;
}

const gradeFor = (score) =>
  score >= 85 ? 'A' : score >= 70 ? 'B' : score >= PASS_SCORE ? 'C' : score >= 40 ? 'D' : 'F';

/** Score a performed attempt against ONE reference. Both are raw frame arrays
 *  plus their calibration. Returns { score, grade, pass, distance, feedback }. */
export function scoreAttempt(attempt, attemptCalib, reference, refCalib) {
  const A = normalizeSequence(attempt, attemptCalib);
  const B = normalizeSequence(reference, refCalib);
  const withHand = (seq) => seq.filter(f => f.R || f.L).length;
  if (A.length < 3 || B.length < 3) return { score: 0, grade: 'F', pass: false, distance: Infinity, feedback: ['Not enough frames captured.'] };
  // A sequence of body-less / hand-less frames normalizes to all-null (frameCost 0),
  // which would score a perfect match on garbage. Require real hand content on both.
  if (withHand(A) < 3 || withHand(B) < 3) return { score: 0, grade: 'F', pass: false, distance: Infinity, feedback: ['No hands were clearly visible — step into frame and try again.'] };

  const acc = { R: { loc: 0, shape: 0, presence: 0, n: 0 }, L: { loc: 0, shape: 0, presence: 0, n: 0 } };
  const { normDistance } = dtw(A, B, (a, b) => frameCost(a, b, acc), { band: 0.25 });
  const score = Math.round(100 * Math.exp(-normDistance / SCORE_TAU));

  // Feedback: name the worst channel per active hand.
  const feedback = [];
  for (const side of ['R', 'L']) {
    const c = acc[side]; if (!c.n) continue;
    const label = side === 'R' ? 'right' : 'left';
    if (c.presence > c.n * 0.4) feedback.push(`Your ${label} hand was missing for much of the sign.`);
    else if (c.shape / Math.max(1, c.n) > 0.35) feedback.push(`Your ${label} handshape drifted from the target.`);
    else if (c.loc / Math.max(1, c.n) > 0.6) feedback.push(`Your ${label} hand's placement/movement was off.`);
  }
  if (!feedback.length && score >= PASS_SCORE) feedback.push('Clean — that matches the reference well.');

  return { score, grade: gradeFor(score), pass: score >= PASS_SCORE, distance: +normDistance.toFixed(4), feedback };
}

/** Rank a performed attempt against MANY references. templates: [{label, frames, calibration}].
 *  Returns { ranked:[{label,score,distance}…], best, margin }. */
export function classify(attempt, attemptCalib, templates) {
  const ranked = templates.map(t => {
    const r = scoreAttempt(attempt, attemptCalib, t.frames, t.calibration);
    return { label: t.label, score: r.score, distance: r.distance };
  }).sort((a, b) => b.score - a.score);
  return { ranked, best: ranked[0] || null, margin: ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0]?.score || 0 };
}

/** Test-mode verdict against a PROMPTED target: pass only if the attempt clears the
 *  bar AND the prompted sign is the nearest template (kills "any wiggle passes"). */
export function verifyAgainstTarget(attempt, attemptCalib, targetLabel, templates) {
  const target = templates.find(t => t.label === targetLabel);
  if (!target) return { score: 0, grade: 'F', pass: false, feedback: ['No reference for this sign yet.'], nearest: null };
  const scored = scoreAttempt(attempt, attemptCalib, target.frames, target.calibration);
  const { best } = classify(attempt, attemptCalib, templates);
  // Co-nearest counts: integer scores can tie, and classify's stable sort would arbitrarily
  // put another sign first — don't reject a correctly-performed target on array order.
  const isNearest = best && (best.label === targetLabel || best.score === scored.score);
  const pass = scored.pass && isNearest;
  const feedback = [...scored.feedback];
  if (scored.pass && !isNearest) feedback.push(`That looked more like "${best.label}" than "${targetLabel}".`);
  return { ...scored, pass, nearest: best?.label || null, nearestScore: best?.score ?? 0, feedback };
}
