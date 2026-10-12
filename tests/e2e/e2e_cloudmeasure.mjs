// Point cloud measuring: distance / height / angle / polyline by mouse clicks on known geometry of the
// synthetic building (walls x=0 and x=30, y=0 and y=20, floors z=0/3.5/7, height 10.5), point info,
// undo, save + reopen. Needs ../scratch/pc/big7.laz; optional STONEX=<laz with fields>
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const BIG = path.resolve('../scratch/pc/big7.laz'), REAL = process.env.STONEX;
const DOC = '/tmp/mtest/Meas.lithpcd'; fs.rmSync('/tmp/mtest', { recursive: true, force: true }); fs.mkdirSync('/tmp/mtest');
const T = await launch('cloud');
const { win, W, idle } = T;
await win.evaluate(() => { lithApp.doc.doc.view.budget = 3e6; });
const settle = async (ms = 800) => { await idle().catch(() => {}); await W(ms); await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length), null, { timeout: 60000 }).catch(() => console.log('settle timeout')); await W(300); };
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; }, DOC);
await win.evaluate((p) => lithApp.doc.addCloud(p), BIG); await settle();
const O = await win.evaluate(() => lithApp.doc.doc.origin);
const X0 = 150000, Y0 = 450000; // synthetic building corner (scan coords)
const scr = (a) => win.evaluate((a) => { const d = lithApp.doc; const r = d.vp.el.getBoundingClientRect(); const s = d.absToScreen(a); return [r.left + s[0], r.top + s[1]]; }, a);
const clickAbs = async (a) => { const [x, y] = await scr(a); await win.mouse.move(x, y, { steps: 2 }); await W(150); await win.mouse.down(); await win.mouse.up(); await W(250); };
const last = () => win.evaluate(() => { const m = lithApp.doc.doc.measures.at(-1); return m && { name: m.name, pts: m.pts.map((p) => p.map((v) => +v.toFixed(3))) }; });
const vals = () => win.evaluate(() => { const d = lithApp.doc; return d.doc.measures.map((m) => m.name + ' = ' + document.querySelector('.panel.tree') && m.name).join(); });
void vals;
const value = (type) => win.evaluate((type) => { const m = lithApp.doc.doc.measures.filter((x) => x.type === type).at(-1); const p = m.pts; const L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (type === 'distance') return L(p[0], p[1]); if (type === 'height') return Math.abs(p[1][2] - p[0][2]);
  if (type === 'angle') { const a = p[0].map((v, i) => v - p[1][i]), b = p[2].map((v, i) => v - p[1][i]); return Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b)) * 180 / Math.PI; }
  let A = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; A += q[0] * r[1] - r[0] * q[1]; } return Math.abs(A) / 2; }, type);
// ---- front view: distance, height, angle ----
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.zoomFit(); }); await settle(1500);
await win.evaluate(() => lithApp.doc.cmdMeasure('distance')); await W(300);
await clickAbs([X0 + 0.2, Y0, 5.0]); await clickAbs([X0 + 29.8, Y0, 5.0]);
const dist = await value('distance'); console.log('distance (expect 29.6 +- 0.1)', dist.toFixed(3), JSON.stringify(await last()));
await win.evaluate(() => lithApp.doc.cmdMeasure('height')); await W(300);
await clickAbs([X0 + 15, Y0, 0.15]); await clickAbs([X0 + 15, Y0, 10.35]);
const hgt = await value('height'); console.log('height (expect 10.2 +- 0.1)', hgt.toFixed(3));
await win.evaluate(() => lithApp.doc.cmdMeasure('angle')); await W(300);
await clickAbs([X0 + 0.2, Y0, 0.2]); await clickAbs([X0 + 29.8, Y0, 0.2]); await clickAbs([X0 + 29.8, Y0, 10.3]);
const ang = await value('angle'); console.log('angle (expect 90 +- 1)', ang.toFixed(2));
await T.shot('ms1_front');
// ---- top view: polyline on the roof (z = 7 floor is the top one) ----
await win.keyboard.press('Escape'); await W(200);
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); d.zoomFit(); }); await settle(1500);
await win.evaluate(() => lithApp.doc.cmdMeasure('poly')); await W(300);
for (const [x, y] of [[1, 1], [29, 1], [29, 19], [1, 19]]) await clickAbs([X0 + x, Y0 + y, 7]);
{ const [x, y] = await scr([X0 + 15, Y0 + 10, 7]); await win.mouse.click(x, y, { button: 'right' }); await W(300); }
const area = await value('poly'); console.log('poly area (expect 504 +- 3)', area.toFixed(2), 'z of points', JSON.stringify((await last()).pts.map((p) => p[2])));
await T.shot('ms2_top_poly');
// ---- point info ----
await win.evaluate(() => lithApp.doc.cmdMeasure('info')); await W(300);
await clickAbs([X0 + 10, Y0 + 10, 7]); await W(500);
console.log('point info:', await win.evaluate(() => document.querySelector('.pm-body').innerText.replace(/\n+/g, ' | ')));
await win.keyboard.press('Escape'); await W(200);
// ---- tree, undo, save + reopen ----
console.log('tree:', await win.evaluate(() => [...document.querySelectorAll('.panel.tree .tr-row')].map((r) => r.innerText.trim()).filter((t) => /Measure|Distance|Height|Angle|Polyline/.test(t)).join(' | ')));
await win.evaluate(() => lithApp.doc.undo()); await W(300);
console.log('after undo measures:', await win.evaluate(() => lithApp.doc.doc.measures.length));
await win.evaluate(() => lithApp.doc.redo()); await W(300);
await win.evaluate(() => lithApp.save()); await W(500);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await settle();
console.log('reopened measures:', await win.evaluate(() => lithApp.doc.doc.measures.map((m) => m.name).join(', ')));
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomFit(); }); await settle(1000);
await T.shot('ms3_reopened_iso');
// ---- Stonex: point info with fields ----
if (REAL) {
  await win.evaluate(() => lithApp.newDoc('cloud')); await W(600);
  await win.evaluate(() => { lithApp.doc.doc.view.budget = 2e6; });
  await win.evaluate((p) => lithApp.doc.addCloud(p), REAL); await settle();
  await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); d.zoomFit(); d.cmdMeasure('info'); }); await settle(800);
  const vp = await win.evaluate(() => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await win.mouse.move(vp[0], vp[1], { steps: 2 }); await W(200); await win.mouse.down(); await win.mouse.up(); await W(800);
  console.log('stonex point info:', await win.evaluate(() => document.querySelector('.pm-body').innerText.replace(/\n+/g, ' | ')));
  await T.shot('ms4_stonex_info');
}
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
