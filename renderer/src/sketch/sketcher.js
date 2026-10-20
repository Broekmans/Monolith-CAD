// Interactive constraint sketcher (SolidWorks-style): drawing tools with
// automatic relations, smart dimensions, relations, trim, drag-solve and
// fully-defined feedback.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { icon } from '../icons.js';
import { opt } from '../app/options.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { SketchTools } from './tools.js';
import { SketchDims } from './dims.js';
import { SketchEditing } from './editing.js';
import { SketchDraw } from './draw.js';
import { SketchText } from './text.js';
import { SketchOffset } from './offsettool.js';

export const niceHeight = (v) => { const e = Math.pow(10, Math.floor(Math.log10(v))); const m = v / e; return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * e; };

// Colours from Options > Colours (opt(), read when the theme or the options change). COL holds the current values
// (draw.js swaps in COL_DARK_FREE temporarily); COL_LIGHT / COL_DARK / COL_DARK_FREE read Options through getters.
const themeCols = (origin) => ({
  get defined() { return opt('skDefined'); }, get under() { return opt('skUnder'); }, get over() { return opt('skOver'); },
  get sel() { return opt('skSel'); }, get hover() { return opt('skHover'); }, get construction() { return opt('skConstruction'); },
  get dim() { return opt('skDimColor'); }, get driven() { return opt('skDrivenColor'); }, get preview() { return opt('skHover'); },
  get origin() { return opt(origin); },
});
export const COL_LIGHT = themeCols('skOrigin');
// Dark mode: sketches are drawn on light part faces/planes, so geometry keeps the light-mode colours
// (Options > Colours: black = fully defined, blue = under defined); only the origin is brightened.
export const COL_DARK = themeCols('skOriginDark');
export const COL = { ...COL_LIGHT };
// Dark mode, sketch NOT lying on a part face (empty plane on the dark background): light colours (fully / under
// defined come from Options > Colours everywhere since 0.1.99: black / blue; black → light on the dark background, see draw.js).
export const COL_DARK_FREE = {
  get over() { return opt('skOverDark'); }, get construction() { return opt('skConstructionDark'); },
  get dim() { return opt('skDimColorDark'); }, get driven() { return opt('skDrivenColorDark'); },
};
let themeDark = false;
export function setSketchTheme(dark) { themeDark = !!dark; Object.assign(COL, dark ? COL_DARK : COL_LIGHT); applySketchColours(); }
// all sketch colours from Options > Colours (current theme)
export function applySketchColours() { Object.assign(COL, themeDark ? COL_DARK : COL_LIGHT); }

export const SKETCH_TOOLS = [
  { id: 'line', label: 'Line', icon: 'line', key: 'L' },
  { id: 'centerline', label: 'Centerline', icon: 'centerline' },
  { id: 'rect', label: 'Corner Rectangle', icon: 'rect', key: 'R' },
  { id: 'centerRect', label: 'Center Rectangle', icon: 'centerRect' },
  { id: 'circle', label: 'Circle', icon: 'circle', key: 'C' },
  { id: 'arc', label: 'Centerpoint Arc', icon: 'arc', key: 'A' },
  { id: 'arc3', label: '3 Point Arc', icon: 'arc3' },
  { id: 'tangentArc', label: 'Tangent Arc', icon: 'tangentArc' },
  { id: 'slot', label: 'Straight Slot', icon: 'slot' },
  { id: 'point', label: 'Point', icon: 'point' },
  { id: 'text', label: 'Text', icon: 'text', key: 'X' },
  { id: 'trim', label: 'Trim Entities', icon: 'trim', key: 'T' },
  { id: 'dimension', label: 'Smart Dimension', icon: 'dimension', key: 'D' },
];

export const REL_DEFS = {
  horizontal: { label: 'Horizontal', icon: 'horizontal', glyph: 'H' },
  vertical: { label: 'Vertical', icon: 'vertical', glyph: 'V' },
  horizontalPts: { label: 'Horizontal', icon: 'horizontal', glyph: 'H' },
  verticalPts: { label: 'Vertical', icon: 'vertical', glyph: 'V' },
  parallel: { label: 'Parallel', icon: 'parallel', glyph: '∥' },
  perpendicular: { label: 'Perpendicular', icon: 'perpendicular', glyph: '⊥' },
  equal: { label: 'Equal', icon: 'equal', glyph: '=' },
  tangent: { label: 'Tangent', icon: 'tangent', glyph: 'T' },
  tangentEnd: { label: 'Tangent', icon: 'tangent', glyph: 'T' },
  concentric: { label: 'Concentric', icon: 'concentric', glyph: '◎' },
  coincident: { label: 'Coincident', icon: 'coincident', glyph: '•' },
  pointOnLine: { label: 'Coincident', icon: 'coincident', glyph: '•' },
  pointOnCircle: { label: 'Coincident', icon: 'coincident', glyph: '•' },
  midpoint: { label: 'Midpoint', icon: 'midpoint', glyph: 'M' },
  collinear: { label: 'Collinear', icon: 'collinear', glyph: '/' },
  symmetric: { label: 'Symmetric', icon: 'symmetric', glyph: '⇹' },
  fix: { label: 'Fix', icon: 'fix', glyph: '⚓' },
  onEdge: { label: 'On Edge', icon: 'fix', glyph: '⊏' },
  offsetRel: { label: 'Offset', icon: 'parallel', glyph: '⫽' },
  offsetEnd: { label: 'Offset End', icon: 'coincident', glyph: '•' },
  offsetPerp: { label: 'Offset End', icon: 'perpendicular', glyph: '⊥' },
};
// relation shown in lists / glyphs: a Fix made by Convert Entities that is linked to the model reads "On Edge"
export const relDef = (c) => (c.type === 'fix' && c.onEdge ? REL_DEFS.onEdge : REL_DEFS[c.type]);

export function newSketch(id, name, plane, planeName) {
  return { id, type: 'sketch', name, plane, planeName, geo: [{ id: 'O', type: 'point', x: 0, y: 0, fixed: true, origin: true }], cons: [], next: 1 };
}

export class Sketcher {
  constructor(host, sketch) {
    this.host = host;
    this.vp = host.viewport;
    this.sk = structuredClone(sketch);
    if (!this.sk.next) this.sk.next = 1;
    this.original = sketch;
    const n = this.sk.plane.normal, x = this.sk.plane.xDir;
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    this.fr = { o: this.sk.plane.origin, n, x, y };
    this.tool = null;
    this.sel = new Set();
    this.hover = null;
    this.under = new Set();
    this.state = { dof: 0, conflicting: [] };
    this.undoStack = [];
    this.redoStack = [];
    this.dimHits = [];
    this.glyphHits = [];
    this.showRelations = true;
    this.mouse = null;
    this._drawer = (ctx) => this.draw(ctx);
    this.vp.overlayDrawers.push(this._drawer);
    this._bind();
    this.resolve(true);
    // sketches saved by v0.1.1 lack exact glyph segments: regenerate them
    for (const g of this.sk.geo) if (g.type === 'text' && (!g.segs || g.segs.length !== (g.outline || []).length)) this.updateText(g);
  }

  // ---------------- model helpers ----------------
  gid() { return 'g' + this.sk.next++; }
  cid() { return 'c' + this.sk.next++; }
  get geoMap() { return new Map(this.sk.geo.map((g) => [g.id, g])); }
  G(id) { return this.sk.geo.find((g) => g.id === id); }
  P(id) { const p = this.G(id); return p ? [p.x, p.y] : null; }
  addPoint(x, y, extra = {}) { const g = { id: this.gid(), type: 'point', x, y, ...extra }; this.sk.geo.push(g); return g.id; }
  addLine(a, b, construction = false) {
    const p1 = this.addPoint(a[0], a[1]), p2 = this.addPoint(b[0], b[1]);
    const g = { id: this.gid(), type: 'line', p1, p2, construction };
    this.sk.geo.push(g); return g;
  }
  addCons(c) { const k = { id: this.cid(), ...c }; this.sk.cons.push(k); return k; }
  pushUndo() { this.undoStack.push(JSON.stringify(this.sk)); if (this.undoStack.length > opt('skUndoLimit')) this.undoStack.shift(); this.redoStack = []; }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.sk)); this.sk = JSON.parse(this.undoStack.pop()); this.sel.clear(); this.resolve(true); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.sk)); this.sk = JSON.parse(this.redoStack.pop()); this.sel.clear(); this.resolve(true); }

  textPolys(g) { const a = this.G(g.p); return a ? textLoops(g, [a.x, a.y]) : []; }
  // Text extents in the text's own (unrotated) frame
  textBox(g) {
    const pts = (g.outline || []).flat();
    if (!pts.length) return { min: [0, 0], max: [g.h * 3, g.h] };
    return { min: [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))], max: [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))] };
  }
  textLocal(g, p) { const a = this.G(g.p); const r = -(g.rot || 0); const x = p[0] - a.x, y = p[1] - a.y; return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]; }
  curveOf(g) {
    if (g.type === 'line') return { kind: 'line', a: this.P(g.p1), b: this.P(g.p2) };
    if (g.type === 'circle') return { kind: 'circle', c: this.P(g.c), r: g.r };
    if (g.type === 'arc') {
      const c = this.P(g.c), s = this.P(g.s), e = this.P(g.e);
      return { kind: 'arc', c, r: g.r, a0: Math.atan2(s[1] - c[1], s[0] - c[0]), a1: Math.atan2(e[1] - c[1], e[0] - c[0]), a: s, b: e };
    }
    return null;
  }

  // Solve and refresh definition state.
  resolve(analyze = true) {
    const r = solve(this.sk);
    this.state = { dof: r.dof, conflicting: r.conflicting || [], redundant: r.redundant || [], ok: r.ok };
    if (analyze) {
      const pts = this.sk.geo.filter((g) => g.type === 'point').length;
      const maxPts = opt('skAnalyzeMaxPts');
      this.under = r.dof > 0 && pts < maxPts ? analyzeDefinition(this.sk) : new Set();
      if (r.dof > 0 && pts >= maxPts) this.under = new Set(this.sk.geo.map((g) => g.id));
    }
    this.host.onSketchChanged?.(this);
    this.renderPanel();
    this.vp.requestRender();
    return r;
  }

  statusText() {
    const s = this.state;
    if (!s.ok || s.conflicting.length) return { text: 'Over Defined', cls: 'over' };
    if (s.dof > 0) return { text: `Under Defined (${s.dof} DOF)`, cls: 'under' };
    return { text: 'Fully Defined', cls: 'full' };
  }

  // ---------------- coordinates & picking ----------------
  local(e) {
    const r = this.vp.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, p: this.vp.planePoint(sx, sy, this.fr) };
  }
  to3(p) { const f = this.fr; return [f.o[0] + f.x[0] * p[0] + f.y[0] * p[1], f.o[1] + f.x[1] * p[0] + f.y[1] * p[1], f.o[2] + f.x[2] * p[0] + f.y[2] * p[1]]; }
  scr(p) { return this.vp.toScreen(this.to3(p)); }
  get px() { return this.vp.scale; }

  // Model references made by clicking a model edge / corner (refKey): invisible links, not sketch entities to pick
  // (0.1.92). Their end / centre points are hidden too.
  hiddenIds() {
    const s = new Set();
    for (const g of this.sk.geo) if (g.refKey) { s.add(g.id); for (const k of ['p1', 'p2', 'c', 's', 'e']) if (g[k]) s.add(g[k]); }
    return s;
  }
  pick(p, sx, sy, { points = true, curves = true, dims = true, exclude = new Set() } = {}) {
    const thr = (opt('skPickPx') - opt('skPickInset')) * this.px;
    const hid = this.hiddenIds();
    if (hid.size) exclude = new Set([...exclude, ...hid]);
    if (dims) {
      const H = this._hitsBy?.get(this.vp.pane || this.vp); // hit boxes of the pane under the mouse (several views)
      for (const d of H?.dims || this.dimHits) if (sx >= d.x0 && sx <= d.x1 && sy >= d.y0 && sy <= d.y1) return { kind: 'cons', id: d.id };
      for (const d of H?.glyphs || this.glyphHits) if (sx >= d.x0 && sx <= d.x1 && sy >= d.y0 && sy <= d.y1) return { kind: 'cons', id: d.id };
    }
    if (points) {
      let best = null, bd = thr;
      for (const g of this.sk.geo) {
        if (g.type !== 'point' || exclude.has(g.id)) continue;
        const d = dist(p, [g.x, g.y]);
        if (d < bd) { bd = d; best = { kind: 'geo', id: g.id }; }
      }
      if (best) return best;
    }
    if (curves) {
      let best = null, bd = thr;
      for (const g of this.sk.geo) {
        if (g.type === 'point' || exclude.has(g.id)) continue;
        const d = this.distToGeo(p, g);
        if (d < bd) { bd = d; best = { kind: 'geo', id: g.id }; }
      }
      if (best) return best;
    }
    return null;
  }
  distToGeo(p, g) {
    if (g.type === 'text') {
      const q = this.textLocal(g, p), b = this.textBox(g);
      const dx = Math.max(b.min[0] - q[0], 0, q[0] - b.max[0]), dy = Math.max(b.min[1] - q[1], 0, q[1] - b.max[1]);
      return Math.hypot(dx, dy);
    }
    const c = this.curveOf(g);
    if (!c) return Infinity;
    if (c.kind === 'line') return dist(p, projectOnSegment(p, c.a, c.b).pt);
    const d = Math.abs(dist(p, c.c) - c.r);
    if (c.kind === 'circle') return d;
    const ang = Math.atan2(p[1] - c.c[1], p[0] - c.c[0]);
    return angleInArc(ang, c.a0, c.a1) ? d : Math.min(dist(p, c.a), dist(p, c.b));
  }

  // Inference snapping while drawing: returns point and the relation to add.
  snap(p, { from = null, exclude = new Set() } = {}) {
    const thr = opt('skPickPx') * this.px, thrC = thr * opt('skSnapCurveFactor');
    // existing points
    let best = null, bd = thr;
    for (const g of this.sk.geo) {
      if (g.type !== 'point' || exclude.has(g.id)) continue;
      const d = dist(p, [g.x, g.y]);
      if (d < bd) { bd = d; best = { pt: [g.x, g.y], ref: { kind: 'point', id: g.id } }; }
    }
    if (best) return best;
    const M = this.modelSnapGeo();
    for (const v of M.verts) { const d = dist(p, v); if (d < bd) { bd = d; best = { pt: v, ref: { kind: 'model', what: 'vertex' } }; } }
    if (best) return best;
    // midpoints
    for (const m of M.mids) if (dist(p, m) < thr) return { pt: m, ref: { kind: 'model', what: 'mid' } };
    for (const m of M.centers) if (dist(p, m) < thr) return { pt: m, ref: { kind: 'model', what: 'center' } };
    for (const g of this.sk.geo) {
      if (g.type !== 'line' || exclude.has(g.id)) continue;
      const a = this.P(g.p1), b = this.P(g.p2), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (dist(p, m) < thr) return { pt: m, ref: { kind: 'mid', id: g.id } };
    }
    // on curve
    for (const g of this.sk.geo) {
      if (g.type === 'point' || exclude.has(g.id)) continue;
      const c = this.curveOf(g);
      if (!c) continue;
      if (c.kind === 'line') {
        const pr = projectOnSegment(p, c.a, c.b);
        if (dist(p, pr.pt) < thrC && pr.t > 0 && pr.t < 1) { best = { pt: pr.pt, ref: { kind: 'onLine', id: g.id } }; break; }
      } else {
        const d = dist(p, c.c);
        if (Math.abs(d - c.r) < thrC && d > opt('geomEpsTiny')) {
          const q = [c.c[0] + ((p[0] - c.c[0]) * c.r) / d, c.c[1] + ((p[1] - c.c[1]) * c.r) / d];
          if (c.kind === 'circle' || angleInArc(Math.atan2(q[1] - c.c[1], q[0] - c.c[0]), c.a0, c.a1)) { best = { pt: q, ref: { kind: 'onCircle', id: g.id } }; break; }
        }
      }
    }
    if (best) return best;
    for (const [a, b] of M.segs) {
      const pr = projectOnSegment(p, a, b);
      if (dist(p, pr.pt) < thrC) return { pt: pr.pt, ref: { kind: 'model', what: 'edge' } };
    }
    // horizontal / vertical inference relative to the start point
    if (from) {
      const dx = p[0] - from[0], dy = p[1] - from[1];
      const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      if (Math.hypot(dx, dy) > opt('skDragPx') * this.px) {
        const hv = opt('skHVInferDeg');
        if (ang < hv || ang > 180 - hv) return { pt: [p[0], from[1]], hv: 'h' };
        if (Math.abs(ang - 90) < hv) return { pt: [from[0], p[1]], hv: 'v' };
      }
    }
    return { pt: p };
  }
  // Model (feature) edges projected into the sketch plane, cached per mesh.
  // Edges lying in the sketch plane are used; if none (offset plane), all edges are projected.
  modelSnapGeo() {
    const mesh = this.host.mesh;
    if (this._msg && this._msg.mesh === mesh) return this._msg.geo;
    const geo = { verts: [], mids: [], centers: [], segs: [], edges: [] };
    const f = this.fr;
    if (mesh?.edges?.length) {
      const tolP = opt('skInPlaneTol'), eps = opt('geomEps'), res = opt('skSnapVertexKeyRes');
      const loc = (x, y, z) => { const d = [x - f.o[0], y - f.o[1], z - f.o[2]]; return [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2], d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]]; };
      const all = mesh.edges.map((e) => { const q = []; for (let i = 0; i + 2 < e.pts.length; i += 3) q.push(loc(e.pts[i], e.pts[i + 1], e.pts[i + 2])); return { e, q }; }).filter((x) => x.q.length >= 2);
      const inPlane = all.filter((x) => x.q.every((q) => Math.abs(q[2]) < tolP));
      const use = inPlane.length ? inPlane : all;
      // every model edge projected on the sketch plane, for picking an edge to dimension / relate to (0.1.93: also
      // edges off the plane, e.g. the side of a filleted rim; in-plane and front-most edges win when they overlap)
      geo.pickEdges = [];
      for (const { e, q } of all) {
        const pts = q.map((v) => [v[0], v[1]]);
        let len = 0; for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
        if (len < eps) continue;
        geo.pickEdges.push({ e, pts, inPlane: q.every((v) => Math.abs(v[2]) < tolP), depth: q.reduce((a, v) => a + v[2], 0) / q.length, flat: q.every((v) => Math.abs(v[2] - q[0][2]) < tolP) });
      }
      const key = (v) => Math.round(v[0] * res) + ',' + Math.round(v[1] * res);
      const seen = new Set();
      const addV = (arr, v) => { if (!seen.has(key(v) + arr.tag)) { seen.add(key(v) + arr.tag); arr.push(v); } };
      geo.verts.tag = 'v'; geo.mids.tag = 'm'; geo.centers.tag = 'c';
      for (const { e, q } of use) {
        const pts = q.map((v) => [v[0], v[1]]);
        const a = pts[0], b = pts[pts.length - 1];
        let len = 0; for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
        if (len < eps) continue; // edge seen end-on
        const closed = dist(a, b) < eps;
        if (!closed) { addV(geo.verts, a); addV(geo.verts, b); }
        if (e.type === 'line' && !closed) addV(geo.mids, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        else if (e.type === 'circle' && pts.length >= 3) {
          const cc = circleFrom3(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
          if (cc) addV(geo.centers, cc.c);
          if (!closed) addV(geo.mids, pts[Math.floor(pts.length / 2)]);
        }
        geo.edges.push({ e, pts });
        for (let i = 1; i < pts.length; i++) if (dist(pts[i - 1], pts[i]) > opt('geomEpsTiny')) geo.segs.push([pts[i - 1], pts[i]]);
      }
    }
    this._msg = { mesh, geo };
    return geo;
  }
  // Select-mode click on a model corner or edge: create (or reuse) fixed construction reference
  // geometry for it and add it to the selection, so relations like Coincident / Midpoint can be added.
  // is there a model corner / edge under p (without making reference geometry)? Smart Dimension's second pick
  modelSnapHit(p) { return !!this.modelHoverAt(p, 1); }
  // model corner ({v}) or edge ({pts}) under p, same distances as modelRefAt (× f); used for the hover highlight
  modelHoverAt(p, f = 1, edgesOnly = false) {
    const M = this.modelSnapGeo(), thr = opt('skPickPx') * this.px * f;
    let bv = null, bd = thr;
    if (!edgesOnly) for (const v of M.verts) { const d = dist(p, v); if (d < bd) { bd = d; bv = v; } }
    if (bv) return { v: bv };
    const be = this.pickModelEdge(p, thr * opt('skEdgePickFactor'));
    return be ? { pts: be.pts, e: be.e } : null;
  }
  // nearest model edge to p within thr (in-plane edges preferred, then the one nearest the viewer)
  pickModelEdge(p, thr) {
    const M = this.modelSnapGeo(), list = M.pickEdges || M.edges;
    let be = null, bs = Infinity;
    const pen = opt('skOutOfPlanePenalty'), tie = opt('skDepthTieBreak');
    for (const ed of list) {
      let d = Infinity; for (let i = 1; i < ed.pts.length; i++) d = Math.min(d, dist(p, projectOnSegment(p, ed.pts[i - 1], ed.pts[i]).pt));
      if (d >= thr) continue;
      const score = d + (ed.inPlane === false ? pen * thr : 0) - (ed.depth || 0) * tie;
      if (score < bs) { bs = score; be = ed; }
    }
    return be;
  }
  modelRefAt(p, e) {
    const M = this.modelSnapGeo(), thr = opt('skPickPx') * this.px, res = opt('skRefKeyRes');
    const key = (v) => Math.round(v[0] * res) + ',' + Math.round(v[1] * res);
    let id = null;
    let bv = null, bd = thr;
    for (const v of M.verts) { const d = dist(p, v); if (d < bd) { bd = d; bv = v; } }
    if (bv) {
      const k = 'v:' + key(bv);
      id = this.sk.geo.find((g) => g.refKey === k || (g.refKey && g.type === 'point' && dist([g.x, g.y], bv) < opt('skRefMatchTol')))?.id;
      if (!id) { this.pushUndo(); id = this.addPoint(bv[0], bv[1], { refKey: k }); this.fixOnModel(id, bv); }
    } else {
      const be = this.pickModelEdge(p, thr * opt('skEdgePickFactor'));
      if (!be) return false;
      id = this.refForModelEdge(be);
      if (!id) return false;
    }
    const sk = 'geo:' + id;
    this.sel.add(sk); // a model reference always adds to the current selection
    this.resolve(true);
    return id; // the reference geometry (Smart Dimension uses it)
  }
  // invisible linked reference geometry for model edge `be` (existing one reused); returns its geometry id
  refForModelEdge(be, { full = false } = {}) { // full: only reuse a reference that covers the whole edge (Offset Entities)
    const res = opt('skRefKeyRes'), key = (v) => Math.round(v[0] * res) + ',' + Math.round(v[1] * res);
    let id = null;
    {
      const k = 'e:' + key(be.pts[0]) + ':' + key(be.pts[be.pts.length - 1]) + ':' + key(be.pts[Math.floor(be.pts.length / 2)]);
      // an existing reference on this edge (its key may be stale after the model moved): reuse it
      const a0 = be.pts[0], a1 = be.pts[be.pts.length - 1], tolE = opt('skRefOnEdgeTol') * Math.max(1, this.px * opt('skRefOnEdgeZoom'));
      const ends = (p, q) => !full || (p && q && ((dist(p, a0) < tolE && dist(q, a1) < tolE) || (dist(p, a1) < tolE && dist(q, a0) < tolE)));
      const onEdge = (q) => { for (let i = 1; i < be.pts.length; i++) if (dist(q, projectOnSegment(q, be.pts[i - 1], be.pts[i]).pt) < tolE) return true; return false; };
      const P2 = (pid) => { const g = this.sk.geo.find((x) => x.id === pid); return g ? [g.x, g.y] : null; };
      id = this.sk.geo.find((g) => g.refKey === k)?.id
        || this.sk.geo.find((g) => g.refKey && g.type === 'line' && be.e.type === 'line' && onEdge(P2(g.p1)) && onEdge(P2(g.p2)) && ends(P2(g.p1), P2(g.p2)))?.id
        || this.sk.geo.find((g) => g.refKey && (g.type === 'circle' || g.type === 'arc') && be.e.type === 'circle' && onEdge(P2(g.s) || [P2(g.c)[0] + g.r, P2(g.c)[1]]) && (g.type === 'circle' || ends(P2(g.s), P2(g.e))))?.id;
      if (!id) {
        const before = new Set(this.sk.geo.map((g) => g.id));
        this.convertEdge(be.e, { construction: true });
        const made = this.sk.geo.filter((g) => !before.has(g.id) && g.type !== 'point');
        if (!made.length) return false;
        made.forEach((g) => { g.refKey = k; });
        id = made[0].id;
      }
    }
    return id;
  }
  // Fix a point on a model corner; linked (On Edge) so it follows the corner when the model changes (Options > Sketch)
  fixOnModel(pid, p2) {
    const g = this.sk.geo.find((x) => x.id === pid), mesh = this.host?.mesh;
    if (g && p2 && mesh && opt('linkConvert')) { g.onEdge = { type: 'vertex', p: this.to3(p2), bb: mesh.bbox }; this.addCons({ type: 'fix', e: pid, onEdge: true }); }
    else this.addCons({ type: 'fix', e: pid });
  }
  // Apply the snap relation to a newly created point.
  applySnap(pid, snap) {
    if (!snap?.ref) return;
    const r = snap.ref;
    if (r.kind === 'model') {
      if (r.what === 'vertex') { const p = this.sk.geo.find((g) => g.id === pid); this.fixOnModel(pid, p ? [p.x, p.y] : null); } // corner: linked
      else if (r.what !== 'edge') this.addCons({ type: 'fix', e: pid });
      return;
    }
    if (r.kind === 'point') this.addCons({ type: 'coincident', a: r.id, b: pid });
    else if (r.kind === 'mid') this.addCons({ type: 'midpoint', p: pid, l: r.id });
    else if (r.kind === 'onLine') this.addCons({ type: 'pointOnLine', p: pid, l: r.id });
    else if (r.kind === 'onCircle') this.addCons({ type: 'pointOnCircle', p: pid, c: r.id });
  }

}

// mix in methods split off into separate files
for (const M of [SketchTools, SketchDims, SketchEditing, SketchDraw, SketchText, SketchOffset]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(Sketcher.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
