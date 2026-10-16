// Part overlay on point cloud views (mixin of DrawingDoc): a part aligned with the scan in the point cloud
// document (Register → Align Part, doc.partAlign[file] = 4×4 column-major in the document frame, acting on
// the part's document-frame coordinates) is drawn on top of the scan. The cloud view frame is the part
// frame (mm, Y up) of the cloud document, so the overlay map is p -> R·p + t with R = P·R_A·Pᵀ, t = 1000·P·t_A
// (P: doc Z-up -> Y-up). The kernel draws the part with the view direction turned back by R (and a section
// plane moved back), the 2D result is shifted by (x·t, y·t). Edges get `ov: true` (own colour).
const P = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function overlayXf(m) {
  const RA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j * 4 + i])), tA = [m[12], m[13], m[14]];
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => { let s = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += P[i][a] * RA[a][b] * P[j][b]; return s; }));
  const t = [0, 1, 2].map((i) => 1000 * (P[i][0] * tA[0] + P[i][1] * tA[1] + P[i][2] * tA[2]));
  const RT = (v) => [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2]); // Rᵀ·v
  return { R, t, RT };
}
export class DrawingOverlay {
  async addOverlays(items, geoms, ctx, partAlign) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i], o = it.cloud || ctx?.cloud, file = o?.overlay, m = file && partAlign?.[file];
      if (!m) continue;
      const { t, RT } = overlayXf(m), X = it.x, Y = cross(it.dir, it.x);
      const view = { dir: RT(it.dir), x: RT(it.x), plane: it.plane ? { p: RT(it.plane.p.map((c, k) => c - t[k])), n: RT(it.plane.n) } : null };
      let g;
      try { g = (await this.computeViews(file, [view]))[0]; } catch (e) { geoms[i].info.overlayError = String(e.message || e); continue; }
      const du = dot(X, t), dw = dot(Y, t);
      geoms[i].edges = g.edges.filter((e) => e.cls !== 'h').map((e) => ({ ...e, ov: true, pts: e.pts.map((c, k) => c + (k % 2 ? dw : du)), ...(e.c ? { c: [e.c[0] + du, e.c[1] + dw] } : {}) }));
      if (g.hatch) geoms[i].hatch = g.hatch.map((face) => face.map((lp) => lp.map((c, k) => c + (k % 2 ? dw : du))));
      geoms[i].info.overlay = file;
    }
  }
}
