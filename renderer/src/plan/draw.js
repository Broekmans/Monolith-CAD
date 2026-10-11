// Plan: canvas drawing
// Methods are mixed into PlanDoc (see plan.js); `this` is the PlanDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, promptText, evalNumber } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import * as G from './planGeom.js';
const { dist, add, sub, mul, lerp } = G;
import { parseDxf, planToDxf } from '../io/dxf.js';
import { circleFrom3, cross2 } from '../sketch/geom2d.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { newPlanDoc, LAYER_FOR, pointInPoly, polyArea, seqCommand, selectThen, COMMANDS, dimCommand, kindFor, openingCommand, nearestWall, xformCommand, offsetEntity, lineIntersect, trimEntity, filletLines } from './plan.js';

export class PlanDraw {
  // ======================= drawing =======================
  draw(ctx) {
    const A = (this._A = this.affine());
    const S2 = (p) => this.S2(p, A);
    const W = this.vp.width, H = this.vp.height;
    const px = this.px;
    // grid
    if (this.S.grid) {
      let g = this.S.gridSize;
      while (g / px < 12) g *= 10;
      const major = g * 10;
      const x0 = (0 - A.o[0]) / A.ex[0], x1 = (W - A.o[0]) / A.ex[0];
      const y0 = (H - A.o[1]) / A.ey[1], y1 = (0 - A.o[1]) / A.ey[1];
      const drawLines = (step, color) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = Math.ceil(Math.min(x0, x1) / step) * step; x <= Math.max(x0, x1); x += step) { const s = Math.round(S2([x, 0])[0]) + 0.5; ctx.moveTo(s, 0); ctx.lineTo(s, H); }
        for (let y = Math.ceil(Math.min(y0, y1) / step) * step; y <= Math.max(y0, y1); y += step) { const s = Math.round(S2([0, y])[1]) + 0.5; ctx.moveTo(0, s); ctx.lineTo(W, s); }
        ctx.stroke();
      };
      drawLines(g, 'rgba(120,140,170,0.13)');
      drawLines(major, 'rgba(120,140,170,0.28)');
      // axes
      const o = S2([0, 0]);
      ctx.strokeStyle = 'rgba(200,40,40,.45)'; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(o[0] + 40, o[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(40,150,40,.55)'; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(o[0], o[1] - 40); ctx.stroke();
    }
    const walls = this.wallMap();
    const openingsOf = new Map();
    for (const e of this.doc.entities) if (e.type === 'door' || e.type === 'window') { if (!openingsOf.has(e.wall)) openingsOf.set(e.wall, []); openingsOf.get(e.wall).push(e); }
    const visLayers = new Set(this.doc.layers.filter((l) => l.visible).map((l) => l.name));
    const colorOf = (e) => e.color || this.layer(e.layer).color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pathCurve = (c) => {
      if (c.kind === 'line') { const a = S2(c.a), b = S2(c.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); return; }
      const sw = c.kind === 'circle' ? G.TAU : G.normAng(c.a1 - c.a0) || G.TAU;
      const a0 = c.kind === 'circle' ? 0 : c.a0;
      const n = Math.max(12, Math.min(128, Math.ceil((c.r / px) * sw / 4)));
      for (let i = 0; i <= n; i++) { const t = a0 + (sw * i) / n; const s = S2([c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)]); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }
    };
    const selStyle = (e) => {
      if (this.sel.has(e.id)) { ctx.setLineDash([6, 3]); ctx.strokeStyle = '#1e7cff'; }
      else if (this.hover === e.id) { ctx.setLineDash([]); ctx.lineWidth += 1.2; }
    };
    // slabs first (fills)
    for (const e of this.doc.entities) {
      if (!visLayers.has(e.layer) || e.type !== 'polyline' || !e.closed || !e.slab) continue;
      ctx.fillStyle = 'rgba(150,150,150,0.13)';
      ctx.beginPath(); e.pts.forEach((p, i) => { const s = S2(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath(); ctx.fill();
    }
    // walls: outline then fill (fills hide internal overlaps)
    const wallList = this.doc.entities.filter((e) => e.type === 'wall' && visLayers.has(e.layer));
    const piecesOf = new Map(wallList.map((w) => [w.id, G.wallPieces(w, openingsOf.get(w.id) || [])]));
    for (const w of wallList) {
      ctx.lineWidth = 2.6; ctx.setLineDash([]); ctx.strokeStyle = colorOf(w);
      selStyle(w);
      for (const poly of piecesOf.get(w.id)) { ctx.beginPath(); poly.forEach((p, i) => { const s = S2(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath(); ctx.stroke(); }
    }
    for (const w of wallList) {
      ctx.fillStyle = this.sel.has(w.id) ? '#d6e6ff' : this.hover === w.id ? '#f3e3c8' : '#e3ddd2';
      for (const poly of piecesOf.get(w.id)) { ctx.beginPath(); poly.forEach((p, i) => { const s = S2(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath(); ctx.fill(); }
    }
    // other entities
    for (const e of this.doc.entities) {
      if (!visLayers.has(e.layer) || e.type === 'wall') continue;
      ctx.setLineDash([]); ctx.lineWidth = 1.2; ctx.strokeStyle = colorOf(e); ctx.fillStyle = colorOf(e);
      selStyle(e);
      if (e.type === 'text') { this.drawText(ctx, e, S2); continue; }
      if (e.type === 'point') { const s = S2(e.p); ctx.beginPath(); ctx.arc(s[0], s[1], 2.5, 0, G.TAU); ctx.fill(); continue; }
      if (e.type === 'dim') { this.drawDim(ctx, e, S2); continue; }
      if (e.type === 'door' || e.type === 'window') {
        const w = walls.get(e.wall); if (!w) continue;
        for (const pr of G.openingPrims(e, w)) {
          ctx.lineWidth = pr.heavy ? 2 : pr.thin ? 0.8 : 1.2;
          if (pr.thin && !this.sel.has(e.id)) ctx.setLineDash([4, 3]);
          ctx.beginPath(); pathCurve(pr.type === 'line' ? { kind: 'line', a: pr.a, b: pr.b } : { kind: 'arc', c: pr.c, r: pr.r, a0: pr.a0, a1: pr.a1 }); ctx.stroke();
          if (!this.sel.has(e.id)) ctx.setLineDash([]);
        }
        continue;
      }
      ctx.beginPath();
      for (const c of G.curvesOf(e, walls)) pathCurve(c);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // grips
    if (this.sel.size && this.sel.size <= 50 && !this.cmd) {
      for (const id of this.sel) {
        const e = this.E(id); if (!e) continue;
        for (const g of this.grips(e)) {
          const s = S2(g.p);
          const hot = this.gripDrag && this.gripDrag.id === id && dist(this.gripDrag.origin, g.p) < 1e-9;
          ctx.fillStyle = hot ? '#e02020' : '#2a6fd6'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
          ctx.fillRect(s[0] - 4, s[1] - 4, 8, 8); ctx.strokeRect(s[0] - 4, s[1] - 4, 8, 8);
        }
      }
    }
    // grip drag preview
    if (this.gripDrag) {
      const e = structuredClone(this.E(this.gripDrag.id));
      this.gripDrag.apply(e, this.gripDrag.cur);
      ctx.strokeStyle = '#e02020'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); for (const c of G.curvesOf(e, walls)) pathCurve(c); ctx.stroke(); ctx.setLineDash([]);
    }
    // command preview
    if (this.cmd?.preview) {
      ctx.save(); ctx.strokeStyle = '#ff7a00'; ctx.fillStyle = '#ff7a00'; ctx.lineWidth = 1.3; ctx.setLineDash([]);
      const pv = this.cmd.preview(this.cursor?.p);
      for (const e of pv || []) {
        if (e.type === 'text') { this.drawText(ctx, e, S2); continue; }
        if (e.type === 'dim') { this.drawDim(ctx, e, S2); continue; }
        if (e.type === 'rubber') { ctx.setLineDash([4, 4]); ctx.beginPath(); const a = S2(e.a), b = S2(e.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]); continue; }
        if (e.type === 'wall') {
          ctx.fillStyle = 'rgba(255,140,0,.15)';
          const poly = G.wallPolygon(e).map(S2);
          ctx.beginPath(); poly.forEach((s, i) => (i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]))); ctx.closePath(); ctx.fill(); ctx.stroke();
          continue;
        }
        if (e.type === 'door' || e.type === 'window') {
          const w = walls.get(e.wall); if (!w) continue;
          ctx.beginPath();
          for (const pr of G.openingPrims(e, w)) pathCurve(pr.type === 'line' ? { kind: 'line', a: pr.a, b: pr.b } : { kind: 'arc', c: pr.c, r: pr.r, a0: pr.a0, a1: pr.a1 });
          ctx.stroke();
          continue;
        }
        ctx.beginPath(); for (const c of G.curvesOf(e, walls)) pathCurve(c); ctx.stroke();
      }
      ctx.restore();
    }
    // selection box
    if (this.box) {
      const b = this.box;
      const crossing = b.sx1 < b.sx0;
      ctx.strokeStyle = crossing ? '#1a9a3a' : '#2a6fd6'; ctx.fillStyle = crossing ? 'rgba(30,160,60,.08)' : 'rgba(42,111,214,.08)';
      ctx.setLineDash(crossing ? [5, 4] : []); ctx.lineWidth = 1;
      ctx.fillRect(b.sx0, b.sy0, b.sx1 - b.sx0, b.sy1 - b.sy0); ctx.strokeRect(b.sx0, b.sy0, b.sx1 - b.sx0, b.sy1 - b.sy0); ctx.setLineDash([]);
    }
    // cursor + snap marker
    if (this.cursor && this.mouse) {
      const s = S2(this.cursor.p);
      const k = this.cursor.kind;
      if (k) {
        ctx.strokeStyle = '#e8a000'; ctx.lineWidth = 2;
        ctx.beginPath();
        if (k === 'end') ctx.rect(s[0] - 6, s[1] - 6, 12, 12);
        else if (k === 'mid') { ctx.moveTo(s[0], s[1] - 7); ctx.lineTo(s[0] + 7, s[1] + 5); ctx.lineTo(s[0] - 7, s[1] + 5); ctx.closePath(); }
        else if (k === 'cen') ctx.arc(s[0], s[1], 6, 0, G.TAU);
        else if (k === 'quad') { ctx.moveTo(s[0], s[1] - 7); ctx.lineTo(s[0] + 7, s[1]); ctx.lineTo(s[0], s[1] + 7); ctx.lineTo(s[0] - 7, s[1]); ctx.closePath(); }
        else if (k === 'int') { ctx.moveTo(s[0] - 6, s[1] - 6); ctx.lineTo(s[0] + 6, s[1] + 6); ctx.moveTo(s[0] + 6, s[1] - 6); ctx.lineTo(s[0] - 6, s[1] + 6); }
        else if (k === 'perp') { ctx.moveTo(s[0] - 6, s[1] + 6); ctx.lineTo(s[0] + 6, s[1] + 6); ctx.moveTo(s[0] - 6, s[1] + 6); ctx.lineTo(s[0] - 6, s[1] - 6); ctx.moveTo(s[0] - 6, s[1]); ctx.lineTo(s[0], s[1]); ctx.lineTo(s[0], s[1] + 6); }
        else ctx.rect(s[0] - 4, s[1] - 4, 8, 8);
        ctx.stroke();
        const names = { end: 'Endpoint', mid: 'Midpoint', cen: 'Center', quad: 'Quadrant', int: 'Intersection', perp: 'Perpendicular', node: 'Node', pc: 'Scan point' };
        ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const label = names[k] || k; const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(255,255,224,.95)'; ctx.fillRect(s[0] + 12, s[1] + 12, w, 16); ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1; ctx.strokeRect(s[0] + 12, s[1] + 12, w, 16);
        ctx.fillStyle = '#222'; ctx.fillText(label, s[0] + 16, s[1] + 14);
      }
      if (this.cmd && !this.cmd.selecting) {
        ctx.strokeStyle = 'rgba(30,30,30,.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(s[0] - 18, s[1]); ctx.lineTo(s[0] + 18, s[1]); ctx.moveTo(s[0], s[1] - 18); ctx.lineTo(s[0], s[1] + 18); ctx.stroke();
        const base = this.cmd.base?.();
        if (base) {
          const d = dist(base, this.cursor.p), ang = (Math.atan2(this.cursor.p[1] - base[1], this.cursor.p[0] - base[0]) * 180) / Math.PI;
          const label = `${fmt(d, 1)} < ${fmt((ang + 360) % 360, 1)}°`;
          ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          const w = ctx.measureText(label).width + 8;
          ctx.fillStyle = 'rgba(240,246,255,.95)'; ctx.fillRect(s[0] + 14, s[1] - 26, w, 16); ctx.strokeStyle = '#8aa'; ctx.strokeRect(s[0] + 14, s[1] - 26, w, 16);
          ctx.fillStyle = '#123'; ctx.fillText(label, s[0] + 18, s[1] - 24);
        }
      }
    }
  }

  drawText(ctx, e, S2) {
    const s = S2(e.p);
    const hpx = e.h / this.px;
    if (hpx < 2) { ctx.fillRect(s[0], s[1] - 1, 4, 1); return; }
    ctx.save();
    ctx.translate(s[0], s[1]); ctx.rotate(-(e.rot || 0));
    ctx.font = `${hpx * 1.35}px Segoe UI, Arial, sans-serif`;
    ctx.textAlign = e.align === 'center' ? 'center' : 'left'; ctx.textBaseline = e.align === 'center' ? 'middle' : 'alphabetic';
    String(e.text).split('\n').forEach((line, i) => ctx.fillText(line, 0, i * hpx * 1.6));
    ctx.restore();
  }

  drawDim(ctx, d, S2) {
    const g = G.dimGeom(d);
    const s1 = S2(d.a), s2 = S2(d.b), t1 = S2(g.d1), t2 = S2(g.d2);
    const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
    const ext = (a, b) => { const v = sub(b, a); const L = Math.hypot(v[0], v[1]); if (L < 2) return; seg(add(a, mul(v, 3 / L)), add(b, mul(v, 5 / L))); };
    ctx.lineWidth = 1;
    ext(s1, t1); ext(s2, t2); seg(t1, t2);
    // architectural ticks
    for (const t of [t1, t2]) { ctx.lineWidth = 2; seg([t[0] - 4, t[1] + 4], [t[0] + 4, t[1] - 4]); }
    ctx.lineWidth = 1;
    const th = (d.h || this.S.dimTextH) / this.px;
    if (th >= 4) {
      const ms = S2(g.mid);
      let ang = Math.atan2(t2[1] - t1[1], t2[0] - t1[0]);
      if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
      ctx.save(); ctx.translate(ms[0], ms[1]); ctx.rotate(ang);
      ctx.font = `${th * 1.3}px Segoe UI, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(g.value, 0), 0, -2);
      ctx.restore();
    }
  }

}
