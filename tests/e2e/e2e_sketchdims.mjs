// 0.1.87: Smart Dimension to a model edge, double-click a dimension with Smart Dimension active (own double-click
// timing), view toolbar scale, Options window dragged by its title. Needs ../scratch/hoesje.lithprt.
import fs from 'node:fs';
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/sd', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/sd/hoesje.lithprt');
await win.evaluate(() => { try { localStorage.removeItem('monolith.dlgPos.Options'); } catch {} });
await win.evaluate((p) => lithApp.open(p), '/tmp/sd/hoesje.lithprt'); await W(5000); await idle();
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.editSketch(d.doc.features.find((f) => f.name === 'Sketch3').id); }); await W(2500); await idle();
// remove the linked line at the right edge (like Wouter did) so the model edge itself is clicked
const info = await win.evaluate(() => {
  const sk = lithApp.doc.sketcher, S = sk.sk;
  const kill = ['g132', 'g130', 'g131']; S.cons = S.cons.filter((c) => ![c.e, c.l, c.a, c.b, c.p].some((x) => kill.includes(x))); S.geo = S.geo.filter((g) => !['g132', 'g130', 'g131'].includes(g.id)); sk.resolve(true);
  const l = S.geo.find((g) => g.id === 'g73'), P = (id) => S.geo.find((g) => g.id === id);
  const a = P(l.p1), b = P(l.p2);
  sk.vp.setView('right', false); lithApp.doc.zoomFit();
  return { mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], n: S.cons.length };
});
await W(500);
await T.btn('Smart Dimension'); await W(300);
const [hx, hy] = await T.P(79, info.mid[1] + 3); await win.mouse.move(hx, hy, { steps: 3 }); await W(200);
const mh = await win.evaluate(() => { const h = lithApp.doc.sketcher.modelHover; return h ? (h.v ? 'v' : 'e' + h.pts.length) : null; });
ok(mh && mh[0] === 'e', '0 Smart Dimension: model edge under the mouse is highlighted (' + mh + ')');
await T.shot('sketchdims-hover');
await T.click(info.mid[0], info.mid[1]); await W(200);
await T.click(79, info.mid[1]); await W(200);
await T.click(90, info.mid[1] - 10); await W(400);
const r1 = await win.evaluate(() => { const S = lithApp.doc.sketcher.sk; const c = S.cons[S.cons.length - 1]; const g = S.geo.filter((x) => x.onEdge).map((x) => x.id); return { n: S.cons.length, last: c.type, val: c.value, linked: g }; });
console.log(JSON.stringify(info), JSON.stringify(r1));
const near = await win.evaluate(() => { const S = lithApp.doc.sketcher.sk, c = S.cons[S.cons.length - 1], l = S.geo.find((g) => g.id === 'g73'); return [l.p1, l.p2].includes(c.p); });
ok(near, '1b the distance is measured from the slot line (not from the far end of the model edge)');
ok(r1.n === info.n + 2 && r1.last === 'pointLine', '1 Smart Dimension: slot line → model edge makes a distance (' + r1.val?.toFixed?.(2) + ') to a new On Edge reference');
// double-click a dimension label while Smart Dimension is still active (second click 6 px off)
const lab = await win.evaluate(() => { const sk = lithApp.doc.sketcher, h = sk._hitsBy.get(sk.vp.pane).dims.find((x) => x.id === 'c122'); const r = sk.vp.el.getBoundingClientRect(); return { x: r.left + (h.x0 + h.x1) / 2, y: r.top + (h.y0 + h.y1) / 2 }; });
await win.mouse.click(lab.x, lab.y); await W(120); await win.mouse.click(lab.x + 6, lab.y + 2); await W(400);
ok(await win.evaluate(() => !!document.querySelector('.modify-box') && lithApp.doc.sketcher.tool?.id === 'dimension'), '2 double-click on R10 with Smart Dimension active opens the value box');
await win.keyboard.press('Escape'); await W(200);
await win.evaluate(() => { document.querySelector('.modify-box')?.remove(); lithApp.doc.exitSketch(false); }); await W(800); await idle();
// view toolbar scale
const w0 = await win.evaluate(() => document.querySelector('.headsup').getBoundingClientRect().width);
await win.evaluate(() => lithApp.applyOptions({ hudScale: 150 })); await W(300);
const w1 = await win.evaluate(() => document.querySelector('.headsup').getBoundingClientRect().width);
ok(Math.abs(w1 / w0 - 1.5) < 0.05, `3 view toolbar scale 150 %: width ${w0.toFixed(0)} → ${w1.toFixed(0)}`);
// options window drag
win.evaluate(() => lithApp.optionsDialog()); await W(800);
const t0 = await win.evaluate(() => { const r = document.querySelector('.dlg .dlg-title').getBoundingClientRect(); return [r.left + 60, r.top + 10]; });
await win.mouse.move(t0[0], t0[1]); await win.mouse.down(); await win.mouse.move(t0[0] - 100, t0[1] + 40, { steps: 5 }); await win.mouse.up(); await W(200);
const t1 = await win.evaluate(() => { const r = document.querySelector('.dlg .dlg-title').getBoundingClientRect(); return [r.left + 60, r.top + 10]; });
ok(Math.round(t1[0] - t0[0]) === -100 && Math.round(t1[1] - t0[1]) === 40, '4 Options window dragged by its title: ' + JSON.stringify([t1[0] - t0[0], t1[1] - t0[1]]));
await win.keyboard.press('Escape'); await W(300);
win.evaluate(() => lithApp.optionsDialog()); await W(800);
const t2 = await win.evaluate(() => { const r = document.querySelector('.dlg .dlg-title').getBoundingClientRect(); return [r.left + 60, r.top + 10]; });
ok(Math.abs(t2[0] - t1[0]) < 1 && Math.abs(t2[1] - t1[1]) < 1, '5 reopened at the same place');
await T.shot('sketchdims-options'); await win.keyboard.press('Escape'); await W(300);
// view cube stays on top of sketch overlay
await win.evaluate(() => { const d = lithApp.doc; d.editSketch(d.doc.features.find((f) => f.name === 'Sketch3').id); }); await W(2500); await idle();
const a = await win.evaluate(() => { const vp = lithApp.doc.vp.pane, vc = vp.viewCube, el = vc.el, ctx = vp.ctx, dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#000'; // draw something over the cube as a sketch would, then redraw
  vp.overlayDrawers.push((c) => { c.fillStyle = '#f00'; c.fillRect(0, 0, vp.width, vp.height); }); vp._drawOverlay(); vp.overlayDrawers.pop();
  const px = (x, y) => ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data[3];
  const r = [px(el.offsetLeft + vc.S / 2, el.offsetTop + vc.S / 2), px(10, 10), px(el.offsetLeft + 3, el.offsetTop + 3)]; vp._drawOverlay(); return r; });
ok(a[0] === 0 && a[1] === 255 && a[2] === 255, '6 overlay cleared only over the cube itself, not its corner area (alpha ' + a + ')');
await T.shot('sketchdims-cube'); await win.keyboard.press('Escape');
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
