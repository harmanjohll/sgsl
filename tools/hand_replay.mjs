#!/usr/bin/env node
/* ============================================================
   SgSL — Hand-orientation replay / diagnostic harness
   ============================================================
   Lives OUTSIDE sgsl-app/ (never served). Committed so it
   survives container resets (the old /tmp harness did not).

   Purpose: feed REAL recorded world-hand landmarks through a
   faithful, pure-JS port of retarget.js `_driveHand`'s palm-
   facing math, so we can SEE — without a webcam or headless GL
   — exactly why a wrist "rotates weirdly", per side.

   The suspected bug: the winding→facing map uses a single GLOBAL
   WIND_SIGN that was tuned on one hand. If a side's WIND_SIGN is
   wrong, the override negates the palm normal on (almost) every
   non-edge-on frame — i.e. it constantly fights the geometry.
   So the headline metric here is the per-side OVERRIDE-FIRE rate:
   low = healthy, high = that side's sign is wrong.

   Usage:
     node tools/hand_replay.mjs <hand-dump.json | exported-sign.json> [--every N]

   Accepts either:
     - a hand dump:   {kind:"sgsl-hand-dump", frames:[{rW,lW,raw}]}
     - an exported sign: {frames:[{leftHandWorld,rightHandWorld,...}]}

   Output is labelled by the retarget `side` argument ("Left"/
   "Right" as passed to _driveHand), so findings map straight onto
   the fix.
   ============================================================ */

import { readFileSync } from 'node:fs';

// ── Constants — kept byte-for-byte in step with retarget.js ──
// retarget.js:66  HAND_WX/WY/WZ ; :70 HAND_DET ; :87-92 WIND_SIGN/WIND_THRESH
const HAND_W = [-1, -1, -1];   // HAND_WX, HAND_WY, HAND_WZ
const HAND_DET = -1;
// Per-side, mirroring retarget.js. BOTH sides want -1 — pinned by handdump_4/5
// (side "Right") and handdump_6–9 (side "Left", 339 non-edge-on frames: 0%
// agreement at +1, ~100% at -1). A wrong sign shows up here as a ~90%
// override-fire rate / ~0% agreement (see the verdict logic).
const WIND_SIGN = { Left: -1, Right: -1 };
const WIND_THRESH = 0.3;

// ── tiny vec3 helpers (landmarks are [x,y,z] arrays) ──
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// Map a raw landmark i into avatar space exactly like retarget V(i).
const V = (pts, i) => [pts[i][0] * HAND_W[0], pts[i][1] * HAND_W[1], pts[i][2] * HAND_W[2]];

// ── Faithful port of the _driveHand ORIENTATION decision ──
// We deliberately omit the WRIST_STRAIGHTEN blend (it needs the live IK'd
// forearm, unavailable offline). It only tilts fingerDir toward the forearm;
// it does not touch the winding or the desired-facing sign, which is what we
// are diagnosing. palmNormal here uses the raw fingerDir — the same z-sign the
// override tests.
function orient(pts, state, windSign) {
  const wrist = V(pts, 0);
  const fingerDir = norm(sub(V(pts, 9), wrist));
  const across = sub(V(pts, 17), V(pts, 5));
  let palmNormal = norm(scl(cross(fingerDir, across), HAND_DET));
  const palmZraw = palmNormal[2];

  // winding (2D signed area of index/pinky MCP about the wrist) — depth-stable
  const a = sub(V(pts, 5), wrist), b = sub(V(pts, 17), wrist);
  const windRaw = a[0] * b[1] - a[1] * b[0];
  const wind = windRaw / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]) + 1e-9);

  // temporal hold of the facing sign (per side) — retarget.js:293-294
  if (Math.abs(wind) > WIND_THRESH) state.facing = sgn(wind) * windSign;
  const desired = state.facing;

  // the override — negate palm normal when its z-sign disagrees with `desired`
  let negated = false;
  if (desired !== 0 && sgn(palmZraw || 0) !== desired) { palmNormal = scl(palmNormal, -1); negated = true; }

  return { fingerDir, palmNormal, palmZraw, wind, desired, negated,
           edgeOn: Math.abs(wind) <= WIND_THRESH };
}

// ── Loaders → per-frame { t, Left, Right } in retarget side convention ──
// retarget 'Left'  <- results.right  <- dump.rW / export.rightHandWorld / raw camera-'Right'
// retarget 'Right' <- results.left   <- dump.lW / export.leftHandWorld  / raw camera-'Left'
function loadFrames(json) {
  const out = [];
  const fr = json.frames || [];
  const isDump = json.kind === 'sgsl-hand-dump' || (fr[0] && ('rW' in fr[0] || 'lW' in fr[0] || 'raw' in fr[0]));
  for (const f of fr) {
    let Left = null, Right = null;
    if (isDump) {
      const rawRight = f.raw && f.raw.find(r => r.side === 'Right');
      const rawLeft = f.raw && f.raw.find(r => r.side === 'Left');
      Left = f.rW || (rawRight && rawRight.w) || null;
      Right = f.lW || (rawLeft && rawLeft.w) || null;
    } else {
      Left = f.rightHandWorld || null;
      Right = f.leftHandWorld || null;
    }
    out.push({ t: f.t ?? 0, Left, Right });
  }
  return out;
}

function analyzeSide(frames, side) {
  const state = { facing: 0 };
  const windSign = WIND_SIGN[side] ?? 1;
  const rows = [];
  let nData = 0, nNeg = 0, nEdge = 0, nAgree = 0, nMeasured = 0;
  let prevRoll = null, maxJump = 0, flips = 0, prevPalmZsign = 0;
  for (const fr of frames) {
    const pts = fr[side];
    if (!pts || pts.length < 18) { rows.push(null); continue; }
    nData++;
    const r = orient(pts, state, windSign);
    // agreement of the *raw* palm z-sign with the winding-desired sign,
    // measured only where the hand isn't edge-on (winding is meaningful)
    if (!r.edgeOn) {
      nMeasured++;
      if (sgn(r.palmZraw) === sgn(r.wind) * windSign) nAgree++;
    }
    if (r.negated) nNeg++;
    if (r.edgeOn) nEdge++;
    // continuity of the corrected palm normal (snap detection)
    const roll = Math.atan2(r.palmNormal[1], r.palmNormal[2]) * 180 / Math.PI;
    if (prevRoll !== null) {
      let d = Math.abs(roll - prevRoll); if (d > 180) d = 360 - d;
      maxJump = Math.max(maxJump, d);
    }
    prevRoll = roll;
    const pzs = sgn(r.palmNormal[2]);
    if (prevPalmZsign && pzs && pzs !== prevPalmZsign) flips++;
    if (pzs) prevPalmZsign = pzs;
    rows.push({ t: fr.t, ...r, roll });
  }
  return { side, windSign, nData, nNeg, nEdge, nAgree, nMeasured, maxJump, flips, rows };
}

function pct(n, d) { return d ? (100 * n / d).toFixed(0) + '%' : '—'; }

function report(side, a) {
  if (!a.nData) { console.log(`\n### ${side}: no data in this file.`); return; }
  console.log(`\n### retarget side "${side}"  (${a.nData} frames with this hand)`);
  console.log(`  override fired (palm negated):   ${a.nNeg}/${a.nData}  (${pct(a.nNeg, a.nData)})`);
  console.log(`  edge-on (winding < ${WIND_THRESH}, ignored): ${a.nEdge}/${a.nData}  (${pct(a.nEdge, a.nData)})`);
  console.log(`  raw palmZ agrees w/ winding*WIND_SIGN: ${a.nAgree}/${a.nMeasured}  (${pct(a.nAgree, a.nMeasured)})  [non-edge-on frames]`);
  console.log(`  corrected palmZ sign-flips frame→frame: ${a.flips}   max roll jump: ${a.maxJump.toFixed(0)}°`);
  // verdict
  const fireRate = a.nData ? a.nNeg / a.nData : 0;
  const agree = a.nMeasured ? a.nAgree / a.nMeasured : 1;
  let verdict;
  if (a.nMeasured < 5) verdict = 'inconclusive (too few non-edge-on frames — wave the palm more)';
  else if (agree >= 0.7 && fireRate <= 0.3) verdict = `HEALTHY — WIND_SIGN ${a.windSign} suits this side.`;
  else if (agree <= 0.3) verdict = `SUSPECT — raw geometry systematically DISAGREES with winding*${a.windSign}; this side likely needs WIND_SIGN = ${-a.windSign}.`;
  else verdict = 'mixed — palm facing is unstable here (depth flips); inspect samples below.';
  console.log(`  → ${verdict}`);
  // a few samples spread across the clip
  const present = a.rows.filter(Boolean);
  const step = Math.max(1, Math.floor(present.length / 8));
  console.log('    t(ms)   wind   palmZraw  desired neg edge  roll°');
  for (let i = 0; i < present.length; i += step) {
    const r = present[i];
    console.log(`    ${String(r.t).padStart(6)}  ${r.wind.toFixed(2).padStart(5)}  ${r.palmZraw.toFixed(2).padStart(7)}   ${String(r.desired).padStart(3)}   ${r.negated ? 'Y' : '·'}   ${r.edgeOn ? 'Y' : '·'}  ${r.roll.toFixed(0).padStart(5)}`);
  }
}

// ── Digit direct-aim geometry check ──────────────────────────────
// Validates the thumb-fix premise on REAL data: when the thumb curls it should
// sweep ACROSS the palm (toward the fingers) and stay roughly IN the palm plane —
// which DIRECT HAND-LOCAL AIM (retarget.js _driveHand) reproduces, but the old
// cross(thumbDir, palmNormal) flex axis did not (it lifts the thumb out of the
// plane → it juts out). Also prints each digit's curl range so we can see the
// fingers actually move through open→closed on the clip.
const deg = (r) => r * 180 / Math.PI;
function jointAngle(pts, a, b, c) {
  const u = sub(V(pts, b), V(pts, a)), v = sub(V(pts, c), V(pts, b));
  if (len(u) < 1e-9 || len(v) < 1e-9) return 0;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(norm(u), norm(v))))));
}
const FSEG = { Thumb:[0,1,2,3,4], Index:[0,5,6,7,8], Middle:[0,9,10,11,12], Ring:[0,13,14,15,16], Little:[0,17,18,19,20] };
function digitReport(frames, side) {
  const present = frames.map(f => f[side]).filter(p => p && p.length >= 21);
  if (present.length < 5) { console.log(`\n### digits "${side}": too few frames.`); return; }
  let nDegen = 0; const curled = [];
  for (const pts of present) {
    const wrist = V(pts, 0);
    const f = norm(sub(V(pts, 9), wrist));
    const n = norm(scl(cross(f, sub(V(pts, 17), V(pts, 5))), HAND_DET));
    const xRaw = cross(f, n);
    if (len(xRaw) < 1e-6) { nDegen++; continue; }   // degenerate hand frame
    const Xm = norm(xRaw), Zm = norm(cross(Xm, f));
    const td = norm(sub(V(pts, 4), V(pts, 2)));      // thumb overall dir (MCP→tip)
    const across = Math.abs(dot(td, Xm)), nrm = Math.abs(dot(td, Zm));
    const ip = jointAngle(pts, 2, 3, 4);             // thumb IP curl
    if (ip > 30) curled.push({ across, nrm, oop: deg(Math.asin(Math.min(1, nrm))) });
  }
  const mean = (a, k) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : 0;
  console.log(`\n### digits "${side}"  (${present.length} frames, ${nDegen} degenerate, ${curled.length} curled-thumb frames IP>30°)`);
  if (curled.length >= 3) {
    const ax = mean(curled, 'across'), no = mean(curled, 'nrm'), oop = mean(curled, 'oop');
    const pass = oop < 35 && ax > no;
    console.log(`  curled thumb: |across-palm|=${ax.toFixed(2)}  |out-of-palm|=${no.toFixed(2)}  mean tilt off palm plane=${oop.toFixed(0)}°`);
    console.log(`  → ${pass ? 'PASS — thumb folds ACROSS the palm & stays in-plane (direct aim reproduces this; old axis did not).'
                            : 'CHECK — thumb leaves the palm plane on these frames (could be a thumbs-up clip rather than a grip).'}`);
  } else {
    console.log('  (no strongly-curled thumb frames — a fist/grip clip would exercise the fold.)');
  }
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    const k = FSEG[f];
    const tot = present.map(p => jointAngle(p,k[0],k[1],k[2]) + jointAngle(p,k[1],k[2],k[3]) + jointAngle(p,k[2],k[3],k[4]));
    console.log(`  ${f.padEnd(6)} total curl  min ${Math.min(...tot).toFixed(0).padStart(3)}°  max ${Math.max(...tot).toFixed(0).padStart(3)}°`);
  }
}

// ── main ──
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const file = args[0];
if (!file) {
  console.error('usage: node tools/hand_replay.mjs <hand-dump.json | exported-sign.json> [--every N]');
  process.exit(1);
}
const json = JSON.parse(readFileSync(file, 'utf8'));
const frames = loadFrames(json);
const withAny = frames.filter(f => f.Left || f.Right).length;
console.log(`Loaded ${frames.length} frames from ${file} — ${withAny} with a hand.`);
if (!withAny) {
  console.log('\n⚠ This capture has NO hand landmarks in any frame. Nothing to analyse.');
  console.log('  Re-capture with a 3D hand actually tracked (avatar mirroring, overlay "world R/L: y").');
  process.exit(0);
}
report('Left', analyzeSide(frames, 'Left'));
report('Right', analyzeSide(frames, 'Right'));
digitReport(frames, 'Left');
digitReport(frames, 'Right');
console.log('\nNote: WRIST_STRAIGHTEN is intentionally not modelled here (needs the live');
console.log('IK forearm); it does not affect the winding/desired-facing decision above.');
