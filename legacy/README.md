# SgSL Studio

A browser-based Singapore Sign Language (SgSL) app. It can:

1. **Show you a sign** — type any word or phrase and an upper-body signing
   avatar (two hands, arms, head and facial expressions) performs it.
   ~50 everyday words have scripted **lexical signs** with facial grammar
   baked in (furrowed brows on wh-questions, headshake on negation, nodding
   on YES), including all days of the week (letter-handshape circles;
   SUNDAY uses both hands). Months are fingerspelled as standard
   abbreviations (JAN, FEB, SEPT…), which is how signers actually do it.
   Anything else is fingerspelled letter by letter on the raised hand
   (A–Z and digits, including the motion traces for J and Z).
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
| `js/poses.js` | fingerspelling pose library: A–Z, 0–9, rest pose, motion metadata |
| `js/handshapes.js` | extended handshape inventory for lexical signs (flat, open-5, flat-O, claw…) |
| `js/body-model.js` | upper-body avatar: anchors (chin, temple, chest…), 2-bone arm IK, face, scene composer |
| `js/signs.js` | lexical sign library (~50 signs as keyframe scripts with facial grammar) + month spelling rules + phrase resolver |
| `js/body-avatar.js` | signing-avatar animator/painter (sign playback + on-body fingerspelling) |
| `js/classifier.js` | normalisation, template matching, temporal smoothing |
| `js/avatar.js` | close-up hand renderer used by Practice and Alphabet tabs |
| `js/tracker.js` | webcam + MediaPipe Hand Landmarker wrapper |
| `js/dictionary.js` | built-in SgSL vocabulary with sign descriptions (incl. days + months) |
| `js/app.js` | application glue for the four modes |
| `test/test.mjs` | offline verification suite (`node test/test.mjs`, 700+ checks) |
| `test/render_preview.py` | contact sheet of all fingerspelling handshapes |
| `test/dump_signs.mjs` + `test/render_signs.py` | contact sheet of avatar sign keyframes (`test/signs_preview.png`) |

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

## Known limitations (v2)

- Avatar sign animations are **simplified 2.5D schematics** of signs SgSL
  shares with ASL/SEE usage — they teach the shape of a sign, but learners
  should verify against community video (SgSL Sign Bank / SADeaf), since
  SgSL has local variants.
- **J and Z** involve motion; the avatar demonstrates them, but live
  recognition only handles the 24 static letters, and recognition overall
  covers fingerspelling, not lexical signs (that needs sequence matching —
  see roadmap).
- Letters that differ mainly by hidden thumb position (M/N/T/S/E) are hard
  to tell apart from a single camera at some angles — face the camera
  palm-on for best results.

## Roadmap

- Record-and-average user calibration (one click per letter) to personalise
  templates — a natural upgrade path that *collects* a dataset over time.
- Optional ML classifier (e.g. a small MLP over normalised landmarks) once
  calibration data exists; the classifier interface already returns ranked
  candidates so it can be swapped in.
- Motion recognition for J/Z via fingertip-trajectory matching.
- Embed community sign videos from the SgSL Sign Bank for dictionary words.
