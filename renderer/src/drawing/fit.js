// Fitting straight planes in point cloud views (annotations). A wall, floor or ceiling seen edge-on is a
// band of scan points a few mm wide, never an exact line: we fit a line through the band (RANSAC for the
// candidate, then least squares on the inliers, refined twice with a tolerance from the scatter) and snap
// to that line. Data: the view's fit sample (geom.fit, real points thinned to ≈ pix/3, made by
// main/clouddraw.cjs), in view-model mm.
// Tuning values: Options rows dr* (app/options/cats/drawingvals.js), read once per call (node-safe import).
import { opt } from '../app/options/index.js';

const cache = new WeakMap();
const bytes = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export function fitData(f) {
  if (!f || !f.n) return null;
  let d = cache.get(f);
  if (d) return d;
  const raw = bytes(f.xy), arr = f.bits === 32 ? new Uint32Array(raw.buffer) : new Uint16Array(raw.buffer);
  const n = f.n, x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = f.o[0] + arr[i * 2] * f.step; y[i] = f.o[1] + arr[i * 2 + 1] * f.step; }
  // grid for neighbour queries
  const gc = Math.max(40, f.cell * 12), grid = new Map();
  for (let i = 0; i < n; i++) { const k = key(Math.floor(x[i] / gc), Math.floor(y[i] / gc)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  d = { n, x, y, gc, grid, cell: f.cell };
  cache.set(f, d);
  return d;
}
const key = (i, j) => i * 1048576 + j;
// several fit samples (slices) as one point set
export function mergeData(ds) {
  ds = ds.filter(Boolean);
  if (ds.length <= 1) return ds[0] || null;
  const n = ds.reduce((s, d) => s + d.n, 0), x = new Float64Array(n), y = new Float64Array(n), cell = Math.max(...ds.map((d) => d.cell));
  const src = new Uint8Array(n);
  let o = 0; ds.forEach((d, k) => { x.set(d.x, o); y.set(d.y, o); src.fill(k, o, o + d.n); o += d.n; });
  const gc = Math.max(40, cell * 12), grid = new Map();
  for (let i = 0; i < n; i++) { const k = key(Math.floor(x[i] / gc), Math.floor(y[i] / gc)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  return { n, x, y, gc, grid, cell, src, slices: ds.length };
}
export function near(d, q, R) {
  const out = [], i0 = Math.floor((q[0] - R) / d.gc), i1 = Math.floor((q[0] + R) / d.gc), j0 = Math.floor((q[1] - R) / d.gc), j1 = Math.floor((q[1] + R) / d.gc), R2 = R * R;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = d.grid.get(key(i, j)); if (a) for (const k of a) { const dx = d.x[k] - q[0], dy = d.y[k] - q[1]; if (dx * dx + dy * dy <= R2) out.push(k); } }
  return out;
}
// least squares line through points idx: {c, dir, nrm, sigma}
function lsq(d, idx) {
  let cx = 0, cy = 0; for (const k of idx) { cx += d.x[k]; cy += d.y[k]; } cx /= idx.length; cy /= idx.length;
  let sxx = 0, sxy = 0, syy = 0; for (const k of idx) { const a = d.x[k] - cx, b = d.y[k] - cy; sxx += a * a; sxy += a * b; syy += b * b; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dir = [Math.cos(th), Math.sin(th)], nrm = [-dir[1], dir[0]];
  let r2 = 0; for (const k of idx) { const e = (d.x[k] - cx) * nrm[0] + (d.y[k] - cy) * nrm[1]; r2 += e * e; }
  return { c: [cx, cy], dir, nrm, sigma: Math.sqrt(r2 / Math.max(1, idx.length - 2)) };
}
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const distTo = (L, X, Y) => (X - L.c[0]) * L.nrm[0] + (Y - L.c[1]) * L.nrm[1];

// candidate lines near q (search radius R, model mm): the strongest band first, the one nearest q chosen
// among the strong ones (a wall has two faces: the face under the cursor wins). exclude: line to ignore.
function ransac(d, idx, q, R, tol, exclude = null) {
  const exTol = tol * opt('drFitExclTol'), minP = opt('drFitMinPts'), minSpan = opt('drFitMinSpan'), strongK = opt('drFitStrong');
  if (exclude) idx = idx.filter((k) => Math.abs(distTo(exclude, d.x[k], d.y[k])) > exTol);
  if (idx.length < minP) return null;
  const cands = [];
  for (let it = 0; it < 160; it++) {
    const a = idx[rnd(idx.length)], b = idx[rnd(idx.length)];
    const dx = d.x[b] - d.x[a], dy = d.y[b] - d.y[a], l = Math.hypot(dx, dy);
    if (l < R * minSpan) continue;
    const L = { c: [d.x[a], d.y[a]], dir: [dx / l, dy / l], nrm: [-dy / l, dx / l] };
    let cnt = 0; for (const k of idx) if (Math.abs(distTo(L, d.x[k], d.y[k])) <= tol) cnt++;
    cands.push({ L, cnt });
  }
  if (!cands.length) return null;
  const top = Math.max(...cands.map((c) => c.cnt));
  if (top < minP) return null;
  const strong = cands.filter((c) => c.cnt >= strongK * top);
  strong.sort((u, v) => Math.abs(distTo(u.L, q[0], q[1])) - Math.abs(distTo(v.L, q[0], q[1])));
  return strong[0].L;
}
// refine a candidate with least squares over a longer stretch of the band; extent from the inliers
function refine(d, L, q, R, tol) {
  const minP = opt('drFitRefineMinPts'), sb = opt('drFitSigmaBand'), sm = opt('drFitSigmaMin'), eLo = opt('drFitEndLo'), eHi = opt('drFitEndHi');
  const far = near(d, q, R * opt('drFitRefineR'));
  let cur = L, idx = [], fit = null, t = tol;
  for (let pass = 0; pass < 3; pass++) {
    idx = far.filter((k) => Math.abs(distTo(cur, d.x[k], d.y[k])) <= t);
    if (idx.length < minP) return null;
    fit = lsq(d, idx); cur = fit;
    t = Math.max(Math.min(tol, sb * fit.sigma + d.cell), sm * fit.sigma, d.cell);
  }
  // extent along the line: 2 % … 98 % of the inliers (robust ends)
  const ts = idx.map((k) => (d.x[k] - fit.c[0]) * fit.dir[0] + (d.y[k] - fit.c[1]) * fit.dir[1]).sort((a, b) => a - b);
  const t0 = ts[Math.floor(ts.length * eLo)], t1 = ts[Math.floor(ts.length * eHi)];
  return { ...fit, n: idx.length, a: [fit.c[0] + fit.dir[0] * t0, fit.c[1] + fit.dir[1] * t0], b: [fit.c[0] + fit.dir[0] * t1, fit.c[1] + fit.dir[1] * t1] };
}
// axis-aligned bands (walls straight along the view's X or Y): histogram of the points' offset across
// the axis, peaks = bands; deterministic, so the snap does not jump between calls. ax 0 = line along X.
function axisBands(d, idx, q, R, tol, ax) {
  const bw = Math.max(tol / 2, opt('drAxisBinMin')), minC = opt('drAxisMinCount'), nb = Math.ceil((2 * R) / bw) + 1, h = new Float64Array(nb);
  const o = ax === 0 ? 1 : 0; // coordinate across the line
  for (const k of idx) { const u = (o ? d.y[k] : d.x[k]) - q[o] + R, b = Math.floor(u / bw); if (b >= 0 && b < nb) h[b]++; }
  const w = Math.max(1, Math.round(tol / bw)), sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { let c = 0; for (let j = i - w; j <= i + w; j++) if (j >= 0 && j < nb) c += h[j]; sm[i] = c; }
  const out = [];
  for (let i = 0; i < nb; i++) if (sm[i] >= minC && (i === 0 || sm[i] > sm[i - 1]) && (i === nb - 1 || sm[i] >= sm[i + 1])) out.push({ off: q[o] - R + (i + 0.5) * bw, cnt: sm[i], ax });
  return out;
}
// least squares line held exactly on an axis through the band at offset off
function axisLine(d, q, R, tol, b) {
  const minP = opt('drAxisLineMinPts'), sb = opt('drFitSigmaBand'), sm = opt('drFitSigmaMin'), eLo = opt('drFitEndLo'), eHi = opt('drFitEndHi');
  const far = near(d, q, R * opt('drFitRefineR')), o = b.ax === 0 ? 1 : 0, along = 1 - o;
  let off = b.off, t = tol, idx = [];
  for (let pass = 0; pass < 3; pass++) {
    idx = far.filter((k) => Math.abs((o ? d.y[k] : d.x[k]) - off) <= t);
    if (idx.length < minP) return null;
    let m = 0; for (const k of idx) m += o ? d.y[k] : d.x[k]; m /= idx.length;
    let r2 = 0; for (const k of idx) { const e = (o ? d.y[k] : d.x[k]) - m; r2 += e * e; }
    const sg = Math.sqrt(r2 / Math.max(1, idx.length - 1));
    off = m; t = Math.max(Math.min(tol, sb * sg + d.cell), sm * sg, d.cell);
    b.sigma = sg;
  }
  const ts = idx.map((k) => (along ? d.y[k] : d.x[k])).sort((a, c) => a - c);
  const t0 = ts[Math.floor(ts.length * eLo)], t1 = ts[Math.floor(ts.length * eHi)];
  const dir = b.ax === 0 ? [1, 0] : [0, 1], nrm = [-dir[1], dir[0]];
  const P = (tt) => (b.ax === 0 ? [tt, off] : [off, tt]);
  const c = P((t0 + t1) / 2);
  return { c, dir, nrm, sigma: b.sigma, n: idx.length, a: P(t0), b: P(t1), axis: true };
}
// a band that is too weak or too wide is not a wall (furniture, vegetation, noise): Options drMaxSigma
const good = (d, l) => l && l.n >= opt('drFitGoodPts') && l.sigma <= Math.max(opt('drMaxSigma'), opt('drFitSigmaCell') * d.cell);
function axisFit(d, idx, q, R, tol) {
  const bands = [...axisBands(d, idx, q, R, tol, 0), ...axisBands(d, idx, q, R, tol, 1)];
  if (!bands.length) return [];
  const top = Math.max(...bands.map((b) => b.cnt));
  const strong = bands.filter((b) => b.cnt >= opt('drAxisStrong') * top);
  const lines = [];
  for (const b of strong) { const l = axisLine(d, q, R, tol, { ...b }); if (good(d, l)) lines.push(l); }
  // the band under the cursor wins (a wall has two faces), among strong ones
  lines.sort((u, v) => Math.abs(distTo(u, q[0], q[1])) - Math.abs(distTo(v, q[0], q[1])));
  return lines;
}
// fitted line (and corner when two bands meet) under model point q; R = search radius (model mm)
// mode: 'axis' = only lines along the view X/Y, 'first' = those first, else any direction; 'any' = RANSAC
export function fitAt(d, q, R, mode = 'first') {
  seed = 12345; // same answer for the same cursor position
  const idx = near(d, q, R), tol = Math.max(opt('drFitTolMin'), opt('drFitTolCell') * d.cell), cR = opt('drFitCornerR');
  let line = null, corner = null;
  if (mode !== 'any') {
    const ls = axisFit(d, idx, q, R, tol).filter((l) => Math.abs(distTo(l, q[0], q[1])) <= R);
    if (ls.length) {
      line = ls[0];
      const other = ls.find((l) => l.dir[0] !== line.dir[0]);
      if (other) { const X = intersect(line, other); if (X && Math.hypot(X[0] - q[0], X[1] - q[1]) < R * cR) corner = { q: X, l1: line, l2: other }; }
    }
    if (!line && mode === 'axis') return null;
  }
  if (!line) {
    const L0 = ransac(d, idx, q, R, tol);
    if (!L0) return null;
    line = refine(d, L0, q, R, tol);
    if (!good(d, line)) return null;
    // within 3° of an axis: put it exactly on the axis
    const ang = Math.abs(Math.atan2(line.dir[1], line.dir[0])) % (Math.PI / 2);
    if (Math.min(ang, Math.PI / 2 - ang) < (opt('drFitAxisDeg') * Math.PI) / 180) {
      const ax = Math.abs(line.dir[0]) > Math.abs(line.dir[1]) ? 0 : 1;
      const l = axisLine(d, q, R, tol, { ax, off: ax === 0 ? line.c[1] : line.c[0], cnt: line.n });
      if (good(d, l)) line = l;
    }
    if (Math.abs(distTo(line, q[0], q[1])) > R) return null;
    const L1 = ransac(d, idx, q, R, tol, line);
    if (L1) {
      const l2 = refine(d, L1, q, R, tol);
      if (good(d, l2) && Math.abs(line.dir[0] * l2.dir[1] - line.dir[1] * l2.dir[0]) > opt('drFitCornerCross')) {
        const X = intersect(line, l2);
        if (X && Math.hypot(X[0] - q[0], X[1] - q[1]) < R * cR) corner = { q: X, l1: line, l2 };
      }
    }
  }
  const e = distTo(line, q[0], q[1]);
  return { line, foot: [q[0] - line.nrm[0] * e, q[1] - line.nrm[1] * e], corner };
}
export const lineDist = (l, q) => Math.abs(distTo(l, q[0], q[1]));
export function intersect(l1, l2) {
  const rxs = l1.dir[0] * l2.dir[1] - l1.dir[1] * l2.dir[0];
  if (Math.abs(rxs) < opt('geomEpsTiny')) return null;
  const t = ((l2.c[0] - l1.c[0]) * l2.dir[1] - (l2.c[1] - l1.c[1]) * l2.dir[0]) / rxs;
  return [l1.c[0] + l1.dir[0] * t, l1.c[1] + l1.dir[1] * t];
}
// room outline around q: rays every 1° to the first scan point (occupancy of the fit sample), door
// openings clipped by a running median, simplified (Douglas-Peucker). Returns polygon (model mm) or null.
// Room outline around q, by region growing on a grid (no rays: furniture can't shadow, doors can't leak):
// 1. distance map D (chamfer) from the scan points; 2. flood fill from q over cells farther than CLOSE
//    from any point (openings narrower than 2·CLOSE are closed this way); 3. grow back CLOSE through
//    non-wall cells (the room reaches the wall faces again, not through the openings); 4. fill holes
//    (furniture, columns inside the room count as floor); 5. trace the outer boundary, simplify, and
//    straighten the long edges onto the walls (squareUp). Region touching the grid edge = not closed.
export const CLOSE = 600;
// room straightening defaults (user settings per room: Room Outline popup / Drafting Standard)
// tol = wall straightness (max deviation from a straight wall, mm), close = openings narrower than this are
// closed (mm), offset = whole loop moved out (+) / in (−) (mm)
export const ROOM_DEF = { lowFrom: 1.0, lowTo: 1.3, highFrom: 1.9, highTo: 2.2, method: 'rect', tol: 60, cover: 60, look: 400, maxSize: 30, face: 70, furniture: 2000, minWall: 250, jog: 100, angle: 5, close: 1200, offset: 0, join: 400 };
export function roomAt(d, q, maxR = opt('drRoomMaxR'), opts = {}) {
  const o = { ...ROOM_DEF, ...opts };
  if (o.method === 'rect') return rectAt(d, q, o);
  const oc = Math.max(d.cell * opt('drRoomCellK'), opt('drRoomCellMin')), g = Math.max(opt('drRoomGridMin'), oc);
  const W = Math.ceil((2 * maxR) / g), x0 = q[0] - maxR, y0 = q[1] - maxR, NN = W * W;
  const D = new Float32Array(NN).fill(1e9);
  for (const k of near(d, q, maxR * opt('drRoomNearK'))) { const i = Math.floor((d.x[k] - x0) / g), j = Math.floor((d.y[k] - y0) / g); if (i >= 0 && j >= 0 && i < W && j < W) D[j * W + i] = 0; }
  const s2 = g * Math.SQRT2;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) { const o = j * W + i; let v = D[o]; if (i) v = Math.min(v, D[o - 1] + g); if (j) { v = Math.min(v, D[o - W] + g); if (i) v = Math.min(v, D[o - W - 1] + s2); if (i < W - 1) v = Math.min(v, D[o - W + 1] + s2); } D[o] = v; }
  for (let j = W - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) { const o = j * W + i; let v = D[o]; if (i < W - 1) v = Math.min(v, D[o + 1] + g); if (j < W - 1) { v = Math.min(v, D[o + W] + g); if (i < W - 1) v = Math.min(v, D[o + W + 1] + s2); if (i) v = Math.min(v, D[o + W - 1] + s2); } D[o] = v; }
  const qi = Math.floor((q[0] - x0) / g), qj = Math.floor((q[1] - y0) / g), q0 = qj * W + qi;
  if (D[q0] < g) return null; // clicked on a wall
  const close = Math.min(Math.max(g, (o.close ?? 2 * CLOSE) / 2), D[q0] - g);
  const M = new Uint8Array(NN); // 1 = room
  const nb = [1, -1, W, -W];
  // grow-back with 8 neighbours = square growth: room corners stay square (4 neighbours cut them off)
  const nb8 = [1, -1, W, -W, W + 1, W - 1, -W + 1, -W - 1];
  // 2. flood over open cells
  let st = [q0]; M[q0] = 1; let touch = false;
  while (st.length) { const o = st.pop(), i = o % W, j = (o / W) | 0; if (i === 0 || j === 0 || i === W - 1 || j === W - 1) { touch = true; continue; } for (const n of nb) { const u = o + n; if (!M[u] && D[u] > close) { M[u] = 1; st.push(u); } } }
  if (touch) return null; // not closed: outside, or a wall missing in the slice
  // 3. grow back to the wall faces (BFS rings through non-wall cells)
  let ring = []; for (let o = 0; o < NN; o++) if (M[o]) ring.push(o);
  const free = g * opt('drRoomGrowK');
  for (let k = 0, K = Math.ceil(close / g) + 1; k < K && ring.length; k++) { const nx = []; for (const o of ring) for (const n of nb8) { const u = o + n; if (u >= 0 && u < NN && !M[u] && D[u] >= free) { M[u] = 1; nx.push(u); } } ring = nx; }
  // 4. fill holes: everything not reachable from the grid edge without crossing the room
  const out = new Uint8Array(NN); st = [];
  for (let i = 0; i < W; i++) for (const o of [i, (W - 1) * W + i, i * W, i * W + W - 1]) if (!M[o] && !out[o]) { out[o] = 1; st.push(o); }
  while (st.length) { const o = st.pop(), i = o % W; for (const n of nb) { const u = o + n; if (u < 0 || u >= NN || (n === 1 && i === W - 1) || (n === -1 && i === 0)) continue; if (!M[u] && !out[u]) { out[u] = 1; st.push(u); } } }
  // 5. outer boundary (Moore tracing on room = !out), cell corners → model mm
  const R = (i, j) => i >= 0 && j >= 0 && i < W && j < W && !out[j * W + i];
  let si = -1, sj = -1; for (let j = 0; j < W && si < 0; j++) for (let i = 0; i < W; i++) if (R(i, j)) { si = i; sj = j; break; }
  if (si < 0) return null;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const pts = []; let ci = si, cj = sj, bd = 4, guard = 0;
  do {
    pts.push([x0 + (ci + 0.5) * g, y0 + (cj + 0.5) * g]);
    let k = 0, found = false;
    for (; k < 8; k++) { const dd = (bd + 1 + k) % 8, ni = ci + dirs[dd][0], nj = cj + dirs[dd][1]; if (R(ni, nj)) { bd = (dd + 4) % 8; ci = ni; cj = nj; found = true; break; } }
    if (!found) break;
  } while ((ci !== si || cj !== sj) && ++guard < 4 * NN);
  if (pts.length < 4) return null;
  let poly = simplify(pts, Math.max(opt('drSimplifyMin'), o.tol ?? 30, g * opt('drSimplifyCellK')));
  if (!poly || poly.length < 3) return poly;
  return offsetPoly(roomShape(d, poly, oc, o), o.offset || 0);
}
function roomShape(d, poly, oc, o) {
  // scan noise makes small steps along every wall: straighten first (so squareUp sees whole walls),
  // fit the long walls onto the scan points, then straighten again (axis snap of the refitted lines)
  if (d.grid) { const sq = squareUp(d, poly, oc); if (sq !== poly) return straighten(sq, o); poly = straighten(poly, o); const sq2 = squareUp(d, poly, oc); return straighten(sq2, o); }
  return straighten(poly, o);
}
// replace the outline's long edges by lines fitted through the wall points next to them; corners become the
// intersections of neighbouring walls (the ray outline cuts corners and follows the scatter)
function squareUp(d, poly, oc) {
  const minL = Math.max(opt('drSqMinWall'), oc * opt('drSqMinWallK')), lines = [];
  const add = opt('drSqNearAdd'), tLo = opt('drSqTrimLo'), tHi = opt('drSqTrimHi'), band = Math.max(opt('drSqBand'), oc * opt('drSqBandK')), minP = opt('drSquareMinPts');
  const fs = opt('drSqFaceSigma'), maxS = opt('drSqMaxSigma'), maxT = opt('drSqMaxTurn'), sameX = opt('drSqSameCross'), sameD = opt('drSqSameDist');
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (L < minL) continue;
    const dir = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], nr = [-dir[1], dir[0]], mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const idx = near(d, mid, L / 2 + add).filter((k) => { const dx = d.x[k] - A[0], dy = d.y[k] - A[1], t = dx * dir[0] + dy * dir[1]; return t > L * tLo && t < L * tHi && Math.abs(dx * nr[0] + dy * nr[1]) < band; });
    if (idx.length < minP) continue;
    let f = lsq(d, idx);
    // second pass: the room-side face only (points within 3σ of the fit)
    const fb = Math.max(fs * f.sigma, d.cell), idx2 = idx.filter((k) => Math.abs(distTo(f, d.x[k], d.y[k])) <= fb);
    if (idx2.length >= minP) f = lsq(d, idx2);
    if (f.sigma > maxS || Math.abs(f.dir[0] * dir[1] - f.dir[1] * dir[0]) > maxT) continue; // not a clean wall along this edge
    const prev = lines[lines.length - 1];
    if (prev && Math.abs(prev.dir[0] * f.dir[1] - prev.dir[1] * f.dir[0]) < sameX && Math.abs(distTo(prev, f.c[0], f.c[1])) < sameD) continue; // same wall
    lines.push(f);
  }
  while (lines.length > 3) { const a = lines[lines.length - 1], b = lines[0]; if (Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]) < sameX && Math.abs(distTo(a, b.c[0], b.c[1])) < sameD) lines.pop(); else break; }
  if (lines.length < 3) return poly;
  // corners from neighbouring walls; nearly parallel neighbours (a jog, a niche) would meet far away:
  // then the whole squared outline is not trusted and the ray outline is kept
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i], b = lines[(i + 1) % lines.length];
    if (Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]) < opt('drSqCornerCross')) return poly; // < 15°
    const X = intersect(a, b); if (X) out.push(X);
  }
  if (out.length < 3) return poly;
  // sanity: every corner close to the ray outline's box, and about the same area
  const bx = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))], m = opt('drSqBoxMargin');
  if (out.some((p) => p[0] < bx[0] - m || p[0] > bx[2] + m || p[1] < bx[1] - m || p[1] > bx[3] + m)) return poly;
  const ar = (P) => Math.abs(P.reduce((s, p, i) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0)) / 2;
  const k = ar(out) / (ar(poly) || 1);
  return k > opt('drShapeAreaLo') && k < opt('drShapeAreaHi') ? out : poly;
}
// Straighten an outline: edges shorter than minWall are dropped (scan-noise steps), edges within `angle`
// of X/Y become exactly horizontal/vertical, neighbouring parallel walls closer than `jog` become one wall
// (length-weighted position). Corners = intersections of neighbouring walls; two parallel neighbours
// (a real step deeper than jog) get a square step between them. Returns the input when the result is
// not trustworthy (area changed > 20 %, corner far outside).
export function straighten(poly, { minWall = ROOM_DEF.minWall, jog = ROOM_DEF.jog, angle = ROOM_DEF.angle } = {}) {
  const n = poly?.length || 0;
  if (n < 4) return poly;
  const tn = Math.tan((Math.max(0, Math.min(45, angle)) * Math.PI) / 180);
  const eps = opt('geomEps'), sameSin = Math.sin((Math.max(angle, opt('drStraightMinDeg')) * Math.PI) / 180), cornerX = opt('drStraightCornerCross'), one = opt('drStraightMergeMm');
  let W = [];
  for (let i = 0; i < n; i++) {
    const A = poly[i], B = poly[(i + 1) % n], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    if (L < eps) continue;
    const cls = Math.abs(dy) <= Math.abs(dx) * tn ? 'h' : Math.abs(dx) <= Math.abs(dy) * tn ? 'v' : 'd';
    W.push({ cls, A, B, L, off: cls === 'h' ? (A[1] + B[1]) / 2 : cls === 'v' ? (A[0] + B[0]) / 2 : 0, short: L < minWall });
  }
  if (W.some((w) => !w.short)) W = W.filter((w) => !w.short); else return poly;
  const lineOf = (w) => addN(w.cls === 'h' ? { c: [(w.A[0] + w.B[0]) / 2, w.off], dir: [Math.sign(w.B[0] - w.A[0]) || 1, 0] } : w.cls === 'v' ? { c: [w.off, (w.A[1] + w.B[1]) / 2], dir: [0, Math.sign(w.B[1] - w.A[1]) || 1] } : { c: [(w.A[0] + w.B[0]) / 2, (w.A[1] + w.B[1]) / 2], dir: [(w.B[0] - w.A[0]) / w.L, (w.B[1] - w.A[1]) / w.L] });
  function addN(l) { l.nrm = [-l.dir[1], l.dir[0]]; return l; }
  const same = (a, b) => {
    if (a.cls !== b.cls) return false;
    if (a.cls !== 'd') return Math.abs(a.off - b.off) <= jog;
    const la = lineOf(a), lb = lineOf(b);
    if (Math.abs(la.dir[0] * lb.dir[1] - la.dir[1] * lb.dir[0]) > sameSin || la.dir[0] * lb.dir[0] + la.dir[1] * lb.dir[1] < 0) return false;
    return Math.abs(distTo(la, lb.c[0], lb.c[1])) <= jog;
  };
  const merge = (a, b) => { const L = a.L + b.L; return { cls: a.cls, A: a.A, B: b.B, L: Math.hypot(b.B[0] - a.A[0], b.B[1] - a.A[1]) || L, off: (a.off * a.L + b.off * b.L) / L, wl: L }; };
  for (let changed = true; changed && W.length > 2; ) {
    changed = false;
    for (let i = 0; i < W.length && W.length > 2; i++) { const j = (i + 1) % W.length; if (same(W[i], W[j])) { const m = merge(W[i], W[j]); m.L = W[i].L + W[j].L; if (j === 0) { W[i] = m; W.shift(); } else W.splice(i, 2, m); changed = true; i--; } }
  }
  if (W.length < 3) return poly;
  const out = [];
  for (let i = 0; i < W.length; i++) {
    const a = W[i], b = W[(i + 1) % W.length], la = lineOf(a), lb = lineOf(b);
    const cr = Math.abs(la.dir[0] * lb.dir[1] - la.dir[1] * lb.dir[0]);
    const X = cr > cornerX ? intersect(la, lb) : null; // ≥ 10°: a real corner
    if (X) { out.push(X); continue; }
    // parallel neighbours: square step at the junction (between a's end and b's start)
    const J = [(a.B[0] + b.A[0]) / 2, (a.B[1] + b.A[1]) / 2];
    const foot = (l) => { const t = (J[0] - l.c[0]) * l.dir[0] + (J[1] - l.c[1]) * l.dir[1]; return [l.c[0] + l.dir[0] * t, l.c[1] + l.dir[1] * t]; };
    out.push(foot(la), foot(lb));
  }
  // clean: duplicates and collinear points
  const P = [];
  for (const p of out) { const l = P[P.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > one) P.push(p); }
  if (P.length > 1 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) <= one) P.pop();
  for (let k = 0; k < P.length && P.length > 3; ) {
    const a = P[(k - 1 + P.length) % P.length], b = P[k], c = P[(k + 1) % P.length];
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1) < one) P.splice(k, 1); else k++;
  }
  if (P.length < 3) return poly;
  const ar = (Q) => Math.abs(Q.reduce((s, p, i) => s + p[0] * Q[(i + 1) % Q.length][1] - Q[(i + 1) % Q.length][0] * p[1], 0)) / 2;
  const bx = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))], m = Math.max(opt('drSqBoxMargin'), jog * opt('drStraightJogK'));
  if (P.some((p) => p[0] < bx[0] - m || p[0] > bx[2] + m || p[1] < bx[1] - m || p[1] > bx[3] + m)) return poly;
  const k = ar(P) / (ar(poly) || 1);
  return k > opt('drShapeAreaLo') && k < opt('drShapeAreaHi') ? P : poly;
}

// Rectangular room from the click (Wouter's method): look from the click along +X, −X, +Y, −Y for the first
// wall: a straight band (± tol) whose points cover at least `cover` of the room's length. Furniture is short
// and does not cover the length, so it is skipped. Then repeat with the real room length (3 rounds).
// Returns the 4 corners at the wall faces (inside), with the offset applied, or null.
export function rectAt(d, q, o = {}) {
  const cMin = opt('drRectCoverMin'), cMax = opt('drRectCoverMax'), t50 = opt('drRectStart'), minP = opt('drRectMinPts'), hiK = opt('drRectHighCover'), fb = opt('drRectFaceBin'), back = opt('drRectFaceBack'), stepMin = opt('drRectStepMin');
  const tol = Math.max(opt('drRectTolMin'), o.tol ?? 60), cover = Math.min(cMax, Math.max(cMin, (o.cover ?? 50) / 100)), maxR = (o.maxSize ?? 30) * 1000;
  const ids = near(d, q, maxR * opt('drRoomNearK')), X = d.x, Y = d.y, bin = opt('drRectBin');
  // wall along the direction of axis a (0: wall ⟂ x, i.e. at an x position), searched from q in sign sg
  const find = (a, sg, lo, hi) => {
    const b = 1 - a, nb = Math.max(3, Math.ceil((hi - lo) / bin)), step = Math.max(stepMin, tol / 2);
    // points in the strip [lo, hi] (along the wall), keyed by distance from q (perpendicular)
    const pts = [], S = d.src;
    for (const k of ids) { const c = a === 0 ? Y[k] : X[k]; if (c < lo || c > hi) continue; const t = ((a === 0 ? X[k] : Y[k]) - q[a]) * sg; if (t > t50 && t < maxR) pts.push([t, c, S ? S[k] : 0]); }
    if (pts.length < minP) return null;
    pts.sort((u, v) => u[0] - v[0]);
    // slide a band (± tol) outward; the first band that covers enough is a wall candidate. Within `look`
    // mm past it the densest covering band wins (furniture / radiators in front of the wall are lighter)
    const look = Math.max(0, o.look ?? 400);
    // with two slices: furniture shows only in the low slice. A band that covers enough but is (almost) empty
    // in the high slice is skipped when a full-height wall (covered in the high slice too) follows within
    // `furniture` mm (desks, cabinets, tables standing in the room)
    const two = (d.slices || 1) > 1, furn = Math.max(0, o.furniture ?? 2000), bands = [];
    let j0 = 0;
    for (let t = t50 + tol; t < maxR; t += step) {
      while (j0 < pts.length && pts[j0][0] < t - tol) j0++;
      const occ = new Uint8Array(nb), occH = new Uint8Array(nb); let n = 0, fr = 0, frH = 0, j = j0;
      for (; j < pts.length && pts[j][0] <= t + tol; j++) { const i = Math.min(nb - 1, Math.floor((pts[j][1] - lo) / bin)); if (!occ[i]) { occ[i] = 1; fr++; } if (pts[j][2] === 1 && !occH[i]) { occH[i] = 1; frH++; } n++; }
      if (fr / nb >= cover) bands.push({ t, n, j0, j1: j, full: frH / nb >= cover * hiK });
    }
    if (!bands.length) return null;
    // runs of consecutive covering bands
    const runs = [];
    for (const b of bands) { const r = runs[runs.length - 1]; if (r && b.t - r.t1 <= step + 1) { r.t1 = b.t; r.full ||= b.full; } else runs.push({ t0: b.t, t1: b.t, full: b.full }); }
    const isWall = (r) => !two || r.full;
    let first = runs[0].t0;
    if (!isWall(runs[0])) { const f = runs.find(isWall); if (f && f.t0 - first <= furn) first = f.t0; }
    let best = null;
    for (const b of bands) { if (b.t < first) continue; if (b.t > first + look) break; if (!best || b.n > best.n) best = b; }
    if (best) {
      if (o.face === 0) {
        // wall face = median of the band (scan points scatter evenly around the surface)
        const band = []; for (let j = best.j0; j < best.j1; j++) band.push(pts[j][0]);
        band.sort((u, v) => u - v);
        return q[a] + sg * band[Math.floor(band.length * 0.5)];
      }
      // wall face = room side of the scan scatter: from the room, the first place where the point density
      // (10 mm bins, smoothed) reaches half of the wall's peak. Takes the near face of a thin wall even when
      // the far face (other room) was scanned denser, and does not land in the middle of the scatter.
      const t0 = Math.max(t50, first - back * tol), t1 = pts[best.j1 - 1][0] + 1, nbin = Math.ceil((t1 - t0) / fb) + 1;
      const h = new Float64Array(nbin);
      for (const [t] of pts) if (t >= t0 && t < t1) h[Math.floor((t - t0) / fb)]++;
      const hs = h.map((_, i) => (h[Math.max(0, i - 1)] + h[i] + h[Math.min(nbin - 1, i + 1)]) / 3);
      let pk = 0; for (const v of hs) pk = Math.max(pk, v);
      const thr = pk * Math.min(cMax, Math.max(cMin, (o.face ?? 70) / 100));
      for (let i = 0; i < nbin; i++) if (hs[i] >= thr) {
        const prev = i ? hs[i - 1] : 0, f = hs[i] > prev ? (thr - prev) / (hs[i] - prev) : 0;
        return q[a] + sg * (t0 + (i - 1 + f) * fb + fb / 2);
      }
    }
    return null;
  };
  // first round: a short strip around the click, widened when a direction finds nothing (an opening, a
  // window right in front of the click); later rounds: the room's own length minus the corners
  const first = (a, sg) => { for (const w of opt('drRectStrips')) { const r = find(a, sg, q[1 - a] - w, q[1 - a] + w); if (r != null) return r; } return null; };
  let x0 = first(0, -1), x1 = first(0, 1), y0 = first(1, -1), y1 = first(1, 1);
  if (x0 == null || x1 == null || y0 == null || y1 == null) return null;
  for (let r = 0; r < 3; r++) {
    const m = opt('drRectCornerSkip'); // stay out of the corners (perpendicular walls)
    const nx0 = find(0, -1, y0 + m, y1 - m), nx1 = find(0, 1, y0 + m, y1 - m), ny0 = find(1, -1, x0 + m, x1 - m), ny1 = find(1, 1, x0 + m, x1 - m);
    if (nx0 == null || nx1 == null || ny0 == null || ny1 == null) return null;
    if (nx0 === x0 && nx1 === x1 && ny0 === y0 && ny1 === y1) break;
    x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1;
  }
  return offsetPoly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], o.offset || 0);
}

// move every edge of a closed outline by `dist` mm along its outward normal (+ = bigger), mitred corners
export function offsetPoly(P, dist) {
  if (!P || P.length < 3 || !dist) return P;
  let A2 = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; A2 += p[0] * q[1] - q[0] * p[1]; }
  const sg = A2 > 0 ? 1 : -1, n = P.length, L = [];
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, dir = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], nr = [dir[1] * sg, -dir[0] * sg]; L.push({ c: [a[0] + nr[0] * dist, a[1] + nr[1] * dist], dir, nr }); }
  const out = [], par = opt('drOffsetParallel');
  for (let i = 0; i < n; i++) { const a = L[(i - 1 + n) % n], b = L[i], X = Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]) > par ? intersect(a, b) : null; out.push(X || [P[i][0] + b.nr[0] * dist, P[i][1] + b.nr[1] * dist]); }
  return out;
}

function simplify(pts, tol) {
  // closed ring: split at two far-apart points, Douglas-Peucker on both halves
  const dp = (P, a, b) => {
    let mx = 0, at = -1; const A = P[a], B = P[b], dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const e = Math.abs((P[i][0] - A[0]) * dy - (P[i][1] - A[1]) * dx) / l; if (e > mx) { mx = e; at = i; } }
    return mx > tol ? [...dp(P, a, at).slice(0, -1), ...dp(P, at, b)] : [a, b];
  };
  const far = (from) => { let f = 0, fd = -1; for (let i = 0; i < pts.length; i++) { const e = Math.hypot(pts[i][0] - from[0], pts[i][1] - from[1]); if (e > fd) { fd = e; f = i; } } return f; };
  const f = far(pts[0]), ring = [...pts.slice(f), ...pts.slice(0, f), pts[f]];
  const g = (() => { let k = 0, kd = -1; for (let i = 0; i < ring.length; i++) { const e = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (e > kd) { kd = e; k = i; } } return k; })();
  const idx = [...dp(ring, 0, g).slice(0, -1), ...dp(ring, g, ring.length - 1)];
  const keep = idx.map((i) => ring[i]);
  keep.pop();
  return keep.length >= 3 ? keep : null;
}

// opening (door / window) under q: q lies in a gap of a fitted wall line, between two wall ends.
// The wall is fitted from the points on both sides (search radius Rb), the gap is the empty stretch of the
// band around q's foot (≥ 250 mm). Returns {line, a, b (wall ends, model mm), width} or null.
export function openingAt(d, q, R, Rb = opt('drOpenSearch')) {
  const idx = near(d, q, Rb), tol = Math.max(opt('drFitTolMin'), opt('drFitTolCell') * d.cell), fk = opt('drOpenFitK'), minW = opt('drOpeningMin');
  const L0 = ransac(d, idx, q, Rb * fk, tol);
  if (!L0) return null;
  const line = refine(d, L0, q, Rb * fk, tol);
  if (!line) return null;
  const off = distTo(line, q[0], q[1]);
  if (Math.abs(off) > Math.max(R, opt('drOpenOffSigma') * line.sigma + opt('drOpenOffAdd'))) return null;
  const tq = (q[0] - line.c[0]) * line.dir[0] + (q[1] - line.c[1]) * line.dir[1];
  const band = Math.max(opt('drOpenBandSigma') * line.sigma, d.cell * opt('drOpenBandCell'));
  const ts = near(d, q, Rb * opt('drOpenBandR')).filter((k) => Math.abs(distTo(line, d.x[k], d.y[k])) <= band).map((k) => (d.x[k] - line.c[0]) * line.dir[0] + (d.y[k] - line.c[1]) * line.dir[1]);
  let lo = -Infinity, hi = Infinity;
  for (const t of ts) { if (t <= tq && t > lo) lo = t; if (t >= tq && t < hi) hi = t; }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < minW) return null;
  // wall ends: the robust end of each side (ignore single stray points inside the gap: need 5 points within 50 mm)
  const endN = opt('drOpenEndPts') - 1, endMm = opt('drOpenEndMm');
  const sideEnd = (dirSign) => {
    const s = ts.filter((t) => (dirSign < 0 ? t <= tq : t >= tq)).sort((a, b) => (dirSign < 0 ? b - a : a - b));
    for (let i = 0; i + endN < s.length; i++) if (Math.abs(s[i + endN] - s[i]) < endMm) return s[i];
    return null;
  };
  const e1 = sideEnd(-1), e2 = sideEnd(1);
  if (e1 == null || e2 == null || e2 - e1 < minW) return null;
  const P = (t) => [line.c[0] + line.dir[0] * t, line.c[1] + line.dir[1] * t];
  return { line, a: P(e1), b: P(e2), width: e2 - e1 };
}

// Joining two room spaces that sit on both sides of a wall (Shift+click with Room Outline): each space
// stops at its own wall face, so they never touch. Find two facing, parallel walls of A and B at most
// `maxGap` mm apart that overlap along their length; in that wall strip look for doorways = runs of at
// least `minOpen` mm without scan points (low slice only: door heads show in the high slice). Returns
// [{rect: [[x,y]...4], width}] bridges (one per doorway); without a doorway one bridge over the whole shared
// length ({full: true}: a cabinet row or closed door between); {reason: 'far'} when no such wall.
export function joinAcross(A, B, d, maxGap = 400, minOpen = opt('drJoinMinOpen')) {
  const at = opt('drRoomAxisTol'), probe = opt('drJoinProbe'), bin = opt('drJoinBin'), nAdd = opt('drJoinNearAdd'), fTol = opt('drJoinFaceTol'), eMin = opt('drJoinEmptyMin'), eK = opt('drJoinEmptyK');
  const edges = (P) => P.map((p, i) => [p, P[(i + 1) % P.length]]).filter(([a, b]) => Math.abs(a[0] - b[0]) < at || Math.abs(a[1] - b[1]) < at);
  const inside = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const strips = [];
  for (const [a1, a2] of edges(A)) for (const [b1, b2] of edges(B)) {
    for (const ax of [0, 1]) { // ax = coordinate across the wall (0: vertical walls at x = c, 1: horizontal walls at y = c)
      const u = 1 - ax;
      if (Math.abs(a1[ax] - a2[ax]) > at || Math.abs(b1[ax] - b2[ax]) > at || Math.abs(a1[u] - a2[u]) < at || Math.abs(b1[u] - b2[u]) < at) continue;
      const ca = a1[ax], cb = b1[ax], g = Math.abs(ca - cb);
      if (g < at || g > maxGap) continue;
      const lo = Math.max(Math.min(a1[u], a2[u]), Math.min(b1[u], b2[u])), hi = Math.min(Math.max(a1[u], a2[u]), Math.max(b1[u], b2[u]));
      if (hi - lo < minOpen) continue;
      // the strip between the faces must be outside both spaces, each space on its own side
      const m = (ca + cb) / 2, um = (lo + hi) / 2, pt = (c, w) => (ax === 0 ? [c, w] : [w, c]), s = Math.sign(cb - ca);
      if (inside(A, ...pt(m, um)) || inside(B, ...pt(m, um)) || !inside(A, ...pt(ca - s * probe, um)) || !inside(B, ...pt(cb + s * probe, um))) continue;
      strips.push({ ax, c0: Math.min(ca, cb), c1: Math.max(ca, cb), lo, hi });
    }
  }
  if (!strips.length) return { reason: 'far' };
  const out = [];
  for (const S of strips) {
    const u = 1 - S.ax, nb = Math.ceil((S.hi - S.lo) / bin), cnt = new Uint32Array(nb), wmin = new Float64Array(nb).fill(Infinity), wmax = new Float64Array(nb).fill(-Infinity);
    const mid = S.ax === 0 ? [(S.c0 + S.c1) / 2, (S.lo + S.hi) / 2] : [(S.lo + S.hi) / 2, (S.c0 + S.c1) / 2];
    for (const k of near(d, mid, Math.hypot(S.c1 - S.c0, S.hi - S.lo) / 2 + nAdd)) {
      if (d.src && d.slices > 1 && d.src[k] !== 0) continue;
      const p = [d.x[k], d.y[k]], c = p[S.ax], w = p[u];
      if (c < S.c0 - fTol || c > S.c1 + fTol || w < S.lo || w >= S.hi) continue;
      const b = Math.min(nb - 1, Math.floor((w - S.lo) / bin)); cnt[b]++; wmin[b] = Math.min(wmin[b], w); wmax[b] = Math.max(wmax[b], w);
    }
    const full = [...cnt].filter((x) => x > 0).sort((x, y) => x - y), med = full.length ? full[full.length >> 1] : 0, lim = Math.max(eMin, eK * med);
    for (let i = 0; i < nb;) {
      if (cnt[i] >= lim) { i++; continue; }
      let j = i; while (j < nb && cnt[j] < lim) j++;
      // doorway ends = the last / first jamb point next to the empty run (not the bin edges)
      const w0 = i > 0 && isFinite(wmax[i - 1]) ? wmax[i - 1] : S.lo + i * bin, w1 = j < nb && isFinite(wmin[j]) ? wmin[j] : Math.min(S.hi, S.lo + j * bin);
      if (w1 - w0 >= minOpen) {
        const r = S.ax === 0 ? [[S.c0, w0], [S.c1, w0], [S.c1, w1], [S.c0, w1]] : [[w0, S.c0], [w1, S.c0], [w1, S.c1], [w0, S.c1]];
        out.push({ rect: r, width: w1 - w0 });
      }
      i = j;
    }
  }
  if (out.length) return out;
  // no doorway (furniture or a closed door between): join over the whole shared length of the widest-overlap strip
  const S = strips.sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))[0];
  return [{ rect: S.ax === 0 ? [[S.c0, S.lo], [S.c1, S.lo], [S.c1, S.hi], [S.c0, S.hi]] : [[S.lo, S.c0], [S.hi, S.c0], [S.hi, S.c1], [S.lo, S.c1]], width: S.hi - S.lo, full: true }];
}
