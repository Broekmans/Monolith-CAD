// ViewSet pane commands: pane buttons, maximize / restore, minimize + dock tabs, close, right-click items (mixed into ViewSet).
import * as THREE from 'three';
import { ICON, VIEW_NAMES, swapCam, copyCam, slotOf, norm, layoutName } from './util.js';

export class ViewSetPanes {
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
    btn('vs-min', 'Minimize View', () => this.minimize(p)).innerHTML = ICON.min;
    p._maxBtn = btn('vs-max', 'Maximize View', () => (this.max ? this.restoreViews() : this.maximize(p)));
    btn('vs-close', 'Close View', () => this.closePane(p)).innerHTML = ICON.close;
    p.el.appendChild(box);
    p._vsBtns = box;
  }

  // ---- maximize / restore / close ----
  maximize(p = this.active) {
    if (this.visible().length < 2 || this.max === p || p._min) return;
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
    if (!p._min && this.visible().length < 2 && !this.max) return; // keep at least one view on screen
    this.max = null;
    if (p === this.primary && !p._min) { // pane 0 owns the WebGL renderer + scene: it takes over another pane's view and place
      const vis = this.panes.filter((x) => x !== p && !x._min);
      const q = vis.find((x) => x === this.active) || vis[0];
      const s0 = slotOf(this.cols, p), s1 = slotOf(this.cols, q);
      copyCam(q, p);
      s1.row.pane = p; s0.row.pane = q;
      p = q;
    }
    if (!p._min) {
      const { col, row } = slotOf(this.cols, p);
      col.rows.splice(col.rows.indexOf(row), 1);
      if (!col.rows.length) this.cols.splice(this.cols.indexOf(col), 1);
      norm(this.cols);
    }
    this.panes.splice(this.panes.indexOf(p), 1);
    p.dispose();
    if (!this.panes.includes(this.active)) this.active = this.primary;
    this.layout = layoutName(this.cols);
    this.build();
    this.setActive(this.active);
    this.onLayout?.();
  }

  // Minimize: out of the layout (like Close) but kept; its tab in the dock brings it back in the same place
  minimize(p = this.active) {
    if (p._min || this.visible().length < 2 && !this.max) return;
    this.max = null;
    if (p === this.primary) { // pane 0 must stay on screen (it owns the renderer): it swaps view + place with another pane
      const vis = this.panes.filter((x) => x !== p && !x._min);
      const q = vis.find((x) => x === this.active) || vis[0];
      const s0 = slotOf(this.cols, p), s1 = slotOf(this.cols, q);
      swapCam(p, q);
      s0.row.pane = q; s1.row.pane = p;
      if (this.active === p) this.active = q;
      p = q;
    }
    const { col, row } = slotOf(this.cols, p), ci = this.cols.indexOf(col);
    p._min = { ci, ri: col.rows.indexOf(row), h: row.h, w: col.w, alone: col.rows.length === 1, ncols: this.cols.length };
    col.rows.splice(col.rows.indexOf(row), 1);
    if (!col.rows.length) this.cols.splice(ci, 1);
    norm(this.cols);
    if (this.active === p) this.active = this.visible()[0] || this.primary;
    this.layout = layoutName(this.cols);
    this.build();
    this.setActive(this.active);
    this.onLayout?.(); this.onChange?.();
  }

  unminimize(p) {
    const m = p?._min; if (!m) return;
    p._min = null;
    this.max = null;
    if (m.alone || !this.cols[m.ci] || this.cols.length < m.ncols && m.alone) { // its own column again
      const ci = Math.min(m.ci, this.cols.length);
      const w = Math.min(0.9, m.w || 1 / (this.cols.length + 1));
      for (const c of this.cols) c.w *= 1 - w;
      this.cols.splice(ci, 0, { w, rows: [{ h: 1, pane: p }] });
    } else {
      const col = this.cols[m.ci], ri = Math.min(m.ri, col.rows.length);
      const h = Math.min(0.9, m.h || 1 / (col.rows.length + 1));
      for (const r of col.rows) r.h *= 1 - h;
      col.rows.splice(ri, 0, { h, pane: p });
    }
    norm(this.cols);
    this.layout = layoutName(this.cols);
    this.build();
    this.setActive(p);
    this.onLayout?.(); this.onChange?.();
  }

  restoreMinimized() { for (const p of this.minimized()) this.unminimize(p); }

  // name for a dock tab: the standard view the camera looks along, else Isometric / 3D View
  viewName(p) {
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(p.camera.quaternion);
    for (const [v, name] of VIEW_NAMES) if (d.dot(new THREE.Vector3(...v)) > 0.999) return name;
    const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
    return a.every((c) => Math.abs(c - 0.57735) < 0.02) ? 'Isometric' : '3D View';
  }

  syncDock() {
    const mins = this.minimized();
    this.dock.innerHTML = '';
    this.dock.style.display = mins.length ? '' : 'none';
    for (const p of mins) {
      const b = document.createElement('button');
      b.className = 'vs-tab'; b.title = 'Restore this view';
      b.innerHTML = ICON.up + '<span>' + this.viewName(p) + '</span>';
      for (const t of ['pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'wheel']) b.addEventListener(t, (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); this.unminimize(p); });
      this.dock.appendChild(b);
    }
  }

  // items for the right-click menu on empty space in a pane (empty with one view)
  menuItems(p = this.active) {
    const items = [];
    if (this.visible().length > 1 || this.max) {
      items.push(this.max ? { label: 'Restore Views', icon: 'views', run: () => this.restoreViews() } : { label: 'Maximize View', icon: 'views', run: () => this.maximize(p) },
        { label: 'Minimize View', icon: 'views', run: () => this.minimize(p) },
        { label: 'Close View', icon: 'cancel', run: () => this.closePane(p) });
    }
    if (this.minimized().length) items.push({ label: 'Restore Minimized Views', icon: 'views', run: () => this.restoreMinimized() });
    if (items.length) items.push('-');
    return items;
  }
}
