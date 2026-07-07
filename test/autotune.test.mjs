/* Auto-tune solver unit tests: given raw measured bases with a KNOWN offset,
   the solved Euler triple must cancel it (qMeas · Euler(solved) ≈ identity).
   Run: node test/autotune.test.mjs */
import { solveOrientationOffset, eulerYXZToQuat, qMul, qConj, qAngleDeg, avgQuats } from '../sgsl-app/js/autotune.js';

let passed = 0, failed = 0;
const check = (name, cond) => { if (cond) { passed++; console.log(`ok   ${name}`); } else { failed++; console.log(`FAIL ${name}`); } };

const jitter = (q, deg, axis) => {
  const r = deg * Math.PI / 360;
  const j = [...axis.map(a => a * Math.sin(r)), Math.cos(r)];
  return qMul(q, j);
};

// 1) Exact recovery: measured basis = a known rotation; solved triple must cancel it.
for (const truth of [
  { pitchDeg: 10, rollDeg: -170, yawDeg: 25 },
  { pitchDeg: -5, rollDeg: 10, yawDeg: -25 },
  { pitchDeg: 0, rollDeg: 0, yawDeg: 0 },
  { pitchDeg: 45, rollDeg: 90, yawDeg: -60 },
]) {
  const qMeas = qConj(eulerYXZToQuat(truth));   // the basis such that truth is the fix
  const solved = solveOrientationOffset([qMeas, qMeas, qMeas]);
  const residual = qAngleDeg(qMul(qMeas, eulerYXZToQuat(solved)));
  check(`cancels {${truth.pitchDeg},${truth.rollDeg},${truth.yawDeg}} (residual ${residual.toFixed(2)}°)`, residual < 0.01);
}

// 2) Noisy samples: ±3° jitter around the truth still solves to <1.5° residual.
{
  const qMeas = qConj(eulerYXZToQuat({ pitchDeg: 12, rollDeg: 8, yawDeg: 20 }));
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const ax = [[1,0,0],[0,1,0],[0,0,1]][i % 3];
    samples.push(jitter(qMeas, ((i % 7) - 3), ax));
  }
  const solved = solveOrientationOffset(samples);
  const residual = qAngleDeg(qMul(avgQuats(samples), eulerYXZToQuat(solved)));
  check(`noisy solve residual ${residual.toFixed(2)}° < 1.5`, residual < 1.5);
  check(`spread reported (${solved.spreadDeg.toFixed(1)}°)`, solved.spreadDeg > 1 && solved.spreadDeg < 8);
}

// 3) Sign-flipped duplicates (q and -q are the same rotation) average correctly.
{
  const q = eulerYXZToQuat({ pitchDeg: 30, rollDeg: -40, yawDeg: 10 });
  const neg = q.map(v => -v);
  const avg = avgQuats([q, neg, q, neg]);
  check('sign-flipped average stays put', qAngleDeg(qMul(avg, qConj(q))) < 0.01);
}

// 4) Side-aware expected basis: a LEFT canonical pose pairs at rotY(180°); solving
//    against that expectation must return a SMALL correction, not a ~180° roll.
{
  const rotY180 = [0, 1, 0, 0];
  const smallOff = eulerYXZToQuat({ pitchDeg: 8, rollDeg: -12, yawDeg: 15 });
  const qMeas = qMul(rotY180, qConj(smallOff));   // measured = expected · offset⁻¹
  const solved = solveOrientationOffset([qMeas, qMeas, qMeas], rotY180);
  const residual = qAngleDeg(qMul(qMul(qMeas, eulerYXZToQuat(solved)), qConj(rotY180)));
  check(`left-paired solve residual ${residual.toFixed(2)}° < 0.01`, residual < 0.01);
  check(`left-paired solve is small (roll ${solved.rollDeg.toFixed(1)}°), not ~180°`, Math.abs(solved.rollDeg) < 135);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
