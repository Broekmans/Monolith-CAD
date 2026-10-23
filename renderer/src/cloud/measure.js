// Point Cloud document: point info + measurements (mixed into CloudDoc; `this` is the CloudDoc).
// Measurements are stored in doc.measures as absolute scan coordinates (m):
//   {id, type: 'distance'|'height'|'angle'|'poly', name, pts: [[x, y, z], ...], visible}
import * as THREE from 'three';
import { h, fmt, toast, contextMenu, promptText } from '../ui.js';
import { api } from '../api.js';
import { SCAN_TO_WORLD } from './layer.js';
import { opt } from '../app/options.js';

const TYPES = {
  distance: { label: 'Distance', n: 2, icon: 'dimension' },
  height: { label: 'Height', n: 2, icon: 'vertical' },
  angle: { label: 'Angle', n: 3, icon: 'dimAligned' },
  poly: { label: 'Polyline', n: Infinity, icon: 'polyline' },
};
const m3 = (v) => fmt(v, opt('pcMeasDec'));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

// values of a measurement: {main: text on the label, rows: [[label, value]], csv: {...}}
export function measureValues(m) {
  const p = m.pts;
  if (m.type === 'distance' && p.length >= 2) {
    const d = sub(p[1], p[0]);
    return { main: `${m3(len(d))} m`, rows: [['Distance', `${m3(len(d))} m`], ['Horizontal', `${m3(Math.hypot(d[0], d[1]))} m`], ['ΔX', `${m3(d[0])} m`], ['ΔY', `${m3(d[1])} m`], ['ΔZ', `${m3(d[2])} m`]], value: len(d), unit: 'm', d };
  }
  if (m.type === 'height' && p.length >= 2) {
    const dz = p[1][2] - p[0][2];
    return { main: `↕ ${m3(Math.abs(dz))} m`, rows: [['Height', `${m3(Math.abs(dz))} m`], ['From Z', `${m3(p[0][2])} m`], ['To Z', `${m3(p[1][2])} m`], ['Horizontal offset', `${m3(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]))} m`]], value: Math.abs(dz), unit: 'm', d: sub(p[1], p[0]) };
  }
  if (m.type === 'angle' && p.length >= 3) {
    const a = sub(p[0], p[1]), b = sub(p[2], p[1]);
    const ang = (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b) || 1)))) * 180) / Math.PI;
    const ad = opt('pcAngleDec');
    return { main: `${fmt(ang, ad)}°`, rows: [['Angle', `${fmt(ang, ad)}°`], ['Leg 1', `${m3(len(a))} m`], ['Leg 2', `${m3(len(b))} m`]], value: ang, unit: '°' };
  }
  if (m.type === 'poly' && p.length >= 2) {
    let L = 0, A = 0;
    for (let i = 1; i < p.length; i++) L += len(sub(p[i], p[i - 1]));
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; A += q[0] * r[1] - r[0] * q[1]; }
    A = Math.abs(A) / 2;
    const rows = [['Length', `${m3(L)} m`], ['Points', String(p.length)]];
    if (p.length >= 3) rows.push(['Area (plan, closed)', `${fmt(A, opt('pcAreaDec'))} m²`], ['Perimeter (closed)', `${m3(L + len(sub(p[0], p[p.length - 1])))} m`]);
    return { main: p.length >= 3 ? `${m3(L)} m · ${fmt(A, opt('pcAreaLabelDec'))} m²` : `${m3(L)} m`, rows, value: L, unit: 'm', area: A };
  }
  return { main: '', rows: [], value: 0, unit: '' };
}

// ---------------- the interactive tool ----------------
class MeasureTool {
  constructor(doc, type, onDone) {
    this.doc = doc; this.vp = doc.vp; this.type = type; this.onDone = onDone;
    this.pts = []; this.hover = null; this.raf = 0;
    this.draw = (ctx) => this.paint(ctx);
    this.vp.overlayDrawers.push(this.draw);
    const el = this.vp.el;
    this.onMove = (e) => {
      const r = el.getBoundingClientRect(); this.mouse = [e.clientX - r.left, e.clientY - r.top];
      if (e.buttons) return; // navigating
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.hover = this.doc.pickAt(...this.mouse); this.vp.requestRender(); this.doc.app.setCoords(this.hover ? this.doc.fmtAbs(this.hover.abs) : ''); });
    };
    this.onDown = (e) => {
      if (e.button !== 0 || e.altKey) return;
      const r = el.getBoundingClientRect();
      const hit = this.doc.pickAt(e.clientX - r.left, e.clientY - r.top);
      if (!hit) { this.doc.app.setStatus('No scan point under the cursor - click on a point of the cloud'); return; }
      this.click(hit);
    };
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    el.style.cursor = 'crosshair';
  }
  click(hit) {
    this.pts.push(hit.abs);
    if (this.type === 'info') { this.doc.showPointInfo(hit); this.pts = []; return; }
    if (this.pts.length >= TYPES[this.type].n) this.finish();
    this.vp.requestRender();
  }
  finish() {
    const need = this.type === 'poly' ? 2 : TYPES[this.type]?.n;
    if (this.pts.length >= need) this.onDone?.(this.type, this.pts.slice());
    this.pts = [];
    this.vp.requestRender();
  }
  onKey(e) {
    if (e.key === 'Enter' && this.type === 'poly') { this.finish(); return true; }
    if (e.key === 'Backspace') { this.pts.pop(); this.vp.requestRender(); return true; }
    return false;
  }
  onContext() { if (this.type === 'poly' && this.pts.length) { this.finish(); return true; } return false; }
  paint(ctx) {
    const S = (a) => this.doc.absToScreen(a);
    const pts = this.pts.map(S);
    ctx.strokeStyle = opt('pcPreviewColor'); ctx.lineWidth = opt('pcToolLineW'); ctx.setLineDash(opt('pcMeasDash'));
    if (pts.length) {
      ctx.beginPath(); ctx.moveTo(...pts[0]);
      for (const q of pts.slice(1)) ctx.lineTo(...q);
      if (this.hover) ctx.lineTo(...S(this.hover.abs));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = opt('pcPreviewColor');
    for (const q of pts) { ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcMeasPickedR'), 0, Math.PI * 2); ctx.fill(); }
    if (this.hover) {
      const q = S(this.hover.abs);
      ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcHoverRingR'), 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcHoverDotR'), 0, Math.PI * 2); ctx.fill();
      if (pts.length && this.type !== 'info') {
        const v = measureValues({ type: this.type, pts: [...this.pts, this.hover.abs] });
        const lo = opt('pcLiveLabelOff');
        if (v.main) this.doc.drawLabel(ctx, q[0] + lo, q[1] - lo, v.main, true);
      }
    }
  }
  dispose() {
    const el = this.vp.el;
    cancelAnimationFrame(this.raf);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerdown', this.onDown);
    el.style.cursor = '';
    this.vp.overlayDrawers = this.vp.overlayDrawers.filter((d) => d !== this.draw);
    this.doc.app.setCoords('');
    this.vp.requestRender();
  }
}

export class CloudMeasure {
  measureTab() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const can = () => !this.busy && this.layers.size > 0 && !(this.app.pm.open && !this.tool?.isMeasure);
    const act = (t) => () => this.tool?.isMeasure && this.tool.type === t;
    return { name: 'Measure', groups: [
      [C('pinfo', 'Point Info', 'point', () => this.cmdMeasure('info'), { enabled: can, active: act('info'), tip: 'Click a point to see its coordinates, colour, intensity and field values' })],
      [C('mdist', 'Distance', 'dimension', () => this.cmdMeasure('distance'), { enabled: can, active: act('distance'), tip: 'Distance between two scan points (with ΔX, ΔY, ΔZ)' }),
        C('mheight', 'Height', 'vertical', () => this.cmdMeasure('height'), { enabled: can, active: act('height'), tip: 'Vertical distance between two points, e.g. floor to ceiling' }),
        C('mangle', 'Angle', 'dimAligned', () => this.cmdMeasure('angle'), { enabled: can, active: act('angle'), tip: 'Angle at the middle one of three points' }),
        C('mpoly', 'Polyline', 'polyline', () => this.cmdMeasure('poly'), { enabled: can, active: act('poly'), tip: 'Length along several points and the enclosed area (plan view). Right click or Enter finishes' })],
      [C('mcsv', 'Export CSV', 'export', () => this.exportMeasures(), { enabled: () => (this.doc.measures || []).length > 0, tip: 'Save all measurements as a CSV file (opens in Excel)' })],
    ] };
  }
  // ---------- coordinates ----------
  absToScreen(a) {
    const o = this.doc.origin || [0, 0, 0];
    return this.vp.toScreen(new THREE.Vector3(a[0] - o[0], a[1] - o[1], a[2] - o[2]).applyMatrix4(SCAN_TO_WORLD));
  }
  fmtAbs(a) { return `X ${m3(a[0])}  Y ${m3(a[1])}  Z ${m3(a[2])}`; }
  // nearest scan point over all visible clouds
  pickAt(sx, sy) {
    let best = null;
    for (const l of this.layers.values()) {
      const r = l.pickNear(this.vp, sx, sy);
      if (!r) continue;
      const front = r.px <= opt('pcPickFrontPx');
      if (!best || (front && (!best.front || r.depth < best.r.depth)) || (!front && !best.front && r.px < best.r.px)) best = { r, front };
    }
    if (!best) return null;
    const o = this.doc.origin, d = best.r.doc;
    return { ...best.r, abs: [d[0] + o[0], d[1] + o[1], d[2] + o[2]] };
  }

  // ---------- tool ----------
  cmdMeasure(type) {
    if (this.tool?.isMeasure && this.tool.type === type) { this.app.pm.close(false); this.endTool(); return; }
    this.app.pm.close(false); this.endTool();
    const t = new MeasureTool(this, type, (ty, pts) => this.addMeasure(ty, pts));
    t.isMeasure = true;
    this.tool = t;
    const help = type === 'info' ? 'Click on a scan point.' : type === 'poly' ? 'Click points; right click or Enter finishes. Backspace removes the last point.' : `Click ${TYPES[type].n} scan points.`;
    this.app.pm.show({
      title: type === 'info' ? 'Point Info' : `Measure ${TYPES[type].label}`, iconName: type === 'info' ? 'point' : TYPES[type].icon,
      message: help + ' The cursor snaps to the nearest scan point. Esc ends the tool.',
      fields: [{ type: 'info', key: 'res', text: type === 'info' ? 'No point picked yet.' : 'Measurements are added to the tree under Measurements.' }],
      onCancel: () => this.endTool(),
    });
    this.app.cm.refresh();
  }
  addMeasure(type, pts) {
    this.doc.measures ||= [];
    this.pushUndo();
    const n = this.doc.measures.filter((m) => m.type === type).length + 1;
    const m = { id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), type, name: `${TYPES[type].label} ${n}`, pts, visible: true };
    this.doc.measures.push(m);
    this.selMeasure = m.id;
    const v = measureValues(m);
    this.app.setStatus(`${m.name}: ${v.rows.map((r) => r.join(' ')).join(' · ')}`);
    const res = this.app.pm.current?.inputs?.res;
    if (res) res.textContent = `${m.name}: ${v.rows.map((r) => r.join(' ')).join(', ')}`;
    this.app.setDirty(true);
    this.renderTree();
    this.vp.requestRender();
  }
  async showPointInfo(hit) {
    const L = hit.layer;
    let info = null;
    try { info = await api.cloudPoint(L.id, hit.node, hit.i); } catch { /* ignore */ }
    this.lastPoint = { abs: hit.abs, info, cloud: L.rec.name };
    const res = this.app.pm.current?.inputs?.res;
    if (!res) return;
    res.innerHTML = '';
    const rows = [['Cloud', L.rec.name], ['X', m3(hit.abs[0])], ['Y', m3(hit.abs[1])], ['Z', m3(hit.abs[2])]];
    if (info) {
      if (info.rgb) rows.push(['RGB', info.rgb.join(', ')]);
      if (L.meta.attrs.intensity) rows.push(['Intensity', String(info.intensity)]);
      if (L.meta.attrs.classification) rows.push(['Classification', String(info.classification)]);
      for (const [k, v] of Object.entries(info.fields)) rows.push([k, fmt(v, opt('pcFieldDec'))]);
    }
    res.appendChild(h('table', { class: 'mass' }, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))));
    if (info?.rgb) res.appendChild(h('div', { style: { height: '14px', margin: '4px 0', borderRadius: '3px', background: `rgb(${info.rgb.join(',')})` } }));
    this.app.setStatus(`${L.rec.name}: ${this.fmtAbs(hit.abs)}`);
  }

  // ---------- drawing (overlay) ----------
  drawLabel(ctx, x, y, text, live = false) {
    ctx.font = opt('pcLabelFont');
    const pad = opt('pcLabelPad'), H = opt('pcLabelH'), hh = H / 2;
    const w = ctx.measureText(text).width + pad;
    // step aside from labels already drawn in this frame
    if (this._labels && !live) {
      for (let k = 0; k < opt('pcLabelTries') && this._labels.some((r) => x < r[0] + r[2] && x + w > r[0] && y - hh < r[1] + hh && y + hh > r[1] - hh); k++) y += opt('pcLabelStep');
      this._labels.push([x, y, w]);
    }
    ctx.fillStyle = live ? opt('pcLiveLabelFill') : opt('pcLabelFill');
    ctx.strokeStyle = live ? opt('pcLiveLabelEdge') : opt('pcMeasColor');
    ctx.lineWidth = opt('pcLabelLineW');
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y - hh, w, H, opt('pcLabelR')) : ctx.rect(x, y - hh, w, H); ctx.fill(); ctx.stroke();
    ctx.fillStyle = live ? opt('pcLiveLabelText') : opt('pcLabelText'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad / 2, y + 0.5);
  }
  drawMeasures(ctx) {
    this._labels = [];
    for (const m of this.doc.measures || []) {
      if (m.visible === false) continue;
      const S = (a) => this.absToScreen(a);
      const sel = this.selMeasure === m.id;
      ctx.strokeStyle = sel ? opt('pcSelColor') : opt('pcMeasColor'); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = sel ? opt('pcMeasSelLineW') : opt('pcMeasLineW');
      const p = m.pts.map(S);
      let lab;
      if (m.type === 'height') {
        const q = S([m.pts[0][0], m.pts[0][1], m.pts[1][2]]);
        ctx.beginPath(); ctx.moveTo(...p[0]); ctx.lineTo(...q); ctx.stroke();
        ctx.setLineDash(opt('pcMeasHeightDash')); ctx.beginPath(); ctx.moveTo(...q); ctx.lineTo(...p[1]); ctx.stroke(); ctx.setLineDash([]);
        lab = [(p[0][0] + q[0]) / 2, (p[0][1] + q[1]) / 2];
      } else {
        ctx.beginPath(); ctx.moveTo(...p[0]); for (const q of p.slice(1)) ctx.lineTo(...q); ctx.stroke();
        if (m.type === 'poly' && p.length >= 3) { ctx.setLineDash(opt('pcMeasCloseDash')); ctx.beginPath(); ctx.moveTo(...p[p.length - 1]); ctx.lineTo(...p[0]); ctx.stroke(); ctx.setLineDash([]); }
        lab = m.type === 'angle' ? p[1] : m.type === 'poly' ? p[p.length - 1] : [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
      }
      for (const q of p) { ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcMeasDotR'), 0, Math.PI * 2); ctx.fill(); }
      const lo = opt('pcMeasLabelOff');
      this.drawLabel(ctx, lab[0] + lo[0], lab[1] + lo[1], `${m.name}: ${measureValues(m).main}`);
    }
  }

  // ---------- tree + panel ----------
  measureRows(row) {
    const list = this.doc.measures || [];
    if (!list.length) return [];
    const out = [row({ icon: 'measure', label: `Measurements (${list.length})` })];
    for (const m of list) {
      out.push(row({
        icon: TYPES[m.type]?.icon || 'measure', depth: 1, label: `${m.name}: ${measureValues(m).main}`, sel: this.selMeasure === m.id, dim: m.visible === false,
        eye: m.visible !== false, onEye: () => { m.visible = m.visible === false; this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); },
        onClick: () => { this.selMeasure = this.selMeasure === m.id ? null : m.id; this.renderTree(); this.vp.requestRender(); },
        onDbl: () => this.zoomToMeasure(m),
        onMenu: (e) => { this.selMeasure = m.id; this.renderTree(); this.vp.requestRender(); contextMenu(e.clientX, e.clientY, [
          { label: 'Zoom to', run: () => this.zoomToMeasure(m) },
          { label: 'Rename…', run: async () => { const n = await promptText('Measurement name', m.name); if (n) { this.pushUndo(); m.name = n; this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); } } },
          { label: 'Delete', run: () => this.deleteMeasure(m.id) },
          { label: 'Delete all measurements', run: () => { this.pushUndo(); this.doc.measures = []; this.selMeasure = null; this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); } }]); },
      }));
    }
    return out;
  }
  measurePanel() {
    const m = (this.doc.measures || []).find((x) => x.id === this.selMeasure);
    if (!m) return null;
    const v = measureValues(m);
    return h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, m.name),
      ...v.rows.map(([k, val]) => h('div', { class: 'pp-row ro' }, h('label', {}, k), h('span', {}, val))),
      ...m.pts.map((p, i) => h('div', { class: 'pp-row ro' }, h('label', {}, `Point ${i + 1}`), h('span', {}, `${m3(p[0])}, ${m3(p[1])}, ${m3(p[2])}`))));
  }
  deleteMeasure(id) { this.pushUndo(); this.doc.measures = (this.doc.measures || []).filter((x) => x.id !== id); if (this.selMeasure === id) this.selMeasure = null; this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); }
  zoomToMeasure(m) {
    const o = this.doc.origin, b = new THREE.Box3();
    for (const p of m.pts) b.expandByPoint(new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2]).applyMatrix4(SCAN_TO_WORLD));
    b.expandByScalar(Math.max(opt('pcZoomMinMargin'), b.getSize(new THREE.Vector3()).length() * opt('pcZoomMarginK')));
    this.vp.fit(b); this.scheduleLOD();
  }
  async exportMeasures() {
    const list = this.doc.measures || [];
    if (!list.length) return;
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const c = (v) => fmt(v, opt('pcCsvDec')).replace('.', ','); // Dutch Excel: ';' separates, ',' is the decimal sign
    const lines = ['Name;Type;Value;Unit;dX;dY;dZ;Horizontal;Area m2;Points (X Y Z)'];
    for (const m of list) {
      const v = measureValues(m), d = v.d;
      lines.push([q(m.name), TYPES[m.type].label, c(v.value), v.unit, d ? c(d[0]) : '', d ? c(d[1]) : '', d ? c(d[2]) : '', d ? c(Math.hypot(d[0], d[1])) : '', v.area != null ? c(v.area) : '',
        q(m.pts.map((p) => p.map((x) => x.toFixed(opt('pcCsvDec')).replace('.', ',')).join(' ')).join(' | '))].join(';'));
    }
    const def = (this.app.path ? this.app.path.replace(/\.[^.\\/]+$/, '') : this.doc.name) + ' measurements.csv';
    const p = await api.saveFile({ defaultPath: def, filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }], text: '﻿' + lines.join('\r\n') + '\r\n' });
    if (p) toast(`Saved ${list.length} measurements to ${p.split(/[\\/]/).pop()}`, 'ok', opt('pcToastOkMs'));
  }
}
