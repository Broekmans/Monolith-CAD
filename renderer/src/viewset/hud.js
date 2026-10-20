// ViewSet: the heads-up view toolbar (app.el.headsUp, shared by all tabs) at the active pane's view cube.
// Options > Viewports > View toolbar position: 'cube' = under the cube's arrows (falls back to the left of the cube when
// the view is too low), 'left' = left of the cube, 'top' = centred at the top of the views (old place).
// Only the viewset that is on screen acts (root.offsetParent); plan-mode sets (Drawing / Plan) have no cube → centred.
import { opt } from '../app/options.js';

export class ViewSetHud {
  // OK / Cancel buttons (app.el.corner) inside the focused view, left of its view cube (0.1.95; were at the top right of
  // the whole views area = over another view with several views)
  placeCorner() {
    const el = this.root.closest('.views-wrap')?.querySelector('.corner');
    if (!el || el.style.display === 'none' || !this.root.offsetParent) return;
    const p = this.focus || this.active, host = el.offsetParent?.getBoundingClientRect();
    if (!p?.el.offsetWidth || !host) return;
    const r = p.el.getBoundingClientRect(), a = p.viewCube?.arrows, w = el.offsetWidth || 90, hgt = el.offsetHeight || 38, pad = 6;
    const top = this.visible().length > 1 ? 28 : pad; // under the pane buttons
    let x, y;
    if (a && a.offsetWidth) { x = r.left + a.offsetLeft - 8 - w; y = r.top + Math.max(top, a.offsetTop); }
    else { x = r.right - pad - w; y = r.top + top; }
    x = Math.max(r.left + pad, Math.min(x, r.right - pad - w)); y = Math.max(r.top + pad, Math.min(y, r.bottom - pad - hgt));
    Object.assign(el.style, { left: Math.round(x - host.left) + 'px', top: Math.round(y - host.top) + 'px', right: 'auto' });
  }
  placeHud() {
    this.placeCorner();
    const hud = document.querySelector('.headsup');
    if (!hud || !this.root.offsetParent) return;
    const p = this.focus || this.active, cube = p?.viewCube, mode = opt('hudPos');
    const k = Math.max(0.5, Math.min(2, (opt('hudScale') || 100) / 100)); // Options > Viewports > View toolbar scale
    hud.style.scale = k === 1 ? '' : String(k);
    const reset = () => { hud.classList.remove('vertical'); Object.assign(hud.style, { left: '', right: '', top: '', transform: '', transformOrigin: 'top center' }); hud.classList.remove('under-cube'); hud.dataset.pos = 'top'; };
    if (!cube || mode === 'top' || this.opts.mode === 'plan' || !p.el.offsetWidth) return reset();
    const host = hud.offsetParent?.getBoundingClientRect(), r = p.el.getBoundingClientRect(), a = cube.arrows;
    if (!host || !a) return reset();
    let vert = mode === 'cube';
    hud.classList.toggle('vertical', vert);
    if (vert && (hud.offsetHeight || 150) * k + 12 > r.height) { vert = false; hud.classList.remove('vertical'); } // pane too low: horizontal, left of the cube
    const hw = (hud.offsetWidth || 180) * k, hh = (hud.offsetHeight || 30) * k, pad = 6;
    const aTop = r.top + a.offsetTop, aBottom = aTop + a.offsetHeight, aLeft = r.left + a.offsetLeft;
    let x, y, pos = mode;
    // 'cube' (0.1.93): a slim vertical column at the bottom right of the view cube
    const vw = (hud.offsetWidth || 30) * k, vh = (hud.offsetHeight || 150) * k;
    if (vert && aBottom + 2 + vh + pad <= r.bottom) { x = r.right - 8 - vw; y = aBottom + 2; }
    else if (vert) { x = r.right - 8 - vw; y = r.bottom - pad - vh; }
    else { pos = 'left'; x = aLeft - 6 - hw; y = aTop + Math.max(0, (a.offsetHeight - hh) / 2); }
    // never outside the pane
    const W2 = vert ? vw : hw, H2 = vert ? vh : hh;
    x = Math.max(r.left + pad, Math.min(x, r.right - pad - W2));
    y = Math.max(r.top + pad, Math.min(y, r.bottom - pad - H2));
    Object.assign(hud.style, { left: Math.round(x - host.left) + 'px', right: 'auto', transform: 'none', transformOrigin: 'top left', top: Math.round(y - host.top) + 'px' });
    hud.classList.add('under-cube');
    hud.dataset.pos = pos;
  }
}
