// Point Cloud editing: segment (mouse polygon), undo/redo, filter by value, crop box (handle drag), subsample,
// noise filter, merge, transform, save + result folder cleanup, reopen. Needs STONEX=<real .laz with a 'room' field>
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const REAL = process.env.STONEX;
const DIR = '/tmp/edtest'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const DOC = path.join(DIR, 'Office.lithpcd');
const T = await launch('cloud');
const { win, W, idle } = T;
await win.evaluate(() => { lithApp.doc.doc.view.budget = 1e6; });
const settle = async (ms = 800) => { await idle().catch(async () => { console.log('IDLE TIMEOUT status:', await win.evaluate(() => document.querySelector('.st-left').textContent + ' | prog: ' + document.querySelector('.cloud-prog')?.innerText + ' | busy ' + lithApp.doc.busy)); console.log(T.logs.slice(-8).join('\n')); }); await W(ms); await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length) && !lithApp.doc.busy, null, { timeout: 120000 }).catch(() => console.log('settle timeout')); await W(200); };
const clouds = () => win.evaluate(() => lithApp.doc.doc.clouds.map((r) => `${r.name}${r.visible === false ? ' (hidden)' : ''}: ${r.count}`).join(' | '));
// save the document first (edits are stored next to it)
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; }, DOC);
await win.evaluate((p) => lithApp.doc.addCloud(p), REAL); await settle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); d.zoomFit(); }); await settle();
// ---- segment with the mouse ----
await win.evaluate(() => lithApp.doc.cmdSegment()); await W(300);
const box = await win.evaluate(() => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
const P = (fx, fy) => [box[0] + box[2] * fx, box[1] + box[3] * fy];
for (const [fx, fy] of [[0.35, 0.2], [0.65, 0.2], [0.65, 0.5], [0.35, 0.5]]) { const [x, y] = P(fx, fy); await win.mouse.click(x, y); await W(120); }
{ const [x, y] = P(0.5, 0.6); await win.mouse.click(x, y, { button: 'right' }); await W(300); }
await T.shot('ed1_polygon');
console.log('pm msg', await win.evaluate(() => document.querySelector('.pm-msg')?.textContent));
let t0 = Date.now();
await win.locator('.pm-ok').click(); await W(500); await settle();
console.log('segment ms', Date.now() - t0, '->', await clouds());
const sum = await win.evaluate(() => lithApp.doc.doc.clouds.filter((r) => /inside|outside/.test(r.name)).reduce((a, r) => a + r.count, 0));
console.log('inside+outside =', sum);
await T.shot('ed2_segmented');
// ---- undo / redo ----
await win.evaluate(() => lithApp.doc.undo()); await settle();
console.log('after undo', await clouds());
await win.evaluate(() => lithApp.doc.redo()); await settle();
console.log('after redo', await clouds());
// ---- filter by value on the original: room 3 ----
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds[0]; d.selIds = new Set([r.id]); d.selId = r.id; d.renderTree(); d.cmdFilter(); });
await W(300);
await win.evaluate(() => { const pm = lithApp.pm.current; pm.setValue('attr', 'f:room'); pm.values.attr = 'f:room'; pm.setValue('min', 3); pm.setValue('max', 3); });
await win.locator('.pm-ok').click(); await W(500); await settle();
console.log('filter room 3 ->', await clouds());
// ---- crop box on room 3: drag the top (z max) handle down ----
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.zoomFit(); d.cmdCrop(); }); await settle(300);
const hz = await win.evaluate(() => { const t = lithApp.doc.tool; const hh = t.handles().find((q) => q.axis === 2 && q.side === 'max'); const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left + hh.s[0], r.top + hh.s[1]]; });
await win.mouse.move(hz[0], hz[1]); await win.mouse.down(); await win.mouse.move(hz[0], hz[1] + 60, { steps: 6 }); await win.mouse.up(); await W(300);
const zmax = await win.evaluate(() => lithApp.pm.current.values.z1);
console.log('crop z max after drag', zmax);
await T.shot('ed3_cropbox');
await win.locator('.pm-ok').click(); await W(500); await settle();
console.log('crop ->', await clouds());
// ---- subsample 5 cm + SOR on the original ----
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds[0]; d.selIds = new Set([r.id]); d.cmdSubsample(); }); await W(200);
await win.evaluate(() => lithApp.pm.current.setValue('spacing', 5)); await win.evaluate(() => { lithApp.pm.current.values.spacing = 5; });
await win.locator('.pm-ok').click(); await W(500); await settle();
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds[0]; d.selIds = new Set([r.id]); d.cmdNoise(); }); await W(200);
t0 = Date.now(); await win.locator('.pm-ok').click(); await W(500); await settle();
console.log('subsample + SOR ms', Date.now() - t0, '->', await clouds());
// ---- merge two clouds via ctrl+click in the tree ----
const rows = win.locator('.panel.tree .tr-row');
await rows.filter({ hasText: '- inside' }).first().click();
await rows.filter({ hasText: '5 cm' }).first().click({ modifiers: ['Control'] });
console.log('selected', await win.evaluate(() => lithApp.doc.selIds.size));
await win.evaluate(() => lithApp.doc.cmdMerge()); await W(500); await settle();
console.log('merge ->', await clouds());
// ---- transform: move 10 m in X, rotate 90° ----
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds.find((x) => x.name.startsWith('Merged')); d.selIds = new Set([r.id]); d.cmdTransform(); }); await W(200);
const inp = (k) => win.evaluate((k) => lithApp.pm.current.inputs[k], k);
void inp;
await win.evaluate(() => { const pm = lithApp.pm.current; pm.values.dx = 10; pm.values.rz = 90; });
await win.locator('.pm-ok').click(); await W(400);
console.log('transform', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.clouds.find((x) => x.name.startsWith('Merged')).transform)));
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); for (const r of lithApp.doc.doc.clouds) { r.visible = !!r.transform || r.name.endsWith('outside'); lithApp.doc.layers.get(r.id).applyStyle(); } lithApp.doc.zoomFit(); lithApp.doc.renderTree(); }); await settle();
await T.shot('ed4_transformed');
const ex = await win.evaluate(async () => { const d = lithApp.doc; const r = d.doc.clouds.find((x) => x.name.startsWith('Merged')); return window.monolith.cloudExport(d.layers.get(r.id).id, '/tmp/edtest/merged_moved.las', 'las', 1, r.transform); });
console.log('export transformed', JSON.stringify(ex));
// ---- save, remove a cloud, save again (results still in undo history stay), reopen ----
await win.evaluate(() => lithApp.save()); await W(500);
const files1 = fs.readdirSync(path.join(DIR, 'Office clouds')).length;
await win.evaluate(() => { const d = lithApp.doc; d.undoStack = []; d.redoStack = []; const r = d.doc.clouds.find((x) => x.name.endsWith('cleaned')); d.removeCloud(r.id, false); d.undoStack = []; });
await win.evaluate(() => lithApp.save()); await W(800);
const files2 = fs.readdirSync(path.join(DIR, 'Office clouds')).length;
console.log('result files', files1, '->', files2);
const saved = JSON.parse(fs.readFileSync(DOC, 'utf8'));
console.log('saved clouds', saved.clouds.length, saved.clouds.map((c) => c.cache ? 'cache' : 'scan').join(','));
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
t0 = Date.now(); await win.evaluate((p) => lithApp.open(p), DOC); await settle();
console.log('reopen ms', Date.now() - t0, await clouds());
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
