// File format upgrades (shared/format.mjs): node tests/unit/format.mjs [file.lith*…]
// Extra arguments: real documents that must open unchanged at the current format.
import fs from 'node:fs';
import { FORMAT, upgradeDoc, _steps } from '../../shared/format.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// 1. every kind has a version and new documents are current
for (const k of ['part', 'assembly', 'plan', 'drawing', 'cloud']) ok(FORMAT[k] >= 1, `${k} has format ${FORMAT[k]}`);
const cur = upgradeDoc({ kind: 'part', version: FORMAT.part, features: [] });
ok(!cur.upgraded && !cur.newer && cur.doc.version === FORMAT.part, 'current part stays as it is');

// 2. a file without a version counts as version 1
const nov = upgradeDoc({ kind: 'plan', entities: [] });
ok(nov.from === 1 && nov.doc.version === FORMAT.plan, 'no version → 1 → current');

// 3. a file from a newer program is left alone and flagged
const nw = upgradeDoc({ kind: 'drawing', version: FORMAT.drawing + 3, x: 1 });
ok(nw.newer && nw.doc.version === FORMAT.drawing + 3 && nw.doc.x === 1, 'newer file flagged, untouched');

// 4. steps run in order (temporary fake format 1 → 3 for 'cloud')
const save = FORMAT.cloud;
FORMAT.cloud = 3;
_steps.cloud[1] = (d) => { d.clouds = d.scans; delete d.scans; };
_steps.cloud[2] = (d) => { d.clouds.forEach((c) => { c.path = c.file; delete c.file; }); };
const old = upgradeDoc({ kind: 'cloud', version: 1, scans: [{ file: 'a.laz' }] });
ok(old.upgraded && old.from === 1 && old.to === 3 && old.doc.version === 3 && old.doc.clouds[0].path === 'a.laz' && !old.doc.scans, 'steps 1→2→3 applied in order');
let threw = false;
FORMAT.cloud = 4;
try { upgradeDoc({ kind: 'cloud', version: 1, scans: [] }); } catch { threw = true; }
ok(threw, 'missing step is an error, not a silent half upgrade');
delete _steps.cloud[1]; delete _steps.cloud[2]; FORMAT.cloud = save;

// 5. real files
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const before = JSON.stringify(d);
  const r = upgradeDoc(d);
  ok(!r.newer && JSON.stringify(r.doc) === before, `${f.split('/').pop()}: ${r.kind} format ${r.from}, opens unchanged`);
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
