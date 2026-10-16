// 0.1.66: browser tree (folders, eyes, editing green, rollback by data-fi) + view cube 90° arrows
import { _electron as electron } from 'playwright-core';
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part' }, timeout: 60000 });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => { if (/error/i.test(m.type()) && !/Security|WebGL|GPU stall|swiftshader/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const W = (ms) => win.waitForTimeout(ms);
await W(3500);
const shot = async (n) => { await W(400); await win.screenshot({ path: `tests/e2e/shots/tree-${n}.png` }); };
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(300); };
const P = async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
const click = async (x, y) => { const [px, py] = await P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(120); };
const rows = () => win.evaluate(() => [...document.querySelectorAll('.panel.tree .tr-row')].map((r) => r.querySelector('.tr-label').textContent + (r.querySelector('.tr-count')?.textContent || '') + (r.querySelector('.tr-eye') ? (r.querySelector('.tr-eye.off') ? ' [eye off]' : ' [eye]') : '') + (r.classList.contains('editing') ? ' {editing}' : '')));
// sketch + extrude
await win.locator('.tr-row:has-text("Top Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.3; vp.requestRender(); });
await win.locator('.cm-btn:has-text("Center Rectangle")').click(); await click(0, 0); await click(60, 40); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await win.locator('.cm-tab:has-text("Features")').click(); await win.locator('.cm-btn:has-text("Extruded Boss")').click(); await idle();
await win.keyboard.press('Enter'); await idle();
// second stand-alone sketch on the Front plane (a circle)
await win.locator('.tr-row:has-text("Front Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(700);
console.log('1 editing sketch row:', (await rows()).filter((r) => r.includes('{editing}')));
await win.locator('.cm-btn:has-text("Circle")').first().click(); await click(0, 30); await click(10, 30); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await win.evaluate(() => lithApp.doc.app.showPanel('tree')); await W(200);
console.log('2 tree:', JSON.stringify(await rows()));
await shot('tree');
// nested sketch eye
await win.locator('.tr-row:has-text("Boss-Extrude") .twisty').first().click(); await W(200);
const skVis = () => win.evaluate(() => { const d = lithApp.doc; const f = d.doc.features.find((x) => x.type === 'sketch'); return { visible: f.visible ?? null, lines: d.sketchGroup.children.length }; });
console.log('3 nested sketch before:', JSON.stringify(await skVis()));
await win.locator('.tr-row:has-text("Sketch1") .tr-eye').click(); await W(300);
console.log('3 nested sketch after eye:', JSON.stringify(await skVis()), (await rows()).find((r) => r.startsWith('Sketch1')));
await win.locator('.tr-row:has-text("Sketch1") .tr-eye').click(); await W(300);
console.log('3 eye again:', JSON.stringify(await skVis()));
// plane eye
await win.locator('.tr-row:has-text("Right Plane") .tr-eye').click(); await W(300);
console.log('4 Right plane shown:', JSON.stringify(await win.evaluate(() => ({ shown: lithApp.doc.doc.planesShown, planes: lithApp.doc.planeGroup.children.filter((o) => o.userData.plane).map((o) => o.userData.plane) }))));
// body eye
if (!(await win.locator('.tr-row[data-item="body"]').count())) { await win.locator('.tr-row:has-text("Solid Bodies") .twisty').click(); await W(200); }
const pickMid = () => win.evaluate(() => { const d = lithApp.doc, vp = d.vp, r = vp.el.getBoundingClientRect(); vp.setView('iso', false); vp.target.set(0, 5, 0); vp.scale = 0.3; vp._updateCamera(); const s = vp.toScreen([0, 10, 0]); const p = d.pickAt({ clientX: r.left + s[0], clientY: r.top + s[1] }); return p?.kind || null; });
console.log('5 pick before hide:', await pickMid());
await win.locator('.tr-row[data-item="body"] .tr-eye').click(); await W(300);
console.log('5 hidden:', JSON.stringify(await win.evaluate(() => ({ hidden: lithApp.doc.doc.bodyHidden, vis: lithApp.doc.bodyGroup.visible }))), 'pick:', await pickMid());
await shot('hidden');
await win.evaluate(() => lithApp.doc.undo()); await idle();
console.log('5 undo:', JSON.stringify(await win.evaluate(() => ({ hidden: !!lithApp.doc.doc.bodyHidden, vis: lithApp.doc.bodyGroup.visible }))));
// sketch editing = green
await win.evaluate(() => { const d = lithApp.doc; d.editSketch(d.doc.features.find((x) => x.name === 'Sketch2').id); }); await idle();
console.log('6 edit sketch:', (await rows()).filter((r) => r.includes('{editing}')));
await win.locator('.cc.ok').click(); await idle(); await win.evaluate(() => lithApp.doc.app.showPanel('tree'));
// feature editing = green
await win.evaluate(() => { const d = lithApp.doc; d.editFeature(d.doc.features.find((x) => x.type === 'extrude').id); }); await idle();
console.log('6 edit feature:', (await rows()).filter((r) => r.includes('{editing}')));
await win.keyboard.press('Escape'); await idle(); await W(200);
console.log('6 after Esc:', (await rows()).filter((r) => r.includes('{editing}')));
// rollback drag: drop above the extrude row
const bar = await win.locator('.rollback').boundingBox();
const ext = await win.locator('.tr-row[data-fi]:has-text("Boss-Extrude")').boundingBox();
await win.mouse.move(bar.x + 20, bar.y + 3); await win.mouse.down(); await win.mouse.move(bar.x + 20, ext.y + 4, { steps: 5 }); await win.mouse.up(); await idle();
console.log('7 rollback:', await win.evaluate(() => { const d = lithApp.doc; return [d.doc.rollback, d.doc.features[d.doc.rollback]?.name]; }));
await win.evaluate(() => lithApp.doc.setRollback(null)); await idle();
// folder collapse remembered
await win.locator('.tr-row[data-folder="origin"] .twisty').click(); await W(200);
console.log('8 origin closed:', !(await rows()).some((r) => r.startsWith('Top Plane')), await win.evaluate(() => localStorage.getItem('monolith.treeOpen')));
await win.locator('.tr-row[data-folder="origin"] .twisty').click(); await W(200);
// view cube arrows
const dir = () => win.evaluate(() => { const vp = lithApp.doc.vp; return [vp.viewDir().toArray(), new (vp.camera.up.constructor)(0, 1, 0).applyQuaternion(vp.camera.quaternion).toArray()].map((v) => v.map((x) => Math.round(x * 100) / 100 + 0).join()).join(' up '); });
const arrow = async (k) => { await win.locator('.vc-' + k).click(); await W(500); return dir(); };
await win.evaluate(() => lithApp.doc.vp.setView('front', false)); await W(200);
console.log('9 front:', await dir());
console.log('9 up →', await arrow('up'), '(top)');
console.log('9 down →', await arrow('down'), '(front)');
console.log('9 left →', await arrow('left'), '(left)');
console.log('9 right →', await arrow('right'), '(front)');
console.log('9 cw →', await arrow('cw'));
console.log('9 ccw →', await arrow('ccw'));
await win.mouse.move(400, 300); await win.evaluate(() => lithApp.doc.vp.setView('iso', false));
await win.locator('.viewcube').hover(); await shot('cube');
await win.evaluate(() => lithApp.onMenu('theme', true)); await W(300); await shot('dark');
await win.evaluate(() => lithApp.onMenu('theme', false));
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
