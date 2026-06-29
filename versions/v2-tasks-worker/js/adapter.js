/* ============================================================
   SgSL v2 — Worker output -> legacy `results` adapter
   ============================================================
   retarget.applyFromMediaPipe(vrm, results) reads a fixed set of
   fields. This builds exactly that object from the Tasks-Vision
   worker payload, so the SAME tuned retarget drives the avatar in
   v2 as in v1 (fidelity parity, no drift).

   Fields consumed by retarget (see sgsl-app/js/retarget.js:654+):
     results.faceLandmarks              (>=468)
     results.za                         pose 3D world landmarks
     results.poseLandmarks              pose 2D normalized landmarks
     results.left/rightHandLandmarks    hand 2D normalized landmarks
     results.left/rightHandWorldLandmarks   hand 3D world landmarks

   Hand L/R routing replicates sgsl-app/js/recorder.js::mergeHandLandmarker
   EXACTLY (SWAP_HANDEDNESS = false), so chirality + thumb match v1.
   ============================================================ */

// Mirror of recorder.js's constant. v1 ships with this false (signer's own hand
// drives the same-side avatar hand — the proven "copy me" anatomical mapping).
const SWAP_HANDEDNESS = false;

export function toResults(payload) {
  const results = {
    poseLandmarks: payload.pose || null,
    za: payload.poseWorld || null,            // Holistic called this `za`; retarget reads `za || ea`
    faceLandmarks: payload.face || null,
    leftHandLandmarks: null,
    rightHandLandmarks: null,
    leftHandWorldLandmarks: null,
    rightHandWorldLandmarks: null,
  };

  const hands = payload.hands || [];
  for (let i = 0; i < hands.length; i++) {
    let side = hands[i].categoryName || (i === 0 ? 'Right' : 'Left');
    if (SWAP_HANDEDNESS) side = side === 'Right' ? 'Left' : 'Right';
    const lm = hands[i].landmarks || null;
    const world = hands[i].worldLandmarks || null;
    if (side === 'Right') { results.rightHandLandmarks = lm; results.rightHandWorldLandmarks = world; }
    else { results.leftHandLandmarks = lm; results.leftHandWorldLandmarks = world; }
  }

  return results;
}
