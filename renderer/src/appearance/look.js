// Appearances on screen (0.1.106). A body mesh (part body, assembly component) carries userData.look = { key,
// shaded, real }: two materials made from the resolved appearance. displaystyle.js applyDisplay picks one per view
// (Shaded / Shaded With Edges = the colour only, Realistic = reflections, clear coat, opacity), paneLook sets the
// view itself (tone mapping, studio background, reflection map of that view's renderer, softer lamps).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { opt } from '../app/options.js';
import { appearanceByName } from './library.js';
import { addTexture } from './textures.js';

const hexNum = (c) => (typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16));
export const hexStr = (c) => '#' + hexNum(c).toString(16).padStart(6, '0');

// own = { name?, color?, roughness?, metalness?, opacity?, tex? ('none' = no texture), texScale? } (stored in the part / on the component), else the
// material's appearance (matName), else `fallback` ({ color, metalness, roughness }: today's plain look).
export function resolveAppearance(own, matName, fallback) {
  const base = appearanceByName(own?.name) || appearanceByName(matName);
  const r = base ? { ...base } : { name: '', cat: '', color: hexStr(fallback.color), metalness: fallback.metalness, roughness: fallback.roughness, plain: true };
  if (own) for (const k of ['color', 'roughness', 'metalness', 'opacity', 'tex', 'texScale']) if (own[k] != null) { r[k] = own[k]; r.plain = false; }
  if (r.tex === 'none') delete r.tex;
  r.color = hexStr(r.color);
  return r;
}
// where the appearance comes from, for the popup ('Material: Brass', 'Part', 'Default colour' …)
export function appearanceSource(own, matName) {
  if (own?.name || own?.color) return 'own';
  return appearanceByName(matName) ? 'material' : 'default';
}

const COMMON = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
function makeMaterials(a) {
  const op = a.opacity ?? 1, see = op < 1;
  const tr = see ? { transparent: true, opacity: op, depthWrite: false } : {};
  // Shaded styles: only the colour (without a reflection map, metal would look black); plain = exactly today's look
  const shaded = new THREE.MeshStandardMaterial({ color: hexNum(a.color), metalness: a.plain ? a.metalness : opt('modelMetalness'), roughness: a.plain ? a.roughness : opt('modelRoughness'), ...COMMON, ...tr });
  const real = new THREE.MeshPhysicalMaterial({
    color: hexNum(a.color), metalness: a.metalness, roughness: a.roughness, clearcoat: a.clearcoat || 0,
    clearcoatRoughness: opt('realClearcoatRough'), envMapIntensity: opt('realEnvStrength'), ...COMMON, ...tr,
  });
  if (a.tex && opt('realTextures')) addTexture(real, a); // generated texture, Realistic only (textures.js)
  return { shaded, real };
}
// (re)build the two materials when the appearance or a setting they use changed; cheap when nothing changed
export function ensureLook(mesh, a) {
  if (!mesh) return;
  const key = JSON.stringify(a) + '|' + opt('modelMetalness') + '|' + opt('modelRoughness') + '|' + opt('realEnvStrength') + '|' + opt('realClearcoatRough') + '|' + opt('realTextures') + '|' + opt('realTexBump');
  const L = mesh.userData.look;
  if (L && L.key === key) return;
  const vis = mesh.material?.visible ?? true;
  if (L) { L.shaded.dispose(); L.real.dispose(); }
  mesh.userData.look = { key, ...makeMaterials(a) };
  mesh.material = mesh.userData.look.shaded; mesh.material.visible = vis;
}

// reflection map: one per WebGL renderer (the first view and the shared offscreen one of extra views)
const envs = new WeakMap();
export function envFor(r) {
  let t = envs.get(r);
  if (!t) {
    const pm = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    t = pm.fromScene(room, opt('realEnvBlur')).texture;
    pm.dispose(); room.traverse?.((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    envs.set(r, t);
  }
  return t;
}

// before a view (pane) draws: its look for display style `mode`; meshes = body meshes in the scene
export function paneLook(p, mode, meshes) {
  const real = mode === 'realistic';
  p._toneMap = real ? THREE.NeutralToneMapping : THREE.NoToneMapping;
  p._toneExp = real ? opt('realExposure') : 1;
  const dk = opt('dark') ? 'Dark' : ''; // 0.1.114: own studio colours in dark mode
  const bg = real && opt('realBackground') ? `linear-gradient(to bottom, ${opt('realBgTop' + dk)}, ${opt('realBgBottom' + dk)})` : '';
  if (p.el && p.el.style.background !== bg) p.el.style.background = bg;
  // lamps: shared by all views of the document; softer in Realistic (the reflection map lights the model too)
  const k = real ? opt('realLamps') / 100 : 1;
  p.scene?.traverse((o) => { if (o.isLight) { o.userData.baseI ??= o.intensity; o.intensity = o.userData.baseI * k; } });
  if (!real) return;
  const env = envFor(p.renderer);
  for (const m of meshes) {
    const r = m?.userData.look?.real;
    if (r && r.envMap !== env) { const first = !r.envMap; r.envMap = env; if (first) r.needsUpdate = true; }
  }
}
