#!/usr/bin/env python3
"""Render the avatar cast contact sheet (each avatar signing HELLO and ILY)."""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_signs import paint, CELL_W, CELL_H, BG  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    res = subprocess.run(
        ["node", "test/dump_avatars.mjs"], cwd=ROOT, capture_output=True, text=True
    )
    if res.returncode != 0:
        sys.exit(res.stderr)
    scenes = json.loads(res.stdout)

    cols = 4
    rows = (len(scenes) + cols - 1) // cols
    img = Image.new("RGB", (cols * CELL_W, rows * CELL_H), BG)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
    except OSError:
        font = small = ImageFont.load_default()

    # column-major: each avatar gets a column with its two signs stacked
    n_av = len(scenes) // 2
    for i, scene in enumerate(scenes):
        col = i // 2
        row = i % 2
        ox, oy = col * CELL_W, row * CELL_H
        draw.rectangle([ox, oy, ox + CELL_W - 1, oy + CELL_H - 1], outline=(40, 52, 78))
        paint(draw, scene["prims"], ox, oy)
        draw.text((ox + 8, oy + 6), scene["label"], fill=(122, 224, 196), font=font)
        draw.text((ox + 8, oy + 32), scene["sub"], fill=(147, 160, 184), font=small)

    out = ROOT / "test" / "avatars_preview.png"
    img.save(out)
    print(f"wrote {out} ({n_av} avatars)")


if __name__ == "__main__":
    main()
