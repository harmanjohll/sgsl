/* ============================================================
   SgSL Avatar — Retargeting
   ============================================================
   What this module does, top to bottom:

   1. ARMS are NOT driven by Kalidokit's pose solver any more.
      That solver returns local-bone Eulers based on a hallucinated
      elbow when the elbow is out of frame (laptop webcam case),
      and local Eulers depend on bone-axis conventions we don't
      control — that combination cost us many iterations of
      visible regressions.

      Instead: we read the 2D shoulder→wrist vector from MediaPipe,
      flip image-Y to world-Y, and rotate the UpperArm bone via a
      world-space quaternion so its rest direction aligns with
      that vector. THREE.Quaternion.setFromUnitVectors handles
      every axis convention for us. Mei's wrist ends up where the
      user's wrist actually is. The lower arm is left in its rest
      orientation (no elbow bend driven from the camera) — it'll
      look stick-like at extreme angles but the hand position is
      what matters for sign legibility.

   2. HANDS (fingers + wrist) use Kalidokit.Hand.solve from the
      21 hand-landmark feed. Per-landmark direct pointing was
      attempted and reverted (see plan iteration 5c): setFromUnitVectors
      has a twist-axis singularity at near-antiparallel vectors,
      and each finger bone ends up "rolled" at random around its
      length when the user's hand orientation is far from rest.
      Bend-angle-only retargeting is the next approach — tracked
      in the plan, not yet implemented.

   3. FACE is still driven by Kalidokit.Face.solve.

   4. TORSO (Hips/Spine/Chest) is dampened so MediaPipe noise
      doesn't tilt the avatar. Hips position transfer is disabled
      (SgSL signer stays planted). Legs are never driven.

   5. Per-arm 5-frame hysteresis absorbs MediaPipe hand-detection
      flicker so a brief drop doesn't collapse Mei to rest.
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
    this._calibration = null;
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

  /**
   * Optional per-signer calibration captured by the multi-pose
   * sequence. Currently used to normalize the per-frame
   * shoulder→wrist reach against the user's measured maximum,
   * so the same gesture produces the same Mei pose across
   * different signers / distances from the camera.
   */
  setCalibration(calib) { this._calibration = calib || null; }

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

  /**
   * Rotate a bone in WORLD space so its rest tip direction aligns with
   * `desiredWorldDir`. Derivation:
   *
   *   The bone has a fixed local tip direction `t` (bone geometry).
   *   Its world tip direction is (boneWorldQuat) * t.
   *   At rest: restWorldQuat * t = restWorldDir (snapshotted).
   *
   *   We want: W_new * t = desiredWorldDir.
   *   Let Q = rotation taking restWorldDir → desiredWorldDir.
   *   Then W_new = Q * restWorldQuat satisfies the equation:
   *       W_new * t = Q * restWorldQuat * t = Q * restWorldDir = desiredWorldDir.
   *
   *   Convert to local under the CURRENT parent:
   *       newLocal = currentParentWorldQuat⁻¹ * W_new.
   *
   * This is correct even when the parent has been rotated (e.g. the
   * forearm's parent = upper arm, which we just rotated) because we
   * use the snapshotted rest world quaternion, NOT a recomputation
   * that assumes the parent is still at rest.
   */
  _pointBoneInWorld(vrm, boneName, desiredWorldDir, lerpAmount = 0.5) {
    if (!this._avatar || !desiredWorldDir) return false;
    const restWorldDir = this._avatar._restWorldDirs?.[boneName];
    const restWorldQuat = this._avatar._restWorldQuats?.[boneName];
    if (!restWorldDir || !restWorldQuat) return false;

    const BN = THREE.VRMSchema.HumanoidBoneName;
    const bone = vrm.humanoid.getBoneNode(BN[boneName]);
    if (!bone) return false;

    const Q = new THREE.Quaternion().setFromUnitVectors(
      restWorldDir, desiredWorldDir.clone().normalize(),
    );

    const newWorld = Q.clone().multiply(restWorldQuat);

    // Parent's CURRENT world quaternion — reflects any rotation the
    // parent has already received this frame (Three.js
    // getWorldQuaternion calls updateWorldMatrix internally).
    const parentWorld = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorld);

    const newLocal = parentWorld.invert().multiply(newWorld);

    bone.quaternion.slerp(newLocal, lerpAmount);
    return true;
  }

  /**
   * Compute a desired arm direction in avatar world space from a 2D
   * `from` → `to` vector in MediaPipe image coordinates.
   *
   * When a calibration rest-offset key is supplied AND the current
   * retarget instance has calibration data, the rest offset is
   * subtracted from the raw image delta BEFORE building the world
   * vector. That way: user at rest → zero deflection → (null
   * returned) → Mei stays at her current pose; user raises → real
   * deflection survives → Mei responds. Without this subtraction,
   * the per-user bias of "where does your wrist sit when you're
   * standing neutrally" (varies with camera angle, body
   * proportions, seated vs standing) leaked into Mei's arm pose
   * and Mei sat in a subtly-wrong-looking "rest".
   *
   * Mapping image → world axes:
   *   - X: NEGATE. The raw camera is unmirrored, so the user's right
   *     side is on image-LEFT (small x). Mei's RIGHT side is on
   *     world -X (viewer's left). For the user's right hand at
   *     face level (image dx ~ -0.15) we want Mei's left arm
   *     (world +X) to extend to viewer's RIGHT — i.e., world dx > 0.
   *     So we negate.
   *   - Y: NEGATE (image-down → world-up).
   *   - Z: 0 (sign language is mostly frontal).
   *
   * restOffsetKey is one of:
   *   - 'leftShoulderElbow', 'leftElbowWrist'
   *   - 'rightShoulderElbow', 'rightElbowWrist'
   * matching MediaPipe anatomical side names (leftShoulder = MP[11]).
   * Caller picks the correct key per its own side accounting.
   */
  _imageToWorldArmDir(from2D, to2D, restOffsetKey = null) {
    if (!from2D || !to2D) return null;
    let dx = to2D.x - from2D.x;
    let dy = to2D.y - from2D.y;

    // Subtract the user's calibrated rest offset for this segment
    // so the output is "deflection from rest" rather than raw
    // image-space direction.
    const offset = restOffsetKey ? this._calibration?.restOffsets?.[restOffsetKey] : null;
    if (offset) {
      dx -= offset.dx;
      dy -= offset.dy;
    }

    const v = new THREE.Vector3(-dx, -dy, 0);
    if (v.lengthSq() < 1e-6) return null;
    return v.normalize();
  }

  /**
   * Reach scalar in [0..1] for an arm: how extended the shoulder→wrist
   * vector is relative to the user's calibrated maximum reach on
   * that side. Returns null when no calibration is available.
   *
   * Used by callers that want to know "is this arm fully extended"
   * (e.g., for future depth inference, or to tighten per-pose
   * dampening at extremes). Does not change the direction.
   */
  _armReach(side, shoulder2D, wrist2D) {
    if (!this._calibration?.armReach || !shoulder2D || !wrist2D) return null;
    const len = Math.hypot(wrist2D.x - shoulder2D.x, wrist2D.y - shoulder2D.y);
    const max = side === 'right' ? this._calibration.armReach.right : this._calibration.armReach.left;
    if (!max) return null;
    return Math.min(1, len / max);
  }

  _writeHand(vrm, side, riggedHand) {
    if (!riggedHand) return;
    const wrist = riggedHand[`${side}Wrist`];
    if (wrist) {
      // Drop the pose-solver's wrist z. In laptop crops, pose-z is
      // hallucinated and tilts the palm onto a bad plane. Use only
      // the hand-solve's own xyz.
      this._rigRotation(vrm, `${side}Hand`, {
        x: wrist.x,
        y: wrist.y,
        z: wrist.z ?? 0,
      });
    }
    // Fingers: Kalidokit's hand-solver output. Direct
    // landmark→bone pointing was tried in 8c5e2c9 but introduced
    // severe finger distortion because Quaternion.setFromUnitVectors
    // chooses an arbitrary rotation axis for near-antiparallel vectors
    // (finger rest direction down vs. target direction up, when the
    // user raises their hand) — twist around the bone's length is
    // unconstrained, so fingers look curled at random angles. The
    // next try will be bend-angle-only: compute a single bend axis
    // per segment and leave twist at rest. Until then, Kalidokit's
    // solver is the less-wrong option.
    for (const f of FINGER_NAMES) {
      for (const s of FINGER_SEGMENTS) {
        const key = `${side}${f}${s}`;
        const rot = riggedHand[key];
        if (rot) this._rigRotation(vrm, key, rot);
      }
    }
  }

  applyFromMediaPipe(vrm, results) {
    if (!vrm) return;
    let riggedPose, riggedLeftHand, riggedRightHand, riggedFace;

    const faceLandmarks = results.faceLandmarks;
    const pose3DLandmarks = results.za || results.ea;
    const pose2DLandmarks = results.poseLandmarks;

    // ─── Handedness disambiguation ─────────────────────────────
    //
    // MediaPipe Holistic occasionally mislabels which hand is which
    // (especially when one hand is held high near the face and the
    // other is at the hip — both palms are oriented similarly to the
    // camera). When that happens, the MP-labeled "leftHandLandmarks"
    // and "rightHandLandmarks" arrays are swapped, and our retarget
    // drives the wrong avatar arm with the wrong data.
    //
    // Geometric truth holds even when MP's labels lie: in the raw
    // (unmirrored) camera frame, the user's RIGHT hand is always to
    // the image-LEFT of their body midline (= midpoint of shoulders),
    // and their LEFT hand is to the image-RIGHT.
    //
    // We override MP's labels by sorting any detected hands by their
    // wrist x relative to the shoulder midline. The resulting
    // assignment matches the user's anatomy regardless of MP's call.
    const ls = pose2DLandmarks?.[11];
    const rs = pose2DLandmarks?.[12];
    const midX = (ls && rs) ? (ls.x + rs.x) / 2 : null;

    const hands = [];
    if (results.leftHandLandmarks?.[0])  hands.push({ lm: results.leftHandLandmarks,  x: results.leftHandLandmarks[0].x  });
    if (results.rightHandLandmarks?.[0]) hands.push({ lm: results.rightHandLandmarks, x: results.rightHandLandmarks[0].x });

    let userRight = null, userLeft = null;
    if (midX !== null && hands.length > 0) {
      // Image-left of midline = user's anatomical RIGHT.
      const leftOfMid  = hands.filter(h => h.x <  midX);
      const rightOfMid = hands.filter(h => h.x >= midX);
      if (leftOfMid.length === 1 && rightOfMid.length === 1) {
        userRight = leftOfMid[0].lm;
        userLeft  = rightOfMid[0].lm;
      } else if (leftOfMid.length === 1 && rightOfMid.length === 0) {
        userRight = leftOfMid[0].lm;
      } else if (rightOfMid.length === 1 && leftOfMid.length === 0) {
        userLeft = rightOfMid[0].lm;
      } else {
        // Both hands ended up on the same side of the midline (rare —
        // typically a crossed-arms gesture). Fall back to MP labels.
        userLeft  = results.leftHandLandmarks  || null;
        userRight = results.rightHandLandmarks || null;
      }
    } else {
      // No body midline available — trust MP labels.
      userLeft  = results.leftHandLandmarks  || null;
      userRight = results.rightHandLandmarks || null;
    }

    // Mirror retargeting: user's RIGHT hand drives Mei's LEFT bones,
    // user's LEFT hand drives Mei's RIGHT bones. Names below match
    // the side accounting in the retargeting block.
    const leftHandLandmarks  = userRight;  // → drives Mei.Left*
    const rightHandLandmarks = userLeft;   // → drives Mei.Right*

    const solveOpts = this._video
      ? { runtime: "mediapipe", video: this._video }
      : { runtime: "mediapipe" };

    this._dc++;
    const emitDebug = (this._dc % 30 === 0);

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
      lms && this._countVisible(lms, 0) >= HAND_MIN_VISIBLE_LMS;    // MediaPipe pose wrist indices: 15 = signer's right, 16 = signer's left.
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

    // We still call Pose.solve for torso (Hips/Spine/Chest), but we
    // ignore its arm Eulers entirely.
    if (poseVisible && pose3DLandmarks) {
      riggedPose = Kalidokit.Pose.solve(pose3DLandmarks, pose2DLandmarks, solveOpts);
      if (riggedPose) {
        if (this._avatar) this._avatar.markActive();

        this._rigRotation(vrm, "Hips", riggedPose.Hips.rotation, 0.2, 0.15);
        this._rigRotation(vrm, "Chest", riggedPose.Spine, 0.1, 0.15);
        this._rigRotation(vrm, "Spine", riggedPose.Spine, 0.2, 0.15);
      }
    }

    // Arms: direct world-space pointing, upper + lower separately.
    //
    // Upper arm points from shoulder → elbow.
    // Lower arm points from elbow → wrist.
    //
    // Without this two-bone treatment, pointing the straight upper
    // arm at the wrist (or the fingertip) made Mei's whole arm
    // reach all the way to face level, so her un-driven forearm
    // dangled from there and her hand ended up above her head.
    // Driving both bones lets the elbow bend, hand lands where
    // the user's hand actually is.
    //
    // When a hand is detected we take the wrist from hand-landmark-0
    // (hand-solver, more accurate); otherwise we fall back to pose
    // landmark 15/16. Elbow always comes from pose 13/14 (we have
    // no hand-free elbow detector). If pose elbow visibility is
    // low we estimate an elbow at the midpoint of shoulder+wrist —
    // not anatomically correct, but gives a plausible straight
    // arm that at least places the hand in the right spot.

    // Pick the best wrist point available: hand-solver wrist first,
    // else pose wrist. `lms` is the matching-side local hand array.
    const pickWrist = (lms, poseWristIdx) => (
      lms?.[0] || pose2DLandmarks?.[poseWristIdx] || null
    );

    // Pick the elbow: pose elbow if it's clearly visible, else
    // fall back to the midpoint of shoulder + wrist (gives a
    // "straight-arm" pose that places the hand correctly).
    //
    // The visibility bar is set high (0.75) because MP often
    // returns landmarks with vis ~0.5 even when the elbow is
    // off-frame and hallucinated — trusting those was the source
    // of "awkward forward rotation" artifacts in the Apr 19 test.
    const pickElbow = (poseElbowIdx, shoulder, wrist) => {
      const e = pose2DLandmarks?.[poseElbowIdx];
      if (e && (e.visibility ?? 0) >= 0.75) return e;
      if (!shoulder || !wrist) return null;
      return {
        x: (shoulder.x + wrist.x) / 2,
        y: (shoulder.y + wrist.y) / 2,
        z: 0,
      };
    };

    if (pose2DLandmarks) {
      // Side accounting (the source of repeated bugs — comment
      // carefully). Under the swap at the top of this function:
      //   local leftHandLandmarks  = MP results.rightHandLandmarks
      //                            = user's ANATOMICAL RIGHT hand.
      //   local rightHandLandmarks = MP results.leftHandLandmarks
      //                            = user's ANATOMICAL LEFT hand.
      //
      // signerRightArmOn is triggered by local rightHandLandmarks,
      //   i.e., user's anatomical LEFT side.  Shoulder = MP[11],
      //   elbow = MP[13], wrist = MP[15].  We drive Mei's Right*
      //   bones — mirror: user's left hand up → Mei's right arm up.
      //
      // signerLeftArmOn is triggered by local leftHandLandmarks,
      //   i.e., user's anatomical RIGHT side: shoulder MP[12],
      //   elbow MP[14], wrist MP[16]. We drive Mei's Left* bones.

      // Side accounting crib (don't re-derive, just read):
      //   signerRightArmOn drives Mei's RIGHT bones.
      //   It's triggered by the user's ANATOMICAL LEFT hand
      //   (via the swap at the top of this function).
      //   Pose indices: MP[11] L-shoulder, MP[13] L-elbow, MP[15] L-wrist.
      //   So the calibration rest-offset keys are the "left*" ones.
      //
      //   Symmetric story for signerLeftArmOn → Mei's LEFT bones,
      //   driven by user's anatomical RIGHT (MP[12]/[14]/[16]),
      //   reads the "right*" rest offsets.

      if (signerRightArmOn) {
        const sh = pose2DLandmarks[11];
        const wr = pickWrist(rightHandLandmarks, 15);
        const el = pickElbow(13, sh, wr);
        if (sh && el) {
          const upDir = this._imageToWorldArmDir(sh, el, 'leftShoulderElbow');
          if (upDir) this._pointBoneInWorld(vrm, "RightUpperArm", upDir, 0.7);
        }
        if (el && wr) {
          const loDir = this._imageToWorldArmDir(el, wr, 'leftElbowWrist');
          if (loDir) this._pointBoneInWorld(vrm, "RightLowerArm", loDir, 0.7);
        }
      } else if (this._avatar) {
        this._avatar.slerpToRest(["RightUpperArm", "RightLowerArm", "RightHand"], 0.18);
      }

      if (signerLeftArmOn) {
        const sh = pose2DLandmarks[12];
        const wr = pickWrist(leftHandLandmarks, 16);
        const el = pickElbow(14, sh, wr);
        if (sh && el) {
          const upDir = this._imageToWorldArmDir(sh, el, 'rightShoulderElbow');
          if (upDir) this._pointBoneInWorld(vrm, "LeftUpperArm", upDir, 0.7);
        }
        if (el && wr) {
          const loDir = this._imageToWorldArmDir(el, wr, 'rightElbowWrist');
          if (loDir) this._pointBoneInWorld(vrm, "LeftLowerArm", loDir, 0.7);
        }
      } else if (this._avatar) {
        this._avatar.slerpToRest(["LeftUpperArm", "LeftLowerArm", "LeftHand"], 0.18);
      }
    }

    if (emitDebug) {
      // Pose-side shoulder→wrist 2D vector in normalized image coords.
      // The label "Rsh->wrist" reads "MP-right shoulder to MP-right
      // wrist" = user's anatomical right side. Use to verify
      // framing + that detection is reaching expected coords.
      const sw = (shoulderIdx, wristIdx) => {
        const s = pose2DLandmarks?.[shoulderIdx];
        const w = pose2DLandmarks?.[wristIdx];
        if (!s || !w) return 'NULL';
        const dx = (w.x - s.x).toFixed(2);
        const dy = (w.y - s.y).toFixed(2);
        return `dx=${dx} dy=${dy}`;
      };
      const restDirs = this._avatar?._restWorldDirs;
      const rdr = restDirs?.RightUpperArm;
      const ldr = restDirs?.LeftUpperArm;
      const fmtV = (v) => v ? `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})` : 'NULL';
      // Where the disambiguated user-right/user-left hands ended up
      // in the local var names that drive Mei. After the geometric
      // override:
      //   userLeft  → local rightHandLandmarks → drives Mei.Right*
      //   userRight → local leftHandLandmarks  → drives Mei.Left*
      const mpHands = (results.leftHandLandmarks ? 'L' : '-')
                    + (results.rightHandLandmarks ? 'R' : '-');
      const disHands = (rightHandLandmarks ? 'L' : '-')   // → user-left
                     + (leftHandLandmarks  ? 'R' : '-');  // → user-right
      this._lastDebug = `Frame: ${this._dc}`
        + `\npose3D: ${pose3DLandmarks ? pose3DLandmarks.length + ' lm' : 'NULL'}`
        + `\npose2D: ${pose2DLandmarks ? pose2DLandmarks.length + ' lm' : 'NULL'}`
        + `\nface: ${faceLandmarks ? faceLandmarks.length + ' lm' : 'NULL'}`
        + `\nMP labels (L/R hand): ${mpHands}`
        + `\nGeom user (L/R hand): ${disHands}`
        + `\narmStreak: R=${this._rightArmStreak} L=${this._leftArmStreak}`
        + `\nMP12->16: ${sw(12, 16)}`
        + `\nMP11->15: ${sw(11, 15)}`
        + `\nrestRUpDir: ${fmtV(rdr)}`
        + `\nrestLUpDir: ${fmtV(ldr)}`;
    }

    // Hand + finger writes.
    //
    // Wrist orientation: Kalidokit's hand-only solve (palm rotation
    // from 21 landmarks). Finger bones: Kalidokit's solver output,
    // written inside _writeHand. Per-landmark direct pointing was
    // attempted in 8c5e2c9 and reverted — it produced severe finger
    // distortion because setFromUnitVectors has a twist-axis
    // singularity at near-antiparallel vectors (rest dir down vs
    // raised-hand target dir up). See the plan file "iteration 5c"
    // for the next approach (bend-angle only per segment).
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
