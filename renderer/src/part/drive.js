// Sketch size changes that move geometry a long way (0.1.83). planegcs solves one big jump (74 → 690) into a wrong
// configuration or not at all, so a dimension is walked to its new value in steps of at most `maxStep` (25 %) per
// solve; each step starts from the previous solution (continuation). Pure module (solver only), also used by tests.
import { solve as solveSketch, measure as measureDim, DIM_TYPES } from '../sketch/solver.js';

export function stepCount(from, to, maxStep = 0.25) {
  if (!(isFinite(from) && isFinite(to)) || from === to) return 1;
  if (from > 0 && to > 0) return Math.min(60, Math.max(1, Math.ceil(Math.abs(Math.log(to / from)) / Math.log(1 + maxStep))));
  return Math.min(60, Math.max(1, Math.ceil(Math.abs(to - from) / (maxStep * Math.max(Math.abs(from), Math.abs(to), 1)))));
}
const fmt = (v, d = 2) => { if (!isFinite(v)) return '-'; let s = Number(v).toFixed(d); s = s.includes('.') ? s.replace(/\.?0+$/, '') : s; return s === '-0' ? '0' : s; };
const valueAt = (from, to, k, n) => (from > 0 && to > 0 ? from * Math.pow(to / from, k / n) : from + ((to - from) * k) / n);

// Set constraint `c` (an object inside sk.cons) to `to`, solving in steps (predictor-corrector): after a tiny probe step
// the speed of every point / radius per unit of the value is known, each next step first moves the geometry by that
// speed (prediction) and then solves. Without the prediction, unsigned sizes (a 5 mm offset) flip to the other side
// when the main size jumps further than twice that offset in one solve. On failure the sketch is restored and
// {ok:false} returned; otherwise the last solve result.
export function solveStepped(sk, c, to, { maxStep = 0.25, solve = solveSketch } = {}) {
  const snap = JSON.stringify({ geo: sk.geo, cons: sk.cons });
  const from = c.value, n = stepCount(from, to, maxStep);
  const fail = (r, k) => { const o = JSON.parse(snap); sk.geo = o.geo; sk.cons = o.cons; solve(sk); return { ...(r || {}), ok: false, step: k, steps: n }; };
  if (n <= 1 || !isFinite(from)) { c.value = to; const r = solve(sk); return !r || r.ok === false ? fail(r, 1) : r; }
  const state = () => sk.geo.map((g) => (g.type === 'point' ? [g.x, g.y] : g.r !== undefined ? [g.r] : null));
  const put = (S0, V, dv) => sk.geo.forEach((g, i) => {
    if (!S0[i] || !V[i]) return;
    if (g.type === 'point') { g.x = S0[i][0] + V[i][0] * dv; g.y = S0[i][1] + V[i][1] * dv; } else if (g.r !== undefined) g.r = Math.max(1e-6, S0[i][0] + V[i][0] * dv);
  });
  const speed = (A, B, dv) => A.map((a, i) => (a && B[i] ? a.map((v, k) => (B[i][k] - v) / dv) : null));
  // probe: 1 % of the first step
  let cur = from, X = state(), r = null;
  const probe = (valueAt(from, to, 1, n) - from) * 0.01;
  c.value = from + probe; r = solve(sk);
  if (!r || r.ok === false) return fail(r, 0);
  let Y = state(), V = speed(X, Y, probe); X = Y; cur = c.value;
  for (let k = 1; k <= n; k++) {
    const next = k === n ? to : valueAt(from, to, k, n), dv = next - cur;
    put(X, V, dv); // prediction
    c.value = next; r = solve(sk);
    if (!r || r.ok === false) return fail(r, k);
    Y = state(); V = speed(X, Y, dv); X = Y; cur = next;
  }
  return r;
}

// A size without its own dimension that already follows from the sketch (r = solve result with the size added):
// find the existing dimension that drives it. Each dimension in the conflict set is tried: drop it, hold the size at
// `want`, solve, read what that dimension measures now. The one that changes least (relative) wins; it gets that
// value and the size is checked. Returns {cons, old, value} or {reason}.
export function driveSize(sk, want, r, opts = {}) {
  const base = (id) => String(id).split('#')[0];
  const ids = new Set([...(r?.conflicting || []), ...(r?.redundant || [])].map(base));
  const dims = (sk.cons || []).filter((c) => DIM_TYPES.has(c.type) && typeof c.value === 'number' && !c.driven);
  let cand = dims.filter((c) => ids.has(c.id));
  if (!cand.length) cand = dims; // conflict set unknown: try every dimension
  const snap = JSON.stringify({ geo: sk.geo, cons: sk.cons });
  const restore = () => { const o = JSON.parse(snap); sk.geo = o.geo; sk.cons = o.cons; };
  const sizeNow = () => measureDim(sk, want);
  let best = null;
  for (const c of cand) {
    restore();
    const t = sk.cons.find((x) => x.id === c.id), old = t.value;
    sk.cons = sk.cons.filter((x) => x !== t);
    const now = sizeNow(), w = { ...want, id: '__want', value: isFinite(now) && now > 0 ? now : want.value };
    sk.cons.push(w);
    const r1 = solveStepped(sk, w, want.value, opts); // big jumps in steps (84 → 700)
    if (!r1 || r1.ok === false || (r1.conflicting || []).length || (r1.redundant || []).some((x) => base(x) === '__want')) continue;
    let v = measureDim(sk, t);
    if (!(v > 1e-9) || !isFinite(v)) continue;
    if (Math.abs(v - Math.round(v * 1000) / 1000) < 5e-4) v = Math.round(v * 1000) / 1000; // solver noise: 39.99993 → 40
    // apply on a clean copy and check that the size really becomes `want`
    restore();
    const t2 = sk.cons.find((x) => x.id === c.id);
    const r2 = solveStepped(sk, t2, v, opts);
    if (!r2 || r2.ok === false || Math.abs(sizeNow() - want.value) > 1e-3 * Math.max(1, want.value)) continue;
    const rel = Math.abs(v - old) / Math.max(Math.abs(old), 1e-9) + (c.type === want.type ? 0 : 1e-3);
    if (!best || rel < best.rel) best = { id: c.id, old, value: v, rel };
  }
  restore();
  if (best) { const t = sk.cons.find((x) => x.id === best.id); solveStepped(sk, t, best.value, opts); return { cons: t, old: best.old, value: best.value }; }
  solveSketch(sk);
  const fixed = !cand.some((c) => ids.has(c.id)) && sk.cons.some((c) => c.type === 'fix');
  return { fixed, reason: fixed
    ? 'This size follows model edges the sketch is attached to (converted edges: Fix / On Edge relations). Change the sketch or feature that made those edges, or remove that relation in this sketch.'
    : 'This size follows from relations in the sketch, not from a dimension, so it cannot be set here. Add or change a dimension in the sketch instead.' };
}

// Sizes of a sketch that have no dimension yet (shown dashed on the model, editable like real ones; typing a value
// adds the dimension). Lines without a length/distance dimension (a parallel line of the same length that already
// shows a size is skipped, so a rectangle gets one width + one height), circles (Ø) and arcs (R) without one.
export function autoDims(sk) {
  const G = new Map(sk.geo.map((g) => [g.id, g])), P = (id) => { const p = G.get(id); return p ? [p.x, p.y] : null; };
  const cons = (sk.cons || []).filter((c) => DIM_TYPES.has(c.type));
  const pts = sk.geo.filter((g) => g.type === 'point');
  const ctr = pts.length ? [pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.y, 0) / pts.length] : [0, 0];
  const lines = sk.geo.filter((g) => g.type === 'line' && !g.construction).map((g) => {
    const a = P(g.p1), b = P(g.p2); if (!a || !b) return null;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) return null;
    return { g, a, b, L, u: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] };
  }).filter(Boolean);
  const same = (x, y) => Math.abs(x.u[0] * y.u[1] - x.u[1] * y.u[0]) < 0.02 && Math.abs(x.L - y.L) < 1e-4 * Math.max(1, x.L);
  const dimmed = (ln) => cons.some((c) => (c.type === 'length' && c.l === ln.g.id) || (['distance', 'hdist', 'vdist'].includes(c.type) && ((c.a === ln.g.p1 && c.b === ln.g.p2) || (c.a === ln.g.p2 && c.b === ln.g.p1))));
  const shown = lines.filter(dimmed), size = Math.max(1, ...lines.map((l) => l.L)), off = size * 0.06;
  const out = [];
  for (const ln of lines) {
    if (dimmed(ln) || shown.some((x) => same(x, ln))) continue;
    shown.push(ln);
    const m = [(ln.a[0] + ln.b[0]) / 2, (ln.a[1] + ln.b[1]) / 2];
    let n = [-ln.u[1], ln.u[0]]; if ((m[0] - ctr[0]) * n[0] + (m[1] - ctr[1]) * n[1] < 0) n = [-n[0], -n[1]];
    const lp = [n[0] * off, n[1] * off];
    out.push({ text: fmt(ln.L, 2), value: ln.L, at: [m[0] + lp[0], m[1] + lp[1]], lp, cons: { type: 'length', l: ln.g.id } });
  }
  for (const g of sk.geo) {
    if ((g.type !== 'circle' && g.type !== 'arc') || g.construction) continue;
    if (cons.some((c) => (c.type === 'radius' || c.type === 'diameter') && c.c === g.id)) continue;
    const c = P(g.c); if (!c || !(g.r > 0)) continue;
    const full = g.type === 'circle', v = full ? 2 * g.r : g.r, lp = [g.r * 0.7, g.r * 0.7];
    out.push({ text: (full ? 'Ø' : 'R') + fmt(v, 2), value: v, at: [c[0] + lp[0], c[1] + lp[1]], lp, cons: { type: full ? 'diameter' : 'radius', c: g.id } });
  }
  return out;
}

// Older parts (0.1.87/0.1.88 Smart Dimension): a distance between two parallel lines that is measured from an end of
// the LONGER line (e.g. the far corner of a model-edge reference) is turned around: from the shorter line's end nearest
// to the label, to the longer line. Same value (parallel lines); the label stays where it was. Returns the count.
export function fixParallelDims(sk) {
  const G = new Map(sk.geo.map((g) => [g.id, g])), P = (id) => { const p = G.get(id); return p ? [p.x, p.y] : null; };
  const lineOf = (pid) => sk.geo.find((g) => g.type === 'line' && (g.p1 === pid || g.p2 === pid));
  const len = (l) => Math.hypot(P(l.p2)[0] - P(l.p1)[0], P(l.p2)[1] - P(l.p1)[1]);
  const dir = (l) => { const a = P(l.p1), b = P(l.p2), d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
  let n = 0;
  for (const c of sk.cons || []) {
    if (c.type !== 'pointLine') continue;
    const lp = lineOf(c.p), l = G.get(c.l);
    if (!lp || !l || l.type !== 'line' || lp === l) continue;
    const u = dir(lp), v = dir(l);
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-6 || len(lp) <= len(l) * 1.0001) continue;
    const a0 = P(c.p), lab = [a0[0] + (c.lp?.[0] ?? 0), a0[1] + (c.lp?.[1] ?? 0)];
    const e1 = P(l.p1), e2 = P(l.p2);
    const np = Math.hypot(e1[0] - lab[0], e1[1] - lab[1]) <= Math.hypot(e2[0] - lab[0], e2[1] - lab[1]) ? l.p1 : l.p2;
    const na = P(np);
    c.p = np; c.l = lp.id; c.lp = [lab[0] - na[0], lab[1] - na[1]];
    n++;
  }
  return n;
}
