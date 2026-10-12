// Point cloud analysis: normals, density, cloud-to-cloud (signed with reference normals), cloud-to-part,
// tolerance view, undo, save + reopen. Needs ../scratch/an/*.las from tests/e2e/gen_analyse.py:
//   python3 tests/e2e/gen_analyse.py ../scratch/an
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const D = path.resolve('../scratch/an'), DIR = '/tmp/atest', DOC = DIR + '/An.lithpcd';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
// box part 1000 x 600 x 400 mm (sketch on Top, extruded 400 up)
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const PART = DIR + '/Box.lithprt';
fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Box', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 1000, 0), pt('p3', 1000, 600), pt('p4', 0, 600),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 400, end: 'blind', op: 'boss' }] }));
const T = await launch('cloud');
const { win, W, idle } = T;
await win.evaluate(() => { lithApp.doc.doc.view.budget = 2e6; });
const settle = async (ms = 600) => { await idle().catch(() => {}); await W(ms); await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length), null, { timeout: 60000 }).catch(() => console.log('settle timeout')); await W(200); };
const waitBusy = async () => { await W(400); await win.waitForFunction(() => !lithApp.doc.busy, null, { timeout: 120000 }); await settle(); };
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; }, DOC);
const add = (f) => win.evaluate((p) => lithApp.doc.addCloud(p), f);
const select = (name) => win.evaluate((n) => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.name === n); d.selIds = new Set([r.id]); d.selId = r.id; d.renderTree(); return r.id; }, name);
const last = () => win.evaluate(() => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.id === d.selId); const s = r.analysis?.stats; return { name: r.name, colorMode: r.colorMode, range: r.range?.map((x) => +x.toFixed(4)), fields: d.layers.get(r.id).meta.attrs.fields.map((f) => f.name).join(','), stats: s && { n: s.n, nan: s.nan, min: +s.min.toFixed(4), max: +s.max.toFixed(4), mean: +s.mean.toFixed(4), sd: +s.sd.toFixed(4) } }; });
const runPM = async (cmd, vals = {}) => { await win.evaluate(({ cmd, vals }) => { const d = lithApp.doc; d[cmd](); const pm = d.app.pm.current; for (const [k, v] of Object.entries(vals)) { pm.setValue(k, v); const i = pm.inputs[k]; if (i) i.dispatchEvent(new Event('change')); } }, { cmd, vals }); await W(300); };
const ok = async () => { await win.evaluate(() => lithApp.doc.app.pm.ok()); await waitBusy(); };

await add(D + '/shapes.las'); await settle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomFit(); }); await settle();
// ---- normals ----
await select('shapes.las');
await runPM('cmdNormals'); await ok();
console.log('normals:', JSON.stringify(await last()));
await win.evaluate(() => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.id === d.selId); r.colorMode = 'normal'; d.layers.get(r.id).applyStyle(); d.renderTree(); }); await settle(1000);
await T.shot('an1_normals_colour');
// ---- density ----
await runPM('cmdDensity', { r: 10, kind: 'surface' }); await ok();
console.log('density:', JSON.stringify(await last()));
await T.shot('an2_density');
// ---- cloud to cloud ----
await add(D + '/plane0.las'); await add(D + '/plane50.las'); await settle();
await select('plane0.las'); await runPM('cmdNormals', { orient: 'up' }); await ok();
const refId = await win.evaluate(() => lithApp.doc.selId);
await select('plane50.las'); await runPM('cmdC2C', { ref: refId, maxDist: 20, model: 'plane' });
console.log('c2c sign info:', await win.evaluate(() => lithApp.doc.app.pm.current.inputs.sign.textContent));
await ok();
console.log('c2c (expect mean +0.050, sd ~0.001):', JSON.stringify(await last()));
// tolerance view: ±45 mm -> nearly all above (red)
await win.evaluate(() => { const i = document.querySelector('.pc-panel input[placeholder="off"]'); i.value = '45'; i.dispatchEvent(new Event('change')); }); await settle(600);
console.log('tolerance info:', await win.evaluate(() => [...document.querySelectorAll('.pc-panel .pm-info')].map((e) => e.textContent).join(' | ')));
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('top', false); d.zoomTo(d.selId); }); await settle(800);
await T.shot('an3_c2c_tolerance');
// ---- cloud to part ----
await add(D + '/boxscan.las'); await settle();
await win.evaluate((p) => lithApp.open(p), PART); await W(500); await idle().catch(() => {});
await win.evaluate(() => lithApp.activate(lithApp.tabs.find((t) => t.doc?.doc?.kind === 'cloud' || t.kind === 'cloud') || lithApp.tabs[0])); await W(500);
console.log('active kind', await win.evaluate(() => lithApp.doc.doc.kind));
await select('boxscan.las');
await win.evaluate(() => lithApp.doc.cmdC2M());
await win.waitForFunction(() => !!lithApp.doc.c2mMesh, null, { timeout: 60000 }).catch(async () => console.log('NO MESH:', await win.evaluate(() => [lithApp.doc.app.pm.current?.inputs.pinfo?.textContent, lithApp.tabs.map((t) => t.path).join()].join(' / '))));
const place = await win.evaluate(() => {
  const d = lithApp.doc, P = d.c2mMesh.positions, mn = [Infinity, Infinity, Infinity];
  for (let i = 0; i < P.length; i += 3) { const v = [P[i] / 1000, -P[i + 2] / 1000, P[i + 1] / 1000]; for (let k = 0; k < 3; k++) mn[k] = Math.min(mn[k], v[k]); }
  const O = d.doc.origin, tgt = [200001, 500001, 10].map((v, k) => v - O[k]);
  return { dx: +(tgt[0] - mn[0]).toFixed(6), dy: +(tgt[1] - mn[1]).toFixed(6), dz: +(tgt[2] - mn[2]).toFixed(6), info: d.app.pm.current.inputs.pinfo.textContent };
});
console.log('part:', JSON.stringify(place));
console.log('snap to scan (expect ~ same dx/dy, dz):', await win.evaluate(() => { [...document.querySelectorAll('.pm-buttons button, .pm-body button')].find((b) => /Put part on the scan/.test(b.textContent)).click(); const v = lithApp.doc.app.pm.current.values; return [v.dx, v.dy, v.dz].join(', '); }));
await win.evaluate((v) => { const pm = lithApp.doc.app.pm.current; for (const k of ['dx', 'dy', 'dz']) { const i = pm.inputs[k]; i.value = String(v[k]); i.dispatchEvent(new Event('change')); } pm.setValue('maxDist', 10); }, place);
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('iso', false); d.zoomTo(d.selId); }); await settle(800);
await T.shot('an4_part_preview');
await ok();
console.log('c2m (expect min -0.003, max +0.020):', JSON.stringify(await last()));
console.log('c2m histogram peaks (mm):', await win.evaluate(() => { const d = lithApp.doc, r = d.doc.clouds.find((c) => c.id === d.selId), { lo, hi, bins } = r.analysis.stats.hist, w = (hi - lo) / bins.length; return bins.map((n, i) => [((lo + (i + 0.5) * w) * 1000).toFixed(1), n]).filter((x) => x[1] > 500).map((x) => x.join(':')).join(' '); }));
await settle(800);
await T.shot('an5_c2m');
// ---- undo / redo / save + reopen ----
const n0 = await win.evaluate(() => lithApp.doc.doc.clouds.length);
await win.evaluate(() => lithApp.doc.undo()); await W(500);
const n1 = await win.evaluate(() => lithApp.doc.doc.clouds.length);
await win.evaluate(() => lithApp.doc.redo()); await settle();
console.log('clouds before/after undo/redo', n0, n1, await win.evaluate(() => lithApp.doc.doc.clouds.length));
await win.evaluate(() => lithApp.save()); await W(800);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await settle();
console.log('reopened analyses:', await win.evaluate(() => lithApp.doc.doc.clouds.filter((r) => r.analysis).map((r) => `${r.name} [${r.analysis.op}:${r.analysis.field}]`).join(', ')));
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
