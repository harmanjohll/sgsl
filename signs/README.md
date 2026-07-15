# Base sign set (shipped demo / starter library)

This folder **is** the central library that ships with the app — the signs every
visitor sees before recording their own. Keep it to a small, curated **base set** so
new users have something to try; personal or bulk recordings should stay on-device
(IndexedDB) or go through a reviewed Contribute flow, not get committed here.

**Current base set:** `one`, `three`, `five` — backs the "Numbers 1–5" lesson.

## How to curate it
- **Add** a sign: drop `<label>.json` in this folder and add an entry to
  `_manifest.json`: `{ "label": "<label>", "frames": <n>, "schema_version": 1, "hands": true }`.
- **Remove** a sign: delete `<label>.json` and its `_manifest.json` entry.

The app reads `_manifest.json` only (never a directory listing), so the file and the
manifest entry must stay in sync. `test/test.mjs` asserts the base-set size — update
that count if you change how many signs ship.
