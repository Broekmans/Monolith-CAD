// Profile extraction: turns solved sketch geometry into closed loops and
// nested regions (outer loop + holes). Pure JS, shared by renderer and kernel.

const TAU = Math.PI * 2;

export function normAng(a) {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

// Resolve sketch geometry into drawable curves (2D, sketch coordinates).
export function sketchCurves(sketch, { includeConstruction = false } = {}) {
  const pts = new Map();
  for (const g of sketch.geo) if (g.type === 'point') pts.set(g.id, g);
  const out = [];
  for (const g of sketch.geo) {
    if (g.type === 'point') continue;
    if (g.construction && !includeConstruction) continue;
    if (g.refKey) continue; // invisible link to a model edge (clicked in the sketch), never drawn or used as a profile
    if (g.type === 'text') {
      const a = pts.get(g.p);
      if (!a || !g.outline) continue;
      const segs = textSegs(g, [a.x, a.y]);
      textLoops(g, [a.x, a.y]).forEach((loop, i) => out.push({ id: g.id, kind: 'poly', pts: loop, segs: segs?.[i], ...(g.tol != null ? { tol: g.tol } : {}), construction: !!g.construction }));
      continue;
    }
    if (g.type === 'line') {
      const a = pts.get(g.p1), b = pts.get(g.p2);
      if (!a || !b) continue;
      out.push({ id: g.id, kind: 'line', a: [a.x, a.y], b: [b.x, b.y], construction: !!g.construction });
    } else if (g.type === 'circle') {
      const c = pts.get(g.c);
      if (!c) continue;
      out.push({ id: g.id, kind: 'circle', c: [c.x, c.y], r: g.r, construction: !!g.construction });
    } else if (g.type === 'arc') {
      const c = pts.get(g.c), s = pts.get(g.s), e = pts.get(g.e);
      if (!c || !s || !e) continue;
      const a0 = Math.atan2(s.y - c.y, s.x - c.x);
      const a1 = Math.atan2(e.y - c.y, e.x - c.x);
      out.push({ id: g.id, kind: 'arc', c: [c.x, c.y], r: g.r, a0, a1, a: [s.x, s.y], b: [e.x, e.y], construction: !!g.construction });
    }
  }
  return out;
}

export function arcSweep(cur) {
  let d = normAng(cur.a1 - cur.a0);
  if (d < 1e-9) d = TAU;
  return d;
}

// Text outlines are stored relative to the anchor point (unrotated, in
// sketch units); place them in sketch coordinates.
export function textLoops(g, anchor) {
  const r = g.rot || 0, c = Math.cos(r), s = Math.sin(r);
  return (g.outline || []).map((loop) => loop.map(([x, y]) => [anchor[0] + x * c - y * s, anchor[1] + x * s + y * c]));
}

// Exact glyph segments (lines / Bezier control polygons), placed like textLoops.
export function textSegs(g, anchor) {
  if (!g.segs || g.segs.length !== (g.outline || []).length) return null;
  const r = g.rot || 0, c = Math.cos(r), s = Math.sin(r);
  const T = ([x, y]) => [anchor[0] + x * c - y * s, anchor[1] + x * s + y * c];
  return g.segs.map((loop) => loop.map((seg) => seg.map(T)));
}

// Sample a curve into a polyline (in its natural direction).
export function sampleCurve(cur, segs = 48) {
  if (cur.kind === 'line') return [cur.a, cur.b];
  if (cur.kind === 'poly') return [...cur.pts, cur.pts[0]];
  if (cur.kind === 'circle') {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * TAU;
      pts.push([cur.c[0] + cur.r * Math.cos(t), cur.c[1] + cur.r * Math.sin(t)]);
    }
    return pts;
  }
  const sw = arcSweep(cur);
  const n = Math.max(4, Math.ceil((segs * sw) / TAU));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = cur.a0 + (sw * i) / n;
    pts.push([cur.c[0] + cur.r * Math.cos(t), cur.c[1] + cur.r * Math.sin(t)]);
  }
  return pts;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Find closed loops. Returns { loops, openIds } where each loop is
// { curves: [{cur, reversed}], poly, area }.
// Faces of a planar edge graph with junctions (nodes of degree > 2), e.g. a profile and
// its mirror sharing an edge. Walks half-edges always turning most to the left; the
// unbounded outer face (clockwise) is dropped.
function planarFaces(comp, edges, adj) {
  const dirOut = (k, fromN) => { // tangent angle leaving node fromN along edge k
    const e = edges[k]; let p = sampleCurve(e.cur, 24);
    if (e.n1 !== fromN) p = p.slice().reverse();
    const q = p[1]; return Math.atan2(q[1] - p[0][1], q[0] - p[0][0]);
  };
  const used = new Set(), out = [];
  for (const k0 of comp) for (const rev0 of [false, true]) {
    if (used.has(k0 + ':' + rev0)) continue;
    const seq = []; let k = k0, rev = rev0, guard = 0, ok = true;
    while (!used.has(k + ':' + rev)) {
      if (guard++ > 10000) { ok = false; break; }
      used.add(k + ':' + rev);
      seq.push({ cur: edges[k].cur, reversed: rev });
      const at = rev ? edges[k].n1 : edges[k].n2;
      const back = dirOut(k, at);
      let best = null, bestTurn = Infinity;
      for (const j of adj[at]) {
        if (j === k && adj[at].length > 1) continue;
        const a = dirOut(j, at);
        let turn = back - a; while (turn <= 1e-9) turn += Math.PI * 2; // clockwise sweep from the reverse direction
        if (turn < bestTurn) { bestTurn = turn; best = j; }
      }
      if (best === null) { ok = false; break; }
      rev = edges[best].n1 !== at; k = best;
    }
    if (!ok || seq.length < 2) continue;
    const poly = [];
    for (const s of seq) { let p = sampleCurve(s.cur); if (s.reversed) p = p.slice().reverse(); poly.push(...p.slice(0, -1)); }
    const a = polyArea(poly);
    if (a <= 1e-12) continue; // outer face / degenerate
    out.push({ curves: seq, poly, area: Math.abs(a) });
  }
  return out;
}

export function findLoops(curves, tol = 1e-4) {
  const loops = [];
  const openIds = [];
  const keyOf = new Map();
  const nodes = [];
  const nodeFor = (p) => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - p[0]) < tol && Math.abs(nodes[i][1] - p[1]) < tol) return i;
    }
    nodes.push(p);
    return nodes.length - 1;
  };
  const edges = [];
  for (const cur of curves) {
    if (cur.kind === 'poly') {
      if (cur.pts.length >= 3) loops.push({ curves: [{ cur, reversed: false }], poly: cur.pts, area: Math.abs(polyArea(cur.pts)) });
      continue;
    }
    if (cur.kind === 'circle') {
      const poly = sampleCurve(cur, 96).slice(0, -1);
      loops.push({ curves: [{ cur, reversed: false }], poly, area: Math.abs(polyArea(poly)) });
      continue;
    }
    const n1 = nodeFor(cur.a), n2 = nodeFor(cur.b);
    if (n1 === n2) continue; // degenerate
    edges.push({ cur, n1, n2, used: false });
  }
  keyOf.clear();
  // drop duplicate edges (e.g. a mirrored edge lying on top of its original)
  {
    const seenE = new Set();
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i], c = e.cur;
      const k = [Math.min(e.n1, e.n2), Math.max(e.n1, e.n2), c.kind, c.kind === 'arc' ? nodeFor(c.c) + ':' + Math.round(c.r / tol) : ''].join('|');
      if (seenE.has(k)) edges.splice(i, 1); else seenE.add(k);
    }
  }
  // prune dangling edges (open stubs) so the remaining closed contours still count
  for (let changed = true; changed;) {
    changed = false;
    const deg = nodes.map(() => 0);
    edges.forEach((e) => { deg[e.n1]++; deg[e.n2]++; });
    for (let i = edges.length - 1; i >= 0; i--) if (deg[edges[i].n1] < 2 || deg[edges[i].n2] < 2) { openIds.push(edges[i].cur.id); edges.splice(i, 1); changed = true; }
  }
  const adj = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.n1].push(i); adj[e.n2].push(i); });

  // components
  const seen = new Array(edges.length).fill(false);
  for (let i = 0; i < edges.length; i++) {
    if (seen[i]) continue;
    const comp = [];
    const stack = [i];
    seen[i] = true;
    while (stack.length) {
      const k = stack.pop();
      comp.push(k);
      for (const n of [edges[k].n1, edges[k].n2]) for (const j of adj[n]) if (!seen[j]) { seen[j] = true; stack.push(j); }
    }
    const compNodes = new Set();
    comp.forEach((k) => { compNodes.add(edges[k].n1); compNodes.add(edges[k].n2); });
    const ok = [...compNodes].every((n) => adj[n].length === 2);
    if (!ok) { for (const L of planarFaces(comp, edges, adj)) loops.push(L); continue; }
    // walk the cycle
    const seq = [];
    let cur = comp[0];
    let at = edges[cur].n1;
    const used = new Set();
    while (!used.has(cur)) {
      used.add(cur);
      const e = edges[cur];
      const reversed = e.n1 !== at;
      seq.push({ cur: e.cur, reversed });
      at = reversed ? e.n1 : e.n2;
      const nxt = adj[at].find((j) => j !== cur && !used.has(j));
      if (nxt === undefined) break;
      cur = nxt;
    }
    const poly = [];
    for (const s of seq) {
      let p = sampleCurve(s.cur);
      if (s.reversed) p = p.slice().reverse();
      poly.push(...p.slice(0, -1));
    }
    loops.push({ curves: seq, poly, area: Math.abs(polyArea(poly)) });
  }
  return { loops, openIds };
}

// Nest loops into regions: each region = outer loop + direct hole loops.
export function findRegions(curves, tol) {
  const { loops, openIds } = findLoops(curves, tol);
  const n = loops.length;
  const depth = new Array(n).fill(0);
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const probe = loops[i].poly[0];
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (i === j || loops[j].area <= loops[i].area) continue;
      // probe a few points to be robust against touching boundaries
      const p = loops[i].poly;
      const samples = [p[0], p[Math.floor(p.length / 3)], p[Math.floor((2 * p.length) / 3)]];
      const inside = samples.filter((s) => pointInPoly(s, loops[j].poly)).length >= 2;
      if (inside && (best < 0 || loops[j].area < loops[best].area)) best = j;
    }
    parent[i] = best;
    void probe;
  }
  for (let i = 0; i < n; i++) { let d = 0, k = parent[i]; while (k >= 0) { d++; k = parent[k]; } depth[i] = d; }
  const regions = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue;
    const holes = [];
    for (let j = 0; j < n; j++) if (parent[j] === i && depth[j] === depth[i] + 1) holes.push(loops[j]);
    regions.push({ outer: loops[i], holes });
  }
  return { regions, loops, openIds };
}
