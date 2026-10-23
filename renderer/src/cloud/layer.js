// One point cloud in a Point Cloud document: octree nodes from the .lithcache file, loaded on demand.
// Level of detail: nodes are picked by their size on screen (largest first) until the point budget is
// used up; each node holds an even sample, so parent + children together give the full density.
import * as THREE from 'three';
import { api } from '../api.js';
import { opt, optHex } from '../app/options.js';

// LAS standard classes (ASPRS) - colours for "Classification": Options pcClassColors
export const CLASS_NAMES = { 0: 'Never classified', 1: 'Unclassified', 2: 'Ground', 3: 'Low vegetation', 4: 'Medium vegetation', 5: 'High vegetation', 6: 'Building', 7: 'Low noise', 8: 'Key point', 9: 'Water', 10: 'Rail', 11: 'Road surface', 12: 'Overlap', 13: 'Wire guard', 14: 'Wire conductor', 15: 'Transmission tower', 16: 'Wire connector', 17: 'Bridge deck', 18: 'High noise' };

const VERT = /* glsl */`
attribute vec3 color;
attribute float scalar;
uniform float size;
uniform int mode;
uniform float sMin, sMax, zMin, zMax;
uniform vec3 single;
uniform vec3 classCol[32];
uniform int categorical;
uniform vec4 clipZ; // on, min, max (local z)
uniform mat4 toDoc; // local -> document frame (scan units)
uniform int boxOn; // crop box preview: 1 keep inside, 2 keep outside
uniform vec3 boxMin, boxMax;
uniform int outMode; // field values outside From..To: 0 end colour, 1 grey, 2 hidden
uniform float tol;   // > 0: deviation view (|v| <= tol green, above red, below blue)
varying vec3 vC;
varying float vClip;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.19, 0.07, 0.23), b = vec3(0.12, 0.56, 0.95), c = vec3(0.29, 0.85, 0.42), d = vec3(0.98, 0.75, 0.17), e = vec3(0.80, 0.16, 0.12);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}
vec3 hashCol(float v) {
  float h = fract(sin(floor(v + 0.5) * 12.9898 + 4.1414) * 43758.5453);
  float s = 0.55 + 0.35 * fract(h * 7.31);
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(0.85), k, s);
}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size;
  vClip = (clipZ.x > 0.5 && (position.z < clipZ.y || position.z > clipZ.z)) ? 1.0 : 0.0;
  if (boxOn > 0) {
    vec3 pd = (toDoc * vec4(position, 1.0)).xyz;
    bool inside = all(greaterThanEqual(pd, boxMin)) && all(lessThanEqual(pd, boxMax));
    if ((boxOn == 1 && !inside) || (boxOn == 2 && inside)) vClip = 1.0;
  }
  if (mode == 0) vC = color;
  else if (mode == 1) vC = ramp((position.z - zMin) / max(1e-6, zMax - zMin));
  else if (mode == 2) {
    if (scalar < -1e29) { vC = vec3(0.55); if (outMode == 2) vClip = 1.0; } // no value
    else if (categorical == 1) vC = hashCol(scalar);
    else if (tol > 0.0) vC = abs(scalar) <= tol ? vec3(0.2, 0.75, 0.3) : scalar > 0.0 ? vec3(0.85, 0.15, 0.12) : vec3(0.15, 0.4, 0.9);
    else {
      float t = (scalar - sMin) / max(1e-12, sMax - sMin);
      if ((t < 0.0 || t > 1.0) && outMode == 1) vC = vec3(0.55);
      else { vC = ramp(t); if ((t < 0.0 || t > 1.0) && outMode == 2) vClip = 1.0; }
    }
  }
  else if (mode == 3) { int k = int(scalar + 0.5); vC = k >= 0 && k < 32 ? classCol[k] : vec3(0.5); }
  else if (mode == 5) vC = vec3(clamp((scalar - sMin) / max(1e-6, sMax - sMin), 0.0, 1.0));
  else vC = single;
}`;
const FRAG = /* glsl */`
uniform int uRound;
varying vec3 vC;
varying float vClip;
void main() {
  if (vClip > 0.5) discard;
  if (uRound == 1) { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; }
  gl_FragColor = vec4(vC, 1.0);
}`;
const MODE = { rgb: 0, height: 1, field: 2, class: 3, single: 4, intensity: 5 };

// world (mm, Y up) from scan units (m, Z up): X = 1000x, Y = 1000z, Z = -1000y
export const SCAN_TO_WORLD = new THREE.Matrix4().set(1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1);

export class CloudLayer {
  constructor(doc, rec, handle) {
    this.doc = doc;
    this.rec = rec;
    this.id = handle.id;
    this.meta = handle.meta;
    this.cachePath = handle.cache;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.nodes = new Map();
    this.loadedPoints = 0;
    this.inflight = 0;
    this.queue = [];
    this.gen = 0; // bumped when the attribute set changes (drops in-flight results)
    const m = this.meta, cube = m.cube;
    for (const [name, n, , depth] of m.nodes) {
      let min = cube.min.slice(), size = cube.size;
      for (let i = 1; i < name.length; i++) { const c = +name[i]; size /= 2; if (c & 4) min[0] += size; if (c & 2) min[1] += size; if (c & 1) min[2] += size; }
      this.nodes.set(name, { name, n, depth, size, box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(min[0] + size, min[1] + size, min[2] + size)), children: [], obj: null, loading: false, used: 0 });
    }
    for (const nd of this.nodes.values()) if (nd.name.length > 1) this.nodes.get(nd.name.slice(0, -1))?.children.push(nd);
    this.root = this.nodes.get('r');
    const bb = m.bbox;
    this.box = new THREE.Box3(new THREE.Vector3(bb[0], bb[1], bb[2]), new THREE.Vector3(bb[3], bb[4], bb[5])); // scan units, relative to origin
    const CLASS_COL = opt('pcClassColors');
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        size: { value: 2 }, mode: { value: 0 }, sMin: { value: 0 }, sMax: { value: 1 }, zMin: { value: bb[2] }, zMax: { value: bb[5] },
        single: { value: new THREE.Color(optHex('pcSingleColor')) }, classCol: { value: Array.from({ length: 32 }, (_, i) => new THREE.Color(CLASS_COL[i] ?? opt('pcClassColorOther'))) },
        categorical: { value: 0 }, outMode: { value: 0 }, tol: { value: 0 }, uRound: { value: 0 }, clipZ: { value: new THREE.Vector4(0, 0, 0, 0) },
        toDoc: { value: new THREE.Matrix4() }, boxOn: { value: 0 }, boxMin: { value: new THREE.Vector3() }, boxMax: { value: new THREE.Vector3() },
      },
    });
    this.want = null;
    this.setPlacement();
    this.applyStyle();
  }

  // position relative to the document origin (keeps float precision for georeferenced scans)
  // rec.transform = {R: 3x3 row-major, t: [3]} in absolute scan coordinates (abs' = R abs + t)
  setPlacement() {
    const o = this.meta.origin, d = this.doc.doc.origin || o, T = this.rec.transform;
    const R = T?.R || [1, 0, 0, 0, 1, 0, 0, 0, 1], t = T?.t || [0, 0, 0];
    // local -> document frame: R * local + (R * origin + t - docOrigin), computed in doubles
    const off = [0, 1, 2].map((i) => R[i * 3] * o[0] + R[i * 3 + 1] * o[1] + R[i * 3 + 2] * o[2] + t[i] - d[i]);
    this.offset = off;
    this.toDoc = new THREE.Matrix4().set(R[0], R[1], R[2], off[0], R[3], R[4], R[5], off[1], R[6], R[7], R[8], off[2], 0, 0, 0, 1);
    this.material.uniforms.toDoc.value.copy(this.toDoc);
    this.group.matrix.copy(SCAN_TO_WORLD).multiply(this.toDoc);
    this.group.matrixWorldNeedsUpdate = true;
    this.resetBoxes();
  }
  // box in the document frame (scan units): corners of the cloud's bounding box
  docBox() { return this.box.clone().applyMatrix4(this.toDoc); }
  setCropPreview(box, mode) {
    const u = this.material.uniforms;
    u.boxOn.value = box ? (mode === 'outside' ? 2 : 1) : 0;
    if (box) { u.boxMin.value.set(...box.min); u.boxMax.value.set(...box.max); }
  }
  worldBox() { return this.box.clone().applyMatrix4(this.group.matrix); }

  // which arrays the current colour mode needs
  wantFor() {
    const mode = this.rec.colorMode || 'rgb', A = this.meta.attrs;
    if (mode === 'rgb' && A.rgb) return { rgb: true, key: 'rgb' };
    if (mode === 'intensity') return { inten: true, key: 'i' };
    if (mode === 'class') return { cls: true, key: 'k' };
    if (mode === 'normal') { const n = ['nx', 'ny', 'nz'].map((k) => A.fields.findIndex((f) => f.name === k)); if (n.every((i) => i >= 0)) return { nrm: n, key: 'n' }; }
    if (mode.startsWith('field:')) { const i = A.fields.findIndex((f) => f.name === mode.slice(6)); if (i >= 0) return { field: i, key: 'f' + i }; }
    return { key: 'none' };
  }
  // colour mode, point size etc. from the record; reloads nodes when other data is needed
  applyStyle() {
    const r = this.rec, u = this.material.uniforms, A = this.meta.attrs;
    let mode = r.colorMode || 'rgb';
    if (mode === 'rgb' && !A.rgb) mode = 'height';
    u.mode.value = mode === 'normal' ? MODE.rgb : mode.startsWith('field:') ? MODE.field : MODE[mode] ?? MODE.height;
    u.outMode.value = { grey: 1, hide: 2 }[r.outside] || 0;
    u.tol.value = mode.startsWith('field:') && r.tol > 0 && r.tolFor === mode ? r.tol : 0;
    u.size.value = (r.pointSize || opt('pcPointSizeFallback')) * (window.devicePixelRatio || 1);
    u.uRound.value = this.doc.doc.view?.round ? 1 : 0;
    u.categorical.value = r.categorical ? 1 : 0;
    const rng = this.rangeFor(mode);
    if (rng) { u.sMin.value = rng[0]; u.sMax.value = rng[1]; }
    const bb = this.meta.bbox;
    const zr = r.heightRange || [bb[2], bb[5]];
    u.zMin.value = zr[0]; u.zMax.value = zr[1];
    const c = r.clip;
    u.clipZ.value.set(c?.on ? 1 : 0, c?.min ?? 0, c?.max ?? 0, 0);
    u.single.value.set(r.single || optHex('pcSingleColor'));
    this.group.visible = r.visible !== false;
    const w = this.wantFor();
    if (this.want && this.want.key !== w.key) this.dropAll();
    this.want = w;
  }
  rangeFor(mode) {
    const A = this.meta.attrs, r = this.rec;
    if (r.range && r.rangeFor === mode) return r.range;
    if (mode === 'intensity') return A.intensity || [0, 65535];
    if (mode.startsWith('field:')) { const f = A.fields.find((x) => x.name === mode.slice(6)); return f ? [f.min, f.max] : null; }
    return null;
  }

  // ---------- level of detail ----------
  // Picks the nodes to show for each pane (Viewport menu: 1–4 panes); returns the number of points shown
  // (the biggest pane). One load queue for all panes; nodes used by no pane are evicted first.
  update(panes, budget) {
    if (!this.root) return 0;
    if (!Array.isArray(panes)) panes = [panes];
    this.group.updateMatrixWorld(true);
    const now = performance.now();
    this.visBy = new Map();
    const union = new Set(), wants = [];
    let shownMax = 0;
    for (const vp of panes) {
      const { vis, want, pts } = this.select(vp, budget, now);
      this.visBy.set(vp, vis);
      for (const nd of vis) union.add(nd);
      wants.push(want);
      shownMax = Math.max(shownMax, pts);
    }
    // interleave the panes' wishes so every pane fills up evenly
    const queue = [], seen = new Set();
    for (let i = 0, more = true; more; i++) { more = false; for (const w of wants) if (i < w.length) { more = true; if (!seen.has(w[i])) { seen.add(w[i]); queue.push(w[i]); } } }
    this.showFor(panes.length === 1 ? panes[0] : this.lastPane || panes[0]);
    this.queue = queue;
    this.pump();
    this.evict(budget * opt('pcEvictK') * Math.max(1, panes.length * opt('pcEvictPaneK')), union);
    let shown = 0;
    for (const nd of this.visBy.get(panes[0]) || []) if (nd.obj) shown += nd.n;
    return shown || shownMax;
  }
  // make the nodes of pane vp visible (called before each pane renders)
  showFor(vp) {
    this.lastPane = vp;
    const vis = this.visBy?.get(vp);
    if (!vis) return;
    for (const nd of this.nodes.values()) if (nd.obj) nd.obj.visible = vis.has(nd);
  }
  select(vp, budget, now) {
    const cam = vp.camera;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const mw = this.group.matrixWorld;
    const pxPerMm = 1 / vp.scale;
    const ctr = vp.target;
    const heap = [];
    const push = (nd) => {
      const wb = nd.wbox || (nd.wbox = nd.box.clone().applyMatrix4(mw));
      if (!frustum.intersectsBox(wb)) return;
      const c = wb.getCenter(new THREE.Vector3());
      const px = wb.getSize(new THREE.Vector3()).length() * pxPerMm;
      const off = c.sub(ctr).length() * pxPerMm / Math.max(vp.width, vp.height);
      heap.push({ nd, pr: px / (1 + off) });
      // sift up
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p].pr >= heap[i].pr) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].pr > heap[m].pr) m = l; if (r < heap.length && heap[r].pr > heap[m].pr) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
      }
      return top;
    };
    push(this.root);
    const vis = new Set();
    let pts = 0;
    const want = [];
    while (heap.length) {
      const { nd } = pop();
      if (pts + nd.n > budget && pts > 0) continue;
      vis.add(nd); pts += nd.n; nd.used = now;
      if (!nd.obj) want.push(nd);
      // go deeper while the sample spacing of this node is more than ~1 px on screen
      const spacingPx = (nd.size / this.meta.grid) * 1000 * pxPerMm;
      if (spacingPx > opt('pcLodSpacingPx')) for (const ch of nd.children) push(ch);
    }
    return { vis, want, pts };
  }
  // world boxes depend on the placement: clear them when it changes
  resetBoxes() { for (const nd of this.nodes.values()) nd.wbox = null; }

  async pump() {
    while (this.inflight < opt('pcMaxRequests') && this.queue.length) {
      // a batch of nodes per request (up to ~1.5 M points)
      const batch = [];
      let pts = 0;
      while (this.queue.length && (batch.length === 0 || pts + this.queue[0].n < opt('pcBatchPts')) && batch.length < opt('pcBatchNodes')) {
        const nd = this.queue.shift();
        if (nd.obj || nd.loading) continue;
        nd.loading = true; batch.push(nd); pts += nd.n;
      }
      if (!batch.length) break;
      this.inflight++; this.reqs = (this.reqs || 0) + 1;
      const gen = this.gen, want = this.want;
      api.cloudRead(this.id, batch.map((n) => n.name), want).then((res) => {
        if (gen !== this.gen || this.disposed) return;
        for (const r of res) this.addNode(this.nodes.get(r.name), r, want);
      }).catch((e) => console.error('cloud read', e)).finally(() => {
        for (const nd of batch) nd.loading = false;
        this.inflight--; this.dones = (this.dones || 0) + 1;
        if (!this.disposed) { this.doc.onNodesLoaded(); this.pump(); }
      });
    }
  }
  addNode(nd, r, want) {
    if (!nd || nd.obj) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.pos), 3));
    if (r.c) g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(r.c), 3, true));
    if (r.nrm) { // normals as colours: |nx|, |ny|, |nz|
      const grey = opt('pcNoNormalGrey');
      const [a, b, c] = r.nrm.map((x) => new Float32Array(x)), col = new Uint8Array(r.n * 3);
      for (let i = 0; i < r.n; i++) { const x = a[i], y = b[i], z = c[i]; if (x === x) { col[i * 3] = Math.abs(x) * 255; col[i * 3 + 1] = Math.abs(y) * 255; col[i * 3 + 2] = Math.abs(z) * 255; } else col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = grey; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    }
    let sc = null;
    if (r.i) sc = Float32Array.from(new Uint16Array(r.i));
    else if (r.k) sc = Float32Array.from(new Uint8Array(r.k));
    else if (r.f) { sc = new Float32Array(r.f); for (let i = 0; i < sc.length; i++) if (sc[i] !== sc[i]) sc[i] = -1e30; } // NaN = no value
    if (sc) g.setAttribute('scalar', new THREE.BufferAttribute(sc, 1));
    g.boundingBox = nd.box.clone();
    g.boundingSphere = nd.box.getBoundingSphere(new THREE.Sphere());
    const p = new THREE.Points(g, this.material);
    p.frustumCulled = false;
    p.matrixAutoUpdate = false;
    p.visible = false;
    p.userData.cloudNode = nd.name;
    nd.obj = p;
    this.group.add(p);
    this.loadedPoints += nd.n;
    void want;
  }
  // free least recently used nodes when far over budget
  evict(limit, vis) {
    if (this.loadedPoints <= limit) return;
    const list = [...this.nodes.values()].filter((n) => n.obj && !vis.has(n)).sort((a, b) => a.used - b.used);
    for (const nd of list) { if (this.loadedPoints <= limit) break; this.freeNode(nd); }
  }
  freeNode(nd) { if (!nd.obj) return; this.group.remove(nd.obj); nd.obj.geometry.dispose(); nd.obj = null; this.loadedPoints -= nd.n; }
  // ---------- picking ----------
  // Nearest visible point around screen position (sx, sy) in px. Prefers the front-most point within
  // `front` px, else the nearest within `r` px. Returns {node, i, doc: [x, y, z] (doc frame), px, depth} or null.
  pickNear(vp, sx, sy, r = opt('pcPickPx'), front = opt('pcPickFrontPx')) {
    const pane = vp.pane || vp; if (this.visBy?.has(pane) && this.lastPane !== pane) this.showFor(pane); // picking in another pane
    if (this.rec.visible === false) return null;
    this.group.updateMatrixWorld(true);
    const cam = vp.camera;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(this.group.matrixWorld).elements;
    const W = vp.width, H = vp.height, u = this.material.uniforms;
    const clip = u.clipZ.value, boxOn = u.boxOn.value, bmin = u.boxMin.value, bmax = u.boxMax.value, T = this.toDoc.elements;
    const toS = (x, y, z) => [((m[0] * x + m[4] * y + m[8] * z + m[12]) + 1) / 2 * W, (1 - (m[1] * x + m[5] * y + m[9] * z + m[13])) / 2 * H, m[2] * x + m[6] * y + m[10] * z + m[14]];
    const cands = [];
    for (const nd of this.nodes.values()) {
      const o = nd.obj;
      if (!o || !o.visible) continue;
      // screen rectangle of the node cube
      const b = nd.box;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let c = 0; c < 8; c++) { const q = toS(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      if (sx < x0 - r || sx > x1 + r || sy < y0 - r || sy > y1 + r) continue;
      const P = o.geometry.attributes.position.array, n = P.length / 3;
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) + 1) / 2 * W - sx;
        if (px > r || px < -r) continue;
        const py = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13])) / 2 * H - sy;
        if (py > r || py < -r) continue;
        const d = Math.hypot(px, py);
        if (d > r) continue;
        if (clip.x > 0.5 && (z < clip.y || z > clip.z)) continue;
        if (boxOn) {
          const dx = T[0] * x + T[4] * y + T[8] * z + T[12], dy = T[1] * x + T[5] * y + T[9] * z + T[13], dz = T[2] * x + T[6] * y + T[10] * z + T[14];
          const ins = dx >= bmin.x && dx <= bmax.x && dy >= bmin.y && dy <= bmax.y && dz >= bmin.z && dz <= bmax.z;
          if ((boxOn === 1 && !ins) || (boxOn === 2 && ins)) continue;
        }
        const depth = m[2] * x + m[6] * y + m[10] * z + m[14];
        cands.push({ nd, i, x, y, z, px: d, depth });
      }
    }
    // the front surface under the cursor, then the point on that surface nearest to the cursor
    let h = null;
    if (cands.length) {
      let dmin = Infinity;
      for (const c of cands) if (c.px <= front && c.depth < dmin) dmin = c.depth;
      if (dmin === Infinity) for (const c of cands) if (c.depth < dmin) dmin = c.depth;
      const tol = opt('pcPickDepthPx') * (vp.scale / 1000) * Math.hypot(m[2], m[6], m[10]); // ~12 px of depth (scan m) in clip units
      for (const c of cands) if (c.depth <= dmin + tol && (!h || c.px < h.px)) h = c;
    }
    if (!h) return null;
    const v = new THREE.Vector3(h.x, h.y, h.z).applyMatrix4(this.toDoc);
    return { layer: this, node: h.nd.name, i: h.i, doc: [v.x, v.y, v.z], px: h.px, depth: h.depth };
  }
  dropAll() { this.gen++; this.queue = []; for (const nd of this.nodes.values()) this.freeNode(nd); }
  dispose() { this.disposed = true; this.dropAll(); this.material.dispose(); this.group.parent?.remove(this.group); api.cloudClose(this.id); }
}
