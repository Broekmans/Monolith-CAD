// Point cloud editing ops (run in the cloud worker pool, see main/cloudio.cjs editCloud).
// All ops work on shared arrays: S = {pos, inten, cls, rgb, fields[]} + a Uint8 `mask` per point
// (0/1 = output index, 255 = dropped).
import fs from 'node:fs';

const V = (S) => ({
  pos: new Float32Array(S.pos), inten: new Uint16Array(S.inten), cls: new Uint8Array(S.cls),
  rgb: S.rgb ? new Uint8Array(S.rgb) : null, fields: (S.fields || []).map((b) => new Float32Array(b)),
});
const nodeBytes = (k, a) => { const b = k * (12 + 4 * a.nf + 2 + (a.rgb ? 3 : 0) + 1); return (b + 3) & ~3; };

// ---------- gather: cache nodes -> shared arrays (with transform) ----------
export function gather({ cache, nodes, dstStart, S, A, fieldMap, R, delta }, progress) {
  const D = V(S);
  const fd = fs.openSync(cache, 'r');
  let k = dstStart, rep = 0;
  try {
    for (const [, n, off] of nodes) {
      if (!n) continue;
      const bytes = nodeBytes(n, A);
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, off);
      const ab = buf.buffer, bo = buf.byteOffset;
      const P = new Float32Array(ab, bo, n * 3);
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], o = (k + i) * 3;
        if (R) {
          D.pos[o] = R[0] * x + R[1] * y + R[2] * z + delta[0];
          D.pos[o + 1] = R[3] * x + R[4] * y + R[5] * z + delta[1];
          D.pos[o + 2] = R[6] * x + R[7] * y + R[8] * z + delta[2];
        } else { D.pos[o] = x + delta[0]; D.pos[o + 1] = y + delta[1]; D.pos[o + 2] = z + delta[2]; }
      }
      for (let f = 0; f < fieldMap.length; f++) {
        const si = fieldMap[f], dst = D.fields[f];
        if (si < 0) { dst.fill(0, k, k + n); continue; }
        const F = new Float32Array(ab, bo + 12 * n + 4 * n * si, n);
        dst.set(F, k);
      }
      let o = bo + 12 * n + 4 * n * A.nf;
      D.inten.set(new Uint16Array(ab.slice(o, o + 2 * n)), k); o += 2 * n;
      if (A.rgb) { if (D.rgb) D.rgb.set(new Uint8Array(ab, o, 3 * n), k * 3); o += 3 * n; } else if (D.rgb) D.rgb.fill(170, k * 3, (k + n) * 3);
      D.cls.set(new Uint8Array(ab, o, n), k);
      k += n; rep += n;
      if (rep > 300000) { progress(rep); rep = 0; }
    }
  } finally { fs.closeSync(fd); }
  progress(rep);
  return { n: k - dstStart };
}

// ---------- masks over an index range ----------
const pointIn = (x, y, poly) => {
  let c = false;
  for (let i = 0, j = poly.length / 2 - 1; i < poly.length / 2; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
// mode: 'split' (inside 0, outside 1), 'inside' (keep inside), 'outside' (keep outside)
const put = (mode, inside) => (mode === 'split' ? (inside ? 0 : 1) : mode === 'inside' ? (inside ? 0 : 255) : inside ? 255 : 0);

export function maskPoly({ S, mask, from, to, mat, poly, mode }) {
  const P = new Float32Array(S.pos), M = new Uint8Array(mask), m = mat;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) { bx0 = Math.min(bx0, poly[i]); bx1 = Math.max(bx1, poly[i]); by0 = Math.min(by0, poly[i + 1]); by1 = Math.max(by1, poly[i + 1]); }
  for (let k = from; k < to; k++) {
    const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
    // column-major 4x4 (three.js elements); orthographic -> w = 1
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const inside = sx >= bx0 && sx <= bx1 && sy >= by0 && sy <= by1 && pointIn(sx, sy, poly);
    M[k] = put(mode, inside);
  }
}
export function maskBox({ S, mask, from, to, min, max, mode }) {
  const P = new Float32Array(S.pos), M = new Uint8Array(mask);
  for (let k = from; k < to; k++) {
    const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
    M[k] = put(mode, x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]);
  }
}
// attr: {k: 'z' | 'i' | 'c' | 'f', i}
export function maskValue({ S, mask, from, to, attr, min, max, mode }) {
  const D = V(S), M = new Uint8Array(mask);
  const get = attr.k === 'z' ? (k) => D.pos[k * 3 + 2] : attr.k === 'i' ? (k) => D.inten[k] : attr.k === 'c' ? (k) => D.cls[k] : ((F) => (k) => F[k])(D.fields[attr.i]);
  const eps = attr.k === 'z' ? 1e-5 : 1e-6; // heights are float32 relative to the origin
  for (let k = from; k < to; k++) { const v = get(k); M[k] = put(mode, v >= min - eps && v <= max + eps); }
}
export function maskRandom({ mask, from, to, frac, seed }) {
  const M = new Uint8Array(mask);
  let s = (seed ^ (from * 2654435761)) >>> 0 || 1;
  for (let k = from; k < to; k++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; M[k] = s / 4294967296 < frac ? 0 : 255; }
}
export function countMask({ mask, from, to }) {
  const M = new Uint8Array(mask);
  const c = [0, 0];
  for (let k = from; k < to; k++) { const v = M[k]; if (v === 0) c[0]++; else if (v === 1) c[1]++; }
  return c;
}
export function maskThreshold({ mask, dist, from, to, thr }) {
  const M = new Uint8Array(mask), Dd = new Float32Array(dist);
  for (let k = from; k < to; k++) M[k] = Dd[k] <= thr ? 0 : 255;
}
export function distStats({ dist, from, to }) {
  const Dd = new Float32Array(dist);
  let n = 0, s = 0, s2 = 0;
  for (let k = from; k < to; k++) { const v = Dd[k]; if (!(v < 1e30)) continue; n++; s += v; s2 += v * v; }
  return { n, s, s2 };
}

// ---------- spatial: slabs along x (cell aligned) ----------
export function histX({ S, from, to, gmin, cell, binCells, nbins }) {
  const P = new Float32Array(S.pos), h = new Float64Array(nbins);
  const w = cell * binCells;
  for (let k = from; k < to; k++) { let b = Math.floor((P[k * 3] - gmin[0]) / w); if (b < 0) b = 0; if (b >= nbins) b = nbins - 1; h[b]++; }
  return [...h];
}

// open addressing hash: (cx, cy, cz) -> slot; keys as cx (int32) + cy*2^21+cz (float64)
export class CellHash {
  constructor(n) {
    let cap = 1; while (cap < n * 2) cap <<= 1;
    this.cap = cap; this.mask = cap - 1;
    this.kx = new Int32Array(cap).fill(-2147483648); this.kyz = new Float64Array(cap); this.val = new Int32Array(cap);
    this.size = 0;
  }
  slot(cx, cy, cz) {
    const yz = cy * 2097152 + cz;
    let h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) & this.mask;
    for (;;) {
      if (this.kx[h] === -2147483648) return -1 - h; // empty: -(slot+1)
      if (this.kx[h] === cx && this.kyz[h] === yz) return h;
      h = (h + 1) & this.mask;
    }
  }
  insert(cx, cy, cz, v) { const s = this.slot(cx, cy, cz); if (s >= 0) return s; const h = -1 - s; this.kx[h] = cx; this.kyz[h] = cy * 2097152 + cz; this.val[h] = v; this.size++; return h; }
  get(cx, cy, cz) { const s = this.slot(cx, cy, cz); return s >= 0 ? this.val[s] : -1; }
}

// keep the first point of every voxel (spacing subsample) for voxels with cx in [lo, hi)
export function voxelSub({ S, mask, count, gmin, cell, lo, hi, expect }, progress) {
  const P = new Float32Array(S.pos), M = new Uint8Array(mask);
  const H = new CellHash(Math.max(1024, expect || 1024));
  const inv = 1 / cell;
  let kept = 0;
  for (let k = 0; k < count; k++) {
    const cx = Math.floor((P[k * 3] - gmin[0]) * inv);
    if (cx < lo || cx >= hi) continue;
    const cy = Math.floor((P[k * 3 + 1] - gmin[1]) * inv), cz = Math.floor((P[k * 3 + 2] - gmin[2]) * inv);
    const s = H.slot(cx, cy, cz);
    if (s < 0) { H.insert(cx, cy, cz, k); M[k] = 0; kept++; }
    if ((k & 0xfffff) === 0xfffff) progress(0);
  }
  return { kept };
}

// neighbourhood filters for points with cx in [lo, hi): 'radius' keeps points with >= minN neighbours
// within r; 'sor' writes the mean distance to the k nearest neighbours into `dist`.
export function neigh({ S, mask, dist, count, gmin, cell, lo, hi, mode, r, minN, k: K, expect }, progress) {
  const P = new Float32Array(S.pos), M = new Uint8Array(mask), Dd = dist ? new Float32Array(dist) : null;
  const inv = 1 / cell;
  // 1. points of the slab + one cell halo, with their cell
  let cap = Math.max(1024, Math.ceil((expect || 1024) * 1.3)), n = 0;
  let idx = new Uint32Array(cap), cid = new Int32Array(cap);
  const H = new CellHash(Math.max(1024, (expect || 1024) / 2));
  let ncell = 0;
  let cellCnt = new Int32Array(Math.max(1024, (expect || 1024) / 2));
  for (let p = 0; p < count; p++) {
    const cx = Math.floor((P[p * 3] - gmin[0]) * inv);
    if (cx < lo - 1 || cx > hi) continue;
    const cy = Math.floor((P[p * 3 + 1] - gmin[1]) * inv), cz = Math.floor((P[p * 3 + 2] - gmin[2]) * inv);
    let s = H.slot(cx, cy, cz), c;
    if (s >= 0) c = H.val[s];
    else {
      if (H.size * 2 >= H.cap) { // grow the hash
        const old = H; const nh = new CellHash(old.size * 2 + 1024);
        for (let i = 0; i < old.cap; i++) if (old.kx[i] !== -2147483648) { const h2 = -1 - nh.slot(old.kx[i], Math.floor(old.kyz[i] / 2097152), old.kyz[i] % 2097152); nh.kx[h2] = old.kx[i]; nh.kyz[h2] = old.kyz[i]; nh.val[h2] = old.val[i]; nh.size++; }
        Object.assign(H, nh);
      }
      c = ncell++; H.insert(cx, cy, cz, c);
      if (c >= cellCnt.length) { const t = new Int32Array(cellCnt.length * 2); t.set(cellCnt); cellCnt = t; }
    }
    if (n >= cap) { cap *= 2; const a = new Uint32Array(cap); a.set(idx); idx = a; const b = new Int32Array(cap); b.set(cid); cid = b; }
    idx[n] = p; cid[n] = c; n++; cellCnt[c]++;
    if ((p & 0xfffff) === 0xfffff) progress(0);
  }
  // 2. CSR: points sorted by cell
  const start = new Int32Array(ncell + 1);
  for (let c = 0; c < ncell; c++) start[c + 1] = start[c] + cellCnt[c];
  const fill = start.slice(0, ncell), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[fill[cid[i]]++] = idx[i];
  // 3. per own point: look at the 27 surrounding cells
  const r2 = (r || cell) * (r || cell);
  const best = new Float64Array(Math.max(1, K || 1));
  let done = 0;
  for (let i = 0; i < n; i++) {
    const p = idx[i];
    const x = P[p * 3], y = P[p * 3 + 1], z = P[p * 3 + 2];
    const cx = Math.floor((x - gmin[0]) * inv);
    if (cx < lo || cx >= hi) continue;
    const cy = Math.floor((y - gmin[1]) * inv), cz = Math.floor((z - gmin[2]) * inv);
    if (mode === 'radius') {
      let cnt = 0;
      outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const c = H.get(cx + dx, cy + dy, cz + dz); if (c < 0) continue;
        for (let j = start[c]; j < start[c + 1]; j++) {
          const q = order[j]; if (q === p) continue;
          const ex = P[q * 3] - x, ey = P[q * 3 + 1] - y, ez = P[q * 3 + 2] - z;
          if (ex * ex + ey * ey + ez * ez <= r2 && ++cnt >= minN) break outer;
        }
      }
      M[p] = cnt >= minN ? 0 : 255;
    } else {
      let m = 0;
      best.fill(Infinity);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const c = H.get(cx + dx, cy + dy, cz + dz); if (c < 0) continue;
        for (let j = start[c]; j < start[c + 1]; j++) {
          const q = order[j]; if (q === p) continue;
          const ex = P[q * 3] - x, ey = P[q * 3 + 1] - y, ez = P[q * 3 + 2] - z;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < best[K - 1]) { let t = K - 1; while (t > 0 && best[t - 1] > d2) { best[t] = best[t - 1]; t--; } best[t] = d2; if (m < K) m++; }
        }
      }
      let s = 0; for (let t = 0; t < m; t++) s += Math.sqrt(best[t]);
      // fewer than k neighbours nearby: count the missing ones as far away (2 cells)
      Dd[p] = (s + (K - m) * 2 * cell) / K;
    }
    if (++done % 500000 === 0) progress(500000);
  }
  progress(done % 500000);
  return { done };
}

// ---------- compact: copy the points of one output into new arrays ----------
export function compact({ S, D, mask, which, from, to, dstStart }) {
  const A = V(S), B = V(D), M = new Uint8Array(mask);
  const nf = B.fields.length;
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const st = []; for (let f = 0; f < nf; f++) st.push(Infinity, -Infinity);
  let o = dstStart;
  for (let k = from; k < to; k++) {
    if (M[k] !== which) continue;
    for (let d = 0; d < 3; d++) { const v = A.pos[k * 3 + d]; B.pos[o * 3 + d] = v; if (v < bbox[d]) bbox[d] = v; if (v > bbox[d + 3]) bbox[d + 3] = v; }
    B.inten[o] = A.inten[k]; B.cls[o] = A.cls[k];
    if (B.rgb) { B.rgb[o * 3] = A.rgb[k * 3]; B.rgb[o * 3 + 1] = A.rgb[k * 3 + 1]; B.rgb[o * 3 + 2] = A.rgb[k * 3 + 2]; }
    for (let f = 0; f < nf; f++) { const v = A.fields[f][k]; B.fields[f][o] = v; if (v < st[f * 2]) st[f * 2] = v; if (v > st[f * 2 + 1]) st[f * 2 + 1] = v; }
    o++;
  }
  return { n: o - dstStart, bbox, stats: st };
}

// ---------- per-point predicate for streaming edits (same rules as the mask ops above) ----------
// pred: {kind: 'poly'|'box'|'value'|'random'|'all', ...}; returns (x, y, z, inten, cls, fields, gid) -> output index or 255
export function makePredicate(pred) {
  const mode = pred.mode || 'inside';
  if (pred.kind === 'poly') {
    const m = pred.mat, poly = pred.poly;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) { bx0 = Math.min(bx0, poly[i]); bx1 = Math.max(bx1, poly[i]); by0 = Math.min(by0, poly[i + 1]); by1 = Math.max(by1, poly[i + 1]); }
    return (x, y, z) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      return put(mode, sx >= bx0 && sx <= bx1 && sy >= by0 && sy <= by1 && pointIn(sx, sy, poly));
    };
  }
  if (pred.kind === 'box') { const a = pred.min, b = pred.max; return (x, y, z) => put(mode, x >= a[0] && x <= b[0] && y >= a[1] && y <= b[1] && z >= a[2] && z <= b[2]); }
  if (pred.kind === 'value') {
    const at = pred.attr, lo = pred.min - (at.k === 'z' ? 1e-5 : 1e-6), hi = pred.max + (at.k === 'z' ? 1e-5 : 1e-6);
    if (at.k === 'z') return (x, y, z) => put(mode, z >= lo && z <= hi);
    if (at.k === 'i') return (x, y, z, i) => put(mode, i >= lo && i <= hi);
    if (at.k === 'c') return (x, y, z, i, c) => put(mode, c >= lo && c <= hi);
    return (x, y, z, i, c, F) => { const v = F[at.i]; return put(mode, v >= lo && v <= hi); };
  }
  if (pred.kind === 'random') {
    const frac = pred.frac;
    return (x, y, z, i, c, F, gid) => { let h = Math.imul(gid ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296 < frac ? 0 : 255; };
  }
  return () => 0;
}
