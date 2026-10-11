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

// ======================= commands =======================
// Each command is a small state machine: point(p), input(text), enter(), preview(cursor).
export function seqCommand(plan, { prompts, onDone, preview, chain = false, closeable = false, options = {}, minPts = 2 }) {
  const c = { pts: [] };
  c.base = () => c.pts[c.pts.length - 1] || null;
  c.promptText = () => {
    const i = Math.min(c.pts.length, prompts.length - 1);
    let t = typeof prompts[i] === 'function' ? prompts[i]() : prompts[i];
    const opts = Object.keys(options).filter((k) => !options[k].when || options[k].when(c));
    if (closeable && c.pts.length >= 2) opts.unshift('Close');
    if (chain && c.pts.length >= 2) opts.push('Undo');
    if (opts.length) t += ` [${opts.join('/')}]`;
    return t + ':';
  };
  c.point = (p) => {
    c.pts.push(p);
    const r = onDone(c, false);
    if (r === 'end') { plan.endCommand(); return; }
    plan.prompt(c.promptText());
  };
  c.input = (t) => {
    const u = t.toUpperCase();
    if (closeable && c.pts.length >= 2 && (u === 'C' || u === 'CLOSE')) { c.pts.push(c.pts[0]); onDone(c, 'close'); plan.endCommand(); return true; }
    if (chain && (u === 'U' || u === 'UNDO')) { c.undoStep(); return true; }
    for (const [name, o] of Object.entries(options)) {
      if (u === name.toUpperCase() || u === name[0].toUpperCase() || u === o.alias) { o.run(c); plan.prompt(c.promptText()); return true; }
    }
    return false;
  };
  c.undoStep = () => {
    if (!chain || !c.pts.length) return false;
    c.pts.pop();
    if (c.created?.length) { const id = c.created.pop(); plan.change(() => { plan.doc.entities = plan.doc.entities.filter((e) => e.id !== id); }); }
    plan.prompt(c.promptText());
    return true;
  };
  c.enter = () => { if (c.pts.length >= minPts || chain) onDone(c, 'enter'); plan.endCommand(); };
  c.preview = (cur) => preview?.(c, cur) || [];
  return c;
}

export function selectThen(plan, label, after) {
  // gather a selection first (or use the current one), then run `after`
  const c = {
    selecting: true, wantsPoint: true,
    base: () => null,
    promptText: () => `Select objects (${plan.sel.size} selected), Enter when done`,
    point: () => {}, enter: () => {
      if (!plan.sel.size) { plan.endCommand(); return; }
      const next = after();
      next.name = c.name;
      plan.cmd = next;
      next.start?.();
      if (plan.cmd === next) plan.prompt(next.promptText());
    },
  };
  if (plan.sel.size) return after();
  void label;
  return c;
}

export const COMMANDS = {
  LINE: (plan) => {
    const c = seqCommand(plan, {
      prompts: ['Specify first point', 'Specify next point'], chain: true, closeable: true,
      onDone: (c2, mode) => {
        if (mode && mode !== 'close') return;
        const n = c2.pts.length;
        if (n < 2) return;
        const a = c2.pts[n - 2], b = c2.pts[n - 1];
        if (dist(a, b) < 1e-9) { c2.pts.pop(); return; }
        let id;
        plan.change(() => { id = plan.addEntity({ type: 'line', a, b }).id; });
        (c2.created ||= []).push(id);
      },
      preview: (c2, cur) => (c2.pts.length && cur ? [{ type: 'line', a: c2.base(), b: cur }] : []),
    });
    return c;
  },
  PLINE: (plan) => seqCommand(plan, {
    prompts: ['Specify start point', 'Specify next point'], closeable: true, minPts: 2,
    onDone: (c, mode) => {
      if (!mode) return;
      let pts = c.pts;
      const closed = mode === 'close';
      if (closed) pts = pts.slice(0, -1);
      if (pts.length >= 2) plan.change(() => plan.addEntity({ type: 'polyline', pts, closed }));
    },
    preview: (c, cur) => (c.pts.length ? [{ type: 'polyline', pts: cur ? [...c.pts, cur] : c.pts, closed: false }] : []),
  }),
  RECTANG: (plan) => seqCommand(plan, {
    prompts: ['Specify first corner', 'Specify other corner (or @width,height)'],
    onDone: (c) => {
      if (c.pts.length < 2) return;
      const [a, b] = c.pts;
      plan.change(() => plan.addEntity({ type: 'polyline', pts: [a, [b[0], a[1]], b, [a[0], b[1]]], closed: true }));
      return 'end';
    },
    preview: (c, cur) => (c.pts.length && cur ? [{ type: 'polyline', pts: [c.pts[0], [cur[0], c.pts[0][1]], cur, [c.pts[0][0], cur[1]]], closed: true }] : []),
  }),
  CIRCLE: (plan) => {
    const c = seqCommand(plan, {
      prompts: ['Specify center point', 'Specify radius (or point)'],
      onDone: (c2) => { if (c2.pts.length < 2) return; const r = dist(c2.pts[0], c2.pts[1]); if (r > 0) plan.change(() => plan.addEntity({ type: 'circle', c: c2.pts[0], r })); return 'end'; },
      preview: (c2, cur) => (c2.pts.length && cur ? [{ type: 'circle', c: c2.pts[0], r: dist(c2.pts[0], cur) }] : []),
    });
    const inp = c.input;
    c.input = (t) => {
      const v = evalNumber(t);
      if (c.pts.length === 1 && v !== null && !t.includes(',')) { plan.change(() => plan.addEntity({ type: 'circle', c: c.pts[0], r: v })); plan.endCommand(); return true; }
      return inp(t);
    };
    return c;
  },
  ARC: (plan) => {
    const arcFrom = (a, m, b) => {
      const cc = circleFrom3(a, m, b);
      if (!cc) return null;
      const ccw = cross2(sub(m, a), sub(b, a)) < 0;
      const A0 = Math.atan2(a[1] - cc.c[1], a[0] - cc.c[0]), A1 = Math.atan2(b[1] - cc.c[1], b[0] - cc.c[0]);
      return { type: 'arc', c: cc.c, r: cc.r, a0: ccw ? A0 : A1, a1: ccw ? A1 : A0 };
    };
    return seqCommand(plan, {
      prompts: ['Specify start point', 'Specify second point', 'Specify end point'], minPts: 3,
      onDone: (c) => { if (c.pts.length < 3) return; const a = arcFrom(...c.pts); if (a) plan.change(() => plan.addEntity(a)); return 'end'; },
      preview: (c, cur) => (c.pts.length === 1 && cur ? [{ type: 'line', a: c.pts[0], b: cur }] : c.pts.length === 2 && cur ? [arcFrom(c.pts[0], c.pts[1], cur)].filter(Boolean) : []),
    });
  },
  TEXT: (plan) => {
    const c = { pts: [], stage: 0, base: () => null };
    c.promptText = () => (c.stage === 0 ? 'Specify start point of text' : c.stage === 1 ? `Specify height <${plan.S.textH}>` : c.stage === 2 ? 'Specify rotation angle <0>' : 'Enter text');
    c.point = (p) => {
      if (c.stage === 0) { c.p = p; c.stage = 1; }
      else if (c.stage === 1) { c.h = dist(c.p, p); c.stage = 2; }
      else if (c.stage === 2) { c.rot = Math.atan2(p[1] - c.p[1], p[0] - c.p[0]); c.stage = 3; }
      plan.prompt(c.promptText());
    };
    c.input = (t) => {
      if (c.stage === 1) { const v = evalNumber(t); if (v) { plan.S.textH = v; c.h = v; c.stage = 2; plan.prompt(c.promptText()); return true; } }
      if (c.stage === 2) { const v = evalNumber(t); if (v !== null) { c.rot = (v * Math.PI) / 180; c.stage = 3; plan.prompt(c.promptText()); return true; } }
      if (c.stage === 3) {
        plan.change(() => plan.addEntity({ type: 'text', p: c.p, h: c.h || plan.S.textH, rot: c.rot || 0, text: t }));
        c.p = [c.p[0], c.p[1] - (c.h || plan.S.textH) * 1.6]; // next line
        plan.prompt('Enter text (Enter to finish)');
        return true;
      }
      return false;
    };
    c.enter = () => {
      if (c.stage === 1) { c.h = plan.S.textH; c.stage = 2; plan.prompt(c.promptText()); return; }
      if (c.stage === 2) { c.rot = 0; c.stage = 3; plan.prompt(c.promptText()); return; }
      plan.endCommand();
    };
    c.preview = (cur) => (c.stage === 0 && cur ? [{ type: 'text', p: cur, h: plan.S.textH, text: 'Text' }] : []);
    return c;
  },
  DIMLINEAR: (plan) => dimCommand(plan, 'auto'),
  DIMALIGNED: (plan) => dimCommand(plan, 'aligned'),
  DIST: (plan) => seqCommand(plan, {
    prompts: ['Specify first point', 'Specify second point'],
    onDone: (c) => { if (c.pts.length < 2) return; const [a, b] = c.pts; plan.log(`Distance = ${fmt(dist(a, b), 4)},  Angle = ${fmt((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, 3)}°,  ΔX = ${fmt(b[0] - a[0], 4)},  ΔY = ${fmt(b[1] - a[1], 4)}`); return 'end'; },
    preview: (c, cur) => (c.pts.length && cur ? [{ type: 'rubber', a: c.pts[0], b: cur }] : []),
  }),
  WALL: (plan) => {
    const s = plan.S;
    const c = seqCommand(plan, {
      prompts: [() => `Specify wall start point (T=${s.wallT}, H=${s.wallH}, ${s.wallJ})`, 'Specify next point'], chain: true, closeable: true,
      options: {
        Thickness: { alias: 'T', run: async () => { const v = evalNumber(await promptText('Wall thickness (mm)', String(s.wallT))); if (v) s.wallT = v; plan.prompt(c.promptText()); } },
        Height: { alias: 'H', run: async () => { const v = evalNumber(await promptText('Wall height (mm)', String(s.wallH))); if (v) s.wallH = v; plan.prompt(c.promptText()); } },
        Justify: { alias: 'J', run: () => { s.wallJ = { center: 'left', left: 'right', right: 'center' }[s.wallJ]; } },
      },
      onDone: (c2, mode) => {
        if (mode && mode !== 'close') return;
        const n = c2.pts.length;
        if (n < 2) return;
        const a = c2.pts[n - 2], b = c2.pts[n - 1];
        if (dist(a, b) < 1e-6) { c2.pts.pop(); return; }
        let id;
        plan.change(() => { id = plan.addEntity({ type: 'wall', a, b, t: s.wallT, h: s.wallH, justify: s.wallJ }).id; });
        (c2.created ||= []).push(id);
      },
      preview: (c2, cur) => (c2.pts.length && cur && dist(c2.base(), cur) > 1e-6 ? [{ type: 'wall', a: c2.base(), b: cur, t: s.wallT, justify: s.wallJ }] : []),
    });
    return c;
  },
  DOOR: (plan) => openingCommand(plan, 'door'),
  WINDOW: (plan) => openingCommand(plan, 'window'),
  SLAB: (plan) => {
    const c = { selecting: true, base: () => null, promptText: () => 'Select a closed polyline (or rectangle) for the slab' };
    c.point = () => {};
    c.enter = () => plan.endCommand();
    const pick = () => {
      const ids = [...plan.sel].map((id) => plan.E(id)).filter((e) => e?.type === 'polyline' && e.closed);
      if (!ids.length) return false;
      plan.change(() => { for (const e of ids) { const live = plan.E(e.id); live.slab = live.slab || plan.S.slabT; if (plan.doc.layers.some((l) => l.name === 'Slabs')) live.layer = 'Slabs'; } });
      toast(`Slab applied to ${ids.length} outline(s)`, 'ok');
      plan.endCommand();
      return true;
    };
    c.start = () => { if (pick()) return; };
    // re-check after each pick
    const orig = plan.onUp.bind(plan);
    c.cancel = () => { plan.onUp = orig; };
    plan.onUp = (e) => { orig(e); if (plan.cmd === c) setTimeout(() => { if (pick()) plan.onUp = orig; }, 0); };
    return c;
  },
  ERASE: (plan) => selectThen(plan, 'erase', () => { plan.eraseSelection(); return { promptText: () => '', start: () => plan.endCommand(), enter: () => plan.endCommand(), point: () => {} }; }),
  EXPLODE: (plan) => selectThen(plan, 'explode', () => ({
    promptText: () => '', point: () => {}, enter: () => plan.endCommand(),
    start: () => {
      plan.change(() => {
        const add2 = [];
        for (const id of [...plan.sel]) {
          const e = plan.E(id);
          if (!e || !plan.editable(e)) continue;
          if (e.type === 'polyline') {
            const n = e.pts.length;
            for (let i = 0; i < (e.closed ? n : n - 1); i++) add2.push({ type: 'line', a: e.pts[i], b: e.pts[(i + 1) % n], layer: e.layer, color: e.color });
            plan.doc.entities = plan.doc.entities.filter((x) => x.id !== id);
          } else if (e.type === 'dim') {
            const g = G.dimGeom(e);
            add2.push({ type: 'line', a: e.a, b: g.d1, layer: e.layer }, { type: 'line', a: e.b, b: g.d2, layer: e.layer }, { type: 'line', a: g.d1, b: g.d2, layer: e.layer }, { type: 'text', p: g.mid, h: plan.S.dimTextH, text: fmt(g.value, 0), layer: e.layer });
            plan.doc.entities = plan.doc.entities.filter((x) => x.id !== id);
          }
        }
        plan.sel.clear();
        add2.forEach((x) => { if (!x.color) delete x.color; plan.addEntity(x); });
      });
      plan.endCommand();
    },
  })),
  MOVE: (plan) => selectThen(plan, 'move', () => xformCommand(plan, 'move')),
  COPY: (plan) => selectThen(plan, 'copy', () => xformCommand(plan, 'copy')),
  ROTATE: (plan) => selectThen(plan, 'rotate', () => xformCommand(plan, 'rotate')),
  SCALE: (plan) => selectThen(plan, 'scale', () => xformCommand(plan, 'scale')),
  MIRROR: (plan) => selectThen(plan, 'mirror', () => xformCommand(plan, 'mirror')),
  OFFSET: (plan) => {
    const c = { stage: 0, d: plan.lastOffset || 100, base: () => null, wantsPoint: true };
    c.promptText = () => (c.stage === 0 ? `Specify offset distance <${c.d}>` : c.stage === 1 ? 'Select object to offset' : 'Specify point on side to offset');
    c.input = (t) => { const v = evalNumber(t); if (c.stage === 0 && v > 0) { c.d = v; plan.lastOffset = v; c.stage = 1; plan.prompt(c.promptText()); return true; } return false; };
    c.enter = () => { if (c.stage === 0) { c.stage = 1; plan.prompt(c.promptText()); } else plan.endCommand(); };
    c.point = (p, info) => {
      if (c.stage === 0) { c.stage = 1; }
      else if (c.stage === 1) { const e = plan.pickEntity(info?.raw || p, (x) => ['line', 'circle', 'arc', 'polyline', 'wall'].includes(x.type)); if (e) { c.ent = e; c.stage = 2; } }
      else if (c.stage === 2) { const o = offsetEntity(c.ent, c.d, p); if (o) plan.change(() => { delete o.id; plan.addEntity(o); }); c.stage = 1; }
      plan.prompt(c.promptText());
    };
    c.preview = (cur) => (c.stage === 2 && cur ? [offsetEntity(c.ent, c.d, cur)].filter(Boolean) : []);
    return c;
  },
  TRIM: (plan) => {
    const c = { base: () => null, wantsPoint: true };
    c.promptText = () => 'Select object segment to trim';
    c.enter = () => plan.endCommand();
    c.point = (p, info) => { trimEntity(plan, info?.raw || p); plan.prompt(c.promptText()); };
    return c;
  },
  FILLET: (plan) => {
    const c = { stage: 0, r: plan.lastFillet || 0, base: () => null };
    c.promptText = () => (c.stage === 0 ? `Select first line [Radius=${c.r}]` : 'Select second line');
    c.input = (t) => { const u = t.toUpperCase(); if (u === 'R' || u === 'RADIUS') { promptText('Fillet radius', String(c.r)).then((v) => { const n = evalNumber(v); if (n !== null) { c.r = n; plan.lastFillet = n; } plan.prompt(c.promptText()); }); return true; } const v = evalNumber(t); if (v !== null) { c.r = v; plan.lastFillet = v; plan.prompt(c.promptText()); return true; } return false; };
    c.enter = () => plan.endCommand();
    c.point = (p, info) => {
      const e = plan.pickEntity(info?.raw || p, (x) => x.type === 'line');
      if (!e) return;
      if (c.stage === 0) { c.l1 = e; c.p1 = info?.raw || p; c.stage = 1; plan.prompt(c.promptText()); return; }
      if (e.id === c.l1.id) return;
      filletLines(plan, c.l1, c.p1, e, info?.raw || p, c.r);
      plan.endCommand();
    };
    return c;
  },
};

export function dimCommand(plan, mode) {
  return seqCommand(plan, {
    prompts: ['Specify first extension line origin', 'Specify second extension line origin', 'Specify dimension line location'], minPts: 3,
    onDone: (c) => {
      if (c.pts.length < 3) return;
      plan.change(() => plan.addEntity({ type: 'dim', a: c.pts[0], b: c.pts[1], p: c.pts[2], kind: kindFor(c.pts[0], c.pts[1], c.pts[2], mode) }));
      return 'end';
    },
    preview: (c, cur) => {
      if (c.pts.length === 1 && cur) return [{ type: 'rubber', a: c.pts[0], b: cur }];
      if (c.pts.length === 2 && cur) return [{ type: 'dim', a: c.pts[0], b: c.pts[1], p: cur, kind: kindFor(c.pts[0], c.pts[1], cur, mode) }];
      return [];
    },
  });
}
export function kindFor(a, b, p, mode) {
  if (mode === 'aligned') return 'aligned';
  const xmin = Math.min(a[0], b[0]), xmax = Math.max(a[0], b[0]), ymin = Math.min(a[1], b[1]), ymax = Math.max(a[1], b[1]);
  const inX = p[0] >= xmin && p[0] <= xmax, inY = p[1] >= ymin && p[1] <= ymax;
  if (inX && !inY) return 'h';
  if (inY && !inX) return 'v';
  return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'h' : 'v';
}

export function openingCommand(plan, type) {
  const s = plan.S;
  const c = { base: () => null, wantsPoint: true };
  const W = () => (type === 'door' ? s.doorW : s.winW);
  c.promptText = () => `Click on a wall to place the ${type} (width ${W()}) [Width]`;
  c.place = (p) => {
    const wall = plan.pickEntity(p, (e) => e.type === 'wall') || nearestWall(plan, p);
    if (!wall) return null;
    const f = G.wallFrame(wall);
    let pos = (p[0] - wall.a[0]) * f.u[0] + (p[1] - wall.a[1]) * f.u[1];
    const w = W();
    pos = Math.max(w / 2, Math.min(f.L - w / 2, pos));
    const side = (p[0] - wall.a[0]) * f.n[0] + (p[1] - wall.a[1]) * f.n[1] >= (f.o1 + f.o2) / 2 ? 1 : -1;
    const along = (p[0] - wall.a[0]) * f.u[0] + (p[1] - wall.a[1]) * f.u[1];
    const o = type === 'door' ? { type, wall: wall.id, pos, w, h: s.doorH, side, hinge: along < pos ? 1 : -1 } : { type, wall: wall.id, pos, w, h: s.winH, sill: s.winSill };
    return o;
  };
  c.point = (p, info) => {
    const o = c.place(info?.raw || p);
    if (!o) { toast('Click on a wall'); return; }
    plan.change(() => plan.addEntity(o));
  };
  c.input = (t) => {
    const u = t.toUpperCase();
    if (u === 'W' || u === 'WIDTH') { promptText(`${type} width (mm)`, String(W())).then((v) => { const n = evalNumber(v); if (n) { if (type === 'door') s.doorW = n; else s.winW = n; } plan.prompt(c.promptText()); }); return true; }
    const n = evalNumber(t);
    if (n) { if (type === 'door') s.doorW = n; else s.winW = n; plan.prompt(c.promptText()); return true; }
    return false;
  };
  c.enter = () => plan.endCommand();
  c.preview = () => { const m = plan.mouse?.p; if (!m) return []; const o = c.place(m); return o ? [o] : []; };
  return c;
}
export function nearestWall(plan, p) {
  let best = null, bd = 30 * plan.px;
  for (const w of plan.doc.entities) if (w.type === 'wall') { const d = G.distToCurve(p, { kind: 'line', a: w.a, b: w.b }); if (d < bd + (w.t || 200) / 2) { bd = d; best = w; } }
  return best;
}

export function xformCommand(plan, kind) {
  const ids = [...plan.sel];
  const ents = () => ids.map((id) => plan.E(id)).filter(Boolean);
  const c = { pts: [], base: () => c.pts[0] || null };
  const P = {
    move: ['Specify base point', 'Specify second point (or @dx,dy)'],
    copy: ['Specify base point', 'Specify second point (Enter to finish)'],
    rotate: ['Specify base point', 'Specify rotation angle (degrees) or point'],
    scale: ['Specify base point', 'Specify scale factor or point'],
    mirror: ['Specify first point of mirror line', 'Specify second point of mirror line'],
  }[kind];
  c.promptText = () => P[Math.min(c.pts.length, 1)];
  const fnFor = (cur, val = null) => {
    const b = c.pts[0];
    if (kind === 'move' || kind === 'copy') { const d = sub(cur, b); return { fn: (p) => add(p, d) }; }
    if (kind === 'rotate') { const a = val !== null ? (val * Math.PI) / 180 : Math.atan2(cur[1] - b[1], cur[0] - b[0]); return { fn: (p) => G.rot(p, b, a), opts: { angle: a } }; }
    if (kind === 'scale') { const s = val !== null ? val : dist(b, cur) / (plan.S.gridSize * 10); return { fn: (p) => add(b, mul(sub(p, b), s)), opts: { scale: s } }; }
    if (kind === 'mirror') return { fn: (p) => G.mirrorPt(p, b, cur), opts: { mirror: true } };
    return null;
  };
  const apply = (t) => {
    plan.change(() => {
      for (const e of ents()) {
        if (!plan.editable(e)) continue;
        const ne = G.transformEntity(e, t.fn, t.opts);
        if (kind === 'copy' || kind === 'mirror') {
          delete ne.id;
          if (ne.type === 'door' || ne.type === 'window') continue;
          const nn = plan.addEntity(ne);
          // copy openings along with their walls
          if (e.type === 'wall') for (const o of plan.doc.entities.filter((x) => (x.type === 'door' || x.type === 'window') && x.wall === e.id)) { const oc = structuredClone(o); delete oc.id; oc.wall = nn.id; if (kind === 'mirror') oc.side = -(oc.side ?? 1); plan.addEntity(oc); }
        } else Object.assign(plan.E(e.id), ne);
      }
    });
  };
  c.point = (p) => {
    c.pts.push(p);
    if (c.pts.length === 2) {
      apply(fnFor(p));
      if (kind === 'copy') { c.pts.pop(); plan.prompt(c.promptText()); return; }
      plan.endCommand();
      return;
    }
    plan.prompt(c.promptText());
  };
  c.input = (t) => {
    if (c.pts.length === 1 && (kind === 'rotate' || kind === 'scale')) {
      const v = evalNumber(t);
      if (v !== null) { apply(fnFor(null, v)); plan.endCommand(); return true; }
    }
    return false;
  };
  c.enter = () => plan.endCommand();
  c.preview = (cur) => {
    if (!c.pts.length || !cur) return [];
    const t = fnFor(cur);
    const pv = ents().filter((e) => e.type !== 'door' && e.type !== 'window').map((e) => G.transformEntity(e, t.fn, t.opts));
    return [{ type: 'rubber', a: c.pts[0], b: cur }, ...pv];
  };
  return c;
}

export function offsetEntity(e, d, side) {
  const o = structuredClone(e);
  if (e.type === 'line' || e.type === 'wall') {
    const L = dist(e.a, e.b) || 1; const n = [-(e.b[1] - e.a[1]) / L, (e.b[0] - e.a[0]) / L];
    const s = Math.sign((side[0] - e.a[0]) * n[0] + (side[1] - e.a[1]) * n[1]) || 1;
    o.a = add(e.a, mul(n, d * s)); o.b = add(e.b, mul(n, d * s));
    return o;
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const s = dist(side, e.c) > e.r ? 1 : -1;
    o.r = e.r + s * d;
    return o.r > 0 ? o : null;
  }
  if (e.type === 'polyline') {
    const pts = e.pts, n = pts.length;
    const segs = [];
    // decide side using the nearest segment
    let best = 0, bd = Infinity;
    for (let i = 0; i < (e.closed ? n : n - 1); i++) { const dd = G.distToCurve(side, { kind: 'line', a: pts[i], b: pts[(i + 1) % n] }); if (dd < bd) { bd = dd; best = i; } }
    const a0 = pts[best], b0 = pts[(best + 1) % n];
    const L0 = dist(a0, b0) || 1; const n0 = [-(b0[1] - a0[1]) / L0, (b0[0] - a0[0]) / L0];
    const s = Math.sign((side[0] - a0[0]) * n0[0] + (side[1] - a0[1]) * n0[1]) || 1;
    for (let i = 0; i < (e.closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n]; const L = dist(a, b) || 1; const nn = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      segs.push([add(a, mul(nn, d * s)), add(b, mul(nn, d * s))]);
    }
    const out = [];
    const m = segs.length;
    for (let i = 0; i < m; i++) {
      if (!e.closed && i === 0) { out.push(segs[0][0]); continue; }
      const prev = segs[(i - 1 + m) % m], cur = segs[i];
      const X = lineIntersect(prev[0], prev[1], cur[0], cur[1]);
      out.push(X || cur[0]);
    }
    if (!e.closed) out.push(segs[m - 1][1]);
    o.pts = out;
    return o;
  }
  return null;
}
export function lineIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return add(a, mul(r, t));
}

export function trimEntity(plan, p) {
  const e = plan.pickEntity(p, (x) => ['line', 'circle', 'arc'].includes(x.type));
  if (!e) { const pl = plan.pickEntity(p, (x) => x.type === 'polyline'); if (pl) toast('Explode the polyline (X) before trimming it'); return; }
  const walls = plan.wallMap();
  const cur = G.curvesOf(e)[0];
  const cutters = [];
  for (const o of plan.visibleEntities()) if (o.id !== e.id) for (const c of G.curvesOf(o, walls)) cutters.push(c);
  const ints = cutters.flatMap((c) => G.intersect(cur, c));
  const param = (q) => (cur.kind === 'line' ? G.projectOnSegment(q, cur.a, cur.b).t : cur.kind === 'circle' ? G.normAng(Math.atan2(q[1] - cur.c[1], q[0] - cur.c[0])) : G.normAng(Math.atan2(q[1] - cur.c[1], q[0] - cur.c[0]) - cur.a0));
  const end = cur.kind === 'line' ? 1 : cur.kind === 'arc' ? G.normAng(cur.a1 - cur.a0) || G.TAU : G.TAU;
  const ts = [...new Set(ints.map(param).filter((t) => t > 1e-9 && t < end - 1e-9).map((t) => +t.toFixed(10)))].sort((a, b) => a - b);
  const tc = param(p);
  plan.change(() => {
    const live = plan.E(e.id);
    if (cur.kind === 'circle') {
      if (ts.length < 2) { plan.doc.entities = plan.doc.entities.filter((x) => x.id !== e.id); return; }
      let lo = ts[ts.length - 1], hi = ts[0];
      for (let i = 0; i < ts.length - 1; i++) if (tc >= ts[i] && tc <= ts[i + 1]) { lo = ts[i]; hi = ts[i + 1]; }
      Object.assign(live, { type: 'arc', a0: hi, a1: lo });
      return;
    }
    let lo = null, hi = null;
    for (const t of ts) { if (t < tc) lo = t; else if (hi === null) hi = t; }
    if (lo === null && hi === null) { plan.doc.entities = plan.doc.entities.filter((x) => x.id !== e.id); return; }
    if (cur.kind === 'line') {
      const P = (t) => lerp(cur.a, cur.b, t);
      if (lo === null) live.a = P(hi);
      else if (hi === null) live.b = P(lo);
      else { const b0 = live.b; live.b = P(lo); const n = structuredClone(live); delete n.id; n.a = P(hi); n.b = b0; plan.addEntity(n); }
    } else {
      const A = (t) => cur.a0 + t;
      if (lo === null) live.a0 = A(hi);
      else if (hi === null) live.a1 = A(lo);
      else { const a1 = live.a1; live.a1 = A(lo); const n = structuredClone(live); delete n.id; n.a0 = A(hi); n.a1 = a1; plan.addEntity(n); }
    }
  });
}

export function filletLines(plan, l1, p1, l2, p2, r) {
  const X = lineIntersect(l1.a, l1.b, l2.a, l2.b);
  if (!X) { toast('Lines are parallel'); return; }
  // keep the side of each line that was clicked
  const keep = (l, p) => (dist(l.a, X) < 1e-9 ? 'b' : dist(l.b, X) < 1e-9 ? 'a' : ((p[0] - X[0]) * (l.a[0] - X[0]) + (p[1] - X[1]) * (l.a[1] - X[1]) > 0 ? 'a' : 'b'));
  const k1 = keep(l1, p1), k2 = keep(l2, p2);
  plan.change(() => {
    const A = plan.E(l1.id), B = plan.E(l2.id);
    const far1 = A[k1], far2 = B[k2];
    const u1 = sub(far1, X), u2 = sub(far2, X);
    const n1 = Math.hypot(...u1), n2 = Math.hypot(...u2);
    const d1 = [u1[0] / n1, u1[1] / n1], d2 = [u2[0] / n2, u2[1] / n2];
    if (r <= 0) { A[k1 === 'a' ? 'b' : 'a'] = X; B[k2 === 'a' ? 'b' : 'a'] = X; return; }
    const half = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]))) / 2;
    const t = r / Math.tan(half);
    if (t > n1 || t > n2) { toast('Radius too large'); return; }
    const t1 = add(X, mul(d1, t)), t2 = add(X, mul(d2, t));
    const bis = [d1[0] + d2[0], d1[1] + d2[1]]; const bl = Math.hypot(...bis);
    const C = add(X, mul([bis[0] / bl, bis[1] / bl], r / Math.sin(half)));
    A[k1 === 'a' ? 'b' : 'a'] = t1; B[k2 === 'a' ? 'b' : 'a'] = t2;
    let a0 = Math.atan2(t1[1] - C[1], t1[0] - C[0]), a1 = Math.atan2(t2[1] - C[1], t2[0] - C[0]);
    if (G.normAng(a1 - a0) > Math.PI) [a0, a1] = [a1, a0];
    plan.addEntity({ type: 'arc', c: C, r, a0, a1, layer: A.layer });
  });
}

// mix in methods split off into separate files
for (const M of [PlanEvents, PlanDraw, PlanPanels, PlanIO]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(PlanDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
