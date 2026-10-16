// 0.1.75: Options window (Tools > Options…): live preview of ghost opacity, Cancel, OK, Save as My Defaults (file),
// restart reads My Defaults, Reset to Factory, wheel step option. Writes ../scratch/opt/monolith-options.json
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const OPT = path.resolve('../scratch/opt/monolith-options.json');
const launch = () => electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part', MONOLITH_OPTIONS: OPT }, timeout: 60000 });
let app = await launch(), win = await app.firstWindow();
const logs = [];
const hook = (w) => { w.on('console', (m) => { if (/error/i.test(m.type()) && !/Security|WebGL|GPU stall|swiftshader/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); }); w.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`)); };
hook(win);
const W = (ms) => win.waitForTimeout(ms);
await W(3500);
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(300); };
const P = async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]);
const click = async (x, y) => { const [px, py] = await P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(120); };
await win.locator('.tr-row:has-text("Top Plane")').click();
await win.locator('.cm-tab:has-text("Sketch")').click(); await win.locator('.cm-btn:has-text("Sketch")').first().click(); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.3; vp.requestRender(); });
await win.locator('.cm-btn:has-text("Center Rectangle")').click(); await click(0, 0); await click(60, 40); await win.keyboard.press('Escape');
await win.locator('.cc.ok').click(); await idle();
await win.locator('.cm-tab:has-text("Features")').click(); await win.locator('.cm-btn:has-text("Extruded Boss")').click(); await idle(); await W(800);
const ghostA = () => win.evaluate(() => lithApp.doc.ghostGroup.children.filter((o) => o.isMesh).map((o) => +o.material.opacity.toFixed(3)).join());
console.log('1 ghost opacities factory (0.08, 0.04):', await ghostA());
// wheel step 1 (factory)
const vb = await win.evaluate(() => { const r = document.querySelector('.feat-val input').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
const v0 = await win.evaluate(() => +document.querySelector('.feat-val input').value);
await win.mouse.move(...vb); await win.mouse.wheel(0, -100); await W(300);
console.log('2 wheel step 1:', v0, '→', await win.evaluate(() => +document.querySelector('.feat-val input').value));
// open Options from the title bar gear; Feature Preview: face 30 → live
await win.evaluate(() => lithApp.onMenu('options')); await W(500);
console.log('3 categories:', JSON.stringify(await win.locator('.opt-cat').allTextContents()));
await win.locator('.opt-cat:has-text("Feature Preview")').click(); await W(200);
const num = (k) => win.locator(`.opt-rows input[data-key="${k}"]`);
await num('ghostFace').fill('30'); await num('ghostFace').press('Enter'); await W(400);
console.log('4 live preview face 30:', await ghostA());
await win.evaluate(() => lithApp.setTheme(true)); await W(300); await win.screenshot({ path: 'tests/e2e/shots/options-dark.png' }); await win.evaluate(() => lithApp.setTheme(false));
await win.locator('.dlg-buttons button:has-text("Cancel")').click(); await W(400);
console.log('5 after Cancel (back to 0.08):', await ghostA());
// change + OK, wheel step 2
await win.evaluate(() => lithApp.onMenu('options')); await W(400);
await win.locator('.opt-cat:has-text("Feature Preview")').click();
await num('ghostFace').fill('20'); await num('ghostFace').press('Enter');
await win.locator('.opt-cat:has-text("Feature Values")').click();
await num('wheelStep').fill('2'); await num('wheelStep').press('Enter');
await win.locator('.opt-btn:has-text("Save as My Defaults")').click(); await W(500);
console.log('6 msg:', await win.locator('.opt-msg').textContent(), '| file:', fs.existsSync(OPT) ? JSON.stringify(JSON.parse(fs.readFileSync(OPT, 'utf8'))).slice(0, 80) + '…' : 'missing');
await win.locator('.dlg-buttons button:has-text("OK")').click(); await W(400);
console.log('7 after OK face 0.2:', await ghostA());
await win.mouse.move(...vb); const v1 = await win.evaluate(() => +document.querySelector('.feat-val input').value); await win.mouse.wheel(0, -100); await W(300);
console.log('8 wheel step 2:', v1, '→', await win.evaluate(() => +document.querySelector('.feat-val input').value));
// Reset to Factory in the window → 8 %; OK
await win.evaluate(() => lithApp.onMenu('options')); await W(400);
await win.locator('.opt-btn:has-text("Reset to Factory")').click(); await W(300);
console.log('9 factory reset live:', await ghostA(), await win.evaluate(() => document.body.classList.contains('dark')));
await win.locator('.opt-btn:has-text("Back to My Defaults")').click(); await W(300);
console.log('10 back to my defaults:', await ghostA());
await win.locator('.dlg-buttons button:has-text("Cancel")').click(); await W(300);
await win.keyboard.press('Escape'); await idle();
// restart: test mode ignores stored current values → My Defaults file applies (face 20, wheel 2)
await win.evaluate(() => localStorage.removeItem('monolith.options'));
await app.close();
app = await launch(); win = await app.firstWindow(); hook(win); await W(4000);
console.log('11 restart reads My Defaults (20, 2):', await win.evaluate(() => { const o = JSON.parse(localStorage.getItem('monolith.options') || '{}'); return [o.ghostFace, o.wheelStep]; }));
console.log('ERRORS:', logs.length ? logs.join('\n') : 'none');
await app.close();
