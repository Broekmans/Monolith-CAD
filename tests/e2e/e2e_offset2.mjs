// 0.1.99: sketch colours. 0.1.98: Offset Entities on a model outline with corner arcs stays Fully Defined (fixed base arcs), edges off the
// sketch plane can be picked (chained at their own depth only), hover colours. Needs ../scratch/stonex001.lithprt
// (Projects\Stonex\Stonex-01-001-001.lithprt).
import fs from 'node:fs';
import { launch } from './common.mjs';
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/of2', { recursive: true }); fs.copyFileSync('/home/claude/scratch/stonex001.lithprt', '/tmp/of2/s.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/of2/s.lithprt'); await W(9000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.editSketch(d.doc.features.find((f) => f.name === 'Sketch4').id); }); await W(2500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.normalTo(d.sketcher.fr); }); await W(800);
const st = () => win.evaluate(() => { const s = lithApp.doc.sketcher; return { st: s.statusText().text, conf: s.state.conflicting.length, dof: s.state.dof }; });
ok((await st()).st === 'Fully Defined', 'Sketch4 fully defined before');
// 0.1.99 colours: blue = as is (fully defined / selected), yellow = under defined
const cols = await win.evaluate(() => { const s = lithApp.doc.sketcher, g = s.sk.geo.find((x) => x.type === 'line' && !x.construction && !x.refKey); const d = s.colorFor(g); s.sel.add('geo:' + g.id); const se = s.colorFor(g); s.sel.clear(); s.under.add(g.id); const u = s.colorFor(g); s.under.delete(g.id); return { d, se, u }; });
ok(cols.d === '#111111' && cols.se === '#1e90ff' && cols.u === '#286edc', 'sketch colours: fully defined black, selected bright blue, under defined blue ' + JSON.stringify(cols));
await T.btn('Offset Entities'); await W(300); await T.num(0, 2);
await T.click(77, 0); await W(500);
let o = await win.evaluate(() => { const s = lithApp.doc.sketcher, m = s.offsetMode; return { n: m.picks[0]?.chain.items.map((it) => s.G(it.id).type).join(), err: m.err }; });
ok(o.n === 'line,arc,line,arc,line,arc,line,arc' && !o.err, 'model outline with 4 corner arcs picked ' + JSON.stringify(o));
await win.keyboard.press('Enter'); await W(800); await idle();
o = await st();
ok(o.st === 'Fully Defined' && !o.conf && o.dof === 0, 'after the offset: still Fully Defined, no conflicts (was Over Defined -4) ' + JSON.stringify(o));
// edge off the sketch plane: depths of projected edges, pick one that is not in the plane
const off = await win.evaluate(() => {
  const s = lithApp.doc.sketcher, L = s.modelSnapGeo().pickEdges;
  const cand = L.filter((x) => !x.inPlane && x.flat && x.pts.length >= 2 && Math.hypot(x.pts[0][0] - x.pts[x.pts.length - 1][0], x.pts[0][1] - x.pts[x.pts.length - 1][1]) > 20);
  // an off-plane edge whose middle is not covered by an in-plane edge
  for (const c of cand) {
    const mid = c.pts[Math.floor(c.pts.length / 2)], q = c.pts.length === 2 ? [(c.pts[0][0] + c.pts[1][0]) / 2, (c.pts[0][1] + c.pts[1][1]) / 2] : mid;
    const be = s.pickModelEdge(q, 0.3);
    if (be === c) return { q, depth: +c.depth.toFixed(3), n: cand.length };
  }
  return { n: cand.length };
});
ok(!!off.q, 'an edge off the sketch plane is pickable at ' + JSON.stringify(off));
if (off.q) {
  await T.btn('Offset Entities'); await W(300); await T.num(0, 1);
  const [x, y] = await T.P(off.q[0], off.q[1]); await win.mouse.move(x - 15, y - 15); await win.mouse.move(x, y, { steps: 4 }); await W(300);
  const hv = await win.evaluate(() => { const h = lithApp.doc.sketcher.offsetMode.hover; return { key: h?.key, n: h?.polys?.length }; });
  ok(/^e/.test(hv.key || '') && hv.n >= 1, 'hover lights up the off-plane edge chain ' + JSON.stringify(hv));
  await T.click(off.q[0], off.q[1]); await W(500);
  o = await win.evaluate((dep) => { const s = lithApp.doc.sketcher, m = s.offsetMode; const L = s.modelSnapGeo().pickEdges; return { picks: m.picks.length, n: m.picks[0]?.chain.items.length, refs: m.picks[0]?.chain.items.every((it) => !!s.G(it.id)?.refKey), err: m.err, prev: m.preview?.length, hovN: m.hover?.polys?.length }; }, off.depth);
  ok(o.picks === 1 && o.refs && o.prev > 0 && !o.err && o.n === o.hovN, 'off-plane edge picked: chain of references at its own depth, same as the hover, preview ok ' + JSON.stringify(o));
  await win.keyboard.press('Enter'); await W(800); await idle();
  o = await st();
  ok(o.st === 'Fully Defined' && !o.conf, 'offset of the off-plane chain keeps the sketch Fully Defined ' + JSON.stringify(o));
}
await T.shot('offset2');
await T.app.close();
