// Saved section views in the tree + drag/scroll the cut face
import { launch } from './common.mjs';
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => lithApp.doc.insertComponent(null, null, { std: 'DIN912', size: 'M10', L: 40 })); await idle();
await T.btn('Section View'); await W(300); await win.locator('.pm-body select').first().selectOption('Right'); await W(200); await T.ok(); await W(300);
const S = () => win.evaluate(() => JSON.stringify({ sec: lithApp.doc.vp.section, list: lithApp.doc.doc.sections.map((s) => s.name + ':' + s.offset), act: lithApp.doc.doc.secActive }));
const rows = () => win.evaluate(() => [...document.querySelectorAll('.tr-row')].map((r) => r.textContent).join(' | '));
console.log('1', await S(), await rows());
await win.evaluate(() => lithApp.doc.vp.setView('front', false)); await W(300);
// cut face of the screw (Right plane x=0, hiding +x): viewed from front, points with x slightly < 0 show the red face? front view looks along -z, cut faces face +x -> edge-on. use iso.
await win.evaluate(() => lithApp.doc.vp.setView('iso', false)); await W(300);
const p = await T.WP([0, -15, 0]);
console.log('hit', await win.evaluate(([x, y]) => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return null; }, p));
await win.mouse.move(p[0], p[1]); await W(100);
await win.mouse.wheel(0, -100); await W(200); console.log('wheel', await S());
await win.mouse.move(p[0], p[1]); await win.mouse.down(); await win.mouse.move(p[0] + 40, p[1] + 20, { steps: 5 }); await win.mouse.up(); await W(200);
console.log('drag', await S());
await T.shot('sec2');
await win.locator('.tr-row:has-text("Cross section 1")').click(); await W(200); console.log('off', await S());
await win.locator('.tr-row:has-text("Cross section 1")').click(); await W(200); console.log('on', await S());
await win.locator('.tr-row:has-text("Cross section 1")').dblclick(); await W(300); console.log('edit pm', await win.locator('.pm-title').textContent());
await win.keyboard.press('Escape'); await W(200); console.log('after esc', await S());
await win.keyboard.press('Control+z'); await W(300); console.log('undo', await S(), await rows());
await T.app.close();
