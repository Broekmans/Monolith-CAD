// Motion Study timing: old after/with + delay form (0.1.122), own start times + moveStep + overlap (0.1.124), snapTime, frameTimes (Save Animation)
import { schedule, totalTime, valuesAt, placeStep, snapTime, frameTimes, moveStep, toAbsolute } from '../../shared/motion.mjs';
let bad = 0;
const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${info}`); if (!ok) bad++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const S = [
  { id: 'a', mate: 'm1', from: 0, to: 90, dur: 1 },
  { id: 'b', mate: 'm2', from: 0, to: 10, dur: 2, after: true },
  { id: 'c', mate: 'm1', from: 90, to: 0, dur: 1, after: false },
];
let sch = schedule(S);
check('old steps (no delay) unchanged', sch.map((s) => `${s.start}-${s.end}`).join() === '0-1,1-3,1-2', sch.map((s) => `${s.start}-${s.end}`).join());
const D = S.map((s) => ({ ...s })); D[1].delay = 0.5; D[2].delay = 0.25;
sch = schedule(D);
check('delay after / with', sch.map((s) => `${s.start}-${s.end}`).join() === '0-1,1.5-3.5,1.75-2.75' && totalTime(D) === 3.5, sch.map((s) => `${s.start}-${s.end}`).join());
check('first step delay', schedule([{ ...S[0], delay: 0.4 }])[0].start === 0.4);
check('values before a delayed first step = its from', valuesAt([{ ...S[0], delay: 0.4 }], 0.2).m1 === 0);
// 0.1.124: own start times
const A = [
  { id: 'a', mate: 'm1', from: 0, to: 90, start: 0, dur: 1 },
  { id: 'b', mate: 'm2', from: 0, to: 10, start: 2, dur: 2 },
  { id: 'c', mate: 'm1', from: 90, to: 0, start: 0.5, dur: 1 },
];
sch = schedule(A);
check('own start times, list order free (step 3 before step 2)', sch.map((s) => `${s.start}-${s.end}`).join() === '0-1,2-4,0.5-1.5' && totalTime(A) === 4, sch.map((s) => `${s.start}-${s.end}`).join());
let p = placeStep(A, 1, 0.3, 1.5);
check('placeStep: just the start and time', p.start === 0.3 && p.dur === 1.5 && Object.keys(p).join() === 'start,dur', JSON.stringify(p));
check('placeStep: not before 0', placeStep(A, 1, -2, 1).start === 0);
const mv = moveStep(A, 2, 0);
check('moveStep: order changes, times stay', mv.map((s) => s.id).join() === 'c,a,b' && schedule(mv).find((s) => s.id === 'b').start === 2);
check('moveStep: clamps the target row', moveStep(A, 0, 9).map((s) => s.id).join() === 'b,c,a');
// same mate, overlapping: the later one starts where the earlier one is then (no jump); later = takes over
const vAt = (t) => valuesAt(A, t).m1;
check('overlap: at 0.5 s step 3 takes over from where step 1 is (45°), no jump', Math.abs(vAt(0.5 - 1e-9) - 45) < 1e-3 && Math.abs(vAt(0.5) - 45) < 1e-6, `${vAt(0.4999)} ${vAt(0.5)}`);
check('overlap: step 3 ends at its own To (0)', vAt(1.5) === 0 && vAt(3) === 0);
check('list order does not matter for the values', JSON.stringify([0, 0.7, 1.2, 3].map((t) => valuesAt(mv, t))) === JSON.stringify([0, 0.7, 1.2, 3].map((t) => valuesAt(A, t))));
// old form → absolute (format 1 files)
const abs = toAbsolute(D);
check('toAbsolute: same times, no after / delay', abs.map((s) => s.start).join() === '0,1.5,1.75' && abs.every((s) => !('after' in s) && !('delay' in s) && !('i' in s) && !('end' in s)), JSON.stringify(abs));
check('toAbsolute: same values as the old form where steps of a mate do not overlap', [0.2, 1.6, 2.6, 3.4].every((t) => Math.abs(valuesAt(abs, t).m2 - valuesAt(D, t).m2) < 1e-9));
// snapTime
check('snap to a near target', snapTime(1.03, [0, 1, 2], 0.05, 0.1) === 1);
check('else snap to the grid', near(snapTime(1.37, [0, 1, 2], 0.05, 0.1), 1.4));
check('grid 0 = free', snapTime(1.37, [], 0.05, 0) === 1.37);
// frameTimes
let f = frameTimes(2, 15, 'once');
check('once: 0 … total, 31 frames', f.length === 31 && f[0] === 0 && near(f[30], 2), `${f.length} ${f[f.length - 1]}`);
f = frameTimes(2, 15, 'reciprocate');
check('reciprocate: 60 frames, up to total and back, no double start', f.length === 60 && near(Math.max(...f), 2) && near(f[59], 1 / 15) && f[0] === 0, `${f.length} max ${Math.max(...f)} last ${f[59]}`);
// 0.1.125 loops
f = frameTimes(2, 15, 'once', 3);
check('once × 3: 91 frames, starts again at 0 after each run, ends at 2', f.length === 91 && f[0] === 0 && near(f[29], 29 / 15) && f[30] === 0 && near(f[90], 2) && f[60] === 0, `${f.length} ${f[29]} ${f[30]} ${f[90]}`);
f = frameTimes(2, 15, 'reciprocate', 2);
check('reciprocate × 2: 120 frames, two up-and-back cycles', f.length === 120 && f[60] === 0 && near(f[30], 2) && near(f[90], 2) && near(f[119], 1 / 15), `${f.length}`);
check('loops 1 = as before', JSON.stringify(frameTimes(2, 15, 'once', 1)) === JSON.stringify(frameTimes(2, 15, 'once')) && JSON.stringify(frameTimes(2, 15, 'reciprocate', 1)) === JSON.stringify(frameTimes(2, 15, 'reciprocate')));
// 0.1.126: speed
f = frameTimes(2, 15, 'once', 1, 0.5);
check('speed 0.5 = slow motion: twice the frames, motion step 1/30 s, ends on total', f.length === 61 && Math.abs(f[1] - 1 / 30) < 1e-12 && f[60] === 2, `${f.length} ${f[1]}`);
f = frameTimes(2, 15, 'once', 1, 2);
check('speed 2 = fast: half the frames, ends on total', f.length === 16 && Math.abs(f[1] - 2 / 15) < 1e-12 && f[15] === 2, `${f.length}`);
f = frameTimes(2, 15, 'reciprocate', 2, 0.25);
check('speed 0.25 reciprocate × 2 = 4 × 60 × 2 frames, all inside 0…total', f.length === 480 && f.every((t) => t >= 0 && t <= 2) && Math.abs(f[240]) < 1e-9, `${f.length} ${f[240]}`);
check('speed 1 = as before', JSON.stringify(frameTimes(2, 15, 'reciprocate', 2, 1)) === JSON.stringify(frameTimes(2, 15, 'reciprocate', 2)));
console.log(bad ? `FAILED ${bad}` : 'ALL OK');
process.exit(bad ? 1 : 0);
