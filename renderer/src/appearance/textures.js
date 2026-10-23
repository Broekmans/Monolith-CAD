// Generated textures for the Realistic display style (0.1.110): brushed, wood, cast, knurl, grain. Each kind is a small
// tileable grey-value image made here (no image files), laid on the model "triplanar" in the shader: projected along
// the three part axes and blended by the face direction, so no texture coordinates are needed and any shape works.
// The grey value changes the colour a little, the roughness a little and bumps the surface (TEXTURES in library.js
// holds the amounts and the tile size per kind). Positions are the part's own (mm), so a moved component keeps its
// texture.
import * as THREE from 'three';
import { opt } from '../app/options.js';
import { TEXTURES } from './library.js';

// ---- tileable noise (period n cells) ----
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967295; }
function vnoise(u, v, n, s) { // value noise on a periodic n×n lattice, u, v in cells
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (a) => ((a % n) + n) % n;
  const a = hash(w(x0), w(y0), s), b = hash(w(x0 + 1), w(y0), s), c = hash(w(x0), w(y0 + 1), s), d = hash(w(x0 + 1), w(y0 + 1), s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(u, v, n, oct, s) { let r = 0, amp = 0.5, tot = 0; for (let o = 0; o < oct; o++) { r += amp * vnoise(u * 2 ** o, v * 2 ** o, n * 2 ** o, s + o); tot += amp; amp *= 0.5; } return r / tot; }

// grey value 0..1 at (x, y) in 0..1 of the tile, per kind
const KINDS = {
  // fine streaks along the tile's u direction: value changes across rows, slowly along them
  brushed: (x, y) => 0.65 * fbm(x * 2, y * 160, 2, 1, 11) + 0.35 * fbm(x * 8, y * 40, 8, 2, 12),
  // growth rings around an axis along u, wavy, with fine fibres
  wood: (x, y) => { const r = y * 14 + 0.9 * fbm(x * 2, y * 4, 2, 3, 21); const ring = Math.pow(0.5 + 0.5 * Math.sin(r * Math.PI * 2), 3); return 0.7 * ring + 0.3 * fbm(x * 4, y * 96, 4, 2, 22); },
  // sand-cast: blotches + small pits
  cast: (x, y) => { const b = fbm(x * 6, y * 6, 6, 4, 31); const p = fbm(x * 48, y * 48, 48, 1, 32); return 0.6 * b + 0.4 * (p > 0.72 ? 0 : p); },
  // diamond knurl: two crossing ridge sets
  knurl: (x, y) => { const a = Math.abs(Math.sin((x + y) * Math.PI * 8)), b = Math.abs(Math.sin((x - y) * Math.PI * 8)); return Math.min(a, b); },
  // fine even grain (galvanised, textured plastic)
  grain: (x, y) => fbm(x * 32, y * 32, 32, 3, 41),
};
export const TEXTURE_KINDS = Object.keys(KINDS);

const cache = new Map();
export function textureFor(kind) {
  if (!KINDS[kind]) return null;
  let t = cache.get(kind);
  if (t) return t;
  const n = opt('realTexPx'), data = new Uint8Array(n * n * 4), f = KINDS[kind];
  let lo = Infinity, hi = -Infinity; const g = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const v = f(i / n, j / n); g[j * n + i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let k = 0; k < n * n; k++) { const v = Math.round(((g[k] - lo) / Math.max(1e-9, hi - lo)) * 255); data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = v; data[k * 4 + 3] = 255; }
  t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  cache.set(kind, t);
  return t;
}

// Add the triplanar texture to a MeshStandard / MeshPhysical material. a = resolved appearance (a.tex, a.texScale).
export function addTexture(mat, a) {
  const T = TEXTURES[a.tex], tex = T && textureFor(a.tex);
  if (!tex) return;
  const u = { uTriTex: { value: tex }, uTriTile: { value: T.tile * (a.texScale ?? 1) }, uTriAmt: { value: new THREE.Vector3(T.color, T.rough, T.bump * opt('realTexBump')) } };
  mat.userData.tex = a.tex;
  mat.customProgramCacheKey = () => 'tri';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vTriP;\nvarying vec3 vTriN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vTriP = position; vTriN = normal;');
    sh.fragmentShader = `uniform sampler2D uTriTex; uniform float uTriTile; uniform vec3 uTriAmt;
varying vec3 vTriP; varying vec3 vTriN;
float triH() {
  vec3 w = pow(abs(normalize(vTriN)), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec3 p = vTriP / uTriTile;
  return texture2D(uTriTex, p.zy).r * w.x + texture2D(uTriTex, p.xz).r * w.y + texture2D(uTriTex, p.xy).r * w.z;
}
vec3 triPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float fd) {
  vec3 vSigmaX = normalize(dFdx(surf_pos)); vec3 vSigmaY = normalize(dFdy(surf_pos)); vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN); vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * fd;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
` + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n float triV = triH();\n diffuseColor.rgb *= 1.0 + (triV - 0.5) * 2.0 * uTriAmt.x;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + (triV - 0.5) * 2.0 * uTriAmt.y, 0.02, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = triPerturb(-vViewPosition, normal, vec2(dFdx(triV), dFdy(triV)) * uTriAmt.z, faceDirection);');
  };
}
