/* ============================================================
   SgSL Avatar — Kalidokit Retargeting
   Derived from Kalidokit demo script.js (VRM 0.x API).

   Diverges from the demo where necessary for laptop-webcam signing:
   - Arms are gated per-side with 5-frame hysteresis so MediaPipe
     hand-detection flicker doesn't collapse Mei to rest.
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
   * Compute upper-arm Euler directly from MediaPipe 2D shoulder→wrist.
   * This sidesteps Kalidokit's pose solver, which under-shoots arm
   * height when the elbow is extrapolated (laptop crop case).
   *
   * We return an object compatible with _rigRotation:
   *  { x, y, z, rotationOrder }.
   *
   * `side` is "Right" or "Left" from the SIGNER'S perspective.
   * `shoulder`, `wrist` are MediaPipe 2D landmarks (x,y in [0..1]).
   */
  _directUpperArm(side, shoulder, wrist) {
    if (!shoulder || !wrist) return null;
    // MediaPipe 2D convention: +x right, +y down.
    // Rest upper-arm in the VRM hangs straight down (shoulder→wrist
    // vector pointing +y in the image).
    const dx = wrist.x - shoulder.x;
    const dy = wrist.y - shoulder.y;

    // Angle from straight-down, measured CCW when viewed from the
    // front. atan2(dx, dy): 0 = straight down, +π/2 = arm out to
    // the signer's right (camera's left side of frame).
    const angle = Math.atan2(dx, dy);

    // For a VRM facing the camera (rotated Math.PI in the scene):
    //   RightUpperArm.rotation.z > 0 raises the right arm
    //   LeftUpperArm.rotation.z  < 0 raises the left arm
    // The sign flip takes care of the mirror.
    const sign = (side === "Right") ? 1 : -1;
    const zRot = sign * angle;

    // Pitch (x rotation) — use the horizontal distance from shoulder
    // to wrist as a very rough proxy for "how forward" the hand is.
    // Sign language is mostly frontal, so keep this small and let
    // Kalidokit's lower-arm handle forward reach.
    const horizontalReach = Math.abs(dx);
    const xRot = -0.2 * clamp(horizontalReach - 0.15, 0, 1);

    return { x: xRot, y: 0, z: zRot, rotationOrder: "XYZ" };
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
    if (this._dc % 30 === 0) {
      this._lastDebug = `Frame: ${this._dc}`
        + `\npose3D: ${pose3DLandmarks ? pose3DLandmarks.length + ' lm' : 'NULL'}`
        + `\npose2D: ${pose2DLandmarks ? pose2DLandmarks.length + ' lm' : 'NULL'}`
        + `\nface: ${faceLandmarks ? faceLandmarks.length + ' lm' : 'NULL'}`
        + `\nrightHand(MP): ${rightHandLandmarks ? 'yes' : 'no'}`
        + `\nleftHand(MP): ${leftHandLandmarks ? 'yes' : 'no'}`
        + `\narmStreak: R=${this._rightArmStreak} L=${this._leftArmStreak}`;
    }

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

    if (poseVisible && pose3DLandmarks) {
      riggedPose = Kalidokit.Pose.solve(pose3DLandmarks, pose2DLandmarks, solveOpts);
      if (riggedPose) {
        if (this._avatar) this._avatar.markActive();

        // Torso: small dampeners so MediaPipe noise doesn't tilt the
        // avatar. Hips position transfer is intentionally disabled.
        this._rigRotation(vrm, "Hips", riggedPose.Hips.rotation, 0.2, 0.15);
        this._rigRotation(vrm, "Chest", riggedPose.Spine, 0.1, 0.15);
        this._rigRotation(vrm, "Spine", riggedPose.Spine, 0.2, 0.15);

        // MediaPipe 2D shoulders: 11 = signer's right, 12 = signer's left.
        const rightShoulder = pose2DLandmarks?.[11];
        const leftShoulder  = pose2DLandmarks?.[12];
        // Hand wrist landmark within a hand array is index 0.
        const rightWrist = rightHandLandmarks?.[0];
        const leftWrist  = leftHandLandmarks?.[0];

        // Right arm
        if (signerRightArmOn) {
          // Prefer direct 2D computation when we have hand + shoulder.
          // It bypasses Kalidokit's elbow extrapolation, which was
          // under-shooting arm height on laptop crops.
          const direct = (rightWrist && rightShoulder)
            ? this._directUpperArm("Right", rightShoulder, rightWrist)
            : null;
          this._rigRotation(
            vrm, "RightUpperArm",
            direct || riggedPose.RightUpperArm,
            1, 0.65,
          );
          this._rigRotation(vrm, "RightLowerArm", riggedPose.RightLowerArm, 1, 0.65);
        } else if (this._avatar) {
          this._avatar.slerpToRest(["RightUpperArm", "RightLowerArm", "RightHand"], 0.18);
        }

        // Left arm
        if (signerLeftArmOn) {
          const direct = (leftWrist && leftShoulder)
            ? this._directUpperArm("Left", leftShoulder, leftWrist)
            : null;
          this._rigRotation(
            vrm, "LeftUpperArm",
            direct || riggedPose.LeftUpperArm,
            1, 0.65,
          );
          this._rigRotation(vrm, "LeftLowerArm", riggedPose.LeftLowerArm, 1, 0.65);
        } else if (this._avatar) {
          this._avatar.slerpToRest(["LeftUpperArm", "LeftLowerArm", "LeftHand"], 0.18);
        }
        // Legs intentionally NOT driven.
      }
    }

    // Hand writes: hand-solve only, no longer mix in pose-Z.
    if (handDetected(leftHandLandmarks)) {
      riggedLeftHand = Kalidokit.Hand.solve(leftHandLandmarks, "Left");
      this._writeHand(vrm, "Left", riggedLeftHand);
    }

    if (handDetected(rightHandLandmarks)) {
      riggedRightHand = Kalidokit.Hand.solve(rightHandLandmarks, "Right");
      this._writeHand(vrm, "Right", riggedRightHand);
    }

    return { hasPose: !!riggedPose, hasLeft: !!riggedLeftHand, hasRight: !!riggedRightHand };
  }
}
