// 0.1.118: Lock rotation on concentric mates (shared/mates.mjs, m.lockRot + m.lockQ).
// node tests/unit/lockrot.mjs "<path>/Slide and rotation test.lithasm"
// Without locks every Toolbox part keeps 1 free DOF (spin about its bolt axis); with its concentric mates locked it is
// fully defined, keeps its turn relative to the part it sits on while the crank is dragged, and the drag gets cheaper.
import fs from 'node:fs';
import * as M from '../../shared/mates.mjs';
const file = process.argv[2];
if (!file) { console.log('usage: node tests/unit/lockrot.mjs <Slide and rotation test.lithasm>'); process.exit(0); }
let fails = 0;
const check = (n, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${info}`); if (!ok) fails++; };
const load = () => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return { d, by: new Map(d.components.map((c) => [c.id, c])) }; };
const libs = (S) => S.d.components.filter((c) => c.lib);
const lockAll = (S) => { for (const m of S.d.mates) if (m.type === 'concentric' && (S.by.get(m.a.comp).lib || S.by.get(m.b.comp).lib)) { m.lockRot = true; m.lockQ = M.lockQOf(S.by.get(m.a.comp), S.by.get(m.b.comp)); } };
const err = (S) => Math.max(...S.d.mates.map((m) => M.mateError(m, S.by)));
// 1) DOF: a fastener on a moving part also carries that part's motion (crank mechanism = 1 DOF), so compare with
// the part it sits on: unlocked = part + 1 (spin), locked = part
let S = load();
const host = (S, f) => { for (const m of S.d.mates) if (m.type === 'concentric') { const a = S.by.get(m.a.comp), b = S.by.get(m.b.comp); if (a.id === f.id && !b.lib) return b; if (b.id === f.id && !a.lib) return a; } return null; };
const hostDof = (dof, S, f) => { const h = host(S, f); return h ? (h.fixed ? 0 : dof.get(h.id).dof) : null; };
let dof = M.analyzeDOF(S.d.components, S.d.mates);
const bolts = libs(S).filter((f) => host(S, f));
check('unlocked: bolts/washers on a part spin (DOF = part + 1)', bolts.every((f) => dof.get(f.id).dof === hostDof(dof, S, f) + 1), bolts.map((f) => `${f.name} ${dof.get(f.id).dof}/${hostDof(dof, S, f)}`).join(', '));
lockAll(S);
check('lock keeps the saved pose (mates < 1e-5)', err(S) < 1e-5, err(S).toExponential(1));
dof = M.analyzeDOF(S.d.components, S.d.mates);
check('locked: they move only with their part (DOF = part)', bolts.every((f) => dof.get(f.id).dof === hostDof(dof, S, f)), bolts.map((f) => `${f.name} ${dof.get(f.id).dof}/${hostDof(dof, S, f)}`).join(', '));
check('locked: on the fixed base → fully defined', libs(S).filter((f) => host(S, f)?.fixed).every((f) => dof.get(f.id).state === 'defined'));
check('crank still free (1 DOF)', dof.get('c3').dof === 1, JSON.stringify(dof.get('c3')));
// 2) drag the crank 0 → 100° → 0 with and without locks
const run = (locked) => {
  const S = load(); if (locked) lockAll(S);
  const crank = S.by.get('c3'), local = [200, 0, 20], piv = [300, 105];
  const p0 = M.xfPoint(crank, local), r = Math.hypot(p0[0] - piv[0], p0[1] - piv[1]), a0 = Math.atan2(p0[1] - piv[1], p0[0] - piv[0]);
  const parent = new Map(); // fastener → the non-library part it is mated to
  for (const m of S.d.mates) { const a = S.by.get(m.a.comp), b = S.by.get(m.b.comp); if (m.type === 'concentric' && a.lib && !b.lib) parent.set(a.id, b.id); if (m.type === 'concentric' && b.lib && !a.lib) parent.set(b.id, a.id); }
  const rel0 = new Map([...parent].map(([f, p]) => [f, M.relPose(S.by.get(p), S.by.get(f)).rot]));
  const size = new Map(S.d.components.map((c) => [c.id, c.lib ? 0 : 220]));
  const drag = { comp: 'c3', pts: [], prev: null };
  let worst = 0, spin = 0, ms = 0, n = 0;
  const seq = []; for (let k = 1; k <= 50; k++) seq.push(k * 2); for (let k = 49; k >= 0; k--) seq.push(k * 2);
  for (const deg of seq) {
    const a = a0 + deg * Math.PI / 180;
    drag.pts = [{ local, target: [piv[0] + r * Math.cos(a), piv[1] + r * Math.sin(a), p0[2]] }];
    const t = performance.now(); M.dragStep(S.d.components, S.d.mates, drag, { size, maxStep: 22 }); ms += performance.now() - t; n++;
    worst = Math.max(worst, err(S));
    for (const [f, p] of parent) { const q = M.relPose(S.by.get(p), S.by.get(f)).rot, q0 = rel0.get(f); const dq = M.qmul(q, M.qinv(q0)); spin = Math.max(spin, 2 * Math.acos(Math.min(1, Math.abs(dq[3]))) * 180 / Math.PI); }
  }
  return { worst, spin, ms: ms / n };
};
const a = run(false), b = run(true);
console.log('unlocked', JSON.stringify(a)); console.log('locked  ', JSON.stringify(b));
check('locked drag: mates hold', b.worst < 1e-3, b.worst.toExponential(1));
check('locked drag: fasteners do not turn on their part (< 0.01°)', b.spin < 0.01, b.spin.toFixed(4));
console.log(fails ? `FAILED ${fails}` : 'ALL OK');
process.exit(fails ? 1 : 0);
