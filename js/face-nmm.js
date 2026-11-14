/* ============================================================
   SgSL — Face non-manual markers (brows + eyes)
   ============================================================
   In SgSL the brows are GRAMMAR, not decoration: raised brows mark a
   yes/no question, furrowed brows mark a wh-question. Kalidokit's face
   solve (retarget._rigFace) already drives blink, visemes, gaze and
   head; this module adds the brow/eye channel.

   Source (ported from the sign1 "Fumi mirror" reboot): MediaPipe
   FaceLandmarker's 52 ARKit blendshape scores, which are far cleaner
   than landmark geometry. Recordings store a compact subset per frame
   (frame.faceBS, fixed key order below) so replays carry the brows.
   Old recordings without faceBS fall back to Kalidokit's geometric
   brow-raise ratio (raise only; it cannot see a furrow).

   Output drives the VRoid "Fcl_BRW_*" / "Fcl_EYE_*" morph targets
   directly. On the hero model none of these is bound by a VRM preset,
   so writing them never fights blink/viseme/emotion presets.

   Pure parts (packFaceBS, unpackFaceBS, solveFaceNMM, lerpFaceBS) are
   Node-tested in test/face-nmm.test.mjs; FaceRig needs a live VRM.
   ============================================================ */

/** Fixed order for frame.faceBS. Append only: reordering breaks saved recordings. */
export const FACE_BS_KEYS = [
  'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'browDownLeft', 'browDownRight',
  'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'cheekPuff', 'mouthPucker',
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

/** Accepts MediaPipe categories [{categoryName, score}] or a {name: score} map.
 *  Returns the compact recording array (3 dp) or null. */
export function packFaceBS(src) {
  if (!src) return null;
  let map = src;
  if (Array.isArray(src)) {
    if (!src.length) return null;
    map = {};
    for (const c of src) if (c && c.categoryName) map[c.categoryName] = c.score;
  }
  if (!FACE_BS_KEYS.some((k) => typeof map[k] === 'number')) return null;
  return FACE_BS_KEYS.map((k) => Math.round((map[k] || 0) * 1000) / 1000);
}

/** Compact array -> {name: score}. Tolerates shorter arrays from older builds. */
export function unpackFaceBS(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const m = {};
  FACE_BS_KEYS.forEach((k, i) => { m[k] = arr[i] || 0; });
  return m;
}

/** Linear blend of two compact arrays (interp.js); null unless both exist,
 *  so a bridge never snaps the channel on mid-span. */
export function lerpFaceBS(a, b, t) {
  if (!a || !b) return undefined;
  return b.map((v, i) => (a[i] ?? v) + (v - (a[i] ?? v)) * t);
}

/**
 * Blendshape map (or null) + optional Kalidokit brow ratio -> NMM weights 0..1.
 *   raise  — both brows up (yes/no question)
 *   furrow — brows down and together (wh-question)
 *   worry  — inner brows up only
 *   wide   — eyes widened;  squint — eyes narrowed
 *   puff   — cheeks puffed (no morph on the hero model; recorded for later)
 * Dead zones absorb each face's resting offset so a neutral face reads 0.
 */
export function solveFaceNMM(bs, kalidokitBrow) {
  const out = { raise: 0, furrow: 0, worry: 0, wide: 0, squint: 0, puff: 0, source: 'none' };
  if (bs) {
    const g = (k) => bs[k] || 0;
    const outer = (g('browOuterUpLeft') + g('browOuterUpRight')) / 2;
    const inner = g('browInnerUp');
    const down = (g('browDownLeft') + g('browDownRight')) / 2;
    out.raise = ramp(outer * 0.6 + inner * 0.4, 0.10, 0.50);
    out.furrow = ramp(down, 0.08, 0.45);
    out.worry = ramp(inner - outer, 0.12, 0.45);
    out.wide = ramp((g('eyeWideLeft') + g('eyeWideRight')) / 2, 0.15, 0.60);
    out.squint = ramp((g('eyeSquintLeft') + g('eyeSquintRight')) / 2, 0.30, 0.75);
    out.puff = ramp(g('cheekPuff'), 0.15, 0.60);
    // Raised and furrowed brows are opposite muscles: let the stronger one win.
    if (out.raise > out.furrow) out.furrow *= 0.3; else out.raise *= 0.3;
    out.source = 'blendshapes';
  } else if (typeof kalidokitBrow === 'number' && isFinite(kalidokitBrow)) {
    out.raise = ramp(kalidokitBrow, 0.35, 0.85);
    out.source = 'geometry';
  }
  return out;
}

// ─── Avatar side ────────────────────────────────────────────
// semantic channel -> morph-name suffixes to try (VRoid naming first).
const MORPHS = {
  raise:  ['Fcl_BRW_Surprised', 'BrowUp', 'browUp'],
  furrow: ['Fcl_BRW_Angry', 'BrowDown', 'browDown'],
  worry:  ['Fcl_BRW_Sorrow'],
  wide:   ['Fcl_EYE_Surprised'],
  squint: ['Fcl_EYE_Angry'],
};
const GAIN = { raise: 1.0, furrow: 0.9, worry: 0.8, wide: 0.6, squint: 0.5 };
const CHANNELS = Object.keys(MORPHS);

const rigs = new WeakMap();

/** One FaceRig per loaded VRM. */
export function faceRigFor(vrm) {
  if (!vrm || !vrm.scene) return null;
  let r = rigs.get(vrm);
  if (!r) { r = new FaceRig(vrm); rigs.set(vrm, r); }
  return r;
}

export class FaceRig {
  constructor(vrm) {
    this.targets = {};                        // channel -> [{mesh, index}]
    this.tracked = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
    this.scripted = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
    this.last = null;                         // last solve, for the debug readout
    const lists = vrm.__targetNameLists || [];
    vrm.scene.traverse((o) => {
      let dict = o.morphTargetDictionary;
      if (!dict || !o.morphTargetInfluences) return;
      // Unnamed (index-only) dictionary: recover names from the glTF lists when exactly
      // one list has this mesh's morph count (VRoid primitive-level targetNames).
      if (Object.keys(dict).every((k) => /^\d+$/.test(k))) {
        const n = o.morphTargetInfluences.length;
        const match = lists.filter((l) => l.length === n);
        if (match.length !== 1) return;
        dict = Object.fromEntries(match[0].map((name, i) => [name, i]));
      }
      for (const ch of CHANNELS) {
        for (const suffix of MORPHS[ch]) {
          const name = Object.keys(dict).find((n) => n.endsWith(suffix));
          if (name !== undefined) { (this.targets[ch] ||= []).push({ mesh: o, index: dict[name] }); break; }
        }
      }
    });
    this.available = CHANNELS.filter((c) => this.targets[c]);
  }

  /** Live/replay tracking. nmm = solveFaceNMM(...) or null (face lost: decay out). */
  setTracked(nmm, alpha = 0.5) {
    this.last = nmm;
    for (const c of CHANNELS) {
      const goal = nmm ? (nmm[c] || 0) : 0;
      this.tracked[c] += (goal - this.tracked[c]) * (nmm ? alpha : 0.15);
    }
    this._write();
  }

  /** Scripted grammar (avatar.applyNMM). weights: {channel: 0..1}. */
  setScripted(weights) {
    for (const c of CHANNELS) this.scripted[c] = (weights && weights[c]) || 0;
    this._write();
  }

  _write() {
    for (const c of this.available) {
      const v = clamp01(Math.max(this.tracked[c], this.scripted[c]) * GAIN[c]);
      for (const t of this.targets[c]) t.mesh.morphTargetInfluences[t.index] = v;
    }
  }
}
