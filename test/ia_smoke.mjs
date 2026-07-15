/* IA smoke: the restructured app loads and all three modes (Learn / Test /
   Contribute) initialize in headless Chromium with a fake camera — Learn
   renders lessons + library on a live avatar, Test loads its controller,
   Contribute's tracking worker reaches ready. Zero page errors.
   Run: node test/ia_smoke.mjs  (shares the vendored-CDN + cached-model setup). */
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const VENDOR = join(ROOT, 'test', 'vendor'), TV = join(VENDOR, 'tasks-vision');
const VM = { 'three@0.133.0/build/three.min.js': 'three.min.js', 'three@0.133.0/examples/js/loaders/GLTFLoader.js': 'GLTFLoader.js', 'three@0.133.0/examples/js/controls/OrbitControls.js': 'OrbitControls.js', '@pixiv/three-vrm@0.6.7/lib/three-vrm.js': 'three-vrm.js', 'kalidokit@1.1.5/dist/kalidokit.es.js': 'kalidokit.es.js' };
const MODELS = ['hand_landmarker.task', 'pose_landmarker_lite.task', 'face_landmarker.task'];
const PORT = 8992;

if (!existsSync(join(TV, 'models', MODELS[0]))) { console.error('run test/mainapp_smoke.mjs once first (caches models)'); process.exit(2); }

const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/sgsl-app/index.html`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ permissions: ['camera'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push('[console] ' + m.text().slice(0, 140)); });
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
  const model = MODELS.find(n => url.endsWith(n));
  if (model) return route.fulfill({ path: join(TV, 'models', model), contentType: 'application/octet-stream' });
  if (url.includes('tasks-vision@0.10.14/vision_bundle.mjs')) return route.fulfill({ path: join(TV, 'vision_bundle.mjs'), contentType: 'text/javascript' });
  const w = url.match(/tasks-vision@0\.10\.14\/wasm\/(.+?)$/);
  if (w && existsSync(join(TV, 'wasm', w[1]))) return route.fulfill({ path: join(TV, 'wasm', w[1]), contentType: w[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
  const hit = Object.keys(VM).find(k => url.includes(k));
  if (hit) return route.fulfill({ path: join(VENDOR, VM[hit]), contentType: 'text/javascript' });
  return route.abort();
});
let ok = false;
try {
  await page.goto(`http://localhost:${PORT}/sgsl-app/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#learn-lessons .lesson-card').length > 0, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#learn-list .sign-row').length > 0, null, { timeout: 30000 }).catch(() => {});
  const learn = await page.evaluate(() => ({ lessons: document.querySelectorAll('#learn-lessons .lesson-card').length, lib: document.querySelectorAll('#learn-list .sign-row').length, canvas: !!document.querySelector('#learn-viewport canvas') }));
  await page.click('.tab[data-tab="test"]'); await page.waitForTimeout(400);
  const testOk = await page.evaluate(() => document.getElementById('tab-test')?.classList.contains('active') && !!document.getElementById('btn-test-start'));
  await page.click('.tab[data-tab="contribute"]');
  await page.waitForFunction(() => window.__sgslWorkerReady === true, null, { timeout: 120000 });
  ok = errors.length === 0 && learn.lessons > 0 && learn.lib > 0 && learn.canvas && testOk;
  console.log(`Learn: ${learn.lessons} lessons, ${learn.lib} library rows, avatar:${learn.canvas} | Test:${testOk} | Contribute worker: ready | errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 6));
} finally { await browser.close(); srv.kill(); }
console.log(ok ? 'IA SMOKE PASS' : 'IA SMOKE FAIL');
process.exit(ok ? 0 : 1);
