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

import { HandRouter } from '../../../sgsl-app/js/hand-router.js';

// Mirror of recorder.js's constant. v1 ships with this false (signer's own hand
// drives the same-side avatar hand — the proven "copy me" anatomical mapping).
const SWAP_HANDEDNESS = false;

// Temporal continuity: raw per-frame handedness labels flip while hands cross,
// which swapped the avatar's arms violently. One stream per page → one router.
const router = new HandRouter();

export function toResults(payload) {
  // Tasks-Vision sometimes materializes landmark.visibility as 0 (proto default) where
  // legacy Holistic carried a real score. All-zero visibility would freeze the torso
  // gate and reject perfectly-tracked shoulders in _bodyAnchor — strip it so the
  // `(visibility ?? 1)` gates treat it as "no signal", exactly like v1's hands.
  let pose = payload.pose || null;
  if (pose && pose.length && pose.every(lm => !(lm.visibility > 0))) {
    pose = pose.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
  }
  const results = {
    poseLandmarks: pose,
    za: payload.poseWorld || null,            // Holistic called this `za`; retarget reads `za || ea`
    faceLandmarks: payload.face || null,
    leftHandLandmarks: null,
    rightHandLandmarks: null,
    leftHandWorldLandmarks: null,
    rightHandWorldLandmarks: null,
  };

  const routed = router.route((payload.hands || []).map((h, i) => {
    let side = h.categoryName || (i === 0 ? 'Right' : 'Left');
    if (SWAP_HANDEDNESS) side = side === 'Right' ? 'Left' : 'Right';
    return { ...h, categoryName: side };
  }));
  if (routed.Right) { results.rightHandLandmarks = routed.Right.landmarks || null; results.rightHandWorldLandmarks = routed.Right.worldLandmarks || null; }
  if (routed.Left) { results.leftHandLandmarks = routed.Left.landmarks || null; results.leftHandWorldLandmarks = routed.Left.worldLandmarks || null; }

  return results;
}
