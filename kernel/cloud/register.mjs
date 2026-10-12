// ICP refinement (point cloud worker). Coarse to fine: the reference is thinned to a voxel grid per
// level (voxel = maxD / 8), each moving sample point gets its nearest reference point within maxD, the
// local plane (PCA of the nearest reference points, or the given normal for part surfaces) and a
// point-to-plane residual. The worst pairs are trimmed (overlap), the linearised 6-dof (or 4-dof with
// `level`: rotation about Z only) system is solved, and maxD shrinks towards 3x the RMS.
// All coordinates in one shared frame (document frame, m), Float64.
import { rotVec, rot, solveSym, IDENT, compose } from '../../shared/rigid.mjs';

const F64 = (b) => (b ? new Float64Array(b) : null);
const F32 = (b) => (b ? new Float32Array(b) : null);

// numeric cell keys (cells relative to the reference box, padded)
function cellKeyer(P, n, cell) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) { const v = P[i * 3 + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; }
  const inv = 1 / cell, o = mn.map((v) => v - 2 * cell), dim = [0, 1, 2].map((d) => Math.floor((mx[d] - o[d]) * inv) + 4);
  return { inv, o, dim, cx: (x) => Math.floor((x - o[0]) * inv), cy: (y) => Math.floor((y - o[1]) * inv), cz: (z) => Math.floor((z - o[2]) * inv), key: (i, j, k) => i + dim[0] * (j + dim[1] * k) };
}
// voxel thinning of the reference: one point (the first) per voxel, normal carried along
function thin(P, N, n, vox) {
  const K = cellKeyer(P, n, vox), seen = new Set(), keep = [];
  for (let i = 0; i < n; i++) {
    const key = K.key(K.cx(P[i * 3]), K.cy(P[i * 3 + 1]), K.cz(P[i * 3 + 2]));
    if (seen.has(key)) continue;
    seen.add(key); keep.push(i);
  }
  const out = new Float64Array(keep.length * 3), nrm = N ? new Float32Array(keep.length * 3) : null;
  keep.forEach((i, k) => { for (let d = 0; d < 3; d++) { out[k * 3 + d] = P[i * 3 + d]; if (N) nrm[k * 3 + d] = N[i * 3 + d]; } });
  return { P: out, N: nrm, n: keep.length };
}
// cell grid over thinned points (CSR: cells -> sorted point ids)
function grid(P, n, cell) {
  const K = cellKeyer(P, n, cell), keys = new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = K.key(K.cx(P[i * 3]), K.cy(P[i * 3 + 1]), K.cz(P[i * 3 + 2]));
  const ids = new Int32Array(n).map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const start = new Map();
  for (let k = 0; k < n; k++) { const key = keys[ids[k]]; if (!k || key !== keys[ids[k - 1]]) start.set(key, k); }
  return { K, ids, keys, start, n };
}
// k nearest within the 3x3x3 cells around p (cell >= search radius)
function nearK(G, P, x, y, z, K, r2, bi, bd) {
  const C = G.K, cx = C.cx(x), cy = C.cy(y), cz = C.cz(z);
  if (cx < 1 || cy < 1 || cz < 1 || cx > C.dim[0] - 2 || cy > C.dim[1] - 2 || cz > C.dim[2] - 2) return 0;
  let m = 0;
  for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
    const key = C.key(cx + a, cy + b, cz + c), s0 = G.start.get(key);
    if (s0 === undefined) continue;
    for (let s = s0; s < G.n && G.keys[G.ids[s]] === key; s++) {
      const j = G.ids[s], dx = P[j * 3] - x, dy = P[j * 3 + 1] - y, dz = P[j * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d > r2 || (m === K && d >= bd[m - 1])) continue;
      let q = m < K ? m++ : K - 1;
      while (q > 0 && bd[q - 1] > d) { bd[q] = bd[q - 1]; bi[q] = bi[q - 1]; q--; }
      bd[q] = d; bi[q] = j;
    }
  }
  return m;
}
// normal of the plane through the ids (smallest eigenvector of the covariance, power iteration on the inverse-ish)
function pcaNormal(P, ids, m) {
  let mx = 0, my = 0, mz = 0;
  for (let k = 0; k < m; k++) { const j = ids[k] * 3; mx += P[j]; my += P[j + 1]; mz += P[j + 2]; }
  mx /= m; my /= m; mz /= m;
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
  for (let k = 0; k < m; k++) { const j = ids[k] * 3, x = P[j] - mx, y = P[j + 1] - my, z = P[j + 2] - mz; a += x * x; b += x * y; c += x * z; d += y * y; e += y * z; f += z * z; }
  // smallest eigenvector of [[a b c][b d e][c e f]]: largest of (tr*I - C)
  const tr = a + d + f;
  const A = [tr - a, -b, -c, -b, tr - d, -e, -c, -e, tr - f];
  let v = [0.577, 0.577, 0.577];
  for (let it = 0; it < 12; it++) { const w = rot(A, v), l = Math.hypot(...w) || 1; v = w.map((x) => x / l); }
  // curvature-like flatness check: smallest eigenvalue / trace
  const Cv = [a * v[0] + b * v[1] + c * v[2], b * v[0] + d * v[1] + e * v[2], c * v[0] + e * v[1] + f * v[2]];
  const lam = v[0] * Cv[0] + v[1] * Cv[1] + v[2] * Cv[2];
  return { n: v, flat: tr > 0 ? lam / tr : 1 };
}

// mov, ref: Float64 xyz buffers; refN: optional Float32 normals; T0: start transform of mov
export function icp({ mov, nmov, ref, nref, refN, T0, maxDist, minDist = 0.002, iters = 40, overlap = 0.9, level = false }, progress) {
  const M = F64(mov), Rp = F64(ref), RN = F32(refN);
  let T = T0 ? { R: T0.R.slice(), t: T0.t.slice() } : IDENT();
  const hist = [];
  let maxD = maxDist, last = null, it = 0;
  const bi = new Int32Array(12), bd = new Float64Array(12);
  let L = null, Lmax = -1;
  const build = () => { const vox = Math.max(minDist / 2, maxD / 8); L = thin(Rp, RN, nref, vox); L.G = grid(L.P, L.n, maxD); Lmax = maxD; };
  build();
  const p = [0, 0, 0];
  const pairs = new Float64Array(nmov * 7); // px py pz nx ny nz r
  const dist = new Float64Array(nmov);
  for (; it < iters; it++) {
    if (maxD < Lmax / 2.5) build();
    // ---- correspondences ----
    let np = 0;
    const r2 = maxD * maxD;
    for (let i = 0; i < nmov; i++) {
      p[0] = M[i * 3]; p[1] = M[i * 3 + 1]; p[2] = M[i * 3 + 2];
      const q = rot(T.R, p); q[0] += T.t[0]; q[1] += T.t[1]; q[2] += T.t[2];
      const m = nearK(L.G, L.P, q[0], q[1], q[2], RN ? 1 : 8, r2, bi, bd);
      if (!m) continue;
      let n, flat = 0;
      if (RN) { const j = bi[0] * 3; n = [RN[j], RN[j + 1], RN[j + 2]]; }
      else { if (m < 4) continue; ({ n, flat } = pcaNormal(L.P, bi, m)); if (flat > 0.08) continue; }
      const j = bi[0] * 3, r = (q[0] - L.P[j]) * n[0] + (q[1] - L.P[j + 1]) * n[1] + (q[2] - L.P[j + 2]) * n[2];
      const o = np * 7;
      pairs[o] = q[0]; pairs[o + 1] = q[1]; pairs[o + 2] = q[2]; pairs[o + 3] = n[0]; pairs[o + 4] = n[1]; pairs[o + 5] = n[2]; pairs[o + 6] = r;
      dist[np] = Math.abs(r); np++;
    }
    if (np < (level ? 10 : 20)) { last = { np, rms: NaN }; break; }
    // ---- trim ----
    const sorted = Float64Array.from(dist.subarray(0, np)).sort();
    const cut = sorted[Math.min(np - 1, Math.max(0, Math.floor(np * overlap) - 1))];
    // ---- point to plane normal equations; x = [a b c tx ty tz] (level: [c tx ty tz]) ----
    const D = level ? 4 : 6, A = Array.from({ length: D }, () => new Array(D).fill(0)), b = new Array(D).fill(0);
    let used = 0, s2 = 0;
    // centre the rotation at the pairs' centroid (better conditioned)
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < np; k++) { cx += pairs[k * 7]; cy += pairs[k * 7 + 1]; cz += pairs[k * 7 + 2]; }
    cx /= np; cy /= np; cz /= np;
    const J = new Array(D);
    for (let k = 0; k < np; k++) {
      const o = k * 7, r = pairs[o + 6];
      if (Math.abs(r) > cut) continue;
      const x = pairs[o] - cx, y = pairs[o + 1] - cy, z = pairs[o + 2] - cz, nx = pairs[o + 3], ny = pairs[o + 4], nz = pairs[o + 5];
      const ax = y * nz - z * ny, ay = z * nx - x * nz, az = x * ny - y * nx;
      if (level) { J[0] = az; J[1] = nx; J[2] = ny; J[3] = nz; } else { J[0] = ax; J[1] = ay; J[2] = az; J[3] = nx; J[4] = ny; J[5] = nz; }
      for (let u = 0; u < D; u++) { b[u] -= J[u] * r; for (let v = u; v < D; v++) A[u][v] += J[u] * J[v]; }
      used++; s2 += r * r;
    }
    for (let u = 0; u < D; u++) { for (let v = 0; v < u; v++) A[u][v] = A[v][u]; A[u][u] += 1e-9 * used; }
    const x = solveSym(A, b);
    const rms = Math.sqrt(s2 / Math.max(1, used));
    last = { np, used, rms, maxD };
    hist.push({ it: it + 1, rms, used, maxD });
    progress?.(1);
    if (!x) break;
    const [ra, rb, rc, tx, ty, tz] = level ? [0, 0, x[0], x[1], x[2], x[3]] : x;
    const dR = rotVec(ra, rb, rc), c = [cx, cy, cz];
    // p' = dR (p - c) + c + t
    const dT = { R: dR, t: rot(dR, c).map((v, i) => c[i] - v + [tx, ty, tz][i]) };
    T = compose(dT, T);
    const step = Math.hypot(ra, rb, rc) + Math.hypot(tx, ty, tz);
    // shrink the search distance towards the noise level
    const next = Math.max(minDist, Math.min(maxD, 4 * rms + minDist));
    const prev = hist.length > 1 ? hist[hist.length - 2].rms : Infinity;
    if (next >= maxD * 0.95 && (step < 1e-7 || (step < 2e-5 && Math.abs(prev - rms) < 0.005 * rms))) { it++; break; }
    maxD = next;
  }
  // final overlap: share of sample points with a partner within max(3 rms, minDist*2)
  const tol = Math.max(3 * (last?.rms || 0), minDist * 2), r2 = Math.max(tol, maxD) ** 2;
  let inl = 0;
  for (let i = 0; i < nmov; i++) {
    p[0] = M[i * 3]; p[1] = M[i * 3 + 1]; p[2] = M[i * 3 + 2];
    const q = rot(T.R, p); q[0] += T.t[0]; q[1] += T.t[1]; q[2] += T.t[2];
    if (nearK(L.G, L.P, q[0], q[1], q[2], 1, r2, bi, bd) && bd[0] <= tol * tol + (RN ? 0 : 0)) inl++;
  }
  return { T, rms: last?.rms ?? NaN, iterations: it, history: hist, overlap: nmov ? inl / nmov : 0, pairs: last?.used || 0 };
}
