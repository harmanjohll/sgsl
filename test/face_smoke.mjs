/* Face NMM browser smoke: boots sgsl-app in headless Chromium (no camera, no MediaPipe
   models needed), loads the real hero VRM through the Playback engine, and checks the
   brow channel end to end on the real mesh:
     - recorded frame.faceBS (raised / lowered brows) reaches the Fcl_BRW_* morphs,
     - scripted markers ('question', 'wh-question') drive brows, NOT the whole-face presets,
     - no page errors.
   Writes face close-ups to test/out/face_*.png for a visual check.
   Run: node test/face_smoke.mjs */

import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'test', 'vendor');
const OUT = join(ROOT, 'test', 'out');
const PORT = 8989;
const VENDOR_MAP = {
  'three@0.133.0/build/three.min.js': 'three.min.js',
  'three@0.133.0/examples/js/loaders/GLTFLoader.js': 'GLTFLoader.js',
  'three@0.133.0/examples/js/controls/OrbitControls.js': 'OrbitControls.js',
  '@pixiv/three-vrm@0.6.7/lib/three-vrm.js': 'three-vrm.js',
  'kalidokit@1.1.5/dist/kalidokit.es.js': 'kalidokit.es.js',
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/sgsl-app/index.html`); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  const browser = await pw.chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  let ok = false;
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
      const hit = Object.keys(VENDOR_MAP).find((k) => url.includes(k));
      if (hit) return route.fulfill({ path: join(VENDOR, VENDOR_MAP[hit]), contentType: 'text/javascript' });
      return route.abort();
    });
    await page.goto(`http://localhost:${PORT}/sgsl-app/`, { waitUntil: 'domcontentloaded' });

    // A dedicated viewport so the app's own avatars are untouched.
    await page.evaluate(async () => {
      const div = document.createElement('div');
      div.id = 'face-smoke';
      div.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:600px;z-index:99999;background:#fff';
      document.body.appendChild(div);
      const { Playback } = await import('./js/player.js');
      window.__pb = new Playback('face-smoke');
    });
    await page.waitForFunction(() => window.__pb?.ready === true, null, { timeout: 90000 });

    const r = await page.evaluate(async () => {
      const { faceRigFor, FACE_BS_KEYS } = await import('./js/face-nmm.js');
      const pb = window.__pb, av = pb.avatar, vrm = av.vrm;
      const rig = faceRigFor(vrm);
      // Frame the face.
      const head = vrm.humanoid.getBoneNode(THREE.VRMSchema.HumanoidBoneName.Head);
      const hp = new THREE.Vector3(); head.getWorldPosition(hp);
      av.camera.position.set(hp.x, hp.y + 0.06, hp.z + 0.55);
      av.controls.target.set(hp.x, hp.y + 0.06, hp.z);
      av.controls.update();

      const t = rig.targets;
      const read = (ch) => t[ch] ? t[ch][0].mesh.morphTargetInfluences[t[ch][0].index] : null;
      // whole-face preset morphs the old NMM code used to drive (ALL_Fun / ALL_Angry)
      const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); };
      const bs = (o) => FACE_BS_KEYS.map((k) => o[k] ?? 0.02);
      const play = async (frame, n = 25) => { for (let i = 0; i < n; i++) pb.renderFrame(frame); await settle(); };

      const out = { available: rig.available };
      await play({ faceBS: bs({}) });
      out.neutral = { raise: read('raise'), furrow: read('furrow') };
      await play({ faceBS: bs({ browOuterUpLeft: 0.7, browOuterUpRight: 0.7, browInnerUp: 0.6, eyeWideLeft: 0.5, eyeWideRight: 0.5 }) });
      out.recordedRaise = { raise: read('raise'), furrow: read('furrow') };
      await settle();
      return out;
    });
    await page.locator('#face-smoke').screenshot({ path: join(OUT, 'face_recorded_raise.png') });

    const r2 = await page.evaluate(async () => {
      const { faceRigFor, FACE_BS_KEYS } = await import('./js/face-nmm.js');
      const pb = window.__pb, vrm = pb.avatar.vrm, rig = faceRigFor(vrm), t = rig.targets;
      const read = (ch) => t[ch][0].mesh.morphTargetInfluences[t[ch][0].index];
      const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); };
      const bs = (o) => FACE_BS_KEYS.map((k) => o[k] ?? 0.02);
      for (let i = 0; i < 25; i++) pb.renderFrame({ faceBS: bs({ browDownLeft: 0.6, browDownRight: 0.6 }) });
      await settle();
      return { recordedFurrow: { raise: read('raise'), furrow: read('furrow') } };
    });
    await page.locator('#face-smoke').screenshot({ path: join(OUT, 'face_recorded_furrow.png') });

    const r3 = await page.evaluate(async () => {
      const { faceRigFor } = await import('./js/face-nmm.js');
      const pb = window.__pb, av = pb.avatar, vrm = av.vrm, rig = faceRigFor(vrm), t = rig.targets;
      const read = (ch) => t[ch][0].mesh.morphTargetInfluences[t[ch][0].index];
      const faceMesh = t.raise[0].mesh, dict = faceMesh.morphTargetDictionary;
      const names = vrm.__targetNameLists.find((l) => l.length === faceMesh.morphTargetInfluences.length);
      const readAll = (s) => faceMesh.morphTargetInfluences[names.findIndex((n) => n.endsWith(s))];
      const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); };
      // no face in frames: tracked decays, scripted grammar takes over
      for (let i = 0; i < 60; i++) pb.renderFrame({});
      const out = {};
      for (let i = 0; i < 40; i++) av.applyNMM('question');
      await settle();
      out.scriptedQuestion = { raise: read('raise'), furrow: read('furrow'), allFun: readAll('Fcl_ALL_Fun'), allAngry: readAll('Fcl_ALL_Angry') };
      return out;
    });
    await page.locator('#face-smoke').screenshot({ path: join(OUT, 'face_scripted_question.png') });

    const r4 = await page.evaluate(async () => {
      const { faceRigFor } = await import('./js/face-nmm.js');
      const pb = window.__pb, av = pb.avatar, vrm = av.vrm, rig = faceRigFor(vrm), t = rig.targets;
      const read = (ch) => t[ch][0].mesh.morphTargetInfluences[t[ch][0].index];
      const faceMesh = t.raise[0].mesh, dict = faceMesh.morphTargetDictionary;
      const names = vrm.__targetNameLists.find((l) => l.length === faceMesh.morphTargetInfluences.length);
      const readAll = (s) => faceMesh.morphTargetInfluences[names.findIndex((n) => n.endsWith(s))];
      const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); };
      for (let i = 0; i < 60; i++) av.applyNMM(null);           // blend out, then switch kind
      for (let i = 0; i < 40; i++) av.applyNMM('wh-question');
      await settle();
      const out = { scriptedWh: { raise: read('raise'), furrow: read('furrow'), allAngry: readAll('Fcl_ALL_Angry') } };
      for (let i = 0; i < 80; i++) av.applyNMM(null);
      await settle();
      out.afterNeutral = { raise: read('raise'), furrow: read('furrow') };
      return out;
    });
    await page.locator('#face-smoke').screenshot({ path: join(OUT, 'face_scripted_wh.png') });

    const res = { ...r, ...r2, ...r3, ...r4 };
    console.log(JSON.stringify(res, null, 1));
    const checks = [
      ['brow + eye morphs found on hero model', ['raise', 'furrow', 'wide'].every((c) => res.available.includes(c))],
      ['neutral face -> brows at rest', res.neutral.raise < 0.05 && res.neutral.furrow < 0.05],
      ['recorded raised brows reach the mesh', res.recordedRaise.raise > 0.7 && res.recordedRaise.furrow < 0.2],
      ['recorded lowered brows reach the mesh', res.recordedFurrow.furrow > 0.6 && res.recordedFurrow.raise < 0.2],
      ['yes/no question -> raised brows', res.scriptedQuestion.raise > 0.6],
      ['yes/no question no longer drives whole-face smile', res.scriptedQuestion.allFun < 0.01],
      ['wh-question -> furrowed brows', res.scriptedWh.furrow > 0.6 && res.scriptedWh.raise < 0.1],
      ['wh-question does not drive whole-face anger', res.scriptedWh.allAngry < 0.01],
      ['marker off -> neutral again', res.afterNeutral.raise < 0.05 && res.afterNeutral.furrow < 0.05],
      ['no page errors', errors.length === 0],
    ];
    for (const [n, c] of checks) console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`);
    if (errors.length) console.log('errors:', errors.slice(0, 5));
    ok = checks.every(([, c]) => c);
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(ok ? 'FACE SMOKE PASS' : 'FACE SMOKE FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
