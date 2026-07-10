/* Per-sign edit overlay: pure applyEdits math. Run: node test/signedits.test.mjs */
import { applyEdits } from '../sgsl-app/js/sign-edits.js';

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`ok   ${n}`); } else { failed++; console.log(`FAIL ${n}`); } };

const rec = (n = 30, dt = 100) => ({ label: 'x', landmarks: Array.from({ length: n }, (_, i) => ({ t: i * dt, pose: [[0.5, 0.5, 0, 1]] })) });

{ const r = applyEdits(rec(), null); check('no edits -> same record', r === rec() || r.landmarks.length === 30); }
{
  const raw = rec();
  const r = applyEdits(raw, { trimStartMs: 500, trimEndMs: 400 });
  check('trim drops both ends', r.landmarks.length === 30 - 5 - 4);
  check('trim re-bases t to 0', r.landmarks[0].t === 0);
  check('raw untouched (non-destructive)', raw.landmarks.length === 30 && raw.landmarks[0].t === 0 && raw.landmarks[5].t === 500);
}
{
  const r = applyEdits(rec(), { speed: 2 });
  check('speed 2x halves duration', r.landmarks[r.landmarks.length - 1].t === 2900 / 2);
}
{
  const r = applyEdits(rec(), { speed: 9 });
  check('speed clamped to 2x', r.landmarks[r.landmarks.length - 1].t === 2900 / 2);
}
{
  const r = applyEdits(rec(6), { trimStartMs: 400, trimEndMs: 400 });
  check('refuses to gut below 5 frames', r.landmarks.length === 6);
}
{
  const r = applyEdits(rec(), { trimStartMs: 250 });   // between samples
  check('trim between samples keeps next frame', r.landmarks.length === 27 && r.landmarks[0].t === 0);
}
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
