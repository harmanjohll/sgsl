/* ============================================================
   SgSL Avatar — Kalidokit Retargeting
   Derived from Kalidokit demo script.js (VRM 0.x API).

   Diverges from the demo where necessary for laptop-webcam signing:
   - Arms are gated per-side with 5-frame hysteresis so MediaPipe
     hand-detection flicker doesn't collapse Fumi to rest.
   - Upper-arm rotation is computed DIRECTLY from the 2D
     shoulder→wrist vector when the hand is detected. Kalidokit's
     pose solver under-shoots arm height when the elbow is off-frame
     (it extrapolates world-z from the torso and believes itself).
     We still use Kalidokit for the elbow bend and the "hands down"
     fallback.
   - Wrist rotation drops the pose-solver's z component (the same
     hallucination that caused under-shoot was rotating the hand
     onto a bad plane, so open palms rendered as curled fingers).
   - Torso dampened; Hips position transfer removed (SgSL signer
     stays planted, prevents floating/tilt).
   - Legs are never driven (avatar.js holds them in rest).
   ============================================================ */

import * as Kalidokit from 'kalidokit';
import { LandmarkFilter } from './one-euro.js';

const remap = Kalidokit.Utils.remap;
const clamp = Kalidokit.Utils.clamp;
const lerp = Kalidokit.Vector.lerp;

const FINGER_NAMES = ['Ring','Index','Middle','Thumb','Little'];
const FINGER_SEGMENTS = ['Proximal','Intermediate','Distal'];

const POSE_MIN_VISIBLE_LMS = 20;   // of 33
const POSE_VIS_THRESH = 0.5;
const HAND_MIN_VISIBLE_LMS = 12;   // of 21 (lowered from 15; we now have hysteresis)
const WRIST_VIS_THRESH = 0.5;

// Hysteresis: once an arm is "on", it can absorb up to this many
// consecutive failure frames before we start slerping it back to
// rest. 5 frames at ~30 fps = ~160 ms grace window.
const ARM_HYSTERESIS_FRAMES = 5;
// Hands-interacting hold: when the two hands are CLOSE (contact signs), MediaPipe
// drops/merges detections; without a hold the lost side's fingers relax immediately and
// its arm collapses to rest 5 frames later, then snaps back (measured 1.5 SW wrist drop +
// 75° finger relax in test/fidelity_run.mjs duo-dropout). While close, a side that loses
// its detection FREEZES (streak sustained, held target, fingers untouched), bounded by
// this many frames (~2 s) so a genuine exit still relaxes. Enter/exit thresholds are in
// shoulder-width units with hysteresis so the state doesn't flap at the boundary.
const INTERACTION_HOLD_MAX = 45;
const HANDS_CLOSE_ENTER = 1.1, HANDS_CLOSE_EXIT = 1.4;

// ── Hands-first arm IK tuning ───────────────────────────────────
// Map the tracked wrist's screen position (normalized 0..1) to a world
// target on a plane in front of the chest, sized by the avatar's own
// shoulder width, then 2-bone-IK the arm to reach it. The avatar's real
// shoulder anchors the solve, so no monocular arm-depth guessing is done.
// MIRROR_X / FRONT_Z signs are pinned by tools/ik_harness.mjs.
//
// Primary mapping is BODY-RELATIVE: the wrist is measured relative to the
// user's own shoulders (in shoulder-width units), so it's invariant to how
// the user is framed/zoomed. This is what makes a hand raised above the
// shoulders read as "raised" even when the shoulders sit low in the frame.
const MIRROR_X = 1;          // anatomical copy (no left-right mirror); was -1 for the mirror config
const FRONT_Z = 1;           // +1 = signing plane sits toward the camera
const REACH_GAIN = 1.15;     // user shoulder-widths → avatar shoulder-widths
const BOX_DEPTH = 1.2;       // plane distance in front, in shoulder-widths
// TRUE DEPTH: MediaPipe's 3D pose (za) carries a real metric wrist z. When it's
// available + the wrist is visible, the target depth blends this measurement over
// the synthetic plane by this weight (the plane remains the fallback and the
// stabilising prior — za z is the noisiest pose channel).
const DEPTH3D_WEIGHT = 0.65;
// Absolute fallback (only when the user's shoulders/nose aren't detected):
const BOX_W = 2.4;           // signing-box width  in shoulder-widths
const BOX_H = 3.0;           // signing-box height in shoulder-widths
const ARM_IK_LERP = 0.45;    // per-frame slerp toward the IK solution
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── 3D hand driving (MediaPipe Tasks HandLandmarker world landmarks) ──
// Map MP world-landmark axes → avatar-world axes. The same mapping drives both
// palm orientation and per-finger aim. Signs pinned by the harness + live test:
// x mirrored (reflection), y up (MP y is down), z toward the camera.
const HAND_WX = -1, HAND_WY = -1, HAND_WZ = -1;
// The axis map is a reflection (det = product of signs); a cross product (the
// palm normal) flips sign under reflection, so correct it back to match the
// rest palm axis (computed in un-reflected avatar space).
const HAND_DET = HAND_WX * HAND_WY * HAND_WZ;
const HAND_LERP = 0.5;       // per-frame slerp for hand/finger bones
// Wrist: the hand's world orientation is trusted (3D landmarks), but slaving the forearm
// 1:1 to it (the old STRAIGHT_GAIN=1.0 behaviour) meant the arm-IK NEVER placed the wrist
// at the tracked 2D target — the posed wrist sat up to a forearm length from the landmark
// dot (measured: median 0.82 shoulder-widths in test/fidelity_run.mjs cross sweeps), and
// one bad orientation frame swung the whole forearm unbounded. Now the forearm aims at the
// IK's own elbow→target direction (wrist lands ON the dot — the IK chose the elbow so
// |E−T| = L2), the hand keeps its true world orientation, and the difference shows as an
// anatomical wrist bend:
//   STRAIGHT_GAIN    — fraction of the hand-vs-IK angle the FOREARM leans toward the hand
//                      (small: position fidelity wins; the wrist joint carries the rest).
//   WRIST_BEND_MAX   — max bend carried at the wrist joint; beyond it the forearm concedes
//                      position (matches the WRIST_MAX deform-guard limit so they don't fight).
//   WRIST_SWING_CAP  — absolute bound on the forearm's swing away from the IK direction
//                      (bad-frame guard, e.g. a garbage hand orientation).
const STRAIGHT_GAIN = 0.10;
const WRIST_SWING_CAP = 80 * Math.PI / 180;
// Manual palm-rotation calibration. The hand is rolled about the forearm (fingerDir)
// axis by a USER-SET angle (default 180°). 180° == negating palmNormal: it flips both the
// palm-normal (Z) and across (X) of the hand basis — a true 180° wrist roll (NOT a mirror),
// so the fingers/thumb follow consistently. Other angles let the user dial the palm facing
// in by eye to correct the imperfect monocular orientation (setOrientationCalibration).
// Applied to palmNormal BEFORE qHandWorld so the forearm follows and the wrist stays straight.
const DEFAULT_ROLL_DEG = 180;
// Fingers + thumb are driven by DIRECT HAND-LOCAL AIM (see _driveHand): each bone
// is aimed along its real landmark segment, re-expressed in the avatar's hand
// frame, so curl, splay and thumb opposition reproduce exactly — no per-joint flex
// axis and no tuning gains. (The old per-joint FLEXION-ANGLE model curled the thumb
// about cross(thumbDir, palmNormal), which lifts it OUT of the palm plane instead
// of folding it across the palm, so the thumb juts out; direct aim fixes that.)
// Per-finger landmark chains [wrist, mcp, pip, dip, tip]. (Digit names use the
// shared FINGER_NAMES list declared at the top of the module — do NOT redeclare
// it here: a second `const FINGER_NAMES` is a duplicate-declaration SyntaxError
// that breaks the whole module, and `node --check` does NOT catch it.)
const FINGER_SEG = { Thumb: [0,1,2,3,4], Index: [0,5,6,7,8], Middle: [0,9,10,11,12], Ring: [0,13,14,15,16], Little: [0,17,18,19,20] };
// Palm-facing stabiliser. MediaPipe's monocular depth can flip palm↔back (world
// z negates, x/y stay), swinging the palm ~180°. The 2D knuckle winding (from
// the world x/y, which DON'T flip) robustly says palm-toward vs palm-away, so we
// force the palm normal's facing to match it.
// WHY BOTH SIDES ARE -1 (rig-paired convention — measured, do not "fix" again):
// the measured palm normal (cross(fingerDir, little−index)·det) and the avatar
// rig's rest palmAxis (avatar.js _measureHandRig, same cross formula on the
// avatar's own bones) are BOTH chirality-odd. For the LEFT hand both flip
// together, so they stay PAIRED: a correctly-rendered left palm-to-camera has
// dbg facing ≈ −1 by convention (NOT +1 — the debug value is rig-paired, not
// anatomical). The winding also flips for left (chirality-odd), and the desired
// rig-paired facing flips too — the two negations cancel, so WIND_SIGN is the
// SAME sign for both sides. Verified by RENDERED anatomy in the harness
// (face-* scenarios assert the avatar's thumb side in world space): with -1 the
// left thumb points the correct way (thumbDx −0.093); with +1 the left hand
// rolls ~180° wrong. The 2026-07 left-hand complaints were the mirrored-default
// regression (see _defaultCalib), not this constant.
const WIND_SIGN = { Left: -1, Right: -1 };
const WIND_THRESH = 0.3;     // |normalized winding| below this = hold last (edge-on)

// Deformation guard — anatomical clamps so the VRM hand can't skin into a collapsed/twisted
// pose when the orientation or curl is pushed to extremes (edge-on palm, hard fist, high gains).
// Limits are generous: inactive on normal poses, so the default render is unchanged. A cap also
// dodges the _aimBone antipodal singularity (target ≈ −rest → unstable 180° flip) on tight fists.
const FINGER_MAX = [100, 120, 100].map(d => d * Math.PI / 180); // Proximal, Intermediate, Distal
const THUMB_MAX  = [75, 85, 85].map(d => d * Math.PI / 180);
const WRIST_MAX  = 65 * Math.PI / 180;   // hand-vs-forearm deviation from its rest relationship

let oldLookTarget = new THREE.Euler();

export class SMPLXRetarget {
  constructor() {
    this._lastDebug = '';
    this._dc = 0;
    this._video = null;
    this._avatar = null;
    // Hysteresis counters per arm. Treated as "arm is on" whenever > 0.
    this._rightArmStreak = 0;
    this._leftArmStreak = 0;
    // Per-hand diagnostic (palm facing + curl), set by _driveHand.
    this._handDbg = { Right: null, Left: null };
    // Last stable palm-facing sign per hand (for the edge-on temporal hold).
    this._handFacing = { Right: 0, Left: 0 };
    // Optional per-signer finger calibration {Left|Right: {finger:[{rest,max}×3]}}.
    this._handCalib = null;
    // Body calibration baseline from "Calibrate (arms at sides)" — a STABLE reach
    // anchor (shoulder midpoint + width) so the mapping doesn't drift with the live
    // pose when an arm raises. Set via setCalibration(); null = use the live anchor.
    this._calib = null;
    // Per-hand calibration (Right/Left) — chirality means the left hand needs its own (often
    // mirrored) orientation. Each side stores a full set; _activate(side) loads one into the
    // working this._* scratch fields just before that side is driven (so _driveHand/_solveArmIK
    // stay unchanged). Seeded identical; the left is tuned via the Record-panel Left⇄Right selector.
    this._sideCal = { Right: this._defaultCalib('Right'), Left: this._defaultCalib('Left') };
    this._activate('Right');
  }

  /** A fresh per-side calibration set (the shipped baseline). smoothing 0 = crisp playback;
   *  the recorder applies the live smoothing per side via setHandTuning. */
  _defaultCalib(side = 'Right') {
    // IDENTICAL for both sides — measured, not assumed. The measured hand basis and the
    // avatar rig's rest basis are built with the SAME chirality-odd cross formula per
    // side, so they stay paired and the correction does NOT mirror (the earlier mirrored
    // Left defaults were a regression built on an anatomical-identity assumption the
    // rendered-thumb harness scenarios falsified — they put ~50° of error on the left).
    const m = 1;
    return {
      // rollDeg was -170 while the winding override wrongly negated the palm on every
      // confident frame (the -170 was eye-tuned to compensate that ~180° error). With the
      // flip-parity fix the negation is gone, so the equivalent look is -170+180 = +10.
      // (Saved user settings are migrated the same way in recorder.js / v2 app.js.)
      orientCalib: { rollDeg: 10 * m, pitchDeg: 10, yawDeg: 25 * m },
      // Gains were eye-tuned (0.70/0.80) while orientation bugs distorted the hand; on
      // ground-truth landmarks the direct-aim math reproduces bends exactly at 1.0
      // (test/fidelity_run.mjs shape scenarios). Sliders remain for per-user taste.
      curlGain: 1.00, spreadGain: 1.00, thumbDeg: 25 * m, thumbCurl: 1.00, thumbSpread: 1.00,
      reachDepth: 0.90, reachGain: 1.00, wristFlip: true, deformGuard: true,
      guardStrictness: 1, smoothing: 0, handLerp: HAND_LERP, armLerp: ARM_IK_LERP,
    };
  }

  /** Load a side's calibration into the active this._* scratch fields read by _driveHand /
   *  _solveArmIK. Called per-side each frame (in applyFromMediaPipe) before that side is driven. */
  _activate(side) {
    const c = this._sideCal[side]; if (!c) return;
    this._orientCalib = c.orientCalib;
    this._curlGain = c.curlGain; this._spreadGain = c.spreadGain; this._thumbDeg = c.thumbDeg;
    this._thumbCurl = c.thumbCurl; this._thumbSpread = c.thumbSpread;
    this._reachDepth = c.reachDepth; this._reachGain = c.reachGain;
    this._wristFlip = c.wristFlip; this._deformGuard = c.deformGuard; this._guardStrictness = c.guardStrictness;
    this._smoothing = c.smoothing; this._handLerp = c.handLerp; this._armLerp = c.armLerp;
    // (per-frame lerp fractions; call sites stretch them by _rateK via _dtLerp)
  }

  /** Per-hand tuning. `side` = 'Right'|'Left'; `c` = flat {rollDeg,…,smoothing} (any subset). */
  /** Stretch a per-frame lerp fraction to the actual call rate (see _rateK). */
  _dtLerp(a) { const k = this._rateK || 1; return k === 1 ? a : 1 - Math.pow(1 - a, k); }

  setHandTuning(side, c) {
    const cal = this._sideCal[side]; if (!cal || !c) return;
    const num = (v) => typeof v === 'number' && isFinite(v);
    for (const k of ['rollDeg', 'pitchDeg', 'yawDeg']) if (num(c[k])) cal.orientCalib[k] = c[k];
    for (const k of ['curlGain', 'spreadGain', 'thumbDeg', 'thumbCurl', 'thumbSpread', 'reachDepth', 'reachGain', 'guardStrictness']) if (num(c[k])) cal[k] = c[k];
    if (typeof c.wristFlip === 'boolean') cal.wristFlip = c.wristFlip;
    if (typeof c.deformGuard === 'boolean') cal.deformGuard = c.deformGuard;
    if (num(c.smoothing)) { cal.smoothing = clampNum(c.smoothing, 0, 1); const k = 1 - 0.8 * cal.smoothing; cal.handLerp = HAND_LERP * k; cal.armLerp = ARM_IK_LERP * k; }
  }

  /** Per-hand orientation metrics + PER-SIDE calibration, for HUD / dumps / screenshots. */
  getMetrics() {
    const cm = (c) => ({
      rollDeg: c.orientCalib.rollDeg, pitchDeg: c.orientCalib.pitchDeg, yawDeg: c.orientCalib.yawDeg,
      curlGain: c.curlGain, spreadGain: c.spreadGain, thumbDeg: c.thumbDeg,
      thumbCurl: c.thumbCurl, thumbSpread: c.thumbSpread, reachDepth: c.reachDepth, reachGain: c.reachGain,
      wristFlip: c.wristFlip, deformGuard: c.deformGuard, guardStrictness: c.guardStrictness, smoothing: c.smoothing,
    });
    return {
      Right: this._handDbg.Right, Left: this._handDbg.Left,
      calibration: { Right: cm(this._sideCal.Right), Left: cm(this._sideCal.Left) },
    };
  }
  reset() {
    oldLookTarget = new THREE.Euler();
    this._rightArmStreak = 0;
    this._leftArmStreak = 0;
    // Clip boundary = new input stream: drop the One-Euro state + frame clock, or the
    // first frames of every playback/preview/recording get dragged from the previous
    // stream's final pose (player.js and recorder.js call reset() at exactly these points).
    this._inFilt = null;
    this._lastApplyMs = 0;
  }

  /** Per-signer finger calibration (open→fist range), or null to use defaults.
   *  Keyed by retarget side ('Left'/'Right'); see recorder.js hand calibration. */
  setHandCalibration(calib) { this._handCalib = calib || null; }

  /** Per-finger joint angles (rad) [proximal, intermediate, distal] from a hand's
   *  21 world landmarks. Shared by the live curl and the calibration capture. */
  _fingerJointAngles(world) {
    const P = (i) => new THREE.Vector3(world[i].x, world[i].y, world[i].z);
    const ja = (a, b, c) => {
      const u = P(b).sub(P(a)), v = P(c).sub(P(b));
      if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return 0;
      return Math.acos(clampNum(u.normalize().dot(v.normalize()), -1, 1));
    };
    const out = {};
    for (const f of FINGER_NAMES) {
      const k = FINGER_SEG[f];
      out[f] = [ja(k[0], k[1], k[2]), ja(k[1], k[2], k[3]), ja(k[2], k[3], k[4])];
    }
    return out;
  }

  /** Measure finger angles for whichever hands are present, routed to the same
   *  retarget sides _driveHand uses. Returns {Left, Right} (null where absent). */
  fingerAnglesFromResults(results) {
    // Same-side routing, matching applyFromMediaPipe (Right rig <- results.right*).
    // This was crossed, so any per-signer finger calibration captured through it
    // measured the OTHER hand.
    const map = { Right: results.rightHandWorldLandmarks, Left: results.leftHandWorldLandmarks };
    const out = { Left: null, Right: null };
    for (const side of ['Left', 'Right']) {
      const w = map[side];
      if (w && w.length >= 21) out[side] = this._fingerJointAngles(w);
    }
    return out;
  }

  /** Input One-Euro de-jitter on/off (default on). Harness uses this to A/B noise. */
  setInputFilter(on) { this._inputFilter = on !== false; if (!this._inputFilter) this._inFilt = null; }

  /** Caller wires up a video element (recorder) or null (viewer). */
  setVideo(video) { this._video = video || null; }

  /** Avatar instance so we can poke its rest-rebias watchdog. */
  setAvatar(avatar) { this._avatar = avatar || null; }

  _rigRotation(vrm, name, rotation, dampener = 1, lerpAmount = 0.3) {
    if (!vrm || !rotation) return;
    const Part = vrm.humanoid.getBoneNode(THREE.VRMSchema.HumanoidBoneName[name]);
    if (!Part) return;
    const euler = new THREE.Euler(
      (rotation.x || 0) * dampener,
      (rotation.y || 0) * dampener,
      (rotation.z || 0) * dampener,
      rotation.rotationOrder || "XYZ"
    );
    const quaternion = new THREE.Quaternion().setFromEuler(euler);
    Part.quaternion.slerp(quaternion, lerpAmount);
  }

  _rigPosition(vrm, name, position, dampener = 1, lerpAmount = 0.3) {
    if (!vrm || !position) return;
    const Part = vrm.humanoid.getBoneNode(THREE.VRMSchema.HumanoidBoneName[name]);
    if (!Part) return;
    const vector = new THREE.Vector3(
      (position.x || 0) * dampener,
      (position.y || 0) * dampener,
      (position.z || 0) * dampener
    );
    Part.position.lerp(vector, lerpAmount);
  }

  _countVisible(landmarks, thresh = POSE_VIS_THRESH) {
    let n = 0;
    for (const lm of landmarks) {
      if (lm && (lm.visibility === undefined || lm.visibility >= thresh)) n++;
    }
    return n;
  }

  _rigFace(vrm, riggedFace) {
    if (!vrm || !riggedFace) return;
    this._rigRotation(vrm, "Neck", riggedFace.head, 0.7, 0.3);
    const Blendshape = vrm.blendShapeProxy;
    const PresetName = THREE.VRMSchema.BlendShapePresetName;
    if (!Blendshape) return;

    riggedFace.eye.l = lerp(clamp(1 - riggedFace.eye.l, 0, 1), Blendshape.getValue(PresetName.Blink), 0.5);
    riggedFace.eye.r = lerp(clamp(1 - riggedFace.eye.r, 0, 1), Blendshape.getValue(PresetName.Blink), 0.5);
    riggedFace.eye = Kalidokit.Face.stabilizeBlink(riggedFace.eye, riggedFace.head.y);
    Blendshape.setValue(PresetName.Blink, riggedFace.eye.l);

    Blendshape.setValue(PresetName.I, lerp(riggedFace.mouth.shape.I, Blendshape.getValue(PresetName.I), 0.5));
    Blendshape.setValue(PresetName.A, lerp(riggedFace.mouth.shape.A, Blendshape.getValue(PresetName.A), 0.5));
    Blendshape.setValue(PresetName.E, lerp(riggedFace.mouth.shape.E, Blendshape.getValue(PresetName.E), 0.5));
    Blendshape.setValue(PresetName.O, lerp(riggedFace.mouth.shape.O, Blendshape.getValue(PresetName.O), 0.5));
    Blendshape.setValue(PresetName.U, lerp(riggedFace.mouth.shape.U, Blendshape.getValue(PresetName.U), 0.5));

    const lookTarget = new THREE.Euler(
      lerp(oldLookTarget.x, riggedFace.pupil.y, 0.4),
      lerp(oldLookTarget.y, riggedFace.pupil.x, 0.4),
      0, "XYZ"
    );
    oldLookTarget.copy(lookTarget);
    if (vrm.lookAt && vrm.lookAt.applyer) vrm.lookAt.applyer.lookAt(lookTarget);
  }

  _writeHand(vrm, side, riggedHand) {
    if (!riggedHand) return;
    const wrist = riggedHand[`${side}Wrist`];
    if (wrist) {
      // Drop the pose-solver's wrist z. It was a Kalidokit-demo
      // pattern that only held up when the full body was in frame.
      // In laptop crops, pose-z is hallucinated and tilts the palm
      // onto a bad plane, so open hands render as curls. Use only
      // the hand-solve's own xyz.
      this._rigRotation(vrm, `${side}Hand`, {
        x: wrist.x,
        y: wrist.y,
        z: wrist.z ?? 0,
      });
    }
    for (const f of FINGER_NAMES) {
      for (const s of FINGER_SEGMENTS) {
        const key = `${side}${f}${s}`;
        const rot = riggedHand[key];
        if (rot) this._rigRotation(vrm, key, rot);
      }
    }
  }

  /**
   * Aim a bone so that the local direction toward its child (`restAxisLocal`,
   * the fixed bind offset, measured once in avatar.js) points along a desired
   * WORLD direction. We solve for the bone's LOCAL quaternion:
   *   worldChildDir = parentWorldQ · boneQ · restAxisLocal
   * so   boneQ = setFromUnitVectors(restAxisLocal, parentWorldQ⁻¹ · worldDir).
   * The minimal-rotation result ignores roll about the bone axis (wrist roll
   * comes from the hand solve), which is exactly what we want for placement.
   */
  _aimBone(bone, restAxisLocal, worldDir, lerpAmount = ARM_IK_LERP, maxAngle = Math.PI) {
    if (!bone || !bone.parent) return;
    if (worldDir.lengthSq() < 1e-9) return;
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const localDir = worldDir.clone().applyQuaternion(pq.invert());
    if (localDir.lengthSq() < 1e-9) return;
    localDir.normalize();
    let q = new THREE.Quaternion().setFromUnitVectors(restAxisLocal, localDir);
    if (maxAngle < Math.PI) {   // clamp the swing from rest to an anatomical max (deformation guard)
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (ang > maxAngle) q = new THREE.Quaternion().slerp(q, maxAngle / ang);
    }
    bone.quaternion.slerp(q, lerpAmount);
  }

  /** Orthonormal-basis quaternion: Y = finger axis, Z = palm normal, X = Y×Z. */
  _basisQuat(fingerAxis, palmAxis) {
    const Y = fingerAxis.clone().normalize();
    const X = new THREE.Vector3().crossVectors(Y, palmAxis).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    const m = new THREE.Matrix4().makeBasis(X, Y, Z);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }

  /** Orient the Hand bone so its rest (finger,palm) basis maps to the desired
   *  WORLD (finger,palm) basis — i.e. palm faces where the real palm faces. */
  _orientHand(bone, restFinger, restPalm, worldFinger, worldPalm, lerp = HAND_LERP) {
    if (!bone || !bone.parent) return;
    if (worldFinger.lengthSq() < 1e-9 || worldPalm.lengthSq() < 1e-9) return;
    const inv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    const tFinger = worldFinger.clone().applyQuaternion(inv);
    const tPalm = worldPalm.clone().applyQuaternion(inv);
    const qRest = this._basisQuat(restFinger, restPalm);
    const qTarget = this._basisQuat(tFinger, tPalm);
    const local = qTarget.multiply(qRest.invert());
    bone.quaternion.slerp(local, lerp);
  }

  /**
   * Drive a hand from MediaPipe HandLandmarker 3D WORLD landmarks (21 pts,
   * metric). Palm facing comes from the finger-direction + palm-normal basis;
   * each finger bone is aimed along its world-landmark segment, so curl + splay
   * reproduce at full magnitude. `world` is an array of {x,y,z} (MP-world).
   */
  _driveHand(vrm, side, world) {
    const rig = this._avatar?.handRig?.[side];
    if (!rig || !world || world.length < 21) return;
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const hand = vrm.humanoid.getBoneNode(BN[`${side}Hand`]);
    if (!hand) return;
    // Wrist-rotation toggle: the hand mapping is a reflection (HAND_W det = -1), which reverses
    // the SENSE of wrist twist (user CCW → avatar CW). `_wristFlip` flips the x-axis of the
    // mapping, mirroring the hand so the twist follows the other way (also swaps thumb side —
    // they're coupled). det is recomputed so the palm-normal + finger across stay consistent.
    const wx = this._wristFlip ? -HAND_WX : HAND_WX;
    const det = wx * HAND_WY * HAND_WZ;
    const V = (i) => new THREE.Vector3(world[i].x * wx, world[i].y * HAND_WY, world[i].z * HAND_WZ);

    // Hand orientation (palm facing). Compute fingerDir + palmNormal FIRST so the forearm
    // can be oriented palm-aware (matching the hand's roll → no wrist twist).
    const wrist = V(0);
    const fingerDir = V(9).sub(wrist).normalize();
    // Same formula as avatar.js handRig.palmAxis (finger × (little-MCP − index-MCP)),
    // with the reflection-determinant correction so it matches the rest basis.
    const palmNormal = new THREE.Vector3()
      .crossVectors(fingerDir, V(17).sub(V(5))).multiplyScalar(det).normalize();

    // Stabilise palm-vs-back against MediaPipe's depth flip using the 2D knuckle
    // winding (world x/y don't flip with depth). Normalised so |wind| ∈ [0,1].
    const a = V(5).sub(V(0)), b = V(17).sub(V(0));
    const windRaw = a.x * b.y - a.y * b.x;
    const wind = windRaw / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) + 1e-9);
    // Only correct the palm-vs-back SIGN when the winding is CONFIDENT (|wind|>thresh).
    // In the edge-on dead zone the raw 3D normal is reliable (and small in z anyway), so
    // applying a STALE held sign there pins the palm to the wrong side as it rotates past
    // edge-on — the "B palm faces the wrong way" bug. Verified on handdump_14 via
    // tools/palm_facing_probe.mjs: 21 dead-zone frames where the old persistent hold
    // negated a CORRECT raw normal (and 0 confident frames change), so trust the geometry
    // there. The winding override still protects against MP-z flips when it's confident.
    if (Math.abs(wind) > WIND_THRESH) {
      // WIND_SIGN was pinned (tools/palm_facing_probe.mjs, hand_replay.mjs) in the
      // UN-flipped frame (wx = HAND_WX). wristFlip negates `wind` (windRaw is odd in wx)
      // but NOT palmNormal.z (cross-z and det both flip, cancelling) — so the pinned sign
      // must be re-parified under flip. Without this, the override negated a CORRECT
      // normal on every confident frame and the hand+forearm barrel-rolled ~180° at each
      // |wind|=WIND_THRESH crossing (the across-body "awkward rotation" bug; measured as
      // 178° steps in test/fidelity_run.mjs yaw/roll sweeps).
      const flipPar = this._wristFlip ? -1 : 1;
      this._handFacing[side] = Math.sign(wind) * flipPar * WIND_SIGN[side];
      if (Math.sign(palmNormal.z || 0) !== this._handFacing[side]) palmNormal.negate();
    }
    // Raw (post-winding, PRE-calibration) measured basis — the auto-tune wizard solves the
    // 3-DOF calibration offset from this while the signer holds a known flat-palm pose.
    const qRaw = this._basisQuat(fingerDir, palmNormal);
    (this._rawBasis ||= {})[side] = [qRaw.x, qRaw.y, qRaw.z, qRaw.w];

    // Manual 3-DOF orientation calibration on the measured hand basis (X=across, Y=finger,
    // Z=palm normal): roll about Y, pitch about X (tilt forward/back), yaw about Z. Applied
    // here (before qHandWorld) so the forearm + finger frame follow. Default {180,0,0} is a
    // π rotation about Y → fingerDir unchanged, palmNormal flipped = exactly the old negate.
    const oc = this._orientCalib;
    if (oc.rollDeg || oc.pitchDeg || oc.yawDeg) {
      const D = Math.PI / 180;
      const qC = this._basisQuat(fingerDir, palmNormal).multiply(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((oc.pitchDeg || 0) * D, (oc.rollDeg || 0) * D, (oc.yawDeg || 0) * D, 'YXZ')));
      fingerDir.set(0, 1, 0).applyQuaternion(qC).normalize();
      palmNormal.set(0, 0, 1).applyQuaternion(qC).normalize();
    }

    // Desired hand WORLD orientation (parent-independent): basisQuat(fingerDir,palmNormal)·qRest⁻¹.
    const qRestHand = this._basisQuat(rig.fingerAxis, rig.palmAxis);
    const qHandWorld = this._basisQuat(fingerDir, palmNormal).multiply(qRestHand.clone().invert());

    // Orient the FOREARM so the Hand sits at its BIND relationship — fixes BOTH the wrist
    // bend AND the TWIST: lowerArm_world = qHandWorld · handBindLocal⁻¹ ⇒ hand_local ≈ bind.
    // (Old code aimed the forearm roll-free, matching only fingerDir, so the hand barrel-
    // rolled ~120° about the forearm — measured on dump_12. Verified with hand_fk_preview.)
    const lowerArm = vrm.humanoid.getBoneNode(BN[`${side}LowerArm`]);
    const armRig = this._avatar?.armRig?.[side];
    let wristBend = 0;
    if (lowerArm && lowerArm.parent && armRig && armRig.handBindLocal) {
      const qLowerWorld = qHandWorld.clone().multiply(armRig.handBindLocal.clone().invert());
      // Split the hand-vs-IK disagreement between forearm swing and wrist bend, position-first:
      // aim the forearm at the IK's own elbow→target direction (wrist lands ON the tracked dot),
      // lean it STRAIGHT_GAIN of the way back toward the hand direction for a natural look, let
      // the wrist joint carry the rest up to WRIST_BEND_MAX, and only concede position beyond
      // that. Twist (pronation) still propagates to the forearm — the swing rotation is applied
      // about cross(dHand,dIK), which preserves the roll component of qLowerWorld.
      const dbgIK = this._armDbg?.[side];
      if (dbgIK && dbgIK.dc === this._dc && armRig.lowerRestAxis) {
        const elbowW = lowerArm.getWorldPosition(new THREE.Vector3());
        const dIK = new THREE.Vector3(dbgIK.target[0], dbgIK.target[1], dbgIK.target[2]).sub(elbowW);
        const dHand = armRig.lowerRestAxis.clone().applyQuaternion(qLowerWorld);
        if (dIK.lengthSq() > 1e-9 && dHand.lengthSq() > 1e-9) {
          dIK.normalize(); dHand.normalize();
          const ang = Math.acos(clampNum(dHand.dot(dIK), -1, 1));
          const bendMax = WRIST_MAX; // stay inside the wrist deform-guard limit
          const swingFromIK = Math.min(ang * STRAIGHT_GAIN + Math.max(0, ang * (1 - STRAIGHT_GAIN) - bendMax), WRIST_SWING_CAP);
          const axis = new THREE.Vector3().crossVectors(dHand, dIK);
          if (axis.lengthSq() > 1e-9) {
            // Rotate the hand-slaved forearm from dHand all the way to dIK, minus the swing we
            // intentionally leave toward the hand.
            qLowerWorld.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), Math.max(0, ang - swingFromIK)));
          }
        }
      }
      const pInv = lowerArm.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      lowerArm.quaternion.slerp(pInv.multiply(qLowerWorld), this._dtLerp(this._armLerp));
      lowerArm.updateWorldMatrix(true, true); // refresh the Hand (child) world transform too
      const res = hand.getWorldPosition(new THREE.Vector3())
        .sub(lowerArm.getWorldPosition(new THREE.Vector3()));
      if (res.lengthSq() > 1e-9) wristBend = Math.acos(clampNum(fingerDir.dot(res.normalize()), -1, 1)) * 180 / Math.PI;
    }

    this._orientHand(hand, rig.fingerAxis, rig.palmAxis, fingerDir, palmNormal, this._dtLerp(this._handLerp));
    hand.updateWorldMatrix(true, true);

    // Wrist deformation guard: cap the hand's rotation away from its rest relationship to the
    // forearm (hand.quaternion is hand-local relative to LowerArm = same frame as handBindLocal),
    // so the VRM hand can't skin into a collapsed/twisted pose. Only fires when the forearm hasn't
    // absorbed the twist (the deformation case); normal signs stay under the cap.
    if (this._deformGuard && armRig?.handBindLocal) {
      const wristMax = WRIST_MAX + (Math.PI - WRIST_MAX) * (1 - this._guardStrictness); // guard strength
      const dev = armRig.handBindLocal.clone().invert().multiply(hand.quaternion);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(dev.w)));
      if (ang > wristMax) {
        // Converge toward the clamped pose rather than hard-copying it: when the bend
        // oscillates around the limit, the hard rewrite read as a notchy "catch".
        const clamped = armRig.handBindLocal.clone().multiply(new THREE.Quaternion().slerp(dev, wristMax / ang));
        hand.quaternion.slerp(clamped, 0.65);
        hand.updateWorldMatrix(true, true);
      }
    }

    // Fingers + thumb: DIRECT HAND-LOCAL AIM. Aim each bone so it points along its
    // real landmark segment, re-expressed through the avatar hand's frame — so curl,
    // splay and (critically) thumb opposition reproduce exactly, with no per-joint
    // flex axis and no tuning gain. The segment dirs are taken relative to the same
    // (finger, palm) basis the hand was just oriented to, so the digits follow the
    // straightened/oriented wrist.
    const segNames = ['Proximal', 'Intermediate', 'Distal'];
    // Measured hand basis (same _basisQuat convention as the avatar rest basis:
    // Y = finger axis, X = Y×palm, Z = X×Y). fingerDir/palmNormal are the vectors
    // _orientHand aligned the hand to (already mapped into avatar space by V()).
    const Ym = fingerDir.clone().normalize();
    const Xm = new THREE.Vector3().crossVectors(Ym, palmNormal).normalize();
    const Zm = new THREE.Vector3().crossVectors(Xm, Ym).normalize();
    // Avatar hand rest basis carried into WORLD by the Hand bone's orientation.
    const Qh = hand.getWorldQuaternion(new THREE.Quaternion());
    const Yr = rig.fingerAxis.clone().normalize();
    const Xr = new THREE.Vector3().crossVectors(Yr, rig.palmAxis).normalize();
    const Zr = new THREE.Vector3().crossVectors(Xr, Yr).normalize();
    const Xa = Xr.applyQuaternion(Qh), Ya = Yr.applyQuaternion(Qh), Za = Zr.applyQuaternion(Qh);
    // Re-express a mapped-world segment dir into the avatar hand frame (a digit bent
    // θ off the palm in the real hand bends θ off the avatar palm — same intrinsics).
    // The ACROSS (X) component carries the chirality flip from the V() point-inversion
    // (HAND_W = -1,-1,-1, det = HAND_DET): palmNormal is sign-corrected by HAND_DET but
    // the across axis is not, so without this factor splay inverts (spread↔together) and
    // the thumb folds the wrong way. Verified visually with tools/hand_fk_preview.mjs.
    // User shaping: spread scales the across (splay) term, curl the palm-normal (bend) term.
    // The THUMB has its OWN gains (decoupled) so finger tuning doesn't drag it.
    const toHand = (d, sg, cg) => new THREE.Vector3()
      .addScaledVector(Xa, det * d.dot(Xm) * sg)
      .addScaledVector(Ya, d.dot(Ym))
      .addScaledVector(Za, d.dot(Zm) * cg);
    const thumbRad = this._thumbDeg * Math.PI / 180; // thumb abduction about the palm normal (Za)
    // Guard strength scales the clamp limits: 1 = base (tight), 0 = effectively off (→ π).
    const loosen = (base) => base + (Math.PI - base) * (1 - this._guardStrictness);
    for (const f of FINGER_NAMES) {
      const arr = rig.fingers[f];
      if (!arr) continue;
      const k = FINGER_SEG[f]; // [wrist, mcp, pip, dip, tip]
      const isThumb = f === 'Thumb';
      const sg = isThumb ? this._thumbSpread : this._spreadGain;
      const cg = isThumb ? this._thumbCurl : this._curlGain;
      const swing = (isThumb && thumbRad) ? thumbRad : 0;
      for (let i = 0; i < 3; i++) {
        const fr = arr[i];
        if (!fr) continue;
        const bone = vrm.humanoid.getBoneNode(BN[`${side}${f}${segNames[i]}`]);
        if (!bone) continue;
        const d = V(k[i + 2]).sub(V(k[i + 1])); // real segment: parent→child landmark
        if (d.lengthSq() < 1e-12) continue;
        const dir = toHand(d.normalize(), sg, cg);
        if (swing) dir.applyAxisAngle(Za, swing); // swing the thumb across the palm plane
        const maxA = this._deformGuard ? loosen((isThumb ? THUMB_MAX : FINGER_MAX)[i]) : Math.PI;
        this._aimBone(bone, fr.fwdLocal, dir, this._dtLerp(this._handLerp), maxA);
        bone.updateWorldMatrix(true, false); // so the next bone in the chain aims off it
      }
    }

    // Diagnostic: palm facing (+1 = toward camera) + mean finger / thumb curl (deg).
    const angDeg = this._fingerJointAngles(world);
    const meanDeg = (names) => {
      let s = 0, n = 0;
      for (const nm of names) for (const a of angDeg[nm]) { s += a; n++; }
      return n ? (s / n) * 180 / Math.PI : 0;
    };
    // Wrist TWIST: how much the hand is rolled about the forearm axis relative to the
    // LowerArm (swing-twist decomposition). At bend≈0 this is the remaining "knot".
    let roll = 0;
    if (lowerArm && armRig) {
      const qL = lowerArm.getWorldQuaternion(new THREE.Quaternion()).invert()
        .multiply(hand.getWorldQuaternion(new THREE.Quaternion()));
      const ax = armRig.lowerRestAxis; // forearm (twist) axis in LowerArm-local frame
      const d = qL.x * ax.x + qL.y * ax.y + qL.z * ax.z;
      const tw = new THREE.Quaternion(ax.x * d, ax.y * d, ax.z * d, qL.w).normalize();
      roll = 2 * Math.acos(Math.min(1, Math.abs(tw.w))) * 180 / Math.PI;
      if (roll > 180) roll = 360 - roll;
    }
    this._handDbg[side] = {
      facing: +palmNormal.z.toFixed(2),
      palmN: [+palmNormal.x.toFixed(2), +palmNormal.y.toFixed(2), +palmNormal.z.toFixed(2)],
      tiltZ: +fingerDir.z.toFixed(2),
      curl: Math.round(meanDeg(['Index', 'Middle', 'Ring', 'Little'])),
      thumb: Math.round(meanDeg(['Thumb'])), bend: Math.round(wristBend), roll: Math.round(roll),
      wind: +wind.toFixed(2),
    };
  }

  /** User body anchor (image space) for framing-invariant wrist mapping:
   *  prefer the shoulder midpoint + shoulder width; fall back to the nose. */
  /** Store the "Calibrate (arms at sides)" baseline so the reach anchor is STABLE
   *  (vs. recomputing from the jittery live pose every frame). Pass null to clear. */
  setCalibration(c) {
    this._calib = (c && c.shoulderMid && c.shoulderWidth > 0.05)
      ? { x: c.shoulderMid[0], y: c.shoulderMid[1], scale: c.shoulderWidth }
      : null;
  }

  _bodyAnchor(pose2D) {
    // Calibrated anchor wins: a fixed shoulder midpoint + width captured at rest, so the
    // reach reference doesn't drift when the live pose shifts (raised arm, jitter).
    if (this._calib) return this._calib;
    const L = pose2D?.[11], R = pose2D?.[12];
    if (L && R && (L.visibility ?? 1) > 0.3 && (R.visibility ?? 1) > 0.3) {
      const raw = {
        x: (L.x + R.x) / 2,
        y: (L.y + R.y) / 2,
        scale: Math.hypot(L.x - R.x, L.y - R.y) || 0.2,
      };
      // EMA-smooth the live anchor: relX/relY are DIVIDED by anchor.scale, so raw
      // per-frame shoulder jitter (and torso-yaw foreshortening while reaching across)
      // was amplified straight into both arm targets. 0.15/frame ≈ 300 ms at track rate.
      const e = this._anchorEma;
      this._anchorEma = e ? {
        x: e.x + (raw.x - e.x) * 0.15,
        y: e.y + (raw.y - e.y) * 0.15,
        scale: e.scale + (raw.scale - e.scale) * 0.15,
      } : raw;
      return this._anchorEma;
    }
    // Shoulder dropout (typically the crossing hand occluding one): HOLD the last good
    // anchor instead of snapping to the nose fallback, whose hardcoded 0.22 scale
    // re-scaled every target by ~1.6× mid-sign (the cross-occlusion wrist lurch).
    if (this._anchorEma) return this._anchorEma;
    const nose = pose2D?.[0];
    if (nose) return { x: nose.x, y: nose.y + 0.18, scale: 0.22 };
    return null;
  }

  /**
   * Hands-first 2-bone IK: reach `side`'s hand to the tracked wrist's screen
   * position. Uses ONLY reliable signals — the 2D wrist (x,y in [0..1]) and
   * the avatar's own shoulder world position — never a guessed arm depth.
   * `screen` is any landmark with {x,y}: the hand's wrist, or a pose wrist.
   */
  _solveArmIK(vrm, side, screen, anchor, skipForearm = false, aux = null) {
    const rig = this._avatar?.armRig?.[side];
    if (!rig || !screen) return false;
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const ua = vrm.humanoid.getBoneNode(BN[`${side}UpperArm`]);
    const la = vrm.humanoid.getBoneNode(BN[`${side}LowerArm`]);
    if (!ua || !la) return false;

    // Avatar shoulder anchors + width from its current pose.
    const Rs = vrm.humanoid.getBoneNode(BN.RightUpperArm).getWorldPosition(new THREE.Vector3());
    const Ls = vrm.humanoid.getBoneNode(BN.LeftUpperArm).getWorldPosition(new THREE.Vector3());
    const mid = Rs.clone().add(Ls).multiplyScalar(0.5);
    const avShoulderW = Rs.distanceTo(Ls) || 0.25;

    let T;
    let depthSW = this._reachDepth;   // hoisted: the elbow pole below tracks the real target depth
    if (anchor) {
      // BODY-RELATIVE: wrist position relative to the user's shoulders, in
      // shoulder-width units → same offset (scaled) from the avatar's
      // shoulders. Framing-invariant. Image y is down, so invert for world up.
      const relX = (screen.x - anchor.x) / anchor.scale;
      const relY = (screen.y - anchor.y) / anchor.scale;
      // Across-body targets sit NEAR the chest in reality (the hand comes in, not out),
      // but the fixed signing-plane depth saturated the reach — the arm went stiff-
      // straight and the elbow solve's sqrt amplified target jitter near full extension.
      // Shrink depth as the target crosses the midline toward the far side.
      const xOffSW = relX * this._reachGain * MIRROR_X;   // shoulder-width units from mid
      const outSign = Math.sign((side === "Right" ? Rs.x : Ls.x) - mid.x) || (side === "Right" ? 1 : -1);
      const crossSW = Math.max(0, -xOffSW * outSign);     // how far PAST the midline (far side)
      const depthScale = clampNum(1 - 0.45 * crossSW, 0.55, 1);
      // TRUE DEPTH (blend): the 3D pose carries a real metric wrist z. Positive zOff =
      // wrist toward the camera vs the shoulder midpoint, in USER shoulder-widths — the
      // same unit as the synthetic plane, so the two blend directly. Gated on the 2D
      // wrist's visibility (za is hallucinated exactly when the wrist is occluded).
      depthSW = this._reachDepth * depthScale;
      const wIdx = side === "Right" ? 16 : 15;
      const zw = aux?.za?.[wIdx], zs1 = aux?.za?.[11], zs2 = aux?.za?.[12];
      // Absent visibility = "no signal, trust it" (?? 1) — the v2 adapter STRIPS an
      // all-zero visibility field by contract; defaulting to 0 here silently disabled
      // true depth on that whole pipeline.
      const wVis = aux?.pose2D?.[wIdx]?.visibility ?? 1;
      if (zw && zs1 && zs2 && wVis >= WRIST_VIS_THRESH) {
        const swWorld = Math.hypot(zs1.x - zs2.x, zs1.y - zs2.y, zs1.z - zs2.z);
        const zOff = swWorld > 1e-6 ? ((zs1.z + zs2.z) / 2 - zw.z) / swWorld : NaN;
        if (isFinite(zOff)) {
          depthSW = depthSW * (1 - DEPTH3D_WEIGHT) + clampNum(zOff, -0.2, 1.8) * DEPTH3D_WEIGHT;
          depthSW = clampNum(depthSW, 0.15, 2.0);
        }
      }
      T = new THREE.Vector3(
        mid.x + xOffSW * avShoulderW,
        mid.y - relY * avShoulderW * this._reachGain,
        mid.z + avShoulderW * depthSW * FRONT_Z,
      );
    } else {
      // Absolute fallback (no shoulders/nose): image-centered box.
      T = new THREE.Vector3(
        mid.x + (0.5 - screen.x) * avShoulderW * BOX_W * -MIRROR_X,
        mid.y + (0.5 - screen.y) * avShoulderW * BOX_H,
        mid.z + avShoulderW * this._reachDepth * FRONT_Z,
      );
    }

    // The IK's own target: consumed by _driveHand's forearm split (fresh-frame check via
    // dc) and by the fidelity harness (|wrist−T| = the "reaches the dot" score).
    (this._armDbg ||= {})[side] = { target: [T.x, T.y, T.z], shoulderW: avShoulderW, dc: this._dc };

    const S = (side === "Right" ? Rs : Ls).clone();
    const { L1, L2, upperRestAxis, lowerRestAxis } = rig;

    // Planar 2-bone IK (law of cosines). Reach capped at 95% extension: at full
    // extension h = sqrt(L1²−a²) → 0 with infinite slope, so millimetre target jitter
    // became centimetre elbow swings; the cap keeps a slight bend and a bounded slope.
    const toT = T.clone().sub(S);
    const d = clampNum(toT.length(), Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.95);
    const axis = toT.lengthSq() > 1e-9 ? toT.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const a = (d * d + L1 * L1 - L2 * L2) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // Pole hint: prefer the signer's REAL tracked elbow (pose 14 = right, 13 = left),
    // mapped body-relative exactly like the wrist target, at half the target depth —
    // the avatar's elbow then matches the signer's actual arm posture (raised elbow,
    // chicken-wing, etc.) instead of a fixed guess. Falls back to the synthetic hint
    // when the elbow isn't visible.
    let pole = null;
    const eIdx = side === "Right" ? 14 : 13;
    const e2 = aux?.pose2D?.[eIdx];
    if (anchor && e2 && (e2.visibility ?? 1) >= 0.5) {   // absent visibility = trust (adapter contract)
      const exSW = ((e2.x - anchor.x) / anchor.scale) * this._reachGain * MIRROR_X;
      const eySW = ((e2.y - anchor.y) / anchor.scale) * this._reachGain;
      const E2 = new THREE.Vector3(
        mid.x + exSW * avShoulderW,
        mid.y - eySW * avShoulderW,
        mid.z + avShoulderW * 0.5 * depthSW * FRONT_Z,
      );
      const cand = E2.sub(S.clone().add(T).multiplyScalar(0.5));
      if (cand.lengthSq() > 1e-6) pole = cand;
    }
    if (!pole) {
      // Synthetic fallback: elbow bends down, toward the camera, and outward per side.
      const outX = (side === "Right" ? Rs.x : Ls.x) - mid.x;
      pole = new THREE.Vector3(Math.sign(outX || (side === "Right" ? 1 : -1)) * 0.3, -1, 0.4 * FRONT_Z);
    }
    let perp = pole.sub(axis.clone().multiplyScalar(pole.dot(axis)));
    if (perp.lengthSq() < 1e-9) perp = new THREE.Vector3(0, -1, 0);
    perp.normalize();
    const E = S.clone().add(axis.clone().multiplyScalar(a)).add(perp.multiplyScalar(h));

    // Aim upper arm S→E (places the elbow). When a 3D hand drives this side,
    // _driveHand owns the forearm (re-aims it to follow the hand); aiming it at T
    // here too would make the two slerps fight and leave the wrist knotted, so skip it.
    this._aimBone(ua, upperRestAxis, E.clone().sub(S), this._dtLerp(this._armLerp));
    ua.updateWorldMatrix(true, true);
    if (!skipForearm) {
      const Ew = la.getWorldPosition(new THREE.Vector3());
      this._aimBone(la, lowerRestAxis, T.clone().sub(Ew), this._dtLerp(this._armLerp)); // forearm fallback when no 3D hand
    }
    return true;
  }

  applyFromMediaPipe(vrm, results) {
    if (!vrm) return;
    let riggedPose, riggedLeftHand, riggedRightHand, riggedFace;

    this._dc++;
    // Rate compensation (stretch-only): the slerp constants were tuned at ~30 fps, but v2
    // applies results at the tracking rate (~20-24 fps), silently over-smoothing every time
    // constant ~1.3-1.5x. Convert per-call lerp fractions to per-TIME: a = 1-(1-a)^(dt/33ms).
    // Clamped to [1,3]: only stretch for slow call rates — never shrink for fast repeated
    // calls (replay/preview apply frames back-to-back and must still converge).
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._rateK = this._lastApplyMs ? clampNum((nowMs - this._lastApplyMs) / 33.33, 1, 3) : 1;
    this._lastApplyMs = nowMs;

    // Input de-jitter (One-Euro, speed-adaptive): filter the landmarks every bone
    // consumes BEFORE any math — still hands stop trembling without adding lag to
    // fast signs. dt uses the same clamped frame clock as the lerp compensation so
    // back-to-back replay applies still converge. setInputFilter(false) disables
    // (the harness A/Bs a raw run against a filtered one).
    if (this._inputFilter !== false) {
      const dtSec = (this._rateK || 1) / 30;
      const F = (this._inFilt ||= {
        rw: new LandmarkFilter(), lw: new LandmarkFilter(),
        rh: new LandmarkFilter(), lh: new LandmarkFilter(),   // 2D image hands: the ARM TARGET reads [0]
        pose: new LandmarkFilter(), za: new LandmarkFilter(),
      });
      // NON-MUTATING (shallow copy): the caller's results object stays RAW. The recorder
      // captures frames from it AFTER this call — recordings are the future ML dataset and
      // must remain raw sensor data, and replaying a recording must not double-filter.
      results = {
        ...results,
        rightHandWorldLandmarks: F.rw.apply(results.rightHandWorldLandmarks, dtSec),
        leftHandWorldLandmarks: F.lw.apply(results.leftHandWorldLandmarks, dtSec),
        rightHandLandmarks: F.rh.apply(results.rightHandLandmarks, dtSec),
        leftHandLandmarks: F.lh.apply(results.leftHandLandmarks, dtSec),
        poseLandmarks: F.pose.apply(results.poseLandmarks, dtSec),
        // Unconditional apply: a null za must still advance the filter's missed-frame
        // counter or stale state survives dropouts and drags the depth signal on
        // reappearance. Legacy builds exposing the world pose as `ea` funnel through
        // the same filter (consts below read za first).
        za: F.za.apply(results.za || results.ea || null, dtSec),
      };
    }

    const faceLandmarks = results.faceLandmarks;
    const pose3DLandmarks = results.za || results.ea;
    const pose2DLandmarks = results.poseLandmarks;
    // ANATOMICAL COPY (user chose "copy me, same actual hand"): the signer's OWN hand
    // drives the SAME-SIDE avatar hand — no mirror — so the thumb/handedness match.
    // Proven by chirality check: signer-right (+1) → avatar Right rig (+1); the old swap
    // sent it to the Left rig (−1) = the mirror. (tools/hand_fk_preview.mjs)
    const leftHandLandmarks = results.leftHandLandmarks;
    const rightHandLandmarks = results.rightHandLandmarks;
    const leftHandWorld = results.leftHandWorldLandmarks;
    const rightHandWorld = results.rightHandWorldLandmarks;

    const solveOpts = this._video
      ? { runtime: "mediapipe", video: this._video }
      : { runtime: "mediapipe" };


    if (faceLandmarks && faceLandmarks.length >= 468) {
      riggedFace = Kalidokit.Face.solve(faceLandmarks, solveOpts);
      if (riggedFace) this._rigFace(vrm, riggedFace);
    }

    const poseVisible = pose2DLandmarks
      ? this._countVisible(pose2DLandmarks) >= POSE_MIN_VISIBLE_LMS
      : false;

    // Raw per-frame "arm is trustworthy" signal. An arm activates ONLY when its
    // hand is actually detected (image or 3D world landmarks) — a bare pose
    // wrist must not raise the non-signing arm. Hysteresis (below) still
    // sustains an on-arm through brief hand dropouts.
    const handDetected = (lms) =>
      lms && this._countVisible(lms, 0) >= HAND_MIN_VISIBLE_LMS;
    const rawRightOk = handDetected(rightHandLandmarks) || (rightHandWorld?.length >= 21);
    const rawLeftOk  = handDetected(leftHandLandmarks)  || (leftHandWorld?.length >= 21);

    // Hands-interacting hold (see INTERACTION_HOLD_MAX above): closeness from the current
    // hand wrists, falling back to the last held targets so the signal survives the exact
    // frame a detection vanishes.
    const wRc = rightHandLandmarks?.[0] || this._lastTarget?.Right;
    const wLc = leftHandLandmarks?.[0] || this._lastTarget?.Left;
    const anchorScale = this._calib?.scale || this._anchorEma?.scale || 0.3;
    let handsClose = false;
    if (wRc && wLc) {
      const dSW = Math.hypot(wRc.x - wLc.x, wRc.y - wLc.y) / anchorScale;
      handsClose = this._handsClose ? dSW < HANDS_CLOSE_EXIT : dSW < HANDS_CLOSE_ENTER;
    }
    this._handsClose = handsClose;
    this._holdFrames ||= { Right: 0, Left: 0 };
    const holdSide = (side, rawOk) => {
      if (rawOk) { this._holdFrames[side] = 0; return false; }
      if (!handsClose || this._holdFrames[side] >= INTERACTION_HOLD_MAX) return false;
      this._holdFrames[side]++;
      return true;
    };
    const holdRight = holdSide('Right', rawRightOk);
    const holdLeft = holdSide('Left', rawLeftOk);

    // Hysteresis: fill the streak up to MAX when the raw signal is
    // good; decrement when it's bad. Arm is "on" whenever > 0.
    const bump = (streak, ok) => ok
      ? ARM_HYSTERESIS_FRAMES
      : Math.max(0, streak - 1);
    this._rightArmStreak = bump(this._rightArmStreak, rawRightOk || holdRight);
    this._leftArmStreak  = bump(this._leftArmStreak,  rawLeftOk || holdLeft);
    const signerRightArmOn = this._rightArmStreak > 0;
    const signerLeftArmOn  = this._leftArmStreak  > 0;

    // Torso (optional, lightly damped) — only when a full pose is present.
    // The avatar otherwise stays planted; arms below do NOT depend on this.
    if (poseVisible && pose3DLandmarks) {
      riggedPose = Kalidokit.Pose.solve(pose3DLandmarks, pose2DLandmarks, solveOpts);
      if (riggedPose) {
        this._rigRotation(vrm, "Hips", riggedPose.Hips.rotation, 0.15, 0.12);
        this._rigRotation(vrm, "Chest", riggedPose.Spine, 0.08, 0.12);
        this._rigRotation(vrm, "Spine", riggedPose.Spine, 0.12, 0.12);
      }
    }

    // ── Hands-first arm IK ──────────────────────────────────────────
    // Reach each hand to the tracked wrist's screen position. Prefer the
    // hand wrist (index 0); fall back to the pose wrist (15 = signer's
    // left, 16 = signer's right — same anatomical sides the swap assigns)
    // so the arm still tracks for a few frames if the fingers drop out.
    // Pose-wrist fallback indices follow the ANATOMICAL slot convention proven live
    // (signer raises right hand → results.rightHandLandmarks): MediaPipe pose 16 = the
    // signer's RIGHT wrist, 15 = LEFT. These were crossed (15/16 swapped), so during a
    // hand dropout the arm was yanked toward the signer's OTHER wrist.
    // The pose wrist is also gated on visibility (WRIST_VIS_THRESH — previously a dead
    // constant): mid-cross occlusion is exactly when the pose model hallucinates, and the
    // arm used to chase that ghost. Below threshold we hold the LAST GOOD hand target for
    // the hysteresis window instead of switching to a worse source.
    const poseWrist = (i) => {
      const lm = pose2DLandmarks?.[i];
      return lm && (lm.visibility ?? 1) >= WRIST_VIS_THRESH ? lm : null;
    };
    const lastT = (this._lastTarget ||= { Right: null, Left: null });
    // During an interaction hold the FROZEN hand target outranks the pose wrist: the hands
    // are touching, so the held position is where the hand actually is — while the pose
    // model's wrist is at its least reliable (occluded by the other hand) and dragging the
    // arm to a bad pose wrist is exactly the collapse the hold exists to prevent.
    const rightTargetScreen = rightHandLandmarks?.[0] || (holdRight ? lastT.Right : null) || poseWrist(16) || lastT.Right;
    const leftTargetScreen  = leftHandLandmarks?.[0]  || (holdLeft ? lastT.Left : null)  || poseWrist(15) || lastT.Left;
    if (rightHandLandmarks?.[0]) lastT.Right = { x: rightHandLandmarks[0].x, y: rightHandLandmarks[0].y };
    if (leftHandLandmarks?.[0])  lastT.Left  = { x: leftHandLandmarks[0].x,  y: leftHandLandmarks[0].y };

    if (this._avatar &&
        ((signerRightArmOn && rightTargetScreen) || (signerLeftArmOn && leftTargetScreen))) {
      this._avatar.markActive();
    }

    // Map the wrist relative to the user's own body (framing-invariant).
    const userAnchor = this._bodyAnchor(pose2DLandmarks);

    // Bone world matrices must be current before we read the shoulders.
    vrm.scene.updateMatrixWorld(true);

    if (signerRightArmOn && rightTargetScreen) {
      this._activate("Right");
      // skipForearm also during an interaction hold: with no live hand the IK would re-aim
      // the forearm FULLY at the target, dropping the hand-orientation lean — a visible
      // wrist pop right when the hands touch. Held = frozen, forearm included.
      this._solveArmIK(vrm, "Right", rightTargetScreen, userAnchor, !!(rightHandWorld && rightHandWorld.length >= 21) || holdRight,
        { za: pose3DLandmarks, pose2D: pose2DLandmarks });
    } else if (this._avatar) {
      this._avatar.slerpToRest(["RightUpperArm", "RightLowerArm", "RightHand"], 0.18);
    }

    if (signerLeftArmOn && leftTargetScreen) {
      this._activate("Left");
      this._solveArmIK(vrm, "Left", leftTargetScreen, userAnchor, !!(leftHandWorld && leftHandWorld.length >= 21) || holdLeft,
        { za: pose3DLandmarks, pose2D: pose2DLandmarks });
    } else if (this._avatar) {
      this._avatar.slerpToRest(["LeftUpperArm", "LeftLowerArm", "LeftHand"], 0.18);
    }
    // Legs intentionally NOT driven.

    // Hands: prefer 3D world landmarks (HandLandmarker); fall back to Kalidokit.
    this._handDbg.Left = null; this._handDbg.Right = null;
    if (rightHandWorld && rightHandWorld.length >= 21) {
      this._activate("Right"); this._driveHand(vrm, "Right", rightHandWorld); riggedRightHand = true;
    } else if (handDetected(rightHandLandmarks)) {
      this._writeHand(vrm, "Right", Kalidokit.Hand.solve(rightHandLandmarks, "Right"));
      riggedRightHand = true;
    } else if (this._avatar && !holdRight) {
      this._avatar.restFingers("Right", 0.25); // no hand → fingers relax to rest (unless held)
    }
    if (leftHandWorld && leftHandWorld.length >= 21) {
      this._activate("Left"); this._driveHand(vrm, "Left", leftHandWorld); riggedLeftHand = true;
    } else if (handDetected(leftHandLandmarks)) {
      this._writeHand(vrm, "Left", Kalidokit.Hand.solve(leftHandLandmarks, "Left"));
      riggedLeftHand = true;
    } else if (this._avatar && !holdLeft) {
      this._avatar.restFingers("Left", 0.25);
    }

    // Live diagnostic (read by recorder.js → #rec-debug). Every frame, so a
    // screenshot is current. Per AVATAR side: arm on/off + target, hand source,
    // palm facing (+1 = palm to camera) and mean finger curl (deg).
    const fmt = (t) => t ? `(${t.x.toFixed(2)},${t.y.toFixed(2)})` : '—';
    const lSrc = leftHandWorld ? '3D' : (leftHandLandmarks?.[0] ? 'kdk' : 'none');
    const rSrc = rightHandWorld ? '3D' : (rightHandLandmarks?.[0] ? 'kdk' : 'none');
    const hd = (s) => { const d = this._handDbg[s];
      return d ? `face:${d.facing} palmN:[${d.palmN.join(',')}] tilt:${d.tiltZ} wind:${d.wind} curl:${d.curl}° thumb:${d.thumb}° bend:${d.bend}° roll:${d.roll}°`
               : 'face:— palmN:— tilt:— wind:— curl:— thumb:— bend:— roll:—'; };
    const calLine = (side) => { const c = this._sideCal[side], o = c.orientCalib;
      return `calib[${side[0]}] roll:${Math.round(o.rollDeg)}° pitch:${Math.round(o.pitchDeg)}° yaw:${Math.round(o.yawDeg)}° flip:${c.wristFlip ? 'on' : 'off'}  curl:${c.curlGain.toFixed(2)} spread:${c.spreadGain.toFixed(2)} thumb:${Math.round(c.thumbDeg)}°(c${c.thumbCurl.toFixed(2)}/s${c.thumbSpread.toFixed(2)})  depth:${c.reachDepth.toFixed(2)} ext:${c.reachGain.toFixed(2)} guard:${c.deformGuard ? 'on' : 'off'}×${c.guardStrictness.toFixed(2)} smooth:${Math.round(c.smoothing * 100)}%`; };
    this._lastDebug =
        calLine('Right') + `\n` + calLine('Left')
      + `\nFrame ${this._dc}   pose2D:${pose2DLandmarks ? pose2DLandmarks.length : 0}  face:${faceLandmarks ? faceLandmarks.length : 0}`
      + `\nMP hands  signer-R:${results.rightHandLandmarks ? 'y' : 'n'}  signer-L:${results.leftHandLandmarks ? 'y' : 'n'}  world R:${rightHandWorld ? 'y' : 'n'} L:${leftHandWorld ? 'y' : 'n'}  close:${handsClose ? 'y' : 'n'} hold R:${this._holdFrames.Right} L:${this._holdFrames.Left}`
      + `\navatar LEFT : ${signerLeftArmOn ? 'ON ' : 'off'} tgt:${fmt(leftTargetScreen)} | hand:${lSrc} ${hd('Left')}`
      + `\navatar RIGHT: ${signerRightArmOn ? 'ON ' : 'off'} tgt:${fmt(rightTargetScreen)} | hand:${rSrc} ${hd('Right')}`;

    return { hasPose: !!riggedPose, hasLeft: !!riggedLeftHand, hasRight: !!riggedRightHand };
  }
}
