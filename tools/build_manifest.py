#!/usr/bin/env python3
"""
Regenerate sgsl-app/signs/_manifest.json from the committed sign files.

The manifest is what the app's signs-source reads to list the library:
    [{ "label": str, "frames": int, "schema_version": int, "hands": bool }]

Run this after adding/removing a sign JSON under sgsl-app/signs/:
    python tools/build_manifest.py
"""

import json
import os

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNS_DIR = os.path.join(REPO_DIR, "sgsl-app", "signs")
MANIFEST = os.path.join(SIGNS_DIR, "_manifest.json")


def main():
    entries = []
    for name in sorted(os.listdir(SIGNS_DIR)):
        if not name.endswith(".json") or name == "_manifest.json":
            continue
        path = os.path.join(SIGNS_DIR, name)
        try:
            with open(path) as f:
                sign = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"  [skip] {name}: {e}")
            continue

        frames = sign.get("landmarks", [])
        has_hands = any(
            isinstance(fr, dict) and (fr.get("leftHand") or fr.get("rightHand"))
            for fr in frames
        )
        entries.append({
            "label": sign.get("label", os.path.splitext(name)[0]),
            "frames": len(frames),
            "schema_version": sign.get("schema_version", 1),
            "hands": has_hands,
        })
        print(f"  [ok] {name}: {len(frames)} frames")

    with open(MANIFEST, "w") as f:
        json.dump(entries, f, indent=2)
    print(f"\nWrote {MANIFEST} ({len(entries)} signs).")


if __name__ == "__main__":
    main()
