# Contributing signs

The sign library *is* the dataset. Every recording you contribute makes Mei
sign more words and, later, becomes labelled training data for recognition.

## Record → Export → PR

1. Open the app (`http://localhost:8000` locally, or the live Pages site).
2. Go to the **Record** tab.
3. Stand so the on-screen guide turns solid (framing gate), then
   **Calibrate** (arms at sides, ~1.5 s).
4. Type the **sign label** (lowercase, words joined by `_`, e.g. `thank_you`),
   then **Record** the sign and **Stop**.
5. Check the **Quality** grade and the **Replay Fidelity** score. Aim for the
   replay error to be within your tolerance (default 8% of shoulder-width).
   Re-record if it's jerky or incomplete.
6. **Preview on Avatar** to confirm Mei reproduces it.
7. **Save to device** (stores in your browser, IndexedDB) and/or **Export JSON**
   to download `<label>.json`.
8. Drop the exported file into `sgsl-app/signs/`, run
   `python tools/build_manifest.py`, and open a pull request.

## File shape

Each `sgsl-app/signs/<label>.json` is:

```json
{
  "label": "thank_you",
  "schema_version": 2,
  "landmarks": [ { "t": 0, "pose": [...], "poseWorld": [...], "face": [...],
                   "leftHand": [...], "rightHand": [...] }, ... ],
  "calibration": { "shoulderWidth": 0.27, "headToShoulder": 0.18, "shoulderMid": [..], "frames": 45 },
  "quality":  { "overall": 86, "grade": "A", "details": { ... } },
  "fidelity": { "overall": 4.1, "grade": "B", "perChannel": { ... } }
}
```

This is the same shape the (future) Postgres `signs` table stores, so the
library migrates to a database later without reshaping.

## Rules of thumb

- **schema v2 only** for the curated library: per-frame `t` + `poseWorld`. The
  8 seed signs (`b, c, d, five, h, k, one, three`) are legacy **v1 fixtures**
  (hands only, no timestamps) — smoke tests, not fidelity references. Re-record
  them properly when you can.
- Keep the label consistent with how you'd type it in **Sign It** (the resolver
  maps `thank you` → `thank_you`, and a few synonyms like `me` → `i`).
- Run `node test/replay_error.mjs` before you PR — CI fails if a committed v2
  sign's replay error exceeds the threshold.
