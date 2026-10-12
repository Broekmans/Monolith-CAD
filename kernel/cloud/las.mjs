// LAS/LAZ reading for the point cloud editor: header + VLRs (extra bytes, LASzip), the LAZ chunk table
// (so chunks can be decompressed in parallel), and per-record field extraction into flat arrays.
import fs from 'node:fs';

// ---------------- header ----------------
const BASE_LEN = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };
const RGB_OFF = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
const EB_TYPES = { 1: ['getUint8', 1], 2: ['getInt8', 1], 3: ['getUint16', 2], 4: ['getInt16', 2], 5: ['getUint32', 4], 6: ['getInt32', 4], 7: ['getBigUint64', 8], 8: ['getBigInt64', 8], 9: ['getFloat32', 4], 10: ['getFloat64', 8] };

export function readLasHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const b = Buffer.alloc(375);
    fs.readSync(fd, b, 0, 375, 0);
    if (b.toString('latin1', 0, 4) !== 'LASF') throw new Error('Not a LAS/LAZ file');
    const vMaj = b.readUInt8(24), vMin = b.readUInt8(25);
    const headerSize = b.readUInt16LE(94);
    const dataOffset = b.readUInt32LE(96);
    const nVlr = b.readUInt32LE(100);
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
    if (BASE_LEN[fmt] === undefined) throw new Error(`LAS point format ${fmt} is not supported`);
    // VLRs
    const vlrs = [];
    let pos = headerSize;
    for (let i = 0; i < nVlr && pos + 54 <= dataOffset; i++) {
      const vh = Buffer.alloc(54);
      fs.readSync(fd, vh, 0, 54, pos);
      const user = vh.toString('latin1', 2, 18).replace(/\0.*$/, '');
      const rec = vh.readUInt16LE(18), len = vh.readUInt16LE(20);
      const data = Buffer.alloc(len);
      fs.readSync(fd, data, 0, len, pos + 54);
      vlrs.push({ user, rec, data });
      pos += 54 + len;
    }
    // extra bytes (scalar fields)
    const fields = [];
    const eb = vlrs.find((v) => v.user === 'LASF_Spec' && v.rec === 4);
    let ebOff = BASE_LEN[fmt];
    if (eb) {
      for (let o = 0; o + 192 <= eb.data.length; o += 192) {
        const d = eb.data;
        const type = d.readUInt8(o + 2), opt = d.readUInt8(o + 3);
        const name = d.toString('latin1', o + 4, o + 36).replace(/\0.*$/, '').trim();
        const opts = d.readUInt8(o + 3);
        let len;
        if (type === 0) len = opt; // undocumented bytes: options holds the size
        else len = EB_TYPES[type]?.[1] || 0;
        if (type > 0 && EB_TYPES[type]) {
          const sc = (opts & 8) ? d.readDoubleLE(o + 112) : 1;
          const of = (opts & 16) ? d.readDoubleLE(o + 136) : 0;
          fields.push({ name: name || `extra${fields.length + 1}`, type, off: ebOff, scale: sc, offset: of });
        }
        ebOff += len;
      }
    }
    // LASzip VLR
    let laszip = null;
    const lz = vlrs.find((v) => v.user === 'laszip encoded' && v.rec === 22204);
    if (lz) {
      const d = lz.data;
      laszip = { compressor: d.readUInt16LE(0), chunkSize: d.readUInt32LE(12) };
    }
    return {
      version: `${vMaj}.${vMin}`, dataOffset, fmt, recLen, count, scale, offset, min, max, compressed, size, laszip, fields,
      hasColor: RGB_OFF[fmt] !== undefined, rgbOff: RGB_OFF[fmt], ext: fmt >= 6,
      system: b.toString('latin1', 26, 58).replace(/\0.*$/, '').trim(),
      software: b.toString('latin1', 58, 90).replace(/\0.*$/, '').trim(),
    };
  } finally { fs.closeSync(fd); }
}

// ---------------- LAZ chunk table ----------------
// The chunk table is compressed with LASzip's arithmetic coder + integer compressor (32 bits, 2 contexts).
const AC_MinLength = 0x01000000, DM_LengthShift = 15, DM_MaxCount = 1 << 15, BM_LengthShift = 13, BM_MaxCount = 1 << 13;

class BitModel {
  constructor() { this.bit0Count = 1; this.bitCount = 2; this.bit0Prob = 1 << (BM_LengthShift - 1); this.updateCycle = this.bitsUntilUpdate = 4; }
  update() {
    if ((this.bitCount += this.updateCycle) > BM_MaxCount) {
      this.bitCount = (this.bitCount + 1) >>> 1; this.bit0Count = (this.bit0Count + 1) >>> 1;
      if (this.bit0Count === this.bitCount) ++this.bitCount;
    }
    const scale = Math.floor(0x80000000 / this.bitCount);
    this.bit0Prob = Math.floor((this.bit0Count * scale) / 2 ** (31 - BM_LengthShift));
    this.updateCycle = (5 * this.updateCycle) >>> 2; if (this.updateCycle > 64) this.updateCycle = 64;
    this.bitsUntilUpdate = this.updateCycle;
  }
}
class SymModel {
  constructor(symbols) {
    this.symbols = symbols;
    if (symbols > 16) {
      let tb = 3; while (symbols > (1 << (tb + 2))) ++tb;
      this.tableSize = 1 << tb; this.tableShift = DM_LengthShift - tb;
      this.table = new Uint32Array(this.tableSize + 2);
    } else { this.tableSize = 0; this.tableShift = 0; this.table = null; }
    this.dist = new Float64Array(symbols); this.count = new Float64Array(symbols).fill(1);
    this.total = 0; this.updateCycle = symbols; this.lastSymbol = symbols - 1;
    this.update();
    this.symbolsUntilUpdate = this.updateCycle = (symbols + 6) >>> 1;
  }
  update() {
    const S = this.symbols;
    if ((this.total += this.updateCycle) > DM_MaxCount) { this.total = 0; for (let k = 0; k < S; k++) { this.count[k] = Math.floor((this.count[k] + 1) / 2); this.total += this.count[k]; } }
    const scale = Math.floor(0x80000000 / this.total);
    let sum = 0, s = 0;
    if (!this.tableSize) for (let k = 0; k < S; k++) { this.dist[k] = Math.floor((scale * sum) / 2 ** (31 - DM_LengthShift)); sum += this.count[k]; }
    else {
      for (let k = 0; k < S; k++) {
        this.dist[k] = Math.floor((scale * sum) / 2 ** (31 - DM_LengthShift)); sum += this.count[k];
        const w = this.dist[k] >>> this.tableShift;
        while (s < w) this.table[++s] = k - 1;
      }
      this.table[0] = 0;
      while (s <= this.tableSize) this.table[++s] = S - 1;
    }
    this.updateCycle = Math.floor((5 * this.updateCycle) / 4);
    const maxCycle = (S + 6) << 3; if (this.updateCycle > maxCycle) this.updateCycle = maxCycle;
    this.symbolsUntilUpdate = this.updateCycle;
  }
}
class ArithDecoder {
  constructor(buf, pos) { this.b = buf; this.p = pos; this.length = 0xFFFFFFFF; this.value = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]; this.p += 4; }
  byte() { return this.p < this.b.length ? this.b[this.p++] : 0; }
  renorm() { do { this.value = ((this.value * 256) + this.byte()) % 4294967296; this.length = (this.length * 256) % 4294967296; } while (this.length < AC_MinLength); }
  bit(m) {
    const x = m.bit0Prob * (this.length >>> BM_LengthShift);
    const sym = this.value >= x ? 1 : 0;
    if (!sym) { this.length = x; ++m.bit0Count; } else { this.value -= x; this.length -= x; }
    if (this.length < AC_MinLength) this.renorm();
    if (--m.bitsUntilUpdate === 0) m.update();
    return sym;
  }
  symbol(m) {
    let n, sym, x, y = this.length;
    if (m.table) {
      this.length = this.length >>> DM_LengthShift;
      const dv = Math.floor(this.value / this.length);
      const t = dv >>> m.tableShift;
      sym = m.table[t]; n = m.table[t + 1] + 1;
      while (n > sym + 1) { const k = (sym + n) >>> 1; if (m.dist[k] > dv) n = k; else sym = k; }
      x = m.dist[sym] * this.length;
      if (sym !== m.lastSymbol) y = m.dist[sym + 1] * this.length;
    } else {
      x = sym = 0; this.length = this.length >>> DM_LengthShift;
      n = m.symbols; let k = n >>> 1;
      do { const z = this.length * m.dist[k]; if (z > this.value) { n = k; y = z; } else { sym = k; x = z; } } while ((k = (sym + n) >>> 1) !== sym);
    }
    this.value -= x; this.length = y - x;
    if (this.length < AC_MinLength) this.renorm();
    ++m.count[sym];
    if (--m.symbolsUntilUpdate === 0) m.update();
    return sym;
  }
  bits(n) {
    if (n > 19) { const lo = this.short(); const hi = this.bits(n - 16); return hi * 65536 + lo; }
    this.length = this.length >>> n;
    const sym = Math.floor(this.value / this.length);
    this.value -= this.length * sym;
    if (this.length < AC_MinLength) this.renorm();
    return sym;
  }
  short() {
    this.length = this.length >>> 16;
    const sym = Math.floor(this.value / this.length);
    this.value -= this.length * sym;
    if (this.length < AC_MinLength) this.renorm();
    return sym;
  }
}
class IntCompressor32 {
  constructor(dec, contexts) {
    this.dec = dec; this.bitsHigh = 8; this.corrBits = 32;
    this.mBits = Array.from({ length: contexts }, () => new SymModel(33));
    this.mCorr = [new BitModel()];
    for (let i = 1; i <= 32; i++) this.mCorr.push(new SymModel(i <= 8 ? 1 << i : 256));
  }
  decompress(pred, ctx) {
    const d = this.dec;
    const k = d.symbol(this.mBits[ctx]);
    let c;
    if (k) {
      if (k < 32) {
        if (k <= this.bitsHigh) c = d.symbol(this.mCorr[k]);
        else { const k1 = k - this.bitsHigh; c = d.symbol(this.mCorr[k]); const c1 = d.bits(k1); c = c * 2 ** k1 + c1; }
        if (c >= 2 ** (k - 1)) c += 1; else c -= 2 ** k - 1;
      } else c = -2147483648;
    } else c = d.bit(this.mCorr[0]);
    return (pred + c) | 0;
  }
}

// -> [{start (byte offset), count (points)}]
export function readChunkTable(file, h) {
  if (!h.compressed || !h.laszip) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const p8 = Buffer.alloc(8);
    fs.readSync(fd, p8, 0, 8, h.dataOffset);
    let tablePos = Number(p8.readBigInt64LE(0));
    if (tablePos === -1) { fs.readSync(fd, p8, 0, 8, h.size - 8); tablePos = Number(p8.readBigInt64LE(0)); }
    if (!(tablePos > h.dataOffset && tablePos < h.size)) return null;
    const len = Math.min(h.size - tablePos, 8 + 16 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, tablePos);
    const version = buf.readUInt32LE(0), nChunks = buf.readUInt32LE(4);
    if (version !== 0 || nChunks <= 0) return null;
    const variable = h.laszip.chunkSize === 0xFFFFFFFF;
    const dec = new ArithDecoder(buf, 8);
    const ic = new IntCompressor32(dec, 2);
    const counts = new Array(nChunks), sizes = new Array(nChunks);
    let pc = 0, ps = 0;
    for (let i = 0; i < nChunks; i++) {
      if (variable) { pc = ic.decompress(pc, 0); counts[i] = pc; }
      ps = ic.decompress(ps, 1); sizes[i] = ps;
    }
    const chunks = [];
    let start = h.dataOffset + 8, total = 0;
    for (let i = 0; i < nChunks; i++) {
      const cnt = variable ? counts[i] : Math.min(h.laszip.chunkSize, h.count - total);
      chunks.push({ start, size: sizes[i] >>> 0, count: cnt });
      start += sizes[i] >>> 0; total += cnt;
    }
    if (total !== h.count || start > tablePos) return null; // table does not add up: fall back to sequential
    return chunks;
  } finally { fs.closeSync(fd); }
}

// ---------------- record decoding ----------------
// Writes decoded points into the shared arrays at index `k` (positions relative to `origin`).
export function recordReader(h, origin, out) {
  const { scale: s, offset: o } = h;
  const clsOff = h.ext ? 16 : 15, clsMask = h.ext ? 0xff : 0x1f;
  let cshift = out.cshift ?? null;
  const fields = h.fields.map((f, i) => ({ get: EB_TYPES[f.type][0], off: f.off, sc: f.scale, of: f.offset, big: f.type === 7 || f.type === 8, arr: out.fields[i] }));
  const st = out.stats; // per field [min, max]
  return (dv, p, k) => {
    out.pos[k * 3] = dv.getInt32(p, true) * s[0] + o[0] - origin[0];
    out.pos[k * 3 + 1] = dv.getInt32(p + 4, true) * s[1] + o[1] - origin[1];
    out.pos[k * 3 + 2] = dv.getInt32(p + 8, true) * s[2] + o[2] - origin[2];
    out.inten[k] = dv.getUint16(p + 12, true);
    out.cls[k] = dv.getUint8(p + clsOff) & clsMask;
    if (out.rgb) {
      let r = dv.getUint16(p + h.rgbOff, true), g = dv.getUint16(p + h.rgbOff + 2, true), b = dv.getUint16(p + h.rgbOff + 4, true);
      if (cshift === null && (r | g | b)) cshift = out.cshift = Math.max(r, g, b) > 255 ? 8 : 0;
      const c = cshift || 0;
      out.rgb[k * 3] = r >> c; out.rgb[k * 3 + 1] = g >> c; out.rgb[k * 3 + 2] = b >> c;
    }
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      let v = dv[f.get](p + f.off, true);
      if (f.big) v = Number(v);
      v = v * f.sc + f.of;
      f.arr[k] = v;
      if (v < st[i * 2]) st[i * 2] = v; if (v > st[i * 2 + 1]) st[i * 2 + 1] = v;
    }
  };
}
