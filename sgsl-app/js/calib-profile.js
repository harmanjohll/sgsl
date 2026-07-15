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

const CALIB_KEY = 'sgsl.calib.v1';       // device hand tuning (Contribute → Advanced)
const FINETUNE_KEY = 'sgsl.finetune.v1'; // device-global fine-tune overrides
const SIDES = ['Right', 'Left'];

// The keys the fine-tune panels may override.
export const FINETUNE_KEYS = ['heightOffset', 'reachDepth', 'reachGain', 'smoothing'];

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
