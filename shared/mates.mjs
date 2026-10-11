// Assembly mate solver: rigid components (position + unit quaternion) are
// moved by a damped least-squares (Levenberg-Marquardt) solve so that all
// mates are satisfied. Pure JS, runs in the renderer and in node tests.
//
// Mate entity geometry (component-local): {t:'plane', p, n} | {t:'axis', p, d, r?} | {t:'circle', p, d, r}
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
function mateResidual(m, A, B, cA, cB, out) {
  const s = m.sense ?? -1;
  const align = (a, b) => { out.push((a[0] - s * b[0]) * L, (a[1] - s * b[1]) * L, (a[2] - s * b[2]) * L); };
  const side = m.side ?? 1;
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
      if (isAx(A) && isAx(B)) { align(A.d, B.d); out.push(...cross(sub(B.p, A.p), A.d)); return; }
      break;
    case 'distance': {
      const v = m.value || 0;
      if (P(A) && P(B)) { align(A.n, B.n); out.push(dot(sub(B.p, A.p), A.n) - side * v); return; }
      if (P(A) && isAx(B)) { if (B.t === 'circle') align(A.n, B.d); else out.push(dot(B.d, A.n) * L); out.push(dot(sub(B.p, A.p), A.n) - side * v); return; }
      if (isAx(A) && isAx(B)) { align(A.d, B.d); out.push(len(cross(sub(B.p, A.p), A.d)) - v); return; }
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
      // angle about the common axis: cos and sin parts keep it well conditioned
      out.push((dot(dA, dB) - Math.cos(a)) * L, (len(cross(dA, dB)) - Math.sin(a)) * L);
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

export function mateError(m, byId) {
  const cA = byId.get(m.a.comp), cB = byId.get(m.b.comp);
  if (!cA || !cB) return Infinity;
  const r = [];
  try { mateResidual(m, worldGeo(cA, m.a.geo), worldGeo(cB, m.b.geo), cA, cB, r); } catch { return Infinity; }
  return Math.sqrt(r.reduce((s, v) => s + v * v, 0));
}

// Solve. comps: [{id, pos, rot, fixed}] (mutated). drag: {comp, pts:[{local, target}], w}
export function solveMates(comps, mates, { drag = null, iters = 80, tol = 1e-10 } = {}) {
  const byId = new Map(comps.map((c) => [c.id, c]));
  const active = mates.filter((m) => !m.suppressed && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
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
  const byId = new Map(comps.map((c) => [c.id, c]));
  const active = mates.filter((m) => !m.suppressed && byId.has(m.a.comp) && byId.has(m.b.comp) && m.a.comp !== m.b.comp);
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
