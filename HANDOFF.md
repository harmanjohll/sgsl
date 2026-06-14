# SgSL — Project Handoff & Review Brief

> Purpose: brief a Claude Code session (running locally in the `sgsl-tic`
> folder, or a new cloud session scoped to `sgsl-hub`) so it can review the
> existing work and continue toward the objective below. Paste this in and say
> "review `sgsl-hub` per this handoff."

## 0. Your role (new/local session)
First task is **review, not build**. Read the local app `sgsl-hub`, understand
its intent, and report:
1. What it does and how it tries to meet the objective.
2. What works and what's broken (with file references).
3. An honest **salvage-vs-rebuild** recommendation, and what to carry over.

Honor the effort already invested — explain *why* anything should be dropped,
don't just discard it.

## 1. Objective (north star — do not drift)
A Singapore Sign Language (SgSL) app that:
1. Does **hand tracking** now; **facial-expression tracking** later.
2. Lets the user **record a real sign** via webcam ("learn" it).
3. Has an avatar reproduce the recorded sign **EXACTLY**, with an allowed
   **tolerance / margin of error**.
4. **Recognizes** the sign when the user performs it again.
5. Uses **machine learning** where it helps — preferred, especially long term.
6. Uses the anime avatar **"Mei"** as the face of the app.

## 2. Two codebases
- **`sgsl`** (`harmanjohll/sgsl`, deployed to GitHub Pages): a *working*
  static web app — clean MediaPipe hand tracking + a parametric 2D avatar.
  This is the **reference implementation**; reuse its patterns.
- **`sgsl-hub`** (local, inside `sgsl-tic`): the user's larger effort —
  full-stack (`render.yaml` for Render.com, Postgres dumps `restore_*.sql` +
  `db_cluster…backup.gz`, Python `venv`). Has "a lot of problems." Sibling
  folders `sgsl-avatar` and `sgsl-avatar-v2-backup1` are earlier versions /
  backups; `sgsl-hub` is the newest.

## 3. Architecture verdict (carry this in)
Record → replay → recognize is **100% client-side**: MediaPipe runs in the
browser, recording = capturing landmark arrays over time, replay = animating
the avatar from them, recognition = comparing sequences. **No server or
database is required for the core**, and **GitHub Pages suffices**.

`sgsl-hub`'s server/DB stack (Render + Postgres) is very likely the source of
its problems — over-engineered for an inherently client-side task. **Review it
with this lens:** is the backend buying anything the objective actually needs?
A backend is only justified later for multi-user accounts or a shared,
crowd-contributed sign library.

## 4. How the working `sgsl` app does it (reuse these patterns)
- **Tracking:** MediaPipe Tasks `HandLandmarker` (CDN
  `@mediapipe/tasks-vision@0.10.14`, GPU→CPU fallback), `VIDEO` mode, 21
  landmarks `{x,y,z}` in 0..1, loaded once via a shared singleton.
- **Avatar:** a parametric 2D model. `composeScene({rhPts, lhPts, face}, theme)`
  (`sgsl-app/js/body-model.js`) already renders from **raw 21-point arrays**;
  `lerpPts` + `requestAnimationFrame` tween between poses in
  `sgsl-app/js/body-avatar.js`. So driving the avatar from recorded landmarks
  is a short hop: you need a MediaPipe→body-space mapping (inverse of the
  existing `toMediaPipe()` in `hand-model.js`) plus a sequence player.
- **Static fingerspelling recognition:** `sgsl-app/js/classifier.js` —
  `normalize(lms, mirrorX)` (wrist→origin, scaled by palm size), weighted
  nearest-template distance (fingertips/thumb up-weighted, z down-weighted as
  noisy), softmax confidence, both chiralities tried. `Smoother` commits a
  letter after a stable hold.
- **Known bug:** `sgsl-app/js/app.js` falls back to `"wei"` instead of
  `DEFAULT_AVATAR` ("mei") from `body-model.js` — that's why the anime avatar
  Mei wasn't showing. Fix this first.
- **Tests:** `node sgsl-app/test/test.mjs` (751 checks; simple
  `check(name, cond)` helper). Visual verification: `dump_*.mjs` → JSON →
  `render_*.py` (PIL) → PNG contact sheets under `sgsl-app/test/`.

## 5. Technical design for the objective
- **Recorder:** buffer `Tracker.onFrame` landmarks + timestamps into a frame
  array; trim leading/trailing no-hand frames; cap length; store
  `{name, frames: [{lms, t}], createdAt}`.
- **Persistence:** IndexedDB (with a localStorage fallback) + JSON
  export/import, so recorded signs can be committed to the repo and shared.
- **Replay ("EXACTLY"):** play the stored landmark sequence through
  `composeScene` / `lerpPts` at the recorded timing; smooth between frames.
- **Recognition + "margin of error":**
  - **Baseline (now, no ML):** per-frame `normalize`, then **Dynamic Time
    Warping (DTW)** between the live sequence and each stored template. DTW
    handles speed differences; the **margin = a distance threshold** (reject
    above it, rank below). Works with a *single* recorded example — ideal for
    "record then recognize." The recordings you collect double as the ML
    training set, so this is not throwaway work.
  - **ML (longer term):** once there are multiple examples per sign, train a
    small sequence classifier on normalized landmark sequences (**1D-CNN,
    GRU/LSTM, or a small Transformer**) in **TensorFlow.js** — trainable *and*
    runnable in-browser for on-device personalization.
- **Faces (later):** add MediaPipe `FaceLandmarker` / `HolisticLandmarker`
  to get face blendshapes + hands together; drive the avatar's existing
  `face` channel (brows / mouth / head offsets) from them.

## 6. ML research notes (confirm specifics against live docs)
- **Input representation:** normalized hand/pose-landmark sequences are the
  standard, robust feature for isolated sign-language recognition (ISLR) —
  invariant to lighting, skin tone, and background. Augment with per-frame
  velocity (Δ between frames). Pose/landmark input + **Transformer**
  (self-attention over the temporal sequence) is the current research
  direction for word-level SLR.
- **MediaPipe Tasks (web, `tasks-vision`):** `HandLandmarker` (21 pts/hand),
  `FaceLandmarker` (~478 points **plus 52 ARKit-style blendshape
  coefficients** such as `jawOpen`, `browInnerUp`, `mouthSmileLeft` — ideal
  for driving an avatar's face), `PoseLandmarker` (33 body points), and a
  combined `HolisticLandmarker`. All run client-side in the browser.
  *(Re-verify exact task names and outputs at ai.google.dev — automated fetch
  of those docs was blocked during this research.)*
- **Model progression (all deployable as static TF.js assets on Pages):**
  DTW (1 example) → 1D-CNN / GRU / LSTM (tens of examples) → small Transformer
  (hundreds). Landmark inputs keep models tiny and fast.
- **Data reality:** there is **no large public SgSL dataset**; ASL sets
  (WLASL, MS-ASL) exist but SgSL differs. The **record-your-own flow IS the
  dataset strategy** — every recording is labeled training data. Design
  storage/export with this in mind from day one.
- **Tolerance:** expose the recognition threshold as a user-tunable control
  (false-accept vs false-reject trade-off).
- **Sources:**
  - https://en.wikipedia.org/wiki/Sign_language_recognition
  - https://github.com/ArminSmajlagic/Real-Time-Hand-Gesture-Recognition (LSTM on MediaPipe landmarks)
  - https://blog.tensorflow.org/2020/03/face-and-hand-tracking-in-browser-with-mediapipe-and-tensorflowjs.html
  - https://ai.google.dev/edge/mediapipe/solutions (Tasks Vision: Hand / Face / Pose / Holistic Landmarker)

## 7. Repo strategy
Build the rebuild on **`sgsl`** — it is already a clean, working,
Pages-deployed client-side base. Keep `sgsl-hub` as an archive / reference
(do not delete it). **Avoid creating a brand-new empty repo:** it would
discard the working tracker + avatar, add a fourth repo to juggle, and would
not solve the real constraint — any session that "references hub" still needs
hub added to its scope. Only create a new repo if a fresh name/history is
specifically wanted *and* a full from-scratch rebuild is certain — and even
then, seed it from `sgsl`, not empty.

## 8. Hosting
GitHub Pages (static) covers everything above; revisit a backend only for
accounts or a shared library. (Aside: the `sgsl` Pages deploy still needs its
GitHub Actions workflow `deploy-pages.yml` triggered once — it has 0 runs so
far. Final URL: https://harmanjohll.github.io/sgsl/.)

## 9. Deliverables from the review
1. `sgsl-hub` architecture summary + how it attempts the objective.
2. What works / what's broken (with file references).
3. Salvage-vs-rebuild call, with reasons; if rebuild, what to carry over.
4. A concrete next-step plan toward record → replay → recognize on a
   client-side, Pages-hostable base, using the Mei avatar.
