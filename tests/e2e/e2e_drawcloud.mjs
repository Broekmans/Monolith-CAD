// Point cloud views in drawings: standard 3 views of a scan (synthetic 30×20 m building, 3 floors,
// walls 10.5 m), auto scale, true size, floor plan slice 1.0–1.3 m above the floor (walls only), colour
// modes, projected view, .lithpcd source with a transform, PDF size + scale, save/reopen, rebuild.
// Needs: python3 tests/e2e/gen_cloud.py 3e6 ../scratch/dc/bld.laz 7
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const DIR = '/tmp/dctest';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const LAZ = path.resolve('../scratch/dc/bld.laz'), PCD = DIR + '/Building.lithpcd', PDF = DIR + '/scan.pdf', DOC = DIR + '/scan.lithdrw';
fs.writeFileSync(PCD, JSON.stringify({ kind: 'cloud', version: 1, name: 'Building', origin: null, clouds: [{ id: 'pc1', name: 'bld', path: LAZ, visible: true, transform: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [1, 0, 0] } }], view: {} }));
const T = await launch('drawing');
const { win, W, idle } = T;
const info = (n) => win.evaluate((n) => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === n); if (!v) return null; const b = v.geom.box; return { pos: v.pos.map((x) => +x.toFixed(1)), box: b.map((x) => Math.round(x)), dots: v.geom.dots.n, src: v.srcName }; }, n);
console.time('3 views');
await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top', 'right'], { auto: true, cloud: { color: 'black', size: 0.25, density: 'normal' } }), LAZ);
await idle().catch(() => {}); console.timeEnd('3 views');
console.log('scale:', await win.evaluate(() => lithApp.doc.sheet.scale.join(':')));
const F = await info('Front'), Tp = await info('Top'), R = await info('Right');
console.log('front (≈ 30000 × 10500):', JSON.stringify(F), (F.box[2] - F.box[0]), (F.box[3] - F.box[1]));
console.log('top   (≈ 30000 × 20000):', JSON.stringify(Tp), (Tp.box[2] - Tp.box[0]), (Tp.box[3] - Tp.box[1]));
console.log('right (≈ 20000 × 10500):', JSON.stringify(R), (R.box[2] - R.box[0]), (R.box[3] - R.box[1]));
console.log('aligned:', Tp.pos[0] === F.pos[0] && R.pos[1] === F.pos[1]);
// true size on the sheet: dots extent of the top view in sheet mm
const ext = (n) => win.evaluate((n) => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === n); const { sheetPrims } = d.__sheet || {}; const D = v.geom.dots; const sh = d.sheet, s = sh.scale[0] / sh.scale[1]; let a = Infinity, b = -Infinity; const q = D.q; const raw = atob(D.xy); for (let i = 0; i < D.n; i++) { const x = raw.charCodeAt(i * 4) | (raw.charCodeAt(i * 4 + 1) << 8); const X = q[0] + x * q[2]; a = Math.min(a, X); b = Math.max(b, X); } return +((b - a) * s).toFixed(2); }, n);
console.log('top view dots width on paper (expect 150 mm at 1:200):', await ext('Top'));
await T.shot('dc1_three');
// floor plan slice
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Top'); d.setCloudClip(v, { on: true, ref: 'floor', from: 1.0, to: 1.3 }); });
await idle().catch(() => {}); await W(300);
const wallFrac = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Top'), D = v.geom.dots, q = D.q, raw = atob(D.xy); let ok = 0; for (let i = 0; i < D.n; i++) { const X = q[0] + (raw.charCodeAt(i * 4) | (raw.charCodeAt(i * 4 + 1) << 8)) * q[2], Y = q[1] + (raw.charCodeAt(i * 4 + 2) | (raw.charCodeAt(i * 4 + 3) << 8)) * q[3]; if (Math.min(Math.abs(Math.abs(X) - 15000), Math.abs(Math.abs(Y) - 10000)) < 100) ok++; } return { n: D.n, wall: +(ok / D.n).toFixed(4), floor: Math.round(v.geom.info.floor - v.geom.info.dMin), box: v.geom.box.map(Math.round) }; });
console.log('slice 1.0–1.3 m above floor (expect wall fraction 1, floor ≈ 0):', JSON.stringify(wallFrac));
// colours + size
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Front'); d.setViewProp(v, { cloud: { ...v.cloud, color: 'rgb', size: 0.35 } }); const r = d.doc.views.find((q) => q.name === 'Right'); d.setViewProp(r, { cloud: { ...r.cloud, color: 'grey' } }); });
await W(300); await T.shot('dc2_slice_colours');
// projected left of the front view
await win.evaluate(() => { const d = lithApp.doc; return d.addProjected(d.doc.views.find((q) => q.name === 'Front'), 'left'); }); await idle().catch(() => {});
console.log('left view:', JSON.stringify(await info('Left')));
// .lithpcd source with a 1 m shift
await win.evaluate(() => lithApp.doc.addSheet());
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: true, cloud: { color: 'black', size: 0.25, density: 'normal' } }), PCD); await idle().catch(() => {});
const P = await info('Top').then(() => win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; return { box: v.geom.box.map(Math.round), src: v.srcName, scale: d.sheet.scale.join(':') }; }));
console.log('lithpcd top (doc origin = scan centre, shifted 1 m: box x ≈ -14000..16000):', JSON.stringify(P));
// scale change recomputes the density
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; d.setViewScale(v, [1, 100]); }); await idle().catch(() => {}); await W(500);
console.log('after 1:100:', await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; return `dots ${v.geom.dots.n}, s ${v.geom.dots.s}`; }));
// title block names
console.log('title block models:', await win.evaluate(() => { const d = lithApp.doc; return d.doc.sheets.map((sh) => [...new Set(d.doc.views.filter((v) => v.sheet === sh.id).map((v) => v.srcName))].join(',')).join(' | '); }));
// PDF
console.time('pdf');
await win.evaluate((p) => lithApp.doc.exportPdf(p), PDF); console.timeEnd('pdf'); await W(300);
console.log('pdf bytes:', fs.statSync(PDF).size);
// save + reopen + rebuild
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.toJSON())); }, DOC);
console.log('drawing file bytes:', fs.statSync(DOC).size);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await W(800);
await win.evaluate(() => lithApp.doc.showSheet(lithApp.doc.doc.sheets[0].id)); await W(300);
await T.shot('dc3_reopened');
await win.evaluate(() => lithApp.doc.rebuildViews()); await idle().catch(() => {});
console.log('after rebuild top:', JSON.stringify(await info('Top')));
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
