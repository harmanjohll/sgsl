/**
 * Dump composed scenes (drawing primitives) for sign keyframes as JSON,
 * consumed by render_signs.py to produce a visual contact sheet.
 * Usage: node test/dump_signs.mjs [sign ...]
 */
import { composeScene } from "../js/body-model.js";
import { resolveHand } from "../js/body-avatar.js";
import { SIGNS } from "../js/signs.js";

const DEFAULT = [
  "hello", "good", "no", "what", "sunday", "tomorrow",
  "more", "love", "eat", "monday", "help", "you",
];

const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const out = [];
for (const name of names) {
  const sign = SIGNS[name];
  if (!sign) {
    console.error(`unknown sign: ${name}`);
    process.exit(1);
  }
  // First and last keyframes show the sign's start and end posture.
  const picks =
    sign.frames.length === 1
      ? [sign.frames[0]]
      : [sign.frames[0], sign.frames[sign.frames.length - 1]];
  for (let i = 0; i < picks.length; i++) {
    const f = picks[i];
    out.push({
      label: `${name}${picks.length > 1 ? ` ${i + 1}` : ""}`,
      prims: composeScene({
        rhPts: resolveHand("r", f.rh),
        lhPts: resolveHand("l", f.lh),
        face: f.face || {},
      }),
    });
  }
}
// Also one fingerspelling posture for reference.
out.push({
  label: "fs: B",
  prims: composeScene({
    rhPts: resolveHand("r", { shape: "letter:b", at: "FS" }),
    lhPts: resolveHand("l", "rest"),
    face: {},
  }),
});
console.log(JSON.stringify(out));
