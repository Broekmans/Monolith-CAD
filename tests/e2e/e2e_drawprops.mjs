// Selection popup (0.1.55): click a dimension -> popup with its settings, changes are undoable, empty click /
// Esc closes, clicking a room / area outline switches to it; Drafting Standard: drawing defaults, company
// standard file (MONOLITH_STD), import. Uses a simple block part.
import { launch } from './common.mjs';
import fs from 'node:fs';
const DIR = '/tmp/drprops';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
process.env.MONOLITH_STD = DIR + '/drafting-standard.json';
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const PART = DIR + '/Block.lithprt';
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Block', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 100, 0), pt('p3', 100, 60), pt('p4', 0, 60),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] }));
const T = await launch('drawing');
const { win, W } = T;
const busy = async () => { await W(300); await win.waitForFunction(() => !lithApp.doc.busy, null, { timeout: 60000 }); await W(200); };
const S = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.S2(p, d.affine()); return [r.left + s[0], r.top + s[1]]; }, p);
const click = async (p) => { const [x, y] = await S(p); await win.mouse.move(x, y, { steps: 2 }); await W(60); await win.mouse.down(); await win.mouse.up(); await W(200); };
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: false }).then(() => { lithApp.doc.doc.views[0].pos = [200, 150]; }), PART); await busy();
await win.evaluate(() => { const d = lithApp.doc; d.zoomTo(d.doc.views[0]); });
await W(400);
// a length dimension 100 mm and an area outline
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0]; d.addAnn(v, { type: 'len', a: [0, 60], b: [100, 60], mode: 'h', at: [50, 75] }); d.addAnn(v, { type: 'area', pts: [[0, 0], [100, 0], [100, 60], [0, 60]], at: [120, -10], label: 'Room 1', room: true }); d.vp.requestRender(); });
await W(300);
const box = (i) => win.evaluate((i) => { const d = lithApp.doc, a = d.doc.views[0].anns[i]; const b = d._annBoxes.find((q) => q.t === 'annbox' && q.ann === a.id).box; return b; }, i);
const pop = () => win.evaluate(() => { const el = document.querySelector('.ann-props'); return el ? { head: el.querySelector('.ap-head b').textContent, secs: [...el.querySelectorAll('.ap-sec')].map((x) => x.textContent), sel: lithApp.doc.selAnn?.id } : null; });
let b = await box(0);
await click([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
console.log('1 popup on dimension:', JSON.stringify(await pop()));
const h0 = b[3] - b[1];
// text height 5 via the popup select
await win.evaluate(() => { const s = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Text height')).querySelector('select'); s.value = '5'; s.dispatchEvent(new Event('change')); });
await W(200); b = await box(0);
console.log('2 text height 5: style', JSON.stringify(await win.evaluate(() => lithApp.doc.doc.views[0].anns[0].style)), 'box h', +(b[3] - b[1]).toFixed(2), 'was', +h0.toFixed(2), 'popup still open', !!(await pop()));
// offset 20 mm
await win.evaluate(() => { const i = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Dimension line offset')).querySelector('input'); i.value = '20'; i.dispatchEvent(new Event('change')); });
await W(150);
console.log('3 offset 20 → at y (60 + 20 = 80):', await win.evaluate(() => lithApp.doc.doc.views[0].anns[0].at[1].toFixed(2)));
// suffix + colour; Delete key inside a field must not delete the dimension
await win.evaluate(() => { const i = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Suffix')).querySelector('input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); i.value = ' TYP'; i.dispatchEvent(new Event('change')); const c = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Line colour')).querySelector('input'); c.value = '#d01010'; c.dispatchEvent(new Event('change')); });
await W(150);
console.log('4 suffix/colour:', JSON.stringify(await win.evaluate(() => { const a = lithApp.doc.doc.views[0].anns[0]; return { n: lithApp.doc.doc.views[0].anns.length, suffix: a.suffix, line: a.style.lineColor, text: lithApp.doc._annBoxes.length }; })),
  'pdf text:', await win.evaluate(() => /100 TYP/.test(lithApp.doc.pdfText ? lithApp.doc.pdfText() : '') ));
// undo x4 → back to plain; popup closes on undo
for (let i = 0; i < 4; i++) await win.evaluate(() => lithApp.doc.undo());
await W(150);
console.log('5 after 4 undo: style', JSON.stringify(await win.evaluate(() => lithApp.doc.doc.views[0].anns[0].style || null)), 'popup', JSON.stringify(await pop()));
// select again, click empty paper → closes
b = await box(0); await click([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
const opened = !!(await pop());
await click([262, 110]);
console.log('6 open then empty click → closed:', opened, (await pop()) === null);
// click on the room outline (its line, not the text) → popup switches to the room
const edge = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0]; return d.toSheetPt(v, [50, 0]); });
b = await box(0); await click([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
const covered = await win.evaluate(async (p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.S2(p, d.affine()); const e = document.elementFromPoint(r.left + s[0], r.top + s[1]); return !!e?.closest('.ann-props'); }, edge);
console.log('   popup covers the edge point:', covered);
if (covered) await click([262, 110]);
await click(edge);
console.log('   annAt(edge):', JSON.stringify(await win.evaluate((p) => lithApp.doc.annAt(p), edge)), JSON.stringify(edge), await win.evaluate(() => lithApp.doc._annBoxes.map((q) => q.t + ':' + (q.view || '-')).join(',')));
console.log('7 outline click → room popup:', JSON.stringify(await pop()));
await win.evaluate(() => { const s = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Line type')).querySelector('select'); s.value = 'solid'; s.dispatchEvent(new Event('change')); });
await W(100);
console.log('   outline solid:', await win.evaluate(() => { const d = lithApp.doc; const p = d.doc.views[0].anns[1]; return p.style?.outlineDash; }));
await T.shot('drawprops_room');
await win.mouse.move(5, 5); await win.keyboard.press('Escape'); await W(150);
console.log('8 Esc closes:', (await pop()) === null);
await T.shot('drawprops');
// ---- 0.1.58: drag the box by its title (position remembered), edit the outline by hand ----
const M = (q) => win.evaluate((q) => { const d = lithApp.doc; return d.toSheetPt(d.doc.views[0], q); }, q);
const drag = async (a, b, opts = {}) => { const [x0, y0] = await S(a), [x1, y1] = await S(b); await win.mouse.move(x0, y0, { steps: 2 }); await W(60); await win.mouse.down(); await win.mouse.move(x1, y1, { steps: 8 }); await W(60); await win.mouse.up(); await W(200); };
const ar = () => win.evaluate(() => Math.round(Math.abs(lithApp.doc.doc.views[0].anns[1].pts.reduce((s, p, i, P) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0)) / 2));
await click(await M([50, 0]));
const head = await win.evaluate(() => { const r = document.querySelector('.ann-props .ap-head').getBoundingClientRect(); return [r.left + 40, r.top + 10]; });
const host = await win.evaluate(() => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
await win.mouse.move(head[0], head[1]); await win.mouse.down(); await win.mouse.move(host[0] + 60, host[1] + 30, { steps: 6 }); await win.mouse.up(); await W(150);
const pos1 = await win.evaluate(() => [document.querySelector('.ann-props').offsetLeft, localStorage.getItem('monolith.propsPos')]);
await click([262, 110]); b = await box(0); await click([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
console.log('13 box dragged, saved', pos1[1], '; next box opens at the same left:', (await win.evaluate(() => document.querySelector('.ann-props').offsetLeft)) === pos1[0]);
await click([262, 110]); await click(await M([50, 0]));
console.log('14 room 100 x 60 area mm²:', await ar());
await drag(await M([50, 0]), await M([50, -20]));
console.log('15 bottom wall dragged 20 down (100 x 80 = 8000):', await ar(), 'edited', await win.evaluate(() => !!lithApp.doc.doc.views[0].anns[1].edited), 'corners', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].pts.length));
// split the top wall at x = 25 and pull the left part up 10 → L-shape 8000 + 25 × 10
const sp = await S(await M([25, 60])); await win.mouse.click(sp[0], sp[1], { button: 'right' }); await W(200);
await win.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('Split wall here')).click()); await W(150);
await drag(await M([12, 60]), await M([12, 70]));
console.log('16 split + pull left part up 10 (8250):', await ar(), 'corners', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].pts.length));
await drag(await M([100, -20]), await M([110, -20]));
console.log('17 corner (100,-20) dragged +10 x (8250 + 10 × 80 = 9050):', await ar());
await win.evaluate(() => lithApp.doc.undo()); await W(100);
console.log('18 undo corner → 8250:', await ar());
// Ctrl + corner: free move of that corner only (corner (110,-20) of the 8250 shape → +10 y: a triangle 10 × 80 / 2 = 400 less)
await click(await M([50, -20])); await win.keyboard.down('Control'); await drag(await M([100, -20]), await M([100, -10])); await win.keyboard.up('Control');
console.log('19 Ctrl + corner (100,-20) up 10 → 8250 − 0.5 × 10 × 100 = 7750:', await ar(), 'corners', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].pts.length));
await click(await M([0, 30]));
await win.evaluate(() => { const i = [...document.querySelectorAll('.ann-props .ap-row')].find((r) => r.textContent.startsWith('Line weight')).querySelector('input'); i.value = '0.03'; i.dispatchEvent(new Event('change')); });
await W(100); console.log('20 typed line weight 0.03:', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].style?.outlineW));
await T.shot('drawprops_outline');
// ---- 0.1.60: move the label dot, rename on the sheet, Room List ----
const dot0 = await win.evaluate(() => { const d = lithApp.doc, a = d.doc.views[0].anns[1]; const P = a.pts; return [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length]; });
await drag(await M(dot0), await M([20, 20]));
console.log('21 dot dragged to (20,20):', JSON.stringify(await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].dot?.map((x) => Math.round(x)))), 'pts unchanged', await ar());
await win.keyboard.press('Escape'); await win.evaluate(() => lithApp.doc.zoomFit(false)); await W(300);
b = await box(1); { const q = await S([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]); await win.mouse.dblclick(q[0], q[1]); } await W(200);
const hasInp = await win.evaluate(() => document.activeElement?.matches('input.inline-name'));
await win.keyboard.press('Control+A'); await win.keyboard.type('Kantoor 1'); await win.keyboard.press('Enter'); await W(150);
console.log('22 dblclick name → inline field', hasInp, '→ label', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].label));
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0]; d.addAnn(v, { type: 'area', pts: [[0, -100], [50, -100], [50, -60], [0, -60]], at: [60, -120], label: 'Room 2', room: true }); d.addAnn(v, { type: 'area', pts: [[0, -200], [10, -200], [10, -190], [0, -190]], at: [60, -220], label: 'Room 10', room: true }); d.cmdRoomList(); });
await W(200);
const rows = () => win.evaluate(() => [...document.querySelectorAll('.room-list tbody tr')].map((tr) => tr.querySelector('input').value + '=' + tr.children[1].textContent));
await win.evaluate(() => localStorage.removeItem('monolith.roomListSort')); await win.evaluate(() => lithApp.doc.fillRoomList(true));
console.log('23 list by name (natural):', JSON.stringify(await rows()));
await win.evaluate(() => [...document.querySelectorAll('.room-list th')].find((t) => t.textContent.startsWith('Area')).click()); await W(100);
console.log('24 sorted by area:', JSON.stringify(await rows()));
await win.evaluate(() => { const i = [...document.querySelectorAll('.room-list tbody input')].find((x) => x.value === 'Room 2'); i.value = 'Archief'; i.dispatchEvent(new Event('change')); }); await W(150);
console.log('25 renamed in list → drawing label', await win.evaluate(() => lithApp.doc.doc.views[0].anns.find((a) => a.label === 'Archief') ? 'Archief' : 'missing'), '; rename on drawing shows in list:',
  await win.evaluate(async () => { const d = lithApp.doc, a = d.doc.views[0].anns.find((x) => x.label === 'Room 10'); d.renameRoom(d.doc.views[0], a, 'Hal'); await new Promise((r) => setTimeout(r, 150)); return [...document.querySelectorAll('.room-list tbody input')].some((x) => x.value === 'Hal'); }),
  'total', await win.evaluate(() => document.querySelector('.room-list .ap-val').textContent));
await T.shot('drawprops_roomlist');
// ---- 0.1.61: Make horizontal, corner snapping, infill ----
const A1 = () => win.evaluate(() => lithApp.doc.doc.views[0].anns[1]);
await win.evaluate(() => lithApp.doc.closeRoomList());
let r1 = await A1(); await click(await M([r1.pts[0][0] * 0.5 + r1.pts[1][0] * 0.5, r1.pts[0][1] * 0.5 + r1.pts[1][1] * 0.5]));
const slant = await win.evaluate(() => { const P = lithApp.doc.doc.views[0].anns[1].pts; for (let i = 0; i < P.length; i++) { const A = P[i], B = P[(i + 1) % P.length]; if (Math.abs(A[0] - B[0]) > 0.01 && Math.abs(A[1] - B[1]) > 0.01) return { i, m: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], A, B }; } return null; });
{ const sp2 = await S(await M(slant.m)); await win.mouse.click(sp2[0], sp2[1], { button: 'right' }); await W(200); }
const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-item')].map((b) => b.textContent));
await win.evaluate(() => [...document.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('Make horizontal')).click()); await W(150);
r1 = await A1();
console.log('26 slanted wall', JSON.stringify(slant.A), '→', JSON.stringify(slant.B), 'menu', JSON.stringify(items), '→ horizontal:', JSON.stringify([r1.pts[slant.i], r1.pts[(slant.i + 1) % r1.pts.length]].map((p) => p.map((x) => +x.toFixed(3)))), 'y =', ((slant.A[1] + slant.B[1]) / 2).toFixed(3));
// corner snap onto Archief's corner (50,-60): drag corner 0 of room 1 to 1 mm next to it (Ctrl = only this corner)
r1 = await A1(); const c0 = r1.pts[0];
await win.keyboard.down('Control'); await drag(await M(c0), await M([50.8, -60.6])); await win.keyboard.up('Control');
console.log('27 corner dragged to (50.8,-60.6) snaps to Archief corner:', JSON.stringify((await A1()).pts[0].map((x) => +x.toFixed(3))), 'status', await win.evaluate(() => document.querySelector('.status-msg, #status, .statusbar')?.textContent || ''));
await win.evaluate(() => lithApp.doc.undo()); await W(100); await click(await M([r1.pts[0][0] * 0.5 + r1.pts[1][0] * 0.5, r1.pts[0][1] * 0.5 + r1.pts[1][1] * 0.5]));
await win.keyboard.down('Control'); await win.keyboard.down('Shift'); await drag(await M(c0), await M([50.8, -60.6])); await win.keyboard.up('Shift'); await win.keyboard.up('Control');
console.log('28 same with Shift = free:', JSON.stringify((await A1()).pts[0].map((x) => +x.toFixed(1))));
const fills = await win.evaluate(() => { const { sheetPrims } = lithApp.doc; return lithApp.doc._annBoxes ? null : null; });
const fp = await win.evaluate(() => { const d = lithApp.doc; const txt = d.pdfText ? d.pdfText() : ''; return { gs: (txt.match(/\/GA2 gs/g) || []).length, res: /\/ExtGState/.test(txt) }; });
console.log('29 infill 10 % in the PDF (one per room/area with outline):', JSON.stringify(fp));
await win.evaluate(() => { const d = lithApp.doc, a = d.doc.views[0].anns[1]; d.selAnn = { view: d.doc.views[0].id, id: a.id }; d.vp.requestRender(); }); await W(150);
await win.evaluate(() => { const r = [...document.querySelectorAll('.ann-props .ap-row')].find((x) => x.textContent.startsWith('Infill opacity')); const i = r.querySelector('input'); i.value = '40'; i.dispatchEvent(new Event('change')); }); await W(100);
console.log('30 infill opacity 40 →', await win.evaluate(() => lithApp.doc.doc.views[0].anns[1].style?.fillOpacity), 'pdf /GA8:', await win.evaluate(() => /\/GA8 gs/.test(lithApp.doc.pdfText())));
await T.shot('drawprops_fill');
// Drafting Standard: drawing defaults, company file, import
await win.evaluate(() => { lithApp.doc.cmdDraftStd(); const pm = lithApp.doc.app.pm.current; pm.values.textH = '2.5'; pm.values.arrow = 'tick'; pm.values.jog = 150; });
await win.evaluate(() => lithApp.doc.saveCompanyStd(lithApp.doc.app.pm.current.values));
await win.evaluate(() => lithApp.doc.app.pm.ok());
const f = JSON.parse(fs.readFileSync(process.env.MONOLITH_STD, 'utf8'));
console.log('9 drawing style', JSON.stringify(await win.evaluate(() => { const s = lithApp.doc.doc.style; return { textH: s.textH, arrow: s.arrow, jog: s.jog }; })), 'company file', JSON.stringify({ textH: f.textH, arrow: f.arrow, jog: f.jog, keys: Object.keys(f).length }));
console.log('   dimension now tick arrows, 2.5 mm text:', await win.evaluate(() => { const d = lithApp.doc; const st = d.doc.views[0].anns[0]; return JSON.stringify(Object.keys(st.style || {})); }));
// import a file with only a red text colour
fs.writeFileSync(DIR + '/red.json', JSON.stringify({ textColor: '#cc0000', bogus: 1 }));
await T.app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, DIR + '/red.json');
await win.evaluate(() => lithApp.doc.importStd()); await W(300);
console.log('10 import:', JSON.stringify(await win.evaluate(() => ({ textColor: lithApp.doc.doc.style.textColor, bogus: lithApp.doc.doc.style.bogus ?? null, textH: lithApp.doc.doc.style.textH }))));
await win.evaluate(() => [...document.querySelectorAll('.cm-tab')].find((b) => b.textContent === 'Annotate').click()); await W(200);
console.log('11 buttons:', await win.evaluate(() => [...document.querySelectorAll('.cm-btn, .cm-bar button')].map((b) => b.textContent.trim()).filter(Boolean).join(' | ')));
await win.evaluate(async () => { const d = lithApp.doc, a = d.doc.views[0].anns[1]; a.style = { ...(a.style || {}), outlineDash: 'solid', outlineColor: '#1f5fbf', outlineW: 0.5, offset: -20 }; await d.saveMyStandard(a); });
const f2 = JSON.parse(fs.readFileSync(process.env.MONOLITH_STD, 'utf8'));
console.log('12 save as my standard → file:', JSON.stringify({ dash: f2.outlineDash, col: f2.outlineColor, w: f2.outlineW, offset: f2.offset, close: f2.close }), 'drawing:', await win.evaluate(() => JSON.stringify({ dash: lithApp.doc.doc.style.outlineDash, offset: lithApp.doc.doc.style.offset })));
// 0.1.63: left panel "Selection" shows facts of the selected annotation and follows changes
const info = () => win.evaluate(() => { const el = document.querySelector('.sel-info'); return el && el.style.display !== 'none' ? [...el.querySelectorAll('.sp-sec, .pp-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()).join(' | ') : null; });
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0]; d.selAnn = { view: v.id, id: v.anns[1].id }; d.renderTree(); d.vp.requestRender(); }); await W(300);
console.log('31 info room:', await info());
await win.evaluate(() => { const d = lithApp.doc, a = d.doc.views[0].anns[1]; a.pts = a.pts.map((p) => [p[0] * 2, p[1]]); d.vp.requestRender(); }); await W(300);
console.log('32 info follows change (width doubled):', await info());
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0]; d.selAnn = { view: v.id, id: v.anns[0].id }; d.renderTree(); d.vp.requestRender(); }); await W(300);
console.log('33 info dimension:', await info());
await win.evaluate(() => { const d = lithApp.doc; d.selAnn = null; d.vp.requestRender(); }); await W(300);
console.log('34 nothing selected → hidden:', await info());
await T.app.close();
