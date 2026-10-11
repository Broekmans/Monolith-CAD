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
const S = () => win.evaluate(() => { const s = lithApp.doc.sketcher; return { dof: s.state.dof, conf: s.state.conflicting.length, st: document.querySelector('.st-sketch').textContent }; });
await btn('Straight Slot'); await click(10, 10); await click(40, 10.5); await click(30, 18); await win.keyboard.press('Escape');
const sl = await win.evaluate(() => { const s = lithApp.doc.sketcher.sk; return s.cons.map((c) => c.type).join(); });
console.log('slot cons', sl, JSON.stringify(await S()));
console.log('probe', await win.evaluate(async () => { const s = lithApp.doc.sketcher; const l = s.sk.geo.find((g) => g.type === 'line' && !g.construction); const out = []; for (const id of [l.p1, s.sk.geo.find((g)=>g.type==='arc').c]) { const q = s.G(id); s.dragSolve({ id, last: [q.x, q.y] }, [q.x - 3, q.y + 4]); out.push(id + ':' + JSON.stringify(s.P(id))); } return out.join(' | '); }));
// drag a slot arc point
const before = await win.evaluate(() => lithApp.doc.sketcher.P(lithApp.doc.sketcher.sk.geo.find((g) => g.type === 'line' && !g.construction).p1));
const [x0, y0] = await P(before[0], before[1]); await win.mouse.move(x0, y0); await win.mouse.down(); const [x1, y1] = await P(before[0] - 5, before[1] + 6); await win.mouse.move(x1, y1, { steps: 6 }); await win.mouse.up(); await W(200);
const after = await win.evaluate(() => lithApp.doc.sketcher.P(lithApp.doc.sketcher.sk.geo.find((g) => g.type === 'line' && !g.construction).p1));
console.log('drag', before, after, Math.hypot(after[0] - before[0], after[1] - before[1]) > 1 ? 'DRAG PASS' : 'DRAG FAIL');
// mirror slot about a vertical centerline at x=-5
await btn('Centerline'); await click(-5, -20); await click(-5, 30); await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
const n0 = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.length);
await btn('Mirror Entities'); await W(200);
const slotIds = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter((g) => g.type === 'line' && !g.construction || g.type === 'arc').map((g) => g.id));
for (const id of slotIds) { const m = await win.evaluate((id) => { const s = lithApp.doc.sketcher, g = s.G(id); if (g.type === 'line') { const a = s.P(g.p1), b = s.P(g.p2); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; } const c = s.P(g.c), q = s.P(g.s), e = s.P(g.e); const a0 = Math.atan2(q[1] - c[1], q[0] - c[0]); let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); while (a1 <= a0) a1 += 2 * Math.PI; const am = (a0 + a1) / 2; return [c[0] + g.r * Math.cos(am), c[1] + g.r * Math.sin(am)]; }, id); await click(m[0], m[1]); }
console.log('step1 sel', slotIds.join(), await win.evaluate(() => [...lithApp.doc.sketcher.sel].join()));
await win.keyboard.press('Enter'); await W(100);
await click(-5, 0); await W(300);
const n1 = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.length);
const xs = await win.evaluate(() => { const s = lithApp.doc.sketcher; return s.sk.geo.filter((g) => g.type === 'point').map((p) => +p.x.toFixed(2)); });
console.log('mirror geo', n0, '->', n1, JSON.stringify(await S()), 'minX', Math.min(...xs), Math.min(...xs) < -40 ? 'MIRROR PASS' : 'MIRROR FAIL');
console.log('under copies', await win.evaluate(() => { const s = lithApp.doc.sketcher; return [...s.sel].map((k) => k.slice(4)).map((id) => id + ':' + s.under.has(id)).join(' '); }));
const reg = await win.evaluate(async () => { const m = await import('../shared/profile.mjs').catch(() => null); const s = lithApp.doc.sketcher; const cs = s.curves().filter((c) => !c.construction); return { n: cs.length, kinds: cs.map((c) => c.kind + (c.kind === 'arc' ? '[' + c.a0.toFixed(2) + ',' + c.a1.toFixed(2) + ']' : '')).join(' '), mod: !!m }; });
console.log('curves', JSON.stringify(reg));
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Boss'); await idle();
await win.locator('.pm-ok').click(); await idle();
console.log('faces', await win.evaluate(() => lithApp.doc.mesh?.faces?.length), JSON.stringify(await win.evaluate(() => lithApp.doc.status?.map((x) => x.state))));
await app.close();
