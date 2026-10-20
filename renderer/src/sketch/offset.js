// Offset Entities (0.1.94): pure 2D helpers, no DOM / solver. Used by sketch/offsettool.js and tests/unit/offset.mjs.
//
// A curve: {kind: 'line', a, b} | {kind: 'arc', c, r, a, b} (arc runs counter-clockwise from a to b) |
// {kind: 'circle', c, r}. A chain = ordered list of {i (curve index), rev} + closed: rev = traversed against the
// curve's own direction (for an arc: clockwise from its b to its a).
// Offset distance d is signed: + = to the LEFT of the traversal direction.
import { dist, lineLine, lineCircle, circleCircle } from './geom2d.js';
import { opt } from '../app/options/index.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const unit = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const left = (v) => [-v[1], v[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

// traversal form of chain item: {kind, a (start), b (end), c, r, ccw (arc turns ccw while traversed), i, rev}
export function travSeg(curves, it) {
  const g = curves[it.i];
  if (g.kind === 'line') return { kind: 'line', a: it.rev ? g.b : g.a, b: it.rev ? g.a : g.b, i: it.i, rev: !!it.rev };
  if (g.kind === 'arc') return { kind: 'arc', c: g.c, r: g.r, a: it.rev ? g.b : g.a, b: it.rev ? g.a : g.b, ccw: !it.rev, i: it.i, rev: !!it.rev };
  return { kind: 'circle', c: g.c, r: g.r, ccw: true, i: it.i, rev: false };
}
// unit tangent (traversal direction) at the start (end = false) or end (end = true) of a traversal segment
export function tangentAt(s, end) {
  if (s.kind === 'line') return unit(sub(s.b, s.a));
  const p = end ? s.b : s.a, rv = unit(sub(p, s.c));
  return s.ccw ? left(rv) : mul(left(rv), -1);
}

// Chain through curve `start`: follows shared end points (within tol) while there is exactly one way on.
// `same(i, j)` may restrict which curves join (e.g. same construction state). Returns {items, closed}.
export function gatherChain(curves, start, { tol = opt('skChainJoinTol'), same = () => true } = {}) {
  const g0 = curves[start];
  if (!g0 || g0.kind === 'circle') return { items: [{ i: start, rev: false }], closed: g0?.kind === 'circle' };
  const ends = (i) => [curves[i].a, curves[i].b];
  const nextFrom = (p, used) => {
    const hits = [];
    curves.forEach((g, j) => {
      if (used.has(j) || g.kind === 'circle' || !same(start, j)) return;
      const [a, b] = ends(j);
      if (dist(a, p) < tol) hits.push({ i: j, rev: false });
      else if (dist(b, p) < tol) hits.push({ i: j, rev: true });
    });
    return hits;
  };
  const used = new Set([start]);
  const fwd = [{ i: start, rev: false }];
  let closed = false;
  for (;;) { // forward from the end
    const last = fwd[fwd.length - 1], t = travSeg(curves, last);
    if (fwd.length > 1 && dist(t.b, curves[start].a) < tol) { closed = true; break; }
    const h = nextFrom(t.b, used);
    if (h.length !== 1) { if (fwd.length > 1 && h.length === 0 && dist(t.b, curves[start].a) < tol) closed = true; break; }
    used.add(h[0].i); fwd.push(h[0]);
  }
  if (!closed) { // backward from the start
    for (;;) {
      const first = fwd[0], t = travSeg(curves, first);
      const h = nextFrom(t.a, used);
      if (h.length !== 1) break;
      const it = { i: h[0].i, rev: !h[0].rev }; // reached at its end when traversed forward
      used.add(it.i); fwd.unshift(it);
    }
  }
  return { items: fwd, closed };
}

// signed area of the traversed chain (closed: + = counter-clockwise)
export function chainArea(curves, items) {
  const pts = [];
  for (const it of items) {
    const s = travSeg(curves, it);
    if (s.kind === 'circle') { for (let k = 0; k < 32; k++) { const t = k / 32 * 2 * Math.PI; pts.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]); } continue; }
    if (s.kind === 'line') { pts.push(s.a); continue; }
    let a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a1 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]);
    if (s.ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
    for (let k = 0; k < 16; k++) { const t = a0 + (a1 - a0) * k / 16; pts.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]); }
  }
  let A = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; A += p[0] * q[1] - q[0] * p[1]; }
  return A / 2;
}
// sign of d for "outside" of a closed chain (open chain: left = +1)
export const outwardSign = (curves, items, closed) => (closed && chainArea(curves, items) > 0 ? -1 : 1);

// Offset a chain by signed distance d. Returns {segs: [{kind, a, b, c, r, ccw, i, rev}], joints: [{k, tangent}], closed}
// or {err} (message). joints[k] = joint between segs[k] and segs[k+1] (last one wraps for a closed chain).
export function offsetChain(curves, items, closed, d) {
  const eps = opt('geomEps'), sinTol = Math.sin(opt('offsetAngTolDeg') * Math.PI / 180); // tangent joint tolerance
  const base = items.map((it) => travSeg(curves, it));
  if (base.length === 1 && base[0].kind === 'circle') {
    const s = base[0], r = s.r - d;
    if (r <= eps) return { err: 'The offset is larger than the circle radius.' };
    return { segs: [{ ...s, r }], joints: [], closed: true };
  }
  const out = base.map((s) => {
    if (s.kind === 'line') { const n = mul(left(unit(sub(s.b, s.a))), d); return { ...s, a: add(s.a, n), b: add(s.b, n) }; }
    const r = s.r + (s.ccw ? -d : d);
    const rad = (p) => add(s.c, mul(unit(sub(p, s.c)), r));
    return { ...s, r, a: rad(s.a), b: rad(s.b) };
  });
  for (const s of out) if (s.kind === 'arc' && s.r <= eps) return { err: 'The offset is larger than an arc radius in the chain.' };
  const joints = [];
  const nJ = closed ? out.length : out.length - 1;
  for (let k = 0; k < nJ; k++) {
    const A = out[k], B = out[(k + 1) % out.length], bA = base[k], bB = base[(k + 1) % base.length];
    const ta = tangentAt(bA, true), tb = tangentAt(bB, false);
    const tangent = Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) < sinTol && dot(ta, tb) > 0;
    joints.push({ k, tangent });
    if (tangent) continue; // offset ends already meet (same normal)
    const near = mul(add(A.b, B.a), 0.5);
    let X = [];
    if (A.kind === 'line' && B.kind === 'line') X = lineLine(A.a, A.b, B.a, B.b, { segA: false, segB: false });
    else if (A.kind === 'line') X = lineCircle(A.a, A.b, B.c, B.r, { seg: false });
    else if (B.kind === 'line') X = lineCircle(B.a, B.b, A.c, A.r, { seg: false });
    else X = circleCircle(A.c, A.r, B.c, B.r);
    if (!X.length) return { err: 'The offset entities do not meet at a corner of the chain - try a smaller distance.' };
    const P = X.reduce((m, q) => (dist(q, near) < dist(m, near) ? q : m), X[0]);
    A.b = P; B.a = P;
  }
  // a line that turned around (or vanished) = distance too large for the chain
  for (let k = 0; k < out.length; k++) {
    const s = out[k], b = base[k];
    if (s.kind === 'line' && (dist(s.a, s.b) < eps || dot(sub(s.b, s.a), sub(b.b, b.a)) <= 0)) return { err: 'The offset is too large: an entity of the chain would turn inside out.' };
    if (s.kind === 'arc' && dist(s.a, s.b) < opt('geomEpsTiny') && dist(b.a, b.b) > eps) return { err: 'The offset is too large: an arc of the chain would vanish.' };
  }
  return { segs: out, joints, closed };
}

// ---------------------------------------------------------------- sketch side (plain sketch object, no DOM)
export function sketchCurves(sk) {
  const G = new Map(sk.geo.map((g) => [g.id, g])), P = (id) => { const p = G.get(id); return p ? [p.x, p.y] : null; };
  const ids = [], curves = [];
  for (const g of sk.geo) {
    if (g.type === 'line') curves.push({ kind: 'line', a: P(g.p1), b: P(g.p2) });
    else if (g.type === 'arc') curves.push({ kind: 'arc', c: P(g.c), r: g.r, a: P(g.s), b: P(g.e) });
    else if (g.type === 'circle') curves.push({ kind: 'circle', c: P(g.c), r: g.r });
    else continue;
    ids.push(g.id);
  }
  return { ids, curves, index: new Map(ids.map((id, i) => [id, i])) };
}
// chain of sketch entities through geometry `id` (selectChain false = that entity alone)
export function sketchChain(sk, id, { selectChain = true, tol = opt('skChainJoinTol') } = {}) {
  const C = sketchCurves(sk), i = C.index.get(id);
  if (i == null) return null;
  const g = sk.geo.find((x) => x.id === id);
  const same = (a, b) => !!sk.geo.find((x) => x.id === C.ids[b])?.construction === !!g.construction && !!sk.geo.find((x) => x.id === C.ids[b])?.refKey === !!g.refKey;
  const ch = selectChain ? gatherChain(C.curves, i, { tol, same }) : { items: [{ i, rev: false }], closed: C.curves[i].kind === 'circle' };
  return { items: ch.items.map((it) => ({ id: C.ids[it.i], rev: it.rev })), closed: ch.closed };
}

// Add offset entities to sketch `sk` (mutated). spec = {chains: [{items: [{id, rev}], closed}], dist (> 0),
// side (+1 = left of the first chain's traversal, -1 = right; 0 = outside for closed chains / left for open),
// both, cap, baseConstruction}. Returns {made: [geo ids], master (dimension id), err}.
export function addOffset(sk, spec) {
  const C = sketchCurves(sk);
  const G = (id) => sk.geo.find((g) => g.id === id);
  const gid = () => 'g' + sk.next++, cid = () => 'c' + sk.next++;
  const pt = (p) => { const g = { id: gid(), type: 'point', x: p[0], y: p[1] }; sk.geo.push(g); return g.id; };
  const cons = (c) => { const k = { id: cid(), ...c }; sk.cons.push(k); return k; };
  const made = [];
  let master = null;
  const plan = [];
  for (const ch of spec.chains) {
    const items = ch.items.map((it) => ({ i: C.index.get(it.id), rev: !!it.rev }));
    if (items.some((it) => it.i == null)) return { err: 'An entity of the chain was not found.' };
    const s0 = (spec.side || outwardSign(C.curves, items, ch.closed)) * (spec.reverse ? -1 : 1);
    for (const side of spec.both ? [s0, -s0] : [s0]) {
      const res = offsetChain(C.curves, items, ch.closed, side * spec.dist);
      if (res.err) return { err: res.err };
      plan.push({ ch, items, res, side });
    }
  }
  const capEnds = [];
  for (const { ch, items, res } of plan) {
    const segIds = []; // per segment: {gid, start point, end point}
    res.segs.forEach((s, k) => {
      const bg = G(ch.items[k].id);
      let ng, a, b;
      if (s.kind === 'line') { a = pt(s.a); b = pt(s.b); ng = { id: gid(), type: 'line', p1: a, p2: b }; }
      else if (s.kind === 'circle') { ng = { id: gid(), type: 'circle', c: pt(s.c), r: s.r }; }
      else {
        a = pt(s.a); b = pt(s.b);
        ng = { id: gid(), type: 'arc', c: pt(s.c), s: s.ccw ? a : b, e: s.ccw ? b : a, r: s.r };
      }
      sk.geo.push(ng); made.push(ng.id);
      let sd = 0;
      if (s.kind === 'line') { const P1 = G(bg.p1), P2 = G(bg.p2), d0 = unit([P2.x - P1.x, P2.y - P1.y]), m = mul(add(s.a, s.b), 0.5); sd = Math.sign(dot(left(d0), [m[0] - P1.x, m[1] - P1.y])) || 1; }
      const val = { a: ng.id, b: bg.id, value: spec.dist, ...(s.kind !== 'line' ? { s: Math.sign(s.r - bg.r) || 1 } : { sd }) };
      if (!master) {
        const base = travSeg(C.curves, items[k]);
        let lp;
        if (s.kind === 'line') { const dir = unit(sub(s.b, s.a)), L = dist(s.a, s.b), n = unit(sub(s.a, base.a)); lp = add(mul(dir, opt('offsetDimLabelAlong') * L), mul(n, opt('offsetDimLabelAcross') * spec.dist)); }
        else { const u = s.kind === 'circle' ? [0.7071, 0.7071] : unit(sub(mul(add(s.a, s.b), 0.5), s.c)); lp = mul(u, s.r + Math.max(spec.dist, opt('offsetDimLabelMinR'))); }
        master = cons({ type: 'offset', ...val, lp });
      } else cons({ type: 'offsetRel', ...val, of: master.id });
      segIds.push({ id: ng.id, a, b, base: bg, trav: travSeg(C.curves, items[k]) });
    });
    // base joint point id at the traversal end (atEnd) / start of base segment k
    const bPt = (k, atEnd) => {
      const t = segIds[k].trav, g = segIds[k].base, end = atEnd !== t.rev;
      return g.type === 'line' ? (end ? g.p2 : g.p1) : (end ? g.e : g.s);
    };
    const radial = (k) => (segIds[k].base.type === 'arc' ? segIds[k].base.c : null);
    const endCons = (p, k, atEnd) => { // open end / tangent joint: offset end on the normal through the base end
      const B = bPt(k, atEnd), c = radial(k);
      if (c) cons({ type: 'offsetEnd', p, a: c, b: B });
      else cons({ type: 'offsetPerp', p, b: B, l: segIds[k].base.id });
    };
    for (const j of res.joints) {
      const k = j.k, k2 = (k + 1) % segIds.length;
      const pa = segIds[k].b, pb = segIds[k2].a;
      if (!j.tangent) { cons({ type: 'coincident', a: pa, b: pb }); continue; }
      const kr = radial(k) ? k : radial(k2) ? k2 : k; // radial line through an arc centre if there is one
      const B = kr === k ? bPt(k, true) : bPt(k2, false);
      for (const p of [pa, pb]) {
        if (radial(kr)) cons({ type: 'offsetEnd', p, a: radial(kr), b: B });
        else cons({ type: 'offsetPerp', p, b: B, l: segIds[kr].base.id });
      }
    }
    if (!res.closed && segIds[0].a) {
      endCons(segIds[0].a, 0, false);
      endCons(segIds[segIds.length - 1].b, segIds.length - 1, true);
      capEnds.push([segIds[0].a, segIds[segIds.length - 1].b]);
    }
  }
  if (spec.both && spec.cap) { // close both sides with lines at the open ends
    for (let k = 0; k + 1 < capEnds.length; k += 2) {
      const [s1, e1] = capEnds[k], [s2, e2] = capEnds[k + 1];
      for (const [p, q] of [[s1, s2], [e1, e2]]) {
        const P = G(p), Q = G(q), a = pt([P.x, P.y]), b = pt([Q.x, Q.y]);
        const l = { id: gid(), type: 'line', p1: a, p2: b }; sk.geo.push(l); made.push(l.id);
        cons({ type: 'coincident', a: p, b: a }); cons({ type: 'coincident', a: q, b });
      }
    }
  }
  if (spec.baseConstruction) for (const ch of spec.chains) for (const it of ch.items) { const g = G(it.id); if (g && !g.refKey) g.construction = true; }
  return { made, master: master?.id };
}
