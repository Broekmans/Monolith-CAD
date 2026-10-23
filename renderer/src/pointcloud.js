// Point clouds (LAS/LAZ/PLY/XYZ/PTS) as reference geometry in parts and plans.
// The file stays on disk; the document stores its path and display settings.
import * as THREE from 'three';
import { api } from './api.js';
import { h, dialog, toast, fmt, evalNumber } from './ui.js';
import { opt } from './app/options.js';

export const PC_EXTS = ['las', 'laz', 'ply', 'xyz', 'pts', 'txt', 'csv'];
export const isPointCloud = (path) => PC_EXTS.includes(String(path).split('.').pop().toLowerCase());

const UNITS = { m: { label: 'Meters', scale: 1000 }, mm: { label: 'Millimeters', scale: 1 }, cm: { label: 'Centimeters', scale: 10 }, ft: { label: 'International feet', scale: 304.8 }, usft: { label: 'US survey feet', scale: 1200000 / 3937 } };

// ---------------- import dialog ----------------
export async function askImportOptions(path) {
  const info = await api.pcInfo(path);
  const name = path.split(/[\\/]/).pop();
  const span = [0, 1, 2].map((d) => info.max[d] - info.min[d]);
  // Scans are almost always in meters; small spans in mm-sized numbers suggest millimeters.
  const guessUnits = Math.max(...span) > opt('pcUnitGuessSpan') ? 'mm' : 'm';
  const big = info.min.some((v) => Math.abs(v) > opt('pcBigCoord'));
  const unitsSel = h('select', {}, Object.entries(UNITS).map(([k, u]) => h('option', { value: k, selected: k === guessUnits }, u.label)));
  const shiftSel = h('select', {},
    h('option', { value: 'min', selected: true }, 'Move scan to origin (recommended)'),
    h('option', { value: 'none' }, 'Keep original coordinates'));
  const maxIn = h('input', { type: 'text', value: String(Math.min(info.count, opt('pcImportMaxPts'))), class: 'dlg-input' });
  const row = (k, v) => h('tr', {}, h('td', {}, k), h('td', {}, v));
  const body = h('div', { class: 'pc-dlg' },
    h('table', { class: 'mass' },
      row('File', name), row('Format', info.format), row('Points', info.count.toLocaleString()),
      row('Colors', info.hasColor ? 'RGB' : 'none (colored by elevation)'),
      row('Extent', `${span.map((v) => fmt(v, opt('pcSizeDec'))).join(' × ')} (file units)`),
      row('Lower corner', info.min.map((v) => fmt(v, opt('pcCoordDec'))).join(', ')),
      info.system ? row('Created by', info.system) : null),
    h('div', { class: 'pp-row' }, h('label', {}, 'File units'), unitsSel),
    h('div', { class: 'pp-row' }, h('label', {}, 'Position'), shiftSel),
    h('div', { class: 'pp-row' }, h('label', {}, 'Max. points shown'), maxIn),
    big ? h('p', { class: 'muted' }, 'The scan uses large (georeferenced) coordinates. Moving it to the origin keeps full precision; the offset is stored so measurements stay true to the original.') : null);
  const r = await dialog({ title: 'Import Point Cloud', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Import', primary: true, value: 'ok' }] });
  if (r !== 'ok') return null;
  const units = unitsSel.value;
  const shift = shiftSel.value === 'min' ? info.min.map((v) => Math.floor(v)) : [0, 0, 0];
  return {
    id: 'pc' + Date.now().toString(36), name, path, units, scale: UNITS[units].scale, shift,
    maxPoints: Math.max(opt('pcImportMinPts'), Math.round(evalNumber(maxIn.value) || opt('pcImportMaxPts'))), count: info.count,
    visible: true, pointSize: opt('cloudPointSize'), colorMode: info.hasColor ? 'rgb' : 'elevation', clip: { on: false, min: opt('pcPartClipFrom'), max: opt('pcPartClipTo') },
  };
}

// ---------------- loading ----------------
export async function loadCloud(rec, onProgress) {
  const off = api.onPcProgress((p) => onProgress?.(p));
  try {
    return await api.pcLoad({ path: rec.path, maxPoints: rec.maxPoints, shift: rec.shift, scale: rec.scale });
  } finally { off?.(); }
}

// ---------------- rendering ----------------
const VERT = `
attribute vec3 ccolor;
attribute float intensity;
uniform float size;
uniform int mode;
uniform float hMin, hMax, iMax;
uniform vec3 single;
uniform float clipOn, clipMin, clipMax;
varying vec3 vC;
varying float vClip;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.19, 0.07, 0.23), b = vec3(0.12, 0.56, 0.95), c = vec3(0.29, 0.85, 0.42), d = vec3(0.98, 0.75, 0.17), e = vec3(0.80, 0.16, 0.12);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size;
  float hh = position.y;
  vClip = (clipOn > 0.5 && (hh < clipMin || hh > clipMax)) ? 1.0 : 0.0;
  if (mode == 0) vC = ccolor;
  else if (mode == 1) vC = ramp((hh - hMin) / max(1e-6, hMax - hMin));
  else if (mode == 2) vC = vec3(clamp(intensity / max(1.0, iMax), 0.0, 1.0));
  else vC = single;
}`;
const FRAG = `
varying vec3 vC;
varying float vClip;
void main() {
  if (vClip > 0.5) discard;
  gl_FragColor = vec4(vC, 1.0);
}`;
const MODES = { rgb: 0, elevation: 1, intensity: 2, single: 3 };

export class CloudView {
  constructor(rec, data) {
    this.rec = rec;
    this.data = data;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    const col = data.colors ? new THREE.BufferAttribute(data.colors, 3, true) : new THREE.BufferAttribute(new Uint8Array(data.positions.length), 3, true);
    g.setAttribute('ccolor', col);
    g.setAttribute('intensity', new THREE.BufferAttribute(new Float32Array(data.intensity), 1));
    g.computeBoundingBox();
    this.geometry = g;
    this.box = g.boundingBox.clone();
    let iMax = 1; for (let i = 0, st = opt('pcIntensityStep'); i < data.intensity.length; i += st) if (data.intensity[i] > iMax) iMax = data.intensity[i];
    this.iMax = iMax;
    this.objects = [];
    this.grid = null;
  }
  material() {
    const r = this.rec;
    return new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        size: { value: r.pointSize || opt('pcPointSizeFallback') }, mode: { value: this.data.colors || r.colorMode !== 'rgb' ? MODES[r.colorMode] ?? 1 : 1 },
        hMin: { value: this.box.min.y }, hMax: { value: this.box.max.y }, iMax: { value: this.iMax },
        single: { value: new THREE.Color(opt('pcPartSingleColor')) },
        clipOn: { value: r.clip?.on ? 1 : 0 }, clipMin: { value: r.clip?.min ?? 0 }, clipMax: { value: r.clip?.max ?? 0 },
      },
    });
  }
  // Add a Points object for a scene (one per viewport/scene).
  attach(scene) {
    const p = new THREE.Points(this.geometry, this.material());
    p.frustumCulled = false;
    p.visible = this.rec.visible !== false;
    p.renderOrder = -1;
    scene.add(p);
    this.objects.push(p);
    return p;
  }
  // Apply current record settings to all attached objects.
  refresh() {
    const r = this.rec;
    for (const o of this.objects) {
      const u = o.material.uniforms;
      u.size.value = r.pointSize || opt('pcPointSizeFallback');
      u.mode.value = !this.data.colors && r.colorMode === 'rgb' ? 1 : MODES[r.colorMode] ?? 1;
      u.clipOn.value = r.clip?.on ? 1 : 0; u.clipMin.value = r.clip?.min ?? 0; u.clipMax.value = r.clip?.max ?? 0;
      o.visible = r.visible !== false;
    }
    this.grid = null;
  }
  dispose() {
    for (const o of this.objects) { o.parent?.remove(o); o.material.dispose(); }
    this.objects = [];
    this.geometry.dispose();
  }

  // ---- plan snapping: nearest visible point in plan (x, y) ----
  buildGrid() {
    const pos = this.data.positions, r = this.rec;
    const n = pos.length / 3;
    const b = this.box;
    const cell = Math.max(opt('pcSnapGridMin'), Math.sqrt(((b.max.x - b.min.x) * (b.max.z - b.min.z)) / Math.max(1, n)) * opt('pcSnapGridK'));
    const grid = new Map(), maxPts = opt('pcSnapGridMaxPts');
    const step = n > maxPts ? Math.ceil(n / maxPts) : 1;
    for (let i = 0; i < n; i += step) {
      const y = pos[i * 3 + 1];
      if (r.clip?.on && (y < r.clip.min || y > r.clip.max)) continue;
      const px = pos[i * 3], py = -pos[i * 3 + 2];
      const k = Math.floor(px / cell) + ',' + Math.floor(py / cell);
      let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
    }
    this.grid = { cell, map: grid };
  }
  nearestPlan(p, thr) {
    if (this.rec.visible === false) return null;
    if (!this.grid) this.buildGrid();
    const { cell, map } = this.grid, pos = this.data.positions;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), rr = Math.ceil(thr / cell);
    let best = null, bd = thr;
    for (let i = cx - rr; i <= cx + rr; i++) for (let j = cy - rr; j <= cy + rr; j++) {
      const a = map.get(i + ',' + j); if (!a) continue;
      for (const k of a) { const d = Math.hypot(pos[k * 3] - p[0], -pos[k * 3 + 2] - p[1]); if (d < bd) { bd = d; best = [pos[k * 3], -pos[k * 3 + 2]]; } }
    }
    return best;
  }
}

// ---------------- properties panel ----------------
export function cloudPanel(rec, view, { onChange, onRemove, onZoom, onReload }) {
  const wrap = h('div', { class: 'pc-panel' });
  const set = (fn) => { fn(); view?.refresh(); onChange?.(); };
  const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
  const num = (val, fn) => { const i = h('input', { type: 'text', value: fmt(val, opt('pcInputDec')) }); i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); }); i.addEventListener('change', () => { const v = evalNumber(i.value); if (v !== null) set(() => fn(v)); }); return i; };
  const vis = h('input', { type: 'checkbox', checked: rec.visible !== false });
  vis.addEventListener('change', () => set(() => { rec.visible = vis.checked; }));
  const mode = h('select', {}, [['rgb', 'Scan colors (RGB)'], ['elevation', 'Elevation'], ['intensity', 'Intensity'], ['single', 'Single color']].map(([v, l]) => h('option', { value: v, selected: rec.colorMode === v }, l)));
  mode.addEventListener('change', () => set(() => { rec.colorMode = mode.value; }));
  const [psMin, psMax, psStep] = opt('pcPointSizeSlider');
  const size = h('input', { type: 'range', min: psMin, max: psMax, step: psStep, value: rec.pointSize || opt('pcPointSizeFallback') });
  size.addEventListener('input', () => set(() => { rec.pointSize = +size.value; }));
  const clipOn = h('input', { type: 'checkbox', checked: !!rec.clip?.on });
  clipOn.addEventListener('change', () => set(() => { rec.clip = { ...(rec.clip || {}), on: clipOn.checked }; }));
  const box = view?.box;
  wrap.append(...[
    h('div', { class: 'pp-type' }, rec.name),
    field('Visible', vis), field('Color', mode), field('Point size', size),
    h('div', { class: 'sp-sec' }, 'Height section'),
    h('label', { class: 'pm-check' }, clipOn, 'Show only points between'),
    field('From height', num(rec.clip?.min ?? opt('pcPartClipFrom'), (v) => { rec.clip = { ...(rec.clip || {}), min: v }; })),
    field('To height', num(rec.clip?.max ?? opt('pcPartClipTo'), (v) => { rec.clip = { ...(rec.clip || {}), max: v }; })),
    box ? h('div', { class: 'pp-inline', style: { margin: '4px 8px' } },
      h('button', { class: 'mini txt', onclick: () => set(() => { rec.clip = { on: true, min: box.min.y + opt('pcSliceFrom') * 1000, max: box.min.y + opt('pcSliceTo') * 1000 }; }), title: `Horizontal slice ${opt('pcSliceFrom').toFixed(1)}–${opt('pcSliceTo').toFixed(1)} m above the lowest point, for tracing walls` }, 'Floor plan slice'),
      h('button', { class: 'mini txt', onclick: () => set(() => { rec.clip = { on: false, min: box.min.y, max: box.max.y }; }) }, 'Show all')) : null,
    h('div', { class: 'sp-sec' }, 'Source'),
    h('div', { class: 'pp-row ro' }, h('label', {}, 'File'), h('span', { title: rec.path }, rec.path.split(/[\\/]/).pop())),
    h('div', { class: 'pp-row ro' }, h('label', {}, 'Points'), h('span', {}, `${(view?.data.kept ?? 0).toLocaleString()} shown of ${(rec.count || 0).toLocaleString()}`)),
    h('div', { class: 'pp-row ro' }, h('label', {}, 'Units'), h('span', {}, UNITS[rec.units]?.label || rec.units)),
    h('div', { class: 'pp-row ro' }, h('label', {}, 'Offset'), h('span', {}, rec.shift.map((v) => fmt(v, opt('pcCoordDec'))).join(', '))),
    box ? h('div', { class: 'pp-row ro' }, h('label', {}, 'Size (mm)'), h('span', {}, `${fmt(box.max.x - box.min.x, opt('pcSizeMmDec'))} × ${fmt(box.max.z - box.min.z, opt('pcSizeMmDec'))} × ${fmt(box.max.y - box.min.y, opt('pcSizeMmDec'))}`)) : null,
    !view ? h('div', { class: 'pm-msg error' }, 'File not loaded — it may have been moved. Use Reload after restoring it.') : null,
    h('div', { class: 'pp-inline', style: { margin: '10px 8px' } },
      h('button', { class: 'mini txt', onclick: onZoom }, 'Zoom to'),
      h('button', { class: 'mini txt', onclick: onReload }, 'Reload'),
      h('button', { class: 'mini txt', onclick: onRemove }, 'Remove'))].filter(Boolean));
  return wrap;
}

// Shared manager used by both document types.
export class CloudManager {
  constructor(app, getList, scenesFn, onChanged) {
    this.app = app;
    this.getList = getList;
    this.scenesFn = scenesFn;
    this.onChanged = onChanged;
    this.views = new Map();
  }
  async loadAll() { for (const rec of this.getList()) await this.load(rec); }
  async load(rec) {
    this.views.get(rec.id)?.dispose();
    this.views.delete(rec.id);
    this.app.setBusy(true);
    const label = this.app.el.status;
    try {
      const data = await loadCloud(rec, (p) => this.app.setStatus(`Loading ${rec.name}… ${Math.round(p * 100)}%`));
      const view = new CloudView(rec, data);
      for (const s of this.scenesFn()) view.attach(s);
      this.views.set(rec.id, view);
      this.app.setStatus(`${rec.name}: ${data.kept.toLocaleString()} points shown`);
      this.onChanged?.();
      return view;
    } catch (e) {
      toast(`Could not load point cloud ${rec.name}: ${e.message}`, 'error', opt('toastWarnMs'));
      this.app.setStatus('Ready');
      return null;
    } finally { this.app.setBusy(false); void label; }
  }
  remove(id) { this.views.get(id)?.dispose(); this.views.delete(id); }
  box() {
    const b = new THREE.Box3();
    for (const [id, v] of this.views) if (this.getList().find((r) => r.id === id)?.visible !== false) b.union(v.box);
    return b;
  }
  dispose() { for (const v of this.views.values()) v.dispose(); this.views.clear(); }
}
