// Part document: SolidWorks/Inventor-style feature-based modeling with a
// FeatureManager tree, PropertyManager feature dialogs, sketches on planes or
// faces, rollback, suppression, and live regeneration through the kernel.
import { cacheKey } from '../meshcache.js';
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { ViewSet } from '../viewset.js';
import { Sketcher, SKETCH_TOOLS, newSketch } from '../sketch/sketcher.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { opt, optHex } from '../app/options.js';
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
import { PartCommands } from './commands.js';
import { PartFeatureUI } from './featureui.js';
import { PartConvertLink } from './convertlink.js';
import { PartDimDrag } from './dimdrag.js';
import { hasLinks } from './linkgeom.js';
import { fixParallelDims } from './drive.js';

export const STD_PLANES = {
  Front: { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] },
  Top: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] },
  Right: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 0, -1] },
};

export const FEATURE_META = {
  sketch: { icon: 'sketch', base: 'Sketch' },
  extrude: { icon: 'extrude', base: 'Boss-Extrude' },
  extrudeCut: { icon: 'cutExtrude', base: 'Cut-Extrude' },
  revolve: { icon: 'revolve', base: 'Revolve' },
  revolveCut: { icon: 'cutRevolve', base: 'Cut-Revolve' },
  fillet: { icon: 'fillet', base: 'Fillet' },
  chamfer: { icon: 'chamfer', base: 'Chamfer' },
  shell: { icon: 'shell', base: 'Shell' },
  linearPattern: { icon: 'linearPattern', base: 'LPattern' },
  circularPattern: { icon: 'circularPattern', base: 'CirPattern' },
  mirror: { icon: 'mirror', base: 'Mirror' },
  import: { icon: 'import', base: 'Imported' },
};
export const metaKey = (f) => (f.type === 'extrude' && f.op === 'cut' ? 'extrudeCut' : f.type === 'revolve' && f.op === 'cut' ? 'revolveCut' : f.type);

export const MATERIALS = [
  { name: 'Not specified', density: 1.0 },
  { name: 'Plain Carbon Steel', density: 7.8 },
  { name: 'AISI 304 Stainless', density: 8.0 },
  { name: '6061 Aluminium Alloy', density: 2.7 },
  { name: 'Brass', density: 8.5 },
  { name: 'Copper', density: 8.9 },
  { name: 'Titanium Ti-6Al-4V', density: 4.43 },
  { name: 'ABS', density: 1.04 },
  { name: 'Nylon 6/6', density: 1.14 },
  { name: 'Oak', density: 0.75 },
];

export function newPartDoc(name = 'Part1') {
  return { kind: 'part', version: 1, name, units: 'mm', material: 'Not specified', features: [], rollback: null, next: 1 };
}

// model colours = Options > Colours (read live, so a change shows after applyColors / the next redraw)
export const COLORS = {
  get body() { return optHex('bodyColor'); }, get edge() { return optHex('edgeColor'); }, get hover() { return optHex('hoverColor'); },
  get sel() { return optHex('selColor'); }, get plane() { return optHex('planeColor'); },
};

// ghost preview colours: added volume, removed volume, body before the feature
export const GHOST_COL = { boss: 0xf2b630, bossEdge: 0xffc83d, cut: 0xe0463c, cutEdge: 0xff5a4a, prev: 0x7d8aa0 };

export class PartDoc {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    this.sel = [];
    this.hover = null;
    this.mesh = null;
    this.status = [];
    this.undoStack = [];
    this.redoStack = [];
    this.displayMode = 'shadedEdges';
    this.showPlanes = false;
    this.regenToken = 0;
    this.pmState = null;
  }

  // ======================= setup =======================
  init() {
    const app = this.app;
    this.viewSet = new ViewSet(app.el.views, { mode: '3d' }); // Viewport menu: 1, 2 or 4 panes
    this.viewport = this.vp = this.viewSet.proxy;
    this.viewSet.onLayout = () => app.syncViewportMenu?.(); // close / maximize from the pane buttons
    this.vp.onContextMenu = (e) => this.viewContextMenu(e);
    this.vp.onMiddleClick = () => this.zoomFit(); // double middle click = Zoom to Fit
    this.scene = this.vp.scene;
    this.bodyGroup = new THREE.Group(); this.scene.add(this.bodyGroup);
    this.ghostGroup = new THREE.Group(); this.ghostGroup.name = 'ghost'; this.scene.add(this.ghostGroup); // feature preview (see showGhost)
    this.sketchGroup = new THREE.Group(); this.scene.add(this.sketchGroup);
    this.planeGroup = new THREE.Group(); this.scene.add(this.planeGroup);
    this.hlGroup = new THREE.Group(); this.scene.add(this.hlGroup);
    this.vp.overlayDrawers.push((ctx) => this.drawOverlay(ctx));
    this.syncGrid();
    this.sketchPanel = app.el.props;
    this.buildCommands();
    this.buildHeadsUp();
    this.bindViewport();
    this.renderTree();
    this.updateSketchDisplay();
    this.updatePlanes();
    this.vp.setView('iso', false);
    this.vp.fit({ min: [-60, -60, -60], max: [60, 60, 60] });
    this.doc.pointClouds ||= [];
    this.clouds = new CloudManager(app, () => this.doc.pointClouds, () => [this.scene], () => { this.renderTree(); this.vp.requestRender(); });
    for (const f of this.doc.features) if (f.type === 'sketch') fixParallelDims(f); // 0.1.89: parallel-line distances measured from the sketch side
    this._autoLink = true; // older parts: fixed converted geometry on model edges gets linked (Options > Sketch)
    this.regen().then(async () => {
      if (this.doc.viewLayout && this.viewSet.restore(this.doc.viewLayout)) { /* saved panes + views */ } else if (this.mesh?.bbox) this.vp.fit(this.mesh.bbox);
      if (this.doc.pointClouds.length) { await this.clouds.loadAll(); if (!this.mesh?.bbox) this.zoomFit(); }
    });
    app.setStatusRight('MMGS');
  }

  get title() { return this.doc.name; }
  // grid on the Top plane, or on the sketch plane while sketching; doc.grid overrides the program default
  get gridOn() { return this.doc.grid ?? this.app.gridDefault?.() ?? true; }
  syncGrid() { const g = this.vp.grid; g.on = this.gridOn; g.frame = this.sketcher?.fr || null; this.vp.requestRender(); }
  toggleGrid() { this.doc.grid = !this.gridOn; this.syncGrid(); this.app.setStatus(`Grid ${this.doc.grid ? 'on' : 'off'} in this document (Viewport menu: default for all)`); this.app.syncViewportMenu?.(); }

  // Viewport menu: layout of 1, 2 or 4 panes (saved in the file with each pane's view)
  setViewLayout(name) { this.viewSet.setLayout(name, { fit: () => this.zoomFit() }); this.app.setStatus(name === 'single' ? 'Single view' : 'Click in a view to make it the active one (blue border); commands like Zoom to Fit and the standard views act on it'); }
  resetViews() { this.viewSet.resetViews(() => this.zoomFit()); }
  beforeSave() { const s = this.viewSet.toJSON(); if (s.layout === 'single') delete this.doc.viewLayout; else this.doc.viewLayout = s; }
  // Geometry used for picking: while a feature PropertyManager shows a live
  // preview, selections are made on the model as it was before the feature.
  get pick() { return this.pickOverride !== undefined ? this.pickOverride : this.pickDefault; }
  async setPickBase(features) {
    this.pickOverride = null;
    const res = await api.kernel('regen', { features }).catch(() => null);
    if (!res?.mesh?.positions?.length || !this.app.pm.open) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.mesh.positions), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(res.mesh.indices), 1));
    geom.computeVertexNormals();
    this.pickOverride = makePickData(res.mesh, new THREE.Mesh(geom));
  }
  clearPickBase() { this.pickOverride = undefined; }

  setDisplay(m) { this.displayMode = m; this.applyMesh(this.mesh); }

  zoomFit() {
    const box = new THREE.Box3();
    if (this.mesh?.bbox) box.union(new THREE.Box3(new THREE.Vector3(...this.mesh.bbox.min), new THREE.Vector3(...this.mesh.bbox.max)));
    this.sketchGroup.traverse((o) => { if (o.geometry) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
    this.ghostGroup?.traverse((o) => { if (o.geometry) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
    if (this.sketcher) {
      for (const c of this.sketcher.curves()) for (const p of sampleCurve(c, 16)) box.expandByPoint(new THREE.Vector3(...this.sketcher.to3(p)));
      box.expandByPoint(new THREE.Vector3(...this.sketcher.to3([0, 0])));
    }
    if (this.clouds) box.union(this.clouds.box());
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    this.vp.fit(box);
  }

  normalTo() {
    if (this.sketcher) { this.vp.normalTo(this.sketcher.fr); return; }
    const s = this.sel.find((x) => x.plane);
    if (s) { const fr = frameOf(s.plane); this.vp.normalTo(fr); }
    else toast('Select a plane or planar face to look normal to it');
  }

  // ======================= history =======================
  snapshot() { return JSON.stringify(this.doc); }
  commit(label) {
    this.undoStack.push(this._last ?? this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this._last = null;
    this.app.setDirty(true);
    void label;
  }
  beginChange() { this._last = this.snapshot(); }
  undo() {
    if (this.sketcher) { this.sketcher.undo(); return; }
    if (this.app.pm.open) return;
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.doc = JSON.parse(this.undoStack.pop());
    this.afterDocChange();
  }
  redo() {
    if (this.sketcher) { this.sketcher.redo(); return; }
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.doc = JSON.parse(this.redoStack.pop());
    this.afterDocChange();
  }
  // keep loaded point clouds in step with the document (undo/redo)
  syncClouds() {
    if (!this.clouds) return;
    this.doc.pointClouds ||= [];
    const ids = new Set(this.doc.pointClouds.map((r) => r.id));
    for (const id of [...this.clouds.views.keys()]) if (!ids.has(id)) this.clouds.remove(id);
    for (const r of this.doc.pointClouds) {
      const v = this.clouds.views.get(r.id);
      if (!v) this.clouds.load(r); else { v.rec = r; v.refresh(); }
    }
  }
  async addPointCloud(rec) {
    this.beginChange();
    this.doc.pointClouds.push(rec);
    this.commit('import point cloud');
    const v = await this.clouds.load(rec);
    this.renderTree();
    if (v) this.zoomFit();
  }
  removePointCloud(id) {
    this.beginChange();
    this.doc.pointClouds = this.doc.pointClouds.filter((r) => r.id !== id);
    this.commit('remove point cloud');
    this.clouds.remove(id);
    this.app.pm.close(false);
    this.renderTree(); this.vp.requestRender();
  }
  showCloudProps(id) {
    const rec = this.doc.pointClouds.find((r) => r.id === id);
    if (!rec) return;
    this.app.pm.show({ title: 'Point Cloud', iconName: 'cloud', fields: [], okLabel: 'Close', onOk: () => true });
    this.app.showPanel('pm');
    const body = this.app.el.pm.querySelector('.pm-body');
    const render = () => {
      body.innerHTML = '';
      body.appendChild(cloudPanel(rec, this.clouds.views.get(id), {
        onChange: () => { this.app.setDirty(true); this.vp.requestRender(); this.renderTree(); },
        onRemove: () => this.removePointCloud(id),
        onZoom: () => { const v = this.clouds.views.get(id); if (v) this.vp.fit(v.box); },
        onReload: async () => { await this.clouds.load(rec); render(); },
      }));
    };
    render();
  }
  afterDocChange() {
    this.syncClouds();
    this.sel = [];
    this.bodyGroup.visible = !this.doc.bodyHidden; this.updatePlanes();
    this.renderTree();
    this.updateSketchDisplay();
    this.regen();
    this.app.setDirty(true);
  }

  newId() { this.doc.next = (this.doc.next || 1) + 1; return 'f' + this.doc.next; }
  nextName(f) {
    const base = FEATURE_META[metaKey(f)].base;
    let n = 1;
    const names = new Set(this.doc.features.map((x) => x.name));
    while (names.has(base + n)) n++;
    return base + n;
  }
  insertIndex() { return this.doc.rollback ?? this.doc.features.length; }
  insertFeature(f) {
    const i = this.insertIndex();
    this.doc.features.splice(i, 0, f);
    if (this.doc.rollback !== null && this.doc.rollback !== undefined) this.doc.rollback++;
  }
  F(id) { return this.doc.features.find((f) => f.id === id); }
  faceRefOf(it) { return it?.kind === 'face' && it.plane ? { c: it.c, n: it.plane.normal, bb: this.pick?.mesh.bbox } : null; }
  planeOf(f) { return this.resolvedPlanes?.get(f.id) || f.plane; }
  consumedSketches() {
    const s = new Set();
    for (const f of this.doc.features) if (f.sketch) s.add(f.sketch);
    return s;
  }

  // ======================= regeneration =======================
  async regen(previewFeatures = null, opts = {}) {
    const token = ++this.regenToken;
    let features = previewFeatures || this.doc.features;
    const upTo = previewFeatures ? undefined : this.doc.rollback ?? undefined;
    this.app.setBusy(true);
    try {
      // linked converted edges (On Edge) follow earlier sketches / features: update those sketches first (preview: on a copy)
      let link = null;
      if (previewFeatures) { if (features.some(hasLinks)) { features = JSON.parse(JSON.stringify(features)); link = await this.relink(features); } }
      else {
        const auto = !!this._autoLink && opt('linkOld'); this._autoLink = false;
        link = await this.relink(features, { upTo, auto });
        if (token !== this.regenToken) return null;
        if (link?.changed && this.sketcher == null) this.updateSketchDisplay();
      }
      if (token !== this.regenToken) return null;
      const ghost = !!previewFeatures && !!opts.ghost;
      const res = await api.kernel('regen', { features, upTo, ghost });
      if (token !== this.regenToken) return res;
      this.linkStatus(link, res.status);
      if (ghost && res.ghost) this.showGhost(res, features[features.length - 1]);
      else { this.clearGhost(); this.applyMesh(res.mesh); }
      this.mass = res.mass;
      if (!previewFeatures) {
        this.savedMesh = { key: cacheKey(features, upTo), mesh: res.mesh }; // embedded in the file on save
        this.status = res.status;
        this.storeEdgeGroups(res.status);
        this.resolvedPlanes = new Map(res.status.filter((x) => x.plane).map((x) => [x.id, x.plane]));
        this.renderTree(); this.updateSketchDisplay();
        this.linkedMessage(link);
      }
      const err = res.status.find((s) => s.state === 'error');
      if (previewFeatures) this.app.pm.current?.setMessage(err ? err.error : '', err ? 'error' : 'info');
      else if (err) {
        this.app.setStatus(`Rebuild error in ${this.F(err.id)?.name}: ${err.error}`, 'error');
        try { window.__lithLog?.('REBUILD ERROR', res.status.filter((s) => s.state === 'error').map((s) => `${this.F(s.id)?.name}: ${s.error}`).join(' | ')); } catch { /* log optional */ }
      }
      else if (this._statusAfter && !previewFeatures) { this.app.setStatus(this._statusAfter); this._statusAfter = null; } // message of the change that caused this rebuild
      else if (!link?.linkedNow?.length) this.app.setStatus('Ready');
      return res;
    } catch (e) {
      toast('Kernel error: ' + e.message, 'error');
      return null;
    } finally {
      if (token === this.regenToken) this.app.setBusy(false);
    }
  }

  // Feature preview ("ghost"). Extrude / Revolve: the body as it was before the feature stays solid and the volume the
  // feature adds (yellow) or removes (red) is drawn see-through on top. Other features (fillet, chamfer, shell,
  // patterns): the result is shown solid and the body before the feature as a faint see-through outline.
  showGhost(res, f) {
    const g = res.ghost, tool = g.tool && (f?.type === 'extrude' || f?.type === 'revolve');
    this.clearGhost();
    this._ghostArgs = [res, f]; // Options window: redraw with new colours / opacities
    this.ghost = { op: g.op, tool: tool ? g.tool : null, prev: tool ? null : g.prev, result: res.mesh };
    // boss: body before + the added volume; cut: the real result (the model updates) + the removed volume on top
    this.applyMesh(tool && g.op !== 'cut' ? g.prev : res.mesh);
    const add = (m, color, faceA, edgeA, behindA) => {
      if (!m?.positions?.length) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.positions), 3));
      geom.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
      geom.computeVertexNormals();
      const mk = (opacity, depthTest, order) => {
        // the front pass writes depth so the viewport grid does not draw over the ghost
        const o = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: depthTest, depthTest, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
        o.renderOrder = order; o.raycast = () => {}; this.ghostGroup.add(o);
      };
      mk(faceA, true, 5);
      if (behindA) mk(behindA, false, 6); // the part hidden inside the body shows faintly through it
      const segs = [];
      for (const e of m.edges) { const p = e.pts; for (let i = 3; i < p.length; i += 3) segs.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]); }
      const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
      // edges: full strength on top of everything so the outline stays sharp; faces stay light
      const l = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: edgeCol ?? color, transparent: edgeA < 1, opacity: edgeA, depthTest: false }));
      l.renderOrder = 7; l.raycast = () => {}; this.ghostGroup.add(l);
    };
    let edgeCol = null;
    // colours and opacities: Tools > Options > Feature Preview (faces 8 %, inside 4 %, edges 100 %)
    if (tool) {
      const col = new THREE.Color(opt(g.op === 'cut' ? 'ghostCut' : 'ghostBoss'));
      edgeCol = col.clone().offsetHSL(0, 0, 0.06).getHex();
      add(g.tool, col.getHex(), opt('ghostFace') / 100, opt('ghostEdge') / 100, opt('ghostBehind') / 100);
    } else add(g.prev, GHOST_COL.prev, opt('ghostPrev') / 100, 0.35, 0);
    this.vp.requestRender();
  }
  // kernel tells which group of edges (same owning features) each fillet / chamfer edge belongs to: kept in the edge
  // reference so the edge is found again when its pocket / boss moves far (matchEdges fallback)
  storeEdgeGroups(status) {
    for (const st of status) {
      if (!st.refs) continue;
      const f = this.F(st.id); if (!f?.edges) continue;
      st.refs.forEach((g, k) => {
        const e = f.edges[k]; if (!g || !e) return;
        const { mid, bb, ...grp } = g; e.grp = grp;
        if (mid) { e.mid = mid; if (bb) e.bb = bb; } // the reference follows the edge (position of this rebuild)
      });
      delete st.refs;
    }
  }
  refreshGhost() { if (this.ghost && this._ghostArgs) this.showGhost(...this._ghostArgs); }
  // Options > Colours changed: recolour body, edges, planes and highlights without a rebuild
  applyColors() {
    this.bodyMesh?.material.color.setHex(COLORS.body);
    this.bodyGroup?.traverse((o) => { if (o.isLineSegments) o.material.color.setHex(COLORS.edge); });
    this.updatePlanes?.(); this.updateHighlights?.(); this.vp?.requestRender();
  }
  clearGhost() {
    this.ghost = null; this._ghostArgs = null;
    if (!this.ghostGroup) return;
    for (const o of [...this.ghostGroup.children]) { this.ghostGroup.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    this.vp?.requestRender();
  }

  applyMesh(m) {
    this.mesh = m;
    const g = this.bodyGroup;
    for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
    this.clearHighlights();
    if (!m || !m.positions?.length) { this.bodyMesh = null; this.pickDefault = null; this.vp.requestRender(); return; }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.positions), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
    geom.computeVertexNormals();

    const wire = this.displayMode === 'wire';
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS.body, metalness: 0.18, roughness: 0.42, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: wire, opacity: wire ? 0.0 : 1, depthWrite: !wire,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'body';
    g.add(mesh);
    this.bodyMesh = mesh;
    g.visible = !this.doc.bodyHidden;
    this.pickDefault = makePickData(m, mesh);
    if (this.displayMode !== 'shaded') {
      const segs = [];
      for (const e of m.edges) { const p = e.pts; for (let i = 3; i < p.length; i += 3) segs.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]); }
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
      const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COLORS.edge, depthTest: !wire }));
      g.add(lines);
    }
    this.vp.requestRender();
  }

  // ======================= planes & sketches display =======================
  planeSize() {
    if (this.mesh?.bbox) {
      const b = this.mesh.bbox;
      return Math.max(20, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.7);
    }
    return 60;
  }
  updatePlanes() {
    const g = this.planeGroup;
    for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
    const visible = new Set();
    if (this.showPlanes) Object.keys(STD_PLANES).forEach((k) => visible.add(k));
    for (const k of this.doc.planesShown || []) visible.add(k); // tree eye
    for (const s of this.sel) if (s.kind === 'plane') visible.add(s.name);
    if (this.hover?.kind === 'plane') visible.add(this.hover.name);
    if (this.hoverTreePlane) visible.add(this.hoverTreePlane);
    const S = this.planeSize();
    for (const name of visible) {
      const fr = frameOf(STD_PLANES[name]);
      const corners = [[-S, -S], [S, -S], [S, S], [-S, S]].map(([u, v]) => new THREE.Vector3(
        fr.o[0] + fr.x[0] * u + fr.y[0] * v, fr.o[1] + fr.x[1] * u + fr.y[1] * v, fr.o[2] + fr.x[2] * u + fr.y[2] * v));
      const sel = this.sel.some((s) => s.kind === 'plane' && s.name === name);
      const hov = (this.hover?.kind === 'plane' && this.hover.name === name) || this.hoverTreePlane === name;
      const col = sel ? COLORS.sel : hov ? COLORS.hover : COLORS.plane;
      const geom = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      mesh.userData.plane = name;
      g.add(mesh);
      const lg = new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]);
      g.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8 })));
    }
    this.vp.requestRender();
  }

  updateSketchDisplay() {
    const g = this.sketchGroup;
    for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
    const consumed = this.consumedSketches();
    const roll = this.doc.rollback ?? Infinity;
    this.doc.features.forEach((f, i) => {
      if (f.type !== 'sketch' || i >= roll) return;
      if (this.sketcher && this.sketcher.original.id === f.id) return;
      const shownBy = [this.dimFeat, this.hoverFeat].some((id) => id && (id === f.id || this.F(id)?.sketch === f.id));
      const show = shownBy || (f.visible ?? !consumed.has(f.id));
      if (!show) return;
      const fr = frameOf(this.planeOf(f));
      const pts = [];
      const cpts = [];
      for (const c of sketchCurves(f, { includeConstruction: true })) {
        const arr = c.construction ? cpts : pts;
        const s = sampleCurve(c, 64);
        for (let k = 1; k < s.length; k++) arr.push(...to3(fr, s[k - 1]), ...to3(fr, s[k]));
      }
      const selected = this.sel.some((s) => s.kind === 'sketch' && s.id === f.id);
      const hov = (this.hover?.kind === 'sketch' && this.hover.id === f.id) || (this.hoverFeat && (this.hoverFeat === f.id || this.F(this.hoverFeat)?.sketch === f.id));
      // shown through a double-clicked face / tree hover: bright so it reads on top of the model (dark + light mode)
      const color = selected ? COLORS.sel : hov ? COLORS.hover : shownBy ? new THREE.Color(opt(document.body.classList.contains('dark') ? 'shownSkDark' : 'shownSkLight')).getHex() : 0x3050a0;
      if (pts.length) {
        const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const ls = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, depthTest: !shownBy })); if (shownBy) ls.renderOrder = 5; g.add(ls);
      }
      if (cpts.length) {
        const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(cpts, 3));
        const ls = new THREE.LineSegments(geom, new THREE.LineDashedMaterial({ color, dashSize: 3 * this.vp.scale, gapSize: 2 * this.vp.scale }));
        ls.computeLineDistances(); g.add(ls);
      }
      if (this.featUI?.sketch === f.id) { const fill = this.featFill(f); if (fill) g.add(fill); }
    });
    this.vp.requestRender();
  }

  dispose() {
    this.clouds?.dispose();
    this.sketcher?.dispose();
    this.vp.dispose();
  }
}

// ---------- helpers ----------
export function makePickData(mesh, obj) {
  const faceOfTri = new Int32Array(mesh.indices.length / 3);
  for (const f of mesh.faces) for (let t = f.start / 3; t < (f.start + f.count) / 3; t++) faceOfTri[t] = f.id;
  return { mesh, obj, faceOfTri };
}
export function edgeRef(e, mesh) {
  if (e.bb || !e.edge) return { mid: e.mid, type: e.type, ...(e.dir ? { dir: e.dir } : {}), ...(e.bb ? { bb: e.bb } : {}) };
  const p = e.edge.pts;
  const ref = { mid: e.mid, type: e.type, bb: mesh?.bbox };
  if (e.type === 'line' && p.length >= 6) {
    const d = [p[p.length - 3] - p[0], p[p.length - 2] - p[1], p[p.length - 1] - p[2]];
    ref.dir = norm(d);
  }
  return ref;
}
export function frameOf(pl) {
  const n = norm(pl.normal), x = norm(pl.xDir);
  const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  return { o: pl.origin, n, x, y };
}
export function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export function to3(fr, p) { return [fr.o[0] + fr.x[0] * p[0] + fr.y[0] * p[1], fr.o[1] + fr.x[1] * p[0] + fr.y[1] * p[1], fr.o[2] + fr.x[2] * p[0] + fr.y[2] * p[1]]; }
export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
// circle through edge polyline points (3D)
export function circle3(pts) {
  const n = pts.length / 3;
  if (n < 3) return null;
  const P = (i) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const a = P(0), b = P(Math.floor(n / 3)), c = P(Math.floor((2 * n) / 3));
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nn = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const nl = Math.hypot(...nn);
  if (nl < 1e-12) return null;
  const nz = nn.map((v) => v / nl);
  const ux = norm(ab), uy = [nz[1] * ux[2] - nz[2] * ux[1], nz[2] * ux[0] - nz[0] * ux[2], nz[0] * ux[1] - nz[1] * ux[0]];
  const L = (p) => { const d = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]; return [d[0] * ux[0] + d[1] * ux[1] + d[2] * ux[2], d[0] * uy[0] + d[1] * uy[1] + d[2] * uy[2]]; };
  const cc = circleFrom3(L(a), L(b), L(c));
  if (!cc) return null;
  const center = [a[0] + ux[0] * cc.c[0] + uy[0] * cc.c[1], a[1] + ux[1] * cc.c[0] + uy[1] * cc.c[1], a[2] + ux[2] * cc.c[0] + uy[2] * cc.c[1]];
  return { c: center, r: cc.r, n: nz };
}
// axis from an edge: line direction, or circle center + normal
export function edgeAxis(ed) {
  const pts = ed.pts;
  if (!pts || pts.length < 6) return null;
  if (ed.type === 'circle') { const c = circle3(pts); return c ? { p: c.c, d: c.n } : null; }
  const a = [pts[0], pts[1], pts[2]], b = [pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]];
  return { p: a, d: norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) };
}

// mix in methods split off into separate files
for (const M of [PartPicking, PartTree, PartSketching, PartFeatures, PartExchange, PartCommands, PartFeatureUI, PartConvertLink, PartDimDrag]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(PartDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
