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

await clickWorld([30, 30, 10]);
await tab('Sketch'); await btn('Sketch'); await W(700);
const g = await win.evaluate(() => { const m = lithApp.doc.sketcher.modelSnapGeo(); return { v: m.verts, m: m.mids, s: m.segs.length }; });
console.log('model snap geo', g.v.length, 'verts', g.m.length, 'mids', g.s, 'segs');
const v = g.v[0], m = g.m[0];
await btn('Corner Rectangle').catch(() => btn('Rectangle'));
await click(v[0] + 0.8, v[1] - 0.8); await click(m[0] + 0.5, m[1] + 0.5); await win.keyboard.press('Escape');
const res = await win.evaluate(() => { const sk = lithApp.doc.sketcher.sk; return { pts: sk.geo.filter((x) => x.type === 'point' && !x.origin).map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]), fixes: sk.cons.filter((c) => c.type === 'fix').length, status: document.querySelector('.st-sketch').textContent }; });
console.log(JSON.stringify(res), 'expect corner', v, 'mid', m);
const has = (q) => res.pts.some((p) => Math.abs(p[0] - q[0]) < 1e-3 && Math.abs(p[1] - q[1]) < 1e-3);
console.log(has(v) && has(m) && res.fixes >= 2 ? 'SNAP PASS' : 'SNAP FAIL');
// select-mode: line endpoint + model edge -> Midpoint relation
await btn('Line'); await click(-30, -10); await click(-20, -5); await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
const lp = await win.evaluate(() => { const sk = lithApp.doc.sketcher; const l = sk.sk.geo.filter((g) => g.type === 'line').pop(); return { id: l.p2, p: sk.P(l.p2) }; });
await click(lp.p[0], lp.p[1]);
const e0 = g.m[1]; // midpoint of some model edge -> click a bit off-centre along that edge
await win.evaluate(() => 0);
const ed = await win.evaluate((m) => { const M = lithApp.doc.sketcher.modelSnapGeo(); return M.edges.map((x) => x.pts).find((q) => Math.abs((q[0][0] + q[q.length - 1][0]) / 2 - m[0]) < 1e-6 && Math.abs((q[0][1] + q[q.length - 1][1]) / 2 - m[1]) < 1e-6); }, e0);
const qx = ed[0][0] * 0.3 + ed[ed.length - 1][0] * 0.7, qy = ed[0][1] * 0.3 + ed[ed.length - 1][1] * 0.7;
await click(qx, qy);
const rels = await win.evaluate(() => lithApp.doc.sketcher.applicableRelations());
console.log('relations offered', rels.join());
await win.evaluate(() => lithApp.doc.sketcher.addRelation('midpoint'));
const np = await win.evaluate((id) => lithApp.doc.sketcher.P(id), lp.id);
console.log('endpoint now', np, 'expect', e0, Math.hypot(np[0] - e0[0], np[1] - e0[1]) < 1e-4 ? 'MIDREL PASS' : 'MIDREL FAIL');
await app.close();
