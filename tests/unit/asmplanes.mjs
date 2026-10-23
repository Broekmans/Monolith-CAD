// 0.1.127: mates to origin planes — the assembly's own planes (GROUND) and a component's part planes
import * as M from '../../shared/mates.mjs';
let bad = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) bad++; };
const near = (a, b, t = 1e-5) => Math.abs(a - b) < t;
const q = (ax, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)]; };
// a part somewhere, turned; no component fixed
const P = { id: 'c1', pos: [120, -40, 75], rot: M.qnorm([0.2, 0.5, -0.1, 0.8]), fixed: false };
const comps = [P];
// part Front Plane (normal z) coincident with assembly Top Plane (normal y), part Right Plane coincident with assembly Right Plane,
// part Top Plane at 30 mm from the assembly Front Plane
const mates = [
  { id: 'm1', type: 'coincident', a: M.planeRef(M.GROUND_ID, 'Top'), b: M.planeRef('c1', 'Front') },
  { id: 'm2', type: 'coincident', a: M.planeRef(M.GROUND_ID, 'Right'), b: M.planeRef('c1', 'Right') },
  { id: 'm3', type: 'distance', value: 30, a: M.planeRef(M.GROUND_ID, 'Front'), b: M.planeRef('c1', 'Top') },
];
M.solveMates(comps, mates, { iters: 200 });
const byId = M.compMap(comps);
const err = Math.max(...mates.map((m) => M.mateError(m, byId)));
const nF = M.qrot(P.rot, [0, 0, 1]), nR = M.qrot(P.rot, [1, 0, 0]), nT = M.qrot(P.rot, [0, 1, 0]);
check('solved: all three plane mates hold', err < 1e-4, err.toExponential(1));
check('part Front Plane lies in the assembly Top Plane (normal ∥ Y, origin y = 0)', near(Math.abs(nF[1]), 1) && near(P.pos[1], 0), `${nF.map((v) => v.toFixed(3))} y ${P.pos[1].toFixed(4)}`);
check('part Right Plane lies in the assembly Right Plane (x = 0)', near(Math.abs(nR[0]), 1) && near(P.pos[0], 0), P.pos[0].toFixed(4));
check('part Top Plane 30 mm from the assembly Front Plane (|z| = 30, normal ∥ Z)', near(Math.abs(nT[2]), 1) && near(Math.abs(P.pos[2]), 30), P.pos[2].toFixed(4));
check('mateValue of the distance mate = 30', near(Math.abs(M.mateValue(mates[2], byId)), 30));
check('GROUND is not moved', JSON.stringify(M.GROUND.pos) === '[0,0,0]' && JSON.stringify(M.GROUND.rot) === '[0,0,0,1]');
const dof = M.analyzeDOF(comps, mates).get('c1');
check('DOF: three plane mates define the part fully', dof.state === 'defined', JSON.stringify(dof));
const dof2 = M.analyzeDOF(comps, mates.slice(0, 1)).get('c1');
check('DOF: one coincident plane → 3 DOF left', dof2.state === 'under' && dof2.dof === 3, JSON.stringify(dof2));
// drag with a ground mate: the part slides in the plane, stays on it
const s0 = [...P.pos];
const r = M.dragStep(comps, mates.slice(0, 1), { comp: 'c1', pts: [{ local: [0, 0, 0], target: [P.pos[0] + 20, 50, P.pos[2] + 10] }], hist: [] }, { maxStep: 10 });
check('drag: stays in the assembly Top Plane, moves in it', r.status === 'ok' && near(P.pos[1], 0, 1e-3) && Math.hypot(P.pos[0] - s0[0], P.pos[2] - s0[2]) > 5, `${r.status} ${P.pos.map((v) => v.toFixed(2))}`);
// angle mate between a part plane and an assembly plane + drive
const Q = { id: 'c2', pos: [0, 0, 0], rot: q([0, 1, 0], 20), fixed: false };
const mates2 = [
  { id: 'k1', type: 'coincident', a: M.planeRef(M.GROUND_ID, 'Top'), b: M.planeRef('c2', 'Top') },
  { id: 'k2', type: 'angle', value: 20, a: M.planeRef(M.GROUND_ID, 'Front'), b: M.planeRef('c2', 'Front') },
];
M.solveMates([Q], mates2.slice(0, 1), { iters: 100 });
mates2[1].axis = M.angleAxisFor(mates2[1], [Q], mates2);
const v0 = M.mateValue(mates2[1], M.compMap([Q])); mates2[1].value = v0;
const d = { targets: [{ id: 'k2', value: v0 + 30 }], hist: [] };
const rd = M.driveStep([Q], mates2, d, {});
M.endDrive(mates2);
check('Angle mate to an assembly plane: drive +30°, the part turns about the assembly Y axis', rd.status === 'ok' && near(M.mateValue(mates2[1], M.compMap([Q])), v0 + 30, 1e-3) && near(Q.pos[1], 0, 1e-6), `${rd.status} ${v0.toFixed(2)} → ${M.mateValue(mates2[1], M.compMap([Q])).toFixed(3)}`);
console.log(bad ? `FAILED ${bad}` : 'ALL OK');
process.exit(bad ? 1 : 0);
