// Several viewports on one document (Viewport menu: Single / Two side by side / Two stacked / Four).
// All panes show the same scene; each has its own camera, view cube, triad and zoom.
//
// Layout = columns with rows: `cols = [{w, rows: [{h, pane}]}]` (fractions). Four Views = 2 columns × 2 rows.
// Closing a view removes it from its column (an empty column goes) → 4 → 3 (one tall + two stacked) → 2 → 1.
// Maximize View shows one pane alone (the others are only hidden); Restore Views brings the exact layout back.
// Dividers: vertical ones between columns, horizontal ones inside a column; created once per layout change
// (`build`), only moved while dragging (`place`) — recreating them killed the drag after the first move (≤ 0.1.73).
//
// The document keeps using `this.vp` as before: it is a proxy that forwards to the *current* pane =
// the pane being rendered (so overlay drawers draw in the right pane) or else the *active* pane (the
// one the mouse is in / last used). `vp.el` is a proxy too: listeners go on the root element (so they
// work in every pane, also panes added later), everything else (rect, style, appendChild,
// setPointerCapture) goes to the current pane's element.
// Pane 0 renders with its own WebGL renderer exactly as a single viewport; extra panes share one
// offscreen renderer and copy their picture into their own canvas (one extra WebGL context per document).
import * as THREE from 'three';
import { Viewport } from './viewport.js';

export const LAYOUTS = {
  single: { n: 1, label: 'Single View' },
  'two-v': { n: 2, label: 'Two Views Side by Side' },
  'two-h': { n: 2, label: 'Two Views Stacked' },
  four: { n: 4, label: 'Four Views' },
};
// standard views per layout (pane order: top-left, top-right, bottom-left, bottom-right)
const DEFAULT_VIEWS = { single: ['iso'], 'two-v': ['front', 'iso'], 'two-h': ['front', 'iso'], four: ['front', 'iso', 'top', 'right'] };
// pane indices per column for the standard layouts
const STD_COLS = { single: [[0]], 'two-v': [[0], [1]], 'two-h': [[0, 1]], four: [[0, 2], [1, 3]] };
const SHARED = ['section', 'renderScene', 'onContextMenu', 'onMiddleClick', 'onViewChange', 'overlayDrawers'];
const GAP = 4; // px between panes (the divider)
const MIN = 0.1; // smallest column / row fraction
const ICON = {
  max: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  restore: '<svg viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.5V1.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.4"/></svg>',
};

export class ViewSet {
  constructor(container, opts = {}) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'viewset';
    container.appendChild(this.root);
    this.layout = 'single';
    this.panes = [];
    this.renderPane = null;
    this.max = null; // maximized pane (others hidden)
    // which pane the mouse works in: set before any document listener runs (capture on the root)
    const pick = (e) => { const p = this.paneOf(e.target); if (p && p !== this.active) this.setActive(p); };
    for (const t of ['pointerdown', 'pointermove', 'wheel', 'dblclick', 'contextmenu']) this.root.addEventListener(t, pick, { capture: true, passive: true });
    const p0 = this.addPane();
    this.active = p0;
    this.cols = [{ w: 1, rows: [{ h: 1, pane: p0 }] }];
    this.proxy = makeProxy(this);
    this.elProxy = makeElProxy(this);
    this.build();
  }
  get cur() { return this.renderPane || this.active; }
  get primary() { return this.panes[0]; }
  // old two-number form (first column width, first row height), kept for tests / old files
  get split() { return [this.cols[0].w, this.cols[0].rows[0].h]; }
  paneOf(node) { const el = node?.closest?.('.viewport'); return el ? this.panes.find((p) => p.el === el) : null; }

  addPane() {
    const p0 = this.panes[0];
    let p;
    const vopts = { mode: this.opts.mode || '3d' };
    if (!p0) p = new Viewport(this.root, vopts);
    else {
      if (!this.offscreen) {
        this.offscreen = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.offscreen.setPixelRatio(window.devicePixelRatio || 1);
        this.offscreen.setClearColor(0x000000, 0);
        this.offscreen.autoClear = false;
      }
      p = new Viewport(this.root, { ...vopts, shared: p0, renderer: this.offscreen });
      for (const k of SHARED) Object.defineProperty(p, k, { configurable: true, get: () => p0[k], set: (v) => { p0[k] = v; } });
      p.camera.position.copy(p0.camera.position); p.camera.quaternion.copy(p0.camera.quaternion); p.camera.up.copy(p0.camera.up);
      p.target.copy(p0.target); p.scale = p0.scale;
    }
    p.viewset = this;
    if (this.opts.cls) p.el.classList.add(...this.opts.cls); // e.g. drawing paper look
    p._render = wrapRender(this, p, p._render.bind(p));
    this.addButtons(p);
    this.panes.push(p);
    return p;
  }
  // Maximize/Restore + Close buttons top-right of a pane (CSS shows them only with more than one view)
  addButtons(p) {
    const box = document.createElement('div');
    box.className = 'vs-btns';
    const btn = (cls, title, run) => {
      const b = document.createElement('button');
      b.className = 'vs-btn ' + cls; b.title = title;
      for (const t of ['pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'wheel']) b.addEventListener(t, (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
      box.appendChild(b);
      return b;
    };
    p._maxBtn = btn('vs-max', 'Maximize View', () => (this.max ? this.restoreViews() : this.maximize(p)));
    btn('vs-close', 'Close View', () => this.closePane(p)).innerHTML = ICON.close;
    p.el.appendChild(box);
    p._vsBtns = box;
  }

  setActive(p) {
    this.active = p;
    for (const q of this.panes) q.el.classList.toggle('active', q === p && this.visible().length > 1);
    this.requestRender();
    this.onActive?.(p);
  }
  requestRender() { for (const p of this.panes) p.requestRender(); }
  // run fn with `vp` pointing at pane p
  withPane(p, fn) { const old = this.renderPane; this.renderPane = p; try { return fn(); } finally { this.renderPane = old; } }
  visible() { return this.max ? [this.max] : this.panes; }

  // standard layout; extra panes are removed (the view of the active pane goes to pane 0)
  // reset: also give the existing panes the standard views (default: only for Four Views)
  setLayout(name, { reset = name === 'four', fit } = {}) {
    if (!LAYOUTS[name]) return;
    const n = LAYOUTS[name].n;
    this.max = null;
    if (n < this.panes.length && this.active !== this.primary) copyCam(this.active, this.primary);
    while (this.panes.length > n) { const p = this.panes.pop(); p.dispose(); }
    const fresh = [];
    while (this.panes.length < n) fresh.push(this.addPane());
    this.layout = name;
    this.cols = STD_COLS[name].map((rows) => ({ w: 1 / STD_COLS[name].length, rows: rows.map((i) => ({ h: 1 / rows.length, pane: this.panes[i] })) }));
    if (!this.panes.includes(this.active)) this.active = this.primary;
    this.build();
    const views = this.opts.mode === 'plan' ? DEFAULT_VIEWS[name].map(() => 'top') : DEFAULT_VIEWS[name];
    this.panes.forEach((p, i) => {
      // standard view for new panes (all panes with reset); every pane is zoomed to fit its new size
      if (n > 1 && (reset || fresh.includes(p))) p.setView(views[i], false);
      if (fit) this.withPane(p, () => fit(p));
    });
    this.setActive(this.active);
    this.onLayout?.();
  }
  resetViews(fit) { this.setLayout(STD_COLS[this.layout] ? this.layout : 'four', { reset: true, fit }); }

  // ---- maximize / restore / close ----
  maximize(p = this.active) {
    if (this.panes.length < 2 || this.max === p) return;
    this.max = p; this.active = p;
    this.place();
    this.setActive(p);
    this.onLayout?.();
  }
  restoreViews() {
    if (!this.max) return;
    this.max = null;
    this.place();
    this.setActive(this.active);
    this.onLayout?.();
  }
  // the view's space goes to its neighbours in the column (or, for a last row, to the neighbouring columns)
  closePane(p = this.active) {
    if (this.panes.length < 2) return;
    this.max = null;
    if (p === this.primary) { // pane 0 owns the WebGL renderer + scene: it takes over another pane's view and place
      const q = this.panes.find((x) => x !== p && x === this.active) || this.panes.find((x) => x !== p);
      const s0 = slotOf(this.cols, p), s1 = slotOf(this.cols, q);
      copyCam(q, p);
      s1.row.pane = p; s0.row.pane = q;
      p = q;
    }
    const { col, row } = slotOf(this.cols, p);
    col.rows.splice(col.rows.indexOf(row), 1);
    if (!col.rows.length) this.cols.splice(this.cols.indexOf(col), 1);
    norm(this.cols);
    this.panes.splice(this.panes.indexOf(p), 1);
    p.dispose();
    if (!this.panes.includes(this.active)) this.active = this.primary;
    this.layout = layoutName(this.cols);
    this.build();
    this.setActive(this.active);
    this.onLayout?.();
  }
  // items for the right-click menu on empty space in a pane (empty with one view)
  menuItems(p = this.active) {
    if (this.panes.length < 2) return [];
    return [
      this.max ? { label: 'Restore Views', icon: 'views', run: () => this.restoreViews() } : { label: 'Maximize View', icon: 'views', run: () => this.maximize(p) },
      { label: 'Close View', icon: 'cancel', run: () => this.closePane(p) },
      '-',
    ];
  }

  // create the dividers for the current columns/rows, then place everything
  build() {
    for (const d of this.root.querySelectorAll('.vs-split')) d.remove();
    this.dividers = [];
    this.cols.forEach((c, i) => {
      if (i > 0) this.dividers.push(this.divider('v', i));
      c.rows.forEach((_, j) => { if (j > 0) this.dividers.push(this.divider('h', i, j)); });
    });
    this.place();
  }
  // pane rectangles + divider positions (no elements created here)
  place() {
    const g = GAP / 2, multi = this.visible().length > 1;
    let x = 0;
    for (const c of this.cols) {
      let y = 0;
      c.x0 = x; c.x1 = x + c.w;
      for (const r of c.rows) {
        r.y0 = y; r.y1 = y + r.h; y = r.y1;
        const p = r.pane, m = this.max;
        const [x0, x1, y0, y1] = m ? [0, 1, 0, 1] : [c.x0, c.x1, r.y0, r.y1];
        Object.assign(p.el.style, {
          display: m && m !== p ? 'none' : '',
          left: `calc(${x0 * 100}% + ${x0 > 1e-6 ? g : 0}px)`, right: `calc(${(1 - x1) * 100}% + ${x1 < 1 - 1e-6 ? g : 0}px)`,
          top: `calc(${y0 * 100}% + ${y0 > 1e-6 ? g : 0}px)`, bottom: `calc(${(1 - y1) * 100}% + ${y1 < 1 - 1e-6 ? g : 0}px)`,
        });
        p._maxBtn.innerHTML = m ? ICON.restore : ICON.max;
        p._maxBtn.title = m ? 'Restore Views' : 'Maximize View';
      }
      x = c.x1;
    }
    this.root.classList.toggle('multi', multi);
    this.root.classList.toggle('maxed', !!this.max);
    for (const d of this.dividers || []) { d.style.display = this.max ? 'none' : ''; d._pos(); }
    for (const p of this.panes) p.resize();
  }
  divider(dir, i, j) {
    const d = document.createElement('div');
    d.className = 'vs-split ' + dir;
    const cols = () => this.cols;
    d._pos = () => {
      const c = cols()[i];
      if (dir === 'v') Object.assign(d.style, { left: `calc(${c.x0 * 100}% - ${GAP / 2}px)`, top: '0', bottom: '0' });
      else { const r = c.rows[j]; Object.assign(d.style, { top: `calc(${r.y0 * 100}% - ${GAP / 2}px)`, left: `calc(${c.x0 * 100}%)`, width: `${c.w * 100}%` }); }
    };
    // move the edge between item a (before) and b (after) to fraction f of the set
    const moveTo = (f) => {
      if (dir === 'v') { const a = this.cols[i - 1], b = this.cols[i]; edge(a, b, 'w', f - a.x0); }
      else { const c = this.cols[i], a = c.rows[j - 1], b = c.rows[j]; edge(a, b, 'h', f - a.y0); }
      this.place();
    };
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); d.setPointerCapture(e.pointerId);
      d.classList.add('drag');
      const r = this.root.getBoundingClientRect();
      const mv = (ev) => moveTo(dir === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
      const up = () => { d.classList.remove('drag'); d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); d.removeEventListener('lostpointercapture', up); this.onChange?.(); };
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up); d.addEventListener('lostpointercapture', up);
    });
    d.addEventListener('dblclick', (e) => { // equal split of the two neighbours
      e.stopPropagation();
      if (dir === 'v') { const a = this.cols[i - 1], b = this.cols[i]; a.w = b.w = (a.w + b.w) / 2; } else { const c = this.cols[i], a = c.rows[j - 1], b = c.rows[j]; a.h = b.h = (a.h + b.h) / 2; }
      this.place(); this.onChange?.();
    });
    this.root.appendChild(d);
    return d;
  }

  // saved in the document: columns/rows (pane indices + sizes), maximized pane and each pane's view
  toJSON() {
    const ix = (p) => this.panes.indexOf(p);
    return { layout: this.layout, split: [...this.split], active: ix(this.active),
      cols: this.cols.map((c) => ({ w: r6(c.w), rows: c.rows.map((r) => ({ h: r6(r.h), i: ix(r.pane) })) })),
      max: this.max ? ix(this.max) : -1,
      views: this.panes.map((p) => ({ q: p.camera.quaternion.toArray().map(r6), t: p.target.toArray().map(r6), s: r6(p.scale) })) };
  }
  restore(s) {
    if (!s) return false;
    const cols = validCols(s.cols);
    if (cols) {
      const n = cols.reduce((k, c) => k + c.rows.length, 0);
      this.setLayout(n === 1 ? 'single' : n === 2 ? 'two-v' : 'four', { reset: false }); // right number of panes first
      while (this.panes.length > n) this.panes.pop().dispose();
      while (this.panes.length < n) this.addPane();
      this.cols = cols.map((c) => ({ w: c.w, rows: c.rows.map((r) => ({ h: r.h, pane: this.panes[r.i] })) }));
      norm(this.cols);
      this.layout = layoutName(this.cols);
      this.max = this.panes[s.max] || null;
      this.build();
    } else {
      if (!LAYOUTS[s.layout]) return false;
      this.setLayout(s.layout, { reset: false });
      if (Array.isArray(s.split)) { // ≤ 0.1.73 files: [column split, row split]
        const [sx, sy] = s.split.map((v) => Math.min(0.85, Math.max(0.15, +v || 0.5)));
        if (this.cols.length === 2) { this.cols[0].w = sx; this.cols[1].w = 1 - sx; }
        for (const c of this.cols) if (c.rows.length === 2) { c.rows[0].h = sy; c.rows[1].h = 1 - sy; }
        this.place();
      }
    }
    (s.views || []).forEach((v, i) => {
      const p = this.panes[i]; if (!p || !v?.q) return;
      p.anim = null; p.target.fromArray(v.t); p.scale = v.s || p.scale; p._applyQuat(new THREE.Quaternion().fromArray(v.q));
    });
    this.setActive(this.panes[s.active] || this.primary);
    this.onLayout?.();
    return true;
  }

  dispose() {
    for (const p of this.panes) p.dispose();
    this.panes = [];
    this.offscreen?.dispose();
    this.root.remove();
  }
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
function copyCam(a, b) {
  b.anim = null; b.target.copy(a.target); b.scale = a.scale; b._applyQuat(a.camera.quaternion.clone());
}
function wrapRender(set, p, orig) {
  return () => { const old = set.renderPane; set.renderPane = p; try { orig(); } finally { set.renderPane = old; } };
}
function slotOf(cols, p) {
  for (const col of cols) for (const row of col.rows) if (row.pane === p) return { col, row };
  return null;
}
// fractions sum to 1 again (after a close or loading)
function norm(cols) {
  const sw = cols.reduce((s, c) => s + c.w, 0) || 1;
  for (const c of cols) { c.w /= sw; const sh = c.rows.reduce((s, r) => s + r.h, 0) || 1; for (const r of c.rows) r.h /= sh; }
}
// move the shared edge of a and b (sizes key k) so that a gets size `fa`; both keep at least MIN
function edge(a, b, k, fa) {
  const tot = a[k] + b[k];
  a[k] = Math.min(tot - MIN, Math.max(MIN, fa));
  b[k] = tot - a[k];
}
// standard name when the columns match one, else 'custom'
function layoutName(cols) {
  const sig = cols.map((c) => c.rows.length).join();
  return { 1: 'single', '1,1': 'two-v', 2: 'two-h', '2,2': 'four' }[sig] || 'custom';
}
function validCols(cols) {
  if (!Array.isArray(cols) || !cols.length) return null;
  const seen = new Set();
  for (const c of cols) {
    if (!(c?.w > 0) || !Array.isArray(c.rows) || !c.rows.length) return null;
    for (const r of c.rows) { if (!(r?.h > 0) || !Number.isInteger(r.i) || seen.has(r.i)) return null; seen.add(r.i); }
  }
  const n = seen.size;
  for (let i = 0; i < n; i++) if (!seen.has(i)) return null;
  return n <= 8 ? cols : null;
}

const PROXY_SET = new Set(['requestRender', 'dispose']);
function makeProxy(set) {
  return new Proxy({}, {
    get(_, k) {
      if (k === 'viewset') return set;
      if (k === 'el') return set.elProxy;
      if (k === 'pane') return set.cur;
      if (PROXY_SET.has(k)) return set[k].bind(set);
      const p = set.cur, v = p[k];
      return typeof v === 'function' ? v.bind(p) : v;
    },
    set(_, k, v) { if (SHARED.includes(k)) set.primary[k] = v; else set.cur[k] = v; return true; },
    has(_, k) { return k in set.cur; },
  });
}
const ROOT_KEYS = new Set(['addEventListener', 'removeEventListener', 'contains']);
function makeElProxy(set) {
  return new Proxy({}, {
    get(_, k) {
      const el = ROOT_KEYS.has(k) ? set.root : set.cur.el, v = el[k];
      return typeof v === 'function' ? v.bind(el) : v;
    },
    set(_, k, v) { set.cur.el[k] = v; return true; },
  });
}
