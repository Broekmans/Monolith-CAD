// Assembly: insert two parts, concentric + coincident mates, drag, DOF status, STEP export op
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
const T = await launch('assembly');
const { win, W, idle } = T;
console.log('kind', await win.evaluate(() => document.body.dataset.kind));
await win.evaluate((p) => lithApp.doc.insertComponent(p), P1); await idle();
await win.evaluate((p) => lithApp.doc.insertComponent(p), P2); await idle();
const state = () => win.evaluate(() => ({ comps: lithApp.doc.doc.components.map((c) => [c.name, c.fixed, c.pos.map((v) => +v.toFixed(3)), [...lithApp.doc.dof.values()].map((d) => d.state).join()]), status: document.querySelector('.st-left').textContent, tree: [...document.querySelectorAll('.tr-row')].map((r) => r.textContent).join(' | ') }));
console.log('inserted', JSON.stringify(await state()));
// mate: offer faces programmatically
const item = (ci, pred) => win.evaluate(([ci, pred]) => { const d = lithApp.doc; const c = d.doc.components[ci]; const v = d.views.get(c.id); const f = v.part.mesh.faces.find(new Function('f', 'return ' + pred));
  return { comp: c.id, kind: 'face', id: f.id, c: f.c, point: f.c, key: `${c.id}:face:${f.id}`, label: 'x' }; }, [ci, pred]);
const offer = async (it) => { await win.evaluate((it) => { const d = lithApp.doc; const v = d.views.get(it.comp); it.geo = (function () { const f = v.part.mesh.faces.find((x) => x.id === it.id); return f.type === 'plane' ? { t: 'plane', p: f.c, n: f.plane.normal } : { t: 'axis', p: f.axis.p, d: f.axis.d, r: f.r }; })(); lithApp.pm.current.offer(it); }, it); await W(200); };
await T.btn('Mate'); await W(300);
await offer(await item(0, "f.type==='cylinder'")); await offer(await item(1, "f.type==='cylinder'"));
console.log('type', await win.evaluate(() => lithApp.pm.current.values.type), 'msg', await win.locator('.pm-msg').textContent());
await T.ok(); await W(300);
await offer(await item(0, "f.type==='plane' && f.plane.normal[1] > 0.9")); await offer(await item(1, "f.type==='plane' && f.plane.normal[1] < -0.9"));
console.log('type2', await win.evaluate(() => lithApp.pm.current.values.type));
await T.ok(); await W(300);
await win.keyboard.press('Escape'); await W(300);
console.log('mated', JSON.stringify(await state()));
await T.shot('asm1');
// drag the pin: should stay concentric (rotates only)
const rot0 = await win.evaluate(() => lithApp.doc.doc.components[1].rot.map((v) => +v.toFixed(3)));
const p = await T.WP([28, 60, 0]);
await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(p[0] + 60, p[1] + 40, { steps: 6 }); await win.mouse.up(); await W(300);
console.log('dragged', JSON.stringify((await state()).comps[1]), 'rot', rot0, await win.evaluate(() => lithApp.doc.doc.components[1].rot.map((v) => +v.toFixed(3))));
// distance mate replacing coincident -> check value
await win.evaluate(() => { const d = lithApp.doc; const m = d.doc.mates[1]; d.cmdMate(m); });
await W(300); await win.evaluate(() => { const pm = lithApp.pm.current; pm.setValue('type', 'distance'); }); 
await win.locator('select').first().dispatchEvent('change'); await W(100);
await T.num(0, 15); await T.ok();
console.log('distance', JSON.stringify((await state()).comps[1]), await win.evaluate(() => lithApp.doc.doc.mates.map((m) => m.name + ':' + m.type).join()));
await win.keyboard.press('Control+z'); await W(400);
console.log('undo', JSON.stringify((await state()).comps[1]));
const json = await win.evaluate(() => JSON.stringify(lithApp.doc.toJSON()));
console.log('saved size', json.length, json.includes('_part') ? 'LEAK' : 'clean');
await T.shot('asm2');
// 0.1.67: four viewports in the assembly; pick a component in the Top pane
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(600);
const four = await win.evaluate(() => { const s = lithApp.doc.viewSet; const p = s.panes[2], r = p.el.getBoundingClientRect(); s.setActive(p); const c = p.toScreen([20, 20, 0]); const hit = lithApp.doc.pickAt({ clientX: r.left + c[0], clientY: r.top + c[1] }); return { n: s.panes.length, dirs: s.panes.map((q) => q.viewDir().toArray().map((v) => Math.round(v * 100) / 100).join()), hit: hit?.kind, comp: hit && lithApp.doc.C(hit.comp)?.name }; });
console.log('four views', JSON.stringify(four));
await T.shot('asm-four');
await T.app.close();
