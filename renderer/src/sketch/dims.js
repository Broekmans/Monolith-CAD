// Sketch: smart dimension
// Methods are mixed into Sketcher (see sketcher.js); `this` is the Sketcher.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { icon } from '../icons.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { niceHeight, COL, COL_LIGHT, COL_DARK, setSketchTheme, SKETCH_TOOLS, REL_DEFS, newSketch } from './sketcher.js';

export class SketchDims {
  // ---------------- smart dimension ----------------
  dimClick(p, sx, sy, e) {
    const t = this.tool;
    const hit = this.pick(p, sx, sy, { dims: false });
    if (t.pending) {
      // a second entity combines with the first instead of placing
      if (hit && hit.kind === 'geo' && t.picks.length === 1 && hit.id !== t.picks[0] && this.canCombine(t.picks[0], hit.id)) {
        t.picks.push(hit.id); t.pending = this.makePendingDim(t.picks, p); return;
      }
      this.placeDim(t.pending, p, e);
      t.picks = []; t.pending = null;
      return;
    }
    if (!hit || hit.kind !== 'geo' || this.G(hit.id)?.type === 'text') return;
    t.picks.push(hit.id);
    const pd = this.makePendingDim(t.picks, p);
    if (pd) t.pending = pd;
  }
  canCombine(a, b) {
    return !!(this.G(a) && this.G(b));
  }
  makePendingDim(picks, p) {
    const gs = picks.map((id) => this.G(id));
    if (gs.length === 1) {
      const g = gs[0];
      if (g.type === 'circle') return { type: 'diameter', c: g.id, lpAbs: p };
      if (g.type === 'arc') return { type: 'radius', c: g.id, lpAbs: p };
      if (g.type === 'line') return { type: 'length', l: g.id, a: g.p1, b: g.p2, lpAbs: p, auto: true };
      return null; // a point waits for a second pick
    }
    let [a, b] = gs;
    const ctr = (g) => (g.type === 'circle' || g.type === 'arc' ? g.c : g.id);
    if (a.type === 'line' && b.type === 'line') {
      const da = this.dirOf(a), db = this.dirOf(b);
      if (Math.abs(cross2(da, db)) < 1e-6) return { type: 'pointLine', p: b.p1, l: a.id, lpAbs: p };
      return { type: 'angle', a: a.id, b: b.id, lpAbs: p };
    }
    if (a.type === 'line') [a, b] = [b, a];
    if (b.type === 'line') return { type: 'pointLine', p: ctr(a), l: b.id, lpAbs: p };
    return { type: 'distance', a: ctr(a), b: ctr(b), lpAbs: p, auto: true };
  }
  dirOf(l) { const a = this.P(l.p1), b = this.P(l.p2); const L = dist(a, b) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; }

  // Pick aligned/horizontal/vertical based on where the label sits (SolidWorks behaviour).
  autoType(pd) {
    if (!pd.auto) return pd.type;
    const a = this.P(pd.a), b = this.P(pd.b), m = pd.lpAbs;
    const xmin = Math.min(a[0], b[0]), xmax = Math.max(a[0], b[0]), ymin = Math.min(a[1], b[1]), ymax = Math.max(a[1], b[1]);
    const inX = m[0] > xmin && m[0] < xmax, inY = m[1] > ymin && m[1] < ymax;
    if (Math.abs(a[1] - b[1]) < 1e-9 || Math.abs(a[0] - b[0]) < 1e-9) return pd.type;
    if (inX && !inY) return 'hdist';
    if (inY && !inX) return 'vdist';
    return pd.type;
  }

  dimAnchor(c) {
    const P = (id) => this.P(id);
    switch (c.type) {
      case 'length': { const l = this.G(c.l); const a = P(l.p1), b = P(l.p2); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
      case 'distance': case 'hdist': case 'vdist': { const a = P(c.a), b = P(c.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
      case 'pointLine': return P(c.p);
      case 'radius': case 'diameter': return P(this.G(c.c).c);
      case 'angle': {
        const la = this.G(c.a), lb = this.G(c.b);
        const X = lineLine(P(la.p1), P(la.p2), P(lb.p1), P(lb.p2), { segA: false, segB: false })[0];
        return X || P(la.p1);
      }
      default: return [0, 0];
    }
  }

  placeDim(pd, p) {
    const type = this.autoType(pd);
    let c;
    if (pd.type === 'length') c = type === 'length' ? { type, l: pd.l } : { type, a: pd.a, b: pd.b };
    else if (pd.type === 'distance') c = { type, a: pd.a, b: pd.b };
    else { c = { ...pd }; delete c.lpAbs; delete c.auto; }
    if (type === 'hdist' || type === 'vdist') {
      const a = this.P(c.a), b = this.P(c.b);
      const d = type === 'hdist' ? b[0] - a[0] : b[1] - a[1];
      c.sign = d >= 0 ? 1 : -1;
    }
    if (type === 'angle') {
      const la = this.G(c.a), lb = this.G(c.b);
      const d1 = this.dirOf(la), d2 = this.dirOf(lb);
      let raw = Math.atan2(d2[1], d2[0]) - Math.atan2(d1[1], d1[0]);
      raw = Math.atan2(Math.sin(raw), Math.cos(raw));
      c.sign = raw >= 0 ? 1 : -1;
    }
    this.pushUndo();
    c.value = measure(this.sk, c);
    const anchor = this.dimAnchor(c);
    c.lp = [p[0] - anchor[0], p[1] - anchor[1]];
    const added = this.addCons(c);
    const r = solve(this.sk);
    const bad = (list) => (list || []).some((id) => id === added.id || id.startsWith(added.id + '#'));
    if (!r.ok || bad(r.conflicting) || bad(r.redundant) || (r.conflicting.length && !this.state.conflicting.length)) {
      added.driving = false;
      toast('This dimension would over-define the sketch, so it was added as a driven (reference) dimension.', 'warn', 5000);
      this.resolve(true);
      return;
    }
    this.resolve(true);
    const [sx, sy] = this.scr(p);
    const rect = this.vp.el.getBoundingClientRect();
    this.editDim(added, rect.left + sx + 12, rect.top + sy + 12, true);
  }

  editDim(c, x, y, fresh = false) {
    if (c.driving === false) { toast('Driven (reference) dimensions show a measured value and cannot be modified.'); return; }
    const isAngle = c.type === 'angle';
    const before = JSON.stringify(this.sk);
    if (!fresh) this.pushUndo();
    modifyBox(x, y, fmt(c.value, 4), {
      title: (c.name || 'D' + c.id.slice(1)) + '@' + this.sk.name, unit: isAngle ? '°' : 'mm',
      onLive: (v) => {
        if (!(v > 0) && !isAngle) return;
        const live = this.sk.cons.find((k) => k.id === c.id);
        if (!live) return;
        live.value = v;
        const r = solve(this.sk);
        if (!r.ok) this.sk = JSON.parse(before);
        this.host.onSketchChanged?.(this, true); this.vp.requestRender();
      },
      onApply: (v) => {
        if (!(v > 0) && !isAngle) { toast('Value must be positive', 'error'); this.sk = JSON.parse(before); this.resolve(true); return; }
        const live = this.sk.cons.find((k) => k.id === c.id) || c;
        live.value = v;
        const r = solve(this.sk);
        if (!r.ok) { toast('That value cannot be solved with the current relations.', 'error'); this.sk = JSON.parse(before); }
        this.resolve(true);
      },
      onCancel: () => { this.sk = JSON.parse(before); this.resolve(true); },
    });
  }

}
