// Point cloud analysis (Analyse tab, mixed into CloudDoc; `this` is the CloudDoc).
// Normals, density, cloud-to-cloud and cloud-to-part distances. Each run makes a new cloud with the
// result as scalar field(s) (main/cloudio.cjs analyseCloud, via runEdit) so Undo/Redo and saving work
// like for edits. The result statistics + histogram are kept in rec.analysis.
import * as THREE from 'three';
import { h, fmt, toast } from '../ui.js';
import { api } from '../api.js';
import { SCAN_TO_WORLD } from './layer.js';
import { loadPart } from '../assembly/assembly.js';

const nm = (r) => r.name.replace(/\.(laz|las|ply|xyz|pts|txt|csv)$/i, '');
const DIST = new Set(['c2c', 'c2m']);
const OPS = { normals: 'Normals', density: 'Density', c2c: 'Cloud to Cloud', c2m: 'Cloud to Part' };

// part mesh (world mm, Y up) -> document frame (m, Z up): x = X/1000, y = -Z/1000, z = Y/1000
const toDocFrame = (X, Y, Z) => [X / 1000, -Z / 1000, Y / 1000];

export class CloudAnalysis {
  analyseTab() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const idle = () => !this.app.pm.open && !this.tool && !this.busy;
    const one = () => idle() && this.targets().length === 1;
    return { name: 'Analyse', groups: [
      [C('normals', 'Normals', 'perpendicular', () => this.cmdNormals(), { enabled: one, tip: 'Surface direction of every point (nx, ny, nz) plus curvature and verticality (0 = floor/ceiling, 1 = wall)' }),
        C('density', 'Density', 'grid', () => this.cmdDensity(), { enabled: one, tip: 'Number of points per m² (or m³, or within a radius) around every point' })],
      [C('c2c', 'Cloud to Cloud', 'cloud', () => this.cmdC2C(), { enabled: () => one() && this.doc.clouds.filter((r) => this.layers.has(r.id)).length >= 2, tip: 'Distance from every point to another cloud (the reference), e.g. before/after or scan vs. scan' }),
        C('c2m', 'Cloud to Part', 'part', () => this.cmdC2M(), { enabled: one, tip: 'Deviation of the scan from a part or assembly (as built vs. design)' })],
      [C('astats', 'Statistics CSV', 'export', () => this.exportStats(), { enabled: () => !!this.selRec()?.analysis, tip: 'Save the statistics and histogram of the selected result as CSV' })],
      [C('undo', 'Undo', 'undo', () => this.undo(), { enabled: () => idle() && this.undoStack.length > 0 }),
        C('redo', 'Redo', 'redo', () => this.redo(), { enabled: () => idle() && this.redoStack.length > 0 })],
    ] };
  }
  selRec() { return this.doc.clouds.find((c) => c.id === this.selId) || null; }

  // colour a new result by its main field
  applyAnalysis(rec, a, fields) {
    rec.analysis = a;
    rec.colorMode = 'field:' + a.field;
    rec.categorical = false;
    const s = a.stats;
    if (DIST.has(a.op) && s.n) {
      const signed = s.min < 0;
      const m = Math.min(a.params.maxDist || Infinity, Math.max(Math.abs(s.min), Math.abs(s.max)));
      rec.range = signed ? [-m, m] : [0, m]; rec.rangeFor = rec.colorMode;
    } else if (a.op === 'normals') { rec.range = [0, 1]; rec.rangeFor = rec.colorMode; }
    void fields;
  }
  async runAnalysis(op, params, rec, suffix) {
    const made = await this.runEdit(op, params, OPS[op], [rec], [`${nm(rec)} - ${suffix}`]);
    if (made?.[0]) { this.renderTree(); this.vp.requestRender(); }
    return made;
  }

  // ======================= Normals =======================
  cmdNormals() {
    const rec = this.targets()[0], L = this.layers.get(rec.id);
    const sp = Math.max(0.002, this.spacingEstimate(L));
    this.app.pm.show({
      title: 'Normals', iconName: 'perpendicular', values: { k: 12, orient: 'inside' },
      fields: [
        { key: 'k', type: 'number', label: 'Neighbours (k)', min: 3, step: 1 },
        { key: 'orient', type: 'select', label: 'Point normals', options: [{ value: 'inside', label: 'Towards the middle (indoor scan)' }, { value: 'outside', label: 'Away from the middle (outdoor scan)' }, { value: 'up', label: 'Upwards (terrain)' }] },
        { type: 'info', text: 'A plane is fitted through every point and its k nearest neighbours. New fields: nx, ny, nz, curvature (0 = flat) and verticality (0 = horizontal, 1 = vertical). Colour "Normals" shows the direction.' },
        { type: 'info', text: `Typical point spacing: about ${fmt(sp * 100, 1)} cm.` }],
      onOk: (v) => {
        const k = Math.max(3, Math.min(64, Math.round(v.k)));
        setTimeout(() => this.runAnalysis('normals', { k, orient: v.orient, cell: Math.max(0.005, sp * Math.max(3, Math.sqrt(k) * 1.2)) }, rec, 'normals'));
        return true;
      },
    });
  }

  // ======================= Density =======================
  cmdDensity() {
    const rec = this.targets()[0], L = this.layers.get(rec.id);
    const sp = Math.max(0.002, this.spacingEstimate(L));
    this.app.pm.show({
      title: 'Density', iconName: 'grid', values: { r: +Math.max(1, sp * 500).toFixed(1), kind: 'surface' },
      fields: [
        { key: 'r', type: 'number', label: 'Radius', unit: 'cm', min: 0.1, step: 1 },
        { key: 'kind', type: 'select', label: 'Result', options: [{ value: 'surface', label: 'Points per m² (surface)' }, { value: 'volume', label: 'Points per m³ (volume)' }, { value: 'count', label: 'Number of neighbours within the radius' }] },
        { type: 'info', text: 'Shows where the scan is thin (low) or dense (high). New field: density.' }],
      onOk: (v) => { if (!(v.r > 0)) return false; setTimeout(() => this.runAnalysis('density', { r: v.r / 100, kind: v.kind }, rec, 'density')); return true; },
    });
  }

  // ======================= Cloud to cloud =======================
  cmdC2C() {
    const rec = this.targets()[0];
    const others = this.doc.clouds.filter((r) => r.id !== rec.id && this.layers.has(r.id));
    const hasN = (r) => ['nx', 'ny', 'nz'].every((k) => this.layers.get(r.id).meta.attrs.fields.some((f) => f.name === k));
    const first = others.find((r) => r.visible !== false) || others[0];
    const pm = this.app.pm.show({
      title: 'Cloud to Cloud', iconName: 'cloud', values: { ref: first.id, maxDist: 20, model: 'plane', split: false },
      fields: [
        { type: 'info', text: `Compared: ${rec.name}` },
        { key: 'ref', type: 'select', label: 'Reference', options: others.map((r) => ({ value: r.id, label: r.name })) },
        { key: 'maxDist', type: 'number', label: 'Max. distance', unit: 'cm', min: 0.1, step: 5 },
        { key: 'model', type: 'select', label: 'Distance to', options: [{ value: 'plane', label: 'Local surface of the reference (best)' }, { value: 'nearest', label: 'Nearest reference point' }] },
        { key: 'split', type: 'check', label: 'Also X, Y, Z parts (c2c_x, c2c_y, c2c_z)' },
        { type: 'info', key: 'sign', text: '' },
        { type: 'info', text: 'Points farther than the max. distance get no value (grey).' }],
      onChange: (v) => upd(v),
      onOk: (v) => {
        const ref = others.find((r) => r.id === v.ref), L = this.layers.get(ref.id);
        if (!(v.maxDist > 0)) return false;
        const sp = Math.max(0.002, this.spacingEstimate(L));
        setTimeout(() => this.runAnalysis('c2c', { ref: { id: L.id, transform: ref.transform || null }, refName: ref.name, maxDist: v.maxDist / 100, model: v.model, k: 8, split: !!v.split, cell: Math.max(0.01, sp * 4) }, rec, `to ${nm(ref)}`));
        return true;
      },
    });
    const upd = (v) => { pm.inputs.sign.textContent = hasN(others.find((r) => r.id === v.ref)) ? 'The reference has normals: distances are signed (+ in front of, − behind its surface).' : 'Tip: run Normals on the reference first to get signed distances (+ / −).'; };
    upd(pm.values);
  }

  // ======================= Cloud to part =======================
  cmdC2M() {
    const rec = this.targets()[0];
    const tabs = (this.app.tabs || []).filter((t) => t.path && /\.lith(prt|asm)$/i.test(t.path));
    let mesh = null, file = tabs[0]?.path || null;
    const preview = new THREE.Group(); preview.matrixAutoUpdate = false; this.c2mPreview = preview;
    this.overlay.add(preview);
    const pm = this.app.pm.show({
      title: 'Cloud to Part', iconName: 'part', values: { file: file || '', dx: 0, dy: 0, dz: 0, rz: 0, maxDist: 10, signed: true },
      message: 'Tip: place the part exactly with Register → Align Part (point pairs + ICP). Move part below nudges it on top of that.',
      fields: [
        { type: 'info', text: `Scan: ${rec.name}` },
        ...(tabs.length ? [{ key: 'file', type: 'select', label: 'Open document', options: tabs.map((t) => ({ value: t.path, label: t.path.split(/[\\/]/).pop() })) }] : []),
        { type: 'buttons', buttons: [{ label: 'Choose part or assembly file…', icon: 'open', run: async () => { const f = await api.openFile({ filters: [{ name: 'Parts and assemblies', extensions: ['lithprt', 'lithasm', 'ekprt', 'ekasm'] }], noRead: true }); if (f) { file = f.path; await load(); } } }] },
        { type: 'info', key: 'pinfo', text: '' },
        { type: 'buttons', buttons: [{ label: 'Put part on the scan', icon: 'move', run: () => snap() }] },
        { type: 'group', label: 'Move part', fields: [{ key: 'dx', type: 'number', label: 'X', unit: 'm', step: 0.1 }, { key: 'dy', type: 'number', label: 'Y', unit: 'm', step: 0.1 }, { key: 'dz', type: 'number', label: 'Z', unit: 'm', step: 0.1 }, { key: 'rz', type: 'number', label: 'Around Z', unit: '°', step: 1 }] },
        { key: 'maxDist', type: 'number', label: 'Max. distance', unit: 'cm', min: 0.1, step: 5 },
        { key: 'signed', type: 'check', label: 'Signed (+ outside, − inside the part)' }],
      onChange: (v, key) => { if (key === 'file') { file = v.file; load(); } else place(v); },
      onOk: (v) => {
        if (!mesh) { pm.setMessage('Choose a part first', 'error'); return false; }
        if (!(v.maxDist > 0)) return false;
        const tris = this.partTriangles(mesh, this.partPlacement(mesh, v, file));
        cleanup();
        setTimeout(() => this.runAnalysis('c2m', { tris, maxDist: v.maxDist / 100, signed: !!v.signed, part: file.split(/[\\/]/).pop(), placement: { dx: v.dx, dy: v.dy, dz: v.dz, rz: v.rz } }, rec, `to ${file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')}`));
        return true;
      },
      onCancel: () => cleanup(),
    });
    const cleanup = () => { this.overlay.remove(preview); preview.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); this.vp.requestRender(); };
    // centre of the part on the centre of the scan (plan view), bottoms level
    const snap = () => {
      if (!mesh) return;
      const P = mesh.positions, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], B = this.partPlacement(mesh, {}, file), w = new THREE.Vector3();
      for (let i = 0; i < P.length; i += 3) { const q = w.set(...toDocFrame(P[i], P[i + 1], P[i + 2])).applyMatrix4(B).toArray(); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); } }
      const b = this.layers.get(rec.id).docBox();
      const d = { dx: (b.min.x + b.max.x) / 2 - (mn[0] + mx[0]) / 2, dy: (b.min.y + b.max.y) / 2 - (mn[1] + mx[1]) / 2, dz: b.min.z - mn[2] };
      for (const k of ['dx', 'dy', 'dz']) pm.setValue(k, +d[k].toFixed(4));
      place(pm.values);
    };
    const place = (v) => {
      if (!mesh) return;
      const M = this.partPlacement(mesh, v, file); // doc frame
      preview.matrix.copy(SCAN_TO_WORLD).multiply(M).multiply(new THREE.Matrix4().copy(SCAN_TO_WORLD).invert());
      preview.matrixWorldNeedsUpdate = true;
      this.vp.requestRender();
    };
    const load = async () => {
      if (!file) return;
      pm.inputs.pinfo.textContent = 'Loading part…';
      const r = await loadPart(file);
      if (r.err) { pm.inputs.pinfo.textContent = 'Cannot use this file: ' + r.err; mesh = null; return; }
      mesh = r.mesh; this.c2mMesh = mesh; // (tests)
      preview.clear();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      g.computeVertexNormals();
      preview.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xe0a030, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide })));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0xff8c00, depthTest: false, transparent: true }));
      edges.renderOrder = 10; preview.add(edges);
      const b = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position'));
      pm.inputs.pinfo.textContent = `${this.doc.partAlign?.[file] ? 'Aligned with Align Part. ' : ''}${file.split(/[\\/]/).pop()}: ${(mesh.indices.length / 3).toLocaleString()} triangles, ${fmt((b.max.x - b.min.x) / 1000, 2)} × ${fmt((b.max.z - b.min.z) / 1000, 2)} × ${fmt((b.max.y - b.min.y) / 1000, 2)} m`;
      place(pm.values);
    };
    if (file) load();
  }
  // placement of the part in the document frame (m, Z up): the saved alignment (Register tab, Align Part)
  // if any, then rotate around the part's centre and move
  partPlacement(mesh, v, file) {
    const saved = file && this.doc.partAlign?.[file];
    const B = saved ? new THREE.Matrix4().fromArray(saved) : new THREE.Matrix4(), P = mesh.positions, q = new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) { q.set(...toDocFrame(P[i], P[i + 1], P[i + 2])).applyMatrix4(B); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
    const R = new THREE.Matrix4().makeRotationZ(((v.rz || 0) * Math.PI) / 180);
    return new THREE.Matrix4().makeTranslation(c.x + (v.dx || 0), c.y + (v.dy || 0), v.dz || 0).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0)).multiply(B);
  }
  // triangles in the document frame (9 numbers per triangle, outward winding kept)
  partTriangles(mesh, M) {
    const P = mesh.positions, I = mesh.indices, out = new Float32Array(I.length * 3), v = new THREE.Vector3();
    for (let k = 0; k < I.length; k++) { const i = I[k] * 3; v.set(...toDocFrame(P[i], P[i + 1], P[i + 2])).applyMatrix4(M); out[k * 3] = v.x; out[k * 3 + 1] = v.y; out[k * 3 + 2] = v.z; }
    // the mm Y-up -> m Z-up change is a proper rotation, so the winding (outside) stays the same
    return out;
  }

  // ======================= result panel (tree) =======================
  analysisPanel(rec) {
    const a = rec.analysis, s = a?.stats;
    if (!s) return null;
    if (!s.n) return h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, `${OPS[a.op]}: ${a.field}`), h('div', { class: 'pm-msg error' }, 'No point is within the max. distance. Check the position of the part / reference or use a larger max. distance.'));
    const dist = DIST.has(a.op), U = dist ? 1000 : 1, unit = dist ? 'mm' : a.field === 'density' ? (a.params.kind === 'surface' ? '/m²' : a.params.kind === 'volume' ? '/m³' : '') : '';
    const v = (x, d = dist ? 1 : 3) => (x === x ? fmt(x * U, d) + (unit ? ' ' + unit : '') : '—');
    const wrap = h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, `${OPS[a.op]}: ${a.field}`));
    const ro = (k, val, tip) => h('div', { class: 'pp-row ro', title: tip || '' }, h('label', {}, k), h('span', {}, val));
    if (a.op === 'c2c') wrap.append(ro('Reference', a.params.refName || ''), ro('Distance to', a.params.model === 'plane' ? 'local surface' : 'nearest point'));
    if (a.op === 'c2m') wrap.append(ro('Part', a.params.part || ''));
    wrap.append(ro('Points with a value', `${s.n.toLocaleString()}${s.nan ? ` (${s.nan.toLocaleString()} without)` : ''}`),
      ro('Min / max', `${v(s.min)} / ${v(s.max)}`), ro('Mean', v(s.mean)));
    if (dist) wrap.append(ro('Mean |distance|', v(s.meanAbs)), ro('RMS', v(s.rms)));
    wrap.append(ro('Std. deviation (σ)', v(s.sd)));
    // histogram in the current colours
    const cv = h('canvas', { class: 'an-hist', width: 260, height: 70, style: { width: '100%', height: '70px', display: 'block', margin: '4px 0' } });
    wrap.append(h('div', { style: { margin: '2px 8px' } }, cv, h('div', { class: 'an-axis', style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.75 } }, h('span', {}, v(s.hist.lo)), h('span', {}, v(s.hist.hi)))));
    requestAnimationFrame(() => this.drawHist(cv, rec));
    // deviation view
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const set = (fn) => { fn(); this.layers.get(rec.id)?.applyStyle(); this.vp.requestRender(); this.app.setDirty(true); this.renderTree(); };
    if (dist) {
      const tol = h('input', { type: 'text', value: rec.tol > 0 && rec.tolFor === rec.colorMode ? fmt(rec.tol * 1000, 1) : '', placeholder: 'off' });
      tol.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') tol.blur(); });
      tol.addEventListener('change', () => set(() => { const t = parseFloat(tol.value.replace(',', '.')); if (t > 0) { rec.tol = t / 1000; rec.tolFor = 'field:' + a.field; rec.colorMode = 'field:' + a.field; } else delete rec.tol; }));
      wrap.append(field('Tolerance ± (mm)', tol));
      if (rec.tol > 0 && rec.tolFor === rec.colorMode) {
        const w = this.withinTol(s, rec.tol);
        wrap.append(h('div', { class: 'pm-info', style: { margin: '2px 8px' } }, `≈ ${fmt(w.in * 100, 1)}% within ±${fmt(rec.tol * 1000, 1)} mm (green) · ${fmt(w.above * 100, 1)}% above (red) · ${fmt(w.below * 100, 1)}% below (blue)`));
      }
    }
    const out = h('select', {}, [['end', 'Colour of the nearest end'], ['grey', 'Grey'], ['hide', 'Hidden']].map(([k, l]) => h('option', { value: k, selected: (rec.outside || 'end') === k }, l)));
    out.addEventListener('change', () => set(() => { rec.outside = out.value; }));
    wrap.append(field('Outside From…To', out));
    wrap.append(h('div', { class: 'pp-inline', style: { margin: '4px 8px' } },
      h('button', { class: 'mini txt', title: 'Colour scale from the minimum to the maximum value', onclick: () => set(() => { rec.colorMode = 'field:' + a.field; rec.range = [s.min, s.max]; rec.rangeFor = rec.colorMode; }) }, 'Full range'),
      dist ? h('button', { class: 'mini txt', title: 'Colour scale ±3σ around 0', onclick: () => set(() => { const m = 3 * Math.max(s.rms, 1e-6); rec.colorMode = 'field:' + a.field; rec.range = s.min < 0 ? [-m, m] : [0, m]; rec.rangeFor = rec.colorMode; }) }, '±3σ') : null,
      h('button', { class: 'mini txt', onclick: () => this.exportStats(rec) }, 'Statistics CSV…')));
    return wrap;
  }
  // share of points within / above / below ±tol, from the histogram (linear inside a bin)
  withinTol(s, tol) {
    const { lo, hi, bins } = s.hist, w = (hi - lo) / bins.length || 1;
    let inn = 0, above = 0, below = 0;
    bins.forEach((c, i) => {
      const a = lo + i * w, b = a + w;
      const part = (x0, x1) => Math.max(0, Math.min(b, x1) - Math.max(a, x0)) / w;
      inn += c * part(-tol, tol); above += c * part(tol, Infinity); below += c * part(-Infinity, -tol);
    });
    const n = Math.max(1, s.n);
    return { in: inn / n, above: above / n, below: below / n };
  }
  drawHist(cv, rec) {
    const s = rec.analysis.stats, { lo, hi, bins } = s.hist, ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, H = cv.height, mx = Math.max(1, ...bins), L = this.layers.get(rec.id);
    const rng = L?.rangeFor(rec.colorMode) || [lo, hi];
    const ramp = (t) => { t = t === t ? Math.max(0, Math.min(1, t)) : 0; const C = [[0.19, 0.07, 0.23], [0.12, 0.56, 0.95], [0.29, 0.85, 0.42], [0.98, 0.75, 0.17], [0.8, 0.16, 0.12]]; const k = Math.min(3, Math.floor(t * 4)), f = t * 4 - k; return `rgb(${C[k].map((c, i) => Math.round((c + (C[k + 1][i] - c) * f) * 255)).join(',')})`; };
    ctx.clearRect(0, 0, W, H);
    const bw = W / bins.length;
    bins.forEach((c, i) => {
      const x = lo + (i + 0.5) * ((hi - lo) / bins.length);
      let col = ramp((x - rng[0]) / ((rng[1] - rng[0]) || 1));
      if (rec.tol > 0 && rec.tolFor === rec.colorMode) col = Math.abs(x) <= rec.tol ? '#33bf4d' : x > 0 ? '#d9261f' : '#2666e6';
      const bh = Math.max(c ? 1 : 0, (Math.sqrt(c / mx)) * (H - 2));
      ctx.fillStyle = col; ctx.fillRect(i * bw, H - bh, Math.max(1, bw - 0.5), bh);
    });
  }
  async exportStats(rec = this.selRec()) {
    const a = rec?.analysis; if (!a) return;
    const s = a.stats, dist = DIST.has(a.op), U = dist ? 1000 : 1, unit = dist ? 'mm' : '';
    const c = (x) => (x === x ? fmt(x * U, 4).replace('.', ',') : '');
    const lines = [`Cloud;${rec.name}`, `Analysis;${OPS[a.op]}`, `Field;${a.field}`, `Unit;${unit}`];
    if (a.op === 'c2c') lines.push(`Reference;${a.params.refName || ''}`, `Distance to;${a.params.model === 'plane' ? 'local surface' : 'nearest point'}`);
    if (a.op === 'c2m') lines.push(`Part;${a.params.part || ''}`);
    if (a.params.maxDist) lines.push(`Max. distance;${c(a.params.maxDist)}`);
    lines.push(`Points with a value;${s.n}`, `Points without a value;${s.nan}`, `Min;${c(s.min)}`, `Max;${c(s.max)}`, `Mean;${c(s.mean)}`, `Mean abs;${c(s.meanAbs)}`, `RMS;${c(s.rms)}`, `Std. deviation;${c(s.sd)}`);
    if (rec.tol > 0) { const w = this.withinTol(s, rec.tol); lines.push(`Tolerance +-;${c(rec.tol)}`, `Within tolerance %;${fmt(w.in * 100, 2).replace('.', ',')}`, `Above %;${fmt(w.above * 100, 2).replace('.', ',')}`, `Below %;${fmt(w.below * 100, 2).replace('.', ',')}`); }
    lines.push('', 'Histogram', 'From;To;Points');
    const { lo, hi, bins } = s.hist, w = (hi - lo) / bins.length;
    bins.forEach((n, i) => lines.push(`${c(lo + i * w)};${c(lo + (i + 1) * w)};${n}`));
    const def = (this.app.path ? this.app.path.replace(/[^\\/]*$/, '') : '') + `${nm(rec)} statistics.csv`;
    const p = await api.saveFile({ defaultPath: def, filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }], text: '﻿' + lines.join('\r\n') + '\r\n' });
    if (p) toast(`Saved statistics to ${p.split(/[\\/]/).pop()}`, 'ok', 3000);
  }
}
