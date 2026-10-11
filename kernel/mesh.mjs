// Kernel meshing & measuring: tessellation for display, face ownership per feature, mass properties.
import { oc, mul, ptArr, bbox, diag, listEdges, listFaces } from './core.mjs';

// ---------- face -> feature ownership (SolidWorks-style double-click / tree hover) ----------
// A face belongs to the earliest feature whose result already had a face on the same surface.
export const sigCache = new WeakMap();
export function surfSig(fi) {
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
export function sigsOf(body) {
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
