// While a feature PropertyManager is open (Extrude, Revolve, Fillet, Chamfer, Shell, Patterns):
// - the dialog floats as a compact box top-left over the 3D view, so the FeatureManager tree stays visible;
// - the feature's sketch stays visible with a light profile fill, its dimensions are shown on the model
//   (double-click one to change it; the preview follows);
// - the main value (Depth / Angle / Radius / Distance / Thickness / Spacing) sits in an edit box on the model,
//   for Extrude with a drag arrow along the extrude direction. Enter in the box = OK, Esc = Cancel.
import * as THREE from 'three';
import { h, fmt } from '../ui.js';
import { sketchCurves, findRegions } from '../../../shared/profile.mjs';
import { frameOf, to3 } from './part.js';

// main value per feature type: [PM key, label, unit]
export const MAIN = { extrude: ['depth', 'Depth', 'mm'], revolve: ['angle', 'Angle', '°'], fillet: ['radius', 'Radius', 'mm'], chamfer: ['distance', 'Distance', 'mm'], shell: ['thickness', 'Thickness', 'mm'], linearPattern: ['spacing', 'Spacing', 'mm'], circularPattern: ['angle', 'Total angle', '°'] };
const evalNum = (s) => { const v = Number(String(s).replace(',', '.').trim()); return isFinite(v) ? v : null; };

export class PartFeatureUI {
  featUIStart(draft, values, preview, base) {
    this.featUIEnd();
    const t = draft.type, m = MAIN[t];
    const ui = (this.featUI = { type: t, op: draft.op, key: m?.[0], values, preview: () => { this.setPickBase(base); preview(this.app.pm.current?.values || values); } });
    if (m) {
      const inp = h('input', { type: 'text', spellcheck: 'false', value: fmt(+values[m[0]], 4) });
      const grip = h('div', { class: 'feat-grip', title: 'Drag to change the ' + m[1].toLowerCase() });
      const box = h('div', { class: 'feat-val', title: 'Enter = OK · Esc = Cancel · Tab = apply' }, h('label', {}, m[1]), inp, h('span', { class: 'unit' }, m[2]));
      for (const ev of ['pointerdown', 'dblclick', 'wheel']) box.addEventListener(ev, (e) => e.stopPropagation());
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); if (this.featApply(inp.value) !== false) this.app.pm.ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.app.pm.cancel(); }
      });
      inp.addEventListener('change', () => this.featApply(inp.value));
      grip.addEventListener('pointerdown', (e) => this.featGripDown(e));
      this.vp.el.append(box, grip);
      Object.assign(ui, { box, inp, grip });
    }
    this.featUISync(values);
  }
  featUIEnd() {
    if (this.editingId) { this.editingId = null; setTimeout(() => this.renderTree(), 0); }
    const ui = this.featUI; if (!ui) return;
    ui.box?.remove(); ui.grip?.remove();
    this.featUI = null;
    this.dimFeat = null; this._dimHits = [];
    this.updateSketchDisplay();
  }
  // PM values changed: sketch to show, value in the box
  featUISync(v) {
    const ui = this.featUI; if (!ui) return;
    ui.values = v;
    const sid = v.sketchSel?.[0]?.id || null;
    if (sid !== ui.sketch) { ui.sketch = sid; this.dimFeat = sid; this.updateSketchDisplay(); }
    if (ui.inp && document.activeElement !== ui.inp && !ui.drag) ui.inp.value = fmt(+v[ui.key], 4);
    this.vp.requestRender();
  }
  // value typed / dragged → the PM field (its change handler validates, stores and previews)
  featApply(text) {
    const ui = this.featUI, pm = this.app.pm.current; if (!ui || !pm) return false;
    const n = evalNum(text);
    const f = pm.inputs[ui.key];
    if (n === null || n <= 0 || !f) { ui.inp?.classList.add('bad'); return false; }
    ui.inp?.classList.remove('bad');
    const val = ui.key === 'count' ? Math.max(2, Math.round(n)) : n;
    if (+pm.values[ui.key] === val) return true;
    f.value = String(val); f.dispatchEvent(new Event('change'));
    return true;
  }
  // sketch plane frame + profile centre of the shown sketch
  featProfile() {
    const sk = this.F(this.featUI?.sketch); if (!sk) return null;
    const st = this.status?.find((x) => x.id === sk.id), fr = frameOf(st?.plane || this.planeOf(sk));
    let regions = [];
    try { regions = findRegions(sketchCurves(sk)).regions; } catch {}
    const pts = regions.length ? regions.flatMap((r) => r.outer.poly) : sk.geo.filter((g) => g.type === 'point').map((p) => [p.x, p.y]);
    if (!pts.length) return null;
    const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    return { sk, fr, regions, c, c3: to3(fr, c) };
  }
  // 3D anchor of the value box (+ arrow base and direction for Extrude)
  featAnchor() {
    const ui = this.featUI, v = ui?.values; if (!v) return null;
    if (ui.type === 'extrude' || ui.type === 'revolve') {
      const pr = this.featProfile(); if (!pr) return null;
      if (ui.type === 'revolve') return { p: pr.c3 };
      if (v.end === 'throughAll') return null;
      let dir = pr.fr.n.slice();
      if (v.reverse) dir = dir.map((x) => -x);
      if (ui.op === 'cut' && v.end !== 'midplane') dir = dir.map((x) => -x);
      const d = (+v.depth || 0) * (v.end === 'midplane' ? 0.5 : 1);
      return { base: pr.c3, dir, p: pr.c3.map((x, i) => x + dir[i] * d), arrow: true, k: v.end === 'midplane' ? 0.5 : 1 };
    }
    const it = v.edges?.[0] || v.faces?.[0];
    const p = it?.mid || it?.c || it?.edge?.mid;
    return p ? { p: Array.isArray(p) ? p : [p.x, p.y, p.z] } : null;
  }
  // overlay: arrow + place the HTML box and grip (called from drawOverlay)
  drawFeatUI(ctx) {
    const ui = this.featUI; if (!ui?.box) return;
    // several panes: the value box + arrow live in the active pane only (they move along when another pane becomes active)
    const set = this.vp.viewset;
    if (set && set.panes.length > 1) {
      if (this.vp.pane !== set.active) return;
      if (ui.box.parentElement !== set.active.el) { set.active.el.appendChild(ui.box); if (ui.grip) set.active.el.appendChild(ui.grip); }
    }
    const a = this.featAnchor(), vp = this.vp;
    if (!a) { // no spot on the model: top centre under the view toolbar
      Object.assign(ui.box.style, { left: vp.width / 2 + 'px', top: '52px', display: '' }); ui.box.classList.add('free'); ui.grip.style.display = 'none'; return;
    }
    ui.box.classList.remove('free');
    const s = vp.toScreen(a.p);
    if (a.arrow) {
      const b = vp.toScreen(a.base);
      ctx.strokeStyle = '#286edc'; ctx.fillStyle = '#286edc'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.beginPath(); ctx.arc(b[0], b[1], 3, 0, Math.PI * 2); ctx.fill();
      // arrow head pointing along the extrude direction (screen)
      const t = vp.toScreen(a.p.map((x, i) => x + a.dir[i])), L = Math.hypot(t[0] - s[0], t[1] - s[1]) || 1, ux = (t[0] - s[0]) / L, uy = (t[1] - s[1]) / L;
      ctx.beginPath(); ctx.moveTo(s[0] + ux * 12, s[1] + uy * 12); ctx.lineTo(s[0] - uy * 5, s[1] + ux * 5); ctx.lineTo(s[0] + uy * 5, s[1] - ux * 5); ctx.closePath(); ctx.fill();
      Object.assign(ui.grip.style, { left: s[0] + ux * 5 + 'px', top: s[1] + uy * 5 + 'px', display: '' });
      ui.dirScr = [ux, uy];
    } else ui.grip.style.display = 'none';
    Object.assign(ui.box.style, { left: s[0] + 22 + 'px', top: s[1] + 'px', display: '' });
  }
  // drag the arrow: value follows the mouse along the extrude direction on screen
  featGripDown(e) {
    const ui = this.featUI, a = this.featAnchor(); if (!ui || !a?.arrow) return;
    e.preventDefault(); e.stopPropagation();
    const vp = this.vp, s0 = vp.toScreen(a.base), s1 = vp.toScreen(a.base.map((x, i) => x + a.dir[i]));
    const pxPerMm = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
    if (pxPerMm < 0.05) return; // looking straight along the direction
    const u = [(s1[0] - s0[0]) / pxPerMm, (s1[1] - s0[1]) / pxPerMm], d0 = +ui.values.depth, x0 = e.clientX, y0 = e.clientY;
    const step = vp.scale > 2 ? 5 : vp.scale > 0.4 ? 1 : 0.1;
    ui.drag = true; ui.grip.setPointerCapture(e.pointerId);
    let raf = 0, want = d0;
    const mv = (ev) => {
      const t = ((ev.clientX - x0) * u[0] + (ev.clientY - y0) * u[1]) / pxPerMm / a.k;
      want = Math.max(step, Math.round((d0 + t) / (ev.shiftKey ? step / 10 : step)) * (ev.shiftKey ? step / 10 : step));
      ui.inp.value = fmt(want, 4);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.featApply(String(want)); });
    };
    const up = () => { ui.grip.removeEventListener('pointermove', mv); ui.grip.removeEventListener('pointerup', up); ui.drag = false; this.featApply(String(want)); this.app.setStatus(`Depth ${fmt(want, 3)} mm`); };
    ui.grip.addEventListener('pointermove', mv); ui.grip.addEventListener('pointerup', up);
  }
  // light fill of the profile regions of the shown sketch (added by updateSketchDisplay)
  featFill(sk) {
    const pr = this.featProfile(); if (!pr || pr.sk !== sk || !pr.regions.length) return null;
    const pos = [];
    for (const r of pr.regions) {
      const shape = new THREE.Shape(r.outer.poly.map((p) => new THREE.Vector2(p[0], p[1])));
      for (const ho of r.holes) shape.holes.push(new THREE.Path(ho.poly.map((p) => new THREE.Vector2(p[0], p[1]))));
      const g = new THREE.ShapeGeometry(shape), P = g.attributes.position, idx = g.index;
      const at = (i) => to3(pr.fr, [P.getX(i), P.getY(i)]);
      for (let k = 0; k < idx.count; k++) pos.push(...at(idx.getX(k)));
      g.dispose();
    }
    const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0xffc478, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    mesh.renderOrder = 4; mesh.raycast = () => {};
    return mesh;
  }
}
