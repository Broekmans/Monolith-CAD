// 0.1.110: Realistic textures (brushed, wood, cast, knurl, grain; texture + scale in the Appearance popup), ground
// shadow (worked out once per model change, only in Realistic views), floor reflection (Options, off by default).
// Needs ../scratch/stonex001.lithprt. Shots: tests/e2e/shots/rl*.png
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
fs.mkdirSync('/tmp/rl', { recursive: true }); fs.copyFileSync('/home/claude/scratch/stonex001.lithprt', '/tmp/rl/s.lithprt');
const T = await launch('part'); const { win, W, idle } = T;
await win.evaluate((p) => lithApp.open(p), '/tmp/rl/s.lithprt'); await W(9000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.vp.setView?.('iso'); }); await W(1500);
await win.mouse.move(5, 5);
const stage = () => win.evaluate(() => { const s = lithApp.doc.stage; return s ? { vis: s.group.visible, shadow: !!s.shadow, mirror: s.mirror.children.length, key: s.key.length } : null; });
check('no stage in Shaded With Edges', (await stage()) === null, JSON.stringify(await stage()));
await win.evaluate(() => lithApp.doc.setDisplay('realistic')); await W(1500);
check('ground shadow in Realistic', (await stage())?.shadow && (await stage()).vis, JSON.stringify(await stage()));
const alpha = await win.evaluate(() => { const t = lithApp.doc.stage.shadow.material.map.image; let mx = 0, n = 0; for (let k = 3; k < t.data.length; k += 4) { mx = Math.max(mx, t.data[k]); if (t.data[k] > 8) n++; } return { mx, n, w: t.width, h: t.height }; });
check('shadow has a soft dark area', alpha.mx > 60 && alpha.n > 100, JSON.stringify(alpha));
await T.shot('rl1_default_shadow');
const setApp = (a) => win.evaluate((a) => { const d = lithApp.doc; d.beginChange(); d.doc.appearance = a; d.commit(); d.vp.requestRender(); }, a);
const texOf = () => win.evaluate(() => { const m = lithApp.doc.bodyMesh.material; return { type: m.type, tex: m.userData.tex || null }; });
for (const [name, shot] of [['Brushed Steel', 'rl2_brushed'], ['Knurled Steel', 'rl3_knurl'], ['Cast Iron', 'rl4_cast'], ['Oak', 'rl5_oak'], ['Textured Black Plastic', 'rl6_grain']]) {
  await setApp({ name }); await W(1500);
  const t = await texOf();
  check(`${name}: textured physical material`, t.type === 'MeshPhysicalMaterial' && !!t.tex, JSON.stringify(t));
  await T.shot(shot);
}
// popup: texture select + scale
await setApp({ name: 'Brushed Steel' }); await W(800);
await win.evaluate(() => lithApp.doc.editAppearance()); await W(600);
check('popup has Texture select', (await win.locator('.app-pop select').count()) === 1);
await win.locator('.app-pop select').selectOption('knurl'); await W(800);
let own = await win.evaluate(() => lithApp.doc.doc.appearance);
check('texture chosen in the popup', own?.tex === 'knurl', JSON.stringify(own));
await win.locator('.app-pop input[type=range]').last().fill('1'); await W(800);
own = await win.evaluate(() => lithApp.doc.doc.appearance);
check('texture scale 2×', own?.texScale === 2, JSON.stringify(own));
await win.mouse.move(5, 5); await T.shot('rl7_knurl_2x');
await win.evaluate(() => lithApp.doc.undo()); await W(600);
own = await win.evaluate(() => lithApp.doc.doc.appearance);
check('undo texture scale', own?.texScale == null && own?.tex === 'knurl', JSON.stringify(own));
await win.locator('.app-pop select').selectOption('none'); await W(800);
check('texture None', (await texOf()).tex === null, JSON.stringify(await texOf()));
await win.keyboard.press('Escape'); await W(300);
// shadow only rebuilt when the model changes
const k0 = await win.evaluate(() => { const s = lithApp.doc.stage; s._tag = 1; return s.shadow.uuid; });
await win.evaluate(() => lithApp.doc.vp.setView?.('front')); await W(800);
check('shadow kept when only the view changes', (await win.evaluate(() => lithApp.doc.stage.shadow.uuid)) === k0);
await win.evaluate(() => lithApp.doc.vp.setView?.('iso')); await W(800);
// floor reflection (Options)
await win.evaluate(() => lithApp.applyOptions({ realReflect: true }));
await W(1000);
check('floor reflection', (await stage())?.mirror > 0, JSON.stringify(await stage()));
await T.shot('rl8_reflection');
// back to Shaded: stage hidden, shaded material untouched
await win.evaluate(() => lithApp.doc.setDisplay('shadedEdges')); await W(1000);
check('stage hidden in Shaded With Edges', (await stage())?.vis === false, JSON.stringify(await stage()));
check('shaded material has no texture', (await texOf()).type === 'MeshStandardMaterial', JSON.stringify(await texOf()));
await win.evaluate(() => lithApp.applyOptions({ realReflect: false }));
console.log('ERRORS:', errs.length ? errs.join(', ') : 'none');
await T.close?.(); process.exit(errs.length ? 1 : 0);
