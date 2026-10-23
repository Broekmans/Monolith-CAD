// Sketch: text entities, convert edges
// Methods are mixed into Sketcher (see sketcher.js); `this` is the Sketcher.
import { solve, analyzeDefinition, measure, DIM_TYPES } from './solver.js';
import { dist, projectOnSegment, angleInArc, normAng, lineLine, lineCircle, circleCircle, circleFrom3, cross2, TAU } from './geom2d.js';
import { sampleCurve, sketchCurves } from '../../../shared/profile.mjs';
import { h, fmt, modifyBox, toast } from '../ui.js';
import { icon } from '../icons.js';
import { listFonts, loadFont, textGeometry, preferredFont } from './fonts.js';
import { textLoops } from '../../../shared/profile.mjs';
import { opt } from '../app/options.js';
import { refFromMeshEdge } from '../part/linkgeom.js';
import { niceHeight, COL, COL_LIGHT, COL_DARK, setSketchTheme, SKETCH_TOOLS, REL_DEFS, newSketch } from './sketcher.js';

export class SketchText {
  // ---------------- sketch text ----------------
  async updateText(g) {
    const token = (g._tok = (g._tok || 0) + 1);
    try {
      const font = await loadFont(g.font);
      if (token !== g._tok) return;
      const geo = textGeometry(font, g.text, g.h, { align: g.align });
      g.outline = geo.outline; g.segs = geo.segs;
    } catch (e) {
      toast('Could not load font ' + g.font + ': ' + e.message, 'error');
      g.outline = []; g.segs = [];
    }
    delete g._tok;
    this.lastFont = g.font;
    this.host.onSketchChanged?.(this);
    this.vp.requestRender();
  }
  drawText(ctx, g, scr) {
    const col = this.colorFor(g);
    const polys = this.textPolys(g);
    ctx.setLineDash(g.construction ? opt('skTextConstructionDash') : []);
    ctx.lineWidth = this.sel.has('geo:' + g.id) || this.hover === 'geo:' + g.id ? opt('skTextLineWSel') : opt('skTextLineW');
    ctx.strokeStyle = col;
    ctx.fillStyle = col === COL.sel ? opt('skTextFillSel') : col === COL.hover ? opt('skTextFillHover') : opt('skTextFill');
    ctx.beginPath();
    for (const loop of polys) { loop.forEach((q, i) => { const s = scr(q); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath(); }
    if (polys.length) { ctx.fill('evenodd'); ctx.stroke(); }
    ctx.setLineDash([]);
    if (!polys.length) {
      const a = this.G(g.p); const s = scr([a.x, a.y]);
      ctx.font = `${opt('skTextPlaceholderPx')}px ${opt('overlayFont')}`; ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(g.text || '…', s[0], s[1]);
    }
    if (this.sel.has('geo:' + g.id)) {
      const b = this.textBox(g), a = this.G(g.p), r = g.rot || 0;
      const T = (x, y) => scr([a.x + x * Math.cos(r) - y * Math.sin(r), a.y + x * Math.sin(r) + y * Math.cos(r)]);
      const pad = g.h * opt('skTextBoxPad');
      const cs = [T(b.min[0] - pad, b.min[1] - pad), T(b.max[0] + pad, b.min[1] - pad), T(b.max[0] + pad, b.max[1] + pad), T(b.min[0] - pad, b.max[1] + pad)];
      ctx.strokeStyle = COL.sel; ctx.lineWidth = 1; ctx.setLineDash(opt('skTextBoxDash'));
      ctx.beginPath(); cs.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  textPanel(g) {
    const rows = [h('div', { class: 'sp-sec' }, 'Sketch Text')];
    const change = (fn, rebuild = true) => { this.pushUndo(); fn(); if (rebuild) this.updateText(g); else { this.host.onSketchChanged?.(this); this.vp.requestRender(); } };
    const ta = h('textarea', { class: 'sp-text', rows: 3, spellcheck: 'false' });
    ta.value = g.text;
    let tmr = null, undone = false;
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('input', () => {
      if (!undone) { this.pushUndo(); undone = true; }
      g.text = ta.value;
      clearTimeout(tmr); tmr = setTimeout(() => this.updateText(g), opt('skTextDebounceMs'));
    });
    rows.push(h('div', { class: 'sp-field' }, h('label', {}, 'Text'), ta));
    const fontSel = h('select', {}, h('option', { value: g.font }, g.font));
    listFonts().then((fonts) => {
      fontSel.innerHTML = '';
      for (const f of fonts) fontSel.appendChild(h('option', { value: f.name, selected: f.name === g.font }, f.name));
    });
    fontSel.addEventListener('change', () => change(() => { g.font = fontSel.value; }));
    rows.push(h('div', { class: 'sp-field' }, h('label', {}, 'Font'), fontSel));
    const num = (label, get, set, unit) => {
      const inp = h('input', { type: 'text', value: fmt(get(), 4) });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (isFinite(v)) change(() => set(v)); });
      return h('div', { class: 'sp-field row' }, h('label', {}, label), inp, h('span', { class: 'unit' }, unit));
    };
    rows.push(num('Height', () => g.h, (v) => { if (v > 0) g.h = v; }, 'mm'));
    rows.push(num('Rotation', () => ((g.rot || 0) * 180) / Math.PI, (v) => { g.rot = (v * Math.PI) / 180; }, '°'));
    rows.push(num('Curve accuracy', () => g.tol ?? opt('skTextArcTol'), (v) => { if (v >= 0) g.tol = v; }, 'mm'));
    const alignSel = h('select', {}, ['left', 'center', 'right'].map((a) => h('option', { value: a, selected: (g.align || 'left') === a }, a[0].toUpperCase() + a.slice(1))));
    alignSel.addEventListener('change', () => change(() => { g.align = alignSel.value; }));
    rows.push(h('div', { class: 'sp-field' }, h('label', {}, 'Alignment'), alignSel));
    const cb = h('input', { type: 'checkbox', checked: !!g.construction });
    cb.addEventListener('change', () => change(() => { g.construction = cb.checked; }, false));
    rows.push(h('label', { class: 'pm-check' }, cb, 'For construction (not used as a profile)'));
    const a = this.G(g.p);
    rows.push(h('div', { class: 'sp-hint' }, `Anchor at ${fmt(a.x, 2)}, ${fmt(a.y, 2)} mm. Drag the text to move it, or select its anchor point to dimension or relate it. Extrude the sketch to emboss the text, or use Extruded Cut to engrave it.`));
    return rows;
  }

  // Convert model edges (3D polylines) into fixed sketch geometry.
  convertEdge(edge, { construction = false } = {}) {
    const f = this.fr;
    const loc = (p) => { const d = [p[0] - f.o[0], p[1] - f.o[1], p[2] - f.o[2]]; return [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2]]; };
    const pts = [];
    for (let i = 0; i < edge.pts.length; i += 3) pts.push(loc([edge.pts[i], edge.pts[i + 1], edge.pts[i + 2]]));
    if (pts.length < 2) return;
    this.pushUndo();
    // linked to the model edge (On Edge): follows it when earlier sketches / features change (Options > Sketch)
    // 0.1.132: an edge of another component (Edit in Context) → in-context reference in that part's frame
    const xref = edge.ctx ? refFromMeshEdge(edge.ctx.e, edge.ctx.bbox) : null;
    const ref = !edge.ctx && opt('linkConvert') && this.host?.mesh ? refFromMeshEdge(edge, this.host.mesh.bbox) : null;
    const fix = (g) => {
      if (xref) { g.xref = this.xrefOf(edge.ctx, xref); this.addCons({ type: 'fix', e: g.id, xref: true }); return; }
      if (ref) g.onEdge = ref; this.addCons(ref ? { type: 'fix', e: g.id, onEdge: true } : { type: 'fix', e: g.id });
    };
    if (edge.type === 'line') {
      const l = this.addLine(pts[0], pts[pts.length - 1], construction);
      fix(l);
    } else if (edge.type === 'circle') {
      const a = pts[0], m = pts[Math.floor(pts.length / 2)], b = pts[pts.length - 1];
      const closed = dist(a, b) < opt('geomEps');
      const cc = circleFrom3(a, pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
      if (!cc) return;
      if (closed) {
        const c = this.addPoint(cc.c[0], cc.c[1]);
        const g = { id: this.gid(), type: 'circle', c, r: cc.r, construction }; this.sk.geo.push(g);
        fix(g);
      } else {
        const ccw = cross2([m[0] - a[0], m[1] - a[1]], [b[0] - a[0], b[1] - a[1]]) > 0;
        const g = this.makeArc(cc.c, ccw ? a : b, ccw ? b : a, cc.r, null);
        g.construction = construction;
        fix(g);
      }
    } else {
      // free-form edge: approximate with fixed line segments
      for (let i = 0; i < pts.length - 1; i++) { const l = this.addLine(pts[i], pts[i + 1], construction); this.addCons({ type: 'fix', e: l.id }); }
    }
    this.resolve(true);
  }

  // Curves for the host's 3D display / profile preview.
  curves() { return sketchCurves(this.sk, { includeConstruction: true }); }
}
