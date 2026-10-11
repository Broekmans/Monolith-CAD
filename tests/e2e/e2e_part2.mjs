import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part' }, timeout: 60000 });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => { if (!/Security|WebGL|GPU stall|swiftshader|boot\]/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await win.waitForTimeout(3500);
const shot = async (n) => { await win.waitForTimeout(500); await win.screenshot({ path: `tests/e2e/shots/${n}.png` }); };
const P = async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
const click = async (x, y) => { const [px, py] = await P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await win.waitForTimeout(120); };
const btn = (label) => win.locator(`.cm-btn:has-text("${label}")`).first().click();
const tab = (label) => win.locator(`.cm-tab:has-text("${label}")`).click();
const W = (ms) => win.waitForTimeout(ms);
process.on('exit', () => console.log(logs.join('\n')));
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(200); };
// world point -> page
const WP = async (p) => win.evaluate((p) => { const vp = lithApp.doc.vp; const r = vp.el.getBoundingClientRect(); const s = vp.toScreen(p); return [r.left + s[0], r.top + s[1]]; }, p);
const clickWorld = async (p, mods = []) => { const [x, y] = await WP(p); await win.mouse.move(x, y, { steps: 2 }); for (const m of mods) await win.keyboard.down(m); await win.mouse.down(); await win.mouse.up(); for (const m of mods) await win.keyboard.up(m); await W(150); };
const edgesWhere = (fnSrc) => win.evaluate((src) => { const f = eval(src); return lithApp.doc.mesh.edges.filter(f).map((e) => { const i = Math.floor(e.pts.length / 6) * 3; return { id: e.id, mid: e.mid, p: [e.pts[i], e.pts[i + 1], e.pts[i + 2]] }; }); }, fnSrc);

// Base: center rectangle 120x80 on Top plane, extrude 30
await win.locator('.tr-row:has-text("Top Plane")').click();
await tab('Sketch'); await btn('Sketch'); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.3; vp.requestRender(); });
await btn('Center Rectangle'); await click(0, 0); await click(60, 40); await win.keyboard.press('Escape');
await btn('Smart Dimension');
await click(0, 40); await click(0, 55); await win.keyboard.type('120'); await win.keyboard.press('Enter'); await W(200);
let rx = await win.evaluate(() => Math.max(...lithApp.doc.sketcher.sk.geo.filter(g=>g.type==='point').map(p=>p.x)));
await click(rx, 0); await click(rx + 15, 0); await win.keyboard.type('80'); await win.keyboard.press('Enter'); await W(200);
await win.keyboard.press('Escape');
console.log('sketch', await win.evaluate(() => document.querySelector('.st-sketch').textContent));
await shot('q1_sketch_full');
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Boss'); await idle();
await win.locator('.pm-numrow input').first().fill('30'); await win.locator('.pm-numrow input').first().press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle();
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(300);

// Sketch on top face: circle, cut-extrude through all
const topFace = await win.evaluate(() => lithApp.doc.mesh.faces.find((f) => f.plane && f.plane.normal[1] > 0.99).c);
await clickWorld([30, 30, 10]);
const selKind = await win.evaluate(() => lithApp.doc.sel.map(s=>s.kind).join());
console.log('selected', selKind, topFace);
await tab('Sketch'); await btn('Sketch'); await W(700);
await btn('Circle'); await click(35, 15); await click(43, 15); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Cut'); await idle();
await shot('q2_cut_pm');
await win.locator('.pm-ok').click(); await idle();
console.log('after cut', await win.evaluate(() => JSON.stringify(lithApp.doc.status.map(s=>s.state))));

// Linear pattern of the cut along X
await win.locator('.tr-row:has-text("Cut-Extrude1")').click();
await btn('Linear Pattern'); await idle();
await win.locator('.pm-numrow input').nth(0).fill('-35'); await win.locator('.pm-numrow input').nth(0).press('Enter');
await win.locator('.pm-numrow input').nth(1).fill('3'); await win.locator('.pm-numrow input').nth(1).press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle();

// Fillet the 4 vertical edges
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(300);
const vert = await edgesWhere("(e) => e.type==='line' && Math.abs(e.mid[1]-15)<1e-3 && Math.abs(Math.abs(e.mid[0])-60)<1e-3");
console.log('vertical edges', vert.length);
await btn('Fillet'); await idle();
for (const e of vert) { await clickWorld(e.p); }
await win.locator('.pm-numrow input').first().fill('8'); await win.locator('.pm-numrow input').first().press('Enter'); await idle();
await shot('q3_fillet_pm');
await win.locator('.pm-ok').click(); await idle();
// Shell removing bottom face
await btn('Shell'); await idle();
await win.evaluate(() => { lithApp.doc.vp.setView('bottom', false); lithApp.doc.zoomFit(); }); await W(400);
await clickWorld([0, 0, 0]);
await win.locator('.pm-numrow input').first().fill('3'); await win.locator('.pm-numrow input').first().press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle();
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(400);
await shot('q4_final');
console.log('status', await win.evaluate(() => JSON.stringify(lithApp.doc.status)));
await win.evaluate(() => { lithApp.doc.vp.setView('bottom', false); lithApp.doc.vp.rotateBy(0.4, 0.5); }); await shot('q5_bottom');
// edit extrude depth through the tree
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); });
await win.locator('.tr-row:has-text("Boss-Extrude1")').dblclick(); await idle();
await win.locator('.pm-numrow input').first().fill('45'); await win.locator('.pm-numrow input').first().press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle();
console.log('after edit', await win.evaluate(() => JSON.stringify(lithApp.doc.status)));
await win.evaluate(() => lithApp.doc.zoomFit()); await shot('q6_edited');
// mass + export
const vol = await win.evaluate(async () => (await window.monolith.kernel('mass', { features: lithApp.doc.doc.features })).volume);
console.log('volume', vol);
const step = await win.evaluate(async () => (await window.monolith.kernel('exportStep', { features: lithApp.doc.doc.features })).length);
console.log('step bytes', step);
fs.writeFileSync('tests/e2e/shots/part_doc.json', await win.evaluate(() => JSON.stringify(lithApp.doc.doc)));
// undo / redo
await win.keyboard.press('Control+z'); await idle();
console.log('undo depth', await win.evaluate(() => lithApp.doc.doc.features.find(f=>f.type==='extrude').depth));
await win.keyboard.press('Control+y'); await idle();
console.log(logs.join('\n'));
await app.close();
