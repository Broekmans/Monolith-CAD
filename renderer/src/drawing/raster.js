// Density rasters of point cloud views (geom.raster, made by main/clouddraw.cjs): the "scan look" —
// grey by the number of points per pixel, walls dark, floors light. The PNG holds the tone 0 (empty) …
// 255 (dense); the view's darkness (v.cloud.dark) is applied here. Loading a PNG is asynchronous: the
// first paint starts it and asks for a repaint when ready (onRasterReady). Prim: {t:'raster', R, x, y, w, h}
// (sheet mm of the image corners: x,y = bottom-left).

const cache = new WeakMap(); // raster object -> {ink: Uint8Array, w, h, canv: Map(dark -> canvas), loading}
let ready = () => {};
export function onRasterReady(fn) { ready = fn; }
function load(r) {
  let e = cache.get(r);
  if (e) return e;
  e = { ink: null, w: r.w, h: r.h, canv: new Map(), loading: null };
  cache.set(r, e);
  e.loading = new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = r.w; c.height = r.h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, r.w, r.h).data, ink = new Uint8Array(r.w * r.h);
      for (let i = 0; i < ink.length; i++) ink[i] = d[i * 4];
      e.ink = ink; res(e); ready();
    };
    img.onerror = () => { e.ink = new Uint8Array(r.w * r.h); res(e); };
    img.src = 'data:image/png;base64,' + r.png;
  });
  return e;
}
export async function loadRaster(r) { const e = load(r); await e.loading; return e; }
// tone curve: t^1.25 keeps sparse areas light; darkness scales the result
export function inkOf(L, dark = 1) { if (!L) return 0; const t = Math.pow(L / 255, 1.25) * dark; return t >= 1 ? 1 : t; }
// canvas for a darkness and a reduction k (zoomed out: k×k pixels -> 1 by their maximum, so thin walls stay visible)
function canvasFor(e, dark, k = 1) {
  const key = dark + ':' + k;
  let c = e.canv.get(key);
  if (c) return c;
  const w = Math.ceil(e.w / k), h = Math.ceil(e.h / k);
  let ink = e.ink;
  if (k > 1) {
    ink = new Uint8Array(w * h);
    for (let y = 0; y < e.h; y++) { const yo = ((y / k) | 0) * w, row = y * e.w; for (let x = 0; x < e.w; x++) { const i = yo + ((x / k) | 0), v = e.ink[row + x]; if (v > ink[i]) ink[i] = v; } }
  }
  c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'), id = x.createImageData(w, h), d = id.data, lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(inkOf(i, dark) * 255);
  for (let i = 0; i < ink.length; i++) { d[i * 4 + 3] = lut[ink[i]]; } // black with alpha = ink
  x.putImageData(id, 0, 0);
  if (e.canv.size > 6) e.canv.clear();
  e.canv.set(key, c);
  return c;
}
export function rasterPrim(v, xf) {
  const r = v.geom?.raster; if (!r) return null;
  const b = v.geom.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, s = xf.s;
  const X = v.pos[0] + (r.x0 - cx) * s, Ytop = v.pos[1] + (r.y1 - cy) * s, w = r.w * r.pix * s, h = r.h * r.pix * s;
  return { t: 'raster', R: r, x: X, y: Ytop - h, w, h, dark: v.cloud?.dark ?? 1 };
}
export function paintRaster(ctx, p, S) {
  const e = load(p.R);
  if (!e.ink) return;
  const a = S([p.x, p.y + p.h]), b = S([p.x + p.w, p.y]);
  ctx.save(); ctx.imageSmoothingEnabled = true;
  const k = Math.max(1, Math.min(32, 2 ** Math.floor(Math.log2(Math.max(1, e.w / Math.max(1, b[0] - a[0]))))));
  ctx.drawImage(canvasFor(e, p.dark, k), a[0], a[1], b[0] - a[0], b[1] - a[1]);
  ctx.restore();
}
// PDF: grey image bytes (255 = white), rows top to bottom; null until loaded (exportPdf loads first)
export function pdfGrey(p) {
  const e = cache.get(p.R); if (!e?.ink) return null;
  const out = new Uint8Array(e.ink.length), lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = 255 - Math.round(inkOf(i, p.dark) * 255);
  for (let i = 0; i < out.length; i++) out[i] = lut[e.ink[i]];
  return { w: e.w, h: e.h, data: out };
}
