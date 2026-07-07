/* ============================================================
   SgSL fidelity harness — synthetic ground-truth hand fixtures
   ============================================================
   Generates worker-shaped payloads ({pose, poseWorld, face, hands})
   that adapter.toResults() consumes, with analytic ground truth per
   frame. Coordinates mimic MediaPipe conventions:
     world hands: meters, x = image right, y = image DOWN,
                  z: negative = toward the camera.
     pose/image landmarks: normalized [0..1], y down.

   Canonical RIGHT hand: palm to camera (normal ≈ (0,0,-1)),
   fingers up (−y), thumb on image-right (+x) — the true chirality
   of a right hand seen palm-first in an unmirrored camera image.

   Ground truth per frame:
     gt.quat  — the rotation applied to the canonical hand [x,y,z,w]
     gt.curls — per-finger [MCP,PIP,DIP] bend angles (deg), computed
                from the landmarks themselves (rotation-invariant).

   The metrics built on this are CONVENTION-FREE (no assumption about
   the retarget's axis mapping):
     - delta-angle rigidity: conjugation preserves rotation angle, so
       the avatar hand must rotate by the same per-frame angle as gt.
     - bends are scalars, comparable directly.
   ============================================================ */

// ── minimal quaternion / vec helpers ([x,y,z,w], plain arrays) ──────────────
export const qAxisAngle = (ax, ang) => {
  const [x, y, z] = ax, n = Math.hypot(x, y, z) || 1, s = Math.sin(ang / 2);
  return [x / n * s, y / n * s, z / n * s, Math.cos(ang / 2)];
};
export const qMul = (a, b) => ([
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]);
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qAngle = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3])));
export const rotV = (q, v) => {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const angBetween = (a, b) => {
  const d = norm(a), e = norm(b);
  return Math.acos(Math.max(-1, Math.min(1, d[0] * e[0] + d[1] * e[1] + d[2] * e[2]))) * 180 / Math.PI;
};

// ── canonical hand ──────────────────────────────────────────────────────────
// curl = {Index:[mcp,pip,dip], ...} degrees; omitted fingers are straight.
export function canonicalRightHand(curl = {}) {
  const FING = { Index: 0.030, Middle: 0.010, Ring: -0.010, Pinky: -0.030 };
  const SEGS = [0.032, 0.024, 0.020];
  const MCP_Y = -0.075;
  const D = Math.PI / 180;
  const pts = new Array(21).fill(null).map(() => [0, 0, 0]);   // wrist at origin
  // Thumb (1..4): straight, angled toward image-right/down; light default curl only.
  const tdir = norm([0.60, -0.72, -0.10]);
  const tlen = [0.035, 0.030, 0.024];
  let p = [0.024, -0.020, -0.004];
  pts[1] = [...p];
  for (let i = 0; i < 3; i++) {
    p = [p[0] + tdir[0] * tlen[i], p[1] + tdir[1] * tlen[i], p[2] + tdir[2] * tlen[i]];
    pts[2 + i] = [...p];
  }
  // Four fingers: chain from MCP, curling about +x (toward the palm side, −z).
  const bases = { Index: 5, Middle: 9, Ring: 13, Pinky: 17 };
  for (const [f, x] of Object.entries(FING)) {
    const b = bases[f];
    const c = curl[f] || [0, 0, 0];
    pts[b] = [x, MCP_Y, 0];
    let cum = 0, cur = pts[b];
    for (let i = 0; i < 3; i++) {
      cum += c[i] * D;
      const dir = [0, -Math.cos(cum), -Math.sin(cum)];   // rotate (0,-1,0) about +x toward −z
      cur = [cur[0] + dir[0] * SEGS[i], cur[1] + dir[1] * SEGS[i], cur[2] + dir[2] * SEGS[i]];
      pts[b + 1 + i] = [...cur];
    }
  }
  return pts;
}
export const mirrorToLeft = (pts) => pts.map(([x, y, z]) => [-x, y, z]);
const applyQuat = (pts, q) => pts.map((p) => rotV(q, p));

// gt bends from landmarks (same definition the harness applies to avatar joints).
const FINGER_LMS = { Index: [0, 5, 6, 7, 8], Middle: [0, 9, 10, 11, 12], Ring: [0, 13, 14, 15, 16], Pinky: [0, 17, 18, 19, 20] };
export function bendsFromLandmarks(pts) {
  const out = {};
  for (const [f, k] of Object.entries(FINGER_LMS)) {
    const segs = [];
    for (let i = 0; i < 4; i++) segs.push(sub(pts[k[i + 1]], pts[k[i]]));
    out[f] = [angBetween(segs[0], segs[1]), angBetween(segs[1], segs[2]), angBetween(segs[2], segs[3])];
  }
  return out;
}

// ── pose + payload builders ─────────────────────────────────────────────────
function makePose({ wristR = null, wristL = null, occludeShoulder = null } = {}) {
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.85, z: 0, visibility: 0.2 }));
  const set = (i, x, y, v = 0.95) => { lm[i] = { x, y, z: 0, visibility: v }; };
  set(0, 0.50, 0.28, 0.98);                       // nose
  set(11, 0.58, 0.40, occludeShoulder === 11 ? 0.1 : 0.95);  // signer-left shoulder (image right)
  set(12, 0.42, 0.40, occludeShoulder === 12 ? 0.1 : 0.95);  // signer-right shoulder (image left)
  set(23, 0.56, 0.72); set(24, 0.44, 0.72);       // hips
  if (wristL) set(15, wristL.x, wristL.y); else set(15, 0.60, 0.78, 0.85);  // MP left wrist
  if (wristR) set(16, wristR.x, wristR.y); else set(16, 0.40, 0.78, 0.85);  // MP right wrist
  return lm;
}

// image-space hand landmarks: canonical/world points scaled onto the frame at target2D.
function imageHand(worldPts, target2D, scale = 1.4) {
  return worldPts.map(([x, y, z]) => ({ x: target2D.x + x * scale, y: target2D.y + y * scale, z }));
}

function frame(worldPts, { label = 'Right', target2D = { x: 0.38, y: 0.45 }, occludeShoulder = null, gtQuat = [0, 0, 0, 1] } = {}) {
  const world = worldPts.map(([x, y, z]) => ({ x, y, z }));
  const poseOpts = { occludeShoulder };
  if (label === 'Right') poseOpts.wristR = target2D; else poseOpts.wristL = target2D;
  return {
    payload: {
      pose: makePose(poseOpts), poseWorld: null, face: null,
      hands: [{ categoryName: label, landmarks: imageHand(worldPts, target2D), worldLandmarks: world }],
    },
    gt: { quat: gtQuat, bends: bendsFromLandmarks(worldPts) },
  };
}

// Two-hand frame: independent geometry/label/2D target per hand — for the
// hands-interacting scenarios (dropout / merged-blob / recovery). `hands` entries
// may be omitted (null) to simulate MediaPipe dropping a detection mid-contact.
function duoFrame(specs, { occludeShoulder = null } = {}) {
  const hands = [];
  const poseOpts = { occludeShoulder };
  let gtBends = {};
  for (const spec of specs) {
    if (!spec) continue;
    const { pts, label, target2D } = spec;
    hands.push({ categoryName: label, landmarks: imageHand(pts, target2D), worldLandmarks: pts.map(([x, y, z]) => ({ x, y, z })) });
    if (label === 'Right') poseOpts.wristR = target2D; else poseOpts.wristL = target2D;
    gtBends[label] = bendsFromLandmarks(pts);
  }
  return { payload: { pose: makePose(poseOpts), poseWorld: null, face: null, hands }, gt: { quat: [0, 0, 0, 1], bends: gtBends } };
}

// ── scenarios ───────────────────────────────────────────────────────────────
const FIST = { Index: [70, 85, 60], Middle: [70, 85, 60], Ring: [70, 85, 60], Pinky: [70, 85, 60] };
const VEE = { Ring: [70, 85, 60], Pinky: [70, 85, 60] };
const POINT = { Middle: [70, 85, 60], Ring: [70, 85, 60], Pinky: [70, 85, 60] };

export function buildScenarios() {
  const S = [];
  const flatR = canonicalRightHand();

  const sweep = (name, side, base, axis, from, to, step, opts = {}) => {
    const frames = [];
    for (let a = from; a <= to + 1e-9; a += step) {
      const q = qAxisAngle(axis, a * Math.PI / 180);
      frames.push(frame(applyQuat(base, q), { label: side, gtQuat: q, ...opts }));
    }
    S.push({ name, side, kind: 'orient', frames });
  };

  // Orientation rigidity sweeps (the HAND-1 flip lives in the yaw sweep's edge-on zone).
  sweep('R-yaw', 'Right', flatR, [0, 1, 0], -85, 85, 5);
  sweep('R-roll', 'Right', flatR, [0, -1, 0], 0, 350, 10);
  sweep('R-pitch', 'Right', flatR, [1, 0, 0], -75, 75, 5);
  const flatL = mirrorToLeft(flatR);
  sweep('L-yaw', 'Left', flatL, [0, 1, 0], -85, 85, 5, { target2D: { x: 0.62, y: 0.45 } });
  sweep('L-roll', 'Left', flatL, [0, -1, 0], 0, 350, 10, { target2D: { x: 0.62, y: 0.45 } });

  // Handshape fidelity (static, 10 frames each so slerps converge).
  for (const [name, curl] of [['shape-flat', {}], ['shape-fist', FIST], ['shape-V', VEE], ['shape-point', POINT]]) {
    const pts = canonicalRightHand(curl);
    S.push({ name, side: 'Right', kind: 'shape', frames: Array.from({ length: 10 }, () => frame(pts)) });
  }

  // Across-body sweeps (arm continuity). Right hand, target x sweeps across the midline.
  const crossFrames = (mut) => {
    const fr = [];
    for (let i = 0; i <= 44; i++) {
      const t = { x: 0.28 + i * 0.01, y: 0.42 };
      const o = mut ? mut(i) : {};
      fr.push(frame(flatR, { target2D: t, ...o }));
    }
    return fr;
  };
  S.push({ name: 'cross-clean', side: 'Right', kind: 'arm', frames: crossFrames() });
  S.push({ name: 'cross-occlusion', side: 'Right', kind: 'arm', frames: crossFrames((i) => (i >= 20 && i <= 26 ? { occludeShoulder: 11 } : {})) });
  S.push({ name: 'cross-labelflip', side: 'Right', kind: 'arm', frames: crossFrames((i) => (i >= 22 && i <= 27 ? { label: 'Left' } : {})) });

  // ── Two-hands-interacting scenarios (the hands-together failure mode) ────────
  // Right hand flat, LEFT hand a FIST (so finger relaxation during a dropout is a
  // big measurable signal: PIP 85° → rest ≈ 0°). Hands approach (0..17), are in
  // contact (18..25), separate (26..39).
  const fistL = mirrorToLeft(canonicalRightHand(FIST));
  const duoSpec = (i, { dropLeft = false, merged = false } = {}) => {
    const t = Math.min(i / 17, 1);                      // approach progress
    const sep = Math.max(0, (i - 25) / 14);             // separation progress
    const rx = 0.38 + 0.10 * t - 0.10 * sep;
    const lx = 0.62 - 0.10 * t + 0.10 * sep;
    const y = 0.45;
    const R = { pts: flatR, label: 'Right', target2D: { x: rx, y } };
    const L = { pts: fistL, label: 'Left', target2D: { x: lx, y } };
    if (merged) {
      // One blob detection between the two wrists, labeled Right (a real MediaPipe
      // failure when hands overlap): geometry = the right hand at the midpoint.
      return [{ pts: flatR, label: 'Right', target2D: { x: (rx + lx) / 2, y } }];
    }
    return dropLeft ? [R] : [R, L];
  };
  const duo = (name, mut) => {
    const frames = [];
    for (let i = 0; i <= 39; i++) frames.push(duoFrame(duoSpec(i, mut ? mut(i) : {})));
    // window: the contact frames where the failure is injected + measured
    S.push({ name, side: 'Right', kind: 'duo', window: [18, 25], frames });
  };
  duo('duo-approach');                                                   // clean contact
  duo('duo-dropout', (i) => (i >= 18 && i <= 25 ? { dropLeft: true } : {}));
  duo('duo-merged', (i) => (i >= 18 && i <= 25 ? { merged: true } : {}));

  // ── ABSOLUTE palm-facing + rendered chirality (the un-foolable pin) ─────────
  // The rigidity metrics are delta-based, so a CONSTANT 180° facing inversion
  // passes them. Two absolute assertions close that hole:
  //   expectFacing — the driven _handDbg facing, in the RIG-PAIRED convention:
  //     the measured normal and the rig rest palmAxis are both chirality-odd, so
  //     a correctly-rendered LEFT palm-to-camera reads facing ≈ −1 (not +1).
  //   expectThumbDx — ANATOMY in world space (convention-free): for a flat palm
  //     toward the camera, the avatar's RIGHT thumb points to the viewer's right
  //     (+x), the LEFT thumb to the viewer's left (−x); flipped for palm-away.
  const away = (pts) => applyQuat(pts, qAxisAngle([0, 1, 0], Math.PI));
  for (const [name, pts, side, target2D, expectFacing, expectThumbDx] of [
    ['face-R-toward', flatR, 'Right', { x: 0.38, y: 0.45 }, 1, 1],
    ['face-R-away', away(flatR), 'Right', { x: 0.38, y: 0.45 }, -1, -1],
    ['face-L-toward', flatL, 'Left', { x: 0.62, y: 0.45 }, -1, -1],
    ['face-L-away', away(flatL), 'Left', { x: 0.62, y: 0.45 }, 1, 1],
  ]) {
    S.push({
      name, side, kind: 'facing', expectFacing, expectThumbDx,
      frames: Array.from({ length: 12 }, () => frame(pts, { label: side, target2D })),
    });
  }

  return S;
}
