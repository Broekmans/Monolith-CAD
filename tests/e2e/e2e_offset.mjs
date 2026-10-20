// 0.1.97: arrow stays under the mouse, drag through the chain reverses, red warning when not possible, flat face pick.
// 0.1.96: distance box + drag arrow on the sketch, side follows the mouse (Reverse by hand stops it).
// 0.1.94: Offset Entities (sketch chain + model edge chain, linked), model edge hover in every sketch mode
// (no tool, Convert Entities, line tool), view cube labels upright + face click keeps them upright.
// Needs ../scratch/hoesje.lithprt.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch } from './common.mjs';
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/of', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/of/h.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/of/h.lithprt'); await W(5000); await idle();
// --- view cube: labels turn to stay horizontal; clicking a face keeps the roll that matches the label
const cube = await win.evaluate(async () => {
  const vp = lithApp.doc.vp.pane; vp.orient([0, 0, -1], [1, 0, 0], false); vp.requestRender(); await new Promise((r) => setTimeout(r, 300));
  const vc = vp.viewCube || vp.cube; return { turn: vc ? [...vc.turn] : null };
});
ok(cube.turn && cube.turn[4] !== 0, 'FRONT label turned while the view is rolled 90°: ' + JSON.stringify(cube.turn));
const goto = await win.evaluate(async () => {
  const vp = lithApp.doc.vp.pane, vc = vp.viewCube || vp.cube; vp.orient([-1, -1, -1], [1, 0, 0], false); await new Promise((r) => setTimeout(r, 100));
  vc.goTo([0, 1, 0]); await new Promise((r) => setTimeout(r, 900));
  const q = vp.camera.quaternion, up = [0, 1, 0], v = { x: 0, y: 1, z: 0 };
  const e = new (vp.camera.up.constructor)(0, 1, 0).applyQuaternion(q), d = new (vp.camera.up.constructor)(0, 0, -1).applyQuaternion(q);
  void up; void v; return { up: [e.x, e.y, e.z].map((x) => +x.toFixed(3)), dir: [d.x, d.y, d.z].map((x) => +x.toFixed(3)), turn: vc.turn[2] };
});
ok(goto.dir[1] === -1, 'TOP face click: looks down ' + JSON.stringify(goto));
ok(Math.abs(goto.up[0]) > 0.99 || Math.abs(goto.up[2]) > 0.99, 'roll kept to the nearest axis (no forced turn) ' + JSON.stringify(goto.up));
await T.shot('offset-cube');
// --- sketch: model edge hover without a tool, in Convert Entities and with the Line tool
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.editSketch(d.doc.features.find((f) => f.name === 'Sketch3').id); }); await W(2500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.normalTo(d.sketcher.fr); }); await W(800);
const hov = async () => win.evaluate(() => { const s = lithApp.doc.sketcher; return s.modelHover ? Object.keys(s.modelHover).join() : null; });
let [x, y] = await T.P(79, 20); await win.mouse.move(x - 20, y); await win.mouse.move(x, y, { steps: 4 }); await W(200);
ok((await hov())?.startsWith('pts'), 'no tool: model edge highlighted');
await T.btn('Convert Entities'); await W(200);
await win.mouse.move(x - 20, y); await win.mouse.move(x, y, { steps: 4 }); await W(200);
ok((await hov())?.startsWith('pts'), 'Convert Entities: model edge highlighted');
await win.keyboard.press('Escape'); await W(200);
await T.btn('Line'); await W(200); await win.mouse.move(x - 20, y); await win.mouse.move(x, y, { steps: 4 }); await W(200);
ok(!!(await hov()), 'Line tool: model edge / corner highlighted');
await win.keyboard.press('Escape'); await win.keyboard.press('Escape'); await W(200);
// --- offset the slot (sketch chain) by 2, outside
const n0 = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.length);
await T.btn('Offset Entities'); await W(300);
ok(await win.evaluate(() => !!lithApp.doc.sketcher.offsetMode && !!document.querySelector('.pm-float')), 'Offset Entities popup floats over the view');
await T.num(0, 2);
for (const [lab, on] of [['Reverse', false], ['Bi-directional', false], ['Select chain', true], ['Base geometry', false]]) await win.locator(`.pm-check:has-text("${lab}") input`).setChecked(on);
await W(200);
await T.click(72, 17); await W(300);
let st = await win.evaluate(() => { const m = lithApp.doc.sketcher.offsetMode; return { picks: m.picks.length, n: m.picks[0]?.chain.items.length, closed: m.picks[0]?.chain.closed, prev: m.preview?.length, err: m.err }; });
ok(st.picks === 1 && st.n === 8 && st.closed && st.prev === 8 && !st.err, 'slot chain: 8 entities closed, preview 8 ' + JSON.stringify(st));
await T.shot('offset-preview');
await win.keyboard.press('Enter'); await W(600); await idle();
st = await win.evaluate(() => {
  const s = lithApp.doc.sketcher, S = s.sk, m = S.cons.find((c) => c.type === 'offset');
  const arcs = S.geo.filter((g) => g.type === 'arc' && !g.refKey).map((g) => +g.r.toFixed(3));
  return { mode: !!s.offsetMode, added: S.geo.length, m: m && +m.value, rel: S.cons.filter((c) => c.type === 'offsetRel').length, arcs, conflict: s.state?.conflicting?.length || 0 };
});
ok(!st.mode && st.m === 2 && st.rel === 7 && st.arcs.filter((r) => r === 12).length === 4 && !st.conflict, 'offset made: dimension 2, 7 offset relations, 4 arcs R12 ' + JSON.stringify({ ...st, added: st.added - n0 }));
// base slot corner R10 → 8: offset arcs follow (R10)
await win.evaluate(() => { const s = lithApp.doc.sketcher, c = s.sk.cons.find((x) => x.id === 'c122'); s.pushUndo(); c.value = 8; s.resolve(true); });
st = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter((g) => g.type === 'arc' && !g.refKey).map((g) => +g.r.toFixed(3)));
ok(st.filter((r) => r === 10).length === 4 && st.filter((r) => r === 8).length === 4, 'slot R8 → offset arcs R10 ' + JSON.stringify(st));
await win.evaluate(() => { const s = lithApp.doc.sketcher, c = s.sk.cons.find((x) => x.id === 'c122'); c.value = 10; s.resolve(true); }); // back (R8 makes Fillet1 impossible)
// offset dimension drawn + editable (label hit box)
ok(await win.evaluate(() => { const s = lithApp.doc.sketcher, m = s.sk.cons.find((c) => c.type === 'offset'); return s.dimHits.some((d) => d.id === m.id); }), 'offset dimension label drawn');
// --- offset a model edge chain (plate outline) 3 mm inside
await T.btn('Offset Entities'); await W(300);
await T.num(0, 3);
await win.locator('.pm-check:has-text("Reverse") input').check(); await W(200);
await T.click(79, -10); await W(500);
st = await win.evaluate(() => { const m = lithApp.doc.sketcher.offsetMode; return { picks: m.picks.length, n: m.picks[0]?.chain.items.length, closed: m.picks[0]?.chain.closed, prev: m.preview?.length, err: m.err }; });
console.log(JSON.stringify(st));
ok(st.picks === 1 && st.n === 4 && st.closed && !st.err, 'model edge chain picked (invisible references) ' + JSON.stringify(st));
await win.keyboard.press('Enter'); await W(600); await idle();
st = await win.evaluate(() => { const s = lithApp.doc.sketcher, S = s.sk; const off = S.cons.filter((c) => c.type === 'offset'); const xs = []; const last = off[off.length - 1]; for (const c of S.cons.filter((k) => k.id === last.id || k.of === last.id)) { const g = S.geo.find((q) => q.id === c.a); for (const k of ['p1', 'p2', 's', 'e']) if (g[k]) xs.push(S.geo.find((q) => q.id === g[k]).x); } return { dims: off.length, maxX: +Math.max(...xs).toFixed(3), minX: +Math.min(...xs).toFixed(3), conflict: s.state?.conflicting?.length || 0 }; });
ok(st.dims === 2 && st.maxX === 76 && st.minX === -76 && !st.conflict, 'model outline offset 3 inside: x ±76 ' + JSON.stringify(st));
await T.shot('offset-model');
// --- undo removes the model offset, redo/undo keep the sketch valid
const before = await win.evaluate(() => lithApp.doc.sketcher.sk.cons.filter((c) => c.type === 'offset').length);
await win.evaluate(() => lithApp.doc.sketcher.undo()); await W(400);
ok(await win.evaluate(() => lithApp.doc.sketcher.sk.cons.filter((c) => c.type === 'offset').length) === before - 1, 'undo removes the last offset');
await win.evaluate(() => lithApp.doc.sketcher.redo()); await W(400);
// --- 0.1.96: distance box on the sketch, side follows the mouse, drag arrow
await T.btn('Offset Entities'); await W(300);
await T.num(0, 2);
[x, y] = await T.P(72, 17); await win.mouse.move(x - 30, y); await win.mouse.move(x, y, { steps: 5 }); await W(250);
ok(await win.evaluate(() => lithApp.doc.sketcher.offsetMode.hover?.geo?.length === 8), '0.1.98: hovering the slot line lights up the whole chain (8 entities)');
await T.click(72, 17); await W(400);
const ofs = () => win.evaluate(() => { const s = lithApp.doc.sketcher, m = s.offsetMode, b = document.querySelector('.off-val'), g = document.querySelector('.off-grip'); return { rev: !!m?.opts.reverse, dist: m && +m.opts.dist, pmRev: lithApp.pm.current?.inputs.reverse?.checked, pmDist: +lithApp.pm.current?.values.dist, box: b && b.style.display !== 'none' && b.querySelector('input').value, grip: g && g.style.display !== 'none', prev: m?.preview?.length }; });
let o = await ofs();
ok(o.box === '2' && o.grip && o.prev === 8 && !o.rev, 'distance box 2 + drag arrow on the sketch, preview outside ' + JSON.stringify(o));
[x, y] = await T.P(59.5, 17.5); await win.mouse.move(x, y, { steps: 6 }); await W(250);
o = await ofs();
ok(!o.rev && !o.pmRev, '0.1.98: moving the mouse into the slot does not flip the side (only dragging the arrow does) ' + JSON.stringify(o));
await win.locator('.off-val input').fill('4'); await win.locator('.off-val input').press('Enter'); await W(300);
o = await ofs();
ok(o.dist === 4 && o.pmDist === 4 && o.box === '4', 'typing 4 + Enter in the box sets the dialog distance ' + JSON.stringify(o));
{
  const gb = await win.locator('.off-grip').boundingBox();
  [x, y] = await T.P(25, 17);
  await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await win.mouse.down(); await win.mouse.move(x, y, { steps: 8 }); await win.mouse.up(); await W(400);
}
o = await ofs();
ok(o.dist === 12 && o.pmDist === 12 && !o.rev, 'dragging the arrow to 12 mm left of the slot: distance 12, outside ' + JSON.stringify(o));
o = await win.evaluate(() => { const s = lithApp.doc.sketcher, a = s.offsetAnchor(); return { base: a.base.map((v) => +v.toFixed(2)), tip: a.p.map((v) => +v.toFixed(2)), field: lithApp.pm.current.inputs.dist.value }; });
ok(Math.abs(o.base[0] - 37) < 0.01 && Math.abs(o.base[1] - 17) < 0.5 && Math.abs(o.tip[0] - 25) < 0.01 && o.field === '12', 'arrow stays where it was dragged (base on the chain at the mouse, tip on the offset), field shows 12 ' + JSON.stringify(o));
const dragTo = async (sxk, syk) => { const gb = await win.locator('.off-grip').boundingBox(); const [tx, ty] = await T.P(sxk, syk); await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2); await win.mouse.down(); await win.mouse.move(tx, ty, { steps: 12 }); await win.mouse.up(); await W(400); };
await dragTo(45, 17);
o = await win.evaluate(() => { const s = lithApp.doc.sketcher, m = s.offsetMode; return { rev: m.opts.reverse, d: +m.opts.dist, err: m.err, prev: m.preview?.length, field: lithApp.pm.current.inputs.dist.value }; });
ok(o.rev && o.d === 8 && !o.err && o.prev === 8 && !/0000/.test(o.field), 'dragged through the chain to the inside: reversed, distance 8, valid ' + JSON.stringify(o));
await dragTo(52, 17);
o = await win.evaluate(() => { const s = lithApp.doc.sketcher, m = s.offsetMode, b = document.querySelector('.off-val'); return { rev: m.opts.reverse, d: +m.opts.dist, err: !!m.err, raw: m.raw?.length, boxErr: b.classList.contains('err'), grip: document.querySelector('.off-grip').style.display !== 'none' }; });
ok(o.rev && o.d === 15 && o.err && o.raw === 8 && o.boxErr && o.grip, 'too far inside (15 > R10): red warning, 8 red ghost entities, arrow still draggable ' + JSON.stringify(o));
await T.shot('offset-error');
await dragTo(30, 17);
o = await win.evaluate(() => { const m = lithApp.doc.sketcher.offsetMode; return { rev: m.opts.reverse, d: +m.opts.dist, err: !!m.err, boxErr: document.querySelector('.off-val').classList.contains('err') }; });
ok(!o.rev && o.d === 7 && !o.err && !o.boxErr, 'dragged back out: outside again, 7, warning gone ' + JSON.stringify(o));
await win.locator('.pm-check:has-text("Reverse") input').check(); await W(200);
[x, y] = await T.P(30, 17); await win.mouse.move(x - 30, y); await win.mouse.move(x, y, { steps: 6 }); await W(250);
o = await ofs();
ok(o.rev && o.pmRev, 'Reverse ticked by hand: the side stays, mouse no longer flips it ' + JSON.stringify(o));
ok(await win.evaluate(() => { const v = lithApp.doc.sketcher.vp.el; return !v.scrollLeft && !v.scrollTop; }), 'the view did not scroll when the box field got focus');
await win.locator('.pm-check:has-text("Reverse") input').press('Escape'); await W(300);
ok(await win.evaluate(() => !lithApp.doc.sketcher.offsetMode && !document.querySelector('.off-val')), 'Esc: offset cancelled, box removed');
// flat model face → all its edges as chains (click again = remove)
await T.btn('Offset Entities'); await W(300);
[x, y] = await T.P(0, 20); await win.mouse.move(x - 20, y); await win.mouse.move(x, y, { steps: 4 }); await W(300);
o = await win.evaluate(() => { const h = lithApp.doc.sketcher.offsetMode.hover; return { key: h?.key, fill: h?.fill?.length, closed: h?.fill?.every((l) => Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 1e-3) }; });
ok(/^f/.test(o.key || '') && o.fill >= 1 && o.closed, '0.1.98: flat face under the mouse lights up (closed fill loops) ' + JSON.stringify(o));
await T.click(0, 20); await W(500);
o = await win.evaluate(() => { const m = lithApp.doc.sketcher.offsetMode; return { picks: m.picks.length, face: m.picks.every((pk) => pk.face != null), closed: m.picks.every((pk) => pk.chain.closed), n: m.picks.map((pk) => pk.chain.items.length), prev: m.preview?.length || 0, err: m.err }; });
ok(o.picks >= 1 && o.face && o.closed && o.prev > 0, 'flat face click: its edge loops picked as closed chains ' + JSON.stringify(o));
await T.click(0, 20); await W(400);
ok(await win.evaluate(() => lithApp.doc.sketcher.offsetMode.picks.length === 0), 'face clicked again: removed');
await win.keyboard.press('Escape'); await W(300);
// both offsets → construction so Cut-Extrude1 keeps its profile (the offset loops would change the cut)
await win.evaluate(() => { const s = lithApp.doc.sketcher, S = s.sk; s.sel.clear(); for (const c of S.cons) if (c.type === 'offset' || c.type === 'offsetRel') s.sel.add('geo:' + c.a); s.toggleConstruction(); });
// --- exit, save the features, then change Sketch1 148 → 158 in node: offset of the model outline follows
await win.evaluate(() => lithApp.doc.exitSketch(true)); await W(2500); await idle();
const status = await win.evaluate(() => lithApp.doc.status.filter((s) => s.state !== 'ok').map((s) => s.id + ' ' + s.error));
ok(!status.length, 'rebuild ok after offsets ' + JSON.stringify(status));
fs.writeFileSync('/tmp/of/after.lithprt', await win.evaluate(() => JSON.stringify({ features: lithApp.doc.doc.features })));
await T.app.close();
const out = execFileSync('node', ['tests/unit/offset_follow.mjs', '/tmp/of/after.lithprt', 'Sketch1', 'c34', '158', 'Sketch3'], { encoding: 'utf8', timeout: 300000 });
console.log(out.split('\n').slice(-6).join('\n'));
ok(/after  \[\[40,-2,79,37\],\[-81,-39,81,39\]\]/.test(out) && /status not ok: \[\]/.test(out), 'Sketch1 148 → 158: model outline grows 5 per side, its 3 mm inside offset follows (±81), slot offset moves with the slot');
