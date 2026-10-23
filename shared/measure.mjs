// 0.1.134: distance between two picked faces / edges (Ctrl+click two in a part or assembly). Pure; all in one frame.
// An entity: {kind 'face'|'edge', geo {t:'plane', p, n} | {t:'axis', p, d, r?} | {t:'circle', p, d, r} | null,
// c (centre), tris [[a,b,c]…] (faces), segs [[a,b]…] (edges)}. measurePair → {normal (parallel planes / lines /
// line ∥ plane, else null), min (closest points), center, angle (° between the directions, null when not defined), dxyz}.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// entity from a displayed mesh (faces: triangles by start/count; edges: polylines); xp / xd map points / directions
export function entityOf(mesh, kind, id, xp = (p) => p, xd = (d) => d) {
  if (kind === 'face') {
    const f = mesh.faces.find((x) => x.id === id); if (!f) return null;
    const P = mesh.positions, I = mesh.indices, tris = [];
    const v = (k) => xp([P[3 * k], P[3 * k + 1], P[3 * k + 2]]);
    for (let i = f.start; i + 2 < f.start + f.count; i += 3) tris.push([v(I[i]), v(I[i + 1]), v(I[i + 2])]);
    let geo = null;
    if (f.type === 'plane' && f.plane) geo = { t: 'plane', p: xp(f.c), n: unit(xd(f.plane.normal)) };
    else if (f.type === 'cylinder' && f.axis) geo = { t: 'axis', p: xp(f.axis.p), d: unit(xd(f.axis.d)), r: f.r };
    return { kind, geo, c: xp(f.c), tris, segs: [] };
  }
  const e = mesh.edges.find((x) => x.id === id); if (!e) return null;
  const pts = []; for (let i = 0; i + 2 < e.pts.length; i += 3) pts.push(xp([e.pts[i], e.pts[i + 1], e.pts[i + 2]]));
  if (pts.length < 2) return null;
  const segs = []; for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  let geo = null, c = mul(add(pts[0], pts[pts.length - 1]), 0.5);
  if (e.type === 'line') geo = { t: 'axis', p: pts[0], d: unit(sub(pts[pts.length - 1], pts[0])) };
  else if (e.type === 'circle' && pts.length >= 3) {
    const cc = circle3(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
    if (cc) { geo = { t: 'circle', p: cc.c, d: cc.n, r: cc.r }; c = cc.c; }
  }
  return { kind, geo, c, tris: [], segs };
}
function circle3(a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), nn = dot(n, n);
  if (nn < 1e-12) return null;
  const off = add(mul(cross(n, ab), dot(ac, ac) / (2 * nn)), mul(cross(ac, n), dot(ab, ab) / (2 * nn)));
  return { c: add(a, off), r: len(off), n: unit(n) };
}
// closest point on a segment / triangle
function onSeg(p, a, b) { const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1))); return add(a, mul(ab, t)); }
function onTri(p, a, b, c) { // Ericson, Real-Time Collision Detection 5.1.5
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
}
function segSeg(p1, q1, p2, q2) { // closest points between two segments
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a < 1e-12 && e < 1e-12) return len(r);
  if (a < 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); } else {
    const c = dot(d1, r);
    if (e < 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}
const vertsOf = (E) => [...E.tris.flat(), ...E.segs.flat()];
function minDist(A, B, cap = 4000) {
  let best = Infinity;
  const thin = (arr) => (arr.length > cap ? arr.filter((_, i) => i % Math.ceil(arr.length / cap) === 0) : arr);
  const vA = thin(vertsOf(A)), vB = thin(vertsOf(B));
  const toE = (p, E) => { let d = Infinity; for (const t of E.tris) d = Math.min(d, len(sub(p, onTri(p, t[0], t[1], t[2])))); for (const s of E.segs) d = Math.min(d, len(sub(p, onSeg(p, s[0], s[1])))); return d; };
  for (const p of vA) best = Math.min(best, toE(p, B));
  for (const p of vB) best = Math.min(best, toE(p, A));
  if (A.segs.length && B.segs.length && A.segs.length * B.segs.length < 4e5) for (const s of A.segs) for (const t of B.segs) best = Math.min(best, segSeg(s[0], s[1], t[0], t[1]));
  return best;
}
export function measurePair(A, B, parTol = 1e-6) {
  const out = { normal: null, min: minDist(A, B), center: len(sub(B.c, A.c)), angle: null, dxyz: sub(B.c, A.c) };
  const ga = A.geo, gb = B.geo;
  const dirA = ga && (ga.t === 'plane' ? ga.n : ga.d), dirB = gb && (gb.t === 'plane' ? gb.n : gb.d);
  if (dirA && dirB) {
    const cos = Math.abs(dot(dirA, dirB));
    const linePlane = (ga.t === 'plane') !== (gb.t === 'plane') && ga.t !== 'circle' && gb.t !== 'circle';
    // a line and a plane: the angle between the line and the plane, parallel when the line lies across the normal
    out.angle = linePlane ? (Math.asin(Math.min(1, cos)) * 180) / Math.PI : (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
    if (ga.t === 'plane' && gb.t === 'plane' && cos > 1 - parTol) out.normal = Math.abs(dot(sub(gb.p, ga.p), ga.n));
    else if (ga.t === 'axis' && gb.t === 'axis' && cos > 1 - parTol) out.normal = len(cross(sub(gb.p, ga.p), ga.d));
    else if (linePlane && cos < parTol) { const P = ga.t === 'plane' ? ga : gb, X = ga.t === 'plane' ? gb : ga; out.normal = Math.abs(dot(sub(X.p, P.p), P.n)); }
    else if (ga.t === 'circle' && gb.t === 'circle' && cos > 1 - parTol) out.normal = Math.abs(dot(sub(gb.p, ga.p), ga.d)); // two parallel circles: distance of their planes
  }
  return out;
}
