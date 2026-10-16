// Part: evaluate (mass props, measure) and import/export
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
import { dxfToSketch, sketchToDxf, skippedTypes, skippedText } from '../io/dxf.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis } from './part.js';

export class PartExchange {
  // ======================= evaluate =======================
  async cmdMass() {
    const res = await api.kernel('mass', { features: this.doc.features, upTo: this.doc.rollback ?? undefined });
    if (!res) { toast('No solid body to evaluate'); return; }
    const mat = MATERIALS.find((m) => m.name === this.doc.material) || MATERIALS[0];
    const massG = (res.volume / 1000) * mat.density;
    const P = (k, v) => h('tr', {}, h('td', {}, k), h('td', {}, v));
    const bb = res.bbox;
    await dialog({
      title: `Mass Properties of ${this.doc.name}`,
      body: h('table', { class: 'mass' },
        P('Material', `${mat.name}${mat.name === 'Not specified' ? ' (density 1 g/cm³)' : ''}`),
        P('Density', `${mat.density} g/cm³`),
        P('Mass', `${fmt(massG, 3)} g  (${fmt(massG / 1000, 5)} kg)`),
        P('Volume', `${fmt(res.volume, 3)} mm³`),
        P('Surface area', `${fmt(res.area, 3)} mm²`),
        P('Center of mass', `X = ${fmt(res.com[0], 3)}  Y = ${fmt(res.com[1], 3)}  Z = ${fmt(res.com[2], 3)} mm`),
        bb ? P('Bounding box', `${fmt(bb.max[0] - bb.min[0], 3)} × ${fmt(bb.max[1] - bb.min[1], 3)} × ${fmt(bb.max[2] - bb.min[2], 3)} mm`) : null),
      buttons: [{ label: 'Close', primary: true }],
    });
  }

  cmdMeasure() {
    const show = (v) => {
      const items = v.items || [];
      const lines = [];
      for (const it of items) {
        if (it.kind === 'edge') {
          const ed = it.edge || this.mesh?.edges.find((e) => e.id === it.id);
          let s = `${it.label}: length ${fmt(ed?.length ?? 0, 3)} mm`;
          if (ed?.type === 'circle') { const c = circle3(ed.pts); if (c) s += `, Ø ${fmt(2 * c.r, 3)} mm`; }
          lines.push(s);
        } else if (it.kind === 'face') lines.push(`${it.label}: area ${fmt(it.area, 3)} mm²`);
      }
      if (items.length === 2) {
        const [a, b] = items;
        const pa = a.kind === 'face' ? a.c : a.mid, pb = b.kind === 'face' ? b.c : b.mid;
        if (pa && pb) lines.push(`Center distance: ${fmt(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), 3)} mm`);
        if (a.plane && b.plane) {
          const na = a.plane.normal, nb = b.plane.normal;
          const d = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
          if (d > 0.9999) lines.push(`Normal distance: ${fmt(Math.abs((b.c[0] - a.c[0]) * na[0] + (b.c[1] - a.c[1]) * na[1] + (b.c[2] - a.c[2]) * na[2]), 3)} mm`);
          else lines.push(`Angle: ${fmt((Math.acos(Math.min(1, d)) * 180) / Math.PI, 3)}°`);
        }
      }
      this.app.pm.current?.inputs.result && (this.app.pm.current.inputs.result.innerHTML = lines.map((l) => `<div>${l}</div>`).join('') || 'Select edges or faces.');
      this.updateHighlights();
    };
    this.app.pm.show({
      title: 'Measure', iconName: 'measure',
      fields: [{ key: 'items', type: 'selbox', label: 'Selections', accepts: (it) => it.kind === 'edge' || it.kind === 'face' }, { key: 'result', type: 'info', text: 'Select edges or faces.' }],
      onChange: show, onCancel: () => { this.app.setConfirmCorner(null); this.updateHighlights(); },
      okLabel: 'Close',
      onOk: () => { this.app.setConfirmCorner(null); this.updateHighlights(); return true; },
    });
    this.app.showPanel('pm');
  }

  // ======================= exchange =======================
  async exportCAD(fmtName) {
    try {
      const text = await api.kernel(fmtName === 'iges' ? 'exportIges' : 'exportStep', { features: this.doc.features, upTo: this.doc.rollback ?? undefined });
      const ext = fmtName === 'iges' ? 'igs' : 'step';
      const path = await api.saveFile({ defaultPath: `${this.doc.name}.${ext}`, filters: [{ name: fmtName.toUpperCase(), extensions: fmtName === 'iges' ? ['igs', 'iges'] : ['step', 'stp'] }], text });
      if (path) toast(`Exported ${path}`, 'ok');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }
  async importCAD(text, format, name) {
    try {
      this.app.setBusy(true);
      const res = await api.kernel('importCAD', { text, format });
      this.beginChange();
      const f = { id: this.newId(), type: 'import', format: 'step', data: res.step, source: name };
      f.name = this.nextName(f);
      this.insertFeature(f);
      this.commit('import');
      this.renderTree();
      await this.regen();
      if (this.mesh?.bbox) this.vp.fit(this.mesh.bbox);
      toast(`Imported ${name}`, 'ok');
    } catch (e) { toast('Import failed: ' + e.message, 'error'); } finally { this.app.setBusy(false); }
  }
  importDxf(dxfText, name) {
    // DXF goes into the active sketch, or a new sketch on the Front plane
    const apply = (sk) => {
      const n = dxfToSketch(dxfText, sk);
      sk.resolve(true);
      const skip = skippedText(skippedTypes(dxfText));
      toast(`Imported ${n} entities from ${name} into ${sk.sk.name}${skip ? ' — ' + skip : ''}`, skip ? 'info' : 'ok', skip ? 9000 : 3500);
      this.zoomFit();
    };
    if (this.sketcher) { this.sketcher.pushUndo(); apply(this.sketcher); return; }
    this.startSketch(STD_PLANES.Front, 'Front');
    apply(this.sketcher);
  }
  async exportSketchDxf(f) {
    const text = sketchToDxf(f);
    const path = await api.saveFile({ defaultPath: `${f.name}.dxf`, filters: [{ name: 'DXF', extensions: ['dxf'] }], text });
    if (path) toast(`Exported ${path}`, 'ok');
  }

}
