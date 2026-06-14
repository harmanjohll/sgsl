/* ============================================================
   SgSL — Sentence Engine (Text -> Sign)
   ============================================================
   text -> gloss.parseSentence() -> resolveLabels() -> chained playback

   HARD CONSTRAINT: the vocabulary is the recorded library only. A typed
   word can only be signed if a matching label exists in the library
   (committed signs/ or the user's IndexedDB recordings). Unknown tokens
   are surfaced (grey chips) and skipped gracefully — never faked.

   The chained sequence concatenates each sign's frames with re-based
   timestamps, inserts a short min-jerk transition bridge between signs
   (so Mei doesn't snap pose-to-pose) and a brief hold between them (so
   distinct signs read as distinct to a deaf reader). Playback runs
   through the same Playback engine as the Library tab.
   ============================================================ */

import { parseSentence } from './gloss.js';
import * as signsSource from './signs-source.js';
import { lerpFrame } from './interp.js';

const BRIDGE_MS = 200;       // transition blend duration between signs
const BRIDGE_STEPS = 5;      // bridge frames synthesised
const PAUSE_MS = 140;        // hold after each sign

// Gloss token -> library label fallbacks (deictic/pronoun simplifications
// that the gloss parser emits but that the library stores under one sign).
const SYNONYMS = {
  me: 'i', myself: 'i', mine: 'my',
  us: 'we', him: 'he', her: 'she', them: 'they',
  hello: 'hi',
};

function labelKey(token) {
  return String(token).trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Map gloss tokens to available library labels.
 * @returns [{ sign, nmm, label|null, available }]
 */
export function resolveLabels(tokens, manifestLabels) {
  const set = new Set(manifestLabels.map(l => l.toLowerCase()));
  return tokens.map(t => {
    const key = labelKey(t.sign);
    let label = null;
    if (set.has(key)) label = key;
    else if (set.has(t.sign.toLowerCase())) label = t.sign.toLowerCase();
    else {
      const syn = SYNONYMS[t.sign.toLowerCase()];
      if (syn && set.has(syn)) label = syn;
    }
    return { ...t, label, available: !!label };
  });
}

/** Load + normalise one sign's frames to start at t=0. */
async function loadClip(label) {
  const sign = await signsSource.getSign(label).catch(() => null);
  if (!sign) return null;
  let frames = (sign.landmarks || []).filter(f => f && (f.pose || f.leftHand || f.rightHand));
  if (!frames.length) return null;
  const hasT = frames.every(f => typeof f.t === 'number');
  if (!hasT) frames = frames.map((f, i) => ({ ...f, t: i * (1000 / 30) }));
  const t0 = frames[0].t;
  return frames.map(f => ({ ...f, t: f.t - t0 }));
}

/**
 * Build one concatenated frame sequence from an ordered list of labels.
 * Bridges + pauses are inserted between clips.
 */
export async function buildSentenceSequence(labels) {
  const clips = [];
  for (const label of labels) {
    const clip = await loadClip(label);
    if (clip) clips.push(clip);
  }
  if (!clips.length) return [];

  const out = [];
  let offset = 0;
  for (let c = 0; c < clips.length; c++) {
    const frames = clips[c];

    if (c > 0 && out.length) {
      // Min-jerk bridge from the last emitted pose into this clip.
      const prev = out[out.length - 1];
      const next = frames[0];
      for (let s = 1; s <= BRIDGE_STEPS; s++) {
        const u = s / BRIDGE_STEPS;
        const bridged = lerpFrame(prev, next, u);
        bridged.t = offset + BRIDGE_MS * u;
        out.push(bridged);
      }
      offset += BRIDGE_MS;
    }

    for (const f of frames) out.push({ ...f, t: offset + f.t });
    offset += frames[frames.length - 1].t + PAUSE_MS;
  }
  return out;
}

/**
 * Full text -> sign pipeline. Plays the sentence on the given Playback
 * instance and returns the resolved tokens (for coverage UI).
 */
export async function signText(text, playback) {
  const tokens = parseSentence(text);
  const manifest = await signsSource.getManifest();
  const labels = manifest.map(s => s.label);
  const resolved = resolveLabels(tokens, labels);

  const playable = resolved.filter(r => r.available).map(r => r.label);
  const seq = await buildSentenceSequence(playable);
  if (seq.length && playback) playback.playFrames(seq);
  return resolved;
}
