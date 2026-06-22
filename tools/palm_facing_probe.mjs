#!/usr/bin/env node
// ============================================================================
// palm_facing_probe.mjs — OFFLINE numeric check for PALM FACING (no deps).
//
// Why this exists: hand_fk_preview.mjs has numeric checks for chirality and
// wrist twist, but NONE for palm FACING — the open issue where the HUD reads
// face:0.2–0.4 for a palm-to-camera hand that should read ~0.9. The methodology
// is "pin with numeric checks, not paper reasoning", so this reproduces the
// EXACT retarget.js palmNormal math (V-map + HAND_DET + winding override) and
// reports `face` (= palmNormal.z, the HUD value) next to candidate, noise-robust
// palm normals — on synthetic hands (to quantify the failure mode) and on real
// v3 hand dumps (to confirm the fix on YOUR capture before any deploy).
//
// Pure JS, no three / no VRM: `face` is derived entirely from the 21 hand
// landmarks, independent of the avatar rig, so this is faithful to the HUD.
//
// Usage:
//   node tools/palm_facing_probe.mjs --synth            # synthetic diagnosis
//   node tools/palm_facing_probe.mjs <dump.json> [Left|Right] [--csv]
// (Side only selects WIND_SIGN, which is -1 for both, so facing magnitude is
//  side-independent; pass a side just to mirror the live convention.)
// ============================================================================

// ── retarget.js constants (kept in sync by hand) ──
const HAND_W = [-1, -1, -1];
const HAND_DET = HAND_W[0] * HAND_W[1] * HAND_W[2];   // -1
const WIND_SIGN = { Left: -1, Right: -1 };
const WIND_THRESH = 0.3;

// ── tiny vec3 helpers (avoid a three dependency) ──
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1e-9; return [a[0]/l, a[1]/l, a[2]/l]; };
const deg = (r) => r * 180 / Math.PI;
const angBetween = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))));

// V(): retarget.js maps MP-world → avatar space by negating every axis.
const V = (pts, i) => [pts[i][0]*HAND_W[0], pts[i][1]*HAND_W[1], pts[i][2]*HAND_W[2]];

// Winding override sign (retarget.js). Stateless: returns 0 in the edge-on dead zone
// (|wind|<=thresh) so the raw 3D normal is trusted there — matching the FIXED live logic
// that only applies the palm-vs-back sign correction when the winding is confident.
// Returns desired facing ∈ {-1,0,+1}.
function windingFacing(pts, side) {
  const w = V(pts, 0), a = sub(V(pts, 5), w), b = sub(V(pts, 17), w);
  const windRaw = a[0]*b[1] - a[1]*b[0];
  const wind = windRaw / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]) + 1e-9);
  const facing = Math.abs(wind) > WIND_THRESH ? Math.sign(wind) * WIND_SIGN[side] : 0;
  return { wind, facing };
}

// CURRENT retarget.js palm normal (lines 322-335): cross(fingerDir, V17-V5)·HAND_DET,
// then the winding override only FLIPS THE SIGN (never the magnitude).
function palmNormalNow(pts, side) {
  const wrist = V(pts, 0);
  const fingerDir = norm(sub(V(pts, 9), wrist));
  let pn = norm(scale(cross(fingerDir, sub(V(pts, 17), V(pts, 5))), HAND_DET));
  const { facing } = windingFacing(pts, side);
  if (facing !== 0 && Math.sign(pn[2] || 0) !== facing) pn = scale(pn, -1);
  return { pn, fingerDir };
}

// CANDIDATE: noise-robust palm normal via Newell's method over the palm polygon
// [wrist, indexMCP, middleMCP, ringMCP, pinkyMCP]. Newell averages every edge, so
// per-landmark z-noise is suppressed (vs the current 2-vector cross, which rides
// entirely on the z-noise of points 0,9,5,17). Same HAND_DET + winding sign fix.
function palmNormalNewell(pts, side) {
  const ring = [0, 5, 9, 13, 17].map(i => V(pts, i));
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i], n = ring[(i + 1) % ring.length];
    nx += (c[1] - n[1]) * (c[2] + n[2]);
    ny += (c[2] - n[2]) * (c[0] + n[0]);
    nz += (c[0] - n[0]) * (c[1] + n[1]);
  }
  let pn = norm(scale([nx, ny, nz], HAND_DET));
  const { facing } = windingFacing(pts, side);
  if (facing !== 0 && Math.sign(pn[2] || 0) !== facing) pn = scale(pn, -1);
  return pn;
}

// MP world-z sanity: how big is the palm's z spread vs its x/y spread? Isotropic
// metric data → ~1. ≪1 means MP flattened z (would HELP facing); ≫1 means z is
// inflated/biased (the prime suspect for the field under-rotation). z-free.
function zScaleRatio(pts) {
  const idx = [0, 5, 9, 13, 17];
  const spread = (k) => { const v = idx.map(i => V(pts, i)[k]); return Math.max(...v) - Math.min(...v); };
  const xy = Math.hypot(spread(0), spread(1)) || 1e-9;
  return spread(2) / xy;
}

function analyze(pts, side) {
  const { pn, fingerDir } = palmNormalNow(pts, side);
  const newell = palmNormalNewell(pts, side);
  const { wind } = windingFacing(pts, side);
  return {
    faceNow: pn[2],            // = the HUD `face` value
    faceNewell: newell[2],
    fingerTiltZ: fingerDir[2], // how far wrist→midMCP leans out of the image plane
    zScale: zScaleRatio(pts),  // palm z-spread / xy-spread (≫1 ⇒ inflated z)
    wind,
    nowVsNewellDeg: angBetween(pn, newell),
  };
}

// ── synthetic hand: flat palm in avatar space (y up, z toward camera, MCP plane
//    at z=0), rotated to a known facing, with optional wrist dive + per-axis z
//    noise. Built in avatar space then negated to MP-world (MP = -avatar), so the
//    probe's V() reconstructs avatar space exactly. Ground-truth facing is known. ─
const BASE = {            // avatar-space landmarks (only the palm pts that matter)
  0:  [ 0.000, -0.090, 0],  // wrist (y below the knuckles)
  5:  [ 0.035,  0.005, 0],  // index MCP
  9:  [ 0.005,  0.010, 0],  // middle MCP
  13: [-0.022,  0.006, 0],  // ring MCP
  17: [-0.045, -0.004, 0],  // pinky MCP
};
function rotX(p, t){ const c=Math.cos(t),s=Math.sin(t); return [p[0], c*p[1]-s*p[2], s*p[1]+c*p[2]]; }
function rotY(p, t){ const c=Math.cos(t),s=Math.sin(t); return [c*p[0]+s*p[2], p[1], -s*p[0]+c*p[2]]; }
// seeded RNG (mulberry32) so synthetic noise is reproducible.
function rng(seed){ return () => { seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function gauss(r){ return Math.sqrt(-2*Math.log(r()+1e-12))*Math.cos(2*Math.PI*r()); }

function synthHand({ tiltDeg=0, yawDeg=0, wristDive=0, zNoise=0, seed=1 }) {
  const r = rng(seed);
  const pts = {};
  for (const k of [0,5,9,13,17]) {
    let p = BASE[k].slice();
    if (k === 0) p = [p[0], p[1], p[2] - wristDive];       // wrist leans away from camera
    p = rotX(p, tiltDeg*Math.PI/180);
    p = rotY(p, yawDeg*Math.PI/180);
    if (zNoise > 0) p = [p[0], p[1], p[2] + gauss(r)*zNoise];
    pts[k] = scale(p, -1);                                  // avatar → MP-world
  }
  // fill the rest with the wrist so V() never sees holes (unused by facing math)
  const out = []; for (let i = 0; i < 21; i++) out[i] = pts[i] || pts[0];
  // ground-truth facing: the true palm normal is avatar +z, rotated the same way.
  let trueN = rotX([0,0,1], tiltDeg*Math.PI/180); trueN = rotY(trueN, yawDeg*Math.PI/180);
  return { pts: out, trueFacing: trueN[2] };
}

function fmt(x, w=6){ return (x>=0?' ':'') + x.toFixed(2).padStart(w-1); }

function runSynth() {
  console.log('PALM-FACING SYNTHETIC PROBE (face = palmNormal.z = the live HUD value)\n');

  console.log('A) Clean geometry, palm-to-camera, swept TILT (no noise, no wrist dive):');
  console.log('   tilt°  trueFace  faceNow  faceNewell   (face should ≈ trueFace = cos tilt)');
  for (const tilt of [0, 15, 30, 45, 60]) {
    const h = synthHand({ tiltDeg: tilt });
    const m = analyze(h.pts, 'Right');
    console.log(`   ${String(tilt).padStart(4)}   ${fmt(h.trueFacing)}   ${fmt(m.faceNow)}     ${fmt(m.faceNewell)}`);
  }

  console.log('\nB) Palm-to-camera + WRIST DIVE (wrist leans away; tilts fingerDir out of plane):');
  console.log('   dive   fingerTiltZ  faceNow  faceNewell');
  for (const wd of [0, 0.02, 0.04, 0.06, 0.09]) {
    const h = synthHand({ wristDive: wd });
    const m = analyze(h.pts, 'Right');
    console.log(`   ${wd.toFixed(2)}   ${fmt(m.fingerTiltZ)}      ${fmt(m.faceNow)}     ${fmt(m.faceNewell)}`);
  }

  console.log('\nC) Palm-to-camera + MP WORLD-Z NOISE (the suspected field cause).');
  console.log('   200 trials per row; reports mean and WORST(min) |face| over trials:');
  console.log('   zNoise(m)  faceNow_mean  faceNow_min  faceNewell_mean  faceNewell_min');
  for (const zn of [0, 0.005, 0.010, 0.020, 0.030]) {
    let sN=0, mnN=9, sW=0, mnW=9;
    for (let t = 0; t < 200; t++) {
      const h = synthHand({ zNoise: zn, seed: t + 1 });
      const m = analyze(h.pts, 'Right');
      const aN = Math.abs(m.faceNow), aW = Math.abs(m.faceNewell);
      sN += aN; mnN = Math.min(mnN, aN); sW += aW; mnW = Math.min(mnW, aW);
    }
    console.log(`   ${zn.toFixed(3)}      ${fmt(sN/200)}       ${fmt(mnN)}      ${fmt(sW/200)}        ${fmt(mnW)}`);
  }
  console.log('\nReading: face≈1.0 = palm squarely at camera. If row C shows faceNow collapsing');
  console.log('toward ~0.2–0.4 as z-noise grows while faceNewell holds high, the field under-');
  console.log('rotation is MP world-z noise on the 4 points the 2-vector cross rides on, and the');
  console.log('Newell (whole-palm) normal is the fix. Confirm on a real dump before deploying.');
}

// ── real v3 dump (kind:'sgsl-hand-dump', version:3, frames:[{rW,lW,...}]) ──
import fs from 'fs';
function valid(p){ return p && p.length >= 21 && p.every(q => q && isFinite(q[0]) && isFinite(q[1]) && isFinite(q[2])); }

function runDump(path, side, csv) {
  const json = JSON.parse(fs.readFileSync(path, 'utf8'));
  const frames = json.frames || [];
  // rW = signer's RIGHT hand, lW = signer's LEFT (recorder.js enc order).
  const pick = side === 'Left' ? (f => f.lW) : (f => f.rW);
  const hands = frames.map(pick).filter(valid);
  const cs = json.calibrationSettings;
  console.log(`Dump: ${path}  version=${json.version}  frames=${frames.length}  valid ${side}-hand frames=${hands.length}`
    + (cs ? `  | calib roll:${cs.rollDeg}° smoothing:${Math.round((cs.smoothing || 0) * 100)}%` : '') + '\n');
  if (!hands.length) { console.log('No valid hands for that side. Try the other side.'); return; }

  if (csv) console.log('idx,wind,fingerTiltZ,zScale,faceNow,faceNewell,nowVsNewellDeg');
  let nFrontal = 0, sNowF = 0, sNewF = 0, sTilt = 0, sZ = 0;
  const hist = {}; // |faceNow| bucket → count, on near-frontal frames
  hands.forEach((pts, i) => {
    const m = analyze(pts, side);
    if (csv) console.log(`${i},${m.wind.toFixed(3)},${m.fingerTiltZ.toFixed(3)},${m.zScale.toFixed(3)},${m.faceNow.toFixed(3)},${m.faceNewell.toFixed(3)},${m.nowVsNewellDeg.toFixed(1)}`);
    // "near-frontal" = the winding strongly says palm-on (so face SHOULD be ~±1).
    if (Math.abs(m.wind) > 0.6) {
      nFrontal++; sNowF += Math.abs(m.faceNow); sNewF += Math.abs(m.faceNewell);
      sTilt += Math.abs(m.fingerTiltZ); sZ += m.zScale;
      const b = (Math.floor(Math.abs(m.faceNow) * 5) / 5).toFixed(1); hist[b] = (hist[b] || 0) + 1;
    }
  });
  console.log(`\nNear-frontal frames (|wind|>0.6, palm strongly toward/away camera): ${nFrontal}`);
  if (nFrontal) {
    console.log(`  mean |faceNow|    = ${(sNowF/nFrontal).toFixed(3)}   <- the live HUD facing (should be ~0.9+ if palm is frontal)`);
    console.log(`  mean |faceNewell| = ${(sNewF/nFrontal).toFixed(3)}   <- candidate whole-palm normal (does it recover?)`);
    console.log(`  mean |fingerTiltZ|= ${(sTilt/nFrontal).toFixed(3)}   <- wrist→midMCP out-of-plane lean`);
    console.log(`  mean zScale       = ${(sZ/nFrontal).toFixed(3)}   <- palm z-spread / xy-spread (≫1 ⇒ MP z inflated = prime suspect)`);
    console.log('  |faceNow| histogram (near-frontal):',
      Object.keys(hist).sort().map(k => `${k}:${hist[k]}`).join('  '));
    console.log('\n  Diagnosis guide:');
    console.log('   • faceNow low AND faceNewell low AND zScale≫1  → MP world-z is inflated/biased; the');
    console.log('     fix is to DOWN-WEIGHT z (rebuild facing from 2D foreshortening + winding), not Newell.');
    console.log('   • faceNow low but faceNewell≈0.9+               → the 2-point cross is noise-bound; swap to Newell.');
    console.log('   • faceNow≈faceNewell≈0.9+                       → facing is actually fine; the visible');
    console.log('     under-rotation is downstream (basis/forearm), look there instead.');
  }
}

// Write a synthetic v3 dump (smoke-tests the real-dump path; NOT a substitute for
// a real capture). Models the suspected field regime: frontal palm + inflated z.
function makeDump(path) {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const h = synthHand({ tiltDeg: (i % 20) - 10, zNoise: 0.02, seed: i + 1 });
    const rW = h.pts.map(p => [+p[0].toFixed(4), +p[1].toFixed(4), +(p[2] * 3).toFixed(4)]); // ×3 = inflated z
    frames.push({ t: i * 100, rW, lW: null, raw: [], arm: null });
  }
  fs.writeFileSync(path, JSON.stringify({ kind: 'sgsl-hand-dump', version: 3, interval_ms: 100, frames }));
  console.log(`Wrote synthetic dump ${path} (${frames.length} frames). NOT real data — smoke test only.`);
}

// ── main ──
const args = process.argv.slice(2);
if (args.includes('--make-dump')) {
  makeDump(args[args.indexOf('--make-dump') + 1] || '/tmp/synth_dump.json');
} else if (args.includes('--synth') || args.length === 0) {
  runSynth();
  if (args.length === 0) console.log('\n(Pass a dump path to analyze a real capture: node tools/palm_facing_probe.mjs <dump.json> [Left|Right] [--csv])');
} else {
  const path = args.find(a => !a.startsWith('--') && a !== 'Left' && a !== 'Right');
  const side = args.includes('Left') ? 'Left' : 'Right';
  runDump(path, side, args.includes('--csv'));
}
