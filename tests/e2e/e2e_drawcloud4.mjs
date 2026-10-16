// Point cloud drawings 0.1.49: door opening width (1.0 m gap in the west wall), chain dimension along the
// wall (5 / 1 / 14 m + overall 20 m), part overlay from doc.partAlign (translation and 90° rotation).
// Needs: gen_cloud.py 3e6 ../scratch/dc/bld.laz 7 && gen_door.py ../scratch/dc/bld.laz ../scratch/dc/door.laz
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const DIR = '/tmp/dc4'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const DOOR = path.resolve('../scratch/dc/door.laz'), PART = DIR + '/Cabinet.lithprt', PCD = DIR + '/Building.lithpcd';
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Cabinet', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 2000, 0), pt('p3', 2000, 1200), pt('p4', 0, 1200),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 800, end: 'blind', op: 'boss' }] }));
const mT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 0.5, 1]; // translate 2 m, 3 m, 0.5 m (doc frame)
const mR = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 2, 3, 0.5, 1]; // + 90° about Z
const writePcd = (m) => fs.writeFileSync(PCD, JSON.stringify({ kind: 'cloud', version: 1, name: 'Building', origin: null, clouds: [{ id: 'pc1', name: 'door', path: DOOR, visible: true }], partAlign: { [PART]: m }, view: {} }));
writePcd(mT);
const T = await launch('drawing');
const { win, W, idle } = T;
const busy = () => idle().catch(() => {});
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: false, preset: 'plan' }), PCD); await busy();
await win.evaluate(() => { const d = lithApp.doc; d.sheet.scale = [1, 200]; d.zoomTo(d.doc.views[0]); }); await W(300);
await win.evaluate(() => lithApp.doc.refreshCloudViews()); await busy(); await W(300);
const V = 'lithApp.doc.doc.views[0]';
// 1. opening
const op = await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}; const s = d.snapAt(d.toSheetPt(v, [-15000, -4500]), v.id); return s?.e?.opening ? { w: Math.round(s.e.opening.width), a: s.e.opening.a.map(Math.round), b: s.e.opening.b.map(Math.round) } : JSON.stringify(s && { kind: s.kind }); })()`);
console.log('opening (1000 ± 5, from y -5000 to -4000):', JSON.stringify(op));
const dimOp = await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}, S = (q) => d.toSheetPt(v, q); d.cmdDimension(); d.tool.click(S([-15000, -4500])); d.tool.click(S([-16500, -4500])); d.endTool(); const a = v.anns[v.anns.length - 1]; return a && Math.round(Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1])); })()`);
console.log('opening dimension:', dimOp);
// 2. chain along the west wall: corner, opening, corner
const chain = await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}, S = (q) => d.toSheetPt(v, q); d.cmdDimension(); const cb = d.app.pm.current.inputs.chain; cb.checked = true; cb.dispatchEvent(new Event('change'));
  const n0 = v.anns.length; d.tool.click(S([-14985, -9985])); d.tool.click(S([-15000, -4500])); d.tool.click(S([-14985, 9985])); d.tool.key({ key: 'Enter' }); d.tool.click(S([-17500, 0])); d.endTool();
  return v.anns.slice(n0).map((a) => a.mode + ':' + Math.round(Math.abs(a.mode === 'v' ? a.b[1] - a.a[1] : Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1])))); })()`);
console.log('chain (v:5000 v:1000 v:14000 v:20000):', JSON.stringify(chain));
// 3. overlay (translation): top view of the part alone gives its own box
await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}; d.change(() => { v.cloud = { ...v.cloud, overlay: ${JSON.stringify(PART)} }; }); return d.refreshCloudViews([v]); })()`); await busy(); await W(300);
const ov = () => win.evaluate(`(() => { const v = ${V}, e = v.geom.edges.filter((q) => q.ov); if (!e.length) return { err: v.geom.info.overlayError, aligned: v.geom.info.aligned }; let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of e) for (let i = 0; i < q.pts.length; i += 2) { a[0] = Math.min(a[0], q.pts[i]); a[1] = Math.min(a[1], q.pts[i + 1]); a[2] = Math.max(a[2], q.pts[i]); a[3] = Math.max(a[3], q.pts[i + 1]); } return { n: e.length, box: a.map(Math.round) }; })()`);
console.log('overlay translated (part box shifted by u +2000, w +3000):', JSON.stringify(await ov()));
await win.evaluate((p) => lithApp.doc.addSheet(), null);
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: false }), PART); await busy();
console.log('part alone top box:', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.views.at(-1).geom.box.map(Math.round))));
await win.evaluate(() => lithApp.doc.showSheet(lithApp.doc.doc.sheets[0].id));
writePcd(mR);
await win.evaluate(() => lithApp.doc.rebuildViews()); await busy(); await W(300);
console.log('overlay rotated 90° (width/height swapped):', JSON.stringify(await ov()));
await win.evaluate(() => lithApp.doc.zoomTo(lithApp.doc.doc.views[0])); await W(500);
await T.shot('dc4_overlay');
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
