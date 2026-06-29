# v2 — tasks-worker (off-thread tracking)

**Status: built, UNTESTED by author — run it live and report.** This is an experiment, not a
replacement for v1. The only thing that changes vs v1 is the **tracking source**; the avatar and
the tuned retarget/calibration are reused unchanged.

## Why this exists
v1 ("movement becomes random after a while") runs two heavy ML models (Holistic + HandLandmarker)
on the **main thread**, starving the render loop over long sessions. Legacy Holistic is
DOM/main-thread-bound and **cannot** be moved into a Web Worker.

v2 switches the tracker to **MediaPipe Tasks-Vision** (PoseLandmarker + HandLandmarker +
FaceLandmarker), which is WASM and **worker-safe**, and runs all of it in a **Web Worker**. The
main thread only captures frames and renders → the render loop never starves.

## How it stays faithful (high fidelity to intent)
- Reuses **`sgsl-app/js/retarget.js` + `avatar.js` verbatim** via relative import — the single
  source of the calibration / orientation / deform-guard work. No drift.
- `js/adapter.js` maps the worker's output into the **exact `results` object** the retarget
  consumes, and routes hands L/R by **replicating `recorder.js::mergeHandLandmarker`** (so
  chirality + thumb match v1).
- Same pinned model weights (hand/pose/face `.task`) and the same every-other-frame hand throttle.

## Architecture
```
webcam ─▶ createImageBitmap ─(transfer)─▶ [Web Worker] track-worker.js
                                              Pose + Hand + Face (Tasks-Vision)
        avatar ◀─ retarget.applyFromMediaPipe ◀─ adapter.toResults ◀─(postMessage)─┘
```
- `js/track-worker.js` — module worker; loads Tasks-Vision, runs the three landmarkers, posts back
  plain arrays. Backpressure: one frame in flight at a time (drops frames under load instead of
  queueing — avoids the lag backlog).
- `js/adapter.js` — worker payload → legacy `results` shape.
- `js/app.js` — boots avatar + retarget, drives the camera→worker loop, draws the overlay, wires a
  compact calibration panel (same setters as v1; persisted under `sgsl.v2.calib.v1`).
- `index.html` — same global libs as v1 **minus** legacy Holistic; adds the Tasks-Vision worker.

This is a focused **live-mirror** page (camera → avatar). It does NOT include the full
Record / Library / Sign It UI — the point is to test the tracking change in isolation. If it wins
on stability, the worker swaps into `sgsl-app` behind a flag as a follow-up.

## How to run
From the **repository root** (needs the symlinked `assets` + `css`, and a module worker, so it
must be served, not opened as a file):
```bash
python3 -m http.server 8000
# then open:  http://localhost:8000/versions/v2-tasks-worker/
```

## What to verify (the whole reason v2 exists)
1. **It mirrors live** — raise a hand, the avatar follows; a `B` / `two` / point look right.
2. **Long-session stability** — run **several minutes** of continuous signing. Motion should stay
   smooth; the v1 "random after a while" degradation should be **gone** (main thread stays free).
3. **Calibration carries** — the sliders move the hand exactly like v1; settings persist on reload.
4. The HUD (`#v2-debug`) shows per-side facing / curl / calib, same as v1's console.

### Known risks (why it's user-verified, not author-verified)
- Tasks-Vision **PoseLandmarker** world landmarks feed Kalidokit instead of Holistic's — same 33
  BlazePose topology, but the torso/arm solve may differ slightly. Watch arm reach/height.
- Worker WASM loading from CDN must succeed (first load fetches the `.task` weights + wasm).
- If the worker errors on init, the status line shows it; tell me and we fall back.
