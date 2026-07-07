/* ============================================================
   SgSL — auto-tune: solve the 3-DOF hand-orientation calibration
   ============================================================
   The retarget applies a user calibration as qMeas · Euler(pitch, roll,
   yaw, 'YXZ'). When the signer holds the CANONICAL pose (flat hand,
   palm to the camera, fingers up), the calibrated basis should be the
   identity — so the needed correction is simply E = qMeasAvg⁻¹, and its
   'YXZ' Euler decomposition IS the slider triple (x=pitch, y=roll,
   z=yaw), per hand. Pure array math ([x,y,z,w] quats) so it unit-tests
   in Node (test/autotune.test.mjs).
   ============================================================ */

export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qNorm = (q) => {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
export const qMul = (a, b) => ([
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]);
export const qAngleDeg = (q) => 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI;

/** Mean of a tight cluster of quaternions (sign-aligned component average). */
export function avgQuats(list) {
  const ref = list[0];
  const acc = [0, 0, 0, 0];
  for (let q of list) {
    // q and -q are the same rotation; align hemispheres before averaging.
    if (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0) q = q.map((v) => -v);
    for (let i = 0; i < 4; i++) acc[i] += q[i];
  }
  return qNorm(acc);
}

/** three.js Euler 'YXZ' from a quaternion → degrees {pitchDeg(x), rollDeg(y), yawDeg(z)}. */
export function eulerYXZFromQuat(q) {
  const [x, y, z, w] = qNorm(q);
  // rotation matrix elements (row-major m[row][col])
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m21 = 2 * (x * y + z * w), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m31 = 2 * (x * z - y * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  const ex = Math.asin(-clamp1(m23));
  let ey, ez;
  if (Math.abs(m23) < 0.9999999) { ey = Math.atan2(m13, m33); ez = Math.atan2(m21, m22); }
  else { ey = Math.atan2(-m31, m11); ez = 0; }
  const D = 180 / Math.PI;
  return { pitchDeg: ex * D, rollDeg: ey * D, yawDeg: ez * D };
}

/** Euler 'YXZ' (degrees) → quaternion. (Used by tests + to verify a solve.) */
export function eulerYXZToQuat({ pitchDeg = 0, rollDeg = 0, yawDeg = 0 }) {
  const R = Math.PI / 360;   // half, in rad
  const cx = Math.cos(pitchDeg * R), sx = Math.sin(pitchDeg * R);
  const cy = Math.cos(rollDeg * R), sy = Math.sin(rollDeg * R);
  const cz = Math.cos(yawDeg * R), sz = Math.sin(yawDeg * R);
  // q = qY * qX * qZ  (three.js 'YXZ' intrinsic order)
  const qy = [0, sy, 0, cy], qx = [sx, 0, 0, cx], qz = [0, 0, sz, cz];
  return qMul(qMul(qy, qx), qz);
}

/** Solve the calibration triple from sampled raw bases (canonical pose held).
 *  Returns {pitchDeg, rollDeg, yawDeg, residualDeg, spreadDeg}:
 *  residualDeg — how far from identity the calibrated basis would still be (should be ~0);
 *  spreadDeg   — sample cluster tightness (large = the hand wasn't held steady). */
export function solveOrientationOffset(qMeasList, qExpected = [0, 0, 0, 1]) {
  const avg = avgQuats(qMeasList);
  const corr = qMul(qConj(avg), qExpected);      // qMeas · corr = qExpected
  const e = eulerYXZFromQuat(corr);
  const residualDeg = qAngleDeg(qMul(qMul(avg, eulerYXZToQuat(e)), qConj(qExpected)));
  let spread = 0;
  for (const q of qMeasList) spread = Math.max(spread, qAngleDeg(qMul(q, qConj(avg))));
  return { ...e, residualDeg, spreadDeg: spread };
}
