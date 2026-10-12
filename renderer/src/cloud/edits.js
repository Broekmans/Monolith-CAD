// Point Cloud document: editing commands (mixed into CloudDoc; `this` is the CloudDoc).
// Every edit makes new cloud(s) from the full-resolution points (main/cloudio.cjs editCloud);
// the source clouds are only hidden, so Undo/Redo just switch the document's cloud list.
import { h, fmt, toast, dialog } from '../ui.js';
import { api } from '../api.js';
import { CloudLayer } from './layer.js';
import { PolygonTool, BoxTool } from './tools.js';

const mpts = (n) => (n >= 1e6 ? fmt(n / 1e6, 1) + ' M' : n >= 1e3 ? fmt(n / 1e3, 0) + ' k' : String(n));
// result names: the cloud name without the file extension
const nm = (r) => r.name.replace(/\.(laz|las|ply|xyz|pts|txt|csv)$/i, '');
const IDENT = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const mul3 = (A, B) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return r; };
const rot3 = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

export class CloudEdits {
  // ======================= helpers =======================
  editTab() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const idle = () => !this.app.pm.open && !this.tool && !this.busy;
    const can = () => idle() && this.targets().length > 0;
    return { name: 'Edit', groups: [
      [C('segment', 'Segment', 'trim', () => this.cmdSegment(), { enabled: can, tip: 'Draw a polygon over the view and cut the scan along it (split, keep inside or keep outside)' }),
        C('crop', 'Crop Box', 'section', () => this.cmdCrop(), { enabled: can, tip: 'Keep only the points inside (or outside) a box' }),
        C('filter', 'Filter by Value', 'layers', () => this.cmdFilter(), { enabled: () => idle() && this.targets().length === 1, tip: 'Keep or remove points by height, intensity, classification or a field (e.g. room = 3)' })],
      [C('subsample', 'Subsample', 'grid', () => this.cmdSubsample(), { enabled: () => idle() && this.targets().length === 1, tip: 'Fewer points: minimum spacing or a percentage' }),
        C('noise', 'Noise Filter', 'erase', () => this.cmdNoise(), { enabled: () => idle() && this.targets().length === 1, tip: 'Remove loose points: radius filter or statistical outlier removal' })],
      [C('merge', 'Merge', 'assembly', () => this.cmdMerge(), { enabled: () => idle() && this.targets(true).length >= 2, tip: 'Combine the selected clouds (Ctrl+click in the tree) into one' }),
        C('transform', 'Transform', 'move', () => this.cmdTransform(), { enabled: () => idle() && this.targets().length === 1, tip: 'Move or rotate a cloud, or enter a 4x4 matrix' })],
      [C('undo', 'Undo', 'undo', () => this.undo(), { enabled: () => idle() && this.undoStack.length > 0 }),
        C('redo', 'Redo', 'redo', () => this.redo(), { enabled: () => idle() && this.redoStack.length > 0 })],
    ] };
  }
  // the clouds an edit applies to: the selected ones, else all visible ones (strict: selection only)
  targets(strict = false) {
    const ok = (r) => this.layers.has(r.id) && r.visible !== false;
    const sel = this.doc.clouds.filter((r) => this.selIds.has(r.id) && this.layers.has(r.id));
    if (sel.length || strict) return sel;
    return this.doc.clouds.filter(ok);
  }
  resultDir() {
    const p = this.app.path, sep = p.includes('\\') ? '\\' : '/';
    return p.replace(/[\\/][^\\/]*$/, '') + sep + p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + ' clouds';
  }
  async ensureSaved() {
    if (this.app.path) return true;
    const r = await dialog({ title: 'Save first', body: h('p', {}, 'Edit results are stored in a folder next to the point cloud document. Save the document first.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Save…', value: 'save', primary: true }] });
    return r === 'save' && (await this.app.save());
  }
  endTool() { this.tool?.dispose(); this.tool = null; for (const l of this.layers.values()) l.setCropPreview(null); this.vp.requestRender(); this.app.cm.refresh(); }

  // ======================= undo =======================
  snapshot() { return { clouds: JSON.stringify(this.toJSON().clouds), measures: JSON.stringify(this.doc.measures || []), parts: JSON.stringify(this.doc.partAlign || {}), selIds: [...this.selIds] }; }
  pushUndo(snap = this.snapshot()) { this.undoStack.push(snap); if (this.undoStack.length > 50) this.undoStack.shift(); this.redoStack = []; this.app.cm.refresh(); }
  async restore(s) {
    this.doc.clouds = JSON.parse(s.clouds);
    if (s.measures) this.doc.measures = JSON.parse(s.measures);
    if (s.parts) this.doc.partAlign = JSON.parse(s.parts);
    this.vp.requestRender();
    this.selIds = new Set(s.selIds.filter((id) => this.doc.clouds.some((r) => r.id === id)));
    this.selId = [...this.selIds][0] || null;
    await this.syncLayers();
    this.app.setDirty(true);
  }
  async undo() { if (!this.undoStack.length || this.busy) return; const s = this.undoStack.pop(); this.redoStack.push(this.snapshot()); await this.restore(s); }
  async redo() { if (!this.redoStack.length || this.busy) return; const s = this.redoStack.pop(); this.undoStack.push(this.snapshot()); await this.restore(s); }
  async syncLayers() {
    const ids = new Set(this.doc.clouds.map((r) => r.id));
    for (const [id, l] of this.layers) if (!ids.has(id)) { l.dispose(); this.layers.delete(id); }
    for (const rec of this.doc.clouds) {
      const l = this.layers.get(rec.id);
      if (l) { l.rec = rec; l.setPlacement(); l.applyStyle(); } else await this.loadLayer(rec);
    }
    this.renderTree();
    this.scheduleLOD();
  }
  // all result files the document (or its undo history) still refers to
  usedCaches() {
    const out = new Set();
    const add = (list) => { for (const r of list) if (r.cache) out.add(r.cache); };
    add(this.doc.clouds);
    for (const s of [...this.undoStack, ...this.redoStack]) add(JSON.parse(s.clouds));
    return [...out];
  }
  async afterSave() {
    if (!this.doc.clouds.some((r) => r.cache) && !this.undoStack.length) return;
    try { await api.cloudClean(this.resultDir(), this.usedCaches()); } catch { /* ignore */ }
  }

  // ======================= running an edit =======================
  // srcs: records; names: one name per output. Returns the new records.
  async runEdit(op, params, label, srcs, names, { undo = true } = {}) {
    if (!(await this.ensureSaved())) return null;
    const spec = { op, params, label, sources: srcs.map((r) => ({ id: this.layers.get(r.id).id, transform: r.transform || null })), outDir: this.resultDir(), names, docOrigin: this.doc.origin };
    const req = Math.random();
    const title = srcs.length === 1 ? `${label}: ${srcs[0].name}` : label;
    this.busy = true; this.app.cm.refresh(); this.app.setBusy(true);
    const off = api.onCloudProgress((p) => { if (p.req === req) this.showProgress(title, p); });
    let r;
    try { r = await api.cloudEdit(spec, req); } catch (e) { r = { error: e.message }; } finally { off?.(); this.showProgress(null); this.app.setBusy(false); this.busy = false; }
    if (!r || r.error) { toast(`${label} failed: ${r?.error || 'unknown error'}`, 'error', 8000); this.app.cm.refresh(); return null; }
    if (undo) this.pushUndo();
    const src = srcs[0], made = [];
    r.outputs.forEach((o, i) => {
      if (!o) return;
      const rec = { id: 'pc' + Date.now().toString(36) + i + Math.floor(Math.random() * 1e4), name: names[i], cache: o.cache, derived: { from: srcs.map((s) => s.name), op: label },
        visible: true, colorMode: src.colorMode, pointSize: src.pointSize || 2, categorical: src.categorical, count: o.meta.count };
      if (rec.colorMode?.startsWith('field:') && !o.meta.attrs.fields.some((f) => 'field:' + f.name === rec.colorMode)) rec.colorMode = null;
      if (!rec.colorMode) rec.colorMode = o.meta.attrs.rgb ? 'rgb' : 'height';
      if (o.analysis) this.applyAnalysis(rec, o.analysis);
      const layer = new CloudLayer(this, rec, o);
      this.scene.add(layer.group);
      this.layers.set(rec.id, layer);
      made.push(rec);
    });
    // new clouds go right after the (last) source; sources are hidden
    const at = Math.max(...srcs.map((s) => this.doc.clouds.indexOf(s))) + 1;
    this.doc.clouds.splice(at, 0, ...made);
    for (const s of srcs) { s.visible = false; this.layers.get(s.id)?.applyStyle(); }
    this.selIds = new Set(made.slice(0, 1).map((m) => m.id)); this.selId = made[0]?.id || null;
    const empty = r.outputs.map((o, i) => (o ? null : names[i])).filter(Boolean);
    this.app.setStatus(`${label}: ${made.map((m) => `${m.name} ${mpts(m.count)}`).join(', ')} (${fmt(r.seconds, 1)} s)`);
    if (empty.length) toast(`No points for: ${empty.join(', ')}`, 'info', 5000);
    this.app.setDirty(true);
    this.renderTree();
    this.scheduleLOD();
    return made;
  }

  // ======================= Segment =======================
  cmdSegment() {
    const tg = this.targets();
    if (!tg.length) return;
    this.tool = new PolygonTool(this, () => { pm.setMessage(`Polygon closed (${this.tool.pts.length} points). Choose what to keep and press OK.`); });
    const pm = this.app.pm.show({
      title: 'Segment', iconName: 'trim', values: { mode: 'split' },
      message: 'Click points around the area in the view. Right click, double click or Enter closes the polygon. Backspace removes the last point.',
      fields: [
        { key: 'mode', type: 'select', label: 'Result', options: [{ value: 'split', label: 'Split into inside + outside' }, { value: 'inside', label: 'Keep inside' }, { value: 'outside', label: 'Keep outside (delete inside)' }] },
        { type: 'info', text: `Applies to: ${tg.map((r) => r.name).join(', ')}` },
        { type: 'info', text: 'Turning the view is still possible while drawing (middle mouse). The cut goes straight through the whole scan, along the viewing direction.' }],
      onOk: (v) => {
        const t = this.tool;
        if (!t.closed) { t.close(); if (!t.closed) return false; }
        const { mat, ndc } = t;
        this.endTool();
        setTimeout(() => this.applySegment(tg, v.mode, mat, ndc));
        return true;
      },
      onCancel: () => this.endTool(),
    });
    this.app.cm.refresh();
  }
  async applySegment(tg, mode, mat, poly) {
    const snap = this.snapshot();
    let any = false;
    for (const rec of tg) {
      const names = mode === 'split' ? [`${nm(rec)} - inside`, `${nm(rec)} - outside`] : [`${nm(rec)} - ${mode === 'inside' ? 'cut out' : 'trimmed'}`];
      const made = await this.runEdit('poly', { mat, poly, mode }, 'Segment', [rec], names, { undo: false });
      if (made) any = true; else break;
    }
    if (any) this.pushUndo(snap);
  }

  // ======================= Crop box =======================
  cmdCrop() {
    const tg = this.targets();
    if (!tg.length) return;
    const b = tg.map((r) => this.layers.get(r.id).docBox()).reduce((a, x) => a.union(x));
    const O = this.doc.origin;
    const box = { min: [b.min.x, b.min.y, b.min.z].map((v) => Math.round(v * 1000) / 1000), max: [b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1000) / 1000) };
    const keys = ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'];
    const vals = () => Object.fromEntries(keys.map((k, i) => [k, +(box[i < 3 ? 'min' : 'max'][i % 3] + O[i % 3]).toFixed(3)]));
    const preview = (mode) => { for (const r of tg) this.layers.get(r.id)?.setCropPreview(box, mode === 'outside' ? 'outside' : 'inside'); this.vp.requestRender(); };
    let mode = 'inside';
    this.tool = new BoxTool(this, box, () => { const v = vals(); for (const k of keys) pm.setValue(k, v[k]); preview(mode); });
    const num = (key, label) => ({ key, type: 'number', label, unit: 'm', step: 0.1 });
    const pm = this.app.pm.show({
      title: 'Crop Box', iconName: 'section', values: { ...vals(), mode },
      message: 'Drag the coloured squares in the view, or type the limits.',
      fields: [
        { key: 'mode', type: 'select', label: 'Result', options: [{ value: 'inside', label: 'Keep inside' }, { value: 'outside', label: 'Keep outside' }, { value: 'split', label: 'Split into inside + outside' }] },
        { type: 'group', label: 'From', fields: [num('x0', 'X'), num('y0', 'Y'), num('z0', 'Z')] },
        { type: 'group', label: 'To', fields: [num('x1', 'X'), num('y1', 'Y'), num('z1', 'Z')] },
        { type: 'info', text: `Applies to: ${tg.map((r) => r.name).join(', ')}` }],
      onChange: (v, key) => {
        if (key === 'mode') mode = v.mode;
        else { const i = keys.indexOf(key); if (i >= 0) box[i < 3 ? 'min' : 'max'][i % 3] = v[key] - O[i % 3]; }
        preview(mode); this.vp.requestRender();
      },
      onOk: (v) => {
        const p = { min: box.min.slice(), max: box.max.slice(), mode: v.mode };
        this.endTool();
        setTimeout(async () => {
          const snap = this.snapshot(); let any = false;
          for (const rec of tg) {
            const names = p.mode === 'split' ? [`${nm(rec)} - in box`, `${nm(rec)} - outside box`] : [`${nm(rec)} - cropped`];
            const made = await this.runEdit('box', p, 'Crop', [rec], names, { undo: false });
            if (made) any = true; else break;
          }
          if (any) this.pushUndo(snap);
        });
        return true;
      },
      onCancel: () => this.endTool(),
    });
    preview(mode);
    this.app.cm.refresh();
  }

  // ======================= Filter by value =======================
  cmdFilter() {
    const rec = this.targets()[0], L = this.layers.get(rec.id), A = L.meta.attrs, M = L.meta;
    const opts = [{ value: 'z', label: 'Height (Z)' }];
    if (A.intensity) opts.push({ value: 'i', label: 'Intensity' });
    if (A.classification) opts.push({ value: 'c', label: 'Classification' });
    for (const f of A.fields) opts.push({ value: 'f:' + f.name, label: 'Field: ' + f.name });
    const range = (a) => {
      if (a === 'z') { const z0 = M.bbox[2] + L.offset[2] + this.doc.origin[2], z1 = M.bbox[5] + L.offset[2] + this.doc.origin[2]; return [+z0.toFixed(3), +z1.toFixed(3)]; }
      if (a === 'i') return A.intensity;
      if (a === 'c') return [0, 31];
      const f = A.fields.find((x) => 'f:' + x.name === a); return f ? [f.min, f.max] : [0, 1];
    };
    // default: the field the cloud is coloured by, if any
    const cm = rec.colorMode || '';
    const first = cm.startsWith('field:') ? 'f:' + cm.slice(6) : cm === 'intensity' && A.intensity ? 'i' : cm === 'class' ? 'c' : 'z';
    const r0 = range(first);
    const pm = this.app.pm.show({
      title: 'Filter by Value', iconName: 'layers', values: { attr: first, min: r0[0], max: r0[1], mode: 'inside' },
      message: 'Example: Field room, from 3 to 3 = only room 3.',
      fields: [
        { key: 'attr', type: 'select', label: 'Value', options: opts },
        { key: 'min', type: 'number', label: 'From' }, { key: 'max', type: 'number', label: 'To' },
        { key: 'mode', type: 'select', label: 'Result', options: [{ value: 'inside', label: 'Keep points in this range' }, { value: 'outside', label: 'Remove points in this range' }, { value: 'split', label: 'Split into in range + rest' }] },
        { type: 'info', key: 'rng', text: `Values in this cloud: ${r0.map((v) => fmt(v, 3)).join(' … ')}` }],
      onChange: (v, key) => {
        if (key !== 'attr') return;
        const r = range(v.attr);
        pm.setValue('min', r[0]); pm.setValue('max', r[1]);
        pm.inputs.rng.textContent = `Values in this cloud: ${r.map((x) => fmt(x, 3)).join(' … ')}`;
      },
      onOk: (v) => {
        if (!(v.max >= v.min)) { pm.setMessage('"To" must be at least "From"', 'error'); return false; }
        const fld = v.attr.startsWith('f:') ? v.attr.slice(2) : null;
        const what = fld ? `${fld} ${v.min === v.max ? '= ' + fmt(v.min, 3) : fmt(v.min, 3) + '–' + fmt(v.max, 3)}` : `${opts.find((o) => o.value === v.attr).label} ${fmt(v.min, 3)}–${fmt(v.max, 3)}`;
        const names = v.mode === 'split' ? [`${nm(rec)} - ${what}`, `${nm(rec)} - rest`] : [`${nm(rec)} - ${v.mode === 'inside' ? what : 'without ' + what}`];
        setTimeout(() => this.runEdit('value', { attr: fld ? 'f' : v.attr, field: fld, min: v.min, max: v.max, mode: v.mode }, 'Filter', [rec], names));
        return true;
      },
    });
  }

  // ======================= Subsample =======================
  cmdSubsample() {
    const rec = this.targets()[0];
    const pm = this.app.pm.show({
      title: 'Subsample', iconName: 'grid', values: { method: 'spacing', spacing: 2, pct: 25 },
      fields: [
        { key: 'method', type: 'select', label: 'Method', options: [{ value: 'spacing', label: 'Minimum spacing (even)' }, { value: 'random', label: 'Random percentage' }] },
        { key: 'spacing', type: 'number', label: 'Spacing', unit: 'cm', min: 0.1, step: 0.5 },
        { key: 'pct', type: 'number', label: 'Keep', unit: '%', min: 0.1, step: 5 },
        { type: 'info', text: 'Minimum spacing keeps one point per cube of that size: an even density, good for large scans.' }],
      onOk: (v) => {
        if (v.method === 'spacing') setTimeout(() => this.runEdit('spacing', { spacing: v.spacing / 100 }, 'Subsample', [rec], [`${nm(rec)} - ${fmt(v.spacing, 1)} cm`]));
        else { if (!(v.pct > 0 && v.pct <= 100)) { pm.setMessage('Percentage between 0 and 100', 'error'); return false; } setTimeout(() => this.runEdit('random', { frac: v.pct / 100 }, 'Subsample', [rec], [`${nm(rec)} - ${fmt(v.pct, 1)}%`])); }
        return true;
      },
    });
  }

  // ======================= Noise filter =======================
  spacingEstimate(L) {
    const s = [];
    for (const nd of L.nodes.values()) if (!nd.children.length && nd.n > 50) s.push(nd.size / Math.sqrt(nd.n));
    s.sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0.02;
  }
  cmdNoise() {
    const rec = this.targets()[0], L = this.layers.get(rec.id);
    const sp = Math.max(0.002, this.spacingEstimate(L));
    const pm = this.app.pm.show({
      title: 'Noise Filter', iconName: 'erase', values: { method: 'sor', k: 8, sigma: 1, r: +(sp * 300).toFixed(1), minN: 4 },
      fields: [
        { key: 'method', type: 'select', label: 'Method', options: [{ value: 'sor', label: 'Statistical outliers (SOR)' }, { value: 'radius', label: 'Radius filter' }] },
        { type: 'group', label: 'Statistical outliers', fields: [
          { key: 'k', type: 'number', label: 'Neighbours (k)', min: 1, step: 1 },
          { key: 'sigma', type: 'number', label: 'Max. deviation (σ)', min: 0, step: 0.5 },
          { type: 'info', text: 'Removes points whose mean distance to their k nearest neighbours is more than σ standard deviations above the average. Smaller σ removes more.' }] },
        { type: 'group', label: 'Radius filter', fields: [
          { key: 'r', type: 'number', label: 'Radius', unit: 'cm', min: 0.1, step: 1 },
          { key: 'minN', type: 'number', label: 'Min. neighbours', min: 1, step: 1 },
          { type: 'info', text: 'Removes points with fewer neighbours than this within the radius.' }] },
        { type: 'info', text: `Typical point spacing in this cloud: about ${fmt(sp * 100, 1)} cm.` }],
      onOk: (v) => {
        if (v.method === 'sor') {
          const k = Math.max(1, Math.round(v.k));
          setTimeout(() => this.runEdit('sor', { k, nSigma: v.sigma, cell: Math.max(0.005, sp * Math.max(3, Math.sqrt(k) * 1.2)) }, 'Noise filter', [rec], [`${nm(rec)} - cleaned`]));
        } else setTimeout(() => this.runEdit('radius', { r: v.r / 100, minN: Math.max(1, Math.round(v.minN)) }, 'Noise filter', [rec], [`${nm(rec)} - cleaned`]));
        return true;
      },
    });
    void pm;
  }

  // ======================= Merge =======================
  cmdMerge() {
    const tg = this.targets(true);
    if (tg.length < 2) { toast('Select two or more clouds (Ctrl+click in the tree)'); return; }
    this.runEdit('merge', {}, 'Merge', tg, [`Merged (${tg.length} clouds)`]);
  }

  // ======================= Transform =======================
  cmdTransform() {
    const rec = this.targets()[0], L = this.layers.get(rec.id);
    const base = rec.transform ? JSON.parse(JSON.stringify(rec.transform)) : null, snap = this.snapshot();
    const O = this.doc.origin;
    // centre of the cloud (absolute) for rotations
    const bb = L.docBox(), c = [(bb.min.x + bb.max.x) / 2 + O[0], (bb.min.y + bb.max.y) / 2 + O[1], (bb.min.z + bb.max.z) / 2 + O[2]];
    const compose = (v) => {
      const B = base || IDENT;
      let R = B.R.slice(), t = B.t.slice();
      const nums = String(v.matrix || '').trim().split(/[\s,;]+/).filter(Boolean).map(Number);
      if (nums.length === 12 || nums.length === 16) {
        if (nums.some((x) => !isFinite(x))) throw new Error('Matrix contains invalid numbers');
        const Mr = [nums[0], nums[1], nums[2], nums[4], nums[5], nums[6], nums[8], nums[9], nums[10]], Mt = [nums[3], nums[7], nums[11]];
        R = mul3(Mr, R); t = rot3(Mr, t).map((x, i) => x + Mt[i]);
      } else if (nums.length) throw new Error('A matrix needs 12 or 16 numbers (row by row)');
      const a = ((v.rz || 0) * Math.PI) / 180, Rz = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
      // rotate about the cloud centre, then move
      R = mul3(Rz, R); t = rot3(Rz, t.map((x, i) => x - c[i])).map((x, i) => x + c[i] + [v.dx || 0, v.dy || 0, v.dz || 0][i]);
      return { R, t };
    };
    const apply = (v) => {
      try { const T = compose(v); rec.transform = T; pm.setMessage(''); } catch (e) { pm.setMessage(e.message, 'error'); return false; }
      L.setPlacement(); this.scheduleLOD(); return true;
    };
    const pm = this.app.pm.show({
      title: 'Transform', iconName: 'move', values: { dx: 0, dy: 0, dz: 0, rz: 0, matrix: '' },
      message: 'The cloud moves right away; the points are changed for real at the next edit or export.',
      fields: [
        { type: 'group', label: 'Move', fields: [{ key: 'dx', type: 'number', label: 'X', unit: 'm', step: 0.1 }, { key: 'dy', type: 'number', label: 'Y', unit: 'm', step: 0.1 }, { key: 'dz', type: 'number', label: 'Z', unit: 'm', step: 0.1 }] },
        { type: 'group', label: 'Rotate', fields: [{ key: 'rz', type: 'number', label: 'Around Z', unit: '°', step: 1 }] },
        { type: 'group', label: 'Matrix (optional)', fields: [{ key: 'matrix', type: 'text', label: '4×4, row by row' }] },
        { type: 'buttons', buttons: [{ label: 'Reset to original position', icon: 'history', run: () => { rec.transform = null; L.setPlacement(); this.scheduleLOD(); this.app.pm.close(false); this.pushUndo(snap); this.renderTree(); this.app.setDirty(true); } }] }],
      onChange: (v) => apply(v),
      onOk: (v) => { if (!apply(v)) return false; this.pushUndo(snap); this.app.setDirty(true); this.renderTree(); return true; },
      onCancel: () => { rec.transform = base; L.setPlacement(); this.scheduleLOD(); },
    });
    this.app.cm.refresh();
  }
}
