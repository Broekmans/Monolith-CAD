// 0.1.67: several viewports (Viewport menu) in Part and Assembly
import { _electron as electron } from 'playwright-core';
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part' }, timeout: 60000 });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => { if (/error/i.test(m.type()) && !/Security|WebGL|GPU stall|swiftshader/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const W = (ms) => win.waitForTimeout(ms);
await W(3500);
const shot = async (n) => { await W(500); await win.screenshot({ path: `tests/e2e/shots/vps-${n}.png` }); };
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(300); };
const P = async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
const click = async (x, y) => { const [px, py] = await P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(120); };
const info = () => win.evaluate(() => { const s = lithApp.doc.viewSet; return { layout: s.layout, n: s.panes.length, active: s.panes.indexOf(s.active), dirs: s.panes.map((p) => p.viewDir().toArray().map((v) => Math.round(v * 100) / 100).join()), sizes: s.panes.map((p) => `${p.width}x${p.height}`), canvases: document.querySelectorAll('.viewset canvas.gl').length }; });
// box 120 x 80 x 10
await win.locator('.tr-row:has-text("Top Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.3; vp.requestRender(); });
await win.locator('.cm-btn:has-text("Center Rectangle")').click(); await click(0, 0); await click(60, 40); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await win.locator('.cm-tab:has-text("Features")').click(); await win.locator('.cm-btn:has-text("Extruded Boss")').click(); await idle();
await win.keyboard.press('Enter'); await idle();
console.log('1 single:', JSON.stringify(await info()));
// four views via the menu command
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(600);
console.log('2 four:', JSON.stringify(await info()));
await shot('four');
// pane under the mouse becomes active; Zoom to Fit / views act on it
const rect = (i) => win.evaluate((i) => { const r = lithApp.doc.viewSet.panes[i].el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }, i);
const [x3, y3, w3, h3] = await rect(3);
await win.mouse.move(x3 + w3 / 2, y3 + h3 / 2); await W(200);
console.log('3 hover pane 3 → active:', (await info()).active);
await win.evaluate(() => lithApp.onMenu('view', 'back')); await W(500);
console.log('3 Back in pane 3:', JSON.stringify((await info()).dirs));
// pick in pane 2 (Top view): face under the centre
const [x2, y2, w2, h2] = await rect(2);
const pick = await win.evaluate(([x, y]) => { const d = lithApp.doc; const ev = { clientX: x, clientY: y }; d.viewSet.setActive(d.viewSet.paneOf(document.elementFromPoint(x, y))); const p = d.pickAt(ev); return p?.kind; }, [x2 + w2 / 2, y2 + h2 / 2]);
console.log('4 pick in Top pane:', pick);
await win.mouse.click(x2 + w2 / 2, y2 + h2 / 2); await W(300);
console.log('4 click selects:', JSON.stringify(await win.evaluate(() => lithApp.doc.sel.map((s) => s.kind))));
// sketch in the iso pane (pane 1): the sketcher draws through the active pane
const [x1, y1, w1, h1] = await rect(1);
await win.mouse.move(x1 + w1 / 2, y1 + h1 / 2); await W(200);
await win.locator('.tr-row:has-text("Front Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(800);
await win.mouse.move(x1 + w1 / 2, y1 + h1 / 2); await W(200);
console.log('5 sketching, active pane:', (await info()).active, 'dir', (await info()).dirs[(await info()).active]);
await win.locator('.cm-btn:has-text("Circle")').first().click(); await click(0, 40); await click(8, 40); await win.keyboard.press('Escape');
console.log('5 circle added:', await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter((g) => g.type === 'circle').length));
await shot('sketch');
await win.locator('.cc.ok').click(); await idle();
// divider drag
const dv = await win.locator('.vs-split.v').boundingBox();
await win.mouse.move(dv.x + 2, dv.y + 100); await win.mouse.down(); await win.mouse.move(dv.x - 150, dv.y + 100, { steps: 4 }); await win.mouse.up(); await W(300);
console.log('6 divider:', JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.split)), JSON.stringify((await info()).sizes));
// saved state + restore into a fresh layout
const saved = await win.evaluate(() => { const d = lithApp.doc; d.beforeSave(); return d.doc.viewLayout; });
console.log('7 saved:', saved.layout, saved.views.length, saved.split.map((v) => +v.toFixed(2)));
await win.evaluate(() => lithApp.onMenu('layout', 'single')); await W(300);
console.log('8 single again:', JSON.stringify(await info()));
await win.evaluate((s) => lithApp.doc.viewSet.restore(s), saved); await W(400);
console.log('8 restored:', JSON.stringify(await info()));
await win.evaluate(() => lithApp.onMenu('layout', 'two-h')); await W(400);
console.log('9 two stacked:', JSON.stringify(await info()));
await win.evaluate(() => lithApp.onMenu('layout', 'two-v')); await W(400);
console.log('9 two side:', JSON.stringify(await info()));
// grid per document via the menu
await win.evaluate(() => lithApp.onMenu('doc-grid', false)); await W(200);
console.log('10 doc grid off:', await win.evaluate(() => [lithApp.doc.gridOn, lithApp.doc.viewSet.panes.every((p) => p.grid.on === false)]));
await win.evaluate(() => lithApp.onMenu('doc-grid', true));
// feature dialog in pane 1
await win.mouse.move(...(await rect(1)).slice(0, 2).map((v) => v + 100)); await W(200);
await win.evaluate(() => { const d = lithApp.doc; d.editFeature(d.doc.features.find((x) => x.type === 'extrude').id); }); await idle();
console.log('11 value box in active pane:', await win.evaluate(() => { const s = lithApp.doc.viewSet; return document.querySelector('.feat-val')?.parentElement === s.active.el; }));
await win.keyboard.press('Escape'); await idle();
await win.evaluate(() => lithApp.onMenu('theme', true)); await win.evaluate(() => lithApp.onMenu('layout', 'four')); await shot('dark');
await win.evaluate(() => lithApp.onMenu('theme', false));
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
