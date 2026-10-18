// 0.1.65: feature dialog floating over the view, sketch + dims visible, value box on the model, drag arrow
// 0.1.71: ghost preview (boss yellow / cut red), turn to Isometric when looking straight at the sketch, Enter twice, dimension edited in place, middle click = Zoom to Fit
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
// look straight at the Top plane (like right after Exit Sketch) → the extrude dialog turns the view to Isometric
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); d.vp.requestRender(); }); await W(300);
await win.locator('.cm-tab:has-text("Features")').click(); await win.locator('.cm-btn:has-text("Extruded Boss")').click(); await idle(); await W(900);
const vdir = () => win.evaluate(() => lithApp.doc.vp.viewDir().toArray().map((x) => +x.toFixed(3)));
console.log('0 view after opening Extrude (top → iso expected ≈ -0.577 ×3):', JSON.stringify(await vdir()));
const ghost = () => win.evaluate(() => { const d = lithApp.doc, g = d.ghost; const bb = (m) => { if (!m?.positions?.length) return null; let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < m.positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], m.positions[i]); hi[i % 3] = Math.max(hi[i % 3], m.positions[i]); } return hi.map((x, i) => +(x - lo[i]).toFixed(2)); };
  return g ? { op: g.op, tool: bb(g.tool), prev: bb(g.prev), body: bb(d.mesh), objs: d.ghostGroup.children.length, col: d.ghostGroup.children[0]?.material.color.getHexString() } : null; });
console.log('0b ghost (boss, no body yet):', JSON.stringify(await ghost()));
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.vp.scale = 0.35; d.vp.target.set(0, 0, 0); d.vp.requestRender(); }); await W(500);
const state = () => win.evaluate(() => { const d = lithApp.doc, pm = document.querySelector('.pmroot'), box = document.querySelector('.feat-val'); return {
  float: pm.classList.contains('pm-float'), pmShown: pm.style.display !== 'none', treeShown: document.querySelector('.panel.tree').style.display !== 'none',
  box: box ? box.querySelector('input').value : null, sketchShown: d.featUI?.sketch || null, dims: (d._dimHits || []).map((x) => x.text), fill: d.sketchGroup.children.some((o) => o.isMesh) }; });
console.log('1 extrude open:', JSON.stringify(await state()));
await shot('extrude');
// type 25 in the box + Enter = preview only; Enter again (same value) = OK
await win.locator('.feat-val input').fill('25'); await win.locator('.feat-val input').press('Enter'); await idle();
console.log('2a first Enter → still open, ghost follows:', JSON.stringify({ pm: await win.evaluate(() => lithApp.doc.app.pm.open), ghost: await ghost() }));
await shot('ghost');
// 0.1.73/0.1.74: mouse wheel over the value box = ±1 while creating (wheel up = more)
const vb = await win.evaluate(() => { const r = document.querySelector('.feat-val input').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const sc0 = await win.evaluate(() => lithApp.doc.vp.scale);
await win.mouse.move(vb[0], vb[1]); await win.mouse.wheel(0, -100); await W(150); await win.mouse.wheel(0, -100); await W(150); await win.mouse.wheel(0, 100); await idle();
console.log('2b wheel up, up, down from 25:', JSON.stringify(await win.evaluate((sc0) => ({ box: document.querySelector('.feat-val input').value, depth: lithApp.doc.app.pm.current.values.depth, zoomUnchanged: lithApp.doc.vp.scale === sc0 }), sc0)));
await win.locator('.feat-val input').fill('25'); await win.locator('.feat-val input').press('Enter'); await idle();
await win.locator('.feat-val input').press('Enter'); await idle();
console.log('2 after Enter:', JSON.stringify(await win.evaluate(() => { const f = lithApp.doc.doc.features.find((x) => x.type === 'extrude'); return { depth: f?.depth, pmOpen: lithApp.doc.app.pm.open, box: !!document.querySelector('.feat-val'), float: document.querySelector('.pmroot').classList.contains('pm-float'), tree: document.querySelector('.panel.tree').style.display !== 'none', bboxY: lithApp.doc.mesh?.bbox?.max?.[1] ?? lithApp.doc.mesh?.bbox }; })));
// edit the feature: drag the arrow up
await win.evaluate(() => { const d = lithApp.doc; d.editFeature(d.doc.features.find((x) => x.type === 'extrude').id); }); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.vp.scale = 0.35; d.vp.target.set(0, 0, 0); d.vp.requestRender(); }); await W(400);
{ const vb2 = await win.evaluate(() => { const r = document.querySelector('.feat-val input').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  const before = await win.evaluate(() => [document.querySelector('.feat-val input').value, lithApp.doc.vp.scale]);
  await win.mouse.move(vb2[0], vb2[1]); await win.mouse.wheel(0, -100); await W(300);
  console.log('2c editing: wheel does not change the value (zooms instead):', JSON.stringify({ before, after: await win.evaluate(() => [document.querySelector('.feat-val input').value, lithApp.doc.vp.scale]) }));
  await win.evaluate((s) => { lithApp.doc.vp.scale = s; lithApp.doc.vp.target.set(0, 0, 0); lithApp.doc.vp.requestRender(); }, before[1]); await W(300); }
const g = await win.evaluate(() => { const r = document.querySelector('.feat-grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const box0 = await win.evaluate(() => document.querySelector('.feat-val input').value);
await win.mouse.move(g[0], g[1]); await win.mouse.down(); await win.mouse.move(g[0], g[1] - 20, { steps: 4 }); await win.mouse.move(g[0], g[1] - 40 / 1, { steps: 4 }); await win.mouse.up(); await idle();
console.log('3 drag up 40 px at 0.35 mm/px (≈ +14 mm):', box0, '→', await win.evaluate(() => [document.querySelector('.feat-val input').value, lithApp.doc.app.pm.current.values.depth]));
await shot('drag');
// a sketch dimension on the model while the dialog is open: change 120 → 100, preview follows
const hit = await win.evaluate(() => { const d = lithApp.doc, x = d._dimHits.find((q) => q.kind === 'cons'), r = d.vp.el.getBoundingClientRect(); return x ? [r.left + (x.x0 + x.x1) / 2, r.top + (x.y0 + x.y1) / 2, x.text] : null; });
console.log('4 dims shown:', JSON.stringify(hit));
if (hit) {
  await win.mouse.dblclick(hit[0], hit[1]); await W(300);
  console.log('4b in place:', JSON.stringify(await win.evaluate(() => ({ dialog: !!document.querySelector('.dlg'), inline: document.querySelector('.dim-inline')?.value, focused: document.activeElement?.className }))));
  await win.locator('.dim-inline').fill('100'); await win.locator('.dim-inline').press('Enter'); await idle();
}
console.log('5 after dim edit:', JSON.stringify(await win.evaluate(() => ({ pm: lithApp.doc.app.pm.open, inline: !!document.querySelector('.dim-inline'), dims: lithApp.doc._dimHits.map((x) => x.text) }))), JSON.stringify(await ghost()));
await win.keyboard.press('Escape'); await idle();
console.log('6 Esc → cancelled, dialog gone:', JSON.stringify(await win.evaluate(() => ({ pm: lithApp.doc.app.pm.open, box: !!document.querySelector('.feat-val'), depth: lithApp.doc.doc.features.find((x) => x.type === 'extrude').depth }))));
// cut with the same sketch: red ghost of the removed volume, body before the cut stays solid
await win.locator('.cm-btn:has-text("Extruded Cut")').click(); await idle();
console.log('6a cut dialog, sketch offered:', await win.evaluate(() => { const d = lithApp.doc, pm = d.app.pm.current, sk = d.doc.features.find((x) => x.type === 'sketch'); const ok = pm.offer(d.selItem({ kind: 'sketch', id: sk.id, key: 'sketch:' + sk.id })); d.updateHighlights(); return ok; })); await idle();
await win.evaluate(() => { const i = lithApp.doc.app.pm.current.inputs.reverse; if (i && !i.checked) i.click(); }); await idle(); await W(300);
console.log('6b cut ghost:', JSON.stringify(await ghost()));
await shot('ghost-cut');
// 0.1.82: Through All cut — the model shows the real result (hole), the ghost is only the removed volume, yellow
await win.evaluate(() => { const pm = lithApp.doc.app.pm.current, sel = pm.inputs.end; if (sel) { sel.value = 'throughAll'; sel.dispatchEvent(new Event('change')); } }); await idle(); await W(400);
console.log('6d through all cut:', JSON.stringify(await win.evaluate(() => { const d = lithApp.doc, g = d.ghost;
  const bb = (pos) => { let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], pos[i]); hi[i % 3] = Math.max(hi[i % 3], pos[i]); } return hi.map((x, i) => +(x - lo[i]).toFixed(1)); };
  return { op: g?.op, toolBox: g?.tool && bb(g.tool.positions), bodyBox: bb(d.mesh.positions), bodyIsResult: d.mesh === g?.result, faces: d.mesh.faces.length,
    col: d.ghostGroup.children.find((o) => o.isMesh)?.material.color.getHexString() }; })));
await win.keyboard.press('Escape'); await idle();
const hole = await win.evaluate(async () => { const d = lithApp.doc, sk1 = d.doc.features.find((x) => x.type === 'sketch');
  const sk = { id: 'fH', type: 'sketch', name: 'SketchH', plane: sk1.plane, planeName: sk1.planeName, next: 5, geo: [{ id: 'O', type: 'point', x: 0, y: 0, fixed: true, origin: true }, { id: 'g1', type: 'point', x: 10, y: 5 }, { id: 'g2', type: 'circle', c: 'g1', r: 10 }], cons: [] };
  const cut = { id: 'fC', type: 'extrude', name: 'Cut-H', op: 'cut', sketch: 'fH', end: 'throughAll', depth: 10, reverse: false, bothSides: true };
  const res = await d.regen([...d.doc.features, sk, cut], { ghost: true }); const g = d.ghost;
  const bb = (pos) => { let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], pos[i]); hi[i % 3] = Math.max(hi[i % 3], pos[i]); } return hi.map((x, i) => +(x - lo[i]).toFixed(1)); };
  return { toolBox: g?.tool && bb(g.tool.positions), bodyBox: bb(d.mesh.positions), shownIsResult: d.mesh === res.mesh, faces: d.mesh.faces.length, col: d.ghostGroup.children.find((o) => o.isMesh)?.material.color.getHexString() }; });
await win.evaluate(() => lithApp.doc.zoomFit?.()); await W(300);
console.log('6e Ø20 Through All hole ghost (tool = removed volume only, ~20×25×20; model = result with hole):', JSON.stringify(hole));
await shot('ghost-cut-through');
await win.evaluate(() => { lithApp.doc.clearGhost(); return lithApp.doc.regen(); }); await idle();
await win.keyboard.press('Escape'); await idle();
console.log('6c after cancel: ghost cleared', JSON.stringify(await win.evaluate(() => ({ ghost: lithApp.doc.ghost, objs: lithApp.doc.ghostGroup.children.length }))));
// middle click (no drag) = Zoom to Fit
await win.evaluate(() => { const d = lithApp.doc; d.vp.scale = 5; d.vp.target.set(300, 0, 0); d.vp.requestRender(); }); await W(200);
const vr = await win.evaluate(() => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left + r.width * 0.7, r.top + r.height * 0.7]; });
await win.mouse.move(vr[0], vr[1]); await win.mouse.down({ button: 'middle' }); await win.mouse.up({ button: 'middle' }); await W(400);
console.log('6d single middle click → nothing:', JSON.stringify(await win.evaluate(() => +lithApp.doc.vp.scale.toFixed(3))));
await W(300);
await win.mouse.down({ button: 'middle' }); await win.mouse.up({ button: 'middle' }); await W(80); await win.mouse.down({ button: 'middle' }); await win.mouse.up({ button: 'middle' }); await W(400);
console.log('6e double middle click → fit:', JSON.stringify(await win.evaluate(() => ({ scale: +lithApp.doc.vp.scale.toFixed(3), target: lithApp.doc.vp.target.toArray().map((x) => +x.toFixed(1)) }))));
// fillet: box without a model spot until an edge is picked
await win.locator('.cm-btn:has-text("Fillet")').click(); await idle();
console.log('7 fillet box:', JSON.stringify(await win.evaluate(() => { const b = document.querySelector('.feat-val'); return b && { label: b.querySelector('label').textContent, v: b.querySelector('input').value, free: b.classList.contains('free') }; })));
await win.keyboard.press('Escape'); await idle();
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
