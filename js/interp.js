/* ============================================================
   SgSL — Shared Min-Jerk Interpolation
   ============================================================
   Single source of truth for frame interpolation, imported by the
   playback engine (player.js), the recorder preview (recorder.js),
   the sentence engine (sentence-engine.js), and the fidelity metric
   (metrics.js).

   Keeping ONE implementation guarantees "looked fine in the recorder
   preview but wrong in the library" class of bugs cannot happen — the
   recorder and the library play back through identical math.

   A frame is { t, pose, poseWorld, face, leftHand, rightHand } where
   each channel is an array of [x, y, z, (visibility)] landmarks.
   ============================================================ */

// 5th-order minimum-jerk easing: 0 velocity & acceleration at both ends.
export function mjEval(x0, xf, t) {
  const t3 = t * t * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  return x0 + (xf - x0) * (10 * t3 - 15 * t4 + 6 * t5);
}

// Interpolate one landmark channel (array of [x,y,z,(vis)]).
export function lerpLM(a, b, t) {
  if (!a) return b;
  if (!b) return a;
  return b.map((lm, i) => {
    const pa = a[i] || lm;
    const out = [
      mjEval(pa[0] ?? lm[0], lm[0], t),
      mjEval(pa[1] ?? lm[1], lm[1], t),
      mjEval(pa[2] ?? 0, lm[2] ?? 0, t),
    ];
    if (lm.length > 3) out.push(lm[3]); // preserve visibility unchanged
    return out;
  });
}

// Interpolate a full holistic frame.
// NOTE: includes the 3D WORLD hands. These were omitted, so every interpolated
// playback frame (player, preview, sentence bridges — lerpFrame runs on nearly
// every rendered frame) lost its world hands and fell back to the legacy 2D hand
// path, quietly diverging from live rendering.
export function lerpFrame(a, b, t) {
  if (!a) return b;
  // World hands interpolate only when BOTH endpoints carry them: lerpLM's null-side
  // passthrough would otherwise SNAP the channel on at a present/absent boundary
  // (e.g. a sentence bridge from an old no-world-hands clip into a new recording),
  // hard-switching solver families mid-bridge. Absent on either side -> the span
  // renders through the 2D path, matching live dropout behaviour.
  const both = (x, y) => (x && y) ? lerpLM(x, y, t) : undefined;
  return {
    leftHand:  lerpLM(a.leftHand, b.leftHand, t),
    rightHand: lerpLM(a.rightHand, b.rightHand, t),
    leftHandWorld:  both(a.leftHandWorld, b.leftHandWorld),
    rightHandWorld: both(a.rightHandWorld, b.rightHandWorld),
    face:      lerpLM(a.face, b.face, t),
    pose:      lerpLM(a.pose, b.pose, t),
    poseWorld: lerpLM(a.poseWorld, b.poseWorld, t),
  };
}
