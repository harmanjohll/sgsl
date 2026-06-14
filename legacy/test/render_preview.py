#!/usr/bin/env python3
"""Render a contact sheet of all letter/digit poses for visual verification.

Mirrors the canvas renderer in js/avatar.js closely enough to judge whether
each handshape reads correctly. Usage: python3 test/render_preview.py
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

DUMP_JS = r"""
import { handLandmarks } from "./js/hand-model.js";
import { LETTER_POSES, DIGIT_POSES } from "./js/poses.js";
const out = {};
for (const [k, p] of Object.entries(LETTER_POSES)) out[k] = handLandmarks(p);
for (const [k, p] of Object.entries(DIGIT_POSES)) out["d" + k] = handLandmarks(p);
console.log(JSON.stringify(out));
"""

CHAINS = [[0, 1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]
PALM = [0, 1, 5, 9, 13, 17]

SKIN = (224, 172, 105)
SKIN_DARK = (176, 123, 69)
SKIN_LIGHT = (241, 194, 125)
BG = (26, 34, 54)

CELL = 220


def draw_hand(draw, pts, ox, oy):
    s = CELL * 0.22
    cx, cy = ox + CELL * 0.58, oy + CELL * 0.55

    def P(p):
        return (cx + s * p[0], cy - s * p[1])

    # forearm extends away from the fingers
    fx, fy = pts[0][0] - pts[9][0], pts[0][1] - pts[9][1]
    n = (fx * fx + fy * fy) ** 0.5 or 1.0
    w0 = P(pts[0])
    w1 = P([pts[0][0] + fx / n, pts[0][1] + fy / n, 0])
    draw.line([w1, w0], fill=SKIN, width=int(s * 0.42))
    # palm
    poly = [P(pts[i]) for i in PALM]
    draw.polygon(poly, fill=SKIN, outline=SKIN)
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        draw.line([a, b], fill=SKIN, width=int(s * 0.3))
    # fingers, far to near
    chains = sorted(CHAINS, key=lambda c: pts[c[-1]][2])
    for chain in chains:
        for i in range(len(chain) - 1):
            depth = (pts[chain[i + 1]][2] + 0.4) / 1.4
            depth = max(0.0, min(1.0, depth))
            col = SKIN_LIGHT if depth > 0.55 else SKIN_DARK if depth < 0.3 else SKIN
            w = int(s * (0.155 + 0.04 * depth))
            a, b = P(pts[chain[i]]), P(pts[chain[i + 1]])
            draw.line([a, b], fill=col, width=max(w, 3))
            r = max(w // 2, 2)
            for q in (a, b):
                draw.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=col)


def main():
    res = subprocess.run(
        ["node", "--input-type=module", "-e", DUMP_JS],
        cwd=ROOT, capture_output=True, text=True,
    )
    if res.returncode != 0:
        sys.exit(res.stderr)
    poses = json.loads(res.stdout)

    keys = [k for k in poses if not k.startswith("d")] + [k for k in poses if k.startswith("d")]
    cols = 8
    rows = (len(keys) + cols - 1) // cols
    img = Image.new("RGB", (cols * CELL, rows * CELL), BG)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
    except OSError:
        font = ImageFont.load_default()

    for idx, key in enumerate(keys):
        ox, oy = (idx % cols) * CELL, (idx // cols) * CELL
        draw.rectangle([ox, oy, ox + CELL - 1, oy + CELL - 1], outline=(40, 52, 78))
        draw_hand(draw, poses[key], ox, oy)
        label = key[1:] if key.startswith("d") else key
        draw.text((ox + 10, oy + 8), label, fill=(122, 224, 196), font=font)

    out = ROOT / "test" / "preview.png"
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
