// 0.1.132: in-context references (linkgeom.js applyXrefs): geometry converted from another component's edges follows
// that component when it moves or changes size. node tests/unit/xref.mjs
import { initSolver, solve } from '../../renderer/src/sketch/solver.js';
import { applyXrefs, xrefBase, refFromMeshEdge, followLinks, hasXrefs, hasFixed, autoLink } from '../../renderer/src/part/linkgeom.js';
await initSolver();
let fails = 0;
const ok = (name, c, info = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!c) fails++; };
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;

// a box W × D × H (bottom at z 0) with a Ø10 hole near the +x end, as displayed mesh edges
function boxMesh(W, D = 50, H = 20) {
  const P = [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]];
  const edges = [];
  let id = 1;
  for (const z of [0, H]) for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; edges.push({ id: id++, type: 'line', pts: [a[0], a[1], z, b[0], b[1], z] }); }
  for (const p of P) edges.push({ id: id++, type: 'line', pts: [p[0], p[1], 0, p[0], p[1], H] });
  const c = [W - 20, D / 2], pts = [];
  for (let k = 0; k <= 32; k++) { const t = (k / 32) * 2 * Math.PI; pts.push(c[0] + 5 * Math.cos(t), c[1] + 5 * Math.sin(t), 0); }
  edges.push({ id: id++, type: 'circle', pts });
  return { edges, bbox: { min: [0, 0, 0], max: [W, D, H] } };
}
const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const fr = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
const xr = (mesh, e) => ({ asm: 'C:\\a.lithasm', comp: 'k1', compName: 'Blok-1<1>', file: 'Blok-1.lithprt', ref: refFromMeshEdge(e, mesh.bbox) });

const m0 = boxMesh(100);
// sketch: line on the other part's front bottom edge (placed at x 200), circle on its hole, a corner point, and an own
// line from the converted line's end: horizontal, 30 long (follows)
function sketch() {
  return {
    type: 'sketch', id: 's1', name: 'Sketch1',
    geo: [
      { id: 'O', type: 'point', x: 0, y: 0, fixed: true, origin: true },
      { id: 'g1', type: 'point', x: 200, y: 0 }, { id: 'g2', type: 'point', x: 300, y: 0 },
      { id: 'g3', type: 'line', p1: 'g1', p2: 'g2', construction: false, xref: xr(m0, m0.edges[0]) },
      { id: 'g4', type: 'point', x: 280, y: 25 },
      { id: 'g5', type: 'circle', c: 'g4', r: 5, xref: xr(m0, m0.edges[12]) },
      { id: 'g6', type: 'point', x: 200, y: 50, xref: { ...xr(m0, m0.edges[0]), ref: { type: 'vertex', p: [0, 50, 0], bb: m0.bbox } } },
      { id: 'g7', type: 'point', x: 330, y: 0 },
      { id: 'g8', type: 'line', p1: 'g2', p2: 'g7' },
    ],
    cons: [
      { type: 'fix', e: 'g3', xref: true }, { type: 'fix', e: 'g5', xref: true }, { type: 'fix', e: 'g6', xref: true },
      { id: 'c1', type: 'horizontal', l: 'g8' }, { id: 'c2', type: 'distance', a: 'g2', b: 'g7', value: 30 },
    ],
    next: 9,
  };
}
const bases = (mesh, m) => new Map([['k1', xrefBase(mesh, m)]]);
const G = (sk, id) => sk.geo.find((g) => g.id === id);
const run = (mesh, m) => {
  const sk = sketch(), before = JSON.parse(JSON.stringify(sk.geo));
  const r = applyXrefs(sk, bases(mesh, m), fr);
  const s = r.moved ? followLinks(sk, before, solve) : { ok: true };
  return { sk, r, s };
};

{ const { r } = run(m0, T(200, 0, 0)); ok('same place: nothing moves', r.moved === 0 && r.linked === 3 && !r.missing.length, JSON.stringify(r)); }
{
  const { sk, r, s } = run(m0, T(250, 10, 0));
  ok('moved: line follows', near(G(sk, 'g1').x, 250) && near(G(sk, 'g1').y, 10) && near(G(sk, 'g2').x, 350), `${G(sk, 'g1').x},${G(sk, 'g1').y} – ${G(sk, 'g2').x}`);
  ok('moved: circle follows', near(G(sk, 'g4').x, 330, 1e-3) && near(G(sk, 'g4').y, 35, 1e-3), `${G(sk, 'g4').x},${G(sk, 'g4').y}`);
  ok('moved: corner follows', near(G(sk, 'g6').x, 250) && near(G(sk, 'g6').y, 60));
  ok('moved: own line keeps its relations (solved)', s.ok !== false && near(Math.abs(G(sk, 'g7').x - 350), 30, 1e-4) && near(G(sk, 'g7').y, 10, 1e-4), `${G(sk, 'g7').x},${G(sk, 'g7').y}`);
  ok('moved: ref kept in the other part frame', near(G(sk, 'g3').xref.ref.a[0], 0) || near(G(sk, 'g3').xref.ref.b[0], 0));
}
{
  const m1 = boxMesh(160);
  const { sk, r } = run(m1, T(200, 0, 0));
  ok('longer part: line 200 → 360', near(Math.min(G(sk, 'g1').x, G(sk, 'g2').x), 200) && near(Math.max(G(sk, 'g1').x, G(sk, 'g2').x), 360), JSON.stringify(r));
  ok('longer part: hole near the end found at the new end', near(G(sk, 'g4').x, 340, 1e-3), `${G(sk, 'g4').x}`);
  ok('longer part: ref box updated', G(sk, 'g3').xref.ref.bb.max[0] === 160);
}
{ const sk = sketch(); const r = applyXrefs(sk, new Map(), fr); ok('out of context: nothing moves', r.outside.length === 3 && r.moved === 0); }
{ const sk = sketch(); const r = applyXrefs(sk, { get: () => undefined }, fr); ok('other assembly: nothing moves', r.outside.length === 3); }
{ const sk = sketch(); sk.cons = sk.cons.filter((c) => c.e !== 'g5'); applyXrefs(sk, bases(m0, T(200, 0, 0)), fr); ok('Fix deleted → reference gone', !G(sk, 'g5').xref && !!G(sk, 'g3').xref); }
{
  const sk = sketch();
  ok('hasXrefs / hasFixed ignore in-context fixes', hasXrefs(sk) && !hasFixed(sk));
  const n = autoLink(sk, { edges: [{ type: 'line', a: [200, 0, 0], b: [300, 0, 0], mid: [250, 0, 0] }], bbox: m0.bbox }, fr);
  ok('own auto-link leaves in-context geometry alone', n === 0 && !G(sk, 'g3').onEdge);
}
{ const m2 = boxMesh(100); m2.edges = m2.edges.filter((e) => e.type !== 'circle'); const { r } = run(m2, T(200, 0, 0)); ok('hole removed → missing, kept', r.missing.length === 1, JSON.stringify(r.missing)); }
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
