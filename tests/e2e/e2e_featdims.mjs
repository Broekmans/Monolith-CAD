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
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Boss'); await idle();
await win.locator('.pm-numrow input').first().fill('30'); await win.locator('.pm-numrow input').first().press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle();
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(300);
await win.locator('.tr-row:has-text("Front Plane")').click();
await tab('Sketch'); await btn('Sketch'); await W(700);
await btn('Circle'); await click(0, 15); await click(8, 15); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await tab('Features'); await btn('Extruded Cut'); await idle();
await win.locator('.pm-ok').click(); await idle();
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(300);
const info = await win.evaluate(() => { const d = lithApp.doc; const m = d.mesh; return { feats: d.doc.features.map((f) => f.id + ':' + f.type).join(), owners: m.faces.map((f) => f.type + '>' + f.feat).join(' ') }; });
console.log(JSON.stringify(info));
// double-click top face
const top = await win.evaluate(() => lithApp.doc.mesh.faces.find((f) => f.plane && f.plane.normal[1] > 0.99).c);
const [tx, ty] = await WP([top[0] + 20, top[1], top[2] + 20]);
await win.mouse.dblclick(tx, ty); await W(400);
console.log('dimFeat', await win.evaluate(() => lithApp.doc.F(lithApp.doc.dimFeat)?.name), await win.evaluate(() => lithApp.doc._dimHits.map((d) => d.text).join(' | ')));
await shot('fd1');
// edit depth via label
const hit = await win.evaluate(() => { const d = lithApp.doc._dimHits.find((x) => x.key === 'depth'); const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left + (d.x0 + d.x1) / 2, r.top + (d.y0 + d.y1) / 2]; });
await win.mouse.dblclick(hit[0], hit[1]); await W(300);
await win.keyboard.press('Control+a'); await win.keyboard.type('45'); await win.keyboard.press('Enter'); await idle();
console.log('depth now', await win.evaluate(() => lithApp.doc.doc.features.find((f) => f.type === 'extrude').depth));
// sketch dim edit
const h2 = await win.evaluate(() => { const d = lithApp.doc._dimHits.find((x) => x.kind === 'cons' && x.value === 120); const r = lithApp.doc.vp.el.getBoundingClientRect(); return d && [r.left + (d.x0 + d.x1) / 2, r.top + (d.y0 + d.y1) / 2]; });
if (h2) { await win.mouse.dblclick(h2[0], h2[1]); await W(300); await win.keyboard.press('Control+a'); await win.keyboard.type('150'); await win.keyboard.press('Enter'); await idle(); }
console.log('bbox x', await win.evaluate(() => { const xs = lithApp.doc.mesh.faces.map((f) => f.c[0]); return [Math.min(...xs), Math.max(...xs)]; }));
// 0.1.72: a single click on a dimension label keeps the dimensions (first click of a double-click)
const h3 = await win.evaluate(() => { const d = lithApp.doc._dimHits.find((x) => x.kind === 'cons'); const r = lithApp.doc.vp.el.getBoundingClientRect(); return d && [r.left + (d.x0 + d.x1) / 2, r.top + (d.y0 + d.y1) / 2]; });
if (h3) { await win.mouse.click(h3[0], h3[1]); await W(300); }
console.log('0.1.72 click on label keeps dims:', await win.evaluate(() => [!!lithApp.doc.dimFeat, lithApp.doc._dimHits.length]));
// sizes without a dimension: the circle of the cut has none → dashed Ø shown, editing it adds a diameter dimension
await win.keyboard.press('Escape'); await win.mouse.click(5, 300); await W(200);
await win.evaluate(() => { const d = lithApp.doc; d.showFeatureDims(d.doc.features.find((f) => f.type === 'extrude' && f.op === 'cut').id); }); await W(400);
console.log('0.1.72 cut dims:', await win.evaluate(() => lithApp.doc._dimHits.map((d) => d.kind + ':' + d.text).join(' | ')), 'sketch line colour', await win.evaluate(() => lithApp.doc.sketchGroup.children[0]?.material.color.getHexString()));
await shot('fd-auto');
const h4 = await win.evaluate(() => { const d = lithApp.doc._dimHits.find((x) => x.kind === 'auto'); const r = lithApp.doc.vp.el.getBoundingClientRect(); return d && [r.left + (d.x0 + d.x1) / 2, r.top + (d.y0 + d.y1) / 2]; });
if (h4) { await win.mouse.dblclick(h4[0], h4[1]); await W(300); await win.locator('.dim-inline').fill('20'); await win.locator('.dim-inline').press('Enter'); await idle(); }
console.log('0.1.72 after Ø20:', await win.evaluate(() => { const d = lithApp.doc, sk = d.doc.features.filter((f) => f.type === 'sketch')[1]; const c = sk.cons.find((x) => x.type === 'diameter'); const g = sk.geo.find((x) => x.type === 'circle'); return { cons: c && c.value, r: g.r, hits: d._dimHits.map((x) => x.kind + ':' + x.text).join(' | ') }; }));
// rectangle without dimensions: one width + one height shown
// rectangle without dimensions (remove its two dims on a copy): one width + one height shown
console.log('0.1.72 rect without dims:', await win.evaluate(() => { const d = lithApp.doc, sk = d.doc.features.find((f) => f.type === 'sketch'); const keep = sk.cons; sk.cons = keep.filter((c) => !['length', 'distance', 'hdist', 'vdist'].includes(c.type)); d.showFeatureDims(d.doc.features.find((f) => f.type === 'extrude').id); const t = d.featureDims().map((x) => x.kind + ':' + x.text).join(' | '); sk.cons = keep; d.showFeatureDims(null); return t; }));
// tree hover on cut
await win.keyboard.press('Escape');
await win.locator('.tr-row:has-text("Cut-Extrude")').hover(); await W(400);
console.log('hover faces', await win.evaluate(() => lithApp.doc.hlGroup.children.length));
await shot('fd2');
await app.close();
