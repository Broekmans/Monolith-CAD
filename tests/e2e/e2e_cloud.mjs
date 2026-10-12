// Point Cloud document: open big LAZ (octree cache build), LOD, colour modes, EDL, reopen from cache, export.
// Needs scratch/pc/big7.laz (10 M points, made with scratch/pc/gen.py) and optionally STONEX=<real .laz>
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const BIG = path.resolve('../scratch/pc/big7.laz');
const REAL = process.env.STONEX;
for (const f of [BIG, REAL]) if (f) for (const c of [f + '.lithcache']) fs.rmSync(c, { force: true });
const T = await launch('cloud');
const { win, W, idle } = T;
// software GL in the test machine is slow: keep the point budget small
await win.evaluate(() => { lithApp.doc.doc.view.budget = 3e6; });
const info = () => win.evaluate(() => { const d = lithApp.doc; const ls = [...d.layers.values()]; return ls.map((l) => ({ name: l.rec.name, count: l.meta.count, nodes: l.meta.nodes.length, loaded: [...l.nodes.values()].filter((n) => n.obj).length, maxDepthLoaded: Math.max(0, ...[...l.nodes.values()].filter((n) => n.obj).map((n) => n.depth)), loadedPts: l.loadedPoints, mode: l.rec.colorMode })).concat([{ shown: d.shown }]); });
const settle = async (ms = 1500) => {
  await idle(); await W(ms);
  try { await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length), null, { timeout: 30000 }); }
  catch (e) { console.log('SETTLE TIMEOUT', await win.evaluate(() => [...lithApp.doc.layers.values()].map((l) => ({ inflight: l.inflight, q: l.queue.length, qn: l.queue.slice(0, 5).map((n) => [n.name, n.n, !!n.obj, n.loading]), gen: l.gen }))).then(JSON.stringify)); console.log(T.logs.slice(-15).join('\n')); }
  await W(300);
};
let t0 = Date.now();
await win.evaluate((p) => lithApp.doc.addCloud(p), BIG);
console.log('open+build big7 (10M) ms', Date.now() - t0);
await settle();
console.log('after open', JSON.stringify(await info()));
await T.shot('cloud1_edl');
await win.evaluate(() => lithApp.doc.setView({ edl: false })); await settle(400);
await T.shot('cloud2_noedl');
await win.evaluate(() => lithApp.doc.setView({ edl: true }));
// colour modes
for (const m of ['height', 'intensity', 'class']) {
  await win.evaluate((m) => { const d = lithApp.doc; const r = d.doc.clouds[0]; r.colorMode = m; d.layers.get(r.id).applyStyle(); d.renderTree(); d.scheduleLOD(); }, m);
  await settle(600);
  await T.shot('cloud3_' + m);
}
// zoom in on a corner: deeper nodes load
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.setView('top', false); lithApp.doc.zoomFit(); vp.zoomAt(vp.width * 0.25, vp.height * 0.3, 0.04); });
await settle(1500);
console.log('zoomed', JSON.stringify(await info()));
await T.shot('cloud4_zoom');
// height section
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds[0]; r.colorMode = 'rgb'; r.clip = { on: true, min: -4.2, max: -3.9 }; d.layers.get(r.id).applyStyle(); d.zoomFit(); d.renderTree(); });
await settle(800);
await T.shot('cloud5_slice');
// real Stonex scan with fields
if (REAL) {
  t0 = Date.now();
  await win.evaluate(() => lithApp.newDoc('cloud')); await W(800);
  await win.evaluate(() => { lithApp.doc.doc.view.budget = 3e6; });
  await win.evaluate((p) => lithApp.doc.addCloud(p), REAL);
  console.log('open+build Stonex ms', Date.now() - t0);
  await settle();
  await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomFit(); });
  await settle(); await T.shot('cloud6_stonex_rgb');
  await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.clouds[0]; d.selId = r.id; r.colorMode = 'field:room'; r.categorical = true; d.layers.get(r.id).applyStyle(); d.renderTree(); d.scheduleLOD(); });
  await settle(); await T.shot('cloud7_stonex_rooms');
  console.log('panel', await win.evaluate(() => document.querySelector('.panel.tree').innerText.replace(/\n+/g, ' | ').slice(0, 600)));
  await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); const r = d.doc.clouds[0]; r.colorMode = 'rgb'; r.clip = { on: true, min: -0.8, max: -0.5 }; d.layers.get(r.id).applyStyle(); d.zoomFit(); d.renderTree(); });
  await settle(); await T.shot('cloud8_stonex_slice');
}
// save -> reopen from cache
const json = await win.evaluate(() => JSON.stringify(lithApp.doc.toJSON()));
await win.evaluate(async (j) => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); }, json);
t0 = Date.now();
await win.evaluate(async (j) => { await lithApp.loadDoc(JSON.parse(j)); }, json);
await settle();
console.log('reopen from cache ms', Date.now() - t0, JSON.stringify(await info()));
console.log('status', await win.evaluate(() => document.querySelector('.st-left').textContent));
// export LAS
t0 = Date.now();
const out = path.resolve('../scratch/pc/export_test.las');
const r = await win.evaluate(async (o) => { const l = [...lithApp.doc.layers.values()][0]; return window.monolith.cloudExport(l.id, o, 'las', 1); }, out);
console.log('export', JSON.stringify(r), Date.now() - t0, 'ms', fs.statSync(out).size);
// home screen card
await win.evaluate(() => lithApp.root.activate(lithApp.root)); await W(500);
await T.shot('cloud9_home');
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
