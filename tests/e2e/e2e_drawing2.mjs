// Drawing part 2: projected view by dragging (incl. diagonal = isometric), section view A–A with hatch,
// Smart Dimension by mouse (line length, circle diameter, angle), area, note, moving / deleting an
// annotation, PDF text. Uses the block-with-hole part of e2e_drawing.
import { launch } from './common.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const DIR = '/tmp/drtest2';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const PART = DIR + '/Block.lithprt', PDF = DIR + '/Block2.pdf';
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Block', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 100, 0), pt('p3', 100, 60), pt('p4', 0, 60),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' },
    pt('c', 50, 30), { id: 'ci', type: 'circle', c: 'c', r: 15 }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] }));
const T = await launch('drawing');
const { win, W, idle } = T;
const busy = async () => { await W(300); await win.waitForFunction(() => !lithApp.doc.busy, null, { timeout: 60000 }); await W(200); };
// sheet mm -> screen
const S = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.S2(p, d.affine()); return [r.left + s[0], r.top + s[1]]; }, p);
const click = async (p) => { const [x, y] = await S(p); await win.mouse.move(x - 3, y - 3); await win.mouse.move(x, y, { steps: 3 }); await W(80); await win.mouse.down(); await win.mouse.up(); await W(150); };
const hover = async (p) => { const [x, y] = await S(p); await win.mouse.move(x, y, { steps: 3 }); await W(120); };
// model point of a view -> sheet
const MS = (name, q) => win.evaluate(({ name, q }) => { const d = lithApp.doc, v = d.doc.views.find((x) => x.name === name); return d.toSheetPt(v, q); }, { name, q });
await win.evaluate(() => { lithApp.doc.doc.sheets[0].size = 'A2'; lithApp.doc.zoomFit(false); });
await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top'], { auto: false }).then(() => { const d = lithApp.doc, f = d.doc.views.find((v) => v.name === 'Front'), t = d.doc.views.find((v) => v.name === 'Top'); f.pos = [200, 200]; t.pos = [200, 300]; }), PART); await busy();
await win.evaluate(() => { const d = lithApp.doc; d.doc.sheets[0].scale = [1, 1]; d.vp.requestRender(); });
const front = await win.evaluate(() => lithApp.doc.doc.views.find((v) => v.name === 'Front').pos);
console.log('front at', JSON.stringify(front));
// ---- projected view by dragging: right, then diagonal (isometric) ----
await win.evaluate(() => { const d = lithApp.doc; d.select(d.doc.views.find((v) => v.name === 'Front').id); d.cmdProjected(); }); await busy();
await hover([front[0] + 120, front[1] + 15]);
console.log('preview right:', await win.evaluate(() => (lithApp.doc.preview || []).length > 0));
await click([front[0] + 120, front[1] + 15]);
await hover([front[0] + 160, front[1] + 200]);
await click([front[0] + 160, front[1] + 200]);
await win.keyboard.press('Escape'); await W(200);
console.log('views:', await win.evaluate(() => lithApp.doc.doc.views.map((v) => `${v.name}${v.side ? '(' + v.side + ')' : ''} @${v.pos.map((x) => x.toFixed(0)).join(',')}`).join(' | ')));
console.log('right view aligned with front:', await win.evaluate(() => { const d = lithApp.doc, f = d.doc.views.find((v) => v.name === 'Front'), r = d.doc.views.find((v) => v.name === 'Right'); return r && r.pos[1] === f.pos[1]; }));
console.log('iso dir:', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.views.find((v) => v.name === 'Isometric')?.dir.map((x) => +x.toFixed(3)))));
// ---- section A-A: horizontal cut through the top view at the hole centre, looking from the front ----
const tA = await MS('Top', [-10, 30]), tB = await MS('Top', [110, 30]);
const topBox = await win.evaluate(() => lithApp.doc.doc.views.find((v) => v.name === 'Top').geom.box);
console.log('top box', JSON.stringify(topBox.map((x) => +x.toFixed(1))));
const yc = (topBox[1] + topBox[3]) / 2;
const A = await MS('Top', [topBox[0] - 10, yc]), B = await MS('Top', [topBox[2] + 10, yc + 0.5]);
await win.evaluate(() => lithApp.doc.cmdSection());
await click(A); console.log('after A:', await win.evaluate(() => [lithApp.doc.app.pm.current?.inputs?.msg?.textContent, !!lithApp.doc.tool, document.querySelector('.toast')?.textContent].join(' | ')));
await click(B); await busy();
console.log('after B:', await win.evaluate(() => [lithApp.doc.app.pm.current?.inputs?.msg?.textContent, !!lithApp.doc.tool, document.querySelector('.toast')?.textContent].join(' | ')));
const topPos = await win.evaluate(() => lithApp.doc.doc.views.find((v) => v.name === 'Top').pos);
await hover([topPos[0], topPos[1] + 80]);
await win.evaluate((p) => lithApp.doc.tool.click(p), [topPos[0], topPos[1] + 80]); await busy(); // (point is off screen at this zoom)
void tA; void tB;
console.log('section:', await win.evaluate(() => { const v = lithApp.doc.doc.views.find((q) => q.cut); return v && `${v.name} side ${v.side} hatch faces ${v.geom.hatch.length} box ${v.geom.box.map((x) => x.toFixed(1)).join(',')}`; }));
// ---- Smart Dimension by mouse ----
const fBox = await win.evaluate(() => lithApp.doc.doc.views.find((v) => v.name === 'Front').geom.box);
await win.evaluate(() => lithApp.doc.cmdDimension());
// bottom edge of the front view, placed below it
const e1 = await MS('Front', [(fBox[0] + fBox[2]) / 2 + 20, fBox[1]]);
await hover(e1); await click(e1); await click([e1[0], e1[1] - 15]);
// right edge (height), placed right
const e2 = await MS('Front', [fBox[2], (fBox[1] + fBox[3]) / 2 + 5]);
await click(e2); await click([e2[0] + 15, e2[1]]);
// hole circle in the top view: diameter
const c1 = await MS('Top', [(topBox[0] + topBox[2]) / 2 + 15, yc]);
await click(c1); await click([c1[0] + 25, c1[1] + 20]);
// angle between the top and right edges of the front view
const e3 = await MS('Front', [(fBox[0] + fBox[2]) / 2 - 20, fBox[3]]);
await click(e3); await click(e2); await click([e2[0] - 10, e3[1] - 10]);
await win.keyboard.press('Escape'); await W(200);
console.log('dims:', await win.evaluate(() => lithApp.doc.doc.views.flatMap((v) => (v.anns || []).map((a) => `${v.name}:${a.type}${a.mode ? '/' + a.mode : ''}`)).join(', ')));
// ---- area of the top view outline (4 corners) + note ----
await win.evaluate(() => lithApp.doc.cmdArea());
for (const q of [[topBox[0], topBox[1]], [topBox[2], topBox[1]], [topBox[2], topBox[3]], [topBox[0], topBox[3]]]) await click(await MS('Top', q));
await win.keyboard.press('Enter'); await W(100);
const lab = await MS('Top', [topBox[2] + 5, topBox[3] + 10]); await hover(lab); await click(lab);
await win.keyboard.press('Escape'); await W(150);
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Front'); d.addAnn(v, { type: 'note', text: 'ALL EDGES 0.5 x 45°', at: [v.geom.box[0], v.geom.box[1] - 30], anchor: null }); });
// ---- values in the PDF text ----
await win.evaluate((p) => lithApp.doc.exportPdf(p), PDF); await W(400);
const txt = execFileSync('pdftotext', ['-layout', PDF, '-'], { encoding: 'utf8' });
for (const want of ['100', '40', 'Ø30', '90°', 'A = 0.006 m²', 'SECTION A-A', 'ALL EDGES']) console.log(`pdf has "${want}":`, txt.includes(want));
await T.shot('dr4_annotations');
// ---- move an annotation by its text, delete one, undo ----
const n0 = await win.evaluate(() => lithApp.doc.doc.views.reduce((a, v) => a + (v.anns || []).length, 0));
const box = await win.evaluate(() => { const b = lithApp.doc._annBoxes.find((q) => q.t === 'annbox'); return b && { box: b.box, id: b.ann }; });
const mid = [(box.box[0] + box.box[2]) / 2, (box.box[1] + box.box[3]) / 2];
const [mx, my] = await S(mid), [nx, ny] = await S([mid[0] + 10, mid[1] - 5]);
await win.mouse.move(mx, my); await win.mouse.down(); await win.mouse.move(nx, ny, { steps: 5 }); await win.mouse.up(); await W(200);
console.log('selected annotation:', await win.evaluate(() => lithApp.doc.selAnn?.id), 'was', box.id);
await win.keyboard.press('Delete'); await W(200);
const n1 = await win.evaluate(() => lithApp.doc.doc.views.reduce((a, v) => a + (v.anns || []).length, 0));
await win.evaluate(() => lithApp.doc.undo()); await W(200);
const n2 = await win.evaluate(() => lithApp.doc.doc.views.reduce((a, v) => a + (v.anns || []).length, 0));
console.log('annotations before/after delete/undo:', n0, n1, n2);
// rebuild keeps the section
await win.evaluate(() => lithApp.doc.rebuildViews()); await busy();
console.log('after rebuild section hatch faces:', await win.evaluate(() => lithApp.doc.doc.views.find((q) => q.cut).geom.hatch.length));
await win.evaluate(() => { document.body.classList.add('dark'); lithApp.doc.vp.requestRender(); }); await T.shot('dr5_dark');
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
