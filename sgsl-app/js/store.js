/* ============================================================
   SgSL — IndexedDB Sign Store
   ============================================================
   Client-side persistence for recorded signs. No dependencies.

   Each record is the same object shape that gets committed to
   sgsl-app/signs/<label>.json and that the (future) Postgres
   `signs` table stores:
       { label, schema_version, landmarks, calibration, quality,
         createdAt, source }
   keyed by `label`. A locally recorded sign with the same label as a
   committed library sign shadows it (see signs-source.js).
   ============================================================ */

const DB_NAME = 'sgsl';
const STORE = 'signs';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'label' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const os = tx.objectStore(STORE);
    const req = fn(os);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function putSign(rec) {
  if (!rec || !rec.label) return Promise.reject(new Error('record needs a label'));
  return run('readwrite', os => os.put(rec)).then(() => rec);
}

export function getSign(label) {
  return run('readonly', os => os.get(label)).then(r => r || null);
}

export function listSigns() {
  return run('readonly', os => os.getAll()).then(r => r || []);
}

export function deleteSign(label) {
  return run('readwrite', os => os.delete(label)).then(() => true);
}
