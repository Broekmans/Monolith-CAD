// Drawing tools (mixed into DrawingDoc; `this` is the DrawingDoc): projected view by dragging (incl.
// diagonal = isometric), section views (cut line A–A), Smart Dimension (length / angle / radius /
// diameter), Area, Note; selecting, moving and deleting annotations.
// A tool gets sheet points: move(p, e), click(p, e), key(e), context(); it shows itself through
// this.preview (extra primitives) and this.hover (snap marker).
import { h, fmt, toast, promptText } from '../ui.js';
import { api } from '../api.js';
import { STD, projected, isOrtho, viewRect, viewXf, viewScale, scaleText } from './sheet.js';
import { fitData, fitAt, roomAt, openingAt, near, lineDist, mergeData } from './fit.js';
import { annValue, centroid, DIM } from './dims.js';
import { styleOf, roomOpts } from './styles.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const n3 = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const lin3 = (A, s, B, t) => [0, 1, 2].map((i) => A[i] * s + B[i] * t);
const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export class DrawingTools {
  // ---------- view <-> sheet ----------
  toModel(v, P) { const sh = this.sheetOf(v), { s } = viewXf(v, sh), b = v.geom.box; return [(b[0] + b[2]) / 2 + (P[0] - v.pos[0]) / s, (b[1] + b[3]) / 2 + (P[1] - v.pos[1]) / s]; }
  toSheetPt(v, q) { return viewXf(v, this.sheetOf(v)).f(q[0], q[1]); }
  sheetOf(v) { return this.doc.sheets.find((s) => s.id === v.sheet) || this.sheet; }
  pxMm() { return Math.abs(this.affine().ex[0]) || 1; }
  // nearest geometry under p (sheet mm): vertex / circle centre (8 px) before edges (6 px)
  snapAt(p, only = null) {
    const k = this.pxMm(), tv = 8 / k, te = 6 / k;
    let best = null;
    for (const v of this.doc.views.filter((q) => q.sheet === this.sheetId && q.geom)) {
      if (only && v.id !== only) continue;
      const r = viewRect(v, this.sheetOf(v));
      if (p[0] < r[0] - tv || p[0] > r[2] + tv || p[1] < r[1] - tv || p[1] > r[3] + tv) continue;
      const { f } = viewXf(v, this.sheetOf(v));
      for (const e of v.geom.edges) {
        if (e.cls === 'h' && !v.hidden) continue;
        const n = e.pts.length / 2;
        const ends = e.type === 'circle' && e.full ? [] : [[e.pts[0], e.pts[1]], [e.pts[e.pts.length - 2], e.pts[e.pts.length - 1]]];
        if (e.type === 'circle') ends.push(e.c);
        for (const q of ends) { const S = f(q[0], q[1]), d = len(sub(S, p)); if (d < tv && (!best || best.kind === 'edge' || d < best.d)) best = { kind: q === e.c ? 'center' : 'pt', v, q: q.slice(), S, d }; }
        if (best && best.kind !== 'edge') continue;
        for (let i = 0; i + 1 < n; i++) {
          const A = f(e.pts[i * 2], e.pts[i * 2 + 1]), B = f(e.pts[i * 2 + 2], e.pts[i * 2 + 3]);
          const ab = sub(B, A), t = Math.max(0, Math.min(1, ((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1)));
          const d = len(sub([A[0] + ab[0] * t, A[1] + ab[1] * t], p));
          if (d < te && (!best || (best.kind === 'edge' && d < best.d))) best = { kind: 'edge', v, e, d, S: [A[0] + ab[0] * t, A[1] + ab[1] * t] };
        }
      }
      // scans: fitted planes when no drawn edge (e.g. a part overlay) is under the cursor
      if (v.geom.fit && !best) { const c = this.cloudSnap(v, p); if (c) best = c; }
    }
    return best;
  }
  // point cloud views: snap to a fitted plane (line through the band of scan points), a corner where two
  // fitted planes meet, or — with Shift held — a free point
  cloudSnap(v, p) {
    const inside = (() => { const r = viewRect(v, this.sheetOf(v)); return p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]; })();
    if (!inside) return null;
    const q = this.toModel(v, p);
    if (this._free) return { kind: 'pt', v, q, S: p.slice(), d: 0, free: true };
    const d = fitData(v.geom.fit); if (!d) return null;
    const s = viewScale(v, this.sheetOf(v)), R = Math.max(12 / this.pxMm() / s, 60);
    let r = fitAt(d, q, R, this.doc.snapMode || 'first');
    // stick to the wall we are on: keep the last fitted line while the cursor stays in its band and
    // along its stretch, unless a corner shows up (no jumping between neighbouring bands)
    const last = this._lastFit;
    if (last && last.v === v.id && r && !r.corner && r.line !== last.line) {
      const L = last.line, inBand = lineDist(L, q) <= Math.max(3 * L.sigma + d.cell, R * 0.35);
      const t = (q[0] - L.a[0]) * L.dir[0] + (q[1] - L.a[1]) * L.dir[1], len0 = (L.b[0] - L.a[0]) * L.dir[0] + (L.b[1] - L.a[1]) * L.dir[1];
      const better = lineDist(r.line, q) < 0.5 * lineDist(L, q) - d.cell;
      if (inBand && t >= -R && t <= len0 + R && !better) { const e = (q[0] - L.c[0]) * L.nrm[0] + (q[1] - L.c[1]) * L.nrm[1]; r = { line: L, foot: [q[0] - L.nrm[0] * e, q[1] - L.nrm[1] * e], corner: null }; }
    }
    this._lastFit = r && !r.corner ? { v: v.id, line: r.line } : null;
    // the fitted wall has no points at the foot: the cursor is in an opening
    if (r && !r.corner && near(d, r.foot, Math.max(4 * d.cell, 40)).length === 0) r = null;
    if (!r) {
      // in a gap of a wall: door / window opening between the two wall ends
      const o = openingAt(d, q, R, Math.max(1500, 40 / this.pxMm() / s));
      if (!o) return null;
      const f = { sigma: o.line.sigma, n: o.line.n };
      return { kind: 'edge', v, q, S: p.slice(), d: 0, e: { type: 'line', pts: [...o.a, ...o.b], fit: { ...f, c: o.line.c, dir: o.line.dir, nrm: o.line.nrm }, opening: { a: o.a, b: o.b, width: o.width } } };
    }
    if (r.corner) return { kind: 'pt', v, q: r.corner.q, S: this.toSheetPt(v, r.corner.q), d: 0, corner: r.corner };
    const L = r.line;
    return { kind: 'edge', v, q: r.foot, S: this.toSheetPt(v, r.foot), d: 0, e: { type: 'line', pts: [...L.a, ...L.b], fit: { sigma: L.sigma, n: L.n, c: L.c, dir: L.dir, nrm: L.nrm } } };
  }
  hoverMark(sn) {
    if (!sn) return [];
    const seg = (l, P) => { const A = this.toSheetPt(sn.v, l.a), B = this.toSheetPt(sn.v, l.b), u = nrm(sub(B, A)), r = 14 / this.pxMm(); return { t: 'line', pts: [P[0] - u[0] * r, P[1] - u[1] * r, P[0] + u[0] * r, P[1] + u[1] * r], w: 0.5, color: '#d81bd8', screen: true }; };
    if (sn.corner) return [seg(sn.corner.l1, sn.S), seg(sn.corner.l2, sn.S), { t: 'circle', c: sn.S, r: 4 / this.pxMm(), w: 0.4, color: '#d81bd8', screen: true }];
    if (sn.kind === 'edge' && sn.e.fit && !sn.e.opening) { const l = { a: [sn.e.pts[0], sn.e.pts[1]], b: [sn.e.pts[2], sn.e.pts[3]] }, P = this.toSheetPt(sn.v, sn.q), k = this.pxMm(); return [seg(l, P), { t: 'circle', c: P, r: 3 / k, w: 0.4, color: '#d81bd8', screen: true }, { t: 'text', x: P[0] + 6 / k, y: P[1] + 6 / k, size: 2.2, text: `±${fmt(sn.e.fit.sigma, 1)} mm (${sn.e.fit.n})`, align: 'l', color: '#d81bd8', screen: true }]; }
    if (sn.kind === 'edge' && sn.e.opening) { const o = sn.e.opening, A = this.toSheetPt(sn.v, o.a), B = this.toSheetPt(sn.v, o.b); return [{ t: 'line', pts: [...A, ...B], w: 0.5, dash: [1.5, 1], color: '#d81bd8', screen: true }, { t: 'circle', c: A, r: 1, w: 0.4, color: '#d81bd8', screen: true }, { t: 'circle', c: B, r: 1, w: 0.4, color: '#d81bd8', screen: true }, { t: 'text', x: (A[0] + B[0]) / 2 + 1.5, y: (A[1] + B[1]) / 2 + 1.5, size: 2.2, text: `opening ${fmt(o.width, 0)} mm`, align: 'l', color: '#d81bd8', screen: true }]; }
    if (sn.kind === 'edge' && sn.e.fit) { const P = this.toSheetPt(sn.v, sn.q); return [...this.hoverMark({ ...sn, e: { ...sn.e, fit: null } }), { t: 'text', x: P[0] + 2, y: P[1] + 2, size: 2.2, text: `±${fmt(sn.e.fit.sigma, 1)} mm (${sn.e.fit.n})`, align: 'l', color: '#d81bd8', screen: true }]; }
    if (sn.kind === 'edge') { const pts = []; const { f } = viewXf(sn.v, this.sheetOf(sn.v)); for (let i = 0; i < sn.e.pts.length; i += 2) pts.push(...f(sn.e.pts[i], sn.e.pts[i + 1])); return [{ t: 'line', pts, w: 0.6, color: '#d81bd8', screen: true }]; }
    return [{ t: 'circle', c: sn.S, r: 1.4, w: 0.4, color: '#d81bd8', screen: true }];
  }
  startTool(tool) {
    this.endTool();
    this.tool = tool;
    this.vp.el.style.cursor = 'crosshair';
    this.app.cm.refresh();
  }
  endTool() {
    if (!this.tool) return;
    const t = this.tool; this.tool = null; this.preview = null;
    t.done?.();
    this.vp.el.style.cursor = '';
    if (this.app.pm.open) this.app.pm.close(false);
    this.app.cm.refresh(); this.vp.requestRender();
  }
  setPreview(prims) { this.preview = prims; this.vp.requestRender(); }

  // ======================= projected view by dragging =======================
  cmdProjected() {
    const par = this.V(this.sel);
    if (!par || !isOrtho(par)) { toast('Select a front, top, side or projected view first, then move the mouse to where the new view should go'); return; }
    this.projectedTool(par);
  }
  async projectedTool(par) {
    const N = par.dir, X = par.x, Y = cross3(N, X);
    const dirs = {
      right: projected(par, 'right'), left: projected(par, 'left'), above: projected(par, 'above'), below: projected(par, 'below'),
    };
    for (const [k, sx, sy] of [['ur', 1, 1], ['ul', -1, 1], ['dr', 1, -1], ['dl', -1, -1]]) { const d = n3(lin3(lin3(N, 1, X, sx), 1, Y, sy)); dirs[k] = { dir: d, x: n3(cross3(sy > 0 ? Y : Y.map((v) => -v), d)).map((v) => (sy > 0 ? v : v)) }; }
    // keep "up" for the diagonal views close to the parent's up
    for (const k of ['ur', 'ul', 'dr', 'dl']) { const d = dirs[k].dir; dirs[k].x = n3(cross3(Y, d)); }
    const keys = Object.keys(dirs);
    const geoms = await this.run('Preparing views', () => this.computeViews(par.src, keys.map((k) => dirs[k]), par));
    if (!geoms) return;
    const sh = this.sheetOf(par), s = viewScale(par, sh), pr = viewRect(par, sh);
    let cur = null;
    this.app.pm.show({ title: 'Projected View', iconName: 'normalTo', fields: [{ type: 'info', text: `From: ${par.name}. Move the mouse right, left, up or down for a projected view, or diagonally for an isometric view. Click to place it; Esc ends.` }], onCancel: () => this.endTool() });
    this.startTool({
      move: (p) => {
        const r = sub(p, par.pos), a = Math.atan2(r[1], r[0]);
        if (len(r) < 10) { cur = null; this.setPreview(null); return; }
        const oct = Math.round(a / (Math.PI / 4));
        const k = { 0: 'right', 1: 'ur', 2: 'above', 3: 'ul', 4: 'left', '-4': 'left', '-3': 'dl', '-2': 'below', '-1': 'dr' }[oct];
        const g = geoms[keys.indexOf(k)], w = (g.box[2] - g.box[0]) * s, hh = (g.box[3] - g.box[1]) * s;
        let pos = p.slice();
        if (k === 'right') pos = [Math.max(p[0], pr[2] + w / 2 + 5), par.pos[1]];
        if (k === 'left') pos = [Math.min(p[0], pr[0] - w / 2 - 5), par.pos[1]];
        if (k === 'above') pos = [par.pos[0], Math.max(p[1], pr[3] + hh / 2 + 5)];
        if (k === 'below') pos = [par.pos[0], Math.min(p[1], pr[1] - hh / 2 - 5)];
        cur = { k, g, pos };
        const ghost = { pos, geom: g, scale: par.scale, sheet: par.sheet };
        const { f } = viewXf(ghost, sh), prims = [];
        for (const e of g.edges) { if (e.cls !== 'v') continue; const q = []; for (let i = 0; i < e.pts.length; i += 2) q.push(...f(e.pts[i], e.pts[i + 1])); prims.push({ t: 'line', pts: q, w: 0.3, color: '#2a6fd6', screen: true }); }
        const rr = viewRect(ghost, sh);
        prims.push({ t: 'sel', on: true, pts: [rr[0] - 4, rr[1] - 4, rr[2] + 4, rr[1] - 4, rr[2] + 4, rr[3] + 4, rr[0] - 4, rr[3] + 4, rr[0] - 4, rr[1] - 4] });
        this.setPreview(prims);
      },
      click: () => {
        if (!cur) return;
        const snap = this.snapshot(), d = dirs[cur.k], ortho = ['right', 'left', 'above', 'below'].includes(cur.k);
        const nm = Object.entries(STD).find(([kk, q]) => kk !== 'iso' && q.dir.every((c, i) => Math.abs(c - d.dir[i]) < 1e-9) && q.x.every((c, i) => Math.abs(c - d.x[i]) < 1e-9));
        const v = { id: uid('v'), sheet: par.sheet, name: ortho ? (nm ? nm[1].label[0] + nm[1].label.slice(1).toLowerCase() : `Projected ${this.doc.views.length + 1}`) : 'Isometric', src: par.src, srcName: par.srcName, dir: d.dir, x: d.x, pos: cur.pos, hidden: ortho ? par.hidden : false, scale: par.scale ? par.scale.slice() : null, geom: cur.g, ...(par.cloud ? { cloud: { ...par.cloud, clip: { ...par.cloud.clip, on: false } } } : {}), ...(ortho ? { parent: par.id, side: cur.k } : {}) };
        this.doc.views.push(v);
        this.pushUndo(snap); this.app.setDirty(true); this.renderTree();
        this.app.setStatus(`${v.name} view placed. Place another one or press Esc.`);
      },
    });
  }

  // ======================= section view =======================
  cmdSection() {
    this.app.pm.show({ title: 'Section View', iconName: 'section', fields: [{ type: 'info', key: 'msg', text: 'Click two points across a view for the cutting line (it snaps to horizontal / vertical and to model points). Then move the mouse to the side you look from and click to place the section.' }], onCancel: () => this.endTool() });
    const st = { a: null, par: null };
    const msg = (t) => { const el = this.app.pm.current?.inputs?.msg; if (el) el.textContent = t; };
    const pick = (p) => { let sn = this.snapAt(p, st.par?.id); if (sn && !isOrtho(sn.v)) sn = null; const v = st.par || (sn && isOrtho(sn.v) ? sn.v : null) || this.viewNear(p, 25, isOrtho); return { sn, v, P: sn && sn.kind !== 'edge' ? sn.S : p }; };
    const second = (P) => {
      // snap the line to horizontal / vertical within 5°
      const d = sub(P, st.a), ang = Math.atan2(d[1], d[0]);
      for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) { let x = ang - t; x = Math.atan2(Math.sin(x), Math.cos(x)); if (Math.abs(x) < (5 * Math.PI) / 180) { const l = len(d); return [st.a[0] + l * Math.cos(t), st.a[1] + l * Math.sin(t)]; } }
      return P;
    };
    this.startTool({
      move: (p) => {
        if (st.place) { this.sectionPreview(st, p); return; }
        const { sn, P } = pick(p);
        const prims = this.hoverMark(sn);
        if (st.a) { const B = second(P); prims.push({ t: 'line', pts: [...st.a, ...B], w: 0.35, dash: [6, 1.5, 1, 1.5], color: '#2a6fd6', screen: true }); }
        this.setPreview(prims);
      },
      click: async (p) => {
        if (st.place) { this.placeSection(st, p); return; }
        const { v, P } = pick(p);
        if (!st.a) {
          if (!v || !isOrtho(v)) { toast('Start the cutting line on a front, top or side view'); return; }
          st.a = P; st.par = v; msg('Now click the second point of the cutting line.'); return;
        }
        const B = second(P);
        if (len(sub(B, st.a)) < 2) return;
        st.b = B;
        await this.prepareSection(st);
        if (st.geoms) msg('Move the mouse to the side you look from, then click to place the section view.');
      },
    });
  }
  async prepareSection(st) {
    const par = st.par, N = par.dir, X = par.x, Y = cross3(N, X);
    const a = this.toModel(par, st.a), b = this.toModel(par, st.b);
    const d2 = nrm(sub(b, a)), D3 = n3(lin3(X, d2[0], Y, d2[1]));
    const m3 = n3(cross3(N, D3)), m2 = [m3[0] * X[0] + m3[1] * X[1] + m3[2] * X[2], m3[0] * Y[0] + m3[1] * Y[1] + m3[2] * Y[2]];
    const p3 = lin3(X, a[0], Y, a[1]);
    // frame of each side: horizontal-ish cut -> keep x along the cut, else keep y along the cut
    // point clouds cut on a plan (top / bottom view): height stays up in the section (building sections)
    const upright = !!par.cloud && Math.abs(N[1]) > 0.9;
    const frame = (m) => {
      if (upright) return { dir: m, x: n3(cross3([0, 1, 0], m)), free: true };
      const dir = m, horiz = Math.abs(d2[0]) >= Math.abs(d2[1]);
      if (horiz) { const x = Math.sign(D3[0] * X[0] + D3[1] * X[1] + D3[2] * X[2]) >= 0 ? D3 : D3.map((v) => -v); return { dir, x }; }
      const y = Math.sign(D3[0] * Y[0] + D3[1] * Y[1] + D3[2] * Y[2]) >= 0 ? D3 : D3.map((v) => -v);
      return { dir, x: n3(cross3(y, dir)) };
    };
    const sides = [{ m: m3, m2 }, { m: m3.map((v) => -v), m2: [-m2[0], -m2[1]] }].map((q) => ({ ...q, ...frame(q.m), plane: { p: p3, n: q.m } }));
    const geoms = await this.run('Cutting the section', () => this.computeViews(par.src, sides.map((q) => ({ dir: q.dir, x: q.x, plane: q.plane })), par));
    if (!geoms) { this.endTool(); return; }
    sides.forEach((q, i) => { q.g = geoms[i]; });
    st.sides = sides; st.geoms = geoms; st.place = true; st.am = a; st.bm = b;
  }
  sectionSide(st, p) { const mid = [(st.a[0] + st.b[0]) / 2, (st.a[1] + st.b[1]) / 2], r = sub(p, mid); return st.sides[(r[0] * st.sides[0].m2[0] + r[1] * st.sides[0].m2[1]) >= 0 ? 0 : 1]; }
  sectionPos(st, side, p) {
    const par = st.par, sh = this.sheetOf(par), s = viewScale(par, sh), g = side.g, w = (g.box[2] - g.box[0]) * s, hh = (g.box[3] - g.box[1]) * s, pr = viewRect(par, sh), m = side.m2;
    if (side.free) return { pos: p.slice(), sideName: 'free' };
    if (Math.abs(m[0]) > 0.999) return { pos: [m[0] > 0 ? Math.max(p[0], pr[2] + w / 2 + 5) : Math.min(p[0], pr[0] - w / 2 - 5), par.pos[1]], sideName: m[0] > 0 ? 'right' : 'left' };
    if (Math.abs(m[1]) > 0.999) return { pos: [par.pos[0], m[1] > 0 ? Math.max(p[1], pr[3] + hh / 2 + 5) : Math.min(p[1], pr[1] - hh / 2 - 5)], sideName: m[1] > 0 ? 'above' : 'below' };
    return { pos: p.slice(), sideName: 'free' };
  }
  sectionPreview(st, p) {
    const side = this.sectionSide(st, p), { pos } = this.sectionPos(st, side, p), sh = this.sheetOf(st.par);
    const ghost = { pos, geom: side.g, scale: st.par.scale, sheet: st.par.sheet }, { f } = viewXf(ghost, sh), prims = [];
    if (!side.g.edges.length) { const r = viewRect(ghost, sh); prims.push({ t: 'line', pts: [r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[3], r[0], r[1]], w: 0.3, color: '#2a6fd6', dash: [2, 1.5], screen: true }); }
    for (const e of side.g.edges) { if (e.cls !== 'v') continue; const q = []; for (let i = 0; i < e.pts.length; i += 2) q.push(...f(e.pts[i], e.pts[i + 1])); prims.push({ t: 'line', pts: q, w: 0.3, color: '#2a6fd6', screen: true }); }
    prims.push({ t: 'line', pts: [...st.a, ...st.b], w: 0.35, dash: [6, 1.5, 1, 1.5], color: '#2a6fd6', screen: true });
    const mid = [(st.a[0] + st.b[0]) / 2, (st.a[1] + st.b[1]) / 2];
    prims.push({ t: 'line', pts: [...mid, mid[0] - side.m2[0] * 8, mid[1] - side.m2[1] * 8], w: 0.35, color: '#2a6fd6', screen: true });
    this.setPreview(prims);
  }
  placeSection(st, p) {
    const side = this.sectionSide(st, p), { pos, sideName } = this.sectionPos(st, side, p), par = st.par;
    const used = new Set(this.doc.views.filter((v) => v.cut).map((v) => v.cut.letter));
    const letter = [...LETTERS].find((c) => !used.has(c)) || '?';
    const snap = this.snapshot();
    const v = { id: uid('v'), sheet: par.sheet, name: `Section ${letter}-${letter}`, src: par.src, srcName: par.srcName, dir: side.dir, x: side.x, plane: side.plane, pos, hidden: false, scale: par.scale ? par.scale.slice() : null, geom: side.g, ...(par.cloud ? { cloud: { ...par.cloud, clip: { ...par.cloud.clip, on: false } } } : {}), parent: par.id, side: sideName, cut: { a: st.am, b: st.bm, m2: side.m2, letter } };
    this.doc.views.push(v);
    this.pushUndo(snap); this.sel = v.id; this.app.setDirty(true); this.renderTree();
    this.endTool();
    this.app.setStatus(`Section ${letter}-${letter} placed`);
    return v;
  }

  // ======================= annotations =======================
  ann(viewId, id) { return this.V(viewId)?.anns?.find((a) => a.id === id); }
  addAnn(v, a) { const snap = this.snapshot(); a.id = uid('a'); (v.anns ||= []).push(a); this.pushUndo(snap); this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); return a; }
  // preview of a not yet placed annotation
  annPreview(v, a, extra = []) {
    const tmp = { ...a, id: '__prev' };
    this.setPreview([...extra, { t: 'annprev', view: v.id, ann: tmp }]);
  }
  cmdDimension() {
    const st = { items: [], v: null };
    const opt = { mode: 'auto', circle: 'dia', chain: false, total: true };
    const pm = this.app.pm.show({
      title: 'Smart Dimension', iconName: 'dimension', values: opt,
      fields: [{ type: 'info', key: 'msg', text: 'Click a line (length), two points, two lines (angle) or a circle / arc (diameter or radius). Then click where the dimension goes. Esc ends.' },
        { key: 'mode', type: 'select', label: 'Length', options: [{ value: 'auto', label: 'Automatic (by mouse position)' }, { value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }, { value: 'aligned', label: 'Aligned (true length)' }] },
        { key: 'circle', type: 'select', label: 'Circles and arcs', options: [{ value: 'dia', label: 'Diameter Ø' }, { value: 'rad', label: 'Radius R' }] },
        { key: 'chain', type: 'check', label: 'Chain: click points / walls / openings in a row, Enter or right click, then place' },
        { key: 'total', type: 'check', label: 'Chain: add the overall dimension' }],
      onChange: (v) => Object.assign(opt, v),
      onCancel: () => this.endTool(),
    });
    void pm;
    const build = (p) => {
      const it = st.items, v = st.v; if (!v || !it.length) return null;
      const at = this.toModel(v, p);
      if (it.length === 1 && it[0].kind === 'circle') return { type: opt.circle, c: it[0].c, r: it[0].r, at };
      if (it.length === 1 && it[0].kind === 'opening') return withFit({ type: 'len', a: it[0].a, b: it[0].b, mode: 'aligned', at }, it);
      let A, B;
      if (it.length === 1 && it[0].kind === 'line') [A, B] = [it[0].a, it[0].b];
      else if (it.length === 2 && it[0].kind === 'pt' && it[1].kind === 'pt') [A, B] = [it[0].q, it[1].q];
      else if (it.length === 2 && it[0].kind === 'line' && it[1].kind === 'line') {
        if (parallel(it[0], it[1])) return withFit(gapAnn(it[0], it[1], at), it);
        return this.angleAnn(it[0], it[1], at);
      } else if (it.length === 2 && (it[0].kind === 'line') !== (it[1].kind === 'line')) {
        const L = it[0].kind === 'line' ? it[0] : it[1], P = it[0].kind === 'line' ? it[1] : it[0];
        return withFit({ type: 'len', a: P.q, b: footOn(L, P.q), mode: 'aligned', at }, it);
      }
      if (!A) return null;
      let mode = opt.mode;
      if (mode === 'auto') {
        const d = sub(B, A);
        if (Math.abs(d[0]) < 1e-6 * (Math.abs(d[1]) + 1) || Math.abs(d[1]) < 1e-6 * (Math.abs(d[0]) + 1)) mode = 'aligned';
        else { const xin = at[0] > Math.min(A[0], B[0]) && at[0] < Math.max(A[0], B[0]), yin = at[1] > Math.min(A[1], B[1]) && at[1] < Math.max(A[1], B[1]); mode = xin && !yin ? 'h' : yin && !xin ? 'v' : 'aligned'; }
      }
      return { type: 'len', a: A, b: B, mode, at };
    };
    const item = (sn) => {
      if (sn.kind === 'pt' || sn.kind === 'center') return { kind: 'pt', q: sn.q, cfit: sn.corner ? { sigma: Math.max(sn.corner.l1.sigma, sn.corner.l2.sigma), n: Math.min(sn.corner.l1.n, sn.corner.l2.n) } : null };
      const e = sn.e;
      if (e.type === 'circle') return { kind: 'circle', c: e.c, r: e.r };
      if (e.opening) return { kind: 'opening', a: e.opening.a, b: e.opening.b, fit: { sigma: e.fit.sigma, n: e.fit.n } };
      if (e.type === 'line') return { kind: 'line', a: [e.pts[0], e.pts[1]], b: [e.pts[2], e.pts[3]], q: sn.q || null, fit: e.fit ? { sigma: e.fit.sigma, n: e.fit.n } : null };
      return null;
    };
    const ready = () => { const it = st.items; return (it.length === 1 && (it[0].kind === 'circle' || it[0].kind === 'line' || it[0].kind === 'opening')) || it.length === 2; };
    // chain: points along a wall -> a row of dimensions at the same distance (+ overall)
    const chainPts = () => st.items.flatMap((it) => (it.kind === 'opening' ? [it.a, it.b] : it.kind === 'line' ? [it.q || it.a] : it.kind === 'pt' ? [it.q] : []));
    const chainAnns = (p) => {
      const P = chainPts(); if (P.length < 2 || !st.v) return [];
      const D = nrm(sub(P[P.length - 1], P[0])), at = this.toModel(st.v, p);
      const S = P.slice().sort((a, b) => (a[0] - P[0][0]) * D[0] + (a[1] - P[0][1]) * D[1] - ((b[0] - P[0][0]) * D[0] + (b[1] - P[0][1]) * D[1]));
      const mode = opt.mode !== 'auto' ? opt.mode : Math.abs(D[0]) > 0.985 ? 'h' : Math.abs(D[1]) > 0.985 ? 'v' : 'aligned';
      const out = [];
      for (let i = 0; i + 1 < S.length; i++) if (len(sub(S[i + 1], S[i])) > 1e-6) out.push(withFit({ type: 'len', a: S[i], b: S[i + 1], mode, at: at.slice(), chain: i }, st.items));
      if (opt.total && out.length > 1) {
        const n = [-D[1], D[0]], side = Math.sign((at[0] - S[0][0]) * n[0] + (at[1] - S[0][1]) * n[1]) || 1, k = 8 / viewScale(st.v, this.sheetOf(st.v));
        out.push(withFit({ type: 'len', a: S[0], b: S[S.length - 1], mode, at: [at[0] + n[0] * side * k, at[1] + n[1] * side * k] }, st.items));
      }
      return out;
    };
    const chainMarks = () => (st.v ? chainPts().map((q) => ({ t: 'circle', c: this.toSheetPt(st.v, q), r: 1, w: 0.4, color: '#2a6fd6', screen: true })) : []);
    this.startTool({
      move: (p) => {
        const sn = this.snapAt(p, st.v?.id);
        const mark = this.hoverMark(sn);
        if (opt.chain) {
          if (st.place) this.setPreview([...chainAnns(p).map((a, i) => ({ t: 'annprev', view: st.v.id, ann: { ...a, id: '__c' + i } }))]);
          else this.setPreview([...mark, ...chainMarks()]);
          return;
        }
        const a = ready() ? build(p) : null;
        if (a) this.annPreview(st.v, a, mark); else this.setPreview(mark);
      },
      click: (p) => {
        const sn = this.snapAt(p, st.v?.id);
        const it = sn && item(sn);
        if (opt.chain) {
          if (st.place) {
            const anns = chainAnns(p);
            if (anns.length) { const snap = this.snapshot(); for (const a of anns) { a.id = uid('a'); (st.v.anns ||= []).push(a); } this.pushUndo(snap); this.app.setDirty(true); this.renderTree(); this.app.setStatus(`Chain of ${anns.length} dimensions placed`); }
            st.items = []; st.v = null; st.place = false; this.setPreview(null); return;
          }
          if (!it || it.kind === 'circle') return;
          if (!st.items.length) st.v = sn.v;
          st.items.push(it); this.setPreview([...this.hoverMark(sn), ...chainMarks()]); return;
        }
        // second line -> angle; second point -> distance; otherwise place
        if (it && st.items.length === 1 && (it.kind === 'line' || it.kind === 'pt') && (st.items[0].kind === 'line' || st.items[0].kind === 'pt')) {
          if (it.kind === 'line' && st.items[0].kind === 'line' && sameLine(st.items[0], it)) { toast('That is the same line: click a second line, or click where the length goes'); return; }
          st.items.push(it); return;
        }
        if (ready()) { const a = build(p); if (a) { this.addAnn(st.v, a); this.app.setStatus(`${a.type === 'ang' ? 'Angle' : a.type === 'len' ? 'Length' : a.type === 'dia' ? 'Diameter' : 'Radius'}: ${fmt(annValue(a), 3)}${a.type === 'ang' ? '°' : ' mm'}${a.fit ? `  (fitted planes, scatter ±${fmt(a.fit.sigma, 1)} mm)` : ''}`); } st.items = []; st.v = null; this.setPreview(null); return; }
        if (!it) return;
        if (!st.items.length) st.v = sn.v;
        st.items.push(it);
      },
      context: () => { if (opt.chain && chainPts().length >= 2) { st.place = true; this.app.setStatus('Click where the chain goes'); } return true; },
      key: (e) => { if (opt.chain && e.key === 'Enter' && chainPts().length >= 2) { st.place = true; this.app.setStatus('Click where the chain goes'); return true; } if (e.key === 'Backspace' && st.items.length) { st.items.pop(); if (!st.items.length) st.v = null; this.setPreview(null); return true; } return false; },
    });
  }
  angleAnn(l1, l2, at) {
    // intersection of the two (infinite) lines
    const p = l1.a, r = sub(l1.b, l1.a), q = l2.a, s2 = sub(l2.b, l2.a), rxs = r[0] * s2[1] - r[1] * s2[0];
    if (Math.abs(rxs) < 1e-12) return null;
    const t = ((q[0] - p[0]) * s2[1] - (q[1] - p[1]) * s2[0]) / rxs, X = [p[0] + r[0] * t, p[1] + r[1] * t];
    // rays towards the mouse side
    const w = sub(at, X);
    let d1 = nrm(r), d2 = nrm(s2);
    if (d1[0] * w[0] + d1[1] * w[1] < 0) d1 = [-d1[0], -d1[1]];
    if (d2[0] * w[0] + d2[1] * w[1] < 0) d2 = [-d2[0], -d2[1]];
    return { type: 'ang', x: X, d1, d2, at };
  }
  cmdArea() {
    const st = { pts: [], v: null, circle: null, place: false };
    this.app.pm.show({ title: 'Area', iconName: 'polyline', fields: [{ type: 'info', text: 'Click the corner points of the area (they snap to model points); right click or Enter closes it. Or click a circle for its area. Then click where the label goes.' }], onCancel: () => this.endTool() });
    const close = () => { if (st.pts.length >= 3) { st.place = true; this.app.setStatus('Click where the area label goes'); } };
    const ann = (p) => ({ type: 'area', ...(st.circle ? { c: st.circle.c, r: st.circle.r } : { pts: st.pts.map((q) => q.slice()) }), at: this.toModel(st.v, p) });
    this.startTool({
      move: (p) => {
        if (st.place) { this.annPreview(st.v, ann(p)); return; }
        const sn = this.snapAt(p, st.v?.id), prims = this.hoverMark(sn);
        if (st.pts.length) { const q = st.pts.flatMap((m) => this.toSheetPt(st.v, m)); const cur = sn && sn.kind !== 'edge' ? sn.S : p; prims.push({ t: 'line', pts: [...q, ...cur], w: 0.3, color: '#2a6fd6', screen: true }); }
        this.setPreview(prims);
      },
      click: (p) => {
        if (st.place) { this.addAnn(st.v, ann(p)); st.pts = []; st.v = null; st.circle = null; st.place = false; this.setPreview(null); return; }
        const sn = this.snapAt(p, st.v?.id);
        if (!st.pts.length && sn?.kind === 'edge' && sn.e.type === 'circle' && sn.e.full) { st.v = sn.v; st.circle = { c: sn.e.c, r: sn.e.r }; st.place = true; return; }
        const v = st.v || sn?.v || this.viewAt(p); if (!v) return;
        st.v = v;
        const q = sn && sn.kind !== 'edge' ? sn.q : this.toModel(v, p);
        if (st.pts.length >= 3 && len(sub(this.toSheetPt(v, st.pts[0]), this.toSheetPt(v, q))) < 8 / this.pxMm()) { close(); return; }
        st.pts.push(q);
      },
      key: (e) => { if (e.key === 'Enter') { close(); return true; } if (e.key === 'Backspace') { st.pts.pop(); return true; } return false; },
      context: () => { close(); return true; },
    });
  }
  // room: click inside a room on a point cloud plan -> outline from the scan (rays to the walls), area label
  cmdRoom() {
    this.app.pm.show({ title: 'Room Outline', iconName: 'room', fields: [{ type: 'info', text: 'Click inside a room on a point cloud floor plan. Its outline is found from the walls in the scan (door openings are closed) and labelled with its area. Click more rooms; Esc ends. Shift+click adds another space to the last room (L-shapes, corridor + room). Afterwards click a room (its text or outline) to change its name, line style and detection; double-click the name to rename it.' }], onCancel: () => this.endTool() });
    // Shift+click target: the room selected when the tool starts, then the last room made
    const sel = this.selAnn && this.ann(this.selAnn.view, this.selAnn.id);
    let last = sel?.type === 'area' && sel.pts ? { v: this.V(this.selAnn.view), a: sel } : null;
    this.startTool({
      click: async (p, e) => {
        const v = this.viewAt(p);
        if (!v?.geom?.fit) { toast('Click inside a room on a point cloud view'); return; }
        const q = this.toModel(v, p);
        let r;
        try { r = await this.roomCompute(v, q, styleOf(this.doc, null), null); } catch (e) { console.error('room slice', e); toast('Could not make the floor plan slice: ' + e.message, 'error', 5000); return; }
        const poly = r.poly;
        if (!poly) {
          const elev = Math.abs(v.dir?.[1] || 0) < 0.99;
          toast(elev ? (v.plane && v.cloud?.depth > 0 ? 'No room found: this section looks past the cut (View depth ' + v.cloud.depth + ' m), so the walls behind fill the openings. Set View depth to 0 (slice only), or use a floor plan.' : 'No room found here: in a side view or elevation the walls behind fill the openings. Use a floor plan (top view or horizontal section) or a section with View depth 0.') : 'No closed room found here. Click inside a room on a floor plan (a wall may be missing in the slice).', 'info', 7000);
          return;
        }
        const B = v.geom.box;
        try { window.__lithLog?.('ROOM', v.name, 'click', q.map(Math.round), 'slices', r.fits.length, 'area', poly ? (annValue({ type: 'area', pts: poly }) / 1e6).toFixed(3) : '-', 'n', poly ? poly.length : 0, 'opts', JSON.stringify(roomOpts(styleOf(this.doc, null)))); window.__lithLog?.('ROOMPTS', JSON.stringify(poly ? poly.map((p) => p.map(Math.round)) : null)); } catch {}
        if (poly && poly.some((p) => p[0] < B[0] || p[0] > B[2] || p[1] < B[1] || p[1] > B[3])) { console.warn('room outside view', JSON.stringify(poly.map((p) => p.map(Math.round)))); toast('The room outline leaks out of the building here (an opening without wall in the slice?). Try a floor plan view or click elsewhere in the room.', 'info', 6000); return; }
        if (Math.abs(annValue({ type: 'area', pts: poly })) < 0.5e6) { toast('Only a very small closed area found here (furniture?). Click in an open part of the room.', 'info', 5000); return; }
        if (e?.shiftKey) {
          if (!last || last.v !== v || !this.ann(v.id, last.a.id)) { toast('Shift+click adds a space to the last room: make or select a room in this view first'); return; }
          const L = last.a, J = joinRooms(L.pts, poly, r.d, styleOf(this.doc, L).join), U = J.poly;
          if (!U) { toast(JOIN_MSG[J.reason] || JOIN_MSG.far, 'info', 7000); return; }
          this.change(() => { L.qs = [...(L.qs || [L.q || L.at]), q]; L.pts = U; });
          try { window.__lithLog?.('ROOM add', v.name, L.label || '', 'click', q.map(Math.round), 'area', (annValue(L) / 1e6).toFixed(3), 'n', U.length, 'doors', J.doors ? J.doors.map((b) => (b.full ? 'full ' : '') + Math.round(b.width)).join('/') : '-'); window.__lithLog?.('ROOMPTS', JSON.stringify(U.map((p) => p.map(Math.round)))); } catch {}
          this.app.setStatus(`${L.label || 'Room'}: space added${J.doors ? ` ${J.doors[0].full ? ' over the full width (no doorway found between)' : ` through ${J.doors.length > 1 ? J.doors.length + ' doorways' : 'a doorway of ' + Math.round(J.doors[0].width) + ' mm'}`}` : ''}, ${fmt(annValue(L) / 1e6, 2)} m²`);
          return;
        }
        const n = this.nextRoomNo();
        const a = this.addAnn(v, { type: 'area', pts: poly, at: q, q, room: true, label: `Room ${n}` });
        last = { v, a };
        this.app.setStatus(`Room ${n}: ${fmt(annValue(a) / 1e6, 2)} m²`);
      },
    });
  }
  // next free room number (highest 'Room n' + 1, so renamed / deleted rooms do not give doubles)
  nextRoomNo() { let m = 0; for (const w of this.doc.views) for (const a of w.anns || []) { const k = /^Room (\d+)$/.exec(a.type === 'area' ? a.label || '' : ''); if (k) m = Math.max(m, +k[1]); } return m + 1; }
  // scale bar: click a spot on or near a view; length = a round number ≈ ¼ of the view width
  cmdScaleBar() {
    this.app.pm.show({ title: 'Scale Bar', iconName: 'dimension', fields: [{ type: 'info', text: 'Click where the scale bar starts (its left end), on or next to a view. Double-click it later to change its length.' }], onCancel: () => this.endTool() });
    this.startTool({
      click: (p) => {
        const v = this.viewAt(p) || this.viewNear(p, 40) || this.nearestView(p);
        if (!v) { toast('Put the scale bar next to a view'); return; }
        const b = v.geom.box, want = (b[2] - b[0]) / 4, nice = [1, 2, 5].flatMap((k) => [1, 10, 100, 1000, 10000, 100000].map((e) => k * e)).sort((x, y) => x - y);
        const len = nice.filter((q) => q <= want).pop() || nice[0];
        this.addAnn(v, { type: 'scalebar', len, n: 5, at: this.toModel(v, p) });
        this.app.pm.cancel?.(); this.endTool();
      },
    });
  }
  cmdNote() {
    const st = { anchor: null, v: null };
    this.app.pm.show({ title: 'Note', iconName: 'text', fields: [{ type: 'info', text: 'Click on a model edge or point for a note with an arrow, or on an empty spot for plain text. Then click where the text goes.' }], onCancel: () => this.endTool() });
    const finish = async (v, at) => {
      const text = await promptText('Note text', '');
      if (text) this.addAnn(v, { type: 'note', text, at, ...(st.anchor ? { anchor: st.anchor } : {}) });
      st.anchor = null; st.v = null; this.setPreview(null);
    };
    this.startTool({
      move: (p) => { const prims = st.v ? [] : this.hoverMark(this.snapAt(p)); if (st.anchor) { const A = this.toSheetPt(st.v, st.anchor); prims.push({ t: 'line', pts: [...A, ...p], w: 0.3, color: '#2a6fd6', screen: true }); } this.setPreview(prims); },
      click: (p) => {
        if (st.anchor) { finish(st.v, this.toModel(st.v, p)); return; }
        const sn = this.snapAt(p);
        if (sn) { st.v = sn.v; st.anchor = this.toModel(sn.v, sn.S); return; }
        const v = this.viewAt(p) || this.nearestView(p);
        if (!v) { toast('Put notes on or near a view'); return; }
        st.v = v; finish(v, this.toModel(v, p));
      },
    });
  }
  // view whose box (grown by `m` mm) contains p
  viewNear(p, m, ok = () => true) {
    const vs = this.doc.views.filter((q) => q.sheet === this.sheetId && q.geom && ok(q)).map((v) => { const r = viewRect(v, this.sheetOf(v)); return { v, r, d: Math.max(r[0] - p[0], p[0] - r[2], r[1] - p[1], p[1] - r[3], 0) }; }).filter((q) => q.d <= m);
    vs.sort((a, b) => a.d - b.d);
    return vs[0]?.v || null;
  }
  nearestView(p) {
    let best = null, bd = Infinity;
    for (const v of this.doc.views.filter((q) => q.sheet === this.sheetId && q.geom)) { const r = viewRect(v, this.sheetOf(v)), c = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], d = len(sub(c, p)); if (d < bd) { bd = d; best = v; } }
    return best;
  }
  cmdDimStyle() { this.cmdDraftStd(); }
  // room outline at q with the room settings st (slices → merged sample → roomAt); writes the test file
  async roomCompute(v, q, st, label) {
    const fits = await this.roomFits(v, st), d = mergeData(fits.map(fitData)), opts = roomOpts(st);
    const poly = d && roomAt(d, q, 25000, opts);
    this.roomDump(v, q, fits, opts, poly, label);
    return { poly, fits, d };
  }
  // room test file (Logs\rooms): the scan sample, click, settings and result, to rerun detection exactly
  roomDump(v, q, fits, opts, poly, label) {
    try {
      const t = new Date(), name = `room-${t.toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${Math.round(q[0])}_${Math.round(q[1])}.json`;
      api.logDump?.(name, JSON.stringify({ time: t.toISOString(), file: this.app.path || '', view: v.name, label, q, opts, fits, result: poly ? poly.map((p) => p.map((x) => Math.round(x))) : null }));
    } catch (e) { console.warn('room dump', e); }
  }
  // annotation under p (its text box)
  annAt(p) {
    const prims = this._annBoxes || sheetPrimsCache(this);
    const t = 1.5 / 1; // mm tolerance
    for (const q of prims) if (q.t === 'annbox' && p[0] >= q.box[0] - t && p[0] <= q.box[2] + t && p[1] >= q.box[1] - t && p[1] <= q.box[3] + t) return { view: q.view, id: q.ann };
    // room / area outlines: within 5 px of the line
    const tp = 5 / Math.max(1e-6, Math.abs(this.affine().ex[0]));
    for (const q of prims) if (q.t === 'annpath' && q.view) for (let i = 0; i + 3 < q.pts.length; i += 2) if (segDist(p, q.pts[i], q.pts[i + 1], q.pts[i + 2], q.pts[i + 3]) <= tp) return { view: q.view, id: q.ann, path: true };
    return null;
  }
  deleteAnn() {
    const s = this.selAnn; if (!s) return;
    this.change(() => { const v = this.V(s.view); v.anns = (v.anns || []).filter((a) => a.id !== s.id); this.selAnn = null; });
  }
  async editAnn(s) {
    const a = this.ann(s.view, s.id); if (!a) return;
    if (a.type === 'area') { this.inlineRename(s); return; }
    if (a.type === 'note') { const t = await promptText('Note text', a.text); if (t != null && t !== a.text) this.change(() => { a.text = t; }); }
    else if (a.type === 'rad' || a.type === 'dia') this.change(() => { a.type = a.type === 'rad' ? 'dia' : 'rad'; });
    else if (a.type === 'len') this.change(() => { a.mode = { aligned: 'h', h: 'v', v: 'aligned' }[a.mode] || 'aligned'; });
    else if (a.type === 'scalebar') { const t = await promptText('Scale bar length (m)', String(a.len / 1000)); const m = parseFloat(String(t ?? '').replace(',', '.')); if (m > 0) this.change(() => { a.len = m * 1000; }); }
  }
}
// two (fitted) lines within 3° count as parallel: the dimension is their perpendicular distance
const ldir = (l) => nrm(sub(l.b, l.a));
function parallel(l1, l2) { const a = ldir(l1), b = ldir(l2); return Math.abs(a[0] * b[1] - a[1] * b[0]) < Math.sin((3 * Math.PI) / 180); }
function footOn(l, q) { const d = ldir(l), t = (q[0] - l.a[0]) * d[0] + (q[1] - l.a[1]) * d[1]; return [l.a[0] + d[0] * t, l.a[1] + d[1] * t]; }
function sameLine(l1, l2) { if (!parallel(l1, l2)) return false; const f = footOn(l1, l2.a); return len(sub(f, l2.a)) < 1e-6 * (1 + len(l2.a)) + (l1.fit ? 3 * l1.fit.sigma + 2 : 0); }
// distance between parallel lines: from the first pick (or the middle of line 1) square across to line 2 (mean direction)
function gapAnn(l1, l2, at) {
  let d1 = ldir(l1), d2 = ldir(l2); if (d1[0] * d2[0] + d1[1] * d2[1] < 0) d2 = [-d2[0], -d2[1]];
  const d = nrm([d1[0] + d2[0], d1[1] + d2[1]]), n = [-d[1], d[0]];
  const a = l1.q || [(l1.a[0] + l1.b[0]) / 2, (l1.a[1] + l1.b[1]) / 2], m2 = [(l2.a[0] + l2.b[0]) / 2, (l2.a[1] + l2.b[1]) / 2];
  const g = (m2[0] - a[0]) * n[0] + (m2[1] - a[1]) * n[1];
  return { type: 'len', a, b: [a[0] + n[0] * g, a[1] + n[1] * g], mode: 'aligned', at };
}
function withFit(a, items) { const f = items.map((i) => i.fit || i.cfit).filter(Boolean); if (f.length) a.fit = { sigma: Math.max(...f.map((x) => x.sigma)), n: Math.min(...f.map((x) => x.n)) }; return a; }
function crossDir(l1, l2) { const r = nrm(sub(l1.b, l1.a)), s = nrm(sub(l2.b, l2.a)); return r[0] * s[1] - r[1] * s[0]; }
// annotation boxes of the current sheet (rebuilt per call; cheap enough for clicks)
import { sheetPrims } from './sheet.js';
import { unionOrtho, joinRooms, JOIN_MSG } from './outline.js';
function sheetPrimsCache(doc) { return sheetPrims(doc.doc, doc.sheet).filter((q) => q.t === 'annbox' || q.t === 'annpath'); }
function segDist(p, x0, y0, x1, y1) { const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p[0] - x0) * dx + (p[1] - y0) * dy) / l2)); return Math.hypot(p[0] - x0 - dx * t, p[1] - y0 - dy * t); }
export { centroid, scaleText, h };
