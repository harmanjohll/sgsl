# archive/: salvage from the retired SgSL repos

Nothing here is served or imported by `sgsl-app`. This folder gathers the pieces
of `sgsl-tic` (Jun 2025 to May 2026) and `sgsl-hub` (Feb to Jun 2026) that were not
already in this repo, so those repos can be deleted without losing work.
Full git history of both repos was also exported as bundles (kept offline by Harman).

| Path | From | Why it is kept |
|---|---|---|
| `signs-2025/` | Supabase `signLibrary` table (via `restore_signLibrary.sql`) | The 9 original recordings, raw. 8 also exist in this repo's history as `sgsl-app/signs/*.json` (identical values); `c-take2.json` (12 Jul 2025, 58 frames) was dropped by the old extractor as a duplicate label and existed nowhere else. Right hand only, schema v0; replay_error skips these. |
| `salvage/pose-editor/` | `sgsl-tic`, branch `claude/dots-first` (19 Apr 2026, never merged) | Curated sign authoring (schema v3): per bone sliders, keyframes, quaternion slerp playback that bypasses the retargeter. `player.js` holds the curated playback branch; `backend_app.py` holds the v3 validation rules (`POST /api/sign/curated`). Also the dots first record flow (`dots.js`, `recorder.js`) and calibration rest offset subtraction (`retarget.js`). Port to static: save to IndexedDB + JSON export instead of the API. |
| `salvage/hub-recognizer/recognizer.py` | `sgsl-hub` backend | Recognition ideas `sgsl-app/js/recognition.js` lacks: 12 D face features (brow raise, eye, mouth ratios) for non manual markers, bone direction unit vectors, and a k NN stage that kicks in once a sign has several examples. Port to JS when the library has multiple takes per sign. |
| `salvage/hub-explainer/howitworks.js` | `sgsl-hub` frontend | Learner facing "how the AI recognises a sign" explainer; content to adapt for a Learn page. |
| `research/avatars-biomechanics.md` | `sgsl-hub/Avatars.md` | Research brief: 22 DoF hand, DIP = 2/3 PIP coupling, joint limits, torso rotation from signing space, NMM blendshape table. |

Deliberately not kept (superseded here): the FastAPI + Supabase/Postgres backend, email auth and admin
verify flow, the GLB "Tom" humanoid (`humanoid.js`), the SMPL-X mesh pipeline, the dots renderer
(replaced by the live overlay), Render and DigitalOcean deploy configs, and the June 2025 Supabase app.
