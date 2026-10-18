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
// ---- 0.1.74: real divider drags, model scales with the view, close / maximize / restore, custom layout saved ----
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(600);
const sc = () => win.evaluate(() => lithApp.doc.viewSet.panes.map((p) => +p.scale.toFixed(4)));
const drag = async (sel, dx, dy, idx = 0) => { const b = await win.locator(sel).nth(idx).boundingBox(); const x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 100); await win.mouse.move(x, y); await win.mouse.down(); for (let k = 1; k <= 6; k++) await win.mouse.move(x + dx * k / 6, y + dy * k / 6); await win.mouse.up(); await W(300); };
const s0 = await sc(), z0 = (await info()).sizes;
await drag('.vs-split.v', -200, 0);
const s1 = await sc(), z1 = (await info()).sizes;
console.log('12 v-divider -200px: split', JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.split.map((v) => +v.toFixed(3)))), 'sizes', JSON.stringify(z0), '→', JSON.stringify(z1));
console.log('12 scale ratio pane0 (expect w0/w1):', (s1[0] / s0[0]).toFixed(3), 'vs', (parseInt(z0[0]) / parseInt(z1[0])).toFixed(3), '| pane1', (s1[1] / s0[1]).toFixed(3), 'vs', (parseInt(z0[1]) / parseInt(z1[1])).toFixed(3));
await drag('.vs-split.h', 0, 120, 1); // the right column's row divider
console.log('13 h-divider right column +120:', JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.cols.map((c) => c.rows.map((r) => +r.h.toFixed(3))))), JSON.stringify((await info()).sizes));
await drag('.vs-split.v', 100, 0); // second drag on the same strip still works
console.log('13b second v drag:', JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.split.map((v) => +v.toFixed(3)))));
// maximize pane 3 with its button, restore
const btn = async (i, cls) => { const b = await win.evaluate(([i, cls]) => { const r = lithApp.doc.viewSet.panes[i].el.querySelector(cls).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, [i, cls]); await win.mouse.move(...b); await win.mouse.click(...b); await W(400); };
const before = JSON.stringify((await info()).sizes);
await btn(3, '.vs-max');
console.log('14 maximized:', await win.evaluate(() => { const s = lithApp.doc.viewSet; return [s.panes.indexOf(s.max), s.panes.map((p) => p.el.style.display || 'show').join()]; }), JSON.stringify((await info()).sizes[3]));
await shot('max');
await btn(3, '.vs-max');
console.log('14 restored, same sizes:', JSON.stringify((await info()).sizes) === before);
// right-click on empty space → Maximize View
const [ex, ey] = await win.evaluate(() => { const r = lithApp.doc.viewSet.panes[2].el.getBoundingClientRect(); return [r.left + 15, r.bottom - 15]; });
await win.mouse.click(ex, ey, { button: 'right' }); await W(300);
const items = await win.locator('.ctx-item').allTextContents();
console.log('15 context menu:', JSON.stringify(items.slice(0, 3)));
await win.locator('.ctx-item:has-text("Maximize View")').click(); await W(300);
console.log('15 max via menu:', await win.evaluate(() => lithApp.doc.viewSet.panes.indexOf(lithApp.doc.viewSet.max)));
await win.mouse.click(ex, ey, { button: 'right' }); await W(300);
await win.locator('.ctx-item:has-text("Restore Views")').click(); await W(300);
console.log('15 restored:', await win.evaluate(() => lithApp.doc.viewSet.max === null));
// close the bottom-right view (pane 3) → right column = one tall view
await btn(3, '.vs-close');
console.log('16 closed 3:', JSON.stringify(await info()), JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.cols.map((c) => c.rows.length))));
await shot('three');
// close pane 0 (top-left; owns the renderer) via the menu command
await win.evaluate(() => { const s = lithApp.doc.viewSet; s.setActive(s.panes[0]); lithApp.onMenu('close-view'); }); await W(400);
console.log('17 closed top-left:', JSON.stringify(await info()), JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.cols.map((c) => c.rows.length))), 'canvases ok', await win.evaluate(() => lithApp.doc.viewSet.panes[0].el.querySelector('canvas.gl') !== null));
// save / reopen custom layout
const saved2 = await win.evaluate(() => { const d = lithApp.doc; d.beforeSave(); return d.doc.viewLayout; });
console.log('18 saved custom:', saved2.layout, JSON.stringify(saved2.cols));
await win.evaluate(() => lithApp.onMenu('layout', 'single')); await W(300);
await win.evaluate((s) => lithApp.doc.viewSet.restore(s), saved2); await W(400);
console.log('18 restored custom:', JSON.stringify(await info()), JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.cols.map((c) => [+c.w.toFixed(3), c.rows.map((r) => +r.h.toFixed(3))]))));
await win.evaluate(() => lithApp.onMenu('reset-views')); await W(400);
console.log('19 reset views:', (await info()).layout, (await info()).n);
// window resize in single view: model scales along
await win.evaluate(() => lithApp.onMenu('layout', 'single')); await W(300);
const a0 = await win.evaluate(() => [lithApp.doc.vp.scale, lithApp.doc.vp.width]);
await win.evaluate(() => { document.querySelector('.left').style.width = '470px'; }); await W(500);
const a1 = await win.evaluate(() => [lithApp.doc.vp.scale, lithApp.doc.vp.width]);
console.log('20 panel wider: width', a0[1], '→', a1[1], 'scale ratio', (a1[0] / a0[0]).toFixed(3), 'expect', (a0[1] / a1[1]).toFixed(3));
await win.evaluate(() => { document.querySelector('.left').style.width = ''; }); await W(300);
// ---- 0.1.78 ----
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await win.evaluate(() => lithApp.onMenu('reset-views')); await W(600);
// 21: the cube is drawn where its hit area is (pane buttons push the hit area 24 px down): pixels inside the FRONT face
const pix = async (i) => {
  const r = await win.evaluate((i) => { const p = lithApp.doc.viewSet.panes[i]; p.setView('front', false); p.requestRender(); const b = p.viewCube.el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }, i);
  await W(400);
  const png = (await win.screenshot({ clip: r })).toString('base64');
  return win.evaluate(async (png) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const k = im.width / 104, at = (x, y) => [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)];
    return { up: at(52, 32), down: at(52, 72), below: at(52, 100) };
  }, png);
};
console.log('21 cube pixels pane 0 (face ≈ 233,238,245 at up+down):', JSON.stringify(await pix(0)));
console.log('21 cube pixels pane 3:', JSON.stringify(await pix(3)));
// real click on the cube's FRONT face of pane 3 in iso view
await win.evaluate(() => lithApp.doc.viewSet.panes[3].setView('iso', false)); await W(300);
const fp = await win.evaluate(async () => { const THREE = await import('three').catch(() => null); const p = lithApp.doc.viewSet.panes[3], c = p.viewCube; const v = c.cam.position.clone().set(0, -0.15, 0.5).project(c.cam); const b = c.el.getBoundingClientRect(); return [b.left + (v.x + 1) / 2 * b.width, b.top + (1 - v.y) / 2 * b.height]; }).catch(() => null);
if (fp) { await win.mouse.move(fp[0], fp[1]); await win.mouse.down(); await win.mouse.up(); await W(900); }
console.log('21 click FRONT on pane 3 cube → dir', (await info()).dirs[3]);
// 22: heads-up toolbar under the active pane's cube
const hud = async () => win.evaluate(() => { const s = lithApp.doc.viewSet, h = document.querySelector('.headsup').getBoundingClientRect(), a = s.active.viewCube.arrows.getBoundingClientRect(), r = s.active.el.getBoundingClientRect(); return { active: s.panes.indexOf(s.active), below: Math.round(h.top - a.bottom), rightGap: Math.round(r.right - h.right), insidePane: h.left >= r.left && h.right <= r.right }; });
console.log('22 hud:', JSON.stringify(await hud()));
const [x0b, y0b, w0b, h0b] = await rect(0);
await win.mouse.click(x0b + 60, y0b + h0b - 40); await W(300);
console.log('22 hud after clicking pane 0:', JSON.stringify(await hud()));
// 23: minimize pane 1 (button) → dock tab, then back in its place
const cols = () => win.evaluate(() => JSON.stringify(lithApp.doc.viewSet.cols.map((c) => c.rows.map((r) => lithApp.doc.viewSet.panes.indexOf(r.pane)))));
const c0 = await cols();
await win.locator('.viewport').nth(1).hover(); await win.evaluate(() => lithApp.doc.viewSet.panes[1]._vsBtns.querySelector('.vs-min').click()); await W(400);
console.log('23 minimized 1:', await cols(), 'tabs', JSON.stringify(await win.locator('.vs-tab').allTextContents()), 'shown', await win.evaluate(() => lithApp.doc.viewSet.visible().length));
await win.locator('.vs-tab').first().click(); await W(400);
console.log('23 restored:', await cols(), 'same as before', (await cols()) === c0, 'tabs', await win.locator('.vs-tab').count());
// minimize pane 0 → it swaps with another pane (pane 0 stays on screen), view kept in the tab
const d0 = (await info()).dirs[0];
await win.evaluate(() => lithApp.doc.viewSet.minimize(lithApp.doc.viewSet.panes[0])); await W(400);
const mi = await win.evaluate(() => { const s = lithApp.doc.viewSet; const m = s.minimized()[0]; return { idx: s.panes.indexOf(m), p0shown: s.panes[0].el.style.display !== 'none', dir: m.viewDir().toArray().map((v) => Math.round(v * 100) / 100).join() }; });
console.log('23 minimize pane 0:', JSON.stringify(mi), 'kept view', mi.dir === d0, 'tab', JSON.stringify(await win.locator('.vs-tab').allTextContents()));
console.log('23 menu items:', JSON.stringify(await win.evaluate(() => lithApp.doc.viewSet.menuItems().filter((x) => x.label).map((x) => x.label))));
// 24: save / restore with a minimized view
const s3 = await win.evaluate(() => { lithApp.doc.beforeSave(); return lithApp.doc.doc.viewLayout; });
await win.evaluate(() => lithApp.onMenu('layout', 'single')); await W(300);
await win.evaluate((s) => lithApp.doc.viewSet.restore(s), s3); await W(400);
console.log('24 restored with min:', JSON.stringify(s3.min), '→ tabs', await win.locator('.vs-tab').count(), 'shown', await win.evaluate(() => lithApp.doc.viewSet.visible().length));
await win.evaluate(() => lithApp.onMenu('restore-mins')); await W(400);
console.log('24 Restore Minimized Views:', await cols(), 'tabs', await win.locator('.vs-tab').count());
// 25: no face highlight while the middle button is held
await win.evaluate(() => lithApp.onMenu('layout', 'single')); await win.evaluate(() => lithApp.doc.zoomFit()); await W(500);
const [xs, ys, ws, hs] = await rect(0);
const fpt = await win.evaluate(([x0, y0, w, h]) => { for (let j = 1; j < 20; j++) for (let i = 1; i < 20; i++) { const x = x0 + w * i / 20, y = y0 + h * j / 20; if (lithApp.doc.pickAt({ clientX: x, clientY: y })?.kind === 'face') return [x, y]; } return null; }, [xs, ys, ws, hs]);
await win.mouse.move(fpt[0] - 3, fpt[1]); await win.mouse.move(fpt[0], fpt[1], { steps: 2 }); await W(200);
const hov0 = await win.evaluate(() => lithApp.doc.hover?.kind || null);
await win.mouse.down({ button: 'middle' }); await win.mouse.move(fpt[0] + 4, fpt[1] + 3, { steps: 5 }); await W(200);
const hov1 = await win.evaluate(() => lithApp.doc.hover?.kind || null);
await win.mouse.up({ button: 'middle' }); await W(200);
console.log('25 hover plain:', hov0, '| while middle-drag:', hov1);
// ---- 0.1.79 ----
// 26: view cube size follows the view: small panes → minimum, maximized → maximum (or % of the view)
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(500);
const cubeInfo = () => win.evaluate(() => lithApp.doc.viewSet.panes.map((p) => [p.viewCube.S, p.viewCube.el.offsetWidth, Math.min(p.width, p.height)]));
console.log('26 four views cube S / DOM / short side:', JSON.stringify(await cubeInfo()));
await win.evaluate(() => lithApp.doc.viewSet.maximize(lithApp.doc.viewSet.panes[1])); await W(400);
console.log('26 maximized pane 1:', JSON.stringify((await cubeInfo())[1]));
await win.evaluate(() => lithApp.doc.viewSet.restoreViews()); await W(300);
// shrink the bottom row of the right column → small pane: cube at the minimum, toolbar still inside the pane
await win.evaluate(() => { const s = lithApp.doc.viewSet; s.cols[1].rows[0].h = 0.82; s.cols[1].rows[1].h = 0.18; s.place(); s.setActive(s.panes[3]); }); await W(400);
console.log('26 small pane 3 cube:', JSON.stringify((await cubeInfo())[3]));
console.log('26 hud in small pane:', JSON.stringify(await win.evaluate(() => { const s = lithApp.doc.viewSet, hu = document.querySelector('.headsup'), h = hu.getBoundingClientRect(), r = s.active.el.getBoundingClientRect(); return { pos: hu.dataset.pos, inside: h.left >= r.left && h.right <= r.right && h.top >= r.top && h.bottom <= r.bottom }; })));
// cube picture = hit area also at another size
console.log('26 pixels pane 0 after resize:', JSON.stringify(await (async () => { const r = await win.evaluate(() => { const p = lithApp.doc.viewSet.panes[0]; p.setView('front', false); const b = p.viewCube.el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }); await W(300); const png = (await win.screenshot({ clip: r })).toString('base64'); return win.evaluate(async (png) => { const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const at = (fx, fy) => [...g.getImageData(Math.round(fx * im.width), Math.round(fy * im.height), 1, 1).data.slice(0, 3)]; return { up: at(0.5, 0.3), down: at(0.5, 0.7) }; }, png); })()));
// 27: options change the cube + toolbar live
await win.evaluate(() => lithApp.applyOptions({ cubeMin: 40, cubePct: 10, hudPos: 'top' })); await W(400);
console.log('27 cubeMin 40 / 10 %:', JSON.stringify((await cubeInfo()).map((c) => c[0])), 'hud', await win.evaluate(() => document.querySelector('.headsup').dataset.pos));
await win.evaluate(() => lithApp.applyOptions({ cubeMin: 64, cubePct: 22, hudPos: 'cube', dividerW: 8 })); await W(400);
console.log('27 divider width 8:', await win.evaluate(() => document.querySelector('.vs-split.v').offsetWidth));
await win.evaluate(() => lithApp.applyOptions({ dividerW: 4 }));
// 28: setting changes are recorded (OK in the Options window)
const tr = await win.evaluate(() => lithApp.trackOptions({ rotateSpeed: 100, cubeMax: 128 }, { rotateSpeed: 150, cubeMax: 128 }));
console.log('28 tracked keys:', JSON.stringify(tr));
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await shot('hud');
await win.evaluate(() => lithApp.onMenu('theme', true)); await win.evaluate(() => lithApp.onMenu('layout', 'four')); await shot('dark');
await win.evaluate(() => lithApp.onMenu('theme', false));
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
