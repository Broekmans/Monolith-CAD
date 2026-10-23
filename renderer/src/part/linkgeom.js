// Linked Convert Entities ("On Edge"): pure geometry, no DOM / kernel calls (also used by tests/unit/link_replay.mjs).
// A converted line / circle / arc (or a point on a model corner) keeps `g.onEdge` = a reference to the model edge it
// came from: {type: 'line'|'circle'|'vertex', a, b, mid, c, r, n, closed, p, bb}. On every rebuild the renderer asks the
// kernel for the edges of the body just before the sketch (kernel `linkBase`), finds the referenced edge again
// (`matchRef`, same idea as fillet / chamfer edges: type, direction, position relative to the body's bounding box),
// moves the geometry onto it (`applyLinks`) and solves the sketch, so its own relations and dimensions are kept.

import { opt } from '../app/options/index.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const bbDiag = (bb) => (bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : opt('linkDefaultSize'));

// sketch frame helpers (frame = {o, x, y, n})
export const loc2 = (fr, p) => { const d = sub(p, fr.o); return [dot(d, fr.x), dot(d, fr.y)]; };
export const at3 = (fr, p) => [fr.o[0] + fr.x[0] * p[0] + fr.y[0] * p[1], fr.o[1] + fr.x[1] * p[0] + fr.y[1] * p[1], fr.o[2] + fr.x[2] * p[0] + fr.y[2] * p[1]];

// where a point of the old body is expected on the new body: same position relative to the bounding box
function expected(p, bb0, bb1) {
  if (!bb0 || !bb1) return p;
  const out = [];
  for (let k = 0; k < 3; k++) {
    const s0 = bb0.max[k] - bb0.min[k], s1 = bb1.max[k] - bb1.min[k];
    out.push(bb1.min[k] + (s0 > opt('geomEpsTiny') ? (p[k] - bb0.min[k]) / s0 : 0.5) * s1);
  }
  return out;
}

// second guess: same distance from the nearest side of the bounding box (a 5 mm rim stays 5 mm when the part grows)
function anchored(p, bb0, bb1) {
  if (!bb0 || !bb1) return p;
  return [0, 1, 2].map((k) => { const lo = p[k] - bb0.min[k], hi = bb0.max[k] - p[k]; return lo <= hi ? bb1.min[k] + lo : bb1.max[k] - hi; });
}
const near3 = (q, p, bb0, bb1) => Math.min(len(sub(q, p)), len(sub(q, expected(p, bb0, bb1))), len(sub(q, anchored(p, bb0, bb1))));

// circle through 3 points in 3D → {c, r, n}
function circle3pts(a, b, c) {
  const ab = sub(b, a), ac = sub(c, a);
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const nn = dot(n, n); if (nn < opt('linkCircleDegenEps')) return null;
  const t1 = [n[1] * ab[2] - n[2] * ab[1], n[2] * ab[0] - n[0] * ab[2], n[0] * ab[1] - n[1] * ab[0]]; // n × ab
  const t2 = [ac[1] * n[2] - ac[2] * n[1], ac[2] * n[0] - ac[0] * n[2], ac[0] * n[1] - ac[1] * n[0]]; // ac × n
  const k1 = dot(ac, ac) / (2 * nn), k2 = dot(ab, ab) / (2 * nn);
  const off = [t1[0] * k1 + t2[0] * k2, t1[1] * k1 + t2[1] * k2, t1[2] * k1 + t2[2] * k2];
  return { c: [a[0] + off[0], a[1] + off[1], a[2] + off[2]], r: len(off), n: nrm(n) };
}

// reference from a displayed (tessellated) model edge {type, pts (flat xyz), mid} — used by Convert Entities
export function refFromMeshEdge(e, bb) {
  const p = e?.pts; if (!p || p.length < 6) return null;
  const P = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], n = p.length / 3;
  const a = P(0), b = P(n - 1);
  if (e.type === 'line') return { type: 'line', a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], bb };
  if (e.type === 'circle' && n >= 3) {
    const c = circle3pts(a, P(Math.floor(n / 3)), P(Math.floor((2 * n) / 3))); if (!c) return null;
    return { type: 'circle', a, b, mid: e.mid || P(Math.floor(n / 2)), c: c.c, r: c.r, n: c.n, closed: len(sub(a, b)) < opt('geomEps') * Math.max(1, c.r), bb };
  }
  return null;
}
// reference from an exact kernel edge (edgeInfo)
export function refFromEdge(e, bb) {
  if (e.type === 'line') return { type: 'line', a: e.a, b: e.b, mid: e.mid, bb };
  if (e.type === 'circle') return { type: 'circle', a: e.a, b: e.b, mid: e.mid, c: e.c, r: e.r, n: e.n, closed: !!e.closed, bb };
  return null;
}

// unique edge end points = model corners
export function vertices(base) {
  const out = [];
  for (const e of base.edges || []) for (const p of [e.a, e.b]) if (p && !out.some((q) => len(sub(p, q)) < opt('linkPointMergeTol'))) out.push(p);
  return out;
}

// find the referenced edge (or corner) on the new body; null when nothing is close enough
export function matchRef(ref, base, tolPct = opt('linkTolPct')) {
  if (!ref || !base) return null;
  const bb = base.bbox, tol = Math.max(opt('linkTolMin'), (bbDiag(bb) * tolPct) / 100);
  if (ref.type === 'vertex') {
    let best = null, bd = Infinity;
    for (const v of vertices(base)) { const d = near3(v, ref.p, ref.bb, bb); if (d < bd) { bd = d; best = v; } }
    return best && bd <= tol ? { type: 'vertex', p: best } : null;
  }
  let best = null, bd = Infinity;
  if (ref.type === 'line') {
    const dir = nrm(sub(ref.b, ref.a)), L0 = len(sub(ref.b, ref.a));
    const exA = expected(ref.a, ref.bb, bb), exB = expected(ref.b, ref.bb, bb), Lx = len(sub(exB, exA));
    for (const e of base.edges || []) {
      if (e.type !== 'line') continue;
      const L = len(sub(e.b, e.a)); if (L < opt('geomEpsTiny')) continue;
      if (Math.abs(dot(nrm(sub(e.b, e.a)), dir)) < opt('linkDirDot')) continue;
      const d = near3(e.mid, ref.mid, ref.bb, bb) + opt('linkScoreWeight') * Math.min(Math.abs(L - L0), Math.abs(L - Lx));
      if (d < bd) { bd = d; best = e; }
    }
  } else if (ref.type === 'circle') {

    for (const e of base.edges || []) {
      if (e.type !== 'circle' || !e.c || !!e.closed !== !!ref.closed) continue;
      if (ref.n && e.n && Math.abs(dot(ref.n, e.n)) < opt('linkDirDot')) continue;
      let d = near3(e.c, ref.c, ref.bb, bb) + opt('linkScoreWeight') * Math.abs(e.r - ref.r);
      if (!ref.closed) d += opt('linkScoreWeight') * near3(e.mid, ref.mid, ref.bb, bb); // arcs: also the right piece
      if (d < bd) { bd = d; best = e; }
    }
  }
  return best && bd <= tol ? best : null;
}

// Move linked geometry of sketch `sk` (in place) onto its edges. fr = the sketch's frame for this rebuild.
// Returns {linked, moved, missing: [geo ids]}; the caller solves the sketch afterwards.
export function applyLinks(sk, base, fr, tolPct = opt('linkTolPct')) {
  const G = new Map(sk.geo.map((g) => [g.id, g]));
  const out = { linked: 0, moved: 0, missing: [] };
  const setP = (id, q) => { const p = G.get(id); if (!p) return; if (d2([p.x, p.y], q) > opt('geomEpsTiny')) out.moved++; p.x = q[0]; p.y = q[1]; };
  const pair = (i1, i2, A, B) => { // keep the end points' order: each takes the nearer end
    const p = G.get(i1), q = G.get(i2); if (!p || !q) return;
    const keep = d2([p.x, p.y], A) + d2([q.x, q.y], B) <= d2([p.x, p.y], B) + d2([q.x, q.y], A);
    setP(i1, keep ? A : B); setP(i2, keep ? B : A);
  };
  const live = new Set((sk.cons || []).filter((c) => c.type === 'fix' && c.onEdge).map((c) => c.e)); // On Edge relation deleted → link gone
  for (const g of sk.geo) {
    const ref = g.onEdge; if (!ref) continue;
    if (!live.has(g.id)) { delete g.onEdge; continue; }
    out.linked++;
    const e = matchRef(ref, base, tolPct);
    if (!e) { out.missing.push(g.id); continue; }
    if (ref.type === 'vertex') { setP(g.id, loc2(fr, e.p)); g.onEdge = { ...ref, p: e.p, bb: base.bbox }; continue; }
    if (g.type === 'line' && e.type === 'line') {
      let ea = e.a, eb = e.b;
      const xa = expected(ref.a, ref.bb, base.bbox), xb = expected(ref.b, ref.bb, base.bbox);
      if (len(sub(ea, xa)) + len(sub(eb, xb)) > len(sub(ea, xb)) + len(sub(eb, xa))) [ea, eb] = [eb, ea];
      let A = ea, B = eb;
      if (ref.cut) { // a piece of the edge: same distances from the edge's ends as before
        const u = nrm(sub(eb, ea)), L = len(sub(eb, ea));
        if (L - ref.cut[0] - ref.cut[1] > opt('geomEps')) { A = [ea[0] + u[0] * ref.cut[0], ea[1] + u[1] * ref.cut[0], ea[2] + u[2] * ref.cut[0]]; B = [eb[0] - u[0] * ref.cut[1], eb[1] - u[1] * ref.cut[1], eb[2] - u[2] * ref.cut[1]]; }
      }
      pair(g.p1, g.p2, loc2(fr, A), loc2(fr, B));
      g.onEdge = { ...refFromEdge({ ...e, a: ea, b: eb }, base.bbox), ...(ref.cut ? { cut: ref.cut } : {}) };
      continue;
    }
    else if ((g.type === 'circle' || g.type === 'arc') && e.type === 'circle') {
      setP(g.c, loc2(fr, e.c));
      if (Math.abs(g.r - e.r) > opt('geomEpsTiny')) out.moved++;
      g.r = e.r;
      if (g.type === 'arc') pair(g.s, g.e, loc2(fr, e.a), loc2(fr, e.b));
    } else { out.missing.push(g.id); continue; }
    g.onEdge = { ...refFromEdge(e, base.bbox) };
  }
  return out;
}

// Older parts: fixed converted geometry that lies exactly on a model edge (line on line, circle / arc on circle,
// fixed point on a corner) gets linked. Returns the number of new links.
export function autoLink(sk, base, fr) {
  const G = new Map(sk.geo.map((g) => [g.id, g])), P = (id) => { const p = G.get(id); return p ? [p.x, p.y] : null; };
  const eps = Math.max(opt('linkOnEdgeMin'), bbDiag(base.bbox) * opt('linkOnEdgeRel'));
  const off = (p3) => Math.abs(dot(sub(p3, fr.o), fr.n)); // distance of a model point from the sketch plane
  const corners = vertices(base);
  let n = 0;
  for (const c of sk.cons || []) {
    if (c.type !== 'fix' || c.onEdge || c.xref) continue;
    const g = G.get(c.e); if (!g || g.onEdge || g.xref || g.origin) continue;
    let ref = null;
    if (g.type === 'line') {
      const A = P(g.p1), B = P(g.p2); if (!A || !B) continue;
      for (const e of base.edges) {
        if (e.type !== 'line') continue;
        const a = loc2(fr, e.a), b = loc2(fr, e.b);
        if ((d2(A, a) < eps && d2(B, b) < eps) || (d2(A, b) < eps && d2(B, a) < eps)) { if (off(e.a) < eps && off(e.b) < eps) { ref = refFromEdge(e, base.bbox); break; } if (!ref) ref = refFromEdge(e, base.bbox); }
      }
      // a piece of an edge (e.g. converted from a later, filleted model): both ends on the edge, in the sketch plane
      if (!ref) for (const e of base.edges) {
        if (e.type !== 'line' || off(e.a) > eps || off(e.b) > eps) continue;
        const a = loc2(fr, e.a), b = loc2(fr, e.b), L = d2(a, b); if (L < opt('geomEps')) continue;
        const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
        const t = (q) => (q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1], dl = (q) => Math.abs((q[0] - a[0]) * u[1] - (q[1] - a[1]) * u[0]);
        if (dl(A) > eps || dl(B) > eps) continue;
        const tA = t(A), tB = t(B), lo = Math.min(tA, tB), hi = Math.max(tA, tB);
        if (lo < -eps || hi > L + eps || hi - lo < opt('geomEps')) continue;
        ref = { ...refFromEdge(e, base.bbox), cut: [Math.max(0, lo), Math.max(0, L - hi)] }; break;
      }
    } else if (g.type === 'circle' || g.type === 'arc') {
      const C = P(g.c); if (!C) continue;
      for (const e of base.edges) {
        if (e.type !== 'circle' || !e.c || Math.abs(e.r - g.r) > eps || d2(loc2(fr, e.c), C) > eps) continue;
        if (g.type === 'circle' && !e.closed) continue;
        if (g.type === 'arc') {
          if (e.closed) continue;
          const S = P(g.s), E = P(g.e), a = loc2(fr, e.a), b = loc2(fr, e.b);
          if (!((d2(S, a) < eps && d2(E, b) < eps) || (d2(S, b) < eps && d2(E, a) < eps))) continue;
        }
        ref = refFromEdge(e, base.bbox); break;
      }
    } else if (g.type === 'point') {
      const Q = [g.x, g.y];
      const v = corners.find((p) => d2(loc2(fr, p), Q) < eps && off(p) < eps);
      if (v) ref = { type: 'vertex', p: v, bb: base.bbox };
    }
    if (!ref) continue;
    g.onEdge = ref; c.onEdge = true; n++;
  }
  return n;
}

export const hasLinks = (sk) => sk?.type === 'sketch' && (sk.geo || []).some((g) => g.onEdge);
export const hasFixed = (sk) => sk?.type === 'sketch' && (sk.cons || []).some((c) => c.type === 'fix' && !c.onEdge && !c.xref);
export const hasXrefs = (sk) => sk?.type === 'sketch' && (sk.geo || []).some((g) => g.xref);

// ---------- In-context references (0.1.132) ----------
// Geometry converted from an edge / corner of ANOTHER component while the part is edited in an assembly keeps
// `g.xref = {asm, comp, compName, file, ref}`; ref = the edge in that component's own part frame (same form as onEdge).
// Its Fix relation has `xref: true` (not onEdge), so the part's own On Edge links and older versions leave it alone.
// bases: Map comp id → {edges (line / circle refs in the other part's frame), bbox, m (16, column-major: other part → this part)}
export const xfPoint = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
// a part's displayed edges as match candidates (same form as the kernel's linkBase edges)
export function xrefBase(mesh, m) {
  const bbox = mesh?.bbox;
  return { bbox, m, edges: (mesh?.edges || []).map((e) => refFromMeshEdge(e, bbox)).filter(Boolean) };
}
export function applyXrefs(sk, bases, fr, tolPct = opt('linkTolPct')) {
  const G = new Map(sk.geo.map((g) => [g.id, g]));
  const out = { linked: 0, moved: 0, missing: [], outside: [], comps: new Set() };
  const setP = (id, q) => { const p = G.get(id); if (!p) return; if (d2([p.x, p.y], q) > opt('geomEpsTiny')) out.moved++; p.x = q[0]; p.y = q[1]; };
  const pair = (i1, i2, A, B) => {
    const p = G.get(i1), q = G.get(i2); if (!p || !q) return;
    const keep = d2([p.x, p.y], A) + d2([q.x, q.y], B) <= d2([p.x, p.y], B) + d2([q.x, q.y], A);
    setP(i1, keep ? A : B); setP(i2, keep ? B : A);
  };
  const live = new Set((sk.cons || []).filter((c) => c.type === 'fix' && c.xref).map((c) => c.e)); // Fix deleted → reference gone
  for (const g of sk.geo) {
    const x = g.xref; if (!x) continue;
    if (!live.has(g.id)) { delete g.xref; continue; }
    out.linked++;
    const B = bases?.get(x.comp, x);
    if (!B) { out.outside.push(g.id); continue; } // component not in this context: stays where it is
    const ref = x.ref, e = matchRef(ref, B, tolPct);
    if (!e) { out.missing.push(g.id); continue; }
    out.comps.add(x.comp);
    const T = (p) => loc2(fr, xfPoint(B.m, p));
    if (ref.type === 'vertex') { setP(g.id, T(e.p)); x.ref = { ...ref, p: e.p, bb: B.bbox }; continue; }
    if (g.type === 'line' && e.type === 'line') {
      let ea = e.a, eb = e.b;
      const xa = expected(ref.a, ref.bb, B.bbox), xb = expected(ref.b, ref.bb, B.bbox);
      if (len(sub(ea, xa)) + len(sub(eb, xb)) > len(sub(ea, xb)) + len(sub(eb, xa))) [ea, eb] = [eb, ea];
      let A = ea, Bp = eb;
      if (ref.cut) {
        const u = nrm(sub(eb, ea)), L = len(sub(eb, ea));
        if (L - ref.cut[0] - ref.cut[1] > opt('geomEps')) { A = [ea[0] + u[0] * ref.cut[0], ea[1] + u[1] * ref.cut[0], ea[2] + u[2] * ref.cut[0]]; Bp = [eb[0] - u[0] * ref.cut[1], eb[1] - u[1] * ref.cut[1], eb[2] - u[2] * ref.cut[1]]; }
      }
      pair(g.p1, g.p2, T(A), T(Bp));
      x.ref = { ...refFromEdge({ ...e, a: ea, b: eb }, B.bbox), ...(ref.cut ? { cut: ref.cut } : {}) };
      continue;
    }
    if ((g.type === 'circle' || g.type === 'arc') && e.type === 'circle') {
      setP(g.c, T(e.c));
      if (Math.abs(g.r - e.r) > opt('geomEpsTiny')) out.moved++;
      g.r = e.r;
      if (g.type === 'arc') pair(g.s, g.e, T(e.a), T(e.b));
      x.ref = refFromEdge(e, B.bbox);
      continue;
    }
    out.missing.push(g.id);
  }
  return out;
}
// geometry ids that a sketch's links hold (own On Edge + in-context references)
export const linkedIds = (sk) => { const s = new Set(); for (const g of sk.geo) if (g.onEdge || g.xref) [g.id, g.p1, g.p2, g.c, g.s, g.e].forEach((id) => id && s.add(id)); return s; };

export function frameOfPlane(pl) {
  const n = nrm(pl.normal), x = nrm(pl.xDir);
  return { o: pl.origin, n, x, y: [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]] };
}

// Walk the feature list in order and bring every sketch with linked geometry up to date (in place). `getBase(features, i)`
// returns the kernel's linkBase for sketch i (async), `solve(sk)` solves a sketch. With `auto`, fixed geometry of
// older parts that lies on a model edge is linked first. `stopAt` = only sketches before this index.
// Returns {changed, linkedNow: [{name, n}], warn: Map(sketch id → text)}.
export async function relinkChain(features, { upTo = features.length, stopAt = Infinity, getBase, solve, tolPct = opt('linkTolPct'), auto = false } = {}) {
  const res = { changed: false, linkedNow: [], warn: new Map() };
  for (let i = 0; i < features.length && i < upTo && i < stopAt; i++) {
    const f = features[i];
    if (f.type !== 'sketch' || f.suppressed) continue;
    const want = hasLinks(f) || (auto && hasFixed(f));
    if (!want) continue;
    let base;
    try { base = await getBase(features, i); } catch { base = null; }
    if (!base?.edges?.length) continue; // first sketch / nothing to link to
    const fr = frameOfPlane(base.plane || f.plane);
    const sk = JSON.parse(JSON.stringify(f));
    if (auto) { const n = autoLink(sk, base, fr); if (n) res.linkedNow.push({ name: f.name, n }); }
    if (!hasLinks(sk)) { if (JSON.stringify(sk) !== JSON.stringify(f)) { features[i] = Object.assign(f, sk); res.changed = true; } continue; }
    const before = JSON.parse(JSON.stringify(sk.geo));
    const r = applyLinks(sk, base, fr, tolPct);
    if (r.missing.length) res.warn.set(f.id, `${r.missing.length} linked edge${r.missing.length > 1 ? 's' : ''} not found on the model - kept at the last position`);
    if (r.moved) {
      const s = followLinks(sk, before, solve);
      if (s && s.ok === false) { res.warn.set(f.id, 'The sketch cannot follow its linked edges (relations or dimensions conflict) - kept at the last position'); continue; }
    }
    if (JSON.stringify(sk) !== JSON.stringify(f)) { Object.assign(f, sk); res.changed = true; }
  }
  return res;
}

// Solve a sketch whose linked geometry moved from `before` (geo list) to where it is now. Big moves go in steps with a
// prediction (each free point / radius first moves by its speed of the previous step, then the sketch is solved), so
// small offsets (a 7 mm distance to a linked line) don't flip to the other side.
export function followLinks(sk, before, solve, maxStep = opt('sizeStepPct') / 100) {
  const target = sk.geo.map((g) => (g.type === 'point' ? [g.x, g.y] : g.r !== undefined ? [g.r] : null));
  const start = before.map((g) => (g.type === 'point' ? [g.x, g.y] : g.r !== undefined ? [g.r] : null));
  const linked = linkedIds(sk);
  let move = 0, size = 1;
  const pts = sk.geo.filter((g) => g.type === 'point');
  if (pts.length) { const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y); size = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); }
  sk.geo.forEach((g, i) => { if (linked.has(g.id) && start[i] && target[i]) move = Math.max(move, ...target[i].map((v, k) => Math.abs(v - start[i][k]))); });
  const n = Math.min(opt('driveMaxSteps'), Math.max(1, Math.ceil(move / (maxStep * size))));
  if (n === 1) return solve(sk);
  const set = (S, only) => sk.geo.forEach((g, i) => { if (!S[i] || (only && !only(g))) return; if (g.type === 'point') { g.x = S[i][0]; g.y = S[i][1]; } else g.r = S[i][0]; });
  const lerp = (t) => start.map((a, i) => (a && target[i] ? a.map((v, k) => v + (target[i][k] - v) * t) : a));
  const state = () => sk.geo.map((g) => (g.type === 'point' ? [g.x, g.y] : g.r !== undefined ? [g.r] : null));
  set(start); // back to the old position, then walk
  let X = state(), V = null, r = null, tPrev = 0;
  const steps = [opt('driveProbeFrac') / n, ...Array.from({ length: n }, (_, k) => (k + 1) / n)];
  for (const t of steps) {
    const dt = t - tPrev;
    if (V) set(X.map((a, i) => (a && V[i] ? a.map((v, k) => v + V[i][k] * dt) : a)), (g) => !linked.has(g.id)); // prediction
    set(lerp(t), (g) => linked.has(g.id));
    r = solve(sk);
    if (!r || r.ok === false) return r;
    const Y = state(); V = X.map((a, i) => (a && Y[i] ? a.map((v, k) => (Y[i][k] - v) / dt) : null)); X = Y; tPrev = t;
  }
  return r;
}
