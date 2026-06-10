/**
 * Parametric 3D hand model.
 *
 * Generates 21 hand landmarks (MediaPipe topology) from a compact pose
 * description via forward kinematics. The same model drives:
 *   - the animated signing avatar (rendering)
 *   - the canonical pose templates used by the gesture classifier
 *
 * Local coordinate frame (right hand, palm facing the viewer):
 *   +X → viewer's right (pinky side), thumb side is -X
 *   +Y → up (finger direction at rest)
 *   +Z → out of the palm, toward the viewer
 * Units are roughly "palm heights" (wrist → middle knuckle ≈ 1).
 *
 * MediaPipe landmark indices:
 *   0 wrist | 1-4 thumb | 5-8 index | 9-12 middle | 13-16 ring | 17-20 pinky
 */

const DEG = Math.PI / 180;

export const FINGER_NAMES = ["index", "middle", "ring", "pinky"];

// Knuckle (MCP) positions and bone lengths per finger.
const MCP = {
  index: [-0.25, 0.95, 0],
  middle: [0.0, 1.0, 0],
  ring: [0.22, 0.95, 0],
  pinky: [0.42, 0.85, 0],
};
const LEN = {
  index: [0.45, 0.27, 0.2],
  middle: [0.5, 0.31, 0.22],
  ring: [0.46, 0.29, 0.21],
  pinky: [0.35, 0.22, 0.18],
};
// Natural splay (deg). Positive leans toward -X (thumb side).
const BASE_SPLAY = { index: 5, middle: 0, ring: -6, pinky: -12 };

// Curl presets: [MCP, PIP, DIP] joint bend in degrees.
// 0 = straight; bending rotates the bone toward the palm (+Z, then -Y).
export const CURL = {
  ext: [4, 4, 2], // fully extended
  fist: [85, 100, 55], // curled tight into the palm
  ecurl: [70, 95, 50], // curled, fingertips resting lower (letter E)
  dcurl: [55, 75, 40], // curled out to meet the thumb (letter D)
  ocurl: [45, 60, 45], // rounded, tip reaching forward (O / F pinch)
  half: [38, 30, 18], // gentle arc (letter C)
  hook: [8, 100, 55], // straight knuckle, hooked tip (letter X)
};

// Thumb presets: explicit positions for landmarks 1-4 (CMC, MCP, IP, tip).
const CMC = [-0.3, 0.22, 0.05];
export const THUMB = {
  up: [CMC, [-0.44, 0.52, 0.08], [-0.47, 0.78, 0.1], [-0.48, 1.0, 0.1]],
  out: [CMC, [-0.56, 0.4, 0.06], [-0.8, 0.46, 0.08], [-1.0, 0.5, 0.08]],
  acrossPalm: [CMC, [-0.26, 0.44, 0.14], [-0.04, 0.52, 0.18], [0.17, 0.54, 0.18]],
  // S: thumb wraps across the OUTSIDE of the curled fingers (large z).
  acrossFront: [CMC, [-0.3, 0.46, 0.26], [-0.08, 0.58, 0.34], [0.13, 0.62, 0.34]],
  underTips: [CMC, [-0.28, 0.42, 0.22], [-0.06, 0.5, 0.32], [0.14, 0.52, 0.32]],
  // M/N: thumb tucked UNDER the fingers (small z), tip peeking out higher up.
  betweenMR: [CMC, [-0.26, 0.46, 0.1], [-0.1, 0.66, 0.14], [0.08, 0.82, 0.16]],
  betweenRP: [CMC, [-0.22, 0.48, 0.1], [0.04, 0.7, 0.14], [0.28, 0.86, 0.16]],
  againstIndex: [CMC, [-0.38, 0.48, 0.14], [-0.37, 0.68, 0.2], [-0.34, 0.84, 0.24]],
  betweenIM: [CMC, [-0.36, 0.52, 0.12], [-0.24, 0.76, 0.16], [-0.14, 0.96, 0.18]],
  cShape: [CMC, [-0.4, 0.36, 0.18], [-0.36, 0.52, 0.3], [-0.28, 0.62, 0.38]],
  parallelIndex: [CMC, [-0.42, 0.5, 0.16], [-0.42, 0.72, 0.2], [-0.42, 0.9, 0.22]],
};

function rotZ(p, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

/** Forward kinematics for one non-thumb finger → [MCP, PIP, DIP, TIP]. */
function fingerChain(name, curl, splayDeg, zoff = 0) {
  const bends = typeof curl === "string" ? CURL[curl] : curl;
  if (!bends) throw new Error(`unknown curl preset: ${curl}`);
  const splay =
    splayDeg !== undefined && splayDeg !== null ? splayDeg : BASE_SPLAY[name];
  const pts = [MCP[name].slice()];
  let theta = 0;
  for (let i = 0; i < 3; i++) {
    theta += bends[i];
    // Bend rotates +Y toward +Z (toward the viewer-facing palm).
    const dir = rotZ(
      [0, Math.cos(theta * DEG), Math.sin(theta * DEG)],
      splay
    );
    const prev = pts[pts.length - 1];
    pts.push([
      prev[0] + LEN[name][i] * dir[0],
      prev[1] + LEN[name][i] * dir[1],
      prev[2] + LEN[name][i] * dir[2],
    ]);
  }
  if (zoff) for (const p of pts) p[2] += zoff;
  return pts;
}

const lerp3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Thumb chain. `spec` is a THUMB preset name or {pinch:"index"|...}. */
function thumbChain(spec, fingers) {
  if (typeof spec === "string") {
    const pts = THUMB[spec];
    if (!pts) throw new Error(`unknown thumb preset: ${spec}`);
    return pts.map((p) => p.slice());
  }
  if (spec && spec.pinch) {
    // Curve the thumb so its tip meets the named finger's tip.
    const tip = fingers[spec.pinch][3];
    const target = [tip[0] - 0.02, tip[1] - 0.05, tip[2] + 0.02];
    const p2 = lerp3(CMC, target, 0.38);
    const p3 = lerp3(CMC, target, 0.7);
    p2[0] -= 0.14;
    p2[2] += 0.06;
    p3[0] -= 0.08;
    p3[2] += 0.08;
    return [CMC.slice(), p2, p3, target];
  }
  throw new Error("thumb spec required");
}

/**
 * Build 21 landmarks from a pose spec:
 * {
 *   fingers: { index: {curl, splay?, zoff?}, middle: ..., ring: ..., pinky: ... },
 *   thumb: "up" | {pinch: "index"} | ...,
 *   rot?: whole-hand rotation about Z in degrees (90 = fingers point left,
 *         180 = fingers point down)
 * }
 * Returns array of 21 [x, y, z] in the local frame described above.
 */
export function handLandmarks(pose) {
  const chains = {};
  for (const name of FINGER_NAMES) {
    const f = pose.fingers[name];
    if (!f) throw new Error(`missing finger spec: ${name}`);
    chains[name] = fingerChain(name, f.curl, f.splay, f.zoff || 0);
  }
  const thumb = thumbChain(pose.thumb, chains);

  let pts = [
    [0, 0, 0],
    ...thumb,
    ...chains.index,
    ...chains.middle,
    ...chains.ring,
    ...chains.pinky,
  ];
  if (pose.rot) pts = pts.map((p) => rotZ(p, pose.rot));
  return pts;
}

/**
 * Convert local-frame landmarks to MediaPipe-style coordinates
 * (x right, y DOWN, z toward camera is negative). Scale/offset are
 * arbitrary; the classifier normalises them away.
 */
export function toMediaPipe(localPts) {
  return localPts.map((p) => ({
    x: 0.5 + 0.16 * p[0],
    y: 0.62 - 0.16 * p[1],
    z: -0.16 * p[2],
  }));
}
