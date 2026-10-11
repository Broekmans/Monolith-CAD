// Geometry kernel built on OpenCascade (opencascade.js / WebAssembly).
// Rebuilds parametric part features into a B-rep body, tessellates it for
// display, and handles STEP / IGES exchange.

import { sketchCurves, findRegions, arcSweep } from '../shared/profile.mjs';

let oc = null;
const PR = () => new oc.Message_ProgressRange_1();

export const __oc = () => oc;
export async function initKernel(initFn) {
  oc = await initFn();
  return true;
}

// ---------- small vector helpers ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function planeFrame(pl) {
  const n = norm(pl.normal);
  const x = norm(pl.xDir);
  const y = cross(n, x);
  return { o: pl.origin, n, x, y };
}
const to3 = (fr, p) => add(fr.o, add(mul(fr.x, p[0]), mul(fr.y, p[1])));

const P = (p) => new oc.gp_Pnt_3(p[0], p[1], p[2]);
const V = (v) => new oc.gp_Vec_4(v[0], v[1], v[2]);
const Dir = (v) => new oc.gp_Dir_4(v[0], v[1], v[2]);
const ptArr = (p) => [p.X(), p.Y(), p.Z()];

// ---------- profile -> OCC faces ----------
function edgeFromCurve(fr, s) {
  const c = s.cur;
  if (c.kind === 'line') {
    const a = to3(fr, s.reversed ? c.b : c.a), b = to3(fr, s.reversed ? c.a : c.b);
    return new oc.BRepBuilderAPI_MakeEdge_3(P(a), P(b)).Edge();
  }
  if (c.kind === 'circle') {
    const circ = new oc.gp_Circ_2(new oc.gp_Ax2_3(P(to3(fr, c.c)), Dir(fr.n)), c.r);
    return new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  }
  // arc: build through three points so orientation follows traversal
  const sw = arcSweep(c);
  const mid = c.a0 + sw / 2;
  const pm = [c.c[0] + c.r * Math.cos(mid), c.c[1] + c.r * Math.sin(mid)];
  const pa = s.reversed ? c.b : c.a, pb = s.reversed ? c.a : c.b;
  const mk = new oc.GC_MakeArcOfCircle_4(P(to3(fr, pa)), P(to3(fr, pm)), P(to3(fr, pb)));
  const h = new oc.Handle_Geom_Curve_2(mk.Value().get());
  return new oc.BRepBuilderAPI_MakeEdge_24(h).Edge();
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
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  const straight = (run) => { for (let j = 1; j < run.length; j++) mw.Add_1(new oc.BRepBuilderAPI_MakeEdge_2(V(run[j - 1]), V(run[j])).Edge()); };
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
      const arr = new oc.TColgp_Array1OfPnt_2(1, run.length);
      P3.forEach((q, j) => arr.SetValue(j + 1, P(q)));
      const fit = new oc.GeomAPI_PointsToBSpline_2(arr, 2, 5, oc.GeomAbs_Shape.GeomAbs_C1, chord * 1e-4);
      if (fit.IsDone()) {
        const hc = fit.Curve();
        const c = hc.get();
        const f = c.FirstParameter(), l = c.LastParameter();
        ok = true;
        for (let s2 = 0; s2 <= 48 && ok; s2++) {
          const q = ptArr(c.Value(f + ((l - f) * s2) / 48));
          for (let d = 0; d < 3; d++) if (q[d] < mn[d] - margin || q[d] > mx[d] + margin) { ok = false; break; }
        }
        if (ok) {
          const me = new oc.BRepBuilderAPI_MakeEdge_27(new oc.Handle_Geom_Curve_2(c), V(run[0]), V(run[run.length - 1]));
          if (me.IsDone()) mw.Add_1(me.Edge()); else ok = false;
        }
      }
    } catch { ok = false; }
    if (!ok) straight(run);
  }
  if (!mw.IsDone()) return null;
  return mw.Wire();
}

// Exact glyph contour: straight edges and Bezier edges sharing vertices.
function bezierWire(segs) {
  const verts = [];
  const vertexAt = (p) => {
    for (const v of verts) if (Math.abs(v.p[0] - p[0]) < 1e-7 && Math.abs(v.p[1] - p[1]) < 1e-7 && Math.abs(v.p[2] - p[2]) < 1e-7) return v.v;
    const v = new oc.BRepBuilderAPI_MakeVertex(P(p)).Vertex();
    verts.push({ p, v });
    return v;
  };
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (const seg of segs) {
    const v0 = vertexAt(seg[0]), v1 = vertexAt(seg[seg.length - 1]);
    if (seg.length === 2) { mw.Add_1(new oc.BRepBuilderAPI_MakeEdge_2(v0, v1).Edge()); continue; }
    const arr = new oc.TColgp_Array1OfPnt_2(1, seg.length);
    seg.forEach((q, j) => arr.SetValue(j + 1, P(q)));
    const bz = new oc.Geom_BezierCurve_1(arr);
    const me = new oc.BRepBuilderAPI_MakeEdge_27(new oc.Handle_Geom_Curve_2(bz), v0, v1);
    if (!me.IsDone()) return null;
    mw.Add_1(me.Edge());
  }
  return mw.IsDone() ? mw.Wire() : null;
}

function wireFromLoop(fr, loop) {
  const lc = loop.curves.length === 1 ? loop.curves[0].cur : null;
  if (lc && lc.kind === 'poly' && lc.segs && !globalThis.__noSmooth) {
    try { const w = bezierWire(lc.segs.map((seg) => seg.map((q) => to3(fr, q)))); if (w) return w; } catch { /* fall back */ }
  }
  if (loop.curves.length === 1 && loop.curves[0].cur.kind === 'poly') {
    const pts = loop.curves[0].cur.pts.map((q) => to3(fr, q));
    let wire = null;
    if (!globalThis.__noSmooth) { try { wire = smoothWire(pts); } catch { wire = null; } }
    if (wire) return wire;
    const mp = new oc.BRepBuilderAPI_MakePolygon_1();
    for (const q of pts) mp.Add_1(P(q));
    mp.Close();
    return mp.Wire();
  }
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (const s of loop.curves) mw.Add_1(edgeFromCurve(fr, s));
  if (!mw.IsDone()) throw new Error('Could not build a closed wire from the sketch');
  return mw.Wire();
}

// Planar face of a region: outer loop with its holes (no booleans needed).
function regionFace(fr, region) {
  const mf = new oc.BRepBuilderAPI_MakeFace_15(wireFromLoop(fr, region.outer), true);
  if (!mf.IsDone()) throw new Error('Could not build a face from the sketch');
  let face = mf.Face();
  if (!region.holes.length) return face;
  for (const h of region.holes) {
    const w = wireFromLoop(fr, h);
    const add = new oc.BRepBuilderAPI_MakeFace_22(face, w);
    if (!add.IsDone()) throw new Error('Could not add a hole to the sketch face');
    face = add.Face();
  }
  const fix = new oc.ShapeFix_Face_2(face);
  fix.FixOrientation_1();
  fix.Perform();
  return oc.TopoDS.Face_1(fix.Face());
}

function faceFromLoop(fr, loop) {
  if (loop.curves.length === 1 && loop.curves[0].cur.kind === 'poly') {
    const pts = loop.curves[0].cur.pts.map((q) => to3(fr, q));
    let wire = null;
    try { wire = smoothWire(pts); } catch { wire = null; }
    if (!wire) {
      const mp = new oc.BRepBuilderAPI_MakePolygon_1();
      for (const q of pts) mp.Add_1(P(q));
      mp.Close();
      wire = mp.Wire();
    }
    const mf = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!mf.IsDone()) throw new Error('Could not build a face from the sketch text');
    return mf.Face();
  }
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (const s of loop.curves) mw.Add_1(edgeFromCurve(fr, s));
  if (!mw.IsDone()) throw new Error('Could not build a closed wire from the sketch');
  const mf = new oc.BRepBuilderAPI_MakeFace_15(mw.Wire(), true);
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
  const builder = new oc.BRep_Builder();
  const comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const s of solids) builder.Add(comp, s);
  return comp;
}

// ---------- booleans / transforms ----------
function boolFuse(a, b) {
  const op = new oc.BRepAlgoAPI_Fuse_3(a, b, PR());
  op.Build(PR());
  if (!op.IsDone()) throw new Error('Boolean union failed');
  return unify(op.Shape());
}
function boolCut(a, b) {
  const op = new oc.BRepAlgoAPI_Cut_3(a, b, PR());
  op.Build(PR());
  if (!op.IsDone()) throw new Error('Boolean cut failed');
  return unify(op.Shape());
}
function boolCommon(a, b) {
  const op = new oc.BRepAlgoAPI_Common_3(a, b, PR());
  op.Build(PR());
  if (!op.IsDone()) throw new Error('Boolean intersect failed');
  return unify(op.Shape());
}
function checkValid(s, what) {
  const an = new oc.BRepCheck_Analyzer(s, true, false);
  if (!an.IsValid_2()) throw new Error(`${what} produced invalid geometry - adjust its parameters`);
  return s;
}
function unify(s) {
  if (globalThis.__noUnify) return s;
  try {
    const u = new oc.ShapeUpgrade_UnifySameDomain_2(s, true, true, false);
    u.Build();
    return u.Shape();
  } catch { return s; }
}
function transformed(shape, trsf) {
  return new oc.BRepBuilderAPI_Transform_2(shape, trsf, true).Shape();
}

function bbox(shape) {
  const b = new oc.Bnd_Box_1();
  oc.BRepBndLib.Add(shape, b, false);
  if (b.IsVoid()) return null;
  const mn = b.CornerMin(), mx = b.CornerMax();
  return { min: ptArr(mn), max: ptArr(mx) };
}
const diag = (bb) => (bb ? len(sub(bb.max, bb.min)) : 100);

// Sketch plane for a planar face: origin is the part origin projected onto
// the face, X follows the matching standard plane (SolidWorks convention).
function facePlane(n, c) {
  const d = dot(c, n);
  const origin = mul(n, d);
  let xd;
  const ax = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  if (ax[1] > 0.999) xd = [1, 0, 0];
  else if (ax[2] > 0.999) xd = [Math.sign(n[2]), 0, 0];
  else if (ax[0] > 0.999) xd = [0, 0, -Math.sign(n[0])];
  else {
    xd = sub([1, 0, 0], mul(n, n[0]));
    if (len(xd) < 1e-6) xd = sub([0, 0, -1], mul(n, -n[2]));
  }
  return { origin, normal: n, xDir: norm(xd) };
}

// ---------- topology listings (with stable-ish references) ----------
function listEdges(shape) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, map);
  const out = [];
  for (let i = 1; i <= map.Extent(); i++) {
    const e = oc.TopoDS.Edge_1(map.FindKey(i));
    let ad;
    try { ad = new oc.BRepAdaptor_Curve_2(e); } catch { continue; }
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const mid = ptArr(ad.Value((f + l) / 2));
    const t = ad.GetType();
    const type = t === oc.GeomAbs_CurveType.GeomAbs_Line ? 'line' : t === oc.GeomAbs_CurveType.GeomAbs_Circle ? 'circle' : 'curve';
    out.push({ edge: e, mid, type, adaptor: ad, f, l });
  }
  return out;
}

function planeOfFace(face) {
  const ad = new oc.BRepAdaptor_Surface_2(face, true);
  if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
  let n = ptArr(ad.Plane().Position().Direction());
  if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  return facePlane(n, ptArr(props.CentreOfMass()));
}

function listFaces(shape) {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
  const out = [];
  for (let i = 1; i <= map.Extent(); i++) {
    const face = oc.TopoDS.Face_1(map.FindKey(i));
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const c = ptArr(props.CentreOfMass());
    const area = props.Mass();
    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    let plane = null, type = 'surface', axis, r;
    const st = ad.GetType();
    if (st === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      type = 'plane';
      const ax = ad.Plane().Position();
      let n = ptArr(ax.Direction());
      const x = ptArr(ax.XDirection());
      if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
      void x;
      plane = facePlane(n, c);
    } else if (st === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      type = 'cylinder';
      try { const cy = ad.Cylinder(); const ax = cy.Axis(); axis = { p: ptArr(ax.Location()), d: ptArr(ax.Direction()) }; r = cy.Radius(); } catch { /* no axis */ }
    }
    out.push({ face, c, area, type, plane, axis, r });
  }
  return out;
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
function edgeDir(e) {
  if (e.type !== 'line') return null;
  const a = ptArr(e.adaptor.Value(e.f)), b = ptArr(e.adaptor.Value(e.l));
  return norm(sub(b, a));
}
function matchEdges(shape, refs) {
  const edges = listEdges(shape);
  const bb = bbox(shape);
  const tol = Math.max(0.5, diag(bb) * 0.04);
  const res = [];
  for (const r of refs) {
    const exp = expectedPos(r, r.mid, bb);
    let best = null, bd = Infinity;
    for (const e of edges) {
      if (r.type && e.type !== r.type) continue;
      if (r.dir && e.type === 'line') { const d = edgeDir(e); if (d && Math.abs(dot(d, r.dir)) < 0.995) continue; }
      const d = Math.min(len(sub(e.mid, r.mid)), len(sub(e.mid, exp)));
      if (d < bd) { bd = d; best = e; }
    }
    if (!best || bd > tol) throw new Error('A referenced edge is missing after rebuild - edit the feature and reselect');
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
    const exp = expectedPos(r, r.c, bb);
    let best = null, bd = Infinity;
    for (const f of faces) {
      if (r.n && (!f.plane || dot(norm(r.n), f.plane.normal) < 0.999)) continue;
      const d = Math.min(len(sub(f.c, r.c)), len(sub(f.c, exp)));
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
  let tool = regionSolids(sk, (face) => new oc.BRepPrimAPI_MakePrism_1(face, V(mul(dir, depth)), false, true).Shape());
  if (f.end === 'midplane') {
    const t = new oc.gp_Trsf_1();
    t.SetTranslation_1(V(mul(dir, -depth / 2)));
    tool = transformed(tool, t);
  }
  if (f.end === 'throughAll' && f.op === 'cut' && f.bothSides) {
    const t = new oc.gp_Trsf_1();
    t.SetTranslation_1(V(mul(dir, -depth / 2)));
    tool = transformed(tool, t);
  }
  return tool;
}

function buildRevolveTool(f, sk, sketches) {
  const ax = f.axis?.line ? axisFromSketchLine(sk, f.axis.line) : resolveAxis(f.axis, sketches);
  const ang = ((Number(f.angle) || 360) * Math.PI) / 180 * (f.reverse ? -1 : 1);
  const axis = new oc.gp_Ax1_2(P(ax.p), Dir(ax.d));
  return regionSolids(sk, (face) => {
    if (Math.abs(Math.abs(ang) - 2 * Math.PI) < 1e-9) return new oc.BRepPrimAPI_MakeRevol_2(face, axis, false).Shape();
    return new oc.BRepPrimAPI_MakeRevol_1(face, axis, ang, false).Shape();
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

function readStepText(text, fmt = 'step') {
  const path = `/in_${Date.now()}.${fmt === 'iges' ? 'igs' : 'stp'}`;
  oc.FS.writeFile(path, text);
  const reader = fmt === 'iges' ? new oc.IGESControl_Reader_1() : new oc.STEPControl_Reader_1();
  const st = reader.ReadFile(path);
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`Could not read ${fmt.toUpperCase()} file`);
  reader.TransferRoots(PR());
  const shape = reader.OneShape();
  oc.FS.unlink(path);
  if (shape.IsNull()) throw new Error('File contains no shapes');
  return shape;
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
          for (const e of matchEdges(body, f.edges || [])) mk.Add_2(Number(f.radius), e);
          mk.Build(PR());
          if (!mk.IsDone()) throw new Error('Fillet failed - try a smaller radius');
          body = checkValid(mk.Shape(), 'Fillet');
          break;
        }
        case 'chamfer': {
          if (!body) throw new Error('No body to chamfer');
          const mk = new oc.BRepFilletAPI_MakeChamfer(body);
          for (const e of matchEdges(body, f.edges || [])) mk.Add_2(Number(f.distance), e);
          mk.Build(PR());
          if (!mk.IsDone()) throw new Error('Chamfer failed - try a smaller distance');
          body = checkValid(mk.Shape(), 'Chamfer');
          break;
        }
        case 'shell': {
          if (!body) throw new Error('No body to shell');
          const list = new oc.TopTools_ListOfShape_1();
          for (const fc of matchFaces(body, f.faces || [])) list.Append_1(fc);
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
              const t = new oc.gp_Trsf_1();
              t.SetTranslation_1(V(mul(dir, Number(f.spacing) * k)));
              copies.push(t);
            }
          } else if (f.type === 'circularPattern') {
            const ax = resolveAxis(f.axis, sketches);
            const n = f.count | 0;
            const total = ((Number(f.angle) || 360) * Math.PI) / 180;
            const step = Math.abs(total - 2 * Math.PI) < 1e-9 ? total / n : total / Math.max(1, n - 1);
            for (let k = 1; k < n; k++) {
              const t = new oc.gp_Trsf_1();
              t.SetRotation_1(new oc.gp_Ax1_2(P(ax.p), Dir(ax.d)), step * k);
              copies.push(t);
            }
          } else {
            const pl = STD_PLANES[f.plane] || f.plane;
            const t = new oc.gp_Trsf_1();
            t.SetMirror_3(new oc.gp_Ax2_3(P(pl.origin), Dir(pl.normal)));
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
      status.push({ id: f.id, state: 'ok' });
    } catch (err) {
      failed = true;
      status.push({ id: f.id, state: 'error', error: String(err.message || err) });
    }
  }
  return { body, status, stages };
}

// ---------- face -> feature ownership (SolidWorks-style double-click / tree hover) ----------
// A face belongs to the earliest feature whose result already had a face on the same surface.
const sigCache = new WeakMap();
function surfSig(fi) {
  const r = (v, k = 3) => (Math.round(v * 10 ** k) / 10 ** k + 0).toFixed(k);
  if (fi.type === 'plane' && fi.plane) { const n = fi.plane.normal; return `p${r(n[0], 4)},${r(n[1], 4)},${r(n[2], 4)}|${r(n[0] * fi.c[0] + n[1] * fi.c[1] + n[2] * fi.c[2])}`; }
  if (fi.type === 'cylinder' && fi.axis) {
    let d = fi.axis.d; const k = Math.abs(d[0]) > 1e-6 ? 0 : Math.abs(d[1]) > 1e-6 ? 1 : 2; if (d[k] < 0) d = mul(d, -1);
    const p = fi.axis.p, t = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    const q = [p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]];
    return `c${r(fi.r)}|${r(d[0], 4)},${r(d[1], 4)},${r(d[2], 4)}|${r(q[0])},${r(q[1])},${r(q[2])}`;
  }
  return `s${fi.type}|${r(fi.c[0])},${r(fi.c[1])},${r(fi.c[2])}|${r(fi.area, 2)}`;
}
function sigsOf(body) {
  let s = sigCache.get(body);
  if (!s) { s = new Set(listFaces(body).map(surfSig)); sigCache.set(body, s); }
  return s;
}
export function faceOwners(stages, body) {
  if (!body || !stages?.length) return [];
  const sets = stages.map((st) => sigsOf(st.body));
  return listFaces(body).map((fi) => { const sg = surfSig(fi); const i = sets.findIndex((S) => S.has(sg)); return i >= 0 ? stages[i].id : stages[stages.length - 1].id; });
}

// ---------- tessellation ----------
export function tessellate(shape, quality = 1) {
  if (!shape) return { positions: new Float32Array(0), indices: new Uint32Array(0), faces: [], edges: [] };
  const bb = bbox(shape);
  const lin = Math.max(0.005, (diag(bb) * 0.0008) / quality);
  new oc.BRepMesh_IncrementalMesh_2(shape, lin, false, 0.35, false);
  const positions = [], normals = [], indices = [];
  const faces = [];
  const faceList = listFaces(shape);
  faceList.forEach((fi, fid) => {
    const loc = new oc.TopLoc_Location_1();
    const hTri = oc.BRep_Tool.Triangulation(fi.face, loc, 0);
    if (hTri.IsNull()) return;
    const tri = hTri.get();
    const trsf = loc.Transformation();
    const base = positions.length / 3;
    const nn = tri.NbNodes();
    for (let i = 1; i <= nn; i++) {
      const p = tri.Node(i).Transformed(trsf);
      positions.push(p.X(), p.Y(), p.Z());
    }
    const reversed = fi.face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const start = indices.length;
    const nt = tri.NbTriangles();
    for (let i = 1; i <= nt; i++) {
      const t = tri.Triangle(i);
      let a = t.Value(1), b = t.Value(2), c = t.Value(3);
      if (reversed) [b, c] = [c, b];
      indices.push(base + a - 1, base + b - 1, base + c - 1);
    }
    faces.push({ id: fid, start, count: indices.length - start, c: fi.c, area: fi.area, type: fi.type, plane: fi.plane, ...(fi.axis ? { axis: fi.axis, r: fi.r } : {}) });
  });
  // seam edges (closed surfaces) are hidden like in SolidWorks
  let seamOf = () => false;
  try {
    const anc = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
    oc.TopExp.MapShapesAndUniqueAncestors(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_FACE, anc, false);
    seamOf = (edge) => { try { const i = anc.FindIndex(edge); return i > 0 && anc.FindFromIndex(i).Size() === 1; } catch { return false; } };
  } catch { /* keep all edges */ }
  const edges = listEdges(shape).filter((e) => !seamOf(e.edge)).map((e, id) => {
    const pts = [];
    try {
      const td = new oc.GCPnts_TangentialDeflection_2(e.adaptor, 0.1, lin, 2, 1e-9, 1e-7);
      for (let i = 1; i <= td.NbPoints(); i++) pts.push(...ptArr(td.Value(i)));
    } catch {
      pts.push(...ptArr(e.adaptor.Value(e.f)), ...ptArr(e.adaptor.Value(e.l)));
    }
    let length = 0;
    for (let i = 3; i < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
    return { id, mid: e.mid, type: e.type, pts: new Float32Array(pts), length };
  });
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), faces, edges, bbox: bb };
}

export function massProps(shape) {
  if (!shape) return null;
  const vp = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, vp, true, false, false);
  const sp = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(shape, sp, false, false);
  return { volume: vp.Mass(), area: sp.Mass(), com: ptArr(vp.CentreOfMass()), bbox: bbox(shape) };
}

// ---------- exchange ----------
export function writeStep(shape) {
  if (!shape) throw new Error('Nothing to export');
  const w = new oc.STEPControl_Writer_1();
  const st = w.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, PR());
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP transfer failed');
  const path = '/out.step';
  w.Write(path);
  const txt = oc.FS.readFile(path, { encoding: 'utf8' });
  oc.FS.unlink(path);
  return txt;
}

// assembly: each part body placed with a 4x4 column-major matrix, written as one compound
export function assemblyShape(parts) {
  const builder = new oc.BRep_Builder();
  const comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  let n = 0;
  for (const { body, m } of parts) {
    if (!body) continue;
    const t = new oc.gp_Trsf_1();
    t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
    builder.Add(comp, new oc.BRepBuilderAPI_Transform_2(body, t, true).Shape());
    n++;
  }
  if (!n) throw new Error('Nothing to export');
  return comp;
}

export function writeIges(shape) {
  if (!shape) throw new Error('Nothing to export');
  const w = new oc.IGESControl_Writer_2('MM', 1); // 1 = B-rep (solid) mode
  w.AddShape(shape, PR());
  w.ComputeModel();
  const path = '/out.igs';
  w.Write_2(path, false);
  const txt = oc.FS.readFile(path, { encoding: 'utf8' });
  oc.FS.unlink(path);
  return txt;
}

// Convert an IGES/STEP file into STEP text so it can be stored in a part.
export function importToStep(text, format) {
  const shape = readStepText(text, format);
  return { step: format === 'step' ? text : writeStep(shape), mesh: tessellate(shape) };
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
    const mw = new oc.BRepBuilderAPI_MakePolygon_1();
    for (const c of corners2d) mw.Add_1(P(W(c[0], c[1], z0)));
    mw.Close();
    const face = new oc.BRepBuilderAPI_MakeFace_15(mw.Wire(), true).Face();
    return new oc.BRepPrimAPI_MakePrism_1(face, V([0, z1 - z0, 0]), false, true).Shape();
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
