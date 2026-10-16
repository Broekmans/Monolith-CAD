// Part: picking, highlights, overlay, double-click feature dims, tree hover
// Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { Sketcher, SKETCH_TOOLS, newSketch } from '../sketch/sketcher.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { sketchCurves, sampleCurve } from '../../../shared/profile.mjs';
import { solve as solveSketch, measure as measureDim, DIM_TYPES } from '../sketch/solver.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import { dxfToSketch, sketchToDxf } from '../io/dxf.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis } from './part.js';

export class PartPicking {
  // ======================= picking =======================
  bindViewport() {
    const el = this.vp.el;
    el.addEventListener('pointermove', (e) => {
      if (this.sketcher) return;
      const p = this.pickAt(e);
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
      const moved = Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]) > 4;
      this._downAt = null;
      if (moved) return;
      const p = this.pickAt(e);
      this.clickItem(p, e.ctrlKey || e.shiftKey);
    });
    el.addEventListener('dblclick', (e) => {
      if (this.sketcher) return;
      const r = this.vp.el.getBoundingClientRect();
      const hit = (this._dimHits || []).find((d) => { const x = e.clientX - r.left, y = e.clientY - r.top; return x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1; });
      if (hit) { this.editShownDim(hit); return; }
      const p = this.pickAt(e);
      if (p?.kind === 'sketch') this.editSketch(p.id);
      else if (p?.kind === 'face' && !this.app.pm.open) {
        const f = this.pick?.mesh.faces.find((x) => x.id === p.id);
        this.showFeatureDims(f?.feat || null);
      }
    });
  }

  clickItem(p, additive) {
    const pm = this.app.pm.current;
    if (pm && p) {
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
  afterSelection() {
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
      let best = null, bd = 6;
      for (const ed of pk.mesh.edges) {
        const p = ed.pts;
        for (let i = 3; i < p.length; i += 3) {
          const a = this.vp.toScreen([p[i - 3], p[i - 2], p[i - 1]]), b = this.vp.toScreen([p[i], p[i + 1], p[i + 2]]);
          const d = segDist([sx, sy], a, b);
          if (d < bd) {
            const mid = new THREE.Vector3((p[i - 3] + p[i]) / 2, (p[i - 2] + p[i + 1]) / 2, (p[i - 1] + p[i + 2]) / 2);
            const depth = mid.clone().sub(origin).dot(viewDir);
            if (this.displayMode === 'wire' || depth <= faceDepth + this.vp.scale * 8) { bd = d; best = ed; }
          }
        }
      }
      if (best) return { kind: 'edge', id: best.id, mid: best.mid, type: best.type, key: 'edge:' + best.id, edge: best };
    }
    // sketches
    {
      let best = null, bd = 6;
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
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: it.col, transparent: true, opacity: 0.45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false }));
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
      ctx.strokeStyle = it.col === COLORS.hover ? '#ff9a1a' : '#1e90ff';
      ctx.lineWidth = 3.2;
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
      ctx.strokeStyle = '#2050b0'; ctx.lineWidth = 1.2;
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const p = this.vp.toScreen([d[0] * this.vp.scale * 18, d[1] * this.vp.scale * 18, d[2] * this.vp.scale * 18]);
        ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      }
    }
    // plane labels
    for (const o of this.planeGroup.children) {
      if (!o.userData.plane) continue;
      const fr = frameOf(STD_PLANES[o.userData.plane]);
      const S = this.planeSize();
      const s = this.vp.toScreen(to3(fr, [-S, S]));
      ctx.font = '11px Segoe UI, sans-serif'; ctx.fillStyle = document.body.classList.contains('dark') ? '#9cc2ef' : '#2a4f8a'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(o.userData.plane, s[0] + 4, s[1] - 2);
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
    this._dimHits = [];
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
        out.push({ text: pre + fmt(val, 2) + (c.type === 'angle' ? '°' : ''), value: val, pos3: to3(fr, [a[0] + (c.lp?.[0] ?? 0), a[1] + (c.lp?.[1] ?? 0)]), kind: 'cons', sk: sk.id, cons: c.id, driven: c.driving === false });
      }
    }
    if (f.type !== 'sketch') {
      const P = [['depth', 'Depth', ' mm'], ['angle', 'Angle', '°'], ['radius', 'Radius', ' mm'], ['distance', 'Distance', ' mm'], ['thickness', 'Thickness', ' mm'], ['spacing', 'Spacing', ' mm'], ['count', 'Count', '']];
      const base = ctr || this.dimFaceC || [0, 0, 0];
      let k = 0;
      for (const [key, lab, u] of P) if (typeof f[key] === 'number' && !(f.type === 'extrude' && f.end && f.end !== 'blind' && key === 'depth')) out.push({ text: `${lab} ${fmt(f[key], 2)}${u}`, value: f[key], pos3: base, dy: 22 * k++, kind: 'feat', key });
    }
    return out;
  }
  drawFeatureDims(ctx) {
    this._dimHits = [];
    if (!this.dimFeat || this.sketcher) return;
    const dark = document.body.classList.contains('dark');
    ctx.font = '13px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const d of this.featureDims()) {
      const s = this.vp.toScreen(d.pos3);
      const x = s[0] + (d.kind === 'feat' ? 14 : 0), y = s[1] + (d.dy || 0);
      const w = ctx.measureText(d.text).width + 10;
      ctx.fillStyle = dark ? 'rgba(30,34,40,0.92)' : 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = d.kind === 'feat' ? '#c06000' : '#1e5fbf'; ctx.lineWidth = 1;
      ctx.fillRect(x - w / 2, y - 10, w, 20); ctx.strokeRect(x - w / 2, y - 10, w, 20);
      ctx.fillStyle = d.driven ? '#888' : d.kind === 'feat' ? (dark ? '#ffb060' : '#a04f00') : (dark ? '#8fbfff' : '#1e4fa0');
      ctx.fillText(d.text, x - w / 2 + 5, y);
      this._dimHits.push({ ...d, x0: x - w / 2, x1: x + w / 2, y0: y - 10, y1: y + 10 });
    }
  }
  async editShownDim(d) {
    if (d.driven) { toast('Driven (reference) dimensions cannot be modified.'); return; }
    const v = await promptText('Modify dimension', fmt(d.value, 4));
    if (v === null || v === undefined || v === '') return;
    const num = Number(String(v).replace(',', '.'));
    if (!isFinite(num) || (d.kind === 'feat' && d.key !== 'angle' && num <= 0)) { toast('Invalid value', 'error'); return; }
    this.beginChange();
    if (d.kind === 'feat') this.F(this.dimFeat)[d.key] = d.key === 'count' ? Math.max(2, Math.round(num)) : num;
    else {
      const sk = this.F(d.sk), c = sk.cons.find((x) => x.id === d.cons);
      const old = c.value; c.value = num;
      const r = solveSketch(sk);
      if (r && r.ok === false) { c.value = old; solveSketch(sk); toast('The sketch cannot be solved with this value', 'error'); }
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
      let txt = `Edge  Length: ${fmt(ed?.length ?? 0, 3)} mm`;
      if (ed?.type === 'circle') { const c = circle3(ed.pts); if (c) txt += `  Radius: ${fmt(c.r, 3)} mm  Ø${fmt(2 * c.r, 3)}`; }
      this.app.setStatus(txt);
    } else if (s.kind === 'face') this.app.setStatus(`Face  Area: ${fmt(s.area, 3)} mm²${s.plane ? '  (planar)' : s.ftype ? '  (' + s.ftype + ')' : ''}`);
    else this.app.setStatus(this.selItem(s).label || '');
  }

}
