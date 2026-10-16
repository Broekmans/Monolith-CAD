// Point cloud dots in drawing views: decoding the packed dots stored in a view (geom.dots, made by
// main/clouddraw.cjs), colour buckets, the 'dots' primitive drawn on screen (drawing.js paint) and in the
// PDF (pdf.js). Dot coordinates are view-model mm; prim: sheet = (ox + x·s, oy + y·s).

const dec = new WeakMap();
const bytes = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export function decodeDots(d) {
  if (!d) return null;
  let r = dec.get(d);
  if (r) return r;
  const xy = new Uint16Array(bytes(d.xy).buffer), n = d.n, q = d.q;
  const x = new Float32Array(n), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = q[0] + xy[i * 2] * q[2]; y[i] = q[1] + xy[i * 2 + 1] * q[3]; }
  r = { n, x, y, g: d.g ? bytes(d.g) : null, c: d.c ? bytes(d.c) : null, buckets: {} };
  dec.set(d, r);
  return r;
}
const hex2 = (v) => v.toString(16).padStart(2, '0');
// colour groups: [{color, idx}] drawn in order (greyscale: light first, so dark points stay on top)
export function dotBuckets(D, mode) {
  const m = mode === 'rgb' && !D.c ? 'grey' : mode === 'grey' && !D.g ? 'black' : mode;
  if (D.buckets[m]) return D.buckets[m];
  let out;
  if (m === 'grey' || m === 'rgb') {
    const map = new Map();
    for (let i = 0; i < D.n; i++) {
      let k;
      if (m === 'grey') k = Math.min(15, D.g[i] >> 4) * 13; // 0 (black) … 195 (light grey, still visible on white)
      else k = ((D.c[i * 3] >> 4) << 8) | ((D.c[i * 3 + 1] >> 4) << 4) | (D.c[i * 3 + 2] >> 4);
      let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(i);
    }
    out = [...map.entries()].map(([k, a]) => ({ k, color: m === 'grey' ? '#' + hex2(k).repeat(3) : '#' + [k >> 8, (k >> 4) & 15, k & 15].map((v) => hex2(v * 17)).join(''), idx: Int32Array.from(a) }));
    if (m === 'grey') out.sort((a, b) => b.k - a.k);
  } else out = [{ color: '#000000', idx: null }];
  return (D.buckets[m] = out);
}
// primitive for one view
export function dotsPrim(v, xf) {
  const D = decodeDots(v.geom?.dots);
  if (!D || !D.n) return null;
  const b = v.geom.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, o = v.cloud || {};
  return { t: 'dots', D, s: xf.s, ox: v.pos[0] - cx * xf.s, oy: v.pos[1] - cy * xf.s, size: o.size || 0.25, mode: o.color || 'black' };
}
// screen: S = sheet -> pixel, k = pixels per mm
export function paintDots(ctx, p, S, k) {
  const D = p.D, px = Math.max(1, p.size * k), h = px / 2;
  const o = S([p.ox, p.oy]), e = S([p.ox + p.s, p.oy]), f = S([p.ox, p.oy + p.s]);
  const ax = e[0] - o[0], ay = f[1] - o[1];
  for (const bk of dotBuckets(D, p.mode)) {
    ctx.fillStyle = bk.color; ctx.beginPath();
    const n = bk.idx ? bk.idx.length : D.n;
    for (let j = 0; j < n; j++) { const i = bk.idx ? bk.idx[j] : j; ctx.rect(o[0] + D.x[i] * ax - h, o[1] + D.y[i] * ay - h, px, px); }
    ctx.fill();
  }
}
// PDF content operators (K = pt per mm)
export function pdfDots(p, K) {
  const D = p.D, w = p.size * K, h = w / 2, ops = [];
  const r2 = (v) => (Math.round(v * 100) / 100).toString();
  const ws = r2(w);
  for (const bk of dotBuckets(D, p.mode)) {
    const c = bk.color, rgb = [1, 3, 5].map((i) => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
    ops.push(`${rgb} rg`);
    const n = bk.idx ? bk.idx.length : D.n, line = [];
    for (let j = 0; j < n; j++) { const i = bk.idx ? bk.idx[j] : j; line.push(`${r2((p.ox + D.x[i] * p.s) * K - h)} ${r2((p.oy + D.y[i] * p.s) * K - h)} ${ws} ${ws} re`); if (line.length >= 2000) { ops.push(line.join('\n')); line.length = 0; } }
    if (line.length) ops.push(line.join('\n'));
    ops.push('f');
  }
  return ops.join('\n');
}
