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
   ============================================================ */

const INF = Infinity;

export function dtw(a, b, costFn, { band = 0.2 } = {}) {
  const n = a.length, m = b.length;
  if (!n || !m) return { distance: INF, normDistance: INF, path: [] };

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
