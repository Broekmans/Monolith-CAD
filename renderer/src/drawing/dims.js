// Drawing annotations and section graphics as primitives (sheet mm). Annotation geometry is stored in the
// view's model plane (mm), so it moves and scales with its view; text and arrows keep their paper size.
//   len:  {a, b, mode: 'aligned'|'h'|'v', at}          rad/dia: {c, r, at}
//   ang:  {x (vertex), d1, d2 (unit rays), at}           area: {pts | c+r, at}
//   note: {text, at, anchor?}
import { textWidth, EM } from './pdf.js';
import { STD_DEF, DASHES } from './styles.js';

export const DIM = { text: 3.5, arrow: 3, arrowW: 0.5, gap: 1, ext: 2, lw: 0.25 };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const perp = (a) => [-a[1], a[0]];

export function fmtVal(v, dec = 2) {
  const s = v.toFixed(dec);
  return dec > 0 ? s.replace(/\.?0+$/, '') : s;
}
export function polyArea(pts) { let A = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; A += p[0] * q[1] - q[0] * p[1]; } return Math.abs(A) / 2; }
export function centroid(pts) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }

// value of an annotation (model units)
export function annValue(a) {
  if (a.type === 'len') { const d = sub(a.b, a.a); return a.mode === 'h' ? Math.abs(d[0]) : a.mode === 'v' ? Math.abs(d[1]) : len(d); }
  if (a.type === 'rad') return a.r;
  if (a.type === 'dia') return 2 * a.r;
  if (a.type === 'ang') return (Math.acos(Math.max(-1, Math.min(1, dot(a.d1, a.d2)))) * 180) / Math.PI;
  if (a.type === 'area') return a.pts ? polyArea(a.pts) : Math.PI * a.r * a.r;
  if (a.type === 'scalebar') return a.len;
  return 0;
}
export function annText(a, dec, units = 'mm', areaU = 'm2') {
  if (a.type === 'note') return a.text || '';
  if (a.type === 'scalebar') return '';
  const t = a.override ? String(a.override) : valueText(a, dec, units, areaU);
  return (a.prefix || '') + t + (a.suffix || '');
}
function valueText(a, dec, units, areaU) {
  const m = units === 'm';
  if (a.type === 'scalebar') return '';
  const v = annValue(a);
  const L = (x) => fmtVal(m ? x / 1000 : x, dec);
  if (a.type === 'rad') return 'R' + L(v);
  if (a.type === 'dia') return 'Ø' + L(v);
  if (a.type === 'ang') return fmtVal(v, Math.max(0, dec - 1)) + '°';
  if (a.type === 'area') return (a.label ? a.label + '  ' : '') + (areaU === 'mm2' ? `A = ${fmtVal(v, Math.max(0, dec - 1))} mm²` : areaU === 'cm2' ? `A = ${fmtVal(v / 100, Math.max(0, dec - 1))} cm²` : `A = ${fmtVal(v / 1e6, v < 1e6 ? 4 : Math.max(2, dec))} m²`);
  return L(v);
}
// readable text angle (radians, within -90°..90°)
const readable = (t) => { while (t > Math.PI / 2 + 1e-9) t -= Math.PI; while (t <= -Math.PI / 2 + 1e-9) t += Math.PI; return t; };

// primitives of one annotation; f: model -> sheet, s: view scale. sel: highlight colour
export function annPrims(a, f, s, out, { dec = 2, color, units = 'mm', areaUnits = 'm2', st = STD_DEF } = {}) {
  // style: selection colour overrides the line/text colours
  const lc = color || (st.lineColor && st.lineColor !== '#000000' ? st.lineColor : null), tc = color || (st.textColor && st.textColor !== '#000000' ? st.textColor : null);
  const C = lc ? { color: lc } : {}, CT = tc ? { color: tc } : {};
  const TH = st.textH || DIM.text, AS = st.arrowSize ?? DIM.arrow, GAP = st.extGap ?? DIM.gap, EXT = st.extOver ?? DIM.ext, LW = st.lineW || DIM.lw;
  const L = (pts) => out.push({ t: 'line', pts, w: LW, ...C });
  const arrow = (tip, dir) => {
    const u = nrm(dir), p = perp(u), k = AS / 6, ty = st.arrow || 'filled';
    if (ty === 'dot') { out.push({ t: 'circle', c: tip, r: AS / 5, w: AS / 2.5, ...C }); return; }
    if (ty === 'tick') { const d = mul(nrm(add(u, p)), AS / 2); out.push({ t: 'line', pts: [...sub(tip, d), ...add(tip, d)], w: LW * 2, ...C }); return; }
    const b = sub(tip, mul(u, AS)); const q1 = add(b, mul(p, k)), q2 = sub(b, mul(p, k));
    if (ty === 'open') out.push({ t: 'line', pts: [...q1, ...tip, ...q2], w: LW, ...C }); else out.push({ t: 'fill', pts: [...tip, ...q1, ...q2], ...C });
  };
  const T = (x, y, text, rot = 0, align = 'c') => out.push({ t: 'text', x, y, size: TH, text, align, rot, ...CT, ann: a.id });
  const text = annText(a, dec, units, areaUnits), tw = textWidth(text, TH * EM);
  if (a.type === 'len') {
    const A = f(...a.a), B = f(...a.b), P = f(...a.at);
    const u = a.mode === 'h' ? [1, 0] : a.mode === 'v' ? [0, 1] : nrm(sub(B, A));
    const n = perp(u);
    const dA = add(A, mul(n, dot(sub(P, A), n))), dB = add(B, mul(n, dot(sub(P, B), n)));
    // extension lines (small gap at the part, a little past the dimension line)
    for (const [p, d] of [[A, dA], [B, dB]]) { const v = sub(d, p), l = len(v); if (l > GAP) { const w = mul(v, 1 / l); L([...add(p, mul(w, GAP)), ...add(d, mul(w, EXT))]); } }
    const span = len(sub(dB, dA)), ud = span > 1e-9 ? nrm(sub(dB, dA)) : u;
    const inside = span > 2 * AS + 2;
    if (inside) { L([...dA, ...dB]); arrow(dA, mul(ud, -1)); arrow(dB, ud); }
    else { L([...sub(dA, mul(ud, AS + 4)), ...add(dB, mul(ud, AS + 4))]); arrow(dA, ud); arrow(dB, mul(ud, -1)); }
    // text: at the dimension line, above it (ISO aligned), at P's position along the line
    const t = Math.max(-0.5, Math.min(1.5, span > 1e-9 ? dot(sub(P, dA), ud) / span : 0.5));
    const along = Math.abs(t - 0.5) < 0.5 ? add(dA, mul(sub(dB, dA), inside ? 0.5 : t)) : add(dA, mul(sub(dB, dA), t));
    let rot = readable(Math.atan2(ud[1], ud[0]));
    const up = [-Math.sin(rot), Math.cos(rot)];
    // chain: a text longer than its segment goes to the other side of the line on every second one
    // (neighbouring short segments then never overlap)
    const flip = a.chain != null && tw + 1 > span && a.chain % 2 === 1;
    const tp = add(along, mul(up, flip ? -(TH + 1) : 1));
    T(tp[0], tp[1], text, rot);
    return { box: textBox(tp, tw, rot, TH) };
  }
  if (a.type === 'rad' || a.type === 'dia') {
    const Cc = f(...a.c), P = f(...a.at), R = a.r * s;
    const d = nrm(sub(P, Cc)), Q = add(Cc, mul(d, R));
    const far = a.type === 'dia' ? sub(Cc, mul(d, R)) : Cc;
    const outside = len(sub(P, Cc)) > R;
    L([...P, ...far]);
    if (outside) arrow(Q, mul(d, -1)); else arrow(Q, d);
    if (a.type === 'dia') arrow(far, mul(d, outside ? 1 : -1));
    // horizontal shoulder with the text on it
    const right = P[0] >= Cc[0], sh = add(P, [right ? tw + 2 : -(tw + 2), 0]);
    L([...P, ...sh]);
    const tx = right ? P[0] + 1 : sh[0] + 1;
    T(tx, P[1] + 1, text, 0, 'l');
    return { box: [tx, P[1], tx + tw, P[1] + TH + 1] };
  }
  if (a.type === 'ang') {
    const X = f(...a.x), P = f(...a.at), r = Math.max(4, len(sub(P, X)));
    const a1 = Math.atan2(a.d1[1], a.d1[0]);
    let da = Math.atan2(a.d2[1], a.d2[0]) - a1;
    while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    const pts = []; const N = Math.max(8, Math.ceil(Math.abs(da) * 24));
    for (let i = 0; i <= N; i++) { const t = a1 + (da * i) / N; pts.push(X[0] + r * Math.cos(t), X[1] + r * Math.sin(t)); }
    L(pts);
    // extension along the rays when the arc is beyond the geometry
    for (const d of [a.d1, a.d2]) L([...add(X, mul(d, r * 0.15)), ...add(X, mul(d, r + EXT))]);
    const sg = Math.sign(da) || 1;
    arrow([pts[0], pts[1]], [Math.sin(a1) * sg, -Math.cos(a1) * sg]);
    const a2 = a1 + da;
    arrow([pts[pts.length - 2], pts[pts.length - 1]], [-Math.sin(a2) * sg, Math.cos(a2) * sg]);
    // horizontal text just outside the arc, on the bisector
    const mid = a1 + da / 2, cx = Math.cos(mid), sy = Math.sin(mid);
    const tp = add(X, [(r + 2 + (tw / 2) * Math.abs(cx)) * cx, (r + 2) * sy + (sy < 0 ? -TH : 0)]);
    T(tp[0], tp[1], text, 0);
    return { box: textBox(tp, tw, 0, TH) };
  }
  if (a.type === 'area') {
    const P = f(...a.at);
    if (a.pts && st.fillOpacity > 0) { const q = a.pts.flatMap((p) => f(...p)); out.push({ t: 'fill', pts: q, color: st.fillColor || '#2a6fd6', alpha: Math.min(1, st.fillOpacity / 100) }); }
    if (a.pts) { const q = a.pts.flatMap((p) => f(...p)); const oc = color || st.outlineColor || '#000000'; out.push({ t: 'line', pts: [...q, q[0], q[1]], w: st.outlineW || LW, ...(DASHES[st.outlineDash || 'chain'] ? { dash: DASHES[st.outlineDash || 'chain'] } : {}), ...(oc !== '#000000' ? { color: oc } : {}) }); out.push({ t: 'annpath', ann: a.id, pts: [...q, q[0], q[1]] }); }
    const Cc = a.dot ? f(...a.dot) : a.pts ? f(...centroid(a.pts)) : f(...a.c);
    out.push({ t: 'circle', c: Cc, r: 0.6, w: 0.5, ...C });
    if (len(sub(P, Cc)) > 3) L([...Cc, ...P]);
    L([...P, ...add(P, [P[0] >= Cc[0] ? tw + 2 : -(tw + 2), 0])]);
    const tx = P[0] >= Cc[0] ? P[0] + 1 : P[0] - tw - 1;
    T(tx, P[1] + 1, text, 0, 'l');
    return { box: [tx, P[1], tx + tw, P[1] + TH + 1] };
  }
  if (a.type === 'scalebar') {
    // checkered bar: n segments, labels 0 … len (m from 1 m on), true to the view scale
    const P = f(...a.at), Lp = a.len * s, n = a.n || 5, sl = Lp / n, hb = 1.2;
    const lab = (v) => (a.len >= 1000 ? fmtVal(v / 1000, 2) + (v === a.len ? ' m' : '') : fmtVal(v, 1) + (v === a.len ? ' mm' : ''));
    for (let i = 0; i < n; i++) {
      const x0 = P[0] + i * sl, q = [x0, P[1], x0 + sl, P[1], x0 + sl, P[1] + hb, x0, P[1] + hb];
      if (i % 2 === 0) out.push({ t: 'fill', pts: q, ...C });
      L([...q, q[0], q[1]]);
    }
    let w = 0;
    for (const i of [0, Math.floor(n / 2), n]) { const tx = lab((a.len * i) / n); T(P[0] + i * sl, P[1] + hb + 1, tx, 0, 'c'); w = Math.max(w, textWidth(tx, TH * EM)); }
    return { box: [P[0] - w / 2, P[1], P[0] + Lp + w / 2, P[1] + hb + 1 + TH] };
  }
  if (a.type === 'note') {
    const P = f(...a.at), lines = String(a.text || '').split('\n');
    if (a.anchor) { const A = f(...a.anchor); L([...A, ...P]); arrow(A, sub(A, P)); }
    let w = 0;
    lines.forEach((ln, i) => { T(P[0] + 1, P[1] - i * TH * 1.6, ln, 0, 'l'); w = Math.max(w, textWidth(ln, TH * EM)); });
    return { box: [P[0], P[1] - (lines.length - 1) * TH * 1.6, P[0] + w + 1, P[1] + TH] };
  }
  return null;
}
function textBox(p, w, rot, th = DIM.text) {
  const c = Math.cos(rot), s = Math.sin(rot), h = th + 1;
  const pts = [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]].map(([x, y]) => [p[0] + x * c - y * s, p[1] + x * s + y * c]);
  return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
}

// 45° hatch lines inside loops (even-odd), spacing in model units; returns sheet line prims
export function hatchPrims(face, f, spacing, out, w = 0.18) {
  const c = Math.SQRT1_2;
  // rotate by -45°: u = (x + y)c, v = (-x + y)c ; scan lines v = const
  const segs = [];
  let vmin = Infinity, vmax = -Infinity;
  for (const lp of face) {
    const n = lp.length / 2;
    for (let i = 0; i < n; i++) {
      const x0 = lp[i * 2], y0 = lp[i * 2 + 1], j = (i + 1) % n, x1 = lp[j * 2], y1 = lp[j * 2 + 1];
      const a = [(x0 + y0) * c, (-x0 + y0) * c], b = [(x1 + y1) * c, (-x1 + y1) * c];
      segs.push([a, b]); vmin = Math.min(vmin, a[1], b[1]); vmax = Math.max(vmax, a[1], b[1]);
    }
  }
  if (!segs.length) return;
  for (let v = Math.ceil(vmin / spacing) * spacing; v <= vmax; v += spacing) {
    const xs = [];
    for (const [a, b] of segs) { if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0])); }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const back = (u) => f((u - v) * c, (u + v) * c);
      out.push({ t: 'line', pts: [...back(xs[i]), ...back(xs[i + 1])], w });
    }
  }
}
