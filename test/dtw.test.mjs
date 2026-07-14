/* DTW unit tests (pure). Run: node test/dtw.test.mjs */
import { dtw } from '../sgsl-app/js/dtw.js';

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`ok   ${n}`); } else { failed++; console.log(`FAIL ${n}`); } };

const abs = (x, y) => Math.abs(x - y);

// 1) identical sequences -> zero distance, diagonal path
{
  const s = [1, 2, 3, 4, 5];
  const r = dtw(s, s, abs);
  check('identical -> 0 distance', r.distance === 0);
  check('identical -> full diagonal path', r.path.length === 5 && r.path.every(([i, j]) => i === j));
}

// 2) time-warp invariance: same shape, one stretched -> small distance
{
  const base = [0, 1, 2, 3, 2, 1, 0];
  const slow = [0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0];   // each value doubled
  const r = dtw(base, slow, abs);
  check('time-warped copy -> zero cost', r.distance === 0);
  check('warp path spans both lengths', r.path.length >= slow.length);
}

// 3) different sequences -> larger normalized distance than a warp
{
  const base = [0, 1, 2, 3, 2, 1, 0];
  const slow = [0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 1, 1, 0, 0];
  const diff = [3, 2, 1, 0, 1, 2, 3];   // inverted shape
  const warp = dtw(base, slow, abs).normDistance;
  const cross = dtw(base, diff, abs).normDistance;
  check('different < warp ordering', cross > warp && cross > 0.5);
}

// 4) band still finds the optimal for a modest warp
{
  const a = Array.from({ length: 30 }, (_, i) => Math.sin(i / 3));
  const b = Array.from({ length: 45 }, (_, i) => Math.sin((i * 30 / 45) / 3));   // same signal resampled
  const r = dtw(a, b, abs, { band: 0.25 });
  check('resampled sine aligns tightly', r.normDistance < 0.05);
}

// 5) empty guard
{
  const r = dtw([], [1, 2], abs);
  check('empty sequence -> Infinity', r.distance === Infinity);
}

// 6) monotonic non-decreasing path indices
{
  const r = dtw([1, 3, 4, 9], [1, 2, 4, 8, 9], abs);
  let mono = true;
  for (let k = 1; k < r.path.length; k++) {
    const [pi, pj] = r.path[k - 1], [ci, cj] = r.path[k];
    if (ci < pi || cj < pj) mono = false;
  }
  check('path is monotonic', mono);
  check('path endpoints anchored', r.path[0][0] === 0 && r.path[0][1] === 0 &&
    r.path[r.path.length - 1][0] === 3 && r.path[r.path.length - 1][1] === 4);
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
