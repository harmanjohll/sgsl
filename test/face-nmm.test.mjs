/* Face NMM unit tests (pure + a fake VRM). Run: node test/face-nmm.test.mjs */
import { FACE_BS_KEYS, packFaceBS, unpackFaceBS, lerpFaceBS, solveFaceNMM, FaceRig } from '../sgsl-app/js/face-nmm.js';
import { lerpFrame } from '../sgsl-app/js/interp.js';

let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log(`ok   ${n}`); } else { failed++; console.log(`FAIL ${n}`); } };

const neutral = Object.fromEntries(FACE_BS_KEYS.map((k) => [k, 0.03]));
const face = (over) => ({ ...neutral, ...over });

// pack / unpack
{
  const cats = Object.entries(face({ browInnerUp: 0.4567 })).map(([categoryName, score]) => ({ categoryName, score }));
  cats.push({ categoryName: 'jawOpen', score: 0.9 });              // ignored key
  const p = packFaceBS(cats);
  check('pack: fixed length', p.length === FACE_BS_KEYS.length);
  check('pack: 3 dp rounding', p[0] === 0.457);
  check('pack: map input == categories input', JSON.stringify(packFaceBS(face({ browInnerUp: 0.4567 }))) === JSON.stringify(p));
  check('pack: null / empty / unrelated -> null', packFaceBS(null) === null && packFaceBS([]) === null && packFaceBS({ jawOpen: 1 }) === null);
  const u = unpackFaceBS(p);
  check('unpack: round trip', Math.abs(u.browInnerUp - 0.457) < 1e-9 && u.cheekPuff === 0.03);
  check('unpack: shorter (older) array tolerated', unpackFaceBS([0.5]).mouthPucker === 0);
}

// solve: grammar directions
{
  const n = solveFaceNMM(neutral);
  check('neutral face -> no markers', n.raise === 0 && n.furrow === 0 && n.wide === 0 && n.source === 'blendshapes');
  const yn = solveFaceNMM(face({ browOuterUpLeft: 0.7, browOuterUpRight: 0.7, browInnerUp: 0.6 }));
  check('raised brows -> raise high, furrow low (yes/no question)', yn.raise > 0.8 && yn.furrow < 0.1);
  const wh = solveFaceNMM(face({ browDownLeft: 0.6, browDownRight: 0.6 }));
  check('lowered brows -> furrow high, raise low (wh-question)', wh.furrow > 0.8 && wh.raise < 0.1);
  const both = solveFaceNMM(face({ browOuterUpLeft: 0.6, browOuterUpRight: 0.6, browInnerUp: 0.6, browDownLeft: 0.2, browDownRight: 0.2 }));
  check('conflict: stronger muscle wins', both.raise > both.furrow * 3);
  const worry = solveFaceNMM(face({ browInnerUp: 0.6 }));
  check('inner-only raise -> worry', worry.worry > 0.5);
  const all = solveFaceNMM(face({ browOuterUpLeft: 1, browOuterUpRight: 1, browInnerUp: 1, eyeWideLeft: 1, eyeWideRight: 1, cheekPuff: 1 }));
  check('all outputs clamped to [0,1]', Object.values(all).every((v) => typeof v !== 'number' || (v >= 0 && v <= 1)));
  const g = solveFaceNMM(null, 0.9);
  check('fallback: Kalidokit brow ratio -> raise only', g.raise > 0.9 && g.furrow === 0 && g.source === 'geometry');
  check('fallback: resting brow ratio reads neutral', solveFaceNMM(null, 0.3).raise === 0);
  check('no data -> none', solveFaceNMM(null, undefined).source === 'none');
}

// interpolation carries faceBS only when both ends have it
{
  const a = { faceBS: FACE_BS_KEYS.map(() => 0) }, b = { faceBS: FACE_BS_KEYS.map(() => 1) };
  const m = lerpFaceBS(a.faceBS, b.faceBS, 0.25);
  check('lerpFaceBS: linear', Math.abs(m[0] - 0.25) < 1e-9);
  check('lerpFaceBS: one side missing -> undefined (no snap)', lerpFaceBS(null, b.faceBS, 0.5) === undefined);
  check('lerpFrame carries faceBS', Math.abs(lerpFrame(a, b, 0.5).faceBS[3] - 0.5) < 1e-9);
}

// FaceRig on a fake VRoid mesh
{
  const mk = () => ({
    morphTargetDictionary: { 'Face.M_F00_000_00_Fcl_BRW_Surprised': 5, 'Face.M_F00_000_00_Fcl_BRW_Angry': 7, 'Face.M_F00_000_00_Fcl_ALL_Fun': 0 },
    morphTargetInfluences: new Array(10).fill(0),
  });
  const m1 = mk(), m2 = mk();
  const vrm = { scene: { traverse: (fn) => [m1, m2, {}].forEach(fn) } };
  const rig = new FaceRig(vrm);
  check('rig: finds brow morphs by suffix on every primitive', rig.targets.raise.length === 2 && rig.available.includes('furrow'));
  check('rig: absent morphs skipped (no wide/squint on fake)', !rig.available.includes('wide'));
  for (let i = 0; i < 20; i++) rig.setTracked({ raise: 1, furrow: 0 });
  check('rig: tracked raise converges', m1.morphTargetInfluences[5] > 0.95 && m2.morphTargetInfluences[5] > 0.95);
  check('rig: never touches whole-face preset morph', m1.morphTargetInfluences[0] === 0);
  rig.setScripted({ furrow: 0.6 });
  check('rig: scripted + tracked compose by max', Math.abs(m1.morphTargetInfluences[7] - 0.54) < 1e-9 && m1.morphTargetInfluences[5] > 0.95);
  for (let i = 0; i < 60; i++) rig.setTracked(null);
  rig.setScripted(null);
  check('rig: face lost + marker off -> decays to neutral', m1.morphTargetInfluences[5] < 0.01 && m1.morphTargetInfluences[7] === 0);
}

// Real VRoid case: three.js dictionaries are index-only; names come from vrm.__targetNameLists
{
  const names = ['Face.M_F00_000_00_Fcl_ALL_Fun', 'Face.M_F00_000_00_Fcl_BRW_Surprised', 'Face.M_F00_000_00_Fcl_BRW_Angry'];
  const prim = () => ({ morphTargetDictionary: { 0: 0, 1: 1, 2: 2 }, morphTargetInfluences: [0, 0, 0] });
  const p1 = prim(), p2 = prim(), body = { morphTargetDictionary: { 0: 0 }, morphTargetInfluences: [0] };
  const vrm = { __targetNameLists: [names, ['x', 'y']], scene: { traverse: (fn) => [p1, p2, body].forEach(fn) } };
  const rig = new FaceRig(vrm);
  check('rig: index-only dictionaries resolved from glTF primitive names', rig.targets.raise?.length === 2 && rig.targets.raise[0].index === 1);
  check('rig: meshes with no matching name list ignored', !rig.targets.raise.some((t) => t.mesh === body));
  for (let i = 0; i < 20; i++) rig.setTracked({ furrow: 1 });
  check('rig: writes the right index on real-style mesh', p1.morphTargetInfluences[2] > 0.8 && p1.morphTargetInfluences[0] === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
