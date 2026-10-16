// roomAt: two rooms with a 1 m door between them, an outer wall with a 1.2 m window gap and a 300 mm jog.
import { roomAt } from '../../renderer/src/drawing/fit.js';
const P = [];
let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
const wall = (x1, y1, x2, y2, gaps = []) => { const L = Math.hypot(x2 - x1, y2 - y1); for (let t = 0; t <= L; t += 8) { if (gaps.some(([a, b]) => t > a && t < b)) continue; P.push([x1 + (x2 - x1) * t / L + rnd() * 20, y1 + (y2 - y1) * t / L + rnd() * 20]); } };
// room A: x 0..5000, y 0..4000 ; room B: x 5000..10000 ; door in x=5000 wall at y 1500..2500
wall(0, 0, 10000, 0); wall(0, 4000, 4000, 4000); wall(4000, 4000, 4000, 4300); wall(4000, 4300, 5000, 4300); wall(5000, 4300, 5000, 4000); wall(5000, 4000, 10000, 4000, [[2000, 3200]]);
wall(0, 0, 0, 4000); wall(10000, 0, 10000, 4000); wall(5000, 0, 5000, 4000, [[1500, 2500]]);
// small room C: x 10000..11200, y 0..1000 (toilet)
wall(10000, 0, 11200, 0); wall(11200, 0, 11200, 1000); wall(10000, 1000, 11200, 1000);
// furniture blob in room A
for (let i = 0; i < 300; i++) P.push([1500 + rnd() * 600, 1500 + rnd() * 400]);
const cell = 5, gc = Math.max(40, cell * 12), grid = new Map(), key = (i, j) => i * 1048576 + j;
const x = Float64Array.from(P.map((p) => p[0])), y = Float64Array.from(P.map((p) => p[1]));
for (let i = 0; i < P.length; i++) { const k = key(Math.floor(x[i] / gc), Math.floor(y[i] / gc)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
const d = { n: P.length, x, y, gc, grid, cell };
const area = (Q) => Math.abs(Q.reduce((a, p, i) => a + p[0] * Q[(i + 1) % Q.length][1] - Q[(i + 1) % Q.length][0] * p[1], 0)) / 2e6;
for (const method of ['rect', 'follow']) for (const [name, q, want] of [['room A (20 m² + jog 0.3)', [3000, 3000], 20.3], ['room B (20 m², window gap)', [7500, 2000], 20], ['A near door', [4600, 2000], 20.3], ['small room C 1.2 x 1.0', [10600, 500], 1.2]]) {
  const t0 = performance.now(), poly = roomAt(d, q, 25000, { method });
  console.log(method, name, poly ? area(poly).toFixed(2) : null, 'want', want, poly ? 'corners ' + poly.length : '', `${(performance.now() - t0).toFixed(0)} ms`);
}
// noisy walls (Kuider-like): the free-space boundary follows the scatter in 25–200 mm steps
import { straighten } from '../../renderer/src/drawing/fit.js';
{
  const P2 = []; let s2 = 11; const r2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647 - 0.5; };
  const nw = (x1, y1, x2, y2) => { const L = Math.hypot(x2 - x1, y2 - y1); let o = 0; for (let t = 0; t <= L; t += 8) { if (Math.floor(t / 300) !== Math.floor((t - 8) / 300)) o = r2() * 160; const nx = -(y2 - y1) / L, ny = (x2 - x1) / L; P2.push([x1 + (x2 - x1) * t / L + nx * o + r2() * 20, y1 + (y2 - y1) * t / L + ny * o + r2() * 20]); } };
  nw(0, 0, 3000, 0); nw(3000, 0, 3000, 2000); nw(3000, 2000, 0, 2000); nw(0, 2000, 0, 0);
  const x2 = Float64Array.from(P2.map((p) => p[0])), y2 = Float64Array.from(P2.map((p) => p[1])), g2 = new Map();
  for (let i = 0; i < P2.length; i++) { const k = key(Math.floor(x2[i] / gc), Math.floor(y2[i] / gc)); if (!g2.has(k)) g2.set(k, []); g2.get(k).push(i); }
  const d2 = { n: P2.length, x: x2, y: y2, gc, grid: g2, cell };
  const poly = roomAt(d2, [1500, 1000]);
  console.log('noisy room 3.0 x 2.0 (±80 mm steps)', poly ? area(poly).toFixed(3) : null, 'want ~6 (inside faces a bit less)', poly ? 'corners ' + poly.length : '');
  const raw = roomAt(d2, [1500, 1000], 25000, { method: 'follow', minWall: 1, jog: 0, angle: 0 });
  console.log('  same, straightening off: corners', raw?.length);
  // straighten() on the logged Kuider Room 1 outline
  const k1 = [[5432,6793],[4832,6843],[4507,6843],[4457,6793],[4382,6868],[4207,6868],[4157,6793],[4182,6343],[4057,6293],[4057,5693],[4207,5618],[4182,5543],[4207,5593],[5432,5568]];
  const k = straighten(k1);
  console.log('Kuider room 1: 14 pts 1.653 m² ->', k.length, 'pts', area(k).toFixed(3), JSON.stringify(k.map((p) => p.map(Math.round))));
}
// 0.1.56: offset, close openings, straightness
{
  const B = roomAt(d, [7500, 2000], 25000, { offset: 100 });
  console.log('room B offset +100 (5.2 x 4.2 = 21.84):', area(B).toFixed(2), 'corners', B.length);
  const Bi = roomAt(d, [7500, 2000], 25000, { offset: -250 });
  console.log('room B offset -250 (4.5 x 3.5 = 15.75):', area(Bi).toFixed(2));
  const leak = roomAt(d, [7500, 2000], 25000, { method: 'follow', close: 800 });
  console.log('close 800: door 1 m and window 1.2 m stay open → leaks outside → null:', leak ? area(leak).toFixed(2) : null);
  const t = roomAt(d, [7500, 2000], 25000, { tol: 150 });
  console.log('straightness 150 → still 4 corners:', t?.length, area(t).toFixed(2));
}
// 0.1.60: Shift+click merge (union of square outlines): corridor 1.2 × 10 m + room 4 × 4 m on top, overlapping
{
  const { unionOrtho } = await import('../../renderer/src/drawing/outline.js');
  const U = unionOrtho([[[0, 0], [1200, 0], [1200, 10000], [0, 10000]], [[-2800, 6000], [1180, 6000], [1180, 10010], [-2800, 10010]]]);
  const A = Math.abs(U.reduce((s, p, i) => s + p[0] * U[(i + 1) % U.length][1] - U[(i + 1) % U.length][0] * p[1], 0)) / 2e6;
  console.log('merge corridor + room → L', U.length, 'corners', A.toFixed(3), 'm² (want 6 corners, ≈ 12 + 4.0·2.8 = 23.2)', JSON.stringify(U.map((p) => p.map(Math.round))));
  console.log('merge apart → null:', unionOrtho([[[0, 0], [1000, 0], [1000, 1000], [0, 1000]], [[2000, 0], [3000, 0], [3000, 1000], [2000, 1000]]]));
  console.log('merge slanted → null:', unionOrtho([[[0, 0], [1000, 0], [1000, 1000], [0, 900]], [[500, 0], [3000, 0], [3000, 1000], [500, 1000]]]));
}
// 0.1.63: join across a wall (Shift+click on the other side of a 200 mm wall with a 900 mm doorway)
{
  const { joinRooms } = await import('../../renderer/src/drawing/outline.js');
  const mk = (door) => {
    const Q = []; let s2 = 11; const r2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647 - 0.5; };
    const w = (x1, y1, x2, y2, gaps = []) => { const L = Math.hypot(x2 - x1, y2 - y1); for (let t = 0; t <= L; t += 8) { if (gaps.some(([a, b]) => t > a && t < b)) continue; Q.push([x1 + (x2 - x1) * t / L + r2() * 20, y1 + (y2 - y1) * t / L + r2() * 20]); } };
    w(0, 0, 8000, 0); w(0, 4000, 8000, 4000); w(0, 0, 0, 4000); w(8000, 0, 8000, 4000);
    const g = door ? [[1500, 2400]] : [];
    w(4000, 0, 4000, 4000, g); w(4200, 0, 4200, 4000, g); // wall faces, 200 mm thick
    if (door) { w(4000, 1500, 4200, 1500); w(4000, 2400, 4200, 2400); } // jambs
    const gc2 = 60, G = new Map(), X = Float64Array.from(Q.map((p) => p[0])), Y = Float64Array.from(Q.map((p) => p[1]));
    for (let i = 0; i < Q.length; i++) { const k = key(Math.floor(X[i] / gc2), Math.floor(Y[i] / gc2)); if (!G.has(k)) G.set(k, []); G.get(k).push(i); }
    return { n: Q.length, x: X, y: Y, gc: gc2, grid: G, cell: 5 };
  };
  for (const door of [true, false]) {
    const dd = mk(door), A = roomAt(dd, [2000, 2000], 25000, {}), B = roomAt(dd, [6000, 2000], 25000, {});
    const J = joinRooms(A, B, dd, 400);
    console.log(`join across wall, ${door ? 'door 900' : 'no door (full width)'}: A ${area(A).toFixed(2)} + B ${area(B).toFixed(2)} →`, J.poly ? `${area(J.poly).toFixed(2)} m², ${J.poly.length} corners, doorway ${J.doors.map((b) => Math.round(b.width))} mm ${JSON.stringify(J.poly.map((p) => p.map(Math.round)))}` : J.reason, door ? '(want ≈ A + B + 0.18, 12 corners: H shape)' : '(want A + B + 0.8 = 31.66, 4 corners)');
    if (door) console.log('  join 100 (wall thicker) →', joinRooms(A, B, dd, 100).reason || 'joined?!');
  }
}
