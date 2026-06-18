#!/usr/bin/env node
// ============================================================================
// hand_fk_preview.mjs — OFFLINE avatar-hand visualizer (no browser, no GPU).
//
// Why this exists: we kept shipping hand sign-errors because we could not SEE
// the avatar hand before deploying. This loads the REAL avatar (mei.vrm), runs
// the EXACT retarget math (_measureHandRig + _orientHand + _aimBone + toHand)
// on real handdump frames via three's pure-JS math, forward-kinematics the
// finger joints, and renders a PNG so we can eyeball it.
//
// Each pose row shows three palm-on stick-figures (finger up, across = sideways):
//   col 1 REAL    — the user's actual MediaPipe hand (ground truth)
//   col 2 NOW     — avatar fingers with the CURRENT toHand (across as-is)
//   col 3 FIX     — avatar fingers with the candidate fix (across *= HAND_DET)
// Compare the "together" vs "spread" rows: REAL fans wider when spread; if NOW
// fans NARROWER when spread, splay is inverted; FIX should track REAL.
//
// Usage: node tools/hand_fk_preview.mjs <dump.json> [Left|Right] [out.png]
// Requires (pure JS, no native build):  npm i three@0.133.0 pngjs
// ============================================================================
import fs from 'fs';
import * as THREE from 'three';
import { PNG } from 'pngjs';

const HAND_W = [-1, -1, -1];
const HAND_DET = HAND_W[0] * HAND_W[1] * HAND_W[2];     // -1
const WIND_SIGN = { Left: -1, Right: -1 };
const WIND_THRESH = 0.3;
const VRM_PATH = 'sgsl-app/assets/mei.vrm';
const FSEG = { Thumb: [0,1,2,3,4], Index: [0,5,6,7,8], Middle: [0,9,10,11,12], Ring: [0,13,14,15,16], Little: [0,17,18,19,20] };
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const FCOLOR = { Thumb: [220,40,40], Index: [240,150,20], Middle: [40,180,60], Ring: [40,120,230], Little: [170,60,210] };

// ── landmark access (dump stores [x,y,z] or {x,y,z}) ──
const c = (p, k) => Array.isArray(p) ? p[k] : p[['x','y','z'][k]];
const Vv = (pts, i) => new THREE.Vector3(c(pts[i],0)*HAND_W[0], c(pts[i],1)*HAND_W[1], c(pts[i],2)*HAND_W[2]); // avatar space
const Rv = (pts, i) => new THREE.Vector3(c(pts[i],0), c(pts[i],1), c(pts[i],2));                                // raw space
const Av = (p) => new THREE.Vector3(p[0], p[1], p[2]); // captured avatar-WORLD arm joint (recorder armWorld; post scene.rotation.y=π) — do NOT map through HAND_W

// ── GLB (VRM 0.x) rest-pose loader ──
function loadVRM(path) {
  const b = fs.readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
  const nodes = json.nodes;
  const parentOf = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach(ch => parentOf[ch] = i));
  const boneNode = {};
  for (const hb of json.extensions.VRM.humanoid.humanBones) boneNode[hb.bone] = hb.node;
  const localTRS = (i) => {
    const n = nodes[i];
    return {
      t: new THREE.Vector3().fromArray(n.translation || [0,0,0]),
      q: new THREE.Quaternion().fromArray(n.rotation || [0,0,0,1]),
      s: new THREE.Vector3().fromArray(n.scale || [1,1,1]),
    };
  };
  const worldM = (i) => {
    const chain = []; let k = i;
    while (k !== -1) { chain.push(k); k = parentOf[k]; }
    chain.reverse();
    const m = new THREE.Matrix4();
    for (const ci of chain) { const { t,q,s } = localTRS(ci); m.multiply(new THREE.Matrix4().compose(t,q,s)); }
    return m;
  };
  return { nodes, parentOf, boneNode, localTRS, worldM };
}

// ── port of _basisQuat ──
function basisQuat(fingerAxis, palmAxis) {
  const Y = fingerAxis.clone().normalize();
  const X = new THREE.Vector3().crossVectors(Y, palmAxis).normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

// ── port of _measureHandRig from the VRM rest pose ──
function measureRig(vrm, side) {
  const s = side.toLowerCase();
  const bn = (nm) => vrm.boneNode[s + nm];
  const handIdx = bn('Hand');
  const midPos = vrm.localTRS(bn('MiddleProximal')).t;
  const idxPos = vrm.localTRS(bn('IndexProximal')).t;
  const litPos = vrm.localTRS(bn('LittleProximal')).t;
  const fingerAxis = midPos.clone().normalize();
  const across = litPos.clone().sub(idxPos).normalize();
  const palmAxis = new THREE.Vector3().crossVectors(fingerAxis, across).normalize();
  const fingers = {};
  for (const f of FINGERS) {
    const idxs = ['Proximal','Intermediate','Distal'].map(seg => vrm.boneNode[s + f + seg]);
    if (idxs[0] == null) continue;
    const arr = [];
    for (let i = 0; i < 3; i++) {
      if (idxs[i] == null) { arr.push(null); continue; }
      const childPos = idxs[i+1] != null ? vrm.localTRS(idxs[i+1]).t.clone() : null;
      const fwdLocal = childPos ? childPos.clone().normalize()
        : (arr[i-1]?.fwdLocal?.clone() || new THREE.Vector3(0,1,0));
      const childLen = childPos ? childPos.length() : (arr[i-1]?.childLen || 0.015);
      arr.push({ restQ: vrm.localTRS(idxs[i]).q.clone(), fwdLocal, localPos: vrm.localTRS(idxs[i]).t.clone(), childLen });
    }
    fingers[f] = arr;
  }
  return { handIdx, fingerAxis, palmAxis, fingers };
}

// ── faithful _driveHand: orient hand + aim all finger bones; return FK joints ──
function avatarHand(vrm, rig, side, pts, { fixAcross }) {
  const handParentQ = new THREE.Quaternion(); { const p=new THREE.Vector3(), s=new THREE.Vector3(); vrm.worldM(vrm.parentOf[rig.handIdx]).decompose(p, handParentQ, s); }
  const handPos = new THREE.Vector3(); { const q=new THREE.Quaternion(), s=new THREE.Vector3(); vrm.worldM(rig.handIdx).decompose(handPos, q, s); }

  // orientation target (retarget.js:305-336; WRIST_STRAIGHTEN omitted — needs live forearm)
  const wrist = Vv(pts, 0);
  const fingerDir = Vv(pts, 9).sub(wrist).normalize();
  const palmNormal = new THREE.Vector3().crossVectors(fingerDir, Vv(pts,17).sub(Vv(pts,5))).multiplyScalar(HAND_DET).normalize();
  const a = Vv(pts,5).sub(wrist), b = Vv(pts,17).sub(wrist);
  const windRaw = a.x*b.y - a.y*b.x;
  const wind = windRaw / (Math.hypot(a.x,a.y) * Math.hypot(b.x,b.y) + 1e-9);
  let facing = 0;
  if (Math.abs(wind) > WIND_THRESH) facing = Math.sign(wind) * WIND_SIGN[side];
  if (facing !== 0 && Math.sign(palmNormal.z || 0) !== facing) palmNormal.negate();

  // _orientHand at lerp=1
  const inv = handParentQ.clone().invert();
  const qRest = basisQuat(rig.fingerAxis, rig.palmAxis);
  const qTarget = basisQuat(fingerDir.clone().applyQuaternion(inv), palmNormal.clone().applyQuaternion(inv));
  const handWorldQ = handParentQ.clone().multiply(qTarget.clone().multiply(qRest.clone().invert()));

  // toHand frame
  const Ym = fingerDir.clone().normalize();
  const Xm = new THREE.Vector3().crossVectors(Ym, palmNormal).normalize();
  const Zm = new THREE.Vector3().crossVectors(Xm, Ym).normalize();
  const Yr = rig.fingerAxis.clone().normalize();
  const Xr = new THREE.Vector3().crossVectors(Yr, rig.palmAxis).normalize();
  const Zr = new THREE.Vector3().crossVectors(Xr, Yr).normalize();
  const Xa = Xr.clone().applyQuaternion(handWorldQ), Ya = Yr.clone().applyQuaternion(handWorldQ), Za = Zr.clone().applyQuaternion(handWorldQ);
  const aSign = fixAcross ? HAND_DET : 1;
  const toHand = (d) => new THREE.Vector3()
    .addScaledVector(Xa, aSign * d.dot(Xm))
    .addScaledVector(Ya, d.dot(Ym))
    .addScaledVector(Za, d.dot(Zm));

  const out = { wrist: handPos.clone(), Xa, Ya, fingers: {} };
  for (const f of FINGERS) {
    const arr = rig.fingers[f]; if (!arr) continue;
    const k = FSEG[f];
    let parentPos = handPos.clone(), parentQ = handWorldQ.clone();
    const joints = [];
    for (let i = 0; i < 3; i++) {
      const fr = arr[i]; if (!fr) break;
      const jointPos = parentPos.clone().add(fr.localPos.clone().applyQuaternion(parentQ));
      joints.push(jointPos);
      const d = Vv(pts, k[i+2]).sub(Vv(pts, k[i+1]));
      let localQ;
      if (d.lengthSq() < 1e-12) localQ = fr.restQ.clone();
      else {
        const localDir = toHand(d.normalize()).applyQuaternion(parentQ.clone().invert()).normalize();
        localQ = new THREE.Quaternion().setFromUnitVectors(fr.fwdLocal, localDir);
      }
      parentQ = parentQ.clone().multiply(localQ);
      parentPos = jointPos;
    }
    const last = arr[2] || arr[1] || arr[0];
    joints.push(parentPos.clone().add(last.fwdLocal.clone().multiplyScalar(last.childLen).applyQuaternion(parentQ)));
    out.fingers[f] = joints; // [MCP, PIP, DIP, TIP]
  }
  return out;
}

// ── per-frame slerp model (predict the LIVE steady state, not the end-state) ──
const ARM_IK_LERP = 0.45; // retarget.js
function slerpDir(a, b, t) {
  const an = a.clone().normalize(), bn = b.clone().normalize();
  const d = Math.max(-1, Math.min(1, an.dot(bn))), th = Math.acos(d);
  if (th < 1e-6) return an;
  const s = Math.sin(th);
  return an.multiplyScalar(Math.sin((1-t)*th)/s).add(bn.multiplyScalar(Math.sin(t*th)/s)).normalize();
}
// Deployed NOW: _solveArmIK slerps the forearm→Tdir each frame, then _driveHand slerps it
// →Fdir — two equal pulls fight to a steady state BETWEEN them (the residual knot).
function eqForearmDueling(Tdir, Fdir) { let x = Tdir.clone(); for (let i=0;i<200;i++){ x = slerpDir(x, Tdir, ARM_IK_LERP); x = slerpDir(x, Fdir, ARM_IK_LERP); } return x; }

// ── arm-aware _driveHand: orient the hand anchored at the CAPTURED avatar wrist and
//    FK fingers in avatar-WORLD, alongside the captured arm S→E→W. Three modes:
//      real — true 3D hand orientation on the captured (IK) forearm → shows the raw seam
//      now  — current deployed behavior: blend fingerDir 0.6 toward the forearm (the pinch)
//      fix  — proposed: keep the true hand, re-aim the forearm to follow it (wrist straight)
//    Returns { arm:[S,E,Wuse], wrist:Wuse, fingers:{f:[j..]}, rawBend, kink } in avatar-world.
//    handWorldQ is parent-independent (basisQuat(fingerDir,palmNormal)·qRest⁻¹), so the
//    captured wrist POSITION is all we need — see retarget.js _orientHand. ─────────────
function avatarArmHand(vrm, rig, side, pts, arm, mode) {
  const S = Av(arm.ua), E = Av(arm.la), W = Av(arm.hand);
  const wrist0 = Vv(pts, 0);
  const fingerDirReal = Vv(pts, 9).sub(wrist0).normalize();
  const across = Vv(pts, 17).sub(Vv(pts, 5));
  // winding/facing override (retarget.js:329-336)
  const a = Vv(pts,5).sub(wrist0), b = Vv(pts,17).sub(wrist0);
  const wind = (a.x*b.y - a.y*b.x) / (Math.hypot(a.x,a.y)*Math.hypot(b.x,b.y) + 1e-9);
  const facing = Math.abs(wind) > WIND_THRESH ? Math.sign(wind) * WIND_SIGN[side] : 0;
  const palmFrom = (fd) => { const pn = new THREE.Vector3().crossVectors(fd, across).multiplyScalar(HAND_DET).normalize();
    if (facing !== 0 && Math.sign(pn.z||0) !== facing) pn.negate(); return pn; };
  const palmReal = palmFrom(fingerDirReal);

  const fwd = W.clone().sub(E);
  const fwdN = fwd.lengthSq() > 1e-9 ? fwd.clone().normalize() : new THREE.Vector3(0,1,0);
  const L2 = fwd.length() || 0.1;
  const deg = (u, v) => Math.acos(Math.max(-1, Math.min(1, u.dot(v)))) * 180 / Math.PI;
  const rawBend = deg(fingerDirReal, fwdN); // real hand vs captured forearm (= live HUD bend)

  // The hand keeps its true 3D orientation in ALL columns (the deployed code no longer
  // blends it); only the FOREARM direction differs by pipeline stage, moving the wrist anchor.
  const fingerDir = fingerDirReal.clone();
  const palmNormal = palmReal.clone();
  let armDir;
  if (mode === 'now')      armDir = eqForearmDueling(fwdN, fingerDirReal); // deployed: solveArmIK vs driveHand tug-of-war
  else if (mode === 'fix') armDir = fingerDirReal.clone();                 // fixed: driveHand alone owns the forearm
  else                     armDir = fwdN.clone();                          // real: the captured IK forearm (raw seam)
  const Wuse = E.clone().add(armDir.clone().multiplyScalar(L2));
  const kink = deg(fingerDir, armDir); // rendered wrist kink (steady state)

  // hand world orientation (parent-independent) + the exact toHand frame from avatarHand
  const qRest = basisQuat(rig.fingerAxis, rig.palmAxis);
  const handWorldQ = basisQuat(fingerDir, palmNormal).multiply(qRest.clone().invert());
  const Ym = fingerDir.clone().normalize();
  const Xm = new THREE.Vector3().crossVectors(Ym, palmNormal).normalize();
  const Zm = new THREE.Vector3().crossVectors(Xm, Ym).normalize();
  const Yr = rig.fingerAxis.clone().normalize();
  const Xr = new THREE.Vector3().crossVectors(Yr, rig.palmAxis).normalize();
  const Zr = new THREE.Vector3().crossVectors(Xr, Yr).normalize();
  const Xa = Xr.clone().applyQuaternion(handWorldQ), Ya = Yr.clone().applyQuaternion(handWorldQ), Za = Zr.clone().applyQuaternion(handWorldQ);
  const toHand = (d) => new THREE.Vector3()
    .addScaledVector(Xa, HAND_DET * d.dot(Xm))
    .addScaledVector(Ya, d.dot(Ym))
    .addScaledVector(Za, d.dot(Zm));

  const fingers = {};
  for (const f of FINGERS) {
    const arr = rig.fingers[f]; if (!arr) continue;
    const k = FSEG[f];
    let parentPos = Wuse.clone(), parentQ = handWorldQ.clone();
    const joints = [];
    for (let i = 0; i < 3; i++) {
      const fr = arr[i]; if (!fr) break;
      const jointPos = parentPos.clone().add(fr.localPos.clone().applyQuaternion(parentQ));
      joints.push(jointPos);
      const d = Vv(pts, k[i+2]).sub(Vv(pts, k[i+1]));
      let localQ;
      if (d.lengthSq() < 1e-12) localQ = fr.restQ.clone();
      else {
        const localDir = toHand(d.normalize()).applyQuaternion(parentQ.clone().invert()).normalize();
        localQ = new THREE.Quaternion().setFromUnitVectors(fr.fwdLocal, localDir);
      }
      parentQ = parentQ.clone().multiply(localQ);
      parentPos = jointPos;
    }
    const last = arr[2] || arr[1] || arr[0];
    joints.push(parentPos.clone().add(last.fwdLocal.clone().multiplyScalar(last.childLen).applyQuaternion(parentQ)));
    fingers[f] = joints; // world positions [MCP, PIP, DIP, TIP]
  }
  return { arm: [S, E, Wuse], wrist: Wuse, fingers, rawBend, kink };
}

// ── real hand: project raw landmarks onto its own palm plane (across, finger) ──
function realHand(pts) {
  const wrist = Rv(pts, 0);
  const fingerDir = Rv(pts, 9).sub(wrist).normalize();
  const palmNormal = new THREE.Vector3().crossVectors(fingerDir, Rv(pts,17).sub(Rv(pts,5))).normalize();
  const Xa = new THREE.Vector3().crossVectors(fingerDir, palmNormal).normalize();
  const Ya = fingerDir;
  const out = { wrist, Xa, Ya, fingers: {} };
  for (const f of FINGERS) { const k = FSEG[f]; out.fingers[f] = [Rv(pts,k[1]), Rv(pts,k[2]), Rv(pts,k[3]), Rv(pts,k[4])]; }
  return out;
}

// project a hand {wrist,Xa,Ya,fingers} → 2D {wrist:[u,v], fingers:{f:[[u,v]..]}}
function project(h) {
  const P = (p) => { const d = p.clone().sub(h.wrist); return [d.dot(h.Xa), d.dot(h.Ya)]; };
  const r = { wrist: [0,0], fingers: {} };
  for (const f of FINGERS) if (h.fingers[f]) r.fingers[f] = h.fingers[f].map(P);
  return r;
}

// ── pose metrics for frame selection ──
const ang = (u, v) => { const lu=u.length(), lv=v.length(); if(lu<1e-9||lv<1e-9) return 0; return Math.acos(Math.max(-1,Math.min(1,u.dot(v)/(lu*lv)))); };
function curlMean(pts) {
  let s = 0, n = 0;
  for (const f of ['Index','Middle','Ring','Little']) { const k = FSEG[f];
    for (let i = 0; i < 3; i++) { s += ang(Vv(pts,k[i+1]).sub(Vv(pts,k[i])), Vv(pts,k[i+2]).sub(Vv(pts,k[i+1]))); n++; } }
  return n ? s/n : 0;
}
function spreadMetric(pts) { // fan width of the 4 fingertips across the knuckle line, / palm width
  const wrist = Vv(pts,0), fd = Vv(pts,9).sub(wrist).normalize();
  const pn = new THREE.Vector3().crossVectors(fd, Vv(pts,17).sub(Vv(pts,5))).normalize();
  const X = new THREE.Vector3().crossVectors(fd, pn).normalize();
  const tips = [8,12,16,20].map(i => Vv(pts,i).sub(wrist).dot(X));
  const palmW = Vv(pts,17).sub(Vv(pts,5)).length() || 1e-6;
  return (Math.max(...tips) - Math.min(...tips)) / palmW;
}
function indexPointiness(pts) { // index extended while others curled
  const cu = (f) => { const k=FSEG[f]; let s=0; for(let i=0;i<3;i++) s+=ang(Vv(pts,k[i+1]).sub(Vv(pts,k[i])),Vv(pts,k[i+2]).sub(Vv(pts,k[i+1]))); return s; };
  return (cu('Middle')+cu('Ring')+cu('Little'))/3 - cu('Index');
}

// ── dump loader (retarget side convention; same mapping as hand_replay.mjs) ──
function loadFrames(json) {
  const out = [];
  for (const f of (json.frames || [])) {
    const rawRight = f.raw && f.raw.find(r => r.side === 'Right');
    const rawLeft = f.raw && f.raw.find(r => r.side === 'Left');
    // Side convention: retarget "Left" is driven by the signer's RIGHT hand (f.rW)
    // and writes the avatar's Left* bones → f.arm.left. So Left↔{rW, arm.left}.
    out.push({
      Left: f.rW || rawRight?.w || null, Right: f.lW || rawLeft?.w || null,
      armLeft: f.arm?.left || null, armRight: f.arm?.right || null,
    });
  }
  return out;
}
function valid(pts) { return pts && pts.length >= 21 && pts.every(p => p && (Array.isArray(p) ? p.length>=3 && isFinite(p[0]) : isFinite(p.x))); }

// ── PNG canvas with line/dot drawing ──
function canvas(W, H, bg=[24,24,28]) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W*H; i++) { png.data[i*4]=bg[0]; png.data[i*4+1]=bg[1]; png.data[i*4+2]=bg[2]; png.data[i*4+3]=255; }
  return png;
}
function px(png, x, y, col) { x=Math.round(x); y=Math.round(y); if(x<0||y<0||x>=png.width||y>=png.height) return; const i=(y*png.width+x)*4; png.data[i]=col[0]; png.data[i+1]=col[1]; png.data[i+2]=col[2]; png.data[i+3]=255; }
function line(png, x0,y0,x1,y1, col) {
  x0=Math.round(x0);y0=Math.round(y0);x1=Math.round(x1);y1=Math.round(y1);
  const dx=Math.abs(x1-x0), dy=-Math.abs(y1-y0), sx=x0<x1?1:-1, sy=y0<y1?1:-1; let err=dx+dy;
  for(;;){ px(png,x0,y0,col); if(x0===x1&&y0===y1) break; const e2=2*err; if(e2>=dy){err+=dy;x0+=sx;} if(e2<=dx){err+=dx;y0+=sy;} }
}
function disc(png, cx, cy, r, col) { for(let y=-r;y<=r;y++) for(let x=-r;x<=r;x++) if(x*x+y*y<=r*r) px(png,cx+x,cy+y,col); }
function rect(png, x, y, w, h, col) { for(let i=0;i<w;i++){px(png,x+i,y,col);px(png,x+i,y+h,col);} for(let j=0;j<=h;j++){px(png,x,y+j,col);px(png,x+w,y+j,col);} }

// draw a projected hand into a panel box
function drawPanel(png, box, proj2d, border) {
  const { x, y, w, h } = box;
  rect(png, x, y, w, h, border);
  // gather pts to compute scale
  const all = [proj2d.wrist];
  for (const f of FINGERS) if (proj2d.fingers[f]) all.push(...proj2d.fingers[f]);
  let minU=1e9,maxU=-1e9,minV=1e9,maxV=-1e9;
  for (const [u,v] of all) { minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v); }
  const pad = 18;
  const spanU = (maxU-minU)||1e-6, spanV=(maxV-minV)||1e-6;
  const sc = Math.min((w-2*pad)/spanU, (h-2*pad)/spanV);
  const cx = x + w/2, cy = y + h/2, mu=(minU+maxU)/2, mv=(minV+maxV)/2;
  const T = ([u,v]) => [cx + (u-mu)*sc, cy - (v-mv)*sc]; // v up
  const W = T(proj2d.wrist);
  disc(png, W[0], W[1], 4, [235,235,235]);
  for (const f of FINGERS) {
    if (!proj2d.fingers[f]) continue;
    const col = FCOLOR[f];
    let prev = W;
    for (const p of proj2d.fingers[f]) { const q = T(p); line(png, prev[0],prev[1],q[0],q[1], col); disc(png, q[0],q[1], 2, col); prev = q; }
  }
}

// ── draw an arm model (shoulder→elbow→wrist + fingers) in one fixed-camera view ──
// proj: Vector3 → [u,v]. FRONT=(x,y), SIDE=(z,y). Autoscales over arm+finger joints.
function drawArmView(png, sub, model, proj) {
  const { x, y, w, h } = sub;
  const all = [...model.arm, ...Object.values(model.fingers).flat()].map(proj);
  let minU=1e9,maxU=-1e9,minV=1e9,maxV=-1e9;
  for (const [u,v] of all){ minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v); }
  const pad=16, spanU=(maxU-minU)||1e-6, spanV=(maxV-minV)||1e-6;
  const sc=Math.min((w-2*pad)/spanU,(h-2*pad)/spanV);
  const cx=x+w/2, cy=y+h/2, mu=(minU+maxU)/2, mv=(minV+maxV)/2;
  const P=(p)=>{ const [u,v]=proj(p); return [cx+(u-mu)*sc, cy-(v-mv)*sc]; }; // v up
  const [Sp,Ep,Wp]=model.arm.map(P);
  line(png,Sp[0],Sp[1],Ep[0],Ep[1],[130,130,140]); disc(png,Sp[0],Sp[1],4,[110,110,120]); // upper arm
  line(png,Ep[0],Ep[1],Wp[0],Wp[1],[190,190,200]); disc(png,Ep[0],Ep[1],4,[110,110,120]); // forearm
  disc(png,Wp[0],Wp[1],4,[235,235,235]);                                                   // wrist
  for (const f of FINGERS){ if(!model.fingers[f])continue; const col=FCOLOR[f]; let prev=Wp;
    for(const p of model.fingers[f]){ const q=P(p); line(png,prev[0],prev[1],q[0],q[1],col); disc(png,q[0],q[1],2,col); prev=q; } }
}
// one grid cell = FRONT view (top) over SIDE view (bottom); the SIDE view exposes the
// forward forearm tilt / wrist kink that a front-only view foreshortens away.
function drawArmCell(png, box, model, border) {
  rect(png, box.x, box.y, box.w, box.h, border);
  const halfH = Math.floor(box.h/2);
  drawArmView(png, { x:box.x, y:box.y,        w:box.w, h:halfH },        model, p=>[p.x, p.y]); // FRONT
  for (let i=4;i<box.w-4;i+=7) px(png, box.x+i, box.y+halfH, [70,70,82]);                        // divider
  drawArmView(png, { x:box.x, y:box.y+halfH,  w:box.w, h:box.h-halfH },  model, p=>[p.z, p.y]); // SIDE
}

// ── main ──
const [,, dumpPath, sideArg='Left', outArg] = process.argv;
if (!dumpPath) { console.error('usage: node tools/hand_fk_preview.mjs <dump.json> [Left|Right] [out.png]'); process.exit(1); }
const side = sideArg;
const out = outArg || `/tmp/hand_preview_${side}.png`;
const json = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const vrm = loadVRM(VRM_PATH);
const rig = measureRig(vrm, side);
// frames carry the landmark array (.pts) + the captured avatar arm (.arm), if present.
const frames = loadFrames(json).map(f => ({ pts: f[side], arm: side === 'Left' ? f.armLeft : f.armRight })).filter(x => valid(x.pts));
const ARM_MODE = frames.some(x => x.arm && x.arm.la && x.arm.hand);
console.log(`Loaded ${frames.length} valid "${side}" frames; arm-data=${ARM_MODE ? 'YES (wrist render)' : 'no (palm-on render)'}; rig fingerAxis=${rig.fingerAxis.toArray().map(n=>n.toFixed(2))}`);
if (frames.length < 4) { console.error('too few frames'); process.exit(1); }

// select representative poses (metrics take the landmark array)
const lowCurl = frames.filter(x => curlMean(x.pts) < 0.5);
const pick = (arr, key, dir) => arr.slice().sort((a,b)=> dir*(key(a.pts)-key(b.pts)))[0];
const poses = [];
if (lowCurl.length) {
  poses.push(['SPREAD',   pick(lowCurl, spreadMetric, -1)]);
  poses.push(['TOGETHER', pick(lowCurl, spreadMetric, +1)]);
}
poses.push(['FIST',  pick(frames, curlMean, -1)]);
poses.push(['POINT', pick(frames, indexPointiness, -1)]);
poses.push(['OPEN',  pick(frames, pts => Math.abs(curlMean(pts)-0.3), +1)]);

// layout: rows = poses, cols = [REAL, NOW, FIX]. Arm cells are taller (FRONT+SIDE stack).
const PW = 300, PH = ARM_MODE ? 520 : 300, MX = 16, MY = 16;
const cols = ['REAL', 'NOW', 'FIX'];
const colBorder = { REAL: [200,200,200], NOW: [220,60,60], FIX: [60,210,90] };
const W = MX + cols.length*(PW+MX), H = MY + poses.length*(PH+MY);
const png = canvas(W, H);
poses.forEach(([label, fr], r) => {
  const { pts, arm } = fr;
  const box = (ci) => ({ x: MX + ci*(PW+MX), y: MY + r*(PH+MY), w: PW, h: PH });
  if (ARM_MODE && arm && arm.la && arm.hand) {
    const real = avatarArmHand(vrm, rig, side, pts, arm, 'real');
    const now  = avatarArmHand(vrm, rig, side, pts, arm, 'now');
    const fix  = avatarArmHand(vrm, rig, side, pts, arm, 'fix');
    const data = { REAL: real, NOW: now, FIX: fix };
    cols.forEach((cn, ci) => drawArmCell(png, box(ci), data[cn], colBorder[cn]));
    console.log(`row ${r} ${label.padEnd(9)} rawBend=${real.rawBend.toFixed(0)}°(=HUD)  NOWkink=${now.kink.toFixed(0)}°  FIXkink=${fix.kink.toFixed(0)}°`);
  } else {
    const data = { REAL: project(realHand(pts)), NOW: project(avatarHand(vrm, rig, side, pts, { fixAcross: false })), FIX: project(avatarHand(vrm, rig, side, pts, { fixAcross: true })) };
    cols.forEach((cn, ci) => drawPanel(png, box(ci), data[cn], colBorder[cn]));
    console.log(`row ${r} ${label.padEnd(9)} spread=${spreadMetric(pts).toFixed(2)} curl=${curlMean(pts).toFixed(2)}`);
  }
});
fs.writeFileSync(out, PNG.sync.write(png));
console.log(`\nGrid: rows = poses (top→bottom: ${poses.map(p=>p[0]).join(', ')})`);
console.log(ARM_MODE
  ? `      cols = REAL hand+IK forearm | NOW deployed(forearm tug-of-war) | FIX forearm-follows-hand (solveArmIK skips forearm);  each cell: FRONT (top) / SIDE (bottom).  PASS = FIX wrist straight (kink≈0).`
  : `      cols = REAL (white) | NOW current-math (red) | FIX candidate (green)`);
console.log(`Wrote ${out}`);
