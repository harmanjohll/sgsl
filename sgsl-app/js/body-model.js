/**
 * Upper-body avatar model.
 *
 * Pure geometry: given a body state (two hand specs + face state), compose
 * a list of drawing primitives in body coordinates. The canvas painter
 * (body-avatar.js) and the offline PNG preview both consume the same
 * primitives, so what we test offline is what users see.
 *
 * Body space: origin at the chest centre, +X = viewer's right, +Y = up.
 * One unit ≈ a head height. The signer faces the viewer, so the signer's
 * RIGHT hand appears on the viewer's LEFT (negative X).
 */

import { handLandmarks } from "./hand-model.js";
import { handshape } from "./handshapes.js";

/* ---------------- anchors (body coordinates) ---------------- */
export const ANCHORS = {
  FOREHEAD: [0, 1.5],
  TEMPLE: [-0.5, 1.38],
  EAR: [-0.52, 1.16],
  EYE: [-0.18, 1.26],
  NOSE: [0, 1.1],
  CHEEK: [-0.4, 0.98],
  MOUTH: [0, 0.95],
  CHIN: [0, 0.8],
  NECK: [0, 0.55],
  SHOULDER_R: [-0.62, 0.42], // signer's right (viewer's left)
  SHOULDER_L: [0.62, 0.42],
  CHEST: [0, 0.05],
  CHEST_R: [-0.28, 0.1],
  CHEST_L: [0.28, 0.1],
  STOMACH: [0, -0.45],
  NEUTRAL: [-0.15, -0.15], // relaxed signing space, dominant side
  NEUTRAL_R: [-0.5, -0.1],
  NEUTRAL_L: [0.5, -0.1],
  SIDE: [-0.95, 0.1], // out to the signer's right side
  FS: [-0.8, 0.55], // fingerspelling position, beside the shoulder
  REST_R: [-0.55, -0.75],
  REST_L: [0.55, -0.75],
};

const HEAD_C = [0, 1.12];
const HEAD_R = 0.42;
const UPPER_ARM = 0.55;
const FOREARM = 0.52;
export const ARM_REACH = UPPER_ARM + FOREARM;

/** Hand render scale: hand-model units → body units. */
export const HAND_SCALE = 0.3;

/* ---------------- avatar cast ---------------- */
export const AVATARS = {
  wei: {
    label: "Wei",
    skin: "#e8b482", skinDark: "#c08a52", skinLight: "#f6caa0",
    hair: "#1d1a17", hairStyle: "short",
    shirt: "#3b4a6b", shirtDark: "#2e3a55",
  },
  priya: {
    label: "Priya",
    skin: "#bf7e4e", skinDark: "#965a30", skinLight: "#d89c6e",
    hair: "#241b14", hairStyle: "long",
    shirt: "#6b3b5e", shirtDark: "#54304b",
    earrings: true,
  },
  aisyah: {
    label: "Aisyah",
    skin: "#d9a06b", skinDark: "#b07b45", skinLight: "#edc08e",
    hair: "#3f7d72", hairStyle: "hijab", // hijab colour
    shirt: "#2f5d54", shirtDark: "#264a44",
  },
  marcus: {
    label: "Marcus",
    skin: "#8d5a3b", skinDark: "#6e4226", skinLight: "#a9744e",
    hair: "#15100c", hairStyle: "curly",
    shirt: "#46603a", shirtDark: "#37502c",
    glasses: true,
  },
};
export const DEFAULT_AVATAR = "wei";

/* ---------------- small vector helpers ---------------- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);

/**
 * Two-bone IK: place the elbow between shoulder S and wrist W.
 * `side` is -1 for the signer's right arm (elbow swings out to viewer-left).
 */
export function solveElbow(S, W, side) {
  let d = sub(W, S);
  let dist = len(d);
  const maxR = UPPER_ARM + FOREARM - 0.01;
  if (dist > maxR) {
    d = scale(d, maxR / dist);
    W = add(S, d);
    dist = maxR;
  }
  if (dist < 0.05) {
    d = [0, -0.05];
    W = add(S, d);
    dist = 0.05;
  }
  // Circle-circle intersection
  const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + dist * dist) / (2 * dist);
  const h2 = UPPER_ARM * UPPER_ARM - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const mid = add(S, scale(d, a / dist));
  const perp = [(-d[1] / dist) * h, (d[0] / dist) * h];
  // Pick the elbow that hangs lower / swings outward for a natural arm.
  const e1 = add(mid, perp);
  const e2 = sub(mid, perp);
  const prefer = (e) => e[1] - 0.15 * side * e[0];
  const elbow = prefer(e1) < prefer(e2) ? e1 : e2;
  return { elbow, wrist: W };
}

/**
 * Position 21 hand-model landmarks in body space.
 * hand: "r" | "l" (signer's hand)
 * spec: { shape, at | pos, offset?, orient? (deg, 0 = fingers up),
 *         palm? "out" | "in" }
 */
export function placeHand(hand, spec) {
  const local = handLandmarks(handshape(spec.shape));
  const anchor = spec.pos || ANCHORS[spec.at];
  if (!anchor) throw new Error(`unknown anchor: ${spec.at}`);
  const target = spec.offset ? add(anchor, spec.offset) : anchor;

  // Chirality: the raw hand model reads as a LEFT hand palm-out.
  // Signer's right palm-out (and left palm-in) need an X mirror.
  const palm = spec.palm || "out";
  const mirror = (hand === "r") === (palm === "out") ? -1 : 1;

  const a = ((spec.orient || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);

  const xf = (p) => {
    const x = p[0] * mirror * HAND_SCALE;
    const y = p[1] * HAND_SCALE;
    return [x * c - y * s, x * s + y * c, p[2] * HAND_SCALE];
  };
  // Anchor the KNUCKLE area (middle MCP, landmark 9) on the target point —
  // signs contact with the hand, not the wrist.
  const ref = xf(local[9]);
  const pts = local.map((p) => {
    const q = xf(p);
    return [target[0] + q[0] - ref[0], target[1] + q[1] - ref[1], q[2]];
  });
  return { pts, wrist: [pts[0][0], pts[0][1]] };
}

/* ---------------- face ---------------- */
function facePrimitives(face = {}, T) {
  const prims = [];
  const dx = face.headDx || 0; // headshake offset
  const dy = face.headDy || 0; // nod offset
  const hc = [HEAD_C[0] + dx, HEAD_C[1] + dy];
  const mv = (p) => [p[0] + dx, p[1] + dy];

  // neck
  prims.push({ type: "line", a: mv([0, 0.72]), b: mv([0, 0.45]), w: 0.22, color: T.skinDark });

  // hair behind the head (hijab wraps wider, long hair drapes to shoulders)
  if (T.hairStyle === "hijab") {
    prims.push({ type: "circle", c: hc, r: HEAD_R * 1.18, fill: T.hair });
    prims.push({
      type: "poly",
      pts: [mv([-0.42, 1.05]), mv([0.42, 1.05]), mv([0.3, 0.42]), mv([-0.3, 0.42])],
      fill: T.hair,
    });
  } else if (T.hairStyle === "long") {
    for (const side of [-1, 1]) {
      prims.push({
        type: "line",
        a: mv([side * 0.34, 1.32]),
        b: mv([side * 0.44, 0.5]),
        w: 0.16,
        color: T.hair,
        cap: "round",
      });
    }
  }

  prims.push({ type: "circle", c: hc, r: HEAD_R, fill: T.skin });

  // hair on top (angles in math convention: 0.05π..0.95π = top of head)
  if (T.hairStyle === "curly") {
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI * (0.1 + (0.8 * i) / 6);
      prims.push({
        type: "circle",
        c: [hc[0] + Math.cos(a) * HEAD_R * 0.95, hc[1] + Math.sin(a) * HEAD_R * 0.95],
        r: 0.11,
        fill: T.hair,
      });
    }
  } else {
    prims.push({ type: "arc", c: hc, r: HEAD_R * 1.02, a0: Math.PI * 0.05, a1: Math.PI * 0.95, w: 0.16, color: T.hair });
  }

  if (T.earrings) {
    for (const side of [-1, 1]) {
      prims.push({ type: "circle", c: mv([side * 0.44, 0.98]), r: 0.035, fill: "#e8c547" });
    }
  }

  const brows = face.brows || "neutral";
  const browLift = brows === "up" ? 0.06 : brows === "furrow" ? -0.04 : 0;
  const browTilt = brows === "furrow" ? 0.05 : 0;
  for (const side of [-1, 1]) {
    const bx = hc[0] + side * 0.17;
    const by = hc[1] + 0.17 + browLift;
    prims.push({
      type: "line",
      a: [bx - side * 0.1, by + (brows === "up" ? 0.02 : 0)],
      b: [bx + side * 0.1, by - browTilt],
      w: 0.035,
      color: "#2a2420",
    });
    // eyes
    prims.push({ type: "circle", c: [hc[0] + side * 0.16, hc[1] + 0.07], r: 0.038, fill: "#222" });
    if (T.glasses) {
      prims.push({ type: "arc", c: [hc[0] + side * 0.16, hc[1] + 0.07], r: 0.1, a0: 0, a1: Math.PI * 2, w: 0.022, color: "#1c2733" });
    }
  }
  if (T.glasses) {
    prims.push({ type: "line", a: [hc[0] - 0.06, hc[1] + 0.09], b: [hc[0] + 0.06, hc[1] + 0.09], w: 0.022, color: "#1c2733" });
  }
  // nose
  prims.push({ type: "line", a: [hc[0], hc[1] + 0.02], b: [hc[0] - 0.03, hc[1] - 0.1], w: 0.025, color: T.skinDark });

  const mouth = face.mouth || "neutral";
  const my = hc[1] - 0.22;
  if (mouth === "smile") {
    prims.push({ type: "arc", c: [hc[0], my + 0.05], r: 0.14, a0: Math.PI * 1.15, a1: Math.PI * 1.85, w: 0.03, color: "#7a3b2e" });
  } else if (mouth === "open") {
    prims.push({ type: "circle", c: [hc[0], my], r: 0.055, fill: "#7a3b2e" });
  } else if (mouth === "frown") {
    prims.push({ type: "arc", c: [hc[0], my - 0.12], r: 0.14, a0: Math.PI * 0.18, a1: Math.PI * 0.82, w: 0.03, color: "#7a3b2e" });
  } else if (mouth === "pressed") {
    prims.push({ type: "line", a: [hc[0] - 0.08, my], b: [hc[0] + 0.08, my], w: 0.035, color: "#7a3b2e" });
  } else {
    prims.push({ type: "line", a: [hc[0] - 0.07, my], b: [hc[0] + 0.07, my], w: 0.025, color: "#7a3b2e" });
  }
  return prims;
}

/* ---------------- hand → primitives ---------------- */
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const PALM_OUTLINE = [0, 1, 5, 9, 13, 17];

function handPrimitives(pts, T) {
  const prims = [];
  const palmPts = PALM_OUTLINE.map((i) => [pts[i][0], pts[i][1]]);
  prims.push({ type: "poly", pts: palmPts, fill: T.skin, stroke: T.skin, w: HAND_SCALE * 0.3 });
  const chains = [...FINGER_CHAINS].sort(
    (a, b) => pts[a[a.length - 1]][2] - pts[b[b.length - 1]][2]
  );
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const depth = Math.max(0, Math.min(1, (pts[chain[i + 1]][2] / HAND_SCALE + 0.4) / 1.4));
      prims.push({
        type: "line",
        a: [pts[chain[i]][0], pts[chain[i]][1]],
        b: [pts[chain[i + 1]][0], pts[chain[i + 1]][1]],
        w: HAND_SCALE * (0.155 + 0.04 * depth),
        color: depth > 0.55 ? T.skinLight : depth < 0.3 ? T.skinDark : T.skin,
        cap: "round",
      });
    }
  }
  return prims;
}

/* ---------------- full scene ---------------- */
/**
 * state = { rhPts, lhPts, face } where rhPts/lhPts are 21 already-placed
 * landmark points in body space (see placeHand). The animator tweens the
 * points; this function only composes primitives, back to front.
 */
export function composeScene(state, theme = AVATARS[DEFAULT_AVATAR]) {
  const T = theme;
  const prims = [];

  // torso
  prims.push({
    type: "poly",
    pts: [
      [-0.72, 0.5], [0.72, 0.5], [0.62, -0.9], [-0.62, -0.9],
    ],
    fill: T.shirt,
    stroke: T.shirtDark,
    w: 0.04,
  });
  // shoulders cap
  prims.push({ type: "line", a: [-0.6, 0.46], b: [0.6, 0.46], w: 0.3, color: T.shirt });

  prims.push(...facePrimitives(state.face, T));

  // arms + hands: non-dominant first, dominant (signer's right) on top
  for (const hand of ["l", "r"]) {
    const pts = hand === "r" ? state.rhPts : state.lhPts;
    if (!pts) continue;
    const S = hand === "r" ? ANCHORS.SHOULDER_R : ANCHORS.SHOULDER_L;
    const { elbow, wrist } = solveElbow(
      S,
      [pts[0][0], pts[0][1]],
      hand === "r" ? -1 : 1
    );
    prims.push({ type: "line", a: S, b: elbow, w: 0.2, color: T.shirt, cap: "round" });
    prims.push({ type: "line", a: elbow, b: wrist, w: 0.17, color: T.shirtDark, cap: "round" });
    prims.push(...handPrimitives(pts, T));
  }
  return prims;
}
