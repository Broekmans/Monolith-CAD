// Point cloud views for drawings (IPC 'cloud:drawView'). Reads the octree caches of open clouds,
// projects the points onto each view plane (part frame: mm, Y up, as kernel/drawing.mjs views) and
// thins them on a paper grid so a view stays readable and the PDF small. Huge clouds work too: only the
// octree levels the view's scale needs are read, nodes outside the depth range are skipped.
const fs = require('fs');

const G = 128; // octree grid per node (kernel/cloud/worker.mjs): node point spacing = node size / G
const READ_MAX = 25e6; // points read per view at most
const DOTS_MAX = 300000; // dots kept per view at most
const PIX_MAX = 12e6;
const FIT_CAP = 3e6, FIT_MAX = 400000; // fit sample: cells collected / points kept per view // density raster pixels per view at most
const zlib = require('zlib');

// density raster -> {box, edges, raster: {w, h, x0, y1 (model mm of the top-left corner), pix, png (base64 grey, 0 = empty, 255 = dense)}}
// tone: log(1 + count) / log(1 + ref), ref = 99.5 % of the non-empty pixels (walls go dark, floors stay light)
function rasterResult(ras, B, box, crop) {
  const { gw, gh, g, pix } = ras;
  const nz = []; for (let i = 0; i < g.length; i += Math.max(1, Math.floor(g.length / 2e6))) if (g[i] > 0) nz.push(g[i]);
  nz.sort((a, b) => a - b);
  const ref = Math.max(2, nz.length ? nz[Math.floor(0.995 * (nz.length - 1))] : 1), lr = Math.log1p(ref);
  let x0 = 0, y0 = 0, x1 = gw - 1, y1 = gh - 1;
  if (crop) {
    x0 = gw; y0 = gh; x1 = -1; y1 = -1;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (g[y * gw + x] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1, img = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { img[y * (w + 1)] = 0; for (let x = 0; x < w; x++) { const c = g[(y + y0) * gw + x + x0]; img[y * (w + 1) + 1 + x] = c > 0 ? Math.max(1, Math.min(255, Math.round((255 * Math.log1p(c)) / lr))) : 0; } }
  const X0 = B[0] + x0 * pix, Y1 = B[3] - y0 * pix;
  if (crop) box = [X0, Y1 - h * pix, X0 + w * pix, Y1];
  return { box, edges: [], raster: { w, h, x0: X0, y1: Y1, pix, ref, png: pngGrey(w, h, img).toString('base64') } };
}
// fit sample: real points (view-model mm) thinned to FIT_MAX, packed relative to B[0..1] in 0.25 mm steps
function fitSample(ras, B) {
  let pts = [...ras.fit.values()];
  if (pts.length > FIT_MAX) { const keep = FIT_MAX / pts.length; let s = 7; pts = pts.filter(() => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff < keep; }); }
  const step = 0.25, span = Math.max(B[2] - B[0], B[3] - B[1]) / step, wide = span >= 65535;
  const arr = wide ? new Uint32Array(pts.length * 2) : new Uint16Array(pts.length * 2);
  pts.forEach((p, i) => { arr[i * 2] = Math.round((p[0] - B[0]) / step); arr[i * 2 + 1] = Math.round((p[1] - B[1]) / step); });
  return { n: pts.length, o: [B[0], B[1]], step, bits: wide ? 32 : 16, cell: ras.fc, xy: Buffer.from(arr.buffer).toString('base64') };
}
// minimal PNG writer: 8-bit greyscale, rows already prefixed with filter byte 0
function pngGrey(w, h, rows) {
  const crcT = pngGrey.t || (pngGrey.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// document frame (m, Z up) -> part frame (mm, Y up)
const C = [1000, 0, 0, 0, 0, 1000, 0, -1000, 0];
const mul3 = (A, B) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return o; };
const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// one cloud: local cache coords -> part mm: P = M·local + b
function placement(hd, transform, O) {
  const R = transform ? transform.R : [1, 0, 0, 0, 1, 0, 0, 0, 1], t = transform ? transform.t : [0, 0, 0];
  const o = hd.meta.origin, ro = mv3(R, o);
  return { M: mul3(C, R), b: mv3(C, [ro[0] + t[0] - O[0], ro[1] + t[1] - O[1], ro[2] + t[2] - O[2]]) };
}
function nodeList(meta) {
  const cube = meta.cube;
  return meta.nodes.map(([name, n, off, depth]) => {
    const min = cube.min.slice(); let size = cube.size;
    for (let i = 1; i < name.length; i++) { const c = +name[i]; size /= 2; if (c & 4) min[0] += size; if (c & 2) min[1] += size; if (c & 1) min[2] += size; }
    return { name, n, off, depth: depth ?? name.length - 1, min, size };
  }).sort((a, b) => a.depth - b.depth);
}
function readXYZ(hd, nd) { const b = Buffer.alloc(12 * nd.n); fs.readSync(hd.fd, b, 0, 12 * nd.n, nd.off); return new Float32Array(b.buffer, b.byteOffset, nd.n * 3); }
function readColor(hd, nd) {
  const A = hd.meta.attrs, nf = A.fields.length, n = nd.n, iOff = nd.off + 12 * n + 4 * n * nf;
  const out = { i: null, c: null };
  if (A.intensity) { const b = Buffer.alloc(2 * n); fs.readSync(hd.fd, b, 0, 2 * n, iOff); out.i = new Uint16Array(b.buffer, b.byteOffset, n); }
  if (A.rgb) { const b = Buffer.alloc(3 * n); fs.readSync(hd.fd, b, 0, 3 * n, iOff + 2 * n); out.c = b; }
  return out;
}
const quantile = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))))];

// spec: {clouds: [{id, transform}], docOrigin, views: [{dir, x, cell (model mm), clip: {ref, from, to} | null, slab: {p, n, half} | null}]}
// Returns per view: {box, dots: {n, xy (base64 Uint16 pairs over box), g (base64 grey), c (base64 RGB | null)}, info: {dMin, dMax, floor}}
function drawCloudViews(spec, getHandle) {
  const O = spec.docOrigin || [0, 0, 0];
  const srcs = spec.clouds.map((c) => { const hd = getHandle(c.id); if (!hd) throw new Error('Point cloud is closed'); return { hd, pl: placement(hd, c.transform, O), nodes: nodeList(hd.meta) }; });
  // coarse even sample of everything (box, depth range, floor)
  const sample = [];
  for (const s of srcs) {
    let tot = 0;
    for (const nd of s.nodes) {
      if (tot > 4e5) break;
      const f = readXYZ(s.hd, nd); tot += nd.n;
      const { M, b } = s.pl;
      for (let i = 0; i < nd.n; i++) { const x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2]; sample.push(M[0] * x + M[1] * y + M[2] * z + b[0], M[3] * x + M[4] * y + M[5] * z + b[1], M[6] * x + M[7] * y + M[8] * z + b[2]); }
    }
  }
  const ns = sample.length / 3;
  return spec.views.map((v) => {
    const N = v.dir, X = v.x, Y = cross(N, X);
    const U = new Float64Array(ns), W = new Float64Array(ns), D = new Float64Array(ns);
    for (let i = 0; i < ns; i++) { const p = [sample[i * 3], sample[i * 3 + 1], sample[i * 3 + 2]]; U[i] = dot(p, X); W[i] = dot(p, Y); D[i] = dot(p, N); }
    const su = Float64Array.from(U).sort(), sw = Float64Array.from(W).sort(), sd = Float64Array.from(D).sort();
    // the view box holds every point of the scan (from each cloud's exact bounding box, transformed): a
    // drawing view never leaves part of the scan out by itself (only depth ranges / slices the user sets)
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of srcs) {
      const m = q.hd.meta, bb = m.bbox || [...m.cube.min, ...m.cube.min.map((c) => c + m.cube.size)], { M, b } = q.pl;
      for (let i = 0; i < 8; i++) {
        const c = [i & 1 ? bb[3] : bb[0], i & 2 ? bb[4] : bb[1], i & 4 ? bb[5] : bb[2]], P = [0, 1, 2].map((r) => M[r * 3] * c[0] + M[r * 3 + 1] * c[1] + M[r * 3 + 2] * c[2] + b[r]);
        const u = dot(P, X), w = dot(P, Y); box[0] = Math.min(box[0], u); box[1] = Math.min(box[1], w); box[2] = Math.max(box[2], u); box[3] = Math.max(box[3], w);
      }
    }
    void su; void sw;
    const dMin = quantile(sd, 0.0005), dMax = quantile(sd, 0.9995);
    // floor: the strongest 50 mm level in the lower half (meaningful for top / bottom views)
    let floor = dMin, levels = [];
    { const bw = 50, nb = Math.max(1, Math.ceil((dMax - dMin) / bw) + 1), hist = new Int32Array(nb);
      for (let i = 0; i < ns; i++) { const k = Math.floor((D[i] - dMin) / bw); if (k >= 0 && k < nb) hist[k]++; }
      // the lowest strong level (several floors of a building: the ground floor)
      let mx = 0; for (let k = 0; k < Math.ceil(nb / 2); k++) mx = Math.max(mx, hist[k]);
      for (let k = 0; k < Math.ceil(nb / 2); k++) if (hist[k] >= 0.5 * mx && mx > 0) { floor = dMin + (k + 0.5) * bw; break; }
      // floor levels (top / bottom views): sharp peaks of the height histogram (floors are flat, terrain is not),
      // at least 25 % of the strongest, 1.8 m apart, low to high
      if (Math.abs(N[1]) > 0.9) {
        const sm = (k) => (hist[k - 1] || 0) + hist[k] + (hist[k + 1] || 0);
        const peaks = [];
        for (let k = 0; k < nb; k++) { const c = sm(k); if (c > 0 && c >= sm(k - 1 < 0 ? k : k - 1) && c >= sm(k + 1 >= nb ? k : k + 1)) peaks.push([k, c]); }
        const top = Math.max(0, ...peaks.map((q) => q[1])), lv = [];
        for (const [k, c] of peaks.sort((a, b) => b[1] - a[1])) if (c >= 0.25 * top && lv.every((q) => Math.abs(q - k) * bw >= 1800)) lv.push(k);
        levels = lv.sort((a, b) => a - b).map((k) => dMin + (k + 0.5) * bw);
      } }
    if (v.clip?.ref === 'floor' && levels.length) floor = levels[Math.min(levels.length - 1, Math.max(0, v.clip.level | 0))];
    // depth range
    let d0 = -Infinity, d1 = Infinity;
    if (v.clip) { const ref = v.clip.ref === 'floor' ? floor : v.clip.ref === 'front' ? dMax : dMin, sg = v.clip.ref === 'front' ? -1 : 1; const a = ref + sg * v.clip.from * 1000, b = ref + sg * v.clip.to * 1000; d0 = Math.min(a, b); d1 = Math.max(a, b); }
    // slab (section): plane point p, normal n (part mm), half thickness
    // lo..hi along n (n points to the viewer): [-thick/2 - view depth, +thick/2]
    const slab = v.slab ? { p: v.slab.p, n: v.slab.n, lo: v.slab.lo ?? -v.slab.half, hi: v.slab.hi ?? v.slab.half } : null;
    if (slab) { const off = dot(slab.p, slab.n); slab.o = off; }
    const mg = 0.002 * Math.max(box[2] - box[0], box[3] - box[1], 1);
    const B = [box[0] - mg, box[1] - mg, box[2] + mg, box[3] + mg];
    let cell = Math.max(1e-3, v.cell);
    // density raster: points per pixel (all depths), pixel = v.raster.pix model mm
    let ras = null;
    if (v.raster) {
      let pix = Math.max(1e-3, v.raster.pix);
      const area = (B[2] - B[0]) * (B[3] - B[1]);
      if (area / (pix * pix) > PIX_MAX) pix = Math.sqrt(area / PIX_MAX);
      const gw = Math.max(1, Math.ceil((B[2] - B[0]) / pix)), gh = Math.max(1, Math.ceil((B[3] - B[1]) / pix));
      ras = { pix, gw, gh, g: new Float32Array(gw * gh), fc: Math.max(1, pix / 3), fit: new Map() };
      ras.fnx = Math.ceil((B[2] - B[0]) / ras.fc) + 1;
      cell = pix; // node levels: read until the point spacing is below the pixel
    }
    const nx = Math.max(1, Math.ceil((B[2] - B[0]) / cell)), cells = new Map();
    let read = 0;
    for (const s of srcs) {
      const { M, b } = s.pl, A = s.hd.meta.attrs, iR = A.intensity, iSpan = iR ? Math.max(1, iR[1] - iR[0]) : 1;
      const rowN = mv3([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]], N); // N^T·M
      const rowX = mv3([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]], X), rowY = mv3([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]], Y);
      const bN = dot(b, N), bX = dot(b, X), bY = dot(b, Y);
      const rowS = slab ? mv3([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]], slab.n) : null, bS = slab ? dot(b, slab.n) - slab.o : 0;
      for (const nd of s.nodes) {
        if (read > READ_MAX) break;
        const spacing = (nd.size / G) * 1000; // m -> mm (the cache is in metres)
        if (nd.depth > 0 && spacing < cell * (ras ? 0.3 : 0.5)) continue; // finer than the view needs (its parent was enough); density wants a few points per pixel
        // cull by depth range / slab
        let lo = Infinity, hi = -Infinity, slo = Infinity, shi = -Infinity;
        for (let c = 0; c < 8; c++) {
          const q = [nd.min[0] + (c & 4 ? nd.size : 0), nd.min[1] + (c & 2 ? nd.size : 0), nd.min[2] + (c & 1 ? nd.size : 0)];
          const d = dot(rowN, q) + bN; lo = Math.min(lo, d); hi = Math.max(hi, d);
          if (slab) { const e = dot(rowS, q) + bS; slo = Math.min(slo, e); shi = Math.max(shi, e); }
        }
        if (hi < d0 || lo > d1) continue;
        if (slab && (shi < slab.lo || slo > slab.hi)) continue;
        const f = readXYZ(s.hd, nd); read += nd.n;
        let col = null;
        for (let i = 0; i < nd.n; i++) {
          const x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2];
          const d = rowN[0] * x + rowN[1] * y + rowN[2] * z + bN;
          if (d < d0 || d > d1) continue;
          if (slab) { const e = rowS[0] * x + rowS[1] * y + rowS[2] * z + bS; if (e < slab.lo || e > slab.hi) continue; }
          const u = rowX[0] * x + rowX[1] * y + rowX[2] * z + bX, w = rowY[0] * x + rowY[1] * y + rowY[2] * z + bY;
          if (u < B[0] || u > B[2] || w < B[1] || w > B[3]) continue;
          if (ras) {
            // thinned real points for fitting walls / planes (annotations): one per small cell
            if (ras.fit.size < FIT_CAP) { const k = Math.floor((w - B[1]) / ras.fc) * ras.fnx + Math.floor((u - B[0]) / ras.fc); if (!ras.fit.has(k)) ras.fit.set(k, [u, w]); }
            // bilinear splat over 4 pixels: no moiré between a voxel-thinned scan and the pixel grid
            const fx = (u - B[0]) / ras.pix - 0.5, fy = (B[3] - w) / ras.pix - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy, G2 = ras.g, gw = ras.gw;
            if (ix >= 0 && iy >= 0 && ix + 1 < gw && iy + 1 < ras.gh) { const o = iy * gw + ix; G2[o] += (1 - ax) * (1 - ay); G2[o + 1] += ax * (1 - ay); G2[o + gw] += (1 - ax) * ay; G2[o + gw + 1] += ax * ay; }
            else { const cx = Math.max(0, Math.min(gw - 1, Math.round(fx))), cy = Math.max(0, Math.min(ras.gh - 1, Math.round(fy))); G2[cy * gw + cx] += 1; }
            continue;
          }
          const key = Math.floor((w - B[1]) / cell) * nx + Math.floor((u - B[0]) / cell);
          const e = cells.get(key);
          if (e && e[2] >= d) continue;
          if (!col) col = readColor(s.hd, nd);
          let g = 0, r = 0, gg = 0, bb = 0;
          if (col.c) { r = col.c[i * 3]; gg = col.c[i * 3 + 1]; bb = col.c[i * 3 + 2]; }
          if (col.i) g = Math.max(0, Math.min(255, Math.round(((col.i[i] - iR[0]) / iSpan) * 255)));
          else if (col.c) g = Math.round(0.299 * r + 0.587 * gg + 0.114 * bb);
          if (e) { e[0] = u; e[1] = w; e[2] = d; e[3] = g; e[4] = r; e[5] = gg; e[6] = bb; } else cells.set(key, [u, w, d, g, r, gg, bb]);
        }
      }
    }
    const hasI = srcs.some((q) => !!q.hd.meta.attrs.intensity), hasRgb = srcs.some((q) => q.hd.meta.attrs.rgb);
    if (ras) return { ...rasterResult(ras, B, box, !!slab), fit: fitSample(ras, B), info: { dMin, dMax, floor, levels, read, hasI, hasRgb } };
    let pts = [...cells.values()];
    // too many dots: thin again on a coarser grid
    if (pts.length > DOTS_MAX) {
      cell *= Math.sqrt(pts.length / DOTS_MAX) * 1.05;
      const nx2 = Math.ceil((B[2] - B[0]) / cell) + 1, m2 = new Map();
      for (const p of pts) { const k = Math.floor((p[1] - B[1]) / cell) * nx2 + Math.floor((p[0] - B[0]) / cell); const e = m2.get(k); if (!e || e[2] < p[2]) m2.set(k, p); }
      pts = [...m2.values()];
    }
    if (slab || v.clip) {
      // the box of what is drawn (a section or slice can be much smaller than the cloud)
      if (pts.length && slab) { let a = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { a[0] = Math.min(a[0], p[0]); a[1] = Math.min(a[1], p[1]); a[2] = Math.max(a[2], p[0]); a[3] = Math.max(a[3], p[1]); } box = a; }
    }
    // pack: Uint16 over the (margin) box, grey bytes, RGB bytes
    const n = pts.length, Q = [B[0], B[1], (B[2] - B[0]) / 65535 || 1, (B[3] - B[1]) / 65535 || 1];
    const xy = new Uint16Array(n * 2), g = new Uint8Array(n), anyRgb = srcs.some((s) => s.hd.meta.attrs.rgb), c = anyRgb ? new Uint8Array(n * 3) : null;
    pts.forEach((p, i) => {
      xy[i * 2] = Math.max(0, Math.min(65535, Math.round((p[0] - Q[0]) / Q[2]))); xy[i * 2 + 1] = Math.max(0, Math.min(65535, Math.round((p[1] - Q[1]) / Q[3])));
      g[i] = p[3]; if (c) { c[i * 3] = p[4]; c[i * 3 + 1] = p[5]; c[i * 3 + 2] = p[6]; }
    });
    const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
    return {
      box, edges: [],
      dots: { n, q: Q, xy: b64(xy), g: b64(g), c: c ? b64(c) : null, cell, hasI: srcs.some((s) => !!s.hd.meta.attrs.intensity), hasRgb: anyRgb },
      info: { dMin, dMax, floor, levels, read, hasI, hasRgb },
    };
  });
}
module.exports = { drawCloudViews };
