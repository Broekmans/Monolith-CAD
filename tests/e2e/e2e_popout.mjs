// 0.1.129: popups and the Motion Study in their own windows (popout.js). Needs ../scratch/motion/ (Slide and rotation test).
// Motion Study ⧉ → own window (view full height, Play works from there, ⧉ docks, remembered, closing the window closes the
// study); step popup ⧉ → window, edits + Delete key + Esc from there; Mate dialog ⧉ → window, tree picks land in it, OK
// keeps the next Mate in the same window; a dialog dragged past the edge of the program → window; Drive popup ⧉.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/po'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
const T = await launch('assembly');
const { win, W, idle, app } = T;
const clearPops = () => win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); });
await clearPops();
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const pages = () => app.windows().filter((p) => p !== win && !p.isClosed());
const newWindow = async (act) => { const n0 = pages().length; await act(); for (let i = 0; i < 40 && pages().length === n0; i++) await W(100); await W(400); return pages().at(-1); };
const gone = async (p) => { for (let i = 0; i < 40 && !p.isClosed(); i++) await W(100); return p.isClosed(); };
// 1) Motion Study in its own window
await T.btn('Motion Study'); await W(600);
const h0 = await win.evaluate(() => document.querySelector('.views').style.bottom);
let mw = await newWindow(() => win.locator('.motion-strip .pop-btn').click());
const inWin = mw ? await mw.evaluate(() => ({ strip: !!document.querySelector('.motion-strip .ms-bar'), title: document.title, dark: document.body.classList.contains('pop-body') })) : null;
const vb = await win.evaluate(() => ({ bottom: document.querySelector('.views').style.bottom, inMain: !!document.querySelector('.motion-strip .ms-bar') }));
check('Motion Study ⧉ → own window with the strip; main view full height', mw && inWin.strip && !vb.inMain && vb.bottom === '' && h0 === '170px', `${JSON.stringify(inWin)} ${JSON.stringify(vb)} was ${h0}`);
await mw.locator('.ms-btn:has-text("Play")').click(); await W(1200);
const t1 = await win.evaluate(() => lithApp.doc._mt.t);
check('Play in the window moves the motion (time runs)', t1 > 0.1, t1.toFixed(2));
await win.evaluate(() => lithApp.doc.pauseMotion()); await W(300);
await mw.locator('.pop-btn').click(); await W(500);
const back = await win.evaluate(() => ({ inMain: !!document.querySelector('.motion-strip .ms-bar'), bottom: document.querySelector('.views').style.bottom, mem: localStorage.getItem('monolith.pop.monolith.motion') }));
check('⧉ in the window → strip back under the view, window closed, not remembered', back.inMain && back.bottom === '170px' && (await gone(mw)) && back.mem === null, JSON.stringify(back));
mw = await newWindow(() => win.locator('.motion-strip .pop-btn').click());
await mw.locator('.ms-x').click(); await W(500);
const closedByX = await gone(mw);
mw = await newWindow(() => T.btn('Motion Study'));
check('closed with × while a window → opening the Motion Study again opens the window again', closedByX && mw && (await mw.locator('.motion-strip .ms-bar').count()) === 1);
await mw.close(); await W(600);
const st = await win.evaluate(() => ({ open: !!lithApp.doc._motionOpen, main: !!document.querySelector('.motion-strip .ms-bar') }));
check('closing the window itself closes the Motion Study (strip back in the program, hidden)', !st.open && !st.main, JSON.stringify(st));
await clearPops();
await T.btn('Motion Study'); await W(600);
// 2) step popup in its own window: edit, Delete key, undo
await win.locator('.motion-strip .ms-name').first().click(); await W(500);
const sw = await newWindow(() => win.locator('.step-pop .pop-btn').click());
check('step popup ⧉ → own window', sw && (await sw.locator('.step-pop .ap-row').count()) > 3 && (await win.locator('.step-pop').count()) === 0);
const dur0 = await win.evaluate(() => lithApp.doc.doc.motion.steps[0].dur);
const ti = sw.locator('.ap-row:has(label:text-is("Time (s)")) input'); await ti.fill(String(dur0 + 1)); await ti.press('Tab'); await W(500);
check('edit Time in the window → the step changes', Math.abs((await win.evaluate(() => lithApp.doc.doc.motion.steps[0].dur)) - dur0 - 1) < 1e-9);
await sw.locator('.ap-head b').click(); await sw.keyboard.press('Delete').catch(() => {}); await W(600); // (the window closes during the key press)
const nSteps = await win.evaluate(() => lithApp.doc.doc.motion.steps.length);
check('Delete key in the window deletes the step (popup and window close)', nSteps === 0 && (await gone(sw)), `${nSteps}`);
await win.evaluate(() => { lithApp.doc.undo(); lithApp.doc.undo(); }); await W(600);
check('undo × 2 → step and time back', (await win.evaluate(() => lithApp.doc.doc.motion.steps.length)) === 1 && (await win.evaluate(() => lithApp.doc.doc.motion.steps[0].dur)) === dur0);
await win.locator('.motion-strip .ms-name').first().click(); await W(700);
const sw2 = pages().at(-1);
check('step popup opens in its window again (remembered)', sw2 && !sw2.isClosed() && (await sw2.locator('.step-pop').count()) === 1 && (await win.locator('.step-pop').count()) === 0);
await sw2.keyboard.press('Escape').catch(() => {}); await W(500);
check('Esc in the window closes the popup and its window', (await gone(sw2)) && (await win.locator('.step-pop').count()) === 0);
await clearPops();
await T.btn('Motion Study'); await W(300);
// 3) Mate dialog in its own window: picks from the main tree, OK → next Mate stays in the same window, Esc closes
await T.btn('Mate'); await W(500);
const pw = await newWindow(() => win.locator('.pmroot .pm-header .pop-btn').click());
check('Mate dialog ⧉ → own window', pw && (await pw.locator('.pm-header .pm-title').textContent()) === 'Mate');
await win.locator('.tree .tr-row[data-item="@asm:plane:Top"]').click(); await W(300);
const blok2 = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.name === 'Blok-2<1>').id);
await win.locator(`.tree .tr-row[data-item="comp:${blok2}"] .twisty`).click(); await W(300);
await win.locator(`.tree .tr-row[data-item="${blok2}:plane:Top"]`).click(); await W(600);
const items = await pw.evaluate(() => [...document.querySelectorAll('.pm-selbox .pm-item, .pm-sel-item, .pm-selbox li')].map((x) => x.textContent.trim()));
check('plane rows clicked in the main tree land in the Mate dialog window', items.length === 2 && /Top Plane@/.test(items.join()), items.join(' | '));
await pw.locator('select').first().selectOption('parallel'); await W(400);
const nM = await win.evaluate(() => lithApp.doc.doc.mates.length);
await pw.locator('.pm-ok').click(); await W(1200);
check('OK in the window → mate made; the next Mate dialog is in the same window', (await win.evaluate(() => lithApp.doc.doc.mates.length)) === nM + 1 && !pw.isClosed() && (await pw.locator('.pm-header .pm-title').textContent()) === 'Mate' && pages().length === 1, `${pages().length} windows`);
await pw.keyboard.press('Escape').catch(() => {}); await W(800);
check('Esc in the window ends Mate, window closes, the tree is back', (await gone(pw)) && !(await win.evaluate(() => lithApp.pm.open)));
await win.evaluate(() => lithApp.doc.undo()); await W(500);
await clearPops();
// 4) a dialog dragged past the edge of the program → own window
const renamed = win.evaluate(() => lithApp.doc.renameAsm?.());
await W(600);
const dh = await win.locator('.dlg .dlg-title').boundingBox();
const vs = await win.evaluate(() => [window.innerWidth, window.innerHeight]);
const n0 = pages().length;
await win.mouse.move(dh.x + 30, dh.y + dh.height / 2); await win.mouse.down(); await W(80);
await win.mouse.move(vs[0] - 5, dh.y + dh.height / 2, { steps: 6 }); await win.mouse.move(vs[0] + 40, dh.y + dh.height / 2, { steps: 4 }); await W(200); await win.mouse.up(); await W(800);
const dw = pages().length > n0 ? pages().at(-1) : null;
check('dialog dragged past the right edge → own window', !!dw && (await dw.locator('.dlg input').count()) === 1 && (await win.locator('.dlg').count()) === 0, `${pages().length} windows`);
if (dw) { const inp = dw.locator('.dlg input'); await inp.fill('Popped name'); await inp.press('Enter').catch(() => {}); await W(600); }
await renamed; await W(300);
check('typing + Enter in the dialog window → applied, window closed', (await win.evaluate(() => lithApp.doc.doc.name)) === 'Popped name' && (!dw || (await gone(dw))), await win.evaluate(() => lithApp.doc.doc.name));
await T.shot('popout-main');
await clearPops(); await W(2500); // let the storage write reach the disk before closing
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
