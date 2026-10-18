// Part: drag dimension labels shown on the model (double-clicked face), 0.1.86. The label follows the mouse on the
// sketch plane; the position is stored in the sketch (c.lp + c.lpUser for dimensions, sk.autoLp[key] for dashed sizes,
// f.depthAt for the extrude depth line) so the open sketch shows it there too. Short move = click (double-click still
// edits), Esc during a drag = back. One undo step per drag. Methods are mixed into PartDoc; `this` is the PartDoc.
import { sketchView } from './modeldims.js';

export const autoKey = (cons) => cons.type + ':' + (cons.l || cons.c || '');

export class PartDimDrag {
  bindDimDrag() {
    const el = this.vp.el;
    el.addEventListener('pointerdown', (e) => {
      if (this.sketcher || e.button !== 0 || !this.dimFeat) return;
      const hit = this.dimLabelAt(e);
      if (!hit || hit.driven) return;
      this._dimDrag = { hit, x0: e.clientX, y0: e.clientY, started: false, pane: this.vp.viewset?.paneOf(e.target) || this.vp.pane || this.vp };
      e.stopPropagation();
    }, true);
    const move = (e) => {
      const dd = this._dimDrag; if (!dd) return;
      if (!dd.started) {
        if (Math.hypot(e.clientX - dd.x0, e.clientY - dd.y0) <= 3) return;
        dd.started = true; this.beginChange(); dd.undo = this._last;
        this._downAt = null; // no click / selection at the end
      }
      this.dimDragTo(dd, e);
    };
    const up = (e) => {
      const dd = this._dimDrag; if (!dd) return;
      this._dimDrag = null;
      if (!dd.started) return;
      e.stopPropagation();
      this.commit('move dimension');
      this.app.setStatus('Dimension moved (Ctrl+Z = back)');
      try { window.__lithLog?.('DIMMOVE', dd.hit.text); } catch { /* log optional */ }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('keydown', (e) => {
      const dd = this._dimDrag; if (!dd || e.key !== 'Escape' || !dd.started) return;
      this._dimDrag = null; this.doc = JSON.parse(dd.undo); this._last = null; this.vp.requestRender();
      e.stopPropagation();
    }, true);
  }
  // place the dragged label at the mouse (point on the sketch plane, or on the mid-depth plane for the depth line)
  dimDragTo(dd, e) {
    const d = dd.hit, pane = dd.pane, r = pane.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const f = this.F(this.dimFeat);
    if (d.kind === 'feat' && d.line && f) {
      const sk = this.F(f.sketch), fr = d.lineFr; if (!sk || !fr) return;
      f.depthAt = pane.planePoint(sx, sy, fr);
    } else if (d.c && d.fr) {
      const sk = this.F(d.sk); if (!sk) return;
      const p = pane.planePoint(sx, sy, d.fr);
      const v = sketchView(sk), c = d.kind === 'cons' ? sk.cons.find((x) => x.id === d.cons) : d.c;
      if (!c) return;
      const a = v.dimAnchor(c), lp = [p[0] - a[0], p[1] - a[1]];
      if (d.kind === 'cons') { c.lp = lp; c.lpUser = true; } else (sk.autoLp ||= {})[autoKey(d.c)] = lp;
    } else return;
    this.vp.requestRender();
  }
}
