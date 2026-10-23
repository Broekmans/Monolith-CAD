// Kernel core: OpenCascade instance (initKernel), vector helpers, shape/topology utilities.
export let oc = null;
export const PR = () => new oc.Message_ProgressRange();

export const __oc = () => oc;
// opts.parallel (0.1.111): the multi-thread kernel build is loaded — booleans and meshing spread over the CPU cores
export const kernelOpts = { parallel: false };
export async function initKernel(initFn, opts = {}) {
  oc = await initFn();
  Object.assign(kernelOpts, opts);
  return true;
}
// Boolean (Cls = 'BRepAlgoAPI_Fuse' | 'BRepAlgoAPI_Cut' | 'BRepAlgoAPI_Common'); with the two shapes in the constructor it
// runs at once on one core; for several cores it is set up first and built with SetRunParallel
export function runBool(Cls, a, b) {
  if (!kernelOpts.parallel) return new oc[Cls](a, b, PR()); // the constructor already runs the operation (no second Build)
  const op = new oc[Cls](), A = new oc.NCollection_List_TopoDS_Shape(), B = new oc.NCollection_List_TopoDS_Shape();
  A.Append(a); B.Append(b);
  op.SetArguments(A); op.SetTools(B); op.SetRunParallel(true);
  op.Build(PR());
  return op;
}

// ---------- small vector helpers ----------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export function planeFrame(pl) {
  const n = norm(pl.normal);
  const x = norm(pl.xDir);
  const y = cross(n, x);
  return { o: pl.origin, n, x, y };
}
export const to3 = (fr, p) => add(fr.o, add(mul(fr.x, p[0]), mul(fr.y, p[1])));

export const P = (p) => new oc.gp_Pnt(p[0], p[1], p[2]);
export const V = (v) => new oc.gp_Vec(v[0], v[1], v[2]);
export const Dir = (v) => new oc.gp_Dir(v[0], v[1], v[2]);
export const ptArr = (p) => [p.X(), p.Y(), p.Z()];

// Readable text for an error: OCCT exceptions arrive as WebAssembly.Exception (0.1.109) — type + message from the kernel
export function errText(e) {
  if (e?.message) return e.message;
  try {
    if (typeof WebAssembly.Exception === 'function' && e instanceof WebAssembly.Exception && oc?.getExceptionMessage) {
      const [type, msg] = oc.getExceptionMessage(e);
      try { oc.decrementExceptionRefcount?.(e); } catch { /* freed */ }
      return `The geometry kernel could not do this (${[type, msg].filter(Boolean).join(': ')})`;
    }
  } catch { /* plain text below */ }
  return String(e);
}
export function checkValid(s, what) {
  const an = new oc.BRepCheck_Analyzer(s, true, false);
  if (!an.IsValid()) throw new Error(`${what} produced invalid geometry - adjust its parameters`);
  return s;
}
export function unify(s) {
  if (globalThis.__noUnify) return s;
  try {
    const u = new oc.ShapeUpgrade_UnifySameDomain(s, true, true, false);
    u.Build();
    return u.Shape();
  } catch { return s; }
}
export function transformed(shape, trsf) {
  return new oc.BRepBuilderAPI_Transform(shape, trsf, true).Shape();
}

export function bbox(shape) {
  const b = new oc.Bnd_Box();
  oc.BRepBndLib.Add(shape, b, false);
  if (b.IsVoid()) return null;
  const mn = b.CornerMin(), mx = b.CornerMax();
  return { min: ptArr(mn), max: ptArr(mx) };
}
export const diag = (bb) => (bb ? len(sub(bb.max, bb.min)) : 100);

// Sketch plane for a planar face: origin is the part origin projected onto
// the face, X follows the matching standard plane (SolidWorks convention).
export function facePlane(n, c) {
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

// ---------- maps (0.1.109: the kernel build has no TopExp map functions — same result with explorers) ----------
// unique sub-shapes of a type (orientation ignored), 1-based like TopTools_IndexedMapOfShape: FindKey(i), FindIndex(s), Extent()
// (the build's map classes cannot be created from JS: a small JS map on the shape hash + IsSame does the same)
const HASH_MAX = 2147483647;
export class ShapeMap {
  constructor() { this.keys = []; this.buckets = new Map(); }
  FindIndex(s) { const b = this.buckets.get(oc.ReplicadShapeHasher.HashCode(s, HASH_MAX)); if (b) for (const i of b) if (this.keys[i - 1].IsSame(s)) return i; return 0; }
  Add(s) {
    const h = oc.ReplicadShapeHasher.HashCode(s, HASH_MAX);
    let b = this.buckets.get(h);
    if (b) { for (const i of b) if (this.keys[i - 1].IsSame(s)) return i; } else this.buckets.set(h, (b = []));
    this.keys.push(s); b.push(this.keys.length);
    return this.keys.length;
  }
  FindKey(i) { return this.keys[i - 1]; }
  Extent() { return this.keys.length; }
}
export function shapeMap(shape, type) {
  const map = new ShapeMap();
  for (const ex = new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) map.Add(ex.Current());
  return map;
}
// edges with their faces: { edges: shapeMap, faces(i) -> [face …] unique } (i = edge index, 1-based)
export function edgeFaces(shape) {
  const edges = shapeMap(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  const lists = new Map();
  for (const fx = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); fx.More(); fx.Next()) {
    const face = fx.Current();
    for (const ex = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); ex.More(); ex.Next()) {
      const i = edges.FindIndex(ex.Current());
      if (i <= 0) continue;
      const l = lists.get(i) || []; if (!l.some((f) => f.IsSame(face))) l.push(face); lists.set(i, l);
    }
  }
  return { edges, faces: (i) => lists.get(i) || [] };
}
// closed polygon wire through 3D points
export function polygonWire(pts) {
  const vs = pts.map((q) => new oc.BRepBuilderAPI_MakeVertex(P(q)).Vertex());
  const mw = new oc.BRepBuilderAPI_MakeWire();
  for (let i = 0; i < vs.length; i++) mw.Add(new oc.BRepBuilderAPI_MakeEdge(vs[i], vs[(i + 1) % vs.length]).Edge());
  return mw.Wire();
}
export function compoundOf(shapes) {
  const b = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  b.MakeCompound(comp);
  for (const s of shapes) b.Add(comp, s);
  return comp;
}

// ---------- topology listings (with stable-ish references) ----------
export function listEdges(shape) {
  const map = shapeMap(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
  const out = [];
  for (let i = 1; i <= map.Extent(); i++) {
    const e = oc.TopoDS.Edge(map.FindKey(i));
    let ad;
    try { ad = new oc.BRepAdaptor_Curve(e); } catch { continue; }
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const mid = ptArr(ad.Value((f + l) / 2));
    const t = ad.GetType();
    const type = t === oc.GeomAbs_CurveType.GeomAbs_Line ? 'line' : t === oc.GeomAbs_CurveType.GeomAbs_Circle ? 'circle' : 'curve';
    out.push({ edge: e, mid, type, adaptor: ad, f, l });
  }
  return out;
}

export function planeOfFace(face) {
  const ad = new oc.BRepAdaptor_Surface(face, true);
  if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
  let n = ptArr(ad.Plane().Position().Direction());
  if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  return facePlane(n, ptArr(props.CentreOfMass()));
}

export function listFaces(shape) {
  const map = shapeMap(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
  const out = [];
  for (let i = 1; i <= map.Extent(); i++) {
    const face = oc.TopoDS.Face(map.FindKey(i));
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props, false, false);
    const c = ptArr(props.CentreOfMass());
    const area = props.Mass();
    const ad = new oc.BRepAdaptor_Surface(face, true);
    let plane = null, type = 'surface', axis, r;
    const st = ad.GetType();
    if (st === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      type = 'plane';
      const ax = ad.Plane().Position();
      let n = ptArr(ax.Direction());
      const x = ptArr(ax.XDirection());
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
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
