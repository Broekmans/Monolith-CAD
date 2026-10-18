// 0.1.93: grid off by default + grid button in the view toolbar, slim vertical toolbar at the view cube, model edges
// off the sketch plane can be picked (outer edge of the filleted rim), dotted leader to a label beyond its dimension
// line. Needs ../scratch/hoesje.lithprt.
import fs from 'node:fs';
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
fs.mkdirSync('/tmp/tb', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/tb/h.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/tb/h.lithprt'); await W(5000); await idle();
await win.evaluate(() => lithApp.doc.setViewLayout('single')); await W(500);
ok(await win.evaluate(() => lithApp.doc.gridOn === false), '1 grid off by default');
const hud = await win.evaluate(() => { const h = document.querySelector('.headsup'), r = h.getBoundingClientRect(), a = lithApp.doc.vp.pane.viewCube.arrows.getBoundingClientRect(), p = lithApp.doc.vp.pane.el.getBoundingClientRect(); return { w: r.width, h: r.height, vert: h.classList.contains('vertical'), top: r.top - a.bottom, right: p.right - r.right, n: h.querySelectorAll('.hu-btn').length }; });
console.log(JSON.stringify(hud));
ok(hud.vert && hud.h > hud.w * 3 && hud.w < 36 && hud.top >= 0 && hud.top < 6 && hud.right < 12, '2 slim vertical toolbar under the view cube at the right');
await win.evaluate(() => document.querySelector('.headsup .hu-btn[title^="Show / Hide Grid"]').click()); await W(300);
ok(await win.evaluate(() => lithApp.doc.gridOn === true), '3 grid button turns the grid on');
await win.evaluate(() => document.querySelector('.headsup .hu-btn[title^="Show / Hide Grid"]').click()); await W(200);
await T.shot('toolbar');
// new sketch on the top face (end of history), pick the outer rim edge (off the sketch plane)
const e = await win.evaluate(async () => {
  const d = lithApp.doc;
  const f = d.mesh.faces.filter((x) => x.plane && Math.abs(x.plane.normal[0] - 1) < 1e-6).sort((a, b) => b.c[0] - a.c[0])[0];
  d.startSketch(f.plane, 'Face', null, { c: f.c, n: f.plane.normal, bb: d.mesh.bbox });
  await new Promise((r) => setTimeout(r, 1500));
  const sk = d.sketcher, M = sk.modelSnapGeo();
  const outer = M.pickEdges.filter((x) => !x.inPlane && x.e.type === 'line' && x.pts.every((q) => Math.abs(q[0] + 79) < 0.05));
  return { n: M.pickEdges.length, outer: outer.length, best: (() => { const b = sk.pickModelEdge([-79.2, 0], 2); return b ? { inPlane: b.inPlane, u: b.pts[0][0] } : null; })() };
});
console.log(JSON.stringify(e));
ok(e.outer >= 1 && e.best && !e.best.inPlane && Math.abs(e.best.u + 79) < 0.05, '4 outer rim edge (off the sketch plane) can be picked');
// a dimension with its label beyond the dimension line gets a dotted leader
const dl = await win.evaluate(() => {
  const sk = lithApp.doc.sketcher, ctx = document.createElement('canvas').getContext('2d'); const calls = [];
  const orig = ctx.setLineDash.bind(ctx); ctx.setLineDash = (a) => { calls.push(a.join(',')); orig(a); };
  sk.sk.geo.push({ id: 'qa', type: 'point', x: 0, y: 0 }, { id: 'qb', type: 'point', x: 20, y: 0 }, { id: 'ql', type: 'line', p1: 'qa', p2: 'qb' });
  const c = { id: 'qc', type: 'length', l: 'ql', value: 20 };
  sk.dimLines(ctx, c, [60, 10], (p) => sk.scr(p), 'length', '20');
  const near = calls.length; calls.length = 0; sk.dimLines(ctx, c, [10, 10], (p) => sk.scr(p), 'length', '20');
  sk.sk.geo.splice(-3, 3);
  return { beyond: near, inside: calls.length };
});
ok(dl.beyond > 0 && dl.inside === 0, '5 dotted leader only when the label is beyond the dimension line ' + JSON.stringify(dl));
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
