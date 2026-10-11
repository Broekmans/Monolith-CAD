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
await btn('Centerline'); await click(0, -30); await click(0, 30); await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
// case A: open half profile ending on the centerline
await btn('Line'); await click(0, 20); await click(20, 20); await click(20, -20); await click(0, -20); await click(0, 20); await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
// case B: closed rectangle away from axis
await btn('Corner Rectangle'); await click(30, 5); await click(40, -5); await win.keyboard.press('Escape');
await win.evaluate(() => { const s = lithApp.doc.sketcher; s.sel.clear(); s.sk.geo.filter((g) => g.type !== 'point').forEach((g) => s.sel.add('geo:' + g.id)); });
await btn('Mirror Entities'); await W(300);
console.log('st', await win.evaluate(() => document.querySelector('.st-sketch').textContent));
console.log('cons', await win.evaluate(() => lithApp.doc.sketcher.sk.cons.map((c) => c.type).join()));
console.log('pts', await win.evaluate(() => JSON.stringify(lithApp.doc.sketcher.curves().filter((c) => !c.construction).map((c) => [c.a, c.b].map((p) => p.map((v) => +v.toFixed(2)))))));
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Boss'); await idle();
await win.locator('.pm-ok').click(); await idle();
console.log('mass', await win.evaluate(() => lithApp.doc.status?.map((x) => x.state + ':' + (x.msg || '')).join()));
console.log('faces', await win.evaluate(() => lithApp.doc.mesh?.faces?.length));
await app.close();
