// Drawing views: exact hidden-line removal (HLRBRep) of a part/assembly shape for one view direction.
// Result in the view plane (mm): x along `xDir`, y along dir × xDir. Edges as polylines, with circle /
// line info kept for dimensioning.
import { oc, Dir, P, listFaces, bbox, runBool } from './core.mjs';

function edgesOf(shape, cls, out, tol) {
  if (!shape || shape.IsNull()) return;
  const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const e = oc.TopoDS.Edge(ex.Current());
    let ad;
    try { ad = new oc.BRepAdaptor_Curve(e); } catch { continue; }
    const f = ad.FirstParameter(), l = ad.LastParameter();
    const t = ad.GetType(), CT = oc.GeomAbs_CurveType;
    const rec = { cls, pts: [] };
    if (t === CT.GeomAbs_Line) {
      const a = ad.Value(f), b = ad.Value(l);
      rec.pts = [a.X(), a.Y(), b.X(), b.Y()]; rec.type = 'line';
    } else {
      if (t === CT.GeomAbs_Circle) { const c = ad.Circle(), p = c.Location(); rec.type = 'circle'; rec.c = [p.X(), p.Y()]; rec.r = c.Radius(); rec.full = Math.abs(l - f) > 2 * Math.PI - 1e-6; }
      else rec.type = 'curve';
      let ok = false;
      try {
        const d = new oc.GCPnts_TangentialDeflection(ad, ad.FirstParameter(), ad.LastParameter(), 0.08, tol, 2, 1e-9, 1e-7);
        const n = d.NbPoints();
        for (let i = 1; i <= n; i++) { const p = d.Value(i); rec.pts.push(p.X(), p.Y()); }
        ok = n >= 2;
      } catch { /* fall back */ }
      if (!ok) { rec.pts = []; for (let i = 0; i <= 32; i++) { const p = ad.Value(f + ((l - f) * i) / 32); rec.pts.push(p.X(), p.Y()); } }
    }
    out.push(rec);
  }
}

// dir: towards the viewer; xDir: right on the paper. hidden: also hidden edges.
export function hlrView(shape, dir, xDir, hidden = false) {
  const algo = new oc.HLRBRep_Algo();
  algo.Add(shape, 0);
  const ax = new oc.gp_Ax2(P([0, 0, 0]), Dir(dir), Dir(xDir));
  algo.Projector(new oc.HLRAlgo_Projector(ax));
  algo.Update();
  algo.Hide();
  const r = new oc.HLRBRep_HLRToShape(algo);
  const out = [];
  const tol = 0.01;
  edgesOf(r.VCompound(), 'v', out, tol);
  edgesOf(r.OutLineVCompound(), 'v', out, tol);
  edgesOf(r.Rg1LineVCompound(), 't', out, tol); // tangent (smooth) edges, drawn thin
  if (hidden) { edgesOf(r.HCompound(), 'h', out, tol); edgesOf(r.OutLineHCompound(), 'h', out, tol); }
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of out) for (let i = 0; i < e.pts.length; i += 2) { box[0] = Math.min(box[0], e.pts[i]); box[1] = Math.min(box[1], e.pts[i + 1]); box[2] = Math.max(box[2], e.pts[i]); box[3] = Math.max(box[3], e.pts[i + 1]); }
  return { edges: out, box };
}

// ---------- section views ----------
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function polyOfEdge(e) {
  const ad = new oc.BRepAdaptor_Curve(e), f = ad.FirstParameter(), l = ad.LastParameter(), out = [];
  if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) { for (const t of [f, l]) { const p = ad.Value(t); out.push([p.X(), p.Y(), p.Z()]); } }
  else {
    let ok = false;
    try { const d = new oc.GCPnts_TangentialDeflection(ad, ad.FirstParameter(), ad.LastParameter(), 0.08, 0.01, 2, 1e-9, 1e-7); for (let i = 1; i <= d.NbPoints(); i++) { const p = d.Value(i); out.push([p.X(), p.Y(), p.Z()]); } ok = out.length >= 2; } catch { /* */ }
    if (!ok) { out.length = 0; for (let i = 0; i <= 48; i++) { const p = ad.Value(f + ((l - f) * i) / 48); out.push([p.X(), p.Y(), p.Z()]); } }
  }
  return out;
}
// chain edge polylines into closed loops
function chain(polys, tol) {
  const loops = [], left = polys.slice();
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
  while (left.length) {
    let cur = left.shift().slice();
    let grew = true;
    while (grew && left.length) {
      grew = false;
      const end = cur[cur.length - 1];
      for (let i = 0; i < left.length; i++) {
        const q = left[i];
        if (near(q[0], end)) { cur = cur.concat(q.slice(1)); left.splice(i, 1); grew = true; break; }
        if (near(q[q.length - 1], end)) { cur = cur.concat(q.slice(0, -1).reverse()); left.splice(i, 1); grew = true; break; }
      }
      if (near(cur[0], cur[cur.length - 1])) break;
    }
    loops.push(cur);
  }
  return loops;
}
// plane: {p, n} with n pointing to the removed side (towards the viewer of the section)
export function sectionView(shape, plane, dir, xDir, hidden = false) {
  const b = bbox(shape); if (!b) throw new Error('Empty model');
  const L = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 2 + 10;
  const n = plane.n, nl = Math.hypot(...n); const m = n.map((v) => v / nl);
  let D = Math.abs(m[0]) < 0.9 ? crs(m, [1, 0, 0]) : crs(m, [0, 1, 0]); const dl = Math.hypot(...D); D = D.map((v) => v / dl);
  const Y = crs(m, D), p0 = plane.p;
  const o = [0, 1, 2].map((i) => p0[i] - D[i] * L - Y[i] * L);
  const box = new oc.BRepPrimAPI_MakeBox(new oc.gp_Ax2(P(o), Dir(m), Dir(D)), 2 * L, 2 * L, L).Shape();
  const op = runBool('BRepAlgoAPI_Cut', shape, box);
  if (!op.IsDone()) throw new Error('Section cut failed');
  const cut = op.Shape();
  const view = hlrView(cut, dir, xDir, hidden);
  // section faces: planar faces lying on the cut plane
  const vy = crs(dir, xDir), to2 = (q) => [dot3(q, xDir), dot3(q, vy)];
  const hatch = [];
  const d0 = dot3(p0, m), tol = Math.max(1e-4, L * 1e-6);
  for (const fi of listFaces(cut)) {
    if (fi.type !== 'plane' || !fi.plane) continue;
    if (Math.abs(Math.abs(dot3(fi.plane.normal, m)) - 1) > 1e-6 || Math.abs(dot3(fi.c, m) - d0) > tol * 10) continue;
    const wex = new oc.TopExp_Explorer(fi.face, oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const loops = [];
    for (; wex.More(); wex.Next()) {
      const polys = [];
      const eex = new oc.TopExp_Explorer(wex.Current(), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; eex.More(); eex.Next()) polys.push(polyOfEdge(oc.TopoDS.Edge(eex.Current())));
      for (const lp of chain(polys, Math.max(1e-3, L * 1e-5))) loops.push(lp.flatMap((q) => to2(q)));
    }
    if (loops.length) hatch.push(loops);
  }
  return { ...view, hatch };
}
