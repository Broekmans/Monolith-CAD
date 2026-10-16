// 0.1.65: feature dialog floating over the view, sketch + dims visible, value box on the model, drag arrow
import { _electron as electron } from 'playwright-core';
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part' }, timeout: 60000 });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => { if (/error/i.test(m.type()) && !/Security|WebGL|GPU stall|swiftshader/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const W = (ms) => win.waitForTimeout(ms);
await W(3500);
const shot = async (n) => { await W(400); await win.screenshot({ path: `tests/e2e/shots/fui-${n}.png` }); };
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(300); };
const P = async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
const click = async (x, y) => { const [px, py] = await P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(120); };
// sketch: 120 x 80 centre rectangle with two dimensions on the Top plane
await win.locator('.tr-row:has-text("Top Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.3; vp.requestRender(); });
await win.locator('.cm-btn:has-text("Center Rectangle")').click(); await click(0, 0); await click(60, 40); await win.keyboard.press('Escape');
await win.locator('.cm-btn:has-text("Smart Dimension")').click();
await click(0, 40); await click(0, 55); await win.keyboard.type('120'); await win.keyboard.press('Enter'); await W(200);
await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await win.locator('.cm-tab:has-text("Features")').click(); await win.locator('.cm-btn:has-text("Extruded Boss")').click(); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.vp.scale = 0.35; d.vp.target.set(0, 0, 0); d.vp.requestRender(); }); await W(500);
const state = () => win.evaluate(() => { const d = lithApp.doc, pm = document.querySelector('.pmroot'), box = document.querySelector('.feat-val'); return {
  float: pm.classList.contains('pm-float'), pmShown: pm.style.display !== 'none', treeShown: document.querySelector('.panel.tree').style.display !== 'none',
  box: box ? box.querySelector('input').value : null, sketchShown: d.featUI?.sketch || null, dims: (d._dimHits || []).map((x) => x.text), fill: d.sketchGroup.children.some((o) => o.isMesh) }; });
console.log('1 extrude open:', JSON.stringify(await state()));
await shot('extrude');
// type 25 in the box + Enter = OK
await win.locator('.feat-val input').fill('25'); await win.locator('.feat-val input').press('Enter'); await idle();
console.log('2 after Enter:', JSON.stringify(await win.evaluate(() => { const f = lithApp.doc.doc.features.find((x) => x.type === 'extrude'); return { depth: f?.depth, pmOpen: lithApp.doc.app.pm.open, box: !!document.querySelector('.feat-val'), float: document.querySelector('.pmroot').classList.contains('pm-float'), tree: document.querySelector('.panel.tree').style.display !== 'none', bboxY: lithApp.doc.mesh?.bbox?.max?.[1] ?? lithApp.doc.mesh?.bbox }; })));
// edit the feature: drag the arrow up
await win.evaluate(() => { const d = lithApp.doc; d.editFeature(d.doc.features.find((x) => x.type === 'extrude').id); }); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.vp.scale = 0.35; d.vp.target.set(0, 0, 0); d.vp.requestRender(); }); await W(400);
const g = await win.evaluate(() => { const r = document.querySelector('.feat-grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const box0 = await win.evaluate(() => document.querySelector('.feat-val input').value);
await win.mouse.move(g[0], g[1]); await win.mouse.down(); await win.mouse.move(g[0], g[1] - 20, { steps: 4 }); await win.mouse.move(g[0], g[1] - 40 / 1, { steps: 4 }); await win.mouse.up(); await idle();
console.log('3 drag up 40 px at 0.35 mm/px (≈ +14 mm):', box0, '→', await win.evaluate(() => [document.querySelector('.feat-val input').value, lithApp.doc.app.pm.current.values.depth]));
await shot('drag');
// a sketch dimension on the model while the dialog is open: change 120 → 100, preview follows
const hit = await win.evaluate(() => { const d = lithApp.doc, x = d._dimHits.find((q) => q.kind === 'cons'), r = d.vp.el.getBoundingClientRect(); return x ? [r.left + (x.x0 + x.x1) / 2, r.top + (x.y0 + x.y1) / 2, x.text] : null; });
console.log('4 dims shown:', JSON.stringify(hit));
if (hit) { await win.mouse.dblclick(hit[0], hit[1]); await W(300); await win.locator('.dlg input').fill('100'); await win.locator('.dlg button.primary').click(); await idle(); }
console.log('5 after dim edit:', JSON.stringify(await win.evaluate(() => ({ pm: lithApp.doc.app.pm.open, w: lithApp.doc.mesh?.bbox ? +(lithApp.doc.mesh.bbox.max[0] - lithApp.doc.mesh.bbox.min[0]).toFixed(2) : null, dims: lithApp.doc._dimHits.map((x) => x.text) }))));
await win.keyboard.press('Escape'); await idle();
console.log('6 Esc → cancelled, dialog gone:', JSON.stringify(await win.evaluate(() => ({ pm: lithApp.doc.app.pm.open, box: !!document.querySelector('.feat-val'), depth: lithApp.doc.doc.features.find((x) => x.type === 'extrude').depth }))));
// fillet: box without a model spot until an edge is picked
await win.locator('.cm-btn:has-text("Fillet")').click(); await idle();
console.log('7 fillet box:', JSON.stringify(await win.evaluate(() => { const b = document.querySelector('.feat-val'); return b && { label: b.querySelector('label').textContent, v: b.querySelector('input').value, free: b.classList.contains('free') }; })));
await win.keyboard.press('Escape'); await idle();
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
