// Geometry for plan (2D drafting + architecture) entities.
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, TAU } from '../sketch/geom2d.js';

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const rot = (p, c, ang) => { const s = Math.sin(ang), k = Math.cos(ang); const x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * k - y * s, c[1] + x * s + y * k]; };
export const mirrorPt = (p, a, b) => { const pr = projectOnSegment(p, a, b).ptLine; return [2 * pr[0] - p[0], 2 * pr[1] - p[1]]; };

export function wallFrame(w) {
  const L = dist(w.a, w.b) || 1e-9;
  const u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L];
  const n = [-u[1], u[0]];
  const t = w.t ?? 200;
  const off = w.justify === 'left' ? t / 2 : w.justify === 'right' ? -t / 2 : 0;
  return { L, u, n, t, o1: off - t / 2, o2: off + t / 2 };
}
// Outline polygons of a wall split around its openings.
export function wallPieces(w, openings) {
  const f = wallFrame(w);
  const cuts = openings.map((o) => [Math.max(0, o.pos - o.w / 2), Math.min(f.L, o.pos + o.w / 2)]).filter((c) => c[1] > c[0]).sort((a, b) => a[0] - b[0]);
  const spans = [];
  let s = -f.t / 2;
  for (const [c0, c1] of cuts) { if (c0 > s) spans.push([s, c0]); s = Math.max(s, c1); }
  if (f.L + f.t / 2 > s) spans.push([s, f.L + f.t / 2]);
  // ends are extended by t/2 so corners close; openings keep their exact edges
  return spans.map(([t0, t1]) => {
    const P = (t, o) => [w.a[0] + f.u[0] * t + f.n[0] * o, w.a[1] + f.u[1] * t + f.n[1] * o];
    return [P(t0, f.o1), P(t1, f.o1), P(t1, f.o2), P(t0, f.o2)];
  });
}
export function wallPolygon(w) {
  const f = wallFrame(w);
  const P = (t, o) => [w.a[0] + f.u[0] * t + f.n[0] * o, w.a[1] + f.u[1] * t + f.n[1] * o];
  return [P(-f.t / 2, f.o1), P(f.L + f.t / 2, f.o1), P(f.L + f.t / 2, f.o2), P(-f.t / 2, f.o2)];
}

// Door / window drawing primitives in plan coords.
export function openingPrims(o, w) {
  const f = wallFrame(w);
  const P = (t, off) => [w.a[0] + f.u[0] * t + f.n[0] * off, w.a[1] + f.u[1] * t + f.n[1] * off];
  const t0 = o.pos - o.w / 2, t1 = o.pos + o.w / 2;
  const prims = [];
  prims.push({ type: 'line', a: P(t0, f.o1), b: P(t0, f.o2) }, { type: 'line', a: P(t1, f.o1), b: P(t1, f.o2) });
  if (o.type === 'window') {
    const mid = (f.o1 + f.o2) / 2;
    prims.push({ type: 'line', a: P(t0, f.o1), b: P(t1, f.o1) }, { type: 'line', a: P(t0, f.o2), b: P(t1, f.o2) });
    prims.push({ type: 'line', a: P(t0, mid - 15), b: P(t1, mid - 15) }, { type: 'line', a: P(t0, mid + 15), b: P(t1, mid + 15) });
  } else {
    const side = o.side ?? 1; // which face the door swings to
    const hingeAtStart = (o.hinge ?? 1) > 0;
    const faceOff = side > 0 ? f.o2 : f.o1;
    const hinge = P(hingeAtStart ? t0 : t1, faceOff);
    const closed = P(hingeAtStart ? t1 : t0, faceOff);
    const nrm = mul(f.n, side > 0 ? 1 : -1);
    const open = add(hinge, mul(nrm, o.w));
    prims.push({ type: 'line', a: hinge, b: open, heavy: true });
    let a0 = Math.atan2(closed[1] - hinge[1], closed[0] - hinge[0]), a1 = Math.atan2(open[1] - hinge[1], open[0] - hinge[0]);
    let sw = normAng(a1 - a0);
    if (sw > Math.PI) [a0, a1] = [a1, a0];
    prims.push({ type: 'arc', c: hinge, r: o.w, a0, a1, thin: true });
  }
  return prims;
}

// Points for snapping.
export function snapPoints(e, walls) {
  const out = [];
  const end = (p) => out.push({ p, kind: 'end' });
  const mid = (p) => out.push({ p, kind: 'mid' });
  switch (e.type) {
    case 'line': end(e.a); end(e.b); mid(lerp(e.a, e.b, 0.5)); break;
    case 'polyline': {
      e.pts.forEach(end);
      const n = e.pts.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) mid(lerp(e.pts[i], e.pts[(i + 1) % n], 0.5));
      break;
    }
    case 'circle': out.push({ p: e.c, kind: 'cen' }); for (let k = 0; k < 4; k++) out.push({ p: [e.c[0] + e.r * Math.cos((k * Math.PI) / 2), e.c[1] + e.r * Math.sin((k * Math.PI) / 2)], kind: 'quad' }); break;
    case 'arc': {
      out.push({ p: e.c, kind: 'cen' });
      end([e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)]); end([e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)]);
      const am = e.a0 + normAng(e.a1 - e.a0) / 2; mid([e.c[0] + e.r * Math.cos(am), e.c[1] + e.r * Math.sin(am)]);
      break;
    }
    case 'wall': {
      end(e.a); end(e.b); mid(lerp(e.a, e.b, 0.5));
      wallPolygon(e).forEach(end);
      break;
    }
    case 'text': case 'point': out.push({ p: e.p, kind: 'node' }); break;
    case 'dim': end(e.a); end(e.b); break;
    case 'door': case 'window': {
      const w = walls.get(e.wall);
      if (w) { const f = wallFrame(w); end(add(w.a, mul(f.u, e.pos - e.w / 2))); end(add(w.a, mul(f.u, e.pos + e.w / 2))); mid(add(w.a, mul(f.u, e.pos))); }
      break;
    }
    default:
  }
  return out;
}

// Segments/curves of an entity used for intersections and hit testing.
export function curvesOf(e, walls) {
  switch (e.type) {
    case 'line': return [{ kind: 'line', a: e.a, b: e.b }];
    case 'polyline': {
      const n = e.pts.length, out = [];
      for (let i = 0; i < (e.closed ? n : n - 1); i++) out.push({ kind: 'line', a: e.pts[i], b: e.pts[(i + 1) % n] });
      return out;
    }
    case 'circle': return [{ kind: 'circle', c: e.c, r: e.r }];
    case 'arc': return [{ kind: 'arc', c: e.c, r: e.r, a0: e.a0, a1: e.a1 }];
    case 'wall': {
      const p = wallPolygon(e);
      return [{ kind: 'line', a: p[0], b: p[1] }, { kind: 'line', a: p[1], b: p[2] }, { kind: 'line', a: p[2], b: p[3] }, { kind: 'line', a: p[3], b: p[0] }];
    }
    case 'dim': return [{ kind: 'line', a: e.a, b: e.b }];
    case 'door': case 'window': {
      const w = walls?.get(e.wall);
      return w ? openingPrims(e, w).map((p) => (p.type === 'line' ? { kind: 'line', a: p.a, b: p.b } : { kind: 'arc', c: p.c, r: p.r, a0: p.a0, a1: p.a1 })) : [];
    }
    default: return [];
  }
}

export function distToCurve(p, c) {
  if (c.kind === 'line') return dist(p, projectOnSegment(p, c.a, c.b).pt);
  const d = Math.abs(dist(p, c.c) - c.r);
  if (c.kind === 'circle') return d;
  const ang = Math.atan2(p[1] - c.c[1], p[0] - c.c[0]);
  if (angleInArc(ang, c.a0, c.a1)) return d;
  return Math.min(dist(p, [c.c[0] + c.r * Math.cos(c.a0), c.c[1] + c.r * Math.sin(c.a0)]), dist(p, [c.c[0] + c.r * Math.cos(c.a1), c.c[1] + c.r * Math.sin(c.a1)]));
}

export function intersect(c1, c2) {
  let pts = [];
  if (c1.kind === 'line' && c2.kind === 'line') pts = lineLine(c1.a, c1.b, c2.a, c2.b);
  else if (c1.kind === 'line') pts = lineCircle(c1.a, c1.b, c2.c, c2.r);
  else if (c2.kind === 'line') pts = lineCircle(c2.a, c2.b, c1.c, c1.r);
  else pts = circleCircle(c1.c, c1.r, c2.c, c2.r);
  for (const c of [c1, c2]) if (c.kind === 'arc') pts = pts.filter((q) => angleInArc(Math.atan2(q[1] - c.c[1], q[0] - c.c[0]), c.a0, c.a1));
  return pts;
}

export function nearestOnCurve(p, c) {
  if (c.kind === 'line') return projectOnSegment(p, c.a, c.b).pt;
  const d = dist(p, c.c) || 1;
  const q = [c.c[0] + ((p[0] - c.c[0]) * c.r) / d, c.c[1] + ((p[1] - c.c[1]) * c.r) / d];
  return q;
}

export function bboxOf(e, walls) {
  const pts = [];
  const cs = curvesOf(e, walls);
  for (const c of cs) {
    if (c.kind === 'line') pts.push(c.a, c.b);
    else pts.push([c.c[0] - c.r, c.c[1] - c.r], [c.c[0] + c.r, c.c[1] + c.r]);
  }
  if (e.type === 'text') { pts.push(e.p, [e.p[0] + (e.text?.length || 1) * e.h * 0.6, e.p[1] + e.h]); }
  if (e.type === 'point') pts.push(e.p);
  if (e.type === 'dim') { const g = dimGeom(e); pts.push(g.d1, g.d2); }
  if (!pts.length) return null;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

// Dimension geometry: extension lines + dimension line + text position.
export function dimGeom(d) {
  let dir;
  if (d.kind === 'h') dir = [1, 0];
  else if (d.kind === 'v') dir = [0, 1];
  else { const L = dist(d.a, d.b) || 1; dir = [(d.b[0] - d.a[0]) / L, (d.b[1] - d.a[1]) / L]; }
  const n = [-dir[1], dir[0]];
  const offOf = (p) => (d.p[0] - p[0]) * n[0] + (d.p[1] - p[1]) * n[1];
  const d1 = add(d.a, mul(n, offOf(d.a))), d2 = add(d.b, mul(n, offOf(d.b)));
  const value = Math.abs((d2[0] - d1[0]) * dir[0] + (d2[1] - d1[1]) * dir[1]);
  return { dir, n, d1, d2, value, mid: lerp(d1, d2, 0.5) };
}

// Transform helpers for MOVE/ROTATE/SCALE/MIRROR.
export function transformEntity(e, fn, { angle = 0, scale = 1, mirror = false } = {}) {
  const c = structuredClone(e);
  switch (c.type) {
    case 'line': case 'dim': case 'wall': c.a = fn(c.a); c.b = fn(c.b); if (c.p) c.p = fn(c.p); if (c.type === 'wall' && mirror && c.justify && c.justify !== 'center') c.justify = c.justify === 'left' ? 'right' : 'left'; break;
    case 'polyline': c.pts = c.pts.map(fn); break;
    case 'circle': c.c = fn(c.c); c.r *= scale; break;
    case 'arc': {
      const s = fn([c.c[0] + c.r * Math.cos(c.a0), c.c[1] + c.r * Math.sin(c.a0)]), t = fn([c.c[0] + c.r * Math.cos(c.a1), c.c[1] + c.r * Math.sin(c.a1)]);
      c.c = fn(c.c); c.r *= scale;
      c.a0 = Math.atan2(s[1] - c.c[1], s[0] - c.c[0]); c.a1 = Math.atan2(t[1] - c.c[1], t[0] - c.c[0]);
      if (mirror) [c.a0, c.a1] = [c.a1, c.a0];
      break;
    }
    case 'text': case 'point': c.p = fn(c.p); if (c.type === 'text') { c.rot = (c.rot || 0) + angle; c.h *= scale; } break;
    case 'door': if (mirror) c.side = -(c.side ?? 1); break;
    default:
  }
  return c;
}

export { dist, projectOnSegment, normAng, TAU };
