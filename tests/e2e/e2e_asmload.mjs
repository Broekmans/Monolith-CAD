// Assembly loading: parallel rebuild of parts + mesh cache embedded in saved .lithprt files
import { launch } from './common.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithload-'));
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const part = (name, w, r) => ({ kind: 'part', version: 1, name, units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', -w, -30), pt('p2', w, -30), pt('p3', w, 30), pt('p4', -w, 30),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' },
    pt('pc', 0, 0), { id: 'c', type: 'circle', c: 'pc', r }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }] });
const files = [];
for (let i = 0; i < 6; i++) { const p = path.join(dir, `P${i}.lithprt`); fs.writeFileSync(p, JSON.stringify(part(`P${i}`, 40 + i * 5, 5 + i))); files.push(p); }
const T = await launch('assembly');
const { win, W, idle } = T;
for (const f of files) { await win.evaluate((p) => lithApp.doc.insertComponent(p), f); await idle(); }
const A = path.join(dir, 'A.lithasm');
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.doc)); }, A);
const openTimed = async () => {
  const t = await win.evaluate(async (p) => { const t0 = performance.now(); await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 20); }); return Math.round(performance.now() - t0); }, A);
  const ok = await win.evaluate(() => lithApp.doc.doc.components.map((c) => c._part && !c._part.err ? c._part.mesh.faces.length : 'ERR').join(','));
  return [t, ok];
};
// 1) no cache: parts rebuilt (in parallel)
await win.evaluate(() => lithApp.clearPartCacheForTest());
console.log('load (rebuild)', JSON.stringify(await openTimed()));
// 2) open each part and save it -> file gets the mesh cache
for (const f of files) { await win.evaluate(async (p) => { await lithApp.open(p); }, f); await W(300); await idle(); await win.evaluate(() => lithApp.cur().save()); await W(200); }
console.log('cached in files', files.map((f) => !!JSON.parse(fs.readFileSync(f, 'utf8')).cache?.mesh).join(','), 'size', fs.statSync(files[0]).size);
// close everything, clear in-memory part cache by reopening fresh from disk
await win.evaluate(async () => { for (const t of [...lithApp.tabs]) { t.dirty = false; await lithApp.closeTab(t); } });
await W(300);
await win.evaluate(() => lithApp.clearPartCacheForTest());
console.log('load (cached)', JSON.stringify(await openTimed()));
// 3) a changed part (cache key mismatch) is rebuilt, not shown stale
const d = JSON.parse(fs.readFileSync(files[0], 'utf8')); d.features[1].depth = 35; fs.writeFileSync(files[0], JSON.stringify(d));
await win.evaluate(async () => { for (const t of [...lithApp.tabs]) { t.dirty = false; await lithApp.closeTab(t); } lithApp.clearPartCacheForTest(); });
await W(300);
await openTimed();
console.log('stale check bbox y', await win.evaluate(() => lithApp.doc.doc.components[0]._part.mesh.bbox.max[1]));
console.log('errors', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
