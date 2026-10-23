// Part: FeatureManager tree, rollback, feature menu
// Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { Sketcher, SKETCH_TOOLS, newSketch } from '../sketch/sketcher.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { openAppearance } from '../appearance/popup.js';
import { appearanceSource } from '../appearance/look.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { treeRow, folderOpen, toggleFolder, rangeItems } from '../treeui.js';
import { api } from '../api.js';
import { sketchCurves, sampleCurve } from '../../../shared/profile.mjs';
import { solve as solveSketch, measure as measureDim, DIM_TYPES } from '../sketch/solver.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import { dxfToSketch, sketchToDxf } from '../io/dxf.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis } from './part.js';

export class PartTree {
  // ======================= FeatureManager tree =======================
  renderTree() {
    const tree = this.app.el.tree;
    tree.innerHTML = '';
    const st = new Map(this.status.map((s) => [s.id, s]));
    const roll = this.doc.rollback ?? this.doc.features.length;
    const consumedBy = new Map();
    for (const f of this.doc.features) if (f.sketch) consumedBy.set(f.sketch, f.id);
    const selKeys = new Set(this.sel.map((s) => s.key));
    const owners = this.ownerFeats(); // 0.1.133: features that made the picked faces / edges
    this._treeItems = new Map(); // 0.1.134: rows for Shift+click ranges
    const add = (o) => tree.appendChild(treeRow(o));
    const folder = (key, dflt, o) => { const open = folderOpen(this, key, dflt); add({ icon: 'folder', ...o, twisty: open, onTwisty: () => toggleFolder(this, key), data: { folder: key } }); return open; };
    add({ icon: 'part', label: `${this.doc.name}  (Default)`, onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: 'Rename…', run: () => this.renamePart() }, { label: 'Appearance…', icon: 'realistic', run: () => this.editAppearance() }, { label: 'Collapse All', key: 'Shift+C', run: () => this.collapseTree() }]) });
    add({ icon: 'massProps', label: `Material <${this.doc.material}>`, depth: 1, onDbl: () => this.editMaterial(), onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: 'Edit Material…', run: () => this.editMaterial() }]) });
    // Solid Bodies
    const hasBody = !!this.bodyMesh;
    if (folder('bodies', false, { label: 'Solid Bodies', count: hasBody ? 1 : 0, depth: 1 }) && hasBody) {
      add({
        icon: 'part', label: this.doc.name, depth: 2, eye: !this.doc.bodyHidden, onEye: () => this.toggleBody(), dim: !!this.doc.bodyHidden, data: { item: 'body' },
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: this.doc.bodyHidden ? 'Show Body' : 'Hide Body', icon: this.doc.bodyHidden ? 'eye' : 'eyeOff', run: () => this.toggleBody() }]),
      });
    }
    // Origin
    if (folder('origin', true, { label: 'Origin', depth: 1 })) {
      for (const name of Object.keys(STD_PLANES)) {
        const key = 'plane:' + name;
        const shown = (this.doc.planesShown || []).includes(name);
        add({
          icon: 'plane', label: `${name} Plane`, depth: 2, sel: selKeys.has(key), eye: shown, onEye: () => this.togglePlaneShown(name), data: { item: key },
          onClick: (e) => this.clickItem({ kind: 'plane', name, plane: STD_PLANES[name], key }, e.ctrlKey || e.shiftKey),
          onEnter: () => { this.hoverTreePlane = name; this.updatePlanes(); }, onLeave: () => { this.hoverTreePlane = null; this.updatePlanes(); },
          onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: 'Sketch', icon: 'sketch', run: () => this.startSketch(STD_PLANES[name], name) }, { label: 'Normal To', icon: 'normalTo', run: () => this.vp.normalTo(frameOf(STD_PLANES[name])) }, { label: shown ? 'Hide' : 'Show', icon: shown ? 'eyeOff' : 'eye', run: () => this.togglePlaneShown(name) }]),
        });
      }
      add({ icon: 'origin', label: 'Origin Point', depth: 2 });
    }
    tree.appendChild(sectionTreeRows(this));
    const pcs = this.doc.pointClouds || [];
    if (pcs.length && folder('clouds', true, { label: 'Point Clouds', count: pcs.length, depth: 1 })) for (const rec of pcs) {
      const loaded = this.clouds?.views.has(rec.id);
      const toggle = () => { rec.visible = rec.visible === false; this.clouds.views.get(rec.id)?.refresh(); this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); };
      add({
        icon: 'cloud', label: rec.name + (loaded ? '' : '  (not loaded)'), depth: 2, dim: rec.visible === false, err: loaded ? null : undefined,
        eye: rec.visible !== false, onEye: toggle,
        onClick: () => this.showCloudProps(rec.id), onDbl: () => this.showCloudProps(rec.id),
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Properties…', icon: 'cloud', run: () => this.showCloudProps(rec.id) },
          { label: rec.visible === false ? 'Show' : 'Hide', icon: rec.visible === false ? 'eye' : 'eyeOff', run: toggle },
          { label: 'Zoom To', icon: 'zoomFit', run: () => { const v = this.clouds.views.get(rec.id); if (v) this.vp.fit(v.box); } },
          { label: 'Reload', run: () => this.clouds.load(rec) },
          '-', { label: 'Remove', icon: 'delete', run: () => this.removePointCloud(rec.id) },
        ]),
      });
    }
    this.expanded = this.expanded || new Set();
    const consumed = this.consumedSketches();
    const editingSketch = this.sketcher?.original?.id;
    const featureRow = (f, i, depth) => {
      const s = st.get(f.id);
      const isSk = f.type === 'sketch';
      const key = (isSk ? 'sketch:' : 'feature:') + f.id;
      this._treeItems.set(key, { kind: isSk ? 'sketch' : 'feature', id: f.id, key });
      const children = this.doc.features.filter((x) => x.type === 'sketch' && consumedBy.get(x.id) === f.id);
      const isOpen = this.expanded.has(f.id);
      const vis = isSk ? (f.visible ?? !consumed.has(f.id)) : undefined;
      add({
        icon: FEATURE_META[metaKey(f)]?.icon || 'sketch', label: f.name + this.xrefMark(f), depth: depth + 1,
        sel: selKeys.has(key) || owners.has(f.id), dim: i >= roll || f.suppressed, err: s?.state === 'error' ? s.error : null, warn: s?.state === 'warn' ? s.error : null,
        editing: f.id === editingSketch || f.id === this.editingId,
        eye: vis, onEye: () => this.toggleSketchVisible(f),
        twisty: children.length ? isOpen : undefined, onTwisty: () => { if (isOpen) this.expanded.delete(f.id); else this.expanded.add(f.id); this.renderTree(); },
        onClick: (e) => this.treeClick({ kind: isSk ? 'sketch' : 'feature', id: f.id, key }, e),
        onDbl: () => (isSk ? this.editSketch(f.id) : this.editFeature(f.id)),
        onMenu: (e) => this.featureMenu(e, f, i),
        onEnter: () => this.setHoverFeat(f.id), onLeave: () => this.setHoverFeat(null),
        tip: [s?.error, this.xrefState(f) ? this.xrefTip(f) : ''].filter(Boolean).join('\n'), data: depth === 0 ? { fi: i, item: key } : { item: key },
      });
      if (isOpen) for (const c of children) featureRow(c, this.doc.features.indexOf(c), depth + 1);
    };
    this.doc.features.forEach((f, i) => {
      if (i === roll) tree.appendChild(this.rollbackBar());
      if (f.type === 'sketch' && consumedBy.has(f.id)) return;
      featureRow(f, i, 0);
    });
    if (roll >= this.doc.features.length) tree.appendChild(this.rollbackBar());
    this.app.cm.refresh();
  }
  // 0.1.134: Shift+click = all features between the last clicked one and this one; Ctrl+click = add / remove
  treeClick(it, e) {
    if (e.shiftKey && !this.app.pm.current) {
      const r = rangeItems(this.app.el.tree, this._treeItems || new Map(), this._treeAnchor, it.key);
      if (r) { this.sel = e.ctrlKey ? [...this.sel.filter((s) => !r.some((x) => x.key === s.key)), ...r] : r; this.afterSelection(); this.app.setStatus(`${r.length} features selected`); return; }
    }
    this._treeAnchor = it.key;
    this.clickItem(it, e.ctrlKey || e.shiftKey);
  }
  selectedFeatures() { return this.sel.filter((s) => s.kind === 'feature' || s.kind === 'sketch').map((s) => this.F(s.id)).filter(Boolean); }
  // 0.1.133: Shift+C — every folder and every feature's sketch list closed
  collapseTree() {
    this.expanded?.clear();
    this._treeOpen ??= {};
    for (const k of Object.keys(this._treeOpen)) this._treeOpen[k] = false;
    this.renderTree();
    this.app.setStatus('Tree collapsed (Shift+C)');
  }
  toggleBody() { this.beginChange(); this.doc.bodyHidden = !this.doc.bodyHidden; if (!this.doc.bodyHidden) delete this.doc.bodyHidden; this.commit(); this.bodyGroup.visible = !this.doc.bodyHidden; this.renderTree(); this.vp.requestRender(); }
  togglePlaneShown(name) {
    this.beginChange();
    const s = new Set(this.doc.planesShown || []);
    if (s.has(name)) s.delete(name); else s.add(name);
    if (s.size) this.doc.planesShown = [...s]; else delete this.doc.planesShown;
    this.commit(); this.updatePlanes(); this.renderTree();
  }
  toggleSketchVisible(f) {
    const vis = f.visible ?? !this.consumedSketches().has(f.id);
    this.beginChange(); f.visible = !vis; this.commit(); this.updateSketchDisplay(); this.renderTree();
  }
  isSketchDefined() { return true; }

  rollbackBar() {
    const bar = h('div', { class: 'rollback', title: 'Rollback bar: drag up or down, or right-click a feature → Roll Back' });
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const tree = this.app.el.tree;
      const rows = [...tree.querySelectorAll('.tr-row[data-fi]')]; // top-level history rows only
      const move = (ev) => {
        bar.style.transform = `translateY(${ev.clientY - e.clientY}px)`;
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        // find the feature row above the drop point
        let target = null;
        for (const r of rows) {
          const rr = r.getBoundingClientRect();
          if (ev.clientY < rr.top + rr.height / 2) { target = +r.dataset.fi; break; }
        }
        this.setRollback(target);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    return bar;
  }
  setRollback(idx) {
    this.beginChange();
    if (idx === null || idx >= this.doc.features.length) this.doc.rollback = null;
    else {
      // keep a consumed sketch together with its feature
      let i = idx;
      while (i > 0 && this.doc.features[i - 1]?.type === 'sketch' && this.doc.features[i]?.sketch === this.doc.features[i - 1].id) i--;
      this.doc.rollback = i;
    }
    this.commit('rollback');
    this.renderTree(); this.updateSketchDisplay(); this.regen();
  }

  featureMenu(e, f, i) {
    const items = [];
    if (f.type === 'sketch') {
      items.push({ label: 'Edit Sketch', icon: 'sketch', run: () => this.editSketch(f.id) });
      const consumed = this.consumedSketches().has(f.id);
      const vis = f.visible ?? !consumed;
      items.push({ label: vis ? 'Hide' : 'Show', icon: vis ? 'eyeOff' : 'eye', run: () => this.toggleSketchVisible(f) });
      items.push({ label: 'Export Sketch to DXF…', icon: 'export', run: () => this.exportSketchDxf(f) });
      if (this.xrefState(f)) items.push({ label: 'Break External References', icon: 'fix', run: () => this.breakXrefs(f) }); // 0.1.132
    } else {
      items.push({ label: 'Edit Feature', icon: FEATURE_META[metaKey(f)]?.icon, run: () => this.editFeature(f.id) });
      if (f.sketch) items.push({ label: 'Edit Sketch', icon: 'sketch', run: () => this.editSketch(f.sketch) });
    }
    items.push('-');
    const group = this.sel.some((s) => s.id === f.id) ? this.selectedFeatures() : [f], many = group.length > 1 ? ` (${group.length})` : ''; // 0.1.134: right-click acts on all selected
    if (f.type !== 'sketch') items.push({ label: (f.suppressed ? 'Unsuppress' : 'Suppress') + many, run: () => { this.beginChange(); const on = !f.suppressed; for (const g of group) if (g.type !== 'sketch') g.suppressed = on; this.commit(); this.renderTree(); this.regen(); } });
    items.push({ label: 'Roll Back', icon: 'history', run: () => this.setRollback(i) });
    if (this.doc.rollback !== null && this.doc.rollback !== undefined) items.push({ label: 'Roll to End', run: () => this.setRollback(null) });
    items.push({ label: 'Rename…', run: async () => { const n = await promptText('Rename feature', f.name); if (n) { this.beginChange(); f.name = n; this.commit(); this.renderTree(); } } });
    items.push('-', { label: 'Delete' + many, icon: 'delete', key: 'Del', run: () => this.deleteFeatures(group.map((g) => g.id)) });
    contextMenu(e.clientX, e.clientY, items);
  }

  deleteFeature(id) { this.deleteFeatures([id]); }
  // 0.1.134: several features in one undo step
  deleteFeatures(ids) {
    ids = ids.filter((id) => this.F(id));
    if (!ids.length) return;
    const dependents = this.doc.features.filter((x) => !ids.includes(x.id) && (ids.includes(x.sketch) || (x.features || []).some((k) => ids.includes(k))));
    this.beginChange();
    const kill = new Set(ids);
    // the feature's sketch is kept (it becomes a stand-alone sketch in the tree again)
    for (const d of dependents) kill.add(d.id);
    const roll = this.doc.rollback;
    if (roll !== null && roll !== undefined) this.doc.rollback = roll - this.doc.features.slice(0, roll).filter((x) => kill.has(x.id)).length;
    this.doc.features = this.doc.features.filter((x) => !kill.has(x.id));
    this.commit('delete');
    if (dependents.length) toast(`Also deleted dependent feature(s): ${dependents.map((d) => d.name).join(', ')}`);
    this.sel = [];
    this.renderTree(); this.updateSketchDisplay(); this.regen();
  }

  async renamePart() {
    const n = await promptText('Part name', this.doc.name);
    if (n) { this.beginChange(); this.doc.name = n; this.commit(); this.renderTree(); this.app.updateTitle(); }
  }
  // Appearance popup for the part (stored in the part file; Reset = back to the material's appearance)
  editAppearance() {
    openAppearance(this, {
      title: 'Part', name: this.doc.name, holder: () => this.doc, resolve: () => this.appearance(), clearLabel: 'Reset to Material',
      source: () => { const s = appearanceSource(this.doc.appearance, MATERIALS.find((m) => m.name === this.doc.material)?.appearance); return s === 'own' ? 'Set on this part' : s === 'material' ? `From the material (${this.doc.material})` : 'Part body colour (Options > Colours)'; },
    });
  }
  async editMaterial() {
    const sel = h('select', {}, MATERIALS.map((m) => h('option', { value: m.name, selected: m.name === this.doc.material }, `${m.name}  (${m.density} g/cm³)`)));
    const r = await dialog({ title: 'Material', body: h('div', {}, h('p', {}, 'Assign a material for mass properties:'), sel), buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', primary: true, value: 'ok' }] });
    if (r === 'ok') { this.beginChange(); this.doc.material = sel.value; this.commit(); this.renderTree(); }
  }

}
