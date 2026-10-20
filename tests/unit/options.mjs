// Settings registry (renderer/src/app/options): unique keys, valid rows, and every opt('key') / optHex('key') used in
// the code exists. node tests/unit/options.mjs
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS_DEF, OPTIONS_SHOWN, opt, clean } from '../../renderer/src/app/options/index.js';

let fail = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); fail++; } };

const keys = OPTIONS_DEF.map((d) => d.key);
const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
ok(!dup.length, 'duplicate keys: ' + dup.join(', '));
for (const d of OPTIONS_DEF) {
  if (d.type === 'button' || d.type === 'info') continue;
  ok('def' in d, `${d.key}: no def`);
  ok(d.label, `${d.key}: no label`);
  if (d.hidden) continue;
  ok(d.cat, `${d.key}: shown row without cat`);
  if (d.type === 'color') ok(/^#[0-9a-f]{6}$/i.test(d.def), `${d.key}: colour def ${d.def}`);
  if (d.type === 'num' || d.type === 'pct') ok(typeof d.def === 'number' && d.def >= (d.min ?? -Infinity) && d.def <= (d.max ?? Infinity), `${d.key}: def ${d.def} outside ${d.min}..${d.max}`);
}
// hidden values can never be stored / overridden
const h = OPTIONS_DEF.find((d) => d.hidden);
if (h) ok(!(h.key in clean({ [h.key]: 123 })), 'hidden value accepted by clean()');

// every key read in the code exists
const used = new Map();
const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (f.name !== 'dist' && f.name !== 'options') walk(p); } else if (/\.(m?js)$/.test(f.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bopt(?:Hex)?\(\s*'([A-Za-z0-9_]+)'/g)) used.set(m[1], p); } };
walk('renderer/src');
for (const [k, p] of used) ok(keys.includes(k), `opt('${k}') in ${p} has no row`);
for (const [k] of used) ok(opt(k) !== undefined, `opt('${k}') is undefined`);

console.log(`${OPTIONS_DEF.length} rows (${OPTIONS_SHOWN.length} shown, ${OPTIONS_DEF.length - OPTIONS_SHOWN.length} internal), ${used.size} keys read in the code`);
console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
