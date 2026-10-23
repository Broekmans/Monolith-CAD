// 0.1.127: origin planes in assemblies — the assembly's Front / Top / Right Plane (Origin folder) and every component's
// own part planes (under the component in the tree). Mates through the Mate dialog by clicking tree rows; hover / eye
// show the planes; a shown plane is picked in the view; save + reopen; undo; Delete with a plane selected.
// Plate (fixed, first) + Pin (moved and turned away from the origin first). Setup like e2e_asmtree.
import { launch } from './common.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../../shared/mates.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithplanes-'));
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const box = { kind: 'part', version: 1, name: 'Plate', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', -50, -30), pt('p2', 50, -30), pt('p3', 50, 30), pt('p4', -50, 30),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }] };
const pin = { kind: 'part', version: 1, name: 'Pin', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('pc', 0, 0), { id: 'c', type: 'circle', c: 'pc', r: 10 }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] };
const P1 = path.join(dir, 'Plate.lithprt'), P2 = path.join(dir, 'Pin.lithprt'), A = path.join(dir, 'Planes.lithasm');
fs.writeFileSync(P1, JSON.stringify(box)); fs.writeFileSync(P2, JSON.stringify(pin));
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const T = await launch('assembly');
const { win, W, idle } = T;
for (const p of [P1, P2]) { await win.evaluate((p) => lithApp.doc.insertComponent(p), p); await idle(); }
const ids = await win.evaluate(() => lithApp.doc.doc.components.map((c) => c.id));
const [plate, pinId] = ids;
// move + turn the pin away from the origin (setup)
await win.evaluate((id) => { const d = lithApp.doc, c = d.C(id); c.pos = [80, 30, -40]; c.rot = [0.2, 0.3, 0.1, 0.93]; const l = Math.hypot(...c.rot); c.rot = c.rot.map((v) => v / l); d.syncScene(); d.solve(); }, pinId);
await W(300);
const rowSel = (key) => `.tree .tr-row[data-item="${key}"]`;
const rowsText = () => win.evaluate(() => [...document.querySelectorAll('.tree .tr-row')].map((r) => r.textContent.trim()));
// 1) assembly Origin folder with the three planes
let rows = await rowsText();
const iO = rows.findIndex((t) => t === 'Origin');
check('tree: Origin → Front Plane, Top Plane, Right Plane, Origin Point', iO >= 0 && rows.slice(iO + 1, iO + 5).join('|') === 'Front Plane|Top Plane|Right Plane|Origin Point', rows.slice(iO, iO + 5).join('|'));
check('plane rows carry the assembly plane keys', await win.locator(rowSel('@asm:plane:Top')).count() === 1);
// 2) hover shows the plane, leaving hides it
const planeMeshes = () => win.evaluate(() => { const d = lithApp.doc; const n = (g) => (g ? g.children.filter((o) => o.userData.plane).map((o) => `${o.userData.plane.comp}:${o.userData.plane.id}`) : []); return [...n(d.planeGroup), ...[...d.views.values()].flatMap((v) => n(v.planes))]; });
await win.locator(rowSel('@asm:plane:Top')).hover(); await W(300);
const hov = await planeMeshes();
await win.mouse.move(700, 400); await W(200); await win.locator('.tree').hover({ position: { x: 5, y: 5 } }); await W(300);
check('hover the assembly Top Plane row → the plane is drawn; leave → gone', hov.join() === '@asm:Top' && (await planeMeshes()).length === 0, `${hov} / ${await planeMeshes()}`);
// 3) expand the pin → its own planes
await win.locator(`${rowSel('comp:' + pinId)} .twisty`).click(); await W(300);
check('component expanded: its Front / Top / Right Plane', (await win.locator(rowSel(`${pinId}:plane:Front`)).count()) === 1 && (await win.locator(rowSel(`${pinId}:plane:Right`)).count()) === 1);
await win.locator(rowSel(`${pinId}:plane:Front`)).hover(); await W(300);
check('hover a component plane → drawn with the component', (await planeMeshes()).join() === `${pinId}:Front`, (await planeMeshes()).join());
// 4) Coincident: assembly Right Plane + Pin Right Plane, clicked in the tree with Mate open
const pose = () => win.evaluate((id) => { const c = lithApp.doc.C(id); return { pos: [...c.pos], rot: [...c.rot] }; }, pinId);
const mateBy = async (a, b, type = null, value = null) => {
  await T.btn('Mate'); await W(400);
  await win.locator(rowSel(a)).click(); await W(250);
  await win.locator(rowSel(b)).click(); await W(400);
  const labels = await win.evaluate(() => Object.values(lithApp.pm.current.selboxes).flatMap((s) => s.items.map((i) => i.label)));
  if (type) { await win.locator('.pm-body select').first().selectOption(type); await W(400); }
  if (value != null) { const inp = win.locator('.pm-field:has(label:text-is("Distance / Angle")) input').first(); await inp.fill(String(value)); await inp.press('Tab'); await W(400); }
  await T.ok(); await W(400); await win.keyboard.press('Escape'); await W(300);
  return labels;
};
let labels = await mateBy('@asm:plane:Right', `${pinId}:plane:Right`);
let p = await pose();
const nR = M.qrot(p.rot, [1, 0, 0]);
let mates = await win.evaluate(() => lithApp.doc.doc.mates.map((m) => ({ type: m.type, a: [m.a.comp, m.a.kind, m.a.id], b: [m.b.comp, m.b.kind, m.b.id] })));
check('Mate dialog lists "Right Plane@<assembly>" and "Right Plane@Pin<1>"', labels.length === 2 && /^Right Plane@/.test(labels[0]) && labels[1] === 'Right Plane@Pin<1>', labels.join(' | '));
check('Coincident mate stored with plane refs (assembly = @asm)', mates.length === 1 && mates[0].type === 'coincident' && mates[0].a.join() === '@asm,plane,Right' && mates[0].b.join() === `${pinId},plane,Right`, JSON.stringify(mates));
check('pin moved: its Right Plane lies in the assembly Right Plane (x = 0, normal ∥ X)', Math.abs(p.pos[0]) < 1e-4 && Math.abs(Math.abs(nR[0]) - 1) < 1e-5, `${p.pos.map((v) => v.toFixed(3))} n ${nR.map((v) => v.toFixed(3))}`);
rows = await rowsText();
check('tree mate label: "(Right Plane, Pin<1>)"', rows.some((t) => /^Coincident1 \(Right Plane, Pin<1>\)/.test(t)), rows.filter((t) => /Coincident/.test(t)).join(' | '));
// 5) Distance 35 mm: assembly Front Plane ↔ Pin Front Plane; Top ↔ Top coincident → fully defined
const und0 = await win.evaluate(() => lithApp.doc.undoStack.length);
await mateBy('@asm:plane:Front', `${pinId}:plane:Front`, 'distance', 35);
await mateBy('@asm:plane:Top', `${pinId}:plane:Top`);
p = await pose();
const dof = await win.evaluate((id) => lithApp.doc.dof.get(id), pinId);
const err = await win.evaluate(() => [...(lithApp.doc.mateErr || new Map()).values()]);
check('Distance 35 from the assembly Front Plane + Top coincident: |z| = 35, y = 0, fully defined, no mate errors', Math.abs(Math.abs(p.pos[2]) - 35) < 1e-4 && Math.abs(p.pos[1]) < 1e-4 && dof?.state === 'defined' && !err.length, `${p.pos.map((v) => v.toFixed(3))} ${JSON.stringify(dof)} ${err}`);
await win.evaluate(() => lithApp.doc.undo()); await W(500);
const nU = await win.evaluate(() => lithApp.doc.doc.mates.length);
await win.evaluate(() => lithApp.doc.redo()); await W(500);
check('undo the Top mate → 2 mates, redo → 3', nU === 2 && (await win.evaluate(() => lithApp.doc.doc.mates.length)) === 3 && (await win.evaluate(() => lithApp.doc.undoStack.length)) > und0, `${nU}`);
// 6) eye on a component plane: saved, one undo step, drawn; follows the component
await win.locator(`${rowSel(`${pinId}:plane:Top`)} .tr-eye`).click(); await W(300);
const shown = await win.evaluate((id) => lithApp.doc.C(id).planesShown, pinId);
await win.mouse.move(700, 400); await W(200);
check('eye on Pin Top Plane: planesShown saved on the component, plane drawn', JSON.stringify(shown) === '["Top"]' && (await planeMeshes()).includes(`${pinId}:Top`), `${JSON.stringify(shown)} ${await planeMeshes()}`);
await win.evaluate(() => lithApp.doc.undo()); await W(500);
check('undo → eye off again', !(await win.evaluate((id) => lithApp.doc.C(id).planesShown, pinId)) && !(await planeMeshes()).includes(`${pinId}:Top`));
// 7) a shown assembly plane is picked in the view where no model is
await win.locator(`${rowSel('@asm:plane:Top')} .tr-eye`).click(); await W(400);
const spot = await win.evaluate(() => { const d = lithApp.doc; const S = d.asmPlaneSize(); const r = d.vp.el.getBoundingClientRect(); const s = d.vp.toScreen([-0.9 * S, 0, 0.9 * S]); return { x: r.left + s[0], y: r.top + s[1], S, inside: s[0] > 0 && s[1] > 0 && s[0] < r.width && s[1] < r.height }; });
await win.mouse.move(spot.x, spot.y); await W(200); await win.mouse.click(spot.x, spot.y); await W(400);
const sel = await win.evaluate(() => lithApp.doc.sel.map((s) => s.key));
check('click the shown assembly Top Plane in the view → selected', spot.inside && sel.join() === '@asm:plane:Top', `${JSON.stringify(spot)} sel ${sel}`);
// 8) Delete with a component plane selected does not delete the component
await win.locator(rowSel(`${pinId}:plane:Front`)).click(); await W(300);
await win.mouse.move(700, 400); await win.keyboard.press('Delete'); await W(400);
check('Delete with the Pin Front Plane selected: the component stays', (await win.evaluate(() => lithApp.doc.doc.components.length)) === 2);
// 9) save to /tmp + reopen: format 3, plane mates + eyes kept, solves the same
await win.evaluate(() => lithApp.doc.app.setDirty(false));
const json = await win.evaluate(() => { const d = lithApp.doc; d.beforeSave?.(); return JSON.stringify({ ...d.toJSON(), version: 3 }); });
fs.writeFileSync(A, json);
const before = await pose();
await win.evaluate(async (a) => { await lithApp.open(a); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.length === 2 && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const re = await win.evaluate(() => { const d = lithApp.doc; return { v: d.doc.version, mates: d.doc.mates.map((m) => `${m.a.comp}:${m.a.id}-${m.b.id}`), shown: d.doc.planesShown, err: [...(d.mateErr || new Map()).keys()], pos: [...d.doc.components[1].pos] }; });
check('reopened: format 3, 3 plane mates, assembly Top Plane eye kept, no errors, same place', re.v === 3 && re.mates.length === 3 && re.mates.every((s) => s.startsWith('@asm:')) && JSON.stringify(re.shown) === '["Top"]' && !re.err.length && Math.hypot(...re.pos.map((v, i) => v - before.pos[i])) < 1e-4, JSON.stringify(re));
await T.shot('asmplanes');
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
