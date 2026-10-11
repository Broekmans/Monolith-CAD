// Point cloud reader (worker thread): LAS/LAZ (1.0-1.4, formats 0-10),
// PLY (ascii / binary), and XYZ/TXT/CSV/PTS text files.
// Output is decimated to a display budget and converted to world space:
// world = ((src - shift) * scale) mapped as (x, z, -y) so that +Z (up) in the
// scan becomes +Y in MonoLith, matching the plan's (x, y) -> (x, -z) convention.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let lazModule = null;
async function laz() {
  if (!lazModule) {
    const { createLazPerf } = require('laz-perf');
    lazModule = await createLazPerf();
  }
  return lazModule;
}

const progress = (id, p, msg) => parentPort.postMessage({ id, progress: p, msg });

// ---------------- LAS / LAZ ----------------
function lasHeader(fd) {
  const b = Buffer.alloc(375);
  fs.readSync(fd, b, 0, 375, 0);
  if (b.toString('latin1', 0, 4) !== 'LASF') throw new Error('Not a LAS/LAZ file');
  const vMaj = b.readUInt8(24), vMin = b.readUInt8(25);
  const headerSize = b.readUInt16LE(94);
  const dataOffset = b.readUInt32LE(96);
  const fmtRaw = b.readUInt8(104);
  const compressed = (fmtRaw & 0x80) !== 0 || (fmtRaw & 0x40) !== 0;
  const fmt = fmtRaw & 0x3f;
  const recLen = b.readUInt16LE(105);
  let count = b.readUInt32LE(107);
  if (vMin >= 4 && headerSize >= 375) { const c64 = Number(b.readBigUInt64LE(247)); if (c64 > 0) count = c64; }
  const scale = [b.readDoubleLE(131), b.readDoubleLE(139), b.readDoubleLE(147)];
  const offset = [b.readDoubleLE(155), b.readDoubleLE(163), b.readDoubleLE(171)];
  const max = [b.readDoubleLE(179), b.readDoubleLE(195), b.readDoubleLE(211)];
  const min = [b.readDoubleLE(187), b.readDoubleLE(203), b.readDoubleLE(219)];
  const rgbOff = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
  return { version: `${vMaj}.${vMin}`, dataOffset, fmt, recLen, count, scale, offset, min, max, compressed, hasColor: rgbOff !== undefined, rgbOff, system: b.toString('latin1', 26, 58).replace(/\0.*$/, '').trim() };
}

function makeSink(count, maxPoints, opts, hasColor) {
  const stride = Math.max(1, Math.ceil(count / maxPoints));
  const n = Math.ceil(count / stride);
  const pos = new Float32Array(n * 3);
  const col = hasColor ? new Uint8Array(n * 3) : null;
  const inten = new Uint16Array(n);
  const { shift, scale } = opts;
  let k = 0;
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  return {
    stride,
    add(x, y, z, r, g, bl, i) {
      if (k >= n) return;
      const X = (x - shift[0]) * scale, Y = (y - shift[1]) * scale, Z = (z - shift[2]) * scale;
      pos[k * 3] = X; pos[k * 3 + 1] = Z; pos[k * 3 + 2] = -Y;
      if (col) { col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = bl; }
      inten[k] = i;
      if (X < bmin[0]) bmin[0] = X; if (X > bmax[0]) bmax[0] = X;
      if (Y < bmin[1]) bmin[1] = Y; if (Y > bmax[1]) bmax[1] = Y;
      if (Z < bmin[2]) bmin[2] = Z; if (Z > bmax[2]) bmax[2] = Z;
      k++;
    },
    result() {
      return { positions: pos.subarray(0, k * 3), colors: col ? col.subarray(0, k * 3) : null, intensity: inten.subarray(0, k), kept: k, bboxMin: bmin, bboxMax: bmax };
    },
  };
}

// RGB in LAS is 16-bit by spec but many writers store 8-bit values.
function colorShift(sample) { return sample > 255 ? 8 : 0; }

async function readLas(id, file, opts) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = lasHeader(fd);
    const sink = makeSink(h.count, opts.maxPoints, opts, h.hasColor);
    let cshift = null;
    const take = (dv, o) => {
      const x = dv.getInt32(o, true) * h.scale[0] + h.offset[0];
      const y = dv.getInt32(o + 4, true) * h.scale[1] + h.offset[1];
      const z = dv.getInt32(o + 8, true) * h.scale[2] + h.offset[2];
      const i = dv.getUint16(o + 12, true);
      let r = 0, g = 0, b = 0;
      if (h.hasColor) {
        r = dv.getUint16(o + h.rgbOff, true); g = dv.getUint16(o + h.rgbOff + 2, true); b = dv.getUint16(o + h.rgbOff + 4, true);
        if (cshift === null && (r || g || b)) cshift = colorShift(Math.max(r, g, b));
        const s = cshift || 0; r >>= s; g >>= s; b >>= s;
      }
      sink.add(x, y, z, r, g, b, i);
    };
    if (!h.compressed) {
      const recsPerChunk = Math.max(1, Math.floor((64 << 20) / h.recLen));
      const buf = Buffer.alloc(recsPerChunk * h.recLen);
      let done = 0;
      while (done < h.count) {
        const nrec = Math.min(recsPerChunk, h.count - done);
        fs.readSync(fd, buf, 0, nrec * h.recLen, h.dataOffset + done * h.recLen);
        const dv = new DataView(buf.buffer, buf.byteOffset, nrec * h.recLen);
        const first = (sink.stride - (done % sink.stride)) % sink.stride;
        for (let r = first; r < nrec; r += sink.stride) take(dv, r * h.recLen);
        done += nrec;
        progress(id, done / h.count);
      }
    } else {
      const size = fs.fstatSync(fd).size;
      if (size > 1.8e9) throw new Error('LAZ files larger than 1.8 GB are not supported yet - split or decimate the file first');
      const L = await laz();
      const data = fs.readFileSync(file);
      const fptr = L._malloc(data.length);
      L.HEAPU8.set(data, fptr);
      const zip = new L.LASZip();
      try {
        zip.open(fptr, data.length);
        const recLen = zip.getPointLength();
        const pptr = L._malloc(recLen);
        const n = zip.getCount();
        for (let r = 0; r < n; r++) {
          zip.getPoint(pptr);
          if (r % sink.stride !== 0) continue;
          const dv = new DataView(L.HEAPU8.buffer, pptr, recLen);
          take(dv, 0);
          if (r % 200000 === 0) progress(id, r / n);
        }
        L._free(pptr);
      } finally { zip.delete(); L._free(fptr); }
    }
    return { header: h, ...sink.result() };
  } finally { fs.closeSync(fd); }
}

// ---------------- text formats ----------------
function* textLines(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(16 << 20);
  let rest = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const chunk = rest + buf.toString('latin1', 0, n);
      const lines = chunk.split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) yield l;
    }
    if (rest) yield rest;
  } finally { fs.closeSync(fd); }
}

function textInfo(file) {
  const size = fs.statSync(file).size;
  let n = 0, bytes = 0, cols = 0, first = null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const l of textLines(file)) {
    bytes += l.length + 1;
    const v = l.trim().split(/[\s,;]+/).map(Number);
    if (v.length < 3 || v.slice(0, 3).some((x) => !isFinite(x))) continue;
    if (!first) { first = v; cols = v.length; }
    for (let d = 0; d < 3; d++) { if (v[d] < min[d]) min[d] = v[d]; if (v[d] > max[d]) max[d] = v[d]; }
    n++;
    if (n >= 200000) break; // estimate from a sample
  }
  const est = bytes < size ? Math.round((n * size) / Math.max(1, bytes)) : n;
  return { count: est, min, max, hasColor: cols >= 6, cols, estimated: bytes < size };
}

async function readText(id, file, opts, info) {
  const sink = makeSink(info.count * 1.2, opts.maxPoints, opts, info.hasColor);
  let r = 0;
  const colIdx = info.cols >= 7 ? 4 : 3; // PTS: x y z i r g b
  for (const l of textLines(file)) {
    const v = l.trim().split(/[\s,;]+/).map(Number);
    if (v.length < 3 || !isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])) continue;
    if (r++ % sink.stride !== 0) continue;
    const c = info.hasColor ? [v[colIdx], v[colIdx + 1], v[colIdx + 2]] : [0, 0, 0];
    sink.add(v[0], v[1], v[2], c[0], c[1], c[2], info.cols >= 7 || info.cols === 4 ? v[3] : 0);
    if (r % 500000 === 0) progress(id, Math.min(0.99, r / info.count));
  }
  return sink.result();
}

// ---------------- PLY ----------------
function plyHeader(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(65536);
  const n = fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  const txt = b.toString('latin1', 0, n);
  const end = txt.indexOf('end_header');
  if (!txt.startsWith('ply') || end < 0) throw new Error('Not a PLY file');
  const headerLen = txt.indexOf('\n', end) + 1;
  const lines = txt.slice(0, end).split(/\r?\n/);
  const format = lines.find((l) => l.startsWith('format')).split(/\s+/)[1];
  let count = 0, props = [], inVertex = false, beforeVertex = 0;
  const sizes = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') { inVertex = t[1] === 'vertex'; if (inVertex) count = +t[2]; else if (!count) beforeVertex++; }
    else if (t[0] === 'property' && inVertex) props.push({ type: t[1], name: t[2], size: sizes[t[1]] });
  }
  if (beforeVertex) throw new Error('PLY files with elements before the vertex list are not supported');
  let off = 0;
  for (const p of props) { p.off = off; off += p.size || 0; }
  const idx = (n2) => props.findIndex((p) => p.name === n2);
  return { format, count, props, stride: off, headerLen, ix: idx('x'), iy: idx('y'), iz: idx('z'), ir: idx('red'), ig: idx('green'), ib: idx('blue'), ii: idx('intensity'), hasColor: idx('red') >= 0 };
}

async function readPly(id, file, opts, h) {
  const sink = makeSink(h.count, opts.maxPoints, opts, h.hasColor);
  if (h.format === 'ascii') {
    let r = 0, line = 0;
    for (const l of textLines(file)) {
      if (line++ < 1) { if (!l.startsWith('ply')) throw new Error('Bad PLY'); }
      if (line <= h.headerLines) continue;
      if (r >= h.count) break;
      const v = l.trim().split(/\s+/).map(Number);
      if (r++ % sink.stride) continue;
      sink.add(v[h.ix], v[h.iy], v[h.iz], h.ir >= 0 ? v[h.ir] : 0, h.ig >= 0 ? v[h.ig] : 0, h.ib >= 0 ? v[h.ib] : 0, h.ii >= 0 ? v[h.ii] : 0);
    }
    return sink.result();
  }
  const le = h.format === 'binary_little_endian';
  const get = (dv, o, p) => {
    switch (p.type) {
      case 'float': case 'float32': return dv.getFloat32(o + p.off, le);
      case 'double': case 'float64': return dv.getFloat64(o + p.off, le);
      case 'uchar': case 'uint8': return dv.getUint8(o + p.off);
      case 'char': case 'int8': return dv.getInt8(o + p.off);
      case 'ushort': case 'uint16': return dv.getUint16(o + p.off, le);
      case 'short': case 'int16': return dv.getInt16(o + p.off, le);
      case 'uint': case 'uint32': return dv.getUint32(o + p.off, le);
      default: return dv.getInt32(o + p.off, le);
    }
  };
  const fd = fs.openSync(file, 'r');
  try {
    const per = Math.max(1, Math.floor((64 << 20) / h.stride));
    const buf = Buffer.alloc(per * h.stride);
    let done = 0;
    while (done < h.count) {
      const nrec = Math.min(per, h.count - done);
      fs.readSync(fd, buf, 0, nrec * h.stride, h.headerLen + done * h.stride);
      const dv = new DataView(buf.buffer, buf.byteOffset, nrec * h.stride);
      const first = (sink.stride - (done % sink.stride)) % sink.stride;
      for (let r = first; r < nrec; r += sink.stride) {
        const o = r * h.stride, P = h.props;
        sink.add(get(dv, o, P[h.ix]), get(dv, o, P[h.iy]), get(dv, o, P[h.iz]),
          h.ir >= 0 ? get(dv, o, P[h.ir]) : 0, h.ig >= 0 ? get(dv, o, P[h.ig]) : 0, h.ib >= 0 ? get(dv, o, P[h.ib]) : 0, h.ii >= 0 ? get(dv, o, P[h.ii]) : 0);
      }
      done += nrec;
      progress(id, done / h.count);
    }
  } finally { fs.closeSync(fd); }
  return sink.result();
}

// ---------------- API ----------------
function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.las' || ext === '.laz') return 'las';
  if (ext === '.ply') return 'ply';
  return 'text';
}

async function info(file) {
  const kind = kindOf(file);
  const size = fs.statSync(file).size;
  if (kind === 'las') {
    const fd = fs.openSync(file, 'r');
    try { const h = lasHeader(fd); return { kind, size, count: h.count, min: h.min, max: h.max, hasColor: h.hasColor, format: `LAS ${h.version} (point format ${h.fmt}${h.compressed ? ', LAZ compressed' : ''})`, system: h.system }; }
    finally { fs.closeSync(fd); }
  }
  if (kind === 'ply') {
    const h = plyHeader(file);
    // bounds from a quick decimated pass
    const r = await readPly(0, file, { maxPoints: 20000, shift: [0, 0, 0], scale: 1 }, { ...h, headerLines: headerLineCount(file) });
    return { kind, size, count: h.count, min: [r.bboxMin[0], r.bboxMin[1], r.bboxMin[2]], max: [r.bboxMax[0], r.bboxMax[1], r.bboxMax[2]], hasColor: h.hasColor, format: `PLY (${h.format})` };
  }
  const t = textInfo(file);
  return { kind, size, count: t.count, min: t.min, max: t.max, hasColor: t.hasColor, format: `ASCII points (${t.cols} columns)${t.estimated ? ', count estimated' : ''}` };
}
function headerLineCount(file) {
  const b = Buffer.alloc(65536);
  const fd = fs.openSync(file, 'r'); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
  const txt = b.toString('latin1', 0, n);
  return txt.slice(0, txt.indexOf('end_header')).split(/\n/).length;
}

async function load(id, file, opts) {
  const kind = kindOf(file);
  let r;
  if (kind === 'las') r = await readLas(id, file, opts);
  else if (kind === 'ply') { const h = plyHeader(file); r = await readPly(id, file, opts, { ...h, headerLines: headerLineCount(file) }); }
  else r = await readText(id, file, opts, textInfo(file));
  progress(id, 1);
  return r;
}

parentPort.on('message', async ({ id, op, args }) => {
  try {
    let result, transfer = [];
    if (op === 'info') result = await info(args.path);
    else if (op === 'load') {
      result = await load(id, args.path, args);
      // copy subarrays into compact buffers for transfer
      const compact = (a) => (a ? a.slice() : null);
      result = { ...result, positions: compact(result.positions), colors: compact(result.colors), intensity: compact(result.intensity), header: undefined };
      transfer = [result.positions.buffer, result.intensity.buffer, ...(result.colors ? [result.colors.buffer] : [])];
    } else throw new Error('Unknown point cloud op ' + op);
    parentPort.postMessage({ id, result }, transfer);
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
