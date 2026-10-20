// ViewSet layout: standard layouts, columns/rows, dividers, save/restore (mixed into ViewSet).
import * as THREE from 'three';
import { LAYOUTS, DEFAULT_VIEWS, STD_COLS, gap, ICON, r6, copyCam, norm, edge, layoutName, validCols } from './util.js';

export class ViewSetLayout {
  // standard layout; extra panes are removed (the view of the active pane goes to pane 0)
  // reset: also give the existing panes the standard views (default: only for Four Views)
  setLayout(name, { reset = name === 'four', fit } = {}) {
    if (!LAYOUTS[name]) return;
    const n = LAYOUTS[name].n;
    this.max = null;
    for (const p of this.panes) p._min = null; // minimized views come back into the standard layout
    const keep = this.focus; // the clicked view's camera survives when views are removed
    if (n < this.panes.length && keep !== this.primary) copyCam(keep, this.primary);
    while (this.panes.length > n) { const p = this.panes.pop(); p.dispose(); }
    const fresh = [];
    while (this.panes.length < n) fresh.push(this.addPane());
    this.layout = name;
    this.cols = STD_COLS[name].map((rows) => ({ w: 1 / STD_COLS[name].length, rows: rows.map((i) => ({ h: 1 / rows.length, pane: this.panes[i] })) }));
    if (!this.panes.includes(this.active)) this.active = this.primary;
    if (!this.panes.includes(this._focus)) this._focus = this.active;
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
    const g = gap() / 2, multi = this.visible().length > 1;
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
    for (const p of this.panes) if (p._min) p.el.style.display = 'none';
    this.syncDock();
    this.root.classList.toggle('multi', multi);
    this.root.classList.toggle('maxed', !!this.max);
    for (const d of this.dividers || []) { d.style.display = this.max ? 'none' : ''; d._pos(); }
    for (const p of this.panes) p.resize();
    this.placeHud();
  }

  divider(dir, i, j) {
    const d = document.createElement('div');
    d.className = 'vs-split ' + dir;
    const cols = () => this.cols;
    d._pos = () => {
      const c = cols()[i];
      if (dir === 'v') Object.assign(d.style, { left: `calc(${c.x0 * 100}% - ${gap() / 2}px)`, top: '0', bottom: '0', width: gap() + 'px' });
      else { const r = c.rows[j]; Object.assign(d.style, { top: `calc(${r.y0 * 100}% - ${gap() / 2}px)`, left: `calc(${c.x0 * 100}%)`, width: `${c.w * 100}%`, height: gap() + 'px' }); }
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
    return { layout: this.layout, split: [...this.split], active: ix(this.focus || this.active),
      cols: this.cols.map((c) => ({ w: r6(c.w), rows: c.rows.map((r) => ({ h: r6(r.h), i: ix(r.pane) })) })),
      max: this.max ? ix(this.max) : -1,
      min: this.minimized().map((p) => ({ i: ix(p), ...p._min })),
      views: this.panes.map((p) => ({ q: p.camera.quaternion.toArray().map(r6), t: p.target.toArray().map(r6), s: r6(p.scale), ...(p.displayMode ? { d: p.displayMode } : {}) })) };
  }

  restore(s) {
    if (!s) return false;
    const mins = Array.isArray(s.min) ? s.min.filter((m) => Number.isInteger(m?.i)) : [];
    const cols = validCols(s.cols, mins.map((m) => m.i));
    if (cols) {
      const n = cols.reduce((k, c) => k + c.rows.length, 0) + mins.length;
      this.setLayout(n === 1 ? 'single' : n === 2 ? 'two-v' : 'four', { reset: false }); // right number of panes first
      while (this.panes.length > n) this.panes.pop().dispose();
      while (this.panes.length < n) this.addPane();
      this.cols = cols.map((c) => ({ w: c.w, rows: c.rows.map((r) => ({ h: r.h, pane: this.panes[r.i] })) }));
      norm(this.cols);
      this.layout = layoutName(this.cols);
      this.max = this.panes[s.max] || null;
      for (const m of mins) { const { i, ...slot } = m; this.panes[i]._min = slot; }
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
      if (v.d) p.displayMode = v.d; else delete p.displayMode;
    });
    this.setActive(this.panes[s.active] || this.primary);
    this.onLayout?.();
    return true;
  }
}
