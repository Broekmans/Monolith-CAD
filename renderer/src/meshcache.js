// Display cache stored inside .lithprt files: the finished mesh of the part,
// so assemblies can show it without rebuilding the feature history.
// Valid only while `key` matches the part's features + rollback (and CACHE_VER).
const CACHE_VER = 1;
export function cacheKey(features, upTo) {
  const s = JSON.stringify([CACHE_VER, features, upTo ?? null]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + s.length.toString(16);
}
const r4 = (a) => Array.from(a, (x) => Math.round(x * 1e4) / 1e4);
export function packMesh(m) {
  if (!m?.positions?.length) return null;
  return { positions: r4(m.positions), indices: Array.from(m.indices), faces: m.faces, edges: m.edges.map((e) => ({ ...e, pts: r4(e.pts) })), bbox: m.bbox };
}
export function unpackMesh(p) {
  return { positions: new Float32Array(p.positions), indices: new Uint32Array(p.indices), faces: p.faces, edges: p.edges.map((e) => ({ ...e, pts: new Float32Array(e.pts) })), bbox: p.bbox };
}
// mesh from a saved part document, or null when missing/out of date
export function cachedMesh(data) {
  const c = data?.cache;
  if (!c?.mesh || c.key !== cacheKey(data.features, data.rollback ?? undefined)) return null;
  try { return unpackMesh(c.mesh); } catch { return null; }
}
