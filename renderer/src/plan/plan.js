// Plan document: AutoCAD-style 2D drafting (command line, object snaps,
// grips, layers) plus architectural walls, doors, windows and slabs with a
// live 3D model.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, promptText, evalNumber } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import * as G from './planGeom.js';
import { parseDxf, planToDxf } from '../io/dxf.js';
import { circleFrom3, cross2 } from '../sketch/geom2d.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { PlanEvents } from './events.js';
import { PlanDraw } from './draw.js';
import { PlanPanels } from './panels.js';
import { PlanIO } from './io.js';
export * from './commands.js';

const { dist, add, sub, mul, lerp } = G;

export function newPlanDoc(name = 'Plan1') {
  return {
    kind: 'plan', version: 1, name, units: 'mm', next: 1, current: '0',
    layers: [
      { name: '0', color: '#000000', visible: true, locked: false },
      { name: 'Walls', color: '#202020', visible: true, locked: false },
      { name: 'Doors', color: '#a04a00', visible: true, locked: false },
      { name: 'Windows', color: '#1f5fbf', visible: true, locked: false },
      { name: 'Dimensions', color: '#c01010', visible: true, locked: false },
      { name: 'Text', color: '#106010', visible: true, locked: false },
      { name: 'Slabs', color: '#707070', visible: true, locked: false },
    ],
    entities: [],
    settings: { grid: true, snap: false, ortho: false, osnap: true, gridSize: 100, wallT: 200, wallH: 2700, wallJ: 'center', doorW: 900, doorH: 2100, winW: 1200, winH: 1200, winSill: 900, textH: 250, slabT: 200, dimTextH: 150 },
  };
}

export const LAYER_FOR = { wall: 'Walls', door: 'Doors', window: 'Windows', dim: 'Dimensions', text: 'Text' };

export class PlanDoc {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    this.sel = new Set();
    this.hover = null;
    this.cmd = null;
    this.undoStack = [];
    this.redoStack = [];
    this.layout = 'split';
    this.cursor = null;
    this.history = [];
  }
  get title() { return this.doc.name; }
  get S() { return this.doc.settings; }

  // ======================= setup =======================
  init() {
    const app = this.app;
    const wrap = h('div', { class: 'plan-views' });
    app.el.views.appendChild(wrap);
    this.planPane = h('div', { class: 'pane plan-pane' });
    this.p3dPane = h('div', { class: 'pane p3d-pane' });
    wrap.append(this.planPane, this.p3dPane);
    this.vp = new Viewport(this.planPane, { mode: 'plan' });
    this.vp.el.classList.add('paper');
    this.vp3 = new Viewport(this.p3dPane, { mode: '3d' });
    this.viewport = this.vp;
    this.vp.overlayDrawers.push((ctx) => this.draw(ctx));
    this.vp.onContextMenu = (e) => this.contextMenu(e);
    this.vp3.setView('iso', false);
    this.modelGroup = new THREE.Group(); this.vp3.scene.add(this.modelGroup);
    this.applyLayout();
    this.buildCommands();
    this.buildHeadsUp();
    this.bind();
    this.app.showPanel('tree');
    this.renderPanel();
    this.app.showCommandLine(true, (txt) => this.onCommandInput(txt));
    this.prompt('Command:');
    this.updateToggles();
    this.vp.fit({ min: [-1000, 0, -8000], max: [10000, 0, 1000] });
    this.zoomExtents(true);
    this.update3D();
    app.setStatusRight('mm');
    this.doc.pointClouds ||= [];
    this.clouds = new CloudManager(app, () => this.doc.pointClouds, () => [this.vp.scene, this.vp3.scene], () => { this.renderPanel(); this.vp.requestRender(); this.vp3.requestRender(); });
    if (this.doc.pointClouds.length) this.clouds.loadAll().then(() => this.zoomExtents());
  }

  // ======================= point clouds =======================
  async addPointCloud(rec) {
    this.undoStack.push(this.snapshot());
    this.doc.pointClouds.push(rec);
    this.app.setDirty(true);
    const v = await this.clouds.load(rec);
    if (v) {
      this.selCloud = rec.id; this.sel.clear();
      this.renderPanel();
      this.zoomExtents();
      this.vp3.fit(v.box); this._fitted3d = true;
    }
  }
  removePointCloud(id) {
    this.change(() => { this.doc.pointClouds = this.doc.pointClouds.filter((r) => r.id !== id); });
    this.clouds.remove(id);
    this.selCloud = null;
    this.renderPanel(); this.vp.requestRender(); this.vp3.requestRender();
  }
  syncClouds() {
    if (!this.clouds) return;
    this.doc.pointClouds ||= [];
    const ids = new Set(this.doc.pointClouds.map((r) => r.id));
    for (const id of [...this.clouds.views.keys()]) if (!ids.has(id)) this.clouds.remove(id);
    for (const r of this.doc.pointClouds) { const v = this.clouds.views.get(r.id); if (!v) this.clouds.load(r); else { v.rec = r; v.refresh(); } }
  }

  applyLayout() {
    this.planPane.style.display = this.layout === '3d' ? 'none' : '';
    this.p3dPane.style.display = this.layout === 'plan' ? 'none' : '';
    this.vp.resize(); this.vp3.resize();
  }

  buildCommands() {
    const C = (id, label, ic, cmd, extra = {}) => ({ id, label, icon: ic, run: () => this.runCommand(cmd), tip: `${label} (${cmd})`, ...extra });
    const draw = [
      [C('line', 'Line', 'line', 'LINE'), C('pline', 'Polyline', 'polyline', 'PLINE'), C('rect', 'Rectangle', 'rect', 'RECTANG')],
      [C('circle', 'Circle', 'circle', 'CIRCLE'), C('arc', 'Arc', 'arc3', 'ARC'), C('text', 'Text', 'text', 'TEXT')],
      [C('dimlin', 'Linear Dim', 'dimension', 'DIMLINEAR'), C('dimal', 'Aligned Dim', 'dimAligned', 'DIMALIGNED')],
    ];
    const modify = [
      [C('move', 'Move', 'move', 'MOVE'), C('copy', 'Copy', 'copy', 'COPY'), C('rotate', 'Rotate', 'rotate', 'ROTATE')],
      [C('scale', 'Scale', 'scale', 'SCALE'), C('mirror', 'Mirror', 'mirror', 'MIRROR'), C('offset', 'Offset', 'offset', 'OFFSET')],
      [C('trim', 'Trim', 'trim', 'TRIM'), C('fillet', 'Fillet', 'fillet', 'FILLET'), C('explode', 'Explode', 'explode', 'EXPLODE'), C('erase', 'Erase', 'erase', 'ERASE')],
    ];
    const arch = [
      [C('wall', 'Wall', 'wall', 'WALL'), C('door', 'Door', 'door', 'DOOR'), C('window', 'Window', 'window', 'WINDOW'), C('slab', 'Slab', 'slab', 'SLAB')],
      [{ id: 'v2d', label: 'Plan', icon: 'single', run: () => this.setLayout('plan'), active: () => this.layout === 'plan' },
        { id: 'vsplit', label: 'Plan + 3D', icon: 'split', run: () => this.setLayout('split'), active: () => this.layout === 'split' },
        { id: 'v3d', label: '3D', icon: 'cube3d', run: () => this.setLayout('3d'), active: () => this.layout === '3d' }],
      [{ id: 'expStep', label: 'Export 3D STEP', icon: 'step', run: () => this.exportStep() },
        { id: 'impPc', label: 'Import Point Cloud', icon: 'cloud', run: () => this.app.importPointCloud(), tip: 'Import a scan (LAS, LAZ, PLY, XYZ, PTS) to trace over' }],
    ];
    const io = [
      [{ id: 'impDxf', label: 'Import DXF/DWG', icon: 'import', run: () => this.app.importFile() },
        { id: 'expDxf', label: 'Export DXF', icon: 'export', run: () => this.exportDxf('dxf') },
        { id: 'expDwg', label: 'Export DWG', icon: 'dwg', run: () => this.exportDxf('dwg') },
        { id: 'impPc2', label: 'Import Point Cloud', icon: 'cloud', run: () => this.app.importPointCloud() }],
    ];
    this.app.cm.setTabs([{ name: 'Draw', groups: draw }, { name: 'Modify', groups: modify }, { name: 'Architecture', groups: arch }, { name: 'Import/Export', groups: io }], 'Draw');
  }
  setLayout(l) { this.layout = l; this.applyLayout(); this.app.cm.refresh(); if (l !== 'plan') this.update3D(); }

  buildHeadsUp() {
    const bar = this.app.el.headsUp;
    bar.innerHTML = '';
    const B = (ic, tip, run) => h('button', { class: 'hu-btn', title: tip, html: icon(ic), onclick: run });
    bar.append(B('zoomFit', 'Zoom Extents (double-click wheel)', () => this.zoomExtents()), B('layers', 'Layers', () => this.app.showPanel('tree')));
  }

  updateToggles() {
    const s = this.S;
    this.app.setToggles([
      { label: 'GRID', key: 'F7', on: s.grid, run: () => { s.grid = !s.grid; this.updateToggles(); this.vp.requestRender(); } },
      { label: 'SNAP', key: 'F9', on: s.snap, run: () => { s.snap = !s.snap; this.updateToggles(); } },
      { label: 'ORTHO', key: 'F8', on: s.ortho, run: () => { s.ortho = !s.ortho; this.updateToggles(); } },
      { label: 'OSNAP', key: 'F3', on: s.osnap, run: () => { s.osnap = !s.osnap; this.updateToggles(); } },
    ]);
  }

  // ======================= history =======================
  snapshot() { return JSON.stringify(this.doc); }
  change(fn) {
    const before = this.snapshot();
    fn();
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.app.setDirty(true);
    this.afterChange();
  }
  undo() {
    if (this.cmd?.undoStep?.()) return;
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.doc = JSON.parse(this.undoStack.pop());
    this.sel.clear(); this.afterChange();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.doc = JSON.parse(this.redoStack.pop());
    this.sel.clear(); this.afterChange();
  }
  afterChange() {
    this.syncClouds();
    for (const id of [...this.sel]) if (!this.E(id)) this.sel.delete(id);
    this.renderPanel();
    this.vp.requestRender();
    clearTimeout(this._t3d); this._t3d = setTimeout(() => this.update3D(), 250);
  }

  newId() { this.doc.next = (this.doc.next || 1) + 1; return 'e' + this.doc.next; }
  E(id) { return this.doc.entities.find((e) => e.id === id); }
  layer(name) { return this.doc.layers.find((l) => l.name === name) || this.doc.layers[0]; }
  wallMap() { return new Map(this.doc.entities.filter((e) => e.type === 'wall').map((w) => [w.id, w])); }
  addEntity(e) {
    e.id = this.newId();
    if (!e.layer) {
      const auto = LAYER_FOR[e.type];
      e.layer = auto && this.doc.layers.some((l) => l.name === auto) && this.doc.current === '0' ? auto : this.doc.current;
    }
    this.doc.entities.push(e);
    return e;
  }
  visibleEntities() {
    const vis = new Set(this.doc.layers.filter((l) => l.visible).map((l) => l.name));
    return this.doc.entities.filter((e) => vis.has(e.layer));
  }
  editable(e) { return !this.layer(e.layer).locked; }

  // ======================= 3D model =======================
  async update3D() {
    if (this.layout === 'plan' && !this._force3d) return;
    const vis = this.visibleEntities().filter((e) => ['wall', 'door', 'window'].includes(e.type) || (e.type === 'polyline' && e.closed && e.slab));
    const token = (this._tok3 = (this._tok3 || 0) + 1);
    try {
      const mesh = await api.kernel('planModel', { entities: vis });
      if (token !== this._tok3) return;
      const g = this.modelGroup;
      for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
      if (mesh?.positions?.length) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
        geom.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
        geom.computeVertexNormals();
        g.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide })));
        const segs = [];
        for (const e of mesh.edges) { const p = e.pts; for (let i = 3; i < p.length; i += 3) segs.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]); }
        const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
        g.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x404040 })));
        if (!this._fitted3d && mesh.bbox) { this.vp3.fit(mesh.bbox); this._fitted3d = true; }
      }
      // ground grid
      if (!this.ground) {
        this.ground = new THREE.GridHelper(40000, 40, 0xb8c0cc, 0xd8dde4);
        this.vp3.scene.add(this.ground);
      }
      this.vp3.requestRender();
    } catch (e) { console.error(e); }
  }

  // ======================= coordinates =======================
  affine() {
    const o = this.vp.toScreen([0, 0, 0]), ex = this.vp.toScreen([1, 0, 0]), ey = this.vp.toScreen([0, 0, -1]);
    return { o, ex: [ex[0] - o[0], ex[1] - o[1]], ey: [ey[0] - o[0], ey[1] - o[1]] };
  }
  S2(p, A = this._A) { return [A.o[0] + A.ex[0] * p[0] + A.ey[0] * p[1], A.o[1] + A.ex[1] * p[0] + A.ey[1] * p[1]]; }
  planAt(e) {
    const r = this.vp.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const q = this.vp.planePoint(sx, sy, { o: [0, 0, 0], n: [0, 1, 0], x: [1, 0, 0], y: [0, 0, -1] });
    return { p: q, sx, sy };
  }
  get px() { return this.vp.scale; }

  zoomExtents(initial = false) {
    const walls = this.wallMap();
    let box = null;
    for (const e of this.visibleEntities()) {
      const b = G.bboxOf(e, walls);
      if (!b) continue;
      box = box ? { min: [Math.min(box.min[0], b.min[0]), Math.min(box.min[1], b.min[1])], max: [Math.max(box.max[0], b.max[0]), Math.max(box.max[1], b.max[1])] } : b;
    }
    const cb = this.clouds?.box();
    if (cb && !cb.isEmpty()) {
      const b = { min: [cb.min.x, -cb.max.z], max: [cb.max.x, -cb.min.z] };
      box = box ? { min: [Math.min(box.min[0], b.min[0]), Math.min(box.min[1], b.min[1])], max: [Math.max(box.max[0], b.max[0]), Math.max(box.max[1], b.max[1])] } : b;
    }
    if (!box) { if (initial) this.vp.fit({ min: [-500, 0, -6000], max: [8000, 0, 500] }); return; }
    const pad = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) * 0.05 + 10;
    this.vp.fit({ min: [box.min[0] - pad, 0, -(box.max[1] + pad)], max: [box.max[0] + pad, 0, -(box.min[1] - pad)] });
  }

  // ======================= snapping =======================
  snap(p, { base = null, exclude = null } = {}) {
    const thr = 10 * this.px;
    const s = this.S;
    if (s.osnap) {
      const walls = this.wallMap();
      let best = null, bd = thr;
      const ents = this.visibleEntities().filter((e) => !exclude || !exclude.has(e.id));
      for (const e of ents) {
        for (const sp of G.snapPoints(e, walls)) {
          const d = dist(p, sp.p);
          if (d < bd) { bd = d; best = { p: sp.p, kind: sp.kind }; }
        }
      }
      // intersections among entities near the cursor
      if (!best) {
        const near = [];
        for (const e of ents) for (const c of G.curvesOf(e, walls)) if (G.distToCurve(p, c) < thr * 1.5) near.push(c);
        for (let i = 0; i < near.length && !best; i++) for (let j = i + 1; j < near.length; j++) {
          for (const q of G.intersect(near[i], near[j])) if (dist(p, q) < thr && (!best || dist(p, q) < dist(p, best.p))) best = { p: q, kind: 'int' };
        }
      }
      // perpendicular from base
      if (!best && base) {
        for (const e of ents) for (const c of G.curvesOf(e, walls)) {
          if (c.kind !== 'line') continue;
          const pr = G.projectOnSegment(base, c.a, c.b);
          if (pr.t > 0 && pr.t < 1 && dist(p, pr.pt) < thr) { best = { p: pr.pt, kind: 'perp' }; break; }
        }
      }
      // nearest scan point (respects the height section)
      if (!best && this.clouds?.views.size) {
        for (const v of this.clouds.views.values()) { const q = v.nearestPlan(p, thr * 0.8); if (q && (!best || dist(p, q) < dist(p, best.p))) best = { p: q, kind: 'pc' }; }
      }
      if (best) return best;
    }
    let q = p;
    if (base && s.ortho) {
      const dx = p[0] - base[0], dy = p[1] - base[1];
      q = Math.abs(dx) >= Math.abs(dy) ? [p[0], base[1]] : [base[0], p[1]];
    }
    if (s.snap) {
      const g = s.gridSize;
      if (base && s.ortho) {
        const dx = q[0] - base[0], dy = q[1] - base[1];
        q = Math.abs(dx) >= Math.abs(dy) ? [base[0] + Math.round(dx / g) * g, base[1]] : [base[0], base[1] + Math.round(dy / g) * g];
      } else q = [Math.round(q[0] / g) * g, Math.round(q[1] / g) * g];
    }
    return { p: q, kind: null };
  }

  // ======================= picking =======================
  pickEntity(p, filter = null) {
    const thr = 6 * this.px;
    const walls = this.wallMap();
    let best = null, bd = thr;
    const ents = this.visibleEntities();
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      if (filter && !filter(e)) continue;
      let d = Infinity;
      if (e.type === 'text') {
        const b = G.bboxOf(e, walls);
        d = p[0] >= b.min[0] - thr && p[0] <= b.max[0] + thr && p[1] >= b.min[1] - thr && p[1] <= b.max[1] + thr ? 0 : Infinity;
      } else if (e.type === 'point') d = dist(p, e.p);
      else if (e.type === 'dim') { const g = G.dimGeom(e); d = Math.min(G.distToCurve(p, { kind: 'line', a: g.d1, b: g.d2 }), dist(p, g.mid)); }
      else if (e.type === 'wall') {
        const poly = G.wallPolygon(e);
        d = pointInPoly(p, poly) ? 0 : Math.min(...G.curvesOf(e, walls).map((c) => G.distToCurve(p, c)));
        d += thr * 0.3; // let doors/windows on top win
      } else if (e.type === 'polyline' && e.closed && e.slab) {
        d = Math.min(...G.curvesOf(e).map((c) => G.distToCurve(p, c)));
      } else for (const c of G.curvesOf(e, walls)) d = Math.min(d, G.distToCurve(p, c));
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }

for (const M of [PlanEvents, PlanDraw, PlanPanels, PlanIO]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(PlanDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
