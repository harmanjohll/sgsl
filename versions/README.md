# SgSL — approach variants (A/B sandbox)

Three independent versions of the **digital-twin** goal — *the avatar reproduces exactly what the
signer does* — so we can run/test each separately and compare fidelity. The **shared north star**
for all: faithful hand orientation + handshape + reach, scored the same way (replay fidelity).

Where possible each version **reuses the tuned `sgsl-app/js/retarget.js` + `avatar.js`**, so the
calibration/orientation work carries over and only the *tracking source* differs. That's what keeps
fidelity consistent across types.

| Version | Dir | Tracking | Runs where | Status |
|---|---|---|---|---|
| **v1 legacy** (current/deployed) | `../sgsl-app/` | MediaPipe **Holistic** (legacy, main thread) + Tasks HandLandmarker | Browser, GitHub Pages | live |
| **v2 tasks-worker** | `v2-tasks-worker/` | MediaPipe **Tasks-Vision** (Pose+Hand+Face) in a **Web Worker** | Browser, local | built, UNTESTED by author |
| **v3 wilor-twin** | `v3-wilor-twin/` | In-browser pose/face + **WiLoR hands on a GPU server** | Browser + GPU backend | scaffold (GPU deferred) |

## How to run (serve from the repo root)
```bash
python3 -m http.server 8000      # from the repo root
# v1: http://localhost:8000/sgsl-app/
# v2: http://localhost:8000/versions/v2-tasks-worker/
# v3: http://localhost:8000/versions/v3-wilor-twin/web/   (needs the server — see its README)
```
`localhost` is a secure context, so webcam + WebGL work. Each version is self-contained except it
imports the shared `avatar.js`/`retarget.js` from `sgsl-app/` (single source — no drift).

## Important
- I (the author) cannot browser/GPU-test these here. v2/v3 are best-effort — run them and report;
  we iterate. v1 remains the trustworthy baseline and the only thing deployed to Pages.
- Fidelity check for any version: does the avatar match a `two` / `B` / fingerspelling pass, and does
  it stay stable over a long session?
