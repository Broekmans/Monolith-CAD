// Point cloud drawings, annotations + section editing: whole scan kept (stray point 200 m away), fitted
// wall snapping (scatter), wall-to-wall dimension 30 / 20 m, corner from two fitted walls, room area,
// units m, section cut moved by offset and by dragging, view depth, flip.
// Needs: python3 tests/e2e/gen_cloud.py 3e6 ../scratch/dc/bld.laz 7 && python3 tests/e2e/gen_stray.py ../scratch/dc/bld.laz ../scratch/dc/stray.laz
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const LAZ = path.resolve('../scratch/dc/bld.laz'), STRAY = path.resolve('../scratch/dc/stray.laz'), PDF = '/tmp/dc3.pdf';
const T = await launch('drawing');
const { win, W, idle } = T;
const busy = () => idle().catch(() => {});
// 1. whole scan
await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top'], { auto: true }), STRAY); await busy();
console.log('stray views (box width ≥ 215000):', await win.evaluate(() => lithApp.doc.doc.views.map((v) => `${v.name} ${Math.round(v.geom.box[2] - v.geom.box[0])} × ${Math.round(v.geom.box[3] - v.geom.box[1])}`).join(' | ')));
// 2. plan of the building, sheet 2
await win.evaluate(() => lithApp.doc.addSheet());
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: false, preset: 'plan' }), LAZ); await busy();
await win.evaluate(() => { const d = lithApp.doc; d.sheet.scale = [1, 200]; d.zoomTo(d.doc.views.filter((q) => q.sheet === d.sheetId)[0]); }); await busy(); await W(500);
await win.evaluate(() => lithApp.doc.refreshCloudViews()); await busy(); await W(300);
const V = 'lithApp.doc.doc.views.filter((q) => q.sheet === lithApp.doc.sheetId)[0]';
console.log('plan:', await win.evaluate(`(() => { const v = ${V}; return JSON.stringify({ fit: v.geom.fit.n, cell: +v.geom.fit.cell.toFixed(1), scale: lithApp.doc.sheet.scale }); })()`));
const snap = (q) => win.evaluate(`((q) => { const d = lithApp.doc, v = ${V}; const s = d.snapAt(d.toSheetPt(v, q), v.id); if (!s) return null; return s.e ? { kind: s.kind, sigma: +s.e.fit.sigma.toFixed(1), n: s.e.fit.n, foot: s.q.map(Math.round), dir: s.e.fit.dir.map((x) => +x.toFixed(4)) } : { kind: s.kind, corner: !!s.corner, q: s.q.map(Math.round) }; })(${JSON.stringify(q)})`);
console.log('snap west wall (x ≈ -15000, ±3 mm):', JSON.stringify(await snap([-14990, 2000])));
console.log('snap north wall (y ≈ 10000):', JSON.stringify(await snap([3000, 9985])));
console.log('snap corner (-15000, -10000):', JSON.stringify(await snap([-14985, -9985])));
// 2b. calm snapping: 50 cursor positions along / across the west wall band must give the same axis line
console.log('steady snap (spread x ≤ 2 mm, all on axis, n=50):', await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}; d._lastFit = null; const xs = [], dirs = new Set(); for (let i = 0; i < 50; i++) { const q = [-15000 + ((i * 37) % 21 - 10) * 12, -8000 + i * 320]; const s = d.snapAt(d.toSheetPt(v, q), v.id); if (s && s.e) { xs.push(s.q[0]); dirs.add(s.e.fit.dir.join(',')); } } return JSON.stringify({ n: xs.length, spread: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), dirs: [...dirs] }); })()`));
for (const m of ['axis', 'any']) { await win.evaluate((m) => { lithApp.doc.doc.snapMode = m; lithApp.doc._lastFit = null; }, m); console.log('mode', m, JSON.stringify(await snap([-14990, 2000]))); }
await win.evaluate(() => { lithApp.doc.doc.snapMode = 'first'; lithApp.doc._lastFit = null; });
// 3. wall-to-wall dimensions with the tool
const dim = async (a, b, at) => win.evaluate(`((a, b, at) => { const d = lithApp.doc, v = ${V}, S = (q) => d.toSheetPt(v, q); d.cmdDimension(); d.tool.click(S(a)); d.tool.click(S(b)); d.tool.click(S(at)); const ann = v.anns[v.anns.length - 1]; d.endTool(); return ann ? { type: ann.type, a: ann.a.map(Math.round), b: ann.b.map(Math.round), fit: ann.fit && +ann.fit.sigma.toFixed(1) } : null; })(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(at)})`);
const D1 = await dim([-14990, 2000], [14990, 1000], [0, 4000]);
const D2 = await dim([3000, 9990], [2000, -9990], [5000, 0]);
const val = (D) => Math.hypot(D.b[0] - D.a[0], D.b[1] - D.a[1]);
console.log('width (30000 ± 2):', JSON.stringify(D1), Math.round(val(D1)), ' depth (20000 ± 2):', JSON.stringify(D2), Math.round(val(D2)));
// 4. room
const room = await win.evaluate(`(async () => { const d = lithApp.doc, v = ${V}; d.cmdRoom(); await d.tool.click(d.toSheetPt(v, [1000, 1500])); d.endTool(); const a = v.anns.find((q) => q.type === 'area'); return a ? { label: a.label, pts: a.pts.map((q) => q.map(Math.round)) } : null; })()`);
const area = await win.evaluate(`(() => { const v = ${V}; const a = v.anns.find((q) => q.type === 'area'); let A = 0; const p = a.pts; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; A += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(A) / 2e6; })()`);
console.log('room (≈ 600 m²):', JSON.stringify(room), area.toFixed(2));
console.log('room offset −100 (29.8 × 19.8 = 590.04):', await win.evaluate(`(async () => { const d = lithApp.doc, v = ${V}, a = v.anns.find((q) => q.type === 'area'); (a.style ||= {}).offset = -100; await d.recomputeRoom(v, a); let A = 0; const p = a.pts; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; A += p[i][0] * q[1] - q[0] * p[i][1]; } return (Math.abs(A) / 2e6).toFixed(2) + ' corners ' + p.length; })()`));
// 4b. room on a full-depth (x-ray) top view: hidden floor-plan slice is used
await win.evaluate(() => lithApp.doc.addSheet());
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: false, preset: 'full' }), LAZ); await busy();
await win.evaluate(() => { const d = lithApp.doc; d.sheet.scale = [1, 200]; }); await win.evaluate(() => lithApp.doc.refreshCloudViews()); await busy();
console.log('room on x-ray top view (≈ 600 m², clip off):', await win.evaluate(`(async () => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; d.cmdRoom(); await d.tool.click(d.toSheetPt(v, [1000, 1500])); d.endTool(); const a = (v.anns || []).find((q) => q.type === 'area'); return JSON.stringify({ clip: v.cloud.clip.on, area: a ? +(Math.abs(a.pts.reduce((s, p, i, P) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0)) / 2e6).toFixed(2) : null, label: a && a.label }); })()`));
await win.evaluate(() => { const d = lithApp.doc; d.sheetId = d.doc.sheets[1].id; });
// 5. units m
await win.evaluate(() => { const d = lithApp.doc; d.change(() => { d.doc.dimUnits = 'm'; d.doc.dimDec = 3; }); });
await T.shot('dc3_annotations');
// 6. section through the plan at x = 0, then move it 5 m by offset and drag
const cut = await win.evaluate(`(() => { const d = lithApp.doc, v = ${V}; return [d.toSheetPt(v, [0, -12000]), d.toSheetPt(v, [0, 12000]), v.pos]; })()`);
await win.evaluate(() => lithApp.doc.cmdSection()); await W(150);
await win.evaluate((p) => lithApp.doc.tool.click(p), cut[0]); await W(150);
await win.evaluate((p) => lithApp.doc.tool.click(p), cut[1]); await busy(); await W(200);
await win.evaluate((p) => { lithApp.doc.tool.move(p); lithApp.doc.tool.click(p); }, [cut[2][0] + 110, cut[2][1] + 40]); await busy(); await W(300);
const S = () => win.evaluate(() => { const v = lithApp.doc.doc.views.find((q) => q.cut); return { p: v.plane.p.map(Math.round), n: v.plane.n.map((x) => +x.toFixed(3)), off: v.cut.off || 0, a: v.cut.a.map(Math.round), w: v.geom.raster?.w, ink: (() => { return v.geom.raster ? v.geom.raster.png.length : 0; })() }; });
console.log('section placed:', JSON.stringify(await S()));
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.cut); d.setCutOffset(v, 5000); }); await busy(); await W(300);
console.log('offset 5 m:', JSON.stringify(await S()));
// drag the cutting line 10 mm on paper (= 2 m at 1:200)
const line = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.cut), par = d.V(v.parent), A = d.toSheetPt(par, v.cut.a), B = d.toSheetPt(par, v.cut.b); return [A[0] + (B[0] - A[0]) * 0.2, A[1] + (B[1] - A[1]) * 0.2]; });
const scr = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.S2(p, d.affine()); return [r.left + s[0], r.top + s[1]]; }, p);
const [x0, y0] = await scr(line), [x1, y1] = await scr([line[0] + 10, line[1]]);
await win.mouse.move(x0, y0); await win.mouse.down(); await win.mouse.move(x1, y1, { steps: 5 }); await win.mouse.up(); await busy(); await W(400);
console.log('after drag (+2 m or -2 m along the normal):', JSON.stringify(await S()), 'selected', await win.evaluate(() => lithApp.doc.V(lithApp.doc.sel)?.name));
await win.evaluate(() => lithApp.doc.undo()); await W(200);
console.log('undo drag:', JSON.stringify(await S()));
// view depth: slice only vs everything behind the cut
const inkSum = () => win.evaluate(async () => { const v = lithApp.doc.doc.views.find((q) => q.cut), r = v.geom.raster, img = new Image(); img.src = 'data:image/png;base64,' + r.png; await img.decode(); const c = document.createElement('canvas'); c.width = r.w; c.height = r.h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const dd = x.getImageData(0, 0, r.w, r.h).data; let n = 0; for (let i = 0; i < dd.length; i += 4) if (dd[i] > 0) n++; return n; });
const n0 = await inkSum();
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.cut); d.change(() => { v.cloud = { ...v.cloud, depth: 1000 }; }); return d.refreshCloudViews([v]); }); await busy(); await W(300);
const n1 = await inkSum();
console.log('pixels with points: slice', n0, '→ view depth all', n1, n1 > n0 * 1.5);
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.cut); d.flipSection(v); }); await busy(); await W(300);
console.log('flipped n:', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.views.find((q) => q.cut).plane.n.map((x) => +x.toFixed(3)))));
await win.evaluate(() => lithApp.doc.select(lithApp.doc.doc.views.find((q) => q.cut).id)); await W(300);
await T.shot('dc3_section_selected');
await win.evaluate((p) => lithApp.doc.exportPdf(p), PDF); await W(300);
try { const t = execFileSync('pdftotext', ['-enc', 'UTF-8', PDF, '-'], { encoding: 'utf8' }); console.log('pdf texts:', ['30', '20', 'Room 1', 'm²', 'THIRD ANGLE · m'].map((k) => `${k}:${t.includes(k)}`).join(' ')); } catch (e) { console.log('pdftotext', e.message); }
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
