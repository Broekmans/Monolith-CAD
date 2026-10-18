// Several viewports on one document (Viewport menu: Single / Two side by side / Two stacked / Four).
// All panes show the same scene; each has its own camera, view cube, triad and zoom.
//
// Layout = columns with rows: `cols = [{w, rows: [{h, pane}]}]` (fractions). Four Views = 2 columns × 2 rows.
// Closing a view removes it from its column (an empty column goes) → 4 → 3 (one tall + two stacked) → 2 → 1.
// Maximize View shows one pane alone (the others are only hidden); Restore Views brings the exact layout back.
// Minimize View (0.1.78) takes a pane out of the layout but keeps it (camera and all): it becomes a tab in the dock
// bottom-left (`.vs-dock`); clicking the tab puts it back in its old column/row (`p._min` = where it was).
// The heads-up view toolbar (app.el.headsUp, shared by all tabs) is placed under the active pane's view cube
// (`placeHud`, 3D only; plan-mode sets reset it to the centred CSS position).
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
// Files: viewset.js (core: panes, active pane, proxies) · viewset/layout.js · viewset/panes.js · viewset/hud.js · viewset/util.js
import * as THREE from 'three';
import { Viewport } from './viewport.js';
import { SHARED, wrapRender, makeProxy, makeElProxy } from './viewset/util.js';
import { ViewSetLayout } from './viewset/layout.js';
import { ViewSetPanes } from './viewset/panes.js';
import { ViewSetHud } from './viewset/hud.js';
export { LAYOUTS } from './viewset/util.js';

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
    this.dock = document.createElement('div');
    this.dock.className = 'vs-dock';
    this.root.appendChild(this.dock);
    this.ro = new ResizeObserver(() => this.placeHud());
    this.ro.observe(this.root);
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

  setActive(p) {
    this.active = p;
    for (const q of this.panes) q.el.classList.toggle('active', q === p && this.visible().length > 1);
    this.placeHud();
    this.requestRender();
    this.onActive?.(p);
  }

  requestRender() { for (const p of this.panes) p.requestRender(); }

  // run fn with `vp` pointing at pane p
  withPane(p, fn) { const old = this.renderPane; this.renderPane = p; try { return fn(); } finally { this.renderPane = old; } }

  visible() { return this.max ? [this.max] : this.panes.filter((p) => !p._min); }

  minimized() { return this.panes.filter((p) => p._min); }

  dispose() {
    this.ro?.disconnect();
    for (const p of this.panes) p.dispose();
    this.panes = [];
    this.offscreen?.dispose();
    this.root.remove();
  }
}
for (const M of [ViewSetLayout, ViewSetPanes, ViewSetHud]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(ViewSet.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));
