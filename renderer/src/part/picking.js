// Part: picking, highlights, overlay, double-click feature dims, tree hover
// Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import { paneDisplay } from '../displaystyle.js';
import * as THREE from 'three';
import { Viewport, navHeld } from '../viewport.js';
import { Sketcher, SKETCH_TOOLS, newSketch } from '../sketch/sketcher.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { opt } from '../app/options.js';
import { sketchCurves, sampleCurve } from '../../../shared/profile.mjs';
import { solve as solveSketch, measure as measureDim, DIM_TYPES } from '../sketch/solver.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import { dxfToSketch, sketchToDxf } from '../io/dxf.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { driveSize, autoDims, solveStepped } from './drive.js';
import { drawModelDimLines } from './modeldims.js';
import { autoKey } from './dimdrag.js';
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis } from './part.js';

export class PartPicking {
  // ======================= picking =======================
  bindViewport() {
    const el = this.vp.el;
    this.bindDimDrag(); // drag dimension labels on the model (dimdrag.js; capture listeners run first)
    el.addEventListener('pointermove', (e) => {
      if (this.sketcher) return;
      const p = navHeld(e) ? null : this.pickAt(e);
      const key = p?.key || null;
      if (key !== (this.hover?.key || null)) {
        this.hover = p;
        this.updateHighlights();
        if (p?.kind === 'plane' || this._hoverWasPlane) this.updatePlanes();
        if (p?.kind === 'sketch' || this._hoverWasSketch) this.updateSketchDisplay();
        this._hoverWasPlane = p?.kind === 'plane';
        this._hoverWasSketch = p?.kind === 'sketch';
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (this.sketcher || e.button !== 0 || e.altKey) return;
      this._downAt = [e.clientX, e.clientY];
    });
    el.addEventListener('pointerup', (e) => {
      if (this.sketcher || e.button !== 0 || !this._downAt) return;
      const moved = Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]) > opt('modelClickMovePx');
      this._downAt = null;
      if (moved) return;
      if (this.dimLabelAt(e)) return; // first click of a double-click on a dimension label: keep the dimensions shown
      const p = this.pickAt(e);
      this.clickItem(p, e.ctrlKey || e.shiftKey);
    });
    el.addEventListener('dblclick', (e) => {
      if (this.sketcher) return;
      const hit = this.dimLabelAt(e);
      if (hit) { this.editShownDim(hit); return; }
      const p = this.pickAt(e);
      if (p?.kind === 'sketch') this.editSketch(p.id);
      else if (p?.kind === 'face' && !this.app.pm.open) {
        const f = this.pick?.mesh.faces.find((x) => x.id === p.id);
        this.showFeatureDims(f?.feat || null);
      }
    });
  }

  // dimension label (shown on the model) under the mouse
  // Label boxes are kept per view (pane): every pane draws the labels at its own screen positions; ≤ 0.1.79 one list
  // was overwritten by each pane, so only the last-drawn view had clickable labels.
  get _dimHits() { return this.dimHitsOf(this.vp.viewset?.active); } // active view's labels (tests, older code)
  dimHitsOf(pane) { return this._dimHitsBy?.get(pane || this.vp.pane || this.vp) || []; }
  dimLabelAt(e) {
    const pane = this.vp.viewset?.paneOf(e.target) || this.vp.pane;
    const hits = this.dimHitsOf(pane);
    if (!hits.length) return null;
    const r = (pane?.el || this.vp.el).getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const m = opt('modelDimHitPadPx');
    return hits.find((d) => x >= d.x0 - m && x <= d.x1 + m && y >= d.y0 - m && y <= d.y1 + m) || null;
  }
  clickItem(p, additive) {
    const pm = this.app.pm.current;
    if (pm && p) {
      if (p.kind === 'face' && this.offerFaceEdges(pm, p)) { this.updateHighlights(); return; }
      if (pm.offer(this.selItem(p))) { this.updateHighlights(); return; }
    }
    if (pm && !p) return;
    if (!p && this.dimFeat) this.showFeatureDims(null);
    if (!p) { this.sel = []; }
    else if (additive) {
      const i = this.sel.findIndex((s) => s.key === p.key);
      if (i >= 0) this.sel.splice(i, 1); else this.sel.push(p);
    } else this.sel = [p];
    this.afterSelection();
  }
  // Fillet / Chamfer (any edge selection box that takes no faces): a clicked face adds all its edges; clicking it
  // again (all its edges already in the box) removes them (0.1.95)
  offerFaceEdges(pm, p) {
    const box = Object.values(pm.selboxes).find((b) => b.key === pm.activeSel) || Object.values(pm.selboxes)[0];
    const okEdge = (it) => !box.accepts || box.accepts(it);
    if (!box || (box.accepts && box.accepts(this.selItem(p))) || !okEdge({ kind: 'edge', type: 'line' })) return false;
    const mesh = this.pick?.mesh; if (!mesh) return false;
    const items = mesh.edges.filter((e) => e.faces?.includes(p.id)).map((e) => this.selItem({ kind: 'edge', id: e.id, mid: e.mid, type: e.type, key: 'edge:' + e.id, edge: e })).filter(okEdge);
    if (!items.length) return false;
    const has = (it) => box.items.some((x) => x.key === it.key);
    const next = items.every(has) ? box.items.filter((x) => !items.some((it) => it.key === x.key)) : [...box.items, ...items.filter((it) => !has(it))];
    pm.setValue(box.key, next); pm.fire(box.key);
    window.__lithLog?.(`FACE EDGES face ${p.id} ${items.length} edges → ${next.length} in ${box.key}`);
    return true;
  }
  afterSelection() {
    this.treeGhost?.();
    this.updateHighlights();
    this.updatePlanes();
    this.updateSketchDisplay();
    this.renderTree();
    this.app.cm.refresh();
    this.showSelectionInfo();
  }
  selItem(p) {
    const label = {
      face: () => `Face<${p.id + 1}>`, edge: () => `Edge<${p.id + 1}>`, plane: () => `${p.name} Plane`,
      sketch: () => this.F(p.id)?.name, feature: () => this.F(p.id)?.name,
    }[p.kind]?.() || p.kind;
    return { ...p, label };
  }

  // only the model face under the mouse (Offset Entities face pick, 0.1.97)
  faceAt(e) {
    const pk = this.doc.bodyHidden ? null : this.pick; if (!pk) return null;
    const r = this.vp.el.getBoundingClientRect(), rc = this.vp.ray(e.clientX - r.left, e.clientY - r.top);
    const hit = rc.intersectObject(pk.obj, false)[0]; if (!hit) return null;
    const fid = pk.faceOfTri[hit.faceIndex], f = pk.mesh.faces.find((x) => x.id === fid);
    return f ? { id: fid, plane: f.plane, ftype: f.type } : null;
  }
  pickAt(e) {
    const r = this.vp.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const rc = this.vp.ray(sx, sy);
    let faceHit = null;
    const pk = this.doc.bodyHidden && !this.pickOverride ? null : this.pick; // hidden body (tree eye) is not pickable
    if (pk) {
      const hits = rc.intersectObject(pk.obj, false);
      if (hits.length) faceHit = hits[0];
    }
    const faceDepth = faceHit ? faceHit.distance : Infinity;
    const viewDir = this.vp.viewDir();
    const origin = rc.ray.origin;
    // edges (screen space)
    if (pk) {
      let best = null, bd = opt('modelPickPx');
      for (const ed of pk.mesh.edges) {
        const p = ed.pts;
        for (let i = 3; i < p.length; i += 3) {
          const a = this.vp.toScreen([p[i - 3], p[i - 2], p[i - 1]]), b = this.vp.toScreen([p[i], p[i + 1], p[i + 2]]);
          const d = segDist([sx, sy], a, b);
          if (d < bd) {
            const mid = new THREE.Vector3((p[i - 3] + p[i]) / 2, (p[i - 2] + p[i + 1]) / 2, (p[i - 1] + p[i + 2]) / 2);
            const depth = mid.clone().sub(origin).dot(viewDir);
            if (paneDisplay(this) === 'wire' || depth <= faceDepth + this.vp.scale * opt('modelEdgeDepthTolPx')) { bd = d; best = ed; }
          }
        }
      }
      if (best) return { kind: 'edge', id: best.id, mid: best.mid, type: best.type, key: 'edge:' + best.id, edge: best };
    }
    // sketches
    {
      let best = null, bd = opt('modelPickPx');
      for (const f of this.doc.features) {
        if (f.type !== 'sketch') continue;
        const show = f.visible ?? !this.consumedSketches().has(f.id);
        if (!show) continue;
        const fr = frameOf(this.planeOf(f));
        for (const c of sketchCurves(f, { includeConstruction: true })) {
          const s = sampleCurve(c, 32).map((q) => this.vp.toScreen(to3(fr, q)));
          for (let i = 1; i < s.length; i++) { const d = segDist([sx, sy], s[i - 1], s[i]); if (d < bd) { bd = d; best = f; } }
        }
      }
      if (best) return { kind: 'sketch', id: best.id, key: 'sketch:' + best.id };
    }
    if (faceHit) {
      const fid = pk.faceOfTri[faceHit.faceIndex];
      const f = pk.mesh.faces.find((x) => x.id === fid);
      return { kind: 'face', id: fid, c: f.c, n: f.plane?.normal, plane: f.plane, ftype: f.type, area: f.area, key: 'face:' + fid };
    }
    // planes
    const planeHits = rc.intersectObjects(this.planeGroup.children.filter((o) => o.userData.plane), false);
    if (planeHits.length) {
      const name = planeHits[0].object.userData.plane;
      return { kind: 'plane', name, plane: STD_PLANES[name], key: 'plane:' + name };
    }
    return null;
  }

  clearHighlights() {
    for (const o of [...this.hlGroup.children]) { this.hlGroup.remove(o); o.geometry?.dispose(); }
  }
  updateHighlights() {
    this.clearHighlights();
    const pk = this.pick;
    const m = pk?.mesh;
    const pmItems = this.app.pm.current ? Object.values(this.app.pm.current.selboxes).flatMap((b) => b.items) : [];
    const items = [...this.sel, ...pmItems].map((s) => ({ ...s, col: COLORS.sel }));
    if (this.hover) items.push({ ...this.hover, col: COLORS.hover });
    if (m && this.hoverFeat) for (const f of m.faces) if (f.feat === this.hoverFeat) items.push({ kind: 'face', id: f.id, col: COLORS.hover });
    if (m && pk) {
      for (const it of items) {
        if (it.kind !== 'face') continue;
        const f = m.faces.find((x) => x.id === it.id);
        if (!f) continue;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', pk.obj.geometry.getAttribute('position'));
        geom.setAttribute('normal', pk.obj.geometry.getAttribute('normal'));
        geom.setIndex(Array.from(m.indices.slice(f.start, f.start + f.count)));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: it.col, transparent: true, opacity: opt('modelFaceHlPct') / 100, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false }));
        this.hlGroup.add(mesh);
      }
    }
    this.hlEdges = items.filter((i) => i.kind === 'edge');
    this.vp.requestRender();
  }

  drawOverlay(ctx) {
    // highlighted edges
    for (const it of this.hlEdges || []) {
      const ed = it.edge || this.pick?.mesh.edges.find((e) => e.id === it.id);
      if (!ed) continue;
      ctx.strokeStyle = it.col === COLORS.hover ? opt('hoverColor') : opt('selColor');
      ctx.lineWidth = opt('modelEdgeHlW');
      ctx.beginPath();
      for (let i = 0; i < ed.pts.length; i += 3) {
        const s = this.vp.toScreen([ed.pts[i], ed.pts[i + 1], ed.pts[i + 2]]);
        if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
      }
      ctx.stroke();
    }
    this.drawFeatureDims(ctx);
    this.drawFeatUI(ctx);
    // origin glyph
    if (!this.sketcher) {
      const o = this.vp.toScreen([0, 0, 0]);
      ctx.strokeStyle = opt('modelOriginColor'); ctx.lineWidth = opt('modelOriginLineW');
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const len = this.vp.scale * opt('modelOriginLenPx');
        const p = this.vp.toScreen([d[0] * len, d[1] * len, d[2] * len]);
        ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      }
    }
    // plane labels
    for (const o of this.planeGroup.children) {
      if (!o.userData.plane) continue;
      const fr = frameOf(STD_PLANES[o.userData.plane]);
      const S = this.planeSize();
      const s = this.vp.toScreen(to3(fr, [-S, S]));
      ctx.font = `${opt('planeLabelFontPx')}px ${opt('overlayFont')}`; ctx.fillStyle = opt(document.body.classList.contains('dark') ? 'planeLabelColorDark' : 'planeLabelColor'); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(o.userData.plane, s[0] + opt('planeLabelDxPx'), s[1] - opt('planeLabelDyPx'));
    }
  }

  // ======================= SolidWorks-style: show feature dimensions / tree hover =======================
  setHoverFeat(id) {
    if (this.hoverFeat === id) return;
    this.hoverFeat = id;
    this.updateHighlights(); this.updateSketchDisplay();
  }
  showFeatureDims(id) {
    this.dimFeat = id && !this.sketcher ? id : null;
    this._dimHitsBy = new WeakMap();
    if (this.dimFeat) { const f = this.F(this.dimFeat); this.app.setStatus(`${f?.name}: double-click a dimension to change it`); }
    this.updateSketchDisplay(); this.vp.requestRender();
  }
  // list of shown dimensions [{label, value, unit, pos3, kind, cons?|key?}]
  featureDims() {
    const f = this.F(this.dimFeat);
    if (!f) return [];
    const out = [];
    const sk = f.type === 'sketch' ? f : f.sketch ? this.F(f.sketch) : null;
    let ctr = null;
    if (sk) {
      const st = this.status.find((x) => x.id === sk.id);
      const fr = frameOf(st?.plane || this.planeOf(sk));
      const G = (id) => sk.geo.find((g) => g.id === id), P = (id) => { const p = G(id); return p ? [p.x, p.y] : null; };
      const anchor = (c) => {
        switch (c.type) {
          case 'length': { const l = G(c.l); const a = P(l?.p1), b = P(l?.p2); return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null; }
          case 'distance': case 'hdist': case 'vdist': { const a = P(c.a), b = P(c.b); return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null; }
          case 'pointLine': return P(c.p);
          case 'offset': { const a = G(c.a); if (!a) return null; if (a.type !== 'line') return P(a.c); const p = P(a.p1), q = P(a.p2); return p && q ? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] : null; }
          case 'radius': case 'diameter': return P(G(c.c)?.c);
          case 'angle': return P(G(c.a)?.p1);
          default: return null;
        }
      };
      const pts = sk.geo.filter((g) => g.type === 'point');
      if (pts.length) ctr = to3(fr, [pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.y, 0) / pts.length]);
      for (const c of sk.cons || []) {
        if (!DIM_TYPES.has(c.type)) continue;
        const a = anchor(c); if (!a) continue;
        const val = c.driving === false ? measureDim(sk, c) : c.value;
        const pre = c.type === 'diameter' ? 'Ø' : c.type === 'radius' ? 'R' : '';
        out.push({ text: pre + fmt(val, opt('dimDecimals')) + (c.type === 'angle' ? '°' : ''), value: val, pos3: to3(fr, [a[0] + (c.lp?.[0] ?? 0), a[1] + (c.lp?.[1] ?? 0)]), kind: 'cons', sk: sk.id, cons: c.id, driven: c.driving === false, c, fr, skRef: sk });
      }
      if (opt('autoDims')) for (const d0 of autoDims(sk)) {
        const lpU = sk.autoLp?.[autoKey(d0.cons)]; // dragged by the user (dimdrag.js)
        const d = lpU ? { ...d0, lp: lpU, at: [d0.at[0] - d0.lp[0] + lpU[0], d0.at[1] - d0.lp[1] + lpU[1]] } : d0;
        out.push({ ...d, pos3: to3(fr, d.at), kind: 'auto', sk: sk.id, c: { ...d.cons, lp: d.lp, lpUser: !!lpU }, fr, skRef: sk });
      }
      // depth dimension line: from the sketch plane along the extrude direction, beside the profile
      if (f.type === 'extrude' && typeof f.depth === 'number' && (!f.end || f.end === 'blind' || f.end === 'midplane') && pts.length) {
        // profile points only (ends of non-construction lines / arcs), not construction or converted reference lines
        const ids = new Set(); for (const g of sk.geo) if (!g.construction && (g.type === 'line' || g.type === 'arc')) [g.p1, g.p2, g.s, g.e].forEach((x) => x && ids.add(x));
        const pp = pts.filter((p) => ids.has(p.id)).length ? pts.filter((p) => ids.has(p.id)) : pts;
        let side = pp[0], bd = -1; const c2 = [pp.reduce((a, p) => a + p.x, 0) / pp.length, pp.reduce((a, p) => a + p.y, 0) / pp.length];
        for (const p of pp) { const d2 = (p.x - c2[0]) ** 2 + (p.y - c2[1]) ** 2; if (d2 > bd) { bd = d2; side = p; } }
        let dir = fr.n.slice(); if (f.reverse) dir = dir.map((x) => -x); if (f.op === 'cut' && f.end !== 'midplane') dir = dir.map((x) => -x);
        const at = Array.isArray(f.depthAt) ? f.depthAt : [side.x, side.y]; // f.depthAt = dragged by the user
        const p0 = to3(fr, at), k0 = f.end === 'midplane' ? -0.5 : 0, k1 = f.end === 'midplane' ? 0.5 : 1;
        // plane through the middle of the depth, parallel to the sketch: dragging the depth label moves the line on it
        const om = fr.o.map((x, i) => x + dir[i] * f.depth * (k0 + k1) / 2);
        this._depthLine = { a: p0.map((x, i) => x + dir[i] * f.depth * k0), b: p0.map((x, i) => x + dir[i] * f.depth * k1), fr: { ...fr, o: om } };
      } else this._depthLine = null;
    }
    if (f.type !== 'sketch') {
      const P = [['depth', 'Depth', ' mm'], ['angle', 'Angle', '°'], ['radius', 'Radius', ' mm'], ['distance', 'Distance', ' mm'], ['thickness', 'Thickness', ' mm'], ['spacing', 'Spacing', ' mm'], ['count', 'Count', '']];
      const base = ctr || this.dimFaceC || [0, 0, 0];
      let k = 0;
      for (const [key, lab, u] of P) if (typeof f[key] === 'number' && !(f.type === 'extrude' && f.end && f.end !== 'blind' && key === 'depth')) {
        const line = key === 'depth' && this._depthLine && sk ? this._depthLine : null;
        out.push({ text: `${lab} ${fmt(f[key], opt('dimDecimals'))}${u}`, value: f[key], pos3: line ? line.b : base, dy: line ? 0 : opt('featDimStackPx') * k++, kind: 'feat', key, ...(line ? { line, lineFr: line.fr } : {}) });
      }
    }
    return out;
  }
  drawFeatureDims(ctx) {
    const hits = [];
    (this._dimHitsBy ||= new WeakMap()).set(this.vp.pane || this.vp, hits);
    if (!this.dimFeat || this.sketcher) return;
    const dark = document.body.classList.contains('dark');
    ctx.font = `${opt('modelDimFontPx')}px ${opt('overlayFont')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const lines = opt('modelDimLines');
    for (const d of this.featureDims()) {
      let s = this.vp.toScreen(d.pos3);
      // dimension lines like in the sketch (Options > Dimensions); the label then sits on its dimension line
      const lc = d.kind === 'feat' ? opt('featDimColor') : d.driven ? opt('modelDimDriven') : opt(dark ? 'modelDimColorDark' : 'modelDimColor');
      const at = lines && (d.c || d.line) ? drawModelDimLines(ctx, this.vp, d, lc, d.kind === 'auto') : null;
      if (at) s = at;
      const x = s[0] + (d.kind === 'feat' && !at ? opt('featDimOffsetPx') : 0), y = s[1] + (d.dy || 0);
      const pad = opt('modelDimPadPx'), bh = opt('modelDimBoxH');
      const w = ctx.measureText(d.text).width + pad;
      ctx.fillStyle = opt(dark ? 'modelDimBgDark' : 'modelDimBg');
      ctx.strokeStyle = d.kind === 'feat' ? opt('featDimColor') : opt('modelDimColor'); ctx.lineWidth = opt('modelDimBoxLineW');
      ctx.fillRect(x - w / 2, y - bh / 2, w, bh);
      if (d.kind === 'auto') ctx.setLineDash(opt('autoDimDash')); // size without a dimension yet (double-click = add one)
      ctx.strokeRect(x - w / 2, y - bh / 2, w, bh); ctx.setLineDash([]);
      ctx.fillStyle = d.driven ? opt('modelDimDriven') : d.kind === 'feat' ? opt(dark ? 'featDimTextDark' : 'featDimText') : opt(dark ? 'modelDimTextDark' : 'modelDimText');
      ctx.fillText(d.text, x - w / 2 + pad / 2, y);
      hits.push({ ...d, x0: x - w / 2, x1: x + w / 2, y0: y - bh / 2, y1: y + bh / 2 });
    }
  }
  // double-click a dimension shown on the model: its label becomes an edit box right there (no window).
  // Enter = apply (rebuild, or the feature preview while a feature dialog is open), Esc / click elsewhere = cancel.
  editShownDim(d) {
    if (d.driven) { toast('Driven (reference) dimensions cannot be modified.'); return; }
    this._dimInline?.cancel();
    const inp = h('input', { type: 'text', class: 'dim-inline', spellcheck: 'false', value: fmt(d.value, opt('featEditDecimals')) });
    const w = Math.max(opt('modelDimEditMinW'), d.x1 - d.x0 + opt('modelDimEditExtraW'));
    Object.assign(inp.style, { left: (d.x0 + d.x1) / 2 - w / 2 + 'px', top: d.y0 - opt('modelDimEditDyPx') + 'px', width: w + 'px' });
    for (const ev of ['pointerdown', 'dblclick', 'wheel']) inp.addEventListener(ev, (e) => e.stopPropagation());
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true; this._dimInline = null;
      const val = inp.value; inp.remove(); this.vp.requestRender();
      if (ok) this.applyShownDim(d, val);
    };
    this._dimInline = { inp, d, cancel: () => finish(false) };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => finish(false));
    this.vp.el.appendChild(inp);
    inp.focus(); inp.select();
  }
  applyShownDim(d, v) {
    if (v === null || v === undefined || String(v).trim() === '') return;
    const num = Number(String(v).replace(',', '.'));
    if (!isFinite(num) || (d.kind === 'feat' && d.key !== 'angle' && num <= 0)) { toast('Invalid value', 'error'); return; }
    this.beginChange();
    if (d.kind === 'feat') this.F(this.dimFeat)[d.key] = d.key === 'count' ? Math.max(opt('featMinCount'), Math.round(num)) : num;
    else if (d.kind === 'auto') {
      // a size the sketch had no dimension for: typing a value adds that dimension to the sketch
      if (num <= 0) { toast('Invalid value', 'error'); this.commit(); return; }
      const sk = this.F(d.sk);
      sk.next = sk.next || 1;
      const c = { id: 'c' + sk.next++, ...d.cons, value: num, lp: d.lp, ...(sk.autoLp?.[autoKey(d.cons)] ? { lpUser: true } : {}) };
      if (sk.autoLp) delete sk.autoLp[autoKey(d.cons)];
      sk.cons.push(c);
      const r = solveSketch(sk);
      const bad = (list) => (list || []).some((id) => id === c.id || String(id).startsWith(c.id + '#'));
      if (!r || r.ok === false || bad(r.conflicting) || bad(r.redundant)) {
        // the size already follows from other dimensions/relations: change the dimension that drives it instead
        // (the sketch keeps its dimensioning, only that value changes)
        sk.cons.splice(sk.cons.indexOf(c), 1); solveSketch(sk);
        const dr = driveSize(sk, { ...d.cons, value: num }, r, { maxStep: opt('sizeStepPct') / 100 });
        if (!dr.cons && dr.fixed && sk.geo.some((g) => g.onEdge)) { this.applyUpstream(sk, { ...d.cons, value: num }, dr.reason); return; } // follows linked edges: change the sketch that made them
        if (dr.cons) {
          const ln = dr.cons.type === 'radius' ? 'R' : dr.cons.type === 'diameter' ? 'Ø' : '';
          this.app.setStatus(this._statusAfter = `${sk.name}: dimension ${ln}${fmt(dr.old, opt('partReportDecimals'))} → ${ln}${fmt(dr.value, opt('partReportDecimals'))} (it drives this size, now ${fmt(num, opt('partReportDecimals'))})`);
          try { window.__lithLog?.('DRIVE', sk.name, dr.cons.id, dr.old, '->', dr.value, 'size', num); } catch {}
        } else toast(dr.reason, 'warn', opt('toastWarnMs'));
      } else this.app.setStatus(`Dimension ${fmt(num, opt('partReportDecimals'))} added to ${sk.name}`);
    } else {
      const sk = this.F(d.sk), c = sk.cons.find((x) => x.id === d.cons);
      const r = solveStepped(sk, c, num, { maxStep: opt('sizeStepPct') / 100 }); // big changes in steps
      if (r && r.ok === false) toast('The sketch cannot be solved with this value', 'error');
    }
    this.commit();
    this.renderTree(); this.updateSketchDisplay();
    if (this.featUI) this.featUI.preview(); else this.regen(); // feature dialog open: keep its preview
  }

  showSelectionInfo() {
    const s = this.sel[this.sel.length - 1];
    if (!s) { this.app.setStatus('Ready'); return; }
    if (s.kind === 'edge') {
      const ed = s.edge || this.mesh?.edges.find((e) => e.id === s.id);
      const dec = opt('partReportDecimals');
      let txt = `Edge  Length: ${fmt(ed?.length ?? 0, dec)} mm`;
      if (ed?.type === 'circle') { const c = circle3(ed.pts); if (c) txt += `  Radius: ${fmt(c.r, dec)} mm  Ø${fmt(2 * c.r, dec)}`; }
      this.app.setStatus(txt);
    } else if (s.kind === 'face') this.app.setStatus(`Face  Area: ${fmt(s.area, opt('partReportDecimals'))} mm²${s.plane ? '  (planar)' : s.ftype ? '  (' + s.ftype + ')' : ''}`);
    else this.app.setStatus(this.selItem(s).label || '');
  }

}

export { driveSize, autoDims } from './drive.js';
