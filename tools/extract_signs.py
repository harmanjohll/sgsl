"""
Extract sign data from restore_signLibrary.sql into individual JSON files.

Parses the PostgreSQL INSERT statements and saves each sign's landmark data
as a standalone JSON file in sgsl-app/signs/ (the static library).

Usage:
    python backend/extract_signs.py
"""

import json
import os
import re
import sys

# tools/ lives at the repo root; signs ship under sgsl-app/signs/ (the
# GitHub Pages artifact root) and the SQL dumps live in data-archive/.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.dirname(SCRIPT_DIR)

SQL_FILE = os.path.join(REPO_DIR, "data-archive", "restore_signLibrary.sql")
SMALL_SQL = os.path.join(REPO_DIR, "data-archive", "restore_data_small.sql")
OUTPUT_DIR = os.path.join(REPO_DIR, "sgsl-app", "signs")


def extract_from_sql(sql_path):
    """Parse INSERT statements and extract label + landmarks."""
    if not os.path.exists(sql_path):
        print(f"  [skip] {sql_path} not found")
        return []

    with open(sql_path, "r") as f:
        content = f.read()

    signs = []

    # Split into individual INSERT blocks
    inserts = re.split(r"INSERT INTO", content)

    for block in inserts[1:]:  # skip preamble before first INSERT
        # Extract label: 'label_text',
        label_match = re.search(
            r"'[0-9a-f-]+',\s*'([^']+)',\s*'[^']*',\s*'[^']+'",
            block
        )
        if not label_match:
            continue
        label = label_match.group(1)

        # Extract landmarks JSON: everything between the opening '[ and
        # the closing ]'::jsonb (or ]', or ]')
        # The landmarks start after the 4th single-quoted field
        # Find the landmarks string - it's the 5th quoted value
        lm_match = re.search(
            r"'(\[[\s\S]*?\])'(?:::jsonb)?",
            block[label_match.end():]
        )
        if not lm_match:
            # Try $json$ delimiters
            lm_match = re.search(
                r"\$json\$([\s\S]*?)\$json\$",
                block[label_match.end():]
            )
        if not lm_match:
            print(f"  [warn] No landmarks found for '{label}'")
            continue

        landmarks_raw = lm_match.group(1).strip()

        try:
            landmarks = json.loads(landmarks_raw)
        except json.JSONDecodeError as e:
            print(f"  [warn] Failed to parse landmarks for '{label}': {e}")
            continue

        # Normalize to holistic format
        frames = normalize_landmarks(landmarks)
        if frames:
            signs.append({"label": label, "landmarks": frames})
            print(f"  [ok] {label}: {len(frames)} frames")
        else:
            print(f"  [warn] {label}: no valid frames after normalization")

    return signs


def normalize_landmarks(landmarks):
    """Convert various landmark formats to holistic format.

    Holistic format: [{leftHand, rightHand, face, pose}, ...]

    Legacy formats:
    - [[[x,y,z]*21]]  — single hand per frame
    - [[[x,y,z]*21], [[x,y,z]*21]]  — two hands per frame
    """
    if not landmarks or not isinstance(landmarks, list):
        return []

    frames = []
    for fr in landmarks:
        if fr is None:
            continue

        # Already holistic format
        if isinstance(fr, dict) and ("leftHand" in fr or "rightHand" in fr):
            frames.append({
                "leftHand": fr.get("leftHand"),
                "rightHand": fr.get("rightHand"),
                "face": fr.get("face"),
                "pose": fr.get("pose"),
            })
            continue

        if not isinstance(fr, list):
            continue

        # Direct 21 landmarks: [[x,y,z], ...]
        if (len(fr) >= 21
                and isinstance(fr[0], list)
                and len(fr[0]) >= 2
                and isinstance(fr[0][0], (int, float))):
            frames.append({
                "rightHand": fr,
                "leftHand": None,
                "face": None,
                "pose": None,
            })
            continue

        # Wrapped: [[[x,y,z]*21]] or [[[x,y,z]*21], [[x,y,z]*21]]
        if (len(fr) <= 2
                and isinstance(fr[0], list)
                and len(fr[0]) >= 21
                and isinstance(fr[0][0], list)):
            right_hand = fr[0]
            left_hand = fr[1] if len(fr) == 2 and isinstance(fr[1], list) and len(fr[1]) >= 21 else None
            frames.append({
                "rightHand": right_hand,
                "leftHand": left_hand,
                "face": None,
                "pose": None,
            })
            continue

    return frames


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Extracting signs to {OUTPUT_DIR}/\n")

    all_signs = []

    # Try both SQL files
    for sql_path in [SQL_FILE, SMALL_SQL]:
        basename = os.path.basename(sql_path)
        print(f"Parsing {basename}...")
        signs = extract_from_sql(sql_path)
        all_signs.extend(signs)

    # Deduplicate by label (keep first occurrence)
    seen = set()
    unique_signs = []
    for sign in all_signs:
        if sign["label"] not in seen:
            seen.add(sign["label"])
            unique_signs.append(sign)

    if not unique_signs:
        print("\nNo signs extracted. Check that SQL files exist in repo root.")
        sys.exit(1)

    # Write individual JSON files
    for sign in unique_signs:
        out_path = os.path.join(OUTPUT_DIR, f"{sign['label']}.json")
        with open(out_path, "w") as f:
            json.dump(sign, f)
        size_kb = os.path.getsize(out_path) / 1024
        print(f"  -> {out_path} ({size_kb:.1f} KB)")

    # Write manifest (list of available signs)
    manifest = [{"label": s["label"], "frames": len(s["landmarks"])} for s in unique_signs]
    manifest_path = os.path.join(OUTPUT_DIR, "_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone: {len(unique_signs)} signs extracted.")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
