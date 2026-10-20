// 0.1.94 Offset Entities: geometry + solver relations on plain sketches. node tests/unit/offset.mjs
import { initSolver, solve, measure } from '../../renderer/src/sketch/solver.js';
import { solveStepped } from '../../renderer/src/part/drive.js';
import { sketchChain, addOffset } from '../../renderer/src/sketch/offset.js';
await initSolver();
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b, t = 1e-4) => Math.abs(a - b) < t;
const newSk = () => ({ geo: [{ id: 'O', type: 'point', x: 0, y: 0, fixed: true }], cons: [], next: 1 });
const P = (sk, x, y) => { const id = 'g' + sk.next++; sk.geo.push({ id, type: 'point', x, y }); return id; };
const L = (sk, a, b) => { const id = 'g' + sk.next++; sk.geo.push({ id, type: 'line', p1: a, p2: b }); return id; };
const A = (sk, c, s, e, r) => { const id = 'g' + sk.next++; sk.geo.push({ id, type: 'arc', c, s, e, r }); return id; };
const K = (sk, c) => sk.cons.push({ id: 'c' + sk.next++, ...c });
const Gp = (sk, id) => sk.geo.find((g) => g.id === id);
const bbox = (sk, ids) => { const xs = [], ys = []; for (const id of ids) { const g = Gp(sk, id); for (const k of ['p1', 'p2', 's', 'e']) if (g[k]) { xs.push(Gp(sk, g[k]).x); ys.push(Gp(sk, g[k]).y); } if (g.type === 'circle') { const c = Gp(sk, g.c); xs.push(c.x - g.r, c.x + g.r); ys.push(c.y - g.r, c.y + g.r); }
    if (g.type === 'arc') { const c = Gp(sk, g.c), S = Gp(sk, g.s), E = Gp(sk, g.e); let a0 = Math.atan2(S.y - c.y, S.x - c.x), a1 = Math.atan2(E.y - c.y, E.x - c.x); if (a1 <= a0) a1 += 2 * Math.PI; for (let k = 0; k <= 64; k++) { const t = a0 + (a1 - a0) * k / 64; xs.push(c.x + g.r * Math.cos(t)); ys.push(c.y + g.r * Math.sin(t)); } } } return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => +v.toFixed(4)); };
// rectangle 100 x 60 with length dims (driving, so we can change it)
function rect(w = 100, h = 60) {
  const sk = newSk();
  const p = [P(sk, 0, 0), P(sk, w, 0), P(sk, w, h), P(sk, 0, h)], q = [P(sk, 0, 0), P(sk, w, 0), P(sk, w, h), P(sk, 0, h)];
  const l = [L(sk, p[0], q[1]), L(sk, p[1], q[2]), L(sk, p[2], q[3]), L(sk, p[3], q[0])];
  for (let i = 0; i < 4; i++) K(sk, { type: 'coincident', a: l[i] && sk.geo.find((g) => g.id === l[i]).p2, b: sk.geo.find((g) => g.id === l[(i + 1) % 4]).p1 });
  K(sk, { type: 'horizontal', l: l[0] }); K(sk, { type: 'horizontal', l: l[2] }); K(sk, { type: 'vertical', l: l[1] }); K(sk, { type: 'vertical', l: l[3] });
  K(sk, { type: 'coincident', a: 'O', b: p[0] });
  K(sk, { id: 'W', type: 'length', l: l[0], value: w }); sk.cons[sk.cons.length - 1].id = 'W';
  K(sk, { type: 'length', l: l[1], value: h }); sk.cons[sk.cons.length - 1].id = 'H';
  return { sk, l };
}
// 1. rectangle, outside 5
{
  const { sk, l } = rect();
  const ch = sketchChain(sk, l[0]);
  ok(ch.items.length === 4 && ch.closed, `rectangle chain 4 closed (${ch.items.length}, ${ch.closed})`);
  const r = addOffset(sk, { chains: [ch], dist: 5, side: 0 });
  ok(!r.err && r.made.length === 4, 'offset made 4 lines ' + (r.err || ''));
  let s = solve(sk); ok(s.ok && !s.conflicting.length && !s.redundant.length, `solve ok, no conflict/redundant (${JSON.stringify(s.redundant)}) dof ${s.dof}`);
  ok(JSON.stringify(bbox(sk, r.made)) === '[-5,-5,105,65]', 'outside 5 → ' + JSON.stringify(bbox(sk, r.made)));
  s = solveStepped(sk, sk.cons.find((c) => c.id === 'W'), 150); // as the app does (≤ 25 % per step)
  ok(s.ok && JSON.stringify(bbox(sk, r.made)) === '[-5,-5,155,65]', 'width 150 → offset follows ' + JSON.stringify(bbox(sk, r.made)));
  const m = sk.cons.find((c) => c.id === r.master); s = solveStepped(sk, m, 12);
  ok(s.ok && JSON.stringify(bbox(sk, r.made)) === '[-12,-12,162,72]', 'offset 12 → ' + JSON.stringify(bbox(sk, r.made)) + ' measure ' + measure(sk, m).toFixed(3));
}
// 2. rounded slot 80 x 20 (2 lines + 2 arcs), inside 4 and both sides
{
  const mk = () => {
    const sk = newSk();
    const c1 = P(sk, 0, 0), c2 = P(sk, 80, 0);
    const a1 = P(sk, 0, -10), a2 = P(sk, 80, -10), b2 = P(sk, 80, 10), b1 = P(sk, 0, 10);
    const lb = L(sk, a1, a2), ar = A(sk, c2, P(sk, 80, -10), P(sk, 80, 10), 10), lt = L(sk, b2, b1), al = A(sk, c1, P(sk, 0, 10), P(sk, 0, -10), 10);
    const G = (id) => Gp(sk, id);
    K(sk, { type: 'coincident', a: a2, b: G(ar).s }); K(sk, { type: 'coincident', a: G(ar).e, b: b2 }); K(sk, { type: 'coincident', a: b1, b: G(al).s }); K(sk, { type: 'coincident', a: G(al).e, b: a1 });
    K(sk, { type: 'tangentEnd', l: lb, c: ar, p: a2 }); K(sk, { type: 'tangentEnd', l: lt, c: ar, p: b2 }); K(sk, { type: 'tangentEnd', l: lt, c: al, p: b1 }); K(sk, { type: 'tangentEnd', l: lb, c: al, p: a1 });
    K(sk, { type: 'horizontal', l: lb }); K(sk, { type: 'coincident', a: 'O', b: c1 }); K(sk, { type: 'horizontalPts', a: c1, b: c2 });
    sk.cons.push({ id: 'R', type: 'radius', c: ar, value: 10 }); sk.cons.push({ id: 'D', type: 'distance', a: c1, b: c2, value: 80 });
    return { sk, lb, ar };
  };
  let { sk, lb } = mk();
  let s0 = solve(sk); ok(s0.ok && !s0.redundant.length, 'slot base solves');
  let ch = sketchChain(sk, lb);
  ok(ch.items.length === 4 && ch.closed, 'slot chain 4 closed');
  let r = addOffset(sk, { chains: [ch], dist: 4, side: 0 });
  let s = solve(sk); ok(!r.err && s.ok && !s.conflicting.length && !s.redundant.length, `slot outside 4 solves (${r.err || ''} red ${JSON.stringify(s.redundant)})`);
  ok(JSON.stringify(bbox(sk, r.made)) === '[-14,-14,94,14]', 'slot outside 4 → ' + JSON.stringify(bbox(sk, r.made)));
  solveStepped(sk, sk.cons.find((c) => c.id === 'R'), 15); s = solveStepped(sk, sk.cons.find((c) => c.id === 'D'), 100);
  ok(s.ok && JSON.stringify(bbox(sk, r.made)) === '[-19,-19,119,19]', 'R15 / 100 → ' + JSON.stringify(bbox(sk, r.made)));
  ({ sk, lb } = mk()); ch = sketchChain(sk, lb);
  r = addOffset(sk, { chains: [ch], dist: 4, side: 0, both: true });
  s = solve(sk); ok(!r.err && r.made.length === 8 && s.ok && !s.redundant.length, 'slot both sides 8 entities');
  ok(JSON.stringify(bbox(sk, r.made.slice(4))) === '[-6,-6,86,6]', 'inner side → ' + JSON.stringify(bbox(sk, r.made.slice(4))));
  ({ sk, lb } = mk()); ch = sketchChain(sk, lb);
  r = addOffset(sk, { chains: [ch], dist: 12, side: 0, both: true });
  ok(!!r.err, 'inside 12 > R10 refused: ' + r.err);
}
// 3. open L chain + single circle + cap ends
{
  const sk = newSk();
  const a = P(sk, 0, 0), b = P(sk, 50, 0), b2 = P(sk, 50, 0), c = P(sk, 50, 30);
  const l1 = L(sk, a, b), l2 = L(sk, b2, c);
  K(sk, { type: 'fix', e: l1 }); K(sk, { type: 'fix', e: l2 });
  const ch = sketchChain(sk, l2);
  ok(ch.items.length === 2 && !ch.closed, 'L chain 2 open');
  const r = addOffset(sk, { chains: [ch], dist: 5, side: 1, both: true, cap: true });
  const s = solve(sk); ok(!r.err && r.made.length === 6 && s.ok && !s.redundant.length && s.dof === 0, `L both + caps: ${r.made.length} entities dof ${s.dof} red ${JSON.stringify(s.redundant)}`);
  ok(JSON.stringify(bbox(sk, r.made)) === '[0,-5,55,30]', 'L both → ' + JSON.stringify(bbox(sk, r.made)));
  const ci = P(sk, 200, 0), cg = 'g' + sk.next++; sk.geo.push({ id: cg, type: 'circle', c: ci, r: 10 }); K(sk, { type: 'fix', e: cg });
  const r2 = addOffset(sk, { chains: [sketchChain(sk, cg)], dist: 3, side: 0 });
  const s2 = solve(sk); ok(!r2.err && s2.ok && near(Gp(sk, r2.made[0]).r, 13), 'circle outside 3 → r ' + Gp(sk, r2.made[0]).r);
}
console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
