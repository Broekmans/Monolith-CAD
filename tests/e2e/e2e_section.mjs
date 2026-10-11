// Section View: standard plane, face of an assembly component, drawn cut line; also in a part
import { launch } from './common.mjs';
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => lithApp.doc.insertComponent(null, null, { std: 'DIN912', size: 'M10', L: 40 })); await idle();
await win.evaluate(() => lithApp.doc.insertComponent(null, null, { std: 'DIN934', size: 'M10' })); await idle();
await T.btn('Section View'); await W(400);
console.log('std', await win.evaluate(() => JSON.stringify(lithApp.doc.vp.section)));
// pick a side face of the nut (hex flat) through the PM
await win.evaluate(() => { const d = lithApp.doc; const c = d.doc.components[1]; const v = d.views.get(c.id); const f = v.part.mesh.faces.find((x) => x.type === 'plane' && Math.abs(x.plane.normal[1]) < 0.1);
  lithApp.pm.current.offer({ comp: c.id, kind: 'face', id: f.id, c: f.c, geo: { t: 'plane', p: f.c, n: f.plane.normal }, key: 'k', label: 'Plane@nut' }); });
await W(300); console.log('face', await win.evaluate(() => JSON.stringify(lithApp.doc.vp.section)), await win.locator('.pm-msg').textContent());
// draw a diagonal cut line across the screw
await win.locator('.pm-bbtn:has-text("Draw cut line")').click(); await W(200);
const a = await T.WP([-15, 12, 0]), b = await T.WP([15, -38, 0]);
await win.mouse.click(a[0], a[1]); await win.mouse.move(b[0], b[1], { steps: 4 }); await W(200); await T.shot('sec_draw'); await win.mouse.click(b[0], b[1]); await W(300);
console.log('line', await win.evaluate(() => JSON.stringify(lithApp.doc.vp.section)), 'plane', await win.evaluate(() => lithApp.pm.current.values.plane), 'comps', await win.evaluate(() => lithApp.doc.doc.components.length));
await T.ok(); await W(300); await T.shot('sec_asm');
await T.app.close();
