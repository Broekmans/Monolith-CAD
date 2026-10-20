// Sketch: trim, delete, mirror, relations, construction
// Methods are mixed into Sketcher (see sketcher.js); `this` is the Sketcher.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { icon } from '../icons.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { opt } from '../app/options.js';
import { niceHeight, COL, COL_LIGHT, COL_DARK, setSketchTheme, SKETCH_TOOLS, REL_DEFS, newSketch } from './sketcher.js';

export class SketchEditing {
  // ---------------- trim ----------------
  intersectionsWith(id) {
    const g = this.G(id), c = this.curveOf(g);
    const out = [];
    for (const o of this.sk.geo) {
      if (o.id === id || o.type === 'point' || o.type === 'text') continue;
      const k = this.curveOf(o);
      let pts = [];
      if (c.kind === 'line' && k.kind === 'line') pts = lineLine(c.a, c.b, k.a, k.b);
      else if (c.kind === 'line') pts = lineCircle(c.a, c.b, k.c, k.r);
      else if (k.kind === 'line') pts = lineCircle(k.a, k.b, c.c, c.r);
      else pts = circleCircle(c.c, c.r, k.c, k.r);
      if (k.kind === 'arc') pts = pts.filter((q) => angleInArc(Math.atan2(q[1] - k.c[1], q[0] - k.c[0]), k.a0, k.a1));
      if (c.kind === 'arc') pts = pts.filter((q) => angleInArc(Math.atan2(q[1] - c.c[1], q[0] - c.c[0]), c.a0, c.a1));
      for (const q of pts) out.push({ pt: q, other: o });
    }
    // points lying on the curve (e.g. T-junction endpoints)
    return out;
  }
  paramOn(c, q) {
    if (c.kind === 'line') return projectOnSegment(q, c.a, c.b).t;
    const ang = Math.atan2(q[1] - c.c[1], q[0] - c.c[0]);
    return c.kind === 'circle' ? normAng(ang) : normAng(ang - c.a0);
  }
  pointOn(c, t) {
    if (c.kind === 'line') return [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[1] + (c.b[1] - c.a[1]) * t];
    const ang = c.kind === 'circle' ? t : c.a0 + t;
    return [c.c[0] + c.r * Math.cos(ang), c.c[1] + c.r * Math.sin(ang)];
  }
  removeConsOnPoint(pid) { this.sk.cons = this.sk.cons.filter((k) => ![k.a, k.b, k.p].includes(pid)); }
  onCurveCons(pid, other) {
    if (other.type === 'line') this.addCons({ type: 'pointOnLine', p: pid, l: other.id });
    else this.addCons({ type: 'pointOnCircle', p: pid, c: other.id });
  }
  trimAt(id, p) {
    const g = this.G(id), c = this.curveOf(g);
    if (!c) return;
    const ints = this.intersectionsWith(id).map((x) => ({ ...x, t: this.paramOn(c, x.pt) }));
    const tc = this.paramOn(c, p);
    this.pushUndo();
    const end = c.kind === 'line' ? 1 : c.kind === 'arc' ? (normAng(c.a1 - c.a0) || TAU) : TAU;
    const eps = opt('skTrimParamEps') * Math.max(1, end);
    const inner = ints.filter((x) => x.t > eps && x.t < end - eps).sort((a, b) => a.t - b.t);
    if (c.kind === 'circle') {
      if (inner.length < 2) { this.deleteGeo([id]); this.resolve(true); return; }
      // find surrounding pair cyclically
      let lo = inner[inner.length - 1], hi = inner[0];
      for (let i = 0; i < inner.length - 1; i++) if (tc >= inner[i].t && tc <= inner[i + 1].t) { lo = inner[i]; hi = inner[i + 1]; }
      // keep the arc from hi to lo (CCW), dropping lo->hi which contains the click
      const s = this.addPoint(hi.pt[0], hi.pt[1]), e = this.addPoint(lo.pt[0], lo.pt[1]);
      g.type = 'arc'; g.s = s; g.e = e;
      this.onCurveCons(s, hi.other); this.onCurveCons(e, lo.other);
      this.resolve(true);
      return;
    }
    let lo = null, hi = null;
    for (const x of inner) { if (x.t < tc) lo = x; else if (!hi) hi = x; }
    const startPid = g.type === 'line' ? g.p1 : g.s, endPid = g.type === 'line' ? g.p2 : g.e;
    if (!lo && !hi) { this.deleteGeo([id]); this.resolve(true); return; }
    if (!lo) { // trim start segment
      const q = this.G(startPid); q.x = hi.pt[0]; q.y = hi.pt[1];
      this.removeConsOnPoint(startPid); this.dropLengthDims(id); this.onCurveCons(startPid, hi.other);
    } else if (!hi) {
      const q = this.G(endPid); q.x = lo.pt[0]; q.y = lo.pt[1];
      this.removeConsOnPoint(endPid); this.dropLengthDims(id); this.onCurveCons(endPid, lo.other);
    } else {
      // split: original keeps [start, lo], new piece is [hi, end]
      const oldEnd = this.G(endPid);
      const endXY = [oldEnd.x, oldEnd.y];
      let piece;
      if (g.type === 'line') {
        piece = this.addLine(hi.pt, endXY, g.construction);
        this.sk.cons.forEach((k) => { for (const f of ['a', 'b', 'p']) if (k[f] === endPid) k[f] = piece.p2; });
        const copyRel = this.sk.cons.filter((k) => (k.type === 'horizontal' || k.type === 'vertical') && k.l === id);
        for (const k of copyRel) this.addCons({ type: k.type, l: piece.id });
        if (!copyRel.length) this.addCons({ type: 'collinear', a: id, b: piece.id });
        this.onCurveCons(piece.p1, hi.other);
      } else {
        const cpt = this.G(g.c);
        piece = this.makeArc([cpt.x, cpt.y], hi.pt, endXY, g.r, null);
        this.sk.cons.forEach((k) => { for (const f of ['a', 'b', 'p']) if (k[f] === endPid) k[f] = piece.e; });
        this.addCons({ type: 'concentric', a: id, b: piece.id });
        this.addCons({ type: 'equal', a: id, b: piece.id });
        this.onCurveCons(piece.s, hi.other);
      }
      oldEnd.x = lo.pt[0]; oldEnd.y = lo.pt[1];
      this.dropLengthDims(id);
      this.onCurveCons(endPid, lo.other);
    }
    this.resolve(true);
  }
  dropLengthDims(id) { this.sk.cons = this.sk.cons.filter((k) => !(k.type === 'length' && k.l === id)); }

  // ---------------- editing ----------------
  deleteGeo(ids) {
    const kill = new Set(ids);
    for (const id of ids) {
      const g = this.G(id);
      if (!g || g.origin) { kill.delete(id); continue; }
      if (g.type === 'line') { kill.add(g.p1); kill.add(g.p2); }
      if (g.type === 'circle') kill.add(g.c);
      if (g.type === 'text') kill.add(g.p);
      if (g.type === 'arc') { kill.add(g.c); kill.add(g.s); kill.add(g.e); }
    }
    // keep points still used by surviving curves
    for (const g of this.sk.geo) {
      if (kill.has(g.id) || g.type === 'point') continue;
      for (const f of ['p1', 'p2', 'c', 's', 'e', 'p']) if (g[f]) kill.delete(g[f]);
    }
    kill.delete('O');
    this.sk.geo = this.sk.geo.filter((g) => !kill.has(g.id));
    this.sk.cons = this.sk.cons.filter((k) => ![k.a, k.b, k.p, k.l, k.c, k.e].some((r) => r && kill.has(r)));
  }
  deleteSelection() {
    if (!this.sel.size) return;
    this.pushUndo();
    const geo = [], cons = [];
    for (const k of this.sel) { const [kind, id] = k.split(':'); (kind === 'geo' ? geo : cons).push(id); }
    this.sk.cons = this.sk.cons.filter((c) => !cons.includes(c.id));
    this.deleteGeo(geo);
    this.sel.clear();
    this.resolve(true);
  }
  toggleConstruction() {
    const ids = this.selectedGeo().filter((g) => g.type !== 'point');
    if (!ids.length) return;
    this.pushUndo();
    const on = !ids.every((g) => g.construction);
    ids.forEach((g) => { g.construction = on; });
    this.resolve(false);
  }
  selectedGeo() { return [...this.sel].filter((k) => k.startsWith('geo:')).map((k) => this.G(k.slice(4))).filter(Boolean); }
  selectedCons() { return [...this.sel].filter((k) => k.startsWith('cons:')).map((k) => this.sk.cons.find((c) => c.id === k.slice(5))).filter(Boolean); }

  // Mirror the selected entities about the selected centerline / line / model edge.
  // Axis: the selected construction line (or the last selected line if none / several).
  // Two-step Mirror: step 1 select entities (click to toggle, Next/Enter), step 2 click the mirror line
  // (sketch line/centerline or a model edge). If entities are already selected, starts at step 2.
  startMirror() {
    this.cancelTool();
    this.mirrorMode = { step: this.selectedGeo().length ? 2 : 1 };
    this.host.onToolChanged?.('mirror');
    this.renderPanel(); this.vp.requestRender();
  }
  endMirror() { this.mirrorMode = null; this.host.onToolChanged?.(null); this.renderPanel(); this.vp.requestRender(); }
  mirrorNext() {
    if (!this.selectedGeo().length) { toast('Select the entities to mirror first.'); return; }
    this.mirrorMode.step = 2; this.renderPanel();
  }
  mirrorClick(p, sx, sy, e) {
    const m = this.mirrorMode;
    if (m.step === 1) {
      const hit = this.pick(p, sx, sy, { dims: false });
      if (hit) { const k = 'geo:' + hit.id; if (this.sel.has(k)) this.sel.delete(k); else this.sel.add(k); }
      this.renderPanel(); this.vp.requestRender();
      return;
    }
    let axisId = null;
    const hit = this.pick(p, sx, sy, { points: false, dims: false });
    if (hit && this.G(hit.id)?.type === 'line') axisId = hit.id;
    else {
      const before = new Set(this.sel);
      if (this.modelRefAt(p, e)) {
        const added = [...this.sel].find((k) => !before.has(k));
        this.sel = before;
        if (added && this.G(added.slice(4))?.type === 'line') axisId = added.slice(4);
      }
    }
    if (!axisId) { toast('Click a line, centerline or straight model edge as the mirror line.'); return; }
    this.sel.delete('geo:' + axisId);
    this.mirrorSelection(axisId);
    this.endMirror();
  }
  mirrorSelection(axisId = null) {
    const keys = [...this.sel].filter((k) => k.startsWith('geo:'));
    const gs = keys.map((k) => this.G(k.slice(4))).filter(Boolean);
    let axis = axisId ? this.G(axisId) : null;
    if (!axis) { const lines = gs.filter((g) => g.type === 'line'), cons = lines.filter((g) => g.construction); axis = cons.length === 1 ? cons[0] : lines[lines.length - 1]; }
    const ents = gs.filter((g) => g !== axis && g.type !== 'text');
    if (!axis || !ents.length) { this.startMirror(); return; }
    const a = this.P(axis.p1), b = this.P(axis.p2), L = dist(a, b);
    if (L < opt('geomEpsTiny')) return;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const refl = (p) => { const d = [p[0] - a[0], p[1] - a[1]], t = d[0] * u[0] + d[1] * u[1]; const f = [a[0] + u[0] * t, a[1] + u[1] * t]; return [2 * f[0] - p[0], 2 * f[1] - p[1]]; };
    const axTol = opt('skMirrorAxisTol'), onAxis = (p) => dist(p, refl(p)) < axTol;
    this.pushUndo();
    const map = new Map();
    const mp = (id) => {
      if (map.has(id)) return map.get(id);
      const p = this.P(id);
      let nid;
      if (onAxis(p)) nid = id;
      else { nid = this.addPoint(...refl(p)); this.addCons({ type: 'symmetric', a: id, b: nid, l: axis.id }); }
      map.set(id, nid); return nid;
    };
    const made = [];
    for (const g of ents) {
      let n = null;
      if (g.type === 'point') { mp(g.id); continue; }
      if (g.type === 'line') { const q1 = mp(g.p1), q2 = mp(g.p2); if (q1 === g.p1 && q2 === g.p2) continue; n = { type: 'line', p1: q1, p2: q2, construction: g.construction }; }
      else if (g.type === 'circle') n = { type: 'circle', c: mp(g.c), r: g.r, construction: g.construction };
      else if (g.type === 'arc') n = { type: 'arc', c: mp(g.c), s: mp(g.e), e: mp(g.s), r: g.r, construction: g.construction };
      if (!n) continue;
      n.id = this.gid(); this.sk.geo.push(n); made.push(n.id);
      if (g.type === 'circle') this.addCons({ type: 'equal', a: g.id, b: n.id });
    }
    this.sel.clear(); made.forEach((id) => this.sel.add('geo:' + id));
    this.resolve(true);
    this.renderPanel();
  }
  applicableRelations() {
    const gs = this.selectedGeo();
    const T = (t) => gs.filter((g) => g.type === t);
    const lines = T('line'), pts = T('point'), circs = gs.filter((g) => g.type === 'circle' || g.type === 'arc');
    const rel = [];
    const n = gs.length;
    if (!n) return rel;
    if (gs.some((g) => g.type === 'text')) return n === 1 ? ['fix'] : [];
    if (lines.length === n) {
      rel.push('horizontal', 'vertical');
      if (n === 2) rel.push('parallel', 'perpendicular', 'collinear');
      if (n >= 2) rel.push('equal');
    }
    if (pts.length === n && n === 2) rel.push('coincident', 'horizontalPts', 'verticalPts');
    if (pts.length === 1 && lines.length === 1 && n === 2) rel.push('pointOnLine', 'midpoint');
    if (pts.length === 1 && circs.length === 1 && n === 2) rel.push('pointOnCircle');
    if (lines.length === 1 && circs.length === 1 && n === 2) rel.push('tangent');
    if (circs.length === n && n >= 2) { rel.push('equal'); if (n === 2) rel.push('concentric', 'tangent'); }
    if (pts.length === 2 && lines.length === 1 && n === 3) rel.push('symmetric');
    rel.push('fix');
    return [...new Set(rel)];
  }
  addRelation(type) {
    const gs = this.selectedGeo();
    const ids = gs.map((g) => g.id);
    const lines = gs.filter((g) => g.type === 'line'), pts = gs.filter((g) => g.type === 'point'), circs = gs.filter((g) => g.type === 'circle' || g.type === 'arc');
    this.pushUndo();
    const before = JSON.stringify(this.sk.cons);
    switch (type) {
      case 'horizontal': case 'vertical': lines.forEach((l) => this.addCons({ type, l: l.id })); break;
      case 'horizontalPts': case 'verticalPts': this.addCons({ type, a: pts[0].id, b: pts[1].id }); break;
      case 'parallel': case 'perpendicular': case 'collinear': this.addCons({ type, a: lines[0].id, b: lines[1].id }); break;
      case 'equal': for (let i = 1; i < ids.length; i++) this.addCons({ type, a: ids[0], b: ids[i] }); break;
      case 'coincident': this.addCons({ type, a: pts[0].id, b: pts[1].id }); break;
      case 'pointOnLine': case 'midpoint': this.addCons({ type, p: pts[0].id, l: lines[0].id }); break;
      case 'pointOnCircle': this.addCons({ type, p: pts[0].id, c: circs[0].id }); break;
      case 'tangent': this.addCons({ type, a: (lines[0] || circs[0]).id, b: (lines[0] ? circs[0] : circs[1]).id }); break;
      case 'concentric': this.addCons({ type, a: circs[0].id, b: circs[1].id }); break;
      case 'symmetric': this.addCons({ type, a: pts[0].id, b: pts[1].id, l: lines[0].id }); break;
      case 'fix': gs.forEach((g) => this.addCons({ type: 'fix', e: g.id })); break;
      default:
    }
    const r = solve(this.sk);
    if (!r.ok || r.conflicting.length) {
      this.sk.cons = JSON.parse(before);
      this.undoStack.pop();
      toast(`Cannot add ${REL_DEFS[type].label}: it conflicts with existing relations or dimensions.`, 'error');
    }
    this.resolve(true);
  }

}
