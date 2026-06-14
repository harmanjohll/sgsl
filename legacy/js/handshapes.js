/**
 * Handshape inventory for lexical signs.
 *
 * Reuses the fingerspelling pose library and adds the non-alphabet
 * handshapes that everyday signs need (flat hand, open-5, claw, flat-O,
 * bent hand...). Every entry is a pose spec consumable by
 * handLandmarks() in hand-model.js.
 */

import { LETTER_POSES, DIGIT_POSES, poseFor } from "./poses.js";

const F = (curl, splay) => {
  const f = { curl };
  if (splay !== undefined && splay !== null) f.splay = splay;
  return f;
};

export const HANDSHAPES = {
  // Borrowed straight from the manual alphabet / numbers
  A: LETTER_POSES.A, // fist, thumb up the side
  S: LETTER_POSES.S, // fist, thumb across the front
  B: LETTER_POSES.B, // flat hand, thumb across palm
  C: LETTER_POSES.C,
  F: LETTER_POSES.F,
  H: LETTER_POSES.H, // note: H pose carries rot:90; engine strips hand-local rot
  U: LETTER_POSES.U, // like H but upright
  L: LETTER_POSES.L,
  M: LETTER_POSES.M,
  T: LETTER_POSES.T, // SgSL modified T
  W: LETTER_POSES.W,
  X: LETTER_POSES.X,
  Y: LETTER_POSES.Y,
  ILY: {
    // I-LOVE-YOU: thumb, index and pinky extended
    fingers: {
      index: F("ext", 10),
      middle: F("fist"),
      ring: F("fist"),
      pinky: F("ext", -18),
    },
    thumb: "out",
  },
  point: DIGIT_POSES[1], // index finger point
  open5: DIGIT_POSES[5], // open hand, fingers spread
  flat: {
    // flat hand, fingers together, thumb alongside (classic "B-flat")
    fingers: {
      index: F("ext", 2),
      middle: F("ext", 0),
      ring: F("ext", -2),
      pinky: F("ext", -4),
    },
    thumb: "up",
  },
  bent: {
    // flat hand bent at the knuckles (used in HOW, NIGHT...)
    fingers: {
      index: F([80, 12, 5], 2),
      middle: F([80, 12, 5], 0),
      ring: F([80, 12, 5], -2),
      pinky: F([80, 12, 5], -4),
    },
    thumb: "acrossPalm",
  },
  claw5: {
    // spread fingers, hooked (used in actions like grabbing)
    fingers: {
      index: F([30, 70, 30], 12),
      middle: F([30, 70, 30], 3),
      ring: F([30, 70, 30], -8),
      pinky: F([30, 70, 30], -16),
    },
    thumb: "cShape",
  },
  flatO: {
    // fingers straight-ish, bunched onto the thumb (EAT, MORE, HOME...)
    fingers: {
      index: F([52, 18, 8], 1),
      middle: F([52, 18, 8], 0),
      ring: F([52, 18, 8], -1),
      pinky: F([52, 18, 8], -2),
    },
    thumb: { pinch: "index" },
  },
  thumbUp: LETTER_POSES.A, // alias used by time signs (TOMORROW/YESTERDAY)
};

export function handshape(name) {
  // "letter:x" resolves a fingerspelling pose, keeping its built-in
  // orientation (G/H point sideways, P/Q point down — that IS the letter).
  if (name.startsWith("letter:")) {
    const p = poseFor(name.slice(7));
    if (!p) throw new Error(`unknown letter handshape: ${name}`);
    return p.pose;
  }
  const s = HANDSHAPES[name];
  if (!s) throw new Error(`unknown handshape: ${name}`);
  // Strip alphabet-specific whole-hand rotation; the sign engine controls
  // orientation itself for lexical signs.
  if (s.rot) {
    const { rot, ...rest } = s;
    return rest;
  }
  return s;
}
