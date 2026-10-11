import { Worker } from 'node:worker_threads';
const w = new Worker(new URL('../kernel/pointcloud.mjs', import.meta.url));
let id = 0; const pend = new Map();
w.on('message', (m) => { if (m.progress !== undefined) return; const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); });
const call = (op, args) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); w.postMessage({ id: i, op, args }); });
for (const f of ['room.laz', 'room.las', 'room.ply', 'room.xyz']) {
  const p = 'scratch/pc/' + f;
  let t = Date.now();
  const info = await call('info', { path: p });
  console.log(f, info.format, info.count, info.min.map(v=>v.toFixed(2)).join(','), info.hasColor, Date.now() - t + 'ms');
  t = Date.now();
  const r = await call('load', { path: p, maxPoints: 500000, shift: info.min.map(Math.floor), scale: 1000 });
  console.log('  kept', r.kept, 'bbox', r.bboxMin.map(v=>v.toFixed(0)).join(','), '..', r.bboxMax.map(v=>v.toFixed(0)).join(','), 'color0', r.colors ? [...r.colors.slice(0,3)] : null, Date.now() - t + 'ms');
}
w.terminate();
