// Point cloud registration: Align Clouds (point pairs, ICP, level only) and Align Part (pairs + ICP, then
// Cloud to Part uses the placement), undo, save + reopen. Needs ../scratch/rg from
//   python3 tests/e2e/gen_register.py ../scratch/rg
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const D = path.resolve('../scratch/rg'), DIR = '/tmp/rgtest', DOC = DIR + '/Rg.lithpcd';
const TRUE = JSON.parse(fs.readFileSync(D + '/truth.json', 'utf8'));
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const PART = DIR + '/Box.lithprt';
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Box', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 1000, 0), pt('p3', 1000, 600), pt('p4', 0, 600),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 400, end: 'blind', op: 'boss' }] }));
const rot = (R, v) => [0, 1, 2].map((i) => R[i * 3] * v[0] + R[i * 3 + 1] * v[1] + R[i * 3 + 2] * v[2]);
const ap = (T, v) => rot(T.R, v).map((x, i) => x + T.t[i]);
const inv = (T) => { const Rt = [T.R[0], T.R[3], T.R[6], T.R[1], T.R[4], T.R[7], T.R[2], T.R[5], T.R[8]]; return { R: Rt, t: rot(Rt, T.t).map((x) => -x) }; };
const X0 = TRUE.X0;
const CORNERS = [[0, 0, 0], [8, 0, 0], [8, 6, 0], [0, 6, 3], [8, 6, 3], [2, 1, 1.2], [6, 4, 0]].map((p) => p.map((v, i) => v + X0[i]));
// worst corner error (mm) between a transform and the truth
const err = (T, truth) => Math.max(...CORNERS.map((c) => { const p = inv(truth); const f = ap(p, c), a = ap(T, f); return Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) * 1000; }));

const T = await launch('cloud');
const { win, W, idle } = T;
await win.evaluate(() => { lithApp.doc.doc.view.budget = 2e6; });
const settle = async (ms = 600) => { await idle().catch(() => {}); await W(ms); await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length), null, { timeout: 60000 }).catch(() => console.log('settle timeout')); await W(200); };
const waitBusy = async () => { await W(400); await win.waitForFunction(() => !lithApp.doc.busy, null, { timeout: 180000 }); await settle(); };
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; }, DOC);
const add = (f) => win.evaluate((p) => lithApp.doc.addCloud(p), f);
const idOf = (name) => win.evaluate((n) => lithApp.doc.doc.clouds.find((c) => c.name === n).id, name);
const select = (name) => win.evaluate((n) => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.name === n); d.selIds = new Set([r.id]); d.selId = r.id; d.renderTree(); return r.id; }, name);
const setv = (vals) => win.evaluate((vals) => { const pm = lithApp.doc.app.pm.current; for (const [k, v] of Object.entries(vals)) { pm.setValue(k, v); const i = pm.inputs[k]; if (i) i.dispatchEvent(new Event('change')); } }, vals);
const icp = async () => { await win.evaluate(() => { lithApp.doc.regICP(); }); await waitBusy(); return win.evaluate(() => lithApp.doc.app.pm.current.inputs.icp.textContent); };
const xf = (name) => win.evaluate((n) => lithApp.doc.doc.clouds.find((c) => c.name === n).transform, name);
const live = (name) => win.evaluate((n) => lithApp.doc.reg?.mov?.name === n ? lithApp.doc.reg.mov.transform : null, name);
// pairs from known room points: a = point of the moving file (abs), b = true point (abs); noise in metres
const pairsFor = (truth, pts, noise) => pts.map((p, k) => { const b = p.map((v, i) => v + X0[i]); const a = ap(inv(truth), b).map((v, i) => v + (noise ? noise * Math.sin(k * 7 + i * 3) : 0)); return [a, b]; });

await add(D + '/room.las'); await add(D + '/room_moved.las'); await settle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomFit(); }); await settle();
await T.shot('rg1_before');
// ---- 1. pairs (exact picks) ----
await select('room_moved.las');
await win.evaluate(() => lithApp.doc.cmdRegister('cloud'));
console.log('session:', await win.evaluate(() => `${lithApp.doc.reg.mov.name} -> ${lithApp.doc.reg.ref.name}`));
const P4 = [[0, 0, 0], [8, 0, 3], [8, 6, 0], [0, 6, 3]];
for (const [a, b] of pairsFor(TRUE.moved, P4, 0)) await win.evaluate(([a, b]) => lithApp.doc.regAddPair(a, b), [a, b]);
console.log('pairs exact: panel =', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.pairs.textContent.replace(/\s+/g, ' ')));
console.log('pairs exact: corner error mm (expect ~0) =', err(await live('room_moved.las'), TRUE.moved).toFixed(4));
await settle(); await T.shot('rg2_pairs');
// ---- 2. noisy pairs (≈3 cm) then ICP ----
await win.evaluate(() => { const d = lithApp.doc; d.reg.pairs = []; d.regSolve(); });
for (const [a, b] of pairsFor(TRUE.moved, P4, 0.03)) await win.evaluate(([a, b]) => lithApp.doc.regAddPair(a, b), [a, b]);
console.log('pairs noisy: corner error mm =', err(await live('room_moved.las'), TRUE.moved).toFixed(1));
console.log('icp:', await icp());
console.log('after ICP: corner error mm (expect < 1) =', err(await live('room_moved.las'), TRUE.moved).toFixed(3));
await win.evaluate(() => lithApp.doc.app.pm.ok()); await settle();
await T.shot('rg3_icp');
console.log('registration:', JSON.stringify(await win.evaluate(() => { const r = lithApp.doc.doc.clouds.find((c) => c.name === 'room_moved.las').registration; return { ref: r.ref, icpRms: +(r.icpRms * 1000).toFixed(2), overlap: +r.overlap.toFixed(2) }; })));
// undo -> back to the original position; redo
await win.evaluate(() => lithApp.doc.undo()); await W(400);
console.log('undo transform:', JSON.stringify(await xf('room_moved.las')));
await win.evaluate(() => lithApp.doc.redo()); await settle();
console.log('redo error mm:', err(await xf('room_moved.las'), TRUE.moved).toFixed(3));
// ---- 3. ICP only from a rough start (Transform: undo, then put it 2° / 8 cm off the truth) ----
await win.evaluate(() => lithApp.doc.undo()); await W(400);
const a = (2 * Math.PI) / 180, Rz = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const c = [4 + X0[0], 3 + X0[1], X0[2]], off = { R: Rz, t: rot(Rz, c).map((v, i) => c[i] - v + [0.08, -0.05, 0.03][i]) };
const rough = { R: rot(Rz, [TRUE.moved.R[0], TRUE.moved.R[3], TRUE.moved.R[6]]) && [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => Rz[i * 3] * TRUE.moved.R[j] + Rz[i * 3 + 1] * TRUE.moved.R[3 + j] + Rz[i * 3 + 2] * TRUE.moved.R[6 + j])), t: ap(off, TRUE.moved.t) };
await win.evaluate((t) => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.name === 'room_moved.las'); r.transform = t; d.layers.get(r.id).setPlacement(); }, rough);
await select('room_moved.las');
await win.evaluate(() => lithApp.doc.cmdRegister('cloud'));
await setv({ maxDist: 30 });
console.log('rough start error mm =', err(await live('room_moved.las'), TRUE.moved).toFixed(1));
console.log('icp:', await icp());
console.log('ICP only: corner error mm (expect < 1) =', err(await live('room_moved.las'), TRUE.moved).toFixed(3));
await win.evaluate(() => lithApp.doc.app.pm.ok()); await settle();
// ---- 4. level only (2 pairs) on the yawed scan ----
await add(D + '/room_yaw.las'); await settle();
await select('room_yaw.las');
await win.evaluate((id) => { lithApp.doc.cmdRegister('cloud'); }, null);
await setv({ ref: await idOf('room.las'), level: true });
for (const [a, b] of pairsFor(TRUE.yaw, [[0, 0, 0], [8, 6, 3]], 0.01)) await win.evaluate(([a, b]) => lithApp.doc.regAddPair(a, b), [a, b]);
console.log('level pairs: panel =', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.pairs.textContent.replace(/\s+/g, ' ')));
console.log('icp (level):', await icp());
const ty = await live('room_yaw.las');
console.log('level: R[8] (expect 1) =', ty.R[8].toFixed(9), ' corner error mm =', err(ty, TRUE.yaw).toFixed(3));
await win.evaluate(() => lithApp.doc.app.pm.ok()); await settle();
// ---- 5. Align Part ----
await add(D + '/boxscan2.las'); await settle();
for (const n of ['room.las', 'room_moved.las', 'room_yaw.las']) await win.evaluate((n) => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.name === n); r.visible = false; d.layers.get(r.id).applyStyle(); }, n);
await win.evaluate((p) => lithApp.open(p), PART); await W(500); await idle().catch(() => {});
await win.evaluate(() => lithApp.activate(lithApp.tabs.find((t) => t.doc?.doc?.kind === 'cloud') || lithApp.tabs[0])); await W(500);
await select('boxscan2.las');
await win.evaluate(() => lithApp.doc.cmdRegister('part'));
await win.waitForFunction(() => !!lithApp.doc.reg?.mesh, null, { timeout: 60000 });
await W(300);
console.log('part info:', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.pinfo.textContent));
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomTo(d.selId); }); await settle();
await T.shot('rg4_part_start');
// part corners (document frame of the part at its start placement) -> abs; scan corners from the truth (5 mm noise)
const BC = [[0, 0, 0], [1, 0, 0], [1, 0.6, 0.4], [0, 0.6, 0.4]];
await win.evaluate(({ BC, B }) => {
  const d = lithApp.doc, e = d.reg.base.elements, O = d.doc.origin;
  BC.forEach((p, k) => {
    const a = [0, 1, 2].map((i) => e[i] * p[0] + e[4 + i] * p[1] + e[8 + i] * p[2] + e[12 + i] + O[i]);
    const b = rot3(B.R, p).map((v, i) => v + B.t[i] + 0.005 * Math.cos(k * 5 + i));
    d.regAddPair(a, b);
  });
  function rot3(R, v) { return [0, 1, 2].map((i) => R[i * 3] * v[0] + R[i * 3 + 1] * v[1] + R[i * 3 + 2] * v[2]); }
}, { BC, B: TRUE.box });
console.log('part pairs:', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.pairs.textContent.replace(/\s+/g, ' ')));
await setv({ maxDist: 5 });
console.log('icp (part):', await icp());
await settle(); await T.shot('rg5_part_icp');
await win.evaluate(() => lithApp.doc.app.pm.ok()); await W(300);
const pa = await win.evaluate((p) => lithApp.doc.doc.partAlign?.[p], PART);
const O = await win.evaluate(() => lithApp.doc.doc.origin);
const perr = Math.max(...BC.map((p) => { const a = [0, 1, 2].map((i) => pa[i] * p[0] + pa[4 + i] * p[1] + pa[8 + i] * p[2] + pa[12 + i] + O[i]); const b = ap(TRUE.box, p); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000; }));
console.log('part placement corner error mm (expect < 1) =', perr.toFixed(3));
// Cloud to Part uses it
await win.evaluate(() => lithApp.doc.cmdC2M());
await win.waitForFunction(() => !!lithApp.doc.c2mMesh, null, { timeout: 60000 }); await W(500);
console.log('c2m info:', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.pinfo.textContent));
await setv({ maxDist: 2 });
await win.evaluate(() => lithApp.doc.app.pm.ok()); await waitBusy();
console.log('c2m (box points ~0 mm):', await win.evaluate(() => { const d = lithApp.doc, s = d.doc.clouds.find((c) => c.id === d.selId).analysis.stats; return `n ${s.n} mean ${(s.mean * 1000).toFixed(2)} mm rms ${(s.rms * 1000).toFixed(2)} mm`; }));
await settle(); await T.shot('rg6_c2m');
// ---- save + reopen ----
await win.evaluate(() => lithApp.save()); await W(800);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await settle();
console.log('reopened:', await win.evaluate(() => { const d = lithApp.doc; return d.doc.clouds.filter((r) => r.registration).map((r) => `${r.name}->${r.registration.ref}`).join(', ') + ' | parts ' + Object.keys(d.doc.partAlign || {}).length; }));
console.log('reopened error mm:', err(await xf('room_moved.las'), TRUE.moved).toFixed(3));
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
