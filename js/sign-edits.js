/* ============================================================
   SgSL — per-sign playback edits (trim / re-time), non-destructive
   ============================================================
   Edits live in a localStorage OVERLAY keyed by label — the stored
   recording stays RAW (it's the future ML dataset, and Export ships
   raw). Applied at the signs-source.getSign choke point, so the
   Library player, Sign-It sentences, and previews all honor them.

   Edit shape: { trimStartMs, trimEndMs, speed } (all optional).
   applyEdits is a pure function -> unit-tested in Node.
   ============================================================ */

const KEY = 'sgsl.sign-edits.v1';
const MIN_FRAMES = 5;

function loadAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}

export function getEditsFor(label) {
  const e = loadAll()[label];
  return e && typeof e === 'object' ? e : null;
}

export function saveEditsFor(label, edits) {
  const all = loadAll();
  if (edits && (edits.trimStartMs || edits.trimEndMs || (edits.speed && edits.speed !== 1))) all[label] = edits;
  else delete all[label];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

/** Pure: returns a record whose landmarks are trimmed/re-timed per `edits`.
 *  Refuses edits that would leave fewer than MIN_FRAMES frames. Raw input untouched. */
export function applyEdits(record, edits) {
  if (!record || !edits || !Array.isArray(record.landmarks) || !record.landmarks.length) return record;
  const frames = record.landmarks;
  const t0 = frames[0].t ?? 0;
  const tEnd = frames[frames.length - 1].t ?? 0;
  const start = t0 + Math.max(0, edits.trimStartMs || 0);
  const end = tEnd - Math.max(0, edits.trimEndMs || 0);
  let kept = (start > t0 || end < tEnd) ? frames.filter(f => (f.t ?? 0) >= start && (f.t ?? 0) <= end) : frames;
  if (kept.length < MIN_FRAMES) kept = frames;   // never gut a sign
  const speed = Math.min(2, Math.max(0.5, edits.speed || 1));
  const base = kept[0].t ?? 0;
  const out = (kept !== frames || speed !== 1)
    ? kept.map(f => ({ ...f, t: ((f.t ?? 0) - base) / speed }))
    : kept;
  return out === frames ? record : { ...record, landmarks: out };
}
