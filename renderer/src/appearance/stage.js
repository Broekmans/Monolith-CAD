// Realistic display style, the "stage" under the model (0.1.110): a soft ground shadow and an optional floor
// reflection. Both lie on the ground = the lowest point of the model (the part's / assembly's Y is up).
// The shadow is worked out once per model change on the CPU (no GPU pass, so it works in every view's renderer):
// the model's triangles are laid flat on the ground, each spot keeps its lowest height, the darkness falls off with
// that height (contact shadow) and is blurred. The reflection = the model mirrored in the ground, faint, fading out
// with the distance below the ground. Only shown in views with the Realistic style (show()).
import * as THREE from 'three';
import { opt } from '../app/options.js';

const noPick = () => {};
export class Stage {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.name = 'stage'; this.group.userData.noPivot = true; this.group.userData.disp = 'stage';
    scene.add(this.group);
    this.key = ''; this.shadow = null; this.mirror = new THREE.Group(); this.group.add(this.mirror);
  }
  // meshes: body meshes (any transform). Rebuilds only when the model, its placement or a stage setting changed.
  sync(meshes) {
    const list = meshes.filter((m) => m?.geometry?.attributes?.position && m.visible !== false && m.parent?.visible !== false);
    for (const m of list) m.updateWorldMatrix(true, false);
    const key = list.map((m) => m.geometry.uuid + ':' + m.matrixWorld.elements.map((v) => Math.round(v * 1000)).join(',') + ':' + (m.userData.look?.key || '')).join('|')
      + `|${opt('realShadow')}|${opt('realShadowPct')}|${opt('realShadowSpread')}|${opt('realReflect')}|${opt('realReflectPct')}|${opt('realShadowPx')}`;
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (!list.length) return;
    const box = new THREE.Box3();
    for (const m of list) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
    if (box.isEmpty()) return;
    if (opt('realShadow')) this.makeShadow(list, box);
    if (opt('realReflect')) this.makeMirror(list, box);
  }
  clear() {
    if (this.shadow) { this.group.remove(this.shadow); this.shadow.geometry.dispose(); this.shadow.material.map?.dispose(); this.shadow.material.dispose(); this.shadow = null; }
    for (const o of [...this.mirror.children]) { this.mirror.remove(o); o.material.dispose(); }
  }
  show(on) { this.group.visible = !!on; }

  makeShadow(list, box) {
    const size = box.getSize(new THREE.Vector3()), big = Math.max(size.x, size.z, 1e-6);
    const spread = opt('realShadowSpread') / 100; // 0.1.114: wide soft layer, so flat parts also show a shadow past their edges
    const margin = big * Math.max(opt('realShadowMargin'), spread * 2.5), x0 = box.min.x - margin, z0 = box.min.z - margin;
    const w = size.x + 2 * margin, d = size.z + 2 * margin, n = opt('realShadowPx');
    const nx = Math.max(8, Math.round(n * Math.min(1, w / d))), nz = Math.max(8, Math.round(n * Math.min(1, d / w)));
    const ground = box.min.y, fade = Math.max(size.y * opt('realShadowFade'), big * 0.02);
    const wideFade = Math.max(size.y * opt('realShadowWideFade'), big * 0.25);
    // lowest height above the ground per cell (Infinity = nothing above it)
    const hmin = new Float32Array(nx * nz).fill(Infinity);
    const p = new THREE.Vector3(), A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    const cx = (x) => ((x - x0) / w) * nx - 0.5, cz = (z) => ((z - z0) / d) * nz - 0.5;
    for (const m of list) {
      const pos = m.geometry.attributes.position, idx = m.geometry.index, cnt = idx ? idx.count : pos.count;
      const get = (i, o) => { p.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld); o[0] = cx(p.x); o[1] = cz(p.z); o[2] = p.y - ground; };
      for (let t = 0; t + 2 < cnt; t += 3) {
        get(t, A); get(t + 1, B); get(t + 2, C);
        const ix0 = Math.max(0, Math.ceil(Math.min(A[0], B[0], C[0]))), ix1 = Math.min(nx - 1, Math.floor(Math.max(A[0], B[0], C[0])));
        const iz0 = Math.max(0, Math.ceil(Math.min(A[1], B[1], C[1]))), iz1 = Math.min(nz - 1, Math.floor(Math.max(A[1], B[1], C[1])));
        if (ix0 > ix1 || iz0 > iz1) { // smaller than a cell: mark the cell it is in
          const i = Math.round((A[0] + B[0] + C[0]) / 3), k = Math.round((A[1] + B[1] + C[1]) / 3);
          if (i >= 0 && i < nx && k >= 0 && k < nz) { const hh = Math.min(A[2], B[2], C[2]); if (hh < hmin[k * nx + i]) hmin[k * nx + i] = hh; }
          continue;
        }
        const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
        if (Math.abs(den) < 1e-12) { const hh = Math.min(A[2], B[2], C[2]); for (let k = iz0; k <= iz1; k++) for (let i = ix0; i <= ix1; i++) if (hh < hmin[k * nx + i]) hmin[k * nx + i] = hh; continue; }
        for (let k = iz0; k <= iz1; k++) for (let i = ix0; i <= ix1; i++) {
          const l1 = ((B[1] - C[1]) * (i - C[0]) + (C[0] - B[0]) * (k - C[1])) / den, l2 = ((C[1] - A[1]) * (i - C[0]) + (A[0] - C[0]) * (k - C[1])) / den, l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const hh = l1 * A[2] + l2 * B[2] + l3 * C[2];
          if (hh < hmin[k * nx + i]) hmin[k * nx + i] = hh;
        }
      }
    }
    // darkness from the height, then blurred (3 box passes ≈ Gaussian): a tight contact layer + a wide soft layer
    const layer = (f, r) => {
      let a = new Float32Array(nx * nz);
      for (let k = 0; k < a.length; k++) a[k] = hmin[k] === Infinity ? 0 : Math.max(0, 1 - Math.max(0, hmin[k]) / f);
      for (let pass = 0; pass < 3; pass++) a = boxBlur(boxBlur(a, nx, nz, r, true), nx, nz, r, false);
      return a;
    };
    const a = layer(fade, Math.max(1, Math.round(Math.max(nx, nz) * opt('realShadowBlur'))));
    const rw = Math.round((spread * big * nx) / w), b = rw >= 1 ? layer(wideFade, rw) : null;
    if (b) { let mx = 0; for (const v of b) if (v > mx) mx = v; if (mx > 1e-6) for (let k = 0; k < b.length; k++) b[k] /= mx; } // thin parts (a standing plate) stay as dark as wide ones
    const strength = opt('realShadowPct') / 100, wide = strength * opt('realShadowWide'), data = new Uint8Array(nx * nz * 4);
    for (let k = 0; k < a.length; k++) data[k * 4 + 3] = Math.round(Math.min(1, 1 - (1 - Math.min(1, a[k] * strength)) * (1 - (b ? Math.min(1, b[k] * wide) : 0))) * 255);
    const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: 0x000000, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    const geo = new THREE.PlaneGeometry(w, d); geo.rotateX(Math.PI / 2); // in XZ; texture v runs along +Z
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x0 + w / 2, ground - big * opt('realShadowGap'), z0 + d / 2);
    mesh.raycast = noPick; mesh.renderOrder = -1; mesh.name = 'groundShadow';
    this.shadow = mesh; this.group.add(mesh);
  }

  makeMirror(list, box) {
    const ground = box.min.y, fade = Math.max(box.getSize(new THREE.Vector3()).y * opt('realReflectFade'), 1e-6);
    const flip = new THREE.Matrix4().makeTranslation(0, ground, 0).multiply(new THREE.Matrix4().makeScale(1, -1, 1)).multiply(new THREE.Matrix4().makeTranslation(0, -ground, 0));
    for (const m of list) {
      const src = m.userData.look?.real || m.material;
      const mat = src.clone();
      mat.transparent = true; mat.depthWrite = false; mat.opacity = (src.opacity ?? 1) * opt('realReflectPct') / 100;
      const prev = src.onBeforeCompile; // keep a texture patch (textures.js), then fade with the depth below the ground
      mat.customProgramCacheKey = () => 'mirror' + (src.customProgramCacheKey?.() || '');
      mat.onBeforeCompile = (sh, r) => {
        if (prev && src.userData?.tex) prev.call(mat, sh, r);
        sh.uniforms.uGround = { value: ground }; sh.uniforms.uFade = { value: fade };
        sh.vertexShader = 'varying float vMirY;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vMirY = (modelMatrix * vec4(transformed, 1.0)).y;');
        sh.fragmentShader = 'uniform float uGround; uniform float uFade; varying float vMirY;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n gl_FragColor.a *= clamp(1.0 - (uGround - vMirY) / uFade, 0.0, 1.0);');
      };
      const c = new THREE.Mesh(m.geometry, mat);
      c.matrixAutoUpdate = false; c.matrix.copy(flip).multiply(m.matrixWorld);
      c.raycast = noPick; c.name = 'floorReflection';
      this.mirror.add(c);
    }
  }
  // envMap of the reflection materials follows the view (paneLook sets it on the model's real materials)
  setEnv(env) { for (const o of this.mirror.children) if (o.material.envMap !== env) { const first = !o.material.envMap; o.material.envMap = env; if (first) o.material.needsUpdate = true; } }
  dispose() { this.clear(); this.group.parent?.remove(this.group); }
}

function boxBlur(src, nx, nz, r, horiz) {
  const out = new Float32Array(src.length), n = horiz ? nx : nz, m = horiz ? nz : nx;
  const at = (line, i) => (horiz ? line * nx + i : i * nx + line);
  for (let line = 0; line < m; line++) {
    let sum = 0; const win = 2 * r + 1;
    for (let i = -r; i <= r; i++) sum += src[at(line, Math.min(n - 1, Math.max(0, i)))] * (i < 0 || i >= n ? 0 : 1);
    for (let i = 0; i < n; i++) {
      out[at(line, i)] = sum / win;
      const add = i + r + 1, rem = i - r;
      if (add < n) sum += src[at(line, add)];
      if (rem >= 0) sum -= src[at(line, rem)];
    }
  }
  return out;
}
