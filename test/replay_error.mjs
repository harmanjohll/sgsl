/* ============================================================
   SgSL — Replay Fidelity Guard (CI)
   ============================================================
   Runs the reconstruction-error metric over every committed sign and
   fails if any real (schema v2) recording exceeds the threshold — so
   tuning the retarget for one sign can't silently wreck the fidelity of
   another. Legacy v1 seed fixtures (hands-only, no timestamps) are
   smoke fixtures, not fidelity references, and are reported + skipped.

   Run: node test/replay_error.mjs
   ============================================================ */

import { readdir, readFile } from 'node:fs/promises';
import { reconstructionError } from '../sgsl-app/js/metrics.js';

const SIGNS = new URL('../sgsl-app/signs/', import.meta.url);
const THRESHOLD = 12;   // max % of shoulder-width replay error for v2 signs

function isV2(sign) {
  if (sign.schema_version === 2) return true;
  const f = sign.landmarks || [];
  return f.length >= 5 && f.every(x => x && typeof x.t === 'number');
}

const names = (await readdir(SIGNS)).filter(n => n.endsWith('.json') && n !== '_manifest.json');
let enforced = 0, failed = 0, skipped = 0;

console.log('sign'.padEnd(16), 'grade', 'error%', 'status');
console.log('-'.repeat(44));
for (const name of names.sort()) {
  const sign = JSON.parse(await readFile(new URL(name, SIGNS)));
  if (!isV2(sign)) {
    skipped++;
    console.log(name.replace('.json', '').padEnd(16), '  -  ', '  -   ', 'skip (v1 fixture)');
    continue;
  }
  enforced++;
  const r = reconstructionError(sign);
  const over = r.overall != null && r.overall > THRESHOLD;
  if (over) failed++;
  console.log(
    name.replace('.json', '').padEnd(16),
    `  ${r.grade}  `,
    String(r.overall ?? '–').padStart(5),
    over ? `FAIL (> ${THRESHOLD}%)` : 'ok',
  );
}

console.log('-'.repeat(44));
console.log(`${enforced} enforced, ${skipped} skipped (v1 fixtures), ${failed} over threshold.`);
if (failed) process.exit(1);
