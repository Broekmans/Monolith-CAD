// Sketch: drawing tools (line, arc, rect, slot, ...)
// Methods are mixed into Sketcher (see sketcher.js); `this` is the Sketcher.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { navHeld } from '../viewport.js';
import { opt } from '../app/options.js';
import { icon } from '../icons.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { niceHeight, COL, COL_LIGHT, COL_DARK, setSketchTheme, SKETCH_TOOLS, REL_DEFS, newSketch } from './sketcher.js';

export class SketchTools {
  // ---------------- tools ----------------
  setTool(id) {
    this.cancelTool();
    if (!id) { this.renderPanel(); return; }
    this.tool = { id, pts: [], snaps: [] };
    if (id === 'dimension') this.tool.picks = [];
    this.sel.clear();
    this.host.onToolChanged?.(id);
    this.renderPanel();
    this.vp.requestRender();
  }
  cancelTool() {
    const t = this.tool;
    this.tool = null;
    if (t) this.host.onToolChanged?.(null);
    this.vp.requestRender();
  }

  _bind() {
    const el = this.vp.el;
    this._down = (e) => this.onDown(e);
    this._move = (e) => this.onMove(e);
    this._up = (e) => this.onUp(e);
    this._dbl = (e) => this.onDbl(e);
    el.addEventListener('pointerdown', this._down);
    el.addEventListener('pointermove', this._move);
    el.addEventListener('pointerup', this._up);
    el.addEventListener('dblclick', this._dbl);
  }
  dispose() {
    const el = this.vp.el;
    el.removeEventListener('pointerdown', this._down);
    el.removeEventListener('pointermove', this._move);
    el.removeEventListener('pointerup', this._up);
    el.removeEventListener('dblclick', this._dbl);
    const i = this.vp.overlayDrawers.indexOf(this._drawer);
    if (i >= 0) this.vp.overlayDrawers.splice(i, 1);
    document.querySelector('.modify-box')?.remove();
    this.vp.requestRender();
  }

  onDown(e) {
    if (e.button !== 0 || e.altKey) return;
    const { p, sx, sy } = this.local(e);
    this.mouse = { p, sx, sy };
    // double-click on a dimension label = edit it, also while a tool (Smart Dimension) is active; own timing so a
    // slightly moved second click still counts (0.1.87)
    if (!this.tool?.pending) {
      const dh = this.pick(p, sx, sy, { points: false, curves: false });
      const dc = dh?.kind === 'cons' && this.sk.cons.find((x) => x.id === dh.id);
      if (dc && DIM_TYPES.has(dc.type)) {
        const now = performance.now(), last = this._dimClick;
        this._dimClick = { id: dc.id, t: now, sx, sy };
        if (last && last.id === dc.id && now - last.t < opt('dimDblClickMs') && Math.hypot(sx - last.sx, sy - last.sy) < opt('dimDblClickPx')) {
          this._dimClick = null; this.drag = null; this.editDim(dc, e.clientX, e.clientY); return;
        }
        if (this.tool) return; // a click on a label does not start a new dimension
      }
    }
    if (this.tool) { this.toolClick(p, sx, sy, e); return; }
    if (this.mirrorMode) { this.mirrorClick(p, sx, sy, e); return; }
    if (this.offsetMode) { this.offsetClick(p, sx, sy, e); return; }
    const hit = this.pick(p, sx, sy);
    if (hit) {
      const key = hit.kind + ':' + hit.id;
      if (e.ctrlKey || e.shiftKey) { if (this.sel.has(key)) this.sel.delete(key); else this.sel.add(key); }
      else if (!this.sel.has(key)) { this.sel.clear(); this.sel.add(key); }
      if (hit.kind === 'geo') this.drag = { id: hit.id, start: p, last: p, moved: false, sx, sy };
      if (hit.kind === 'cons') {
        const c = this.sk.cons.find((x) => x.id === hit.id);
        // start from where the label is drawn (it may be drawn near its geometry instead of at a stale far position)
        const shown = this._hitsBy?.get(this.vp.pane || this.vp)?.dims.find((x) => x.id === c?.id)?.L;
        const lp0 = shown && c && !c.lpUser ? (() => { const a = this.dimAnchor(c); return [shown[0] - a[0], shown[1] - a[1]]; })() : c?.lp ? [...c.lp] : [0, 0];
        if (c && DIM_TYPES.has(c.type)) this.drag = { dim: c, start: p, lp0, moved: false, sx, sy };
      }
    } else if (this.modelRefAt(p, e)) {
      // a model corner / edge was clicked: it became fixed reference geometry and was added to the selection
    } else {
      if (!e.ctrlKey && !e.shiftKey) this.sel.clear();
      this.box = { sx0: sx, sy0: sy, sx1: sx, sy1: sy };
    }
    this.vp.el.setPointerCapture(e.pointerId);
    this.renderPanel();
    this.vp.requestRender();
  }

  onMove(e) {
    const { p, sx, sy } = this.local(e);
    this.mouse = { p, sx, sy };
    if (this.drag) {
      const d = this.drag;
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < opt('skDragPx') - opt('skDragInset')) return;
      if (!d.moved) { d.moved = true; this.pushUndo(); }
      if (d.dim) {
        d.dim.lp = [d.lp0[0] + p[0] - d.start[0], d.lp0[1] + p[1] - d.start[1]]; d.dim.lpUser = true;
        this.vp.requestRender();
        return;
      }
      this.dragSolve(d, p);
      return;
    }
    if (this.box) { this.box.sx1 = sx; this.box.sy1 = sy; this.vp.requestRender(); return; }
    if (navHeld(e)) { if (this.hover || this.modelHover) { this.hover = null; this.modelHover = null; this.vp.requestRender(); } return; }
    if (this.tool) { this.toolMove(p, sx, sy); this.vp.requestRender(); return; }
    if (this.offsetMode) this.offsetHoverAt(p, sx, sy, e); // 0.1.98: chain / face under the mouse lights up (the side only changes by dragging the arrow)
    // 0.1.94: model edges / corners light up under the mouse in every sketch mode (Convert Entities: edges only)
    const conv = !!this.host.convertMode;
    const hit = conv ? null : this.pick(p, sx, sy);
    const key = hit ? hit.kind + ':' + hit.id : null;
    const mh = hit ? null : this.modelHoverAt(p, 1, conv);
    const mk = mh ? (mh.v ? 'v' + mh.v.join() : 'e' + mh.pts[0].join() + mh.pts[mh.pts.length - 1].join()) : null;
    if (key !== this.hover || mk !== this._mhKey) { this.hover = key; this.modelHover = mh; this._mhKey = mk; this.vp.requestRender(); }
    this.host.setCoords?.(p);
  }

  onUp(e) {
    if (e.button !== 0) return;
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (d.moved && !d.dim) this.resolve(true);
      else this.vp.requestRender();
      if (d.moved && d.dim) this.host.onSketchChanged?.(this);
      return;
    }
    if (this.box) {
      const b = this.box; this.box = null;
      const x0 = Math.min(b.sx0, b.sx1), x1 = Math.max(b.sx0, b.sx1), y0 = Math.min(b.sy0, b.sy1), y1 = Math.max(b.sy0, b.sy1);
      const minBox = opt('boxSelectMinPx');
      if (x1 - x0 > minBox || y1 - y0 > minBox) {
        const crossing = b.sx1 < b.sx0; // right-to-left selects touching
        for (const g of this.sk.geo) {
          if (g.origin) continue;
          const c = this.curveOf(g);
          const pts = g.type === 'point' ? [[g.x, g.y]] : g.type === 'text' ? this.textPolys(g).flat() : sampleCurve(c, 24);
          if (!pts.length) continue;
          const scr = pts.map((q) => this.scr(q));
          const inside = scr.map(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
          if (crossing ? inside.some(Boolean) : inside.every(Boolean)) this.sel.add('geo:' + g.id);
        }
        this.renderPanel();
      }
      this.vp.requestRender();
      return;
    }
    if (this.tool) this.toolUp?.(e);
  }

  onDbl(e) {
    if (this._dimClick === null && document.querySelector('.modify-box')) return; // already opened by onDown
    const { p, sx, sy } = this.local(e);
    if (this.tool && (this.tool.id === 'line' || this.tool.id === 'centerline')) { this.tool.pts = []; this.tool.snaps = []; this.vp.requestRender(); return; }
    if (this.tool) return;
    const th = this.pick(p, sx, sy, { points: false, dims: false });
    if (th && this.G(th.id)?.type === 'text') { this.sel.clear(); this.sel.add('geo:' + th.id); this.renderPanel(); setTimeout(() => this.host.sketchPanel?.querySelector('textarea')?.focus(), 0); return; }
    const hit = this.pick(p, sx, sy, { points: false, curves: false });
    if (hit?.kind === 'cons') {
      const c = this.sk.cons.find((x) => x.id === hit.id);
      if (c && DIM_TYPES.has(c.type)) this.editDim(c, e.clientX, e.clientY);
    }
  }

  // Dragging with temporary solver constraints.
  dragSolve(d, p) {
    const g = this.G(d.id);
    const delta = [p[0] - d.last[0], p[1] - d.last[1]];
    d.last = p;
    const drag = [];
    if (g.type === 'point') drag.push({ kind: 'point', id: g.id, x: p[0], y: p[1] });
    else if (g.type === 'text') { const q = this.G(g.p); drag.push({ kind: 'point', id: g.p, x: q.x + delta[0], y: q.y + delta[1] }); }
    else if (g.type === 'line') {
      for (const pid of [g.p1, g.p2]) { const q = this.G(pid); drag.push({ kind: 'point', id: pid, x: q.x + delta[0], y: q.y + delta[1] }); }
    } else {
      const c = this.G(g.c);
      drag.push({ kind: 'radius', id: g.id, arc: g.type === 'arc', r: Math.max(opt('geomEps'), dist(p, [c.x, c.y])) });
    }
    const backup = JSON.stringify(this.sk.geo);
    const r = solve(this.sk, { drag });
    if (!r.ok) this.sk.geo = JSON.parse(backup);
    this.host.onSketchChanged?.(this, true);
    this.vp.requestRender();
  }

  toolMove(p) {
    const t = this.tool;
    const from = t.pts.length ? t.pts[t.pts.length - 1] : null;
    t.snap = t.id === 'trim' || t.id === 'dimension' ? null : this.snap(p, { from: t.id === 'line' || t.id === 'centerline' || (t.id === 'slot' && t.pts.length === 1) ? from : null });
    t.cursor = t.snap ? t.snap.pt : p;
    if (t.id === 'dimension' && t.pending) t.pending.lpAbs = p;
    if (t.id === 'trim' || (t.id === 'dimension' && !t.pending)) {
      const hit = this.pick(p, this.mouse.sx, this.mouse.sy, { points: t.id === 'dimension', dims: false });
      this.hover = hit ? 'geo:' + hit.id : null;
    }
    // Smart Dimension: a model edge / corner that would be picked is highlighted (0.1.88)
    this.modelHover = null;
    if (t.id === 'dimension' && t.pending && t.picks?.length === 1) { // second pick: a sketch entity or a model edge
      const hit = this.pick(p, this.mouse.sx, this.mouse.sy, { dims: false });
      this.hover = hit && hit.id !== t.picks[0] ? 'geo:' + hit.id : null;
    }
    if (t.id === 'dimension' && !this.hover && (!t.pending || t.picks?.length === 1)) this.modelHover = this.modelHoverAt(p, 1);
    // other drawing tools: the model edge / corner under the cursor (what the cursor snaps / relates to)
    else if (t.id !== 'dimension' && t.id !== 'trim' && !this.hover) this.modelHover = this.modelHoverAt(p, 1);
  }

  toolClick(p, sx, sy, e) {
    const t = this.tool;
    const snap = t.id === 'trim' || t.id === 'dimension' ? null : this.snap(p, { from: ((t.id === 'line' || t.id === 'centerline') && t.pts.length) || (t.id === 'slot' && t.pts.length === 1) ? t.pts[t.pts.length - 1] : null });
    const q = snap ? snap.pt : p;
    switch (t.id) {
      case 'line': case 'centerline': {
        if (!t.pts.length) { t.pts.push(q); t.snaps.push(snap); t.downAt = { sx, sy }; return; }
        this.pushUndo();
        const a = t.pts[t.pts.length - 1];
        if (dist(a, q) < opt('geomEpsTiny')) return;
        const ln = this.addLine(a, q, t.id === 'centerline');
        // relations: start
        if (t.prevEnd) this.addCons({ type: 'coincident', a: t.prevEnd, b: ln.p1 });
        else this.applySnap(ln.p1, t.snaps[t.snaps.length - 1]);
        this.applySnap(ln.p2, snap);
        if (snap?.hv === 'h') this.addCons({ type: 'horizontal', l: ln.id });
        if (snap?.hv === 'v') this.addCons({ type: 'vertical', l: ln.id });
        t.prevEnd = ln.p2;
        t.pts.push(q); t.snaps.push(snap);
        this.resolve(true);
        // closing onto an existing point ends the chain (SolidWorks behaviour)
        if (snap?.ref?.kind === 'point') { t.pts = []; t.snaps = []; t.prevEnd = null; }
        return;
      }
      case 'rect': case 'centerRect': {
        if (!t.pts.length) { t.pts.push(q); t.snaps.push(snap); return; }
        this.pushUndo();
        let a = t.pts[0], b = q;
        if (t.id === 'centerRect') { const c = t.pts[0]; a = [2 * c[0] - q[0], 2 * c[1] - q[1]]; b = q; }
        const corners = [a, [b[0], a[1]], b, [a[0], b[1]]];
        const lines = corners.map((c, i) => this.addLine(c, corners[(i + 1) % 4]));
        for (let i = 0; i < 4; i++) this.addCons({ type: 'coincident', a: lines[i].p2, b: lines[(i + 1) % 4].p1 });
        this.addCons({ type: 'horizontal', l: lines[0].id }); this.addCons({ type: 'horizontal', l: lines[2].id });
        this.addCons({ type: 'vertical', l: lines[1].id }); this.addCons({ type: 'vertical', l: lines[3].id });
        if (t.id === 'rect') { this.applySnap(lines[0].p1, t.snaps[0]); this.applySnap(lines[2].p1, snap); }
        else {
          const d1 = this.addLine(corners[0], corners[2], true), d2 = this.addLine(corners[1], corners[3], true);
          this.addCons({ type: 'coincident', a: d1.p1, b: lines[0].p1 }); this.addCons({ type: 'coincident', a: d1.p2, b: lines[2].p1 });
          this.addCons({ type: 'coincident', a: d2.p1, b: lines[1].p1 }); this.addCons({ type: 'coincident', a: d2.p2, b: lines[3].p1 });
          const cp = this.addPoint(t.pts[0][0], t.pts[0][1]);
          this.addCons({ type: 'midpoint', p: cp, l: d1.id });
          this.applySnap(cp, t.snaps[0]);
        }
        t.pts = []; t.snaps = [];
        this.resolve(true);
        return;
      }
      case 'circle': {
        if (!t.pts.length) { t.pts.push(q); t.snaps.push(snap); return; }
        const r = dist(t.pts[0], q);
        if (r < opt('geomEpsTiny')) return;
        this.pushUndo();
        const c = this.addPoint(t.pts[0][0], t.pts[0][1]);
        const g = { id: this.gid(), type: 'circle', c, r };
        this.sk.geo.push(g);
        this.applySnap(c, t.snaps[0]);
        if (snap?.ref?.kind === 'point') this.addCons({ type: 'pointOnCircle', p: snap.ref.id, c: g.id });
        t.pts = []; t.snaps = [];
        this.resolve(true);
        return;
      }
      case 'arc': {
        t.pts.push(q); t.snaps.push(snap);
        if (t.pts.length === 2) { t.sweep = 0; t.lastAng = Math.atan2(q[1] - t.pts[0][1], q[0] - t.pts[0][0]); }
        if (t.pts.length < 3) return;
        this.pushUndo();
        const [c, s] = t.pts;
        const r = dist(c, s);
        const ae = Math.atan2(q[1] - c[1], q[0] - c[0]);
        const e2 = [c[0] + r * Math.cos(ae), c[1] + r * Math.sin(ae)];
        const ccw = (t.sweep ?? 1) >= 0;
        this.makeArc(c, ccw ? s : e2, ccw ? e2 : s, r, [t.snaps[0], ccw ? t.snaps[1] : snap, ccw ? snap : t.snaps[1]]);
        t.pts = []; t.snaps = [];
        this.resolve(true);
        return;
      }
      case 'arc3': {
        t.pts.push(q); t.snaps.push(snap);
        if (t.pts.length < 3) return;
        const [a, b, m] = t.pts;
        const cc = circleFrom3(a, m, b);
        if (!cc) { t.pts.pop(); t.snaps.pop(); return; }
        this.pushUndo();
        const ccw = cross2([m[0] - a[0], m[1] - a[1]], [b[0] - a[0], b[1] - a[1]]) < 0;
        this.makeArc(cc.c, ccw ? a : b, ccw ? b : a, cc.r, [null, ccw ? t.snaps[0] : t.snaps[1], ccw ? t.snaps[1] : t.snaps[0]]);
        t.pts = []; t.snaps = [];
        this.resolve(true);
        return;
      }
      case 'tangentArc': {
        if (!t.pts.length) {
          if (snap?.ref?.kind !== 'point') { toast('Start the tangent arc on the endpoint of a line or arc'); return; }
          const owner = this.sk.geo.find((g) => (g.type === 'line' && (g.p1 === snap.ref.id || g.p2 === snap.ref.id)) || (g.type === 'arc' && (g.s === snap.ref.id || g.e === snap.ref.id)));
          if (!owner) { toast('Start the tangent arc on the endpoint of a line or arc'); return; }
          t.owner = owner; t.startPt = snap.ref.id;
          t.tan = this.tangentAt(owner, snap.ref.id);
          t.pts.push(q); t.snaps.push(snap);
          return;
        }
        const arc = this.tangentArcGeom(t.pts[0], t.tan, q);
        if (!arc) return;
        this.pushUndo();
        const g = this.makeArc(arc.c, arc.ccw ? t.pts[0] : q, arc.ccw ? q : t.pts[0], arc.r, [null, null, null]);
        const startId = arc.ccw ? g.s : g.e, endId = arc.ccw ? g.e : g.s;
        this.addCons({ type: 'coincident', a: t.startPt, b: startId });
        this.addCons({ type: 'tangent', a: t.owner.id, b: g.id });
        this.applySnap(endId, snap);
        this.tool = { id: 'tangentArc', pts: [], snaps: [] };
        this.resolve(true);
        return;
      }
      case 'slot': {
        t.pts.push(q); t.snaps.push(snap);
        if (t.pts.length < 3) return;
        const [c1, c2] = t.pts;
        const L = dist(c1, c2);
        if (L < opt('geomEpsTiny')) { t.pts = []; return; }
        const u = [(c2[0] - c1[0]) / L, (c2[1] - c1[1]) / L], n = [-u[1], u[0]];
        const r = Math.max(opt('geomEps'), Math.abs((q[0] - c1[0]) * n[0] + (q[1] - c1[1]) * n[1]));
        this.pushUndo();
        const P = (c, s) => [c[0] + n[0] * r * s, c[1] + n[1] * r * s];
        const top = this.addLine(P(c1, 1), P(c2, 1)), bot = this.addLine(P(c2, -1), P(c1, -1));
        const a2 = this.makeArc(c2, P(c2, -1), P(c2, 1), r, [t.snaps[1], null, null]);
        const a1 = this.makeArc(c1, P(c1, 1), P(c1, -1), r, [t.snaps[0], null, null]);
        this.addCons({ type: 'coincident', a: top.p2, b: a2.e }); this.addCons({ type: 'coincident', a: a2.s, b: bot.p1 });
        this.addCons({ type: 'coincident', a: bot.p2, b: a1.e }); this.addCons({ type: 'coincident', a: a1.s, b: top.p1 });
        // non-redundant set (keeps the slot draggable): endpoint tangency at all 4 joints + top ∥ bottom
        const cl = this.addLine(c1, c2, true);
        this.addCons({ type: 'coincident', a: cl.p1, b: a1.c }); this.addCons({ type: 'coincident', a: cl.p2, b: a2.c });
        for (const [l, pid, a] of [[top, top.p1, a1], [top, top.p2, a2], [bot, bot.p1, a2], [bot, bot.p2, a1]]) this.addCons({ type: 'tangentEnd', l: l.id, p: pid, c: a.id });
        this.addCons({ type: 'parallel', a: top.id, b: bot.id });
        if (Math.abs(u[1]) < opt('skSlotHVTol')) this.addCons({ type: 'horizontal', l: cl.id });
        else if (Math.abs(u[0]) < opt('skSlotHVTol')) this.addCons({ type: 'vertical', l: cl.id });
        t.pts = []; t.snaps = [];
        this.resolve(true);
        return;
      }
      case 'point': {
        this.pushUndo();
        const id = this.addPoint(q[0], q[1]);
        this.applySnap(id, snap);
        this.resolve(true);
        return;
      }
      case 'text': {
        this.pushUndo();
        const pid = this.addPoint(q[0], q[1]);
        this.applySnap(pid, snap);
        const g = { id: this.gid(), type: 'text', p: pid, text: 'Text', h: niceHeight(this.px * opt('skTextHeightPx')), font: this.lastFont || opt('skTextFont'), rot: 0, align: 'left', tol: opt('skTextArcTol'), outline: [] };
        this.sk.geo.push(g);
        this.setTool(null);
        this.sel.clear(); this.sel.add('geo:' + g.id);
        this.resolve(true);
        (this.lastFont ? Promise.resolve(this.lastFont) : preferredFont()).then((f) => { g.font = f; this.updateText(g); });
        setTimeout(() => this.host.sketchPanel?.querySelector('textarea')?.select(), opt('skTextFocusMs'));
        return;
      }
      case 'trim': {
        const hit = this.pick(p, sx, sy, { points: false, dims: false });
        if (hit) this.trimAt(hit.id, p);
        return;
      }
      case 'dimension': this.dimClick(p, sx, sy, e); return;
      default:
    }
  }

  makeArc(c, s, e, r, snaps) {
    const cid = this.addPoint(c[0], c[1]), sid = this.addPoint(s[0], s[1]), eid = this.addPoint(e[0], e[1]);
    const g = { id: this.gid(), type: 'arc', c: cid, s: sid, e: eid, r };
    this.sk.geo.push(g);
    if (snaps) { this.applySnap(cid, snaps[0]); this.applySnap(sid, snaps[1]); this.applySnap(eid, snaps[2]); }
    return g;
  }

  tangentAt(owner, pid) {
    if (owner.type === 'line') {
      const a = this.P(owner.p1), b = this.P(owner.p2);
      const d = owner.p2 === pid ? [b[0] - a[0], b[1] - a[1]] : [a[0] - b[0], a[1] - b[1]];
      const L = Math.hypot(d[0], d[1]) || 1;
      return [d[0] / L, d[1] / L];
    }
    const c = this.P(owner.c), p = this.P(pid);
    const rad = [p[0] - c[0], p[1] - c[1]];
    // CCW arc: tangent at end is +90deg of radius, at start it's -90deg (leaving)
    let t = owner.e === pid ? [-rad[1], rad[0]] : [rad[1], -rad[0]];
    const L = Math.hypot(t[0], t[1]) || 1;
    t = [t[0] / L, t[1] / L];
    return t;
  }
  tangentArcGeom(p, tan, q) {
    const n = [-tan[1], tan[0]];
    const d = [q[0] - p[0], q[1] - p[1]];
    const dn = d[0] * n[0] + d[1] * n[1];
    if (Math.abs(dn) < opt('geomEpsTiny')) return null;
    const tt = (d[0] * d[0] + d[1] * d[1]) / (2 * dn);
    const c = [p[0] + n[0] * tt, p[1] + n[1] * tt];
    return { c, r: Math.abs(tt), ccw: tt > 0 };
  }

}
