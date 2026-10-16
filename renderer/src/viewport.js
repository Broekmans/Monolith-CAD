// 3D viewport: orthographic CAD camera, SolidWorks-style mouse navigation,
// a 2D overlay canvas for annotations, and a corner view triad.
import { opt } from './app/options.js';
import { ViewCube } from './viewcube.js';
import * as THREE from 'three';
import { Grid } from './grid.js';

const tmpV = new THREE.Vector3();

export class Viewport {
  // shared / renderer: extra pane of a ViewSet (same scene, lights and grid as `shared`; draws with the
  // ViewSet's offscreen renderer and copies the picture into its own canvas)
  constructor(container, { mode = '3d', shared = null, renderer = null } = {}) {
    this.container = container;
    this.mode = mode; // '3d' or 'plan' (no rotation, top-down)
    this.el = document.createElement('div');
    this.el.className = 'viewport';
    container.appendChild(this.el);

    if (renderer) {
      this.renderer = renderer;
      this.out = document.createElement('canvas'); // what this pane shows (copied from the offscreen renderer)
      this.out.className = 'gl';
      this.outCtx = this.out.getContext('2d');
      this.el.appendChild(this.out);
    } else {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.autoClear = false;
      this.el.appendChild(this.renderer.domElement);
      this.renderer.domElement.className = 'gl';
    }

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    this.el.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d');

    this.scene = shared ? shared.scene : new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.target = new THREE.Vector3(0, 0, 0);
    this.scale = 0.5; // world units per pixel
    this.camera.position.set(1, 1, 1).normalize().multiplyScalar(1000);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);

    // lighting that follows the camera (one key light per scene; each pane moves it before it renders)
    if (shared) this.keyLight = shared.keyLight;
    else {
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9098a8, 1.7));
      this.keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
      this.scene.add(this.keyLight);
      this.scene.add(this.keyLight.target);
    }

    // corner triad
    this.triadScene = new THREE.Scene();
    this.triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
    const axis = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir)]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    };
    this.triadScene.add(axis([1, 0, 0], 0xd03030), axis([0, 1, 0], 0x30a030), axis([0, 0, 1], 0x3050d0));

    this.overlayDrawers = [];
    this.grid = shared ? shared.grid : new Grid(); // on/off + frame set by the document (Part, Assembly)
    if (mode === '3d') this.viewCube = new ViewCube(this);
    this.needsRender = true;
    this.anim = null;
    this._bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.el);
    this.resize();
    if (mode === 'plan') this.setView('top', false);
    const loop = () => {
      if (this.disposed) return;
      requestAnimationFrame(loop);
      if (this.anim) this._stepAnim();
      if (this.needsRender) { this.needsRender = false; this._render(); }
    };
    loop();
  }

  requestRender() { this.needsRender = true; }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) { if (!this.width) { this.width = 1; this.height = 1; } return; } // hidden (other tab / maximized pane): keep the last size
    // the model scales with the view: only the width changed → scale by the width, only the height → by the
    // height, both → keep everything that was visible (option scaleWithView, default on)
    const w0 = this.width, h0 = this.height;
    if (w0 > 1 && h0 > 1 && (w0 !== w || h0 !== h) && opt('scaleWithView')) {
      const rw = w0 / w, rh = h0 / h;
      const k = Math.abs(rw - 1) < 1e-3 ? rh : Math.abs(rh - 1) < 1e-3 ? rw : Math.max(rw, rh);
      this.scale = Math.min(1e5, Math.max(1e-5, this.scale * k));
    }
    this.width = w; this.height = h;
    const dpr = window.devicePixelRatio || 1;
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr); // UI scale / monitor change
    if (this.out) {
      this.out.width = Math.floor(w * dpr); this.out.height = Math.floor(h * dpr);
      this.out.style.width = w + 'px'; this.out.style.height = h + 'px';
      this._fitOffscreen(w, h);
    } else this.renderer.setSize(w, h, false);
    this.overlay.width = w * dpr; this.overlay.height = h * dpr;
    this.overlay.style.width = w + 'px'; this.overlay.style.height = h + 'px';
    if (!this.out) { this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px'; }
    this._updateCamera();
    this.requestRender();
  }

  // the shared offscreen canvas must be at least as big as this pane (it only grows)
  _fitOffscreen(w, h) {
    const sz = this.renderer.getSize(new THREE.Vector2());
    if (sz.x < w || sz.y < h) this.renderer.setSize(Math.max(sz.x, w), Math.max(sz.y, h), false);
  }
  _updateCamera() {
    const w = this.width / 2 * this.scale, h = this.height / 2 * this.scale;
    const c = this.camera;
    c.left = -w; c.right = w; c.top = h; c.bottom = -h;
    const dir = tmpV.copy(c.position).sub(this.target).normalize();
    c.position.copy(this.target).addScaledVector(dir, 50000);
    c.near = -1e6; c.far = 1e6;
    c.lookAt(this.target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    // key light from upper-left of the viewer
    const right = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
    this.keyLight.position.copy(this.target).add(dir.clone().multiplyScalar(1000)).addScaledVector(up, 600).addScaledVector(right, -400);
    this.keyLight.target.position.copy(this.target);
  }

  // section view: dotted X and Y lines across the cut plane (always visible, drawn on top)
  _renderSecAxes(sec) {
    const box = new THREE.Box3();
    this.scene.traverse((o) => { if (o.isMesh && !o.userData.isCap && o.visible && o.geometry && !o.material?.transparent) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    if (box.isEmpty()) return;
    const n = new THREE.Vector3(...sec.n).normalize();
    const ctr = box.getCenter(new THREE.Vector3());
    const p0 = ctr.clone().addScaledVector(n, -(n.dot(ctr) + sec.c));
    const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = ref.addScaledVector(n, -n.dot(ref)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const h = Math.max(box.getSize(new THREE.Vector3()).length() * 0.6, 1);
    const pts = [p0.clone().addScaledVector(u, -h), p0.clone().addScaledVector(u, h), p0.clone().addScaledVector(v, -h), p0.clone().addScaledVector(v, h)];
    if (!this._secAx) {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = new THREE.LineDashedMaterial({ color: 0x333333, dashSize: 1, gapSize: 1, depthTest: false, depthWrite: false, transparent: true });
      this._secAx = new THREE.LineSegments(g, m);
      this._secAx.renderOrder = 999;
      this._secAxScene = new THREE.Scene();
      this._secAxScene.add(this._secAx);
    }
    const ln = this._secAx;
    ln.geometry.setFromPoints(pts);
    ln.computeLineDistances();
    ln.geometry.attributes.position.needsUpdate = true;
    ln.material.color.set(document.body.classList.contains('dark') ? 0xdddddd : 0x333333);
    ln.material.dashSize = h / 40; ln.material.gapSize = h / 60;
    this.renderer.render(this._secAxScene, this.camera);
  }

  _render() {
    this._updateCamera();
    const r = this.renderer;
    if (this.out) this._fitOffscreen(this.width, this.height);
    r.setViewport(0, 0, this.width, this.height);
    r.clear();
    // section view: clip everything; back faces of solids show as the cut face colour
    const sec = this.section;
    this.scene.traverse((o) => {
      if (o.userData.isCap) { o.visible = !!sec; return; }
      if (!sec || !o.isMesh || o.userData.capDone || o.material?.side !== THREE.DoubleSide || o.material.transparent) return;
      o.userData.capDone = true;
      const cap = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ color: 0xc8553d, side: THREE.BackSide }));
      cap.userData.isCap = true;
      cap.raycast = () => {};
      o.add(cap);
    });
    r.clippingPlanes = sec ? [new THREE.Plane(new THREE.Vector3(...sec.n), sec.c)] : [];
    if (this.renderScene) this.renderScene(r); else r.render(this.scene, this.camera);
    r.clippingPlanes = [];
    if (this.mode === '3d') this.grid.render(r, this);
    if (sec) this._renderSecAxes(sec);
    if (this.mode === '3d') {
      const s = 90;
      r.setViewport(8, 8, s, s);
      r.clearDepth();
      this.triadCam.quaternion.copy(this.camera.quaternion);
      this.triadCam.position.set(0, 0, 0).add(new THREE.Vector3(0, 0, 5).applyQuaternion(this.camera.quaternion));
      this.triadCam.updateMatrixWorld();
      r.render(this.triadScene, this.triadCam);
      this.viewCube?.render(r);
    }
    if (this.out) { // copy the bottom-left w×h of the offscreen canvas (GL origin is bottom-left)
      const src = r.domElement, o = this.out, g = this.outCtx;
      g.clearRect(0, 0, o.width, o.height);
      g.drawImage(src, 0, src.height - o.height, o.width, o.height, 0, 0, o.width, o.height);
    }
    this._drawOverlay();
  }

  _drawOverlay() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.mode === '3d') {
      // triad labels
      const dk = document.body.classList.contains('dark');
      const labels = [['X', [1.25, 0, 0], dk ? '#ff6b6b' : '#c02020'], ['Y', [0, 1.25, 0], dk ? '#5fd35f' : '#208020'], ['Z', [0, 0, 1.25], dk ? '#7f9cff' : '#2040c0']];
      ctx.font = '600 11px Segoe UI, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const [t, p, col] of labels) {
        const v = new THREE.Vector3(...p).applyQuaternion(this.camera.quaternion.clone().invert());
        ctx.fillStyle = col;
        ctx.fillText(t, 8 + 45 + v.x / 1.6 * 45, this.height - 8 - 45 - v.y / 1.6 * 45);
      }
    }
    for (const d of this.overlayDrawers) {
      ctx.save();
      try { d(ctx, this); } catch (e) { console.error(e); }
      ctx.restore();
    }
  }

  // ---------- coordinate helpers ----------
  toScreen(p) {
    const v = tmpV.set(p[0] ?? p.x, p[1] ?? p.y, p[2] ?? p.z).project(this.camera);
    return [(v.x + 1) / 2 * this.width, (1 - v.y) / 2 * this.height];
  }
  ray(sx, sy) {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }
  viewDir() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); }
  // Intersect the cursor ray with a plane frame {o,n,x,y}; returns local [u,v].
  planePoint(sx, sy, fr) {
    const rc = this.ray(sx, sy);
    const n = new THREE.Vector3(...fr.n), o = new THREE.Vector3(...fr.o);
    const denom = n.dot(rc.ray.direction);
    let p;
    if (Math.abs(denom) < 1e-9) p = rc.ray.origin.clone();
    else {
      const t = o.clone().sub(rc.ray.origin).dot(n) / denom;
      p = rc.ray.origin.clone().addScaledVector(rc.ray.direction, t);
    }
    const d = p.sub(o);
    return [d.dot(new THREE.Vector3(...fr.x)), d.dot(new THREE.Vector3(...fr.y))];
  }

  // ---------- navigation ----------
  _bindEvents() {
    const el = this.el;
    let drag = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      const nav = e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey);
      if (!nav) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let kind = 'rotate';
      if (this.mode === 'plan' || e.shiftKey || e.button === 2) kind = 'pan';
      if (e.ctrlKey) kind = 'zoom';
      drag = { kind, x: e.clientX, y: e.clientY, moved: false, button: e.button, t: performance.now() };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.kind === 'rotate') this.rotateBy(dx * 0.008, dy * 0.008);
      else if (drag.kind === 'pan') this.panBy(dx, dy);
      else this.zoomAt(this.width / 2, this.height / 2, Math.exp(dy * 0.01));
    });
    const end = (e) => {
      if (!drag) return;
      const wasRightClick = drag.button === 2 && !drag.moved;
      // double click with the middle button (two short presses without dragging) = Zoom to Fit
      const now = performance.now();
      const midClick = drag.button === 1 && !drag.moved && now - drag.t < 400 && e.type === 'pointerup';
      const midDouble = midClick && opt('midDouble') && now - (this._lastMid || 0) < opt('midDoubleMs');
      this._lastMid = midClick && !midDouble ? now : 0;
      drag = null;
      if (wasRightClick && this.onContextMenu) this.onContextMenu(e);
      if (midDouble && this.onMiddleClick) this.onMiddleClick(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(e.deltaY * 0.0015 * opt('wheelZoom') / 100));
    }, { passive: false });
  }

  rotateBy(ax, ay) {
    if (this.mode === 'plan') return;
    this.anim = null;
    const cam = this.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const q = new THREE.Quaternion().setFromAxisAngle(up, -ax).multiply(new THREE.Quaternion().setFromAxisAngle(right, -ay));
    const off = cam.position.clone().sub(this.target).applyQuaternion(q);
    cam.position.copy(this.target).add(off);
    cam.up.applyQuaternion(q);
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
    this.requestRender();
    this.onViewChange?.();
  }
  panBy(dx, dy) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const d = right.multiplyScalar(-dx * this.scale).addScaledVector(up, dy * this.scale);
    this.target.add(d); cam.position.add(d);
    this.requestRender();
    this.onViewChange?.();
  }
  zoomAt(sx, sy, factor) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const ox = (sx - this.width / 2), oy = (this.height / 2 - sy);
    const newScale = Math.min(1e5, Math.max(1e-5, this.scale * factor));
    const k = this.scale - newScale;
    const d = right.multiplyScalar(ox * k).addScaledVector(up, oy * k);
    this.scale = newScale;
    this.target.add(d); cam.position.add(d);
    this.requestRender();
    this.onViewChange?.();
  }

  // Animate the camera to look along `dir` (from camera to target) with `up`.
  orient(dir, up, animate = true) {
    const m = new THREE.Matrix4();
    const z = new THREE.Vector3(...dir).normalize().negate(); // camera looks along -z
    const y = new THREE.Vector3(...up).normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    y.crossVectors(z, x);
    m.makeBasis(x, y, z);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    if (!animate) { this._applyQuat(q); return; }
    this.anim = { from: this.camera.quaternion.clone(), to: q, t0: performance.now(), dur: 280 };
  }
  _applyQuat(q) {
    const cam = this.camera;
    const dist = 50000;
    cam.quaternion.copy(q);
    cam.position.copy(this.target).add(new THREE.Vector3(0, 0, dist).applyQuaternion(q));
    cam.up.set(0, 1, 0).applyQuaternion(q);
    cam.updateMatrixWorld();
    this.requestRender();
    this.onViewChange?.();
  }
  _stepAnim() {
    const a = this.anim;
    let t = (performance.now() - a.t0) / a.dur;
    if (t >= 1) { t = 1; this.anim = null; }
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const q = a.from.clone().slerp(a.to, e);
    this._applyQuat(q);
    if (a.fit && !this.anim) this.fit(a.fit, false);
  }

  setView(name, animate = true) {
    const V = {
      front: [[0, 0, -1], [0, 1, 0]], back: [[0, 0, 1], [0, 1, 0]],
      top: [[0, -1, 0], [0, 0, -1]], bottom: [[0, 1, 0], [0, 0, 1]],
      right: [[-1, 0, 0], [0, 1, 0]], left: [[1, 0, 0], [0, 1, 0]],
      iso: [[-1, -1, -1], [0, 1, 0]], dimetric: [[-0.5, -0.6, -1], [0, 1, 0]], trimetric: [[-0.8, -0.55, -1], [0, 1, 0]],
    };
    const v = V[name];
    if (!v) return;
    let [dir, up] = v;
    if (name === 'iso') up = [-0.4082, 0.8165, -0.4082];
    this.orient(dir, up, animate);
  }
  // View cube arrows: turn the view 90° — 'up'/'down' tilt about the screen X axis, 'left'/'right' about the
  // screen Y axis (look at the face that was on that side), 'cw'/'ccw' roll about the view direction.
  stepView(kind, animate = true) {
    if (this.mode === 'plan' && kind !== 'cw' && kind !== 'ccw') return;
    const q = this.anim ? this.anim.to : this.camera.quaternion;
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q), u = new THREE.Vector3(0, 1, 0).applyQuaternion(q), r = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    let nd = d, nu = u;
    if (kind === 'up') { nd = u.clone().negate(); nu = d; }
    else if (kind === 'down') { nd = u; nu = d.clone().negate(); }
    else if (kind === 'left') { nd = r; nu = u; }
    else if (kind === 'right') { nd = r.clone().negate(); nu = u; }
    else if (kind === 'cw') { nu = r.clone().negate(); }
    else if (kind === 'ccw') { nu = r; }
    else return;
    this.orient(nd.toArray(), nu.toArray(), animate);
  }
  // Look straight at a plane frame (Normal To).
  normalTo(fr, animate = true) {
    this.orient([-fr.n[0], -fr.n[1], -fr.n[2]], fr.y, animate);
  }

  fit(box, animate = true) {
    if (!box || box.isEmpty?.()) return;
    const b = box.isBox3 ? box : new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
    const center = b.getCenter(new THREE.Vector3());
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    let w = 0, h = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(center);
      w = Math.max(w, Math.abs(p.dot(right))); h = Math.max(h, Math.abs(p.dot(up)));
    }
    const s = Math.max((2 * w) / (this.width * 0.8), (2 * h) / (this.height * 0.8), 1e-3);
    const off = cam.position.clone().sub(this.target);
    this.target.copy(center);
    cam.position.copy(center).add(off);
    this.scale = s;
    void animate;
    this.requestRender();
    this.onViewChange?.();
  }

  snapshot() {
    this._render();
    const c = document.createElement('canvas');
    c.width = this.overlay.width; c.height = this.overlay.height;
    const g = c.getContext('2d');
    g.drawImage(this.out || this.renderer.domElement, 0, 0, c.width, c.height);
    g.drawImage(this.overlay, 0, 0);
    return c.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.viewCube?.dispose();
    if (!this.out) this.renderer.dispose();
    this.el.remove();
  }
}
