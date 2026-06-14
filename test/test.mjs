/* ============================================================
   SgSL — Test Suite (node, no browser)
   ============================================================
   Covers the pure + integration logic that does not need a DOM/WebGL:
   interpolation, replay-fidelity metric, gloss parsing, token→label
   resolution, sentence concatenation, and the static signs-source.

   Run: node test/test.mjs
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { mjEval, lerpLM, lerpFrame } from '../sgsl-app/js/interp.js';
import { reconstructionError, frameError } from '../sgsl-app/js/metrics.js';
import { parseSentence } from '../sgsl-app/js/gloss.js';
import { resolveLabels, buildSentenceSequence } from '../sgsl-app/js/sentence-engine.js';
import * as signsSource from '../sgsl-app/js/signs-source.js';

// ─── Stub fetch -> read committed signs from disk ───────────
const SIGNS = new URL('../sgsl-app/signs/', import.meta.url);
global.fetch = async (url) => {
  const rel = String(url).replace(/^signs\//, '');
  try {
    const buf = await readFile(new URL(rel, SIGNS));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString()) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

// ─── Tiny harness ───────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];
function check(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ─── interp.js ──────────────────────────────────────────────
check('mjEval start', approx(mjEval(0, 10, 0), 0));
check('mjEval end', approx(mjEval(0, 10, 1), 10));
check('mjEval midpoint = 0.5', approx(mjEval(0, 10, 0.5), 5));
{
  const a = [[0, 0, 0]], b = [[1, 2, 3]];
  check('lerpLM t=0 ~ a', approx(lerpLM(a, b, 0)[0][0], 0));
  check('lerpLM t=1 ~ b', approx(lerpLM(a, b, 1)[0][1], 2));
  const fa = { rightHand: a, leftHand: null, pose: null, face: null, poseWorld: null };
  const fb = { rightHand: b, leftHand: null, pose: null, face: null, poseWorld: null };
  check('lerpFrame keeps channel shape', lerpFrame(fa, fb, 0.5).rightHand.length === 1);
}

// ─── metrics.js ─────────────────────────────────────────────
function synthSign(positionAt, n = 21) {
  // n frames, evenly spaced t, one rightHand point per frame.
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push({ t: i * 33, rightHand: [[positionAt(i), 0, 0]], leftHand: null, pose: null, face: null, poseWorld: null });
  }
  return { landmarks: frames, calibration: { shoulderWidth: 1 } };
}
{
  const linear = reconstructionError(synthSign(i => i * 0.01));        // constant velocity
  const jagged = reconstructionError(synthSign(i => (i % 2) * 0.2));    // alternating
  check('metrics: linear motion reconstructs near-perfectly', linear.overall <= 1);
  check('metrics: linear earns grade A', linear.grade === 'A');
  check('metrics: jagged motion errs more than linear', jagged.overall > linear.overall);
  check('metrics: too-few-frames -> note', reconstructionError({ landmarks: [{ t: 0 }] }).note === 'too few frames');
  check('frameError null channel -> null', frameError({ pose: null }, { pose: null }, 1).pose === null);
}

// ─── gloss.js ───────────────────────────────────────────────
{
  const t1 = parseSentence('thank you');
  check('gloss: phrase "thank you" stays one sign', t1.some(x => x.sign === 'thank you'));
  const t2 = parseSentence('the cat');
  check('gloss: drops article "the"', t2.every(x => x.sign !== 'the') && t2.some(x => x.sign === 'cat'));
  const t3 = parseSentence('what is your name?');
  check('gloss: question flag set', t3.length > 0 && t3.every(x => x.nmm === 'question'));
}

// ─── sentence-engine resolveLabels ──────────────────────────
{
  const labels = ['one', 'three', 'thank_you', 'i'];
  const r = resolveLabels(
    [{ sign: 'one' }, { sign: 'thank you' }, { sign: 'me' }, { sign: 'zzz' }],
    labels,
  );
  check('resolve: exact label', r[0].available && r[0].label === 'one');
  check('resolve: phrase -> underscore label', r[1].available && r[1].label === 'thank_you');
  check('resolve: synonym me -> i', r[2].available && r[2].label === 'i');
  check('resolve: unknown -> unavailable', r[3].available === false && r[3].label === null);
}

// ─── signs-source (static, stubbed fetch) ───────────────────
{
  const manifest = await signsSource.getManifest();
  check('signs-source: 8 library signs', manifest.length === 8);
  check('signs-source: tagged library', manifest.every(s => s.source === 'library'));
  const one = await signsSource.getSign('one');
  check('signs-source: getSign("one") has 28 frames', (one.landmarks || []).length === 28);
  let threw = false;
  try { await signsSource.getSign('does_not_exist'); } catch { threw = true; }
  check('signs-source: missing sign rejects', threw);
}

// ─── sentence-engine buildSentenceSequence (integration) ────
{
  const seq = await buildSentenceSequence(['one', 'three']);
  // 28 + 5-frame bridge + 73 = 106
  check('sentence: concatenated length = 106', seq.length === 106);
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i].t < seq[i - 1].t) mono = false;
  check('sentence: timestamps non-decreasing', mono);
  check('sentence: skips empty label list', (await buildSentenceSequence([])).length === 0);
}

// ─── Report ─────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail} checks).`);
if (fail) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('All checks passed.');
