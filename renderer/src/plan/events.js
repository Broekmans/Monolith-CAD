// Plan: mouse/keyboard events, command line, grips
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

export class PlanEvents {
  // ======================= events =======================
  bind() {
    const el = this.vp.el;
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('dblclick', (e) => { if (e.button === 1) this.zoomExtents(); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1 && e.detail === 2) this.zoomExtents(); });
    this.vp.onViewChange = () => {};
  }

  onMove(e) {
    const { p, sx, sy } = this.planAt(e);
    this.mouse = { p, sx, sy };
    if (this.gripDrag) {
      const s = this.snap(p, { base: this.gripDrag.origin, exclude: new Set([this.gripDrag.id]) });
      this.cursor = s;
      this.gripDrag.cur = s.p;
      this.vp.requestRender();
      this.app.setCoords(`${fmt(s.p[0], 2)}, ${fmt(s.p[1], 2)}`);
      return;
    }
    if (this.box) { this.box.sx1 = sx; this.box.sy1 = sy; this.box.p1 = p; this.vp.requestRender(); return; }
    const base = this.cmd?.base?.() || null;
    this.cursor = this.cmd?.wantsPoint !== false ? this.snap(p, { base }) : { p, kind: null };
    if (!this.cmd || this.cmd.selecting) {
      const hit = this.pickEntity(p);
      this.hover = hit?.id || null;
    }
    if (this.cmd) this.cmd.move?.(this.cursor.p);
    this.app.setCoords(`${fmt(this.cursor.p[0], 2)}, ${fmt(this.cursor.p[1], 2)}`);
    this.vp.requestRender();
  }

  onDown(e) {
    if (e.button !== 0 || e.altKey) return;
    const { p, sx, sy } = this.planAt(e);
    this.vp.el.setPointerCapture(e.pointerId);
    if (this.cmd && !this.cmd.selecting) {
      const s = this.snap(p, { base: this.cmd.base?.() || null });
      this.cmd.point(s.p, { raw: p, snap: s });
      this.vp.requestRender();
      return;
    }
    // grips of selected entities
    if (!this.cmd) {
      const g = this.gripAt(sx, sy);
      if (g) { this.gripDrag = { ...g, origin: g.p, cur: g.p }; return; }
    }
    const hit = this.pickEntity(p);
    if (hit) {
      this.selCloud = null;
      if (e.shiftKey) this.sel.delete(hit.id);
      else this.sel.add(hit.id);
      this.renderPanel();
      this.vp.requestRender();
      return;
    }
    this.box = { sx0: sx, sy0: sy, sx1: sx, sy1: sy, p0: p, p1: p };
  }

  onUp(e) {
    if (e.button !== 0) return;
    if (this.gripDrag) {
      const g = this.gripDrag; this.gripDrag = null;
      if (dist(g.cur, g.origin) > 1e-9) this.change(() => { const ent = this.E(g.id); g.apply(ent, g.cur); });
      this.vp.requestRender();
      return;
    }
    if (this.box) {
      const b = this.box; this.box = null;
      if (Math.hypot(b.sx1 - b.sx0, b.sy1 - b.sy0) > 4) {
        const crossing = b.sx1 < b.sx0;
        const min = [Math.min(b.p0[0], b.p1[0]), Math.min(b.p0[1], b.p1[1])], max = [Math.max(b.p0[0], b.p1[0]), Math.max(b.p0[1], b.p1[1])];
        const walls = this.wallMap();
        for (const ent of this.visibleEntities()) {
          const bb = G.bboxOf(ent, walls);
          if (!bb) continue;
          const inside = bb.min[0] >= min[0] && bb.max[0] <= max[0] && bb.min[1] >= min[1] && bb.max[1] <= max[1];
          const touch = bb.max[0] >= min[0] && bb.min[0] <= max[0] && bb.max[1] >= min[1] && bb.min[1] <= max[1] && (inside || this.crossesBox(ent, min, max, walls));
          if (crossing ? touch : inside) { if (e.shiftKey) this.sel.delete(ent.id); else this.sel.add(ent.id); }
        }
      } else if (!this.cmd && !e.shiftKey) this.sel.clear();
      this.renderPanel();
      this.vp.requestRender();
      if (this.cmd?.selecting) this.prompt(this.cmd.promptText());
    }
  }
  crossesBox(ent, min, max, walls) {
    const edges = [[min, [max[0], min[1]]], [[max[0], min[1]], max], [max, [min[0], max[1]]], [[min[0], max[1]], min]];
    for (const c of G.curvesOf(ent, walls)) {
      if (c.kind === 'line' && c.a[0] >= min[0] && c.a[0] <= max[0] && c.a[1] >= min[1] && c.a[1] <= max[1]) return true;
      for (const [a, b] of edges) if (G.intersect(c, { kind: 'line', a, b }).length) return true;
    }
    if (ent.type === 'text' || ent.type === 'point') return true;
    return false;
  }

  onKey(e) {
    const k = e.key;
    if (k === 'F3') { this.S.osnap = !this.S.osnap; this.updateToggles(); return true; }
    if (k === 'F7') { this.S.grid = !this.S.grid; this.updateToggles(); this.vp.requestRender(); return true; }
    if (k === 'F8') { this.S.ortho = !this.S.ortho; this.updateToggles(); return true; }
    if (k === 'F9') { this.S.snap = !this.S.snap; this.updateToggles(); return true; }
    if (e.ctrlKey && (k === 'z' || k === 'Z')) { this.undo(); return true; }
    if (e.ctrlKey && (k === 'y' || k === 'Y')) { this.redo(); return true; }
    if (e.ctrlKey && (k === 'a' || k === 'A')) { this.visibleEntities().forEach((x) => this.sel.add(x.id)); this.renderPanel(); this.vp.requestRender(); return true; }
    if (k === 'Escape') {
      if (this.cmd) this.endCommand(true);
      else { this.sel.clear(); this.renderPanel(); this.vp.requestRender(); }
      return true;
    }
    if (k === 'Delete' && !this.cmd && this.sel.size) { this.eraseSelection(); return true; }
    if (k === 'Enter' && this.cmd && !this.app.cmdInputHasText()) { this.cmd.enter(); return true; }
    if (k === ' ' && !this.app.cmdInputHasText()) {
      if (this.cmd) this.cmd.enter(); else if (this.lastCommand) this.runCommand(this.lastCommand);
      return true;
    }
    // typing goes into the command line
    if (k.length === 1 && !e.ctrlKey && !e.altKey) { this.app.focusCommandLine(k); return true; }
    return false;
  }

  contextMenu(e) {
    if (this.cmd) { this.cmd.enter(); return; }
    const items = [];
    if (this.lastCommand) items.push({ label: `Repeat ${this.lastCommand}`, run: () => this.runCommand(this.lastCommand) });
    if (this.sel.size) {
      items.push('-', { label: 'Move', icon: 'move', run: () => this.runCommand('MOVE') }, { label: 'Copy', icon: 'copy', run: () => this.runCommand('COPY') },
        { label: 'Rotate', icon: 'rotate', run: () => this.runCommand('ROTATE') }, { label: 'Erase', icon: 'erase', key: 'Del', run: () => this.eraseSelection() },
        { label: 'Deselect All', run: () => { this.sel.clear(); this.renderPanel(); this.vp.requestRender(); } });
    }
    items.push('-', { label: 'Zoom Extents', icon: 'zoomFit', run: () => this.zoomExtents() }, { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', run: () => this.undo() });
    contextMenu(e.clientX, e.clientY, items);
  }

  // ======================= command line =======================
  prompt(text) { this.app.setPrompt(text); }
  log(text) { this.app.logCommand(text); }

  onCommandInput(raw) {
    const txt = raw.trim();
    if (this.cmd) {
      if (!txt) { this.cmd.enter(); return; }
      if (this.cmd.input?.(txt)) return;
      const pt = this.parsePoint(txt, this.cmd.base?.());
      if (pt && this.cmd.wantsPoint !== false) { this.cmd.point(pt, { typed: true }); this.vp.requestRender(); return; }
      toast(`Invalid input: ${txt}`, 'warn');
      return;
    }
    if (!txt) { if (this.lastCommand) this.runCommand(this.lastCommand); return; }
    this.runCommand(txt.toUpperCase());
  }

  // "x,y" | "@dx,dy" | "@d<ang" | "d" (direct distance toward cursor)
  parsePoint(t, base) {
    t = t.replace(/\s+/g, '');
    let m;
    if ((m = t.match(/^(@?)(-?[\d.]+)<(-?[\d.]+)$/))) {
      const b = m[1] ? base || [0, 0] : [0, 0];
      const d = +m[2], a = (+m[3] * Math.PI) / 180;
      return [b[0] + d * Math.cos(a), b[1] + d * Math.sin(a)];
    }
    if ((m = t.match(/^(@?)(-?[\d.eE+]+),(-?[\d.eE+]+)$/))) {
      const b = m[1] ? base || [0, 0] : [0, 0];
      return [b[0] + +m[2], b[1] + +m[3]];
    }
    const v = evalNumber(t);
    if (v !== null && base && this.cursor) {
      let d = sub(this.cursor.p, base);
      if (this.S.ortho) d = Math.abs(d[0]) >= Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
      const L = Math.hypot(d[0], d[1]);
      if (L < 1e-9) return null;
      return add(base, mul(d, v / L));
    }
    return null;
  }

  runCommand(name) {
    const aliases = { L: 'LINE', PL: 'PLINE', REC: 'RECTANG', C: 'CIRCLE', A: 'ARC', T: 'TEXT', DT: 'TEXT', DLI: 'DIMLINEAR', DAL: 'DIMALIGNED', DIM: 'DIMLINEAR',
      M: 'MOVE', CO: 'COPY', CP: 'COPY', RO: 'ROTATE', SC: 'SCALE', MI: 'MIRROR', O: 'OFFSET', TR: 'TRIM', F: 'FILLET', X: 'EXPLODE', E: 'ERASE', W: 'WALL',
      Z: 'ZOOM', U: 'UNDO', LA: 'LAYER', DI: 'DIST' };
    const n = aliases[name] || name;
    const factory = COMMANDS[n];
    if (n === 'UNDO') { this.undo(); return; }
    if (n === 'REDO') { this.redo(); return; }
    if (n === 'ZOOM') { this.zoomExtents(); return; }
    if (n === 'LAYER') { this.app.showPanel('tree'); return; }
    if (!factory) { toast(`Unknown command: ${name}`, 'warn'); this.log(`Unknown command "${name}".`); return; }
    if (this.cmd) this.endCommand(true);
    this.lastCommand = n;
    this.log(`Command: ${n}`);
    this.cmd = factory(this);
    this.cmd.name = n;
    this.cmd.start?.();
    if (!this.cmd) return;
    this.prompt(this.cmd.promptText());
    this.app.cm.refresh();
    this.vp.requestRender();
  }
  endCommand(cancel = false) {
    const c = this.cmd;
    this.cmd = null;
    if (c && cancel) c.cancel?.();
    this.prompt('Command:');
    if (cancel && c) this.log('*Cancel*');
    this.vp.requestRender();
  }

  eraseSelection() {
    if (!this.sel.size) return;
    this.change(() => {
      const kill = new Set(this.sel);
      // erasing a wall erases its doors/windows
      for (const e of this.doc.entities) if ((e.type === 'door' || e.type === 'window') && kill.has(e.wall)) kill.add(e.id);
      this.doc.entities = this.doc.entities.filter((e) => !kill.has(e.id) || !this.editable(e));
      this.sel.clear();
    });
  }

  // ======================= grips =======================
  grips(e) {
    const walls = this.wallMap();
    const out = [];
    const G2 = (p, apply) => out.push({ id: e.id, p, apply });
    switch (e.type) {
      case 'line': case 'wall':
        G2(e.a, (x, q) => { x.a = q; }); G2(e.b, (x, q) => { x.b = q; });
        G2(lerp(e.a, e.b, 0.5), (x, q) => { const d = sub(q, lerp(x.a, x.b, 0.5)); x.a = add(x.a, d); x.b = add(x.b, d); });
        break;
      case 'polyline': e.pts.forEach((p, i) => G2(p, (x, q) => { x.pts[i] = q; })); break;
      case 'circle': G2(e.c, (x, q) => { x.c = q; }); G2([e.c[0] + e.r, e.c[1]], (x, q) => { x.r = dist(x.c, q); }); break;
      case 'arc': G2(e.c, (x, q) => { x.c = q; }); { const am = e.a0 + G.normAng(e.a1 - e.a0) / 2; G2([e.c[0] + e.r * Math.cos(am), e.c[1] + e.r * Math.sin(am)], (x, q) => { x.r = dist(x.c, q); }); } break;
      case 'text': case 'point': G2(e.p, (x, q) => { x.p = q; }); break;
      case 'dim': G2(e.a, (x, q) => { x.a = q; }); G2(e.b, (x, q) => { x.b = q; }); G2(G.dimGeom(e).mid, (x, q) => { x.p = q; }); break;
      case 'door': case 'window': {
        const w = walls.get(e.wall);
        if (w) { const f = G.wallFrame(w); G2(add(w.a, mul(f.u, e.pos)), (x, q) => { const ww = this.E(x.wall); const ff = G.wallFrame(ww); x.pos = Math.max(x.w / 2, Math.min(ff.L - x.w / 2, (q[0] - ww.a[0]) * ff.u[0] + (q[1] - ww.a[1]) * ff.u[1])); }); }
        break;
      }
      default:
    }
    return out;
  }
  gripAt(sx, sy) {
    if (this.sel.size > 50) return null;
    this._A = this.affine();
    for (const id of this.sel) {
      const e = this.E(id);
      if (!e || !this.editable(e)) continue;
      for (const g of this.grips(e)) { const s = this.S2(g.p); if (Math.abs(s[0] - sx) < 6 && Math.abs(s[1] - sy) < 6) return g; }
    }
    return null;
  }

}
