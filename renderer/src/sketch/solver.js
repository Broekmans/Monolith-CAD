// Wrapper around FreeCAD's PlaneGCS solver (WebAssembly) for sketches.
import { init_planegcs_module, GcsWrapper } from '@salusoft89/planegcs';

let mod = null;
export async function initSolver(locateFile) {
  mod = await init_planegcs_module(locateFile ? { locateFile } : undefined);
}

const DEG = Math.PI / 180;

function geoMap(sk) {
  return new Map(sk.geo.map((g) => [g.id, g]));
}

// Convert one of our constraints into planegcs primitives.
function consToGcs(c, gm) {
  const id = c.id;
  const T = (o) => ({ id: o.id || id, driving: c.driving !== false, ...o });
  const g = (k) => gm.get(c[k]);
  const isArc = (x) => x && x.type === 'arc';
  const isCirc = (x) => x && x.type === 'circle';
  switch (c.type) {
    case 'coincident': return [T({ type: 'p2p_coincident', p1_id: c.a, p2_id: c.b })];
    case 'concentric': return [T({ type: 'p2p_coincident', p1_id: g('a').c, p2_id: g('b').c })];
    case 'pointOnLine': return [T({ type: 'point_on_line_pl', p_id: c.p, l_id: c.l })];
    case 'pointOnCircle':
      return isArc(gm.get(c.c)) ? [T({ type: 'point_on_arc', p_id: c.p, a_id: c.c })] : [T({ type: 'point_on_circle', p_id: c.p, c_id: c.c })];
    case 'midpoint': {
      const l = gm.get(c.l);
      return [T({ type: 'p2p_symmetric_ppp', p1_id: l.p1, p2_id: l.p2, p_id: c.p })];
    }
    case 'horizontal': return [T({ type: 'horizontal_l', l_id: c.l })];
    case 'vertical': return [T({ type: 'vertical_l', l_id: c.l })];
    case 'horizontalPts': return [T({ type: 'horizontal_pp', p1_id: c.a, p2_id: c.b })];
    case 'verticalPts': return [T({ type: 'vertical_pp', p1_id: c.a, p2_id: c.b })];
    case 'parallel': return [T({ type: 'parallel', l1_id: c.a, l2_id: c.b })];
    case 'perpendicular': return [T({ type: 'perpendicular_ll', l1_id: c.a, l2_id: c.b })];
    case 'collinear': {
      const b = g('b');
      return [T({ id: id + '#1', type: 'point_on_line_pl', p_id: b.p1, l_id: c.a }), T({ id: id + '#2', type: 'point_on_line_pl', p_id: b.p2, l_id: c.a })];
    }
    case 'equal': {
      const a = g('a'), b = g('b');
      if (a.type === 'line') return [T({ type: 'equal_length', l1_id: c.a, l2_id: c.b })];
      if (isCirc(a) && isCirc(b)) return [T({ type: 'equal_radius_cc', c1_id: c.a, c2_id: c.b })];
      if (isArc(a) && isArc(b)) return [T({ type: 'equal_radius_aa', a1_id: c.a, a2_id: c.b })];
      const cc = isCirc(a) ? c.a : c.b, aa = isCirc(a) ? c.b : c.a;
      return [T({ type: 'equal_radius_ca', c1_id: cc, a2_id: aa })];
    }
    case 'tangent': {
      let a = g('a'), b = g('b'), ia = c.a, ib = c.b;
      if (b.type === 'line') { [a, b] = [b, a]; [ia, ib] = [ib, ia]; }
      if (a.type === 'line') return [T(isArc(b) ? { type: 'tangent_la', l_id: ia, a_id: ib } : { type: 'tangent_lc', l_id: ia, c_id: ib })];
      if (isCirc(a) && isCirc(b)) return [T({ type: 'tangent_cc', c1_id: ia, c2_id: ib })];
      if (isArc(a) && isArc(b)) return [T({ type: 'tangent_aa', a1_id: ia, a2_id: ib })];
      const cc = isCirc(a) ? ia : ib, aa = isCirc(a) ? ib : ia;
      return [T({ type: 'tangent_ca', c_id: cc, a_id: aa })];
    }
    case 'tangentEnd': { // line tangent to arc at the shared endpoint p: line ⟂ (arc centre → p)
      const l = gm.get(c.l), a = gm.get(c.c);
      return [T({ type: 'perpendicular_pppp', l1p1_id: l.p1, l1p2_id: l.p2, l2p1_id: a.c, l2p2_id: c.p })];
    }
    case 'symmetric': return [T({ type: 'p2p_symmetric_ppl', p1_id: c.a, p2_id: c.b, l_id: c.l })];
    case 'fix': return []; // handled via fixed flags
    // ---- dimensions ----
    case 'distance': return [T({ type: 'p2p_distance', p1_id: c.a, p2_id: c.b, distance: c.value })];
    case 'length': {
      const l = gm.get(c.l);
      return [T({ type: 'p2p_distance', p1_id: l.p1, p2_id: l.p2, distance: c.value })];
    }
    case 'hdist': return [T({ type: 'difference', param1: { o_id: c.a, prop: 'x' }, param2: { o_id: c.b, prop: 'x' }, difference: c.value * (c.sign || 1) })];
    case 'vdist': return [T({ type: 'difference', param1: { o_id: c.a, prop: 'y' }, param2: { o_id: c.b, prop: 'y' }, difference: c.value * (c.sign || 1) })];
    case 'pointLine': return [T({ type: 'p2l_distance', p_id: c.p, l_id: c.l, distance: c.value })];
    case 'radius': return [T(isArc(gm.get(c.c)) ? { type: 'arc_radius', a_id: c.c, radius: c.value } : { type: 'circle_radius', c_id: c.c, radius: c.value })];
    case 'diameter': return [T(isArc(gm.get(c.c)) ? { type: 'arc_diameter', a_id: c.c, diameter: c.value } : { type: 'circle_diameter', c_id: c.c, diameter: c.value })];
    case 'angle': return [T({ type: 'l2l_angle_ll', l1_id: c.a, l2_id: c.b, angle: (c.sign || 1) * c.value * DEG })];
    default: return [];
  }
}

function fixedSet(sk) {
  const s = new Set();
  const gm = geoMap(sk);
  for (const c of sk.cons) {
    if (c.type !== 'fix') continue;
    const g = gm.get(c.e);
    if (!g) continue;
    if (g.type === 'point') s.add(g.id);
    if (g.type === 'text') s.add(g.p);
    if (g.type === 'line') { s.add(g.p1); s.add(g.p2); }
    if (g.type === 'circle' || g.type === 'arc') { s.add(g.c); if (g.s) { s.add(g.s); s.add(g.e); } }
  }
  for (const g of sk.geo) if (g.type === 'point' && g.fixed) s.add(g.id);
  return s;
}

function buildPrims(sk, extra = []) {
  const gm = geoMap(sk);
  const fixed = fixedSet(sk);
  const prims = [];
  for (const g of sk.geo) if (g.type === 'point') prims.push({ id: g.id, type: 'point', x: g.x, y: g.y, fixed: fixed.has(g.id) });
  for (const g of sk.geo) {
    if (g.type === 'line') prims.push({ id: g.id, type: 'line', p1_id: g.p1, p2_id: g.p2 });
    else if (g.type === 'circle') prims.push({ id: g.id, type: 'circle', c_id: g.c, radius: g.r });
    else if (g.type === 'arc') {
      const c = gm.get(g.c), s = gm.get(g.s), e = gm.get(g.e);
      let a0 = Math.atan2(s.y - c.y, s.x - c.x), a1 = Math.atan2(e.y - c.y, e.x - c.x);
      if (a1 <= a0) a1 += Math.PI * 2;
      prims.push({ id: g.id, type: 'arc', c_id: g.c, radius: g.r, start_angle: a0, end_angle: a1, start_id: g.s, end_id: g.e });
      prims.push({ id: g.id + '#rules', type: 'arc_rules', a_id: g.id });
    }
  }
  for (const c of sk.cons) {
    if (c.driving === false) continue; // reference dimensions are measured in JS
    try { prims.push(...consToGcs(c, gm)); } catch { /* dangling reference */ }
  }
  prims.push(...extra);
  return prims;
}

function makeWrapper() {
  const w = new GcsWrapper(new mod.GcsSystem());
  w.debug_mode = 0;
  return w;
}

function readBack(sk, w) {
  const gm = geoMap(sk);
  for (const p of w.sketch_index.get_primitives()) {
    const g = gm.get(p.id);
    if (!g) continue;
    if (p.type === 'point') { g.x = p.x; g.y = p.y; }
    else if (p.type === 'circle' || p.type === 'arc') g.r = p.radius;
  }
}

// Solve the sketch in place. `drag` adds temporary constraints that pull
// geometry toward the cursor without fighting real constraints.
export function solve(sk, { drag = null } = {}) {
  const extra = [];
  if (drag) {
    for (const d of drag) {
      if (d.kind === 'point') {
        extra.push({ id: 'drag_x_' + d.id, type: 'coordinate_x', p_id: d.id, x: d.x, temporary: true });
        extra.push({ id: 'drag_y_' + d.id, type: 'coordinate_y', p_id: d.id, y: d.y, temporary: true });
      } else if (d.kind === 'radius') {
        extra.push({ id: 'drag_r_' + d.id, type: d.arc ? 'arc_radius' : 'circle_radius', [d.arc ? 'a_id' : 'c_id']: d.id, radius: d.r, temporary: true });
      }
    }
  }
  const w = makeWrapper();
  let result;
  try {
    w.push_primitives_and_params(buildPrims(sk, extra));
    const st = w.solve();
    const conflicting = w.get_gcs_conflicting_constraints();
    const redundant = w.get_gcs_redundant_constraints();
    const ok = st === 0 || st === 1;
    if (ok) { w.apply_solution(); readBack(sk, w); }
    const dof = drag ? null : w.gcs.dof();
    result = { ok, status: st, dof, conflicting, redundant };
  } finally {
    w.destroy_gcs_module();
  }
  return result;
}

// Determine which geometry is fully defined by probing each point: if the
// solver can move it with a temporary pull, it is under-defined.
export function analyzeDefinition(sk) {
  const under = new Set();
  const gm = geoMap(sk);
  const pts = sk.geo.filter((g) => g.type === 'point');
  const scale = Math.max(1, ...pts.map((p) => Math.abs(p.x) + Math.abs(p.y))) * 1e-3;
  const probe = (extra, check) => {
    const w = makeWrapper();
    try {
      w.push_primitives_and_params(buildPrims(sk, extra));
      const st = w.solve();
      if (st !== 0 && st !== 1) return false;
      w.apply_solution();
      const prims = new Map(w.sketch_index.get_primitives().map((p) => [p.id, p]));
      return check(prims);
    } finally { w.destroy_gcs_module(); }
  };
  for (const p of pts) {
    if (p.id === 'O') continue;
    for (const [axis, dx, dy] of [['x', scale, 0], ['y', 0, scale]]) {
      if (under.has(p.id)) break;
      const moved = probe([
        { id: 'pr_x', type: 'coordinate_x', p_id: p.id, x: p.x + dx, temporary: true },
        { id: 'pr_y', type: 'coordinate_y', p_id: p.id, y: p.y + dy, temporary: true },
      ], (prims) => {
        const q = prims.get(p.id);
        return Math.abs(q.x - p.x) > scale * 0.3 || Math.abs(q.y - p.y) > scale * 0.3;
      });
      void axis;
      if (moved) under.add(p.id);
    }
  }
  for (const g of sk.geo) {
    if (g.type !== 'circle' && g.type !== 'arc') continue;
    const moved = probe([{ id: 'pr_r', type: g.type === 'arc' ? 'arc_radius' : 'circle_radius', [g.type === 'arc' ? 'a_id' : 'c_id']: g.id, radius: g.r * 1.01 + scale, temporary: true }],
      (prims) => Math.abs(prims.get(g.id).radius - g.r) > scale * 0.3);
    if (moved) under.add(g.id);
  }
  // a curve is under-defined if any of its defining points/radius is
  const geoUnder = new Set();
  for (const g of sk.geo) {
    if (g.type === 'point' && under.has(g.id)) geoUnder.add(g.id);
    if (g.type === 'line' && (under.has(g.p1) || under.has(g.p2))) geoUnder.add(g.id);
    if (g.type === 'text' && under.has(g.p)) geoUnder.add(g.id);
    if ((g.type === 'circle' || g.type === 'arc') && (under.has(g.id) || under.has(g.c) || (g.s && (under.has(g.s) || under.has(g.e))))) geoUnder.add(g.id);
  }
  void gm;
  return geoUnder;
}

// Measure the current value of a dimension (used for display and for
// reference/driven dimensions).
export function measure(sk, c) {
  const gm = geoMap(sk);
  const P = (id) => gm.get(id);
  switch (c.type) {
    case 'distance': { const a = P(c.a), b = P(c.b); return Math.hypot(b.x - a.x, b.y - a.y); }
    case 'length': { const l = P(c.l), a = P(l.p1), b = P(l.p2); return Math.hypot(b.x - a.x, b.y - a.y); }
    case 'hdist': return Math.abs(P(c.b).x - P(c.a).x);
    case 'vdist': return Math.abs(P(c.b).y - P(c.a).y);
    case 'pointLine': {
      const p = P(c.p), l = P(c.l), a = P(l.p1), b = P(l.p2);
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
    }
    case 'radius': return P(c.c).r;
    case 'diameter': return P(c.c).r * 2;
    case 'angle': {
      const la = P(c.a), lb = P(c.b);
      const d = (l) => { const a = P(l.p1), b = P(l.p2); return Math.atan2(b.y - a.y, b.x - a.x); };
      let ang = Math.abs(d(lb) - d(la)) / DEG;
      ang = ang % 360; if (ang > 180) ang = 360 - ang;
      return ang;
    }
    default: return 0;
  }
}

export const DIM_TYPES = new Set(['distance', 'length', 'hdist', 'vdist', 'pointLine', 'radius', 'diameter', 'angle']);
