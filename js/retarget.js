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
const MIRROR_X = -1;         // screen-x → world-x direction (reflection mirror)
const FRONT_Z = 1;           // +1 = signing plane sits toward the camera
const REACH_GAIN = 1.15;     // user shoulder-widths → avatar shoulder-widths
const BOX_DEPTH = 1.2;       // plane distance in front, in shoulder-widths
// Absolute fallback (only when the user's shoulders/nose aren't detected):
const BOX_W = 2.4;           // signing-box width  in shoulder-widths
const BOX_H = 3.0;           // signing-box height in shoulder-widths
const ARM_IK_LERP = 0.45;    // per-frame slerp toward the IK solution
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  }
  reset() {
    oldLookTarget = new THREE.Euler();
    this._rightArmStreak = 0;
    this._leftArmStreak = 0;
  }

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
  _aimBone(bone, restAxisLocal, worldDir, lerpAmount = ARM_IK_LERP) {
    if (!bone || !bone.parent) return;
    if (worldDir.lengthSq() < 1e-9) return;
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const localDir = worldDir.clone().applyQuaternion(pq.invert());
    if (localDir.lengthSq() < 1e-9) return;
    localDir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(restAxisLocal, localDir);
    bone.quaternion.slerp(q, lerpAmount);
  }

  /** User body anchor (image space) for framing-invariant wrist mapping:
   *  prefer the shoulder midpoint + shoulder width; fall back to the nose. */
  _bodyAnchor(pose2D) {
    const L = pose2D?.[11], R = pose2D?.[12];
    if (L && R && (L.visibility ?? 1) > 0.3 && (R.visibility ?? 1) > 0.3) {
      return {
        x: (L.x + R.x) / 2,
        y: (L.y + R.y) / 2,
        scale: Math.hypot(L.x - R.x, L.y - R.y) || 0.2,
      };
    }
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
  _solveArmIK(vrm, side, screen, anchor) {
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
    if (anchor) {
      // BODY-RELATIVE: wrist position relative to the user's shoulders, in
      // shoulder-width units → same offset (scaled) from the avatar's
      // shoulders. Framing-invariant. Image y is down, so invert for world up.
      const relX = (screen.x - anchor.x) / anchor.scale;
      const relY = (screen.y - anchor.y) / anchor.scale;
      T = new THREE.Vector3(
        mid.x + relX * avShoulderW * REACH_GAIN * MIRROR_X,
        mid.y - relY * avShoulderW * REACH_GAIN,
        mid.z + avShoulderW * BOX_DEPTH * FRONT_Z,
      );
    } else {
      // Absolute fallback (no shoulders/nose): image-centered box.
      T = new THREE.Vector3(
        mid.x + (0.5 - screen.x) * avShoulderW * BOX_W * -MIRROR_X,
        mid.y + (0.5 - screen.y) * avShoulderW * BOX_H,
        mid.z + avShoulderW * BOX_DEPTH * FRONT_Z,
      );
    }

    const S = (side === "Right" ? Rs : Ls).clone();
    const { L1, L2, upperRestAxis, lowerRestAxis } = rig;

    // Planar 2-bone IK (law of cosines).
    const toT = T.clone().sub(S);
    const d = clampNum(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    const axis = toT.lengthSq() > 1e-9 ? toT.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const a = (d * d + L1 * L1 - L2 * L2) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // Pole hint: elbow bends down, toward the camera, and outward per side.
    const outX = (side === "Right" ? Rs.x : Ls.x) - mid.x;
    const pole = new THREE.Vector3(Math.sign(outX || (side === "Right" ? 1 : -1)) * 0.3, -1, 0.4 * FRONT_Z);
    let perp = pole.sub(axis.clone().multiplyScalar(pole.dot(axis)));
    if (perp.lengthSq() < 1e-9) perp = new THREE.Vector3(0, -1, 0);
    perp.normalize();
    const E = S.clone().add(axis.clone().multiplyScalar(a)).add(perp.multiplyScalar(h));

    // Aim upper arm S→E, refresh its world matrix, then aim lower arm E→T.
    this._aimBone(ua, upperRestAxis, E.clone().sub(S));
    ua.updateWorldMatrix(true, true);
    const Ew = la.getWorldPosition(new THREE.Vector3());
    this._aimBone(la, lowerRestAxis, T.clone().sub(Ew));
    return true;
  }

  applyFromMediaPipe(vrm, results) {
    if (!vrm) return;
    let riggedPose, riggedLeftHand, riggedRightHand, riggedFace;

    const faceLandmarks = results.faceLandmarks;
    const pose3DLandmarks = results.za || results.ea;
    const pose2DLandmarks = results.poseLandmarks;
    // MediaPipe reports hands as the camera sees them; Kalidokit's
    // demo swaps so "Left" refers to the signer's own left hand.
    const leftHandLandmarks = results.rightHandLandmarks;
    const rightHandLandmarks = results.leftHandLandmarks;

    const solveOpts = this._video
      ? { runtime: "mediapipe", video: this._video }
      : { runtime: "mediapipe" };

    this._dc++;

    if (faceLandmarks && faceLandmarks.length >= 468) {
      riggedFace = Kalidokit.Face.solve(faceLandmarks, solveOpts);
      if (riggedFace) this._rigFace(vrm, riggedFace);
    }

    const poseVisible = pose2DLandmarks
      ? this._countVisible(pose2DLandmarks) >= POSE_MIN_VISIBLE_LMS
      : false;

    // Raw per-frame "arm is trustworthy" signal. Hand detection is
    // the strong signal; wrist visibility is a fallback for the
    // no-hand-raised case.
    const vis = (i) => pose2DLandmarks?.[i]?.visibility ?? 0;
    const handDetected = (lms) =>
      lms && this._countVisible(lms, 0) >= HAND_MIN_VISIBLE_LMS;
    // MediaPipe pose wrist indices: 15 = signer's right, 16 = signer's left.
    const rawRightOk = handDetected(rightHandLandmarks) || vis(15) >= WRIST_VIS_THRESH;
    const rawLeftOk  = handDetected(leftHandLandmarks)  || vis(16) >= WRIST_VIS_THRESH;

    // Hysteresis: fill the streak up to MAX when the raw signal is
    // good; decrement when it's bad. Arm is "on" whenever > 0.
    const bump = (streak, ok) => ok
      ? ARM_HYSTERESIS_FRAMES
      : Math.max(0, streak - 1);
    this._rightArmStreak = bump(this._rightArmStreak, rawRightOk);
    this._leftArmStreak  = bump(this._leftArmStreak,  rawLeftOk);
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
    const rightTargetScreen = rightHandLandmarks?.[0] || pose2DLandmarks?.[15];
    const leftTargetScreen  = leftHandLandmarks?.[0]  || pose2DLandmarks?.[16];

    if (this._avatar &&
        ((signerRightArmOn && rightTargetScreen) || (signerLeftArmOn && leftTargetScreen))) {
      this._avatar.markActive();
    }

    // Map the wrist relative to the user's own body (framing-invariant).
    const userAnchor = this._bodyAnchor(pose2DLandmarks);

    // Bone world matrices must be current before we read the shoulders.
    vrm.scene.updateMatrixWorld(true);

    if (signerRightArmOn && rightTargetScreen) {
      this._solveArmIK(vrm, "Right", rightTargetScreen, userAnchor);
    } else if (this._avatar) {
      this._avatar.slerpToRest(["RightUpperArm", "RightLowerArm", "RightHand"], 0.18);
    }

    if (signerLeftArmOn && leftTargetScreen) {
      this._solveArmIK(vrm, "Left", leftTargetScreen, userAnchor);
    } else if (this._avatar) {
      this._avatar.slerpToRest(["LeftUpperArm", "LeftLowerArm", "LeftHand"], 0.18);
    }
    // Legs intentionally NOT driven.

    // Hand writes: hand-solve only, no longer mix in pose-Z.
    if (handDetected(leftHandLandmarks)) {
      riggedLeftHand = Kalidokit.Hand.solve(leftHandLandmarks, "Left");
      this._writeHand(vrm, "Left", riggedLeftHand);
    }

    if (handDetected(rightHandLandmarks)) {
      riggedRightHand = Kalidokit.Hand.solve(rightHandLandmarks, "Right");
      this._writeHand(vrm, "Right", riggedRightHand);
    }

    // Live diagnostic (read by recorder.js → #rec-debug). Every frame, so a
    // screenshot is current. Reports each AVATAR arm's on/off, target source,
    // and target screen coords — maps any failure to a concrete cause.
    const fmt = (t) => t ? `(${t.x.toFixed(2)},${t.y.toFixed(2)})` : '—';
    const lSrc = leftHandLandmarks?.[0] ? 'hand' : (pose2DLandmarks?.[16] ? 'pose' : 'none');
    const rSrc = rightHandLandmarks?.[0] ? 'hand' : (pose2DLandmarks?.[15] ? 'pose' : 'none');
    this._lastDebug =
        `Frame ${this._dc}   pose2D:${pose2DLandmarks ? pose2DLandmarks.length : 0}  face:${faceLandmarks ? faceLandmarks.length : 0}`
      + `\nMP hands  signer-R:${results.rightHandLandmarks ? 'yes' : 'no'}  signer-L:${results.leftHandLandmarks ? 'yes' : 'no'}`
      + `\navatar LEFT : ${signerLeftArmOn ? 'ON ' : 'off'}  src:${lSrc}  tgt:${fmt(leftTargetScreen)}  streak ${this._leftArmStreak}`
      + `\navatar RIGHT: ${signerRightArmOn ? 'ON ' : 'off'}  src:${rSrc}  tgt:${fmt(rightTargetScreen)}  streak ${this._rightArmStreak}`;

    return { hasPose: !!riggedPose, hasLeft: !!riggedLeftHand, hasRight: !!riggedRightHand };
  }
}
