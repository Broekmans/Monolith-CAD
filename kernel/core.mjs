// Kernel core: OpenCascade instance (initKernel), vector helpers, shape/topology utilities.
export let oc = null;
export const PR = () => new oc.Message_ProgressRange_1();

export const __oc = () => oc;
export async function initKernel(initFn) {
  oc = await initFn();
  return true;
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

export const P = (p) => new oc.gp_Pnt_3(p[0], p[1], p[2]);
export const V = (v) => new oc.gp_Vec_4(v[0], v[1], v[2]);
export const Dir = (v) => new oc.gp_Dir_4(v[0], v[1], v[2]);
export const ptArr = (p) => [p.X(), p.Y(), p.Z()];

export function checkValid(s, what) {
  const an = new oc.BRepCheck_Analyzer(s, true, false);
  if (!an.IsValid_2()) throw new Error(`${what} produced invalid geometry - adjust its parameters`);
  return s;
}
export function unify(s) {
  if (globalThis.__noUnify) return s;
  try {
    const u = new oc.ShapeUpgrade_UnifySameDomain_2(s, true, true, false);
    u.Build();
    return u.Shape();
  } catch { return s; }
}
export function transformed(shape, trsf) {
  return new oc.BRepBuilderAPI_Transform_2(shape, trsf, true).Shape();
}

export function bbox(shape) {
  const b = new oc.Bnd_Box_1();
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

// ---------- topology listings (with stable-ish references) ----------
export function listEdges(shape) {
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

export function planeOfFace(face) {
  const ad = new oc.BRepAdaptor_Surface_2(face, true);
  if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
  let n = ptArr(ad.Plane().Position().Direction());
  if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = mul(n, -1);
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  return facePlane(n, ptArr(props.CentreOfMass()));
}

export function listFaces(shape) {
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
