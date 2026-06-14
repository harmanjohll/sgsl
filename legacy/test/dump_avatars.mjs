/**
 * Dump each avatar performing HELLO (start frame) and I-LOVE-YOU,
 * for the avatar-chooser contact sheet. Used by render_avatars.py.
 */
import { composeScene, AVATARS } from "../js/body-model.js";
import { resolveHand } from "../js/body-avatar.js";
import { SIGNS } from "../js/signs.js";

const out = [];
for (const [key, theme] of Object.entries(AVATARS)) {
  for (const [signName, frameIdx] of [["hello", 0], ["i love you", 0]]) {
    const f = SIGNS[signName].frames[frameIdx];
    out.push({
      label: `${theme.label}`,
      sub: signName,
      prims: composeScene(
        {
          rhPts: resolveHand("r", f.rh),
          lhPts: resolveHand("l", f.lh),
          face: f.face || {},
        },
        theme
      ),
    });
  }
}
console.log(JSON.stringify(out));
