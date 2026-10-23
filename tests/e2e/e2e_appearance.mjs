// Appearances + Realistic display style (0.1.106): part default / material / own appearance, popup swatches and
// sliders, undo, Edges in Realistic, one view Realistic + one Shaded, glass, save + reopen; assembly: part
// appearance used, component override + clear. Needs ../scratch/stonex001.lithprt. Shots: tests/e2e/shots/ap*.png
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
fs.mkdirSync('/tmp/apt', { recursive: true }); fs.copyFileSync('/home/claude/scratch/stonex001.lithprt', '/tmp/apt/s.lithprt');
let T = await launch('part'); let { win, W, idle } = T;
await win.evaluate((p) => lithApp.open(p), '/tmp/apt/s.lithprt'); await W(9000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.vp.setView?.('iso'); }); await W(1500);
await win.mouse.move(5, 5);
await T.shot('ap0_shaded_edges');
const A = () => win.evaluate(() => { const a = lithApp.doc.appearance(); return { name: a.name, color: a.color, r: a.roughness, m: a.metalness, o: a.opacity ?? 1, own: lithApp.doc.doc.appearance || null }; });
check('default = Part body colour', (await A()).name === '' && (await A()).color === '#cfd6df', JSON.stringify(await A()));
await win.evaluate(() => lithApp.doc.setDisplay('realistic')); await W(1500);
const mat = () => win.evaluate(() => { const m = lithApp.doc.bodyMesh.material; return m.type + ' env:' + !!m.envMap; });
check('realistic uses physical material with reflections', (await mat()) === 'MeshPhysicalMaterial env:true', await mat());
await T.shot('ap1_default_realistic');
await win.evaluate(() => { const d = lithApp.doc; d.beginChange(); d.doc.material = 'Plain Carbon Steel'; d.commit(); d.renderTree(); d.vp.requestRender(); }); await W(1200);
check('material gives appearance', (await A()).name === 'Satin Steel', JSON.stringify(await A()));
await T.shot('ap2_steel_realistic');
await win.evaluate(() => lithApp.doc.editAppearance()); await W(600);
check('popup open', await win.locator('.app-pop').isVisible());
await T.shot('ap3_popup');
await win.locator('.app-pop .app-sw[title="Gloss Paint Red"]').click(); await W(800);
check('swatch sets own appearance', JSON.stringify((await A()).own) === '{"name":"Gloss Paint Red"}', JSON.stringify(await A()));
await win.locator('.app-pop input[type=range]').first().fill('0.7'); await W(600);
check('roughness slider', (await A()).r === 0.7 && (await A()).own.roughness === 0.7, JSON.stringify(await A()));
await win.mouse.move(5, 5); await T.shot('ap4_red_rough');
await win.evaluate(() => lithApp.doc.undo()); await W(800);
check('undo slider', JSON.stringify((await A()).own) === '{"name":"Gloss Paint Red"}', JSON.stringify(await A()));
await win.evaluate(() => lithApp.doc.undo()); await W(800);
check('undo swatch', (await A()).own === null && (await A()).name === 'Satin Steel', JSON.stringify(await A()));
await win.evaluate(() => lithApp.doc.redo()); await W(800);
check('redo swatch', (await A()).name === 'Gloss Paint Red', JSON.stringify(await A()));
await win.keyboard.press('Escape'); await W(400);
check('Esc closes popup', !(await win.locator('.app-pop').count()));
// Edges in Realistic (menu item toggles the option)
const edges = () => win.evaluate(() => lithApp.doc.edgeLines.visible);
await win.evaluate(() => lithApp.doc.vp.requestRender()); await W(400);
check('no edges in realistic by default', (await edges()) === false);
await win.evaluate(() => lithApp.doc.viewSet.displayItems().find((i) => i.label.startsWith('Edges in Realistic')).run()); await W(800);
check('edges toggled on', (await edges()) === true);
await T.shot('ap5_red_edges');
await win.evaluate(() => lithApp.doc.viewSet.displayItems().find((i) => i.label.startsWith('Edges in Realistic')).run()); await W(500);
// two views: left Realistic, right Shaded With Edges
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('two-v'); d.viewSet.panes[1].displayMode = 'shadedEdges'; d.viewSet.panes[0].displayMode = 'realistic'; d.vp.requestRender(); }); await W(2000);
const bgs = await win.evaluate(() => lithApp.doc.viewSet.panes.slice(0, 2).map((p) => (p.el.style.background ? 'studio' : 'none') + '/' + (p._toneMap ? 'tone' : 'flat')).join(' '));
check('per view look', bgs === 'studio/tone none/flat', bgs);
await win.mouse.move(5, 5); await T.shot('ap6_two_views');
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.setDisplay('realistic'); }); await W(1200);
// glass
await win.evaluate(() => { const d = lithApp.doc; d.beginChange(); d.doc.appearance = { name: 'Clear Glass' }; d.commit(); d.vp.requestRender(); }); await W(1000);
check('glass transparent', await win.evaluate(() => lithApp.doc.bodyMesh.material.transparent && lithApp.doc.bodyMesh.material.opacity === 0.25));
await T.shot('ap7_glass');
// save (tmp copy) + reopen
await win.evaluate(() => { const d = lithApp.doc; d.beginChange(); d.doc.appearance = { name: 'Brass', roughness: 0.2 }; d.commit(); }); await W(500);
await win.evaluate(async () => { await window.monolith.writeFile('/tmp/apt/s2.lithprt', JSON.stringify(lithApp.doc.doc)); });
await win.evaluate((p) => lithApp.open(p), '/tmp/apt/s2.lithprt'); await W(6000); await idle();
check('reopened appearance', JSON.stringify((await A()).own) === '{"name":"Brass","roughness":0.2}' && (await A()).r === 0.2, JSON.stringify(await A()));
await T.app.close();

// ---------------- assembly ----------------
const P1 = '/tmp/apt/steel.lithprt', P2 = '/tmp/apt/plain.lithprt';
const src = JSON.parse(fs.readFileSync('/tmp/apt/s.lithprt', 'utf8'));
fs.writeFileSync(P1, JSON.stringify({ ...src, name: 'steel', material: 'AISI 304 Stainless' }));
fs.writeFileSync(P2, JSON.stringify({ ...src, name: 'plain', material: 'Not specified' }));
T = await launch('assembly'); ({ win, W, idle } = T);
for (const f of [P1, P2]) { await win.evaluate((p) => lithApp.doc.insertComponent(p), f); await idle(); await W(1500); }
await win.evaluate(() => { const d = lithApp.doc; const c = d.doc.components[1]; c.pos = [300, 0, 0]; d.syncScene(); d.setDisplay('realistic'); d.zoomFit(); }); await W(2000);
const CA = () => win.evaluate(() => lithApp.doc.doc.components.map((c, i) => lithApp.doc.compAppearance(c, i).name || lithApp.doc.compAppearance(c, i).color).join(','));
check('components: material / list colour', (await CA()) === 'Stainless Steel,#d8cfbf', await CA());
await win.mouse.move(5, 5); await T.shot('ap8_asm_realistic');
await win.evaluate(() => lithApp.doc.editCompAppearance(lithApp.doc.doc.components[1])); await W(600);
await win.locator('.app-pop .app-sw[title="Anodised Blue"]').click(); await W(800);
check('component override', (await CA()) === 'Stainless Steel,Anodised Blue', await CA());
check('override stored in assembly', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.components[1].appearance)) === '{"name":"Anodised Blue"}');
await win.mouse.move(5, 5); await T.shot('ap9_asm_override');
await win.locator('.app-pop .ap-btns button').click(); await W(600);
check('clear override', (await CA()) === 'Stainless Steel,#d8cfbf', await CA());
await win.evaluate(() => lithApp.doc.undo()); await W(600);
check('undo clear', (await CA()) === 'Stainless Steel,Anodised Blue', await CA());
await win.evaluate(() => lithApp.doc.setDisplay('shadedEdges')); await W(800);
await win.mouse.move(5, 5); await T.shot('ap10_asm_shaded');
await T.app.close();
console.log('ERRORS:', errs.length ? errs.join('; ') : 'none');
