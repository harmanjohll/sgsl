"""
SgSL v3 — WiLoR digital-twin server  [STUB / GPU DEFERRED]
==========================================================
FastAPI WebSocket that the web client (../web/app.js) connects to. It receives
downscaled JPEG frames and is meant to return WiLoR-reconstructed hand world
landmarks (21 metric points per hand, MediaPipe order) so the avatar's hands
come from a GPU MANO model instead of in-browser landmarks.

THIS IS A STUB. WiLoR inference is NOT wired up (requires a GPU + model weights).
Right now it replies `{type:'hands', right:null, left:null}` for every frame,
which tells the client "no override — keep in-browser hands". So the web page
keeps working; the round-trip + contract are real, the inference is the TODO.

Run (CPU-only, just to exercise the socket):
    pip install -r requirements.txt
    uvicorn app:app --host 0.0.0.0 --port 8765

Contract:
    client -> server : binary message = JPEG bytes (downscaled frame)
    server -> client : text JSON = {"type":"hands",
                                     "right":[[x,y,z]*21] | null,
                                     "left":[[x,y,z]*21] | null}
      Each hand = 21 METRIC world landmarks in MediaPipe HandLandmarker order,
      a drop-in for results.{right,left}HandWorldLandmarks in retarget.js.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI(title="SgSL WiLoR twin (stub)")

# ─────────────────────────────────────────────────────────────────────────────
# TODO (deferred until the DO GPU droplet is set up):
#   1. pip install torch + the WiLoR package and download its weights.
#   2. Load the model ONCE at startup (see load_wilor() below).
#   3. In the frame loop: decode JPEG -> run WiLoR -> convert MANO joints to the
#      21-point MediaPipe world-landmark layout -> return them per hand.
# ─────────────────────────────────────────────────────────────────────────────

WILOR = None  # the loaded model, once GPU is available

def load_wilor():
    """Load WiLoR weights onto the GPU. Stubbed — returns None (no model)."""
    # import torch
    # from wilor import WiLoR
    # model = WiLoR.from_pretrained(...).to("cuda").eval()
    # return model
    return None


def infer_hands(jpeg_bytes: bytes):
    """Run WiLoR on one frame. STUB: returns no hands (client keeps in-browser)."""
    if WILOR is None:
        return {"right": None, "left": None}
    # decode -> detect hands -> WiLoR MANO -> map to MediaPipe 21-pt world order
    # right, left = run_wilor(WILOR, jpeg_bytes)
    # return {"right": right, "left": left}
    return {"right": None, "left": None}


@app.on_event("startup")
def _startup():
    global WILOR
    WILOR = load_wilor()  # None until GPU + weights are wired up


@app.get("/")
def health():
    return {"ok": True, "wilor_loaded": WILOR is not None,
            "note": "stub — hands not reconstructed yet; client uses in-browser hands"}


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    try:
        while True:
            msg = await sock.receive()
            data = msg.get("bytes")
            if data is None:
                # ignore non-binary (e.g. text pings)
                continue
            hands = infer_hands(data)
            await sock.send_json({"type": "hands", "right": hands["right"], "left": hands["left"]})
    except WebSocketDisconnect:
        pass
