// Drawing sheets: paper sizes, standard view directions (third angle), scales and the drawing
// primitives of a sheet (frame, title block, views). The same primitive list is drawn on screen
// (drawing.js) and written to PDF (pdf.js). Sheet coordinates: mm, origin bottom-left, y up.

export const SIZES = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
export const SCALES = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 25], [1, 50], [1, 100], [1, 200], [1, 500]];
export const scaleText = (s) => `${s[0]}:${s[1]}`;
export const scaleVal = (s) => s[0] / s[1];
export function parseScale(t) { const m = String(t).trim().match(/^(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)$/); if (!m) return null; const a = +m[1].replace(',', '.'), b = +m[2].replace(',', '.'); return a > 0 && b > 0 ? [a, b] : null; }

// part frame: mm, Y up. dir = towards the viewer, x = right on the paper (up = dir × x)
export const STD = {
  front: { dir: [0, 0, 1], x: [1, 0, 0], label: 'FRONT' },
  back: { dir: [0, 0, -1], x: [-1, 0, 0], label: 'BACK' },
  top: { dir: [0, 1, 0], x: [1, 0, 0], label: 'TOP' },
  bottom: { dir: [0, -1, 0], x: [1, 0, 0], label: 'BOTTOM' },
  right: { dir: [1, 0, 0], x: [0, 0, -1], label: 'RIGHT' },
  left: { dir: [-1, 0, 0], x: [0, 0, 1], label: 'LEFT' },
  iso: { dir: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], x: [1 / Math.SQRT2, 0, -1 / Math.SQRT2], label: 'ISOMETRIC' },
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => a.map((v) => -v || 0);
// third angle projection: the view placed to the right of the parent shows its right side, above shows its top
export function projected(parent, side) {
  const N = parent.dir, X = parent.x, Y = cross(N, X);
  if (side === 'right') return { dir: X, x: neg(N) };
  if (side === 'left') return { dir: neg(X), x: N };
  if (side === 'above') return { dir: Y, x: X };
  return { dir: neg(Y), x: X }; // below
}
// name of a direction if it is a standard one
export function stdName(dir, x) {
  for (const [k, v] of Object.entries(STD)) if (v.dir.every((c, i) => Math.abs(c - dir[i]) < 1e-6) && v.x.every((c, i) => Math.abs(c - x[i]) < 1e-6)) return k;
  return null;
}
export const isOrtho = (v) => v.dir.filter((c) => Math.abs(c) > 1e-9).length === 1;

// ---------- view geometry on the sheet ----------
export const viewScale = (v, sheet) => scaleVal(v.scale || sheet.scale);
// model (view plane, mm) -> sheet (mm)
export function viewXf(v, sheet) {
  const s = viewScale(v, sheet), b = v.geom?.box || [0, 0, 0, 0];
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return { s, f: (x, y) => [v.pos[0] + (x - cx) * s, v.pos[1] + (y - cy) * s] };
}
export function viewRect(v, sheet) {
  const b = v.geom?.box; if (!b || !(b[2] >= b[0])) return [v.pos[0] - 10, v.pos[1] - 10, v.pos[0] + 10, v.pos[1] + 10];
  const { f } = viewXf(v, sheet), a = f(b[0], b[1]), c = f(b[2], b[3]);
  return [a[0], a[1], c[0], c[1]];
}

import { textWidth, EM } from './pdf.js';
import { annPrims, hatchPrims, DIM } from './dims.js';
import { styleOf } from './styles.js';
import { dotsPrim } from './dots.js';
import { rasterPrim } from './raster.js';

// line weights (mm) and dash patterns
export const LW = { thick: 0.5, thin: 0.25, hidden: 0.35, frame: 0.7, tb: 0.35 };
export const DASH = { hidden: [3, 1.5] };

// title block fields: [key, label]
export const TB_FIELDS = [['company', 'Company'], ['title', 'Title'], ['number', 'Drawing no.'], ['drawnBy', 'Drawn by'], ['date', 'Date'], ['revision', 'Revision']];

// primitives: {t:'line', pts:[x,y,...], w, dash?, color?} | {t:'text', x, y, size, text, align ('l'|'c'|'r'), bold?}
export function sheetPrims(doc, sheet, { selected = null, selAnn = null, preview = null } = {}) {
  const [W, H] = sheetSize(sheet), out = [];
  const L = (pts, w, extra = {}) => out.push({ t: 'line', pts, w, ...extra });
  const T = (x, y, size, text, align = 'l', bold = false, extra = {}) => out.push({ t: 'text', x, y, size, text: String(text ?? ''), align, bold, ...extra });
  const rect = (x0, y0, x1, y1, w) => L([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], w);
  // frame: 20 mm filing margin left, 10 mm elsewhere
  const m = { l: 20, r: 10, t: 10, b: 10 };
  rect(m.l, m.b, W - m.r, H - m.t, LW.frame);
  // centring marks
  for (const [a, b, c, d] of [[W / 2, 0, W / 2, m.b], [W / 2, H, W / 2, H - m.t], [0, H / 2, m.l, H / 2], [W, H / 2, W - m.r, H / 2]]) L([a, b, c, d], LW.frame);
  // title block (bottom right, 40 mm high): as wide as its text needs, at least 110 mm
  const tb = doc.titleBlock || {};
  const idx = doc.sheets.indexOf(sheet) + 1;
  const models = [...new Set(doc.views.filter((v) => v.sheet === sheet.id).map((v) => v.srcName))];
  const tw = titleWidth(doc, sheet, models, W - m.l - m.r - 30), th = 40, x1 = W - m.r, x0 = x1 - tw, y0 = m.b, y1 = y0 + th;
  rect(x0, y0, x1, y1, LW.frame);
  // rows: company | title (big) ; model ; number / scale / sheet ; drawn by / date / revision
  const rows = [y1, y1 - 8, y1 - 18, y1 - 26, y1 - 33, y0];
  for (const y of rows.slice(1, -1)) L([x0, y, x1, y], LW.tb);
  const cell = (xa, xb, ya, yb, label, value, size = 3) => {
    if (xa > x0) L([xa, ya, xa, yb], LW.tb);
    T(xa + 1.2, yb - 2.2, 1.8, label);
    T(xa + 1.2, ya + 1.4, size, value, 'l', size > 3);
  };
  cell(x0, x1, rows[1], rows[0], 'COMPANY', tb.company || '');
  cell(x0, x1, rows[2], rows[1], 'TITLE', tb.title || doc.name, 4.5);
  cell(x0, x1, rows[3], rows[2], models.length > 1 ? 'MODELS' : 'MODEL', models.join(', '));
  const c3 = [x0, x0 + tw * TB_COLS[0], x0 + tw * (TB_COLS[0] + TB_COLS[1]), x1];
  cell(c3[0], c3[1], rows[4], rows[3], 'DRAWING NO.', tb.number || '');
  cell(c3[1], c3[2], rows[4], rows[3], 'SCALE', scaleText(sheet.scale));
  cell(c3[2], c3[3], rows[4], rows[3], 'SHEET', `${idx} / ${doc.sheets.length}`);
  cell(c3[0], c3[1], rows[5], rows[4], 'DRAWN BY', tb.drawnBy || '');
  cell(c3[1], c3[2], rows[5], rows[4], 'DATE', tb.date || '');
  cell(c3[2], c3[3], rows[5], rows[4], 'REVISION', tb.revision || '');
  // zone grid: numbers along the top and bottom margin, letters along the left and right margin
  const zg = zoneGrid(sheet);
  if (zg) {
    const fx0 = m.l, fx1 = W - m.r, fy0 = m.b, fy1 = H - m.t;
    for (let i = 0; i <= zg.nx; i++) { const x = fx0 + ((fx1 - fx0) * i) / zg.nx; if (i > 0 && i < zg.nx) { L([x, fy1, x, H - 2], LW.thin); L([x, fy0, x, 2], LW.thin); } if (i < zg.nx) { const xc = x + (fx1 - fx0) / zg.nx / 2; T(xc, H - m.t / 2 - 1.2, 2.5, String(i + 1), 'c'); T(xc, m.b / 2 - 1.2, 2.5, String(i + 1), 'c'); } }
    for (let j = 0; j <= zg.ny; j++) { const y = fy1 - ((fy1 - fy0) * j) / zg.ny; if (j > 0 && j < zg.ny) { L([fx0, y, 2, y], LW.thin); L([fx1, y, W - 2, y], LW.thin); } if (j < zg.ny) { const yc = y - (fy1 - fy0) / zg.ny / 2 - 1.2, ch = zoneLetter(j); T(m.l / 2 + 1, yc, 2.5, ch, 'c'); T(W - m.r / 2, yc, 2.5, ch, 'c'); } }
  }
  // third angle projection symbol + units, left of the title block
  const sx = x0 - 22, sy = y0 + 3;
  rect(x0 - 26, y0, x0, y0 + 14, LW.tb);
  L([sx, sy + 2.5, sx, sy + 5.5, sx + 7, sy + 7, sx + 7, sy + 1, sx, sy + 2.5], LW.thin);
  L([sx, sy + 4, sx + 7, sy + 4], LW.thin, { dash: [1, 0.6] });
  out.push({ t: 'circle', c: [sx + 13, sy + 4], r: 3, w: LW.thin }, { t: 'circle', c: [sx + 13, sy + 4], r: 1.5, w: LW.thin });
  T(x0 - 13, y0 + 11, 1.8, `THIRD ANGLE · ${doc.dimUnits || 'mm'}`, 'c');
  // views
  for (const v of doc.views.filter((q) => q.sheet === sheet.id)) {
    if (!v.geom) continue;
    const xf = viewXf(v, sheet), { f } = xf;
    if (v.geom.dots) { const dp = dotsPrim(v, xf); if (dp) out.push(dp); }
    if (v.geom.raster) { const rp = rasterPrim(v, xf); if (rp) out.push(rp); }
    for (const e of v.geom.edges) {
      if (e.cls === 'h' && !v.hidden) continue;
      if (e.cls === 't' && v.tangent === false) continue;
      const pts = [];
      for (let i = 0; i < e.pts.length; i += 2) pts.push(...f(e.pts[i], e.pts[i + 1]));
      if (e.ov) { if (v.cloud?.overlayOn === false) continue; L(pts, e.cls === 'v' ? LW.thin * 1.4 : LW.thin, { color: v.cloud?.ovColor || '#1f5fbf' }); continue; } // part overlay on a scan
      L(pts, e.cls === 'v' ? LW.thick : e.cls === 'h' ? LW.hidden : LW.thin, e.cls === 'h' ? { dash: DASH.hidden } : e.cls === 't' ? { color: '#555555' } : {});
    }
    // section faces: 45° hatch, about 2.5 mm apart on paper
    const s = viewScale(v, sheet);
    for (const face of v.geom.hatch || []) hatchPrims(face, f, 2.5 / s, out);
    // cutting lines of the section views made from this view
    for (const c of doc.views.filter((q) => q.parent === v.id && q.cut)) cutPrims(c, f, out, L, T, selected === c.id);
    if (v.label !== false) {
      const r = viewRect(v, sheet);
      const own = v.scale && (v.scale[0] !== sheet.scale[0] || v.scale[1] !== sheet.scale[1]);
      T((r[0] + r[2]) / 2, r[1] - 7, 3.5, v.cut ? `SECTION ${v.cut.letter}-${v.cut.letter}` : v.name.toUpperCase(), 'c', true);
      if (own) T((r[0] + r[2]) / 2, r[1] - 11.5, 2.5, `SCALE ${scaleText(v.scale)}`, 'c');
    }
    // annotations
    for (const a of v.anns || []) { const n0 = out.length; const r = annPrims(a, f, s, out, { dec: doc.dimDec ?? 2, units: doc.dimUnits || 'mm', areaUnits: doc.areaUnits || 'm2', color: selAnn === a.id ? '#2a6fd6' : undefined, st: styleOf(doc, a) }); for (let i = n0; i < out.length; i++) if (out[i].t === 'annpath') out[i].view = v.id; if (r?.box) out.push({ t: 'annbox', ann: a.id, view: v.id, box: r.box }); }
    { const r = frameRect(v, sheet); out.push({ t: 'sel', on: selected === v.id, pts: [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3], r[0], r[1]] }); } // screen only
  }
  if (preview) for (const p of preview) {
    if (p.t !== 'annprev') { out.push(p); continue; }
    const v = doc.views.find((q) => q.id === p.view); if (!v) continue;
    annPrims(p.ann, viewXf(v, sheet).f, viewScale(v, sheet), out, { dec: doc.dimDec ?? 2, units: doc.dimUnits || 'mm', areaUnits: doc.areaUnits || 'm2', color: '#2a6fd6', st: styleOf(doc, p.ann) });
  }
  return out;
}
export function sheetSize(sheet) { const [a, b] = SIZES[sheet.size] || SIZES.A3; return sheet.orient === 'portrait' ? [b, a] : [a, b]; }
export function drawArea(sheet) { const [W, H] = sheetSize(sheet); return { x0: 20, y0: 10 + 40, x1: W - 10, y1: H - 10, W, H }; }

// dotted frame around a view (screen only): the view's box plus a margin
export const FRAME_M = 4;
export function frameRect(v, sheet) { const r = viewRect(v, sheet); return [r[0] - FRAME_M, r[1] - FRAME_M, r[2] + FRAME_M, r[3] + FRAME_M]; }
// title block column shares of the two lower rows
const TB_COLS = [0.5, 0.25, 0.25];
export function titleWidth(doc, sheet, models, maxW) {
  const tb = doc.titleBlock || {}, pad = 3;
  const w = (t, size, bold) => textWidth(t, size * EM, bold) + pad;
  let need = Math.max(w(tb.company || '', 3), w(tb.title || doc.name, 4.5, true), w(models.join(', '), 3));
  const cols = [[tb.number, tb.drawnBy], [scaleText(sheet.scale), tb.date], [`${doc.sheets.length} / ${doc.sheets.length}`, tb.revision]];
  cols.forEach((c, i) => { for (const t of c) need = Math.max(need, w(t || '', 3) / TB_COLS[i]); });
  return Math.max(110, Math.min(maxW, Math.ceil(need / 5) * 5));
}
export const zoneLetter = (j) => String.fromCharCode(65 + (j >= 8 ? j + 1 : j) + (j >= 13 ? 1 : 0)); // skips I and O
// zones about 50 mm (even count along the long side, as on standard sheets)
export function zoneGrid(sheet) {
  if (!sheet.zones?.on) return null;
  const [W, H] = sheetSize(sheet), fw = W - 30, fh = H - 20;
  const nx = sheet.zones.nx > 0 ? sheet.zones.nx : Math.max(2, 2 * Math.round(fw / 100));
  const ny = sheet.zones.ny > 0 ? sheet.zones.ny : Math.max(2, 2 * Math.round(fh / 100));
  return { nx, ny };
}

// cutting line A–A on the parent view: thin chain line, thick ends, arrows in the viewing direction, letters
function cutPrims(c, f, out, L0, T0, sel = false) {
  // selected section: its cutting line in blue (screen and PDF alike are drawn from the same prims; PDF has no selection)
  const col = sel ? { color: '#2a6fd6' } : {};
  const L = (pts, w, extra = {}) => L0(pts, w, { ...extra, ...col }), T = (x, y, size, text, align, bold, extra = {}) => T0(x, y, size, text, align, bold, { ...extra, ...col });
  const n0 = out.length;
  const A = f(...c.cut.a), B = f(...c.cut.b);
  const d = [B[0] - A[0], B[1] - A[1]], l = Math.hypot(...d) || 1, u = [d[0] / l, d[1] / l];
  const e = 6, A0 = [A[0] - u[0] * 4, A[1] - u[1] * 4], B0 = [B[0] + u[0] * 4, B[1] + u[1] * 4];
  L([...A0, ...B0], LW.thin, { dash: [8, 1.5, 1, 1.5] });
  L([...A0, A0[0] + u[0] * e, A0[1] + u[1] * e], LW.thick);
  L([...B0, B0[0] - u[0] * e, B0[1] - u[1] * e], LW.thick);
  // arrows show the direction of sight: towards the kept material (away from the section view side)
  const m = c.cut.m2, sight = [-m[0], -m[1]], al = 8;
  for (const P of [A0, B0]) {
    const tail = [P[0] - sight[0] * al, P[1] - sight[1] * al];
    L([...tail, ...P], LW.thin);
    const p = [-sight[1], sight[0]], b = [P[0] - sight[0] * DIM.arrow * 1.3, P[1] - sight[1] * DIM.arrow * 1.3];
    out.push({ t: 'fill', pts: [...P, b[0] + p[0] * 0.8, b[1] + p[1] * 0.8, b[0] - p[0] * 0.8, b[1] - p[1] * 0.8], ...col });
    T(tail[0] - sight[0] * 1.5 - 1.2, tail[1] - sight[1] * 1.5 - 1.8, 5, c.cut.letter, 'l', true);
  }
  void n0;
}
