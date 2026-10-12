// Eye-Dome Lighting: darkens points that lie behind their screen neighbours, so the shape of a scan
// reads clearly without normals. The scene is drawn into a texture (colour + depth), then shaded.
import * as THREE from 'three';

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 px;
uniform float strength;
uniform float radius;
uniform float depthToPx; // depth buffer units -> screen pixels
varying vec2 vUv;
void main() {
  float dc = texture2D(tDepth, vUv).x;
  if (dc >= 1.0) discard;
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 o = vec2(cos(a), sin(a)) * radius * px;
    float dn = texture2D(tDepth, vUv + o).x;
    if (dn < 1.0) sum += min(8.0, max(0.0, (dc - dn) * depthToPx / radius));
    else sum += 0.35;
  }
  float shade = exp(-sum * strength * 0.15);
  gl_FragColor = vec4(texture2D(tColor, vUv).rgb * shade, 1.0);
}`;

export class EDLPass {
  constructor() {
    this.rt = null;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2() }, strength: { value: 1 }, radius: { value: 1.4 }, depthToPx: { value: 1 } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene();
    this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  ensure(w, h) {
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    this.rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this.rt.depthTexture.minFilter = this.rt.depthTexture.magFilter = THREE.NearestFilter;
  }
  // vp: Viewport (orthographic camera; depth is linear between near and far)
  render(r, scene, vp, strength = 1) {
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.ensure(size.x, size.y);
    const cam = vp.camera, dpr = size.x / Math.max(1, vp.width);
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(null);
    const u = this.mat.uniforms;
    u.tColor.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture;
    u.px.value.set(1 / size.x, 1 / size.y);
    u.strength.value = strength;
    u.depthToPx.value = ((cam.far - cam.near) / vp.scale) * dpr; // 1 depth unit = (far-near) mm
    r.render(this.qscene, this.qcam);
  }
  dispose() { this.rt?.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
