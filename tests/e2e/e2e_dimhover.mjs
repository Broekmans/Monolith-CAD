// 0.1.91/0.1.92: Smart Dimension hover, view normal to the sketch: the model edge is highlighted orange everywhere
// (references made by clicking edges are invisible links since 0.1.92); second pick on the edge; label under the mouse. Needs ../scratch/hoesje.lithprt.
import fs from 'node:fs';
import { launch } from './common.mjs';
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/hv', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/hv/h.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/hv/h.lithprt'); await W(5000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.editSketch(d.doc.features.find((f) => f.name === 'Sketch3').id); }); await W(2500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.normalTo(d.sketcher.fr); }); await W(800);
await T.btn('Smart Dimension'); await W(300);
for (const v of [10, 30, -20]) { // 0.1.109: 30 (not 40): at the zoom after a finished rebuild the corner (79, 42) is within pick distance of 40
  const [x, y] = await T.P(79, v); await win.mouse.move(x - 20, y); await win.mouse.move(x, y, { steps: 4 }); await W(200);
  const r = await win.evaluate(() => { const s = lithApp.doc.sketcher; return { hover: s.hover, mh: s.modelHover ? Object.keys(s.modelHover)[0] : null }; });
  const px = await win.evaluate(([x, y]) => { const vp = lithApp.doc.vp.pane, r = vp.el.getBoundingClientRect(), d = window.devicePixelRatio || 1; const c = vp.ctx.getImageData(Math.round((x - r.left) * d), Math.round((y - r.top) * d), 1, 1).data; return [c[0], c[1], c[2], c[3]]; }, [x, y]);
  ok(r.mh === 'pts' && !r.hover, `hover at v=${v}: model edge itself (reference line g132 is an invisible link now): ${JSON.stringify(r)}`);
  ok(px[0] > 200 && px[1] > 100 && px[1] < 180 && px[3] > 200, `orange under the mouse at v=${v}: ${px}`);
}
// hidden references are not drawn: no sketch-colour pixels on the edge reference g132 away from the model edge? (checked via hiddenIds)
ok(await win.evaluate(() => lithApp.doc.sketcher.hiddenIds().has('g132')), 'reference line g132 is an invisible link');
// first pick the slot's right line, then hover the model edge: it highlights; the pending label follows the mouse exactly
const l = await win.evaluate(() => { const S = lithApp.doc.sketcher.sk, g = S.geo.find((x) => x.id === 'g73'), P = (id) => S.geo.find((x) => x.id === id); return [(P(g.p1).x + P(g.p2).x) / 2, (P(g.p1).y + P(g.p2).y) / 2]; });
await T.click(l[0], l[1]); await W(200);
const [ex, ey] = await T.P(79, 30); await win.mouse.move(ex - 15, ey); await win.mouse.move(ex, ey, { steps: 3 }); await W(200);
ok(await win.evaluate(() => !!lithApp.doc.sketcher.modelHover), 'second pick: model edge highlighted while a dimension is pending');
await win.mouse.down(); await win.mouse.up(); await W(200);
const mv = [];
for (const [dx, dy] of [[60, -80], [120, -120], [-100, -60], [40, 80]]) {
  await win.mouse.move(ex + dx, ey + dy, { steps: 4 }); await W(120);
  const r = await win.evaluate(([mx, my]) => { const sk = lithApp.doc.sketcher, pd = sk.tool?.pending; if (!pd) return null; const vp = sk.vp, rr = vp.el.getBoundingClientRect(); const s = sk.scr(pd.lpAbs); return [s[0] + rr.left - mx, s[1] + rr.top - my, pd.type]; }, [ex + dx, ey + dy]);
  mv.push(r);
}
console.log(JSON.stringify(mv));
ok(mv.every((r) => r && r[2] === 'pointLine' && Math.abs(r[0]) < 2 && Math.abs(r[1]) < 2), 'pending pointLine to the edge; its label point stays under the mouse');
await T.shot('dimhover-pending');
await win.mouse.down(); await win.mouse.up(); await W(300);
const made = await win.evaluate(() => { const S = lithApp.doc.sketcher.sk, c = S.cons[S.cons.length - 1]; const g = S.geo.find((x) => x.id === c.l || S.geo.find((y) => y.id === c.p && y.refKey)); return { type: c.type, v: +S.cons[S.cons.length - 1].value.toFixed(3), n: S.geo.filter((x) => x.refKey).length }; });
console.log(JSON.stringify(made));
ok(made.type === 'pointLine' && made.n === 2, 'dimension to the edge made, existing invisible reference reused (no new geometry): ' + JSON.stringify(made));
await T.app.close();
