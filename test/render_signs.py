#!/usr/bin/env python3
"""Render the body-avatar sign keyframes to a PNG contact sheet.

Paints the same primitives the canvas painter consumes (via dump_signs.mjs),
so what is verified here is what users see.
Usage: python3 test/render_signs.py [sign ...]
"""
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CELL_W, CELL_H = 240, 270
BG = (26, 34, 54)


def project(p, ox, oy):
    s = min(CELL_W, CELL_H) * 0.28
    return (ox + CELL_W * 0.5 + s * p[0], oy + CELL_H * 0.45 - s * p[1])


def paint(draw, prims, ox, oy):
    s = min(CELL_W, CELL_H) * 0.28
    for pr in prims:
        t = pr["type"]
        if t == "line":
            a = project(pr["a"], ox, oy)
            b = project(pr["b"], ox, oy)
            w = max(1, int(pr["w"] * s))
            col = pr["color"]
            draw.line([a, b], fill=col, width=w)
            r = w / 2
            for q in (a, b):
                draw.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=col)
        elif t == "circle":
            c = project(pr["c"], ox, oy)
            r = pr["r"] * s
            draw.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=pr["fill"])
        elif t == "arc":
            c = project(pr["c"], ox, oy)
            r = pr["r"] * s
            w = max(1, int(pr["w"] * s))
            # math y-up angles → screen angles (PIL: degrees CW from 3 o'clock)
            start = -pr["a1"] * 180 / math.pi
            end = -pr["a0"] * 180 / math.pi
            draw.arc([c[0] - r, c[1] - r, c[0] + r, c[1] + r], start, end, fill=pr["color"], width=w)
        elif t == "poly":
            pts = [project(p, ox, oy) for p in pr["pts"]]
            draw.polygon(pts, fill=pr.get("fill"), outline=pr.get("stroke"))


def main():
    res = subprocess.run(
        ["node", "test/dump_signs.mjs", *sys.argv[1:]],
        cwd=ROOT, capture_output=True, text=True,
    )
    if res.returncode != 0:
        sys.exit(res.stderr)
    scenes = json.loads(res.stdout)

    cols = 6
    rows = (len(scenes) + cols - 1) // cols
    img = Image.new("RGB", (cols * CELL_W, rows * CELL_H), BG)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
    except OSError:
        font = ImageFont.load_default()

    for idx, scene in enumerate(scenes):
        ox, oy = (idx % cols) * CELL_W, (idx // cols) * CELL_H
        draw.rectangle([ox, oy, ox + CELL_W - 1, oy + CELL_H - 1], outline=(40, 52, 78))
        paint(draw, scene["prims"], ox, oy)
        draw.text((ox + 8, oy + 6), scene["label"], fill=(122, 224, 196), font=font)

    out = ROOT / "test" / "signs_preview.png"
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
