// Point cloud editor, main process side: worker pool, octree cache files (.lithcache) and node reading.
// Opening a scan: decode (in parallel per LAZ chunk / LAS record range) into shared memory -> build an
// octree (top levels in one worker, subtrees spread over the pool) -> write <scan>.lithcache next to the scan
// (or in userData/cloudcache when that folder is read-only). Reopening only reads the node table.
let app = null; try { ({ app } = require('electron')); } catch { /* plain node (tests) */ }
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const ROOT = path.join(__dirname, '..');
const CACHE_VER = 1;
const MAGIC = 'LITHCACHE1';

// ---------------- pool ----------------
const POOL_SIZE = Math.max(1, Math.min(12, +process.env.MONOLITH_CLOUD_WORKERS || os.cpus().length - 2 || 1));
const pool = []; // {w, busy}
const queue = [];
let nextId = 1;
const pending = new Map();
function spawn() {
  const p = path.join(ROOT, 'kernel', 'cloud', 'worker.mjs').replace('app.asar', 'app.asar.unpacked');
  const w = new Worker(pathToFileURL(p));
  const slot = { w, busy: null, idle: null };
  w.on('message', (m) => {
    const q = pending.get(m.id);
    if (!q) return;
    if (m.progress !== undefined) { q.onProgress?.(m.progress); return; }
    pending.delete(m.id);
    slot.busy = null;
    if (m.error) q.reject(new Error(m.error)); else q.resolve(m.result);
    pump();
  });
  w.on('error', (e) => { const q = slot.busy && pending.get(slot.busy); if (q) { pending.delete(slot.busy); q.reject(e); } pool.splice(pool.indexOf(slot), 1); pump(); });
  pool.push(slot);
  return slot;
}
function pump() {
  while (queue.length) {
    let slot = pool.find((s) => !s.busy);
    if (!slot && pool.length < POOL_SIZE) slot = spawn();
    if (!slot) return;
    const job = queue.shift();
    slot.busy = job.id;
    clearTimeout(slot.idle);
    slot.w.postMessage({ id: job.id, op: job.op, args: job.args });
  }
  // idle workers quit after a minute (frees their WASM memory)
  for (const s of pool) if (!s.busy) { clearTimeout(s.idle); s.idle = setTimeout(() => { if (!s.busy) { s.w.terminate(); pool.splice(pool.indexOf(s), 1); } }, 60000); }
}
function run(op, args, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    queue.push({ id, op, args });
    pump();
  });
}
function stopCloudWorkers() { for (const s of pool) s.w.terminate(); pool.length = 0; }

// ---------------- progress ----------------
function reporter(sender, req, phase, total) {
  const t0 = Date.now();
  let done = 0, last = 0;
  const send = (force) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    const el = (now - t0) / 1000;
    const eta = done > 0 && done < total ? (el / done) * (total - done) : 0;
    if (sender && !sender.isDestroyed()) sender.send('cloud-progress', { req, phase, done, total, eta, elapsed: el, ram: process.memoryUsage().rss });
  };
  send(true);
  return { add: (n) => { done += n; send(false); }, set: (n) => { done = n; send(false); }, end: () => { done = total; send(true); } };
}

// ---------------- helpers ----------------
const kindOf = (f) => { const e = path.extname(f).toLowerCase(); return e === '.las' || e === '.laz' ? 'las' : e === '.ply' ? 'ply' : 'text'; };
let lasMod = null;
async function las() { if (!lasMod) lasMod = await import(pathToFileURL(path.join(ROOT, 'kernel', 'cloud', 'las.mjs').replace('app.asar', 'app.asar.unpacked')).href); return lasMod; }
const sab = (bytes) => new SharedArrayBuffer(Math.max(4, bytes));
const nodeBytes = (k, a) => { const b = k * (12 + 4 * a.nf + 2 + (a.rgb ? 3 : 0) + 1); return (b + 3) & ~3; };

function cacheCandidates(src) {
  const h = crypto.createHash('sha1').update(path.resolve(src).toLowerCase()).digest('hex').slice(0, 20);
  return [src + '.lithcache', path.join(app?.getPath?.('userData') || os.tmpdir(), 'cloudcache', h + '.lithcache')];
}
function readMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 80) return null;
    const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1', 0, MAGIC.length) !== MAGIC) return null;
    const tr = Buffer.alloc(16); fs.readSync(fd, tr, 0, 16, size - 16);
    if (tr.toString('latin1', 0, 4) !== 'LCND') return null;
    const len = tr.readUInt32LE(4), off = Number(tr.readBigUInt64LE(8));
    const js = Buffer.alloc(len); fs.readSync(fd, js, 0, len, off);
    return JSON.parse(js.toString('utf8'));
  } catch { return null; } finally { fs.closeSync(fd); }
}
function validMeta(meta, src) {
  if (!meta || meta.v !== CACHE_VER) return false;
  try { const st = fs.statSync(src); return st.size === meta.src.size && Math.abs(st.mtimeMs - meta.src.mtime) < 2000; } catch { return false; }
}

// ---------------- open (build the cache if needed) ----------------
const handles = new Map(); // id -> {cache, meta, fd}
let handleNext = 1;
function addHandle(cache, meta) {
  const id = 'c' + handleNext++;
  handles.set(id, { cache, meta, fd: fs.openSync(cache, 'r') });
  return { id, meta, cache };
}

async function openCloud(src, sender, req, opts = {}) {
  if (!fs.existsSync(src)) throw new Error('File not found: ' + src);
  if (!opts.rebuild) for (const c of cacheCandidates(src)) if (fs.existsSync(c)) { const m = readMeta(c); if (validMeta(m, src)) return { ...addHandle(c, m), fromCache: true }; }
  const t0 = Date.now();
  const st = fs.statSync(src);
  const kind = kindOf(src);
  const L = await las();
  // ---- 1. header: count, fields, origin ----
  let count, origin = [0, 0, 0], fields = [], hasColor = false, info = {}, decodeJobs = [], lasCube = null;
  if (kind === 'las') {
    const h = L.readLasHeader(src);
    count = h.count;
    fields = h.fields.map((f) => f.name);
    hasColor = h.hasColor;
    origin = [0, 1, 2].map((d) => Math.round(((h.min[d] + h.max[d]) / 2) * 1000) / 1000);
    { const ext = Math.max(h.max[0] - h.min[0], h.max[1] - h.min[1], h.max[2] - h.min[2]); if (ext > 0 && isFinite(ext)) lasCube = { min: [0, 1, 2].map((d) => h.min[d] - origin[d] - 1e-3), size: ext * 1.0001 + 2e-3 }; }
    info = { format: `LAS ${h.version}, point format ${h.fmt}${h.compressed ? ' (LAZ)' : ''}`, system: h.system, software: h.software, lasScale: h.scale };
    if (h.compressed) {
      const chunks = L.readChunkTable(src, h);
      if (chunks) {
        // spread chunks over the pool in contiguous groups of ~2M points
        let first = 0, group = [], gc = 0;
        const flush = () => { if (group.length) decodeJobs.push({ op: 'decodeLaz', args: { file: src, chunks: group, first, origin } }); first += gc; group = []; gc = 0; };
        const per = Math.max(2e6, count / (POOL_SIZE * 3));
        for (const c of chunks) { group.push(c); gc += c.count; if (gc >= per) flush(); }
        flush();
      } else decodeJobs.push({ op: 'decodeLazAll', args: { file: src, origin } });
    } else {
      const per = Math.max(1e6, Math.ceil(count / (POOL_SIZE * 2)));
      for (let r = 0; r < count; r += per) decodeJobs.push({ op: 'decodeLas', args: { file: src, from: r, to: Math.min(count, r + per), origin } });
    }
  } else if (kind === 'ply') {
    const h = await run('plyHeader', { file: src });
    count = h.count; hasColor = h.ir >= 0; fields = h.fields.map((f) => f.name);
    info = { format: `PLY (${h.format})` };
    decodeJobs.push({ op: 'decodePly', args: { file: src, origin } });
  } else {
    const prog = reporter(sender, req, 'Counting points', 1);
    const s = await run('textScan', { file: src });
    prog.end();
    count = s.count; hasColor = s.cols >= 6; origin = s.min.map((v) => Math.floor(v));
    info = { format: `Text, ${s.cols} columns` };
    decodeJobs.push({ op: 'decodeText', args: { file: src, cols: s.cols, origin } });
  }
  if (!count) throw new Error('The file contains no points');
  if (count > 2 ** 32) throw new Error('More than 4 billion points is not supported');
  if (count > passMax(bytesPer(fields.length, hasColor))) {
    if (kind !== 'las' || !lasCube) throw new Error(`This ${kind.toUpperCase()} file is too big to open at once (${count.toLocaleString()} points); convert it to LAZ first`);
    let cache = null;
    for (const c of cacheCandidates(src)) { try { fs.mkdirSync(path.dirname(c), { recursive: true }); fs.closeSync(fs.openSync(c + '.tmp', 'w')); cache = c; break; } catch { /* next */ } }
    if (!cache) throw new Error('Cannot write the point cloud cache file');
    try { fs.rmSync(cache + '.tmp', { force: true }); } catch { /* ignore */ }
    checkSpace(cache, count, fields.length, hasColor);
    const meta = await buildBig(decodeJobs, { fields, hasColor, origin, cube: lasCube, info, src: { path: src, size: st.size, mtime: st.mtimeMs }, estimate: count }, cache, sender, req, t0);
    if (!meta) throw new Error('The file contains no points');
    return { ...addHandle(cache, meta), fromCache: false };
  }
  // ---- 2. shared memory ----
  const S = { pos: sab(count * 12), inten: sab(count * 2), cls: sab(count), rgb: hasColor ? sab(count * 3) : null, fields: fields.map(() => sab(count * 4)) };
  // ---- 3. decode ----
  let prog = reporter(sender, req, 'Reading points', count);
  const res = await Promise.all(decodeJobs.map((j) => run(j.op, { ...j.args, S }, (n) => prog.add(n))));
  prog.end();
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const stats = fields.map(() => [Infinity, -Infinity]);
  for (const r of res) {
    for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], r.bbox[d]); bbox[d + 3] = Math.max(bbox[d + 3], r.bbox[d + 3]); }
    r.stats.forEach((v, i) => { const f = i >> 1; if (i & 1) stats[f][1] = Math.max(stats[f][1], v); else stats[f][0] = Math.min(stats[f][0], v); });
  }
  // where to write: next to the scan, else the user's cache folder
  let cache = null;
  for (const c of cacheCandidates(src)) {
    try { fs.mkdirSync(path.dirname(c), { recursive: true }); fs.closeSync(fs.openSync(c + '.tmp', 'w')); cache = c; break; } catch { /* try next */ }
  }
  if (!cache) throw new Error('Cannot write the point cloud cache file');
  checkSpace(cache, count, fields.length, hasColor);
  const meta = await buildCache(S, count, { fields, stats, hasColor, origin, bbox, info, src: { path: src, size: st.size, mtime: st.mtimeMs } }, cache, sender, req, t0);
  return { ...addHandle(cache, meta), fromCache: false };
}

// octree + cache file from points in shared memory (used by open and by every edit)
async function buildCache(S, count, { fields, stats, hasColor, origin, bbox, info, src }, cache, sender, req, t0 = Date.now()) {
  // intensity / classification present?
  const I = new Uint16Array(S.inten), K = new Uint8Array(S.cls);
  let iMax = 0, iMin = 65535, kAny = false;
  const step = Math.max(1, Math.floor(count / 2e6));
  for (let i = 0; i < count; i += step) { const v = I[i]; if (v > iMax) iMax = v; if (v < iMin) iMin = v; if (K[i]) kAny = true; }
  const size = Math.max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2], 1e-3) * 1.0001;
  const cube = { min: [bbox[0], bbox[1], bbox[2]], size };
  S.idxA = sab(count * 4); S.idxB = sab(count * 4); S.counter = sab(8);
  const ia = new Uint32Array(S.idxA); for (let i = 0; i < count; i++) ia[i] = i;
  new BigInt64Array(S.counter)[0] = 64n;
  const attrs = { nf: fields.length, rgb: hasColor };
  const tmp = cache + '.tmp';
  { const fd = fs.openSync(tmp, 'w'); const hd = Buffer.alloc(64); hd.write(MAGIC, 0, 'latin1'); fs.writeSync(fd, hd, 0, 64, 0); fs.closeSync(fd); }
  const prog = reporter(sender, req, 'Building octree', count);
  const split = count > 3e6 ? 2 : null;
  const top = await run('buildTree', { task: { name: 'r', start: 0, end: count, parity: 0, min: cube.min, size, depth: 0 }, S, attrs, cachePath: tmp, split }, (n) => prog.add(n));
  const nodes = [...top.nodes];
  const subs = await Promise.all(top.pending.sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .map((t) => run('buildTree', { task: t, S, attrs, cachePath: tmp, split: null }, (n) => prog.add(n))));
  for (const r of subs) nodes.push(...r.nodes);
  prog.end();
  nodes.sort((a, b) => (a[0].length - b[0].length) || (a[0] < b[0] ? -1 : 1));
  const meta = {
    v: CACHE_VER, src, count, origin, bbox, cube, info,
    lasScale: info.lasScale || null,
    attrs: { rgb: hasColor, intensity: iMax > iMin ? [iMin, iMax] : null, classification: kAny, fields: fields.map((n, i) => ({ name: n, min: stats[i][0], max: stats[i][1] })) },
    grid: 128, nodes, buildSeconds: (Date.now() - t0) / 1000,
  };
  finishCache(tmp, cache, meta, Number(new BigInt64Array(S.counter)[0]));
  return meta;
}
function finishCache(tmp, cache, meta, end) {
  const js = Buffer.from(JSON.stringify(meta), 'utf8');
  const fd = fs.openSync(tmp, 'r+');
  fs.writeSync(fd, js, 0, js.length, end);
  const tr = Buffer.alloc(16); tr.write('LCND', 0, 'latin1'); tr.writeUInt32LE(js.length, 4); tr.writeBigUInt64LE(BigInt(end), 8);
  fs.writeSync(fd, tr, 0, 16, end + js.length);
  fs.closeSync(fd);
  try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
  fs.renameSync(tmp, cache);
}

// ---------------- big clouds: build in rounds ----------------
// A cloud that does not fit in memory is split into spatial buckets (cells of a 64^3 grid over the cube,
// merged up the octree while small). Round 0 counts points per cell; each later round decodes the
// source again and keeps only the buckets of that round (up to PASS_MAX points) in memory, builds their
// subtrees (plus their share of the ancestor nodes) and frees them. No temporary files are needed.
const HD = 6, HG = 2 ** HD;
function passMax(bytesPerPoint) {
  const env = +process.env.MONOLITH_CLOUD_PASS;
  if (env > 0) return env;
  // ~30% of the RAM for one round, and every shared array below 2 GB
  return Math.max(2e6, Math.min(160e6, Math.floor((os.totalmem() * 0.3) / (bytesPerPoint + 8))));
}
const bytesPer = (nf, rgb) => 12 + 2 + 1 + (rgb ? 3 : 0) + 4 * nf;
// the cache needs about bytesPer x points on disk: check before starting
function checkSpace(file, count, nf, rgb) {
  try {
    const st = fs.statfsSync(path.dirname(file));
    const free = st.bavail * st.bsize, need = count * bytesPer(nf, rgb) * 1.05 + 64e6;
    if (free < need) throw Object.assign(new Error(`Not enough free disk space for the display cache of this scan: about ${(need / 1e9).toFixed(1)} GB is needed on the drive of ${path.dirname(file)}, ${(free / 1e9).toFixed(1)} GB is free.`), { space: true });
  } catch (e) { if (e.space) throw e; /* statfs not available: just try */ }
}

// jobs: [{op, args}] that accept a `sink`; cube: {min, size} fixed in advance (points outside are clamped)
async function buildBig(jobs, { fields, hasColor, origin, cube, info, src, phase = 'Reading points', estimate }, cache, sender, req, t0 = Date.now()) {
  const nf = fields.length, attrs = { nf, rgb: hasColor };
  const PM = passMax(bytesPer(nf, hasColor));
  const BUCKET = Math.min(20e6, PM);
  // ---- round 0: count per cell ----
  let prog = reporter(sender, req, `${phase} (counting)`, estimate || 1);
  const res = await Promise.all(jobs.map((j) => run(j.op, { ...j.args, sink: { type: 'hist', D: HD, cube, rgb: hasColor } }, (n) => prog.add(n))));
  prog.end();
  const hist = new Float64Array(HG * HG * HG);
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const stats = fields.map(() => [Infinity, -Infinity]);
  let total = 0;
  for (const r of res) {
    total += r.count;
    r.hist.forEach((v, i) => { if (v) hist[i] += v; });
    for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], r.bbox[d]); bbox[d + 3] = Math.max(bbox[d + 3], r.bbox[d + 3]); }
    r.stats.forEach((v, i) => { const f = i >> 1; if (i & 1) stats[f][1] = Math.max(stats[f][1], v); else stats[f][0] = Math.min(stats[f][0], v); });
  }
  if (!total) return null;
  // ---- buckets: count pyramid, split while too big ----
  const pyr = [hist];
  for (let d = HD - 1; d >= 0; d--) {
    const g = 2 ** d, up = pyr[0], gu = g * 2, a = new Float64Array(g * g * g);
    for (let x = 0; x < gu; x++) for (let y = 0; y < gu; y++) for (let z = 0; z < gu; z++) a[((x >> 1) * g + (y >> 1)) * g + (z >> 1)] += up[(x * gu + y) * gu + z];
    pyr.unshift(a);
  }
  const buckets = [];
  const split = (d, x, y, z, name) => {
    const g = 2 ** d, n = pyr[d][(x * g + y) * g + z];
    if (!n) return;
    if (n <= BUCKET || d === HD) { buckets.push({ name, d, x, y, z, n }); return; }
    for (let c = 0; c < 8; c++) split(d + 1, x * 2 + (c >> 2 & 1), y * 2 + (c >> 1 & 1), z * 2 + (c & 1), name + c);
  };
  split(0, 0, 0, 0, 'r');
  // ---- rounds: groups of buckets up to PM points ----
  const rounds = [];
  let cur = [], cn = 0;
  for (const b of buckets) { if (cur.length && cn + b.n > PM) { rounds.push(cur); cur = []; cn = 0; } cur.push(b); cn += b.n; }
  if (cur.length) rounds.push(cur);
  const tmp = cache + '.tmp';
  { const fd = fs.openSync(tmp, 'w'); const hd = Buffer.alloc(64); hd.write(MAGIC, 0, 'latin1'); fs.writeSync(fd, hd, 0, 64, 0); fs.closeSync(fd); }
  const counter = sab(8); new BigInt64Array(counter)[0] = 64n;
  const nodes = [], pieces = new Map();
  for (let ri = 0; ri < rounds.length; ri++) {
    const rb = rounds[ri], n = rb.reduce((a, b) => a + b.n, 0);
    const S = { pos: sab(n * 12), inten: sab(n * 2), cls: sab(n), rgb: hasColor ? sab(n * 3) : null, fields: fields.map(() => sab(n * 4)), counter };
    const cellSlot = sab(HG * HG * HG * 4), cs = new Int32Array(cellSlot).fill(-1);
    const base = []; let at = 0;
    rb.forEach((b, slot) => {
      base.push(at); b.start = at; at += b.n;
      const k = 2 ** (HD - b.d);
      for (let x = b.x * k; x < (b.x + 1) * k; x++) for (let y = b.y * k; y < (b.y + 1) * k; y++) for (let z = b.z * k; z < (b.z + 1) * k; z++) cs[(x * HG + y) * HG + z] = slot;
    });
    const counters = sab(rb.length * 4);
    prog = reporter(sender, req, `${phase} (part ${ri + 1} of ${rounds.length})`, total);
    await Promise.all(jobs.map((j) => run(j.op, { ...j.args, S, sink: { type: 'bucket', D: HD, cube, cellSlot, base, counters, rgb: hasColor } }, (k) => prog.add(k))));
    prog.end();
    const got = new Int32Array(counters);
    rb.forEach((b, i) => { if (got[i] !== b.n) throw new Error(`Point count changed while reading (${got[i]} instead of ${b.n}) - is the file being written?`); });
    S.idxA = sab(n * 4); S.idxB = sab(n * 4);
    const ia = new Uint32Array(S.idxA); for (let i = 0; i < n; i++) ia[i] = i;
    prog = reporter(sender, req, `Building octree (part ${ri + 1} of ${rounds.length})`, n);
    const built = await Promise.all(rb.map((b) => {
      const size = cube.size / 2 ** b.d, min = [cube.min[0] + b.x * size, cube.min[1] + b.y * size, cube.min[2] + b.z * size];
      return run('buildTree', { task: { name: b.name, start: b.start, end: b.start + b.n, parity: 0, min, size, depth: b.d, up: { min: cube.min, size: cube.size } }, S, attrs, cachePath: tmp, split: null }, (k) => prog.add(k));
    }));
    prog.end();
    for (const r of built) {
      nodes.push(...r.nodes);
      for (const p of r.pieces) { if (!pieces.has(p.name)) pieces.set(p.name, { depth: p.depth, list: [] }); pieces.get(p.name).list.push(p); }
    }
  }
  // ---- ancestor nodes from the pieces of all buckets ----
  const fd = fs.openSync(tmp, 'r+');
  let end = Number(new BigInt64Array(counter)[0]);
  for (const [name, { depth, list }] of pieces) {
    const N = list.reduce((a, p) => a + p.n, 0), out = Buffer.alloc(nodeBytes(N, attrs));
    const secs = [[12, 0]];
    for (let f = 0; f < nf; f++) secs.push([4, 12 + 4 * f]);
    let acc = 0;
    for (const p of list) {
      const b = Buffer.from(p.buf.buffer, p.buf.byteOffset, p.buf.byteLength), n = p.n;
      let srcOff = 0, dstOff = 0;
      const sec = (w) => { b.copy(out, dstOff + w * acc, srcOff, srcOff + w * n); srcOff += w * n; dstOff += w * N; };
      sec(12); for (let f = 0; f < nf; f++) sec(4); sec(2); if (hasColor) sec(3); sec(1);
      acc += n;
    }
    fs.writeSync(fd, out, 0, out.length, end);
    nodes.push([name, N, end, depth]);
    end += out.length;
  }
  fs.closeSync(fd);
  nodes.sort((a, b) => (a[0].length - b[0].length) || (a[0] < b[0] ? -1 : 1));
  const I = { min: Infinity, max: -Infinity }; // intensity/classification presence: from the stats of a small sample is not available here
  void I;
  const meta = {
    v: CACHE_VER, src, count: total, origin, bbox, cube, info, lasScale: info.lasScale || null,
    attrs: { rgb: hasColor, intensity: [0, 65535], classification: true, fields: fields.map((nm, i) => ({ name: nm, min: stats[i][0], max: stats[i][1] })) },
    grid: 128, nodes, buildSeconds: (Date.now() - t0) / 1000, rounds: rounds.length,
  };
  // intensity range / classification use from the root node (an even sample of the whole cloud)
  try { Object.assign(meta.attrs, sampleAttrs(tmp, meta)); } catch { /* keep defaults */ }
  finishCache(tmp, cache, meta, end);
  return meta;
}
// intensity range and "has classification" from the coarse nodes (an even sample of the cloud)
function sampleAttrs(file, meta) {
  const fd = fs.openSync(file, 'r'), A = meta.attrs, nf = A.fields.length;
  let iMin = 65535, iMax = 0, kAny = false;
  try {
    for (const [, n, off] of meta.nodes.filter((x) => x[0].length <= 3)) {
      const b = Buffer.alloc(n * 2 + n * (A.rgb ? 3 : 0) + n);
      fs.readSync(fd, b, 0, b.length, off + 12 * n + 4 * n * nf);
      for (let i = 0; i < n; i++) { const v = b.readUInt16LE(i * 2); if (v < iMin) iMin = v; if (v > iMax) iMax = v; }
      const ko = 2 * n + (A.rgb ? 3 * n : 0);
      for (let i = 0; i < n; i++) if (b[ko + i]) { kAny = true; break; }
    }
  } finally { fs.closeSync(fd); }
  return { intensity: iMax > iMin ? [iMin, iMax] : null, classification: kAny };
}


// ---------------- derived clouds (edits) ----------------
// An edit reads the full-resolution points of its source(s) from their caches into shared memory
// (with each source's transform applied), marks every point with an output index (mask), and writes
// one new cache file per output. The source files are never changed.
const rot3 = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
function mulCM(a, b) { // column-major 4x4: a * b
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) { let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + rr] * b[c * 4 + k]; r[c * 4 + rr] = v; }
  return r;
}
function ranges(count, parts) {
  const per = Math.max(250000, Math.ceil(count / parts)), out = [];
  for (let a = 0; a < count; a += per) out.push([a, Math.min(count, a + per)]);
  return out;
}
// x-slabs (cell aligned) with about the same number of points each
async function slabs(S, count, gmin, gmax, cell) {
  const nxCells = Math.max(1, Math.ceil((gmax[0] - gmin[0]) / cell) + 1);
  const binCells = Math.max(1, Math.ceil(nxCells / 100000));
  const nbins = Math.ceil(nxCells / binCells) + 1;
  const parts = await Promise.all(ranges(count, POOL_SIZE * 2).map(([from, to]) => run('histX', { S, from, to, gmin, cell, binCells, nbins })));
  const hist = new Float64Array(nbins); for (const h of parts) h.forEach((v, i) => { hist[i] += v; });
  const target = count / Math.max(1, POOL_SIZE * 2), out = [];
  let lo = 0, acc = 0;
  for (let b = 0; b < nbins; b++) {
    acc += hist[b];
    if (acc >= target || b === nbins - 1) { out.push({ lo: lo * binCells, hi: (b + 1) * binCells, expect: acc + (hist[b + 1] || 0) + (hist[lo - 1] || 0) }); lo = b + 1; acc = 0; }
  }
  return out;
}
const safeName = (n) => String(n || 'cloud').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80).trim() || 'cloud';
function uniquePath(dir, name) {
  let p = path.join(dir, safeName(name) + '.lithcache'), i = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${safeName(name)} (${i++}).lithcache`);
  return p;
}

// read the full-resolution points of `srcs` (with their transforms) into shared arrays, relative to `origin`
async function readSources(srcs, names, hasColor, origin, count, sender, req, phase = 'Reading points') {
  const S = { pos: sab(count * 12), inten: sab(count * 2), cls: sab(count), rgb: hasColor ? sab(count * 3) : null, fields: names.map(() => sab(count * 4)) };
  const prog = reporter(sender, req, phase, count);
  const jobs = [];
  let dst = 0;
  for (const s of srcs) {
    const m = s.hd.meta, A = { nf: m.attrs.fields.length, rgb: m.attrs.rgb };
    const fieldMap = names.map((n) => m.attrs.fields.findIndex((f) => f.name === n));
    const R = s.T ? s.T.R : null;
    const base = R ? rot3(R, m.origin).map((v, d) => v + s.T.t[d]) : m.origin;
    const delta = base.map((v, d) => v - origin[d]);
    let group = [], gc = 0;
    const flush = () => { if (group.length) jobs.push({ cache: s.hd.cache, nodes: group, dstStart: dst, A, fieldMap, R, delta }); dst += gc; group = []; gc = 0; };
    for (const nd of m.nodes) { group.push(nd); gc += nd[1]; if (gc >= 2e6) flush(); }
    flush();
  }
  await Promise.all(jobs.map((j) => run('gather', { ...j, S }, (n) => prog.add(n))));
  prog.end();
  return S;
}

// spec: {op, sources: [{id, transform: {R, t} | null}], params, outDir, names: [..], docOrigin}
async function editCloud(spec, sender, req) {
  if (ANALYSES.has(spec.op)) return analyseCloud(spec, sender, req);
  const t0 = Date.now();
  const srcs = spec.sources.map((s) => { const hd = handles.get(s.id); if (!hd) throw new Error('Point cloud is closed'); return { hd, T: s.transform || null }; });
  const names = [];
  for (const s of srcs) for (const f of s.hd.meta.attrs.fields) if (!names.includes(f.name)) names.push(f.name);
  const hasColor = srcs.some((s) => s.hd.meta.attrs.rgb);
  const abs = (s, v) => (s.T ? rot3(s.T.R, v).map((x, d) => x + s.T.t[d]) : v.slice());
  const origin = abs(srcs[0], srcs[0].hd.meta.origin).map((v) => Math.round(v * 1000) / 1000);
  const count = srcs.reduce((a, s) => a + s.hd.meta.count, 0);
  // conservative box of all points (transformed source boxes), in the new local frame
  const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
  for (const s of srcs) {
    const b = s.hd.meta.bbox, o = s.hd.meta.origin;
    for (let i = 0; i < 8; i++) { const c = abs(s, [o[0] + (i & 1 ? b[3] : b[0]), o[1] + (i & 2 ? b[4] : b[1]), o[2] + (i & 4 ? b[5] : b[2])]); for (let d = 0; d < 3; d++) { gmin[d] = Math.min(gmin[d], c[d] - origin[d]); gmax[d] = Math.max(gmax[d], c[d] - origin[d]); } }
  }
  for (let d = 0; d < 3; d++) { gmin[d] -= 1e-3; gmax[d] += 1e-3; }
  // ---- too big for memory: stream the sources through the round-based builder ----
  if (count > passMax(bytesPer(names.length, hasColor))) return editBig(spec, srcs, names, hasColor, origin, count, gmin, gmax, sender, req, t0);
  // ---- 1. read the source points ----
  const S = await readSources(srcs, names, hasColor, origin, count, sender, req);
  let prog;
  // ---- 2. mark points ----
  const mask = sab(count);
  const P = spec.params || {};
  const R2 = ranges(count, POOL_SIZE * 2);
  let outputs = [0];
  const shift = spec.docOrigin ? origin.map((v, d) => v - spec.docOrigin[d]) : [0, 0, 0]; // new local -> document frame
  prog = reporter(sender, req, 'Filtering', count);
  const each = (op, args) => Promise.all(R2.map(([from, to]) => run(op, { ...args, S, mask, from, to }).then((r) => { prog.add(to - from); return r; })));
  if (spec.op === 'poly') {
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift[0], shift[1], shift[2], 1];
    await each('maskPoly', { mat: mulCM(P.mat, T), poly: P.poly, mode: P.mode });
    if (P.mode === 'split') outputs = [0, 1];
  } else if (spec.op === 'box') {
    await each('maskBox', { min: P.min.map((v, d) => v - shift[d]), max: P.max.map((v, d) => v - shift[d]), mode: P.mode });
    if (P.mode === 'split') outputs = [0, 1];
  } else if (spec.op === 'value') {
    let attr = { k: P.attr };
    if (P.attr === 'f') attr = { k: 'f', i: names.indexOf(P.field) };
    const off = P.attr === 'z' ? origin[2] : 0;
    await each('maskValue', { attr, min: P.min - off, max: P.max - off, mode: P.mode });
    if (P.mode === 'split') outputs = [0, 1];
  } else if (spec.op === 'random') {
    await each('maskRandom', { frac: P.frac, seed: 12345 });
  } else if (spec.op === 'merge') {
    // all points kept (mask is 0)
  } else if (spec.op === 'spacing' || spec.op === 'radius' || spec.op === 'sor') {
    const cell = spec.op === 'spacing' ? P.spacing : spec.op === 'radius' ? P.r : P.cell;
    if (!(cell > 0)) throw new Error('Invalid distance');
    const sl = await slabs(S, count, gmin, gmax, cell);
    if (spec.op === 'spacing') {
      new Uint8Array(mask).fill(255);
      await Promise.all(sl.map((x) => run('voxelSub', { S, mask, count, gmin, cell, lo: x.lo, hi: x.hi, expect: x.expect }).then(() => prog.add(x.expect))));
    } else if (spec.op === 'radius') {
      await Promise.all(sl.map((x) => run('neigh', { S, mask, count, gmin, cell, lo: x.lo, hi: x.hi, mode: 'radius', r: P.r, minN: P.minN, expect: x.expect }, (n) => prog.add(n))));
    } else {
      const dist = sab(count * 4);
      await Promise.all(sl.map((x) => run('neigh', { S, mask, dist, count, gmin, cell, lo: x.lo, hi: x.hi, mode: 'sor', k: P.k, expect: x.expect }, (n) => prog.add(n))));
      const st = await Promise.all(R2.map(([from, to]) => run('distStats', { dist, from, to })));
      const n = st.reduce((a, x) => a + x.n, 0), sm = st.reduce((a, x) => a + x.s, 0), s2 = st.reduce((a, x) => a + x.s2, 0);
      const mu = sm / Math.max(1, n), sd = Math.sqrt(Math.max(0, s2 / Math.max(1, n) - mu * mu));
      await Promise.all(R2.map(([from, to]) => run('maskThreshold', { mask, dist, from, to, thr: mu + P.nSigma * sd })));
    }
  } else throw new Error('Unknown edit ' + spec.op);
  prog.end();
  // ---- 3. one cache file per output ----
  const cnt = await Promise.all(R2.map(([from, to]) => run('countMask', { mask, from, to })));
  fs.mkdirSync(spec.outDir, { recursive: true });
  const results = [];
  for (const w of outputs) {
    const total = cnt.reduce((a, c) => a + c[w], 0);
    if (!total) { results.push(null); continue; }
    const D = { pos: sab(total * 12), inten: sab(total * 2), cls: sab(total), rgb: hasColor ? sab(total * 3) : null, fields: names.map(() => sab(total * 4)) };
    let at = 0;
    const parts = await Promise.all(R2.map(([from, to], i) => { const st = at; at += cnt[i][w]; return run('compact', { S, D, mask, which: w, from, to, dstStart: st }); }));
    const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const stats = names.map(() => [Infinity, -Infinity]);
    for (const r of parts) {
      if (!r.n) continue;
      for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], r.bbox[d]); bbox[d + 3] = Math.max(bbox[d + 3], r.bbox[d + 3]); }
      names.forEach((_, f) => { stats[f][0] = Math.min(stats[f][0], r.stats[f * 2]); stats[f][1] = Math.max(stats[f][1], r.stats[f * 2 + 1]); });
    }
    const cache = uniquePath(spec.outDir, spec.names?.[w] || 'cloud');
    const info = { format: 'MonoLith edit: ' + (spec.label || spec.op), lasScale: srcs[0].hd.meta.lasScale || srcs[0].hd.meta.info?.lasScale || null, software: srcs[0].hd.meta.info?.software };
    const meta = await buildCache(D, total, { fields: names, stats, hasColor, origin, bbox, info, src: { derived: true, op: spec.label || spec.op, from: srcs.map((s) => s.hd.meta.src?.path || s.hd.cache) } }, cache, sender, req, t0);
    results.push(addHandle(cache, meta));
  }
  return { outputs: results, seconds: (Date.now() - t0) / 1000 };
}

// ---------------- analysis (normals, density, cloud-to-cloud, cloud-to-mesh) ----------------
// Same flow as an edit, but every point is kept and new scalar fields are added (an existing field of
// the same name is replaced). The result statistics + histogram come back with the new cloud.
const ANALYSES = new Set(['normals', 'density', 'c2c', 'c2m']);
const FIELDS_OF = { normals: ['nx', 'ny', 'nz', 'curvature', 'verticality'], density: ['density'] };
async function fieldSummary(buf, count, lo, hi, nb = 120) {
  const R2 = ranges(count, POOL_SIZE * 2);
  const a = await Promise.all(R2.map(([from, to]) => run('fieldStats', { buf, from, to, lo: 0, hi: 0, nb: 0 })));
  const n = a.reduce((x, r) => x + r.n, 0), nan = a.reduce((x, r) => x + r.nan, 0);
  const mn = Math.min(...a.map((r) => r.mn)), mx = Math.max(...a.map((r) => r.mx));
  const s = a.reduce((x, r) => x + r.s, 0), s2 = a.reduce((x, r) => x + r.s2, 0), sa = a.reduce((x, r) => x + r.sa, 0);
  const L = lo ?? mn, H = hi ?? mx;
  const b = n && nb ? await Promise.all(R2.map(([from, to]) => run('fieldStats', { buf, from, to, lo: L, hi: H > L ? H : L + 1e-9, nb }))) : [];
  const bins = new Array(nb).fill(0); for (const r of b) r.bins.forEach((v, i) => { bins[i] += v; });
  const mean = n ? s / n : NaN;
  return { n, nan, min: n ? mn : NaN, max: n ? mx : NaN, mean, meanAbs: n ? sa / n : NaN, rms: n ? Math.sqrt(s2 / n) : NaN, sd: n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : NaN, hist: { lo: L, hi: H, bins } };
}
async function analyseCloud(spec, sender, req) {
  const t0 = Date.now();
  const s0 = spec.sources[0], hd = handles.get(s0.id);
  if (!hd) throw new Error('Point cloud is closed');
  const src = { hd, T: s0.transform || null }, m = hd.meta, P = spec.params || {};
  const hasColor = !!m.attrs.rgb;
  const abs = (v) => (src.T ? rot3(src.T.R, v).map((x, d) => x + src.T.t[d]) : v.slice());
  const origin = abs(m.origin).map((v) => Math.round(v * 1000) / 1000);
  const count = m.count;
  const shift = spec.docOrigin ? origin.map((v, d) => v - spec.docOrigin[d]) : [0, 0, 0];
  // new fields
  let add = FIELDS_OF[spec.op];
  if (spec.op === 'c2c') add = P.split ? ['c2c', 'c2c_x', 'c2c_y', 'c2c_z'] : ['c2c'];
  if (spec.op === 'c2m') add = ['c2m'];
  const names = m.attrs.fields.map((f) => f.name).filter((n) => !add.includes(n));
  const allNames = [...names, ...add];
  // reference cloud (c2c)
  let ref = null;
  if (spec.op === 'c2c') {
    const rh = handles.get(P.ref?.id);
    if (!rh) throw new Error('Reference cloud is closed');
    ref = { hd: rh, T: P.ref.transform || null };
  }
  const total = count + (ref ? ref.hd.meta.count : 0);
  if (total > passMax(bytesPer(allNames.length + 3, hasColor))) throw new Error(`This cloud is too big for an analysis in one go (${(total / 1e6).toFixed(0)} M points). Crop, segment or subsample the part you need first.`);
  // conservative box (local frame)
  const box = (s) => {
    const b = s.hd.meta.bbox, o = s.hd.meta.origin, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const f = (v) => (s.T ? rot3(s.T.R, v).map((x, d) => x + s.T.t[d]) : v);
    for (let i = 0; i < 8; i++) { const c = f([o[0] + (i & 1 ? b[3] : b[0]), o[1] + (i & 2 ? b[4] : b[1]), o[2] + (i & 4 ? b[5] : b[2])]); for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], c[d] - origin[d]); mx[d] = Math.max(mx[d], c[d] - origin[d]); } }
    return [mn, mx];
  };
  const [gmin, gmax] = box(src);
  if (ref) { const [a, b] = box(ref); for (let d = 0; d < 3; d++) { gmin[d] = Math.min(gmin[d], a[d]); gmax[d] = Math.max(gmax[d], b[d]); } }
  for (let d = 0; d < 3; d++) { gmin[d] -= 1e-3; gmax[d] += 1e-3; }
  // ---- read ----
  const S = await readSources([src], names, hasColor, origin, count, sender, req);
  const NEW = add.map(() => sab(count * 4));
  S.fields = [...S.fields, ...NEW];
  const R2 = ranges(count, POOL_SIZE * 2);
  const phase = { normals: 'Computing normals', density: 'Computing density', c2c: 'Computing distances', c2m: 'Computing distances' }[spec.op];
  let prog = reporter(sender, req, phase, count);
  const bySlab = async (cell, op, args) => {
    const sl = await slabs(S, count, gmin, gmax, cell);
    await Promise.all(sl.map((x) => run(op, { S, count, gmin, cell, lo: x.lo, hi: x.hi, expect: x.expect, ...args }, (n) => prog.add(n))));
  };
  let main = add[0];
  if (spec.op === 'normals') {
    const centre = [0, 1, 2].map((d) => (gmin[d] + gmax[d]) / 2);
    await bySlab(P.cell, 'normals', { k: Math.max(3, Math.min(64, Math.round(P.k || 12))), orient: P.orient || 'inside', centre, out: { nx: NEW[0], ny: NEW[1], nz: NEW[2], curv: NEW[3], vert: NEW[4] } });
    main = 'verticality';
  } else if (spec.op === 'density') {
    if (!(P.r > 0)) throw new Error('Invalid radius');
    await bySlab(P.r, 'density', { r: P.r, kind: P.kind || 'count', out: NEW[0] });
  } else if (spec.op === 'c2c') {
    const rm = ref.hd.meta, rn = rm.attrs.fields.map((f) => f.name);
    const useN = ['nx', 'ny', 'nz'].every((n) => rn.includes(n));
    const Rf = await readSources([ref], useN ? ['nx', 'ny', 'nz'] : [], false, origin, rm.count, sender, req, 'Reading reference');
    prog = reporter(sender, req, phase, count);
    if (!(P.maxDist > 0)) throw new Error('Invalid maximum distance');
    const cell = Math.max(P.cell || 0.05, P.maxDist / 12);
    await bySlab(cell, 'c2c', { Rf: { pos: Rf.pos, fields: Rf.fields }, rcount: rm.count, maxDist: P.maxDist, model: P.model || 'nearest', k: P.k || 8, out: { d: NEW[0], dx: NEW[1] || null, dy: NEW[2] || null, dz: NEW[3] || null } });
  } else if (spec.op === 'c2m') {
    // triangles: document frame -> new local frame
    const T = new Float32Array(P.tris.length), nt = P.tris.length / 9;
    for (let i = 0; i < P.tris.length; i++) T[i] = P.tris[i] - shift[i % 3];
    if (!nt) throw new Error('The part has no triangles');
    const N = new Float32Array(nt * 3);
    let area = 0;
    const tb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let t = 0; t < nt; t++) {
      const o = t * 9, ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2], vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
      area += l / 2;
      if (l > 0) { N[t * 3] = nx / l; N[t * 3 + 1] = ny / l; N[t * 3 + 2] = nz / l; }
      for (let v = 0; v < 9; v += 3) for (let d = 0; d < 3; d++) { tb[d] = Math.min(tb[d], T[o + v + d]); tb[d + 3] = Math.max(tb[d + 3], T[o + v + d]); }
    }
    if (!(P.maxDist > 0)) throw new Error('Invalid maximum distance');
    // cell: about the max distance, but not so small that big faces fill millions of cells
    const diag = Math.hypot(tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]);
    let cell = Math.max(P.maxDist / 4, diag / 400, Math.sqrt(area / Math.max(1, nt)) / 2, 1e-4);
    while (area / (cell * cell) + nt * 8 > 4e7) cell *= 1.5;
    const tris = sab(T.byteLength), nrm = sab(N.byteLength);
    new Float32Array(tris).set(T); new Float32Array(nrm).set(N);
    const gm = [tb[0] - cell, tb[1] - cell, tb[2] - cell];
    await Promise.all(R2.map(([from, to]) => run('c2m', { S, tris, nrm, ntris: nt, out: NEW[0], from, to, gmin: gm, cell, maxDist: P.maxDist, signed: P.signed !== false }, (n) => prog.add(n))));
  }
  prog.end();
  // ---- write ----
  const boxes = await Promise.all(R2.map(([from, to]) => run('posBox', { S, from, to })));
  const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let d = 0; d < 3; d++) { bbox[d] = Math.min(bbox[d], b[d]); bbox[d + 3] = Math.max(bbox[d + 3], b[d + 3]); }
  const stats = [];
  for (let f = 0; f < allNames.length; f++) {
    const old = f < names.length ? m.attrs.fields.find((x) => x.name === allNames[f]) : null;
    if (old) stats.push([old.min, old.max]);
    else { const r = await fieldSummary(S.fields[f], count, null, null, 0); stats.push(r.n ? [r.min, r.max] : [0, 0]); }
  }
  const mi = allNames.indexOf(main);
  const summary = await fieldSummary(S.fields[mi], count, null, null, 120);
  fs.mkdirSync(spec.outDir, { recursive: true });
  const cache = uniquePath(spec.outDir, spec.names?.[0] || 'cloud');
  const info = { format: 'MonoLith analysis: ' + (spec.label || spec.op), lasScale: m.lasScale || m.info?.lasScale || null, software: m.info?.software };
  const meta = await buildCache(S, count, { fields: allNames, stats, hasColor, origin, bbox, info, src: { derived: true, op: spec.label || spec.op, from: [m.src?.path || hd.cache] } }, cache, sender, req, t0);
  return { outputs: [{ ...addHandle(cache, meta), analysis: { op: spec.op, field: main, params: { ...P, tris: undefined, ref: undefined }, stats: summary } }], seconds: (Date.now() - t0) / 1000 };
}

async function editBig(spec, srcs, names, hasColor, origin, count, gmin, gmax, sender, req, t0) {
  const P = spec.params || {};
  if (['spacing', 'radius', 'sor'].includes(spec.op)) throw new Error(`This cloud is too big for this filter in one go (${(count / 1e6).toFixed(0)} M points). Crop or segment the part you need first, then filter that.`);
  const shift = spec.docOrigin ? origin.map((v, d) => v - spec.docOrigin[d]) : [0, 0, 0];
  let pred, outputs = [0];
  if (spec.op === 'poly') pred = { kind: 'poly', mat: mulCM(P.mat, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift[0], shift[1], shift[2], 1]), poly: P.poly, mode: P.mode };
  else if (spec.op === 'box') pred = { kind: 'box', min: P.min.map((v, d) => v - shift[d]), max: P.max.map((v, d) => v - shift[d]), mode: P.mode };
  else if (spec.op === 'value') { const off = P.attr === 'z' ? origin[2] : 0; pred = { kind: 'value', attr: P.attr === 'f' ? { k: 'f', i: names.indexOf(P.field) } : { k: P.attr }, min: P.min - off, max: P.max - off, mode: P.mode }; }
  else if (spec.op === 'random') pred = { kind: 'random', frac: P.frac };
  else if (spec.op === 'merge') pred = { kind: 'all' };
  else throw new Error('Unknown edit ' + spec.op);
  if (P.mode === 'split') outputs = [0, 1];
  const size = Math.max(gmax[0] - gmin[0], gmax[1] - gmin[1], gmax[2] - gmin[2], 1e-3) * 1.0001;
  const cube = { min: gmin.slice(), size };
  const jobsFor = (which) => {
    const jobs = [];
    let gid = 0;
    for (const s of srcs) {
      const m = s.hd.meta, A = { nf: m.attrs.fields.length, rgb: m.attrs.rgb };
      const fieldMap = names.map((n) => m.attrs.fields.findIndex((f) => f.name === n));
      const R = s.T ? s.T.R : null;
      const base = R ? rot3(R, m.origin).map((v, d) => v + s.T.t[d]) : m.origin;
      const delta = base.map((v, d) => v - origin[d]);
      let group = [], gc = 0;
      const per = Math.max(2e6, count / (POOL_SIZE * 3));
      const flush = () => { if (group.length) jobs.push({ op: 'gatherFilter', args: { cache: s.hd.cache, nodes: group, A, fieldMap, R, delta, pred, which, gidStart: gid } }); gid += gc; group = []; gc = 0; };
      for (const nd of m.nodes) { group.push(nd); gc += nd[1]; if (gc >= per) flush(); }
      flush();
    }
    return jobs;
  };
  fs.mkdirSync(spec.outDir, { recursive: true });
  checkSpace(path.join(spec.outDir, 'x'), count, names.length, hasColor);
  const results = [];
  for (const w of outputs) {
    const cache = uniquePath(spec.outDir, spec.names?.[w] || 'cloud');
    const info = { format: 'MonoLith edit: ' + (spec.label || spec.op), lasScale: srcs[0].hd.meta.lasScale || null, software: srcs[0].hd.meta.info?.software };
    const meta = await buildBig(jobsFor(w), { fields: names, hasColor, origin, cube, info, src: { derived: true, op: spec.label || spec.op, from: srcs.map((s) => s.hd.meta.src?.path || s.hd.cache) }, phase: outputs.length > 1 ? `Filtering, result ${w + 1} of 2` : 'Filtering', estimate: count }, cache, sender, req, t0);
    results.push(meta ? addHandle(cache, meta) : null);
  }
  return { outputs: results, seconds: (Date.now() - t0) / 1000 };
}


// ---------------- registration (ICP) ----------------
// A side is {cloud: {id, transform}} or {tris: [9 numbers per triangle, document frame]}.
// Points are gathered in the document frame (abs - docOrigin): clouds from the coarse octree levels
// first (an even thinning, works for huge clouds too), parts as an area-weighted surface sample.
function cloudSample(side, docOrigin, budget) {
  const hd = handles.get(side.id);
  if (!hd) throw new Error('Point cloud is closed');
  const m = hd.meta, T = side.transform, R = T ? T.R : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const o = m.origin, base = rot3(R, o).map((v, d) => v + (T ? T.t[d] : 0) - docOrigin[d]);
  const nodes = m.nodes.slice().sort((a, b) => (a[3] ?? a[0].length) - (b[3] ?? b[0].length));
  const pick = []; let total = 0;
  for (const nd of nodes) { if (total >= budget) break; pick.push(nd); total += nd[1]; }
  const out = new Float64Array(total * 3);
  let k = 0;
  for (const [, n, off] of pick) {
    const b = Buffer.alloc(12 * n); fs.readSync(hd.fd, b, 0, 12 * n, off);
    const f = new Float32Array(b.buffer, b.byteOffset, n * 3);
    for (let i = 0; i < n; i++) {
      const x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2];
      out[k++] = R[0] * x + R[1] * y + R[2] * z + base[0]; out[k++] = R[3] * x + R[4] * y + R[5] * z + base[1]; out[k++] = R[6] * x + R[7] * y + R[8] * z + base[2];
    }
  }
  return { P: out, n: total, N: null };
}
function partSample(tris, count, seed = 1) {
  const nt = tris.length / 9, acc = new Float64Array(nt), nrm = new Float64Array(nt * 3);
  let A = 0;
  for (let t = 0; t < nt; t++) {
    const o = t * 9, ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2], vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    A += l / 2; acc[t] = A;
    if (l > 0) { nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l; }
  }
  if (!(A > 0)) throw new Error('The part has no surface');
  let s = seed >>> 0 || 1; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const P = new Float64Array(count * 3), N = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = rnd() * A; let lo = 0, hi = nt - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (acc[mid] < r) lo = mid + 1; else hi = mid; }
    let a = rnd(), b = rnd(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const o = lo * 9;
    for (let d = 0; d < 3; d++) { P[i * 3 + d] = tris[o + d] + a * (tris[o + 3 + d] - tris[o + d]) + b * (tris[o + 6 + d] - tris[o + d]); N[i * 3 + d] = nrm[lo * 3 + d]; }
  }
  return { P, n: count, N, area: A };
}
// spec: {mov: side, ref: side, docOrigin, maxDist, iters, overlap, level, sample}
// Returns {T (document frame, applied to the moving side), rms, iterations, history, overlap}
async function registerCloud(spec, sender, req) {
  const t0 = Date.now(), O = spec.docOrigin || [0, 0, 0];
  const get = (side, budget) => (side.tris ? partSample(side.tris, Math.min(budget, 1500000)) : cloudSample(side.cloud, O, budget));
  const ref = get(spec.ref, 3e6);
  const mv = get(spec.mov, 4e5);
  // even random subset of the moving side
  const want = Math.max(1000, Math.min(spec.sample || 30000, mv.n));
  const mov = new Float64Array(want * 3);
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0, left = mv.n, need = want, k = 0; i < mv.n && need > 0; i++, left--) if (rnd() * left < need) { mov[k * 3] = mv.P[i * 3]; mov[k * 3 + 1] = mv.P[i * 3 + 1]; mov[k * 3 + 2] = mv.P[i * 3 + 2]; k++; need--; }
  const sh = (a) => { const b = sab(a.byteLength); new a.constructor(b).set(a); return b; };
  // the point spacing sets the finest search distance
  let minDist = spec.minDist;
  if (!(minDist > 0)) minDist = spec.ref.tris ? 0.001 : 0.003;
  const iters = Math.max(1, Math.min(200, spec.iters || 40));
  const prog = reporter(sender, req, 'Refining (ICP)', iters);
  const r = await run('icp', { mov: sh(mov), nmov: want, ref: sh(ref.P), nref: ref.n, refN: ref.N ? sh(ref.N) : null, T0: null, maxDist: spec.maxDist, minDist, iters, overlap: spec.overlap || 0.9, level: !!spec.level }, (n) => prog.add(n));
  prog.end();
  return { ...r, sample: want, refPoints: ref.n, seconds: (Date.now() - t0) / 1000 };
}

// open a cache file directly (edit results)
function openCacheFile(cache) {
  if (!fs.existsSync(cache)) throw new Error('File not found: ' + cache);
  const m = readMeta(cache);
  if (!m || m.v !== CACHE_VER) throw new Error('Not a valid point cloud cache: ' + cache);
  return { ...addHandle(cache, m), fromCache: true };
}
// remove edit results in `dir` that the document no longer uses
function cleanDir(dir, keep) {
  const k = new Set((keep || []).map((p) => path.resolve(p).toLowerCase()));
  const open = new Set([...handles.values()].map((h) => path.resolve(h.cache).toLowerCase()));
  let removed = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir); } catch { return 0; }
  for (const e of ents) {
    if (!/\.lithcache$/i.test(e)) continue;
    const p = path.resolve(dir, e), lp = p.toLowerCase();
    if (k.has(lp) || open.has(lp)) continue;
    try { fs.rmSync(p); removed++; } catch { /* in use */ }
  }
  return removed;
}

// ---------------- node reading ----------------
// want: {rgb, inten, cls, field: index|-1}. Returns one entry per node with only the requested arrays.
function readNodes(id, names, want = {}) {
  const hd = handles.get(id);
  if (!hd) throw new Error('Point cloud is closed');
  const { meta, fd } = hd, A = meta.attrs, nf = A.fields.length;
  const byName = hd.byName || (hd.byName = new Map(meta.nodes.map((n) => [n[0], n])));
  const out = [];
  const rd = (bytes, pos) => { const b = Buffer.alloc(bytes); fs.readSync(fd, b, 0, bytes, pos); return b.buffer.slice(b.byteOffset, b.byteOffset + bytes); };
  for (const name of names) {
    const nd = byName.get(name);
    if (!nd) continue;
    const [, n, off] = nd;
    const r = { name, n, pos: rd(12 * n, off) };
    if (want.field >= 0 && want.field < nf) r.f = rd(4 * n, off + 12 * n + 4 * n * want.field);
    if (want.nrm) r.nrm = want.nrm.map((k) => rd(4 * n, off + 12 * n + 4 * n * k));
    const iOff = off + 12 * n + 4 * n * nf;
    if (want.inten) r.i = rd(2 * n, iOff);
    if (want.rgb && A.rgb) r.c = rd(3 * n, iOff + 2 * n);
    if (want.cls) r.k = rd(n, iOff + 2 * n + (A.rgb ? 3 * n : 0));
    out.push(r);
  }
  return out;
}
// all values of one point (picking): node name + index inside the node
function readPoint(id, name, i) {
  const hd = handles.get(id);
  if (!hd) throw new Error('Point cloud is closed');
  const { meta, fd } = hd, A = meta.attrs, nf = A.fields.length;
  const byName = hd.byName || (hd.byName = new Map(meta.nodes.map((n) => [n[0], n])));
  const nd = byName.get(name);
  if (!nd || i < 0 || i >= nd[1]) return null;
  const [, n, off] = nd;
  const rd = (w, pos) => { const b = Buffer.alloc(w); fs.readSync(fd, b, 0, w, pos); return b; };
  const p = rd(12, off + 12 * i);
  const local = [p.readFloatLE(0), p.readFloatLE(4), p.readFloatLE(8)];
  const fields = {};
  A.fields.forEach((f, k) => { fields[f.name] = rd(4, off + 12 * n + 4 * n * k + 4 * i).readFloatLE(0); });
  const iOff = off + 12 * n + 4 * n * nf;
  const out = { local, intensity: rd(2, iOff + 2 * i).readUInt16LE(0), fields };
  if (A.rgb) { const c = rd(3, iOff + 2 * n + 3 * i); out.rgb = [c[0], c[1], c[2]]; }
  out.classification = rd(1, iOff + 2 * n + (A.rgb ? 3 * n : 0) + i)[0];
  return out;
}
function closeCloud(id) { const hd = handles.get(id); if (hd) { try { fs.closeSync(hd.fd); } catch { /* ignore */ } handles.delete(id); } }

async function exportCloudFile(id, out, format, sender, req, transform = null) {
  const hd = handles.get(id);
  if (!hd) throw new Error('Point cloud is closed');
  const prog = reporter(sender, req, 'Exporting', hd.meta.count);
  const r = await run('exportCloud', { cachePath: hd.cache, meta: hd.meta, out, format, transform }, (n) => prog.add(n));
  prog.end();
  return r;
}

function setupCloudIPC(ipcMain) {
  ipcMain.handle('cloud:open', async (e, src, req, opts) => { try { return await openCloud(src, e.sender, req, opts); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:read', (_e, id, names, want) => readNodes(id, names, want));
  ipcMain.handle('cloud:point', (_e, id, name, i) => readPoint(id, name, i));
  ipcMain.handle('cloud:close', (_e, id) => closeCloud(id));
  ipcMain.handle('cloud:export', async (e, id, out, format, req, transform) => { try { return await exportCloudFile(id, out, format, e.sender, req, transform); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:edit', async (e, spec, req) => { try { return await editCloud(spec, e.sender, req); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:register', async (e, spec, req) => { try { return await registerCloud(spec, e.sender, req); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:openCache', (_e, p) => { try { return openCacheFile(p); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:clean', (_e, dir, keep) => cleanDir(dir, keep));
  ipcMain.handle('cloud:drawView', (_e, spec) => { try { return require('./clouddraw.cjs').drawCloudViews(spec, (id) => handles.get(id)); } catch (err) { return { error: String(err.message || err) }; } });
  ipcMain.handle('cloud:sysinfo', () => ({ cores: os.cpus().length, workers: POOL_SIZE, ram: os.totalmem() }));
}

module.exports = { registerCloud, analyseCloud, setupCloudIPC, stopCloudWorkers, openCloud, readNodes, closeCloud, nodeBytes, editCloud, openCacheFile, cleanDir, exportCloudFile };
