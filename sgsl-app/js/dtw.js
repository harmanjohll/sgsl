/* ============================================================
   SgSL — Dynamic Time Warping (pure)
   ============================================================
   Aligns two sequences that may differ in speed/length — the core
   of sign→text scoring: a slow attempt and a fast reference of the
   SAME sign must align to a small distance, while a different sign
   stays far. Classic DP with a Sakoe-Chiba band (widened to cover
   the length difference) for O(n·band) cost.

   dtw(a, b, costFn, opts) — a,b are frame arrays; costFn(ai,bj)->=0.
   Returns { distance, normDistance, path } where normDistance is
   the accumulated cost divided by the warping-path length (so it is
   comparable across different sequence lengths).

   opts.openEnds — subsequence mode: `b` (the reference) must be fully
   consumed, but the match may start and end anywhere in `a` (the
   attempt), so lead-in/lead-out frames — raising the hand into the
   sign and dropping it after — cost nothing. No band (sequences are
   short; the window may sit anywhere in `a`, which a diagonal band
   would wrongly exclude).
   ============================================================ */

const INF = Infinity;

export function dtw(a, b, costFn, { band = 0.2, openEnds = false } = {}) {
  const n = a.length, m = b.length;
  if (!n || !m) return { distance: INF, normDistance: INF, path: [] };

  if (openEnds) return dtwOpenEnds(a, b, costFn);

  // Band radius in cells: a fraction of the longer sequence, never smaller
  // than the length gap (or one hand's frames could never reach the other's).
  const r = Math.max(Math.ceil(band * Math.max(n, m)), Math.abs(n - m) + 1);
  const ratio = m / n;

  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  D[0][0] = 0;

  for (let i = 1; i <= n; i++) {
    const center = Math.round((i - 1) * ratio) + 1;
    const lo = Math.max(1, center - r), hi = Math.min(m, center + r);
    for (let j = lo; j <= hi; j++) {
      const c = costFn(a[i - 1], b[j - 1]);
      const best = Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
      D[i][j] = c + (best === INF ? 0 : best);
    }
  }

  if (D[n][m] === INF) return { distance: INF, normDistance: INF, path: [] };

  // Backtrack for the path length (path-normalisation denominator) + alignment.
  const path = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    path.push([i - 1, j - 1]);
    const diag = D[i - 1][j - 1], up = D[i - 1][j], left = D[i][j - 1];
    if (diag <= up && diag <= left) { i--; j--; }
    else if (up <= left) { i--; }
    else { j--; }
  }
  path.reverse();

  return { distance: D[n][m], normDistance: D[n][m] / path.length, path };
}

/** Subsequence DTW: free start/end along `a`, `b` fully consumed. */
function dtwOpenEnds(a, b, costFn) {
  const n = a.length, m = b.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  for (let i = 0; i <= n; i++) D[i][0] = 0;   // the match may start at any attempt frame

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = costFn(a[i - 1], b[j - 1]);
      D[i][j] = c + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
    }
  }

  let end = 1;   // ...and end at whichever attempt frame completes b cheapest
  for (let i = 2; i <= n; i++) if (D[i][m] < D[end][m]) end = i;
  if (D[end][m] === INF) return { distance: INF, normDistance: INF, path: [] };

  const path = [];
  let i = end, j = m;
  while (j > 0) {
    path.push([i - 1, j - 1]);
    const diag = D[i - 1][j - 1], up = D[i - 1][j], left = D[i][j - 1];
    if (i > 1 && diag <= up && diag <= left) { i--; j--; }
    else if (i > 1 && up <= left) { i--; }
    else { j--; }
  }
  path.reverse();

  return { distance: D[end][m], normDistance: D[end][m] / path.length, path };
}
