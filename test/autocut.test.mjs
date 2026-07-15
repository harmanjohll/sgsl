/* Auto-cut segmenter unit tests — pure Node, no browser.
   Synthesizes recorded-frame sequences (the recorder.js extractFrame shape)
   and asserts the state machine stops at the right moments and trimFrames
   keeps the motion span. Run: node test/autocut.test.mjs */

import { AutoCut, trimFrames, frameEnergy } from '../sgsl-app/js/autocut.js';

let passed = 0, failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
};

// ── synthetic frame builders ────────────────────────────────────────────────
const DT = 33;   // ~30 fps
// A hand as 21 [x,y,z] points around a wrist position.
const hand = (x, y) => Array.from({ length: 21 }, (_, i) => [x + (i % 5) * 0.01, y + Math.floor(i / 5) * 0.01, 0]);
// pose: shoulders at y .40, wrists parameterized (y .78 = at sides/down, .45 = up signing)
const pose = (wristY) => {
  const p = Array.from({ length: 33 }, () => [0.5, 0.85, 0, 0.2]);
  p[11] = [0.58, 0.40, 0, 0.95]; p[12] = [0.42, 0.40, 0, 0.95];
  p[15] = [0.60, wristY, 0, 0.9]; p[16] = [0.40, wristY, 0, 0.9];
  return p;
};
// idle: hand nearly still (tiny sensor jitter), held DOWN at rest.
// (2nd arg is the seq() phase — ignored; jitter stays fixed.)
const idleFrame = (t, _phase) => ({
  t, rightHand: hand(0.40 + Math.sin(t) * 0.0015, 0.75), pose: pose(0.78),
});
// signing: hand moving in signing space (wrists up)
const signFrame = (t, phase) => ({
  t, rightHand: hand(0.40 + 0.08 * Math.sin(phase), 0.45 + 0.05 * Math.cos(phase)), pose: pose(0.45),
});
// hold: hand static but UP in signing space (a held handshape — part of the sign)
const holdFrame = (t) => ({ t, rightHand: hand(0.45, 0.45), pose: pose(0.45) });
// gone: no hands detected, at rest
const goneFrame = (t) => ({ t, pose: pose(0.78) });

const seq = (...parts) => {
  const frames = []; let t = 0;
  for (const [n, fn] of parts) for (let i = 0; i < n; i++) { frames.push(fn(t, i * 0.5)); t += DT; }
  return frames;
};

// ── 1. idle → sign → idle: stops during trailing idle after endHoldMs ──────
{
  const frames = seq([15, idleFrame], [40, signFrame], [40, idleFrame]);
  const ac = new AutoCut();
  let stopIdx = -1;
  for (let i = 0; i < frames.length; i++) {
    if (ac.update(frames[i]).shouldStop) { stopIdx = i; break; }
  }
  const idleStart = 55;   // trailing idle begins here
  check('stops after the sign ends', stopIdx > idleStart);
  check('stops within ~1.2s of idle onset', stopIdx > 0 && (frames[stopIdx].t - frames[idleStart].t) < 1200);
}

// ── 2. pure jittery idle: never stops before maxMs ──────────────────────────
{
  const frames = seq([300, idleFrame]);   // ~10 s of idle, never signed
  const ac = new AutoCut();
  let stopped = false;
  for (const f of frames) if (ac.update(f).shouldStop) { stopped = true; break; }
  check('never stops when no sign ever started', !stopped);
}

// ── 3. a HOLD inside the sign (static handshape UP) does not cut ────────────
{
  const frames = seq([10, idleFrame], [20, signFrame], [40, holdFrame], [20, signFrame], [40, idleFrame]);
  const ac = new AutoCut();
  let stopIdx = -1;
  for (let i = 0; i < frames.length; i++) if (ac.update(frames[i]).shouldStop) { stopIdx = i; break; }
  check('does not cut during a held handshape', stopIdx === -1 || stopIdx > 90);  // past the hold + 2nd motion
}

// ── 4. hands leaving the frame at the end also ends the sign ────────────────
{
  const frames = seq([10, idleFrame], [40, signFrame], [40, goneFrame]);
  const ac = new AutoCut();
  let stopIdx = -1;
  for (let i = 0; i < frames.length; i++) if (ac.update(frames[i]).shouldStop) { stopIdx = i; break; }
  check('stops when hands leave after signing', stopIdx > 50);
}

// ── 5. hard cap at maxMs ─────────────────────────────────────────────────────
{
  const frames = seq([700, signFrame]);   // ~23 s of continuous motion
  const ac = new AutoCut();
  let stopT = null;
  for (const f of frames) if (ac.update(f).shouldStop) { stopT = f.t; break; }
  check('hard-stops at maxMs', stopT != null && stopT >= 19900 && stopT <= 20100);
}

// ── 6. trimFrames keeps the motion span (+pad), drops idle, re-bases t ──────
{
  const frames = seq([30, idleFrame], [40, signFrame], [30, idleFrame]);
  const trimmed = trimFrames(frames);
  check('trim drops leading idle', trimmed.length < frames.length && trimmed.length >= 38);
  check('trim keeps the sign', trimmed.length <= 50);
  check('trim re-bases t to 0', trimmed[0].t === 0);
}

// ── 7. trim refuses to gut a tiny recording ──────────────────────────────────
{
  const frames = seq([4, idleFrame]);
  check('tiny recordings returned untouched', trimFrames(frames) === frames);
}

// ── 8. energy sanity ─────────────────────────────────────────────────────────
{
  const a = idleFrame(0), b = idleFrame(DT);
  const c = signFrame(0, 0), d = signFrame(DT, 0.5);
  check('idle energy below endThresh', frameEnergy(a, b) < 0.006);
  check('signing energy above startThresh', frameEnergy(c, d) > 0.012);
  check('no-hands energy is null', frameEnergy(goneFrame(0), goneFrame(DT)) === null);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
