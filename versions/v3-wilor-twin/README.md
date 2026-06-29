# v3 — WiLoR twin (scaffold; GPU deferred)

**Status: scaffold.** The web page RUNS TODAY (in-browser hands). The GPU half — WiLoR hand
reconstruction on a server — is **deferred** until the DigitalOcean GPU droplet is set up. This
folder exists so that path is ready and the contract is pinned down now.

## Why this exists
In-browser hand landmarks are the fidelity ceiling for tight fingerspelling shapes (e.g. `O` / `D`).
**WiLoR** reconstructs a full MANO hand (much better finger articulation) but needs a GPU. v3 keeps
everything else in the browser (pose, face, the tuned avatar + retarget) and swaps **only the hands**
for WiLoR output when a GPU server is available — otherwise it falls back to in-browser hands, so the
page is never broken.

## How it stays faithful (high fidelity to intent)
- Reuses **`sgsl-app/js/retarget.js` + `avatar.js`** (the tuned avatar + calibration) unchanged.
- Reuses **v2's worker + adapter** for in-browser tracking (`../v2-tasks-worker/js/...`).
- WiLoR hands are returned in the **same 21-point MediaPipe world-landmark layout**, so they are a
  drop-in for `results.{right,left}HandWorldLandmarks` — the retarget doesn't know the difference.

## Layout
```
web/     in-browser client (runs today)
  index.html   same global libs as v1/v2; reuses v2 worker + shared avatar/retarget
  app.js       camera -> worker (pose/face/hands) -> avatar; opens a WebSocket to the
               server and overrides HANDS with WiLoR output when connected
  assets/ css/ symlinks -> ../../../sgsl-app/{assets,css}
server/  GPU backend (STUB — inference deferred)
  app.py            FastAPI /ws WebSocket; returns {type:'hands', right, left}; WiLoR TODO
  requirements.txt  fastapi/uvicorn/websockets (torch + wilor commented until GPU)
```

## WebSocket contract
```
client -> server : binary JPEG frame (downscaled, ~256px)
server -> client : {"type":"hands",
                    "right":[[x,y,z]*21] | null,
                    "left":[[x,y,z]*21] | null}
```
Each hand = 21 metric world landmarks (MediaPipe HandLandmarker order). `null` = no override this
frame → client keeps in-browser hands.

## How to run
**Web (works now, in-browser hands):** from the repository root —
```bash
python3 -m http.server 8000
# open:  http://localhost:8000/versions/v3-wilor-twin/web/
```
**Server (stub round-trip, optional):**
```bash
cd versions/v3-wilor-twin/server
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8765
```
With the server up, the web page's source badge flips to "WiLoR server (GPU)" — but the stub returns
no hands yet, so it still shows in-browser hands until WiLoR is wired up.

## To finish (when the GPU droplet is ready)
1. Provision the DO GPU droplet; install a CUDA `torch` + the WiLoR package; download weights.
2. Implement `load_wilor()` + `infer_hands()` in `server/app.py` (decode JPEG → WiLoR MANO → map to
   the 21-point MediaPipe world order).
3. Point `WS_URL` in `web/app.js` at the droplet (use `wss://` behind TLS) and test fidelity on
   `O` / `D` / fingerspelling vs v1/v2.
