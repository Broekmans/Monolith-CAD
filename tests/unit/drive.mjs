// 0.1.119: Limits / Drive / Motion Study on Wouter's "Slide and rotation test": an Angle mate between the crank's side
// face and Blok-1 is added (turning axis from the pivot's concentric mate), then driven and limited.
// node tests/unit/drive.mjs "<path>/Slide and rotation test.lithasm"
import fs from 'node:fs';
import * as M from '../../shared/mates.mjs';
import { schedule, totalTime, valuesAt } from '../../shared/motion.mjs';
const file = process.argv[2];
let fails = 0;
const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${info}`); if (!ok) fails++; };
// motion timing (pure)
const steps = [{ mate: 'a', from: 0, to: 90, dur: 2 }, { mate: 'b', from: 0, to: 10, dur: 1, after: false }, { mate: 'a', from: 90, to: 0, dur: 1 }];
const sc = schedule(steps);
check('schedule: with-previous starts together, after waits for the longest', sc.map((s) => `${s.start}-${s.end}`).join() === '0-2,0-1,2-3', sc.map((s) => `${s.start}-${s.end}`).join());
check('total time 3 s', totalTime(steps) === 3);
const v = valuesAt(steps, 1), v2 = valuesAt(steps, 2.5), v3 = valuesAt(steps, 9);
check('values at 1 s / 2.5 s / end', v.a === 45 && v.b === 10 && v2.a === 45 && v3.a === 0 && v3.b === 10, JSON.stringify([v, v2, v3]));
if (!file) { console.log('(no assembly given: only the timing checks)'); process.exit(fails ? 1 : 0); }
const load = () => {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.mates = d.mates.filter((m) => m.type !== 'distance' && m.type !== 'angle'); delete d.motion; // 0.1.122: Wouter's file got a Distance mate on the slider (21-10) — this test adds its own
  const by = new Map(d.components.map((c) => [c.id, c]));
  const m = { id: 'mA', name: 'Angle1', type: 'angle', a: { comp: 'c3', geo: { t: 'plane', p: [0, 50, 20], n: [0, 1, 0] } }, b: { comp: 'c2', geo: { t: 'plane', p: [15, 25, 200], n: [0, 1, 0] } } };
  m.sense = M.currentSense(M.worldGeo(by.get('c3'), m.a.geo), M.worldGeo(by.get('c2'), m.b.geo));
  m.axis = M.angleAxisFor(m, d.components, d.mates);
  m.value = M.mateValue(m, by);
  d.mates.push(m);
  return { d, by, m, crank: by.get('c3'), slider: by.get('c13') };
};
const size = (d) => new Map(d.components.map((c) => [c.id, c.lib ? 0 : 220]));
const err = (S) => Math.max(...S.d.mates.map((m) => M.mateError(m, S.by)));
const crankAng = (S) => { const x = M.qrot(S.crank.rot, [1, 0, 0]); return (Math.atan2(x[1], x[0]) * 180) / Math.PI; };
let S = load();
const v0 = S.m.value, a0 = crankAng(S), sx0 = S.slider.pos[0];
check('new angle mate holds at the saved pose', err(S) < 1e-5, `value ${v0.toFixed(2)}° err ${err(S).toExponential(1)}`);
// which way the crank turns for +value
let drive = { targets: [{ id: 'mA', value: v0 + 5 }] };
M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) });
const sgn = Math.sign(((crankAng(S) - a0 + 540) % 360) - 180);
check('signed angle follows the crank 1:1', Math.abs(Math.abs(((crankAng(S) - a0 + 540) % 360) - 180) - 5) < 0.01, `${(((crankAng(S) - a0 + 540) % 360) - 180).toFixed(3)}°`);
// drive +100° (crank direction of the 117° dead point) and back in 2° slider steps
S = load(); drive = { targets: [] };
let worst = 0, maxSlStep = 0;
const seq = []; for (let k = 1; k <= 50; k++) seq.push(k * 2); for (let k = 49; k >= 0; k--) seq.push(k * 2);
for (const dd of seq) { const sx = S.slider.pos[0]; drive.targets = [{ id: 'mA', value: v0 + sgn * dd }]; M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) }); worst = Math.max(worst, err(S)); maxSlStep = Math.max(maxSlStep, Math.abs(S.slider.pos[0] - sx)); }
check('drive 0 → 100° → 0: mates hold, back at the start', worst < 1e-3 && Math.abs(S.slider.pos[0] - sx0) < 0.5, `err ${worst.toExponential(1)} slider ${S.slider.pos[0].toFixed(2)} (${sx0.toFixed(2)})`);
// drive straight to 150° (past the dead point at ≈117°): stops before it
S = load(); drive = { targets: [{ id: 'mA', value: v0 + sgn * 150 }] };
let r = M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) });
let got = Math.abs(((crankAng(S) - a0 + 540) % 360) - 180);
check('drive to 150° in one call: stops at the dead point (110..118°)', r.status !== 'ok' && got > 110 && got < 118 && err(S) < 1e-3, `${r.status} ${got.toFixed(1)}° part ${r.part.toFixed(2)}`);
drive.targets = [{ id: 'mA', value: v0 }]; r = M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) });
check('…and back to the start on the same branch', r.status === 'ok' && Math.abs(S.slider.pos[0] - sx0) < 0.5, `slider ${S.slider.pos[0].toFixed(2)}`);
M.endDrive(S.d.mates);
check('endDrive: value stored, _drive gone', Math.abs(S.m.value - v0) < 1e-4 && S.m._drive === undefined, S.m.value);
// Limits: free between v0-30 and v0+90 → dragging the crank stops at +90 (and -30)
S = load(); S.m.limits = { min: v0 + sgn * -30, max: v0 + sgn * 90 };
const dof = M.analyzeDOF(S.d.components, S.d.mates);
check('with limits the crank is still free (1 DOF)', dof.get('c3').dof === 1, JSON.stringify(dof.get('c3')));
const local = [200, 0, 20], piv = [300, 105];
const dragTo = (S, degs) => {
  const p0 = M.xfPoint(S.crank, local), rr = Math.hypot(p0[0] - piv[0], p0[1] - piv[1]), b0 = Math.atan2(p0[1] - piv[1], p0[0] - piv[0]);
  const dg = { comp: 'c3', pts: [], prev: null }; let e = 0;
  for (const dd of degs) { const a = b0 + (dd * Math.PI) / 180; dg.pts = [{ local, target: [piv[0] + rr * Math.cos(a), piv[1] + rr * Math.sin(a), p0[2]] }]; M.dragStep(S.d.components, S.d.mates, dg, { size: size(S.d), maxStep: 22 }); e = Math.max(e, err(S)); }
  return e;
};
const up = []; for (let k = 1; k <= 60; k++) up.push(k * 2); // crank turn = sgn × value change → the Maximum (v0 + sgn·90) is crank +90°
let e = dragTo(S, up);
got = ((crankAng(S) - a0 + 540) % 360) - 180;
check('drag past the Maximum: crank stops at +90°', Math.abs(Math.abs(got) - 90) < 0.5 && e < 1e-3, `${got.toFixed(2)}° err ${e.toExponential(1)}`);
S = load(); S.m.limits = { min: v0 + sgn * -30, max: v0 + sgn * 90 };
const dn = []; for (let k = 1; k <= 40; k++) dn.push(-k * 2);
e = dragTo(S, dn); got = ((crankAng(S) - a0 + 540) % 360) - 180;
check('drag past the Minimum: crank stops at -30°', Math.abs(Math.abs(got) - 30) < 0.5 && e < 1e-3, `${got.toFixed(2)}° err ${e.toExponential(1)}`);
// a limited distance mate: slider face to Blok-1 end face… use slider x via the pivot axis distance (axis–axis)
S = load();
const dm = { id: 'mD', type: 'distance', a: { comp: 'c2', geo: { t: 'axis', p: [300, 105, 0], d: [0, 0, 1] } }, b: { comp: 'c13', geo: { t: 'axis', p: [0, 95, 10], d: [0, 0, 1] } }, side: 1 };
dm.sense = M.currentSense(M.worldGeo(S.by.get('c2'), dm.a.geo), M.worldGeo(S.by.get('c13'), dm.b.geo));
S.m.limits = { min: v0 - 179, max: v0 + 179 }; // angle mate free (else it holds the crank)
dm.value = M.mateValue(dm, S.by); dm.limits = { min: dm.value - 50, max: dm.value + 50 }; S.d.mates.push(dm);
drive = { targets: [{ id: 'mD', value: dm.value + 40 }] };
r = M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) });
check('drive a distance mate +40 mm', r.status === 'ok' && Math.abs(M.mateValue(dm, S.by) - dm.value - 40) < 1e-3 && err(S) < 1e-3, `${r.status} ${M.mateValue(dm, S.by).toFixed(3)}`);
// two mates at once (Motion Study "with previous"): angle conflicts with the distance → refused, parts keep a good pose
drive = { targets: [{ id: 'mD', value: dm.value - 40 }, { id: 'mA', value: v0 + sgn * 60 }] };
r = M.driveStep(S.d.components, S.d.mates, drive, { size: size(S.d) });
check('conflicting drive (angle + distance on 1 DOF) is refused, mates stay closed', r.status !== 'ok' && err(S) < 1e-3, `${r.status} err ${err(S).toExponential(1)}`);
console.log(fails ? `FAILED ${fails}` : 'ALL OK');
process.exit(fails ? 1 : 0);
