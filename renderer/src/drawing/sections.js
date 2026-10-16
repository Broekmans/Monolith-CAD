// Editing section views after placing them (mixin of DrawingDoc): the cutting line on the parent view can
// be clicked (selects the section) and dragged square to itself; the section panel sets the offset, flips
// the direction of sight and renames the letter. Point cloud sections also have slice thickness and view
// depth (cloudview.js panel). The section is recomputed after each change.
import { h, fmt, toast } from '../ui.js';
import { viewXf, viewScale } from './sheet.js';

export class DrawingSections {
  // section view whose cutting line (on its parent, this sheet) is within 6 px of p
  cutAt(p) {
    const tol = 6 / Math.max(1e-6, Math.abs(this.affine().ex[0]));
    for (const c of this.doc.views.filter((q) => q.cut && q.parent)) {
      const par = this.V(c.parent); if (!par || par.sheet !== this.sheetId || !par.geom) continue;
      const { f } = viewXf(par, this.sheetOf(par)), A = f(...c.cut.a), B = f(...c.cut.b);
      const d = [B[0] - A[0], B[1] - A[1]], l2 = d[0] ** 2 + d[1] ** 2 || 1, t = ((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1]) / l2;
      if (t < -0.15 || t > 1.15) continue;
      const e = Math.hypot(p[0] - (A[0] + d[0] * t), p[1] - (A[1] + d[1] * t));
      if (e <= tol) return c;
    }
    return null;
  }
  // move the cut square to itself by `shift` model mm (parent view units); plane follows
  shiftCut(v, shift) {
    const m = v.cut.m2, n = v.plane.n;
    v.cut.a = [v.cut.a[0] + m[0] * shift, v.cut.a[1] + m[1] * shift];
    v.cut.b = [v.cut.b[0] + m[0] * shift, v.cut.b[1] + m[1] * shift];
    v.plane = { ...v.plane, p: v.plane.p.map((c, i) => c + n[i] * shift) };
    v.cut.off = (v.cut.off || 0) + shift;
  }
  // drag along the parent: sheet delta -> model shift along the cut normal
  dragCutShift(v, dSheet) { const par = this.V(v.parent), s = viewScale(par, this.sheetOf(par)), m = v.cut.m2; return (dSheet[0] * m[0] + dSheet[1] * m[1]) / s; }
  async recomputeViews(vs) {
    const bySrc = new Map();
    for (const v of vs) { if (!bySrc.has(v.src)) bySrc.set(v.src, []); bySrc.get(v.src).push(v); }
    const ok = await this.run('Updating the section', async () => { for (const [src, arr] of bySrc) { const g = await this.computeViews(src, arr); arr.forEach((v, i) => { v.geom = g[i]; }); } return true; });
    if (ok) { this.app.setDirty(true); this.renderTree(); this.vp.requestRender(); }
  }
  setCutOffset(v, off) { const shift = off - (v.cut.off || 0); if (Math.abs(shift) < 1e-6) return; this.change(() => this.shiftCut(v, shift)); this.recomputeViews([v]); }
  flipSection(v) {
    this.change(() => {
      v.dir = v.dir.map((c) => -c || 0); v.x = v.x.map((c) => -c || 0);
      v.plane = { ...v.plane, n: v.plane.n.map((c) => -c || 0) };
      v.cut.m2 = [-v.cut.m2[0] || 0, -v.cut.m2[1] || 0];
      if (v.side && v.side !== 'free') v.side = 'free';
    });
    this.recomputeViews([v]);
  }
  sectionPanel(v) {
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const letter = h('input', { type: 'text', value: v.cut.letter, style: { width: '50px' } });
    letter.addEventListener('keydown', (e) => e.stopPropagation());
    letter.addEventListener('change', () => { const t = letter.value.trim().toUpperCase().slice(0, 3); if (!t) return; if (this.doc.views.some((q) => q !== v && q.cut?.letter === t)) { toast(`${t}-${t} is already used`); letter.value = v.cut.letter; return; } this.change(() => { v.cut.letter = t; if (/^Section /.test(v.name)) v.name = `Section ${t}-${t}`; }); });
    const off = h('input', { type: 'number', step: 0.05, value: +(((v.cut.off || 0) / 1000).toFixed(3)), style: { width: '80px' } });
    off.addEventListener('keydown', (e) => e.stopPropagation());
    off.addEventListener('change', () => this.setCutOffset(v, (parseFloat(off.value) || 0) * 1000));
    return h('div', {}, h('div', { class: 'sp-sec' }, 'Section'),
      field('Letter', letter),
      field('Offset (m)', off),
      h('div', { class: 'pp-inline', style: { margin: '4px 8px' } }, h('button', { class: 'mini txt', onclick: () => this.flipSection(v) }, 'Flip direction of sight')),
      h('p', { class: 'pm-info', style: { margin: '2px 8px' } }, `Drag the cutting line ${v.cut.letter}–${v.cut.letter} on ${this.V(v.parent)?.name || 'its view'} to move it (moved ${fmt((v.cut.off || 0) / 1000, 3)} m).`));
  }
}
