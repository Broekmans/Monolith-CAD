// Navigation view cube (top-right of a 3D viewport), Inventor/SolidWorks style.
// Click a face, edge or corner to look at it; drag on the cube to orbit.
import * as THREE from 'three';

const S = 104, M = 10; // size in px, margin
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
    // DOM hit area over the canvas
    const el = this.el = document.createElement('div');
    el.className = 'viewcube';
    Object.assign(el.style, { position: 'absolute', top: M + 'px', right: M + 'px', width: S + 'px', height: S + 'px', cursor: 'pointer', zIndex: 4 });
    vp.el.appendChild(el);
    let drag = null;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); el.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, moved: false }; });
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        if (drag.moved) { drag.x = e.clientX; drag.y = e.clientY; vp.rotateBy(dx * 0.012, dy * 0.012); this.setHover(null); }
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
    const ndc = new THREE.Vector2(((e.clientX - r.left) / S) * 2 - 1, -((e.clientY - r.top) / S) * 2 + 1);
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
    r.setViewport(vp.width - S - M, vp.height - S - M, S, S);
    r.clearDepth();
    const q = vp.camera.quaternion;
    this.cam.quaternion.copy(q);
    this.cam.position.set(0, 0, 5).applyQuaternion(q);
    this.cam.updateMatrixWorld();
    r.render(this.scene, this.cam);
  }

  dispose() { this.el.remove(); }
}
