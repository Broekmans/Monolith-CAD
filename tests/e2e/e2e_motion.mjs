// 0.1.119: Limits + Drive + Motion Study through the UI on a copy of Wouter's "Slide and rotation test"
// (Needs ../scratch/motion/). Angle mate crank side face ↔ Blok-1 top (turning axis from the pivot's concentric mate),
// Limits 30…150°, Drive slider + Play, Motion Study steps + Play / Loop / Reciprocate / undo, saved in the .lithasm.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { launch } from './common.mjs';
import * as M from '../../shared/mates.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/mo'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
{ const f0 = JSON.parse(fs.readFileSync(A, 'utf8')); f0.mates = f0.mates.filter((m) => m.type !== 'distance' && m.type !== 'angle'); delete f0.motion; fs.writeFileSync(A, JSON.stringify(f0)); } // 0.1.122: Wouter's file has a Distance mate + a step since 21-10; this test makes its own
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); }); // 0.1.129: no popup windows left from another test
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const doc = () => win.evaluate(() => JSON.parse(JSON.stringify(lithApp.doc.toJSON())));
const live = () => win.evaluate(() => { const d = lithApp.doc; return { comps: d.doc.components.map((c) => ({ id: c.id, name: c.name, pos: [...c.pos], rot: [...c.rot], fixed: c.fixed })), mates: JSON.parse(JSON.stringify(d.doc.mates.map((m) => ({ ...m, _drive: m._drive })))) }; });
const errOf = (s) => { const by = new Map(s.comps.map((c) => [c.id, c])); return Math.max(...s.mates.filter((m) => !m.suppressed).map((m) => M.mateError(m, by))); };
const valOf = (s, id) => { const by = new Map(s.comps.map((c) => [c.id, c])); return M.mateValue(s.mates.find((m) => m.id === id), by); };
const sliderX = async (s) => (s.comps.find((c) => c.name === 'Blok-2<1>').pos[0]);
const offerPlane = (cname, pred) => win.evaluate(([cname, pred]) => {
  const d = lithApp.doc, c = d.doc.components.find((k) => k.name === cname), v = d.views.get(c.id);
  const f = v.part.mesh.faces.find(new Function('f', 'return ' + pred));
  lithApp.pm.current.offer({ comp: c.id, kind: 'face', id: f.id, c: f.c, point: f.c, key: `${c.id}:face:${f.id}`, label: 'Face', geo: { t: 'plane', p: f.c, n: f.plane.normal } });
}, [cname, pred]);
const pmSel = (key) => win.locator('.pm-body select').first();
const pmNum = async (label, v) => { const inp = win.locator(`.pm-field:has(label:text-is("${label}")) input`).first(); await inp.fill(String(v)); await inp.press('Tab'); await W(300); };
const pmCheck = async (label) => { await win.locator(`.pm-field:has-text("${label}") input[type=checkbox]`).first().check(); await W(300); };
const s0 = await live();
// 1) Angle mate with Limits through the Mate PM
await T.btn('Mate'); await W(300);
await offerPlane('Arm-1<1>', "f.type==='plane' && f.plane.normal[1] > 0.9 && Math.abs(f.c[1] - 50) < 1"); await W(200);
await offerPlane('Blok-1<1>', "f.type==='plane' && f.plane.normal[1] > 0.9 && Math.abs(f.c[1] - 25) < 1"); await W(300);
await pmSel('type').selectOption('angle'); await W(400);
const shown = await win.evaluate(() => [...document.querySelectorAll('.pm-body .pm-numrow input')].map((x) => x.value));
check('Angle: value field starts at the angle as it is now (> 0)', +shown[0] > 0 && +shown[0] < 180, shown.join());
const v0 = +shown[0];
await pmCheck('Limits: free between');
await pmNum('Minimum', 30); await pmNum('Maximum', 150);
let st = await live();
check('preview did not move anything (value = current)', Math.abs((await sliderX(st)) - (await sliderX(s0))) < 0.01, (await sliderX(st)).toFixed(3));
await T.ok(); await W(400); await win.keyboard.press('Escape'); await W(400);
let d = await doc();
const am = d.mates.find((m) => m.type === 'angle');
check('angle mate stored with axis + limits 30…150', am && am.axis?.length === 3 && am.limits?.min === 30 && am.limits?.max === 150, JSON.stringify(am && { axis: am.axis, limits: am.limits, value: am.value }));
const rowTxt = await win.locator(`.tree .tr-row[data-item="mate:${am.id}"]`).first().textContent();
check('tree shows the range', /30 … 150°/.test(rowTxt), rowTxt);
check('DOF: crank still free with a limited angle', (await win.evaluate(() => lithApp.doc.dof.get('c3')?.dof)) === 1);
// 2) Drive popup from the mate's right-click
await win.locator(`.tree .tr-row[data-item="mate:${am.id}"]`).first().click({ button: 'right' }); await W(200);
await win.locator('.ctx-item:has-text("Drive…")').first().click(); await W(500);
check('Drive popup open', await win.locator('.drive-pop').count() === 1);
const und0 = await win.evaluate(() => lithApp.doc.undoStack.length);
const slide = async (v) => { await win.evaluate((v) => { const r = document.querySelector('.drive-pop input[type=range]'); r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); }, v); await W(60); };
for (let v = v0; v <= 100; v += 2) await slide(v);
await slide(100);
await win.evaluate(() => document.querySelector('.drive-pop input[type=range]').dispatchEvent(new Event('change', { bubbles: true }))); await W(400);
st = await live();
check('slider → mate at 100°, mates hold', Math.abs(valOf(st, am.id) - 100) < 0.05 && errOf(st) < 1e-3, `${valOf(st, am.id).toFixed(3)} err ${errOf(st).toExponential(1)}`);
check('one undo step for the slider drag', (await win.evaluate(() => lithApp.doc.undoStack.length)) === und0 + 1);
check('mate value stored = 100', Math.abs((await doc()).mates.find((m) => m.id === am.id).value - 100) < 1e-3);
// Play ▶ to the Maximum (150°): stops at the end of travel or reaches it; mates always closed
await win.locator('.drive-pop .ms-btn:has-text("Play ▶")').click();
await W(300); for (let i = 0; i < 40 && (await win.evaluate(() => !!lithApp.doc._drv)); i++) await W(150);
await W(300);
st = await live();
const msg = await win.locator('.drive-pop .dp-msg').textContent();
const vp = valOf(st, am.id);
check('Play ▶: ends at 150° or at a dead point, mates closed', (Math.abs(vp - 150) < 0.1 || /End of travel/.test(msg)) && errOf(st) < 1e-3 && vp <= 150.01, `${vp.toFixed(2)}° "${msg}"`);
await win.locator('.drive-pop .ms-btn:has-text("◀ Play")').click();
await W(300); for (let i = 0; i < 40 && (await win.evaluate(() => !!lithApp.doc._drv)); i++) await W(150);
await W(300); st = await live();
check('Play ◀: back to the Minimum 30°', Math.abs(valOf(st, am.id) - 30) < 0.1 && errOf(st) < 1e-3, valOf(st, am.id).toFixed(2));
await T.shot('motion-drive');
// ⇄ Reciprocate in the Drive popup: up and down between 30° and 150° until Pause
await win.locator('.drive-pop .ms-btn[title^="Reciprocate"]').click();
const rv = []; for (let i = 0; i < 30; i++) { await W(150); rv.push(valOf(await live(), am.id)); }
await win.locator('.drive-pop .ms-btn[title="Pause"]').click(); await W(400);
const turns = rv.slice(2).filter((v, i) => Math.sign(rv[i + 2] - rv[i + 1]) !== Math.sign(rv[i + 1] - rv[i]) && Math.abs(rv[i + 2] - rv[i + 1]) > 0.01).length;
check('Drive ⇄: goes back and forth (turns at the ends), stays in 30…150°, Pause stops', turns >= 1 && Math.min(...rv) > 29.9 && Math.max(...rv) < 150.1 && !(await win.evaluate(() => !!lithApp.doc._drv)), `turns ${turns} range ${Math.min(...rv).toFixed(1)}…${Math.max(...rv).toFixed(1)}`);
await win.keyboard.press('Escape'); await W(300);
check('Esc closes the Drive popup', await win.locator('.drive-pop').count() === 0);
// 3) Motion Study
await T.btn('Motion Study'); await W(400);
const strip = await win.evaluate(() => { const e = lithApp.app?.el?.motion || document.querySelector('.motion-strip:not([style*="display: none"])'); const v = document.querySelector('.views'); return { shown: !!e && getComputedStyle(e).display !== 'none', h: e?.offsetHeight, bottom: lithApp.doc.app.el.views.style.bottom }; });
check('Motion Study strip under the view, view shortened', strip.shown && strip.bottom === `${strip.h}px`, JSON.stringify(strip));
await win.evaluate((id) => { lithApp.doc.sel = [{ kind: 'mate', id, key: 'mate:' + id }]; }, am.id);
await win.locator('.motion-strip .ms-btn:has-text("Add Step")').click(); await W(400);
const stepNum = async (label, v) => { const inp = win.locator(`.step-pop .ap-row:has(label:text-is("${label}")) input`).first(); await inp.fill(String(v)); await inp.dispatchEvent('change'); await W(250); };
await stepNum('From (°)', 30); await stepNum('To (°)', 110); await stepNum('Time (s)', 1);
await win.locator('.motion-strip .ms-btn:has-text("Add Step")').click(); await W(400);
await stepNum('From (°)', 110); await stepNum('To (°)', 60); await stepNum('Time (s)', 0.6);
await win.keyboard.press('Escape'); await W(200);
d = await doc();
check('2 steps stored in the assembly', d.motion?.steps?.length === 2 && d.motion.steps[0].to === 110 && d.motion.steps[1].from === 110 && d.motion.steps[1].dur === 0.6, JSON.stringify(d.motion));
const bars = await win.locator('.motion-strip .ms-stepbar').count();
check('timeline shows 2 bars', bars === 2, bars);
await T.shot('motion-study');
// rewind (to the start of step 1 = 30°) then play; sample during play
await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(500);
const und1 = await win.evaluate(() => lithApp.doc.undoStack.length);
const treeV1 = await win.evaluate((id) => lithApp.doc.doc.mates.find((m) => m.id === id).value, am.id);
const startX = await sliderX(await live());
await win.locator('.motion-strip .ms-btn:has-text("Play")').click();
let maxE = 0, mid = null;
for (let i = 0; i < 60; i++) { await W(80); const s = await live(); maxE = Math.max(maxE, errOf(s)); if (!mid && valOf(s, am.id) > 80) mid = valOf(s, am.id); if (!(await win.evaluate(() => lithApp.doc._mt?.playing))) break; }
await W(300);
st = await live();
const t = await win.evaluate(() => lithApp.doc._mt.t);
check('played to the end (1.6 s), stays at 60°', Math.abs(t - 1.6) < 1e-6 && Math.abs(valOf(st, am.id) - 60) < 0.1, `t ${t} value ${valOf(st, am.id).toFixed(2)}`);
check('mates closed during play', maxE < 1e-3, maxE.toExponential(1));
check('passed 80° on the way (step 1 to 110°)', mid != null, mid);
// 0.1.134: the study takes over — playing makes no undo step and does not change the mate in the tree
check('play = no undo step, tree value of the mate unchanged', (await win.evaluate(() => lithApp.doc.undoStack.length)) === und1 && (await win.evaluate((id) => lithApp.doc.doc.mates.find((m) => m.id === id).value, am.id)) === treeV1, `${treeV1}`);
await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(600);
st = await live();
check('To the start → back to the pose before play', Math.abs((await sliderX(st)) - startX) < 0.5, `${(await sliderX(st)).toFixed(2)} vs ${startX.toFixed(2)}`);
// scrub on the ruler to the middle of step 1
const rb = await win.locator('.motion-strip .ms-ruler').boundingBox();
const span = 1.6 * 1.08;
await win.mouse.move(rb.x + rb.width * (0.5 / span), rb.y + rb.height / 2); await win.mouse.down(); await W(200);
await win.mouse.move(rb.x + rb.width * (0.8 / span), rb.y + rb.height / 2, { steps: 5 }); await W(200); await win.mouse.up(); await W(400);
st = await live();
const ts = await win.evaluate(() => lithApp.doc._mt.t);
check('scrub on the ruler moves the model to that time', Math.abs(ts - 0.8) < 0.05 && valOf(st, am.id) > 70 && valOf(st, am.id) < 110 && errOf(st) < 1e-3, `t ${ts.toFixed(2)} value ${valOf(st, am.id).toFixed(2)}`);
// loop on → play a while → still playing past the end, then pause
await win.locator('.motion-strip .ms-btn:has-text("Loop")').click(); await W(300);
await win.locator('.motion-strip .ms-btn:has-text("Play")').click(); await W(2600);
const looping = await win.evaluate(() => lithApp.doc._mt.playing);
await win.locator('.motion-strip .ms-btn:has-text("Pause")').click(); await W(400);
st = await live();
check('Loop: still playing after the end, Pause stops, mates closed', looping && !(await win.evaluate(() => lithApp.doc._mt.playing)) && errOf(st) < 1e-3, `${looping} err ${errOf(st).toExponential(1)}`);
// Reciprocate: forward, back, forward … (t never past the end, turns at both ends)
await win.locator('.motion-strip .ms-btn:has-text("Reciprocate")').click(); await W(300);
check('Reciprocate replaces Loop (one mode at a time)', (await win.evaluate(() => [lithApp.doc.playMode(), document.querySelectorAll('.motion-strip .ms-btn.on').length])).join() === 'reciprocate,1');
await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(400);
await win.locator('.motion-strip .ms-btn:has-text("Play")').click();
const ts2 = []; let me = 0;
for (let i = 0; i < 45; i++) { await W(100); ts2.push(await win.evaluate(() => lithApp.doc._mt.t)); me = Math.max(me, errOf(await live())); }
await win.locator('.motion-strip .ms-btn:has-text("Pause")').click(); await W(400);
const ups = ts2.filter((t, i) => i && t > ts2[i - 1]).length, downs = ts2.filter((t, i) => i && t < ts2[i - 1]).length;
let flips = 0; for (let i = 2; i < ts2.length; i++) if (Math.sign(ts2[i] - ts2[i - 1]) * Math.sign(ts2[i - 1] - ts2[i - 2]) < 0) flips++;
check('Reciprocate: time runs forward and backward, within 0…1.6 s, mates closed', ups > 3 && downs > 3 && flips >= 2 && Math.max(...ts2) <= 1.6 + 1e-9 && Math.min(...ts2) >= 0 && me < 1e-3, `ups ${ups} downs ${downs} turns ${flips} max ${Math.max(...ts2).toFixed(2)} err ${me.toExponential(1)}`);
console.log('ts', ts2.map((t) => t.toFixed(2)).join(' '));
await T.shot('motion-reciprocate');

// 4) 0.1.122: drag the step bars (real mouse): move, right end, left end with snap to the other bar, click = popup
await win.locator('.motion-strip .ms-btn.on').first().click(); await W(300); // playback back to normal
const motionOf = async () => (await doc()).motion.steps;
const motionDoc = async () => (await doc()).motion;
const barBox = (i) => win.locator(`.motion-strip .ms-stepbar[data-i="${i}"]`).boundingBox();
const dragBar = async (i, where, ds, extraPx = 0) => {
  const rb2 = await win.locator('.motion-strip .ms-ruler').boundingBox();
  const b = await barBox(i);
  const tot = await win.evaluate(() => parseFloat(document.querySelector('.motion-strip .ms-time').textContent.split('/')[1]));
  const pps = rb2.width / Math.max(1, tot * 1.08);
  const x = where === 'end' ? b.x + b.width - 2 : where === 'start' ? b.x + 2 : b.x + b.width / 2, y = b.y + b.height / 2;
  await win.mouse.move(x, y); await W(80); await win.mouse.down(); await W(80);
  await win.mouse.move(x + ds * pps + extraPx, y, { steps: 8 }); await W(150); await win.mouse.up(); await W(400);
  return pps;
};
const und2 = await win.evaluate(() => lithApp.doc.undoStack.length);
const startOf = (st, i) => st[i].start;
let ms0 = await motionOf();
check('new steps have their own start time (step 2 at the end of step 1)', ms0[0].start === 0 && Math.abs(ms0[1].start - 1) < 1e-9 && !('after' in ms0[1]), JSON.stringify(ms0.map((s) => [s.start, s.dur])));
await dragBar(1, 'move', 0.3);
let ms1 = await motionOf();
check('drag bar 2 right 0.3 s → start 1.3 (snapped to 0.1 s), same time, one undo step', Math.abs(ms1[1].start - 1.3) < 1e-9 && ms1[1].dur === ms0[1].dur && (await win.evaluate(() => lithApp.doc.undoStack.length)) === und2 + 1, JSON.stringify(ms1[1]));
await dragBar(1, 'end', 0.4);
ms1 = await motionOf();
check('drag the right end of bar 2 +0.4 s → time 1.0 s, start kept', Math.abs(ms1[1].dur - 1.0) < 1e-9 && Math.abs(ms1[1].start - 1.3) < 1e-9, JSON.stringify(ms1[1]));
await dragBar(0, 'move', 1.0); // step 1: 0 → 1.0 (the others do not move along)
ms1 = await motionOf();
check('drag bar 1 later → only bar 1 moves', Math.abs(ms1[0].start - 1.0) < 1e-9 && Math.abs(ms1[1].start - 1.3) < 1e-9, JSON.stringify(ms1.map((s) => s.start)));
await dragBar(1, 'move', -1.1); // step 2: 1.3 → 0.2, before step 1
ms1 = await motionOf();
check('drag bar 2 before step 1 (a later step starts earlier)', Math.abs(ms1[1].start - 0.2) < 1e-9 && ms1[1].start < ms1[0].start, JSON.stringify(ms1.map((s) => s.start)));
await win.evaluate(() => lithApp.applyOptions({ asmMotionSnapS: 0 }));
const pps = await dragBar(1, 'end', 0.8, 3); // end 1.2 → 2.0 s + 3 px = step 1's end (2.0) → snaps
ms1 = await motionOf();
check('right end with grid off: snaps to the end of bar 1 (2.0 s)', Math.abs(ms1[1].start + ms1[1].dur - 2.0) < 1e-9, `${JSON.stringify(ms1[1])} px/s ${pps.toFixed(0)}`);
await win.evaluate(() => lithApp.applyOptions({ asmMotionSnapS: 0.1 }));
// up / down: drag bar 2 one row up = it becomes step 1, its times stay
const idsBefore = ms1.map((s) => s.id), timesBefore = JSON.stringify(ms1.map((s) => [s.id, s.start, s.dur]).sort());
{ const b = await barBox(1); const rowH = b.height + 8; await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await W(80); await win.mouse.down(); await W(80);
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - rowH, { steps: 8 }); await W(150);
  const marked = await win.evaluate(() => document.querySelectorAll('.motion-strip .ms-row.drop').length);
  await win.mouse.up(); await W(400);
  ms1 = await motionOf();
  check('drag bar 2 up a row → it is step 1 now (row marked while dragging), times kept', marked === 1 && ms1[0].id === idsBefore[1] && ms1[1].id === idsBefore[0] && JSON.stringify(ms1.map((s) => [s.id, s.start, s.dur]).sort()) === timesBefore, `marked ${marked} ${ms1.map((s) => s.id)}`); }
// drag a step name down → order back
{ const n = win.locator('.motion-strip .ms-name[data-i="0"]'); const b = await n.boundingBox(); await win.mouse.move(b.x + 40, b.y + b.height / 2); await W(80); await win.mouse.down(); await W(80);
  await win.mouse.move(b.x + 40, b.y + b.height * 1.5, { steps: 6 }); await W(150); await win.mouse.up(); await W(400); }
ms1 = await motionOf();
check('drag step name 1 down → order back', ms1[0].id === idsBefore[0] && ms1[1].id === idsBefore[1], ms1.map((s) => s.id).join());
await win.evaluate(() => lithApp.doc.undo()); await W(500);
ms1 = await motionOf();
check('undo → the order of before the name drag', ms1[0].id === idsBefore[1], ms1.map((s) => s.id).join());
await win.evaluate(() => lithApp.doc.redo()); await W(500);
{ const b = await barBox(1); await win.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await W(400); }
const popRows = await win.evaluate(() => [...document.querySelectorAll('.step-pop .ap-row label')].map((l) => l.textContent));
check('click (no move) on a bar opens its step popup with Start (s)', popRows.includes('Start (s)') && !popRows.includes('Starts'), popRows.join('|'));
await win.locator('.step-pop button:text-is("After previous")').click(); await W(400);
ms1 = await motionOf();
check('After previous → start = end of the step above', Math.abs(ms1[1].start - (ms1[0].start + ms1[0].dur)) < 1e-9, JSON.stringify(ms1.map((s) => [s.start, s.dur])));
await win.keyboard.press('Escape'); await W(200);
await T.shot('motion-bars');
for (let k = 0; k < 30 && (await win.evaluate(() => lithApp.doc.undoStack.length)) > und2; k++) { await win.evaluate(() => lithApp.doc.undo()); await W(250); }
check('undo all bar changes → the steps of before', JSON.stringify((await motionOf()).map((s) => [s.start, s.dur])) === JSON.stringify(ms0.map((s) => [s.start, s.dur])));
// 5) Save Animation through the popup (save dialog answered in the main process)
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', f]).toString()).streams[0];
const answerSave = (p) => T.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, p);
const total2 = await win.evaluate(() => parseFloat(document.querySelector('.motion-strip .ms-time').textContent.split('/')[1]));
const saveAnim = async (fmtv, size, fps, file, loops = 1, more = {}) => {
  await answerSave(file);
  await win.locator('.motion-strip .ms-btn:has-text("Save Animation")').click(); await W(600);
  const row = (l) => win.locator(`.anim-pop .ap-row:has(label:text-is("${l}"))`);
  await row('Format').locator('select').selectOption(fmtv); await W(200);
  await row('Size').locator('select').selectOption(size); await W(200);
  const fi = row('Frames per second').locator('input'); await fi.fill(String(fps)); await fi.dispatchEvent('change'); await W(200);
  const li = row('Loops').locator('input'); await li.fill(String(loops)); await li.dispatchEvent('change'); await W(200);
  if (more.speedShown) more.speedShown.v = await row('Speed (×)').locator('input').inputValue();
  if (more.speed) { const si = row('Speed (×)').locator('input'); await si.fill(String(more.speed)); await si.dispatchEvent('change'); await W(200); }
  if (more.mbps) { const qi = row('Quality (Mbit/s)').locator('input'); await qi.fill(String(more.mbps)); await qi.dispatchEvent('change'); await W(200); }
  const info = await win.locator('.anim-pop .ap-info').textContent();
  if (fmtv === 'mp4') await T.shot('motion-animpop');
  await win.locator('.anim-pop .ap-ok').click();
  await W(500); for (let i = 0; i < 600 && (await win.locator('.anim-prog').count()); i++) await W(200);
  await W(400);
  return info;
};
const before5 = await live(), und5 = await win.evaluate(() => lithApp.doc.undoStack.length), dirty5 = await win.evaluate(() => lithApp.doc.app.dirty);
let info = await saveAnim('mp4', '720', 10, `${DIR}/anim.mp4`);
let pr = fs.existsSync(`${DIR}/anim.mp4`) ? probe(`${DIR}/anim.mp4`) : null;
const nOnce = Math.round(total2 * 10) + 1;
check('MP4: H.264 1280×720, frames = time × fps + 1', pr && pr.codec_name === 'h264' && pr.width === 1280 && pr.height === 720 && +pr.nb_read_frames === nOnce, `${JSON.stringify(pr)} want ${nOnce} (${info})`);
let after5 = await live();
check('after saving: model back where it was, no undo step, not dirty', Math.abs((await sliderX(after5)) - (await sliderX(before5))) < 1e-6 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === und5 && (await win.evaluate(() => lithApp.doc.app.dirty)) === dirty5 && errOf(after5) < 1e-3, `${(await sliderX(after5)).toFixed(3)} vs ${(await sliderX(before5)).toFixed(3)}`);
// reciprocate range → one cycle; WebM; and Options: stay at the end
await win.locator('.motion-strip .ms-btn:has-text("Reciprocate")').click(); await W(300);
await win.evaluate(() => lithApp.applyOptions({ asmAnimRestore: false }));
const und6 = await win.evaluate(() => lithApp.doc.undoStack.length);
info = await saveAnim('webm', '480', 10, `${DIR}/anim.webm`);
pr = fs.existsSync(`${DIR}/anim.webm`) ? probe(`${DIR}/anim.webm`) : null;
const nCyc = Math.round(2 * total2 * 10);
check('WebM: VP9 854×480, reciprocate = one cycle (2 × time × fps frames)', pr && pr.codec_name === 'vp9' && pr.width === 854 && pr.height === 480 && +pr.nb_read_frames === nCyc, `${JSON.stringify(pr)} want ${nCyc} (${info})`);
check('Options "stay at the end": no undo step (the study keeps its pose)', (await win.evaluate(() => lithApp.doc.undoStack.length)) === und6);
await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(500);
await win.evaluate(() => lithApp.applyOptions({ asmAnimRestore: true }));
info = await saveAnim('gif', '480', 8, `${DIR}/anim.gif`, 3);
pr = fs.existsSync(`${DIR}/anim.gif`) ? probe(`${DIR}/anim.gif`) : null;
const nGif = Math.round(2 * total2 * 8) * 3;
check('GIF: 854×480, Loops 3 = three back-and-forth cycles', pr && pr.codec_name === 'gif' && pr.width === 854 && pr.height === 480 && +pr.nb_read_frames === nGif, `${JSON.stringify(pr)} want ${nGif} (${info})`);
// 0.1.125: bigger sizes (H.264 level 5.1 for 4K)
await win.locator('.motion-strip .ms-btn.on').first().click(); await W(300); // playback normal → range start to end
info = await saveAnim('mp4', '2160', 4, `${DIR}/anim4k.mp4`);
pr = fs.existsSync(`${DIR}/anim4k.mp4`) ? probe(`${DIR}/anim4k.mp4`) : null;
check('MP4 3840 × 2160 (4K)', pr && pr.codec_name === 'h264' && pr.width === 3840 && pr.height === 2160 && +pr.nb_read_frames === Math.round(total2 * 4) + 1, `${JSON.stringify(pr)} (${info})`);
info = await saveAnim('webm', '1440', 4, `${DIR}/anim1440.webm`);
pr = fs.existsSync(`${DIR}/anim1440.webm`) ? probe(`${DIR}/anim1440.webm`) : null;
check('WebM 2560 × 1440', pr && pr.codec_name === 'vp9' && pr.width === 2560 && pr.height === 1440, `${JSON.stringify(pr)} (${info})`);
// 0.1.126: Playback Speed in the bar (saved, undo) + Speed in Save Animation (slow motion = more frames)
{
  await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(400);
  // Play with a fake clock (50 ms per frame) so the result does not depend on the speed of this PC
  const playFrames = async (n) => {
    await win.evaluate(() => { lithApp.doc._mt.t = 0; lithApp.doc.seekMotion(0);
      let fake = performance.now(); window.__q = []; window.__raf = window.requestAnimationFrame; window.__pn = performance.now;
      window.requestAnimationFrame = (f) => { window.__q.push(f); return 1; }; performance.now = () => fake;
      window.__step = (k) => { for (let i = 0; i < k; i++) { fake += 50; const q = window.__q; window.__q = []; q.forEach((f) => f(fake)); } }; });
    await win.locator('.motion-strip .ms-btn:has-text("Play")').click(); await W(100);
    return win.evaluate((n) => { window.__step(n); const d = lithApp.doc, t = d._mt.t; d.pauseMotion(); window.requestAnimationFrame = window.__raf; performance.now = window.__pn; return t; }, n);
  };
  const t1 = await playFrames(10); await W(300);
  const undS = await win.evaluate(() => lithApp.doc.undoStack.length);
  await win.locator('.motion-strip .ms-speed select').selectOption('0.5'); await W(400);
  const sp = (await motionDoc())?.speed, undS2 = await win.evaluate(() => lithApp.doc.undoStack.length);
  const th = await playFrames(10); await W(300);
  check('Speed 0.5× in the bar: saved in doc.motion, one undo step, Play goes half as far (10 frames of 50 ms)', sp === 0.5 && undS2 === undS + 1 && Math.abs(t1 - 0.5) < 1e-6 && Math.abs(th - 0.25) < 1e-6, `speed ${sp} undo +${undS2 - undS} 1×: ${t1.toFixed(3)} s, 0.5×: ${th.toFixed(3)} s`);
  const shown = { v: null };
  info = await saveAnim('mp4', '480', 10, `${DIR}/slow.mp4`, 1, { speedShown: shown });
  pr = fs.existsSync(`${DIR}/slow.mp4`) ? probe(`${DIR}/slow.mp4`) : null;
  const nSlow = Math.round(total2 * 10 / 0.5) + 1;
  check('Save Animation: Speed starts at the bar\'s 0.5×, slow motion = twice the frames', shown.v === '0.5' && pr && +pr.nb_read_frames === nSlow, `shown ${shown.v} ${JSON.stringify(pr)} want ${nSlow} (${info})`);
  // 4K at 75 fps with Quality 128 (= 512 Mbit/s at 4K, above the software encoder's limit) → lowered, saved; Speed 40 = few frames
  await win.evaluate(() => { window.__ml = []; const f = window.__lithLog; window.__lithLog = (...a) => { window.__ml.push(a.join(' ')); return f?.(...a); }; });
  const t4 = Date.now();
  info = await saveAnim('mp4', '2160', 75, `${DIR}/fast4k.mp4`, 1, { speed: 40, mbps: 128 });
  pr = fs.existsSync(`${DIR}/fast4k.mp4`) ? probe(`${DIR}/fast4k.mp4`) : null;
  const n4 = Math.round(total2 * 75 / 40) + 1;
  const lg = (await win.evaluate(() => window.__ml)).filter((l) => /MOTION animation/.test(l)).join(' | ');
  const toastTxt = await win.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check('4K 75 fps, Quality 128: bit rate lowered (warning), file saved, Speed 40× = few frames', pr && pr.width === 3840 && +pr.nb_read_frames === n4 && (/Quality lowered/.test(toastTxt) || (await win.evaluate(() => window.__ml)).some((l) => /MESSAGE warn Quality lowered/.test(l))), `${JSON.stringify(pr)} want ${n4} "${toastTxt.slice(0, 140)}" ${((Date.now() - t4) / 1000).toFixed(0)} s ${lg}`);
  for (let i = 0; i < 10 && (await win.evaluate(() => lithApp.doc.undoStack.length)) > undS; i++) { await win.evaluate(() => lithApp.doc.undo()); await W(300); }
  check('undo → Playback Speed back to 1×', !((await motionDoc())?.speed > 0 && (await motionDoc()).speed !== 1) && (await win.locator('.motion-strip .ms-speed select').inputValue()) === '1', JSON.stringify((await motionDoc())?.speed));
}
await win.locator('.motion-strip .ms-btn:has-text("Reciprocate")').click(); await W(300); // back to reciprocate (saved below)
// 0.1.124: Cancel during saving, clicks blocked while saving, a stalled encoder gives up instead of hanging
{
  const before = await live(), undB = await win.evaluate(() => lithApp.doc.undoStack.length);
  await answerSave(`${DIR}/cancel.mp4`);
  await win.locator('.motion-strip .ms-btn:has-text("Save Animation")').click(); await W(600);
  const row = (l) => win.locator(`.anim-pop .ap-row:has(label:text-is("${l}"))`);
  await row('Format').locator('select').selectOption('mp4'); await W(200);
  await row('Size').locator('select').selectOption('1080'); await W(200);
  const fi = row('Frames per second').locator('input'); await fi.fill('30'); await fi.dispatchEvent('change'); await W(200);
  await win.locator('.anim-pop .ap-ok').click(); await W(1200);
  const busy = await win.locator('.anim-prog').count();
  const pb = await win.locator('.motion-strip .ms-btn:has-text("Play")').boundingBox();
  await win.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2); await W(300);
  const played = await win.evaluate(() => !!lithApp.doc._mt?.playing);
  await win.locator('.anim-prog button:text-is("Cancel")').click();
  let gone = false; for (let i = 0; i < 50 && !gone; i++) { await W(100); gone = (await win.locator('.anim-prog').count()) === 0; }
  const after = await live();
  check('Cancel while saving: stops within 5 s, no file, cover gone, model back, clicks were blocked', busy === 1 && gone && !played && !fs.existsSync(`${DIR}/cancel.mp4`) && (await win.locator('.anim-cover').count()) === 0 && Math.abs((await sliderX(after)) - (await sliderX(before))) < 1e-6 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === undB, `busy ${busy} gone ${gone} played ${played}`);
  // stalled encoder (simulated: the queue never empties) → gives up after asmAnimStallS with a message
  await win.evaluate(() => { window.__qd = Object.getOwnPropertyDescriptor(VideoEncoder.prototype, 'encodeQueueSize'); Object.defineProperty(VideoEncoder.prototype, 'encodeQueueSize', { configurable: true, get: () => 99 }); });
  const t0 = Date.now();
  const r = await win.evaluate(() => lithApp.doc.saveAnimation({ format: 'mp4', size: '480', fps: 10, range: 'once', mbps: 4, hud: false, path: '/tmp/mo/stall.mp4', stallS: 2 }));
  const dt = (Date.now() - t0) / 1000;
  const toastTxt = await win.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check('stalled encoder: gives up after ~2 s with a message, no file, program usable', r === null && dt < 8 && /stopped taking frames/.test(toastTxt) && !fs.existsSync('/tmp/mo/stall.mp4') && (await win.locator('.anim-cover, .anim-prog').count()) === 0 && !(await win.evaluate(() => lithApp.doc._animBusy)), `${dt.toFixed(1)} s "${toastTxt.slice(0, 160)}"`);
  await win.evaluate(() => { Object.defineProperty(VideoEncoder.prototype, 'encodeQueueSize', window.__qd); });
  const r2 = await win.evaluate(() => lithApp.doc.saveAnimation({ format: 'mp4', size: '480', fps: 5, range: 'once', mbps: 4, hud: false, path: '/tmp/mo/after.mp4' }));
  check('after that, saving works again', r2 && fs.existsSync('/tmp/mo/after.mp4'), JSON.stringify(r2));
}
// pictures of the first and a middle frame: background painted (not transparent / black), the model moves
fs.mkdirSync('tests/e2e/shots', { recursive: true });
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${DIR}/anim.mp4`, '-vf', `select=eq(n\\,0)+eq(n\\,${Math.floor(nOnce / 2)})`, '-vsync', '0', 'tests/e2e/shots/anim-%d.png']);
const px = execFileSync('python3', ['-c', `
from PIL import Image, ImageChops
a=Image.open('tests/e2e/shots/anim-1.png').convert('RGB'); b=Image.open('tests/e2e/shots/anim-2.png').convert('RGB')
c=a.getpixel((5,5)); d=ImageChops.difference(a,b).convert('L').point(lambda v: 255 if v>24 else 0)
print(c[0],c[1],c[2], sum(1 for v in d.getdata() if v))`]).toString().trim().split(' ').map(Number);
check('frames: background painted (corner not black) and the model moves between frames', (px[0] + px[1] + px[2]) > 60 && px[3] > 500, px.join());

// 6) 0.1.123: Suppress while editing (step popup) + live value, Current, Drive popup Current, delete steps
await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(500);
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.zoomFit(); }); await W(600);
await win.evaluate(() => { const d = lithApp.doc, s = d.vp.toScreen([300, 105, 200]); d.vp.zoomAt(s[0], s[1], 1.9); }); await W(400);
const PIV = [300, 105], GRAB = [120, 0, 40];
const toScr = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.vp.toScreen(p); return [r.left + s[0], r.top + s[1]]; }, p);
const dragCrank = async (deg) => { // real mouse: grab the crank's top face and turn it about the pivot
  const cs = await win.evaluate(() => lithApp.doc.doc.components.map((c) => ({ id: c.id, name: c.name, pos: [...c.pos], rot: [...c.rot] })));
  const [gx, gy] = await toScr(M.xfPoint(cs.find((c) => c.name === 'Arm-1<1>'), GRAB));
  const pk = await win.evaluate(([x, y]) => { const d = lithApp.doc; const p = d.pickAt({ clientX: x, clientY: y }); return p ? p.point : null; }, [gx, gy]);
  const W0 = pk || [0, 0, 0];
  const at = (a) => { a *= Math.PI / 180; const dx = W0[0] - PIV[0], dy = W0[1] - PIV[1]; return toScr([PIV[0] + dx * Math.cos(a) - dy * Math.sin(a), PIV[1] + dx * Math.sin(a) + dy * Math.cos(a), W0[2]]); };
  const [x0, y0] = await at(0); await win.mouse.move(x0, y0, { steps: 2 }); await W(100); await win.mouse.down();
  const nows = [];
  for (let k = 1; k <= 12; k++) { const [x, y] = await at((deg * k) / 12); await win.mouse.move(x, y); await W(30); nows.push(await win.evaluate(() => document.querySelector('.step-pop .ap-now')?.textContent || '')); }
  await win.mouse.up(); await W(400);
  return nows;
};
{ const b = await barBox(0); await win.mouse.click(b.x + 20, b.y + b.height / 2); await W(400); }
const nowTxt = () => win.evaluate(() => document.querySelector('.step-pop .ap-now')?.textContent);
check('step popup shows the mate value now', Math.abs(parseFloat(await nowTxt()) - valOf(await live(), am.id)) < 0.05, await nowTxt());
const v30 = valOf(await live(), am.id);
await dragCrank(-25);
const vA = valOf(await live(), am.id);
let down = -25, vLim = vA;
if (vA > v30 + 1) { // that way the angle grows: the other way goes below the Minimum
  down = 25;
  await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(400);
  { const b = await barBox(0); await win.mouse.click(b.x + 20, b.y + b.height / 2); await W(400); }
  await dragCrank(down); vLim = valOf(await live(), am.id);
}
check('without Suppress: dragging stops at the Minimum (30°)', vLim > 29.9 && vLim < 30.5, `${vLim.toFixed(2)} (start ${v30.toFixed(2)}, other way ${vA.toFixed(2)})`);
const und7 = await win.evaluate(() => lithApp.doc.undoStack.length);
await win.locator('.step-pop .ap-row:has(label:text-is("Suppress while editing")) input').check(); await W(500);
const tr = await win.locator(`.tree .tr-row[data-item="mate:${am.id}"]`).first().textContent();
check('Suppress while editing: mate left out, tree says so, no undo step', (await win.evaluate((id) => lithApp.doc.doc.mates.find((m) => m.id === id)._free, am.id)) === true && /suppressed while editing/.test(tr) && (await win.evaluate(() => lithApp.doc.undoStack.length)) === und7, tr);
const nows = await dragCrank(down);
const vFree = valOf(await live(), am.id);
const distinct = new Set(nows).size;
check('free: the crank goes past the Minimum; the popup value follows the drag', vFree < 20 && distinct >= 6 && Math.abs(parseFloat(await nowTxt()) - vFree) < 0.05, `${vFree.toFixed(2)} values ${nows.join(' ')}`);
await win.locator('.step-pop .ap-row:has(label:text-is("From (°)")) button:text-is("Current")').click(); await W(400);
let stp = (await motionOf())[0];
check('Current while free → From = the dragged value', Math.abs(stp.from - vFree) < 0.02, `${stp.from} vs ${vFree.toFixed(2)}`);
await T.shot('motion-free');
await win.locator('.step-pop .ap-row:has(label:text-is("Suppress while editing")) input').uncheck(); await W(800);
let s7 = await live();
check('untick: mate on again, outside its Limits → back to 30°, mates hold, not saved as free', Math.abs(valOf(s7, am.id) - 30) < 0.1 && errOf(s7) < 1e-3 && !(await win.evaluate((id) => '_free' in lithApp.doc.doc.mates.find((m) => m.id === id), am.id)) && !JSON.stringify(await doc()).includes('_free'), valOf(s7, am.id).toFixed(2));
await win.keyboard.press('Escape'); await W(300);
// put step 1's From back to 30 (the save check below expects the old steps)
{ const b = await barBox(0); await win.mouse.click(b.x + 20, b.y + b.height / 2); await W(400); }
await stepNum('From (°)', 30); await win.keyboard.press('Escape'); await W(300);
// Drive popup: Current for Maximum, Suppress while editing there too
await win.locator(`.tree .tr-row[data-item="mate:${am.id}"]`).first().click({ button: 'right' }); await W(200);
await win.locator('.ctx-item:has-text("Drive…")').first().click(); await W(500);
await slide(100);
await win.evaluate(() => document.querySelector('.drive-pop input[type=range]').dispatchEvent(new Event('change', { bubbles: true }))); await W(400);
await win.locator('.drive-pop .ap-row:has(label:text-is("Maximum")) button:text-is("Current")').click(); await W(400);
check('Drive: Current for Maximum → limits.max = 100', (await doc()).mates.find((m) => m.id === am.id).limits.max === 100);
await win.locator('.drive-pop .ap-row:has(label:text-is("Suppress while editing")) input').check(); await W(400);
check('Drive popup: Suppress while editing disables the slider and Play', await win.evaluate(() => document.querySelector('.drive-pop input[type=range]').disabled && [...document.querySelectorAll('.drive-pop .dp-btns button')].every((b) => b.disabled)));
await win.keyboard.press('Escape'); await W(500);
check('closing the Drive popup switches the mate on again', !(await win.evaluate((id) => lithApp.doc.doc.mates.find((m) => m.id === id)._free, am.id)));
await win.evaluate(() => lithApp.doc.undo()); await W(300); await win.evaluate(() => lithApp.doc.undo()); await W(300); // back to max 150
for (let k = 0; k < 3 && (await doc()).mates.find((m) => m.id === am.id).limits.max !== 150; k++) { await win.evaluate(() => lithApp.doc.undo()); await W(300); }
check('undo → Maximum 150 again', (await doc()).mates.find((m) => m.id === am.id).limits.max === 150, JSON.stringify((await doc()).mates.find((m) => m.id === am.id).limits));
// delete steps: right-click → Delete Step, Delete key in the step popup; undo brings them back
const nSteps = (await motionOf()).length;
{ const b = await barBox(1); await win.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' }); await W(300); }
await win.locator('.ctx-item:has-text("Delete Step")').click(); await W(400);
check('right-click a bar → Delete Step', (await motionOf()).length === nSteps - 1 && (await win.locator('.motion-strip .ms-stepbar').count()) === nSteps - 1);
await win.evaluate(() => lithApp.doc.undo()); await W(500);
check('undo → the step is back', (await motionOf()).length === nSteps);
{ const b = await barBox(1); await win.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await W(400); }
const compsBefore = (await doc()).components.length, matesBefore = (await doc()).mates.length;
await win.keyboard.press('Delete'); await W(400);
check('Delete key with a step selected deletes the step (not a mate / component)', (await motionOf()).length === nSteps - 1 && (await doc()).components.length === compsBefore && (await doc()).mates.length === matesBefore && (await win.locator('.step-pop').count()) === 0);
await win.evaluate(() => lithApp.doc.undo()); await W(500);
check('undo → back to the steps before', (await motionOf()).length === nSteps);
// save to the temp copy → steps, playback, limits, axis in the file
await win.evaluate(() => lithApp.cur().save()); await W(800);
const f = JSON.parse(fs.readFileSync(A, 'utf8'));
const fm = f.mates.find((m) => m.id === am.id);
check('saved: motion steps + playback + mate limits/axis, no _drive', f.motion?.steps?.length === 2 && f.motion.playback === 'reciprocate' && !('loop' in f.motion) && fm.limits?.max === 150 && fm.axis && !('_drive' in fm), JSON.stringify(f.motion).slice(0, 120));
await T.shot('motion-end');
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
await T.app.close();
process.exit(errs.length ? 1 : 0);
