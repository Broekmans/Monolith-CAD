// Assembly mate solver: rigid components (position + unit quaternion) are
// moved by a damped least-squares (Levenberg-Marquardt) solve so that all
// mates are satisfied. Pure JS, runs in the renderer and in node tests.
//
// Mate entity geometry (component-local): {t:'plane', p, n} | {t:'axis', p, d, r?} | {t:'circle', p, d, r}
// 0.1.123: a mate is left out when suppressed, or while it is suppressed for editing (m._free: runtime only, not saved)
export const mateOff = (m) => !!(m.suppressed || m._free);
// 0.1.127: the assembly itself as a fixed "component" at the world origin, so mates can use the assembly's Front / Top /
// Right Plane (ref {comp: GROUND_ID, kind: 'plane', id: 'Front', geo: {t:'plane', p:[0,0,0], n}}). compMap() puts it in
// every component lookup; it is never moved (fixed) and never listed as a component.
export const GROUND_ID = '@asm';
export const GROUND = Object.freeze({ id: GROUND_ID, name: 'Assembly', pos: Object.freeze([0, 0, 0]), rot: Object.freeze([0, 0, 0, 1]), fixed: true });
export const compMap = (comps) => new Map([[GROUND_ID, GROUND], ...comps.map((c) => [c.id, c])]);
const compOf = (byId, id) => byId.get(id) ?? (id === GROUND_ID ? GROUND : undefined);
// origin planes (part and assembly; same frames as the part's STD_PLANES)
export const ORIGIN_PLANES = { Front: [0, 0, 1], Top: [0, 1, 0], Right: [1, 0, 0] };
export const planeRef = (comp, id) => ({ comp, kind: 'plane', id, c: [0, 0, 0], geo: { t: 'plane', p: [0, 0, 0], n: [...ORIGIN_PLANES[id]] } });
export const MATE_TYPES = [
  { id: 'coincident', label: 'Coincident', icon: 'coincident' },
  { id: 'concentric', label: 'Concentric', icon: 'concentric' },
  { id: 'distance', label: 'Distance', icon: 'dimension', value: 'mm' },
  { id: 'angle', label: 'Angle', icon: 'rotate', value: '°' },
  { id: 'parallel', label: 'Parallel', icon: 'parallel' },
  { id: 'perpendicular', label: 'Perpendicular', icon: 'perpendicular' },
  { id: 'tangent', label: 'Tangent', icon: 'tangent' },
  { id: 'lock', label: 'Lock', icon: 'lock' },
  { id: 'width', label: 'Width', icon: 'parallel' },
];
const L = 100; // weight of angular residuals (mm per radian)

// ---------- vector / quaternion helpers ----------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mulv = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export function qnorm(q) { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); }
export function qexp(w) { // rotation vector -> quaternion
  const a = len(w);
  if (a < 1e-12) return qnorm([w[0] / 2, w[1] / 2, w[2] / 2, 1]);
  const s = Math.sin(a / 2) / a;
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
}
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
}
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const xfPoint = (c, p) => add(qrot(c.rot, p), c.pos);
export const invPoint = (c, p) => qrot(qinv(c.rot), sub(p, c.pos));
// column-major 4x4 (three.js / kernel)
export function poseMatrix(c) {
  const [x, y, z, w] = c.rot;
  const m = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    c.pos[0], c.pos[1], c.pos[2], 1];
  return m;
}

// entity geometry in world coordinates
export function worldGeo(c, g) {
  const o = { t: g.t, p: xfPoint(c, g.p) };
  if (g.n) o.n = qrot(c.rot, g.n);
  if (g.d) o.d = qrot(c.rot, g.d);
  if (g.r !== undefined) o.r = g.r;
  return o;
}
const dirOf = (g) => g.n || g.d;
const isAx = (g) => g.t === 'axis' || g.t === 'circle';

// sense (+1 aligned / -1 anti-aligned) and side of the current configuration
export function currentSense(A, B) { const d = dot(dirOf(A), dirOf(B)); return d > 1e-6 ? 1 : -1; }
export function currentSide(A, B) {
  if (A.t === 'plane') return dot(sub(B.p, A.p), A.n) >= -1e-6 ? 1 : -1;
  if (B.t === 'plane') return dot(sub(A.p, B.p), B.n) >= -1e-6 ? 1 : -1;
  return 1;
}

// which mate types make sense for two entities
export function validTypes(A, B) {
  if (!A || !B) return MATE_TYPES.map((t) => t.id);
  const P = (g) => g.t === 'plane';
  const out = ['coincident', 'parallel', 'perpendicular', 'angle', 'lock'];
  if (isAx(A) && isAx(B)) out.push('concentric', 'distance');
  if (P(A) && P(B)) out.push('distance');
  if ((P(A) && isAx(B)) || (P(B) && isAx(A))) out.push('distance', 'tangent');
  if (A.t === 'axis' && B.t === 'axis' && A.r && B.r) out.push('tangent');
  if (A.t === 'circle' && B.t === 'circle') out.splice(out.indexOf('angle'), 1);
  return MATE_TYPES.map((t) => t.id).filter((t) => out.includes(t));
}
// width mate check: 4 face refs {comp, geo} -> {a, a2, b, b2} or {err}
export function widthGroups(refs) {
  if (refs.some((r) => r.geo?.t !== 'plane')) return { err: 'Width mate needs 4 planar faces' };
  const comps = [...new Set(refs.map((r) => r.comp))];
  if (comps.length !== 2) return { err: 'Select 2 faces on one component and 2 faces on another' };
  const A = refs.filter((r) => r.comp === comps[0]), B = refs.filter((r) => r.comp === comps[1]);
  if (A.length !== 2) return { err: 'Select 2 faces on each component' };
  const par = (x, y) => Math.abs(dot(x.geo.n, y.geo.n)) > 1 - 1e-6;
  if (!par(A[0], A[1]) || !par(B[0], B[1])) return { err: 'The 2 faces of each component must be parallel' };
  return { a: A[0], a2: A[1], b: B[0], b2: B[1] };
}
export function defaultType(A, B) { return isAx(A) && isAx(B) ? 'concentric' : 'coincident'; }

// residual vector of one mate given world entities
// Value term of a Distance / Angle mate (0.1.119): driven (m._drive, Drive / Motion Study, runtime only) → equal to
// that; Limits (m.limits {min, max}) → free between min and max, distance to the nearest limit outside; else = value.
// cur and the result are in mm (distance) or radians (angle; `wrap` for angles).
function valueTerm(m, cur, toU, wrap = false) {
  if (m._drive != null) return wrap ? wrapPi(cur - toU(m._drive)) : cur - toU(m._drive);
  if (m.limits) {
    const lo = toU(Math.min(m.limits.min, m.limits.max)), hi = toU(Math.max(m.limits.min, m.limits.max));
    if (wrap) { const mid = (lo + hi) / 2, half = (hi - lo) / 2, d = wrapPi(cur - mid); return Math.abs(d) <= half ? 0 : d - Math.sign(d) * half; }
    return cur < lo ? cur - lo : cur > hi ? cur - hi : 0;
  }
  return wrap ? wrapPi(cur - toU(m.value || 0)) : cur - toU(m.value || 0);
}
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const deg = (v) => (v * Math.PI) / 180, mm = (v) => v;
// signed angle (radians) of an Angle mate with a stored turning axis (m.axis, in A's local frame, 0.1.119)
function signedAngle(m, A0, B0, cA, s) {
  const dA = dirOf(A0), dB = mulv(dirOf(B0), s), ax = qrot(cA.rot, m.axis);
  return Math.atan2(dot(cross(dA, dB), ax), dot(dA, dB));
}

// 0.1.134: m._flip (runtime, Motion Study "Flip" for this mate): an Angle mate reads 180° further (B's direction
// reversed), a Distance mate is measured to the other side — without changing the mate in the tree
const senseOf = (m) => (m.sense ?? -1) * (m._flip && m.type === 'angle' ? -1 : 1);
const sideOf = (m) => (m.side ?? 1) * (m._flip && m.type === 'distance' ? -1 : 1);
function mateResidual(m, A, B, cA, cB, out) {
  const s = senseOf(m);
  const A0 = A, B0 = B;
  const align = (a, b) => { out.push((a[0] - s * b[0]) * L, (a[1] - s * b[1]) * L, (a[2] - s * b[2]) * L); };
  const side = sideOf(m);
  if (m.type === 'width') {
    // mid-plane of B's two faces = mid-plane of A's two faces, normals parallel
    const A2 = worldGeo(cA, m.a2.geo), B2 = worldGeo(cB, m.b2.geo);
    const n = A.n, nb = B.n;
    const midA = dot(mulv(add(A.p, A2.p), 0.5), n), midB = dot(mulv(add(B.p, B2.p), 0.5), n);
    const c = cross(n, nb);
    out.push(c[0] * L, c[1] * L, c[2] * L, midB - midA);
    return;
  }
  // keep plane first
  if (B.t === 'plane' && A.t !== 'plane') [A, B] = [B, A];
  const P = (g) => g.t === 'plane';
  switch (m.type) {
    case 'coincident':
      if (P(A) && P(B)) { align(A.n, B.n); out.push(dot(sub(B.p, A.p), A.n)); return; }
      if (P(A) && B.t === 'axis') { out.push(dot(B.d, A.n) * L, dot(sub(B.p, A.p), A.n)); return; }
      if (P(A) && B.t === 'circle') { align(A.n, B.d); out.push(dot(sub(B.p, A.p), A.n)); return; }
      if (A.t === 'circle' && B.t === 'circle') { align(A.d, B.d); out.push(...sub(B.p, A.p)); return; }
      if (isAx(A) && isAx(B)) { align(A.d, B.d); out.push(...cross(sub(B.p, A.p), A.d)); return; }
      break;
    case 'concentric':
      if (isAx(A) && isAx(B)) {
        align(A.d, B.d); out.push(...cross(sub(B.p, A.p), A.d));
        // Lock rotation (0.1.118): B keeps its turn about the axis relative to A (m.lockQ = relative rotation when locked)
        if (m.lockRot && m.lockQ && cA && cB) {
          const d = m.b.geo.d || [0, 0, 1], t = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
          const u = unit(cross(d, t)); // a direction across B's axis (B local)
          const have = qrot(cB.rot, u), want = qrot(cA.rot, qrot(m.lockQ, u));
          out.push(...mulv(sub(have, want), L));
        }
        return;
      }
      break;
    case 'distance': {
      const plain = m._drive == null && !m.limits; // unchanged residual for a plain distance mate
      const v = m.value || 0;
      if (P(A) && P(B)) { align(A.n, B.n); const d = dot(sub(B.p, A.p), A.n); out.push(plain ? d - side * v : valueTerm(m, side * d, mm)); return; }
      if (P(A) && isAx(B)) { if (B.t === 'circle') align(A.n, B.d); else out.push(dot(B.d, A.n) * L); const d = dot(sub(B.p, A.p), A.n); out.push(plain ? d - side * v : valueTerm(m, side * d, mm)); return; }
      if (isAx(A) && isAx(B)) { align(A.d, B.d); const d = len(cross(sub(B.p, A.p), A.d)); out.push(plain ? d - v : valueTerm(m, d, mm)); return; }
      break;
    }
    case 'parallel':
      if ((P(A) && P(B)) || (isAx(A) && isAx(B))) { align(dirOf(A), dirOf(B)); return; }
      out.push(dot(dirOf(A), dirOf(B)) * L); return;
    case 'perpendicular':
      if ((P(A) && P(B)) || (isAx(A) && isAx(B))) { out.push(dot(dirOf(A), dirOf(B)) * L); return; }
      align(dirOf(A), dirOf(B)); return;
    case 'angle': {
      const a = ((m.value || 0) * Math.PI) / 180;
      const dA = dirOf(A), dB = mulv(dirOf(B), s);
      if (!m.axis && m._drive == null && !m.limits) {
        // angle about the common axis: cos and sin parts keep it well conditioned
        out.push((dot(dA, dB) - Math.cos(a)) * L, (len(cross(dA, dB)) - Math.sin(a)) * L);
        return;
      }
      // signed angle about the stored axis (0.1.119), or the unsigned one for old angle mates
      const phi = m.axis && cA ? signedAngle(m, A0, B0, cA, s) : Math.atan2(len(cross(dA, dB)), dot(dA, dB));
      if (m._drive == null && !m.limits) { out.push((Math.cos(phi) - Math.cos(a)) * L, (Math.sin(phi) - Math.sin(a)) * L); return; }
      out.push(valueTerm(m, phi, deg, true) * L, 0); // keep 2 rows like the plain form
      return;
    }
    case 'tangent':
      if (P(A) && B.t === 'axis' && B.r) { out.push(dot(B.d, A.n) * L, dot(sub(B.p, A.p), A.n) - side * B.r); return; }
      if (A.t === 'axis' && B.t === 'axis' && A.r && B.r) { align(A.d, B.d); out.push(len(cross(sub(B.p, A.p), A.d)) - (A.r + B.r)); return; }
      break;
    case 'lock': {
      // B's pose relative to A stays as stored in m.rel {pos, rot}
      const rel = m.rel;
      if (!rel || !cA || !cB) return;
      for (const q of [[0, 0, 0], [50, 0, 0], [0, 50, 0], [0, 0, 50]]) {
        const want = xfPoint(cA, xfPoint(rel, q)), have = xfPoint(cB, q);
        out.push(...sub(have, want));
      }
      return;
    }
    default:
  }
  throw new Error('Unsupported entities for ' + m.type);
}

export function relPose(cA, cB) {
  const ri = qinv(cA.rot);
  return { pos: qrot(ri, sub(cB.pos, cA.pos)), rot: qnorm(qmul(ri, cB.rot)) };
}

// current value of a Distance (mm) / Angle (°) mate as it stands now (for the Drive slider, Motion Study, labels)
export function mateValue(m, byId) {
  const cA = compOf(byId, m.a.comp), cB = compOf(byId, m.b.comp);
  if (!cA || !cB) return null;
  let A = worldGeo(cA, m.a.geo), B = worldGeo(cB, m.b.geo);
  const s = senseOf(m), side = sideOf(m);
  if (m.type === 'angle') {
    const dA = dirOf(A), dB = mulv(dirOf(B), s);
    const phi = m.axis ? signedAngle(m, A, B, cA, s) : Math.atan2(len(cross(dA, dB)), dot(dA, dB));
    return (phi * 180) / Math.PI;
  }
  if (m.type !== 'distance') return null;
  if (B.t === 'plane' && A.t !== 'plane') [A, B] = [B, A];
  if (A.t === 'plane') return side * dot(sub(B.p, A.p), A.n);
  return len(cross(sub(B.p, A.p), A.d));
}
// turning axis for a new Angle mate (A-local): the axis of a concentric mate between the same two components, else
// the common axis of the two directions now (or any axis across A's direction when they are parallel)
export function angleAxisFor(m, comps, mates) {
  const byId = compMap(comps);
  const cA = byId.get(m.a.comp), cB = byId.get(m.b.comp);
  const A = worldGeo(cA, m.a.geo), B = worldGeo(cB, m.b.geo);
  let ax = null;
  for (const k of mates) {
    if (k.type !== 'concentric' || mateOff(k)) continue;
    const ids = [k.a.comp, k.b.comp];
    if (!(ids.includes(m.a.comp) && ids.includes(m.b.comp))) continue;
    const r = k.a.comp === m.a.comp ? k.a : k.b;
    ax = qrot(cA.rot, r.geo.d); break;
  }
  if (!ax) { const c = cross(dirOf(A), dirOf(B)); ax = len(c) > 1e-6 ? c : cross(dirOf(A), Math.abs(dirOf(A)[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); }
  return unit(qrot(qinv(cA.rot), unit(ax)));
}

// relative rotation of B to A, stored on a concentric mate when its rotation is locked
export const lockQOf = (cA, cB) => relPose(cA, cB).rot;

export function mateError(m, byId) {
  const cA = compOf(byId, m.a.comp), cB = compOf(byId, m.b.comp);
  if (!cA || !cB) return Infinity;
  const r = [];
  try { mateResidual(m, worldGeo(cA, m.a.geo), worldGeo(cB, m.b.geo), cA, cB, r); } catch { return Infinity; }
  return Math.sqrt(r.reduce((s, v) => s + v * v, 0));
}

// Solve. comps: [{id, pos, rot, fixed}] (mutated). drag: {comp, pts:[{local, target}], w}
export function solveMates(comps, mates, { drag = null, iters = 80, tol = 1e-10 } = {}) {
  const byId = compMap(comps);
  const active = mates.filter((m) => !mateOff(m) && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
  const varIds = new Set();
  for (const m of active) for (const id of [m.a.comp, m.b.comp]) if (!byId.get(id).fixed) varIds.add(id);
  if (drag && !byId.get(drag.comp)?.fixed) varIds.add(drag.comp);
  const vars = [...varIds].map((id) => byId.get(id));
  const n = vars.length * 6;
  const base = vars.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
  const bad = new Set();
  const residual = (x, out = []) => {
    vars.forEach((c, i) => {
      const k = i * 6;
      c.pos = add(base[i].pos, [x[k], x[k + 1], x[k + 2]]);
      c.rot = qnorm(qmul(qexp([x[k + 3], x[k + 4], x[k + 5]]), base[i].rot));
    });
    for (const m of active) {
      if (bad.has(m)) continue;
      const cA = byId.get(m.a.comp), cB = byId.get(m.b.comp);
      try { mateResidual(m, worldGeo(cA, m.a.geo), worldGeo(cB, m.b.geo), cA, cB, out); } catch { bad.add(m); }
    }
    if (drag) {
      const c = byId.get(drag.comp), w = drag.w ?? 0.03;
      for (const p of drag.pts) { const d = sub(xfPoint(c, p.local), p.target); out.push(d[0] * w, d[1] * w, d[2] * w); }
    }
    return out;
  };
  if (!n) return { ok: true, vars: 0, bad };
  residual(new Array(n).fill(0)); // detect unsupported mates once
  let x = new Array(n).fill(0);
  let r = residual(x);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iters && cost > tol; it++) {
    const m = r.length;
    const J = Array.from({ length: n }, () => new Float64Array(m));
    const h = 1e-7;
    for (let j = 0; j < n; j++) {
      const xj = [...x]; xj[j] += h;
      const rj = residual(xj);
      for (let i = 0; i < m; i++) J[j][i] = (rj[i] - r[i]) / h;
    }
    residual(x);
    // normal equations
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const g = new Float64Array(n);
    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) { let s = 0; const Ja = J[a], Jb = J[b]; for (let i = 0; i < m; i++) s += Ja[i] * Jb[i]; A[a][b] = A[b][a] = s; }
      let s = 0; for (let i = 0; i < m; i++) s += J[a][i] * r[i]; g[a] = s;
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.map((row, i) => { const q = Float64Array.from(row); q[i] += lambda * (1 + row[i]) + 1e-9; return q; });
      const dx = solveSPD(M, Array.from(g, (v) => -v));
      if (!dx) { lambda *= 10; continue; }
      const xn = x.map((v, i) => v + dx[i]);
      const rn = residual(xn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) { x = xn; r = rn; cost = cn; lambda = Math.max(lambda / 4, 1e-9); improved = true; break; }
      lambda *= 6;
    }
    if (!improved) break;
    // re-base to keep rotation increments small
    residual(x);
    vars.forEach((c, i) => { base[i] = { pos: [...c.pos], rot: [...c.rot] }; });
    x = new Array(n).fill(0);
  }
  residual(x);
  return { ok: !bad.size, cost, vars: vars.length, bad };
}

// One mouse step of a drag (0.1.117). Pulls the dragged component towards the targets, then
// corrects the mates without the pull, so the mates are never stretched. A step is refused when
// - the mates cannot be held (error > tol mm): the end of travel, or
// - another part moves more than `ratio` × the dragged part (+ `minMove` mm): a dead point
//   (toggle) or a jump to the other branch of the mechanism.
// A refused step is retried in halves (`split` times), so the parts get as close to the limit as
// they can and stop there; they keep the last good pose and stay on their branch.
// drag: {comp, pts:[{local, target}], prev:[target per pt of the last good step], held (set here)}
// size: Map id -> radius (mm) of each component, for the rotation part of a move. maxStep: longest piece (mm) a
// mouse move is walked in (at most maxPieces pieces).
// On the way back the parts retrace the poses they had during this drag (drag.hist), so a
// dead point never sends the mechanism to its other branch.
// Returns {status:'ok'|'limit'|'jump', part (0..1 of the step reached), err, solves, held:[ids], retrace}.
export function dragStep(comps, mates, drag, { w = 0.05, iters = 12, fixIters = 20, tol = 0.01, ratio = 10, minMove = 0.5, split = 2, maxStep = null, maxPieces = 24, size = null } = {}) {
  const byId = compMap(comps);
  const active = mates.filter((m) => !mateOff(m) && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
  const save = () => comps.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
  const restore = (s) => comps.forEach((c, i) => { c.pos = [...s[i].pos]; c.rot = [...s[i].rot]; });
  const maxErr = () => { let e = 0; for (const m of active) { const v = mateError(m, byId); if (Number.isFinite(v) && v > e) e = v; } return e; };
  const moveOf = (c, s) => { // largest point displacement of a component: origin + rotation × radius
    const dq = qmul(c.rot, qinv(s.rot));
    return len(sub(c.pos, s.pos)) + 2 * Math.acos(Math.min(1, Math.abs(dq[3]))) * (size?.get(c.id) ?? 100);
  };
  const lerp = (A, B, f) => A.map((p, i) => ({ local: p.local, target: add(mulv(p.target, 1 - f), mulv(B[i].target, f)) }));
  let solves = 0, err = 0, why = null;
  const held = new Set();
  const tryTo = (pts) => { // one solve; true = accepted (poses changed), false = refused (poses kept)
    const before = save();
    solveMates(comps, active, { drag: { comp: drag.comp, pts, w }, iters });
    solves++;
    let e = maxErr();
    if (e > tol * 0.01) { solveMates(comps, active, { iters: fixIters, tol: (tol * 1e-3) ** 2 }); e = maxErr(); } // pull the mates closed again
    if (!(e <= tol)) { restore(before); why = 'limit'; return false; }
    const di = comps.findIndex((c) => c.id === drag.comp);
    const lim = ratio * (moveOf(comps[di], before[di]) + minMove);
    let bad = null;
    comps.forEach((c, i) => { if (i !== di && !c.fixed && moveOf(c, before[i]) > lim) bad = c.id; });
    if (bad) { restore(before); held.add(bad); why ??= 'jump'; return false; }
    err = Math.max(err, e);
    return true;
  };
  // walk from `from` (reached) to `to`; returns the fraction reached
  const walk = (from, to, depth) => {
    if (tryTo(to)) return 1;
    if (depth >= split) return 0;
    const mid = lerp(from, to, 0.5);
    const a = walk(from, mid, depth + 1);
    if (a < 1) return a * 0.5;
    return 0.5 + 0.5 * walk(mid, to, depth + 1);
  };
  const from = drag.pts.map((p, i) => ({ local: p.local, target: drag.prev?.[i] ?? xfPoint(byId.get(drag.comp), p.local) }));
  // a fast mouse move is walked in pieces of at most maxStep mm (a big jump could land on the other branch)
  const go = (start) => {
    let dist = 0; drag.pts.forEach((p, i) => { dist = Math.max(dist, len(sub(p.target, start[i].target))); });
    const pieces = Math.min(maxPieces, Math.max(1, Math.ceil(dist / Math.max(1e-6, maxStep ?? Infinity))));
    let done = 0;
    for (let k = 0; k < pieces; k++) {
      const f = walk(lerp(start, drag.pts, k / pieces), lerp(start, drag.pts, (k + 1) / pieces), drag.held && !k ? split : 0); // already held: one try only (keeps the mouse smooth at the limit)
      done = (k + f) / pieces;
      if (f < 1) break;
    }
    return done;
  };
  let part = go(from), base = from;
  // Same branch on the way back: compare with the nearest pose of the dragged part seen during
  // this drag; when the other parts are somewhere else entirely, go back to that pose (retrace)
  // and walk from there.
  const hist = drag.hist ??= [];
  const di = comps.findIndex((c) => c.id === drag.comp);
  let retrace = false;
  if (part > 0 && hist.length) {
    let best = null, bd = Infinity;
    for (const h of hist) { const d = moveOf(comps[di], h[di]); if (d < bd) { bd = d; best = h; } }
    let other = 0, who = null;
    comps.forEach((c, i) => { if (i !== di && !c.fixed) { const d = moveOf(c, best[i]); if (d > other) { other = d; who = c.id; } } });
    if (other > ratio * (bd + minMove)) {
      restore(best); retrace = true; held.add(who);
      base = drag.pts.map((p) => ({ local: p.local, target: xfPoint(comps[di], p.local) }));
      drag.held = false;
      part = go(base);
      if (!part) why = 'jump';
    }
  }
  drag.held = part === 0;
  if (part > 0) drag.prev = lerp(base, drag.pts, part).map((p) => p.target);
  else if (retrace) drag.prev = base.map((p) => p.target);
  if (part > 0 || retrace) { hist.push(save()); if (hist.length > 4000) drag.hist = hist.filter((_, i) => i % 2); }
  return { status: part >= 1 ? 'ok' : why || 'limit', part, err: part > 0 ? err : maxErr(), solves, held: [...held], retrace };
}

// One step of Drive / Motion Study (0.1.119): move Distance / Angle mates to new values (drive.targets
// [{id, value}]) with the same protection as dragging: the value change is walked in pieces (maxStepMm / maxStepDeg),
// a piece is refused when the mates cannot be held (> tol mm) or a part that is not driven moves more than
// ratio × the driven parts (dead point / other branch; refused pieces are halved `split` times), and a pose seen before
// at (nearly) the same values is retraced. drive.hist / drive.held are kept between calls (one drive session).
// While driving, m._drive holds the value (runtime only, not saved). Returns {status, part, err, solves, held, values}.
// 0.1.135 (Play / Save Animation): budgetMs > 0 = stop after the piece that used up this many ms (now() = clock) and
// return budget: true with part < 1 — the caller goes on from there next frame; warm = start every piece from the
// pose predicted by the last accepted piece's motion (drive.vel, kept between calls) scaled to this piece's value change
// (|scale| ≤ warmMax); a predicted try that is refused is tried once more from the plain pose before halving.
export function driveStep(comps, mates, drive, { iters = 20, tol = 0.001, ratio = 10, minMove = 0.5, split = 2, maxStepMm = 10, maxStepDeg = 3, maxPieces = 60, size = null, budgetMs = 0, now = null, warm = false, warmMax = 4 } = {}) {
  const timed = budgetMs > 0 && !!now, tStart = timed ? now() : 0;
  const byId = compMap(comps);
  const active = mates.filter((m) => !mateOff(m) && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
  const save = () => comps.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
  const restore = (st) => comps.forEach((c, i) => { c.pos = [...st[i].pos]; c.rot = [...st[i].rot]; });
  const maxErr = () => { let e = 0; for (const m of active) { const v = mateError(m, byId); if (Number.isFinite(v) && v > e) e = v; } return e; };
  const moveOf = (c, st) => { const dq = qmul(c.rot, qinv(st.rot)); return len(sub(c.pos, st.pos)) + 2 * Math.acos(Math.min(1, Math.abs(dq[3]))) * (size?.get(c.id) ?? 100); };
  const T = drive.targets.map((t) => ({ m: active.find((m) => m.id === t.id), to: t.value })).filter((t) => t.m && (t.m.type === 'distance' || t.m.type === 'angle'));
  if (!T.length) return { status: 'ok', part: 1, err: maxErr(), solves: 0, held: [], values: [] };
  for (const t of T) t.from = t.m._drive ?? mateValue(t.m, byId) ?? t.to;
  const driven = new Set(); for (const t of T) for (const id of [t.m.a.comp, t.m.b.comp]) if (!byId.get(id).fixed) driven.add(id);
  const idx = comps.map((c, i) => [c, i]);
  const stepOf = (t) => (t.m.type === 'angle' ? maxStepDeg : maxStepMm);
  const setVals = (vals) => T.forEach((t, i) => { t.m._drive = vals[i]; });
  const lerpV = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);
  let solves = 0, err = 0, why = null, warmUsed = 0;
  const held = new Set();
  const idsKey = T.map((t) => t.m.id).join();
  const du = (a, b) => T.map((t, i) => (b[i] - a[i]) / stepOf(t)); // value change in piece units
  // warm start: move the free parts along the last accepted piece's motion, scaled to this piece (false = no prediction)
  const predict = (a, b) => {
    const v = drive.vel;
    if (!warm || !v || v.ids !== idsKey) return false;
    const d = du(a, b), vv = v.dv.reduce((s, x) => s + x * x, 0);
    if (!(vv > 1e-12)) return false;
    const f = d.reduce((s, x, i) => s + x * v.dv[i], 0) / vv;
    if (!Number.isFinite(f) || Math.abs(f) > warmMax || Math.abs(f) < 1e-9) return false;
    comps.forEach((c, i) => { const p = v.dp[i]; if (!p || c.fixed) return; c.pos = add(c.pos, mulv(p.dp, f)); c.rot = qnorm(qmul(qexp(mulv(p.dw, f)), c.rot)); });
    return true;
  };
  const rotVec = (q) => { // quaternion -> rotation vector (shortest way)
    const w = q[3] < 0 ? q.map((x) => -x) : q, sn = Math.hypot(w[0], w[1], w[2]);
    if (sn < 1e-12) return [w[0] * 2, w[1] * 2, w[2] * 2];
    const ang = 2 * Math.atan2(sn, w[3]);
    return [(w[0] / sn) * ang, (w[1] / sn) * ang, (w[2] / sn) * ang];
  };
  const tryTo = (vals, from, guess = true) => {
    const before = save(), prevVals = T.map((t) => t.m._drive);
    setVals(vals);
    const warmed = guess && from ? predict(from, vals) : false;
    solveMates(comps, active, { iters, tol: (tol * 1e-3) ** 2 });
    solves++;
    const e = maxErr();
    let refuse = !(e <= tol) ? 'limit' : null;
    const heldNow = [];
    if (!refuse) {
      let dmax = 0; for (const [c, i] of idx) if (driven.has(c.id)) dmax = Math.max(dmax, moveOf(c, before[i]));
      for (const [c, i] of idx) if (!driven.has(c.id) && !c.fixed && moveOf(c, before[i]) > ratio * (dmax + minMove)) { refuse = 'jump'; heldNow.push(c.id); }
    }
    if (refuse) {
      restore(before); setVals(prevVals);
      if (warmed) return tryTo(vals, from, false); // the prediction may have been the problem: once more from the plain pose
      heldNow.forEach((id) => held.add(id)); why ??= refuse; return false;
    }
    if (warmed) warmUsed++;
    err = Math.max(err, e);
    if (from) drive.vel = { ids: idsKey, dv: du(from, vals), dp: comps.map((c, i) => (c.fixed ? null : { dp: sub(c.pos, before[i].pos), dw: rotVec(qmul(c.rot, qinv(before[i].rot))) })) };
    return true;
  };
  const walk = (a, b, depth) => {
    if (tryTo(b, a)) return 1;
    if (depth >= split) return 0;
    const mid = lerpV(a, b, 0.5), f = walk(a, mid, depth + 1);
    if (f < 1) return f * 0.5;
    return 0.5 + 0.5 * walk(mid, b, depth + 1);
  };
  const go = (start) => {
    const to = T.map((t) => t.to);
    const n = Math.min(maxPieces, Math.max(1, Math.ceil(Math.max(...T.map((t, i) => Math.abs(to[i] - start[i]) / stepOf(t))))));
    let done = 0;
    for (let k = 0; k < n; k++) {
      const f = walk(lerpV(start, to, k / n), lerpV(start, to, (k + 1) / n), drive.held && !k ? split : 0);
      done = (k + f) / n;
      if (f < 1) break;
      if (timed && k + 1 < n && now() - tStart >= budgetMs) { cut = true; break; } // time used up: the rest next frame
    }
    return done;
  };
  let cut = false;
  let part = go(T.map((t) => t.from));
  // retrace: the nearest earlier pose at (nearly) these values; the other parts elsewhere entirely → go back to it
  const hist = drive.hist ??= [];
  const cur = T.map((t) => t.m._drive);
  let retrace = false;
  if (part > 0 && hist.length) {
    let best = null, bd = Infinity;
    for (const hh of hist) { if (hh.ids !== T.map((t) => t.m.id).join()) continue; const d = Math.max(...cur.map((v, i) => Math.abs(v - hh.vals[i]) / stepOf(T[i]))); if (d < bd) { bd = d; best = hh; } }
    if (best && bd < 1) {
      let dmax = 0, other = 0, who = null;
      for (const [c, i] of idx) { const d = moveOf(c, best.poses[i]); if (driven.has(c.id)) dmax = Math.max(dmax, d); else if (!c.fixed && d > other) { other = d; who = c.id; } }
      if (other > ratio * (dmax + minMove)) {
        restore(best.poses); setVals(best.vals); retrace = true; held.add(who); drive.vel = null;
        drive.held = false;
        part = go(best.vals);
      }
    }
  }
  drive.held = part === 0;
  if (part > 0 || retrace) { hist.push({ ids: T.map((t) => t.m.id).join(), vals: T.map((t) => t.m._drive), poses: save() }); if (hist.length > 4000) drive.hist = hist.filter((_, i) => i % 2); }
  const budget = cut && part > 0 && part < 1;
  return { status: part >= 1 || budget ? 'ok' : why || 'limit', part, err: part > 0 ? err : maxErr(), solves, held: [...held], retrace, budget, warm: warmUsed, values: T.map((t) => t.m._drive) };
}
// end of a drive session: the driven values become the mates' values; m._drive removed
export function endDrive(mates) { for (const m of mates) if (m._drive != null) { m.value = Math.round(m._drive * 1e6) / 1e6; delete m._drive; } }

function solveSPD(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) { const f = M[i][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[i][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}

// Degrees of freedom: per component 'fixed' | 'defined' | 'under' (+ remaining DOF count)
export function analyzeDOF(comps, mates) {
  const byId = compMap(comps);
  const active = mates.filter((m) => !mateOff(m) && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
  const out = new Map();
  const vars = comps.filter((c) => !c.fixed);
  for (const c of comps) out.set(c.id, c.fixed ? { state: 'fixed', dof: 0 } : { state: 'under', dof: 6 });
  const n = vars.length * 6;
  if (!n) return out;
  const idx = new Map(vars.map((c, i) => [c.id, i]));
  const rows = [];
  const save = vars.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
  const res = () => {
    const o = [];
    for (const m of active) { const cA = byId.get(m.a.comp), cB = byId.get(m.b.comp); try { mateResidual(m, worldGeo(cA, m.a.geo), worldGeo(cB, m.b.geo), cA, cB, o); } catch { /* skip */ } }
    return o;
  };
  const r0 = res();
  if (!r0.length) return out;
  const h = 1e-6;
  for (let j = 0; j < n; j++) {
    const c = vars[Math.floor(j / 6)], k = j % 6, s = save[Math.floor(j / 6)];
    if (k < 3) { const p = [...s.pos]; p[k] += h; c.pos = p; } else { const w = [0, 0, 0]; w[k - 3] = h; c.rot = qnorm(qmul(qexp(w), s.rot)); }
    const rj = res();
    rows.push(rj.map((v, i) => (v - r0[i]) / h));
    c.pos = [...s.pos]; c.rot = [...s.rot];
  }
  // JtJ (n x n), eigen-decomposition by cyclic Jacobi
  const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => rows[a].reduce((s, v, i) => s + v * rows[b][i], 0)));
  const { vals, vecs } = jacobiEigen(A);
  const maxE = Math.max(1, ...vals);
  const null_ = [];
  vals.forEach((v, i) => { if (v < maxE * 1e-9) null_.push(vecs.map((row) => row[i])); });
  for (const c of vars) {
    const i = idx.get(c.id);
    // dimension of the null space projected onto this component's 6 columns
    const P = null_.map((v) => v.slice(i * 6, i * 6 + 6));
    const G = P.map((a) => P.map((b) => a.reduce((s, x, k) => s + x * b[k], 0)));
    const dof = G.length ? jacobiEigen(G).vals.filter((v) => v > 1e-6).length : 0;
    out.set(c.id, { state: dof ? 'under' : 'defined', dof: Math.min(6, dof) });
  }
  return out;
}

function jacobiEigen(S) {
  const n = S.length;
  const A = S.map((r) => [...r]);
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { vals: A.map((r, i) => r[i]), vecs: V };
}
