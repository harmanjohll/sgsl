/**
 * Offline verification of the SgSL model. Run: node test/test.mjs
 *
 * 1. Round-trip: every canonical letter pose must classify as itself.
 * 2. Mirrored (left-hand) input must also classify correctly.
 * 3. Noise robustness: jittered poses must still classify correctly.
 * 4. Separation: every pair of letter templates must be distinguishable.
 * 5. Geometry sanity checks on key handshapes.
 * 6. Digits + every dictionary word must be spellable by the avatar pipeline.
 */

import { handLandmarks, toMediaPipe } from "../js/hand-model.js";
import {
  LETTER_POSES,
  DIGIT_POSES,
  STATIC_LETTERS,
  REST_POSE,
  poseFor,
} from "../js/poses.js";
import { classify, normalize, MAX_DIST, Smoother } from "../js/classifier.js";
import { DICTIONARY } from "../js/dictionary.js";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
  }
}

/* ---- 1. round-trip classification ---- */
for (const letter of STATIC_LETTERS) {
  const lms = toMediaPipe(handLandmarks(LETTER_POSES[letter]));
  const ranked = classify(lms);
  check(
    `roundtrip ${letter}`,
    ranked[0].letter === letter,
    `→ got ${ranked[0].letter} (d=${ranked[0].dist.toFixed(3)})`
  );
  check(
    `in-range ${letter}`,
    ranked[0].dist <= MAX_DIST,
    `dist ${ranked[0].dist.toFixed(3)} > MAX_DIST`
  );
}

/* ---- 2. mirrored input ---- */
for (const letter of STATIC_LETTERS) {
  const lms = toMediaPipe(handLandmarks(LETTER_POSES[letter])).map((p) => ({
    x: 1 - p.x,
    y: p.y,
    z: p.z,
  }));
  const ranked = classify(lms);
  check(
    `mirror ${letter}`,
    ranked[0].letter === letter,
    `→ got ${ranked[0].letter}`
  );
}

/* ---- 3. noise robustness ---- */
let rngState = 42;
function rng() {
  // deterministic LCG so the test is reproducible
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296 - 0.5;
}
const NOISE = 0.008; // ~2.4% of palm size in normalised units
let noiseFails = [];
for (const letter of STATIC_LETTERS) {
  let ok = 0;
  const trials = 20;
  for (let t = 0; t < trials; t++) {
    const lms = toMediaPipe(handLandmarks(LETTER_POSES[letter])).map((p) => ({
      x: p.x + rng() * NOISE * 2,
      y: p.y + rng() * NOISE * 2,
      z: p.z + rng() * NOISE * 2,
    }));
    if (classify(lms)[0].letter === letter) ok++;
  }
  if (ok < trials * 0.9) noiseFails.push(`${letter}:${ok}/${trials}`);
  check(`noise ${letter}`, ok >= trials * 0.9, `${ok}/${trials} correct`);
}

/* ---- 4. pairwise template separation ---- */
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < 21; i++) {
    s +=
      (a[i][0] - b[i][0]) ** 2 +
      (a[i][1] - b[i][1]) ** 2 +
      0.35 * (a[i][2] - b[i][2]) ** 2;
  }
  return Math.sqrt(s / 21);
}
const norms = STATIC_LETTERS.map((l) => ({
  l,
  n: normalize(toMediaPipe(handLandmarks(LETTER_POSES[l]))),
}));
let minPair = Infinity;
let minPairName = "";
for (let i = 0; i < norms.length; i++) {
  for (let j = i + 1; j < norms.length; j++) {
    const d = dist(norms[i].n, norms[j].n);
    if (d < minPair) {
      minPair = d;
      minPairName = `${norms[i].l}/${norms[j].l}`;
    }
    check(`separation ${norms[i].l}/${norms[j].l}`, d > 0.04, `d=${d.toFixed(4)}`);
  }
}

/* ---- 5. geometry sanity (local frame: +Y up, +Z toward viewer) ---- */
{
  const b = handLandmarks(LETTER_POSES.B);
  check("B fingers up", b[8][1] > 1.5 && b[12][1] > 1.6, `tips y=${b[8][1].toFixed(2)},${b[12][1].toFixed(2)}`);
  const a = handLandmarks(LETTER_POSES.A);
  check("A fist curled", a[8][1] < 1.1, `index tip y=${a[8][1].toFixed(2)}`);
  check("A thumb up", a[4][1] > 0.9, `thumb tip y=${a[4][1].toFixed(2)}`);
  const l = handLandmarks(LETTER_POSES.L);
  check("L thumb out", l[4][0] < -0.8, `thumb tip x=${l[4][0].toFixed(2)}`);
  const v = handLandmarks(LETTER_POSES.V);
  const u = handLandmarks(LETTER_POSES.U);
  const vGap = Math.abs(v[8][0] - v[12][0]);
  const uGap = Math.abs(u[8][0] - u[12][0]);
  check("V wider than U", vGap > uGap + 0.2, `V=${vGap.toFixed(2)} U=${uGap.toFixed(2)}`);
  const g = handLandmarks(LETTER_POSES.G);
  check("G points sideways", Math.abs(g[8][0]) > Math.abs(g[8][1]), `tip=(${g[8][0].toFixed(2)},${g[8][1].toFixed(2)})`);
  const q = handLandmarks(LETTER_POSES.Q);
  check("Q points down", q[8][1] < -1.0, `index tip y=${q[8][1].toFixed(2)}`);
  const r = handLandmarks(LETTER_POSES.R);
  // crossed: index starts left of middle but its tip ends to the right
  check("R crossed", r[5][0] < r[9][0] && r[8][0] > r[12][0], `tips x=${r[8][0].toFixed(2)},${r[12][0].toFixed(2)}`);
  const f = handLandmarks(LETTER_POSES.F);
  const pinch = Math.hypot(f[4][0] - f[8][0], f[4][1] - f[8][1], f[4][2] - f[8][2]);
  check("F thumb-index pinch", pinch < 0.25, `gap=${pinch.toFixed(2)}`);
  const t = handLandmarks(LETTER_POSES.T);
  check("SgSL T thumb near index side", t[4][0] < -0.2 && t[4][1] < 1.0, `thumb tip=(${t[4][0].toFixed(2)},${t[4][1].toFixed(2)})`);
  const m = handLandmarks(LETTER_POSES.M);
  const n = handLandmarks(LETTER_POSES.N);
  check("M thumb right of N thumb", m[4][0] > n[4][0] + 0.1, `M=${m[4][0].toFixed(2)} N=${n[4][0].toFixed(2)}`);
}

/* ---- 6. everything spellable ---- */
for (const d of Object.keys(DIGIT_POSES)) {
  const lms = handLandmarks(DIGIT_POSES[d]);
  check(`digit ${d} buildable`, lms.length === 21);
}
check("rest pose buildable", handLandmarks(REST_POSE).length === 21);
for (const e of DICTIONARY) {
  const chars = e.word.replace(/\s/g, "").split("");
  const bad = chars.filter((c) => !poseFor(c));
  check(`spellable "${e.word}"`, bad.length === 0, `missing: ${bad.join(",")}`);
}
for (const l of Object.keys(LETTER_POSES)) {
  check(`letter ${l} buildable`, handLandmarks(LETTER_POSES[l]).length === 21);
}

/* ---- 7. temporal smoothing ---- */
{
  // Letters commit after a steady hold...
  const s = new Smoother({ window: 12, minShare: 0.65, holdMs: 700 });
  let t = 0;
  const commits = [];
  // 90 frames ≈ 3s: first commit at 0.7s, repeat at 0.7+1.4s, third would
  // need 3.5s — so exactly two commits expected.
  for (let i = 0; i < 90; i++) {
    t += 33; // ~30 fps
    const { committed } = s.push("A", t);
    if (committed) commits.push(committed);
  }
  check("smoother commits held letter", commits[0] === "A", `got ${commits[0]}`);
  check(
    "smoother repeat needs longer hold",
    commits.length === 2,
    `commits in 3s: ${commits.length}`
  );

  // Flickering candidates must not commit anything.
  const s2 = new Smoother({ window: 12, minShare: 0.65, holdMs: 700 });
  t = 0;
  let flickerCommits = 0;
  const seq = ["A", "B", null, "A", "C", "B", null, "A", "B", "C"];
  for (let i = 0; i < 60; i++) {
    t += 33;
    if (s2.push(seq[i % seq.length], t).committed) flickerCommits++;
  }
  check("smoother rejects flicker", flickerCommits === 0, `${flickerCommits} commits`);

  // Losing the hand resets the hold.
  const s3 = new Smoother({ window: 12, minShare: 0.65, holdMs: 700 });
  t = 0;
  let earlyCommit = false;
  for (let i = 0; i < 15; i++) {
    t += 33;
    if (s3.push("A", t).committed) earlyCommit = true;
  }
  for (let i = 0; i < 15; i++) {
    t += 33;
    if (s3.push(null, t).committed) earlyCommit = true;
  }
  check("smoother no commit on short hold + loss", !earlyCommit);
}

/* ---- 8. lexical sign library ---- */
{
  const { SIGNS, MONTH_SPELLINGS, resolveWord, resolvePhrase } = await import(
    "../js/signs.js"
  );
  const { ANCHORS, ARM_REACH, placeHand, composeScene, solveElbow } =
    await import("../js/body-model.js");
  const { handshape, HANDSHAPES } = await import("../js/handshapes.js");
  const { resolveHand } = await import("../js/body-avatar.js");

  // every handshape builds
  for (const name of Object.keys(HANDSHAPES)) {
    const lms = handLandmarks(handshape(name));
    check(`handshape ${name} buildable`, lms.length === 21);
  }

  // every sign script is structurally valid and physically reachable
  for (const [word, sign] of Object.entries(SIGNS)) {
    check(`sign ${word} has frames`, Array.isArray(sign.frames) && sign.frames.length > 0);
    check(`sign ${word} has description`, typeof sign.description === "string" && sign.description.length > 10);
    let frameOk = true;
    let reachOk = true;
    for (const f of sign.frames) {
      if (!(f.dur > 0)) frameOk = false;
      for (const [hand, spec] of [["r", f.rh], ["l", f.lh]]) {
        if (!spec) { frameOk = false; continue; }
        let pts;
        try {
          pts = resolveHand(hand, spec);
        } catch {
          frameOk = false;
          continue;
        }
        // wrist must be within arm's reach of the shoulder (else IK clamps
        // and the arm visibly distorts)
        const S = hand === "r" ? ANCHORS.SHOULDER_R : ANCHORS.SHOULDER_L;
        const d = Math.hypot(pts[0][0] - S[0], pts[0][1] - S[1]);
        if (d > ARM_REACH + 0.12) reachOk = false;
      }
    }
    check(`sign ${word} frames valid`, frameOk);
    check(`sign ${word} within arm reach`, reachOk, "wrist beyond arm length");
  }

  // days + months coverage
  for (const day of ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]) {
    check(`day sign ${day}`, !!SIGNS[day]);
  }
  check("12 months spellable", Object.keys(MONTH_SPELLINGS).length === 12);
  check("september is SEPT", MONTH_SPELLINGS.september === "SEPT");
  check(
    "month resolves to spelling",
    resolveWord("january").kind === "spell" && resolveWord("january").text === "JAN"
  );

  // phrase resolution: multi-word signs match greedily
  const phrase = resolvePhrase("thank you my friend");
  check(
    "phrase: 'thank you' is one sign",
    phrase[0].kind === "sign" && phrase[0].word === "thank you",
    JSON.stringify(phrase.map((p) => p.word))
  );
  check("phrase: 'my' fingerspelled", phrase[1].kind === "spell");
  check("phrase: 'friend' is a sign", phrase[2].kind === "sign");

  // letter pseudo-handshapes for on-body fingerspelling
  const fsPts = resolveHand("r", { shape: "letter:a", at: "FS" });
  check("letter handshape places", fsPts.length === 21);

  // scene composes for rest + an active two-handed state
  const rest = composeScene({
    rhPts: resolveHand("r", "rest"),
    lhPts: resolveHand("l", "rest"),
    face: {},
  });
  check("rest scene composes", rest.length > 10);
  const ik = solveElbow(ANCHORS.SHOULDER_R, [-0.3, 0.8], -1);
  check("IK elbow finite", Number.isFinite(ik.elbow[0]) && Number.isFinite(ik.elbow[1]));

  // dictionary picked up the days/months entries
  const { DICTIONARY: dict } = await import("../js/dictionary.js");
  check("dictionary has sunday", dict.some((e) => e.word === "sunday"));
  check("dictionary has december", dict.some((e) => e.word === "december"));

  // avatar cast: every theme is complete and composes a scene
  const { AVATARS, DEFAULT_AVATAR } = await import("../js/body-model.js");
  check("default avatar exists", !!AVATARS[DEFAULT_AVATAR]);
  const restState = {
    rhPts: resolveHand("r", "rest"),
    lhPts: resolveHand("l", "rest"),
    face: {},
  };
  for (const [key, theme] of Object.entries(AVATARS)) {
    const fields = ["label", "skin", "skinDark", "skinLight", "hair", "hairStyle", "shirt", "shirtDark"];
    check(`avatar ${key} complete`, fields.every((f) => theme[f]));
    const prims = composeScene(restState, theme);
    check(`avatar ${key} composes`, prims.length > 10);
    check(
      `avatar ${key} primitives well-formed`,
      prims.every((p) => ["line", "circle", "ellipse", "arc", "poly"].includes(p.type))
    );
  }
}

/* ---- report ---- */
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`closest template pair: ${minPairName} (d=${minPair.toFixed(4)})`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
} else {
  console.log("All checks passed ✓");
}
