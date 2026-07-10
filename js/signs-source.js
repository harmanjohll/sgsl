/* ============================================================
   SgSL — Unified Sign Source
   ============================================================
   One provider that every consumer (library viewer, sentence engine,
   recorder) reads/writes through, so the rest of the app never knows
   whether a sign came from the committed static library, the user's
   own IndexedDB recordings, or (dev only) a live API.

   Resolution order for reads:
     1. IndexedDB (the user's local recordings) — these WIN, so a fresh
        re-recording of "hello" shadows the committed one.
     2. Static committed files under sgsl-app/signs/.

   Modes:
     - default (static): GitHub Pages / any static host. No server.
     - ?api=1          : hit a dev FastAPI on the same origin (legacy
                         backend), for anyone who still runs it.
   ============================================================ */

import * as store from './store.js';
import { applyEdits, getEditsFor } from './sign-edits.js';

const params = new URLSearchParams(
  typeof location !== 'undefined' ? location.search : ''
);
const USE_API = params.get('api') === '1';
const SIGNS_DIR = 'signs';

export function isApiMode() { return USE_API; }

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// Hidden built-in signs (client-side tombstones): static library files can't be
// deleted, so a hidden-label list makes them vanish from the Library/Sign-It.
// Recording (or importing) a sign with the same label un-hides it.
const HIDDEN_KEY = 'sgsl.hidden-signs.v1';
const hiddenSet = () => {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
  catch { return new Set(); }
};
export function hideSign(label) {
  const h = hiddenSet(); h.add(label);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h])); } catch { /* private mode */ }
}
export function unhideSign(label) {
  const h = hiddenSet();
  if (h.delete(label)) { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...h])); } catch { /* */ } }
}

/** Merged manifest: [{ label, frames, source }] sorted by label. */
export async function getManifest() {
  if (USE_API) {
    const list = await fetchJSON('/api/signs');
    return list.map(s => ({ ...s, source: 'api' }));
  }
  let lib = [];
  try { lib = await fetchJSON(`${SIGNS_DIR}/_manifest.json`); } catch (_) { lib = []; }
  let local = [];
  try { local = await store.listSigns(); } catch (_) { local = []; }

  const hidden = hiddenSet();
  const map = new Map();
  for (const s of lib) {
    if (hidden.has(s.label)) continue;   // tombstoned built-in
    map.set(s.label, { label: s.label, frames: s.frames, source: 'library' });
  }
  for (const s of local) {
    map.set(s.label, { label: s.label, frames: (s.landmarks || []).length, source: 'local' });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Full sign record { label, landmarks, ... }. Local recordings win. */
export async function getSign(label) {
  const edits = getEditsFor(label);   // per-sign trim/speed overlay (raw storage untouched)
  if (USE_API) return applyEdits(await fetchJSON(`/api/sign/${label}`), edits);
  let local = null;
  try { local = await store.getSign(label); } catch (_) { local = null; }
  if (local) return applyEdits(local, edits);
  return applyEdits(await fetchJSON(`${SIGNS_DIR}/${label}.json`), edits);
}

/** Persist a recorded sign. Static mode -> IndexedDB; api mode -> POST. */
export async function saveSign(rec) {
  if (rec?.label) unhideSign(rec.label);   // re-recording a hidden label brings it back
  if (USE_API) {
    const r = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ detail: 'Save failed' }));
      throw new Error(e.detail || 'Save failed');
    }
    return r.json();
  }
  return store.putSign(rec);
}

/**
 * Delete a sign. In static mode only LOCAL recordings can be removed —
 * committed library signs are files in the repo (remove them with a PR).
 * Returns { ok, reason }.
 */
export async function deleteSign(label) {
  if (USE_API) {
    const r = await fetch(`/api/sign/${label}`, { method: 'DELETE' });
    return { ok: r.ok };
  }
  const local = await store.getSign(label).catch(() => null);
  if (!local) return { ok: false, reason: 'library' };
  await store.deleteSign(label);
  return { ok: true };
}
