/* ============================================================
   SgSL — temporal hand→side router (shared by v1 and v2)
   ============================================================
   MediaPipe's per-frame handedness label flips for a few frames when
   hands cross or come close — and raw label routing then SWAPS which
   avatar arm each physical hand drives (a violent arm jerk, measured
   as a 2.1-shoulder-width wrist jump in test/fidelity_run.mjs
   cross-labelflip). This router adds the temporal continuity the raw
   label lacks:

   - A detection that lands near a side's last-seen wrist KEEPS that
     side, whatever its label says this frame (nearest-wrist matching
     with a max-jump gate).
   - The label only SEEDS untracked sides, and only re-routes a live
     track after RELABEL_FRAMES consecutive disagreeing frames with a
     free destination (a real, sustained identity change — not a
     crossing flicker).
   - Two detections with the SAME label no longer overwrite one slot:
     the second goes to the free side.

   Input hands: [{ categoryName: 'Right'|'Left', landmarks, worldLandmarks }]
   (landmarks[0] = wrist, normalized image coords).
   Output: { Right: hand|null, Left: hand|null }
   ============================================================ */

const RELABEL_FRAMES = 4;   // consecutive disagreeing labels before a live track re-routes
const MAX_JUMP = 0.35;      // normalized image units; beyond this a detection is "new", not a match
const EXPIRE_FRAMES = 12;   // unseen frames before a track is dropped (stale positions must not hijack)

export class HandRouter {
  constructor() {
    this._tracks = { Right: null, Left: null };   // {x, y, unseen, mislabel}
    this._frame = 0;
  }

  route(hands) {
    this._frame++;
    const out = { Right: null, Left: null };
    const dets = (hands || []).filter(h => h && h.landmarks && h.landmarks[0]);

    // Age + expire tracks.
    for (const side of ['Right', 'Left']) {
      const t = this._tracks[side];
      if (t && ++t.unseen > EXPIRE_FRAMES) this._tracks[side] = null;
    }

    // 1) Continuity: greedily match detections to live tracks by wrist distance.
    const unmatched = new Set(dets);
    const pairs = [];
    for (const side of ['Right', 'Left']) {
      const t = this._tracks[side];
      if (!t) continue;
      for (const d of dets) pairs.push({ side, d, dist: Math.hypot(d.landmarks[0].x - t.x, d.landmarks[0].y - t.y) });
    }
    pairs.sort((a, b) => a.dist - b.dist);
    const sideTaken = new Set();
    for (const { side, d, dist } of pairs) {
      if (dist > MAX_JUMP || sideTaken.has(side) || !unmatched.has(d)) continue;
      sideTaken.add(side); unmatched.delete(d);
      this._assign(out, side, d);
    }

    // 2) Leftovers: label seeds a free side; occupied label → the other free side.
    for (const d of unmatched) {
      const want = d.categoryName === 'Left' ? 'Left' : 'Right';
      const side = !out[want] ? want : (!out[want === 'Left' ? 'Right' : 'Left'] ? (want === 'Left' ? 'Right' : 'Left') : null);
      if (side) this._assign(out, side, d);
    }

    // 3) Sustained relabel: a live track whose detections carry the OTHER label for
    //    RELABEL_FRAMES straight, with that side free, genuinely changed identity.
    for (const side of ['Right', 'Left']) {
      const t = this._tracks[side];
      if (!t || !out[side]) continue;
      const other = side === 'Left' ? 'Right' : 'Left';
      if (t.mislabel >= RELABEL_FRAMES && !out[other] && !this._tracks[other]) {
        this._tracks[other] = t; this._tracks[side] = null;
        out[other] = out[side]; out[side] = null;
      }
    }
    return out;
  }

  _assign(out, side, d) {
    out[side] = d;
    const w = d.landmarks[0];
    const prev = this._tracks[side];
    const mislabel = (d.categoryName && d.categoryName !== side) ? (prev ? prev.mislabel + 1 : 1) : 0;
    this._tracks[side] = { x: w.x, y: w.y, unseen: 0, mislabel };
  }
}
