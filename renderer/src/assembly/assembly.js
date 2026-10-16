// Assembly document: SolidWorks/Inventor-style assemblies. Parts (.lithprt) are
// inserted as components, positioned with mates (coincident, concentric,
// distance, angle, parallel, perpendicular, tangent, lock) solved by
// shared/mates.mjs, and can be dragged within their remaining freedom.
import { cachedMesh } from '../meshcache.js';
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { ViewSet } from '../viewset.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import * as M from '../../../shared/mates.mjs';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { AsmCommands } from './commands.js';
import { AsmPicking } from './picking.js';
import { AsmTree } from './tree.js';
// cache key of a component: file path, or 'lib:DIN933:M8:25' for library fasteners
export const compKey = (c) => (c.lib ? `lib:${c.lib.std}:${c.lib.size}:${c.lib.L || 0}` : c.path);
export const libText = (lib) => JSON.stringify(fastenerPart(lib.std, lib.size, lib.L));

export function newAssemblyDoc(name = 'Assembly1') {
  return { kind: 'assembly', version: 1, name, units: 'mm', components: [], mates: [], next: 1 };
}

export const COLORS = { edge: 0x111111, hover: 0xff9a1a, sel: 0x1e90ff };
export const PALETTE = [0xcfd6df, 0xd8cfbf, 0xc4d6c8, 0xd6c6d2, 0xc6d0e0, 0xe0d6c0, 0xc8dcdc];
export const IDENT = [0, 0, 0, 1];

// ---------- part cache (shared by all assembly tabs) ----------
export const partCache = new Map(); // path -> Promise<{data, mesh, geom, err}>
export const partVersion = new Map(); // path -> save counter
export function partSaved(path) { partVersion.set(path, (partVersion.get(path) || 0) + 1); partCache.delete(path); }
const IDENT_M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// three.js geometry + lookup tables for a kernel mesh
function meshGeometry(mesh) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  const faceOfTri = new Int32Array(mesh.indices.length / 3);
  for (const fc of mesh.faces) for (let t = fc.start / 3; t < (fc.start + fc.count) / 3; t++) faceOfTri[t] = fc.id;
  const segs = [];
  for (const e of mesh.edges) { const p = e.pts; for (let i = 3; i < p.length; i += 3) segs.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]); }
  const egeom = new THREE.BufferGeometry();
  egeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
  return { geom, egeom, faceOfTri };
}

// ---------- subassemblies: an assembly inserted into another assembly ----------
// Its components (at their saved positions) are merged into one mesh, so it behaves like one rigid part:
// it can be mated and dragged as a whole. Face/edge ids are offset per component to stay unique.
const ID_STEP = 100000;
const PT_KEYS = new Set(['c', 'origin', 'p', 'mid']), DIR_KEYS = new Set(['normal', 'xDir', 'd', 'n']);
function xfObj(o, m4, n3) {
  if (Array.isArray(o) || !o || typeof o !== 'object') return o;
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && (PT_KEYS.has(k) || DIR_KEYS.has(k))) {
      const t = new THREE.Vector3(...v);
      if (PT_KEYS.has(k)) t.applyMatrix4(m4); else t.applyMatrix3(n3).normalize();
      r[k] = [t.x, t.y, t.z];
    } else r[k] = v && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v) ? xfObj(v, m4, n3) : v;
  }
  return r;
}
async function resolveCompPath(asmPath, c) {
  const cands = [];
  const lith = (p) => p.replace(/\.ekprt$/i, '.lithprt').replace(/\.ekasm$/i, '.lithasm');
  cands.push(lith(c.path), c.path);
  const dir = asmPath?.replace(/[\\/][^\\/]*$/, '');
  if (dir) { const b = c.path.split(/[\\/]/).pop(); const sep = asmPath.includes('\\') ? '\\' : '/'; cands.push(lith(dir + sep + b), dir + sep + b); }
  for (const p of cands) if (await api.fileExists(p).catch(() => false)) return p;
  return c.path;
}
async function loadSubassembly(path, data, stack) {
  const st = [...stack, (path || '').toLowerCase()];
  const pos = [], idx = [], faces = [], edges = [], flat = [];
  let k = 0;
  for (const c of data.components || []) {
    if (c.hidden) continue;
    const cp = c.lib ? compKey(c) : await resolveCompPath(path, c);
    const sub = await loadPart(cp, c.lib ? libText(c.lib) : null, st);
    k++;
    if (sub.err) continue;
    const pm = M.poseMatrix(c), m4 = new THREE.Matrix4().fromArray(pm), n3 = new THREE.Matrix3().getNormalMatrix(m4);
    const mesh = sub.mesh, v0 = pos.length / 3, i0 = idx.length, off = k * ID_STEP, t = new THREE.Vector3();
    for (let i = 0; i < mesh.positions.length; i += 3) { t.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]).applyMatrix4(m4); pos.push(t.x, t.y, t.z); }
    for (let i = 0; i < mesh.indices.length; i++) idx.push(mesh.indices[i] + v0);
    for (const f of mesh.faces) faces.push({ ...xfObj(f, m4, n3), id: f.id + off, start: f.start + i0, comp: c.name });
    for (const e of mesh.edges) {
      const p = new Float32Array(e.pts.length);
      for (let i = 0; i < p.length; i += 3) { t.set(e.pts[i], e.pts[i + 1], e.pts[i + 2]).applyMatrix4(m4); p[i] = t.x; p[i + 1] = t.y; p[i + 2] = t.z; }
      edges.push({ ...xfObj(e, m4, n3), id: e.id + off, pts: p });
    }
    for (const fp of sub.flat || []) flat.push({ ...fp, m: new THREE.Matrix4().fromArray(pm).multiply(new THREE.Matrix4().fromArray(fp.m)).toArray() });
  }
  if (!pos.length) throw new Error('Subassembly has no parts');
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx), faces, edges };
  const r = { data, mesh, ...meshGeometry(mesh), flat, isAssembly: true, ver: partVersion.get(path) || 0 };
  const bb = r.geom.boundingBox; mesh.bbox = { min: bb.min.toArray(), max: bb.max.toArray() };
  return r;
}

export function loadPart(path, text = null, stack = []) {
  if (path && stack.includes(path.toLowerCase())) return Promise.resolve({ err: 'Assembly cannot contain itself' });
  if (partCache.has(path)) return partCache.get(path);
  const pr = (async () => {
    try {
      const f = text != null ? { text } : await api.readFile(path);
      const data = JSON.parse(f.text);
      if (data.kind === 'assembly') return await loadSubassembly(path, data, stack);
      if (data.kind !== 'part') throw new Error('Not a part document');
      // use the finished mesh saved in the file when it is up to date; otherwise rebuild
      const mesh = cachedMesh(data) || (await api.kernel('regen', { features: data.features, upTo: data.rollback ?? undefined, parallel: true })).mesh;
      if (!mesh?.positions?.length) throw new Error('Part has no solid body');
      return { data, mesh, ...meshGeometry(mesh), flat: [{ features: data.features, upTo: data.rollback ?? undefined, m: IDENT_M }], ver: partVersion.get(path) || 0 };
    } catch (e) {
      return { err: e.message || String(e) };
    }
  })();
  partCache.set(path, pr);
  return pr;
}

// geometric entity (component-local) of a picked face/edge, or null if it cannot be mated
export function circle3(pts) {
  const n = pts.length / 3;
  if (n < 3) return null;
  const P = (i) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const a = P(0), b = P(Math.floor(n / 3)), c = P(Math.floor((2 * n) / 3));
  const nz = M.unit(M.cross(M.sub(b, a), M.sub(c, a)));
  if (!isFinite(nz[0]) || M.len(M.cross(M.sub(b, a), M.sub(c, a))) < 1e-12) return null;
  const ux = M.unit(M.sub(b, a)), uy = M.cross(nz, ux);
  const Lc = (p) => { const d = M.sub(p, a); return [M.dot(d, ux), M.dot(d, uy)]; };
  const cc = circleFrom3(Lc(a), Lc(b), Lc(c));
  if (!cc) return null;
  return { c: M.add(a, M.add(M.mulv(ux, cc.c[0]), M.mulv(uy, cc.c[1]))), r: cc.r, n: nz };
}
export function entityGeo(mesh, kind, id) {
  if (kind === 'face') {
    const f = mesh.faces.find((x) => x.id === id);
    if (!f) return null;
    if (f.type === 'plane' && f.plane) return { t: 'plane', p: f.c, n: f.plane.normal };
    if (f.type === 'cylinder' && f.axis) return { t: 'axis', p: f.axis.p, d: f.axis.d, r: f.r };
    return null;
  }
  const e = mesh.edges.find((x) => x.id === id);
  if (!e) return null;
  const p = e.pts;
  if (e.type === 'circle') { const c = circle3(p); return c ? { t: 'circle', p: c.c, d: c.n, r: c.r } : null; }
  if (e.type === 'line' && p.length >= 6) return { t: 'axis', p: [p[0], p[1], p[2]], d: M.unit([p[p.length - 3] - p[0], p[p.length - 2] - p[1], p[p.length - 1] - p[2]]) };
  return null;
}
export const geoName = (g) => (!g ? '' : g.t === 'plane' ? 'Plane' : g.t === 'circle' ? 'Circular edge' : g.r ? 'Cylinder' : 'Line');

export class AssemblyDoc {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    doc.components ||= []; doc.mates ||= [];
    this.sel = [];
    this.hover = null;
    this.undoStack = [];
    this.redoStack = [];
    this.displayMode = 'shadedEdges';
    this.views = new Map(); // comp id -> {group, part}
    this.dof = new Map();
    this.expanded = new Set(['mates']);
  }
  get title() { return this.doc.name; }
  C(id) { return this.doc.components.find((c) => c.id === id); }
  newId(p) { this.doc.next = (this.doc.next || 1) + 1; return p + this.doc.next; }

  // ======================= setup =======================
  init() {
    const app = this.app;
    this.viewSet = new ViewSet(app.el.views, { mode: '3d' }); // Viewport menu: 1, 2 or 4 panes
    this.viewport = this.vp = this.viewSet.proxy;
    this.vp.onContextMenu = (e) => this.viewContextMenu(e);
    this.scene = this.vp.scene;
    this.compGroup = new THREE.Group(); this.scene.add(this.compGroup);
    this.syncGrid();
    this.buildCommands();
    this.buildHeadsUp();
    this.bindViewport();
    this.vp.setView('iso', false);
    this.vp.fit({ min: [-60, -60, -60], max: [60, 60, 60] }, false);
    app.setStatusRight('MMGS');
    this.renderTree();
    this.reloadAll(false).then(() => { if (!(this.doc.viewLayout && this.viewSet.restore(this.doc.viewLayout))) this.zoomFit(); });
  }

  buildCommands() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const idle = () => !this.app.pm.open;
    const groups = [
      [C('insert', 'Insert Component', 'insertComp', () => this.cmdInsert(), { enabled: idle, tip: 'Insert a saved part (.lithprt) or assembly (.lithasm, as subassembly)' }),
        C('toolbox', 'Toolbox', 'bolt', () => this.cmdToolbox(), { enabled: idle, active: () => this.pmKind === 'toolbox', tip: 'Insert standard DIN bolts, screws, nuts and washers' }),
        C('mate', 'Mate', 'mate', () => this.cmdMate(), { enabled: idle, active: () => this.pmKind === 'mate', tip: 'Mate two faces or edges of different components' })],
      [C('fixc', 'Fix / Float', 'fix', () => this.toggleFixSelected(), { enabled: idle, tip: 'Fix the selected component in place, or let it float' }),
        C('hidec', 'Hide / Show', 'eye', () => this.toggleHideSelected(), { enabled: idle })],
      [C('section', 'Section View', 'section', () => toggleSection(this), { active: () => !!this.vp?.section, tip: 'Cut the view with a plane to see inside parts' })],
      [C('rebuild', 'Rebuild', 'history', () => this.reloadAll(true), { enabled: idle, tip: 'Reload all parts from disk and re-solve mates (Ctrl+B)' })],
    ];
    const evaluate = [
      [C('measure', 'Measure', 'measure', () => this.cmdMeasure(), { enabled: idle, active: () => this.pmKind === 'measure', tip: 'Measure edges, faces and distances between them (also across components)' })],
      [C('expStep', 'Export STEP', 'step', () => this.exportCAD('step'), { enabled: idle }),
        C('expIges', 'Export IGES', 'export', () => this.exportCAD('iges'), { enabled: idle })],
    ];
    this.app.cm.setTabs([{ name: 'Assembly', groups }, { name: 'Evaluate', groups: evaluate }], 'Assembly');
  }

  buildHeadsUp() {
    const bar = this.app.el.headsUp;
    bar.innerHTML = '';
    const B = (ic, tip, run) => h('button', { class: 'hu-btn', title: tip, html: icon(ic), onclick: run });
    const viewsMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'trimetric'].map((v, i) => ({ label: v[0].toUpperCase() + v.slice(1).replace('iso', 'Isometric'), key: i < 7 ? `Ctrl+${i + 1}` : undefined, run: () => this.vp.setView(v) })));
    };
    const dispMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Shaded With Edges', icon: 'shaded', run: () => this.setDisplay('shadedEdges') },
        { label: 'Shaded', icon: 'shaded', run: () => this.setDisplay('shaded') },
        { label: 'Wireframe', icon: 'wire', run: () => this.setDisplay('wire') },
      ]);
    };
    bar.append(B('zoomFit', 'Zoom to Fit (F)', () => this.zoomFit()), B('views', 'View Orientation', viewsMenu), B('shaded', 'Display Style', dispMenu), B('section', 'Section View', () => toggleSection(this)));
  }
  get gridOn() { return this.doc.grid ?? this.app.gridDefault?.() ?? true; }
  syncGrid() { const g = this.vp.grid; g.on = this.gridOn; g.frame = null; this.vp.requestRender(); }
  toggleGrid() { this.doc.grid = !this.gridOn; this.syncGrid(); this.app.setStatus(`Grid ${this.doc.grid ? 'on' : 'off'} in this document (Viewport menu: default for all)`); this.app.syncViewportMenu?.(); }

  // Viewport menu: layout of 1, 2 or 4 panes (saved in the file with each pane's view)
  setViewLayout(name) { this.viewSet.setLayout(name, { fit: () => this.zoomFit() }); this.app.setStatus(name === 'single' ? 'Single view' : 'Click in a view to make it the active one (blue border); commands like Zoom to Fit and the standard views act on it'); }
  resetViews() { this.viewSet.resetViews(() => this.zoomFit()); }
  beforeSave() { const s = this.viewSet.toJSON(); if (s.layout === 'single') delete this.doc.viewLayout; else this.doc.viewLayout = s; }
  setDisplay(m) { this.displayMode = m; for (const v of this.views.values()) v.group.parent?.remove(v.group); this.views.clear(); this.syncScene(); }

  // ======================= loading & scene =======================
  async reloadAll(fromDisk) {
    if (fromDisk) for (const c of this.doc.components) partCache.delete(compKey(c));
    this.app.setBusy(true);
    try {
      const n = this.doc.components.length; let done = 0;
      const tick = () => { if (n > 1) this.app.setStatus(`Loading parts ${done}/${n}...`); };
      tick();
      await Promise.all(this.doc.components.map((c) => this.loadComp(c).finally(() => { done++; tick(); })));
      if (n > 1 && !fromDisk) this.app.setStatus('Ready');
      this.rematchAll();
      this.solve();
      if (fromDisk) this.app.setStatus('Rebuilt: parts reloaded and mates solved');
    } finally { this.app.setBusy(false); }
  }
  async loadComp(c, text = null) {
    if (c.lib) text = libText(c.lib);
    // component still points at an old .ekprt: use the .lithprt saved next to it (has the stored shape)
    if (!text && /\.ekprt$/i.test(c.path || '')) {
      const np = c.path.replace(/\.ekprt$/i, '.lithprt');
      if (await api.fileExists(np).catch(() => false)) { c.path = np; this.app.setDirty?.(true); }
    }
    const own = this.app.path ? [this.app.path.toLowerCase()] : [];
    let part = await loadPart(compKey(c), text, own);
    if (part.err && !text) {
      // file moved together with the assembly: look next to it
      const dir = this.app.path?.replace(/[\\/][^\\/]*$/, '');
      const alt = dir ? dir + (this.app.path.includes('\\') ? '\\' : '/') + c.path.split(/[\\/]/).pop() : null;
      if (alt && alt !== c.path && (await api.fileExists(alt).catch(() => false))) { c.path = alt; part = await loadPart(alt); }
    }
    this.views.get(c.id)?.group.parent?.remove(this.views.get(c.id).group);
    this.views.delete(c.id);
    c._part = part;
    this.syncScene();
    return part;
  }
  partOf(c) { return c._part && !c._part.err ? c._part : null; }
  // after a part changed: re-find mate faces/edges by type and position
  rematchAll() {
    for (const m of this.doc.mates) for (const r of [m.a, m.b, m.a2, m.b2].filter(Boolean)) {
      const part = this.partOf(this.C(r.comp) || {});
      if (!part) continue;
      const cur = entityGeo(part.mesh, r.kind, r.id);
      const ent = r.kind === 'face' ? part.mesh.faces.find((f) => f.id === r.id) : part.mesh.edges.find((e) => e.id === r.id);
      const ok = cur && ent && cur.t === r.geo.t && M.len(M.sub(ent.c || ent.mid, r.c)) < 1e-6;
      if (ok) { r.geo = cur; continue; }
      let best = null, bd = Infinity;
      const list = r.kind === 'face' ? part.mesh.faces : part.mesh.edges;
      for (const it of list) {
        const g = entityGeo(part.mesh, r.kind, it.id);
        if (!g || g.t !== r.geo.t) continue;
        const dirA = g.n || g.d, dirB = r.geo.n || r.geo.d;
        const d = M.len(M.sub(it.c || it.mid, r.c)) + 50 * (1 - Math.abs(M.dot(dirA, dirB)));
        if (d < bd) { bd = d; best = { it, g }; }
      }
      if (best) { r.id = best.it.id; r.c = best.it.c || best.it.mid; r.geo = best.g; }
    }
  }
  syncScene() {
    const ids = new Set(this.doc.components.map((c) => c.id));
    for (const [id, v] of this.views) if (!ids.has(id)) { this.compGroup.remove(v.group); this.views.delete(id); }
    this.doc.components.forEach((c, i) => {
      const part = this.partOf(c);
      let v = this.views.get(c.id);
      if (!v && part) {
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        const wire = this.displayMode === 'wire';
        const mat = new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], metalness: 0.18, roughness: 0.42, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: wire, opacity: wire ? 0 : 1, depthWrite: !wire });
        const mesh = new THREE.Mesh(part.geom, mat);
        mesh.userData.comp = c.id;
        group.add(mesh);
        if (this.displayMode !== 'shaded') group.add(new THREE.LineSegments(part.egeom, new THREE.LineBasicMaterial({ color: COLORS.edge, depthTest: !wire })));
        const hl = new THREE.Group(); group.add(hl);
        this.compGroup.add(group);
        v = { group, mesh, hl, part };
        this.views.set(c.id, v);
      }
      if (!v) return;
      v.group.matrix.fromArray(M.poseMatrix(c));
      v.group.matrixWorldNeedsUpdate = true;
      v.group.visible = !c.hidden;
    });
    this.updateHighlights();
  }
  updatePoses() {
    for (const c of this.doc.components) { const v = this.views.get(c.id); if (v) { v.group.matrix.fromArray(M.poseMatrix(c)); v.group.matrixWorldNeedsUpdate = true; } }
    this.vp.requestRender();
  }
  assemblyBox() {
    const box = new THREE.Box3();
    for (const c of this.doc.components) {
      const v = this.views.get(c.id);
      if (!v || c.hidden) continue;
      v.group.updateMatrixWorld(true);
      box.union(v.part.geom.boundingBox.clone().applyMatrix4(v.group.matrixWorld));
    }
    return box;
  }
  zoomFit() {
    const b = this.assemblyBox();
    if (b.isEmpty()) b.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    this.vp.fit(b);
  }

  // ======================= solving =======================
  solve(extra = null, opts = {}) {
    const mates = extra ? [...this.doc.mates.filter((m) => m.id !== extra.id), extra] : this.doc.mates;
    const res = M.solveMates(this.doc.components, mates, opts);
    const byId = new Map(this.doc.components.map((c) => [c.id, c]));
    this.mateErr = new Map();
    for (const m of mates) {
      if (m.suppressed) continue;
      const e = M.mateError(m, byId);
      if (!(e < 1e-3)) this.mateErr.set(m.id, e === Infinity ? 'These entities cannot be used for this mate type' : 'This mate cannot be satisfied (conflicts with other mates)');
    }
    this.updatePoses();
    if (!opts.drag) { this.updateDOF(mates); this.renderTree(); }
    return res;
  }
  updateDOF(mates = this.doc.mates) {
    this.dof = M.analyzeDOF(this.doc.components, mates.filter((m) => !this.mateErr?.has(m.id)));
    const n = this.doc.components.length;
    if (!n) { this.app.setStatus('Insert a component to start the assembly'); return; }
    const under = [...this.dof.values()].filter((d) => d.state === 'under').length;
    const err = this.mateErr?.size;
    this.app.setStatus(err ? `${err} mate error(s)` : under ? `Under defined: ${under} of ${n} component(s) can still move` : 'Fully defined', err ? 'error' : '');
  }

  // ======================= history =======================
  snapshot() { return JSON.stringify(this.doc, (k, v) => (k.startsWith('_') ? undefined : v)); }
  commit() {
    this.undoStack.push(this._last ?? this.snapshot());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this._last = null;
    this.app.setDirty(true);
  }
  beginChange() { this._last = this.snapshot(); }
  undo() { if (this.app.pm.open || !this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); }
  restore(json) {
    const parts = new Map(this.doc.components.map((c) => [c.id, c._part]));
    this.doc = JSON.parse(json);
    for (const c of this.doc.components) c._part = parts.get(c.id);
    this.app.setDirty(true);
    this.sel = [];
    Promise.all(this.doc.components.filter((c) => !c._part).map((c) => this.loadComp(c))).then(() => { this.syncScene(); this.solve(); });
    this.syncScene(); this.solve();
  }
  // JSON written to disk (no cached runtime data)
  toJSON() { return JSON.parse(this.snapshot()); }

  // ======================= commands =======================
  async cmdInsert() {
    const open = this.app.root.tabs.filter((t) => t !== this.app && (t.doc?.doc.kind === 'part' || t.doc?.doc.kind === 'assembly'));
    let choice = 'browse';
    if (open.length) {
      choice = await dialog({
        title: 'Insert Component',
        body: h('div', {}, h('p', {}, 'Insert one of the open parts or assemblies (as subassembly), or browse for a file.'), open.some((t) => !t.path) ? h('p', { class: 'muted' }, 'Unsaved documents must be saved first.') : null),
        buttons: [{ label: 'Cancel', value: null }, ...open.filter((t) => t.path).map((t) => ({ label: t.path.split(/[\\/]/).pop(), value: t })), { label: 'Browse…', value: 'browse', primary: true }],
      });
      if (!choice) return;
    }
    let path, text = null;
    if (choice === 'browse') {
      const f = await api.openFile({ filters: [{ name: 'MonoLith Part or Assembly', extensions: ['lithprt', 'lithasm', 'ekprt', 'ekasm'] }] });
      if (!f) return;
      path = f.path; text = f.text;
    } else { path = choice.path; text = JSON.stringify(choice.doc.toJSON ? choice.doc.toJSON() : choice.doc.doc); partCache.delete(path); }
    await this.insertComponent(path, text);
  }
  async insertComponent(path, text = null, lib = null) {
    const base = lib ? fastenerName(lib.std, lib.size, lib.L) : path.split(/[\\/]/).pop().replace(/\.\w+$/, '');
    if (lib) { text = libText(lib); path = null; }
    const key = lib ? compKey({ lib }) : path;
    const n = this.doc.components.filter((c) => compKey(c) === key).length + 1;
    const c = { id: this.newId('c'), name: `${base}<${n}>`, path, ...(lib ? { lib } : {}), pos: [0, 0, 0], rot: [...IDENT], fixed: this.doc.components.length === 0 };
    this.app.setBusy(true);
    let part;
    try {
      const box = this.assemblyBox();
      Object.defineProperty(c, '_part', { value: null, writable: true, enumerable: false });
      part = await loadPart(key, text, this.app.path ? [this.app.path.toLowerCase()] : []);
      if (part.err) { toast(`Cannot insert ${base}: ${part.err}`, 'error'); return null; }
      if (!box.isEmpty()) {
        const pb = part.geom.boundingBox;
        c.pos = [box.max.x + 20 - pb.min.x, box.min.y - pb.min.y, box.min.z - pb.min.z];
      }
      this.beginChange();
      this.doc.components.push(c);
      c._part = part;
      this.syncScene();
      this.commit();
      this.solve();
      this.zoomFit();
      toast(c.fixed ? `${c.name} inserted and fixed at the origin` : `${c.name} inserted — use Mate to position it`, 'ok', 2500);
      return c;
    } finally { this.app.setBusy(false); }
  }
  openComp(c) {
    if (c.lib) this.app.loadDoc(fastenerPart(c.lib.std, c.lib.size, c.lib.L)); // opens as an unsaved copy
    else this.app.open(c.path);
  }
}

export function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

// mix in methods split off into separate files
for (const M of [AsmCommands, AsmPicking, AsmTree]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(AssemblyDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
