/* ============================================================
   SgSL Avatar — VRM 0.x Loader
   ============================================================
   - Loads a VRM 0.x model (from VRoid Studio export).
   - Three.js 0.133 + @pixiv/three-vrm 0.6.7 (matches Kalidokit demo).
   - Sets an arms-at-sides rest pose.
   - Rebias-to-rest when retargeting has been silent for N frames
     (avoids the avatar freezing in the last tracked pose when a hand
     leaves the frame or Kalidokit skips a write).
   ============================================================ */

// THREE is global (loaded via script tag)

const REST_REBIAS_FRAMES = 15;   // animation frames of silence before drift begins
const REST_REBIAS_LERP = 0.1;

export class SMPLXAvatar {
  constructor(containerEl) {
    this.container = typeof containerEl === 'string'
      ? document.getElementById(containerEl) : containerEl;
    if (!this.container) return;

    this.vrm = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.loaded = false;
    this._statusEl = null;

    // Rest-pose rebias bookkeeping.
    this._restTargets = {};
    this._silentFrames = 0;
    this._playing = false;

    this._initScene();
    this._loadVRM();
  }

  _initScene() {
    const w = this.container.clientWidth || 400;
    const h = this.container.clientHeight || 520;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 1000);
    this.camera.position.set(0.0, 1.35, 1.8);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePanning = true;
    this.controls.target.set(0.0, 1.2, 0.0);
    this.controls.update();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d3e);

    const light = new THREE.DirectionalLight(0xffffff);
    light.position.set(1.0, 1.0, 1.0).normalize();
    this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0x666666));

    this._statusEl = document.createElement('div');
    this._statusEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#8888cc;font:14px/1.4 Inter,sans-serif;text-align:center;';
    this._statusEl.textContent = 'Loading avatar...';
    this.container.style.position = 'relative';
    this.container.appendChild(this._statusEl);

    new ResizeObserver(() => {
      const nw = this.container.clientWidth, nh = this.container.clientHeight;
      if (!nw || !nh) return;
      this.renderer.setSize(nw, nh);
      this.camera.aspect = nw / nh;
      this.camera.updateProjectionMatrix();
    }).observe(this.container);

    const animate = () => {
      requestAnimationFrame(animate);
      if (this.vrm) this.vrm.update(this.clock.getDelta());
      if (this.controls) this.controls.update();
      this._rebiasToRestIfIdle();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  _loadVRM() {
    const loader = new THREE.GLTFLoader();
    loader.crossOrigin = 'anonymous';

    loader.load('assets/mei.vrm',
      (gltf) => {
        THREE.VRMUtils.removeUnnecessaryJoints(gltf.scene);
        THREE.VRM.from(gltf).then((vrm) => {
          this.scene.add(vrm.scene);
          this.vrm = vrm;
          this.vrm.scene.rotation.y = Math.PI;

          this._setRestPose(vrm);
          this._snapshotRestTargets(vrm);
          this._measureArmRig(vrm);
          this._measureHandRig(vrm);

          if (this._statusEl) { this._statusEl.remove(); this._statusEl = null; }
          this.loaded = true;
          console.log('[Avatar] VRM 0.x loaded');
        });
      },
      (p) => { if (p.total > 0 && this._statusEl) this._statusEl.textContent = `Loading... ${Math.round(p.loaded/p.total*100)}%`; },
      (e) => {
        console.error('[Avatar] Load failed:', e);
        if (this._statusEl) this._statusEl.textContent = 'Failed to load assets/mei.vrm';
      }
    );
  }

  _setRestPose(vrm) {
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const rua = vrm.humanoid.getBoneNode(BN.RightUpperArm);
    const lua = vrm.humanoid.getBoneNode(BN.LeftUpperArm);
    if (rua) rua.rotation.z = -1.2;
    if (lua) lua.rotation.z = 1.2;

    const rla = vrm.humanoid.getBoneNode(BN.RightLowerArm);
    const lla = vrm.humanoid.getBoneNode(BN.LeftLowerArm);
    if (rla) rla.rotation.y = 0.15;
    if (lla) lla.rotation.y = -0.15;
  }

  _snapshotRestTargets(vrm) {
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const bones = [
      BN.RightUpperArm, BN.LeftUpperArm,
      BN.RightLowerArm, BN.LeftLowerArm,
      BN.RightHand, BN.LeftHand,
      BN.Hips, BN.Spine, BN.Chest, BN.Neck,
      // Legs are never driven by retarget.js; snapshotting them here
      // lets the idle rebias gently pull them back to rest if any
      // upstream change ever writes them.
      BN.LeftUpperLeg, BN.LeftLowerLeg,
      BN.RightUpperLeg, BN.RightLowerLeg,
    ];
    for (const b of bones) {
      const node = vrm.humanoid.getBoneNode(b);
      if (node) this._restTargets[b] = node.quaternion.clone();
    }
  }

  /**
   * Measure the arm rig once, at bind/rest, for the hands-first IK in
   * retarget.js. Bone local positions are fixed bind offsets (they don't
   * change with rotation), so L1/L2 and the rest axes are constants:
   *   - L1 = shoulder→elbow length, L2 = elbow→wrist length
   *   - upperRestAxis = local dir UpperArm→LowerArm (in UpperArm's frame)
   *   - lowerRestAxis = local dir LowerArm→Hand   (in LowerArm's frame)
   */
  _measureArmRig(vrm) {
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const sides = {
      Right: [BN.RightLowerArm, BN.RightHand],
      Left:  [BN.LeftLowerArm,  BN.LeftHand],
    };
    this.armRig = {};
    for (const side of ['Right', 'Left']) {
      const [laName, haName] = sides[side];
      const la = vrm.humanoid.getBoneNode(laName);
      const ha = vrm.humanoid.getBoneNode(haName);
      if (!la || !ha) continue;
      const upperVec = la.position.clone();   // elbow offset in UpperArm local space
      const lowerVec = ha.position.clone();    // wrist offset in LowerArm local space
      this.armRig[side] = {
        L1: upperVec.length() || 1e-4,
        L2: lowerVec.length() || 1e-4,
        upperRestAxis: upperVec.clone().normalize(),
        lowerRestAxis: lowerVec.clone().normalize(),
      };
    }
  }

  /**
   * Measure the hand + finger rest axes (bind pose) for the 3D hand driver in
   * retarget.js. All are fixed bind offsets (local child positions), so they're
   * constants. Per side:
   *   - fingerAxis: Hand-local dir toward the middle-finger knuckle
   *   - palmAxis  : Hand-local palm normal (finger × across-knuckles)
   *   - fingers[name] = [proxAxis, interAxis, distAxis]: each bone's local dir
   *     toward its child (Distal reuses Intermediate's, as the tip has no bone)
   */
  _measureHandRig(vrm) {
    const BN = THREE.VRMSchema.HumanoidBoneName;
    const node = (n) => vrm.humanoid.getBoneNode(BN[n]);
    this.handRig = {};
    for (const side of ['Right', 'Left']) {
      const hand = node(`${side}Hand`);
      const midProx = node(`${side}MiddleProximal`);
      if (!hand || !midProx) continue;
      const fingerAxis = midProx.position.clone().normalize();
      let palmAxis = new THREE.Vector3(0, 0, 1);
      const idxProx = node(`${side}IndexProximal`);
      const litProx = node(`${side}LittleProximal`);
      if (idxProx && litProx) {
        const across = litProx.position.clone().sub(idxProx.position).normalize();
        palmAxis = new THREE.Vector3().crossVectors(fingerAxis, across).normalize();
      }
      const fingers = {};
      for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
        const prox = node(`${side}${f}Proximal`);
        if (!prox) continue;
        const inter = node(`${side}${f}Intermediate`);
        const dist = node(`${side}${f}Distal`);
        const a0 = inter ? inter.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
        const a1 = dist ? dist.position.clone().normalize() : a0.clone();
        fingers[f] = [a0, a1, a1.clone()]; // Distal reuses Intermediate's local forward
      }
      this.handRig[side] = { fingerAxis, palmAxis, fingers };
    }
  }

  /** Called by the retarget layer each frame it writes bones. */
  markActive() { this._silentFrames = 0; }

  /**
   * Actively slerp a set of bones back toward their rest snapshot.
   * Used by retarget.js when a per-arm visibility check fails — we
   * don't want those bones to freeze at a hallucinated rotation.
   */
  slerpToRest(boneNames, lerpAmount = 0.18) {
    if (!this.vrm) return;
    const BN = THREE.VRMSchema.HumanoidBoneName;
    for (const n of boneNames) {
      const key = BN[n];
      const rest = this._restTargets[key];
      if (!rest) continue;
      const node = this.vrm.humanoid.getBoneNode(key);
      if (node) node.quaternion.slerp(rest, lerpAmount);
    }
  }

  _rebiasToRestIfIdle() {
    if (!this.vrm || !this._playing) return;
    this._silentFrames++;
    if (this._silentFrames < REST_REBIAS_FRAMES) return;
    for (const [boneName, restQ] of Object.entries(this._restTargets)) {
      const node = this.vrm.humanoid.getBoneNode(boneName);
      if (node) node.quaternion.slerp(restQ, REST_REBIAS_LERP);
    }
  }

  setPlaying(on) { this._playing = !!on; this._silentFrames = 0; }
}
