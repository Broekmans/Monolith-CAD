// Part: feature PropertyManagers (extrude, revolve, fillet, ...)
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

export class PartFeatures {
  // ======================= features =======================
  selectedSketchId() {
    const s = this.sel.find((x) => x.kind === 'sketch');
    return s?.id || null;
  }
  // Run `fn(sketchId)` with a sketch: current sketch, selected sketch, or a new one.
  withSketch(fn) {
    if (this.sketcher) {
      const id = this.sketcher.sk.id;
      this.exitSketch(true);
      if (this.F(id)) fn(id);
      return;
    }
    const sid = this.selectedSketchId();
    if (sid) { fn(sid); return; }
    const planeSel = this.sel.find((x) => x.kind === 'plane' || (x.kind === 'face' && x.plane));
    if (planeSel) { this.startSketch(planeSel.plane, planeSel.kind === 'plane' ? planeSel.name : 'Face', (f) => fn(f.id), this.faceRefOf(planeSel)); return; }
    fn(null);
  }

  cmdExtrude(op) { this.withSketch((sid) => this.openFeaturePM({ type: 'extrude', op, sketch: sid, end: op === 'cut' ? 'throughAll' : 'blind', depth: 10, reverse: false })); }
  cmdRevolve(op) {
    this.withSketch((sid) => {
      const sk = sid ? this.F(sid) : null;
      const lines = sk ? sk.geo.filter((g) => g.type === 'line') : [];
      const axis = lines.find((l) => l.construction) || null;
      this.openFeaturePM({ type: 'revolve', op, sketch: sid, axis: axis ? { line: axis.id } : null, angle: 360, reverse: false });
    });
  }
  cmdFillet(type) {
    const edges = this.sel.filter((s) => s.kind === 'edge').map((s) => this.selItem(s));
    this.openFeaturePM(type === 'fillet' ? { type, edges, radius: 2 } : { type, edges, distance: 1 });
  }
  cmdShell() {
    const faces = this.sel.filter((s) => s.kind === 'face').map((s) => this.selItem(s));
    this.openFeaturePM({ type: 'shell', faces, thickness: 1 });
  }
  cmdPattern(type) {
    const feats = this.sel.filter((s) => s.kind === 'feature').map((s) => this.selItem(s));
    if (type === 'linearPattern') this.openFeaturePM({ type, features: feats, direction: 'X', spacing: 20, count: 3, reverse: false });
    else if (type === 'circularPattern') this.openFeaturePM({ type, features: feats, axis: 'Y', count: 6, angle: 360 });
    else this.openFeaturePM({ type, features: feats, plane: 'Right' });
  }

  editFeature(id) {
    const f = this.F(id);
    if (!f) return;
    const draft = structuredClone(f);
    // convert stored refs into selection items for the PM
    if (draft.edges) draft.edges = draft.edges.map((e, i) => ({ ...e, kind: 'edge', key: 'eref' + i, label: `Edge<${i + 1}>` }));
    if (draft.faces) draft.faces = draft.faces.map((e, i) => ({ ...e, kind: 'face', key: 'fref' + i, label: `Face<${i + 1}>` }));
    if (draft.features) draft.features = draft.features.map((fid) => ({ kind: 'feature', id: fid, key: 'feature:' + fid, label: this.F(fid)?.name || fid }));
    // rebuild to just before this feature so edges/faces can be picked
    const idx = this.doc.features.indexOf(f);
    this.openFeaturePM(draft, { editId: id, base: this.doc.features.slice(0, idx), after: this.doc.features.slice(idx + 1) });
  }

  // Generic PropertyManager for features with live preview.
  openFeaturePM(draft, edit = null) {
    const t = draft.type;
    const meta = FEATURE_META[metaKey(draft)];
    const title = edit ? this.F(edit.editId).name : meta.base.replace(/-/g, '-') ;
    const sketchItem = (id) => (id ? [{ kind: 'sketch', id, key: 'sketch:' + id, label: this.F(id)?.name }] : []);
    let fields = [];
    const values = { ...draft };
    const isSketch = (it) => it.kind === 'sketch';
    if (t === 'extrude') {
      values.sketchSel = sketchItem(draft.sketch);
      fields = [
        { key: 'sketchSel', type: 'selbox', label: 'Sketch Profile', max: 1, accepts: isSketch },
        { type: 'group', label: 'Direction 1', fields: [
          { key: 'end', type: 'select', label: 'End Condition', options: [{ value: 'blind', label: 'Blind' }, { value: 'throughAll', label: 'Through All' }, { value: 'midplane', label: 'Mid Plane' }] },
          { key: 'depth', type: 'number', label: 'Depth', unit: 'mm', min: 0.0001, step: 1 },
          { key: 'reverse', type: 'check', label: 'Reverse Direction' },
        ] },
      ];
      if (draft.op === 'cut') fields[1].fields.push({ key: 'bothSides', type: 'check', label: 'Through All - Both Sides' });
    } else if (t === 'revolve') {
      values.sketchSel = sketchItem(draft.sketch);
      const axisOpts = () => {
        const sk = this.F(values.sketchSel?.[0]?.id);
        const opts = [];
        if (sk) for (const l of sk.geo.filter((g) => g.type === 'line')) opts.push({ value: 'line:' + l.id, label: `${l.construction ? 'Centerline' : 'Line'}${l.id.slice(1)} (sketch)` });
        opts.push({ value: 'X', label: 'X Axis' }, { value: 'Y', label: 'Y Axis' }, { value: 'Z', label: 'Z Axis' });
        return opts;
      };
      values.axisSel = draft.axis?.line ? 'line:' + draft.axis.line : typeof draft.axis === 'string' ? draft.axis : axisOpts()[0]?.value;
      fields = [
        { key: 'sketchSel', type: 'selbox', label: 'Sketch Profile', max: 1, accepts: isSketch },
        { key: 'axisSel', type: 'select', label: 'Axis of Revolution', options: axisOpts() },
        { type: 'group', label: 'Direction 1', fields: [
          { key: 'angle', type: 'number', label: 'Angle', unit: '°', min: 0.01, step: 15 },
          { key: 'reverse', type: 'check', label: 'Reverse Direction' }] },
      ];
      this._revolveAxisOpts = axisOpts;
    } else if (t === 'fillet' || t === 'chamfer') {
      fields = [
        { key: 'edges', type: 'selbox', label: 'Edges', accepts: (it) => it.kind === 'edge' },
        t === 'fillet' ? { key: 'radius', type: 'number', label: 'Radius', unit: 'mm', min: 0.0001, step: 0.5 } : { key: 'distance', type: 'number', label: 'Distance', unit: 'mm', min: 0.0001, step: 0.5 },
      ];
    } else if (t === 'shell') {
      fields = [
        { key: 'faces', type: 'selbox', label: 'Faces to Remove', accepts: (it) => it.kind === 'face' },
        { key: 'thickness', type: 'number', label: 'Thickness', unit: 'mm', min: 0.0001, step: 0.5 },
      ];
    } else if (t === 'linearPattern' || t === 'circularPattern' || t === 'mirror') {
      const featureOk = (it) => it.kind === 'feature' && ['extrude', 'revolve'].includes(this.F(it.id)?.type);
      fields = [{ key: 'features', type: 'selbox', label: 'Features to Pattern', accepts: featureOk }];
      const axisSel = (key, label) => ({ key, type: 'select', label, options: [{ value: 'X', label: 'X Axis' }, { value: 'Y', label: 'Y Axis' }, { value: 'Z', label: 'Z Axis' }, { value: 'edge', label: 'Selected edge' }] });
      if (t === 'linearPattern') {
        values.dirSel = typeof draft.direction === 'string' ? draft.direction : 'edge';
        values.dirEdge = draft.direction?.edge ? [draft.direction.edge] : [];
        fields.push({ type: 'group', label: 'Direction 1', fields: [axisSel('dirSel', 'Direction'), { key: 'dirEdge', type: 'selbox', label: 'Direction edge (optional)', max: 1, accepts: (it) => it.kind === 'edge' && it.type === 'line' },
          { key: 'spacing', type: 'number', label: 'Spacing', unit: 'mm', step: 1 }, { key: 'count', type: 'number', label: 'Instances', min: 2, step: 1 }, { key: 'reverse', type: 'check', label: 'Reverse Direction' }] });
      } else if (t === 'circularPattern') {
        values.axisSel = typeof draft.axis === 'string' ? draft.axis : 'edge';
        values.axisEdge = draft.axis?.edge ? [draft.axis.edge] : [];
        fields.push({ type: 'group', label: 'Parameters', fields: [axisSel('axisSel', 'Axis'), { key: 'axisEdge', type: 'selbox', label: 'Axis edge (circular or linear)', max: 1, accepts: (it) => it.kind === 'edge' },
          { key: 'angle', type: 'number', label: 'Total Angle', unit: '°', min: 0.01, step: 15 }, { key: 'count', type: 'number', label: 'Instances', min: 2, step: 1 }] });
      } else {
        values.planeSel = typeof draft.plane === 'string' ? draft.plane : 'face';
        values.planeFace = draft.planeFace ? [draft.planeFace] : [];
        fields.push({ key: 'planeSel', type: 'select', label: 'Mirror Plane', options: [{ value: 'Front', label: 'Front Plane' }, { value: 'Top', label: 'Top Plane' }, { value: 'Right', label: 'Right Plane' }, { value: 'face', label: 'Selected planar face' }] },
          { key: 'planeFace', type: 'selbox', label: 'Mirror face', max: 1, accepts: (it) => it.kind === 'face' && !!it.plane });
      }
    }
    const build = (v) => this.featureFromValues(draft, v);
    const base = edit ? edit.base : this.doc.features.slice(0, this.insertIndex());
    let alive = true;
    this.setPickBase(base);
    const preview = (v) => {
      if (!alive) return;
      const f = build(v);
      if (!f) { this.regen(base); return; }
      this.regen([...base, f]);
    };
    if (edit) this.regen(base);
    let debounce = null;
    this.pmState = { draft, edit };
    this.app.pm.show({
      title, iconName: meta.icon, fields, values,
      message: t === 'fillet' || t === 'chamfer' ? 'Select edges in the graphics area.' : t === 'shell' ? 'Select the faces to remove (e.g. the top face).' : '',
      onChange: (v, key) => {
        if (t === 'revolve' && key === 'sketchSel') {
          const opts = this._revolveAxisOpts();
          const sel = this.app.pm.current.inputs.axisSel;
          sel.innerHTML = '';
          for (const o of opts) sel.appendChild(h('option', { value: o.value }, o.label));
          v.axisSel = opts[0]?.value; sel.value = v.axisSel;
        }
        this.updateHighlights();
        clearTimeout(debounce); debounce = setTimeout(() => preview(v), 60);
      },
      onOk: (v) => {
        const f = build(v);
        if (!f) { this.app.pm.current.setMessage('Complete the required selections first.', 'error'); return false; }
        alive = false; clearTimeout(debounce); this.clearPickBase();
        this.beginChange();
        if (edit) {
          const i = this.doc.features.findIndex((x) => x.id === edit.editId);
          f.id = edit.editId; f.name = this.doc.features[i].name;
          this.doc.features[i] = f;
        } else {
          f.id = this.newId(); f.name = this.nextName(f);
          this.insertFeature(f);
        }
        this.commit(edit ? 'edit feature' : 'add feature');
        this.pmState = null;
        this.app.setConfirmCorner(null);
        this.sel = [];
        this.renderTree(); this.updateSketchDisplay(); this.updateHighlights();
        this.regen();
        return true;
      },
      onCancel: () => { alive = false; clearTimeout(debounce); this.clearPickBase(); this.pmState = null; this.app.setConfirmCorner(null); this.sel = []; this.updateHighlights(); this.updateSketchDisplay(); this.regen(); },
    });
    this.app.showPanel('pm');
    this.app.setConfirmCorner({ ok: () => this.app.pm.ok(), cancel: () => this.app.pm.cancel() });
    this.sel = [];
    this.updateHighlights();
    preview(values);
    this.app.cm.refresh();
  }

  featureFromValues(draft, v) {
    const t = draft.type;
    const f = { type: t };
    if (draft.op) f.op = draft.op;
    if (t === 'extrude') {
      const s = v.sketchSel?.[0]; if (!s) return null;
      Object.assign(f, { sketch: s.id, end: v.end, depth: +v.depth, reverse: !!v.reverse, bothSides: !!v.bothSides });
    } else if (t === 'revolve') {
      const s = v.sketchSel?.[0]; if (!s) return null;
      const ax = String(v.axisSel || '');
      Object.assign(f, { sketch: s.id, axis: ax.startsWith('line:') ? { line: ax.slice(5) } : ax || 'Y', angle: +v.angle, reverse: !!v.reverse });
    } else if (t === 'fillet' || t === 'chamfer') {
      if (!v.edges?.length) return null;
      f.edges = v.edges.map((e) => edgeRef(e, this.pick?.mesh));
      if (t === 'fillet') f.radius = +v.radius; else f.distance = +v.distance;
    } else if (t === 'shell') {
      if (!v.faces?.length) return null;
      f.faces = v.faces.map((x) => (x.bb ? { c: x.c, n: x.n, bb: x.bb } : { c: x.c, n: x.n || x.plane?.normal, bb: this.pick?.mesh.bbox }));
      f.thickness = +v.thickness;
    } else {
      if (!v.features?.length) return null;
      f.features = v.features.map((x) => x.id);
      if (t === 'linearPattern') {
        let dir = v.dirSel;
        if (dir === 'edge') { const e = v.dirEdge?.[0]; if (!e) return null; const ax = edgeAxis(e.edge || this.mesh?.edges.find((x) => x.id === e.id) || e); if (!ax) return null; dir = { p: ax.p, d: ax.d, edge: { mid: e.mid, type: e.type, label: e.label, kind: 'edge', key: e.key, pts: e.pts || ax.pts } }; }
        Object.assign(f, { direction: dir, spacing: +v.spacing, count: Math.max(2, Math.round(+v.count)), reverse: !!v.reverse });
      } else if (t === 'circularPattern') {
        let ax = v.axisSel;
        if (ax === 'edge') { const e = v.axisEdge?.[0]; if (!e) return null; const a = edgeAxis(e.edge || this.mesh?.edges.find((x) => x.id === e.id) || e); if (!a) return null; ax = { p: a.p, d: a.d, edge: { mid: e.mid, type: e.type, label: e.label, kind: 'edge', key: e.key } }; }
        Object.assign(f, { axis: ax, count: Math.max(2, Math.round(+v.count)), angle: +v.angle });
      } else {
        if (v.planeSel === 'face') { const fc = v.planeFace?.[0]; if (!fc) return null; f.plane = fc.plane; f.planeFace = { kind: 'face', c: fc.c, n: fc.n, plane: fc.plane, key: fc.key, label: fc.label }; }
        else f.plane = v.planeSel;
      }
    }
    return f;
  }

}
