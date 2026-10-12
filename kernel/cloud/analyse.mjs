// Point cloud analysis ops (run in the cloud worker pool, see main/cloudio.cjs analyseCloud).
// Results are written into new shared Float32 field arrays (NaN = no value):
//   normals  -> nx, ny, nz, curvature, verticality   (PCA of the k nearest neighbours)
//   density  -> density                               (neighbours within r, or points per m² / m³)
//   c2c      -> c2c (+ c2c_x/y/z)                     (distance to a reference cloud)
//   c2m      -> c2m                                   (signed distance to a triangle mesh)
// Spatial ops work per x-slab of cells [lo, hi) like the SOR filter (edit.mjs neigh).
import { CellHash } from './edit.mjs';

const F = (b) => (b ? new Float32Array(b) : null);

// ---------- grid of the points of one slab (+ halo cells): CSR by cell ----------
function slabGrid(P, count, gmin, cell, lo, hi, halo, expect, progress) {
  const inv = 1 / cell;
  let cap = Math.max(1024, Math.ceil((expect || 1024) * 1.3)), n = 0;
  let idx = new Uint32Array(cap), cid = new Int32Array(cap);
  let H = new CellHash(Math.max(1024, (expect || 1024) / 2));
  let ncell = 0, cellCnt = new Int32Array(Math.max(1024, (expect || 1024) / 2));
  for (let p = 0; p < count; p++) {
    const cx = Math.floor((P[p * 3] - gmin[0]) * inv);
    if (cx < lo - halo || cx >= hi + halo) continue;
    const cy = Math.floor((P[p * 3 + 1] - gmin[1]) * inv), cz = Math.floor((P[p * 3 + 2] - gmin[2]) * inv);
    let c = H.get(cx, cy, cz);
    if (c < 0) {
      if (H.size * 2 >= H.cap) {
        const old = H, nh = new CellHash(old.size * 2 + 1024);
        for (let i = 0; i < old.cap; i++) if (old.kx[i] !== -2147483648) { const yz = old.kyz[i], cy2 = Math.floor(yz / 2097152), cz2 = yz - cy2 * 2097152; nh.insert(old.kx[i], cy2, cz2, old.val[i]); }
        H = nh;
      }
      c = ncell++; H.insert(cx, cy, cz, c);
      if (c >= cellCnt.length) { const t = new Int32Array(cellCnt.length * 2); t.set(cellCnt); cellCnt = t; }
    }
    if (n >= cap) { cap *= 2; const a = new Uint32Array(cap); a.set(idx); idx = a; const b = new Int32Array(cap); b.set(cid); cid = b; }
    idx[n] = p; cid[n] = c; n++; cellCnt[c]++;
    if (progress && (p & 0xfffff) === 0xfffff) progress(0);
  }
  const start = new Int32Array(ncell + 1);
  for (let c = 0; c < ncell; c++) start[c + 1] = start[c] + cellCnt[c];
  const fill = start.slice(0, ncell), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[cid[i]]++] = idx[i];
  return { H, start, order, idx, n, inv };
}

// ---------- k nearest search in growing shells of cells ----------
// fills bd (squared distances, ascending) and bi (indices); returns how many were found
function knn(G, Q, x, y, z, gmin, cell, K, maxRing, maxD2, bd, bi, skip) {
  const cx = Math.floor((x - gmin[0]) * G.inv), cy = Math.floor((y - gmin[1]) * G.inv), cz = Math.floor((z - gmin[2]) * G.inv);
  let m = 0;
  bd.fill(Infinity, 0, K);
  for (let rr = 0; rr <= maxRing; rr++) {
    for (let dx = -rr; dx <= rr; dx++) for (let dy = -rr; dy <= rr; dy++) {
      const onShell = dx === -rr || dx === rr || dy === -rr || dy === rr;
      for (let dz = -rr; dz <= rr; dz += onShell ? 1 : 2 * rr || 1) {
        const c = G.H.get(cx + dx, cy + dy, cz + dz); if (c < 0) continue;
        for (let j = G.start[c]; j < G.start[c + 1]; j++) {
          const q = G.order[j]; if (q === skip) continue;
          const ex = Q[q * 3] - x, ey = Q[q * 3 + 1] - y, ez = Q[q * 3 + 2] - z;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 > maxD2 || d2 >= bd[K - 1]) continue;
          let t = K - 1; while (t > 0 && bd[t - 1] > d2) { bd[t] = bd[t - 1]; bi[t] = bi[t - 1]; t--; }
          bd[t] = d2; bi[t] = q; if (m < K) m++;
        }
        if (rr === 0) break;
      }
    }
    // everything not searched yet is at least rr cells away
    const lim = rr * cell;
    if (m === K && bd[K - 1] <= lim * lim) break;
    if (lim * lim > maxD2) break;
  }
  return m;
}

// ---------- plane fit (PCA): smallest eigenvector of the covariance ----------
const PL = { n: [0, 0, 1], c: [0, 0, 0], curv: 0 };
function planeFit(Q, ids, m, x0, y0, z0) {
  let sx = 0, sy = 0, sz = 0;
  for (let t = 0; t < m; t++) { const q = ids[t] * 3; sx += Q[q] - x0; sy += Q[q + 1] - y0; sz += Q[q + 2] - z0; }
  sx /= m; sy /= m; sz /= m;
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0; // xx xy xz yy yz zz
  for (let t = 0; t < m; t++) {
    const q = ids[t] * 3, u = Q[q] - x0 - sx, v = Q[q + 1] - y0 - sy, w = Q[q + 2] - z0 - sz;
    a += u * u; b += u * v; c += u * w; d += v * v; e += v * w; f += w * w;
  }
  PL.c[0] = sx + x0; PL.c[1] = sy + y0; PL.c[2] = sz + z0;
  // eigenvalues of the symmetric 3x3 (trigonometric method)
  const p1 = b * b + c * c + e * e, tr = a + d + f;
  let l0, l1, l2;
  if (p1 < 1e-30 * (tr * tr + 1e-300)) { const s = [a, d, f].sort((x, y) => x - y); [l0, l1, l2] = s; }
  else {
    const q = tr / 3, p2 = (a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
    const B0 = (a - q) / p, B1 = b / p, B2 = c / p, B3 = (d - q) / p, B4 = e / p, B5 = (f - q) / p;
    let r = (B0 * (B3 * B5 - B4 * B4) - B1 * (B1 * B5 - B4 * B2) + B2 * (B1 * B4 - B3 * B2)) / 2;
    r = Math.max(-1, Math.min(1, r));
    const phi = Math.acos(r) / 3;
    l2 = q + 2 * p * Math.cos(phi); l0 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3); l1 = 3 * q - l0 - l2;
  }
  // eigenvector of l0: the largest cross product of two rows of (A - l0 I)
  const r0 = [a - l0, b, c], r1 = [b, d - l0, e], r2 = [c, e, f - l0];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const c01 = cr(r0, r1), c02 = cr(r0, r2), c12 = cr(r1, r2);
  const n01 = c01[0] ** 2 + c01[1] ** 2 + c01[2] ** 2, n02 = c02[0] ** 2 + c02[1] ** 2 + c02[2] ** 2, n12 = c12[0] ** 2 + c12[1] ** 2 + c12[2] ** 2;
  let v = c01, nn = n01; if (n02 > nn) { v = c02; nn = n02; } if (n12 > nn) { v = c12; nn = n12; }
  if (nn > 0) { const s = 1 / Math.sqrt(nn); PL.n[0] = v[0] * s; PL.n[1] = v[1] * s; PL.n[2] = v[2] * s; } else { PL.n[0] = 0; PL.n[1] = 0; PL.n[2] = 1; }
  PL.curv = tr > 0 ? Math.max(0, l0) / tr : 0;
  return PL;
}

// ---------- normals ----------
// out: {nx, ny, nz, curv, vert}; orient: 'inside' (towards centre), 'outside', 'up'
export function normals({ S, out, count, gmin, cell, lo, hi, k: K, orient, centre, expect }, progress) {
  const P = F(S.pos), O = Object.fromEntries(Object.entries(out).map(([k, b]) => [k, F(b)]));
  const G = slabGrid(P, count, gmin, cell, lo, hi, 1, expect, progress);
  const bd = new Float64Array(K), bi = new Int32Array(K + 1);
  let done = 0;
  for (let i = 0; i < G.n; i++) {
    const p = G.idx[i], x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const cx = Math.floor((x - gmin[0]) * G.inv);
    if (cx < lo || cx >= hi) continue;
    const m = knn(G, P, x, y, z, gmin, cell, K, 1, Infinity, bd, bi, p);
    if (m < 2) { O.nx[p] = O.ny[p] = O.nz[p] = O.curv[p] = O.vert[p] = NaN; }
    else {
      bi[m] = p; // the point itself takes part in the fit
      const L = planeFit(P, bi, m + 1, x, y, z);
      let nx = L.n[0], ny = L.n[1], nz = L.n[2];
      let flip;
      if (orient === 'up') flip = nz < 0;
      else { const s = (centre[0] - x) * nx + (centre[1] - y) * ny + (centre[2] - z) * nz; flip = orient === 'outside' ? s > 0 : s < 0; }
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      O.nx[p] = nx; O.ny[p] = ny; O.nz[p] = nz; O.curv[p] = L.curv; O.vert[p] = 1 - Math.abs(nz);
    }
    if (++done % 200000 === 0) progress(200000);
  }
  progress(done % 200000);
  return { done };
}

// ---------- density ----------
// kind: 'count' (neighbours within r), 'surface' (points per m²), 'volume' (points per m³)
export function density({ S, out, count, gmin, cell, lo, hi, r, kind, expect }, progress) {
  const P = F(S.pos), D = F(out);
  const G = slabGrid(P, count, gmin, cell, lo, hi, 1, expect, progress);
  const r2 = r * r, area = Math.PI * r2, vol = (4 / 3) * Math.PI * r2 * r;
  let done = 0;
  for (let i = 0; i < G.n; i++) {
    const p = G.idx[i], x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const cx = Math.floor((x - gmin[0]) * G.inv);
    if (cx < lo || cx >= hi) continue;
    const cy = Math.floor((y - gmin[1]) * G.inv), cz = Math.floor((z - gmin[2]) * G.inv);
    let cnt = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = G.H.get(cx + dx, cy + dy, cz + dz); if (c < 0) continue;
      for (let j = G.start[c]; j < G.start[c + 1]; j++) {
        const q = G.order[j]; if (q === p) continue;
        const ex = P[q * 3] - x, ey = P[q * 3 + 1] - y, ez = P[q * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= r2) cnt++;
      }
    }
    D[p] = kind === 'surface' ? (cnt + 1) / area : kind === 'volume' ? (cnt + 1) / vol : cnt;
    if (++done % 200000 === 0) progress(200000);
  }
  progress(done % 200000);
  return { done };
}

// ---------- cloud to cloud ----------
// S = compared points, Rf = reference {pos, fields: [nx, ny, nz] (optional)}; out: {d, dx, dy, dz (optional)}
// model: 'nearest' (distance to the nearest reference point) or 'plane' (to a plane through its k nearest)
export function c2c({ S, Rf, out, count, rcount, gmin, cell, lo, hi, maxDist, model, k, expect }, progress) {
  const P = F(S.pos), Q = F(Rf.pos), NR = (Rf.fields || []).length === 3 ? Rf.fields.map(F) : null;
  const D = F(out.d), DX = F(out.dx), DY = F(out.dy), DZ = F(out.dz);
  const maxRing = Math.max(1, Math.ceil(maxDist / cell));
  const G = slabGrid(Q, rcount, gmin, cell, lo, hi, maxRing + 1, expect, progress);
  const K = model === 'plane' ? Math.max(3, k || 6) : 1;
  const bd = new Float64Array(K), bi = new Int32Array(K);
  const maxD2 = maxDist * maxDist, inv = 1 / cell;
  let done = 0;
  for (let p = 0; p < count; p++) {
    const x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const cx = Math.floor((x - gmin[0]) * inv);
    if (cx < lo || cx >= hi) continue;
    const m = knn(G, Q, x, y, z, gmin, cell, K, maxRing, model === 'plane' ? maxD2 * 4 : maxD2, bd, bi, -1);
    let d = NaN, vx = NaN, vy = NaN, vz = NaN;
    if (m > 0 && bd[0] <= maxD2) {
      const q = bi[0];
      vx = x - Q[q * 3]; vy = y - Q[q * 3 + 1]; vz = z - Q[q * 3 + 2];
      d = Math.sqrt(bd[0]);
      if (model === 'plane' && m >= 3) {
        const L = planeFit(Q, bi, m, x, y, z);
        let nx = L.n[0], ny = L.n[1], nz = L.n[2];
        if (NR) { // orient like the reference normals
          let sx = 0, sy = 0, sz = 0; for (let t = 0; t < m; t++) { const r = bi[t]; if (NR[0][r] === NR[0][r]) { sx += NR[0][r]; sy += NR[1][r]; sz += NR[2][r]; } }
          if (sx * nx + sy * ny + sz * nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        }
        const s = (x - L.c[0]) * nx + (y - L.c[1]) * ny + (z - L.c[2]) * nz;
        d = NR ? s : Math.abs(s);
        vx = s * nx; vy = s * ny; vz = s * nz;
      } else if (NR && NR[0][q] === NR[0][q]) {
        if (vx * NR[0][q] + vy * NR[1][q] + vz * NR[2][q] < 0) d = -d;
      }
    }
    D[p] = d;
    if (DX) { DX[p] = vx; DY[p] = vy; DZ[p] = vz; }
    if (++done % 200000 === 0) progress(200000);
  }
  progress(done % 200000);
  return { done };
}

// ---------- cloud to mesh ----------
// closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5); result in CP
const CP = [0, 0, 0];
function closestTri(px, py, pz, T, o) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { CP[0] = ax; CP[1] = ay; CP[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { CP[0] = bx; CP[1] = by; CP[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); CP[0] = ax + v * abx; CP[1] = ay + v * aby; CP[2] = az + v * abz; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { CP[0] = cx; CP[1] = cy; CP[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); CP[0] = ax + w * acx; CP[1] = ay + w * acy; CP[2] = az + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); CP[0] = bx + w * (cx - bx); CP[1] = by + w * (cy - by); CP[2] = bz + w * (cz - bz); return; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  CP[0] = ax + abx * v + acx * w; CP[1] = ay + aby * v + acy * w; CP[2] = az + abz * v + acz * w;
}
// grid of triangles (each listed in every cell its box touches)
function triGrid(T, nt, cell, gmin) {
  const inv = 1 / cell, H = new CellHash(Math.max(1024, nt * 2));
  let ncell = 0, cnt = new Int32Array(1024);
  const box = (t) => {
    const o = t * 9; let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let v = 0; v < 9; v += 3) { x0 = Math.min(x0, T[o + v]); x1 = Math.max(x1, T[o + v]); y0 = Math.min(y0, T[o + v + 1]); y1 = Math.max(y1, T[o + v + 1]); z0 = Math.min(z0, T[o + v + 2]); z1 = Math.max(z1, T[o + v + 2]); }
    return [Math.floor((x0 - gmin[0]) * inv), Math.floor((y0 - gmin[1]) * inv), Math.floor((z0 - gmin[2]) * inv), Math.floor((x1 - gmin[0]) * inv), Math.floor((y1 - gmin[1]) * inv), Math.floor((z1 - gmin[2]) * inv)];
  };
  let Hh = H;
  const cellOf = (x, y, z) => {
    let c = Hh.get(x, y, z);
    if (c < 0) {
      if (Hh.size * 2 >= Hh.cap) {
        const old = Hh, nh = new CellHash(old.size * 2 + 1024);
        for (let i = 0; i < old.cap; i++) if (old.kx[i] !== -2147483648) { const yz = old.kyz[i], cy2 = Math.floor(yz / 2097152); nh.insert(old.kx[i], cy2, yz - cy2 * 2097152, old.val[i]); }
        Hh = nh;
      }
      c = ncell++; Hh.insert(x, y, z, c);
      if (c >= cnt.length) { const t = new Int32Array(cnt.length * 2); t.set(cnt); cnt = t; }
    }
    return c;
  };
  for (let t = 0; t < nt; t++) { const b = box(t); for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) cnt[cellOf(x, y, z)]++; }
  const start = new Int32Array(ncell + 1);
  for (let c = 0; c < ncell; c++) start[c + 1] = start[c] + cnt[c];
  const fill = start.slice(0, ncell), list = new Int32Array(start[ncell]);
  for (let t = 0; t < nt; t++) { const b = box(t); for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) list[fill[Hh.get(x, y, z)]++] = t; }
  return { H: Hh, start, list, inv };
}
// T: triangles (9 floats each, local frame), N: unit normals (3 per triangle)
export function c2m({ S, tris, nrm, ntris, out, from, to, gmin, cell, maxDist, signed }, progress) {
  const P = F(S.pos), T = F(tris), N = F(nrm), D = F(out);
  const G = triGrid(T, ntris, cell, gmin);
  const stamp = new Int32Array(ntris).fill(-1);
  const maxRing = Math.max(1, Math.ceil(maxDist / cell)), maxD2 = maxDist * maxDist;
  let done = 0;
  for (let p = from; p < to; p++) {
    const x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const cx = Math.floor((x - gmin[0]) * G.inv), cy = Math.floor((y - gmin[1]) * G.inv), cz = Math.floor((z - gmin[2]) * G.inv);
    let best = Infinity, bs = 0, bdot = 0;
    for (let rr = 0; rr <= maxRing; rr++) {
      for (let dx = -rr; dx <= rr; dx++) for (let dy = -rr; dy <= rr; dy++) {
        const onShell = dx === -rr || dx === rr || dy === -rr || dy === rr;
        for (let dz = -rr; dz <= rr; dz += onShell ? 1 : 2 * rr || 1) {
          const c = G.H.get(cx + dx, cy + dy, cz + dz);
          if (c >= 0) for (let j = G.start[c]; j < G.start[c + 1]; j++) {
            const t = G.list[j]; if (stamp[t] === p) continue; stamp[t] = p;
            closestTri(x, y, z, T, t * 9);
            const ex = x - CP[0], ey = y - CP[1], ez = z - CP[2], d2 = ex * ex + ey * ey + ez * ez;
            const dot = ex * N[t * 3] + ey * N[t * 3 + 1] + ez * N[t * 3 + 2];
            // equal distances (edges, corners): the triangle that faces the point most decides the sign
            if (d2 < best * (1 - 1e-9) - 1e-14 || (d2 <= best * (1 + 1e-9) + 1e-14 && Math.abs(dot) > Math.abs(bdot))) { if (d2 < best) best = d2; bdot = dot; bs = dot < 0 ? -1 : 1; }
          }
          if (rr === 0) break;
        }
      }
      const lim = rr * cell;
      if (best <= lim * lim || lim * lim > maxD2) break;
    }
    D[p] = best <= maxD2 ? (signed ? bs : 1) * Math.sqrt(best) : NaN;
    if (++done % 100000 === 0) progress(100000);
  }
  progress(done % 100000);
  return { done };
}

// ---------- statistics of a field: bbox-free min/max/mean/rms + histogram ----------
export function fieldStats({ buf, from, to, lo, hi, nb }) {
  const A = F(buf), bins = new Float64Array(nb || 1);
  let n = 0, nan = 0, s = 0, s2 = 0, sa = 0, mn = Infinity, mx = -Infinity;
  const w = hi > lo ? nb / (hi - lo) : 0;
  for (let i = from; i < to; i++) {
    const v = A[i];
    if (v !== v) { nan++; continue; }
    n++; s += v; s2 += v * v; sa += Math.abs(v); if (v < mn) mn = v; if (v > mx) mx = v;
    if (nb) { let b = Math.floor((v - lo) * w); if (b < 0) b = 0; if (b >= nb) b = nb - 1; bins[b]++; }
  }
  return { n, nan, s, s2, sa, mn, mx, bins: [...bins] };
}
// bounding box of positions (for writing S straight to a cache)
export function posBox({ S, from, to }) {
  const P = F(S.pos), b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = from; k < to; k++) for (let d = 0; d < 3; d++) { const v = P[k * 3 + d]; if (v < b[d]) b[d] = v; if (v > b[d + 3]) b[d + 3] = v; }
  return b;
}
