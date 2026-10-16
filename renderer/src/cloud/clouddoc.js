// Point Cloud document (.lithpcd): one or more scans shown with level of detail from their octree cache.
// The scans stay where they are on disk; the document stores their paths and display settings.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { ViewSet } from '../viewset.js';
import { h, fmt, contextMenu, toast, dialog, evalNumber, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { CloudLayer, CLASS_NAMES } from './layer.js';
import { EDLPass } from './edl.js';
import { CloudEdits } from './edits.js';
import { CloudMeasure } from './measure.js';
import { CloudAnalysis } from './analysis.js';
import { CloudRegister } from './register.js';

export const CLOUD_EXTS = ['las', 'laz', 'ply', 'xyz', 'pts', 'txt', 'csv'];
const BUDGETS = [2e6, 5e6, 10e6, 20e6, 40e6];
const mpts = (n) => (n >= 1e6 ? fmt(n / 1e6, n >= 1e8 ? 0 : 1) + ' M' : n >= 1e3 ? fmt(n / 1e3, 0) + ' k' : String(n));
const secs = (s) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

export function newCloudDoc(name = 'PointCloud1') {
  return { kind: 'cloud', version: 1, name, origin: null, clouds: [], view: { budget: 10e6, edl: true, edlStrength: 1, round: false } };
}

export class CloudDoc {
  constructor(app, doc) {
    this.app = app;
    this.doc = doc;
    doc.clouds ||= [];
    doc.view = { budget: 10e6, edl: true, edlStrength: 1, round: false, ...(doc.view || {}) };
    this.layers = new Map();
    this.selId = null;
    this.selIds = new Set();
    this.undoStack = []; this.redoStack = [];
    this.tool = null; this.busy = false;
    this.shown = 0;
  }
  get title() { return this.doc.name; }
  toJSON() { return { ...this.doc, clouds: this.doc.clouds.map(({ missing, ...r }) => r) }; } // eslint-disable-line no-unused-vars

  // ======================= setup =======================
  init() {
    const app = this.app;
    this.viewSet = new ViewSet(app.el.views, { mode: '3d' }); // Viewport menu: 1, 2 or 4 panes
    this.viewport = this.vp = this.viewSet.proxy;
    this.viewSet.onActive = () => this.scheduleLOD();
    this.scene = this.vp.scene;
    this.edls = new Map(); // one depth-shading pass per pane (own render targets / size)
    this.overlay = new THREE.Scene();
    this.vp.renderScene = (r) => {
      const pane = this.vp.pane;
      for (const l of this.layers.values()) l.showFor(pane); // each pane shows its own level of detail
      let edl = this.edls.get(pane); if (!edl) this.edls.set(pane, (edl = new EDLPass()));
      for (const [p, e] of this.edls) if (p.disposed) { e.dispose(); this.edls.delete(p); } // panes closed by the Viewport menu
      if (this.doc.view.edl && this.layers.size) edl.render(r, this.scene, this.vp, this.doc.view.edlStrength);
      else r.render(this.scene, this.vp.camera);
      if (this.overlay.children.length) { const ac = r.autoClear; r.autoClear = false; r.clearDepth(); r.render(this.overlay, this.vp.camera); r.autoClear = ac; } // part preview etc. (not depth shaded)
    };
    this.vp.onViewChange = () => this.viewChanged();
    this.vp.onContextMenu = (e) => this.tool?.onContext?.(e) || contextMenu(e.clientX, e.clientY, [
      { label: 'Zoom to Fit', key: 'F', run: () => this.zoomFit() },
      { label: 'Add Point Cloud…', run: () => this.addCloudDialog() },
      { label: this.doc.view.edl ? 'Shading off' : 'Shading on', run: () => this.setView({ edl: !this.doc.view.edl }) },
    ]);
    this.vp.overlayDrawers.push((ctx) => this.drawMeasures(ctx));
    this.progEl = h('div', { class: 'cloud-prog', style: { display: 'none' } });
    this.vp.el.appendChild(this.progEl);
    this.buildCommands();
    this.buildHeadsUp();
    this.vp.setView('iso', false);
    app.setStatusRight('Meters');
    this.renderTree();
    this.loadAll().then(() => { if (!(this.doc.viewLayout && this.viewSet.restore(this.doc.viewLayout))) this.zoomFit(); });
  }

  buildCommands() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const has = () => this.layers.size > 0;
    const groups = [
      [C('addCloud', 'Add Point Cloud', 'import', () => this.addCloudDialog(), { tip: 'Add a scan (LAS, LAZ, PLY, XYZ, PTS, CSV) to this document' }),
        C('removeCloud', 'Remove', 'delete', () => this.removeSelected(), { enabled: () => this.selIds.size > 0 && !this.busy && !this.tool, tip: 'Remove the selected clouds from this document (scan files stay on disk; can be undone)' })],
      [C('fit', 'Zoom to Fit', 'zoomFit', () => this.zoomFit(), { enabled: has })],
      [C('edl', 'Shading', 'shaded', () => this.setView({ edl: !this.doc.view.edl }), { active: () => this.doc.view.edl, tip: 'Depth shading (Eye-Dome Lighting): makes walls, edges and objects stand out' })],
      [C('export', 'Export', 'export', () => this.exportDialog(), { enabled: has, tip: 'Save the selected scan as LAS, PLY or XYZ' }),
        C('rebuild', 'Rebuild Cache', 'history', () => this.rebuildCache(this.selId), { enabled: () => !!this.selId, tip: 'Read the scan file again and rebuild its display cache' })],
    ];
    this.app.cm.setTabs([{ name: 'Point Cloud', groups }, this.editTab(), this.measureTab(), this.analyseTab(), this.registerTab()], 'Point Cloud');
  }
  buildHeadsUp() {
    const bar = this.app.el.headsUp;
    bar.innerHTML = '';
    const B = (ic, tip, run) => h('button', { class: 'hu-btn', title: tip, html: icon(ic), onclick: run });
    const viewsMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((v, i) => ({ label: v === 'iso' ? 'Isometric' : v[0].toUpperCase() + v.slice(1), key: `Ctrl+${i + 1}`, run: () => this.vp.setView(v) })));
    };
    bar.append(B('zoomFit', 'Zoom to Fit (F)', () => this.zoomFit()), B('views', 'View Orientation', viewsMenu), B('shaded', 'Shading on/off', () => this.setView({ edl: !this.doc.view.edl })));
  }
  setView(v) { Object.assign(this.doc.view, v); for (const l of this.layers.values()) l.applyStyle(); this.app.cm.refresh(); this.renderTree(); this.scheduleLOD(); this.app.setDirty(true); }

  // ======================= loading =======================
  async loadAll() { for (const rec of this.doc.clouds) await this.loadLayer(rec); this.renderTree(); }
  async loadLayer(rec, opts = {}) {
    this.layers.get(rec.id)?.dispose();
    this.layers.delete(rec.id);
    let path = rec.cache || rec.path;
    if (!(await api.fileExists(path).catch(() => false)) && this.app.path) {
      // moved together with the document: look next to it (scans) or in its results folder (edits)
      const sep = this.app.path.includes('\\') ? '\\' : '/', base = path.split(/[\\/]/).pop();
      const alt = rec.cache ? this.resultDir() + sep + base : this.app.path.replace(/[\\/][^\\/]*$/, '') + sep + base;
      if (await api.fileExists(alt).catch(() => false)) { path = alt; if (rec.cache) rec.cache = alt; else rec.path = alt; this.app.setDirty(true); }
    }
    const req = Math.random();
    this.app.setBusy(true);
    const off = api.onCloudProgress((p) => { if (p.req === req) this.showProgress(rec.name, p); });
    let r;
    try { r = rec.cache ? await api.cloudOpenCache(path) : await api.cloudOpen(path, req, opts); } catch (e) { r = { error: e.message }; } finally { off?.(); this.showProgress(null); this.app.setBusy(false); }
    if (!r || r.error) { rec.missing = r?.error || 'Cannot open'; toast(`Could not open ${rec.name}: ${rec.missing}`, 'error', 7000); this.renderTree(); return null; }
    delete rec.missing;
    if (!this.doc.origin) this.doc.origin = r.meta.origin;
    const A = r.meta.attrs;
    if (!rec.colorMode) rec.colorMode = A.rgb ? 'rgb' : A.intensity ? 'intensity' : 'height';
    rec.count = r.meta.count;
    const layer = new CloudLayer(this, rec, r);
    this.scene.add(layer.group);
    this.layers.set(rec.id, layer);
    this.app.setStatus(r.fromCache ? `${rec.name}: ${mpts(r.meta.count)} points (opened from cache)` : `${rec.name}: ${mpts(r.meta.count)} points, prepared in ${secs(r.meta.buildSeconds)}`);
    this.scheduleLOD();
    return layer;
  }
  showProgress(name, p) {
    const el = this.progEl;
    if (!name) { el.style.display = 'none'; return; }
    el.style.display = '';
    const pct = p.total ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0;
    el.innerHTML = '';
    el.append(h('b', {}, name), h('div', {}, `${p.phase}… ${pct}%`),
      h('div', { class: 'cp-bar' }, h('span', { style: { width: pct + '%' } })),
      h('small', {}, `${mpts(p.done)} of ${mpts(p.total)} points · ${secs(p.elapsed)}${p.eta > 1 ? ` · about ${secs(p.eta)} left` : ''} · RAM ${fmt(p.ram / 1e9, 1)} GB`));
    this.app.setStatus(`${name}: ${p.phase} ${pct}%`);
  }

  async addCloudDialog() {
    const f = await api.openFile({ filters: [{ name: 'Point clouds', extensions: CLOUD_EXTS }], noRead: true });
    if (f) await this.addCloud(f.path);
  }
  async addCloud(path) {
    const name = path.split(/[\\/]/).pop();
    if (this.doc.clouds.some((c) => c.path === path)) { toast(`${name} is already in this document`); return null; }
    const rec = { id: 'pc' + Date.now().toString(36), name, path, visible: true, colorMode: null, pointSize: 2 };
    const first = !this.layers.size;
    const layer = await this.loadLayer(rec);
    if (!layer) return null;
    this.pushUndo();
    this.doc.clouds.push(rec);
    this.selId = rec.id; this.selIds = new Set([rec.id]);
    this.app.setDirty(true);
    this.renderTree();
    if (first) this.zoomFit();
    return layer;
  }
  removeSelected() { const ids = [...this.selIds]; if (!ids.length) return; this.pushUndo(); for (const id of ids) this.removeCloud(id, false); }
  removeCloud(id, undo = true) {
    const i = this.doc.clouds.findIndex((c) => c.id === id);
    if (i < 0) return;
    if (undo) this.pushUndo();
    this.selIds.delete(id);
    this.layers.get(id)?.dispose();
    this.layers.delete(id);
    this.doc.clouds.splice(i, 1);
    if (this.selId === id) this.selId = null;
    this.app.setDirty(true);
    this.renderTree();
    this.scheduleLOD();
  }
  async rebuildCache(id) {
    const rec = this.doc.clouds.find((c) => c.id === id);
    if (rec && !rec.cache) { await this.loadLayer(rec, { rebuild: true }); this.renderTree(); } else if (rec) toast('Edit results have no source file to rebuild from');
  }

  // ======================= level of detail =======================
  viewChanged() {
    this.lastMove = performance.now();
    this.scheduleLOD();
    clearTimeout(this.idleT);
    this.idleT = setTimeout(() => this.scheduleLOD(), 230);
  }
  scheduleLOD() {
    if (this.lodPending) return;
    this.lodPending = true;
    requestAnimationFrame(() => { this.lodPending = false; this.updateLOD(); });
  }
  updateLOD() {
    if (this.disposed) return;
    const moving = performance.now() - (this.lastMove || 0) < 200;
    const budget = this.doc.view.budget / (moving ? 4 : 1);
    const vis = [...this.layers.values()].filter((l) => l.rec.visible !== false);
    const total = vis.reduce((a, l) => a + l.meta.count, 0) || 1;
    let shown = 0;
    // several panes: every pane gets its own node selection; the GPU budget is shared (a bit more in total)
    const panes = this.viewSet.panes, k = panes.length > 1 ? 1.5 / panes.length : 1;
    for (const l of vis) shown += l.update(panes, Math.max(2e5, (budget * k * l.meta.count) / total));
    this.shown = shown;
    const all = vis.reduce((a, l) => a + l.meta.count, 0);
    this.app.setCoords(all ? `${mpts(shown)} of ${mpts(all)} points shown` : '');
    this.vp.requestRender();
  }
  onNodesLoaded() { this.scheduleLOD(); }

  zoomFit() {
    const b = new THREE.Box3();
    for (const l of this.layers.values()) if (l.rec.visible !== false) b.union(l.worldBox());
    if (b.isEmpty()) return;
    this.vp.fit(b);
    this.scheduleLOD();
  }

  // Viewport menu: layout of 1, 2 or 4 panes (saved in the file with each pane's view)
  setViewLayout(name) { this.viewSet.setLayout(name, { fit: () => this.zoomFit() }); this.scheduleLOD(); this.app.setStatus(name === 'single' ? 'Single view' : 'Click in a view to make it the active one (blue border); commands like Zoom to Fit act on it'); }
  resetViews() { this.viewSet.resetViews(() => this.zoomFit()); this.scheduleLOD(); }
  beforeSave() { const s = this.viewSet.toJSON(); if (s.layout === 'single') delete this.doc.viewLayout; else this.doc.viewLayout = s; }

  // bounding box for the Home screen picture
  thumbBox() { const b = new THREE.Box3(); for (const l of this.layers.values()) if (l.rec.visible !== false) b.union(l.worldBox()); return b; }

  // ======================= tree + properties =======================
  renderTree() {
    const tree = this.app.el.tree;
    tree.innerHTML = '';
    const row = (o) => {
      const r = h('div', { class: 'tr-row' + (o.sel ? ' sel' : '') + (o.dim ? ' dim' : '') + (o.err ? ' err' : ''), style: { paddingLeft: 6 + (o.depth || 0) * 16 + 'px' }, title: o.tip || '' },
        o.eye !== undefined ? h('button', { class: 'mini', title: o.eye ? 'Hide' : 'Show', html: icon(o.eye ? 'eye' : 'eyeOff'), onclick: (e) => { e.stopPropagation(); o.onEye(); } }) : h('span', { class: 'twisty' }),
        h('span', { class: 'ico sm', html: icon(o.icon) }), h('span', { class: 'tr-label' }, o.label), o.err ? h('span', { class: 'tr-err', title: o.err }, '⚠') : null);
      r.addEventListener('click', (e) => o.onClick?.(e));
      r.addEventListener('dblclick', (e) => o.onDbl?.(e));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); o.onMenu?.(e); });
      return r;
    };
    tree.appendChild(row({ icon: 'cloud', label: this.doc.name }));
    for (const rec of this.doc.clouds) {
      tree.appendChild(row({
        icon: 'cloud', depth: 1, label: `${rec.name}  (${mpts(rec.count || 0)})${rec.transform ? '  ↻' : ''}`, sel: this.selIds.has(rec.id), dim: rec.visible === false, err: rec.missing,
        tip: (rec.derived ? `${rec.derived.op} of ${rec.derived.from.join(', ')}\n` : '') + (rec.cache || rec.path), eye: rec.visible !== false,
        onEye: () => { rec.visible = rec.visible === false; this.layers.get(rec.id)?.applyStyle(); this.app.setDirty(true); this.renderTree(); this.scheduleLOD(); },
        onClick: (e) => {
          this.selMeasure = null;
          if (e.ctrlKey || e.shiftKey) { if (this.selIds.has(rec.id)) this.selIds.delete(rec.id); else this.selIds.add(rec.id); } else this.selIds = new Set([rec.id]);
          this.selId = this.selIds.has(rec.id) ? rec.id : [...this.selIds][0] || null;
          this.renderTree(); this.app.cm.refresh();
        },
        onDbl: () => this.zoomTo(rec.id),
        onMenu: (e) => { if (!this.selIds.has(rec.id)) this.selIds = new Set([rec.id]); this.selId = rec.id; this.renderTree(); contextMenu(e.clientX, e.clientY, [
          { label: 'Rename…', run: () => this.renameCloud(rec) },
          { label: 'Zoom to', run: () => this.zoomTo(rec.id) },
          { label: 'Export…', run: () => this.exportDialog(rec.id) },
          ...(rec.cache ? [] : [{ label: 'Rebuild cache', run: () => this.rebuildCache(rec.id) }]),
          { label: this.selIds.size > 1 ? `Remove ${this.selIds.size} clouds` : 'Remove', run: () => this.removeSelected() }]); },
      }));
    }
    if (!this.doc.clouds.length) tree.appendChild(h('div', { class: 'cloud-empty' }, h('p', {}, 'No scans yet.'), h('button', { class: 'mini txt', onclick: () => this.addCloudDialog() }, 'Add point cloud…')));
    for (const r of this.measureRows(row)) tree.appendChild(r);
    const mp = this.measurePanel();
    if (mp) tree.appendChild(mp);
    const rec = this.doc.clouds.find((c) => c.id === this.selId);
    if (rec && !mp && rec.analysis) { const ap = this.analysisPanel(rec); if (ap) tree.appendChild(ap); }
    if (rec && !mp) tree.appendChild(this.cloudPanel(rec));
    tree.appendChild(this.displayPanel());
    this.app.cm.refresh();
  }
  async renameCloud(rec) {
    const n = await promptText('Cloud name', rec.name);
    if (n && n !== rec.name) { this.pushUndo(); rec.name = n; this.app.setDirty(true); this.renderTree(); }
  }
  zoomTo(id) { const l = this.layers.get(id); if (l) { this.vp.fit(l.worldBox()); this.scheduleLOD(); } }

  cloudPanel(rec) {
    const L = this.layers.get(rec.id);
    const wrap = h('div', { class: 'pc-panel' });
    const set = (fn, rerender = false) => { fn(); L?.applyStyle(); this.scheduleLOD(); this.app.setDirty(true); if (rerender) this.renderTree(); };
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const num = (val, fn, d = 3) => { const i = h('input', { type: 'text', value: fmt(val, d) }); i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); }); i.addEventListener('change', () => { const v = evalNumber(i.value); if (v !== null) set(() => fn(v)); }); return i; };
    wrap.appendChild(h('div', { class: 'sp-sec' }, rec.name));
    if (!L) { wrap.appendChild(h('div', { class: 'pm-msg error' }, rec.missing || 'Not loaded')); wrap.appendChild(h('div', { class: 'pp-inline', style: { margin: '6px 8px' } }, h('button', { class: 'mini txt', onclick: () => this.rebuildCache(rec.id) }, 'Try again'))); return wrap; }
    const M = L.meta, A = M.attrs, O = M.origin;
    // colour
    const opts = [];
    if (A.rgb) opts.push(['rgb', 'Scan colours (RGB)']);
    opts.push(['height', 'Height']);
    if (A.intensity) opts.push(['intensity', 'Intensity']);
    if (A.classification) opts.push(['class', 'Classification']);
    if (['nx', 'ny', 'nz'].every((k) => A.fields.some((f) => f.name === k))) opts.push(['normal', 'Normals (direction)']);
    for (const f of A.fields) opts.push(['field:' + f.name, 'Field: ' + f.name]);
    opts.push(['single', 'Single colour']);
    const mode = rec.colorMode;
    const sel = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: v === mode }, l)));
    sel.addEventListener('change', () => set(() => { rec.colorMode = sel.value; delete rec.range; delete rec.rangeFor; }, true));
    wrap.append(field('Colour', sel));
    if (mode === 'intensity' || mode.startsWith('field:')) {
      const rng = L.rangeFor(mode) || [0, 1];
      const upd = (i, v) => { const r2 = (rec.rangeFor === mode && rec.range) ? rec.range.slice() : rng.slice(); r2[i] = v; rec.range = r2; rec.rangeFor = mode; };
      wrap.append(field('From', num(rng[0], (v) => upd(0, v))), field('To', num(rng[1], (v) => upd(1, v))));
      if (mode.startsWith('field:')) {
        const cat = h('input', { type: 'checkbox', checked: !!rec.categorical });
        cat.addEventListener('change', () => set(() => { rec.categorical = cat.checked; }));
        wrap.append(h('label', { class: 'pm-check', style: { margin: '4px 8px' }, title: 'A different colour for every value, e.g. for room numbers or plane ids' }, cat, 'Colour per value'));
      }
    }
    if (mode === 'height') {
      const zr = rec.heightRange || [M.bbox[2], M.bbox[5]];
      wrap.append(field('From height (m)', num(zr[0] + O[2], (v) => { rec.heightRange = [v - O[2], (rec.heightRange || zr)[1]]; })),
        field('To height (m)', num(zr[1] + O[2], (v) => { rec.heightRange = [(rec.heightRange || zr)[0], v - O[2]]; })));
    }
    if (mode === 'class') wrap.append(h('div', { class: 'cloud-legend' }, Object.entries(CLASS_NAMES).slice(0, 10).map(([k, n]) => h('span', {}, `${k} ${n}`))));
    if (mode === 'single') {
      const c = h('input', { type: 'color', value: rec.single || '#8a96a8' });
      c.addEventListener('input', () => set(() => { rec.single = c.value; }));
      wrap.append(field('Colour', c));
    }
    const size = h('input', { type: 'range', min: 1, max: 8, step: 0.5, value: rec.pointSize || 2 });
    size.addEventListener('input', () => set(() => { rec.pointSize = +size.value; }));
    wrap.append(field('Point size', size));
    // height section
    const clipOn = h('input', { type: 'checkbox', checked: !!rec.clip?.on });
    clipOn.addEventListener('change', () => set(() => { rec.clip = { min: M.bbox[2], max: M.bbox[5], ...(rec.clip || {}), on: clipOn.checked }; }, true));
    wrap.append(h('div', { class: 'sp-sec' }, 'Height section'), h('label', { class: 'pm-check', style: { margin: '4px 8px' } }, clipOn, 'Show only points between'));
    if (rec.clip?.on) {
      wrap.append(field('From (m)', num(rec.clip.min + O[2], (v) => { rec.clip.min = v - O[2]; })), field('To (m)', num(rec.clip.max + O[2], (v) => { rec.clip.max = v - O[2]; })));
      wrap.append(h('div', { class: 'pp-inline', style: { margin: '4px 8px' } },
        h('button', { class: 'mini txt', title: 'Slice 1.0–1.3 m above the lowest floor, for walls', onclick: () => set(() => { rec.clip = { on: true, min: M.bbox[2] + 1.0, max: M.bbox[2] + 1.3 }; }, true) }, 'Floor plan slice')));
    }
    // info
    const ro = (k, v, tip) => h('div', { class: 'pp-row ro', title: tip || '' }, h('label', {}, k), h('span', {}, v));
    const b = M.bbox;
    wrap.append(h('div', { class: 'sp-sec' }, 'Information'),
      rec.derived ? ro('Made by edit', `${rec.derived.op} of ${rec.derived.from.join(', ')}`) : ro('File', rec.path.split(/[\\/]/).pop(), rec.path),
      rec.transform ? ro('Transform', 'moved/rotated (applied at export)') : null,
      rec.registration ? ro('Aligned to', `${rec.registration.ref} (RMS ${fmt(((rec.registration.icpRms ?? rec.registration.pairsRms) || 0) * 1000, 1)} mm)`) : null,
      ro('Format', M.info?.format || ''),
      ro('Points', M.count.toLocaleString()),
      ro('Size (m)', `${fmt(b[3] - b[0], 2)} × ${fmt(b[4] - b[1], 2)} × ${fmt(b[5] - b[2], 2)}`),
      ro('Lowest / highest Z', `${fmt(b[2] + O[2], 3)} / ${fmt(b[5] + O[2], 3)}`),
      ro('Fields', [A.rgb ? 'RGB' : null, A.intensity ? 'intensity' : null, A.classification ? 'classification' : null, ...A.fields.map((f) => f.name)].filter(Boolean).join(', ') || '—'),
      ro('Cache', L.cachePath.split(/[\\/]/).pop(), L.cachePath),
      M.info?.software ? ro('Made by', M.info.software) : null);
    for (const n of [...wrap.childNodes]) if (n.nodeType === 3 && n.textContent === 'null') n.remove(); // append(null) adds the text "null"
    return wrap;
  }

  displayPanel() {
    const v = this.doc.view;
    const wrap = h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, 'Display'));
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const bud = h('select', { title: 'Most points drawn at the same time. Lower = smoother on slower graphics cards.' }, BUDGETS.map((n) => h('option', { value: n, selected: n === v.budget }, mpts(n) + ' points')));
    bud.addEventListener('change', () => this.setView({ budget: +bud.value }));
    const edl = h('input', { type: 'checkbox', checked: v.edl });
    edl.addEventListener('change', () => this.setView({ edl: edl.checked }));
    const str = h('input', { type: 'range', min: 0.2, max: 3, step: 0.1, value: v.edlStrength });
    str.addEventListener('input', () => { this.doc.view.edlStrength = +str.value; this.vp.requestRender(); this.app.setDirty(true); });
    const rnd = h('input', { type: 'checkbox', checked: !!v.round });
    rnd.addEventListener('change', () => this.setView({ round: rnd.checked }));
    wrap.append(field('Point budget', bud), h('label', { class: 'pm-check', style: { margin: '4px 8px' } }, edl, 'Depth shading'), field('Shading strength', str), h('label', { class: 'pm-check', style: { margin: '4px 8px' } }, rnd, 'Round points'));
    return wrap;
  }

  // ======================= export =======================
  async exportDialog(id = this.selId || this.doc.clouds[0]?.id) {
    const rec = this.doc.clouds.find((c) => c.id === id), L = this.layers.get(id);
    if (!rec || !L) { toast('Select a loaded scan first'); return; }
    const base = rec.cache ? (this.app.path || '').replace(/[\\/][^\\/]*$/, '') + (this.app.path?.includes('\\') ? '\\' : '/') + rec.name.replace(/[<>:"/\\|?*]/g, '_') : rec.path.replace(/\.[^.\\/]+$/, '');
    const out = await api.saveFile({ defaultPath: base + '_export.las', noWrite: true, filters: [{ name: 'LAS point cloud', extensions: ['las'] }, { name: 'PLY (binary)', extensions: ['ply'] }, { name: 'XYZ text', extensions: ['xyz', 'txt'] }] });
    if (!out) return;
    if (/\.laz$/i.test(out)) { toast('LAZ export is not available yet - choose LAS, PLY or XYZ', 'error'); return; }
    const format = /\.ply$/i.test(out) ? 'ply' : /\.(xyz|txt)$/i.test(out) ? 'xyz' : 'las';
    const req = Math.random();
    this.app.setBusy(true);
    const off = api.onCloudProgress((p) => { if (p.req === req) this.showProgress(rec.name, p); });
    try {
      const r = await api.cloudExport(L.id, out, format, req, rec.transform || null);
      if (r?.error) throw new Error(r.error);
      toast(`Exported ${r.written.toLocaleString()} points to ${out.split(/[\\/]/).pop()}`, 'ok', 4000);
    } catch (e) { toast('Export failed: ' + e.message, 'error', 7000); } finally { off?.(); this.showProgress(null); this.app.setBusy(false); }
  }

  // ======================= keys & misc =======================
  onKey(e) {
    if (this.tool?.onKey?.(e)) return true;
    if (e.key === 'Escape' && (this.tool || this.app.pm.open)) { this.app.pm.cancel(); this.endTool(); return true; }
    if (e.ctrlKey && /^[1-7]$/.test(e.key)) { this.vp.setView(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'][+e.key - 1]); return true; }
    if (e.ctrlKey) return false;
    if (e.key === 'f' || e.key === 'F') { this.zoomFit(); return true; }
    if (e.key === 'Delete' && this.selIds.size && !this.tool && !this.app.pm.open) { this.removeSelected(); return true; }
    return false;
  }
  onActivate() { this.scheduleLOD(); }
  dispose() {
    this.disposed = true;
    this.tool?.dispose();
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    for (const e of this.edls.values()) e.dispose();
    this.vp.dispose();
  }
}

// editing commands live in edits.js
for (const M of [CloudEdits, CloudMeasure, CloudAnalysis, CloudRegister]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(CloudDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
