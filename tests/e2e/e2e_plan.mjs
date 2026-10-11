import { launch } from './common.mjs';
import fs from 'node:fs';
const T = await launch('plan');
const { win, W } = T;
await win.locator('.viewport.paper').first().click({ position: { x: 5, y: 5 } }); // focus
await win.keyboard.press('Escape');
// Walls: closed room 6000 x 4000 via typed coords
await T.cmd('WALL');
await T.cmd('0,0'); await T.cmd('6000,0'); await T.cmd('6000,4000'); await T.cmd('0,4000'); await T.cmd('C');
// interior wall
await T.cmd('W'); await T.cmd('3500,0'); await T.cmd('@0,4000'); await win.keyboard.press('Escape');
await win.evaluate(() => lithApp.doc.zoomExtents()); await W(300);
// door on bottom wall at x=1500
await T.cmd('DOOR'); await T.clickPlan(1500, 60); await win.keyboard.press('Escape');
// door in interior wall
await T.cmd('DOOR'); await T.clickPlan(3460, 2000); await win.keyboard.press('Escape');
// windows
await T.cmd('WINDOW'); await T.clickPlan(4800, 3990); await T.clickPlan(1500, 3990); await T.clickPlan(6010, 2000); await win.keyboard.press('Escape');
// dimension along bottom
await T.cmd('DLI'); await T.cmd('-100,-100'); await T.cmd('6100,-100'); await T.cmd('3000,-800');
// text
await T.cmd('TEXT'); await T.cmd('1200,2000'); await T.cmd('250'); await T.cmd('0'); await T.cmd('Living room'); await win.keyboard.press('Enter'); await W(100);
await T.cmd('TEXT'); await T.cmd('4200,2000'); await win.keyboard.press('Enter'); await win.keyboard.press('Enter'); await T.cmd('Bedroom'); await win.keyboard.press('Enter');
// slab: rectangle then SLAB
await T.cmd('REC'); await T.cmd('-100,-100'); await T.cmd('@6200,4200');
await win.keyboard.press('Escape');
await win.evaluate(() => { const d = lithApp.doc; const r = d.doc.entities.filter(e => e.type === 'polyline').pop(); d.sel.clear(); d.sel.add(r.id); });
await T.cmd('SLAB'); await W(300);
// line + offset + trim test
await T.cmd('L'); await T.cmd('7000,0'); await T.cmd('9000,0'); await win.keyboard.press('Escape');
await T.cmd('C'); await T.cmd('8000,0'); await T.cmd('500');
await T.cmd('TR'); await T.clickPlan(8000, 2); await win.keyboard.press('Escape');
await T.cmd('O'); await T.cmd('300'); await T.clickPlan(7200, 0); await T.clickPlan(7200, 500); await win.keyboard.press('Escape');
await win.evaluate(() => lithApp.doc.zoomExtents());
await T.idle(); await W(1500);
await win.evaluate(() => { lithApp.doc.vp3.setView('iso', false); lithApp.doc._fitted3d = false; lithApp.doc.update3D(); }); await W(2500);
await win.evaluate(() => { const d = lithApp.doc; const m = d.modelGroup.children[0]; if (m) { m.geometry.computeBoundingBox(); d.vp3.fit(m.geometry.boundingBox); } }); await W(500);
await T.shot('plan1');
const summary = await win.evaluate(() => lithApp.doc.doc.entities.map(e => e.type).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}));
console.log('entities', JSON.stringify(summary));
// select a wall and look at properties
await T.clickPlan(3000, 0);
await T.shot('plan2_selected');
// DXF export text and re-import into new plan
const dxf = await win.evaluate(() => { const { planToDxf } = {}; return null; });
const text = await win.evaluate(() => { const d = lithApp.doc; return window.__dxf = (() => { return null; })(); });
await win.keyboard.press('Escape');
// use internal exporter
const dxfText = await win.evaluate(async () => { const d = lithApp.doc; const mod = d.explodeForDxf(); return JSON.stringify(mod.length); });
console.log('exploded prims', dxfText);
console.log(T.logs.filter(l => /error/i.test(l)).join('\n'));
await T.app.close();
