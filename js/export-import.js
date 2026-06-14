/* ============================================================
   SgSL — Sign Export / Import
   ============================================================
   One-click JSON export of a recorded sign (download) and file import.
   The exported file is byte-for-byte the shape committed under
   sgsl-app/signs/<label>.json, so the contribution workflow is:
       record -> Export -> drop the file into sgsl-app/signs/ -> PR.
   ============================================================ */

function safeLabel(label) {
  return String(label || 'sign').replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
}

/** Trigger a browser download of one sign record as <label>.json. */
export function exportSign(rec) {
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeLabel(rec.label)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse + validate an imported sign file. Returns the record. */
export async function importFile(file) {
  const text = await file.text();
  let rec;
  try { rec = JSON.parse(text); }
  catch (e) { throw new Error('Not valid JSON'); }
  if (!rec.label || !Array.isArray(rec.landmarks)) {
    throw new Error('Invalid sign file (need { label, landmarks: [...] })');
  }
  return rec;
}
