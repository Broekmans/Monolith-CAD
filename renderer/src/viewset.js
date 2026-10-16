// Several viewports on one document (Viewport menu: Single / Two side by side / Two stacked / Four).
// All panes show the same scene; each has its own camera, view cube, triad and zoom.
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
const SHARED = ['section', 'renderScene', 'onContextMenu', 'onViewChange', 'overlayDrawers'];
const GAP = 4; // px between panes (the divider)

export class ViewSet {
  constructor(container, opts = {}) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'viewset';
    container.appendChild(this.root);
    this.layout = 'single';
    this.split = [0.5, 0.5];
    this.panes = [];
    this.renderPane = null;
    // which pane the mouse works in: set before any document listener runs (capture on the root)
    const pick = (e) => { const p = this.paneOf(e.target); if (p && p !== this.active) this.setActive(p); };
    for (const t of ['pointerdown', 'pointermove', 'wheel', 'dblclick', 'contextmenu']) this.root.addEventListener(t, pick, { capture: true, passive: true });
    const p0 = this.addPane();
    this.active = p0;
    this.proxy = makeProxy(this);
    this.elProxy = makeElProxy(this);
  }
  get cur() { return this.renderPane || this.active; }
  get primary() { return this.panes[0]; }
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
    this.panes.push(p);
    return p;
  }

  setActive(p) {
    this.active = p;
    for (const q of this.panes) q.el.classList.toggle('active', q === p && this.panes.length > 1);
    this.requestRender();
    this.onActive?.(p);
  }
  requestRender() { for (const p of this.panes) p.requestRender(); }
  // run fn with `vp` pointing at pane p
  withPane(p, fn) { const old = this.renderPane; this.renderPane = p; try { return fn(); } finally { this.renderPane = old; } }

  // n panes for the layout; extra panes are removed (the view of the active pane goes to pane 0)
  // reset: also give the existing panes the standard views (default: only for Four Views)
  setLayout(name, { reset = name === 'four', fit } = {}) {
    if (!LAYOUTS[name]) return;
    const n = LAYOUTS[name].n;
    if (n < this.panes.length && this.active !== this.primary) copyCam(this.active, this.primary);
    while (this.panes.length > n) { const p = this.panes.pop(); p.dispose(); }
    const fresh = [];
    while (this.panes.length < n) fresh.push(this.addPane());
    this.layout = name;
    this.place();
    if (!this.panes.includes(this.active)) this.active = this.primary;
    const views = this.opts.mode === 'plan' ? DEFAULT_VIEWS[name].map(() => 'top') : DEFAULT_VIEWS[name];
    this.panes.forEach((p, i) => {
      // standard view for new panes (all panes with reset); every pane is zoomed to fit its new size
      if (n > 1 && (reset || fresh.includes(p))) p.setView(views[i], false);
      if (fit) this.withPane(p, () => fit(p));
    });
    this.setActive(this.active);
  }
  resetViews(fit) { this.setLayout(this.layout, { reset: true, fit }); }

  // pane rectangles + dividers
  place() {
    const L = this.layout, [sx, sy] = this.split;
    const cols = L === 'two-v' || L === 'four', rows = L === 'two-h' || L === 'four';
    const X = (i) => (cols ? (i % (L === 'four' ? 2 : 2) === 0 ? [0, sx] : [sx, 1]) : [0, 1]);
    const rects = this.panes.map((_, i) => {
      if (L === 'single') return [[0, 1], [0, 1]];
      if (L === 'two-v') return [i === 0 ? [0, sx] : [sx, 1], [0, 1]];
      if (L === 'two-h') return [[0, 1], i === 0 ? [0, sy] : [sy, 1]];
      return [X(i), i < 2 ? [0, sy] : [sy, 1]];
    });
    this.panes.forEach((p, i) => {
      const [[x0, x1], [y0, y1]] = rects[i], g = GAP / 2;
      Object.assign(p.el.style, {
        left: `calc(${x0 * 100}% + ${x0 > 0 ? g : 0}px)`, right: `calc(${(1 - x1) * 100}% + ${x1 < 1 ? g : 0}px)`,
        top: `calc(${y0 * 100}% + ${y0 > 0 ? g : 0}px)`, bottom: `calc(${(1 - y1) * 100}% + ${y1 < 1 ? g : 0}px)`,
      });
    });
    this.root.classList.toggle('multi', this.panes.length > 1);
    for (const d of this.root.querySelectorAll('.vs-split')) d.remove();
    if (cols) this.divider('v');
    if (rows) this.divider('h');
    for (const p of this.panes) p.resize();
  }
  divider(dir) {
    const d = document.createElement('div');
    d.className = 'vs-split ' + dir;
    const k = dir === 'v' ? 0 : 1;
    const pos = () => { d.style[dir === 'v' ? 'left' : 'top'] = `calc(${this.split[k] * 100}% - ${GAP / 2}px)`; };
    pos();
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); d.setPointerCapture(e.pointerId);
      const r = this.root.getBoundingClientRect();
      const mv = (ev) => { const f = dir === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height; this.split[k] = Math.min(0.85, Math.max(0.15, f)); this.place(); };
      const up = () => { d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); this.onChange?.(); };
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up);
    });
    d.addEventListener('dblclick', (e) => { e.stopPropagation(); this.split[k] = 0.5; this.place(); this.onChange?.(); });
    this.root.appendChild(d);
  }

  // saved in the document: layout, divider positions and each pane's view
  toJSON() {
    return { layout: this.layout, split: [...this.split], active: this.panes.indexOf(this.active),
      views: this.panes.map((p) => ({ q: p.camera.quaternion.toArray().map(r6), t: p.target.toArray().map(r6), s: r6(p.scale) })) };
  }
  restore(s) {
    if (!s || !LAYOUTS[s.layout]) return false;
    if (Array.isArray(s.split)) this.split = s.split.map((v) => Math.min(0.85, Math.max(0.15, +v || 0.5)));
    this.setLayout(s.layout, { reset: false });
    (s.views || []).forEach((v, i) => {
      const p = this.panes[i]; if (!p || !v?.q) return;
      p.anim = null; p.target.fromArray(v.t); p.scale = v.s || p.scale; p._applyQuat(new THREE.Quaternion().fromArray(v.q));
    });
    this.setActive(this.panes[s.active] || this.primary);
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
