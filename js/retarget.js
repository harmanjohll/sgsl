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
// Blend the hand's finger axis toward the avatar's forearm direction (0 = pure
// 3D hand orientation, 1 = wrist locked straight to the forearm). Prevents the
// wrist hyperextending when the 2D-IK forearm and the 3D hand diverge.
const WRIST_STRAIGHTEN = 0.6;
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
// force the palm normal's facing to match it. WIND_SIGN pinned by REAL captures
// via tools/hand_replay.mjs. BOTH sides want -1: handdump_6–9 (339 non-edge-on
// frames, the user's RIGHT hand = retarget side "Left") agree with the raw palm
// geometry 0% at +1 and ~100% at -1 — at +1 the override fired 82–99% of frames,
// forcing the palm ~180° off (the reported left-wrist twist). Side "Right" was
// already pinned to -1 by handdump_4/5. The earlier +1 for "Left" was assumed
// good but never validated until these right-hand dumps arrived.
const WIND_SIGN = { Left: -1, Right: -1 };
const WIND_THRESH = 0.3;     // |normalized winding| below this = hold last (edge-on)

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
  }
  reset() {
    oldLookTarget = new THREE.Euler();
    this._rightArmStreak = 0;
    this._leftArmStreak = 0;
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
    const map = { Right: results.leftHandWorldLandmarks, Left: results.rightHandWorldLandmarks };
    const out = { Left: null, Right: null };
    for (const side of ['Left', 'Right']) {
      const w = map[side];
      if (w && w.length >= 21) out[side] = this._fingerJointAngles(w);
    }
    return out;
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
    const V = (i) => new THREE.Vector3(world[i].x * HAND_WX, world[i].y * HAND_WY, world[i].z * HAND_WZ);

    // Hand orientation (palm facing).
    const wrist = V(0);
    const fingerDir = V(9).sub(wrist).normalize();
    // The hand orientation is absolute (from 3D landmarks) but the forearm is
    // positioned by the 2D arm-IK; left unchecked the wrist bridges the gap and
    // hyperextends. Blend the finger axis toward the avatar's real forearm
    // direction (elbow→wrist) to keep the wrist natural. Palm facing + curls are
    // preserved (palm normal is re-projected ⊥ to the blended axis).
    const lowerArm = vrm.humanoid.getBoneNode(BN[`${side}LowerArm`]);
    let wristBend = 0;
    if (lowerArm) {
      const fwd = hand.getWorldPosition(new THREE.Vector3())
        .sub(lowerArm.getWorldPosition(new THREE.Vector3()));
      if (fwd.lengthSq() > 1e-9) {
        fwd.normalize();
        wristBend = Math.acos(clampNum(fingerDir.dot(fwd), -1, 1)) * 180 / Math.PI;
        fingerDir.lerp(fwd, WRIST_STRAIGHTEN).normalize();
      }
    }
    // Same formula as avatar.js handRig.palmAxis (finger × (little-MCP − index-MCP)),
    // with the reflection-determinant correction so it matches the rest basis.
    const palmNormal = new THREE.Vector3()
      .crossVectors(fingerDir, V(17).sub(V(5))).multiplyScalar(HAND_DET).normalize();

    // Stabilise palm-vs-back against MediaPipe's depth flip using the 2D knuckle
    // winding (world x/y don't flip with depth). Normalised so |wind| ∈ [0,1].
    const a = V(5).sub(V(0)), b = V(17).sub(V(0));
    const windRaw = a.x * b.y - a.y * b.x;
    const wind = windRaw / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) + 1e-9);
    if (Math.abs(wind) > WIND_THRESH) this._handFacing[side] = Math.sign(wind) * WIND_SIGN[side];
    const desired = this._handFacing[side];
    if (desired !== 0 && Math.sign(palmNormal.z || 0) !== desired) palmNormal.negate();

    this._orientHand(hand, rig.fingerAxis, rig.palmAxis, fingerDir, palmNormal);
    hand.updateWorldMatrix(true, true);

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
    const toHand = (d) => new THREE.Vector3()
      .addScaledVector(Xa, d.dot(Xm))
      .addScaledVector(Ya, d.dot(Ym))
      .addScaledVector(Za, d.dot(Zm));
    for (const f of FINGER_NAMES) {
      const arr = rig.fingers[f];
      if (!arr) continue;
      const k = FINGER_SEG[f]; // [wrist, mcp, pip, dip, tip]
      for (let i = 0; i < 3; i++) {
        const fr = arr[i];
        if (!fr) continue;
        const bone = vrm.humanoid.getBoneNode(BN[`${side}${f}${segNames[i]}`]);
        if (!bone) continue;
        const d = V(k[i + 2]).sub(V(k[i + 1])); // real segment: parent→child landmark
        if (d.lengthSq() < 1e-12) continue;
        this._aimBone(bone, fr.fwdLocal, toHand(d.normalize()), HAND_LERP);
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
    this._handDbg[side] = { facing: +palmNormal.z.toFixed(2), curl: Math.round(meanDeg(['Index', 'Middle', 'Ring', 'Little'])), thumb: Math.round(meanDeg(['Thumb'])), bend: Math.round(wristBend), wind: +wind.toFixed(2) };
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
    // 3D world landmarks (HandLandmarker), routed to the same signer sides.
    const leftHandWorld = results.rightHandWorldLandmarks;
    const rightHandWorld = results.leftHandWorldLandmarks;

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

    // Raw per-frame "arm is trustworthy" signal. An arm activates ONLY when its
    // hand is actually detected (image or 3D world landmarks) — a bare pose
    // wrist must not raise the non-signing arm. Hysteresis (below) still
    // sustains an on-arm through brief hand dropouts.
    const handDetected = (lms) =>
      lms && this._countVisible(lms, 0) >= HAND_MIN_VISIBLE_LMS;
    const rawRightOk = handDetected(rightHandLandmarks) || (rightHandWorld?.length >= 21);
    const rawLeftOk  = handDetected(leftHandLandmarks)  || (leftHandWorld?.length >= 21);

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

    // Hands: prefer 3D world landmarks (HandLandmarker); fall back to Kalidokit.
    this._handDbg.Left = null; this._handDbg.Right = null;
    if (rightHandWorld && rightHandWorld.length >= 21) {
      this._driveHand(vrm, "Right", rightHandWorld); riggedRightHand = true;
    } else if (handDetected(rightHandLandmarks)) {
      this._writeHand(vrm, "Right", Kalidokit.Hand.solve(rightHandLandmarks, "Right"));
      riggedRightHand = true;
    } else if (this._avatar) {
      this._avatar.restFingers("Right", 0.25); // no hand → fingers relax to rest
    }
    if (leftHandWorld && leftHandWorld.length >= 21) {
      this._driveHand(vrm, "Left", leftHandWorld); riggedLeftHand = true;
    } else if (handDetected(leftHandLandmarks)) {
      this._writeHand(vrm, "Left", Kalidokit.Hand.solve(leftHandLandmarks, "Left"));
      riggedLeftHand = true;
    } else if (this._avatar) {
      this._avatar.restFingers("Left", 0.25);
    }

    // Live diagnostic (read by recorder.js → #rec-debug). Every frame, so a
    // screenshot is current. Per AVATAR side: arm on/off + target, hand source,
    // palm facing (+1 = palm to camera) and mean finger curl (deg).
    const fmt = (t) => t ? `(${t.x.toFixed(2)},${t.y.toFixed(2)})` : '—';
    const lSrc = leftHandWorld ? '3D' : (leftHandLandmarks?.[0] ? 'kdk' : 'none');
    const rSrc = rightHandWorld ? '3D' : (rightHandLandmarks?.[0] ? 'kdk' : 'none');
    const hd = (s) => this._handDbg[s] ? `face:${this._handDbg[s].facing} wind:${this._handDbg[s].wind} curl:${this._handDbg[s].curl}° thumb:${this._handDbg[s].thumb}° bend:${this._handDbg[s].bend}°` : 'face:— curl:— thumb:— bend:—';
    this._lastDebug =
        `Frame ${this._dc}   pose2D:${pose2DLandmarks ? pose2DLandmarks.length : 0}  face:${faceLandmarks ? faceLandmarks.length : 0}`
      + `\nMP hands  signer-R:${results.rightHandLandmarks ? 'y' : 'n'}  signer-L:${results.leftHandLandmarks ? 'y' : 'n'}  world R:${rightHandWorld ? 'y' : 'n'} L:${leftHandWorld ? 'y' : 'n'}`
      + `\navatar LEFT : ${signerLeftArmOn ? 'ON ' : 'off'} tgt:${fmt(leftTargetScreen)} | hand:${lSrc} ${hd('Left')}`
      + `\navatar RIGHT: ${signerRightArmOn ? 'ON ' : 'off'} tgt:${fmt(rightTargetScreen)} | hand:${rSrc} ${hd('Right')}`;

    return { hasPose: !!riggedPose, hasLeft: !!riggedLeftHand, hasRight: !!riggedRightHand };
  }
}
