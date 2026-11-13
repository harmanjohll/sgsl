/* ============================================================
   SgSL Avatar — Dot Renderer
   ============================================================
   Renders MediaPipe landmarks (hands + pose + face) as a skeleton
   overlay onto a canvas. No retargeting, no avatar — just the
   literal dots and connecting lines that the detector found.

   Used in two places:
     - Live recording: draws on top of the camera feed so the user
       sees themselves as a stick figure while they sign.
     - Playback: draws on a blank canvas so the user can review a
       saved recording frame-by-frame.

   The renderer is stateless aside from the canvas it draws on;
   call drawSkeleton(canvas, frame, opts) per frame. A frame may
   be either:
     - raw MediaPipe results object (live capture): has
       poseLandmarks, leftHandLandmarks, rightHandLandmarks,
       faceLandmarks — each an array of {x, y, z, visibility?}.
     - stored-frame format (recorder.js extractFrame output):
       has pose, leftHand, rightHand, face — each an array of
       [x, y, z, visibility?] tuples.
   The renderer accepts both shapes transparently.
   ============================================================ */

// Pose landmark connections (MediaPipe Pose 33-point topology).
// Each pair is an edge between two landmark indices.
const POSE_EDGES = [
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm (MP-anat: appears on right of UN-mirrored image)
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  // Right arm
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // Face / neck (just the essentials)
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // Legs (draw even though we don't drive them — visual completeness)
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

// Hand landmark connections (MediaPipe Hands 21-point topology).
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],              // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],              // Index
  [5, 9], [9, 10], [10, 11], [11, 12],         // Middle
  [9, 13], [13, 14], [14, 15], [15, 16],       // Ring
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20], // Little + palm
];

// A small subset of face landmarks that carries facial expression
// without drawing all 468 dots (which just looks like noise).
const FACE_KEY_POINTS = [
  10, 67, 109, 338, 297,     // Forehead
  159, 145, 386, 374,         // Eye corners (L upper/lower, R upper/lower)
  1, 4,                       // Nose tip
  61, 291, 13, 14,            // Mouth corners + top/bottom center
  33, 133, 362, 263,          // Eye inner/outer corners
];

const COLORS = {
  pose:      'rgba(120, 220, 140, 0.85)',  // green
  leftHand:  'rgba(255, 140, 60, 0.90)',   // warm orange
  rightHand: 'rgba(60, 180, 255, 0.90)',   // cool blue
  face:      'rgba(200, 200, 255, 0.60)',  // pale violet
  bone:      'rgba(255, 255, 255, 0.45)',
};

/** Normalize either frame shape to a common internal form. */
function unpack(frame) {
  if (!frame) return { pose: null, leftHand: null, rightHand: null, face: null };
  // Raw MediaPipe results (fields named *Landmarks, array of {x,y,...}).
  if (frame.poseLandmarks !== undefined
      || frame.leftHandLandmarks !== undefined
      || frame.rightHandLandmarks !== undefined) {
    return {
      pose: frame.poseLandmarks || null,
      leftHand: frame.leftHandLandmarks || null,
      rightHand: frame.rightHandLandmarks || null,
      face: frame.faceLandmarks || null,
    };
  }
  // Stored frame format: arrays of [x, y, z, v?] tuples. Convert to
  // the same {x, y, z, visibility} objects the raw path uses.
  const convert = (arr) => arr ? arr.map(lm => ({
    x: lm[0], y: lm[1], z: lm[2] ?? 0, visibility: lm[3] ?? 1,
  })) : null;
  return {
    pose: convert(frame.pose),
    leftHand: convert(frame.leftHand),
    rightHand: convert(frame.rightHand),
    face: convert(frame.face),
  };
}

function drawEdges(ctx, landmarks, edges, w, h, color) {
  if (!landmarks) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const [a, b] of edges) {
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!la || !lb) continue;
    // Skip very-low-visibility pose landmarks so we don't draw
    // edges to hallucinated off-frame joints.
    if ((la.visibility !== undefined && la.visibility < 0.3)
        || (lb.visibility !== undefined && lb.visibility < 0.3)) continue;
    ctx.beginPath();
    ctx.moveTo(la.x * w, la.y * h);
    ctx.lineTo(lb.x * w, lb.y * h);
    ctx.stroke();
  }
}

function drawPoints(ctx, landmarks, w, h, color, radius = 3, visThresh = 0.3) {
  if (!landmarks) return;
  ctx.fillStyle = color;
  for (const lm of landmarks) {
    if (!lm) continue;
    if (lm.visibility !== undefined && lm.visibility < visThresh) continue;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFaceSubset(ctx, landmarks, w, h, color, radius = 1.5) {
  if (!landmarks) return;
  ctx.fillStyle = color;
  for (const idx of FACE_KEY_POINTS) {
    const lm = landmarks[idx];
    if (!lm) continue;
    ctx.beginPath();
    ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draw the skeleton for one frame.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} frame — either raw MediaPipe results or stored frame shape
 * @param {Object} [opts]
 * @param {boolean} [opts.clear=true] — clear canvas first
 * @param {number}  [opts.alpha=1.0]  — global alpha (fade for trails)
 * @param {boolean} [opts.showFace=true]
 */
export function drawSkeleton(canvas, frame, opts = {}) {
  if (!canvas) return;
  const { clear = true, alpha = 1.0, showFace = true } = opts;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  if (clear) ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = alpha;

  const { pose, leftHand, rightHand, face } = unpack(frame);

  // Bones (connecting lines) under dots so joints sit on top.
  drawEdges(ctx, pose,      POSE_EDGES, w, h, COLORS.bone);
  drawEdges(ctx, leftHand,  HAND_EDGES, w, h, COLORS.bone);
  drawEdges(ctx, rightHand, HAND_EDGES, w, h, COLORS.bone);

  // Face: subset only (drawing all 468 is noise).
  if (showFace) drawFaceSubset(ctx, face, w, h, COLORS.face);

  // Joint dots on top.
  drawPoints(ctx, pose,      w, h, COLORS.pose,      3.5);
  drawPoints(ctx, leftHand,  w, h, COLORS.leftHand,  3);
  drawPoints(ctx, rightHand, w, h, COLORS.rightHand, 3);

  ctx.restore();
}

/** Clear the canvas without drawing anything. */
export function clearCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
