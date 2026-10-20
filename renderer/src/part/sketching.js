// Part: entering/exiting sketches
// Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
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
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis } from './part.js';

export class PartSketching {
  // ======================= sketching =======================
  cmdSketch() {
    if (this.sketcher) { this.exitSketch(true); return; }
    const s = this.sel.find((x) => x.kind === 'plane' || (x.kind === 'face' && x.plane));
    if (s) { this.startSketch(s.plane, s.kind === 'plane' ? s.name : 'Face', null, this.faceRefOf(s)); return; }
    if (this.sel.length === 1 && this.sel[0].kind === 'sketch') { this.editSketch(this.sel[0].id); return; }
    // ask for a plane
    this.showPlanes = true; this.updatePlanes();
    const pm = this.app.pm.show({
      title: 'Edit Sketch', iconName: 'sketch', message: 'Select a plane or a planar face on which to create a sketch.',
      fields: [{ key: 'plane', type: 'selbox', label: 'Sketch Plane', max: 1, accepts: (it) => it.kind === 'plane' || (it.kind === 'face' && !!it.plane) }],
      onChange: (v) => {
        const it = v.plane[0];
        if (it) { this.app.pm.close(false); this.showPlanes = false; this.startSketch(it.plane, it.kind === 'plane' ? it.name : 'Face', null, this.faceRefOf(it)); }
      },
      onCancel: () => { this.showPlanes = false; this.updatePlanes(); },
    });
    void pm;
  }

  startSketch(plane, planeName, after, faceRef = null) {
    const f = newSketch(this.newId(), '', structuredClone(plane), planeName);
    if (faceRef) f.faceRef = faceRef;
    f.name = this.nextName(f);
    this.enterSketch(f, true, after);
  }
  editSketch(id) {
    const f = this.F(id);
    if (!f) return;
    if (this.sketcher) this.exitSketch(true);
    this.enterSketch(f, false);
  }
  enterSketch(f, isNew, after) {
    this.app.pm.close(false);
    this.sel = []; this.hover = null;
    this.sketchEdit = { isNew, after, featureIndex: this.doc.features.indexOf(f) };
    // rebuild only up to this sketch so the model reflects its position in history
    if (!isNew) this.regen(this.doc.features.slice(0, this.doc.features.indexOf(f)));
    const fe = this.resolvedPlanes?.get(f.id) ? { ...f, plane: this.resolvedPlanes.get(f.id) } : f;
    this.sketcher = new Sketcher(this, fe);
    this.sketcher.original = f;
    this.app.showPanel('props');
    this.app.cm.selectTab('Sketch');
    this.updatePlanes(); this.updateSketchDisplay(); this.updateHighlights();
    this.vp.normalTo(this.sketcher.fr);
    this.syncGrid();
    this.app.setConfirmCorner({ ok: () => this.exitSketch(true), cancel: () => this.exitSketch(false), okTip: 'Exit Sketch', cancelTip: 'Discard changes' });
    this.app.cm.refresh();
    this.renderTree();
  }
  exitSketch(commit) {
    const sk = this.sketcher;
    if (!sk) return;
    if (sk.offsetMode) this.app.pm.cancel();
    sk.dispose();
    this.sketcher = null;
    this.syncGrid();
    document.querySelector('.modify-box')?.remove();
    this.app.setConfirmCorner(null);
    this.app.setSketchStatus(null);
    const f = sk.sk;
    const edit = this.sketchEdit;
    if (commit) {
      const changed = JSON.stringify(f) !== JSON.stringify(sk.original);
      if (edit.isNew) {
        const hasGeo = f.geo.some((g) => !g.origin);
        if (hasGeo) { this.beginChange(); this.insertFeature(f); this.commit('sketch'); this.sel = [{ kind: 'sketch', id: f.id, key: 'sketch:' + f.id }]; }
      } else if (changed) {
        this.beginChange();
        const i = this.doc.features.findIndex((x) => x.id === f.id);
        this.doc.features[i] = f;
        this.commit('edit sketch');
      }
    }
    this.app.showPanel('tree');
    this.app.cm.selectTab('Features');
    this.renderTree(); this.updateSketchDisplay(); this.updateHighlights();
    this.regen();
    if (commit && edit.after && this.F(f.id)) edit.after(f);
  }
  sketchTool(id) {
    if (!this.sketcher) { toast('Start a sketch first (Sketch tab → Sketch, then pick a plane).'); return; }
    this.sketcher.setTool(this.sketcher.tool?.id === id ? null : id);
    this.app.cm.refresh();
  }
  onToolChanged() { this.app.cm.refresh(); }
  onSketchChanged() { this.vp.requestRender(); }
  setSketchStatus(st) { this.app.setSketchStatus(st); }
  setCoords(p) { const d = opt('partCoordDecimals'); this.app.setCoords(`${fmt(p[0], d)} mm, ${fmt(p[1], d)} mm`); }
  // Offset Entities (0.1.94): popup + sketcher offset mode (sketch/offsettool.js)
  cmdOffset() {
    const sk = this.sketcher;
    if (!sk) return;
    if (sk.offsetMode) { this.app.pm.cancel(); return; }
    let last = {}; try { last = JSON.parse(localStorage.getItem('monolith.offsetOpts') || '{}'); } catch { /* none */ }
    const values = { dist: opt('featDefOffsetDist'), selectChain: true, both: false, cap: true, baseConstruction: false, ...last, reverse: false }; // side always starts outside
    sk.startOffset(values);
    const pm = this.app.pm.show({
      title: 'Offset Entities', iconName: 'offset',
      message: 'Click sketch entities or model edges to offset. Click again to remove.',
      fields: [
        { key: 'dist', type: 'number', label: 'Distance', unit: 'mm', min: 0 },
        { key: 'reverse', type: 'check', label: 'Reverse' },
        { key: 'selectChain', type: 'check', label: 'Select chain' },
        { key: 'both', type: 'check', label: 'Bi-directional' },
        { key: 'cap', type: 'check', label: 'Cap ends' },
        { key: 'baseConstruction', type: 'check', label: 'Base geometry → construction' },
      ],
      values,
      onChange: (v) => { sk.setOffsetOpts(v); try { localStorage.setItem('monolith.offsetOpts', JSON.stringify(v)); } catch { /* ignore */ } },
      onOk: () => (sk.finishOffset() ? undefined : false),
      onCancel: () => sk.cancelOffset(),
    });
    this.offsetPM = pm;
    // 0.1.96: the distance box / drag arrow on the sketch and the mouse side talk to this popup
    sk.offsetUI = {
      setDist: (d) => { pm.setValue('dist', +(+d).toFixed(opt('partNoiseDecimals'))); sk.setOffsetOpts({ ...pm.values }); },
      setReverse: (r) => pm.setValue('reverse', r),
      ok: () => this.app.pm.ok(), cancel: () => this.app.pm.cancel(),
    };
    this.app.floatPM?.(true);
    this.app.cm.refresh();
  }
  onOffsetChanged(m) {
    const pm = this.offsetPM; if (!pm || this.app.pm.current !== pm) return;
    const n = m.picks.reduce((a, pk) => a + pk.chain.items.length, 0);
    if (m.err) pm.setMessage(m.err, 'error');
    else pm.setMessage(m.picks.length ? `${n} entit${n === 1 ? 'y' : 'ies'} in ${m.picks.length} chain${m.picks.length === 1 ? '' : 's'}. OK (Enter) to add the offset.` : 'Click sketch entities or model edges to offset. Click again to remove.');
  }
  cmdConvert() {
    if (!this.sketcher) return;
    toast('Click model edges to project them into the sketch. Press Esc when done.');
    this.convertMode = true;
    const el = this.vp.el;
    const onClick = (e) => {
      if (e.button !== 0) return;
      // the highlighted edge (sketcher hover, 0.1.94) wins; else a 3D pick on the model
      const sk = this.sketcher, mh = sk?.modelHover;
      if (mh?.e) { sk.convertEdge(mh.e); sk.modelHover = null; sk._mhKey = null; e.stopPropagation(); this.vp.requestRender(); return; }
      const p = this.pickAt(e);
      if (p?.kind === 'edge') { this.sketcher.convertEdge(p.edge || this.mesh.edges.find((x) => x.id === p.id)); e.stopPropagation(); }
    };
    const onKey = (e) => { if (e.key === 'Escape') stop(); };
    const stop = () => { el.removeEventListener('pointerdown', onClick, true); window.removeEventListener('keydown', onKey, true); this.convertMode = false; if (this.sketcher) { this.sketcher.modelHover = null; this.sketcher._mhKey = null; } this.vp.requestRender(); };
    el.addEventListener('pointerdown', onClick, true);
    window.addEventListener('keydown', onKey, true);
  }

}
