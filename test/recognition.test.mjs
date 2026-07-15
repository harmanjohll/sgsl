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

// 13) hand-only (v1) reference: no pose, no calibration — must still score on handshape.
//     This is the shipped base set's format; before the loc-fallback these all F'd out
//     with "No hands were clearly visible" and the Test tab had zero testable signs.
{
  const stripPose = (frames) => frames.map(f => ({ ...f, pose: null }));
  const handOnlyRef = stripPose(ref.frames);
  const good = scoreAttempt(ref.frames, ref.calib, handOnlyRef, null);
  check('hand-only reference: same handshape passes', good.pass === true && good.score >= 70, `(score ${good.score})`);
  const fist = makeSign({ shape: 'fist', path: 'wave' });
  const bad = scoreAttempt(fist.frames, fist.calib, handOnlyRef, null);
  check('hand-only reference: wrong handshape scores lower', bad.score < good.score - 10, `(bad ${bad.score} vs good ${good.score})`);
  // and a hand-only ATTEMPT against a hand-only reference (both sides no body frame)
  const both = scoreAttempt(stripPose(ref.frames), null, handOnlyRef, null);
  check('hand-only vs hand-only: identical passes', both.pass === true, `(score ${both.score})`);
}

// 14) wrist-tilt invariance: the same handshape held at a tilted wrist angle is the
//     SAME sign (rotation-normalized shape). Before: 10° of tilt scored like a
//     different sign entirely.
{
  const rot = (hand, deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), [wx, wy] = hand[0];
    return hand.map(p => [wx + (p[0] - wx) * c - (p[1] - wy) * s, wy + (p[0] - wx) * s + (p[1] - wy) * c, 0]);
  };
  const tilted = ref.frames.map(f => ({ ...f, rightHand: rot(f.rightHand, 14) }));
  const r = scoreAttempt(tilted, ref.calib, ref.frames, ref.calib);
  check('14° wrist tilt still passes high', r.pass === true && r.score >= 85, `(score ${r.score})`);
  const fist = makeSign({ shape: 'fist', path: 'wave' });
  const diff = scoreAttempt(fist.frames, fist.calib, ref.frames, ref.calib).score;
  check('tilt tolerance keeps shapes separable', diff < r.score - 15, `(diff ${diff} vs tilted ${r.score})`);
}
// 15) mirrored performance (left-handed signer) passes and is flagged
{
  const mirrored = ref.frames.map(f => ({
    ...f,
    rightHand: null,
    leftHand: f.rightHand.map(p => [1 - p[0], p[1], 0]),
    pose: f.pose.map((p, i) => {
      const q = [1 - p[0], p[1], p[2], p[3]];
      return q;
    }).map((p, i, arr) => i === 15 ? arr[16] : i === 16 ? arr[15] : i === 11 ? arr[12] : i === 12 ? arr[11] : p),
  }));
  const calibM = { shoulderMid: [1 - ref.calib.shoulderMid[0], ref.calib.shoulderMid[1]], shoulderWidth: ref.calib.shoulderWidth };
  const r = scoreAttempt(mirrored, calibM, ref.frames, ref.calib);
  check('mirrored (left-handed) attempt passes', r.pass === true && r.score >= 85, `(score ${r.score})`);
  check('mirrored attempt is flagged', r.mirrored === true);
}
// 16) transition frames (raising the hand in, dropping it after) cost nothing
{
  const rest = (n) => Array.from({ length: n }, (_, i) => {
    const u = i / n;
    return { t: 0, rightHand: hand(0.5, 0.85 - u * 0.3, 'flat'), leftHand: null, pose: pose(0.5, 0.85 - u * 0.3, 0.5, 0.3) };
  });
  const padded = [...rest(10), ...ref.frames, ...rest(10).reverse()];
  const r = scoreAttempt(padded, ref.calib, ref.frames, ref.calib);
  check('lead-in/lead-out transitions are free', r.pass === true && r.score >= 85, `(score ${r.score})`);
}
// 17) a template hand present in only a few frames is tracker noise, not the sign —
//     it must not fine the attempt (shipped one.json had 5 stray leftHand frames of 28).
{
  const glitchy = ref.frames.map((f, i) => i % 6 === 0 ? { ...f, leftHand: hand(0.3, 0.7, 'flat') } : f);
  const r = scoreAttempt(ref.frames, ref.calib, glitchy, ref.calib);
  check('rare glitch hand in template is ignored', r.pass === true && r.score >= 90, `(score ${r.score})`);
}
// 18) feedback comes from the alignment path only: a perfect match must not complain
{
  const r = scoreAttempt(ref.frames, ref.calib, ref.frames, ref.calib);
  const spurious = r.feedback.some(f => f.includes('missing') || f.includes('drifted') || f.includes('off'));
  check('perfect match gets no spurious complaints', !spurious, `(feedback: ${r.feedback.join(' | ')})`);
}
// 19) orientation forgiveness is BOUNDED: a small tilt is free (test 14), but a hand
//     pointing the wrong way is a different sign — 90°/180° must fail, not score 100.
{
  const rot = (hand, deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), [wx, wy] = hand[0];
    return hand.map(p => [wx + (p[0] - wx) * c - (p[1] - wy) * s, wy + (p[0] - wx) * s + (p[1] - wy) * c, 0]);
  };
  const at = (deg) => scoreAttempt(ref.frames.map(f => ({ ...f, rightHand: rot(f.rightHand, deg) })), ref.calib, ref.frames, ref.calib);
  const r90 = at(90), r180 = at(180);
  check('90° rotated hand fails', r90.pass === false, `(score ${r90.score})`);
  check('180° (fingers-down) hand fails', r180.pass === false, `(score ${r180.score})`);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
