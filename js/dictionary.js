/**
 * Small built-in SgSL vocabulary.
 *
 * SgSL draws on Shanghainese Sign Language, ASL, Signing Exact English and
 * locally developed signs, and many everyday signs are shared with ASL/SEE.
 * The descriptions below follow that common usage. They are intended as a
 * starting point — always verify against SADeaf materials or the NTU SgSL
 * Sign Bank, since SgSL has local variants.
 *
 * Every entry can also be fingerspelled by the avatar; `description`
 * explains the full (non-fingerspelled) sign.
 */

export const DICTIONARY = [
  { word: "hello", description: "Flat hand at the temple, palm out, moves outward like a relaxed salute." },
  { word: "goodbye", description: "Open hand raised, fingers wave down toward the palm repeatedly." },
  { word: "thank you", description: "Fingertips of a flat hand touch the chin, then the hand moves forward toward the person being thanked." },
  { word: "please", description: "Flat hand on the chest moves in a small circle." },
  { word: "sorry", description: "Fist (A handshape) on the chest moves in a circle." },
  { word: "yes", description: "Fist (S handshape) nods up and down at the wrist, like a head nodding." },
  { word: "no", description: "Index and middle fingers snap shut onto the thumb, like a mouth closing." },
  { word: "help", description: "One fist rests on the opposite flat palm; both rise together." },
  { word: "stop", description: "Edge of a flat hand chops down onto the opposite open palm." },
  { word: "good", description: "Flat hand at the chin moves down to land palm-up on the other hand." },
  { word: "bad", description: "Flat hand at the chin flips over and moves down, palm turning away." },
  { word: "eat", description: "Flattened O handshape taps the lips, as if bringing food to the mouth." },
  { word: "drink", description: "C handshape tips toward the mouth, like raising a cup." },
  { word: "water", description: "W handshape taps the chin twice." },
  { word: "toilet", description: "T handshape shakes gently side to side. In SgSL the modified T is used." },
  { word: "more", description: "Fingertips of both flattened O hands tap together repeatedly." },
  { word: "finish", description: "Both open hands, palms in, flip outward to palms out." },
  { word: "name", description: "Both hands in U/H handshape; one taps across the other twice, forming an X." },
  { word: "what", description: "Both open hands, palms up, shake slightly side to side with a questioning face." },
  { word: "where", description: "Index finger up, shakes side to side with a questioning face." },
  { word: "who", description: "Index finger circles in front of the lips (or thumb at chin, index bent) with a questioning face." },
  { word: "why", description: "Fingers touch the forehead then pull away into a Y handshape, questioning face." },
  { word: "how", description: "Bent hands back-to-back roll forward and open, palms up." },
  { word: "when", description: "One index finger circles the other upright index finger, then lands on its tip." },
  { word: "i", description: "Index finger points to your own chest. (Often signed as 'me'.)" },
  { word: "me", description: "Index finger points to your own chest." },
  { word: "you", description: "Index finger points to the person you are addressing." },
  { word: "we", description: "Index finger touches one side of the chest, arcs across to the other side." },
  { word: "love", description: "Both fists cross over the heart, hugging the chest." },
  { word: "i love you", description: "One hand: thumb, index and pinky extended together (combines I, L and Y)." },
  { word: "family", description: "Both F handshapes start together, circle outward and meet again, palms in." },
  { word: "friend", description: "Index fingers hook together one way, then swap and hook the other way." },
  { word: "home", description: "Flattened O fingertips touch the cheek, then move back toward the ear." },
  { word: "school", description: "Flat hands clap together twice, one on top of the other." },
  { word: "work", description: "One fist (S) taps the back of the other fist twice at the wrist." },
  { word: "learn", description: "Open hand 'lifts' information off the opposite palm up to the forehead." },
  { word: "sign", description: "Both index fingers point at each other and circle alternately." },
  { word: "deaf", description: "Index finger touches the ear, then the chin (or both corners of the mouth)." },
  { word: "hearing", description: "Index finger circles forward in front of the mouth." },
  { word: "sing", description: "One hand waves back and forth over the opposite forearm, like a conductor." },
  { word: "morning", description: "One arm lies flat; the other flat hand rises from behind it like the sun coming up." },
  { word: "night", description: "Bent hand drops over the back of the other flat hand, like the sun setting." },
  { word: "today", description: "Both Y (or flat) hands, palms up, drop down twice in front of the body." },
  { word: "tomorrow", description: "A (thumb-up) handshape at the cheek arcs forward." },
  { word: "yesterday", description: "A (thumb-up) handshape at the cheek arcs backward toward the ear." },
  { word: "singapore", description: "Commonly fingerspelled S-G or signed with a local sign — check the SgSL Sign Bank for the current community sign." },
];

const byWord = new Map(DICTIONARY.map((e) => [e.word, e]));

export function lookupWord(word) {
  return byWord.get(word.trim().toLowerCase()) || null;
}

/** Prefix search used to suggest words while the user fingerspells. */
export function suggest(prefix, limit = 6) {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const starts = [];
  const contains = [];
  for (const e of DICTIONARY) {
    const compact = e.word.replace(/\s/g, "");
    if (e.word.startsWith(p) || compact.startsWith(p)) starts.push(e);
    else if (compact.includes(p)) contains.push(e);
  }
  return [...starts, ...contains].slice(0, limit);
}
