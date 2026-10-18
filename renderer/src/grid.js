// Viewport grid (Part / Assembly): fine lines on the Top plane (the floor, XZ; parts are Y-up), or on the
// sketch plane while sketching (in Front / Right views the plane facing you). Spacing follows the zoom in 1-2-5 steps (minor ≈ 1/10 of the half view
// height, every 5th line heavier), drawn by one shader quad so it costs nothing; fades towards the view
// edges and when the plane is seen edge-on. Faces lying on the plane win (polygon offset).
import * as THREE from 'three';
import { opt } from './app/options.js';

// minor / major spacing for a view of the given half height (world units)
export function gridStep(half) {
  const raw = Math.max(half / 10, 1e-3), p = 10 ** Math.floor(Math.log10(raw)), r = raw / p;
  const minor = (r < 2 ? 1 : r < 5 ? 2 : 5) * p;
  return [minor, minor * 5];
}
export const GRID_COL = {
  light: { minor: 0xc4cad4, major: 0xaab2be, axes: [0xd88a8a, 0x86c08a, 0x8aa0d8] },
  dark: { minor: 0x3b414c, major: 0x4c5361, axes: [0x8a4a4a, 0x4a7a4e, 0x4a5e8a] },
};
const TOP = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0] }, FRONT = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] }, RIGHT = { o: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0] };

const VS = `varying vec2 vUv; uniform vec3 uO, uX, uY; uniform float uSize; uniform vec2 uC;
void main() { vUv = uC + position.xy * uSize; vec3 p = uO + uX * vUv.x + uY * vUv.y; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`;
const FS = `varying vec2 vUv; uniform float uMinor, uMajor, uFade, uR, uAMin, uAMaj; uniform vec2 uC; uniform vec3 uCMin, uCMaj, uCX, uCY;
float lineAt(vec2 c, float s, float w) { vec2 g = c / s; vec2 d = abs(fract(g - 0.5) - 0.5) / fwidth(g); return 1.0 - min(min(d.x, d.y) / w, 1.0); }
void main() {
  float mi = lineAt(vUv, uMinor, 1.0), ma = lineAt(vUv, uMajor, 1.1);
  vec2 aw = abs(vUv) / fwidth(vUv); float ax = 1.0 - min(aw.y / 1.3, 1.0), ay = 1.0 - min(aw.x / 1.3, 1.0);
  vec3 col = uCMin; float a = mi * uAMin;
  if (ma > 0.0) { col = mix(col, uCMaj, ma); a = max(a, ma * uAMaj); }
  if (ax > 0.0) { col = mix(col, uCX, ax); a = max(a, ax); }
  if (ay > 0.0) { col = mix(col, uCY, ay); a = max(a, ay); }
  float r = length(vUv - uC) / uR;
  a *= (1.0 - smoothstep(0.35, 1.0, r)) * uFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}`;

export class Grid {
  constructor() {
    const u = { uO: { value: new THREE.Vector3() }, uX: { value: new THREE.Vector3() }, uY: { value: new THREE.Vector3() }, uSize: { value: 1 }, uC: { value: new THREE.Vector2() },
      uMinor: { value: 10 }, uMajor: { value: 50 }, uAMin: { value: 0.6 }, uAMaj: { value: 0.85 }, uFade: { value: 1 }, uR: { value: 1 }, uCMin: { value: new THREE.Color() }, uCMaj: { value: new THREE.Color() }, uCX: { value: new THREE.Color() }, uCY: { value: new THREE.Color() } };
    this.mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8, extensions: { derivatives: true } });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false; this.mesh.raycast = () => {};
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.frame = null; // null = Top plane
    this.on = false;
  }
  // last spacing used (status / tests)
  get step() { return [this.mat.uniforms.uMinor.value, this.mat.uniforms.uMajor.value]; }
  render(r, vp) {
    if (!this.on) return;
    const U = this.mat.uniforms, cam = vp.camera;
    // no sketch plane: the Top plane (floor); seen (almost) edge-on (Front / Right views) the principal plane facing the view
    let f = this.frame || TOP;
    if (!this.frame) { const d = vp.viewDir(); if (Math.abs(d.y) < 0.3) f = Math.abs(d.z) >= Math.abs(d.x) ? FRONT : RIGHT; }
    const o = new THREE.Vector3(...f.o), X = new THREE.Vector3(...f.x), Y = new THREE.Vector3(...f.y), N = new THREE.Vector3().crossVectors(X, Y).normalize();
    const half = (vp.height / 2) * vp.scale, R = Math.hypot(vp.width, vp.height) / 2 * vp.scale * 1.05;
    const dir = vp.viewDir(), k = Math.abs(dir.dot(N));
    // where the view centre meets the plane (along the view direction; edge-on: the target's foot)
    const t = vp.target.clone(), rel = t.clone().sub(o), s = k > 0.05 ? -rel.dot(N) / dir.dot(N) : -rel.dot(N);
    const c = k > 0.05 ? t.addScaledVector(dir, s) : t.addScaledVector(N, s);
    const cl = c.sub(o), cu = cl.dot(X), cv = cl.dot(Y);
    // an oblique plane stretches on screen: the visible patch is longer by 1/k along the slope
    const reach = R / Math.max(k, 0.25);
    const [mi, ma] = gridStep(half);
    U.uO.value.copy(o); U.uX.value.copy(X); U.uY.value.copy(Y); U.uC.value.set(cu, cv); U.uSize.value = reach; U.uR.value = reach;
    U.uMinor.value = mi; U.uMajor.value = ma; U.uAMin.value = opt('gridMinor') / 100; U.uAMaj.value = opt('gridMajor') / 100; U.uFade.value = THREE.MathUtils.smoothstep(k, 0.04, 0.3);
    const C = GRID_COL[document.body.classList.contains('dark') ? 'dark' : 'light'];
    U.uCMin.value.setHex(C.minor); U.uCMaj.value.setHex(C.major); // axis lines in the colour of the world axis they run along (X red, Y green, Z blue)
    const ax = (v) => C.axes[[0, 1, 2].reduce((b, i) => (Math.abs(v[i]) > Math.abs(v[b]) ? i : b), 0)];
    U.uCX.value.setHex(ax(f.x)); U.uCY.value.setHex(ax(f.y));
    r.render(this.scene, cam);
  }
}
