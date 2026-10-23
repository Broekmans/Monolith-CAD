// 0.1.117: dragging in an assembly stops at the end of travel instead of stretching the mates, never flips the
// mechanism to its other branch, and writes a DRAG line to the action log. Real mouse drags on Wouter's
// "Slide and rotation test" (Blok-1 fixed, crank Arm-1<1> turns about Blok-1's pin, rods Arm-1<2>/<3>, slider
// Blok-2 in Blok-1's slot; crank limit ≈ 117° from the saved pose). Needs ../scratch/motion/ (asm + Arm-1, Blok-1, Blok-2).
// Reads the real action log file (own MONOLITH_HOME + user-data-dir, like e2e_kernelmode).
import fs from 'node:fs';
import { _electron as electron } from 'playwright-core';
import * as M from '../../shared/mates.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const HOME = '/tmp/adhome', UD = '/tmp/adud', DIR = '/tmp/ad';
for (const d of [HOME, UD, DIR]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
fs.writeFileSync(UD + '/actionlog.json', JSON.stringify({ enabled: true, asked: true, consentV: 9 }));
const SRC = '/home/claude/scratch/motion';
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(`${SRC}/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
fs.mkdirSync('tests/e2e/shots', { recursive: true });
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox', '--user-data-dir=' + UD],
  env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'assembly', MONOLITH_LOGTEST: '1', MONOLITH_HOME: HOME }, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
const W = (ms) => win.waitForTimeout(ms);
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 60000 }); await W(200); };
const logLines = (re) => { let t = ''; try { for (const f of fs.readdirSync(HOME + '/Logs')) if (/^MonoLith-.*\.log$/.test(f)) t += fs.readFileSync(HOME + '/Logs/' + f, 'utf8'); } catch {} return t.split('\n').filter((l) => re.test(l)); };
await W(3000);
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part || c.lib)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.setView('front', false); d.zoomFit(); }); await W(800);
// zoom out about the pivot so the whole circle of the grab point stays in the view
await win.evaluate(() => { const d = lithApp.doc, s = d.vp.toScreen([300, 105, 200]); d.vp.zoomAt(s[0], s[1], 1.9); }); await W(500);

// state probe (computed here in node with the program's own solver module): crank angle about the pivot (deg),
// slider x, largest mate error
const PIV = [300, 105], GRAB = [120, 0, 40]; // pivot (Blok-1 pin, world XY); grab point on the crank's top face (crank local)
const mates = await win.evaluate(() => JSON.parse(JSON.stringify(lithApp.doc.doc.mates)));
const state = async () => {
  const cs = await win.evaluate(() => lithApp.doc.doc.components.map((c) => ({ id: c.id, name: c.name, pos: [...c.pos], rot: [...c.rot], fixed: c.fixed })));
  const by = new Map(cs.map((c) => [c.id, c]));
  const crank = cs.find((c) => c.name === 'Arm-1<1>'), slider = cs.find((c) => c.name === 'Blok-2<1>');
  const x = M.qrot(crank.rot, [200, 0, 0]);
  let err = 0; for (const m of mates) if (!m.suppressed) err = Math.max(err, M.mateError(m, by));
  return { ang: Math.atan2(x[1], x[0]) * 180 / Math.PI, sx: slider.pos[0], err, crank: crank.id };
};
const s0 = await state();
console.log('start', JSON.stringify(s0));
check('saved pose: mates hold', s0.err < 1e-4, s0.err);

// screen point of a world point; the grab = the picked surface point under the crank point GRAB, the targets turn it
// about the pivot in the XY plane (the drag plane of a Front view goes through the picked point)
const toScr = (p) => win.evaluate((p) => { const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), s = d.vp.toScreen(p); return [r.left + s[0], r.top + s[1]]; }, p);
const pickAt = (x, y) => win.evaluate(([x, y]) => { const d = lithApp.doc; const p = d.pickAt({ clientX: x, clientY: y }); return p ? { name: d.C(p.comp)?.name, point: p.point } : null; }, [x, y]);
let W0 = null;
const scr = (deg) => { const a = deg * Math.PI / 180, dx = W0[0] - PIV[0], dy = W0[1] - PIV[1]; return toScr([PIV[0] + dx * Math.cos(a) - dy * Math.sin(a), PIV[1] + dx * Math.sin(a) + dy * Math.cos(a), W0[2]]); };
// drag the crank +150° (past the ≈117° limit) and back to 0, in 3° mouse steps
const inView = (x, y) => win.evaluate(([x, y]) => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return x > r.left + 5 && x < r.right - 5 && y > r.top + 5 && y < r.bottom - 5; }, [x, y]);
const drag = async (to, step) => {
  step = Math.sign(to) * Math.abs(step);
  const cs = await win.evaluate(() => lithApp.doc.doc.components.map((c) => ({ id: c.id, name: c.name, pos: [...c.pos], rot: [...c.rot] })));
  const [gx, gy] = await toScr(M.xfPoint(cs.find((c) => c.name === 'Arm-1<1>'), GRAB));
  const pk = await pickAt(gx, gy); const who = pk?.name; W0 = pk?.point || [0, 0, 0];
  const [x0, y0] = await scr(0);
  await win.mouse.move(x0, y0, { steps: 2 }); await W(100); await win.mouse.down();
  let outside = 0; for (let a = 0; Math.abs(a) <= Math.abs(to); a += step) if (!(await inView(...(await scr(a))))) outside++;
  if (outside) console.log('WARNING', outside, 'mouse points outside the view');
  const seq = []; for (let a = step; Math.abs(a) <= Math.abs(to); a += step) seq.push(a); for (let i = seq.length - 2; i >= 0; i--) seq.push(seq[i]); seq.push(0);
  const trace = [];
  let maxErr = 0, maxAng = -1e9, minAng = 1e9, maxSx = -1e9, minSx = 1e9;
  for (const a of seq) {
    const [x, y] = await scr(a); await win.mouse.move(x, y); await W(15);
    const s = await state(); maxErr = Math.max(maxErr, s.err);
    const da = ((s.ang - s0.ang) % 360 + 540) % 360 - 180; maxAng = Math.max(maxAng, da); minAng = Math.min(minAng, da);
    maxSx = Math.max(maxSx, s.sx); minSx = Math.min(minSx, s.sx);
    trace.push([a, +da.toFixed(1), +s.sx.toFixed(0)]);
    if (Math.abs(a) === Math.abs(to)) await win.screenshot({ path: `tests/e2e/shots/asmdrag-limit${to > 0 ? '+' : '-'}.png` });
  }
  const sEnd = await state();
  await win.mouse.up(); await W(400);
  const sRel = await state();
  if (process.env.TRACE) console.log(JSON.stringify(trace));
  return { who, maxErr, maxAng, minAng, minSx, maxSx, end: sEnd, rel: sRel };
};
let r = await drag(150, 3);
console.log('drag +150', JSON.stringify(r));
check('grabbed the crank', r.who === 'Arm-1<1>', r.who);
check('mates never stretched while dragging (< 0.001 mm)', r.maxErr < 1e-3, r.maxErr.toExponential(2));
check('crank stops at its limit (110°..118°)', r.maxAng > 110 && r.maxAng < 118, r.maxAng.toFixed(1));
check('back at the start pose, no flip (slider x as saved ± 2 mm)', Math.abs(r.end.sx - s0.sx) < 2 && Math.abs(r.rel.sx - s0.sx) < 2, `${s0.sx.toFixed(1)} -> ${r.end.sx.toFixed(1)} / ${r.rel.sx.toFixed(1)}`);
for (let i = 0; i < 20 && !logLines(/\bDRAG /).length; i++) await W(250);
let L = logLines(/\bDRAG /);
check('DRAG line in the action log', L.length === 1 && /DRAG Arm-1<1>: \d+ steps, stopped at a limit \d+ \(mates \d+, dead point\/jump \d+\), retraced \d+/.test(L[0]), L[0] || '(none)');
const m = /\(mates (\d+), dead point\/jump (\d+)\)/.exec(L[0] || '');
check('DRAG line counts the refused steps past the limit', m && +m[1] + +m[2] >= 5, m ? `${m[1]} + ${m[2]}` : '');
// other direction: crank goes all the way to ≈ -176° (second dead point) and back
r = await drag(-200, 4);
console.log('drag -200', JSON.stringify(r));
check('negative drag: mates hold', r.maxErr < 1e-3, r.maxErr.toExponential(2));
check('negative drag: stops near -176°', r.minAng < -170 && r.minAng > -178, r.minAng.toFixed(1));
check('negative drag: back without flip', Math.abs(r.rel.sx - s0.sx) < 2, `${r.rel.sx.toFixed(1)}`);
// undo of a drag goes back to the pose before it
await win.evaluate(() => lithApp.doc.undo()); await W(400);
const su = await state();
check('undo → pose before the last drag', Math.abs(su.sx - s0.sx) < 2 && su.err < 1e-3, su.sx.toFixed(1));
for (let i = 0; i < 20 && logLines(/\bDRAG /).length < 2; i++) await W(250);
L = logLines(/\bDRAG /); console.log(L.join('\n'));
check('2 DRAG lines', L.length === 2, L.length);
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
await app.close();
process.exit(errs.length ? 1 : 0);
