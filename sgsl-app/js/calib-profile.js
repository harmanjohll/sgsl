/* ============================================================
   SgSL — Calibration profile (shared across ALL renderers)
   ============================================================
   One choke point that configures a SMPLXRetarget the same way no
   matter which tab drives it, so the Learn playback avatar, the Test
   live mirror, and the Contribute live mirror are CONGRUENT:

     defaults → live baseline → device hand tuning (sgsl.calib.v1)
              → the record's own saved settings (what the signer approved)
              → global fine-tune (sgsl.finetune.v1, this device)
              → per-sign fine-tune override (caller-supplied)

   Records already store `calibration` (body anchor) and
   `calibrationSettings` (hand tuning) — before this module existed
   they were saved but never re-applied at playback, which is exactly
   why a replayed sign didn't look like the mirror the signer recorded
   against.
   ============================================================ */

const CALIB_KEY = 'sgsl.calib.v1';       // device hand tuning (Contribute Advanced / Calibrate hands)
const FINETUNE_KEY = 'sgsl.finetune.v1'; // device-global fine-tune overrides
const SIDES = ['Right', 'Left'];

// The keys the fine-tune panels may override.
export const FINETUNE_KEYS = ['heightOffset', 'reachDepth', 'reachGain', 'smoothing'];

// ── Device hand-tuning defaults + persistence (single owner of sgsl.calib.v1) ──
// Calibrated baseline (tuned live by the signer, 2026-06). New users + Reset start here.
export const CALIB_DEFAULTS = {
  rollDeg: 10, pitchDeg: 10, yawDeg: 25, wristFlip: true,   // orientation
  deformGuard: true,                                 // anatomical clamps (anti-deformation)
  curlGain: 1.00, spreadGain: 1.00, thumbDeg: 25,    // fingers
  thumbCurl: 1.00, thumbSpread: 1.00,                // thumb (decoupled from fingers)
  reachDepth: 0.90, reachGain: 1.00,                 // reach
  guardStrictness: 1,                                // deformation-guard strength
  smoothing: 0.5,                                    // stability (lerps are rate-compensated now)
};
// IDENTICAL defaults for both sides: the measured and rig rest bases are chirality-paired
// per side, so the correction does not mirror (the mirrored-Left experiment measurably
// hurt the left hand and is reverted; the rendered-thumb harness scenarios pin this).
export const calibDefaultsFor = (_side) => ({ ...CALIB_DEFAULTS });

const mergeSide = (src) => {   // fill a side from saved values, falling back to CALIB_DEFAULTS
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const out = {};
  for (const k of Object.keys(CALIB_DEFAULTS)) {
    const d = CALIB_DEFAULTS[k];
    out[k] = (typeof d === 'boolean') ? (typeof src?.[k] === 'boolean' ? src[k] : d) : num(src?.[k], d);
  }
  return out;
};
// Settings saved before the winding flip-parity fix (calib schema v2) carry a rollDeg that
// was compensating a ~180° palm negation that no longer happens — shift it by 180° so the
// user's tuned look is preserved. Normalized to (-180, 180].
const migrateRoll = (side) => { side.rollDeg = ((side.rollDeg + 180 + 180) % 360) - 180; return side; };
// A pre-v2 side whose values still sat at the OLD shipped defaults was never really tuned —
// give it the NEW side-correct defaults instead of a blind roll-shift.
const wasOldDefaults = (c) => c && Math.abs(c.rollDeg - (-170)) < 1e-6 && Math.abs((c.yawDeg ?? 25) - 25) < 1e-6 && Math.abs((c.thumbDeg ?? 25) - 25) < 1e-6;

/** Full device hand-tuning settings, migrated + merged with defaults.
 *  Returns { settings: {Right, Left}, side, migratedLeftReset } — migratedLeftReset is
 *  true when a pre-v3 blob's LEFT side was reset (the left-defaults fix; caller may
 *  want to tell the user to re-run auto-tune). */
export function loadDeviceCalibSettings() {
  const out = { settings: { Right: calibDefaultsFor('Right'), Left: calibDefaultsFor('Left') }, side: 'Right', migratedLeftReset: false };
  try {
    const s = JSON.parse(localStorage.getItem(CALIB_KEY));
    if (!s || typeof s !== 'object') return out;
    const v = s.v || 1;
    const migrate = (saved, side) => {
      if (v >= 2) return mergeSide(saved);
      if (!saved || wasOldDefaults(saved)) return calibDefaultsFor(side);
      return migrateRoll(mergeSide(saved));
    };
    if (s.Right || s.Left) {                       // per-side format
      out.settings = { Right: migrate(s.Right, 'Right'), Left: migrate(s.Left, 'Left') };
      if (s.side === 'Left' || s.side === 'Right') out.side = s.side;
    } else {                                       // migrate old single-set format → both hands
      out.settings = { Right: migrate(s, 'Right'), Left: migrate({ ...s }, 'Left') };
    }
    // v3: the LEFT defaults shipped mirrored for a while (a regression — see retarget.js
    // WIND_SIGN comment), so any left tuning from that era fought a ~50° baseline error.
    // Reset Left to the corrected (identical-to-right) defaults.
    if (v < 3) {
      out.settings.Left = calibDefaultsFor('Left');
      out.migratedLeftReset = true;
    }
  } catch { /* ignore corrupt/absent settings */ }
  return out;
}

export function saveDeviceCalibSettings(settings, side = 'Right') {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify({ ...settings, side, v: 3 })); } catch { /* private mode */ }
}

/** Merge a solved orientation (auto-tune result) for one hand into the stored device
 *  tuning — the write path the Test tab's "Calibrate hands" uses. */
export function applySolvedOrientation(side, { rollDeg, pitchDeg, yawDeg }) {
  const { settings, side: editSide } = loadDeviceCalibSettings();
  settings[side] = { ...settings[side], rollDeg, pitchDeg, yawDeg };
  saveDeviceCalibSettings(settings, editSide);
  return settings;
}

// Contribute's live mirror always runs with smoothing 0.5 (recorder default), while the
// retarget's shipped default is 0 (crisp) — apply the live value as the shared baseline
// so playback isn't twitchier than the mirror the signer approved.
const LIVE_BASELINE = { smoothing: 0.5 };

/** Device hand tuning saved by the Contribute Advanced panel, or null.
 *  v3 blobs are per-side {Right,Left}; older flat blobs apply to both sides
 *  (the recorder migrates them properly on its next load). */
export function loadDeviceCalib() {
  try {
    const d = JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
    if (!d || typeof d !== 'object') return null;
    if (d.Right || d.Left) return { Right: d.Right || null, Left: d.Left || null };
    return { Right: d, Left: d };
  } catch { return null; }
}

export function loadFineTune() {
  try { return JSON.parse(localStorage.getItem(FINETUNE_KEY) || 'null') || {}; }
  catch { return {}; }
}
export function saveFineTune(ft) {
  const clean = {};
  for (const k of FINETUNE_KEYS) if (typeof ft?.[k] === 'number' && isFinite(ft[k])) clean[k] = ft[k];
  try {
    if (Object.keys(clean).length) localStorage.setItem(FINETUNE_KEY, JSON.stringify(clean));
    else localStorage.removeItem(FINETUNE_KEY);
  } catch { /* private mode */ }
  return clean;
}

/** Only the numeric fine-tune keys of `src` (per-sign overlays carry trim/speed too). */
function tuneSubset(src) {
  const out = {};
  for (const k of FINETUNE_KEYS) if (typeof src?.[k] === 'number' && isFinite(src[k])) out[k] = src[k];
  return out;
}

/**
 * Configure a retarget instance through the full precedence chain.
 * `record`  — a sign record (its saved calibration/calibrationSettings win over device)
 * `perSign` — a per-sign fine-tune overlay (wins over everything)
 * Pass no options for a LIVE renderer (Test) — device tuning + global fine-tune.
 */
export function configureRetarget(retarget, { record = null, perSign = null } = {}) {
  if (!retarget) return;
  retarget.resetTuning?.();
  for (const s of SIDES) retarget.setHandTuning(s, LIVE_BASELINE);
  const dev = loadDeviceCalib();
  if (dev) for (const s of SIDES) if (dev[s]) retarget.setHandTuning(s, dev[s]);
  const rcs = record?.calibrationSettings;
  if (rcs) for (const s of SIDES) if (rcs[s]) retarget.setHandTuning(s, rcs[s]);
  retarget.setCalibration(record?.calibration || null);
  const overlay = { ...tuneSubset(loadFineTune()), ...tuneSubset(perSign) };
  if (Object.keys(overlay).length) for (const s of SIDES) retarget.setHandTuning(s, overlay);
}
