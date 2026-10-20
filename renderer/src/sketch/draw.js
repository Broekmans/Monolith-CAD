// Sketch: side panel and canvas drawing
// Methods are mixed into Sketcher (see sketcher.js); `this` is the Sketcher.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { icon } from '../icons.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { COL_DARK_FREE } from './sketcher.js';
import { opt } from '../app/options.js';
import { niceHeight, COL, COL_LIGHT, COL_DARK, setSketchTheme, SKETCH_TOOLS, REL_DEFS, newSketch, relDef } from './sketcher.js';

export class SketchDraw {
  // ---------------- panel ----------------
  renderPanel() {
    const panel = this.host.sketchPanel;
    if (!panel) return;
    panel.innerHTML = '';
    const st = this.statusText();
    this.host.setSketchStatus?.(st);
    if (this.mirrorMode) {
      const m = this.mirrorMode, n = this.selectedGeo().length;
      panel.append(h('div', { class: 'sp-tool' }, h('span', { class: 'ico', html: icon('mirror') }), h('b', {}, 'Mirror Entities')));
      panel.append(h('div', { class: 'sp-hint' }, m.step === 1
        ? `Step 1 of 2: click the entities to mirror (${n} selected), then click Next or press Enter.`
        : `Step 2 of 2: click the mirror line — a line, centerline or straight model edge. (${n} entities)`));
            if (m.step === 1) panel.append(h('button', { class: 'sp-btn', onclick: () => this.mirrorNext() }, 'Next (Enter)'));
      else panel.append(h('button', { class: 'sp-btn', onclick: () => { m.step = 1; this.renderPanel(); } }, 'Back'));
      panel.append(h('button', { class: 'sp-btn', onclick: () => this.endMirror() }, 'Cancel (Esc)'));
      return;
    }
    if (this.tool) {
      const def = SKETCH_TOOLS.find((t) => t.id === this.tool.id);
      const hints = {
        line: 'Click to place points. Lines chain together; double-click or Esc to finish. Snaps add coincident, midpoint, horizontal and vertical relations automatically.',
        centerline: 'Click two points for a construction line. Use it as a revolve axis or for symmetry.',
        rect: 'Click two opposite corners.', centerRect: 'Click the center, then a corner.',
        circle: 'Click the center, then a point on the circle.', arc: 'Click the center, the start point, then the end point.',
        arc3: 'Click the start point, the end point, then a point on the arc.',
        tangentArc: 'Click the endpoint of a line or arc, then the arc end.', slot: 'Click both slot centers, then the width.',
        point: 'Click to place sketch points.', trim: 'Click the segment of an entity to remove it up to the nearest intersections.',
        dimension: 'Select an entity (or two) and click to place the dimension. Placement decides horizontal / vertical / aligned.',
      };
      panel.append(h('div', { class: 'sp-tool' }, h('span', { class: 'ico', html: icon(def.icon) }), h('b', {}, def.label)),
        h('div', { class: 'sp-hint' }, hints[this.tool.id] || ''),
        h('button', { class: 'sp-btn', onclick: () => this.setTool(null) }, 'Done (Esc)'));
      return;
    }
    const gs = this.selectedGeo(), cs = this.selectedCons();
    if (!gs.length && !cs.length) {
      panel.append(h('div', { class: 'sp-hint' }, 'Select sketch entities to see their properties and add relations. Drag geometry to see how it is constrained. Double-click a dimension to change its value.'));
      return;
    }
    if (gs.length) {
      if (gs.length === 1 && gs[0].type === 'text') { panel.append(...this.textPanel(gs[0])); panel.append(h('button', { class: 'sp-btn danger', onclick: () => this.deleteSelection() }, h('span', { class: 'ico sm', html: icon('delete') }), 'Delete (Del)')); return; }
      panel.append(h('div', { class: 'sp-sec' }, 'Selected Entities'),
        h('div', { class: 'sp-list' }, gs.map((g) => h('div', { class: 'sp-item' }, this.geoLabel(g)))));
      const existing = this.sk.cons.filter((c) => !DIM_TYPES.has(c.type) && gs.some((g) => [c.a, c.b, c.p, c.l, c.c, c.e].includes(g.id)));
      panel.append(h('div', { class: 'sp-sec' }, 'Existing Relations'),
        h('div', { class: 'sp-list' }, existing.length ? existing.map((c) => h('div', { class: 'sp-item rel' },
          h('span', { class: 'ico sm', html: icon(relDef(c)?.icon || 'relation') }), h('span', {}, `${relDef(c)?.label || c.type}${this.state.conflicting.includes(c.id) ? ' (conflict)' : ''}`),
          h('button', { class: 'x', title: 'Delete relation', onclick: () => { this.pushUndo(); this.sk.cons = this.sk.cons.filter((k) => k.id !== c.id); this.resolve(true); } }, '×'))) : h('div', { class: 'sp-empty' }, 'None')));
      const rels = this.applicableRelations();
      panel.append(h('div', { class: 'sp-sec' }, 'Add Relations'),
        h('div', { class: 'sp-rels' }, rels.map((r) => h('button', { class: 'sp-rel', title: REL_DEFS[r].label, onclick: () => this.addRelation(r) },
          h('span', { class: 'ico', html: icon(REL_DEFS[r].icon) }), h('span', {}, REL_DEFS[r].label)))));
      if (gs.some((g) => g.type !== 'point')) {
        const cb = h('input', { type: 'checkbox', checked: gs.filter((g) => g.type !== 'point').every((g) => g.construction) });
        cb.addEventListener('change', () => this.toggleConstruction());
        panel.append(h('div', { class: 'sp-sec' }, 'Options'), h('label', { class: 'pm-check' }, cb, 'For construction'));
      }
      if (gs.length === 1 && gs[0].type === 'text') panel.append(...this.textPanel(gs[0]));
      else if (gs.length === 1) panel.append(...this.paramsFor(gs[0]));
    }
    if (cs.length) {
      panel.append(h('div', { class: 'sp-sec' }, 'Selected Relations / Dimensions'),
        h('div', { class: 'sp-list' }, cs.map((c) => h('div', { class: 'sp-item' }, DIM_TYPES.has(c.type) ? `${c.type} = ${fmt(measure(this.sk, c), 3)}${c.driving === false ? ' (driven)' : ''}` : relDef(c)?.label || c.type))));
      const dims = cs.filter((c) => DIM_TYPES.has(c.type));
      if (dims.length === 1) {
        const c = dims[0];
        const cb = h('input', { type: 'checkbox', checked: c.driving === false });
        cb.addEventListener('change', () => {
          this.pushUndo(); c.driving = cb.checked ? false : true;
          if (c.driving) { c.value = measure(this.sk, c); const r = solve(this.sk); if (!r.ok || r.conflicting.length) { c.driving = false; toast('Making this dimension driving would over-define the sketch.', 'error'); } }
          this.resolve(true);
        });
        panel.append(h('label', { class: 'pm-check' }, cb, 'Driven (reference)'));
      }
    }
    panel.append(h('button', { class: 'sp-btn danger', onclick: () => this.deleteSelection() }, h('span', { class: 'ico sm', html: icon('delete') }), 'Delete (Del)'));
  }
  geoLabel(g) {
    if (g.origin) return 'Origin';
    const n = { point: 'Point', line: g.construction ? 'Centerline' : 'Line', circle: 'Circle', arc: 'Arc', text: 'Text' }[g.type];
    return `${n}${g.id.slice(1)}`;
  }
  paramsFor(g) {
    const rows = [];
    const row = (k, v) => h('div', { class: 'sp-param' }, h('span', {}, k), h('b', {}, v));
    if (g.type === 'point') rows.push(row('X', fmt(g.x, 3)), row('Y', fmt(g.y, 3)));
    if (g.type === 'line') {
      const a = this.P(g.p1), b = this.P(g.p2);
      rows.push(row('Length', fmt(dist(a, b), 3)), row('Angle', fmt((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, 2) + '°'));
    }
    if (g.type === 'circle' || g.type === 'arc') { const c = this.P(g.c); rows.push(row('Radius', fmt(g.r, 3)), row('Center', `${fmt(c[0], 3)}, ${fmt(c[1], 3)}`)); }
    return [h('div', { class: 'sp-sec' }, 'Parameters'), ...rows];
  }

  // ---------------- drawing ----------------
  colorFor(g) {
    const key = 'geo:' + g.id;
    if (this.sel.has(key)) return COL.sel;
    if (this.hover === key) return COL.hover;
    if (this.state.conflicting.length && this.sk.cons.some((c) => this.state.conflicting.includes(c.id) && [c.a, c.b, c.p, c.l, c.c].includes(g.id))) return COL.over;
    if (g.construction) return COL.construction;
    return this.under.has(g.id) ? COL.under : COL.defined;
  }

  // true when a face of the part body lies in the sketch plane (sketch drawn on a light face)
  onPartFace() {
    const m = this.host.mesh;
    if (this._ofMesh === m) return this._onFace;
    const { n, o } = this.fr, d0 = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
    this._ofMesh = m;
    this._onFace = !!m?.faces?.some((f) => {
      const pl = f.plane; const fn = pl?.normal; if (!fn) return false;
      const dt = n[0] * fn[0] + n[1] * fn[1] + n[2] * fn[2];
      if (Math.abs(dt) < opt('skCoplanarDot')) return false;
      const fo = pl.origin || f.c; return Math.abs(Math.sign(dt) * (fn[0] * fo[0] + fn[1] * fo[1] + fn[2] * fo[2]) - d0) < opt('skInPlaneTol');
    });
    return this._onFace;
  }
  draw(ctx) {
    const free = document.body.classList.contains('dark') && !this.onPartFace();
    if (!free) return this._draw(ctx);
    const saved = { ...COL }; Object.assign(COL, COL_DARK_FREE);
    if (/^#(000000|111111)$/i.test(saved.defined)) COL.defined = opt('skDefinedDark'); // black would vanish on the dark background
    try { return this._draw(ctx); } finally { Object.assign(COL, saved); }
  }
  _draw(ctx) {
    const scr = (p) => this.scr(p);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // origin
    const o = scr([0, 0]);
    ctx.strokeStyle = COL.origin; ctx.fillStyle = COL.origin; ctx.lineWidth = opt('skOriginLineW');
    const oLen = opt('skOriginLenPx'), oHead = opt('skOriginHeadPx'), oAng = opt('skOriginHeadAngle');
    const ax = scr([1, 0]), ay = scr([0, 1]);
    const ux = [ax[0] - o[0], ax[1] - o[1]], uy = [ay[0] - o[0], ay[1] - o[1]];
    const nl = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L * oLen, v[1] / L * oLen]; };
    for (const v of [nl(ux), nl(uy)]) {
      ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(o[0] + v[0], o[1] + v[1]); ctx.stroke();
      const a = Math.atan2(v[1], v[0]);
      ctx.beginPath(); ctx.moveTo(o[0] + v[0], o[1] + v[1]);
      ctx.lineTo(o[0] + v[0] - oHead * Math.cos(a - oAng), o[1] + v[1] - oHead * Math.sin(a - oAng));
      ctx.lineTo(o[0] + v[0] - oHead * Math.cos(a + oAng), o[1] + v[1] - oHead * Math.sin(a + oAng)); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(o[0], o[1], opt('skOriginDotPx'), 0, TAU); ctx.fill();

    // curves (model references made by clicking an edge are invisible links; drawn only while selected)
    const hid = this.hiddenIds();
    const nSamp = opt('skCurveSamples'), lwSel = opt('skLineWSel'), lwHov = opt('skLineWHover'), lw = opt('skLineW'), cDash = opt('skConstructionDash');
    for (const g of this.sk.geo) {
      if (g.type === 'point') continue;
      if (hid.has(g.id) && !this.sel.has('geo:' + g.id)) continue;
      if (g.type === 'text') { this.drawText(ctx, g, scr); continue; }
      const c = this.curveOf(g);
      if (!c) continue;
      const pts = sampleCurve(c, nSamp).map(scr);
      ctx.strokeStyle = this.colorFor(g);
      ctx.lineWidth = this.sel.has('geo:' + g.id) ? lwSel : this.hover === 'geo:' + g.id ? lwHov : lw; // selected a bit thicker (fully defined is blue too)
      ctx.setLineDash(g.construction ? cDash : []);
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke();
    }
    ctx.setLineDash([]);
    // points
    const rSel = opt('skPointRSel'), rIso = opt('skPointRIsolated'), rPt = opt('skPointR'), cm = opt('skCenterMarkPx');
    for (const g of this.sk.geo) {
      if (g.type !== 'point' || g.origin) continue;
      if (hid.has(g.id) && !this.sel.has('geo:' + g.id)) continue;
      const q = scr([g.x, g.y]);
      const key = 'geo:' + g.id;
      const isolated = !this.sk.geo.some((o) => o.type !== 'point' && [o.p1, o.p2, o.c, o.s, o.e, o.p].includes(g.id));
      const isCenter = this.sk.geo.some((o) => o.c === g.id);
      ctx.fillStyle = this.sel.has(key) ? COL.sel : this.hover === key ? COL.hover : this.under.has(g.id) ? COL.under : COL.defined;
      const r = this.sel.has(key) || this.hover === key ? rSel : isolated ? rIso : rPt;
      if (isCenter) { ctx.lineWidth = 1; ctx.strokeStyle = ctx.fillStyle; ctx.beginPath(); ctx.moveTo(q[0] - cm, q[1]); ctx.lineTo(q[0] + cm, q[1]); ctx.moveTo(q[0], q[1] - cm); ctx.lineTo(q[0], q[1] + cm); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, TAU); ctx.fill(); }
    }
    // dimensions and relation glyphs
    // label / glyph hit boxes per view pane (draw runs once per pane; the pane under the mouse is used for picking)
    const H = { dims: [], glyphs: [] };
    (this._hitsBy ||= new WeakMap()).set(this.vp.pane || this.vp, H);
    this.dimHits = H.dims;
    this.glyphHits = H.glyphs;
    for (const c of this.sk.cons) if (DIM_TYPES.has(c.type)) this.drawDim(ctx, c);
    if (this.showRelations) this.drawGlyphs(ctx);
    // tool preview
    if (this.tool) this.drawPreview(ctx);
    if (this.offsetMode) this.drawOffsetPreview(ctx, COL);
    // sketch entity under the mouse while Smart Dimension / Trim is active: thick solid orange on top, so also a
    // construction / converted reference line lying on a model edge shows clearly (0.1.91)
    if (this.tool && (this.tool.id === 'dimension' || this.tool.id === 'trim') && this.hover?.startsWith('geo:')) {
      const g = this.G(this.hover.slice(4));
      if (g) {
        ctx.save(); ctx.strokeStyle = COL.hover; ctx.fillStyle = COL.hover; ctx.lineWidth = opt('skHoverHighlightW'); ctx.setLineDash([]); ctx.beginPath();
        if (g.type === 'line') { const a = this.scr(this.P(g.p1)), b = this.scr(this.P(g.p2)); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
        else if (g.type === 'circle' || g.type === 'arc') {
          const c = this.P(g.c); let a0 = 0, a1 = TAU;
          if (g.type === 'arc') { const sp = this.P(g.s), ep = this.P(g.e); a0 = Math.atan2(sp[1] - c[1], sp[0] - c[0]); a1 = Math.atan2(ep[1] - c[1], ep[0] - c[0]); if (a1 <= a0) a1 += TAU; }
          for (let i = 0; i <= 64; i++) { const t = a0 + (a1 - a0) * i / 64, q = this.scr([c[0] + g.r * Math.cos(t), c[1] + g.r * Math.sin(t)]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
          ctx.stroke();
        } else if (g.type === 'point') { const q = this.scr([g.x, g.y]); ctx.arc(q[0], q[1], opt('skHoverDotPx'), 0, TAU); ctx.fill(); }
        ctx.restore();
      }
    }
    // model edge / corner under the mouse that Smart Dimension would pick: orange like other hover highlights
    if (this.modelHover && !this.drag) {
      const m = this.modelHover;
      ctx.save(); ctx.strokeStyle = COL.hover; ctx.fillStyle = COL.hover; ctx.lineWidth = opt('skHoverHighlightW'); ctx.setLineDash([]);
      if (m.v) { const q = this.scr(m.v); ctx.beginPath(); ctx.arc(q[0], q[1], opt('skHoverDotPx'), 0, TAU); ctx.fill(); }
      else { ctx.beginPath(); m.pts.forEach((pt, i) => { const q = this.scr(pt); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.stroke(); }
      ctx.restore();
    }
    // box select
    if (this.box) {
      const b = this.box;
      const crossing = b.sx1 < b.sx0;
      ctx.strokeStyle = crossing ? opt('boxCrossColor') : opt('boxWindowColor'); ctx.fillStyle = crossing ? opt('boxCrossFill') : opt('boxWindowFill');
      ctx.setLineDash(crossing ? opt('boxCrossDash') : []); ctx.lineWidth = 1;
      ctx.fillRect(b.sx0, b.sy0, b.sx1 - b.sx0, b.sy1 - b.sy0); ctx.strokeRect(b.sx0, b.sy0, b.sx1 - b.sx0, b.sy1 - b.sy0);
      ctx.setLineDash([]);
    }
  }

  drawGlyphs(ctx) {
    const counts = new Map(), hid = this.hiddenIds();
    const grid = opt('relGlyphCluster'), ox = opt('relGlyphOffsetXPx'), oy = opt('relGlyphOffsetYPx'), sp = opt('relGlyphSpacingPx');
    const sz = opt('relGlyphSizePx'), hs = sz / 2, hit = hs + 0.5, nudge = opt('relGlyphTextNudgePx');
    const place = (anchor) => {
      const k = anchor.map((v) => Math.round(v / grid)).join(',');
      const n = counts.get(k) || 0; counts.set(k, n + 1);
      return [anchor[0] + ox + n * sp, anchor[1] + oy];
    };
    ctx.font = `600 ${opt('relGlyphFontPx')}px ${opt('overlayFont')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of this.sk.cons) {
      const d = relDef(c);
      if (!d || DIM_TYPES.has(c.type)) continue;
      if (c.type === 'coincident' || c.type === 'pointOnLine' || c.type === 'pointOnCircle' || c.type === 'offsetEnd' || c.type === 'offsetPerp') continue;
      const target = this.G(c.l || c.a || c.e || c.p || c.c);
      if (!target || hid.has(target.id)) continue;
      let anchor;
      if (target.type === 'line') { const a = this.P(target.p1), b = this.P(target.p2); anchor = this.scr([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
      else if (target.type === 'point') anchor = this.scr([target.x, target.y]);
      else { const cc = this.P(target.c); anchor = this.scr([cc[0] + target.r * 0.707, cc[1] + target.r * 0.707]); }
      const [x, y] = place(anchor);
      const conflict = this.state.conflicting.includes(c.id);
      const sel = this.sel.has('cons:' + c.id);
      ctx.fillStyle = conflict ? opt('relGlyphFillConflict') : sel ? opt('relGlyphFillSel') : opt('relGlyphFill');
      ctx.strokeStyle = conflict ? opt('relGlyphBorderConflict') : sel ? COL.sel : opt('relGlyphBorder');
      ctx.lineWidth = 1;
      ctx.fillRect(x - hs, y - hs, sz, sz); ctx.strokeRect(x - hs, y - hs, sz, sz);
      ctx.fillStyle = conflict ? opt('relGlyphTextConflict') : opt('relGlyphText');
      ctx.fillText(d.glyph, x, y + nudge);
      this.glyphHits.push({ id: c.id, x0: x - hit, x1: x + hit, y0: y - hit, y1: y + hit });
    }
  }

  // Draw a dimension; `pending` dims are previews that follow the cursor.
  drawDim(ctx, c, pending = false) {
    const conflict = this.state.conflicting.includes(c.id);
    const sel = this.sel.has('cons:' + c.id);
    const color = pending ? COL.preview : conflict ? COL.over : sel ? COL.sel : this.hover === 'cons:' + c.id ? COL.hover : c.driving === false ? COL.driven : COL.dim;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = opt('dimLineW');
    const anchor = this.dimAnchor(c);
    const L = pending ? c.lpAbs : [anchor[0] + (c.lp?.[0] ?? 0), anchor[1] + (c.lp?.[1] ?? 0)];
    const val = pending ? measure(this.sk, c) : c.driving === false ? measure(this.sk, c) : c.value;
    const type = pending ? this.autoType(c) : c.type;
    const r = this.dimLines(ctx, pending ? { ...c, lpUser: true } : c, L, (p) => this.scr(p), type, fmt(val, opt('dimDecimals'))); // placing: label stays under the mouse
    if (!r) return;
    let { labelAt, text, L: Ld } = r;
    ctx.font = `${opt('dimFontPx')}px ${opt('overlayFont')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + opt('dimLabelPadPx'), bh = opt('dimLabelBoxH');
    ctx.fillStyle = opt('dimLabelBg');
    ctx.fillRect(labelAt[0] - w / 2, labelAt[1] - bh / 2, w, bh);
    if (c.driving === false) { ctx.strokeStyle = color; ctx.strokeRect(labelAt[0] - w / 2, labelAt[1] - bh / 2, w, bh); }
    ctx.fillStyle = color === COL.dim ? opt('skDimColor') : color === COL.driven ? opt('dimDrivenText') : color; // label box is always white
    ctx.fillText(c.driving === false ? `(${text})` : text, labelAt[0], labelAt[1]);
    if (!pending) this.dimHits.push({ id: c.id, L: Ld, x0: labelAt[0] - w / 2, x1: labelAt[0] + w / 2, y0: labelAt[1] - opt('dimLabelHitPx'), y1: labelAt[1] + opt('dimLabelHitPx') });
  }

  // Dimension geometry (extension lines, dimension line, arrows, angle arc) in the current stroke/fill colour.
  // L = label position in sketch coords, S = sketch point → screen. Also used for dimensions shown on the model
  // (part/picking.js drawFeatureDims) with a light adaptor (G, P, dirOf, dimAnchor). Returns {labelAt, text} or null.
  dimLines(ctx, c, L0, S, type, txt) {
    let L = L0;
    let text = txt;
    const aL = opt('dimArrowLen'), aA = opt('dimArrowAngle'), gap = opt('dimExtGap'), over = opt('dimExtOver'), extMin = opt('dimExtMinPx');
    const kF = opt('dimKeepNearFactor');
    const arrow = (tip, from) => {
      const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
      ctx.beginPath(); ctx.moveTo(tip[0], tip[1]);
      ctx.lineTo(tip[0] - aL * Math.cos(a - aA), tip[1] - aL * Math.sin(a - aA));
      ctx.lineTo(tip[0] - aL * Math.cos(a + aA), tip[1] - aL * Math.sin(a + aA)); ctx.fill();
    };
    const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
    let labelAt = S(L);
    const linear = (p1, p2, dir) => {
      const n = [-dir[1], dir[0]];
      // keep labels near (0.1.86): a stored label position far from the measured span (geometry moved since it was
      // placed) is drawn next to it instead; positions the user dragged (c.lpUser) are kept as they are
      if (!c.lpUser) {
        const ln = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        if (Math.hypot(L[0] - m[0], L[1] - m[1]) > kF * Math.max(ln, opt('dimKeepNearMinLen'))) {
          const sg = (L[0] - m[0]) * n[0] + (L[1] - m[1]) * n[1] < 0 ? -1 : 1, k = Math.max(opt('dimKeepNearOffset') * ln, opt('dimKeepNearOffsetMin'));
          L = [m[0] + n[0] * sg * k, m[1] + n[1] * sg * k];
        }
      }
      const off = (L[0] - p1[0]) * n[0] + (L[1] - p1[1]) * n[1];
      const q1 = [p1[0] + n[0] * off, p1[1] + n[1] * off];
      const q2 = [p2[0] + (n[0] * ((L[0] - p2[0]) * n[0] + (L[1] - p2[1]) * n[1])), p2[1] + (n[1] * ((L[0] - p2[0]) * n[0] + (L[1] - p2[1]) * n[1]))];
      const s1 = S(p1), s2 = S(p2), t1 = S(q1), t2 = S(q2);
      const ext = (a, b) => { const v = [b[0] - a[0], b[1] - a[1]]; const l = Math.hypot(v[0], v[1]) || 1; seg([a[0] + v[0] / l * gap, a[1] + v[1] / l * gap], [b[0] + v[0] / l * over, b[1] + v[1] / l * over]); };
      if (Math.hypot(t1[0] - s1[0], t1[1] - s1[1]) > extMin) ext(s1, t1);
      if (Math.hypot(t2[0] - s2[0], t2[1] - s2[1]) > extMin) ext(s2, t2);
      seg(t1, t2); arrow(t1, t2); arrow(t2, t1);
      const mid = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
      const along = (L[0] - mid[0]) * dir[0] + (L[1] - mid[1]) * dir[1];
      labelAt = S([mid[0] + dir[0] * along, mid[1] + dir[1] * along]);
      // label beyond the end of the dimension line: dotted leader from the nearer arrow to the label (0.1.93)
      const half = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]) / 2;
      if (Math.abs(along) > half + opt('geomEpsTiny')) {
        const end = along > 0 === ((q2[0] - mid[0]) * dir[0] + (q2[1] - mid[1]) * dir[1] > 0) ? t2 : t1;
        ctx.save(); ctx.setLineDash(opt('dimLeaderDash')); seg(end, labelAt); ctx.restore();
      }
    };
    try {
      if (type === 'length') {
        const l = this.G(c.l); const a = this.P(l.p1), b = this.P(l.p2);
        linear(a, b, this.dirOf(l));
      } else if (type === 'distance') {
        const a = this.P(c.a), b = this.P(c.b); const d = dist(a, b) || 1;
        linear(a, b, [(b[0] - a[0]) / d, (b[1] - a[1]) / d]);
      } else if (type === 'hdist') {
        linear(this.P(c.a), this.P(c.b), [1, 0]);
      } else if (type === 'vdist') {
        linear(this.P(c.a), this.P(c.b), [0, 1]);
      } else if (type === 'pointLine') {
        const p = this.P(c.p), l = this.G(c.l);
        const pr = projectOnSegment(p, this.P(l.p1), this.P(l.p2)).ptLine;
        const d = dist(p, pr) || 1;
        const dir = [(pr[0] - p[0]) / d, (pr[1] - p[1]) / d];
        linear(p, pr, dir);
      } else if (type === 'offset') { // Offset Entities (0.1.94): offset entity a ↔ base entity b
        const a = this.G(c.a), b = this.G(c.b);
        if (a.type === 'line') {
          const p = this.P(a.p1), q = this.P(a.p2), m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          const pr = projectOnSegment(m, this.P(b.p1), this.P(b.p2)).ptLine, d = dist(m, pr) || 1;
          linear(pr, m, [(m[0] - pr[0]) / d, (m[1] - pr[1]) / d]);
        } else {
          const ctr = this.P(a.c), v = [L[0] - ctr[0], L[1] - ctr[1]], d = Math.hypot(v[0], v[1]) || 1, u = [v[0] / d, v[1] / d];
          const pa = [ctr[0] + u[0] * a.r, ctr[1] + u[1] * a.r], pb = [ctr[0] + u[0] * b.r, ctr[1] + u[1] * b.r];
          linear(pb, pa, b.r < a.r ? u : [-u[0], -u[1]]);
        }
      } else if (type === 'radius' || type === 'diameter') {
        const g = this.G(c.c); const ctr = this.P(g.c);
        let v = [L[0] - ctr[0], L[1] - ctr[1]]; let d = Math.hypot(v[0], v[1]) || 1;
        if (!c.lpUser && d > kF * g.r + opt('dimKeepNearRadAdd')) { const kr = opt('dimKeepNearRadPos'); L = [ctr[0] + v[0] / d * g.r * kr, ctr[1] + v[1] / d * g.r * kr]; v = [L[0] - ctr[0], L[1] - ctr[1]]; d = Math.hypot(v[0], v[1]) || 1; } // keep near
        const u = [v[0] / d, v[1] / d];
        const edge = [ctr[0] + u[0] * g.r, ctr[1] + u[1] * g.r];
        const s0 = type === 'diameter' ? S([ctr[0] - u[0] * g.r, ctr[1] - u[1] * g.r]) : S(ctr);
        const se = S(edge), sl = S(L);
        seg(s0, sl); arrow(se, s0);
        if (type === 'diameter') arrow(s0, se);
        text = (type === 'diameter' ? 'Ø' : 'R') + text;
        labelAt = sl;
      } else if (type === 'angle') {
        const la = this.G(c.a), lb = this.G(c.b);
        const X = this.dimAnchor(c);
        const r = Math.max(dist(X, L), opt('geomEps'));
        const da = this.dirOf(la), db = this.dirOf(lb);
        let a1 = Math.atan2(da[1], da[0]), a2 = Math.atan2(db[1], db[0]);
        const am = Math.atan2(L[1] - X[1], L[0] - X[0]);
        // choose the line directions whose wedge contains the label
        const cands = [[a1, a2], [a1 + Math.PI, a2], [a1, a2 + Math.PI], [a1 + Math.PI, a2 + Math.PI]];
        let best = cands[0];
        for (const [p, q] of cands) {
          const sw = normAng(q - p);
          const lo = sw <= Math.PI ? p : q, span = sw <= Math.PI ? sw : TAU - sw;
          if (normAng(am - lo) <= span) { best = [lo, lo + span]; break; }
        }
        const pts = [];
        for (let i = 0; i <= 32; i++) { const t = best[0] + (best[1] - best[0]) * i / 32; pts.push(S([X[0] + r * Math.cos(t), X[1] + r * Math.sin(t)])); }
        ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke();
        arrow(pts[0], pts[2]); arrow(pts[32], pts[30]);
        text += '°';
        labelAt = S(L);
      }
    } catch { return null; }
    return { labelAt, text, L };
  }

  drawPreview(ctx) {
    const t = this.tool;
    const cur = t.cursor;
    const S = (p) => this.scr(p);
    ctx.strokeStyle = COL.preview; ctx.lineWidth = opt('skPreviewLineW'); ctx.setLineDash([]);
    const dL = opt('skReadoutDecimals'), dA = opt('skReadoutAngDecimals');
    const poly = (pts, close = false) => { ctx.beginPath(); pts.map(S).forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); if (close) ctx.closePath(); ctx.stroke(); };
    const curve = (c) => poly(sampleCurve(c, opt('skCurveSamples')));
    let info = '';
    if (t.id === 'dimension') {
      if (t.pending) this.drawDim(ctx, t.pending, true);
      return;
    }
    if (cur) {
      const s = t.snap;
      if (t.id === 'line' || t.id === 'centerline') {
        if (t.pts.length) {
          if (t.id === 'centerline') ctx.setLineDash(opt('skConstructionDash'));
          const a = t.pts[t.pts.length - 1]; poly([a, cur]);
          info = `L ${fmt(dist(a, cur), dL)}  ∠ ${fmt((Math.atan2(cur[1] - a[1], cur[0] - a[0]) * 180) / Math.PI, dA)}°`;
        }
      } else if ((t.id === 'rect' || t.id === 'centerRect') && t.pts.length) {
        let a = t.pts[0], b = cur;
        if (t.id === 'centerRect') a = [2 * a[0] - cur[0], 2 * a[1] - cur[1]];
        poly([a, [b[0], a[1]], b, [a[0], b[1]]], true);
        info = `${fmt(Math.abs(b[0] - a[0]), dL)} × ${fmt(Math.abs(b[1] - a[1]), dL)}`;
      } else if (t.id === 'circle' && t.pts.length) {
        const r = dist(t.pts[0], cur); curve({ kind: 'circle', c: t.pts[0], r }); info = `R ${fmt(r, dL)}`;
      } else if (t.id === 'arc' && t.pts.length) {
        const c = t.pts[0];
        if (t.pts.length === 1) { ctx.setLineDash(opt('skPreviewRadiusDash')); poly([c, cur]); info = `R ${fmt(dist(c, cur), dL)}`; }
        else {
          const s0 = t.pts[1], r = dist(c, s0);
          const a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]);
          const ang = Math.atan2(cur[1] - c[1], cur[0] - c[0]);
          let dA = ang - t.lastAng; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
          t.sweep = (t.sweep || 0) + dA; t.lastAng = ang;
          if (Math.abs(t.sweep) > TAU) t.sweep %= TAU;
          const a1 = a0 + t.sweep;
          curve(t.sweep >= 0 ? { kind: 'arc', c, r, a0, a1 } : { kind: 'arc', c, r, a0: a1, a1: a0 });
          info = `A ${fmt(Math.abs(t.sweep) * 180 / Math.PI, dA)}°`;
        }
      } else if (t.id === 'arc3' && t.pts.length) {
        if (t.pts.length === 1) poly([t.pts[0], cur]);
        else {
          const cc = circleFrom3(t.pts[0], cur, t.pts[1]);
          if (cc) {
            const a0 = Math.atan2(t.pts[0][1] - cc.c[1], t.pts[0][0] - cc.c[0]), a1 = Math.atan2(t.pts[1][1] - cc.c[1], t.pts[1][0] - cc.c[0]);
            const ccw = cross2([cur[0] - t.pts[0][0], cur[1] - t.pts[0][1]], [t.pts[1][0] - t.pts[0][0], t.pts[1][1] - t.pts[0][1]]) < 0;
            curve(ccw ? { kind: 'arc', c: cc.c, r: cc.r, a0, a1 } : { kind: 'arc', c: cc.c, r: cc.r, a0: a1, a1: a0 });
            info = `R ${fmt(cc.r, dL)}`;
          }
        }
      } else if (t.id === 'tangentArc' && t.pts.length) {
        const g = this.tangentArcGeom(t.pts[0], t.tan, cur);
        if (g) {
          const p0 = t.pts[0];
          const a0 = Math.atan2(p0[1] - g.c[1], p0[0] - g.c[0]), a1 = Math.atan2(cur[1] - g.c[1], cur[0] - g.c[0]);
          curve(g.ccw ? { kind: 'arc', c: g.c, r: g.r, a0, a1 } : { kind: 'arc', c: g.c, r: g.r, a0: a1, a1: a0 });
          info = `R ${fmt(g.r, dL)}`;
        }
      } else if (t.id === 'slot' && t.pts.length) {
        if (t.pts.length === 1) poly([t.pts[0], cur]);
        else {
          const [c1, c2] = t.pts; const L = dist(c1, c2) || 1;
          const u = [(c2[0] - c1[0]) / L, (c2[1] - c1[1]) / L], n = [-u[1], u[0]];
          const r = Math.abs((cur[0] - c1[0]) * n[0] + (cur[1] - c1[1]) * n[1]);
          const P = (c, s) => [c[0] + n[0] * r * s, c[1] + n[1] * r * s];
          const ang = Math.atan2(n[1], n[0]);
          poly([P(c1, 1), P(c2, 1)]); poly([P(c2, -1), P(c1, -1)]);
          curve({ kind: 'arc', c: c2, r, a0: ang + Math.PI, a1: ang }); curve({ kind: 'arc', c: c1, r, a0: ang, a1: ang + Math.PI });
          info = `W ${fmt(2 * r, dL)}`;
        }
      }
      // inference cursor glyph
      const sc = S(cur);
      if (s?.ref) {
        const mdl = s.ref.kind === 'model';
        ctx.fillStyle = mdl ? opt('snapMarkModel') : opt('snapMarkSketch'); ctx.strokeStyle = mdl ? opt('snapMarkModelBorder') : opt('snapMarkSketchBorder'); ctx.lineWidth = 1;
        const mk = opt('snapMarkPx');
        ctx.beginPath();
        if (mdl && s.ref.what !== 'edge') ctx.rect(sc[0] - mk, sc[1] - mk, 2 * mk, 2 * mk); else ctx.arc(sc[0], sc[1], mk, 0, TAU);
        ctx.fill(); ctx.stroke();
        const lbl = mdl ? { vertex: 'Model Corner', mid: 'Model Midpoint', center: 'Model Center', edge: 'Model Edge' }[s.ref.what] : { point: 'Coincident', mid: 'Midpoint', onLine: 'On Edge', onCircle: 'On Edge' }[s.ref.kind];
        info = (info ? info + '   ' : '') + lbl;
      } else if (s?.hv) info = (info ? info + '   ' : '') + (s.hv === 'h' ? 'Horizontal' : 'Vertical');
      if (info) {
        ctx.font = `${opt('cursorInfoFontPx')}px ${opt('overlayFont')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const w = ctx.measureText(info).width + opt('cursorInfoPadPx'), off = opt('cursorInfoOffsetPx'), bh = opt('cursorInfoBoxH');
        ctx.fillStyle = opt('cursorInfoBg'); ctx.strokeStyle = opt('cursorInfoBorder');
        ctx.fillRect(sc[0] + off, sc[1] + off, w, bh); ctx.strokeRect(sc[0] + off, sc[1] + off, w, bh);
        ctx.fillStyle = opt('cursorInfoText'); ctx.fillText(info, sc[0] + (off + opt('cursorInfoTextDx')), sc[1] + (off + opt('cursorInfoTextDy')));
      }
    }
  }

}
