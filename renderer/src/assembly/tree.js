// Assembly: tree, menus, export, keys
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { treeRow, folderOpen, toggleFolder, rangeItems } from '../treeui.js';
import { api } from '../api.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import * as M from '../../../shared/mates.mjs';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { openAppearance } from '../appearance/popup.js';
import { appearanceSource } from '../appearance/look.js';
import { MATERIALS } from '../part/part.js';
import { opt } from '../app/options.js';
import { compKey, libText, newAssemblyDoc, COLORS, PALETTE, IDENT, partCache, partVersion, partSaved, loadPart, circle3, entityGeo, geoName, segDist } from './assembly.js';

export class AsmTree {
  // ======================= tree =======================
  renderTree() {
    const tree = this.app.el.tree;
    tree.innerHTML = '';
    const selKeys = new Set(this.sel.map((s) => s.key));
    this._treeItems = new Map(); // 0.1.134: rows for Shift+click ranges
    const row = (o) => treeRow(o);
    const hoverOn = (it) => () => { this.hover = it; this.updateHighlights(); };
    const hoverOff = () => { this.hover = null; this.updateHighlights(); };
    tree.appendChild(row({ icon: 'assembly', label: `${this.doc.name}  (Default)`, onMenu: (e) => contextMenu(e.clientX, e.clientY, [{ label: 'Rename…', run: () => this.renameAsm() }, { label: 'Collapse All', key: 'Shift+C', run: () => this.collapseTree() }]) }));
    // 0.1.127: the assembly's own Front / Top / Right Plane (fixed; mates can use them), like the part's Origin folder
    const oo = folderOpen(this, 'asmOrigin', true);
    tree.appendChild(row({ icon: 'origin', label: 'Origin', depth: 1, twisty: oo, onTwisty: () => toggleFolder(this, 'asmOrigin'), data: { folder: 'asmOrigin' } }));
    if (oo) { for (const r of this.planeRows(M.GROUND_ID, 2, row, selKeys)) tree.appendChild(r); tree.appendChild(row({ icon: 'origin', label: 'Origin Point', depth: 2 })); }
    tree.appendChild(sectionTreeRows(this));
    if (this.doc.components.length) tree.appendChild(row({ icon: 'folder', label: 'Components', count: this.doc.components.length, depth: 1, twisty: folderOpen(this, 'comps', true), onTwisty: () => toggleFolder(this, 'comps'), data: { folder: 'comps' } }));
    // a mate row (main Mates folder and "Mates in <assembly>" under each component, 0.1.116)
    const mateRow = (m, depth) => {
      const it = { kind: 'mate', id: m.id, key: 'mate:' + m.id };
      this._treeItems.set(it.key, it);
      const ms = selKeys.has(it.key) ? this.sel.filter((s) => s.kind === 'mate').map((s) => this.doc.mates.find((k) => k.id === s.id)).filter(Boolean) : [m]; // right-click acts on all selected mates
      const many = ms.length > 1 ? ` (${ms.length})` : '';
      const valueM = m.type === 'distance' || m.type === 'angle';
      const t = M.MATE_TYPES.find((x) => x.id === m.type);
      const names = `(${this.refOwner(m.a)}, ${this.refOwner(m.b)})`;
      const err = this.mateErr?.get(m.id);
      return row({
        tip: m.type === 'concentric' && m.lockRot ? 'Rotation locked' : undefined,
        icon: t?.icon || 'mate', label: `${m.name} ${names}${m.value !== undefined && (m.type === 'distance' || m.type === 'angle') ? '  ' + (m.limits ? `${fmt(Math.min(m.limits.min, m.limits.max))} … ${fmt(Math.max(m.limits.min, m.limits.max))}` : fmt(m.value)) + (m.type === 'angle' ? '°' : ' mm') : ''}${m._free ? '  (suppressed while editing)' : ''}${this._motionOpen && m._drive != null && this.studyIds?.().has(m.id) ? '  (Motion Study)' : ''}`,
        depth, sel: selKeys.has(it.key), dim: m.suppressed || m._free, err: m.suppressed || m._free ? null : err, data: { item: it.key },
        onClick: (e) => this.treeClick(it, e),
        onEnter: hoverOn(it), onLeave: hoverOff, // 0.1.121: highlight the mated faces / edges in the view
        onDbl: () => this.cmdMate(m),
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Edit Mate', icon: 'mate', run: () => this.cmdMate(m) },
          m.type === 'distance' || m.type === 'angle' ? { label: 'Drive…', icon: 'drive', run: () => this.openDrive(m) } : null,
          valueM ? { label: m.type === 'angle' ? 'Flip Mate Alignment' : 'Flip Dimension', icon: 'reciprocate', run: () => this.flipMates([m]) } : null, // 0.1.134: the angle 180° further / the distance to the other side
          m.type === 'concentric' ? { label: m.lockRot ? 'Unlock Rotation' : 'Lock Rotation', icon: m.lockRot ? 'unlock' : 'lock', run: () => this.setLockRot(ms.filter((k) => k.type === 'concentric'), !m.lockRot) } : null,
          { label: (m.suppressed ? 'Unsuppress' : 'Suppress') + many, run: () => { this.beginChange(); const on = !m.suppressed; for (const k of ms) k.suppressed = on; this.commit(); this.solve(); } },
          '-', { label: 'Delete' + many, icon: 'delete', key: 'Del', run: () => this.deleteMates(ms.map((k) => k.id)) },
        ]),
      });
    };
    this._compOpen ??= new Map(); // component id → 'user' | 'auto' (expanded); in memory only
    this._compMatesOpen ??= new Map(); // component id → "Mates in …" folder open (default open)
    if (folderOpen(this, 'comps', true)) for (const c of this.doc.components) {
      const st = this.dof.get(c.id);
      const pre = c.fixed ? '(f) ' : st?.state === 'under' ? '(-) ' : '';
      const it = { kind: 'comp', comp: c.id, key: 'comp:' + c.id };
      this._treeItems.set(it.key, it);
      const err = c._part?.err;
      const mates = this.doc.mates.filter((m) => m.a.comp === c.id || m.b.comp === c.id);
      const open = this._compOpen.has(c.id);
      const picked = selKeys.has(it.key) || this.sel.some((s) => s.comp === c.id && s.kind !== 'feat' && s.kind !== 'plane'); // 0.1.133: a face / edge of it picked in the view
      const xr = this.xrefInfo?.(c); // 0.1.132: in-context references (->)
      tree.appendChild(row({
        icon: c._part?.flat?.length > 1 || /\.lithasm$/i.test(c.path || '') ? 'assembly' : 'part', label: pre + c.name + (xr ? ' ->' : ''), depth: 2, warn: xr?.stale ? `In-context references out of date (${xr.comps.join(', ')} changed or moved): right-click › Edit Part to update them` : null, sel: picked, dim: c.hidden,
        twisty: open, // 0.1.127: always — the part's origin planes (+ "Mates in …")
        onTwisty: () => { if (open) this._compOpen.delete(c.id); else this._compOpen.set(c.id, 'user'); this.renderTree(); },
        eye: !c.hidden, onEye: () => { this.beginChange(); c.hidden = !c.hidden; this.commit(); this.syncScene(); this.renderTree(); }, data: { item: it.key }, err: err ? `Cannot load ${c.path || c.name}: ${err}` : null,
        tip: err ? '' : `${c.lib ? 'Toolbox: ' + fastenerDef(c.lib.std)?.label : c.path}\n${c.fixed ? 'Fixed' : st?.state === 'under' ? `Under defined (${st.dof} DOF free)` : 'Fully defined'}${xr ? `\nIn-context references (->) to ${xr.comps.join(', ')}${xr.stale ? ' — out of date' : ''}` : ''}`,
        onClick: (e) => this.treeClick(it, e),
        onDbl: () => this.editInContext(c), // 0.1.133: Edit Part (was Open Part)
        onEnter: hoverOn(it), onLeave: hoverOff,
        onMenu: (e) => { if (!selKeys.has(it.key)) this.sel = [it]; contextMenu(e.clientX, e.clientY, this.compMenu(c)); },
      }));
      if (open) for (const r of [...this.planeRows(c.id, 3, row, selKeys), ...this.featRows(c, 3, row, selKeys)]) tree.appendChild(r); // 0.1.130: + the part's features
      if (open && mates.length) {
        const mo = this._compMatesOpen.get(c.id) ?? true;
        tree.appendChild(row({ icon: 'mate', label: `Mates in ${(this.app.path || this.path || '').split(/[\\/]/).pop()?.replace(/\.lithasm$/i, '') || this.doc.name}`, count: mates.length, depth: 3, twisty: mo, onTwisty: () => { this._compMatesOpen.set(c.id, !mo); this.renderTree(); }, data: { folder: 'compMates:' + c.id } }));
        if (mo) for (const m of mates) tree.appendChild(mateRow(m, 4));
      }
    }
    const open = folderOpen(this, 'mates', true);
    tree.appendChild(row({ icon: 'mate', label: 'Mates', count: this.doc.mates.length, depth: 1, twisty: open, onTwisty: () => toggleFolder(this, 'mates'), data: { folder: 'mates' } }));
    if (open) for (const m of this.doc.mates) tree.appendChild(mateRow(m, 2));
    this.app.cm.refresh();
  }
  compMenu(c) {
    // the picked component plus the other selected ones (e.g. several bolts)
    const cs = [...new Set([c, ...this.selectedComps()])];
    const conc = this.doc.mates.filter((m) => m.type === 'concentric' && cs.some((k) => m.a.comp === k.id || m.b.comp === k.id));
    const libs = cs.filter((k) => k.lib && fastenerDef(k.lib.std)?.group === fastenerDef(c.lib?.std)?.group);
    const allLocked = conc.length && conc.every((m) => m.lockRot);
    return [
      c.lib ? { label: `Edit Toolbox Definition…${libs.length > 1 ? ` (${libs.length})` : ''}`, icon: 'bolt', run: () => this.cmdToolbox(null, libs) } : null,
      conc.length ? { label: allLocked ? 'Unlock Rotation' : 'Lock Rotation', icon: allLocked ? 'unlock' : 'lock', run: () => this.setLockRot(conc, !allLocked) } : null,
      !c.lib && !this.partOf(c)?.isAssembly ? { label: 'Edit Part', icon: 'part', run: () => this.editInContext(c) } : null, // 0.1.130: in its own tab with the assembly around it
      { label: 'Open Part', icon: 'part', run: () => this.openComp(c) },
      { label: 'Mate', icon: 'mate', run: () => this.cmdMate() },
      { label: c.fixed ? 'Float' : 'Fix', icon: c.fixed ? 'unlock' : 'fix', run: () => { this.sel = [{ kind: 'comp', comp: c.id, key: 'comp:' + c.id }]; this.toggleFixSelected(); } },
      { label: c.hidden ? 'Show' : 'Hide', icon: c.hidden ? 'eye' : 'eyeOff', run: () => { this.sel = [{ kind: 'comp', comp: c.id, key: 'comp:' + c.id }]; this.toggleHideSelected(); } },
      { label: 'Appearance…', icon: 'realistic', run: () => this.editCompAppearance(c) },
      c.appearance ? { label: 'Clear Appearance Override', run: () => { this.beginChange(); delete c.appearance; this.commit(); this.vp.requestRender(); } } : null,
      { label: 'Rename…', run: async () => { const n = await promptText('Component name', c.name); if (n) { this.beginChange(); c.name = n; this.commit(); this.renderTree(); } } },
      { label: 'Reload Part', run: async () => { partCache.delete(compKey(c)); await this.loadComp(c); this.rematchAll(); this.solve(); } },
      '-', { label: 'Delete' + (cs.length > 1 ? ` (${cs.length})` : ''), icon: 'delete', key: 'Del', run: () => this.deleteComponents(cs.map((k) => k.id)) },
    ];
  }
  // Appearance popup for a component: an override stored in the assembly (the part file is not changed)
  editCompAppearance(c0) {
    const id = c0.id, C = () => this.doc.components.find((x) => x.id === id);
    openAppearance(this, {
      title: 'Component', name: c0.name, holder: C, clearLabel: 'Clear Appearance Override',
      resolve: () => { const c = C(); return c ? this.compAppearance(c, this.doc.components.indexOf(c)) : null; },
      source: () => {
        const c = C(), data = c && this.partOf(c)?.data;
        if (c?.appearance) return 'Override in this assembly';
        if (data?.appearance) return 'From the part';
        const s = appearanceSource(null, MATERIALS.find((m) => m.name === data?.material)?.appearance);
        return s === 'material' ? `From the material (${data.material})` : 'Assembly colour list';
      },
    });
  }
  viewContextMenu(e) {
    const p = this.pickAt(e);
    const items = [];
    const c = p && this.C(p.comp);
    if (c) { if (!this.sel.some((s) => s.key === p.key)) this.sel = [p]; items.push({ label: c.name, disabled: true }, ...this.compMenu(c), '-'); } else items.push(...this.viewSet.menuItems()); // empty space: Maximize/Restore + Close View
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

  // 0.1.134: tree click — Shift = the range from the last clicked row (same kind: components or mates), Ctrl = add / remove
  treeClick(it, e) {
    if (e.shiftKey && !this.app.pm.current) {
      const r = rangeItems(this.app.el.tree, this._treeItems || new Map(), this._treeAnchor, it.key, (a, b) => a.kind === b.kind);
      if (r) {
        this.sel = e.ctrlKey ? [...this.sel.filter((s) => !r.some((x) => x.key === s.key)), ...r] : r;
        this.updateHighlights(); this.renderTree(); this.app.cm.refresh();
        this.app.setStatus(`${r.length} ${it.kind === 'mate' ? 'mates' : 'components'} selected`);
        return;
      }
    }
    this._treeAnchor = it.key;
    this.clickItem(it, e.ctrlKey || e.shiftKey, true);
  }
  // 0.1.133: Shift+C — every component, folder and mate list closed; the Components folder stays open (the list itself)
  collapseTree() {
    this._compOpen?.clear();
    this._treeOpen ??= {};
    for (const k of Object.keys(this._treeOpen)) this._treeOpen[k] = k === 'comps';
    for (const k of ['asmOrigin', 'mates']) this._treeOpen[k] = false;
    this.renderTree();
    this.app.setStatus('Tree collapsed (Shift+C)');
  }
  onKey(e) {
    const k = e.key;
    if (k === 'C' && e.shiftKey && !e.ctrlKey && !e.altKey) { this.collapseTree(); return true; }
    if (e.ctrlKey && !e.shiftKey && /^[1-7]$/.test(k)) { this.vp.setView(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][+k - 1]); return true; }
    if (e.ctrlKey && (k === 'z' || k === 'Z')) { this.undo(); return true; }
    if (e.ctrlKey && (k === 'y' || k === 'Y')) { this.redo(); return true; }
    if (e.ctrlKey && (k === 'b' || k === 'B')) { this.reloadAll(true); return true; }
    if (k === 'f' && !e.ctrlKey) { this.zoomFit(); return true; }
    if (k === 'Escape') { if (this.app.pm.open) this.app.pm.cancel(); else { this.sel = []; this.updateHighlights(); this.renderTree(); this.pairMeasure(); } return true; }
    if (k === 'Enter' && this.app.pm.open) { this.app.pm.ok(); return true; }
    if (k === 'Delete' && !this.app.pm.open) {
      // 0.1.134: everything selected (mates and components; Shift+click ranges)
      const ms = this.sel.filter((s) => s.kind === 'mate').map((s) => s.id);
      const cs = [...new Set(this.sel.filter((s) => s.comp && s.kind !== 'plane' && s.kind !== 'feat').map((s) => s.comp))]; // a selected origin plane does not delete its component
      if (ms.length || cs.length) { this.deleteMates(ms, cs); return true; }
      if (this._motionOpen && this._mt?.selIds?.size) { this.deleteMotionSteps(); return true; }
    }
    return false;
  }
  dispose() { window.removeEventListener('pointerup', this._onUp); this.vp.dispose(); }
}
