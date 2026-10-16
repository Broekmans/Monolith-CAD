// Assembly: tree, menus, export, keys
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { treeRow, folderOpen, toggleFolder } from '../treeui.js';
import { api } from '../api.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import * as M from '../../../shared/mates.mjs';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { compKey, libText, newAssemblyDoc, COLORS, PALETTE, IDENT, partCache, partVersion, partSaved, loadPart, circle3, entityGeo, geoName, segDist } from './assembly.js';

export class AsmTree {
  // ======================= tree =======================
  renderTree() {
    const tree = this.app.el.tree;
    tree.innerHTML = '';
    const selKeys = new Set(this.sel.map((s) => s.key));
    const row = (o) => treeRow(o);
    const hoverOn = (it) => () => { this.hover = it; this.updateHighlights(); };
    const hoverOff = () => { this.hover = null; this.updateHighlights(); };
    tree.appendChild(row({ icon: 'assembly', label: `${this.doc.name}  (Default)`, onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: 'Rename…', run: () => this.renameAsm() }]) }));
    tree.appendChild(row({ icon: 'origin', label: 'Origin', depth: 1 }));
    tree.appendChild(sectionTreeRows(this));
    if (this.doc.components.length) tree.appendChild(row({ icon: 'folder', label: 'Components', count: this.doc.components.length, depth: 1, twisty: folderOpen(this, 'comps', true), onTwisty: () => toggleFolder(this, 'comps'), data: { folder: 'comps' } }));
    if (folderOpen(this, 'comps', true)) for (const c of this.doc.components) {
      const st = this.dof.get(c.id);
      const pre = c.fixed ? '(f) ' : st?.state === 'under' ? '(-) ' : '';
      const it = { kind: 'comp', comp: c.id, key: 'comp:' + c.id };
      const err = c._part?.err;
      tree.appendChild(row({
        icon: c._part?.flat?.length > 1 || /\.lithasm$/i.test(c.path || '') ? 'assembly' : 'part', label: pre + c.name, depth: 2, sel: selKeys.has(it.key), dim: c.hidden,
        eye: !c.hidden, onEye: () => { this.beginChange(); c.hidden = !c.hidden; this.commit(); this.syncScene(); this.renderTree(); }, data: { item: it.key }, err: err ? `Cannot load ${c.path || c.name}: ${err}` : null,
        tip: err ? '' : `${c.lib ? 'Toolbox: ' + fastenerDef(c.lib.std)?.label : c.path}\n${c.fixed ? 'Fixed' : st?.state === 'under' ? `Under defined (${st.dof} DOF free)` : 'Fully defined'}`,
        onClick: (e) => { this.clickItem(it, e.ctrlKey || e.shiftKey); },
        onDbl: () => this.openComp(c),
        onEnter: hoverOn(it), onLeave: hoverOff,
        onMenu: (e) => { if (!selKeys.has(it.key)) this.sel = [it]; contextMenu(e.clientX, e.clientY, this.compMenu(c)); },
      }));
    }
    const open = folderOpen(this, 'mates', true);
    tree.appendChild(row({ icon: 'mate', label: 'Mates', count: this.doc.mates.length, depth: 1, twisty: open, onTwisty: () => toggleFolder(this, 'mates'), data: { folder: 'mates' } }));
    if (open) for (const m of this.doc.mates) {
      const it = { kind: 'mate', id: m.id, key: 'mate:' + m.id };
      const t = M.MATE_TYPES.find((x) => x.id === m.type);
      const names = `(${this.C(m.a.comp)?.name}, ${this.C(m.b.comp)?.name})`;
      const err = this.mateErr?.get(m.id);
      tree.appendChild(row({
        icon: t?.icon || 'mate', label: `${m.name} ${names}${m.value !== undefined && (m.type === 'distance' || m.type === 'angle') ? '  ' + fmt(m.value) + (m.type === 'angle' ? '°' : ' mm') : ''}`,
        depth: 2, sel: selKeys.has(it.key), dim: m.suppressed, err: m.suppressed ? null : err,
        onClick: (e) => this.clickItem(it, e.ctrlKey || e.shiftKey),
        onDbl: () => this.cmdMate(m),
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Edit Mate', icon: 'mate', run: () => this.cmdMate(m) },
          { label: m.suppressed ? 'Unsuppress' : 'Suppress', run: () => { this.beginChange(); m.suppressed = !m.suppressed; this.commit(); this.solve(); } },
          '-', { label: 'Delete', icon: 'delete', key: 'Del', run: () => this.deleteMate(m.id) },
        ]),
      }));
    }
    this.app.cm.refresh();
  }
  compMenu(c) {
    return [
      { label: 'Open Part', icon: 'part', run: () => this.openComp(c) },
      { label: 'Mate', icon: 'mate', run: () => this.cmdMate() },
      { label: c.fixed ? 'Float' : 'Fix', icon: c.fixed ? 'unlock' : 'fix', run: () => { this.sel = [{ kind: 'comp', comp: c.id, key: 'comp:' + c.id }]; this.toggleFixSelected(); } },
      { label: c.hidden ? 'Show' : 'Hide', icon: c.hidden ? 'eye' : 'eyeOff', run: () => { this.sel = [{ kind: 'comp', comp: c.id, key: 'comp:' + c.id }]; this.toggleHideSelected(); } },
      { label: 'Rename…', run: async () => { const n = await promptText('Component name', c.name); if (n) { this.beginChange(); c.name = n; this.commit(); this.renderTree(); } } },
      { label: 'Reload Part', run: async () => { partCache.delete(compKey(c)); await this.loadComp(c); this.rematchAll(); this.solve(); } },
      '-', { label: 'Delete', icon: 'delete', key: 'Del', run: () => this.deleteComponent(c.id) },
    ];
  }
  viewContextMenu(e) {
    const p = this.pickAt(e);
    const items = [];
    const c = p && this.C(p.comp);
    if (c) { if (!this.sel.some((s) => s.key === p.key)) this.sel = [p]; items.push({ label: c.name, disabled: true }, ...this.compMenu(c), '-'); }
    items.push({ label: 'Insert Component…', icon: 'insertComp', run: () => this.cmdInsert() }, { label: 'Toolbox (DIN fasteners)…', icon: 'bolt', run: () => this.cmdToolbox() }, { label: 'Zoom to Fit', icon: 'zoomFit', key: 'F', run: () => this.zoomFit() }, { label: 'Isometric', icon: 'views', key: 'Ctrl+7', run: () => this.vp.setView('iso') });
    contextMenu(e.clientX, e.clientY, items);
  }

  // called when the tab becomes active again: pick up parts saved meanwhile
  onActivate() {
    const stale = this.doc.components.filter((c) => c._part && (c._part.ver ?? 0) !== (c.lib ? c._part.ver ?? 0 : partVersion.get(c.path) || 0));
    if (!stale.length) return;
    Promise.all(stale.map((c) => this.loadComp(c))).then(() => { this.rematchAll(); this.solve(); this.app.setStatus('Updated from changed parts'); });
  }

  async exportCAD(fmtName) {
    const comps = this.doc.components.filter((c) => !c.hidden && this.partOf(c));
    if (!comps.length) { toast('Nothing to export'); return; }
    this.app.setBusy(true);
    try {
      // subassemblies are flattened into their parts
      const parts = comps.flatMap((c) => (c._part.flat || []).map((fp) => ({ features: fp.features, upTo: fp.upTo, m: new THREE.Matrix4().fromArray(M.poseMatrix(c)).multiply(new THREE.Matrix4().fromArray(fp.m)).toArray() })));
      const text = await api.kernel('exportAssembly', { parts, format: fmtName });
      const ext = fmtName === 'iges' ? 'igs' : 'step';
      const path = await api.saveFile({ defaultPath: `${this.doc.name}.${ext}`, filters: [{ name: fmtName.toUpperCase(), extensions: fmtName === 'iges' ? ['igs', 'iges'] : ['step', 'stp'] }], text });
      if (path) toast('Exported ' + path.split(/[\\/]/).pop(), 'ok');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); } finally { this.app.setBusy(false); }
  }

  onKey(e) {
    const k = e.key;
    if (e.ctrlKey && !e.shiftKey && /^[1-7]$/.test(k)) { this.vp.setView(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][+k - 1]); return true; }
    if (e.ctrlKey && (k === 'z' || k === 'Z')) { this.undo(); return true; }
    if (e.ctrlKey && (k === 'y' || k === 'Y')) { this.redo(); return true; }
    if (e.ctrlKey && (k === 'b' || k === 'B')) { this.reloadAll(true); return true; }
    if (k === 'f' && !e.ctrlKey) { this.zoomFit(); return true; }
    if (k === 'Escape') { if (this.app.pm.open) this.app.pm.cancel(); else { this.sel = []; this.updateHighlights(); this.renderTree(); } return true; }
    if (k === 'Enter' && this.app.pm.open) { this.app.pm.ok(); return true; }
    if (k === 'Delete' && !this.app.pm.open) {
      const m = this.sel.find((s) => s.kind === 'mate');
      if (m) { this.deleteMate(m.id); return true; }
      const c = this.sel.find((s) => s.comp);
      if (c) { this.deleteComponent(c.comp); return true; }
    }
    return false;
  }
  dispose() { window.removeEventListener('pointerup', this._onUp); this.vp.dispose(); }
}
