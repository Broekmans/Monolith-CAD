// Drawing document (.lithdrw): paper sheets (A4–A0) with views of parts and assemblies, title block,
// PDF export. View geometry comes from the kernel's hidden-line removal (kernel/drawing.mjs, op
// 'drawView') and is stored in the document, so a drawing opens without the kernel; "Rebuild Views"
// recomputes it from the model files. Third angle projection.
import { Viewport } from '../viewport.js';
import { ViewSet } from '../viewset.js';
import { h, fmt, contextMenu, toast } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { loadPart } from '../assembly/assembly.js';
import { SIZES, SCALES, STD, scaleText, scaleVal, projected, isOrtho, viewRect, frameRect, sheetPrims, sheetSize, drawArea, TB_FIELDS, zoneGrid } from './sheet.js';

export const PAPER = '#f3e9cf'; // warm paper colour on screen (the PDF stays white)
import { makePdf, makePdfCompressed, EM } from './pdf.js';
import { paintDots } from './dots.js';
import { paintRaster, loadRaster, onRasterReady } from './raster.js';
import { DrawingClouds, isCloudSrc, CLOUD_EXTS, cloudDefaults, PRESETS } from './cloudview.js';
import { DrawingTools } from './tools.js';
import { DrawingSections } from './sections.js';
import { DrawingOverlay } from './overlay.js';
import { DrawingProps } from './props.js';
import { DrawingOutline } from './outline.js';
import { DrawingRooms } from './rooms.js';
import { DrawingInfo } from './info.js';
import { setCompanyStd, companyStd, clean } from './styles.js';

const today = () => new Date().toISOString().slice(0, 10);
const fileName = (p) => p.split(/[\\/]/).pop();
const baseName = (p) => fileName(p).replace(/\.[^.]+$/, '');
const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4);

export function newDrawingDoc(name = 'Drawing1') {
  return {
    kind: 'drawing', version: 1, name,
    sheets: [{ id: 'sh1', name: 'Sheet1', size: 'A3', orient: 'landscape', scale: [1, 1] }],
    views: [],
    titleBlock: { company: '', title: name, number: '', drawnBy: '', date: today(), revision: 'A' },
  };
}

export class DrawingDoc {
  constructor(app, doc) {
    this.app = app; this.doc = doc;
    doc.sheets ||= []; doc.views ||= []; doc.titleBlock ||= {};
    if (!doc.sheets.length) doc.sheets.push({ id: 'sh1', name: 'Sheet1', size: 'A3', orient: 'landscape', scale: [1, 1] });
    this.sheetId = doc.sheets[0].id;
    this.sel = null;
    this.undoStack = []; this.redoStack = [];
    this.busy = false;
    this.showFrames = true;
    this.tool = null; this.preview = null; this.selAnn = null;
  }
  get title() { return this.doc.name; }
  get sheet() { return this.doc.sheets.find((s) => s.id === this.sheetId) || this.doc.sheets[0]; }
  toJSON() { return this.doc; }
  V(id) { return this.doc.views.find((v) => v.id === id); }

  // ======================= setup =======================
  init() {
    const app = this.app;
    this.viewSet = new ViewSet(app.el.views, { mode: 'plan', cls: ['paper', 'drawing'] }); // Viewport menu: 1, 2 or 4 panes of the sheet
    this.vp = this.viewport = this.viewSet.proxy;
    this.viewSet.onLayout = () => app.syncViewportMenu?.(); // close / maximize from the pane buttons
    this.vp.overlayDrawers.push((ctx) => this.draw(ctx));
    onRasterReady(() => this.vp.requestRender());
    this.vp.onContextMenu = (e) => this.contextMenu(e);
    this.vp.onMiddleClick = () => this.zoomFit(); // double middle click = Zoom to Fit
    this.bind();
    api.draftStd?.().then((r) => { setCompanyStd(clean(r || {})); if (!this.doc.style && !this.doc.views.length) this.doc.style = companyStd(); this.vp.requestRender(); }).catch(() => {});
    this.buildCommands();
    this.buildHeadsUp();
    app.showPanel('tree');
    this.renderTree();
    app.setStatusRight('mm');
    requestAnimationFrame(() => { this.zoomFit(false); if (this.doc.viewLayout) this.viewSet.restore(this.doc.viewLayout); });
  }
  // Viewport menu: layout of 1, 2 or 4 panes (saved in the file with each pane's view)
  setViewLayout(name) { this.viewSet.setLayout(name, { fit: () => this.zoomFit(false) }); this.app.setStatus(name === 'single' ? 'Single view' : 'Click in a view to make it the active one (blue border); commands like Zoom to Fit act on it'); }
  resetViews() { this.viewSet.resetViews(() => this.zoomFit(false)); }
  beforeSave() { const s = this.viewSet.toJSON(); if (s.layout === 'single') delete this.doc.viewLayout; else this.doc.viewLayout = s; }
  buildCommands() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const idle = () => !this.app.pm.open && !this.busy;
    const selV = () => this.V(this.sel);
    // groups per tab: easy to move buttons between tabs later
    const G = {
      views: [C('modelView', 'Model View', 'views', () => this.cmdModelView(false), { enabled: idle, tip: 'Place one view of a part or assembly (front, top, right, …, isometric)' }),
        C('std3', 'Standard 3 Views', 'section', () => this.cmdModelView(true), { enabled: idle, tip: 'Front, top and right view in third angle projection, scaled to fit the sheet' }),
        C('projView', 'Projected View', 'normalTo', () => this.cmdProjected(), { enabled: () => idle() && !!selV() && isOrtho(selV()), tip: 'Select a view, then move the mouse: right/left/up/down = projected view (stays aligned), diagonal = isometric view. Click to place.' }),
        C('secView', 'Section View', 'section', () => this.cmdSection(), { enabled: () => idle() && this.doc.views.some((v) => v.sheet === this.sheetId && isOrtho(v)), tip: 'Draw a cutting line across a view, then place the section A–A (cut faces hatched)' })],
      rebuild: [C('rebuild', 'Rebuild Views', 'history', () => this.rebuildViews(), { enabled: () => idle() && this.doc.views.length > 0, tip: 'Read the part / assembly files again and redraw all views' })],
      output: [C('pdf', 'Export PDF', 'export', () => this.exportPdf(), { enabled: () => !this.busy, tip: 'All sheets as one PDF, true to scale (print at 100%)' })],
      edit: [C('delView', 'Delete', 'delete', () => (this.selAnn ? this.deleteAnn() : this.deleteView()), { enabled: () => idle() && (!!selV() || !!this.selAnn) }),
        C('undo', 'Undo', 'undo', () => this.undo(), { enabled: () => idle() && this.undoStack.length > 0 }),
        C('redo', 'Redo', 'redo', () => this.redo(), { enabled: () => idle() && this.redoStack.length > 0 })],
      format: [C('sheetFmt', 'Sheet Format', 'grid', () => this.cmdSheet(), { enabled: idle, tip: 'Paper size, orientation and scale of this sheet' }),
        C('zones', 'Zone Grid', 'layers', () => this.cmdZones(), { enabled: idle, active: () => !!this.sheet.zones?.on, tip: 'Letters (A, B, C…) and numbers (1, 2, 3…) along the sheet edge' })],
      annotate: [C('smartDim', 'Smart Dimension', 'dimension', () => this.cmdDimension(), { enabled: () => idle() && this.doc.views.length > 0, active: () => this.tool && this.app.pm.current?.title === 'Smart Dimension', tip: 'Length of a line or between two points, angle between two lines, diameter or radius of a circle / arc' }),
        C('area', 'Polygon Area', 'areaPoly', () => this.cmdArea(), { enabled: () => idle() && this.doc.views.length > 0, tip: 'Area of a closed outline (click its corners) or of a circle' }),
        C('room', 'Room Outline', 'room', () => this.cmdRoom(), { enabled: () => idle() && this.doc.views.some((v) => v.geom?.fit), tip: 'Click inside a room on a point cloud plan: outline from the walls, name and area. Click the room afterwards to change its outline settings.' }),
        C('scaleBar', 'Scale Bar', 'scaleBar', () => this.cmdScaleBar(), { enabled: () => idle() && this.doc.views.length > 0, tip: 'Checkered scale bar (0 … 1 m style), true to the view scale' }),
        C('note', 'Note / Leader', 'leader', () => this.cmdNote(), { enabled: () => idle() && this.doc.views.length > 0, tip: 'Text, with an arrow when you start on the model' })],
      rooms: [C('roomList', 'Room List', 'layers', () => this.cmdRoomList(), { active: () => !!this._rl, tip: 'List of all rooms with area, perimeter and size. Click a column head to sort, type in a name to rename, CSV for Excel.' })],
      dimStyle: [C('dimStyle', 'Drafting Standard', 'gear', () => this.cmdDraftStd(), { enabled: idle, tip: 'Units, text, dimension lines, arrows, room outlines and straightening for this drawing; save / load / import / export the company standard' })],
      title: [C('titleBlock', 'Title Block', 'text', () => this.cmdTitleBlock(), { enabled: idle, tip: 'Company, title, drawing number, drawn by, date, revision' })],
      sheets: [C('addSheet', 'Add Sheet', 'plus', () => this.addSheet(), { enabled: idle }),
        C('delSheet', 'Delete Sheet', 'delete', () => this.deleteSheet(), { enabled: () => idle() && this.doc.sheets.length > 1 })],
    };
    const NAMES = { views: 'Create', rebuild: 'Update', output: 'Export', edit: 'Edit', format: 'Sheet', annotate: 'Dimension & Notes', rooms: 'Table', dimStyle: 'Format', title: 'Title Block', sheets: 'Sheets' };
    for (const [k, l] of Object.entries(NAMES)) if (G[k]) G[k].label = l;
    const TABS = [['Drawing', ['views', 'rebuild', 'output', 'edit']], ['Annotate', ['annotate', 'rooms', 'dimStyle', 'edit']], ['Sheet', ['format', 'title', 'sheets', 'output']]];
    this.app.cm.setTabs(TABS.map(([name, gs]) => ({ name, groups: gs.map((g) => G[g]) })), 'Drawing');
  }
  buildHeadsUp() {
    const bar = this.app.el.headsUp;
    bar.innerHTML = '';
    bar.append(h('button', { class: 'hu-btn', title: 'Zoom to sheet (F)', html: icon('zoomFit'), onclick: () => this.zoomFit() }));
  }
  zoomFit(animate = true) {
    const [W, H] = sheetSize(this.sheet), m = 8;
    this.vp.fit({ min: [-m, 0, -H - m], max: [W + m, 0, m] }, animate);
    this.vp.requestRender();
  }
  // ---------- coordinates (sheet mm, y up) ----------
  affine() {
    const o = this.vp.toScreen([0, 0, 0]), ex = this.vp.toScreen([1, 0, 0]), ey = this.vp.toScreen([0, 0, -1]);
    return { o, ex: [ex[0] - o[0], ex[1] - o[1]], ey: [ey[0] - o[0], ey[1] - o[1]] };
  }
  S2(p, A = this._A) { return [A.o[0] + A.ex[0] * p[0] + A.ey[0] * p[1], A.o[1] + A.ex[1] * p[0] + A.ey[1] * p[1]]; }
  toSheet(sx, sy) { const A = this.affine(); return [(sx - A.o[0]) / A.ex[0], (sy - A.o[1]) / A.ey[1]]; }

  // ======================= drawing on screen =======================
  draw(ctx) {
    const A = (this._A = this.affine()), k = A.ex[0];
    const [W, H] = sheetSize(this.sheet);
    const a = this.S2([0, 0]), b = this.S2([W, H]);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(a[0] + 4, b[1] + 4, b[0] - a[0], a[1] - b[1]);
    ctx.fillStyle = PAPER; ctx.fillRect(a[0], b[1], b[0] - a[0], a[1] - b[1]);
    const prims = sheetPrims(this.doc, this.sheet, { selected: this.sel, selAnn: this.selAnn?.id, preview: this.preview });
    this._annBoxes = prims.filter((q) => q.t === 'annbox' || q.t === 'annpath');
    this.paint(ctx, prims, (p) => this.S2(p, A), k);
    this.drawOutlineGrips(ctx);
    this.drawDotGrip(ctx);
    const set = this.viewSet; if (set.panes.length > 1 && this.vp.pane !== set.active) return; // popups / panels follow the active pane
    this.syncProps(); this.syncInfo();
    this.syncRoomList();
  }
  // draw primitives with a sheet->pixel mapping S (k = pixels per mm)
  paint(ctx, prims, S, k) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const p of prims) {
      if (p.t === 'dots') { paintDots(ctx, p, S, k); continue; }
      if (p.t === 'raster') { paintRaster(ctx, p, S); continue; }
      if (p.t === 'line' || p.t === 'sel') {
        const q = p.pts; if (q.length < 4) continue;
        ctx.beginPath();
        let s = S([q[0], q[1]]); ctx.moveTo(s[0], s[1]);
        for (let i = 2; i < q.length; i += 2) { s = S([q[i], q[i + 1]]); ctx.lineTo(s[0], s[1]); }
        if (p.t === 'sel') { if (!this.showFrames) continue; ctx.strokeStyle = p.on ? '#2a6fd6' : 'rgba(90,80,60,0.45)'; ctx.lineWidth = p.on ? 1.3 : 1; ctx.setLineDash(p.on ? [5, 4] : [2, 3]); }
        else { ctx.strokeStyle = p.color || '#000'; ctx.lineWidth = Math.max(0.6, p.w * k); ctx.setLineDash(p.dash ? p.dash.map((d) => Math.max(1, d * k)) : []); }
        ctx.stroke();
      } else if (p.t === 'fill') {
        const q = p.pts; ctx.beginPath(); let s0 = S([q[0], q[1]]); ctx.moveTo(s0[0], s0[1]);
        for (let i = 2; i < q.length; i += 2) { s0 = S([q[i], q[i + 1]]); ctx.lineTo(s0[0], s0[1]); }
        ctx.closePath(); ctx.fillStyle = p.color || '#000'; if (p.alpha != null) { ctx.globalAlpha = p.alpha; ctx.fill(); ctx.globalAlpha = 1; } else ctx.fill();
      } else if (p.t === 'circle') {
        const c = S(p.c); ctx.setLineDash([]); ctx.strokeStyle = p.color || '#000'; ctx.lineWidth = Math.max(0.6, p.w * k);
        ctx.beginPath(); ctx.arc(c[0], c[1], p.r * k, 0, Math.PI * 2); ctx.stroke();
      } else if (p.t === 'text') {
        const px = p.size * EM * k;
        if (px < 2) continue;
        const s = S([p.x, p.y]);
        ctx.fillStyle = p.color || '#000';
        ctx.font = `${p.bold ? 'bold ' : ''}${px}px Helvetica, Arial, sans-serif`;
        ctx.textAlign = p.align === 'c' ? 'center' : p.align === 'r' ? 'right' : 'left';
        ctx.textBaseline = 'alphabetic';
        if (p.rot) { ctx.save(); ctx.translate(s[0], s[1]); ctx.rotate(-p.rot); ctx.fillText(p.text, 0, 0); ctx.restore(); } else ctx.fillText(p.text, s[0], s[1]);
      }
    }
    ctx.setLineDash([]);
  }
  makeThumb() {
    try {
      const sh = this.doc.sheets[0], [W, H] = sheetSize(sh), cw = 320, chh = 200;
      const k = Math.min((cw - 16) / W, (chh - 16) / H), ox = (cw - W * k) / 2, oy = (chh + H * k) / 2;
      const cv = document.createElement('canvas'); cv.width = cw; cv.height = chh;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#dfe4ea'; ctx.fillRect(0, 0, cw, chh);
      ctx.fillStyle = PAPER; ctx.fillRect(ox, oy - H * k, W * k, H * k);
      this.showFrames = false;
      try { this.paint(ctx, sheetPrims(this.doc, sh), (p) => [ox + p[0] * k, oy - p[1] * k], k); } finally { this.showFrames = true; }
      return cv.toDataURL('image/jpeg', 0.8);
    } catch { return null; }
  }

  // ======================= mouse =======================
  bind() {
    const el = this.vp.el;
    let drag = null;
    const at = (e) => { const r = el.getBoundingClientRect(); return { p: this.toSheet(e.clientX - r.left, e.clientY - r.top) }; };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      const { p } = at(e);
      this._free = e.shiftKey;
      if (this.tool) { this.tool.click?.(p, e); this.vp.requestRender(); return; }
      // the dot of a selected room / area label, then the grips of its outline
      const dg = !this.app.pm.open && this.dotGripAt(p);
      if (dg) { drag = this.dotDragStart(dg, p); el.setPointerCapture(e.pointerId); return; }
      const og = !this.app.pm.open && this.outlineGripAt(p);
      if (og) { drag = this.outlineDragStart(og, p); el.setPointerCapture(e.pointerId); return; }
      // annotations first (their text), then view frames, then views
      const an = this.annAt(p);
      if (an) {
        this.selAnn = an; this.sel = an.view; this.renderTree(); this.app.cm.refresh(); this.vp.requestRender();
        const a = this.ann(an.view, an.id), v = this.V(an.view);
        if (a && !an.path && !this.app.pm.open) { drag = { ann: a, v, p0: p, at0: a.at.slice(), snap: this.snapshot(), moved: false }; el.setPointerCapture(e.pointerId); }
        return;
      }
      this.selAnn = null;
      // cutting line of a section: selects the section, drag moves the cut
      const cv = this.cutAt(p);
      if (cv) { this.select(cv.id); if (!this.app.pm.open) { drag = { cut: cv, p0: p, snap: this.snapshot(), moved: false, last: 0 }; el.setPointerCapture(e.pointerId); } return; }
      const fv = this.frameAt(p), v = fv || this.viewAt(p);
      this.select(v?.id || null);
      // only the dotted frame grabs a view (inside it stays free for picking model edges)
      if (fv && !this.app.pm.open) { drag = { v: fv, p0: p, pos0: fv.pos.slice(), snap: this.snapshot(), moved: false }; el.setPointerCapture(e.pointerId); }
    });
    el.addEventListener('pointermove', (e) => {
      const { p } = at(e);
      this.lastMouse = p; this._free = e.shiftKey;
      this.app.setCoords(`X ${fmt(p[0], 1)}  Y ${fmt(p[1], 1)} mm`);
      if (this.tool) { if (!e.buttons) this.tool.move?.(p, e); return; }
      if (!drag) { const g = !e.buttons && (this.dotGripAt(p) ? { kind: 'corner' } : this.outlineGripAt(p)); el.style.cursor = g ? (g.kind === 'corner' ? 'crosshair' : 'move') : !e.buttons && (this.frameAt(p) || this.annAt(p) || this.cutAt(p)) ? 'move' : ''; return; }
      const d = [p[0] - drag.p0[0], p[1] - drag.p0[1]];
      if (Math.abs(d[0]) + Math.abs(d[1]) > (drag.outline ? 2 / Math.max(1e-6, Math.abs(this.affine().ex[0])) : 0.5)) drag.moved = true;
      if (drag.dot) { if (drag.moved) { this.dotDragMove(drag, p); this.vp.requestRender(); } return; }
      if (drag.outline) { if (drag.moved) { this.outlineDragMove(drag, p, e.shiftKey, e.ctrlKey); this.vp.requestRender(); } return; }
      if (drag.cut) { const sh = this.dragCutShift(drag.cut, d); this.shiftCut(drag.cut, sh - drag.last); drag.last = sh; this.vp.requestRender(); return; }
      if (drag.ann) { const s = viewScaleOf(this, drag.v); drag.ann.at = [drag.at0[0] + d[0] / s, drag.at0[1] + d[1] / s]; }
      else this.moveView(drag.v, [drag.pos0[0] + d[0], drag.pos0[1] + d[1]]);
      this.vp.requestRender();
    });
    const end = () => { if (drag?.dot) { if (drag.moved) this.dotDragEnd(drag); drag = null; this.vp.requestRender(); return; } if (drag?.outline) { if (drag.moved) this.outlineDragEnd(drag); drag = null; this.vp.requestRender(); return; } if (drag?.moved) { this.pushUndo(drag.snap); this.app.setDirty(true); if (drag.cut) { this.renderTree(); this.recomputeViews([drag.cut]); } } drag = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => { if (this.tool) return; const r = el.getBoundingClientRect(), p = this.toSheet(e.clientX - r.left, e.clientY - r.top), an = this.annAt(p); if (an) { this.editAnn(an); return; } const v = this.viewAt(p); if (v) this.zoomTo(v); });
  }
  // view whose dotted frame is under p (within 6 px)
  frameAt(p) {
    const tol = 6 / Math.max(1e-6, Math.abs(this.affine().ex[0]));
    const vs = this.doc.views.filter((v) => v.sheet === this.sheetId).reverse();
    return vs.find((v) => {
      const r = frameRect(v, this.sheet);
      const inX = p[0] >= r[0] - tol && p[0] <= r[2] + tol, inY = p[1] >= r[1] - tol && p[1] <= r[3] + tol;
      return (inY && (Math.abs(p[0] - r[0]) <= tol || Math.abs(p[0] - r[2]) <= tol)) || (inX && (Math.abs(p[1] - r[1]) <= tol || Math.abs(p[1] - r[3]) <= tol));
    }) || null;
  }
  viewAt(p) {
    const vs = this.doc.views.filter((v) => v.sheet === this.sheetId).reverse();
    return vs.find((v) => { const r = viewRect(v, this.sheet); return p[0] >= r[0] - 3 && p[0] <= r[2] + 3 && p[1] >= r[1] - 3 && p[1] <= r[3] + 3; }) || null;
  }
  // move a view; projected views stay aligned with their parent, children follow
  moveView(v, pos) {
    const par = v.parent && this.V(v.parent);
    if (par && v.side !== 'free') { if (v.side === 'above' || v.side === 'below') pos[0] = par.pos[0]; else pos[1] = par.pos[1]; }
    const d = [pos[0] - v.pos[0], pos[1] - v.pos[1]];
    const shift = (q) => { q.pos = [q.pos[0] + d[0], q.pos[1] + d[1]]; for (const c of this.doc.views.filter((x) => x.parent === q.id)) shift(c); };
    shift(v);
  }
  zoomTo(v) { const r = viewRect(v, this.sheet), m = 15; this.vp.fit({ min: [r[0] - m, 0, -r[3] - m], max: [r[2] + m, 0, -r[1] + m] }); }
  select(id) { this.sel = id; this.renderTree(); this.app.cm.refresh(); this.vp.requestRender(); }
  contextMenu(e) {
    if (this.tool) { this.tool.context?.(); return; }
    const v = this.V(this.sel);
    const r = this.vp.el.getBoundingClientRect(), om = this.outlineMenu(this.toSheet(e.clientX - r.left, e.clientY - r.top));
    contextMenu(e.clientX, e.clientY, [
      ...om,
      ...(!v && !om.length ? this.viewSet.menuItems() : []), // empty space: Maximize/Restore + Close View
      { label: 'Zoom to Sheet', key: 'F', run: () => this.zoomFit() },
      ...(v ? [{ label: 'Projected View…', run: () => this.cmdProjected() }, ...(isCloudSrc(v.src) ? [] : [{ label: v.hidden ? 'Hide hidden lines' : 'Show hidden lines', run: () => this.setViewProp(v, { hidden: !v.hidden }) }]), { label: 'Delete view', run: () => this.deleteView() }] : []),
      { label: 'Model View…', run: () => this.cmdModelView(false) },
    ]);
  }

  // ======================= undo =======================
  snapshot() { return JSON.stringify({ sheets: this.doc.sheets, views: this.doc.views, titleBlock: this.doc.titleBlock, dimDec: this.doc.dimDec ?? 2, dimUnits: this.doc.dimUnits || 'mm', areaUnits: this.doc.areaUnits || 'm2', snapMode: this.doc.snapMode || 'first', style: this.doc.style || null }); }
  pushUndo(s = this.snapshot()) { this.undoStack.push(s); if (this.undoStack.length > 50) this.undoStack.shift(); this.redoStack = []; this.app.cm.refresh(); }
  restore(s) { this.closeProps?.(); Object.assign(this.doc, JSON.parse(s)); if (!this.doc.sheets.some((x) => x.id === this.sheetId)) this.sheetId = this.doc.sheets[0].id; if (!this.V(this.sel)) this.sel = null; this.selAnn = null; this.app.setDirty(true); this.renderTree(); this.app.cm.refresh(); this.vp.requestRender(); }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); }
  change(fn) { this.pushUndo(); fn(); this.app.setDirty(true); this.renderTree(); this.app.cm.refresh(); this.vp.requestRender(); }

  // ======================= views =======================
  sources() { return (this.app.root?.tabs || this.app.tabs || []).filter((t) => t.path && /\.lith(prt|asm|pcd)$/i.test(t.path)).map((t) => t.path); }
  // compute view geometry: views [{dir, x, hidden}] of one model file
  async computeViews(src, list, ctx = null, opts = {}) {
    if (isCloudSrc(src)) return this.computeCloudViews(src, list, ctx, opts);
    const r = await loadPart(src);
    if (r.err) throw new Error(`${fileName(src)}: ${r.err}`);
    const parts = (r.flat || []).map((fp) => ({ features: fp.features, upTo: fp.upTo, m: fp.m }));
    return api.kernel('drawView', { parts, views: list.map((v) => ({ dir: v.dir, xDir: v.x, hidden: true, plane: v.plane || null })) });
  }
  async run(label, fn) {
    this.busy = true; this.app.setBusy(true); this.app.cm.refresh(); this.app.setStatus(label + '…');
    try { return await fn(); } catch (e) { toast(`${label} failed: ${e.message}`, 'error', 7000); return null; } finally { this.busy = false; this.app.setBusy(false); this.app.cm.refresh(); }
  }
  cmdModelView(three) {
    const srcs = this.sources();
    let file = srcs[0] || null;
    const pm = this.app.pm.show({
      title: three ? 'Standard 3 Views' : 'Model View', iconName: three ? 'section' : 'views',
      values: { file: file || '', orient: 'front', hidden: false, color: 'density', density: 'normal', preset: 'full', scale: this.doc.views.some((v) => v.sheet === this.sheetId) ? 'sheet' : 'auto' },
      fields: [
        ...(srcs.length ? [{ key: 'file', type: 'select', label: 'Part / assembly / point cloud (open documents)', options: srcs.map((p) => ({ value: p, label: fileName(p) })) }] : []),
        { type: 'buttons', buttons: [{ label: 'Choose file…', icon: 'open', run: async () => { const f = await api.openFile({ filters: [{ name: 'Parts, assemblies and point clouds', extensions: ['lithprt', 'lithasm', 'ekprt', 'ekasm', ...CLOUD_EXTS] }], noRead: true }); if (f) { file = f.path; pm.inputs.src.textContent = 'Model: ' + fileName(file); } } }] },
        { type: 'info', key: 'src', text: file ? 'Model: ' + fileName(file) : 'Open a saved part, assembly or point cloud, or choose a file.' },
        ...(three ? [] : [{ key: 'orient', type: 'select', label: 'Orientation', options: Object.entries(STD).map(([k, v]) => ({ value: k, label: v.label[0] + v.label.slice(1).toLowerCase() })) }]),
        { key: 'scale', type: 'select', label: 'Sheet scale', options: [{ value: 'auto', label: 'Fit to sheet (choose scale)' }, { value: 'sheet', label: `Keep ${scaleText(this.sheet.scale)}` }] },
        { key: 'hidden', type: 'check', label: 'Show hidden lines (parts)' },
        { key: 'color', type: 'select', label: 'Point cloud colour', options: [{ value: 'density', label: 'Density (scan look)' }, { value: 'black', label: 'Points, black' }, { value: 'grey', label: 'Points, grey (intensity)' }, { value: 'rgb', label: 'Points, scan colours (RGB)' }] },
        { key: 'preset', type: 'select', label: 'Point cloud top view', options: [{ value: 'full', label: 'Full depth (x-ray)' }, { value: 'plan', label: 'Floor plan slice (floor + 1.0 … 1.3 m)' }, { value: 'slab', label: 'Floor slab (floor + 0.2 … 1.7 m)' }] },
        { key: 'density', type: 'select', label: 'Point cloud density', options: [{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'light', label: 'Light' }] },
        { type: 'info', text: 'Third angle projection: the top view goes above the front view, the right view to the right. Drag views to move them.' }],
      onChange: (v, key) => { if (key === 'file') { file = v.file; pm.inputs.src.textContent = 'Model: ' + fileName(file); } },
      onOk: (v) => {
        if (!file) { pm.setMessage('Choose a part or assembly first', 'error'); return false; }
        const list = three ? ['front', 'top', 'right'] : [v.orient];
        setTimeout(() => this.addViews(file, list, { hidden: !!v.hidden, auto: v.scale === 'auto', cloud: { ...cloudDefaults(), color: v.color, density: v.density }, preset: v.preset }));
        return true;
      },
    });
  }
  async addViews(file, names, { hidden = false, auto = true, cloud = null, preset = 'full' } = {}) {
    const isCloud = isCloudSrc(file);
    const clipFor = (n) => (n === 'top' && PRESETS[preset] ? { on: true, ref: 'floor', ...PRESETS[preset] } : { on: false, ref: 'back', from: 0, to: 1 });
    const list = names.map((n) => ({ name: n, dir: STD[n].dir, x: STD[n].x, ...(isCloud ? { cloud: { ...(cloud || cloudDefaults()), clip: clipFor(n) } } : {}) }));
    // point clouds: the box first (to choose the scale), then the dots at that scale
    let geoms = await this.run('Creating views', () => this.computeViews(file, list, null, { probe: isCloud && auto }));
    if (!geoms) return null;
    const snap = this.snapshot();
    const sh = this.sheet, A = drawArea(sh), gap = 25;
    const size = (g) => [g.box[2] - g.box[0], g.box[3] - g.box[1]];
    const S = list.map((_, i) => size(geoms[i]));
    // layout (model mm): front at origin; top above; right to the right
    const iF = names.indexOf('front'), iT = names.indexOf('top'), iR = names.indexOf('right');
    const three = iF >= 0 && iT >= 0 && iR >= 0;
    if (auto) {
      const needW = three ? S[iF][0] + S[iR][0] : S[0][0], needH = three ? S[iF][1] + S[iT][1] : S[0][1];
      const avail = [A.x1 - A.x0 - (three ? 3 : 2) * gap, A.y1 - A.y0 - (three ? 3 : 2) * gap - 10];
      const fit = SCALES.find((s) => needW * scaleVal(s) <= avail[0] && needH * scaleVal(s) <= avail[1]) || SCALES[SCALES.length - 1];
      sh.scale = fit.slice();
    }
    if (isCloud && auto) { geoms = await this.run('Drawing the point cloud', () => this.computeViews(file, list)); if (!geoms) return null; }
    const s = scaleVal(sh.scale), made = [];
    const mk = (i, pos, extra = {}) => { const n = names[i]; const v = { id: uid('v'), sheet: sh.id, name: STD[n].label[0] + STD[n].label.slice(1).toLowerCase(), src: file, srcName: baseName(file), dir: list[i].dir, x: list[i].x, pos, hidden, scale: null, geom: geoms[i], ...(list[i].cloud ? { cloud: list[i].cloud } : {}), ...extra }; this.doc.views.push(v); made.push(v); return v; };
    if (three) {
      const wTot = (S[iF][0] + S[iR][0]) * s + gap, hTot = (S[iF][1] + S[iT][1]) * s + gap;
      const left = (A.x0 + A.x1) / 2 - wTot / 2, bottom = (A.y0 + A.y1) / 2 - hTot / 2 + 5;
      const f = mk(iF, [left + (S[iF][0] * s) / 2, bottom + (S[iF][1] * s) / 2]);
      mk(iT, [f.pos[0], bottom + S[iF][1] * s + gap + (S[iT][1] * s) / 2], { parent: f.id, side: 'above' });
      mk(iR, [left + S[iF][0] * s + gap + (S[iR][0] * s) / 2, f.pos[1]], { parent: f.id, side: 'right' });
    } else {
      // other views: each at a free spot on the sheet (top right first), else the middle
      for (let i = 0; i < names.length; i++) {
        const rr = this.doc.views.filter((v) => v.sheet === sh.id).map((v) => viewRect(v, sh)), w = S[i][0] * s, hh = S[i][1] * s, m = 12;
        let x = (A.x0 + A.x1) / 2, y = (A.y0 + A.y1) / 2;
        if (rr.length) {
          const free = (cx, cy) => cx - w / 2 >= A.x0 + 5 && cx + w / 2 <= A.x1 - 5 && cy - hh / 2 >= A.y0 && cy + hh / 2 <= A.y1 - 5 && rr.every((r) => cx + w / 2 + m < r[0] || cx - w / 2 - m > r[2] || cy + hh / 2 + m + 8 < r[1] || cy - hh / 2 - m - 8 > r[3]);
          let found = null;
          for (let cy = A.y1 - 5 - hh / 2; cy >= A.y0 + hh / 2 && !found; cy -= 5) for (let cx = A.x1 - 5 - w / 2; cx >= A.x0 + 5 + w / 2; cx -= 5) if (free(cx, cy)) { found = [cx, cy]; break; }
          if (found) [x, y] = found; else toast('No free space for the view: drag it where you want it, or change the sheet scale', 'info', 5000);
        }
        mk(i, [x, y]);
      }
    }
    this.pushUndo(snap);
    this.sel = made[0]?.id || null;
    this.app.setDirty(true); this.renderTree(); this.app.cm.refresh(); this.vp.requestRender();
    this.app.setStatus(`${made.length} view${made.length > 1 ? 's' : ''} of ${fileName(file)} at ${scaleText(sh.scale)}`);
    return made;
  }
  async addProjected(par, side) {
    const d = projected(par, side);
    const geoms = await this.run('Creating view', () => this.computeViews(par.src, [d], par));
    if (!geoms) return null;
    const snap = this.snapshot(), sh = this.doc.sheets.find((x) => x.id === par.sheet), g = geoms[0], s = scaleVal(par.scale || sh.scale);
    const pr = viewRect(par, sh), gap = 25, w = (g.box[2] - g.box[0]) * s, hh = (g.box[3] - g.box[1]) * s;
    const pos = side === 'right' ? [pr[2] + gap + w / 2, par.pos[1]] : side === 'left' ? [pr[0] - gap - w / 2, par.pos[1]] : side === 'above' ? [par.pos[0], pr[3] + gap + hh / 2] : [par.pos[0], pr[1] - gap - hh / 2];
    const nm = Object.entries(STD).find(([k, q]) => k !== 'iso' && q.dir.every((c, i) => Math.abs(c - d.dir[i]) < 1e-9) && q.x.every((c, i) => Math.abs(c - d.x[i]) < 1e-9));
    const v = { id: uid('v'), sheet: sh.id, name: nm ? nm[1].label[0] + nm[1].label.slice(1).toLowerCase() : `Projected ${this.doc.views.length + 1}`, src: par.src, srcName: par.srcName, dir: d.dir, x: d.x, pos, hidden: par.hidden, scale: par.scale ? par.scale.slice() : null, geom: g, parent: par.id, side, ...(par.cloud ? { cloud: { ...par.cloud, clip: { ...par.cloud.clip, on: false } } } : {}) };
    this.doc.views.push(v);
    this.pushUndo(snap); this.sel = v.id;
    this.app.setDirty(true); this.renderTree(); this.app.cm.refresh(); this.vp.requestRender();
    return v;
  }
  async rebuildViews() {
    const bySrc = new Map();
    for (const v of this.doc.views) { if (!bySrc.has(v.src)) bySrc.set(v.src, []); bySrc.get(v.src).push(v); }
    const done = await this.run('Rebuilding views', async () => {
      for (const [src, vs] of bySrc) {
        const g = await this.computeViews(src, vs);
        vs.forEach((v, i) => { v.geom = g[i]; });
      }
      return true;
    });
    if (done) { this.app.setDirty(true); this.vp.requestRender(); this.app.setStatus(`Rebuilt ${this.doc.views.length} views`); }
  }
  deleteView() {
    const v = this.V(this.sel); if (!v) return;
    const kill = new Set([v.id]);
    let grew = true;
    while (grew) { grew = false; for (const q of this.doc.views) if (q.parent && kill.has(q.parent) && !kill.has(q.id)) { kill.add(q.id); grew = true; } }
    this.change(() => { this.doc.views = this.doc.views.filter((q) => !kill.has(q.id)); this.sel = null; });
  }
  setViewProp(v, props) { this.change(() => Object.assign(v, props)); }
  // a view's scale also goes to its projected views; projected views are put back next to their parent
  // with the same gap as before
  descendants(v) { const out = []; const add = (q) => { for (const c of this.doc.views.filter((x) => x.parent === q.id)) { out.push(c); add(c); } }; add(v); return out; }
  withRealign(roots, fn) {
    const kids = [...new Set(roots.flatMap((r) => this.descendants(r)))].filter((c) => c.side && c.side !== 'free');
    const gap = new Map(kids.map((c) => { const p = this.V(c.parent), sh = this.doc.sheets.find((s) => s.id === c.sheet), a = viewRect(p, sh), b = viewRect(c, sh);
      return [c.id, c.side === 'right' ? b[0] - a[2] : c.side === 'left' ? a[0] - b[2] : c.side === 'above' ? b[1] - a[3] : a[1] - b[3]]; }));
    fn();
    for (const c of kids) {
      const p = this.V(c.parent), sh = this.doc.sheets.find((s) => s.id === c.sheet), a = viewRect(p, sh), b = viewRect(c, sh), g = gap.get(c.id);
      const w = (b[2] - b[0]) / 2, hh = (b[3] - b[1]) / 2;
      c.pos = c.side === 'right' ? [a[2] + g + w, p.pos[1]] : c.side === 'left' ? [a[0] - g - w, p.pos[1]] : c.side === 'above' ? [p.pos[0], a[3] + g + hh] : [p.pos[0], a[1] - g - hh];
    }
  }
  setViewScale(v, scale) {
    this.change(() => this.withRealign([v], () => { for (const q of [v, ...this.descendants(v)]) q.scale = scale ? scale.slice() : null; }));
    this.refreshCloudViews();
  }

  // ======================= sheets & title block =======================
  cmdSheet() {
    const sh = this.sheet;
    this.app.pm.show({
      title: 'Sheet Format', iconName: 'grid', values: { size: sh.size, orient: sh.orient, scale: scaleText(sh.scale), name: sh.name },
      fields: [{ key: 'name', type: 'text', label: 'Name' },
        { key: 'size', type: 'select', label: 'Paper size', options: Object.keys(SIZES).map((k) => ({ value: k, label: `${k} (${SIZES[k][0]} × ${SIZES[k][1]} mm)` })) },
        { key: 'orient', type: 'select', label: 'Orientation', options: [{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }] },
        { key: 'scale', type: 'select', label: 'Scale', options: SCALES.map((s) => ({ value: scaleText(s), label: scaleText(s) })) }],
      onOk: (v) => { this.change(() => this.withRealign(this.doc.views.filter((q) => q.sheet === sh.id && !q.parent), () => { sh.name = v.name || sh.name; sh.size = v.size; sh.orient = v.orient; sh.scale = SCALES.find((s) => scaleText(s) === v.scale).slice(); })); this.zoomFit(); this.refreshCloudViews(); return true; },
    });
  }
  cmdZones() {
    const sh = this.sheet, z = sh.zones || {}, auto = zoneGrid({ ...sh, zones: { on: true } });
    this.app.pm.show({
      title: 'Zone Grid', iconName: 'layers', values: { on: z.on ?? true, nx: z.nx || 0, ny: z.ny || 0 },
      fields: [{ key: 'on', type: 'check', label: 'Show the zone grid on this sheet' },
        { key: 'nx', type: 'number', label: 'Zones across (1, 2, 3…)', min: 0, step: 1 },
        { key: 'ny', type: 'number', label: 'Zones down (A, B, C…)', min: 0, step: 1 },
        { type: 'info', text: `0 = automatic (about 50 mm per zone: ${auto.nx} × ${auto.ny} on ${sh.size}).` }],
      onOk: (v) => { this.change(() => { sh.zones = { on: !!v.on, nx: Math.max(0, Math.min(40, Math.round(v.nx || 0))), ny: Math.max(0, Math.min(24, Math.round(v.ny || 0))) }; }); return true; },
    });
  }
  addSheet() {
    const prev = this.sheet;
    const n = this.doc.sheets.length + 1;
    const sh = { id: uid('sh'), name: `Sheet${n}`, size: prev.size, orient: prev.orient, scale: prev.scale.slice(), zones: prev.zones ? { ...prev.zones } : undefined };
    this.change(() => { this.doc.sheets.push(sh); this.sheetId = sh.id; this.sel = null; });
    this.zoomFit(false);
  }
  deleteSheet() {
    if (this.doc.sheets.length < 2) return;
    const id = this.sheetId;
    this.change(() => { this.doc.sheets = this.doc.sheets.filter((s) => s.id !== id); this.doc.views = this.doc.views.filter((v) => v.sheet !== id); this.sheetId = this.doc.sheets[0].id; this.sel = null; });
  }
  showSheet(id) { this.endTool?.(); this.sheetId = id; this.sel = null; this.selAnn = null; this._annBoxes = null; this.renderTree(); this.app.cm.refresh(); this.zoomFit(false); }
  cmdTitleBlock() {
    const tb = this.doc.titleBlock;
    this.app.pm.show({
      title: 'Title Block', iconName: 'text', values: Object.fromEntries(TB_FIELDS.map(([k]) => [k, tb[k] ?? (k === 'title' ? this.doc.name : '')])),
      fields: [...TB_FIELDS.map(([k, l]) => ({ key: k, type: 'text', label: l })), { type: 'info', text: 'Model name, scale and sheet number are filled in automatically.' }],
      onOk: (v) => { this.change(() => { for (const [k] of TB_FIELDS) tb[k] = String(v[k] ?? '').trim(); }); return true; },
    });
  }

  // ======================= PDF =======================
  pdfText() {
    return makePdf(this.doc.sheets.map((sh) => { const [w, hh] = sheetSize(sh); return { w, h: hh, prims: sheetPrims(this.doc, sh) }; }), { title: this.doc.titleBlock?.title || this.doc.name });
  }
  async exportPdf(path = null) {
    for (const v of this.doc.views) if (v.geom?.raster) await loadRaster(v.geom.raster);
    const text = await makePdfCompressed(this.doc.sheets.map((sh) => { const [w, hh] = sheetSize(sh); return { w, h: hh, prims: sheetPrims(this.doc, sh) }; }), { title: this.doc.titleBlock?.title || this.doc.name });
    if (path) { await api.writeFile(path, text); return path; }
    const dir = this.app.path ? this.app.path.replace(/[^\\/]*$/, '') : '';
    const p = await api.saveFile({ defaultPath: dir + `${this.doc.name}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }], text, latin1: true });
    if (p) toast(`Exported ${fileName(p)} (${this.doc.sheets.length} sheet${this.doc.sheets.length > 1 ? 's' : ''})`, 'ok', 3000);
    return p;
  }

  // ======================= tree + properties =======================
  renderTree() {
    const tree = this.app.el.tree;
    if (!tree) return;
    tree.innerHTML = '';
    const row = (o) => {
      const r = h('div', { class: 'tr-row' + (o.sel ? ' sel' : ''), style: { paddingLeft: 6 + (o.depth || 0) * 16 + 'px' }, title: o.tip || '' },
        h('span', { class: 'twisty' }), h('span', { class: 'ico sm', html: icon(o.icon) }), h('span', { class: 'tr-label' }, o.label));
      r.addEventListener('click', (e) => o.onClick?.(e));
      r.addEventListener('dblclick', (e) => o.onDbl?.(e));
      r.addEventListener('contextmenu', (e) => { e.preventDefault(); o.onMenu?.(e); });
      return r;
    };
    tree.appendChild(row({ icon: 'drawing', label: this.doc.name }));
    for (const sh of this.doc.sheets) {
      tree.appendChild(row({ icon: 'grid', depth: 1, label: `${sh.name}  (${sh.size}, ${scaleText(sh.scale)})`, sel: sh.id === this.sheetId && !this.sel, onClick: () => this.showSheet(sh.id), onDbl: () => { this.showSheet(sh.id); this.cmdSheet(); } }));
      const kids = (pid) => this.doc.views.filter((v) => v.sheet === sh.id && (v.parent || null) === pid);
      const add = (v, d) => { tree.appendChild(row({ icon: 'views', depth: d, label: `${v.name}  ·  ${v.srcName}`, tip: v.src, sel: this.sel === v.id, onClick: () => { if (this.sheetId !== sh.id) this.showSheet(sh.id); this.select(v.id); }, onDbl: () => this.zoomTo(v), onMenu: (e) => { this.select(v.id); this.contextMenu(e); } })); for (const c of kids(v.id)) add(c, d + 1); };
      for (const v of kids(null)) add(v, 2);
    }
    const v = this.V(this.sel);
    tree.appendChild(this.infoPanel());
    tree.appendChild(v ? this.viewPanel(v) : this.sheetPanel());
  }
  viewPanel(v) {
    const sh = this.doc.sheets.find((s) => s.id === v.sheet);
    const wrap = h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, 'View'));
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const name = h('input', { type: 'text', value: v.name });
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    name.addEventListener('change', () => this.setViewProp(v, { name: name.value.trim() || v.name }));
    const sc = h('select', {}, h('option', { value: '', selected: !v.scale }, `Sheet scale (${scaleText(sh.scale)})`), ...SCALES.map((s) => h('option', { value: scaleText(s), selected: v.scale && scaleText(v.scale) === scaleText(s) }, scaleText(s))));
    sc.addEventListener('change', () => this.setViewScale(v, sc.value ? SCALES.find((s) => scaleText(s) === sc.value) : null));
    const chk = (label, key, def) => { const c = h('input', { type: 'checkbox', checked: v[key] ?? def }); c.addEventListener('change', () => this.setViewProp(v, { [key]: c.checked })); return h('label', { class: 'pp-check', style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 8px' } }, c, label); };
    const r = v.geom?.box, cl = isCloudSrc(v.src);
    wrap.append(...[field('Name', name), field('Scale', sc), h('div', { style: { display: 'flex', flexDirection: 'column' } }, ...(cl ? [] : [chk('Hidden lines (dashed)', 'hidden', false), chk('Tangent edges', 'tangent', true)]), chk('Label under the view', 'label', true)),
      h('div', { class: 'pp-row ro' }, h('label', {}, 'Model'), h('span', {}, v.srcName)),
      r ? h('div', { class: 'pp-row ro' }, h('label', {}, 'Size (model)'), h('span', {}, `${fmt(r[2] - r[0], 1)} × ${fmt(r[3] - r[1], 1)} mm`)) : null,
      v.parent ? h('div', { class: 'pp-row ro' }, h('label', {}, 'Projected from'), h('span', {}, this.V(v.parent)?.name || '')) : null,
      v.cut ? this.sectionPanel(v) : null,
      cl ? this.cloudPanel(v) : null].filter(Boolean));
    return wrap;
  }
  sheetPanel() {
    const sh = this.sheet, [W, H] = sheetSize(sh);
    return h('div', { class: 'pc-panel' }, h('div', { class: 'sp-sec' }, 'Sheet'),
      h('div', { class: 'pp-row ro' }, h('label', {}, 'Paper'), h('span', {}, `${sh.size} ${sh.orient} (${W} × ${H} mm)`)),
      h('div', { class: 'pp-row ro' }, h('label', {}, 'Scale'), h('span', {}, scaleText(sh.scale))),
      h('div', { class: 'pp-row ro' }, h('label', {}, 'Zone grid'), h('span', {}, zoneGrid(sh) ? `${zoneGrid(sh).nx} × ${zoneGrid(sh).ny}` : 'off')),
      h('div', { class: 'pp-inline', style: { margin: '4px 8px' } }, h('button', { class: 'mini txt', onclick: () => this.cmdSheet() }, 'Sheet format…'), h('button', { class: 'mini txt', onclick: () => this.cmdTitleBlock() }, 'Title block…')),
      this.doc.views.length ? null : h('p', { class: 'pm-info', style: { margin: '8px' } }, 'Start with Standard 3 Views or Model View. The part, assembly or point cloud must be saved.'));
  }

  // ======================= keys =======================
  onKey(e) {
    if (this.tool?.key?.(e)) { this.vp.requestRender(); return true; }
    if (e.key === 'Escape' && (this.tool || this.app.pm.open)) { if (this.app.pm.open) this.app.pm.cancel(); this.endTool(); return true; }
    if (e.key === 'Escape' && this.selAnn) { this.selAnn = null; this.renderTree(); this.app.cm.refresh(); this.vp.requestRender(); return true; }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { this.undo(); return true; }
    if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { this.redo(); return true; }
    if (e.ctrlKey) return false;
    if (e.key === 'f' || e.key === 'F') { this.zoomFit(); return true; }
    if (e.key === 'Delete' && this.selAnn && !this.tool) { this.deleteAnn(); return true; }
    if (e.key === 'Delete' && this.sel && !this.app.pm.open) { this.deleteView(); return true; }
    return false;
  }
  onActivate() { this.vp.requestRender(); }
  dispose() { this.closeProps?.(); this.closeRoomList?.(); this._inline?.remove(); this.vp.dispose(); }
}

const viewScaleOf = (d, v) => { const sh = d.doc.sheets.find((x) => x.id === v.sheet) || d.sheet; return scaleVal(v.scale || sh.scale); };
for (const M of [DrawingClouds, DrawingSections, DrawingOverlay, DrawingProps, DrawingOutline, DrawingRooms, DrawingInfo]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(DrawingDoc.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
for (const k of Object.getOwnPropertyNames(DrawingTools.prototype)) if (k !== 'constructor') Object.defineProperty(DrawingDoc.prototype, k, Object.getOwnPropertyDescriptor(DrawingTools.prototype, k));
