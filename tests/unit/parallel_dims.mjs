// 0.1.89: fixParallelDims turns an old parallel-line distance (measured from the far end of a long model-edge
// reference) around so it is measured from the sketch line; value and label position stay. Plain node.
import fs from 'node:fs';
import * as S from '../../renderer/src/sketch/solver.js';
import { fixParallelDims } from '../../renderer/src/part/drive.js';
await S.initSolver();
const doc = JSON.parse(fs.readFileSync(process.argv[2] || '../scratch/hoesje.lithprt', 'utf8'));
const sk = doc.features.find((f) => f.name === 'Sketch3'); S.solve(sk);
const P = (id) => sk.geo.find((g) => g.id === id);
const l = P('g73'), x = P(l.p1).x; // slot right line
sk.geo.push({ id: 'e1', type: 'point', x: x + 7, y: -200 }, { id: 'e2', type: 'point', x: x + 7, y: 200 }, { id: 'eL', type: 'line', p1: 'e1', p2: 'e2', construction: true });
sk.cons.push({ id: 'cf', type: 'fix', e: 'eL' }, { id: 'cOld', type: 'pointLine', p: 'e1', l: 'g73', value: 7, lp: [10, 230] });
const c = sk.cons.find((k) => k.id === 'cOld'), lab0 = [P('e1').x + 10, P('e1').y + 230], v0 = S.measure(sk, c);
const n = fixParallelDims(sk);
const lab1 = [P(c.p).x + c.lp[0], P(c.p).y + c.lp[1]], v1 = S.measure(sk, c);
console.log('fixed', n, 'p', c.p, 'l', c.l, 'value', v0.toFixed(3), '→', v1.toFixed(3), 'label', lab0.map((v) => v.toFixed(1)), '→', lab1.map((v) => v.toFixed(1)));
const ok = n >= 1 && [l.p1, l.p2].includes(c.p) && c.l === 'eL' && Math.abs(v0 - v1) < 1e-9 && Math.hypot(lab0[0] - lab1[0], lab0[1] - lab1[1]) < 1e-9;
console.log(ok ? 'PASS' : 'FAIL'); if (!ok) process.exitCode = 1;
