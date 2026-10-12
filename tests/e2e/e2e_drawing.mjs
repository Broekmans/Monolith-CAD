// Drawing workspace: standard 3 views (third angle) of a box with a hole, auto scale, alignment,
// dragging (children follow / stay aligned), projected view, hidden lines, sheet format, title block,
// PDF export (checked by tests/e2e/check_pdf.py if python is there), save + reopen.
import { launch } from './common.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const DIR = '/tmp/drtest';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const PART = DIR + '/Block.lithprt', DOC = DIR + '/Block drawing.lithdrw', PDF = DIR + '/Block drawing.pdf';
// 100 (x) × 60 (depth) × 40 (height) mm block with a Ø30 hole through
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Block', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 100, 0), pt('p3', 100, 60), pt('p4', 0, 60),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' },
    pt('c', 50, 30), { id: 'ci', type: 'circle', c: 'c', r: 15 }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] }));
const T = await launch('drawing');
const { win, W, idle } = T;
const R = (n) => win.evaluate((n) => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === n); if (!v) return null; const sh = d.doc.sheets.find((s) => s.id === v.sheet), b = v.geom.box, s = (v.scale || sh.scale)[0] / (v.scale || sh.scale)[1]; return { pos: v.pos.map((x) => +x.toFixed(2)), w: +((b[2] - b[0]) * s).toFixed(2), h: +((b[3] - b[1]) * s).toFixed(2), mw: +(b[2] - b[0]).toFixed(2), mh: +(b[3] - b[1]).toFixed(2), edges: v.geom.edges.map((e) => e.cls).join('').replace(/(.)\1*/g, (m) => m[0] + m.length) }; }, n);
console.log('kind:', await win.evaluate(() => lithApp.doc.doc.kind), 'sheet:', JSON.stringify(await win.evaluate(() => lithApp.doc.sheet)));
await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top', 'right'], { auto: true }), PART);
await idle().catch(() => {}); await W(500);
console.log('scale chosen:', await win.evaluate(() => lithApp.doc.sheet.scale.join(':')));
const F = await R('Front'), Tp = await R('Top'), Rt = await R('Right');
console.log('front (expect model 100 x 40):', JSON.stringify(F));
console.log('top   (expect model 100 x 60, above, same x):', JSON.stringify(Tp));
console.log('right (expect model 60 x 40, right, same y):', JSON.stringify(Rt));
console.log('alignment ok:', Tp.pos[0] === F.pos[0] && Tp.pos[1] > F.pos[1] && Rt.pos[1] === F.pos[1] && Rt.pos[0] > F.pos[0]);
await T.shot('dr1_three_views');
// pressing inside a view (on the model) does not move it
const scr0 = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), A = d.affine(), s = d.S2(p, A); return [r.left + s[0], r.top + s[1]]; }, p);
{ const [a, b] = await scr0([F.pos[0] + 10, F.pos[1]]); await win.mouse.move(a, b); await win.mouse.down(); await win.mouse.move(a - 60, b - 30, { steps: 5 }); await win.mouse.up(); await W(200);
  console.log('drag inside the view (expect no move):', JSON.stringify((await R('Front')).pos), 'selected', await win.evaluate(() => lithApp.doc.V(lithApp.doc.sel)?.name)); }
// frame of the front view: left edge (box − 4 mm)
const FL = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Front'); const r = d.doc.views && v && (() => { const sh = d.sheet, b = v.geom.box, s = sh.scale[0] / sh.scale[1]; return [v.pos[0] - (b[2] - b[0]) * s / 2 - 4, v.pos[1]]; })(); return r; });
// drag the front view by its frame: children follow
const scr = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), A = d.affine(), s = d.S2(p, A); return [r.left + s[0], r.top + s[1]]; }, p);
const [x0, y0] = await scr(FL), [x1, y1] = await scr([FL[0] - 20, FL[1] - 10]);
await win.mouse.move(x0, y0); await win.mouse.down(); await win.mouse.move(x1, y1, { steps: 6 }); await win.mouse.up(); await W(300);
const F2 = await R('Front'), T2 = await R('Top'), R2 = await R('Right');
console.log('after drag front (expect -20,-10 on all):', JSON.stringify([F2.pos, T2.pos, R2.pos]));
// drag the top view sideways: stays above front (x locked)
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Top'); d.moveView(v, [v.pos[0] + 30, v.pos[1] + 5]); });
console.log('top after sideways move (x stays, y +5):', JSON.stringify((await R('Top')).pos));
// undo the mouse drag
await win.evaluate(() => lithApp.doc.undo()); await W(200);
console.log('front after undo (expect original):', JSON.stringify((await R('Front')).pos), 'orig', JSON.stringify(F.pos));
// scale of the front view goes to its projected views, which stay next to it
await win.evaluate(() => { const d = lithApp.doc; d.setViewScale(d.doc.views.find((q) => q.name === 'Front'), [1, 2]); });
const F3 = await R('Front'), T3 = await R('Top'), R3 = await R('Right');
console.log('scale 1:2 -> front/top/right sizes:', F3.w, F3.h, T3.w, T3.h, R3.w, R3.h, '| top x = front x:', T3.pos[0] === F3.pos[0], 'right y = front y:', R3.pos[1] === F3.pos[1],
  '| gaps top/right:', +(T3.pos[1] - T3.h / 2 - (F3.pos[1] + F3.h / 2)).toFixed(2), +(R3.pos[0] - R3.w / 2 - (F3.pos[0] + F3.w / 2)).toFixed(2));
await win.evaluate(() => lithApp.doc.undo()); await W(100);
console.log('undo scale -> front w:', (await R('Front')).w);
// projected view left of the front view
await win.evaluate(async () => { const d = lithApp.doc; await d.addProjected(d.doc.views.find((q) => q.name === 'Front'), 'left'); });
await idle().catch(() => {}); await W(300);
console.log('left view:', JSON.stringify(await R('Left')));
// isometric model view
await win.evaluate((p) => lithApp.doc.addViews(p, ['iso'], { auto: false }), PART); await idle().catch(() => {}); await W(300);
console.log('iso view:', JSON.stringify(await R('Isometric')));
// hidden lines on the front view (hole shows as dashed lines)
await win.evaluate(() => { const d = lithApp.doc; d.setViewProp(d.doc.views.find((q) => q.name === 'Front'), { hidden: true }); });
const dashed = await win.evaluate(() => { const { sheetPrims } = window.__drawingSheet || {}; const d = lithApp.doc; return d.pdfText().split('\n').filter((l) => /\] 0 d$/.test(l) && !/^\[\] 0 d$/.test(l)).length; });
console.log('dash switches in PDF (hidden lines on):', dashed);
// title block + sheet format
await win.evaluate(() => { const d = lithApp.doc; Object.assign(d.doc.titleBlock, { company: 'Test Company', title: 'Block', number: 'DRW-001', drawnBy: 'W. Tester', revision: 'B' }); d.renderTree(); d.vp.requestRender(); });
await W(300); await T.shot('dr2_views_titleblock');
await win.evaluate(() => { const d = lithApp.doc; d.doc.sheets[0].zones = { on: true, nx: 0, ny: 0 }; d.vp.requestRender(); });
await W(300); await T.shot('dr2b_zones');
await win.evaluate(() => { document.body.classList.add('dark'); lithApp.doc.vp.requestRender(); }); await W(300); await T.shot('dr2c_dark');
await win.evaluate(() => { document.body.classList.remove('dark'); });
await win.evaluate(() => lithApp.doc.addSheet()); await W(200);
console.log('sheets:', await win.evaluate(() => lithApp.doc.doc.sheets.map((s) => `${s.name} ${s.size} ${s.scale.join(':')}`).join(', ')));
await win.evaluate(() => lithApp.doc.showSheet(lithApp.doc.doc.sheets[0].id));
// PDF
await win.evaluate((p) => lithApp.doc.exportPdf(p), PDF); await W(500);
console.log('pdf bytes:', fs.statSync(PDF).size);
try { console.log(execFileSync('python3', ['tests/e2e/check_pdf.py', PDF], { encoding: 'utf8' })); } catch (e) { console.log('check_pdf failed:', e.stdout || e.message); }
// thumbnail + save + reopen
console.log('thumb:', await win.evaluate(() => (lithApp.doc.makeThumb() || '').slice(0, 23)));
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.toJSON())); }, DOC);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await W(800);
console.log('reopened:', await win.evaluate(() => { const d = lithApp.doc; return `${d.doc.kind} ${d.doc.sheets.length} sheets, views: ${d.doc.views.map((v) => v.name).join(', ')}, title ${d.doc.titleBlock.number}`; }));
// rebuild from the part file
await win.evaluate(() => lithApp.doc.rebuildViews()); await idle().catch(() => {}); await W(500);
console.log('after rebuild front:', JSON.stringify(await R('Front')));
await T.shot('dr3_reopened');
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
