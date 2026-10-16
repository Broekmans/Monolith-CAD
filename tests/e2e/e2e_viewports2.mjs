// 0.1.68: several viewports in Point Cloud and Drawing documents. Needs ../scratch/pc/vp.laz (gen_cloud.py 2e6 ../scratch/pc/vp.laz 7)
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const LAZ = path.resolve('../scratch/pc/vp.laz');
{
  const T = await launch('cloud');
  const { win, W, idle } = T;
  const settle = async (ms = 800) => { await idle().catch(() => {}); await W(ms); await win.waitForFunction(() => [...lithApp.doc.layers.values()].every((l) => !l.inflight && !l.queue.length), null, { timeout: 60000 }).catch(() => console.log('settle timeout')); await W(400); };
  await win.evaluate(() => { lithApp.doc.doc.view.budget = 1e6; });
  await win.evaluate((p) => lithApp.doc.addCloud(p), LAZ); await settle();
  const st = () => win.evaluate(() => { const d = lithApp.doc, s = d.viewSet, l = [...d.layers.values()][0];
    return { n: s.panes.length, active: s.panes.indexOf(s.active), perPane: s.panes.map((p) => { const v = l.visBy?.get(p); return v ? [...v].filter((nd) => nd.obj).reduce((a, nd) => a + nd.n, 0) : null; }), loaded: l.loadedPoints, edls: d.edls.size }; });
  console.log('1 single:', JSON.stringify(await st()));
  await win.evaluate(() => lithApp.onMenu('layout', 'four')); await settle(1500);
  console.log('2 four:', JSON.stringify(await st()));
  // zoom into a corner in pane 3 only: its LOD gets finer there, the others stay
  await win.evaluate(() => { const s = lithApp.doc.viewSet, p = s.panes[3]; s.setActive(p); p.scale /= 6; p.requestRender(); lithApp.doc.viewChanged(); }); await settle(1500);
  console.log('3 pane 3 zoomed in:', JSON.stringify(await st()));
  // pick a point in the Top pane (pane 2)
  const pk = await win.evaluate(() => { const d = lithApp.doc, s = d.viewSet, p = s.panes[2]; s.setActive(p); const l = [...d.layers.values()][0]; let hit = null;
    for (let y = 40; y < p.height - 40 && !hit; y += 25) for (let x = 40; x < p.width - 40 && !hit; x += 25) hit = l.pickNear(d.vp, x, y, 10); return hit ? hit.doc.map((v) => +v.toFixed(2)) : null; });
  console.log('4 pick in Top pane:', JSON.stringify(pk));
  await T.shot('vp2-cloud');
  await win.evaluate(() => lithApp.doc.setView({ edl: !lithApp.doc.doc.view.edl })); await settle(500); await T.shot('vp2-cloud-edl');
  const saved = await win.evaluate(() => { lithApp.doc.beforeSave(); return lithApp.doc.doc.viewLayout; });
  console.log('5 saved:', saved.layout, saved.views.length);
  await win.evaluate(() => lithApp.onMenu('layout', 'single')); await settle();
  console.log('6 single:', JSON.stringify(await st()));
  await T.app.close();
}
{
  const DIR = '/tmp/vp2'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
  const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, pt = (id, x, y) => ({ id, type: 'point', x, y });
  const PART = DIR + '/Block.lithprt';
  fs.writeFileSync(PART, JSON.stringify({ kind: 'part', version: 1, name: 'Block', units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
    { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', 0, 0), pt('p2', 100, 0), pt('p3', 100, 60), pt('p4', 0, 60),
      { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
    { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 40, end: 'blind', op: 'boss' }] }));
  const T = await launch('drawing');
  const { win, W, idle } = T;
  await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top', 'right'], { auto: true }), PART); await idle(); await W(500);
  await win.evaluate(() => lithApp.onMenu('layout', 'two-v')); await W(600);
  const st = () => win.evaluate(() => { const s = lithApp.doc.viewSet; return { n: s.panes.length, paper: s.panes.map((p) => p.el.classList.contains('paper')), scales: s.panes.map((p) => +p.scale.toFixed(3)), dirs: s.panes.map((p) => p.viewDir().toArray().map((v) => Math.round(v)).join()), cube: s.panes.map((p) => !!p.viewCube) }; });
  console.log('7 drawing two views:', JSON.stringify(await st()));
  // zoom in on the right pane and select a view there by clicking its frame
  const sel = await win.evaluate(() => { const d = lithApp.doc, s = d.viewSet, p = s.panes[1]; s.setActive(p); p.zoomAt(p.width / 2, p.height / 2, 0.5); d.vp.requestRender(); return [+s.panes[0].scale.toFixed(3), +p.scale.toFixed(3)]; });
  console.log('8 right pane zoomed (left unchanged):', JSON.stringify(sel));
  await W(400);
  const v0 = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views[0], s = d.viewSet, p = s.panes[1]; const r = d.frameRect ? d.frameRect(v) : null; return r; });
  void v0;
  await win.evaluate(() => { const d = lithApp.doc; d.select(d.doc.views[0].id); }); await W(300);
  console.log('9 props/info only once:', await win.evaluate(() => document.querySelectorAll('.ann-props').length), 'sel', await win.evaluate(() => lithApp.doc.sel === lithApp.doc.doc.views[0].id));
  await T.shot('vp2-drawing');
  await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(500);
  console.log('10 drawing four:', JSON.stringify(await st()));
  await T.app.close();
}
