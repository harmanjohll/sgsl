/**
 * Lexical sign library.
 *
 * Each sign is a sequence of keyframes for the upper-body avatar:
 *   { rh: handSpec | "rest", lh: handSpec | "rest",
 *     face: {brows, mouth, headDx, headDy}, dur: ms }
 * handSpec: { shape, at, offset?, orient?, palm? } — see body-model.js.
 *
 * Facial grammar baked in where it is grammatical, per common usage:
 *   - wh-questions (WHAT, WHERE...) → furrowed brows
 *   - yes/no and affirmation → raised brows / nod
 *   - negation (NO, BAD) → headshake / frown
 *
 * Provenance: these follow ASL/SEE-derived signs that SgSL shares; SgSL
 * has local variants, so each entry keeps a text description and the UI
 * links to the SgSL Sign Bank for community-verified video. Days of the
 * week use letter-handshape circles (palm in; SUNDAY: both open hands,
 * palms out, circling). Months are fingerspelled abbreviations.
 */

/* ---------- tiny DSL helpers ---------- */
const RH = (shape, at, opts = {}) => ({ shape, at, ...opts });
const KF = (rh, lh, dur, face) => {
  const f = { rh, lh: lh || "rest", dur };
  if (face) f.face = face;
  return f;
};

/** Small circular motion of one hand around its anchor. */
function circleFrames(handSpec, r, loops, durPerLoop, face) {
  const frames = [];
  const steps = 6;
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      frames.push(
        KF(
          { ...handSpec, offset: addOff(handSpec.offset, [r * Math.sin(a), r * Math.cos(a) - r]) },
          "rest",
          durPerLoop / steps,
          face
        )
      );
    }
  }
  return frames;
}

/** Tap: touch the anchor, lift slightly, touch again. */
function tapFrames(handSpec, lh, lift, n, durPerTap, face) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(KF({ ...handSpec, offset: addOff(handSpec.offset, lift) }, lh, durPerTap * 0.45, face));
    frames.push(KF(handSpec, lh, durPerTap * 0.55, face));
  }
  return frames;
}

/** Side-to-side shake of one hand. */
function shakeFrames(handSpec, lh, dx, n, durPerSwing, face) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(KF({ ...handSpec, offset: addOff(handSpec.offset, [-dx, 0]) }, lh, durPerSwing, face));
    frames.push(KF({ ...handSpec, offset: addOff(handSpec.offset, [dx, 0]) }, lh, durPerSwing, face));
  }
  frames.push(KF(handSpec, lh, durPerSwing * 0.6, face));
  return frames;
}

function addOff(a, b) {
  return a ? [a[0] + b[0], a[1] + b[1]] : b;
}

const WH_FACE = { brows: "furrow", mouth: "neutral" };
const SMILE = { mouth: "smile" };

/** Weekday helper: letter handshape, palm in, small circles in side space. */
function weekday(shape) {
  return {
    frames: circleFrames(
      RH(shape, "NEUTRAL_R", { palm: "in", offset: [0, 0.25] }),
      0.08,
      2,
      650
    ),
    description: `${shape} handshape, palm facing you, moves in a small circle.`,
  };
}

/* ---------- the lexicon ---------- */
export const SIGNS = {
  hello: {
    frames: [
      KF(RH("flat", "TEMPLE", { orient: -25 }), "rest", 380, SMILE),
      KF(RH("flat", "TEMPLE", { offset: [-0.45, 0.1], orient: -50 }), "rest", 420, SMILE),
    ],
    description: "Flat hand at the temple moves outward, like a relaxed salute.",
  },
  goodbye: {
    frames: [
      KF(RH("open5", "FS"), "rest", 300, SMILE),
      ...shakeFrames(RH("open5", "FS"), "rest", 0.12, 3, 200, SMILE),
    ],
    description: "Open hand raised, waving side to side.",
  },
  "thank you": {
    frames: [
      KF(RH("flat", "CHIN", { palm: "in" }), "rest", 400, SMILE),
      KF(RH("flat", "CHIN", { offset: [-0.3, -0.3], orient: -35 }), "rest", 450, SMILE),
    ],
    description: "Flat hand at the chin moves forward and down toward the person.",
  },
  please: {
    frames: circleFrames(RH("flat", "CHEST_R", { palm: "in" }), 0.12, 2, 800, SMILE),
    description: "Flat hand on the chest moves in circles.",
  },
  sorry: {
    frames: circleFrames(RH("A", "CHEST_R", { palm: "in" }), 0.12, 2, 800, {
      brows: "up",
      mouth: "frown",
    }),
    description: "A-handshape fist circles on the chest, with an apologetic face.",
  },
  yes: {
    frames: [
      KF(RH("S", "NEUTRAL_R", { offset: [0, 0.35] }), "rest", 280, { brows: "up", headDy: 0.03 }),
      KF(RH("S", "NEUTRAL_R", { offset: [0, 0.15], orient: 35 }), "rest", 260, { headDy: -0.04 }),
      KF(RH("S", "NEUTRAL_R", { offset: [0, 0.35] }), "rest", 260, { headDy: 0.02 }),
      KF(RH("S", "NEUTRAL_R", { offset: [0, 0.15], orient: 35 }), "rest", 260, { headDy: -0.04 }),
    ],
    description: "Fist nods up and down at the wrist, like a head nodding. The head nods along.",
  },
  no: {
    frames: [
      KF(RH("U", "FS", { offset: [0.1, 0] }), "rest", 320, { mouth: "pressed", headDx: 0.04 }),
      KF(RH("flatO", "FS", { offset: [0.1, -0.05] }), "rest", 260, { mouth: "pressed", headDx: -0.05 }),
      KF(RH("U", "FS", { offset: [0.1, 0] }), "rest", 260, { mouth: "pressed", headDx: 0.04 }),
      KF(RH("flatO", "FS", { offset: [0.1, -0.05] }), "rest", 260, { mouth: "pressed", headDx: -0.05 }),
    ],
    description:
      "Index and middle fingers snap shut onto the thumb (like a mouth closing) while the head shakes.",
  },
  help: {
    frames: [
      KF(
        RH("A", "NEUTRAL", { offset: [0, 0.1] }),
        RH("flat", "NEUTRAL", { offset: [0, -0.12], orient: 90, palm: "in" }),
        450
      ),
      KF(
        RH("A", "NEUTRAL", { offset: [0, 0.45] }),
        RH("flat", "NEUTRAL", { offset: [0, 0.23], orient: 90, palm: "in" }),
        550
      ),
    ],
    description: "One fist rests on the opposite flat palm; both rise together.",
  },
  stop: {
    frames: [
      KF(
        RH("flat", "NEUTRAL", { offset: [0, 0.5], orient: -80 }),
        RH("flat", "NEUTRAL", { offset: [0, -0.1], orient: 90, palm: "in" }),
        300,
        { mouth: "pressed" }
      ),
      KF(
        RH("flat", "NEUTRAL", { offset: [0, 0.08], orient: -80 }),
        RH("flat", "NEUTRAL", { offset: [0, -0.1], orient: 90, palm: "in" }),
        250,
        { mouth: "pressed", brows: "furrow" }
      ),
    ],
    description: "Edge of the flat hand chops down onto the opposite open palm.",
  },
  good: {
    frames: [
      KF(RH("flat", "CHIN", { palm: "in" }), RH("flat", "NEUTRAL_L", { orient: 90, palm: "in" }), 420, SMILE),
      KF(
        RH("flat", "NEUTRAL", { offset: [0.15, 0.05], orient: 70, palm: "out" }),
        RH("flat", "NEUTRAL_L", { orient: 90, palm: "in" }),
        500,
        SMILE
      ),
    ],
    description: "Flat hand at the chin moves down to land palm-up on the other hand.",
  },
  bad: {
    frames: [
      KF(RH("flat", "CHIN", { palm: "in" }), "rest", 420, { mouth: "frown", brows: "furrow" }),
      KF(RH("flat", "NEUTRAL", { offset: [0, -0.1], orient: 160, palm: "out" }), "rest", 500, {
        mouth: "frown",
        brows: "furrow",
        headDx: -0.03,
      }),
    ],
    description: "Flat hand at the chin flips over and moves down, palm turning away.",
  },
  eat: {
    frames: tapFrames(RH("flatO", "MOUTH", { palm: "in" }), "rest", [0, -0.18], 2, 480, { mouth: "open" }),
    description: "Bunched fingertips (flat-O) tap the lips, as if bringing food to the mouth.",
  },
  drink: {
    frames: [
      KF(RH("C", "MOUTH", { offset: [0, -0.15] }), "rest", 380),
      KF(RH("C", "MOUTH", { offset: [0, 0.02], orient: -45 }), "rest", 480, { mouth: "open" }),
    ],
    description: "C handshape tips toward the mouth, like raising a cup.",
  },
  water: {
    frames: tapFrames(RH("W", "CHIN", { palm: "in" }), "rest", [0, -0.12], 2, 450),
    description: "W handshape taps the chin twice.",
  },
  toilet: {
    frames: shakeFrames(RH("T", "FS", { offset: [0.1, -0.1] }), "rest", 0.09, 3, 200),
    description: "T handshape (SgSL modified T) shakes gently side to side.",
  },
  more: {
    frames: tapFrames(
      RH("flatO", "NEUTRAL", { offset: [-0.1, 0.15], orient: 55 }),
      RH("flatO", "NEUTRAL", { offset: [0.1, 0.15], orient: -55 }),
      [-0.12, 0.08],
      2,
      460
    ),
    description: "Fingertips of both flat-O hands tap together repeatedly.",
  },
  finish: {
    frames: [
      KF(
        RH("open5", "CHEST_R", { offset: [-0.1, 0.25], palm: "in" }),
        RH("open5", "CHEST_L", { offset: [0.1, 0.25], palm: "in" }),
        380
      ),
      KF(
        RH("open5", "SIDE", { offset: [0, 0.25], orient: -35 }),
        RH("open5", "NEUTRAL_L", { offset: [0.45, 0.35], orient: 35 }),
        480
      ),
    ],
    description: "Both open hands, palms in, flip outward to palms out.",
  },
  name: {
    frames: tapFrames(
      RH("U", "NEUTRAL", { offset: [0, 0.3], orient: 50 }),
      RH("U", "NEUTRAL", { offset: [0, 0.18], orient: -50 }),
      [-0.06, 0.1],
      2,
      480
    ),
    description: "Both H/U hands; the dominant one taps across the other, forming an X.",
  },
  what: {
    frames: shakeFrames(
      RH("open5", "NEUTRAL_R", { offset: [0, 0.1], orient: 80 }),
      RH("open5", "NEUTRAL_L", { offset: [0, 0.1], orient: -80 }),
      0.07,
      2,
      240,
      WH_FACE
    ),
    description: "Both open hands, palms up, shake slightly — with furrowed brows (wh-question face).",
  },
  where: {
    frames: shakeFrames(RH("point", "FS", { offset: [0.1, 0] }), "rest", 0.09, 3, 190, WH_FACE),
    description: "Index finger up shakes side to side, with furrowed brows.",
  },
  who: {
    frames: circleFrames(RH("point", "MOUTH", { offset: [0, -0.05], palm: "in" }), 0.07, 2, 700, WH_FACE),
    description: "Index finger circles in front of the lips, with furrowed brows.",
  },
  why: {
    frames: [
      KF(RH("flat", "FOREHEAD", { offset: [-0.15, 0], palm: "in" }), "rest", 420, WH_FACE),
      KF(RH("Y", "FS", { offset: [0.15, -0.2] }), "rest", 480, WH_FACE),
    ],
    description: "Fingers touch the forehead, then pull away into a Y handshape. Furrowed brows.",
  },
  how: {
    frames: [
      KF(
        RH("bent", "NEUTRAL", { offset: [-0.12, 0.2], orient: 60, palm: "in" }),
        RH("bent", "NEUTRAL", { offset: [0.12, 0.2], orient: -60, palm: "in" }),
        420,
        WH_FACE
      ),
      KF(
        RH("bent", "NEUTRAL", { offset: [-0.1, 0.28], orient: 110 }),
        RH("bent", "NEUTRAL", { offset: [0.1, 0.28], orient: -110 }),
        500,
        WH_FACE
      ),
    ],
    description: "Bent hands back-to-back roll forward and open, palms up. Furrowed brows.",
  },
  when: {
    frames: [
      ...circleFrames(RH("point", "NEUTRAL", { offset: [-0.05, 0.45] }), 0.1, 1, 520, WH_FACE),
      KF(
        RH("point", "NEUTRAL", { offset: [0, 0.32] }),
        RH("point", "NEUTRAL", { offset: [0.02, 0.1] }),
        420,
        WH_FACE
      ),
    ],
    description: "One index finger circles the other upright index finger, then lands on its tip.",
  },
  me: {
    frames: [KF(RH("point", "CHEST", { palm: "in", orient: 160 }), "rest", 600)],
    description: "Index finger points to your own chest.",
  },
  i: {
    frames: [KF(RH("point", "CHEST", { palm: "in", orient: 160 }), "rest", 600)],
    description: "Index finger points to your own chest. (Same as ME.)",
  },
  you: {
    frames: [KF(RH("point", "NEUTRAL", { offset: [0, 0.35], orient: -85 }), "rest", 600)],
    description: "Index finger points at the person you are addressing.",
  },
  we: {
    frames: [
      KF(RH("point", "CHEST_R", { palm: "in", orient: 150 }), "rest", 380),
      KF(RH("point", "CHEST_L", { palm: "in", orient: -150 }), "rest", 480),
    ],
    description: "Index finger touches one side of the chest, arcs to the other side.",
  },
  love: {
    frames: [
      KF(
        RH("S", "CHEST_R", { offset: [0.12, 0], palm: "in", orient: 35 }),
        RH("S", "CHEST_L", { offset: [-0.12, 0], palm: "in", orient: -35 }),
        900,
        SMILE
      ),
    ],
    description: "Both fists cross over the heart, hugging the chest.",
  },
  "i love you": {
    frames: [KF(RH("ILY", "FS"), "rest", 900, SMILE)],
    description: "One hand: thumb, index and pinky extended (combines I, L and Y).",
  },
  family: {
    frames: [
      KF(
        RH("F", "NEUTRAL", { offset: [-0.08, 0.35] }),
        RH("F", "NEUTRAL", { offset: [0.08, 0.35] }),
        380,
        SMILE
      ),
      KF(
        RH("F", "NEUTRAL", { offset: [-0.38, 0.25], orient: -60 }),
        RH("F", "NEUTRAL", { offset: [0.38, 0.25], orient: 60 }),
        420,
        SMILE
      ),
      KF(
        RH("F", "NEUTRAL", { offset: [-0.1, 0.1], orient: -160, palm: "in" }),
        RH("F", "NEUTRAL", { offset: [0.1, 0.1], orient: 160, palm: "in" }),
        480,
        SMILE
      ),
    ],
    description: "Both F handshapes circle outward from together and meet again, palms in.",
  },
  friend: {
    frames: [
      KF(
        RH("X", "NEUTRAL", { offset: [0, 0.3], orient: 140, palm: "in" }),
        RH("X", "NEUTRAL", { offset: [0, 0.12] }),
        500,
        SMILE
      ),
      KF(
        RH("X", "NEUTRAL", { offset: [0, 0.12] }),
        RH("X", "NEUTRAL", { offset: [0, 0.3], orient: -140, palm: "in" }),
        550,
        SMILE
      ),
    ],
    description: "Hooked index fingers link one way, then swap and link the other way.",
  },
  home: {
    frames: [
      KF(RH("flatO", "CHEEK", { palm: "in" }), "rest", 420),
      KF(RH("flatO", "EAR", { offset: [0.02, 0.02], palm: "in" }), "rest", 480),
    ],
    description: "Flat-O fingertips touch the cheek, then move back toward the ear.",
  },
  school: {
    frames: tapFrames(
      RH("flat", "NEUTRAL", { offset: [0, 0.25], orient: 80 }),
      RH("flat", "NEUTRAL", { offset: [0, 0.05], orient: 90, palm: "in" }),
      [0, 0.16],
      2,
      460
    ),
    description: "Flat hands clap together twice, one on top of the other.",
  },
  work: {
    frames: tapFrames(
      RH("S", "NEUTRAL", { offset: [0.05, 0.2], orient: 60 }),
      RH("S", "NEUTRAL", { offset: [0.22, 0], orient: -45, palm: "in" }),
      [0, 0.14],
      2,
      460
    ),
    description: "Dominant fist taps the back of the other fist twice.",
  },
  learn: {
    frames: [
      KF(
        RH("claw5", "NEUTRAL", { offset: [0, 0.18] }),
        RH("flat", "NEUTRAL", { offset: [0, -0.05], orient: 90, palm: "in" }),
        420
      ),
      KF(
        RH("flatO", "FOREHEAD", { offset: [-0.1, -0.05], palm: "in" }),
        RH("flat", "NEUTRAL", { offset: [0, -0.05], orient: 90, palm: "in" }),
        520
      ),
    ],
    description: "Open hand 'lifts' information off the other palm up to the forehead.",
  },
  sign: {
    frames: [
      KF(
        RH("point", "NEUTRAL", { offset: [-0.15, 0.4], orient: 30, palm: "in" }),
        RH("point", "NEUTRAL", { offset: [0.15, 0.25], orient: -30, palm: "in" }),
        300
      ),
      KF(
        RH("point", "NEUTRAL", { offset: [-0.15, 0.25], orient: 30, palm: "in" }),
        RH("point", "NEUTRAL", { offset: [0.15, 0.4], orient: -30, palm: "in" }),
        300
      ),
      KF(
        RH("point", "NEUTRAL", { offset: [-0.15, 0.4], orient: 30, palm: "in" }),
        RH("point", "NEUTRAL", { offset: [0.15, 0.25], orient: -30, palm: "in" }),
        300
      ),
    ],
    description: "Both index fingers point at each other and circle alternately.",
  },
  deaf: {
    frames: [
      KF(RH("point", "EAR", { palm: "in" }), "rest", 420),
      KF(RH("point", "MOUTH", { offset: [-0.12, -0.05], palm: "in" }), "rest", 480),
    ],
    description: "Index finger touches near the ear, then near the mouth.",
  },
  hearing: {
    frames: circleFrames(RH("point", "MOUTH", { offset: [0, -0.05], orient: 70, palm: "in" }), 0.08, 2, 700),
    description: "Index finger circles forward in front of the mouth.",
  },
  morning: {
    frames: [
      KF(
        RH("flat", "NEUTRAL", { offset: [-0.05, 0], orient: 95, palm: "in" }),
        RH("flat", "NEUTRAL", { offset: [0.05, -0.12], orient: 90, palm: "in" }),
        420,
        SMILE
      ),
      KF(
        RH("flat", "NEUTRAL", { offset: [-0.05, 0.45], orient: 30, palm: "in" }),
        RH("flat", "NEUTRAL", { offset: [0.05, -0.12], orient: 90, palm: "in" }),
        550,
        SMILE
      ),
    ],
    description: "One arm lies flat; the other flat hand rises behind it like the sun coming up.",
  },
  night: {
    frames: [
      KF(
        RH("bent", "NEUTRAL", { offset: [-0.05, 0.4], orient: -25 }),
        RH("flat", "NEUTRAL", { offset: [0.05, 0], orient: 90, palm: "in" }),
        420
      ),
      KF(
        RH("bent", "NEUTRAL", { offset: [-0.02, 0.16], orient: -55 }),
        RH("flat", "NEUTRAL", { offset: [0.05, 0], orient: 90, palm: "in" }),
        520
      ),
    ],
    description: "Bent hand drops over the back of the other flat hand, like the sun setting.",
  },
  today: {
    frames: tapFrames(
      RH("Y", "NEUTRAL_R", { offset: [0, 0.15], orient: 75 }),
      RH("Y", "NEUTRAL_L", { offset: [0, 0.15], orient: -75 }),
      [0, 0.14],
      2,
      460
    ),
    description: "Both Y (or flat) hands, palms up, drop down twice in front of the body.",
  },
  tomorrow: {
    frames: [
      KF(RH("thumbUp", "CHEEK", { palm: "in" }), "rest", 420),
      KF(RH("thumbUp", "CHEEK", { offset: [-0.3, -0.12], orient: -45 }), "rest", 500),
    ],
    description: "Thumb of the A handshape on the cheek arcs forward.",
  },
  yesterday: {
    frames: [
      KF(RH("thumbUp", "CHIN", { offset: [-0.2, 0.05], palm: "in" }), "rest", 420),
      KF(RH("thumbUp", "EAR", { offset: [0, -0.02], palm: "in" }), "rest", 500),
    ],
    description: "Thumb of the A handshape at the chin arcs back toward the ear.",
  },
  monday: weekday("M"),
  tuesday: { ...weekday("T"), description: "SgSL modified T handshape, palm in, circles. (ASL uses its own T.)" },
  wednesday: weekday("W"),
  thursday: { ...weekday("H"), description: "H handshape, palm in, circles. (Often signed T-then-H.)" },
  friday: weekday("F"),
  saturday: weekday("S"),
  sunday: {
    frames: [
      KF(
        RH("open5", "NEUTRAL", { offset: [-0.3, 0.55] }),
        RH("open5", "NEUTRAL", { offset: [0.3, 0.55] }),
        350,
        SMILE
      ),
      KF(
        RH("open5", "NEUTRAL", { offset: [-0.45, 0.4] }),
        RH("open5", "NEUTRAL", { offset: [0.45, 0.4] }),
        350,
        SMILE
      ),
      KF(
        RH("open5", "NEUTRAL", { offset: [-0.3, 0.55] }),
        RH("open5", "NEUTRAL", { offset: [0.3, 0.55] }),
        350,
        SMILE
      ),
      KF(
        RH("open5", "NEUTRAL", { offset: [-0.45, 0.4] }),
        RH("open5", "NEUTRAL", { offset: [0.45, 0.4] }),
        350,
        SMILE
      ),
    ],
    description: "Both open hands, palms out, make small outward circles.",
  },
};

/* ---------- months: fingerspelled abbreviations ---------- */
// Months have no separate signs in ASL/SEE-derived usage (incl. SgSL):
// short names are spelled in full, long ones abbreviated.
export const MONTH_SPELLINGS = {
  january: "JAN",
  february: "FEB",
  march: "MARCH",
  april: "APRIL",
  may: "MAY",
  june: "JUN",
  july: "JULY",
  august: "AUG",
  september: "SEPT",
  october: "OCT",
  november: "NOV",
  december: "DEC",
};

/**
 * Resolve a single word: a lexical sign, a month abbreviation to
 * fingerspell, or plain fingerspelling.
 */
export function resolveWord(word) {
  const w = word.trim().toLowerCase();
  if (SIGNS[w]) return { kind: "sign", word: w, sign: SIGNS[w] };
  if (MONTH_SPELLINGS[w])
    return {
      kind: "spell",
      word: w,
      text: MONTH_SPELLINGS[w],
      note: `Months are fingerspelled — "${w}" is spelled ${MONTH_SPELLINGS[w].split("").join("-")}.`,
    };
  return { kind: "spell", word: w, text: w.toUpperCase() };
}

/**
 * Resolve a phrase. Multi-word lexical entries ("thank you",
 * "i love you") are matched greedily before single words.
 */
export function resolvePhrase(text) {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let n = Math.min(3, words.length - i); n >= 2; n--) {
      const joined = words.slice(i, i + n).join(" ");
      if (SIGNS[joined]) {
        out.push({ kind: "sign", word: joined, sign: SIGNS[joined] });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(resolveWord(words[i]));
      i += 1;
    }
  }
  return out;
}
