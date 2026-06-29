/* ============================================================
   SgSL v3 — WiLoR digital-twin (web client)  [SCAFFOLD]
   ============================================================
   GOAL: in-browser pose/face, but HANDS reconstructed by WiLoR
   (MANO) on a GPU server for the highest-fidelity fingerspelling
   (the v1/v2 ceiling on tight shapes like O / D).

   STATUS: scaffold. GPU + WiLoR are DEFERRED. This page RUNS TODAY
   using in-browser hands (the v2 worker) as the fallback, and opens
   a WebSocket to the server; when the server returns real WiLoR
   hands it splices them in, otherwise it stays on in-browser hands.

   Reuses (single source, no drift):
     - ../../../sgsl-app/js/{avatar.js,retarget.js}   (tuned avatar + retarget)
     - ../../v2-tasks-worker/js/{track-worker.js,adapter.js}  (in-browser tracking)
   `assets`/`css` are symlinks in this folder (see ../README.md).

   Server contract (server/app.py):
     client -> server : binary JPEG frame (downscaled)
     server -> client : {type:'hands', right:[[x,y,z]*21]|null, left:[...]|null}
       where each hand is 21 METRIC world landmarks (MediaPipe order),
       i.e. drop-in for results.{right,left}HandWorldLandmarks. null = no
       override this frame (client keeps in-browser hands).
   ============================================================ */

import { SMPLXAvatar } from '../../../sgsl-app/js/avatar.js';
import { SMPLXRetarget } from '../../../sgsl-app/js/retarget.js';
import { toResults } from '../../v2-tasks-worker/js/adapter.js';

const WS_URL = 'ws://localhost:8765/ws';   // set to your GPU droplet when ready

const video = document.getElementById('v3-video');
const overlay = document.getElementById('v3-overlay');
const statusEl = document.getElementById('v3-status');
const srcEl = document.getElementById('v3-source');
const dbgEl = document.getElementById('v3-debug');

const setStatus = (m, k = 'info') => { if (statusEl) { statusEl.textContent = m; statusEl.className = `status status-${k}`; } };

const avatar = new SMPLXAvatar('v3-avatar-viewport');
const retarget = new SMPLXRetarget();
retarget.setVideo(video);
retarget.setAvatar(avatar);

// ── In-browser tracking (v2 worker) ────────────────────────────────────────
const worker = new Worker(new URL('../../v2-tasks-worker/js/track-worker.js', import.meta.url), { type: 'module' });
let workerReady = false, inFlight = false, tsCtr = 0;

// ── WiLoR server (deferred GPU) ────────────────────────────────────────────
let ws = null, wsOpen = false;
let wilorRight = null, wilorLeft = null;     // most recent server hands (world landmarks)
const scratch = document.createElement('canvas');   // downscale frames for upload

function connectServer() {
  try {
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { wsOpen = true; updateSource(); };
    ws.onclose = () => { wsOpen = false; wilorRight = wilorLeft = null; updateSource(); setTimeout(connectServer, 3000); };
    ws.onerror = () => { /* onclose handles retry */ };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hands') { wilorRight = msg.right || null; wilorLeft = msg.left || null; }
      } catch (err) { /* ignore */ }
    };
  } catch (e) { wsOpen = false; updateSource(); }
}
function updateSource() {
  if (!srcEl) return;
  srcEl.textContent = wsOpen ? 'Hands: WiLoR server (GPU)' : 'Hands: in-browser (server offline)';
  srcEl.style.color = wsOpen ? 'var(--success)' : 'var(--warning)';
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'ready') { workerReady = true; setStatus('Tracking ready — raise a hand.', 'success'); return; }
  if (msg.type === 'error') { setStatus(`Worker failed: ${msg.message}`, 'error'); return; }
  if (msg.type === 'result') {
    inFlight = false;
    const results = toResults(msg);
    // Override hands with WiLoR world landmarks when the server is providing them.
    if (wsOpen && wilorRight) results.rightHandWorldLandmarks = wilorRight;
    if (wsOpen && wilorLeft) results.leftHandWorldLandmarks = wilorLeft;
    if (avatar.vrm) retarget.applyFromMediaPipe(avatar.vrm, results);
    drawOverlay(results);
    if (dbgEl && retarget._lastDebug) dbgEl.textContent = retarget._lastDebug;
  }
};
worker.postMessage({ type: 'init' });

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    video.srcObject = stream; await video.play();
    setStatus('Camera on — loading tracking model…', 'loading');
    connectServer();
    requestAnimationFrame(pump);
  } catch (err) { setStatus(`Camera failed: ${err.message}`, 'error'); }
}

async function pump() {
  if (workerReady && !inFlight && video.readyState >= 2) {
    inFlight = true;
    try {
      const bitmap = await createImageBitmap(video);
      worker.postMessage({ type: 'frame', bitmap, ts: ++tsCtr * 33 }, [bitmap]);
    } catch (e) { inFlight = false; }
  }
  // When the GPU server is up, also ship a downscaled JPEG for WiLoR.
  if (wsOpen && ws && ws.readyState === 1 && video.readyState >= 2) {
    const W = 256, H = Math.round(256 * (video.videoHeight || 480) / (video.videoWidth || 640));
    scratch.width = W; scratch.height = H;
    scratch.getContext('2d').drawImage(video, 0, 0, W, H);
    scratch.toBlob((b) => { if (b && ws.readyState === 1) b.arrayBuffer().then((buf) => ws.send(buf)); }, 'image/jpeg', 0.7);
  }
  requestAnimationFrame(pump);
}

function drawOverlay(results) {
  if (!overlay || !video) return;
  overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;
  const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
  const dots = (lms, c, r = 3) => { if (!lms) return; ctx.fillStyle = c; for (const lm of lms) { ctx.beginPath(); ctx.arc(lm.x * overlay.width, lm.y * overlay.height, r, 0, Math.PI * 2); ctx.fill(); } };
  dots(results.rightHandLandmarks, '#00ff88'); dots(results.leftHandLandmarks, '#ff8800');
}

updateSource();
start();
