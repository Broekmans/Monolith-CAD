// 2D geometry helpers for sketching.
import { opt } from '../app/options/index.js';
export const TAU = Math.PI * 2;
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const normAng = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };

export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || opt('geomEpsZero');
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  const tc = Math.max(0, Math.min(1, t));
  return { t, tc, pt: [a[0] + dx * tc, a[1] + dy * tc], ptLine: [a[0] + dx * t, a[1] + dy * t] };
}

export function distToSegment(p, a, b) {
  return dist(p, projectOnSegment(p, a, b).pt);
}

export function angleInArc(ang, a0, a1) {
  const sw = normAng(a1 - a0) || TAU;
  return normAng(ang - a0) <= sw + opt('geomEpsTiny');
}

// Intersections: return arrays of points.
export function lineLine(a, b, c, d, { segA = true, segB = true } = {}) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < opt('geomEpsZero')) return [];
  const qp = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  const eps = opt('geomEpsTiny');
  if (segA && (t < -eps || t > 1 + eps)) return [];
  if (segB && (u < -eps || u > 1 + eps)) return [];
  return [[a[0] + t * r[0], a[1] + t * r[1]]];
}

export function lineCircle(a, b, c, r, { seg = true } = {}) {
  const d = [b[0] - a[0], b[1] - a[1]], f = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1], B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - r * r;
  const eps = opt('geomEpsTiny'), zero = opt('geomEpsZero');
  let disc = B * B - 4 * A * C;
  if (disc < -eps || A < opt('skGeomEpsQuad')) return [];
  disc = Math.sqrt(Math.max(0, disc));
  const out = [];
  for (const t of disc < zero ? [-B / (2 * A)] : [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) {
    if (seg && (t < -eps || t > 1 + eps)) continue;
    out.push([a[0] + t * d[0], a[1] + t * d[1]]);
  }
  return out;
}

export function circleCircle(c1, r1, c2, r2) {
  const d = dist(c1, c2), eps = opt('geomEpsTiny'), zero = opt('geomEpsZero');
  if (d < zero || d > r1 + r2 + eps || d < Math.abs(r1 - r2) - eps) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const px = c1[0] + (a * (c2[0] - c1[0])) / d, py = c1[1] + (a * (c2[1] - c1[1])) / d;
  if (h < zero) return [[px, py]];
  return [[px + (h * (c2[1] - c1[1])) / d, py - (h * (c2[0] - c1[0])) / d], [px - (h * (c2[1] - c1[1])) / d, py + (h * (c2[0] - c1[0])) / d]];
}

// Circle through three points.
export function circleFrom3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < opt('geomEpsZero')) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: dist([ux, uy], a) };
}

export const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
