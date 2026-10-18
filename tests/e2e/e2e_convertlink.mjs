// 0.1.83: linked Convert Entities (On Edge) on Wouter's Hoesje part (copy to ../scratch/hoesje.lithprt first).
// Old fixed converted edges get linked on open; Sketch1 158 → 168 makes Sketch2 + Sketch3 follow; Sketch2's dashed
// size drives Sketch1; a big jump 84 → 700 changes the main dimension; undo; new Convert Entities gets On Edge; option off.
import fs from 'node:fs';
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
const src = '/home/claude/scratch/hoesje.lithprt', tmp = '/tmp/cl/hoesje.lithprt';
fs.mkdirSync('/tmp/cl', { recursive: true }); fs.copyFileSync(src, tmp);
await win.evaluate((p) => lithApp.open(p), tmp); await W(5000); await idle();
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const S = () => win.evaluate(() => {
  const d = lithApp.doc, F = (n) => d.doc.features.find((f) => f.name === n);
  const line = (n, id) => { const s = F(n), g = s.geo.find((x) => x.id === id), P = (p) => s.geo.find((x) => x.id === p); return [P(g.p1).x, P(g.p1).y, P(g.p2).x, P(g.p2).y].map((v) => +v.toFixed(3)); };
  const b = d.mesh.bbox, size = b.min.map((v, k) => +(b.max[k] - v).toFixed(2));
  return { size, c34: F('Sketch1').cons.find((c) => c.id === 'c34').value, c35: F('Sketch1').cons.find((c) => c.id === 'c35').value,
    g36: line('Sketch2', 'g36'), g127: line('Sketch3', 'g127'), bad: d.status.filter((s) => s.state !== 'ok').map((s) => s.id + ':' + s.state + ':' + (s.error || '')),
    links: d.doc.features.filter((f) => f.type === 'sketch').map((f) => f.name + ':' + f.geo.filter((g) => g.onEdge).length).join(' '),
    status: document.querySelector('.st-left')?.textContent || '', toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) };
});
const dimOf = (sk, pred) => win.evaluate(([sk, pred]) => { const d = lithApp.doc, f = d.doc.features.find((x) => x.name === sk); d.dimFeat = f.id; const items = d.featureDims(); const it = items.find((x) => new Function('x', 'return ' + pred)(x)); return it ? { ...it, pos3: null } : { none: items.map((x) => x.text) }; }, [sk, pred]);
const apply = async (it, v) => { await win.evaluate(([it, v]) => lithApp.doc.applyShownDim(it, v), [it, v]); await W(800); await idle(); await W(500); await idle(); };

let s = await S();
console.log(JSON.stringify(s));
const B = s.size; // OCC bounding box is a bit loose (fillets): compare differences
const dz = (s) => +(s.size[2] - B[2]).toFixed(2), dy = (s) => +(s.size[1] - B[1]).toFixed(2);
ok(s.links === 'Sketch1:0 Sketch2:2 Sketch3:2', '1 old converted edges linked on open: ' + s.links);
ok(/Linked 4 converted edges/.test(s.status), '1 message: ' + s.status.slice(0, 90));
ok(s.bad.length === 0 && s.g36[0] === 79, '1 rebuild ok');

await apply(await dimOf('Sketch1', "x.cons === 'c34'"), '158');
s = await S(); console.log(JSON.stringify(s));
ok(dz(s) === 10 && s.g36[0] === 84 && s.g127[0] === 74 && s.bad.length === 0, '2 Sketch1 148 → 158: body 168 long, Sketch2 + Sketch3 follow, all features ok');

await apply(await dimOf('Sketch2', "x.kind === 'auto' && Math.abs(x.value - 168) < 1e-3"), '178');
s = await S(); console.log(JSON.stringify(s));
ok(s.c34 === 168 && dz(s) === 20 && s.bad.length === 0 && /Sketch1: dimension 158 → 168 \(drives this size in Sketch2/.test(s.status), '3 Sketch2 dashed 168 → 178 drives Sketch1 c34 → 168: ' + s.status.slice(0, 100));

await apply(await dimOf('Sketch1', "x.kind === 'auto' && Math.abs(x.value - 84) < 1e-3"), '700');
s = await S(); console.log(JSON.stringify(s));
ok(Math.abs(s.c35 - 690) < 1e-3 && dy(s) === 616 && s.bad.length === 0, '4 Sketch1 dashed 84 → 700 changes c35 74 → 690 (not the 5 mm offset), cut + fillets rebuild');
await T.shot('convertlink-700');

for (let k = 0; k < 3; k++) { await win.evaluate(() => lithApp.doc.undo()); await W(400); await idle(); }
await W(800); await idle();
s = await S(); console.log(JSON.stringify(s));
ok(s.c34 === 148 && s.c35 === 74 && dz(s) === 0 && dy(s) === 0 && s.g36[0] === 79 && s.bad.length === 0, '5 undo ×3 back to 158 × 84');

// new Convert Entities in Sketch3 → On Edge
const cv = await win.evaluate(async () => {
  const d = lithApp.doc, f = d.doc.features.find((x) => x.name === 'Sketch3');
  d.editSketch(f.id); await new Promise((r) => setTimeout(r, 2500));
  const e = d.mesh.edges.find((x) => x.type === 'line' && Math.abs(x.mid[0] - 17) < 1e-6);
  const n0 = d.sketcher.sk.geo.length; d.sketcher.convertEdge(e);
  const g = d.sketcher.sk.geo.slice(n0).find((x) => x.type === 'line'), c = d.sketcher.sk.cons.find((x) => x.e === g?.id);
  d.sketcher.renderPanel?.();
  const txt = document.querySelector('#props, .props')?.textContent || '';
  d.exitSketch(false);
  return { ref: g?.onEdge?.type, cons: c?.onEdge, label: /On Edge/.test(txt) };
});
await idle();
console.log(JSON.stringify(cv));
ok(cv.ref === 'line' && cv.cons === true, '6 Convert Entities stores the link (On Edge)');

// option off: Sketch2 stays where it is
await win.evaluate(() => lithApp.applyOptions({ linkConvert: false }));
await apply(await dimOf('Sketch1', "x.cons === 'c34'"), '158');
s = await S(); console.log(JSON.stringify(s));
ok(s.g36[0] === 79, '7 option off: Sketch2 does not follow');
await win.evaluate(() => lithApp.applyOptions({ linkConvert: true }));
await win.evaluate(() => lithApp.doc.regen()); await W(500); await idle();
s = await S();
ok(s.g36[0] === 84, '7 option on again: follows on the next rebuild');
// links are stored in the file
const json = await win.evaluate(() => JSON.stringify(lithApp.doc.doc));
ok(/"onEdge":\{"type":"line"/.test(json) && /"type":"fix","e":"g36","onEdge":true|"onEdge":true/.test(json), '8 links are part of the document (saved with it)');
// 9: Wouter's sequence (18-10): frame 150 × 500 via Sketch2 dashed sizes, slot 70, slot 50 from the right edge → no errors
await win.evaluate(() => lithApp.doc.undo()); await W(500); await idle(); // back to 148
await apply(await dimOf('Sketch2', "x.kind === 'auto' && Math.abs(x.value - 84) < 1e-3"), '150');
await apply(await dimOf('Sketch2', "x.kind === 'auto' && Math.abs(x.value - 158) < 1e-3"), '500');
await apply(await dimOf('Sketch3', "x.cons === 'c123'"), '70');
await apply(await dimOf('Sketch3', "x.cons === 'c136'"), '50');
s = await S(); console.log(JSON.stringify(s));
ok(s.c34 === 490 && s.c35 === 140 && s.bad.length === 0, '9 150 × 500 frame, slot 70, slot moved 50 from the edge: chamfer + fillets still find their edges');
// 10: four views, edit Sketch3, double-click a dimension label → value box
await win.evaluate(() => lithApp.doc.setViewLayout('four')); await W(600);
await win.evaluate(() => { const d = lithApp.doc; d.editSketch(d.doc.features.find((f) => f.name === 'Sketch3').id); }); await W(2500); await idle();
const pos = await win.evaluate(() => {
  const d = lithApp.doc, sk = d.sketcher, vs = d.viewSet, pane = vs.panes[1];
  const H = sk._hitsBy?.get(pane), h = H?.dims.find((x) => x.id === 'c122') || H?.dims[0];
  if (!h) return { none: true, n: vs.panes.map((p) => sk._hitsBy?.get(p)?.dims.length) };
  const r = pane.el.getBoundingClientRect(); return { x: r.left + (h.x0 + h.x1) / 2, y: r.top + (h.y0 + h.y1) / 2, per: vs.panes.map((p) => sk._hitsBy?.get(p)?.dims.length) };
});
console.log(JSON.stringify(pos));
if (!pos.none) { await win.mouse.move(pos.x, pos.y); await win.mouse.dblclick(pos.x, pos.y); await W(500); }
const box = await win.evaluate(() => !!document.querySelector('.modify-box'));
ok(box, '10 four views: double-click a dimension in the sketch opens the value box (labels per pane ' + JSON.stringify(pos.per) + ')');
await win.evaluate(() => { document.querySelector('.modify-box')?.remove(); lithApp.doc.exitSketch(false); });
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
