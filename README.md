# SgSL · Mei

A Singapore Sign Language app where the anime avatar **Mei** signs — driven by
real webcam recordings, with accuracy treated as the first-class goal.

This is the single consolidated repo. The earlier multi-repo effort
(`sgsl-hub`, `sgsl-tic`) has been folded down to one hero avatar, one tracker,
one client-side app deployed on GitHub Pages.

## What it does (first build cycle)

- **Record** — webcam → MediaPipe Holistic → capture a sign (pose + face +
  both hands, with timestamps), gated on framing + calibration + a quality
  grade, then scored with an objective **replay-fidelity** number.
- **Text → Sign** — type a word/phrase → SgSL gloss → Mei chains the recorded
  signs (with transition blends + inter-sign pauses). Vocabulary is the
  recorded library only; unknown words are shown greyed-out and skipped.
- **Library** — browse and play recorded signs (committed library + your own
  device recordings).

Recognition (sign → text), the ML model, NMM facial grammar, and a real
database are deliberately **out of scope for this cycle** — but every recording
made now is exactly the labelled training data those phases will need.

## Architecture

100% client-side. No server required.

- **Avatar**: VRM 0.x model (`sgsl-app/assets/mei.vrm`) via Three.js 0.133 +
  `@pixiv/three-vrm` 0.6.7.
- **Tracking**: MediaPipe **Holistic 0.5.x** (legacy, pinned to an exact CDN
  build on purpose — the Kalidokit retarget is tuned to it). Modernising to the
  Tasks-Vision HolisticLandmarker is a later, separate task.
- **Retarget**: Kalidokit, customised for laptop-webcam signing
  (`sgsl-app/js/retarget.js`).
- **Storage**: committed JSON under `sgsl-app/signs/` for the shared library +
  IndexedDB for your own recordings. One-click JSON export → PR a sign into the
  library. The JSON shape matches the (future) Postgres `signs` schema, so a DB
  can be added later without reshaping data.

```
sgsl-app/            ← the GitHub Pages artifact (deploy-pages.yml uploads this)
  index.html         3-tab app: Sign It · Record · Library
  js/                hero modules (avatar, retarget, recorder, player, …)
  assets/mei.vrm     the hero avatar (swappable — see assets/mei.vrm.LICENSE.txt)
  signs/             committed sign library (+ _manifest.json)
  legacy/            the previous 2D-canvas app, archived (served, unlinked)
tools/               extract_signs.py, build_manifest.py (dev only, not served)
test/                test.mjs (logic) + replay_error.mjs (CI fidelity guard)
data-archive/        reference SQL dumps (not served)
```

## Run locally

The app is static, but ES modules + the camera need an `http://localhost`
origin (not `file://`):

```bash
cd sgsl-app
python3 -m http.server 8000   # then open http://localhost:8000
```

`localhost` is a secure context, so the webcam, MediaPipe, and WebGL all work.
No Python backend runs — `http.server` only serves files.

Dev API mode (optional, legacy FastAPI on the same origin): append `?api=1`.

## Tests

```bash
node test/test.mjs           # interpolation, fidelity metric, gloss, resolver, sentence engine
node test/replay_error.mjs   # fails if any committed v2 sign exceeds the fidelity threshold
```

## The accuracy loop

Record a reference sign → replay on Mei → read the fidelity number
(`metrics.js`, reported as % of shoulder-width with an A–F grade) → if it's over
your tolerance, tune `retarget.js` or re-record → repeat. `replay_error.mjs`
guards every committed sign in CI so tuning one sign can't silently wreck
another.

## Deploy

Push to `main` → `.github/workflows/deploy-pages.yml` uploads `sgsl-app/` to
GitHub Pages → https://harmanjohll.github.io/sgsl/

## Contributing signs

See [CONTRIBUTING-SIGNS.md](CONTRIBUTING-SIGNS.md).
