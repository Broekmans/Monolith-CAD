// 0.1.135: Motion Study Play speed on Wouter's Bucket assembly. Plays the study once (60 frames per second) at
// 1× / 3× / 10× with the old drive settings (pieces ≤ 3° / 10 mm) and the new Play settings (pieces ≤ 10° / 30 mm,
// warm start, 12 ms solve budget per frame). Reports solves per frame and ms per frame; checks that the mates stay
// closed and that the mechanism never flips: after every frame the pose is compared with a reference model driven to
// the same values with the old fine settings.
// node tests/unit/playspeed.mjs "<path>/Bucket assembly.lithasm"
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as M from '../../shared/mates.mjs';
import { totalTime, valuesAt } from '../../shared/motion.mjs';
import { factoryOf } from '../../renderer/src/app/options/index.js';
const file = process.argv[2];
if (!file) { console.log('usage: node tests/unit/playspeed.mjs <Bucket assembly.lithasm>'); process.exit(2); }
let fails = 0;
const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${info}`); if (!ok) fails++; };
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
const steps = src.motion.steps, total = totalTime(steps);
const size = (d) => new Map(d.components.map((c) => [c.id, c.lib ? 0 : 300]));
const base = { iters: factoryOf('asmDriveIters'), tol: factoryOf('asmDragTol'), ratio: factoryOf('asmDragRatio'), minMove: factoryOf('asmDragMinMove'), split: factoryOf('asmDragSplit'), maxPieces: factoryOf('asmDriveMaxPieces') };
const OLD = { ...base, maxStepDeg: factoryOf('asmDriveStepDeg'), maxStepMm: factoryOf('asmDriveStepMm') };
const PLAY = { ...base, maxStepDeg: factoryOf('asmPlayStepDeg'), maxStepMm: factoryOf('asmPlayStepMm'), warm: factoryOf('asmPlayWarm'), warmMax: factoryOf('asmPlayWarmMax') };
const BUDGET = { ...PLAY, budgetMs: factoryOf('asmPlayBudgetMs'), now: () => performance.now() };
console.log(`study: ${steps.length} steps, ${total.toFixed(2)} s; old pieces ${OLD.maxStepDeg}° / ${OLD.maxStepMm} mm, Play ${PLAY.maxStepDeg}° / ${PLAY.maxStepMm} mm, warm ${PLAY.warm}, budget ${BUDGET.budgetMs} ms`);
// a model at the study's start (as when the study is opened)
const start = (() => {
  const d = structuredClone(src);
  const drv = { targets: Object.entries(valuesAt(steps, 0)).map(([id, value]) => ({ id, value })) };
  const r = M.driveStep(d.components, d.mates, drv, { ...OLD, size: size(d) });
  return { d, ok: r.status === 'ok' && r.part >= 1 };
})();
const by = (d) => M.compMap(d.components);
const err = (d) => { const b = by(d); return Math.max(0, ...d.mates.filter((m) => !m.suppressed).map((m) => M.mateError(m, b)).filter(Number.isFinite)); };
check('study start pose reached, mates closed', start.ok && err(start.d) < 1e-3, `err ${err(start.d).toExponential(1)}`);
const dev = (a, b) => { // largest difference of two poses (origin + angle × 300 mm)
  let w = 0;
  a.components.forEach((c, i) => { const k = b.components[i]; const dq = M.qmul(c.rot, M.qinv(k.rot)); w = Math.max(w, M.len(M.sub(c.pos, k.pos)) + 2 * Math.acos(Math.min(1, Math.abs(dq[3]))) * 300); });
  return w;
};
const play = (speed, opts, name) => {
  const d = structuredClone(start.d), ref = structuredClone(start.d);
  const drv = { targets: [] }, rdrv = { targets: [] };
  let t = 0, frames = 0, solves = 0, sMax = 0, ms = 0, msMax = 0, cut = 0, worstErr = 0, worstDev = 0, held = 0, warm = 0, real = 0;
  const dt = 1 / 60;
  while (t < total - 1e-9 && frames < 5000) {
    const want = Math.min(total, t + dt * speed);
    drv.targets = Object.entries(valuesAt(steps, want)).map(([id, value]) => ({ id, value }));
    const t0 = performance.now();
    const r = M.driveStep(d.components, d.mates, drv, { ...opts, size: size(d) });
    const m = performance.now() - t0;
    frames++; real += dt; solves += r.solves; sMax = Math.max(sMax, r.solves); ms += m; msMax = Math.max(msMax, m); warm += r.warm || 0;
    if (r.status !== 'ok') { held++; break; }
    t = r.budget ? t + r.part * (want - t) : want;
    if (r.budget) cut++;
    worstErr = Math.max(worstErr, err(d));
    // reference: the same values, old fine pieces, its own session
    rdrv.targets = d.mates.filter((k) => k._drive != null).map((k) => ({ id: k.id, value: k._drive }));
    M.driveStep(ref.components, ref.mates, rdrv, { ...OLD, size: size(ref) });
    worstDev = Math.max(worstDev, dev(d, ref));
  }
  const o = { name, speed, frames, solves: solves / frames, sMax, ms: ms / frames, msMax, cut, held, worstErr, worstDev, eff: total / real, warm };
  console.log(`  ${name.padEnd(14)} ${String(speed).padStart(2)}×: ${String(frames).padStart(3)} frames, ${o.solves.toFixed(1)} solves/frame (max ${sMax}), ${o.ms.toFixed(1)} ms/frame (max ${msMax.toFixed(1)}), warm ${warm}, budget cut ${cut}, ran at ${o.eff.toFixed(2)}×, mate error ${worstErr.toExponential(1)} mm, vs reference ${worstDev.toFixed(4)} mm${held ? ' HELD' : ''}`);
  return o;
};
const res = {};
for (const speed of [1, 3, 10]) {
  res[speed] = { old: play(speed, OLD, 'old 3°/10 mm'), play: play(speed, PLAY, 'Play, no budget'), budget: play(speed, BUDGET, 'Play + budget') };
}
for (const speed of [1, 3, 10]) {
  const r = res[speed];
  for (const k of ['old', 'play', 'budget']) check(`${speed}× ${r[k].name}: whole study played, mates closed, no flip (same pose as the fine reference)`, !r[k].held && r[k].worstErr < 1e-3 && r[k].worstDev < 0.5, `err ${r[k].worstErr.toExponential(1)} dev ${r[k].worstDev.toFixed(4)} mm`);
  check(`${speed}× Play needs fewer solves per frame than before`, r.play.solves <= r.old.solves, `${r.play.solves.toFixed(1)} vs ${r.old.solves.toFixed(1)}`);
}
check('3×: Play pieces = at most 1/2 of the old solves per frame', res[3].play.solves <= res[3].old.solves / 2, `${res[3].play.solves.toFixed(1)} vs ${res[3].old.solves.toFixed(1)}`);
// budget: tiny budget forces cuts → the study still ends, slower, same poses
const tiny = play(10, { ...BUDGET, budgetMs: 1e-6 }, 'budget ~0 ms');
check('budget ~0 ms at 10×: one piece per frame, the rest next frame, study still completes on the same branch', tiny.cut > 0 && tiny.sMax <= 4 && !tiny.held && tiny.worstDev < 0.5 && tiny.eff < 10, `cut ${tiny.cut} of ${tiny.frames}, max ${tiny.sMax} solves, ran at ${tiny.eff.toFixed(2)}×`);
// warm start off vs on (same pieces): fewer or equal solver work, same result
const cold = play(3, { ...PLAY, warm: false }, 'Play, cold');
check('warm start used, same pose as without it', res[3].play.warm > 0 && res[3].play.worstDev < 0.5 && cold.worstDev < 0.5, `warm pieces ${res[3].play.warm}; ms/frame warm ${res[3].play.ms.toFixed(1)} vs cold ${cold.ms.toFixed(1)}`);
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
