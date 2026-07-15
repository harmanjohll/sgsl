/* ============================================================
   SgSL — guided hand auto-tune driver (shared)
   ============================================================
   Solves the 3-DOF orientation calibration (roll/pitch/yaw) per hand
   from the retarget's raw measured basis while the signer holds a flat
   palm to the camera. Extracted from the Contribute recorder so the
   Test tab can calibrate too — anywhere a TrackingCore/retarget runs,
   this can run.

   Usage: const tuner = createAutoTuner({ retarget, onStatus, onSolved, onDone, onError });
          per tracking frame: tuner.feed(results);   tuner.cancel() to abort.
   - onStatus(msg)            progress line ("capturing… 10/30")
   - onSolved(side, {rollDeg,pitchDeg,yawDeg}) a hand solved — persist/apply it
   - onDone()                 both hands solved
   - onError(msg, {retrying}) guard tripped; retrying=true means same side restarts
   ============================================================ */

import { solveOrientationOffset } from './autotune.js';

export const AUTOTUNE_SAMPLES = 30;

export function createAutoTuner({ retarget, samples = AUTOTUNE_SAMPLES,
  onStatus = () => {}, onSolved = () => {}, onDone = () => {}, onError = () => {} }) {
  let state = { side: 'Right', samples: [] };

  const promptFor = (side) =>
    `Hold your ${side.toUpperCase()} hand FLAT, palm facing the camera, fingers up.`;
  onStatus(`Auto-tune: ${promptFor('Right')}`);

  return {
    get active() { return !!state; },
    get side() { return state?.side || null; },
    cancel() { state = null; },

    feed(results) {
      if (!state) return;
      const side = state.side;
      const world = side === 'Right' ? results.rightHandWorldLandmarks : results.leftHandWorldLandmarks;
      const dbg = retarget?._handDbg?.[side];
      const raw = retarget?._rawBasis?.[side];
      // Sample only clean canonical frames: confident winding (not edge-on) + flat hand.
      if (world?.length >= 21 && raw && dbg && Math.abs(dbg.wind) > 0.35 && dbg.curl < 25) {
        state.samples.push(raw);
        if (state.samples.length % 10 === 0 && state.samples.length < samples) {
          onStatus(`Auto-tune (${side}): capturing… ${state.samples.length}/${samples}. Hold steady.`);
        }
      }
      if (state.samples.length < samples) return;

      // Expected calibrated basis: identity for Right; for Left the rig-paired canonical
      // flat palm sits at rotY(180°) (see WIND_SIGN comment in retarget.js) — without this
      // the left solve reads as a ~180° roll and the inversion guard rejects it.
      const expected = side === 'Left' ? [0, 1, 0, 0] : [0, 0, 0, 1];
      const solved = solveOrientationOffset(state.samples, expected);
      if (Math.abs(solved.rollDeg) > 135) {
        // A near-180° solve means the measured basis is facing-INVERTED — a chirality/
        // winding regression, not a tuning offset. Refuse rather than bake it in.
        state = null;
        onError(`Auto-tune (${side}): the captured palm reads facing-inverted (roll ${Math.round(solved.rollDeg)}°) — check the Wrist rotation toggle, and report this if it persists.`, { retrying: false });
        return;
      }
      if (solved.spreadDeg > 25) {
        // Hand wasn't steady — retry this side rather than bake a bad calibration.
        state.samples = [];
        onError(`Auto-tune (${side}): the hand moved too much (±${Math.round(solved.spreadDeg)}°) — hold it steadier, flat to the camera.`, { retrying: true });
        return;
      }
      const clampDeg = (v, lim) => Math.max(-lim, Math.min(lim, Math.round(v / 5) * 5));
      const tuned = {
        rollDeg: clampDeg(solved.rollDeg, 180),
        pitchDeg: clampDeg(solved.pitchDeg, 90),
        yawDeg: clampDeg(solved.yawDeg, 90),
      };
      onSolved(side, tuned);
      if (side === 'Right') {
        state = { side: 'Left', samples: [] };
        onStatus(`Right hand tuned (roll ${tuned.rollDeg}° pitch ${tuned.pitchDeg}° yaw ${tuned.yawDeg}°). Now your LEFT hand: flat palm to the camera, fingers up.`);
      } else {
        state = null;
        onDone();
      }
    },
  };
}
