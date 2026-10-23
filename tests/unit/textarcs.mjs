// 0.1.108: glyph Bezier curves -> lines / 3-point arcs within the text's curve accuracy (kernel/occ.mjs bezierArcs).
// Run: node tests/unit/textarcs.mjs
import assert from 'node:assert/strict';
import { bezierArcs } from '../../kernel/occ.mjs';

const bez = (c, t) => { let q = c; while (q.length > 1) { const n = []; for (let i = 0; i < q.length - 1; i++) n.push(q[i].map((v, k) => v * (1 - t) + q[i + 1][k] * t)); q = n; } return q[0]; };
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// points along an arc piece (circle through a, m, b) or a line
function samplePiece(p, n = 40) {
  if (!p.m) return Array.from({ length: n + 1 }, (_, i) => p.a.map((v, k) => v + (p.b[k] - v) * (i / n)));
  // planar in z = const: circle through three points
  const [ax, ay] = p.a, [bx, by] = p.m, [cx, cy] = p.b, z = p.a[2];
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (q) => Math.atan2(q[1] - uy, q[0] - ux);
  let a0 = ang(p.a), am = ang(p.m), a1 = ang(p.b);
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sw = norm(a1 - a0); if (norm(am - a0) > sw) sw -= 2 * Math.PI; // through m
  return Array.from({ length: n + 1 }, (_, i) => [ux + r * Math.cos(a0 + sw * i / n), uy + r * Math.sin(a0 + sw * i / n), z]);
}
let curves = 0, pieces = 0;
for (const tol of [0.002, 0.01, 0.05]) {
  for (let k = 0; k < 300; k++) {
    const deg = k % 2 ? 3 : 2, s = 1 + rnd() * 9;
    // glyph-like: control points on one side of the chord (no loops / cusps)
    const c = [[0, 0, 5], ...Array.from({ length: deg - 1 }, (_, i) => [s * (i + 1) / deg + (rnd() - 0.5) * s * 0.3, rnd() * s * 0.6, 5]), [s, (rnd() - 0.5) * s * 0.4, 5]];
    const ps = bezierArcs(c, tol);
    curves++; pieces += ps.length;
    assert.ok(d3(ps[0].a, c[0]) < 1e-9 && d3(ps[ps.length - 1].b, c[deg]) < 1e-9, 'ends on the curve ends');
    for (let i = 1; i < ps.length; i++) assert.ok(d3(ps[i - 1].b, ps[i].a) < 1e-9, 'pieces connect');
    const dense = Array.from({ length: 2001 }, (_, i) => bez(c, i / 2000));
    for (const p of ps) for (const q of samplePiece(p)) {
      const dmin = Math.min(...dense.map((x) => d3(x, q)));
      assert.ok(dmin <= tol * 1.6 + s * 2e-3, `piece within accuracy (tol ${tol}: ${dmin.toFixed(5)})`);
    }
  }
}
// a straight "curve" stays one line
assert.equal(bezierArcs([[0, 0, 0], [1, 1, 0], [2, 2, 0]], 0.01).length, 1);
assert.equal(bezierArcs([[0, 0, 0], [1, 1, 0], [2, 2, 0]], 0.01)[0].m, null);
console.log(`ok - ${curves} curves -> ${pieces} lines/arcs, all within accuracy`);
