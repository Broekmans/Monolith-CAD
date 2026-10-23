// Geometry kernel built on OpenCascade (opencascade.js / WebAssembly).
// Rebuilds parametric part features into a B-rep body, tessellates it for
// display (mesh.mjs) and handles STEP / IGES exchange (exchange.mjs). Shared helpers: core.mjs.

import { sketchCurves, findRegions, arcSweep } from '../shared/profile.mjs';
import { oc, PR, add, sub, mul, dot, len, norm, planeFrame, to3, P, V, Dir, ptArr, checkValid, unify, transformed, bbox, diag, listEdges, planeOfFace, listFaces, shapeMap, edgeFaces, polygonWire, compoundOf, errText, runBool } from './core.mjs';
import { readStepText } from './exchange.mjs';
import { faceOwners } from './mesh.mjs';
import { factoryOf } from '../renderer/src/app/options/index.js';
export * from './core.mjs';
export * from './mesh.mjs';
export * from './exchange.mjs';

// ---------- profile -> OCC faces ----------
function edgeFromCurve(fr, s) {
  const c = s.cur;
  if (c.kind === 'line') {
    const a = to3(fr, s.reversed ? c.b : c.a), b = to3(fr, s.reversed ? c.a : c.b);
    return new oc.BRepBuilderAPI_MakeEdge(P(a), P(b)).Edge();
  }
  if (c.kind === 'circle') {
    const circ = new oc.gp_Circ(new oc.gp_Ax2(P(to3(fr, c.c)), Dir(fr.n)), c.r);
    return new oc.BRepBuilderAPI_MakeEdge(circ).Edge();
  }
  // arc: build through three points so orientation follows traversal
  const sw = arcSweep(c);
  const mid = c.a0 + sw / 2;
  const pm = [c.c[0] + c.r * Math.cos(mid), c.c[1] + c.r * Math.sin(mid)];
  const pa = s.reversed ? c.b : c.a, pb = s.reversed ? c.a : c.b;
  const mk = new oc.GC_MakeArcOfCircle(P(to3(fr, pa)), P(to3(fr, pm)), P(to3(fr, pb)));
  return new oc.BRepBuilderAPI_MakeEdge(mk.Value()).Edge();
}

// Closed outline (e.g. text glyph) -> wire of straight edges at sharp
// corners / straight segments and smooth B-spline edges along curved runs.
// Every fitted spline is checked against its points; if it overshoots, the
// run falls back to straight segments, so the profile can never "explode".
function smoothWire(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const segLen = (i) => len(sub(pts[(i + 1) % n], pts[i]));
  const turn = (i) => {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const u = norm(sub(b, a)), v = norm(sub(c, b));
    return Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  };
  // a vertex breaks a run at a sharp corner, or where a long straight segment
  // meets a densely sampled curve (very different neighbouring lengths)
  const brk = pts.map((_, i) => {
    const l0 = segLen((i - 1 + n) % n), l1 = segLen(i);
    const ratio = Math.max(l0, l1) / Math.max(1e-12, Math.min(l0, l1));
    return turn(i) > 0.45 || ratio > 3;
  });
  let starts = brk.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) starts = [0, Math.floor(n / 3), Math.floor((2 * n) / 3)];
  const verts = new Map();
  const V = (i) => { if (!verts.has(i)) verts.set(i, new oc.BRepBuilderAPI_MakeVertex(P(pts[i])).Vertex()); return verts.get(i); };
  const mw = new oc.BRepBuilderAPI_MakeWire();
  const straight = (run) => { for (let j = 1; j < run.length; j++) mw.Add(new oc.BRepBuilderAPI_MakeEdge(V(run[j - 1]), V(run[j])).Edge()); };
  for (let k = 0; k < starts.length; k++) {
    const i0 = starts[k], i1 = starts[(k + 1) % starts.length];
    const run = [i0];
    for (let i = (i0 + 1) % n; ; i = (i + 1) % n) { run.push(i); if (i === i1 || run.length > n) break; }
    if (run.length <= 3) { straight(run); continue; }
    // bounding box of the run's points (with a small margin) for the overshoot check
    const P3 = run.map((i) => pts[i]);
    const mn = [0, 1, 2].map((d) => Math.min(...P3.map((q) => q[d]))), mx = [0, 1, 2].map((d) => Math.max(...P3.map((q) => q[d])));
    let chord = 0; for (let j = 1; j < P3.length; j++) chord += len(sub(P3[j], P3[j - 1]));
    const margin = chord * 0.03 + 1e-6;
    let ok = false;
    try {
      const arr = new oc.NCollection_Array1_gp_Pnt(1, run.length);
      P3.forEach((q, j) => arr.SetValue(j + 1, P(q)));
      const fit = new oc.GeomAPI_PointsToBSpline(arr, 2, 5, oc.GeomAbs_Shape.GeomAbs_C1, chord * 1e-4);
      if (fit.IsDone()) {
        const hc = fit.Curve();
        const c = hc;
        const f = c.FirstParameter(), l = c.LastParameter();
        ok = true;
        for (let s2 = 0; s2 <= 48 && ok; s2++) {
          const q = ptArr(c.Value(f + ((l - f) * s2) / 48));
          for (let d = 0; d < 3; d++) if (q[d] < mn[d] - margin || q[d] > mx[d] + margin) { ok = false; break; }
        }
        if (ok) {
          const me = new oc.BRepBuilderAPI_MakeEdge(c, V(run[0]), V(run[run.length - 1]));
          if (me.IsDone()) mw.Add(me.Edge()); else ok = false;
        }
      }
    } catch { ok = false; }
    if (!ok) straight(run);
  }
  if (!mw.IsDone()) return null;
  return mw.Wire();
}

// Glyph curve (Bezier control points, 3D) -> chain of lines and 3-point arcs, each within `tol` of the curve
// (0.1.108: planes and cylinders cut 3-4x faster than Bezier faces, and every later feature on the body too).
function bezPt(c, t) {
  let q = c;
  while (q.length > 1) { const nx = []; for (let i = 0; i < q.length - 1; i++) nx.push(add(mul(q[i], 1 - t), mul(q[i + 1], t))); q = nx; }
  return q[0];
}
const cross3 = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const ARC_CHECK = Array.from({ length: 15 }, (_, i) => (i + 1) / 16).filter((f) => f !== 0.5);
export function bezierArcs(c, tol, maxSplit = factoryOf('skTextArcMaxSplit'), t0 = 0, t1 = 1, depth = 0) {
  const a = bezPt(c, t0), b = bezPt(c, t1), m = bezPt(c, (t0 + t1) / 2);
  const within = (dev) => ARC_CHECK.every((f) => dev(bezPt(c, t0 + (t1 - t0) * f)) <= tol);
  const ab = sub(b, a), L = len(ab);
  // distance to the line piece a-b (beyond its ends: to the nearest end)
  const lineDev = (p) => { const t = dot(sub(p, a), ab) / (L * L || 1e-24); return t < 0 || t > 1 ? Math.min(len(sub(p, a)), len(sub(p, b))) : len(cross3(sub(p, a), ab)) / (L || 1e-12); };
  if (L > 1e-12 && lineDev(m) <= tol && within(lineDev)) return [{ a, b, m: null }];
  const am = sub(m, a), n = cross3(ab, am), n2 = dot(n, n);
  if (n2 > 1e-24) {
    const ctr = add(a, mul(add(mul(cross3(n, ab), dot(am, am)), mul(cross3(am, n), dot(ab, ab))), 1 / (2 * n2)));
    const r = len(sub(a, ctr));
    // on the arc piece (same side of the chord as m) and near the circle
    const side = (p) => dot(cross3(ab, sub(p, a)), n);
    if (depth >= maxSplit || within((p) => (side(p) * n2 < -1e-12 * n2 ? Infinity : Math.abs(len(sub(p, ctr)) - r)))) return [{ a, b, m }];
  } else if (depth >= maxSplit) return [{ a, b, m: null }];
  const tm = (t0 + t1) / 2;
  return [...bezierArcs(c, tol, maxSplit, t0, tm, depth + 1), ...bezierArcs(c, tol, maxSplit, tm, t1, depth + 1)];
}

// Glyph contour: straight edges and (tol > 0) arcs / (tol 0) exact Bezier edges, sharing vertices.
function bezierWire(segs, tol = 0) {
  const verts = [];
  const vertexAt = (p) => {
    for (const v of verts) if (Math.abs(v.p[0] - p[0]) < 1e-7 && Math.abs(v.p[1] - p[1]) < 1e-7 && Math.abs(v.p[2] - p[2]) < 1e-7) return v.v;
    const v = new oc.BRepBuilderAPI_MakeVertex(P(p)).Vertex();
    verts.push({ p, v });
    return v;
  };
  const mw = new oc.BRepBuilderAPI_MakeWire();
  for (const seg of segs) {
    const v0 = vertexAt(seg[0]), v1 = vertexAt(seg[seg.length - 1]);
    if (seg.length === 2) { mw.Add(new oc.BRepBuilderAPI_MakeEdge(v0, v1).Edge()); continue; }
    if (tol > 0) {
      const parts = bezierArcs(seg, tol);
      let prev = v0;
      for (let k = 0; k < parts.length; k++) {
        const pc = parts[k], vb = k === parts.length - 1 ? v1 : vertexAt(pc.b);
        if (!pc.m) { mw.Add(new oc.BRepBuilderAPI_MakeEdge(prev, vb).Edge()); prev = vb; continue; }
        const arc = new oc.GC_MakeArcOfCircle(P(pc.a), P(pc.m), P(pc.b));
        const me = new oc.BRepBuilderAPI_MakeEdge(arc.Value(), prev, vb);
        if (!me.IsDone()) return null;
        mw.Add(me.Edge()); prev = vb;
      }
      continue;
    }
    const arr = new oc.NCollection_Array1_gp_Pnt(1, seg.length);
    seg.forEach((q, j) => arr.SetValue(j + 1, P(q)));
    const bz = new oc.Geom_BezierCurve(arr);
    const me = new oc.BRepBuilderAPI_MakeEdge(bz, v0, v1);
    if (!me.IsDone()) return null;
    mw.Add(me.Edge());
  }
  return mw.IsDone() ? mw.Wire() : null;
}

function wireFromLoop(fr, loop) {
  const lc = loop.curves.length === 1 ? loop.curves[0].cur : null;
  if (lc && lc.kind === 'poly' && lc.segs && !globalThis.__noSmooth) {
    try { const w = bezierWire(lc.segs.map((seg) => seg.map((q) => to3(fr, q))), lc.tol ?? factoryOf('skTextArcTol')); if (w) return w; } catch { /* fall back */ }
  }
  if (loop.curves.length === 1 && loop.curves[0].cur.kind === 'poly') {
    const pts = loop.curves[0].cur.pts.map((q) => to3(fr, q));
    let wire = null;
    if (!globalThis.__noSmooth) { try { wire = smoothWire(pts); } catch { wire = null; } }
    if (wire) return wire;
    return polygonWire(pts);
  }
  const mw = new oc.BRepBuilderAPI_MakeWire();
  for (const s of loop.curves) mw.Add(edgeFromCurve(fr, s));
  if (!mw.IsDone()) throw new Error('Could not build a closed wire from the sketch');
  return mw.Wire();
}

// Planar face of a region: outer loop with its holes (no booleans needed).
function regionFace(fr, region) {
  const mf = new oc.BRepBuilderAPI_MakeFace(wireFromLoop(fr, region.outer), true);
  if (!mf.IsDone()) throw new Error('Could not build a face from the sketch');
  let face = mf.Face();
  if (!region.holes.length) return face;
  for (const h of region.holes) {
    const w = wireFromLoop(fr, h);
    const add = new oc.BRepBuilderAPI_MakeFace(face, w);
    if (!add.IsDone()) throw new Error('Could not add a hole to the sketch face');
    face = add.Face();
  }
  const fix = new oc.ShapeFix_Face(face);
  fix.FixOrientation();
  fix.Perform();
  return oc.TopoDS.Face(fix.Face());
}

function faceFromLoop(fr, loop) {
  if (loop.curves.length === 1 && loop.curves[0].cur.kind === 'poly') {
    const pts = loop.curves[0].cur.pts.map((q) => to3(fr, q));
    let wire = null;
    try { wire = smoothWire(pts); } catch { wire = null; }
    if (!wire) {
      wire = polygonWire(pts);
    }
    const mf = new oc.BRepBuilderAPI_MakeFace(wire, true);
    if (!mf.IsDone()) throw new Error('Could not build a face from the sketch text');
    return mf.Face();
  }
  const mw = new oc.BRepBuilderAPI_MakeWire();
  for (const s of loop.curves) mw.Add(edgeFromCurve(fr, s));
  if (!mw.IsDone()) throw new Error('Could not build a closed wire from the sketch');
  const mf = new oc.BRepBuilderAPI_MakeFace(mw.Wire(), true);
  if (!mf.IsDone()) throw new Error('Could not build a face from the sketch');
  return mf.Face();
}

function sketchRegions(sk) {
  const curves = sketchCurves(sk);
  const { regions, openIds } = findRegions(curves);
  if (!regions.length) {
    throw new Error(openIds.length ? 'Sketch has open contours - close the profile' : 'Sketch contains no closed profile');
  }
  return regions;
}

// Build a solid per region from a face->solid function, subtracting holes.
function regionSolids(sk, makeSolid) {
  const fr = planeFrame(sk.plane);
  const solids = [];
  for (const r of sketchRegions(sk)) {
    let s;
    try { s = makeSolid(regionFace(fr, r), fr); } catch {
      s = makeSolid(faceFromLoop(fr, r.outer), fr);
      for (const h of r.holes) s = boolCut(s, makeSolid(faceFromLoop(fr, h), fr));
    }
    solids.push(s);
  }
  if (solids.length === 1) return solids[0];
  // few regions (e.g. a profile + its mirror sharing an edge): fuse so touching regions become one solid
  if (solids.length <= 12) {
    try { let u = solids[0]; for (let i = 1; i < solids.length; i++) u = boolFuse(u, solids[i]); return u; } catch { /* fall back to a compound */ }
  }
  // Regions of one sketch never overlap, so a compound is a valid tool body
  // (much faster than fusing them one by one, e.g. for sketch text).
  return compoundOf(solids);
}

// ---------- booleans / transforms ----------
function boolFuse(a, b) {
  const op = runBool('BRepAlgoAPI_Fuse', a, b);
  if (!op.IsDone()) throw new Error('Boolean union failed');
  return unify(op.Shape());
}
function boolCut(a, b) {
  const op = runBool('BRepAlgoAPI_Cut', a, b);
  if (!op.IsDone()) throw new Error('Boolean cut failed');
  return unify(op.Shape());
}
// feature preview of a cut: only the volume really removed from the body (not the whole Through All tool)
export function removedVolume(body, tool) { return boolCommon(body, tool); }
function boolCommon(a, b) {
  const op = runBool('BRepAlgoAPI_Common', a, b);
  if (!op.IsDone()) throw new Error('Boolean intersect failed');
  return unify(op.Shape());
}
// Topology references are stored as geometric signatures (midpoint/centroid,
// direction, and position relative to the body's bounding box) and matched
// to the rebuilt shape, so they survive upstream dimension changes.
function expectedPos(ref, p, bb) {
  if (!ref.bb || !bb) return p;
  const out = [];
  for (let k = 0; k < 3; k++) {
    const span0 = ref.bb.max[k] - ref.bb.min[k], span1 = bb.max[k] - bb.min[k];
    const t = span0 > 1e-9 ? (p[k] - ref.bb.min[k]) / span0 : 0.5;
    out.push(bb.min[k] + t * span1);
  }
  return out;
}
// second guess (0.1.83): same distance from the nearest side of the bounding box (a 5 mm rim stays 5 mm when the part grows)
function anchoredPos(ref, p, bb) {
  if (!ref.bb || !bb) return p;
  const out = [];
  for (let k = 0; k < 3; k++) {
    const lo = p[k] - ref.bb.min[k], hi = ref.bb.max[k] - p[k];
    out.push(lo <= hi ? bb.min[k] + lo : bb.max[k] - hi);
  }
  return out;
}
function edgeDir(e) {
  if (e.type !== 'line') return null;
  const a = ptArr(e.adaptor.Value(e.f)), b = ptArr(e.adaptor.Value(e.l));
  return norm(sub(b, a));
}
// Edges with the features that own their faces (`owners` = sorted feature ids joined by '+'), 0.1.83: a fillet / chamfer
// edge on a pocket that moved far (camera slot 43 mm) is found again as the same edge of that pocket's edge group.
function edgeGroups(shape, stages, edges) {
  const own = faceOwners(stages, shape);
  const fmap = shapeMap(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  const ef = edgeFaces(shape);
  for (const e of edges) {
    const keys = new Set();
    try {
      const i = ef.edges.FindIndex(e.edge);
      if (i > 0) for (const f of ef.faces(i)) { const fi = fmap.FindIndex(f); if (fi > 0 && own[fi - 1]) keys.add(own[fi - 1]); }
    } catch { /* no owners */ }
    e.owners = [...keys].sort().join('+');
  }
  return edges;
}
const groupOf = (edges, e) => edges.filter((x) => x.owners === e.owners && x.type === e.type);
const centroid = (list) => mul(list.reduce((a, x) => add(a, x.mid), [0, 0, 0]), 1 / Math.max(1, list.length));
// ctx (optional) = {stages, info: []}: info[k] = the edge group record for ref k ({owners, off, n}) so the renderer can
// store it in the reference; a ref with `grp` that is not found near its old position is looked up in its group.
function matchEdges(shape, refs, ctx = null) {
  const edges = listEdges(shape);
  const bb = bbox(shape);
  const tol = Math.max(0.5, diag(bb) * 0.04);
  const res = [];
  if (ctx) ctx.bb = bb;
  let grouped = false;
  const groups = () => { if (!grouped && ctx?.stages) { edgeGroups(shape, ctx.stages, edges); grouped = true; } return grouped; };
  const record = (k, e) => {
    if (!ctx || !groups()) return;
    const g = groupOf(edges, e);
    ctx.info[k] = { owners: e.owners, off: sub(e.mid, centroid(g)), n: g.length, mid: e.mid, bb: ctx.bb };
  };
  for (let k = 0; k < refs.length; k++) {
    const r = refs[k];
    const exp = expectedPos(r, r.mid, bb), anc = anchoredPos(r, r.mid, bb);
    let best = null, bd = Infinity;
    for (const e of edges) {
      if (r.type && e.type !== r.type) continue;
      if (r.dir && e.type === 'line') { const d = edgeDir(e); if (d && Math.abs(dot(d, r.dir)) < 0.995) continue; }
      const d = Math.min(len(sub(e.mid, r.mid)), len(sub(e.mid, exp)), len(sub(e.mid, anc)));
      if (d < bd) { bd = d; best = e; }
    }
    if ((!best || bd > tol) && r.grp && groups()) { // moved far: the same edge of its group (same owning features)
      const cand = edges.filter((e) => e.owners === r.grp.owners && (!r.type || e.type === r.type));
      if (cand.length) {
        const want = add(centroid(cand), r.grp.off);
        best = null; bd = Infinity;
        for (const e of cand) {
          if (r.dir && e.type === 'line') { const d = edgeDir(e); if (d && Math.abs(dot(d, r.dir)) < 0.995) continue; }
          const d = len(sub(e.mid, want)); if (d < bd) { bd = d; best = e; }
        }
      }
    }
    if (!best || bd > tol) throw new Error('A referenced edge is missing after rebuild - edit the feature and reselect');
    record(k, best); // always: the reference follows the edge from rebuild to rebuild (0.1.89)
    if (!res.includes(best.edge)) res.push(best.edge);
  }
  return res;
}

function matchFaces(shape, refs) {
  const faces = listFaces(shape);
  const bb = bbox(shape);
  const tol = Math.max(0.5, diag(bb) * 0.06);
  const res = [];
  for (const r of refs) {
    const exp = expectedPos(r, r.c, bb), anc = anchoredPos(r, r.c, bb);
    let best = null, bd = Infinity;
    for (const f of faces) {
      if (r.n && (!f.plane || dot(norm(r.n), f.plane.normal) < 0.999)) continue;
      const d = Math.min(len(sub(f.c, r.c)), len(sub(f.c, exp)), len(sub(f.c, anc)));
      if (d < bd) { bd = d; best = f; }
    }
    if (!best || bd > tol) throw new Error('A referenced face is missing after rebuild - edit the feature and reselect');
    res.push(best.face);
  }
  return res;
}

// ---------- feature builders ----------
function axisFromSketchLine(sk, lineId) {
  const g = sk.geo.find((x) => x.id === lineId && x.type === 'line');
  if (!g) throw new Error('Revolve axis line not found in sketch');
  const pts = new Map(sk.geo.filter((x) => x.type === 'point').map((p) => [p.id, p]));
  const a = pts.get(g.p1), b = pts.get(g.p2);
  const fr = planeFrame(sk.plane);
  const A = to3(fr, [a.x, a.y]), B = to3(fr, [b.x, b.y]);
  return { p: A, d: norm(sub(B, A)) };
}

function namedAxis(name) {
  switch (name) {
    case 'X': return { p: [0, 0, 0], d: [1, 0, 0] };
    case 'Y': return { p: [0, 0, 0], d: [0, 1, 0] };
    case 'Z': return { p: [0, 0, 0], d: [0, 0, 1] };
    default: return null;
  }
}

export const STD_PLANES = {
  Front: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  Top: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] },
  Right: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 0, -1] },
};

function resolveAxis(ax, sketches) {
  if (!ax) throw new Error('No axis selected');
  if (typeof ax === 'string') return namedAxis(ax);
  if (ax.sketch) return axisFromSketchLine(sketches.get(ax.sketch), ax.line);
  if (ax.p && ax.d) return { p: ax.p, d: norm(ax.d) };
  throw new Error('Invalid axis');
}

function buildExtrudeTool(f, sk, body) {
  const fr = planeFrame(sk.plane);
  let depth = Number(f.depth) || 10;
  if (f.end === 'throughAll') depth = Math.max(1000, diag(body ? bbox(body) : null) * 3);
  let dir = fr.n;
  if (f.reverse) dir = mul(dir, -1);
  if (f.op === 'cut' && f.end !== 'midplane' && !f.flipCut) {
    // SolidWorks convention: a cut goes into the material by default
    dir = mul(dir, -1);
  }
  let tool = regionSolids(sk, (face) => new oc.BRepPrimAPI_MakePrism(face, V(mul(dir, depth)), false, true).Shape());
  if (f.end === 'midplane') {
    const t = new oc.gp_Trsf();
    t.SetTranslation(V(mul(dir, -depth / 2)));
    tool = transformed(tool, t);
  }
  if (f.end === 'throughAll' && f.op === 'cut' && f.bothSides) {
    const t = new oc.gp_Trsf();
    t.SetTranslation(V(mul(dir, -depth / 2)));
    tool = transformed(tool, t);
  }
  return tool;
}

function buildRevolveTool(f, sk, sketches) {
  const ax = f.axis?.line ? axisFromSketchLine(sk, f.axis.line) : resolveAxis(f.axis, sketches);
  const ang = ((Number(f.angle) || 360) * Math.PI) / 180 * (f.reverse ? -1 : 1);
  const axis = new oc.gp_Ax1(P(ax.p), Dir(ax.d));
  return regionSolids(sk, (face) => {
    if (Math.abs(Math.abs(ang) - 2 * Math.PI) < 1e-9) return new oc.BRepPrimAPI_MakeRevol(face, axis, false).Shape();
    return new oc.BRepPrimAPI_MakeRevol(face, axis, ang, false).Shape();
  });
}

function applyOp(body, tool, op) {
  if (op === 'cut') {
    if (!body) throw new Error('Nothing to cut - create a base feature first');
    return boolCut(body, tool);
  }
  if (op === 'intersect') {
    if (!body) throw new Error('Nothing to intersect');
    return boolCommon(body, tool);
  }
  return body ? boolFuse(body, tool) : tool;
}

// ---------- regeneration with prefix cache ----------
const cache = new Map(); // key -> {body, tools}
function keyFor(features, i) {
  return JSON.stringify(features.slice(0, i + 1));
}

export function regenerate(features, opts = {}) {
  const upTo = opts.upTo ?? features.length;
  const status = [];
  const sketches = new Map();
  const tools = new Map();
  const stages = [];
  let body = null;
  let failed = false;
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (f.type === 'sketch') sketches.set(f.id, f);
    if (i >= upTo) { status.push({ id: f.id, state: 'rolledback' }); continue; }
    if (f.suppressed) { status.push({ id: f.id, state: 'suppressed' }); continue; }
    if (f.type === 'sketch') {
      // sketches placed on a model face follow that face when upstream features change
      if (f.faceRef && body) {
        try {
          const face = matchFaces(body, [f.faceRef])[0];
          const pl = planeOfFace(face);
          if (pl) {
            const moved = { ...f, plane: { ...pl, xDir: f.plane.xDir } };
            sketches.set(f.id, moved);
            status.push({ id: f.id, state: 'ok', plane: moved.plane });
            continue;
          }
        } catch (e) {
          status.push({ id: f.id, state: 'warn', error: 'Sketch face not found - using last known position' });
          continue;
        }
      }
      status.push({ id: f.id, state: 'ok' });
      continue;
    }
    const key = keyFor(features.filter((x, k) => k <= i && (x.type === 'sketch' || (!x.suppressed && k < upTo))), i);
    const hit = cache.get(key);
    if (hit && !failed) {
      body = hit.body;
      if (hit.tool) tools.set(f.id, hit.tool);
      if (body) stages.push({ id: f.id, body });
      status.push({ id: f.id, state: 'ok' });
      continue;
    }
    const refCtx = { stages, info: [] };
    try {
      let tool = null, op = f.op || 'boss';
      switch (f.type) {
        case 'extrude': {
          const sk = sketches.get(f.sketch);
          if (!sk) throw new Error('Sketch not found');
          tool = buildExtrudeTool(f, sk, body);
          body = applyOp(body, tool, op);
          break;
        }
        case 'revolve': {
          const sk = sketches.get(f.sketch);
          if (!sk) throw new Error('Sketch not found');
          tool = buildRevolveTool(f, sk, sketches);
          body = applyOp(body, tool, op);
          break;
        }
        case 'fillet': {
          if (!body) throw new Error('No body to fillet');
          const mk = new oc.BRepFilletAPI_MakeFillet(body, oc.ChFi3d_FilletShape.ChFi3d_Rational);
          for (const e of matchEdges(body, f.edges || [], refCtx)) mk.Add(Number(f.radius), e);
          mk.Build(PR());
          if (!mk.IsDone()) throw new Error('Fillet failed - try a smaller radius');
          body = checkValid(mk.Shape(), 'Fillet');
          break;
        }
        case 'chamfer': {
          if (!body) throw new Error('No body to chamfer');
          const mk = new oc.BRepFilletAPI_MakeChamfer(body);
          for (const e of matchEdges(body, f.edges || [], refCtx)) mk.Add(Number(f.distance), e);
          mk.Build(PR());
          if (!mk.IsDone()) throw new Error('Chamfer failed - try a smaller distance');
          body = checkValid(mk.Shape(), 'Chamfer');
          break;
        }
        case 'shell': {
          if (!body) throw new Error('No body to shell');
          const list = new oc.NCollection_List_TopoDS_Shape();
          for (const fc of matchFaces(body, f.faces || [])) list.Append(fc);
          const mk = new oc.BRepOffsetAPI_MakeThickSolid();
          mk.MakeThickSolidByJoin(body, list, -Math.abs(Number(f.thickness)), 1e-3,
            oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, PR());
          if (!mk.IsDone()) throw new Error('Shell failed - thickness may be too large');
          body = checkValid(mk.Shape(), 'Shell');
          break;
        }
        case 'linearPattern':
        case 'circularPattern':
        case 'mirror': {
          if (!body) throw new Error('No body to pattern');
          const src = (f.features || []).map((id) => {
            const t = tools.get(id);
            if (!t) throw new Error('Pattern seed feature has no geometry');
            return t;
          });
          const copies = [];
          if (f.type === 'linearPattern') {
            const d = resolveAxis(f.direction, sketches).d;
            const dir = f.reverse ? mul(d, -1) : d;
            for (let k = 1; k < (f.count | 0); k++) {
              const t = new oc.gp_Trsf();
              t.SetTranslation(V(mul(dir, Number(f.spacing) * k)));
              copies.push(t);
            }
          } else if (f.type === 'circularPattern') {
            const ax = resolveAxis(f.axis, sketches);
            const n = f.count | 0;
            const total = ((Number(f.angle) || 360) * Math.PI) / 180;
            const step = Math.abs(total - 2 * Math.PI) < 1e-9 ? total / n : total / Math.max(1, n - 1);
            for (let k = 1; k < n; k++) {
              const t = new oc.gp_Trsf();
              t.SetRotation(new oc.gp_Ax1(P(ax.p), Dir(ax.d)), step * k);
              copies.push(t);
            }
          } else {
            const pl = STD_PLANES[f.plane] || f.plane;
            const t = new oc.gp_Trsf();
            t.SetMirror(new oc.gp_Ax2(P(pl.origin), Dir(pl.normal)));
            copies.push(t);
          }
          for (const s of src) for (const t of copies) body = applyOp(body, transformed(s.shape, t), s.op);
          break;
        }
        case 'import': {
          tool = readStepText(f.data, f.format);
          op = 'boss';
          body = applyOp(body, tool, 'boss');
          break;
        }
        default:
          throw new Error(`Unknown feature type ${f.type}`);
      }
      const toolRec = tool ? { shape: tool, op } : null;
      if (toolRec) tools.set(f.id, toolRec);
      if (cache.size > 200) cache.clear();
      cache.set(key, { body, tool: toolRec });
      if (body) stages.push({ id: f.id, body });
      status.push({ id: f.id, state: 'ok', ...(refCtx.info.length ? { refs: refCtx.info } : {}) });
    } catch (err) {
      failed = true;
      status.push({ id: f.id, state: 'error', error: errText(err) });
    }
  }
  return { body, status, stages, tools };
}

// ---------- linked Convert Entities (On Edge) ----------
// Model edges of the body just before sketch `index` (exact geometry: line ends, circle centre / radius / axis) and the
// sketch's resolved plane (it follows its face). The renderer moves linked converted geometry onto these edges.
export function edgeInfo(shape) {
  if (!shape) return [];
  return listEdges(shape).map((e) => {
    const a = ptArr(e.adaptor.Value(e.f)), b = ptArr(e.adaptor.Value(e.l));
    const o = { type: e.type, mid: e.mid, a, b };
    if (e.type === 'circle') {
      try {
        const c = e.adaptor.Circle(), ax = c.Axis().Direction();
        o.c = ptArr(c.Location()); o.r = c.Radius(); o.n = [ax.X(), ax.Y(), ax.Z()]; o.closed = Math.abs(e.l - e.f) > 2 * Math.PI - 1e-6;
      } catch { o.type = 'curve'; }
    }
    return o;
  });
}
export function linkBase(features, index) {
  const r = regenerate(features, { upTo: index + 1 });
  const st = r.status[index];
  return { plane: st?.plane || null, warn: st?.state === 'warn' ? st.error : null, bbox: r.body ? bbox(r.body) : null, edges: edgeInfo(r.body) };
}

// ---------- plan (architecture) model ----------
// Walls are extruded from their footprint; doors/windows cut openings.
export function buildPlanModel(entities) {
  const walls = entities.filter((e) => e.type === 'wall');
  const byId = new Map(entities.map((e) => [e.id, e]));
  // plan (x,y) maps to world (x, z=-y), height along +Y
  const W = (x, y, h) => [x, h, -y];
  let body = null;
  const solids = [];
  const box = (corners2d, z0, z1) => {
    const face = new oc.BRepBuilderAPI_MakeFace(polygonWire(corners2d.map((c) => W(c[0], c[1], z0))), true).Face();
    return new oc.BRepPrimAPI_MakePrism(face, V([0, z1 - z0, 0]), false, true).Shape();
  };
  for (const w of walls) {
    const [ax, ay] = w.a, [bx, by] = w.b;
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const nx = -uy, ny = ux;
    const t = w.t ?? 200, ht = w.h ?? 2700;
    const off = w.justify === 'left' ? t / 2 : w.justify === 'right' ? -t / 2 : 0;
    const e = t / 2; // extend ends so corners close
    const o1 = off - t / 2, o2 = off + t / 2;
    const corners = [
      [ax - ux * e + nx * o1, ay - uy * e + ny * o1],
      [bx + ux * e + nx * o1, by + uy * e + ny * o1],
      [bx + ux * e + nx * o2, by + uy * e + ny * o2],
      [ax - ux * e + nx * o2, ay - uy * e + ny * o2],
    ];
    let s = box(corners, w.base ?? 0, (w.base ?? 0) + ht);
    for (const op of entities.filter((x) => (x.type === 'door' || x.type === 'window') && x.wall === w.id)) {
      const p0 = op.pos - op.w / 2, p1 = op.pos + op.w / 2;
      const z0 = (w.base ?? 0) + (op.type === 'window' ? op.sill ?? 900 : 0);
      const z1 = z0 + (op.h ?? (op.type === 'door' ? 2100 : 1200));
      const big = t;
      const c2 = [
        [ax + ux * p0 + nx * (o1 - big), ay + uy * p0 + ny * (o1 - big)],
        [ax + ux * p1 + nx * (o1 - big), ay + uy * p1 + ny * (o1 - big)],
        [ax + ux * p1 + nx * (o2 + big), ay + uy * p1 + ny * (o2 + big)],
        [ax + ux * p0 + nx * (o2 + big), ay + uy * p0 + ny * (o2 + big)],
      ];
      try { s = boolCut(s, box(c2, z0, z1)); } catch { /* ignore bad opening */ }
    }
    solids.push(s);
  }
  for (const e of entities) {
    if (e.type === 'polyline' && e.closed && e.slab) {
      const th = e.slab;
      const z1 = e.elev ?? 0;
      try { solids.push(box(e.pts, z1 - th, z1)); } catch { /* skip */ }
    }
  }
  void byId;
  for (const s of solids) body = body ? boolFuse(body, s) : s;
  return body;
}
