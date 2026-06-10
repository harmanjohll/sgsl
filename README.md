# SgSL Studio

A browser-based Singapore Sign Language (SgSL) fingerspelling app. It can:

1. **Show you a sign** — type any word or phrase and an animated hand avatar
   fingerspells it letter by letter (A–Z and digits, including the motion
   traces for J and Z). Words in the built-in dictionary also show a
   description of the full SgSL sign.
2. **Read your signs** — point your webcam at your hand and the app
   recognises the fingerspelling handshape you are holding, builds up the
   spelled text, and suggests matching dictionary words as you go.
3. **Practice** — the app prompts letters (or a word of your choice), shows
   the target on the avatar, and watches your hand until you hold the right
   handshape. Tracks streak and score.
4. **Alphabet reference** — interactive chart of the full SgSL manual
   alphabet with descriptions.

Everything runs locally in the browser. No account, no server, no wearable
hardware, no training data — just a laptop with a webcam.

## Quick start

```bash
cd sgsl-app
python3 -m http.server 8000
# open http://localhost:8000 in Chrome/Edge/Firefox and allow camera access
```

Any static file server works. The camera modes need an internet connection
the first time, to fetch Google's MediaPipe hand-tracking model from CDN;
the avatar/lookup/alphabet modes work fully offline.

## How it works

```
webcam ──► MediaPipe Hand Landmarker (21 3D keypoints, in-browser)
                     │
                     ▼
        normalisation (wrist-origin, palm-scale, both chiralities)
                     │
                     ▼
   weighted nearest-template matching against canonical poses ──► letter
                     │                                              │
                     ▼                                              ▼
         temporal smoothing + hold-to-commit               spelled text + word
                                                           suggestions (dictionary)
```

The key design decision: **no training data is needed.** A parametric 3D
hand model (`js/hand-model.js`, forward kinematics over the MediaPipe
21-landmark topology) generates a canonical pose for every letter from a
compact description (per-finger curl/spread + thumb preset). Those same
generated landmarks serve as:

- the **classifier templates** for recognition (`js/classifier.js`), and
- the **avatar keyframes** for rendering (`js/avatar.js`).

Because both directions share one model, the system is self-consistent and
fully testable offline.

## Files

| File | Purpose |
|---|---|
| `index.html`, `css/style.css` | UI shell (4 tabs) |
| `js/hand-model.js` | parametric hand → 21 landmarks (forward kinematics) |
| `js/poses.js` | SgSL pose library: A–Z, 0–9, rest pose, motion metadata |
| `js/classifier.js` | normalisation, template matching, temporal smoothing |
| `js/avatar.js` | canvas hand renderer + fingerspelling animator (incl. J/Z traces) |
| `js/tracker.js` | webcam + MediaPipe Hand Landmarker wrapper |
| `js/dictionary.js` | built-in SgSL vocabulary with sign descriptions |
| `js/app.js` | application glue for the four modes |
| `test/test.mjs` | offline verification suite (`node test/test.mjs`) |
| `test/render_preview.py` | renders `test/preview.png` contact sheet of all poses |

## Verification

```bash
node test/test.mjs           # 466 checks: round-trip classification of every
                             # letter, mirrored input, noise robustness,
                             # pairwise template separation, geometry sanity,
                             # every dictionary word spellable
python3 test/render_preview.py   # visual contact sheet of all 36 handshapes
```

## About SgSL

Singapore Sign Language blends Shanghainese Sign Language, ASL, Signing
Exact English and locally developed signs. Its fingerspelling follows the
ASL manual alphabet **except the letter T**: the ASL T (thumb between index
and middle fingers) is an offensive gesture locally, so SgSL uses a modified
T with the thumb against the side of the curled index finger. This app
implements the modified T and flags it in the alphabet chart.

This is an independent learning aid, not an official SADeaf resource. Full
SgSL signs use movement, two hands, body and facial grammar that go well
beyond fingerspelling — learn from the community:

- [Singapore Association for the Deaf (SADeaf)](https://sadeaf.org.sg/)
- [NTU SgSL Sign Bank](https://blogs.ntu.edu.sg/sgslsignbank/)
- [deaf.sg — SgSL lessons](https://www.deaf.sg/)

## Known limitations (v1)

- **J and Z** involve motion; the avatar demonstrates them, but live
  recognition only handles the 24 static letters.
- Letters that differ mainly by hidden thumb position (M/N/T/S/E) are hard
  to tell apart from a single camera at some angles — face the camera
  palm-on for best results.
- Dictionary signs are shown as text descriptions plus fingerspelling; the
  stick-hand avatar cannot yet perform full two-handed signs.

## Roadmap

- Record-and-average user calibration (one click per letter) to personalise
  templates — a natural upgrade path that *collects* a dataset over time.
- Optional ML classifier (e.g. a small MLP over normalised landmarks) once
  calibration data exists; the classifier interface already returns ranked
  candidates so it can be swapped in.
- Motion recognition for J/Z via fingertip-trajectory matching.
- Embed community sign videos from the SgSL Sign Bank for dictionary words.
