/* ============================================================
   SgSL fidelity harness — headless browser bone-vs-landmark scorer
   ============================================================
   Drives the REAL v2 page (?replay=1) in headless Chromium, injects
   synthetic ground-truth landmark frames through the exact production
   path (adapter.toResults → retarget.applyFromMediaPipe), reads back
   avatar bone world transforms, and scores fidelity numerically.

   Convention-free metrics (no assumption about the retarget's axis map):
     ORIENT  per-frame delta-angle rigidity: conjugation preserves rotation
             angle, so when the input hand rotates X° the avatar hand bone
             must also rotate ~X°. A winding flip shows as a ~180° avatar
             step against a 5-10° input step.
     SHAPE   PIP/DIP bend angles (scalars) avatar vs landmarks.
     ARM     |posed wrist − IK's own target| in shoulder-widths (does the
             solver reach its own dot?) + max per-frame wrist jump during
             occlusion / handedness-flip scenarios (stability).

   Usage: node test/fidelity_run.mjs [--json out.json]
   CDN is blocked in this container → all jsdelivr URLs are fulfilled
   from test/vendor/ (exact pinned versions).
   ============================================================ */

import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { buildScenarios, qMul, qConj, qAngle } from './fixtures/synthetic_hands.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch {
  const g = execSync('npm root -g').toString().trim();
  pw = require(join(g, 'playwright'));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'test', 'vendor');
const PORT = 8987;
const K = 8;                       // applies per frame (slerp convergence at smoothing=0)
const DEG = 180 / Math.PI;

// jsdelivr path fragment -> vendored file
const VENDOR_MAP = {
  'three@0.133.0/build/three.min.js': 'three.min.js',
  'three@0.133.0/examples/js/loaders/GLTFLoader.js': 'GLTFLoader.js',
  'three@0.133.0/examples/js/controls/OrbitControls.js': 'OrbitControls.js',
  '@pixiv/three-vrm@0.6.7/lib/three-vrm.js': 'three-vrm.js',
  'kalidokit@1.1.5/dist/kalidokit.es.js': 'kalidokit.es.js',
};

// Thresholds (the "loop till fixed" pass bar).
const PASS = {
  orientMeanErr: 8,     // deg: mean |avatar step − input step|
  orientMaxStep: 90,    // deg: no avatar step >90° when input step <15° (flip detector)
  shapeMeanErr: 15,     // deg: mean PIP/DIP bend error
  armReach: 0.25,       // shoulder-widths: median |wrist − IK target| (converged frames)
  armMaxJump: 0.35,     // shoulder-widths: max per-frame wrist jump in occlusion/flip scenarios
};

async function startServer() {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/versions/v2-tasks-worker/index.html`); return srv; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  srv.kill(); throw new Error('http.server did not come up');
}

// Runs one scenario in the page; returns per-frame measurements.
const MEASURE = async ({ frames, side, K }) => {
  const T = window.__sgslTest;
  const THREE = window.THREE;
  const BN = THREE.VRMSchema.HumanoidBoneName;
  const vrm = T.avatar.vrm;
  // Deterministic tuning: retarget defaults but NO smoothing (harness measures math, not lag).
  for (const s of ['Right', 'Left']) T.retarget.setHandTuning(s, { smoothing: 0 });
  const hand = vrm.humanoid.getBoneNode(BN[side + 'Hand']);
  const out = [];
  for (const fr of frames) {
    const results = T.toResults(fr.payload);
    for (let k = 0; k < K; k++) T.applyResults(results);
    vrm.scene.updateMatrixWorld(true);
    const q = hand.getWorldQuaternion(new THREE.Quaternion());
    const wrist = hand.getWorldPosition(new THREE.Vector3());
    const armDbg = (T.retarget._armDbg || {})[side] || null;
    const bends = {};
    // VRM names the pinky "Little"; fixtures/gt call it "Pinky".
    for (const [f, rigName] of [['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']]) {
      const bones = ['Proximal', 'Intermediate', 'Distal'].map(s2 => vrm.humanoid.getBoneNode(BN[side + rigName + s2]));
      if (bones.some(b => !b)) continue;
      const p = bones.map(b => b.getWorldPosition(new THREE.Vector3()));
      const rigF = T.avatar.handRig?.[side]?.fingers?.[rigName]?.[2];
      const dq = bones[2].getWorldQuaternion(new THREE.Quaternion());
      const dDir = rigF?.fwdLocal ? rigF.fwdLocal.clone().applyQuaternion(dq) : null;
      const seg1 = p[1].clone().sub(p[0]), seg2 = p[2].clone().sub(p[1]);
      const ang = (a, b) => a.angleTo(b) * 180 / Math.PI;
      bends[f] = [null, ang(seg1, seg2), dDir ? ang(seg2, dDir) : null];
    }
    const dbg = (T.retarget._handDbg || {})[side] || null;
    out.push({
      q: [q.x, q.y, q.z, q.w],
      wrist: [wrist.x, wrist.y, wrist.z],
      target: armDbg?.target || null,
      shoulderW: armDbg?.shoulderW || null,
      bends,
      facing: dbg ? dbg.facing : null,
    });
  }
  return out;
};

function scoreOrient(name, frames, meas) {
  const steps = [];
  for (let i = 1; i < meas.length; i++) {
    const gtStep = qAngle(qMul(frames[i].gt.quat, qConj(frames[i - 1].gt.quat))) * DEG;
    const q0 = meas[i - 1].q, q1 = meas[i].q;
    const avStep = qAngle(qMul(q1, qConj(q0))) * DEG;
    steps.push({ gtStep, avStep, err: Math.abs(avStep - gtStep) });
  }
  const meanErr = steps.reduce((s, x) => s + x.err, 0) / steps.length;
  const flips = steps.filter(x => x.gtStep < 15 && x.avStep > PASS.orientMaxStep);
  const maxStep = Math.max(...steps.map(x => x.avStep));
  return {
    name, kind: 'orient',
    meanErr: +meanErr.toFixed(1), maxStep: +maxStep.toFixed(1), flipCount: flips.length,
    pass: meanErr < PASS.orientMeanErr && flips.length === 0,
  };
}

function scoreShape(name, frames, meas) {
  // last 5 frames (converged); PIP+DIP only (MCP definition is rig-geometry-dependent).
  const errs = [];
  for (const m of meas.slice(-5)) {
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      const gt = frames[0].gt.bends[f], av = m.bends[f];
      if (!av) continue;
      for (const j of [1, 2]) if (av[j] != null) errs.push(Math.abs(av[j] - gt[j]));
    }
  }
  const meanErr = errs.reduce((s, x) => s + x, 0) / (errs.length || 1);
  return { name, kind: 'shape', meanErr: +meanErr.toFixed(1), pass: meanErr < PASS.shapeMeanErr };
}

function scoreArm(name, frames, meas) {
  const sw = meas.find(m => m.shoulderW)?.shoulderW || 0.25;
  const dists = meas.filter(m => m.target).map(m =>
    Math.hypot(m.wrist[0] - m.target[0], m.wrist[1] - m.target[1], m.wrist[2] - m.target[2]) / sw);
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
  let maxJump = 0;
  for (let i = 1; i < meas.length; i++) {
    const j = Math.hypot(...[0, 1, 2].map(k => meas[i].wrist[k] - meas[i - 1].wrist[k])) / sw;
    if (j > maxJump) maxJump = j;
  }
  const stab = name !== 'cross-clean';
  return {
    name, kind: 'arm',
    medianReach: +median.toFixed(3), maxJump: +maxJump.toFixed(3),
    pass: (stab ? maxJump < PASS.armMaxJump : true) && median < PASS.armReach,
  };
}

async function main() {
  const jsonOut = process.argv.includes('--json')
    ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const scenarios = buildScenarios();
  const srv = await startServer();
  const browser = await pw.chromium.launch();
  const results = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('  [console]', m.text().slice(0, 200)); });
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
      const hit = Object.keys(VENDOR_MAP).find(k => url.includes(k));
      if (hit) return route.fulfill({ path: join(VENDOR, VENDOR_MAP[hit]), contentType: 'text/javascript' });
      return route.abort();
    });

    for (const sc of scenarios) {
      // Fresh page per scenario: resets retarget streaks/facing state + bone pose.
      await page.goto(`http://localhost:${PORT}/versions/v2-tasks-worker/?replay=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__sgslTest && window.__sgslTest.avatar?.loaded === true, null, { timeout: 90000 });
      const meas = await page.evaluate(MEASURE, { frames: sc.frames, side: sc.side, K });
      const score = sc.kind === 'orient' ? scoreOrient(sc.name, sc.frames, meas)
        : sc.kind === 'shape' ? scoreShape(sc.name, sc.frames, meas)
        : scoreArm(sc.name, sc.frames, meas);
      score.facingChanges = meas.reduce((n, m, i) => n + (i > 0 && m.facing !== meas[i - 1].facing ? 1 : 0), 0);
      results.push(score);
      console.log(`${score.pass ? 'PASS' : 'FAIL'}  ${sc.name.padEnd(16)} ${JSON.stringify({ ...score, name: undefined, kind: undefined, pass: undefined })}`);
    }
  } finally {
    await browser.close();
    srv.kill();
  }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios pass.`);
  if (jsonOut) { mkdirSync(dirname(jsonOut), { recursive: true }); writeFileSync(jsonOut, JSON.stringify({ results }, null, 1)); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
