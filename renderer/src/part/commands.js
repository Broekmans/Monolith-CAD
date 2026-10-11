import { cacheKey } from '../meshcache.js';
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
import { PartPicking } from './picking.js';
import { PartTree } from './tree.js';
import { PartSketching } from './sketching.js';
import { PartFeatures } from './features.js';
import { PartExchange } from './exchange.js';
import { STD_PLANES, FEATURE_META, metaKey, MATERIALS, newPartDoc, COLORS, makePickData, edgeRef, frameOf, norm, to3, segDist, circle3, edgeAxis, PartDoc } from './part.js';

export class PartCommands {
  // ======================= commands =======================
  buildCommands() {
    const inSketch = () => !!this.sketcher;
    const notSketch = () => !this.sketcher && !this.app.pm.open;
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const sketchTools = SKETCH_TOOLS.map((t) => C('sk-' + t.id, t.label, t.icon, () => this.sketchTool(t.id), {
      enabled: () => inSketch(), active: () => this.sketcher?.tool?.id === t.id, tip: `${t.label}${t.key ? ` (${t.key})` : ''}`,
    }));
    const features = [
      [C('extrude', 'Extruded Boss/Base', 'extrude', () => this.cmdExtrude('boss'), { enabled: () => !this.app.pm.open }),
        C('revolve', 'Revolved Boss/Base', 'revolve', () => this.cmdRevolve('boss'), { enabled: () => !this.app.pm.open })],
      [C('cut', 'Extruded Cut', 'cutExtrude', () => this.cmdExtrude('cut'), { enabled: () => !this.app.pm.open }),
        C('rcut', 'Revolved Cut', 'cutRevolve', () => this.cmdRevolve('cut'), { enabled: () => !this.app.pm.open })],
      [C('fillet', 'Fillet', 'fillet', () => this.cmdFillet('fillet'), { enabled: notSketch }),
        C('chamfer', 'Chamfer', 'chamfer', () => this.cmdFillet('chamfer'), { enabled: notSketch }),
        C('shell', 'Shell', 'shell', () => this.cmdShell(), { enabled: notSketch })],
      [C('lpattern', 'Linear Pattern', 'linearPattern', () => this.cmdPattern('linearPattern'), { enabled: notSketch }),
        C('cpattern', 'Circular Pattern', 'circularPattern', () => this.cmdPattern('circularPattern'), { enabled: notSketch }),
        C('mirror', 'Mirror', 'mirror', () => this.cmdPattern('mirror'), { enabled: notSketch })],
    ];
    const sketchTab = [
      [C('sketch', 'Sketch', 'sketch', () => this.cmdSketch(), { enabled: () => !this.app.pm.open || inSketch(), active: inSketch, tip: 'Sketch: select a plane or planar face' }),
        C('exitSketch', 'Exit Sketch', 'exitSketch', () => this.exitSketch(true), { enabled: inSketch }),
        C('sk-dimension', 'Smart Dimension', 'dimension', () => this.sketchTool('dimension'), { enabled: inSketch, active: () => this.sketcher?.tool?.id === 'dimension', tip: 'Smart Dimension (D)' })],
      sketchTools.filter((t) => !['sk-trim', 'sk-dimension'].includes(t.id)),
      [sketchTools.find((t) => t.id === 'sk-trim'),
        C('convert', 'Convert Entities', 'convert', () => this.cmdConvert(), { enabled: inSketch, tip: 'Project selected model edges into the sketch' }),
        C('mirror', 'Mirror Entities', 'mirror', () => this.sketcher?.startMirror(), { enabled: inSketch, active: () => !!this.sketcher?.mirrorMode, tip: 'Mirror: 1) select entities, 2) click the mirror line' }),
        C('construction', 'Construction Geometry', 'construction', () => this.sketcher?.toggleConstruction(), { enabled: inSketch }),
        C('relations', 'Show Relations', 'relation', () => { if (this.sketcher) { this.sketcher.showRelations = !this.sketcher.showRelations; this.vp.requestRender(); this.app.cm.refresh(); } }, { enabled: inSketch, active: () => this.sketcher?.showRelations })],
    ];
    const evaluate = [
      [C('mass', 'Mass Properties', 'massProps', () => this.cmdMass(), { enabled: notSketch }),
        C('measure', 'Measure', 'measure', () => this.cmdMeasure(), { enabled: notSketch }),
        C('section', 'Section View', 'section', () => toggleSection(this), { enabled: () => !this.sketcher, active: () => !!this.vp?.section })],
      [C('impStep', 'Import STEP/IGES', 'import', () => this.app.importFile(), { enabled: notSketch }),
        C('impPc', 'Import Point Cloud', 'cloud', () => this.app.importPointCloud(), { enabled: notSketch, tip: 'Import a scan (LAS, LAZ, PLY, XYZ, PTS) as a reference' }),
        C('expStep', 'Export STEP', 'step', () => this.exportCAD('step'), { enabled: notSketch }),
        C('expIges', 'Export IGES', 'export', () => this.exportCAD('iges'), { enabled: notSketch })],
    ];
    this.tabs = [{ name: 'Sketch', groups: sketchTab }, { name: 'Features', groups: features }, { name: 'Evaluate', groups: evaluate }];
    this.app.cm.setTabs(this.tabs, 'Sketch');
  }

  buildHeadsUp() {
    const bar = this.app.el.headsUp;
    bar.innerHTML = '';
    const B = (ic, tip, run) => h('button', { class: 'hu-btn', title: tip, html: icon(ic), onclick: run });
    const viewsMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Front', key: 'Ctrl+1', run: () => this.vp.setView('front') }, { label: 'Back', key: 'Ctrl+2', run: () => this.vp.setView('back') },
        { label: 'Left', key: 'Ctrl+3', run: () => this.vp.setView('left') }, { label: 'Right', key: 'Ctrl+4', run: () => this.vp.setView('right') },
        { label: 'Top', key: 'Ctrl+5', run: () => this.vp.setView('top') }, { label: 'Bottom', key: 'Ctrl+6', run: () => this.vp.setView('bottom') },
        { label: 'Isometric', key: 'Ctrl+7', run: () => this.vp.setView('iso') }, { label: 'Trimetric', run: () => this.vp.setView('trimetric') },
        { label: 'Normal To', key: 'Ctrl+8', run: () => this.normalTo() },
      ]);
    };
    const dispMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Shaded With Edges', icon: 'shaded', run: () => this.setDisplay('shadedEdges') },
        { label: 'Shaded', icon: 'shaded', run: () => this.setDisplay('shaded') },
        { label: 'Wireframe', icon: 'wire', run: () => this.setDisplay('wire') },
        '-',
        { label: (this.showPlanes ? 'Hide' : 'Show') + ' Planes', icon: 'plane', run: () => { this.showPlanes = !this.showPlanes; this.updatePlanes(); } },
      ]);
    };
    bar.append(B('zoomFit', 'Zoom to Fit (F)', () => this.zoomFit()), B('normalTo', 'Normal To (Ctrl+8)', () => this.normalTo()),
      B('views', 'View Orientation', viewsMenu), B('shaded', 'Display Style', dispMenu), B('section', 'Section View', () => toggleSection(this)));
  }

  // ======================= keyboard =======================
  onKey(e) {
    const k = e.key;
    if (e.ctrlKey && !e.shiftKey && /^[1-8]$/.test(k)) {
      const v = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][+k - 1];
      if (v) this.vp.setView(v); else this.normalTo();
      return true;
    }
    if (e.ctrlKey && (k === 'z' || k === 'Z')) { this.undo(); return true; }
    if (e.ctrlKey && (k === 'y' || k === 'Y')) { this.redo(); return true; }
    if (k === 'f' && !e.ctrlKey) { this.zoomFit(); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const a = Math.PI / 12;
      this.vp.rotateBy(k === 'ArrowLeft' ? -a : k === 'ArrowRight' ? a : 0, k === 'ArrowUp' ? -a : k === 'ArrowDown' ? a : 0);
      return true;
    }
    if (this.sketcher) {
      const sk = this.sketcher;
      if (sk.mirrorMode && k === 'Escape') { sk.endMirror(); return true; }
      if (sk.mirrorMode && k === 'Enter') { if (sk.mirrorMode.step === 1) sk.mirrorNext(); return true; }
      if (k === 'Escape') { if (sk.tool) { if (sk.tool.pts?.length || sk.tool.pending) { sk.tool.pts = []; sk.tool.snaps = []; sk.tool.prevEnd = null; sk.tool.pending = null; sk.tool.picks = []; sk.vp.requestRender(); } else sk.setTool(null); } else { sk.sel.clear(); sk.renderPanel(); sk.vp.requestRender(); } this.app.cm.refresh(); return true; }
      if (k === 'Delete' || k === 'Backspace') { sk.deleteSelection(); return true; }
      if (!e.ctrlKey) {
        const t = SKETCH_TOOLS.find((x) => x.key && x.key.toLowerCase() === k.toLowerCase());
        if (t) { this.sketchTool(t.id); return true; }
      }
      return false;
    }
    if (k === 'Escape') { if (this.dimFeat) this.showFeatureDims(null); if (this.app.pm.open) this.app.pm.cancel(); else { this.sel = []; this.afterSelection(); } return true; }
    if (k === 'Enter' && this.app.pm.open) { this.app.pm.ok(); return true; }
    if (k === 'Delete') {
      const f = this.sel.find((s) => s.kind === 'feature' || s.kind === 'sketch');
      if (f && !this.app.pm.open) { this.deleteFeature(f.id); return true; }
    }
    return false;
  }

  viewContextMenu(e) {
    if (this.sketcher) {
      const sk = this.sketcher;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Exit Sketch', icon: 'exitSketch', run: () => this.exitSketch(true) },
        { label: 'Discard Changes', icon: 'cancel', run: () => this.exitSketch(false) },
        '-',
        ...SKETCH_TOOLS.slice(0, 6).map((t) => ({ label: t.label, icon: t.icon, run: () => this.sketchTool(t.id) })),
        { label: 'Smart Dimension', icon: 'dimension', run: () => this.sketchTool('dimension') },
        '-', { label: 'Zoom to Fit', icon: 'zoomFit', key: 'F', run: () => this.zoomFit() }, { label: 'Normal To', icon: 'normalTo', run: () => this.normalTo() },
        sk.sel.size ? { label: 'Delete', icon: 'delete', key: 'Del', run: () => sk.deleteSelection() } : null,
      ]);
      return;
    }
    const p = this.pickAt(e);
    const items = [];
    if (p?.kind === 'face' && p.plane) items.push({ label: 'Sketch', icon: 'sketch', run: () => this.startSketch(p.plane, 'Face', null, this.faceRefOf(p)) }, { label: 'Normal To', icon: 'normalTo', run: () => this.vp.normalTo(frameOf(p.plane)) });
    if (p?.kind === 'face') items.push({ label: 'Shell (remove face)', icon: 'shell', run: () => { this.sel = [p]; this.cmdShell(); } });
    if (p?.kind === 'edge') items.push({ label: 'Fillet', icon: 'fillet', run: () => { if (!this.sel.some((s) => s.key === p.key)) this.sel.push(p); this.cmdFillet('fillet'); } }, { label: 'Chamfer', icon: 'chamfer', run: () => { if (!this.sel.some((s) => s.key === p.key)) this.sel.push(p); this.cmdFillet('chamfer'); } });
    if (p?.kind === 'sketch') items.push({ label: 'Edit Sketch', icon: 'sketch', run: () => this.editSketch(p.id) }, { label: 'Extruded Boss/Base', icon: 'extrude', run: () => { this.sel = [p]; this.cmdExtrude('boss'); } }, { label: 'Extruded Cut', icon: 'cutExtrude', run: () => { this.sel = [p]; this.cmdExtrude('cut'); } });
    if (p?.kind === 'plane') items.push({ label: 'Sketch', icon: 'sketch', run: () => this.startSketch(p.plane, p.name) });
    if (items.length) items.push('-');
    items.push({ label: 'Zoom to Fit', icon: 'zoomFit', key: 'F', run: () => this.zoomFit() }, { label: 'Isometric', icon: 'views', key: 'Ctrl+7', run: () => this.vp.setView('iso') });
    contextMenu(e.clientX, e.clientY, items);
  }
}
