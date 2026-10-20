// Interactive tools of the Point Cloud document: polygon (Segment) and crop box.
// Coordinates: "doc frame" = scan units (m, Z up) relative to the document origin; world = SCAN_TO_WORLD * doc.
import * as THREE from 'three';
import { SCAN_TO_WORLD } from './layer.js';

const docToWorld = (p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(SCAN_TO_WORLD);

// ---------------- polygon ----------------
// Left click adds a point, right click / Enter / double click closes, Backspace removes the last point, Esc cancels.
export class PolygonTool {
  constructor(doc, onClose) {
    this.doc = doc; this.vp = doc.vp; this.onClose = onClose;
    this.pts = []; this.hover = null; this.closed = false;
    this.draw = (ctx) => this.paint(ctx);
    this.vp.overlayDrawers.push(this.draw);
    const el = this.vp.el;
    this.onDown = (e) => {
      if (e.button !== 0 || e.altKey || this.closed) return;
      const r = el.getBoundingClientRect();
      const p = [e.clientX - r.left, e.clientY - r.top];
      const last = this.pts[this.pts.length - 1];
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 3) return; // double click
      this.pts.push(p); this.vp.requestRender();
    };
    this.onMove = (e) => { const r = el.getBoundingClientRect(); this.hover = [e.clientX - r.left, e.clientY - r.top]; if (!this.closed) this.vp.requestRender(); };
    this.onDbl = () => this.close();
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('dblclick', this.onDbl);
    el.style.cursor = 'crosshair';
  }
  onKey(e) {
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Backspace') { this.pts.pop(); this.vp.requestRender(); return true; }
    return false;
  }
  onContext() { this.close(); return true; }
  close() {
    if (this.closed) return;
    if (this.pts.length < 3) { this.doc.app.setStatus('Draw at least 3 points (left click), then right click to close'); return; }
    this.closed = true;
    // freeze the view: polygon in NDC + matrix doc frame -> NDC at this moment
    const vp = this.vp, cam = vp.camera;
    cam.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(SCAN_TO_WORLD);
    this.mat = m.elements.slice();
    this.ndc = this.pts.flatMap(([x, y]) => [(x / vp.width) * 2 - 1, 1 - (y / vp.height) * 2]);
    this.vp.el.style.cursor = '';
    this.vp.requestRender();
    this.onClose?.(this);
  }
  paint(ctx) {
    const p = this.pts;
    if (!p.length) return;
    ctx.lineWidth = 1.6;
    // closed fence = selected (blue), still drawing = will be (orange) (0.1.99)
    ctx.strokeStyle = this.closed ? '#1e90ff' : '#ff8a00';
    ctx.fillStyle = this.closed ? 'rgba(30,144,255,0.10)' : 'rgba(255,138,0,0.10)';
    ctx.setLineDash(this.closed ? [] : [6, 4]);
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]);
    if (!this.closed && this.hover) ctx.lineTo(this.hover[0], this.hover[1]);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    for (const q of p) ctx.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5);
  }
  dispose() {
    const el = this.vp.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('dblclick', this.onDbl);
    el.style.cursor = '';
    this.vp.overlayDrawers = this.vp.overlayDrawers.filter((d) => d !== this.draw);
    this.vp.requestRender();
  }
}

// ---------------- crop box ----------------
// box = {min, max} in the doc frame. Drag the square handles on the 6 faces to resize.
export class BoxTool {
  constructor(doc, box, onChange) {
    this.doc = doc; this.vp = doc.vp; this.box = box; this.onChange = onChange;
    this.draw = (ctx) => this.paint(ctx);
    this.vp.overlayDrawers.push(this.draw);
    const el = this.vp.el;
    this.onDown = (e) => {
      if (e.button !== 0 || e.altKey) return;
      const r = el.getBoundingClientRect();
      const m = [e.clientX - r.left, e.clientY - r.top];
      const h = this.handles().find((q) => Math.hypot(q.s[0] - m[0], q.s[1] - m[1]) < 9);
      if (!h) return;
      e.stopPropagation(); e.preventDefault();
      el.setPointerCapture(e.pointerId);
      // screen direction of the handle's axis (px per scan unit)
      const a = this.vp.toScreen(docToWorld(h.p)), b = this.vp.toScreen(docToWorld(h.p.map((v, i) => v + (i === h.axis ? 1 : 0))));
      const dir = [b[0] - a[0], b[1] - a[1]], len2 = dir[0] * dir[0] + dir[1] * dir[1];
      if (len2 < 1e-6) return; // looking along the axis
      this.drag = { h, start: m, v0: this.box[h.side][h.axis], dir, len2 };
    };
    this.onMove = (e) => {
      if (!this.drag) return;
      const r = el.getBoundingClientRect();
      const m = [e.clientX - r.left, e.clientY - r.top], d = this.drag;
      const t = ((m[0] - d.start[0]) * d.dir[0] + (m[1] - d.start[1]) * d.dir[1]) / d.len2;
      let v = d.v0 + t;
      const other = this.box[d.h.side === 'min' ? 'max' : 'min'][d.h.axis];
      v = d.h.side === 'min' ? Math.min(v, other - 1e-3) : Math.max(v, other + 1e-3);
      this.box[d.h.side][d.h.axis] = Math.round(v * 1000) / 1000;
      this.onChange?.(this.box);
      this.vp.requestRender();
    };
    this.onUp = () => { this.drag = null; };
    el.addEventListener('pointerdown', this.onDown, true);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
  }
  handles() {
    const { min, max } = this.box, c = min.map((v, i) => (v + max[i]) / 2), out = [];
    for (let axis = 0; axis < 3; axis++) for (const side of ['min', 'max']) {
      const p = c.slice(); p[axis] = this.box[side][axis];
      out.push({ axis, side, p, s: this.vp.toScreen(docToWorld(p)) });
    }
    return out;
  }
  paint(ctx) {
    const { min, max } = this.box;
    const C = (i) => this.vp.toScreen(docToWorld([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]));
    const P = Array.from({ length: 8 }, (_, i) => C(i));
    ctx.strokeStyle = '#1e90ff'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) for (const b of [1, 2, 4]) if (!(i & b)) { ctx.moveTo(...P[i]); ctx.lineTo(...P[i | b]); }
    ctx.stroke();
    const col = ['#d03030', '#20a020', '#2050d0'];
    for (const h of this.handles()) { ctx.fillStyle = col[h.axis]; ctx.fillRect(h.s[0] - 5, h.s[1] - 5, 10, 10); ctx.strokeStyle = '#fff'; ctx.strokeRect(h.s[0] - 5, h.s[1] - 5, 10, 10); }
  }
  dispose() {
    const el = this.vp.el;
    el.removeEventListener('pointerdown', this.onDown, true);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    this.vp.overlayDrawers = this.vp.overlayDrawers.filter((d) => d !== this.draw);
    this.vp.requestRender();
  }
}
