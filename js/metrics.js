/* ============================================================
   SgSL — Replay Fidelity Metrics
   ============================================================
   Turns "does the replay look right?" into a number, so the accuracy
   loop converges instead of oscillating on vibes, and so CI can guard
   against a retarget tweak silently wrecking another sign.

   v1 metric (pure JS, no headless VRM required) = RECONSTRUCTION ERROR:
   hold out every other frame, rebuild it from its neighbours with the
   exact same min-jerk math the playback engine uses, and measure how
   far the reconstruction lands from the held-out original. This scores
   whether a recording is dense + smooth enough that the engine
   reproduces it faithfully — high error means a jerky / under-sampled
   capture (re-record), low error means the replay tracks the source.

   Errors are normalised by the calibration shoulder-width and reported
   as a percentage of shoulder-width, with an A–F grade mirroring the
   quality gate. (Face is excluded — 478 pts, not load-bearing for the
   manual-sign fidelity loop.)

   When true avatar bone-readback becomes available (headless three-vrm
   harness), `compareSequences` upgrades this to source-vs-driven error.
   ============================================================ */

import { lerpFrame } from './interp.js';

const CHANNELS = ['rightHand', 'leftHand', 'pose'];

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// Mean Euclidean distance between two landmark arrays over shared points.
function lmDist(a, b) {
  if (!a || !b) return null;
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const pa = a[i], pb = b[i];
    if (!pa || !pb) continue;
    const dx = (pa[0] ?? 0) - (pb[0] ?? 0);
    const dy = (pa[1] ?? 0) - (pb[1] ?? 0);
    const dz = (pa[2] ?? 0) - (pb[2] ?? 0);
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

/** Per-channel error between two frames, normalised by `scale`. */
export function frameError(a, b, scale = 1) {
  const out = {};
  for (const ch of CHANNELS) {
    const d = lmDist(a && a[ch], b && b[ch]);
    out[ch] = d == null ? null : d / scale;
  }
  return out;
}

function gradeFromPct(pct) {
  if (pct == null) return 'F';
  if (pct <= 3) return 'A';
  if (pct <= 6) return 'B';
  if (pct <= 10) return 'C';
  if (pct <= 16) return 'D';
  return 'F';
}

function pct(x) { return x == null ? null : +(x * 100).toFixed(2); }

/**
 * Reconstruction fidelity of one recorded sign.
 * @returns {{ overall:number|null, grade:string, perChannel:object, samples:number, note?:string }}
 *          overall + perChannel are % of shoulder-width.
 */
export function reconstructionError(sign) {
  const frames = (sign.landmarks || []).filter(f => f && typeof f.t === 'number');
  const scale = (sign.calibration && sign.calibration.shoulderWidth) || 1;
  if (frames.length < 5) {
    return { overall: null, grade: 'F', perChannel: {}, samples: 0, note: 'too few frames' };
  }

  const per = { rightHand: [], leftHand: [], pose: [] };
  for (let i = 1; i < frames.length - 1; i += 2) {
    const a = frames[i - 1], gt = frames[i], b = frames[i + 1];
    const span = Math.max(b.t - a.t, 1);
    const u = Math.min(Math.max((gt.t - a.t) / span, 0), 1);
    const recon = lerpFrame(a, b, u);
    const err = frameError(recon, gt, scale);
    for (const ch of CHANNELS) if (err[ch] != null) per[ch].push(err[ch]);
  }

  const perChannel = {};
  let all = [];
  for (const ch of CHANNELS) {
    perChannel[ch] = pct(mean(per[ch]));
    all = all.concat(per[ch]);
  }
  const overall = pct(mean(all));
  return { overall, grade: gradeFromPct(overall), perChannel, samples: all.length };
}

/**
 * Direct source-vs-replay error for matched-length sequences.
 * For the future bone-readback path; aligns by index.
 */
export function compareSequences(src, replayed, scale = 1) {
  const n = Math.min(src.length, replayed.length);
  const per = { rightHand: [], leftHand: [], pose: [] };
  for (let i = 0; i < n; i++) {
    const err = frameError(src[i], replayed[i], scale);
    for (const ch of CHANNELS) if (err[ch] != null) per[ch].push(err[ch]);
  }
  const perChannel = {};
  let all = [];
  for (const ch of CHANNELS) { perChannel[ch] = pct(mean(per[ch])); all = all.concat(per[ch]); }
  const overall = pct(mean(all));
  return { overall, grade: gradeFromPct(overall), perChannel, samples: all.length };
}
