import { launch } from './common.mjs';
const T = await launch('plan');
const { win, W } = T;
const cnt = () => win.evaluate(() => lithApp.doc.doc.entities.length);
await win.locator('.viewport.paper').first().click({ position: { x: 5, y: 5 } }); await win.keyboard.press('Escape');
await T.cmd('L'); await T.cmd('0,0'); await T.cmd('2000,0'); await T.cmd('2000,1000'); await win.keyboard.press('Escape');
await T.cmd('PL'); await T.cmd('3000,0'); await T.cmd('@1000,0'); await T.cmd('@0,1000'); await T.cmd('C');
await win.evaluate(() => lithApp.doc.zoomExtents()); await W(200);
console.log('drawn', await cnt());
// fillet corner of the two lines with radius 200
await T.cmd('F'); await T.cmd('200'); await T.clickPlan(1000, 0); await T.clickPlan(2000, 500); await W(200);
console.log('after fillet', await cnt(), await win.evaluate(() => lithApp.doc.doc.entities.map(e=>e.type).join(',')));
// select all, copy with displacement
await win.keyboard.press('Control+a'); await T.cmd('CO'); await T.cmd('0,0'); await T.cmd('0,2000'); await win.keyboard.press('Escape');
console.log('after copy', await cnt());
// rotate selection (current selection still the originals) 90deg about 0,0
await T.cmd('RO'); await T.cmd('0,0'); await T.cmd('90');
// mirror
await win.keyboard.press('Control+a'); await T.cmd('MI'); await T.cmd('0,-5000'); await T.cmd('0,5000');
console.log('after mirror', await cnt());
// explode polylines
await win.keyboard.press('Escape');
await win.evaluate(() => { const d = lithApp.doc; d.sel.clear(); d.doc.entities.filter(e=>e.type==='polyline').forEach(e=>d.sel.add(e.id)); });
await T.cmd('X');
console.log('after explode', await win.evaluate(() => lithApp.doc.doc.entities.map(e=>e.type).reduce((a,t)=>(a[t]=(a[t]||0)+1,a),{})));
// scale everything 0.5 about origin
await win.keyboard.press('Control+a'); await T.cmd('SC'); await T.cmd('0,0'); await T.cmd('0.5');
// grip edit: select first line and drag its end grip
await win.keyboard.press('Escape');
await win.evaluate(() => lithApp.doc.zoomExtents()); await W(200);
const ln = await win.evaluate(() => { const e = lithApp.doc.doc.entities.find(e=>e.type==='line'); lithApp.doc.sel.clear(); lithApp.doc.sel.add(e.id); lithApp.doc.vp.requestRender(); return e; });
await W(200);
const [gx, gy] = await T.PP(ln.b[0], ln.b[1]);
await win.mouse.move(gx, gy); await win.mouse.down(); await win.mouse.move(gx + 60, gy - 40, { steps: 5 }); await win.mouse.up(); await W(200);
console.log('grip moved', JSON.stringify(ln.b), '->', await win.evaluate((id) => JSON.stringify(lithApp.doc.E(id).b), ln.id));
// layer: add + move selection
await win.evaluate(() => { const d = lithApp.doc; d.change(() => d.doc.layers.push({ name: 'Test', color: '#ff00ff', visible: true, locked: false })); });
// erase all + undo
await win.keyboard.press('Control+a'); await win.keyboard.press('Delete'); await W(100);
console.log('after erase', await cnt());
await win.keyboard.press('Control+z'); await W(200);
console.log('after undo', await cnt());
await win.evaluate(() => lithApp.doc.zoomExtents()); await T.shot('pl2');
// dist command
await T.cmd('DI'); await T.cmd('0,0'); await T.cmd('300,400');
console.log('log', await win.evaluate(() => document.querySelector('.cl-log').lastChild.textContent));
console.log('ERRORS:', T.logs.filter(l => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
