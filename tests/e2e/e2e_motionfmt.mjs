// 0.1.124: an assembly saved with 0.1.119–0.1.123 (format 1: steps "after" / "with" + delay) opens as format 2 with own
// start times and plays the same. Needs ../scratch/bucket/ (Wouter's "Motion Sequencer test": Bucket assembly + parts).
import fs from 'node:fs';
import { launch } from './common.mjs';
import * as M from '../../shared/mates.mjs';
import { valuesAt, totalTime } from '../../shared/motion.mjs';
import { FORMAT } from '../../shared/format.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/mf'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/bucket')) fs.copyFileSync(`/home/claude/scratch/bucket/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Bucket assembly.lithasm`;
let old = JSON.parse(fs.readFileSync(A, 'utf8'));
// 0.1.127: Wouter re-saved the Bucket assembly with 0.1.124+ (own start times) → make a format-1 copy for this test:
// steps sorted by start, each "with the previous step" + delay (the old form), so it plays the same
if ((old.version || 1) >= 2) {
  const st = [...old.motion.steps].sort((a, b) => a.start - b.start);
  old.motion.steps = st.map(({ start, ...s }, i) => ({ ...s, after: i ? false : true, delay: +(start - (i ? st[i - 1].start : 0)).toFixed(6) }));
  old.version = 1; fs.writeFileSync(A, JSON.stringify(old));
}
check('test file is format 1 with after/with steps', (old.version || 1) === 1 && old.motion.steps.some((s) => s.after === false));
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const d = await win.evaluate(() => JSON.parse(JSON.stringify(lithApp.doc.toJSON())));
check(`opened as format ${FORMAT.assembly}, every step has a start, no after / delay`, d.version === FORMAT.assembly && d.motion.steps.every((s) => Number.isFinite(s.start) && !('after' in s) && !('delay' in s)), JSON.stringify(d.motion.steps.map((s) => [s.start, s.dur])));
const total = totalTime(old.motion.steps);
check('same total time', Math.abs(totalTime(d.motion.steps) - total) < 1e-9, total);
await T.btn('Motion Study'); await W(400);
let worst = 0;
for (const t of [0, 0.3, 0.6, 1.0, 1.4, 1.9, total]) {
  await win.evaluate((t) => { lithApp.doc.seekMotion(t, true); }, t); await W(150);
  const st = await win.evaluate(() => { const dd = lithApp.doc; return { comps: dd.doc.components.map((c) => ({ id: c.id, pos: [...c.pos], rot: [...c.rot] })), mates: JSON.parse(JSON.stringify(dd.doc.mates)) }; });
  const by = new Map(st.comps.map((c) => [c.id, c]));
  const want = valuesAt(old.motion.steps, t);
  for (const [id, v] of Object.entries(want)) { const m = st.mates.find((k) => k.id === id); let got = M.mateValue(m, by); got += 360 * Math.round((v - got) / 360); worst = Math.max(worst, Math.abs(got - v)); }
}
check('the model follows the old timing (mate values at 7 times, old rules)', worst < 0.05, `worst ${worst.toFixed(4)}°`);
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
await T.app.close();
process.exit(errs.length ? 1 : 0);
