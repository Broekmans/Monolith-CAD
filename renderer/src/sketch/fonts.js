// Fonts for sketch text: bundled DejaVu fonts plus the computer's installed
// TrueType/OpenType fonts. Text is converted into closed outline loops so it
// can be extruded (embossed) or cut (engraved).
import opentype from 'opentype.js';
import { api } from '../api.js';
import { opt } from '../app/options/index.js';

const BUNDLED = [
  { name: 'DejaVu Sans', file: 'fonts/DejaVuSans.ttf', bundled: true },
  { name: 'DejaVu Sans Bold', file: 'fonts/DejaVuSans-Bold.ttf', bundled: true },
];
// default font (bundled) and preferred system fonts: Options rows skTextFont / skTextFontPreferred

let listPromise = null;
const cache = new Map();

export function listFonts() {
  if (!listPromise) {
    listPromise = (async () => {
      let sys = [];
      try { sys = (await api.listFonts()) || []; } catch { /* not available */ }
      const seen = new Set(BUNDLED.map((f) => f.name));
      return [...BUNDLED, ...sys.filter((f) => !seen.has(f.name) && seen.add(f.name))];
    })();
  }
  return listPromise;
}

export async function preferredFont() {
  const fonts = await listFonts();
  return opt('skTextFontPreferred').find((n) => fonts.some((f) => f.name === n)) || opt('skTextFont');
}

export async function loadFont(name) {
  if (cache.has(name)) return cache.get(name);
  const p = (async () => {
    const fonts = await listFonts();
    const f = fonts.find((x) => x.name === name) || BUNDLED[0];
    let buf;
    if (f.bundled) buf = await (await fetch('./' + f.file)).arrayBuffer();
    else {
      const bytes = await api.readFont(f.path);
      buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return opentype.parse(buf);
  })();
  cache.set(name, p);
  p.catch(() => cache.delete(name));
  return p;
}

// Text geometry relative to the anchor (unrotated). `h` is the capital
// letter height in sketch units, matching how engineers specify lettering.
// Returns flattened loops (display, profile nesting) and the exact glyph
// segments per loop (lines + quadratic/cubic Beziers) for the kernel.
export function textGeometry(font, text, h, { align = 'left', spacing = opt('skTextLineSpacing') } = {}) {
  const capRatio = (font.tables.os2?.sCapHeight || font.unitsPerEm * opt('skTextCapRatio')) / font.unitsPerEm;
  const size = h / capRatio;
  const tol = h * opt('skTextCurveTol');
  const eps = tol * opt('skTextSamePtTol'), maxSeg = opt('skTextMaxSeg'), colTol = tol * opt('skTextCollinearTol'), res = opt('skTextCoordRes');
  const outline = [], segs = [];
  const lines = String(text || '').split('\n');
  lines.forEach((line, li) => {
    const width = font.getAdvanceWidth(line, size);
    const x0 = align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
    const y0 = -li * h * spacing;
    const T = (x, y) => [round(x0 + x, res), round(y0 - y, res)];
    const path = font.getPath(line, 0, 0, size);
    let poly = null, sg = null, pen = null, start = null, last = null;
    const same = (a, b) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
    const push = (q) => { if (last && same(q, last)) return; poly.push(q); last = q; };
    const steps = (pts) => {
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return Math.max(2, Math.min(maxSeg, Math.ceil(Math.sqrt(L / tol))));
    };
    const addSeg = (ctrl) => { if (ctrl.every((q) => same(q, ctrl[0]))) return; sg.push(ctrl); };
    const close = () => {
      if (!poly) return;
      if (pen && start && !same(pen, start)) { addSeg([pen, start]); }
      else if (sg.length && pen && start) { const lastSeg = sg[sg.length - 1]; lastSeg[lastSeg.length - 1] = start; }
      if (poly.length >= 3) {
        if (same(poly[0], poly[poly.length - 1])) poly.pop();
        const simplified = dropCollinear(poly, colTol);
        if (simplified.length >= 3 && Math.abs(area(simplified)) > tol * tol && sg.length >= 2) { outline.push(simplified); segs.push(sg); }
      }
      poly = null; sg = null; pen = null; start = null; last = null;
    };
    for (const c of path.commands) {
      if (c.type === 'M') { close(); poly = []; sg = []; pen = start = T(c.x, c.y); push(pen); }
      else if (!poly) continue;
      else if (c.type === 'L') { const q = T(c.x, c.y); addSeg([pen, q]); push(q); pen = q; }
      else if (c.type === 'Q') {
        const c1 = T(c.x1, c.y1), q = T(c.x, c.y), p0 = pen;
        addSeg([p0, c1, q]);
        const n = steps([p0, c1, q]);
        for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; push([u * u * p0[0] + 2 * u * t * c1[0] + t * t * q[0], u * u * p0[1] + 2 * u * t * c1[1] + t * t * q[1]]); }
        pen = q;
      } else if (c.type === 'C') {
        const c1 = T(c.x1, c.y1), c2 = T(c.x2, c.y2), q = T(c.x, c.y), p0 = pen;
        addSeg([p0, c1, c2, q]);
        const n = steps([p0, c1, c2, q]);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * q[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * q[1]]);
        }
        pen = q;
      } else if (c.type === 'Z') close();
    }
    close();
  });
  return { outline, segs };
}
export function textOutline(font, text, h, opts) { return textGeometry(font, text, h, opts).outline; }

const round = (v, res) => Math.round(v * res) / res;
function area(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function dropCollinear(p, eps) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs(cross) / L > eps) out.push(b);
  }
  return out;
}
