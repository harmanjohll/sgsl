# v1 — legacy (the live app)

**This version is the existing app at [`../../sgsl-app/`](../../sgsl-app/).** There is no code
duplicated here on purpose — duplicating it would let the two copies drift. v1 *is* `sgsl-app/`,
and it is the only variant deployed to GitHub Pages.

## What it is
The current, working SgSL digital-twin app: record a real sign from the webcam → the Fumi avatar
replays it exactly → (later) recognize. Includes the full Record / Sign It / Library UI, the tuned
per-hand calibration panel, the deformation guard, screenshots, and `.json` capture for the
accuracy loop.

## Tracking source
- **MediaPipe Holistic 0.5.x** (legacy CDN solution) for pose + face — runs on the **main thread**.
- **MediaPipe Tasks HandLandmarker 0.10.14** for true 3D (metric) hand world landmarks — also main
  thread, throttled to every other frame.
- Custom retarget (`sgsl-app/js/retarget.js`) → `@pixiv/three-vrm` 0.6.7 avatar (`mei.vrm`).

This is the fidelity baseline. `retarget.js` + `avatar.js` here are the **single source** that the
other variants reuse, so the calibration/orientation work carries across all three.

## How to run
From the **repository root**:
```bash
python3 -m http.server 8000
# then open:  http://localhost:8000/sgsl-app/
```
`localhost` is a secure context, so webcam + WebGL work. (Also live on GitHub Pages.)

## Known limits (why v2 and v3 exist)
- **Long-session slowdown / "movement becomes random after a while."** Two heavy ML models
  (Holistic + HandLandmarker) run on the main thread and compete with the render loop. Legacy
  Holistic is DOM/main-thread-bound and *cannot* be moved into a Web Worker — this is the specific
  problem **v2 (`../v2-tasks-worker/`)** targets by switching the tracker to MediaPipe Tasks-Vision
  running off-thread in a worker.
- **Fingerspelling fidelity on tight shapes** (e.g. `O` / `D`): in-browser hand landmarks are the
  ceiling. **v3 (`../v3-wilor-twin/`)** explores GPU MANO hand reconstruction (WiLoR) for those.

v1 stays the trustworthy default while v2/v3 are evaluated.
