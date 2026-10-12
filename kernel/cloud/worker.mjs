// Point cloud editor worker (one of a pool, see main/cloudio.cjs).
// Ops: decode a part of a file into shared arrays, build part of the octree into the cache file, export.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { readLasHeader, recordReader } from './las.mjs';
import * as E from './edit.mjs';
import * as AN from './analyse.mjs';
import * as RG from './register.mjs';

const require = createRequire(import.meta.url);
let lazModule = null;
async function laz() { if (!lazModule) lazModule = await require('laz-perf').createLazPerf(); return lazModule; }

let curId = 0;
const progress = (p) => parentPort.postMessage({ id: curId, progress: p });

// shared arrays from SharedArrayBuffers
function views(S) {
  return {
    pos: new Float32Array(S.pos), inten: new Uint16Array(S.inten), cls: new Uint8Array(S.cls),
    rgb: S.rgb ? new Uint8Array(S.rgb) : null, fields: (S.fields || []).map((b) => new Float32Array(b)),
    idxA: S.idxA ? new Uint32Array(S.idxA) : null, idxB: S.idxB ? new Uint32Array(S.idxB) : null,
    counter: S.counter ? new BigInt64Array(S.counter) : null,
  };
}
const newStats = (nf) => { const s = new Float64Array(nf * 2); for (let i = 0; i < nf; i++) { s[i * 2] = Infinity; s[i * 2 + 1] = -Infinity; } return s; };
function bboxOf(pos, from, to) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = from; k < to; k++) for (let d = 0; d < 3; d++) { const v = pos[k * 3 + d]; if (v < b[d]) b[d] = v; if (v > b[d + 3]) b[d + 3] = v; }
  return b;
}

// ---------------- point sinks ----------------
// Decoders write points into a small batch; the sink then either
//  - 'direct': copies them to the shared arrays at consecutive indices (first, first+1, ...)
//  - 'hist':   counts points per cell of a 2^D grid over the cube (no storage)
//  - 'bucket': keeps only points whose cell belongs to a bucket of this round; each bucket has a
//              fixed region in the shared arrays (base[slot]) filled via an atomic counter.
const BS = 65536;
export function makeSink(spec, S, nf, hasRgb) {
  const B = { pos: new Float32Array(BS * 3), inten: new Uint16Array(BS), cls: new Uint8Array(BS), rgb: hasRgb ? new Uint8Array(BS * 3) : null, fields: Array.from({ length: nf }, () => new Float32Array(BS)), stats: newStats(nf) };
  const V = S ? views(S) : null;
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let n = 0, k = spec.first || 0, total = 0;
  const D = spec.D || 0, G = 2 ** D, cube = spec.cube;
  const inv = cube ? G / cube.size : 0;
  const hist = spec.type === 'hist' ? new Float64Array(G * G * G) : null;
  const cellSlot = spec.cellSlot ? new Int32Array(spec.cellSlot) : null;
  const base = spec.base || null, cnt = spec.counters ? new Int32Array(spec.counters) : null;
  const cellOf = (i) => {
    let x = Math.floor((B.pos[i * 3] - cube.min[0]) * inv), y = Math.floor((B.pos[i * 3 + 1] - cube.min[1]) * inv), z = Math.floor((B.pos[i * 3 + 2] - cube.min[2]) * inv);
    if (x < 0) x = 0; else if (x >= G) x = G - 1; if (y < 0) y = 0; else if (y >= G) y = G - 1; if (z < 0) z = 0; else if (z >= G) z = G - 1;
    return (x * G + y) * G + z;
  };
  const copy = (i, o) => {
    V.pos[o * 3] = B.pos[i * 3]; V.pos[o * 3 + 1] = B.pos[i * 3 + 1]; V.pos[o * 3 + 2] = B.pos[i * 3 + 2];
    V.inten[o] = B.inten[i]; V.cls[o] = B.cls[i];
    if (V.rgb && B.rgb) { V.rgb[o * 3] = B.rgb[i * 3]; V.rgb[o * 3 + 1] = B.rgb[i * 3 + 1]; V.rgb[o * 3 + 2] = B.rgb[i * 3 + 2]; }
    for (let f = 0; f < nf; f++) V.fields[f][o] = B.fields[f][i];
  };
  const flush = () => {
    for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) { const v = B.pos[i * 3 + d]; if (v < bbox[d]) bbox[d] = v; if (v > bbox[d + 3]) bbox[d + 3] = v; }
    if (spec.type === 'direct') {
      V.pos.set(B.pos.subarray(0, n * 3), k * 3); V.inten.set(B.inten.subarray(0, n), k); V.cls.set(B.cls.subarray(0, n), k);
      if (V.rgb && B.rgb) V.rgb.set(B.rgb.subarray(0, n * 3), k * 3);
      for (let f = 0; f < nf; f++) V.fields[f].set(B.fields[f].subarray(0, n), k);
      k += n;
    } else if (spec.type === 'hist') {
      for (let i = 0; i < n; i++) hist[cellOf(i)]++;
    } else {
      for (let i = 0; i < n; i++) { const sl = cellSlot[cellOf(i)]; if (sl < 0) continue; copy(i, base[sl] + Atomics.add(cnt, sl, 1)); }
    }
    total += n; n = 0;
  };
  return {
    out: B, // recordReader target (index = sink.i)
    get i() { return n; },
    next() { if (++n === BS) flush(); },
    finish() { if (n) flush(); return { stats: [...B.stats], bbox, cshift: B.cshift ?? 0, count: total, hist }; },
  };
}

// ---------------- decode ----------------
async function decodeLaz({ file, chunks, first, origin, S, sink: spec = { type: 'direct' } }) {
  const h = readLasHeader(file);
  const sink = makeSink({ first, ...spec }, S, h.fields.length, h.hasColor);
  const read = recordReader(h, origin, sink.out);
  const L = await laz();
  const fd = fs.openSync(file, 'r');
  const pp = L._malloc(h.recLen);
  let sinceReport = 0;
  try {
    // read a few MB at a time (several chunks), decode chunk by chunk
    let i = 0;
    while (i < chunks.length) {
      let j = i, bytes = 0;
      while (j < chunks.length && (j === i || bytes + chunks[j].size < 32 << 20)) { bytes += chunks[j].size; j++; }
      const base = chunks[i].start;
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, base);
      const ptr = L._malloc(bytes);
      L.HEAPU8.set(buf, ptr);
      try {
        for (let c = i; c < j; c++) {
          const ch = chunks[c];
          const dec = new L.ChunkDecoder();
          try {
            dec.open(h.fmt, h.recLen, ptr + (ch.start - base));
            for (let r = 0; r < ch.count; r++) {
              dec.getPoint(pp);
              read(new DataView(L.HEAPU8.buffer, pp, h.recLen), 0, sink.i);
              sink.next();
            }
          } finally { dec.delete(); }
          sinceReport += ch.count;
          if (sinceReport > 200000) { progress(sinceReport); sinceReport = 0; }
        }
      } finally { L._free(ptr); }
      i = j;
    }
  } finally { L._free(pp); fs.closeSync(fd); }
  progress(sinceReport);
  return sink.finish();
}

// whole LAZ file without a usable chunk table (sequential; only for files that fit in memory)
async function decodeLazAll({ file, origin, S, sink: spec = { type: 'direct' } }) {
  const h = readLasHeader(file);
  if (h.size > 1.9e9) throw new Error('This LAZ file has no chunk table and is larger than 1.9 GB; re-save it with a current LAZ writer');
  const sink = makeSink({ first: 0, ...spec }, S, h.fields.length, h.hasColor);
  const read = recordReader(h, origin, sink.out);
  const L = await laz();
  const data = fs.readFileSync(file);
  const fptr = L._malloc(data.length);
  L.HEAPU8.set(data, fptr);
  const zip = new L.LASZip();
  const pp = L._malloc(h.recLen);
  try {
    zip.open(fptr, data.length);
    const n = zip.getCount();
    for (let r = 0; r < n; r++) {
      zip.getPoint(pp);
      read(new DataView(L.HEAPU8.buffer, pp, h.recLen), 0, sink.i);
      sink.next();
      if (r % 200000 === 199999) progress(200000);
    }
    return sink.finish();
  } finally { L._free(pp); zip.delete(); L._free(fptr); }
}

async function decodeLas({ file, from, to, origin, S, sink: spec = { type: 'direct' } }) {
  const h = readLasHeader(file);
  const sink = makeSink({ first: from, ...spec }, S, h.fields.length, h.hasColor);
  const read = recordReader(h, origin, sink.out);
  const fd = fs.openSync(file, 'r');
  try {
    const per = Math.max(1, Math.floor((32 << 20) / h.recLen));
    const buf = Buffer.alloc(per * h.recLen);
    for (let r = from; r < to; r += per) {
      const n = Math.min(per, to - r);
      fs.readSync(fd, buf, 0, n * h.recLen, h.dataOffset + r * h.recLen);
      const dv = new DataView(buf.buffer, buf.byteOffset, n * h.recLen);
      for (let i = 0; i < n; i++) { read(dv, i * h.recLen, sink.i); sink.next(); }
      progress(n);
    }
  } finally { fs.closeSync(fd); }
  return sink.finish();
}

// ---------------- text (XYZ/PTS/CSV/TXT) and PLY ----------------
function* lines(file, start = 0) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(16 << 20);
  let rest = '', pos = start;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const chunk = rest + buf.toString('latin1', 0, n);
      const ls = chunk.split(/\r?\n/);
      rest = ls.pop();
      for (const l of ls) yield l;
    }
    if (rest) yield rest;
  } finally { fs.closeSync(fd); }
}
const splitNums = (l) => l.trim().split(/[\s,;]+/).map(Number);
function textScan({ file }) {
  let count = 0, cols = 0, bmin = [Infinity, Infinity, Infinity];
  for (const l of lines(file)) {
    const v = splitNums(l);
    if (v.length < 3 || !isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])) continue;
    if (!cols) cols = v.length;
    for (let d = 0; d < 3; d++) if (v[d] < bmin[d]) bmin[d] = v[d];
    count++;
  }
  return { count, cols, min: bmin };
}
function decodeText({ file, cols, origin, S }) {
  const V = views(S);
  // columns: x y z [i] [r g b]  (PTS: x y z i r g b; XYZRGB: x y z r g b)
  const iCol = cols === 4 || cols >= 7 ? 3 : -1, cCol = cols >= 7 ? 4 : cols >= 6 ? 3 : -1;
  let k = 0;
  for (const l of lines(file)) {
    const v = splitNums(l);
    if (v.length < 3 || !isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])) continue;
    V.pos[k * 3] = v[0] - origin[0]; V.pos[k * 3 + 1] = v[1] - origin[1]; V.pos[k * 3 + 2] = v[2] - origin[2];
    if (iCol >= 0) V.inten[k] = Math.max(0, Math.min(65535, cols >= 7 ? v[iCol] + 2048 : v[iCol]));
    if (V.rgb && cCol >= 0) { V.rgb[k * 3] = v[cCol]; V.rgb[k * 3 + 1] = v[cCol + 1]; V.rgb[k * 3 + 2] = v[cCol + 2]; }
    k++;
    if (k % 500000 === 0) progress(500000);
  }
  progress(k % 500000);
  return { stats: [], bbox: bboxOf(V.pos, 0, k), cshift: 0 };
}
const PLY_SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
export function plyHeader(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(65536);
  const n = fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  const txt = b.toString('latin1', 0, n);
  const end = txt.indexOf('end_header');
  if (!txt.startsWith('ply') || end < 0) throw new Error('Not a PLY file');
  const headerLen = txt.indexOf('\n', end) + 1;
  const ls = txt.slice(0, end).split(/\r?\n/);
  const format = ls.find((l) => l.startsWith('format')).split(/\s+/)[1];
  let count = 0, inVertex = false, before = 0;
  const props = [];
  for (const l of ls) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') { inVertex = t[1] === 'vertex'; if (inVertex) count = +t[2]; else if (!count) before++; } else if (t[0] === 'property' && inVertex && t[1] !== 'list') props.push({ type: t[1], name: t[2], size: PLY_SIZES[t[1]] || 4 });
  }
  if (before) throw new Error('PLY files with elements before the vertex list are not supported');
  let off = 0; for (const p of props) { p.off = off; off += p.size; }
  const ix = (nm) => props.findIndex((p) => p.name === nm);
  const std = new Set(['x', 'y', 'z', 'red', 'green', 'blue', 'r', 'g', 'b', 'intensity', 'scalar_intensity', 'nx', 'ny', 'nz', 'alpha', 'classification', 'scalar_classification']);
  return {
    format, count, props, stride: off, headerLen, ix: ix('x'), iy: ix('y'), iz: ix('z'),
    ir: Math.max(ix('red'), ix('r')), ig: Math.max(ix('green'), ix('g')), ib: Math.max(ix('blue'), ix('b')),
    ii: Math.max(ix('intensity'), ix('scalar_intensity')), ic: Math.max(ix('classification'), ix('scalar_classification')),
    fields: props.map((p, i) => ({ ...p, i })).filter((p) => !std.has(p.name)).map((p) => ({ name: p.name.replace(/^scalar_/, ''), i: p.i })),
  };
}
function decodePly({ file, origin, S }) {
  const h = plyHeader(file);
  const V = views(S);
  const stats = newStats(h.fields.length);
  const put = (k, val) => {
    V.pos[k * 3] = val(h.ix) - origin[0]; V.pos[k * 3 + 1] = val(h.iy) - origin[1]; V.pos[k * 3 + 2] = val(h.iz) - origin[2];
    if (h.ii >= 0) V.inten[k] = Math.max(0, Math.min(65535, val(h.ii)));
    if (h.ic >= 0) V.cls[k] = val(h.ic);
    if (V.rgb) { V.rgb[k * 3] = val(h.ir); V.rgb[k * 3 + 1] = val(h.ig); V.rgb[k * 3 + 2] = val(h.ib); }
    for (let i = 0; i < h.fields.length; i++) { const v = val(h.fields[i].i); V.fields[i][k] = v; if (v < stats[i * 2]) stats[i * 2] = v; if (v > stats[i * 2 + 1]) stats[i * 2 + 1] = v; }
  };
  if (h.format === 'ascii') {
    let k = 0;
    for (const l of lines(file, h.headerLen)) {
      if (k >= h.count) break;
      const v = l.trim().split(/\s+/).map(Number);
      if (v.length < 3) continue;
      put(k++, (i) => v[i]);
    }
  } else {
    const le = h.format === 'binary_little_endian';
    const G = { float: 'getFloat32', float32: 'getFloat32', double: 'getFloat64', float64: 'getFloat64', uchar: 'getUint8', uint8: 'getUint8', char: 'getInt8', int8: 'getInt8', ushort: 'getUint16', uint16: 'getUint16', short: 'getInt16', int16: 'getInt16', uint: 'getUint32', uint32: 'getUint32', int: 'getInt32', int32: 'getInt32' };
    const fd = fs.openSync(file, 'r');
    try {
      const per = Math.max(1, Math.floor((32 << 20) / h.stride));
      const buf = Buffer.alloc(per * h.stride);
      for (let r = 0; r < h.count; r += per) {
        const n = Math.min(per, h.count - r);
        fs.readSync(fd, buf, 0, n * h.stride, h.headerLen + r * h.stride);
        const dv = new DataView(buf.buffer, buf.byteOffset, n * h.stride);
        for (let i = 0; i < n; i++) { const o = i * h.stride; put(r + i, (pi) => { const p = h.props[pi]; return dv[G[p.type]](o + p.off, le); }); }
        progress(n);
      }
    } finally { fs.closeSync(fd); }
  }
  return { stats: [...stats], bbox: bboxOf(V.pos, 0, h.count), cshift: 0 };
}

// ---------------- octree ----------------
// Each node keeps up to one point per cell of a G^3 grid over its cube (an even sample at that level);
// the remaining points go to its 8 children. Leaves keep everything.
const G = 128, LEAF_MAX = 60000, MAX_DEPTH = 22;
export const nodeBytes = (k, a) => { const b = k * (12 + 4 * a.nf + 2 + (a.rgb ? 3 : 0) + 1); return (b + 3) & ~3; };
function buildTree({ task, S, attrs, cachePath, split }) {
  const V = views(S);
  const fd = fs.openSync(cachePath, 'r+');
  const nodes = [], pending = [];
  const bits = new Uint8Array((G * G * G) >> 3);
  let dec = new Uint8Array(Math.max(1, task.end - task.start));
  const counts = new Int32Array(9), offs = new Int32Array(9);
  let written = 0, lastReport = 0;
  const pack = (arr, s, k) => {
    const bytes = nodeBytes(k, attrs);
    const buf = Buffer.alloc(bytes);
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, (12 * k + 4 * attrs.nf * k) / 4);
    let o = 0;
    for (let i = 0; i < k; i++) { const id = arr[s + i]; f32[o++] = V.pos[id * 3]; f32[o++] = V.pos[id * 3 + 1]; f32[o++] = V.pos[id * 3 + 2]; }
    for (let f = 0; f < attrs.nf; f++) { const fa = V.fields[f]; for (let i = 0; i < k; i++) f32[o++] = fa[arr[s + i]]; }
    let bo = o * 4;
    for (let i = 0; i < k; i++) { buf.writeUInt16LE(V.inten[arr[s + i]], bo); bo += 2; }
    if (attrs.rgb) for (let i = 0; i < k; i++) { const id = arr[s + i] * 3; buf[bo++] = V.rgb[id]; buf[bo++] = V.rgb[id + 1]; buf[bo++] = V.rgb[id + 2]; }
    for (let i = 0; i < k; i++) buf[bo++] = V.cls[arr[s + i]];
    return buf;
  };
  const writeNode = (name, arr, s, k, depth) => {
    const buf = pack(arr, s, k), bytes = buf.length;
    const off = Number(Atomics.add(V.counter, 0, BigInt(bytes)));
    fs.writeSync(fd, buf, 0, bytes, off);
    nodes.push([name, k, off, depth]);
    written += k;
    if (written - lastReport > 500000) { progress(written - lastReport); lastReport = written; }
  };
  const rec = (name, s, e, parity, min, size, depth) => {
    const src = parity ? V.idxB : V.idxA, dst = parity ? V.idxA : V.idxB;
    const n = e - s;
    if (n <= LEAF_MAX || depth >= MAX_DEPTH) { writeNode(name, src, s, n, depth); return; }
    if (split != null && depth >= split && name !== task.name) { pending.push({ name, start: s, end: e, parity, min, size, depth }); return; }
    bits.fill(0); counts.fill(0);
    if (dec.length < n) dec = new Uint8Array(n);
    const inv = G / size, half = size / 2, P = V.pos, mx = min[0], my = min[1], mz = min[2];
    for (let i = 0; i < n; i++) {
      const id = src[s + i];
      const x = P[id * 3] - mx, y = P[id * 3 + 1] - my, z = P[id * 3 + 2] - mz;
      let cx = (x * inv) | 0, cy = (y * inv) | 0, cz = (z * inv) | 0;
      if (cx >= G) cx = G - 1; if (cy >= G) cy = G - 1; if (cz >= G) cz = G - 1;
      if (cx < 0) cx = 0; if (cy < 0) cy = 0; if (cz < 0) cz = 0;
      const cell = (cx * G + cy) * G + cz, byte = cell >> 3, m = 1 << (cell & 7);
      let d;
      if (!(bits[byte] & m)) { bits[byte] |= m; d = 8; } else d = (x >= half ? 4 : 0) | (y >= half ? 2 : 0) | (z >= half ? 1 : 0);
      dec[i] = d; counts[d]++;
    }
    offs[8] = s; let acc = s + counts[8];
    for (let c = 0; c < 8; c++) { offs[c] = acc; acc += counts[c]; }
    for (let i = 0; i < n; i++) dst[offs[dec[i]]++] = src[s + i];
    writeNode(name, dst, s, counts[8], depth);
    let cs = s + counts[8];
    const cc = Int32Array.from(counts);
    for (let c = 0; c < 8; c++) {
      if (cc[c] > 0) rec(name + c, cs, cs + cc[c], 1 - parity, [mx + (c & 4 ? half : 0), my + (c & 2 ? half : 0), mz + (c & 1 ? half : 0)], half, depth + 1);
      cs += cc[c];
    }
  };
  // A bucket of a big cloud (task.up = root cube): first take its share of the ancestor nodes. Every grid
  // cell of an ancestor (level l) lies inside one bucket, so this gives the same even sample as building
  // the whole tree top-down. Ancestor samples go back to the main process as packed pieces.
  const pieces = [];
  let s0 = task.start;
  if (task.up) {
    const src = task.parity ? V.idxB : V.idxA, P = V.pos;
    let min = task.up.min.slice(), size = task.up.size;
    for (let l = 0; l < task.depth; l++) {
      const anc = task.name.slice(0, l + 1);
      if (l > 0) { const c = +task.name[l]; size /= 2; if (c & 4) min[0] += size; if (c & 2) min[1] += size; if (c & 1) min[2] += size; }
      bits.fill(0);
      const inv = G / size;
      let k = 0;
      for (let i = s0; i < task.end; i++) {
        const id = src[i];
        let cx = ((P[id * 3] - min[0]) * inv) | 0, cy = ((P[id * 3 + 1] - min[1]) * inv) | 0, cz = ((P[id * 3 + 2] - min[2]) * inv) | 0;
        if (cx >= G) cx = G - 1; if (cy >= G) cy = G - 1; if (cz >= G) cz = G - 1;
        if (cx < 0) cx = 0; if (cy < 0) cy = 0; if (cz < 0) cz = 0;
        const cell = (cx * G + cy) * G + cz, byte = cell >> 3, m = 1 << (cell & 7);
        if (bits[byte] & m) continue;
        bits[byte] |= m;
        const t = src[s0 + k]; src[s0 + k] = id; src[i] = t; k++;
      }
      if (k) { pieces.push({ name: anc, depth: l, n: k, buf: pack(src, s0, k) }); written += k; }
      s0 += k;
    }
  }
  try { if (s0 < task.end) rec(task.name, s0, task.end, task.parity, task.min, task.size, task.depth); } finally { fs.closeSync(fd); }
  progress(written - lastReport);
  return { nodes, pending, pieces };
}

// ---------------- export (from the cache) ----------------
function exportCloud({ cachePath, meta: meta0, out, format, transform, progressEvery = 1000000 }) {
  // transform {R: 9 (row-major), t: 3} in absolute scan coordinates: abs' = R abs + t
  // -> new origin R*O + t, local' = R * local
  let meta = meta0, R = null;
  if (transform) {
    R = transform.R; const t = transform.t, O0 = meta0.origin, b0 = meta0.bbox;
    const rot = (v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
    const o2 = rot(O0).map((v, d) => v + t[d]);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) { const c = rot([i & 1 ? b0[3] : b0[0], i & 2 ? b0[4] : b0[1], i & 4 ? b0[5] : b0[2]]); for (let d = 0; d < 3; d++) { bb[d] = Math.min(bb[d], c[d]); bb[d + 3] = Math.max(bb[d + 3], c[d]); } }
    meta = { ...meta0, origin: o2, bbox: bb };
  }
  const A = meta.attrs, nf = A.fields.length;
  const ifd = fs.openSync(cachePath, 'r');
  const ofd = fs.openSync(out, 'w');
  const O = meta.origin;
  let done = 0, rep = 0;
  try {
    const w = (b) => fs.writeSync(ofd, b);
    const total = meta.count;
    if (format === 'las') {
      const fmt = A.rgb ? 2 : 0, base = A.rgb ? 26 : 20, recLen = base + 4 * nf;
      const sc = meta.lasScale || [0.001, 0.001, 0.001];
      const off = O.map((v) => Math.round(v));
      const vlrLen = nf ? 54 + 192 * nf : 0;
      const H = Buffer.alloc(375);
      H.write('LASF', 0, 'latin1'); H.writeUInt8(1, 24); H.writeUInt8(4, 25);
      H.write('MonoLith', 26, 'latin1'); H.write('MonoLith', 58, 'latin1');
      const now = new Date(); H.writeUInt16LE(Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5), 90); H.writeUInt16LE(now.getFullYear(), 92);
      H.writeUInt16LE(375, 94); H.writeUInt32LE(375 + vlrLen, 96); H.writeUInt32LE(nf ? 1 : 0, 100);
      H.writeUInt8(fmt, 104); H.writeUInt16LE(recLen, 105); H.writeUInt32LE(total <= 0xffffffff ? total : 0, 107);
      for (let d = 0; d < 3; d++) { H.writeDoubleLE(sc[d], 131 + d * 8); H.writeDoubleLE(off[d], 155 + d * 8); }
      const bb = meta.bbox;
      H.writeDoubleLE(bb[3] + O[0], 179); H.writeDoubleLE(bb[0] + O[0], 187); H.writeDoubleLE(bb[4] + O[1], 195); H.writeDoubleLE(bb[1] + O[1], 203); H.writeDoubleLE(bb[5] + O[2], 211); H.writeDoubleLE(bb[2] + O[2], 219);
      H.writeBigUInt64LE(BigInt(total), 247);
      w(H);
      if (nf) {
        const V = Buffer.alloc(vlrLen);
        V.write('LASF_Spec', 2, 'latin1'); V.writeUInt16LE(4, 18); V.writeUInt16LE(192 * nf, 20); V.write('Extra bytes', 22, 'latin1');
        A.fields.forEach((f, i) => { const o = 54 + i * 192; V.writeUInt8(9, o + 2); V.write(f.name.slice(0, 31), o + 4, 'latin1'); V.write(f.name.slice(0, 31), o + 160, 'latin1'); });
        w(V);
      }
      eachNode(ifd, meta, R, (n, P, F, I, C, K) => {
        const b = Buffer.alloc(n * recLen);
        for (let i = 0; i < n; i++) {
          const o = i * recLen;
          for (let d = 0; d < 3; d++) b.writeInt32LE(Math.round((P[i * 3 + d] + O[d] - off[d]) / sc[d]), o + d * 4);
          b.writeUInt16LE(I[i], o + 12); b.writeUInt8(0x09, o + 14); b.writeUInt8(K[i] & 0x1f, o + 15);
          if (A.rgb) { b.writeUInt16LE(C[i * 3] * 257, o + 20); b.writeUInt16LE(C[i * 3 + 1] * 257, o + 22); b.writeUInt16LE(C[i * 3 + 2] * 257, o + 24); }
          for (let f = 0; f < nf; f++) b.writeFloatLE(F[f][i], o + base + 4 * f);
        }
        w(b);
        done += n; if (done - rep > progressEvery) { progress(done - rep); rep = done; }
      });
    } else if (format === 'ply') {
      let hd = `ply\nformat binary_little_endian 1.0\ncomment MonoLith\nelement vertex ${total}\nproperty double x\nproperty double y\nproperty double z\n`;
      if (A.rgb) hd += 'property uchar red\nproperty uchar green\nproperty uchar blue\n';
      hd += 'property ushort intensity\nproperty uchar classification\n';
      for (const f of A.fields) hd += `property float ${f.name.replace(/\s+/g, '_')}\n`;
      hd += 'end_header\n';
      w(Buffer.from(hd, 'latin1'));
      const rl = 24 + (A.rgb ? 3 : 0) + 3 + 4 * nf;
      eachNode(ifd, meta, R, (n, P, F, I, C, K) => {
        const b = Buffer.alloc(n * rl);
        for (let i = 0; i < n; i++) {
          let o = i * rl;
          for (let d = 0; d < 3; d++) { b.writeDoubleLE(P[i * 3 + d] + O[d], o); o += 8; }
          if (A.rgb) { b[o++] = C[i * 3]; b[o++] = C[i * 3 + 1]; b[o++] = C[i * 3 + 2]; }
          b.writeUInt16LE(I[i], o); o += 2; b[o++] = K[i];
          for (let f = 0; f < nf; f++) { b.writeFloatLE(F[f][i], o); o += 4; }
        }
        w(b);
        done += n; if (done - rep > progressEvery) { progress(done - rep); rep = done; }
      });
    } else {
      w(Buffer.from(`// X Y Z${A.rgb ? ' R G B' : ''} Intensity${A.fields.map((f) => ' ' + f.name.replace(/\s+/g, '_')).join('')}\n`, 'latin1'));
      eachNode(ifd, meta, R, (n, P, F, I, C) => {
        const parts = new Array(n);
        for (let i = 0; i < n; i++) {
          let s = `${(P[i * 3] + O[0]).toFixed(4)} ${(P[i * 3 + 1] + O[1]).toFixed(4)} ${(P[i * 3 + 2] + O[2]).toFixed(4)}`;
          if (A.rgb) s += ` ${C[i * 3]} ${C[i * 3 + 1]} ${C[i * 3 + 2]}`;
          s += ` ${I[i]}`;
          for (let f = 0; f < nf; f++) s += ' ' + +F[f][i].toFixed(5);
          parts[i] = s;
        }
        w(Buffer.from(parts.join('\n') + '\n', 'latin1'));
        done += n; if (done - rep > progressEvery) { progress(done - rep); rep = done; }
      });
    }
  } finally { fs.closeSync(ifd); fs.closeSync(ofd); }
  progress(done - rep);
  return { written: done };
}
// read every node of the cache and hand its arrays to fn
function eachNode(fd, meta, R, fn) {
  const A = meta.attrs, nf = A.fields.length;
  for (const [, n, off] of meta.nodes) {
    if (!n) continue;
    const bytes = nodeBytes(n, { nf, rgb: A.rgb });
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, off);
    const ab = buf.buffer, bo = buf.byteOffset;
    const P = new Float32Array(ab, bo, n * 3);
    if (R) for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; P[i * 3] = R[0] * x + R[1] * y + R[2] * z; P[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z; P[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z; }
    const F = []; for (let f = 0; f < nf; f++) F.push(new Float32Array(ab, bo + 12 * n + 4 * n * f, n));
    let o = bo + 12 * n + 4 * n * nf;
    const I = new Uint16Array(ab.slice(o, o + 2 * n)); o += 2 * n;
    const C = A.rgb ? new Uint8Array(ab, o, 3 * n) : null; if (A.rgb) o += 3 * n;
    const K = new Uint8Array(ab, o, n);
    fn(n, P, F, I, C, K);
  }
}


// ---------------- streaming gather (edits on clouds too big for memory) ----------------
// Reads cache nodes, applies the transform and the edit predicate, and passes the points of output
// `which` to a sink (hist / bucket rounds, like opening a big scan).
function gatherFilter({ cache, nodes, A, fieldMap, R, delta, pred, which, gidStart, S, sink: spec }) {
  const nf = fieldMap.length, dstRgb = !!spec.rgb;
  const sink = makeSink(spec, S, nf, dstRgb);
  const B = sink.out, test = E.makePredicate(pred);
  const fd = fs.openSync(cache, 'r');
  const Fv = new Float64Array(nf);
  let gid = gidStart, rep = 0;
  try {
    for (const [, n, off] of nodes) {
      if (!n) continue;
      const bytes = nodeBytes(n, A);
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, off);
      const ab = buf.buffer, bo = buf.byteOffset;
      const P = new Float32Array(ab, bo, n * 3);
      const F = []; for (let f = 0; f < A.nf; f++) F.push(new Float32Array(ab, bo + 12 * n + 4 * n * f, n));
      let o = bo + 12 * n + 4 * n * A.nf;
      const I = new Uint16Array(ab.slice(o, o + 2 * n)); o += 2 * n;
      const C = A.rgb ? new Uint8Array(ab, o, 3 * n) : null; if (A.rgb) o += 3 * n;
      const K = new Uint8Array(ab, o, n);
      for (let i = 0; i < n; i++, gid++) {
        const x0 = P[i * 3], y0 = P[i * 3 + 1], z0 = P[i * 3 + 2];
        let x, y, z;
        if (R) { x = R[0] * x0 + R[1] * y0 + R[2] * z0 + delta[0]; y = R[3] * x0 + R[4] * y0 + R[5] * z0 + delta[1]; z = R[6] * x0 + R[7] * y0 + R[8] * z0 + delta[2]; }
        else { x = x0 + delta[0]; y = y0 + delta[1]; z = z0 + delta[2]; }
        for (let f = 0; f < nf; f++) Fv[f] = fieldMap[f] >= 0 ? F[fieldMap[f]][i] : 0;
        if (test(x, y, z, I[i], K[i], Fv, gid) !== which) continue;
        const k = sink.i;
        B.pos[k * 3] = x; B.pos[k * 3 + 1] = y; B.pos[k * 3 + 2] = z;
        B.inten[k] = I[i]; B.cls[k] = K[i];
        if (dstRgb) { if (C) { B.rgb[k * 3] = C[i * 3]; B.rgb[k * 3 + 1] = C[i * 3 + 1]; B.rgb[k * 3 + 2] = C[i * 3 + 2]; } else { B.rgb[k * 3] = B.rgb[k * 3 + 1] = B.rgb[k * 3 + 2] = 170; } }
        for (let f = 0; f < nf; f++) { const v = Fv[f]; B.fields[f][k] = v; if (v < B.stats[f * 2]) B.stats[f * 2] = v; if (v > B.stats[f * 2 + 1]) B.stats[f * 2 + 1] = v; }
        sink.next();
      }
      rep += n;
      if (rep > 300000) { progress(rep); rep = 0; }
    }
  } finally { fs.closeSync(fd); }
  progress(rep);
  return sink.finish();
}

const OPS = { ...E, ...AN, ...RG, gatherFilter, decodeLaz, decodeLazAll, decodeLas, textScan, decodeText, decodePly, plyHeader: ({ file }) => plyHeader(file), buildTree, exportCloud };
parentPort.on('message', async ({ id, op, args }) => {
  curId = id;
  try {
    const f = OPS[op];
    if (!f) throw new Error('Unknown cloud op ' + op);
    const result = await f(args, progress);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.stack || e?.message || e) });
  }
});
