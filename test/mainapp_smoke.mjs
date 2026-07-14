/* Main-app smoke: boots sgsl-app/ in headless Chromium with a FAKE camera and the
   default worker tracker, and asserts the full pipeline comes up: module graph loads,
   avatar boots, the tracking worker reaches READY (models + wasm real), no page errors.
   CDN is blocked in this container: pinned libs come from test/vendor/, the
   tasks-vision bundle+wasm are fetched once from registry.npmjs.org into
   test/vendor/tasks-vision/ (gitignored), and the .task models load live from
   storage.googleapis.com (reachable). Run: node test/mainapp_smoke.mjs */

import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); }
catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'test', 'vendor');
const TV = join(VENDOR, 'tasks-vision');
const PORT = 8988;

const VENDOR_MAP = {
  'three@0.133.0/build/three.min.js': 'three.min.js',
  'three@0.133.0/examples/js/loaders/GLTFLoader.js': 'GLTFLoader.js',
  'three@0.133.0/examples/js/controls/OrbitControls.js': 'OrbitControls.js',
  '@pixiv/three-vrm@0.6.7/lib/three-vrm.js': 'three-vrm.js',
  'kalidokit@1.1.5/dist/kalidokit.es.js': 'kalidokit.es.js',
};

const MODELS = {
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

function ensureTasksVision() {
  // Headless Chromium has no proxy config in this container, so ALL external bytes
  // (bundle, wasm, .task models) are cached locally by curl (proxy-aware) and served
  // via route.fulfill. One-time; gitignored.
  if (!existsSync(join(TV, 'vision_bundle.mjs'))) {
    console.log('fetching @mediapipe/tasks-vision@0.10.14 from npm registry (one-time)…');
    mkdirSync(TV, { recursive: true });
    execSync(`curl -sSL https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz | tar xz -C "${TV}" --strip-components=1 package/vision_bundle.mjs package/wasm`, { stdio: 'inherit' });
  }
  mkdirSync(join(TV, 'models'), { recursive: true });
  for (const [name, url] of Object.entries(MODELS)) {
    const f = join(TV, 'models', name);
    if (!existsSync(f)) {
      console.log(`fetching ${name} (one-time)…`);
      execSync(`curl -sSL -o "${f}" "${url}"`, { stdio: 'inherit' });
    }
  }
}

async function main() {
  ensureTasksVision();
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${PORT}/sgsl-app/index.html`); break; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  const browser = await pw.chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const errors = [];
  let ok = false;
  try {
    const context = await browser.newContext({ permissions: ['camera'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await context.route('**/*', (route) => {   // context-level: intercepts worker fetches too
      const url = route.request().url();
      if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
      const model = Object.keys(MODELS).find(n => url.endsWith(n));
      if (model) return route.fulfill({ path: join(TV, 'models', model), contentType: 'application/octet-stream' });
      if (url.includes('@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'))
        return route.fulfill({ path: join(TV, 'vision_bundle.mjs'), contentType: 'text/javascript' });
      const wasm = url.match(/@mediapipe\/tasks-vision@0\.10\.14\/wasm\/(.+)$/);
      if (wasm) {
        const f = join(TV, 'wasm', wasm[1]);
        if (existsSync(f)) return route.fulfill({ path: f, contentType: wasm[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
      }
      const hit = Object.keys(VENDOR_MAP).find(k => url.includes(k));
      if (hit) return route.fulfill({ path: join(VENDOR, VENDOR_MAP[hit]), contentType: 'text/javascript' });
      return route.abort();
    });
    await page.goto(`http://localhost:${PORT}/sgsl-app/`, { waitUntil: 'domcontentloaded' });
    // recorder.js (and the tracking pipeline) lazy-loads when the Record tab opens.
    await page.click('.tab[data-tab="contribute"]');
    // The whole pipeline: avatar boots AND the tracking worker reaches ready.
    await page.waitForFunction(() => window.__sgslWorkerReady === true, null, { timeout: 120000 });
    // Let it run a couple of seconds of fake-camera frames.
    await page.waitForTimeout(2500);
    const debugText = await page.evaluate(() => document.getElementById('rec-debug')?.textContent || '');
    ok = errors.length === 0;
    console.log(`worker ready: yes | HUD alive: ${debugText.includes('Frame') ? 'yes' : 'no'} | page errors: ${errors.length}`);
    if (errors.length) console.log('errors:', errors.slice(0, 5));
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
