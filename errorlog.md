# SgSL — Error Log: the defects behind "awkward rotations, instability, weak fidelity"

This is the record of what was actually wrong with the avatar retargeting pipeline, found by a
systematic multi-reviewer audit (July 2026), each finding verified against the code and then
**measured** with the autonomous fidelity harness (`test/fidelity_run.mjs` — headless Chromium
replaying synthetic ground-truth landmarks through the production pipeline and scoring the avatar's
bones). Fixes landed in commits `306495d..2267bdb` on `claude/confident-ramanujan-znrlt7`.

**Harness scoreboard: 4/12 scenarios passing before → 12/12 after.**

| # | Defect | Where | Measured before → after |
|---|--------|-------|--------------------------|
| 1 | Palm-facing winding override **sign-inverted** under the default wrist-flip | `retarget.js` `_driveHand` | 173–178° hand flips in yaw/roll sweeps → **zero flips, 0.0° error** |
| 2 | Forearm never aimed at the IK's own target (wrist missed the tracked dot) | `retarget.js` forearm slaving + `_solveArmIK` skip | wrist–target miss **0.82 → 0.085** shoulder-widths |
| 3 | Handedness label flips swapped the avatar's arms (no temporal continuity) | v2 `adapter.js`, v1 `mergeHandLandmarker` | label-flip wrist jump **2.08 → 0.09** SW |
| 4 | Pose-wrist dropout fallback indices **crossed** (arm yanked to the wrong wrist) | `retarget.js` target selection | folded into #3's scenario |
| 5 | Body anchor snapped to nose fallback when a crossing hand occluded a shoulder | `retarget.js` `_bodyAnchor` | occlusion jump 0.27→0.067 SW (= clean run) |
| 6 | Arm-reach saturation: sqrt slope at full extension amplified target jitter | `retarget.js` 2-bone IK | capped at 95% extension; adaptive across-body depth |
| 7 | Pose-wrist fallback ignored visibility (`WRIST_VIS_THRESH` was dead code) | `retarget.js` | gated + hold-last-good target |
| 8 | Left hand ran the **right hand's** calibration (chirality not mirrored) | `retarget._defaultCalib`, recorder, v2 | ~50° constant wrist error on the left → mirrored defaults |
| 9 | Smoothing constants were per-call, not per-time → v2's slower rate over-smoothed ~1.5× (≈0.5 s lag) | `retarget.js` all slerps | rate-compensated (`1-(1-a)^(dt/33ms)`); default smoothing 0.75→0.5 |
| 10 | Wrist deform guard hard-rewrote the quaternion at the limit ("notchy catch") | `retarget.js` guard | converges by slerp instead |
| 11 | v2 worker throttled hands to every other frame (pointless off-thread) + fake 33 ms clock skewed MediaPipe's internal filter | v2 `track-worker.js`, `app.js` | hands every frame; real `performance.now()` clock |
| 12 | Replay/preview silently **dropped recorded 3D world hands** → playback used a different hand engine than live | `player.js`, `recorder.js` | world hands passed through; playback = live path |
| 13 | `fingerAnglesFromResults` routed hands to the **opposite** side vs the live path | `retarget.js` | same-side routing |
| 14 | Finger curl/spread gains (0.70/0.80) were eye-tuned compensation for the above bugs | defaults everywhere | ground truth wants 1.0 → fist bend error 16.6°→0.0° |

---

## The smoking gun (#1): winding override inverted by the wrist-flip default

**Symptom:** "awkward rotations" — the hand + forearm barrel-rolled ~180° during across-body or
edge-on movement; the wrist "caught" mid-motion; everything felt subtly mis-rotated.

**Root cause:** the palm-facing stabiliser decides palm-toward vs palm-away from the 2D knuckle
*winding*, with a pinned sign (`WIND_SIGN = -1`) validated by offline tools that model the hand
axis map as `HAND_W = [-1,-1,-1]`. Later, the "Wrist rotation: Flipped" toggle was added and
**defaulted on** — it flips the x-axis of the map (`wx = +1`). Flipping x **negates the winding**
(it's odd in x) but **not** the palm normal's z (cross-product z and the determinant both flip and
cancel). So under the shipped default, the override tested the *wrong sign*: it negated a
geometrically **correct** palm normal on every confident frame, and every crossing of the winding
threshold (|wind| = 0.3 — precisely the edge-on zone you pass through when moving across the body)
snapped the entire hand basis, finger frame, and forearm ~180°.

**Why it survived tuning:** the roll calibration (-170°) was eye-tuned *with the bug active*, so
the confident zone looked right (double-compensation) while the edge-on zone and every threshold
crossing stayed broken. Classic case of tuning absorbing a sign error.

**Fix:** make the winding decision flip-invariant (re-parify by the wrist-flip sign), and shift
the roll default by the 180° the old value was compensating (-170° → +10°). Saved user settings
migrate automatically (calib schema v2).

**Measured:** yaw sweep max step 178° → 5°; roll sweep 173° → 10°; both hands; zero flips.

## The fidelity killer (#2): the wrist never went to the dot

With 3D hand landmarks present, the forearm was slaved 1:1 to the *hand's orientation* and the
arm-IK deliberately skipped the forearm — so nothing ever placed the wrist at the tracked 2D
target. The guard meant to bound this (`WRIST_SWING_CAP` / `STRAIGHT_GAIN`) was **documented but
never implemented** (dead constants). Median wrist-to-target miss: **0.82 shoulder-widths** — the
avatar's "doesn't follow my dots" feeling, quantified. Now the forearm aims at the IK's own
elbow→target direction (the IK picks the elbow such that the wrist lands exactly on the target),
the hand keeps its true orientation, and the difference appears as an anatomical wrist bend capped
at the deform-guard limit. Miss after: **0.085 SW**.

## The across-body jerk (#3 + #4): label flips with no memory

MediaPipe re-decides "Left/Right" per frame; when hands cross or come close, labels flip for a few
frames. Routing was label-per-frame with silent same-label overwrite, so the avatar's arms
**swapped targets** (measured 2.08 SW wrist jump), the wrong-chirality hand drove the rig, and the
dropout fallback pointed at the *other* wrist (crossed pose indices 15/16). Fixed with a temporal
hand→side router (nearest-wrist continuity; labels only seed; 4-frame sustained-relabel rule)
shared by v1 and v2, plus uncrossed fallback indices. Label-flip scenario now identical to a clean
run (0.09 SW).

## How we keep it fixed

- `node test/fidelity_run.mjs` — 12 scenarios (orientation sweeps incl. the edge-on winding zone,
  handshapes, across-body sweeps with occlusion and label flips), convention-free metrics
  (delta-angle rigidity, PIP/DIP bends, wrist-vs-target, jump continuity). Must stay 12/12.
- `node test/test.mjs` (25 checks) + `node test/replay_error.mjs` — repo regression gates.
- Every capture (.json dumps, session recordings, screenshots) embeds the active calibration, so
  field reports stay diagnosable.

## #15 (2026-07-07): the left-hand regression — mirrored defaults, falsified and reverted

**Symptom:** "Left hand is quite a problem" — constant awkward orientation on the left, while
the right was good; left Auto-tune produced unusable values.

**The investigation is a lesson in measuring the right thing.** The HUD showed a flat left palm
reading `face:-0.8` where the right read `+0.91`, which suggested the palm-facing stabiliser's
left sign was inverted — and a plausible history backed it (the Left pin traced to right-hand
captures from the swapped-routing era). A numeric derivation against an ANATOMICAL expectation
"confirmed" it. But an A/B test of the **rendered skeleton** (does the avatar's left thumb point
the anatomically correct way in world space?) falsified the theory: the original sign renders the
left hand CORRECTLY (thumb −0.093 = viewer's left, as a real left palm-to-camera must), and the
"fix" broke it. The debug `facing` value is **rig-paired, not anatomical**: the measured palm
normal and the avatar rig's rest palm axis are built with the same chirality-odd cross product,
so both flip together for the left hand — a correct left palm legitimately reads `facing ≈ −1`.

**The real defect was #8's "fix":** the mirrored Left defaults (roll/yaw/thumb sign-flipped) were
derived from the same anatomical-identity assumption. Because the bases are chirality-PAIRED, the
correction does NOT mirror — the mirrored defaults put ~50° of baseline error on the left hand.
The same assumption made left Auto-tune solve against the wrong expected basis (reading a correct
capture as a ~180° inversion).

**Fixes:** Left defaults restored to identical-to-right (calib schema v3 resets stored Left
settings from the mirrored era); Auto-tune solves against the side-correct expected basis (Left
pairs at rotY 180°); an inversion guard refuses ~180° solves; and the harness gained four
`face-*` scenarios asserting BOTH the rig-paired facing sign AND the **rendered thumb side in
world space** — the anatomy-based check that cannot be fooled by any internal convention, and the
check that would have caught #8's mirror error before it shipped. Bonus: the interaction hold now
freezes the forearm too (the IK re-aim was popping the wrist the moment hands touched:
duo-dropout max drop 0.101 → 0.038 SW).

**Measured:** face-L-toward thumb −0.038 (correct side) / facing −0.97 (correct pairing);
19/19 harness scenarios pass.

## Note on calibration migration

Old saved slider settings (localStorage) are migrated on load: roll shifted by the 180° the old
value compensated; a side left at untouched old defaults is reseeded with the new side-correct
defaults (the left hand now gets the chiral mirror of the right-tuned baseline). Reset buttons are
side-aware. If a hand ever looks 180° rolled after an update, hit **Reset calibration** for that
hand — that's the tuned baseline.
