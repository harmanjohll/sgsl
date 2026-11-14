"""
SgSL Avatar — Backend Server.

- Serves the frontend static files.
- REST API for signs, backed by a pluggable storage adapter
  (local filesystem by default; DigitalOcean Spaces / S3 available
  behind STORAGE_BACKEND=s3).
- Schema v2 required on save: every frame needs `t` and `poseWorld`
  so playback can reconstruct real-time cadence and feed Kalidokit
  world landmarks. v1 uploads are rejected with 400.
- Admin purge endpoint to delete all v1 (legacy) signs in one shot.

Run: uvicorn app:app --reload --port 8001
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from storage import make_storage

app = FastAPI(title="SgSL Avatar", version="2.0")

PROJECT_DIR = Path(__file__).parent.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
SIGNS_DIR = PROJECT_DIR / "data" / "signs"

storage = make_storage(SIGNS_DIR)

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

SCHEMA_VERSION = 2          # current landmark-capture schema (recorder)
SCHEMA_VERSION_CURATED = 3  # quaternion-keyframe schema (pose editor)

# VRM humanoid bones a curated sign MUST animate at minimum. Curated
# signs that omit even one of these on every keyframe are rejected.
# Other bones (fingers, neck, hips, etc.) are optional.
REQUIRED_CURATED_BONES = {
    "RightUpperArm", "LeftUpperArm",
    "RightLowerArm", "LeftLowerArm",
    "RightHand", "LeftHand",
}


def _sanitize(label: str) -> str:
    return "".join(c for c in label if c.isalnum() or c in ("_", "-")).strip()


def _validate_v2(landmarks: list) -> None:
    """Reject landmark-capture payloads missing fields playback needs."""
    if not landmarks or len(landmarks) < 5:
        raise HTTPException(status_code=400, detail="Too few frames (minimum 5)")

    missing_t = sum(1 for f in landmarks if not isinstance(f, dict) or "t" not in f)
    if missing_t:
        raise HTTPException(
            status_code=400,
            detail=f"Schema v2 requires per-frame timestamp 't' ({missing_t} frames missing)",
        )

    has_world = sum(1 for f in landmarks if f.get("poseWorld"))
    if has_world < len(landmarks) * 0.8:
        raise HTTPException(
            status_code=400,
            detail="Schema v2 requires poseWorld on >=80% of frames",
        )


def _validate_v3_curated(keyframes: list) -> None:
    """Reject curated payloads that don't carry enough bone data to play.

    A curated sign is a list of {t, bones} keyframes where t is ms from
    sign start and bones is a dict of VRM-humanoid-bone-name → quaternion
    (4-element [x,y,z,w] array). The viewer slerps quaternions between
    consecutive keyframes; it does NOT run retargeting on these.
    """
    if not keyframes or len(keyframes) < 2:
        raise HTTPException(
            status_code=400,
            detail="Curated sign needs at least 2 keyframes (start + end pose)",
        )

    for i, kf in enumerate(keyframes):
        if not isinstance(kf, dict):
            raise HTTPException(status_code=400, detail=f"Keyframe {i} not an object")
        if "t" not in kf or not isinstance(kf["t"], (int, float)):
            raise HTTPException(status_code=400, detail=f"Keyframe {i} missing numeric 't'")
        bones = kf.get("bones")
        if not isinstance(bones, dict):
            raise HTTPException(status_code=400, detail=f"Keyframe {i} missing 'bones' dict")
        for bname, q in bones.items():
            if not isinstance(q, list) or len(q) != 4:
                raise HTTPException(
                    status_code=400,
                    detail=f"Keyframe {i} bone '{bname}' must be a 4-element quaternion [x,y,z,w]",
                )

    # Require core arm bones to appear on at least one keyframe each —
    # the editor would naturally write them; missing all of them on
    # every frame is a structural error, not just an unused bone.
    seen: set[str] = set()
    for kf in keyframes:
        seen.update(kf["bones"].keys())
    missing = REQUIRED_CURATED_BONES - seen
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Curated sign missing bones: {sorted(missing)}",
        )

    ts = [kf["t"] for kf in keyframes]
    if ts != sorted(ts):
        raise HTTPException(status_code=400, detail="Keyframes must be in ascending 't' order")


@app.get("/api/signs")
async def list_signs():
    return JSONResponse(content=storage.list_signs())


@app.get("/api/sign/{label}")
async def get_sign(label: str):
    data = storage.load_sign(_sanitize(label))
    if data is None:
        raise HTTPException(status_code=404, detail=f"Sign '{label}' not found")
    return JSONResponse(content=data)


@app.delete("/api/sign/{label}")
async def delete_sign(label: str):
    safe = _sanitize(label)
    if not storage.delete_sign(safe):
        raise HTTPException(status_code=404, detail=f"Sign '{safe}' not found")
    print(f"[Delete] Sign '{safe}' removed")
    return JSONResponse(content={"status": "ok", "label": safe})


@app.post("/api/sign")
async def save_sign(request: Request):
    """Save a recorded (landmark-capture) sign — schema v2."""
    body = await request.json()
    label = body.get("label", "").strip().lower()
    landmarks = body.get("landmarks", [])
    calibration = body.get("calibration")
    quality = body.get("quality")
    client_schema = body.get("schema_version", 1)

    if not label:
        raise HTTPException(status_code=400, detail="Label is required")

    safe = _sanitize(label)
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid label")

    if client_schema < SCHEMA_VERSION:
        raise HTTPException(
            status_code=400,
            detail=f"Schema v{client_schema} uploads rejected. Please re-record with the current client.",
        )

    _validate_v2(landmarks)

    sign_data = {
        "label": safe,
        "schema_version": SCHEMA_VERSION,
        "type": "recorded",
        "landmarks": landmarks,
        "calibration": calibration,
        "quality": quality,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "format": "holistic",
    }
    storage.save_sign(safe, sign_data)
    print(f"[Save] Sign '{safe}': {len(landmarks)} frames")
    return JSONResponse(content={"status": "ok", "label": safe, "frames": len(landmarks)})


@app.post("/api/sign/curated")
async def save_curated_sign(request: Request):
    """Save a curated sign authored in the pose editor — schema v3.

    Body shape:
        {
          "label": "hello",
          "duration_ms": 2500,
          "keyframes": [
            { "t": 0, "bones": { "RightUpperArm": [x,y,z,w], ... } },
            ...
          ],
          "author": "optional string"
        }
    """
    body = await request.json()
    label = body.get("label", "").strip().lower()
    keyframes = body.get("keyframes", [])
    duration_ms = body.get("duration_ms")
    author = body.get("author")

    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    safe = _sanitize(label)
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid label")

    _validate_v3_curated(keyframes)

    if not isinstance(duration_ms, (int, float)) or duration_ms <= 0:
        # Derive from keyframes if not supplied.
        duration_ms = float(keyframes[-1]["t"])

    sign_data = {
        "label": safe,
        "schema_version": SCHEMA_VERSION_CURATED,
        "type": "curated",
        "duration_ms": duration_ms,
        "keyframes": keyframes,
        "author": author,
        "authored_at": datetime.now(timezone.utc).isoformat(),
    }
    storage.save_sign(safe, sign_data)
    print(f"[Save] Curated sign '{safe}': {len(keyframes)} keyframes, {duration_ms}ms")
    return JSONResponse(content={
        "status": "ok",
        "label": safe,
        "keyframes": len(keyframes),
        "duration_ms": duration_ms,
    })


@app.post("/api/admin/purge_legacy")
async def purge_legacy(request: Request):
    """Delete all schema v1 signs. Auth via X-Admin-Token header."""
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_TOKEN not configured")
    if request.headers.get("x-admin-token") != ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Forbidden")

    removed: list[str] = []
    for s in storage.list_signs():
        if s.get("schema_version", 1) < SCHEMA_VERSION:
            if storage.delete_sign(s["label"]):
                removed.append(s["label"])
    print(f"[Purge] removed {len(removed)} legacy signs")
    return JSONResponse(content={"status": "ok", "removed": removed})


@app.get("/")
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/editor")
async def editor():
    return FileResponse(FRONTEND_DIR / "editor.html")


if (FRONTEND_DIR / "js").exists():
    app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")
if (FRONTEND_DIR / "css").exists():
    app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
if (FRONTEND_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")
