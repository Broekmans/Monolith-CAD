// Navigation view cube (top-right of a 3D viewport), Inventor/SolidWorks style.
// Click a face, edge or corner to look at it; drag on the cube to orbit.
import * as THREE from 'three';
import { opt } from './app/options.js';

// Size: Options > Viewports > View cube size (% of the view's shorter side) between minimum and maximum (px).
// S = cube px, M = margin around it (room for the arrows); both set by layout() when the view size changes.
export function cubeSize(w, h) {
  const lo = Math.min(opt('cubeMin'), opt('cubeMax')), hi = Math.max(opt('cubeMin'), opt('cubeMax'));
  return Math.round(Math.min(hi, Math.max(lo, opt('cubePct') / 100 * Math.min(w || 0, h || 0) || lo)));
}
const FACES = [ // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
  'RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK',
];

export class ViewCube {
  constructor(vp) {
    this.vp = vp;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-0.9, 0.9, 0.9, -0.9, -10, 10);
    this.mats = FACES.map(() => new THREE.MeshBasicMaterial());
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.mats);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial());
    this.hl = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.55, depthTest: false }));
    this.hl.visible = false;
    this.scene.add(this.cube, this.edges, this.hl);
    this.hover = null;
    this.S = 104; this.M = 20;
    // DOM hit area over the canvas
    const el = this.el = document.createElement('div');
    el.className = 'viewcube';
    Object.assign(el.style, { position: 'absolute', cursor: 'pointer', zIndex: 4 });
    vp.el.appendChild(el);
    this.addArrows();
    this.layout(true);
    let drag = null;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false }; });
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        const rs = 0.012 * opt('rotateSpeed') / 100;
        if (drag.moved) { drag.x = e.clientX; drag.y = e.clientY; vp.rotateBy(dx * rs, dy * rs); this.setHover(null); }
        return;
      }
      this.setHover(this.pick(e));
    });
    el.addEventListener('pointerup', (e) => {
      const d = drag; drag = null;
      if (d && !d.moved) { const n = this.pick(e); if (n) this.goTo(n); }
    });
    el.addEventListener('pointerleave', () => { if (!drag) this.setHover(null); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('dblclick', (e) => e.stopPropagation());
    this.applyTheme();
    window.addEventListener('monolith-theme', () => { this.applyTheme(); vp.requestRender(); });
  }

  // 90° arrows: triangles on the four sides (tilt / turn) + two curved arrows top-right (roll)
  addArrows() {
    const vp = this.vp;
    const box = this.arrows = document.createElement('div');
    box.className = 'vc-arrows';
    Object.assign(box.style, { position: 'absolute', top: '0px', right: '0px', pointerEvents: 'none', zIndex: 4 });
    const tri = '<svg viewBox="0 0 12 12"><path d="M6 2L11 9H1z"/></svg>';
    const roll = (flip) => `<svg viewBox="0 0 16 16"${flip ? ' style="transform:scaleX(-1)"' : ''}><path d="M3 9a5 5 0 1 0 2-6" fill="none" stroke-width="1.8"/><path d="M2.2 0.8L6.4 3 3 6.2z" stroke="none"/></svg>`;
    const items = [
      ['up', tri, 0, 'Rotate 90° up'], ['down', tri, 180, 'Rotate 90° down'],
      ['left', tri, -90, 'Rotate 90° left'], ['right', tri, 90, 'Rotate 90° right'],
      ['ccw', roll(false), 0, 'Roll 90° counter-clockwise'], ['cw', roll(true), 0, 'Roll 90° clockwise'],
    ];
    this.arrowBtns = {};
    for (const [kind, svg, rot, tip] of items) {
      const b = document.createElement('button');
      b.className = 'vc-arrow vc-' + kind; b.title = tip; b.innerHTML = svg; b.dataset.kind = kind;
      Object.assign(b.style, { transform: rot ? `rotate(${rot}deg)` : '' });
      this.arrowBtns[kind] = b;
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
      b.addEventListener('click', (e) => { e.stopPropagation(); vp.stepView(kind); });
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
      box.appendChild(b);
    }
    vp.el.appendChild(box);
  }

  // size from the view (called by Viewport.resize and before each render; cheap when nothing changed)
  layout(force) {
    const vp = this.vp, S = cubeSize(vp.width, vp.height);
    if (!force && S === this.S) return;
    const M = Math.max(18, Math.round(S * 0.19));
    this.S = S; this.M = M;
    Object.assign(this.el.style, { top: M + 'px', right: M + 'px', width: S + 'px', height: S + 'px' });
    Object.assign(this.arrows.style, { width: S + 2 * M + 'px', height: S + 2 * M + 'px' });
    const c = M + S / 2, at = {
      up: [c, M - 8], down: [c, M + S + 8], left: [M - 8, c], right: [M + S + 8, c],
      ccw: [M + S - 6, M - 8], cw: [M + S + 8, M + 6],
    };
    for (const [k, [x, y]] of Object.entries(at)) Object.assign(this.arrowBtns[k].style, { left: x - 8 + 'px', top: y - 8 + 'px' });
    vp.viewset?.placeHud?.();
  }

  applyTheme() {
    const dark = document.body.classList.contains('dark');
    const bg = dark ? '#3a4352' : '#e9eef5', fg = dark ? '#e6ebf2' : '#2b3a52', bd = dark ? '#566074' : '#b9c4d4';
    FACES.forEach((label, i) => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = bd; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 125, 125);
      g.fillStyle = fg; g.font = '700 30px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, 64, 66);
      const old = this.mats[i].map;
      this.mats[i].map = new THREE.CanvasTexture(c);
      this.mats[i].map.colorSpace = THREE.SRGBColorSpace;
      this.mats[i].needsUpdate = true;
      old?.dispose();
    });
    this.edges.material.color.set(dark ? 0x7a869a : 0x8794a8);
  }

  // Region normal (each component -1/0/1) under the mouse, or null.
  pick(e) {
    const r = this.el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.cam);
    const hit = rc.intersectObject(this.cube)[0];
    if (!hit) return null;
    const p = hit.point, q = (v) => (v > 0.34 ? 1 : v < -0.34 ? -1 : 0);
    return [q(p.x), q(p.y), q(p.z)];
  }

  setHover(n) {
    const key = n ? n.join() : null;
    if (key === (this.hover ? this.hover.join() : null)) return;
    this.hover = n;
    this.hl.visible = !!n;
    if (n) {
      this.hl.scale.set(...n.map((c) => (c ? 0.18 : 0.66)));
      this.hl.position.set(...n.map((c) => c * 0.43));
    }
    this.vp.requestRender();
  }

  goTo(n) {
    const names = { '1,0,0': 'right', '-1,0,0': 'left', '0,1,0': 'top', '0,-1,0': 'bottom', '0,0,1': 'front', '0,0,-1': 'back' };
    const name = names[n.join()];
    if (name) { this.vp.setView(name); return; }
    const d = new THREE.Vector3(-n[0], -n[1], -n[2]).normalize(); // view direction
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(d, -d.y);
    if (up.lengthSq() < 1e-6) up.set(0, 0, -1);
    this.vp.orient(d.toArray(), up.normalize().toArray());
  }

  render(r) {
    const vp = this.vp;
    this.layout();
    const S = this.S, M = this.M;
    // draw exactly under the DOM hit area (its CSS margin moves it down when the pane buttons show, ≤ 0.1.77 drew it at M)
    const el = this.el, x = el.offsetWidth ? el.offsetLeft : vp.width - S - M, y = el.offsetWidth ? el.offsetTop : M;
    r.setViewport(x, vp.height - y - S, S, S);
    r.clearDepth();
    const q = vp.camera.quaternion;
    this.cam.quaternion.copy(q);
    this.cam.position.set(0, 0, 5).applyQuaternion(q);
    this.cam.updateMatrixWorld();
    r.render(this.scene, this.cam);
  }

  dispose() { this.el.remove(); this.arrows?.remove(); }
}
