// 0.1.135: Motion Study Play at 1× / 3× / 10× on Wouter's Bucket assembly through the strip (Speed select + Play):
// fewer solves per frame (bigger pieces + warm start), mates closed, same end pose as a slow play (no flip); a slow
// "PC" (fake clock: every clock read takes 5 ms) uses up the 12 ms solve time per frame at 10× → the playhead stays
// where the model got to, the strip says it plays slower, the log says so once, the study still ends at the same pose.
// Needs ../scratch/b300/ (Bucket assembly); copy in /tmp/ps.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/ps'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/b300')) fs.copyFileSync(`/home/claude/scratch/b300/${f}`, `${DIR}/${f}`);
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); window.__xlog = []; const o = window.__lithLog; window.__lithLog = (...a) => { window.__xlog.push(a.join(' ')); return o?.(...a); }; });
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, `${DIR}/Bucket assembly.lithasm`);
await W(1200); await idle();
await win.locator('.cm-btn:has-text("Motion Study")').first().click(); await W(1000);
check('Motion Study open', await win.locator('.motion-strip .ms-btn:has-text("Play")').count() === 1);
// normal playback (the file plays back and forth)
if (await win.evaluate(() => lithApp.doc.playMode()) === 'reciprocate') { await win.locator('.motion-strip .ms-btn:has-text("Reciprocate")').click(); await W(400); }
check('playback normal', (await win.evaluate(() => lithApp.doc.playMode())) === 'normal');
const total = await win.evaluate(() => Math.max(...lithApp.doc.motionSteps().map((s) => s.start + s.dur)));
const poses = () => win.evaluate(() => lithApp.doc.doc.components.map((c) => [...c.pos, ...c.rot]));
const dev = (a, b) => Math.max(...a.map((p, i) => Math.max(...[0, 1, 2].map((k) => Math.abs(p[k] - b[i][k])), ...[3, 4, 5, 6].map((k) => 300 * Math.abs(Math.abs(p[k]) - Math.abs(b[i][k]))))));
// play from the start with a fake clock (frames of 1/60 s; inc = extra ms every clock read takes)
const playAll = async (speed, inc) => {
  await win.locator('.motion-strip .ms-btn[title="To the start"]').click(); await W(500);
  if (String(await win.locator('.motion-strip .ms-speed select').inputValue()) !== String(speed)) { await win.locator('.motion-strip .ms-speed select').selectOption(String(speed)); await W(400); }
  await win.evaluate((inc) => { window.__xlog = []; let fake = performance.now(); window.__q = []; window.__raf = window.requestAnimationFrame; window.__pn = performance.now;
    window.requestAnimationFrame = (f) => { window.__q.push(f); return 1; }; performance.now = () => (fake += inc);
    window.__step = () => { fake += 1000 / 60; const q = window.__q; window.__q = []; q.forEach((f) => f(fake)); }; }, inc);
  await win.locator('.motion-strip .ms-btn:has-text("Play")').click(); await W(100);
  const r = await win.evaluate(() => {
    const d = lithApp.doc, ts = [], msgs = new Set();
    for (let i = 0; i < 3000 && d._mt.playing; i++) { window.__step(); ts.push(d._mt.t); const m = document.querySelector('.motion-strip .ms-msg')?.textContent; if (m) msgs.add(m); }
    const playing = d._mt.playing; if (playing) d.pauseMotion();
    window.requestAnimationFrame = window.__raf; performance.now = window.__pn;
    const by = new Map(d.doc.components.map((c) => [c.id, c]));
    void by;
    return { frames: ts.length, t: d._mt.t, mono: ts.every((v, i) => !i || v >= ts[i - 1] - 1e-9), playing, msgs: [...msgs], log: window.__xlog.filter((l) => /^MOTION (motion|play)/.test(l)) };
  });
  const errMax = await win.evaluate(() => { const d = lithApp.doc; return Math.max(0, ...[...(d.mateErr?.values?.() || [])].map((e) => +e || 0)); });
  r.poses = await poses(); r.err = errMax;
  const line = r.log.find((l) => /^MOTION motion/.test(l)) || '';
  r.solves = +(line.match(/([\d.]+) solves per step/) || [])[1];
  r.maxErr = +(line.match(/max mate error ([\d.e+-]+) mm/) || [])[1];
  r.ms = +(line.match(/([\d.]+) ms avg/) || [])[1];
  r.line = line;
  return r;
};
const ref = await playAll(0.5, 0);
check('0.5×: plays to the end (reference pose)', !ref.playing && Math.abs(ref.t - total) < 1e-6 && ref.maxErr < 1e-3, `${ref.frames} frames, t ${ref.t.toFixed(3)} / ${total.toFixed(3)}, ${ref.solves} solves per step | ${ref.line}`);
for (const sp of [1, 3, 10]) {
  const r = await playAll(sp, 0);
  check(`${sp}×: whole study played, mates closed, end pose = the 0.5× end pose (no flip), solves per frame logged`, !r.playing && Math.abs(r.t - total) < 1e-6 && r.mono && r.maxErr < 1e-3 && dev(r.poses, ref.poses) < 0.05 && r.solves > 0,
    `${r.frames} frames, ${r.solves} solves/frame, ${r.ms} ms avg, dev ${dev(r.poses, ref.poses).toFixed(4)} | ${r.line}`);
  if (sp === 3) check('3×: at most 2 solves per frame on average (0.1.134: 3–6)', r.solves <= 2, String(r.solves));
}
// slow PC: every clock read 5 ms → the 12 ms budget is used up after 2–3 pieces
const slow = await playAll(10, 5);
const slowLog = slow.log.find((l) => /^MOTION play: solve time/.test(l)) || '';
check('10× on a slow PC: solve time used up → playhead follows the model (never jumps back), strip says it plays slower, log line once, end pose the same',
  !slow.playing && Math.abs(slow.t - total) < 1e-6 && slow.mono && slow.msgs.some((m) => /Playing at about .* instead of 10×/.test(m)) && /used up in \d+ of \d+ frames — played at about [\d.]+× instead of 10×/.test(slowLog) && slow.log.filter((l) => /^MOTION play: solve time/.test(l)).length === 1 && dev(slow.poses, ref.poses) < 0.05 && slow.maxErr < 1e-3,
  `${slow.frames} frames, msgs ${JSON.stringify(slow.msgs.slice(0, 2))} | ${slowLog} | ${slow.line}`);
const msgAfter = await win.locator('.motion-strip .ms-msg').textContent();
check('after the play the "slower" message is gone', !/Playing at about/.test(msgAfter || ''), msgAfter);
// scrub still exact: To the start → values at 0
const p0 = await win.evaluate(() => { lithApp.doc.seekMotion(0, true); return lithApp.doc.doc.mates.filter((m) => m._drive != null).length; });
check('To the start after the plays: the study mates follow the timeline', p0 > 0, String(p0));
const bad = await win.evaluate(() => (window.__xlog || []).filter((l) => /ERROR/.test(l)));
check('no ERROR lines', !bad.length, bad.join(' | '));
await T.close?.();
console.log(errs.length ? `${errs.length} FAIL` : 'all ok');
process.exit(errs.length ? 1 : 0);
