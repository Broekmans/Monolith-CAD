// 0.1.116: assembly tree — mates also under each component ("Mates in <assembly>"); a component picked in the view
// (or tree) expands in the tree and scrolls into view; auto-expanded ones close when another is picked; user-expanded
// ones stay; Options asmTreeExpandSel off → nothing expands. Plate + Pin + Pin2: 2 mates Plate–Pin, 1 mate Plate–Pin2.
// (setup copied from e2e_asm)
import { launch } from './common.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithasm-'));
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const box = { kind: 'part', version: 1, name: 'Plate', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', -50, -30), pt('p2', 50, -30), pt('p3', 50, 30), pt('p4', -50, 30),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' },
    pt('pc', 20, 0), { id: 'c', type: 'circle', c: 'pc', r: 10 }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }] };
const pin = { kind: 'part', version: 1, name: 'Pin', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('pc', 0, 0), { id: 'c', type: 'circle', c: 'pc', r: 10 }, pt('q', 0, 0), { id: 'c2', type: 'circle', c: 'q', r: 16 }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] };
// pin: ring area between r10 and r16 would be a tube; keep a solid pin instead
pin.features[0].geo = pin.features[0].geo.slice(0, 2);
const P1 = path.join(dir, 'Plate.lithprt'), P2 = path.join(dir, 'Pin.lithprt');
fs.writeFileSync(P1, JSON.stringify(box)); fs.writeFileSync(P2, JSON.stringify(pin));
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const T = await launch('assembly');
const { win, W, idle } = T;
for (const p of [P1, P2, P2]) { await win.evaluate((p) => lithApp.doc.insertComponent(p), p); await idle(); }
const item = (ci, pred) => win.evaluate(([ci, pred]) => { const d = lithApp.doc; const c = d.doc.components[ci]; const v = d.views.get(c.id); const f = v.part.mesh.faces.find(new Function('f', 'return ' + pred));
  return { comp: c.id, kind: 'face', id: f.id, c: f.c, point: f.c, key: `${c.id}:face:${f.id}`, label: 'x' }; }, [ci, pred]);
const offer = async (it) => { await win.evaluate((it) => { const d = lithApp.doc; const v = d.views.get(it.comp); it.geo = (function () { const f = v.part.mesh.faces.find((x) => x.id === it.id); return f.type === 'plane' ? { t: 'plane', p: f.c, n: f.plane.normal } : { t: 'axis', p: f.axis.p, d: f.axis.d, r: f.r }; })(); lithApp.pm.current.offer(it); }, it); await W(200); };
const mate = async (a, pa, b, pb) => { await T.btn('Mate'); await W(300); await offer(await item(a, pa)); await offer(await item(b, pb)); await T.ok(); await W(300); await win.keyboard.press('Escape'); await W(300); };
await mate(0, "f.type==='cylinder'", 1, "f.type==='cylinder'");
await mate(0, "f.type==='plane' && f.plane.normal[1] > 0.9", 1, "f.type==='plane' && f.plane.normal[1] < -0.9");
await mate(0, "f.type==='plane' && f.plane.normal[1] < -0.9", 2, "f.type==='plane' && f.plane.normal[1] > 0.9");
const info = () => win.evaluate(() => {
  const rows = [...document.querySelectorAll('.tree .tr-row')];
  const out = { comps: {}, all: rows.map((r) => r.textContent.trim()) };
  let cur = null;
  for (const r of rows) {
    const it = r.dataset.item || '', f = r.dataset.folder || '';
    if (it.startsWith('comp:')) { cur = it.slice(5); out.comps[cur] = { open: !!r.querySelector('.twisty.open'), twisty: !!r.querySelector('.twisty svg'), mates: [], folder: null }; continue; }
    if (f.startsWith('compMates:')) { out.comps[cur].folder = r.textContent.trim(); continue; }
    if (f === 'mates') cur = null;
    if (cur && it.startsWith('mate:')) out.comps[cur].mates.push(it.slice(5));
  }
  return out;
});
const ids = await win.evaluate(() => lithApp.doc.doc.components.map((c) => c.id));
const mates = await win.evaluate(() => lithApp.doc.doc.mates.map((m) => [m.id, m.a.comp, m.b.comp]));
check('3 mates made', mates.length === 3, JSON.stringify(mates));
let t = await info();
check('components start closed, all with a twisty', ids.every((id) => t.comps[id] && !t.comps[id].open && t.comps[id].twisty), JSON.stringify(t.comps));
// pick Pin (comp 1) in the view
const pickComp = (ci) => win.evaluate((ci) => { const d = lithApp.doc; const c = d.doc.components[ci]; const v = d.views.get(c.id); const f = v.part.mesh.faces[0]; d.clickItem({ comp: c.id, kind: 'face', id: f.id, key: `${c.id}:face:${f.id}`, label: c.name, point: f.c }, false); }, ci);
await pickComp(1); await W(300); t = await info();
const want = (ci) => mates.filter((m) => m[1] === ids[ci] || m[2] === ids[ci]).map((m) => m[0]).sort().join();
check('pick Pin → Pin expands with its 2 mates', t.comps[ids[1]].open && t.comps[ids[1]].mates.sort().join() === want(1) && want(1).split(',').length === 2, JSON.stringify(t.comps[ids[1]]));
check('folder is "Mates in <assembly>"', /^Mates in .+\(2\)$/.test(t.comps[ids[1]].folder || ''), t.comps[ids[1]].folder);
check('others stay closed', !t.comps[ids[0]].open && !t.comps[ids[2]].open);
await T.shot('asmtree1_pin');
await pickComp(2); await W(300); t = await info();
check('pick Pin2 → Pin2 open (1 mate), Pin closes again', t.comps[ids[2]].open && t.comps[ids[2]].mates.join() === want(2) && !t.comps[ids[1]].open, JSON.stringify([t.comps[ids[1]].open, t.comps[ids[2]]]));
// user-opened Plate stays when picking another
await win.locator(`.tree .tr-row[data-item="comp:${ids[0]}"] .twisty`).click(); await W(200);
await pickComp(1); await W(300); t = await info();
check('user-opened Plate stays open; Pin open; Pin2 closed', t.comps[ids[0]].open && t.comps[ids[0]].mates.length === 3 && t.comps[ids[1]].open && !t.comps[ids[2]].open, JSON.stringify(Object.values(t.comps).map((c) => [c.open, c.mates.length])));
// clicking a mate under a component selects it (both parts highlighted), keeps the tree open
const mId = t.comps[ids[1]].mates[0];
await win.locator(`.tree .tr-row[data-item="mate:${mId}"]`).first().click(); await W(300); t = await info();
const sel = await win.evaluate(() => lithApp.doc.sel.map((s) => s.key));
check('mate row under component selects the mate; Pin stays open', sel.join() === 'mate:' + mId && t.comps[ids[1]].open, sel.join());
// right-click → Edit Mate
await win.locator(`.tree .tr-row[data-item="mate:${mId}"]`).first().click({ button: 'right' }); await W(200);
await win.locator('.ctx-item:has-text("Edit Mate")').first().click(); await W(500);
const pmOpen = await win.evaluate(() => !!lithApp.pm.current);
check('right-click › Edit Mate opens the mate', pmOpen);
await win.evaluate(() => lithApp.pm.cancel()); await W(300);
await T.shot('asmtree2_plate_user_open');
// option off: nothing auto-expands
await win.locator(`.tree .tr-row[data-item="comp:${ids[0]}"] .twisty`).click(); await W(200); // close Plate
await win.evaluate(() => lithApp.applyOptions({ asmTreeExpandSel: false })); await W(200);
await pickComp(2); await W(300); t = await info();
check('Options off: picking Pin2 does not expand it', !t.comps[ids[2]].open, JSON.stringify(t.comps[ids[2]]));
await win.evaluate(() => lithApp.applyOptions({ asmTreeExpandSel: true }));
check('main Mates folder still lists all 3', t.all.filter((s) => /^(Coincident|Concentric|Distance|Parallel)/.test(s)).length >= 3, t.all.join(' | '));
console.log('ERRORS:', errs.length ? errs.join(', ') : 'none');
await T.app.close(); process.exit(errs.length ? 1 : 0);
