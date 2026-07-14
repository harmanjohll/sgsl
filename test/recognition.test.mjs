/* Recognition invariances + ordering (pure, synthetic). Run: node test/recognition.test.mjs
   The load-bearing claims: SAME sign scores high regardless of framing/scale/speed;
   DIFFERENT sign scores low; the prompted-target verdict rejects a wrong sign. */
import { scoreAttempt, classify, verifyAgainstTarget, normalizeFrame } from '../sgsl-app/js/recognition.js';

let passed = 0, failed = 0;
const check = (n, c, extra = '') => { if (c) { passed++; console.log(`ok   ${n}`); } else { failed++; console.log(`FAIL ${n} ${extra}`); } };

// ── synthetic sign builder ──────────────────────────────────────────────────
// A sign = a right hand tracing a path with a handshape, over `nf` frames.
// handshape 'flat' vs 'fist' differ; path 'wave' vs 'chop' differ.
const CALIB = { shoulderMid: [0.5, 0.4], shoulderWidth: 0.30 };
function hand(cx, cy, shape, zoom = 1) {
  // 21 pts around (cx,cy); pt0 wrist, pt9 middle-MCP up. 'fist' pulls fingertips in.
  const pts = [];
  for (let i = 0; i < 21; i++) {
    const up = -0.06 * zoom * (Math.floor(i / 4) + 1) / 5;            // finger extension
    const curl = shape === 'fist' ? 0.7 : 0;
    const x = cx + (i % 4 - 1.5) * 0.02 * zoom;
    const y = cy + up * (1 - curl) + (i === 0 ? 0 : 0.01 * zoom);
    pts.push([x, y, 0]);
  }
  return pts;
}
function pose(wx, wy, midx, sw) {
  const p = Array.from({ length: 33 }, () => [0.5, 0.9, 0, 0.2]);
  p[11] = [midx + sw / 2, 0.40, 0, 0.95]; p[12] = [midx - sw / 2, 0.40, 0, 0.95];
  p[16] = [wx, wy, 0, 0.9];   // signer-right wrist
  return p;
}
// zoom uniformly scales EVERYTHING about the shoulder mid (a signer closer to the
// camera): hand offset-from-mid, hand size, and shoulderWidth all scale together —
// which is precisely what spatial normalization is invariant to.
function makeSign({ nf = 24, shape = 'flat', path = 'wave', shift = [0, 0], zoom = 1 } = {}) {
  const midx = 0.5 + shift[0], midy = 0.4 + shift[1], sw = 0.30 * zoom;
  const frames = [];
  for (let i = 0; i < nf; i++) {
    const u = i / (nf - 1);
    const px = -0.10 + (path === 'wave' ? 0.10 * Math.sin(u * Math.PI * 2) : 0.14 * u);
    const py = 0.05 + (path === 'wave' ? 0.02 * Math.cos(u * Math.PI * 2) : -0.12 * u);
    const cx = midx + px * zoom, cy = midy + py * zoom;
    frames.push({ t: i * 40, rightHand: hand(cx, cy, shape, zoom), leftHand: null, pose: pose(cx, cy, midx, sw) });
  }
  return { frames, calib: { shoulderMid: [midx, midy], shoulderWidth: sw } };
}
const timeWarp = (frames) => frames.flatMap(f => [f, { ...f }]);   // duplicate every frame (2x slower)

const ref = makeSign({ shape: 'flat', path: 'wave' });

// 1) identical → ~100
{
  const r = scoreAttempt(ref.frames, ref.calib, ref.frames, ref.calib);
  check('identical -> A grade', r.grade === 'A' && r.score >= 95, `(score ${r?.score})`);
}
// 2) speed invariance: 2x slower same sign → still high
{
  const slow = timeWarp(ref.frames);
  const r = scoreAttempt(slow, ref.calib, ref.frames, ref.calib);
  check('2x slower same sign -> passes high', r.score >= 85, `(score ${r.score})`);
}
// 3) translation invariance: whole sign shifted on screen → normalization cancels it
{
  const moved = makeSign({ shape: 'flat', path: 'wave', shift: [0.12, -0.08] });
  const r = scoreAttempt(moved.frames, moved.calib, ref.frames, ref.calib);
  check('translated sign -> still high', r.score >= 80, `(score ${r.score})`);
}
// 4) scale invariance: signer closer/bigger (scale + shoulderWidth up) → high
{
  const big = makeSign({ shape: 'flat', path: 'wave', zoom: 1.5 });
  const r = scoreAttempt(big.frames, big.calib, ref.frames, ref.calib);
  check('scaled signer -> still high', r.score >= 75, `(score ${r.score})`);
}
// 5) different handshape → clearly lower than a warp of the same sign
{
  const fist = makeSign({ shape: 'fist', path: 'wave' });
  const same = scoreAttempt(timeWarp(ref.frames), ref.calib, ref.frames, ref.calib).score;
  const diff = scoreAttempt(fist.frames, fist.calib, ref.frames, ref.calib).score;
  check('different handshape < same-sign', diff < same - 15 && diff < 70, `(diff ${diff} vs same ${same})`);
}
// 6) different trajectory → lower
{
  const chop = makeSign({ shape: 'flat', path: 'chop' });
  const r = scoreAttempt(chop.frames, chop.calib, ref.frames, ref.calib);
  check('different trajectory -> lower', r.score < 82, `(score ${r.score})`);
}
// 7) classify: nearest of a template set is the matching sign
{
  const templates = [
    { label: 'wave-flat', frames: ref.frames, calibration: ref.calib },
    { label: 'chop-flat', frames: makeSign({ shape: 'flat', path: 'chop' }).frames, calibration: CALIB },
    { label: 'wave-fist', frames: makeSign({ shape: 'fist', path: 'wave' }).frames, calibration: CALIB },
  ];
  const attempt = timeWarp(ref.frames);
  const { best } = classify(attempt, ref.calib, templates);
  check('classify picks the matching sign', best.label === 'wave-flat', `(got ${best?.label})`);
}
// 8) verifyAgainstTarget rejects a wrong performance for the prompted target
{
  const templates = [
    { label: 'wave-flat', frames: ref.frames, calibration: ref.calib },
    { label: 'wave-fist', frames: makeSign({ shape: 'fist', path: 'wave' }).frames, calibration: CALIB },
  ];
  const good = verifyAgainstTarget(timeWarp(ref.frames), ref.calib, 'wave-flat', templates);
  const wrong = verifyAgainstTarget(makeSign({ shape: 'fist', path: 'wave' }).frames, CALIB, 'wave-flat', templates);
  check('prompted target: good attempt passes', good.pass === true, `(score ${good.score})`);
  check('prompted target: wrong handshape fails', wrong.pass === false, `(score ${wrong.score}, nearest ${wrong.nearest})`);
}
// 9) normalizeFrame invariance (unit): translate raw landmarks + body → identical features
{
  const a = normalizeFrame(ref.frames[5], ref.calib);
  const moved = makeSign({ shape: 'flat', path: 'wave', shift: [0.2, 0.1] });
  const b = normalizeFrame(moved.frames[5], moved.calib);
  const d = Math.hypot(a.R.loc[0] - b.R.loc[0], a.R.loc[1] - b.R.loc[1]);
  check('normalized location is translation-invariant', d < 1e-9, `(d ${d})`);
}

// 10) all-hands-hidden attempt is rejected (not scored 100 on empty frames)
{
  const blank = Array.from({ length: 20 }, (_, i) => ({ t: i * 40, rightHand: null, leftHand: null,
    pose: Array.from({ length: 33 }, () => [0.5, 0.9, 0, 0.1]) }));   // shoulders low-visibility
  const r = scoreAttempt(blank, null, ref.frames, ref.calib);
  check('hands-hidden attempt rejected', r.pass === false && r.score === 0, `(score ${r.score})`);
}
// 11) co-nearest tie does not falsely reject the prompted target
{
  const templates = [
    { label: 'other', frames: makeSign({ shape: 'flat', path: 'wave' }).frames, calibration: CALIB },
    { label: 'target', frames: ref.frames, calibration: ref.calib },   // identical to 'other'
  ];
  // performing the target: 'other' is an identical template so scores tie; target must still pass
  const v = verifyAgainstTarget(ref.frames, ref.calib, 'target', templates);
  check('tie with identical template still passes target', v.pass === true, `(score ${v.score}, nearest ${v.nearest})`);
}

// 12) strictness knob: the same imperfect attempt scores easy >= normal >= strict (deviation
//     tolerance control), and omitting the level reproduces 'normal' exactly (backward compat).
{
  const chop = makeSign({ shape: 'flat', path: 'chop' });   // real, non-zero residual distance
  const easy = scoreAttempt(chop.frames, chop.calib, ref.frames, ref.calib, 'easy').score;
  const normal = scoreAttempt(chop.frames, chop.calib, ref.frames, ref.calib, 'normal').score;
  const strict = scoreAttempt(chop.frames, chop.calib, ref.frames, ref.calib, 'strict').score;
  check('strictness: easy >= normal >= strict', easy >= normal && normal >= strict && easy > strict, `(easy ${easy}, normal ${normal}, strict ${strict})`);
  const dflt = scoreAttempt(chop.frames, chop.calib, ref.frames, ref.calib).score;
  check('strictness: default === normal', dflt === normal, `(default ${dflt} vs normal ${normal})`);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
