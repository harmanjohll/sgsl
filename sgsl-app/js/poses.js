/**
 * SgSL fingerspelling pose library (A–Z, 0–9).
 *
 * SgSL fingerspelling follows the ASL manual alphabet with ONE deliberate
 * difference: the letter T. The ASL T (thumb tucked between index and
 * middle fingers) is an offensive gesture in the local context, so SgSL
 * uses a modified T with the thumb resting against the side of the curled
 * index finger instead.
 *
 * Each entry is a pose spec consumed by hand-model.js, plus optional
 * `motion` metadata for the two dynamic letters (J, Z) and a short
 * human-readable description shown in the UI.
 */

const F = (curl, splay, zoff) => {
  const f = { curl };
  if (splay !== undefined && splay !== null) f.splay = splay;
  if (zoff) f.zoff = zoff;
  return f;
};
const fist = () => F("fist");

export const LETTER_POSES = {
  A: {
    fingers: { index: fist(), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "up",
    desc: "Fist with the thumb upright against the side of the index finger.",
  },
  B: {
    fingers: {
      index: F("ext", 2),
      middle: F("ext", 0),
      ring: F("ext", -2),
      pinky: F("ext", -4),
    },
    thumb: "acrossPalm",
    desc: "Flat hand, fingers together pointing up, thumb folded across the palm.",
  },
  C: {
    fingers: {
      index: F("half"),
      middle: F("half"),
      ring: F("half"),
      pinky: F("half"),
    },
    thumb: "cShape",
    desc: "Fingers and thumb curved into a C shape.",
  },
  D: {
    fingers: {
      index: F("ext"),
      middle: F("dcurl"),
      ring: F("dcurl"),
      pinky: F("dcurl"),
    },
    thumb: { pinch: "middle" },
    desc: "Index finger points up; other fingertips rest on the thumb.",
  },
  E: {
    fingers: {
      index: F("ecurl"),
      middle: F("ecurl"),
      ring: F("ecurl"),
      pinky: F("ecurl"),
    },
    thumb: "underTips",
    desc: "Fingertips curl down to rest on the thumb folded across the palm.",
  },
  F: {
    fingers: {
      index: F("ocurl"),
      middle: F("ext", -2),
      ring: F("ext", -8),
      pinky: F("ext", -14),
    },
    thumb: { pinch: "index" },
    desc: "Index fingertip and thumb form a circle; other fingers point up.",
  },
  G: {
    fingers: { index: F("ext"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "parallelIndex",
    rot: 90,
    desc: "Hand sideways, index finger and thumb pointing flat to the side.",
  },
  H: {
    fingers: {
      index: F("ext", -4),
      middle: F("ext", 4),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "acrossPalm",
    rot: 90,
    desc: "Hand sideways, index and middle fingers together pointing to the side.",
  },
  I: {
    fingers: {
      index: fist(),
      middle: fist(),
      ring: fist(),
      pinky: F("ext", -6),
    },
    thumb: "acrossPalm",
    desc: "Fist with the pinky pointing up.",
  },
  J: {
    fingers: {
      index: fist(),
      middle: fist(),
      ring: fist(),
      pinky: F("ext", -6),
    },
    thumb: "acrossPalm",
    motion: "j",
    desc: "Pinky up (like I), then trace a J hook in the air.",
  },
  K: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", -8),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "betweenIM",
    desc: "Index and middle fingers up in a V; thumb rises between them.",
  },
  L: {
    fingers: { index: F("ext"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "out",
    desc: "Index finger up and thumb out to the side, forming an L.",
  },
  M: {
    fingers: { index: fist(), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "betweenRP",
    desc: "Fist with the thumb tucked under three fingers, tip showing between ring and pinky.",
  },
  N: {
    fingers: { index: fist(), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "betweenMR",
    desc: "Fist with the thumb tucked under two fingers, tip showing between middle and ring.",
  },
  O: {
    fingers: {
      index: F("ocurl", 2),
      middle: F("ocurl", 0),
      ring: F("ocurl", -3),
      pinky: F("ocurl", -7),
    },
    thumb: { pinch: "index" },
    desc: "All fingertips curve round to meet the thumb in an O shape.",
  },
  P: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", -8),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "betweenIM",
    rot: 180,
    desc: "A K handshape turned to point downward.",
  },
  Q: {
    fingers: { index: F("ext"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "parallelIndex",
    rot: 180,
    desc: "Index finger and thumb pointing straight down.",
  },
  R: {
    fingers: {
      index: F("ext", -12, 0.08),
      middle: F("ext", 8),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "acrossPalm",
    desc: "Index and middle fingers crossed.",
  },
  S: {
    fingers: { index: fist(), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "acrossFront",
    desc: "Fist with the thumb locked across the front of the fingers.",
  },
  T: {
    fingers: { index: fist(), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "againstIndex",
    sgslNote:
      "SgSL modification: the ASL T (thumb between index and middle fingers) " +
      "is offensive in Singapore, so the thumb rests against the side of the " +
      "curled index finger instead.",
    desc: "Fist with the thumb tip resting against the side of the curled index finger (SgSL modified T).",
  },
  U: {
    fingers: {
      index: F("ext", -4),
      middle: F("ext", 4),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "acrossPalm",
    desc: "Index and middle fingers together pointing up.",
  },
  V: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", -8),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "acrossPalm",
    desc: "Index and middle fingers spread in a V.",
  },
  W: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", 0),
      ring: F("ext", -12),
      pinky: F("ocurl"),
    },
    thumb: { pinch: "pinky" },
    desc: "Index, middle and ring fingers spread; thumb holds the pinky.",
  },
  X: {
    fingers: { index: F("hook"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "acrossPalm",
    desc: "Index finger bent into a hook; other fingers in a fist.",
  },
  Y: {
    fingers: {
      index: fist(),
      middle: fist(),
      ring: fist(),
      pinky: F("ext", -20),
    },
    thumb: "out",
    desc: "Thumb and pinky stretched out; other fingers in a fist.",
  },
  Z: {
    fingers: { index: F("ext"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "acrossPalm",
    motion: "z",
    desc: "Index finger points up, then traces a Z in the air.",
  },
};

// ASL/SgSL number handshapes (used by the avatar for digits in words/phrases).
export const DIGIT_POSES = {
  0: LETTER_POSES.O,
  1: {
    fingers: { index: F("ext"), middle: fist(), ring: fist(), pinky: fist() },
    thumb: "acrossPalm",
    desc: "Index finger up.",
  },
  2: LETTER_POSES.V,
  3: {
    fingers: {
      index: F("ext", 8),
      middle: F("ext", -6),
      ring: fist(),
      pinky: fist(),
    },
    thumb: "out",
    desc: "Thumb, index and middle fingers extended.",
  },
  4: {
    fingers: {
      index: F("ext", 14),
      middle: F("ext", 4),
      ring: F("ext", -8),
      pinky: F("ext", -18),
    },
    thumb: "acrossPalm",
    desc: "Four fingers up, thumb across the palm.",
  },
  5: {
    fingers: {
      index: F("ext", 14),
      middle: F("ext", 4),
      ring: F("ext", -8),
      pinky: F("ext", -18),
    },
    thumb: "out",
    desc: "Open hand, all five digits spread.",
  },
  6: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", 0),
      ring: F("ext", -12),
      pinky: F("ocurl"),
    },
    thumb: { pinch: "pinky" },
    desc: "Thumb touches the pinky tip; other fingers up.",
  },
  7: {
    fingers: {
      index: F("ext", 12),
      middle: F("ext", 0),
      ring: F("ocurl"),
      pinky: F("ext", -16),
    },
    thumb: { pinch: "ring" },
    desc: "Thumb touches the ring fingertip; other fingers up.",
  },
  8: {
    fingers: {
      index: F("ext", 12),
      middle: F("ocurl"),
      ring: F("ext", -10),
      pinky: F("ext", -18),
    },
    thumb: { pinch: "middle" },
    desc: "Thumb touches the middle fingertip; other fingers up.",
  },
  9: {
    fingers: {
      index: F("ocurl"),
      middle: F("ext", -2),
      ring: F("ext", -8),
      pinky: F("ext", -14),
    },
    thumb: { pinch: "index" },
    desc: "Thumb touches the index fingertip; other fingers up.",
  },
};

/** Letters whose handshape is held still (recognisable from a single frame). */
export const STATIC_LETTERS = Object.keys(LETTER_POSES).filter(
  (l) => !LETTER_POSES[l].motion
);

/** Resting pose used between signs by the avatar. */
export const REST_POSE = {
  fingers: {
    index: F([20, 18, 10], 8),
    middle: F([20, 18, 10], 0),
    ring: F([20, 18, 10], -8),
    pinky: F([20, 18, 10], -14),
  },
  thumb: "up",
};

export function poseFor(ch) {
  const u = ch.toUpperCase();
  if (LETTER_POSES[u]) return { pose: LETTER_POSES[u], label: u };
  if (DIGIT_POSES[ch]) return { pose: DIGIT_POSES[ch], label: ch };
  return null;
}
