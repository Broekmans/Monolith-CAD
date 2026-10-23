// 0.1.117: shared/mates.mjs dragStep on Wouter's "Slide and rotation test" assembly (crank + rod + slider):
// node tests/unit/asmdrag.mjs "<path>/Slide and rotation test.lithasm"
// Drags the crank (several step sizes) and the slider past their limits and back; mates must hold every step,
// the parts must stop at the limit and come back on the same branch (no flip).
import fs from 'node:fs';
import * as M from '../../shared/mates.mjs';
const file = process.argv[2];
if (!file) { console.log('usage: node tests/unit/asmdrag.mjs <Slide and rotation test.lithasm>'); process.exit(0); }
let fails = 0;
const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${info}`); if (!ok) fails++; };
const setup = () => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); const by = new Map(d.components.map((c) => [c.id, c])); return { d, by, crank: d.components.find((c) => c.name === 'Arm-1<1>'), slider: d.components.find((c) => c.name === 'Blok-2<1>') }; };
const size = (d) => new Map(d.components.map((c) => [c.id, c.lib ? 0 : 220]));
const err = (S) => Math.max(...S.d.mates.map((m) => M.mateError(m, S.by)));
const local = [200, 0, 20], piv = [300, 105];
function crankRun(dir, step, max) {
  const S = setup(), p0 = M.xfPoint(S.crank, local), r = Math.hypot(p0[0] - piv[0], p0[1] - piv[1]), a0 = Math.atan2(p0[1] - piv[1], p0[0] - piv[0]);
  const seq = []; for (let k = 1; k * step <= max; k++) seq.push(dir * k * step); for (let k = seq.length - 1; k >= 0; k--) seq.push(dir * k * step);
  const drag = { comp: S.crank.id, pts: [], prev: null }, sx0 = S.slider.pos[0];
  let worst = 0, far = 0, refused = 0;
  for (const deg of seq) {
    const a = a0 + deg * Math.PI / 180;
    drag.pts = [{ local, target: [piv[0] + r * Math.cos(a), piv[1] + r * Math.sin(a), p0[2]] }];
    if (M.dragStep(S.d.components, S.d.mates, drag, { size: size(S.d), maxStep: 22 }).status !== 'ok') refused++;
    worst = Math.max(worst, err(S));
    const g = M.xfPoint(S.crank, local); const ang = ((((Math.atan2(g[1] - piv[1], g[0] - piv[0]) - a0) * 180 / Math.PI) % 360) + 540) % 360 - 180;
    far = dir > 0 ? Math.max(far, ang) : Math.min(far, ang);
  }
  return { worst, far, refused, back: S.slider.pos[0] - sx0 };
}
for (const [dir, step, max, lo, hi] of [[1, 1, 130, 110, 118], [1, 3, 150, 110, 118], [1, 10, 180, 110, 118], [1, 30, 180, 110, 118], [-1, 3, 200, -178, -170], [-1, 30, 200, -178, -170]]) {
  const r = crankRun(dir, step, max);
  check(`crank ${dir > 0 ? '+' : '-'}${max}° in ${step}° steps: mates hold, stops ${lo}..${hi}°, back without flip`, r.worst < 1e-3 && r.far > lo && r.far < hi && Math.abs(r.back) < 1,
    `err ${r.worst.toExponential(1)} limit ${r.far.toFixed(1)} refused ${r.refused} slider back ${r.back.toFixed(2)}`);
}
// slider along its slot: free up to the stretched position (x ≈ -497), back to the start
for (const dir of [1, -1]) {
  const S = setup(), lp = [0, 60, 10], p0 = M.xfPoint(S.slider, lp), drag = { comp: S.slider.id, pts: [], prev: null };
  const seq = []; for (let k = 1; k <= 60; k++) seq.push(dir * k * 10); for (let k = 59; k >= 0; k--) seq.push(dir * k * 10);
  let worst = 0, mn = 1e9, mx = -1e9;
  for (const dx of seq) { drag.pts = [{ local: lp, target: [p0[0] + dx, p0[1] + 30, p0[2]] }]; M.dragStep(S.d.components, S.d.mates, drag, { size: size(S.d), maxStep: 22 }); worst = Math.max(worst, err(S)); mn = Math.min(mn, S.slider.pos[0]); mx = Math.max(mx, S.slider.pos[0]); }
  const ok = dir > 0 ? mx > 410 : mn > -498 && mn < -490;
  check(`slider ${dir > 0 ? '+' : '-'}600 mm: mates hold, ${dir > 0 ? 'follows' : 'stops at the stretched position'}, back`, worst < 1e-3 && ok && Math.abs(S.slider.pos[0] - p0[0]) < 1, `err ${worst.toExponential(1)} range ${mn.toFixed(1)}..${mx.toFixed(1)} end ${S.slider.pos[0].toFixed(1)}`);
}
console.log(fails ? `FAILED ${fails}` : 'ALL OK');
process.exit(fails ? 1 : 0);
