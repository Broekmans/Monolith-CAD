// Kernel worker thread: owns the OpenCascade WebAssembly instance and
// executes geometry requests from the main process.
import { parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import * as K from './occ.mjs';
import { hlrView, sectionView } from './drawing.mjs';
import { factoryOf } from '../renderer/src/app/options/index.js';

// OCCT build with native WebAssembly exceptions (0.1.109; IGES: kernel/iges.mjs). 0.1.111: workerData.multi = the
// multi-thread build (booleans and meshing over all CPU cores); when it cannot start, the single-thread build is used.
const quiet = { print: () => {}, printErr: () => {} };
const info = { mode: 'single', cores: os.cpus().length };
const ready = (async () => {
  if (workerData?.multi) {
    try {
      // the build starts navigator.hardwareConcurrency threads up front; Electron's Node has no navigator
      const n = Math.max(2, Math.min(info.cores, factoryOf('kernelThreadsMax')));
      if (!globalThis.navigator) globalThis.navigator = { hardwareConcurrency: n };
      info.threads = globalThis.navigator.hardwareConcurrency;
      const init = (await import('replicad-opencascadejs/multi')).default;
      await K.initKernel(() => init(quiet), { parallel: true });
      info.mode = 'multi';
      return;
    } catch (e) { info.fallback = String(e?.message || e); }
  }
  const init = (await import('replicad-opencascadejs')).default;
  await K.initKernel(() => init(quiet), { parallel: false });
})();

function meshTransfer(m) {
  const transfer = [m.positions.buffer, m.indices.buffer];
  for (const e of m.edges) transfer.push(e.pts.buffer);
  return transfer;
}

const isIdent = (m) => !m || m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
const ops = {
  regen({ features, upTo, ghost }) {
    const t0 = performance.now();
    const r = K.regenerate(features, { upTo });
    const tRebuild = performance.now() - t0;
    const mesh = K.tessellate(r.body);
    try { const own = K.faceOwners(r.stages, r.body); mesh.faces.forEach((f) => { f.feat = own[f.id]; }); } catch { /* ownership is optional */ }
    const transfer = meshTransfer(mesh);
    let g = null;
    if (ghost) {
      // feature preview: the body before the last feature + the last feature's tool (extruded / revolved profile)
      const last = features[features.length - 1], t = last && r.tools?.get(last.id);
      const prevBody = r.stages.filter((st) => st.id !== last?.id).pop()?.body || null;
      // cut: show only the volume that is removed (the tool of Through All reaches far outside the part)
      let toolShape = t?.shape || null;
      if (t?.op === 'cut' && prevBody && toolShape) { try { toolShape = K.removedVolume(prevBody, toolShape); } catch { /* keep the tool */ } }
      g = { id: last?.id, op: t?.op || null, prev: prevBody ? K.tessellate(prevBody) : null, tool: toolShape ? K.tessellate(toolShape) : null };
      for (const m of [g.prev, g.tool]) if (m) transfer.push(...meshTransfer(m));
    }
    return { result: { status: r.status, mesh, ghost: g, ms: { rebuild: Math.round(tRebuild), total: Math.round(performance.now() - t0) } }, transfer };
  },
  mass({ features, upTo }) {
    const r = K.regenerate(features, { upTo });
    return { result: K.massProps(r.body) };
  },
  exportStep({ features, upTo }) { return { result: K.writeStep(K.regenerate(features, { upTo }).body) }; },
  async exportIges({ features, upTo }) { return { result: await K.writeIges(K.regenerate(features, { upTo }).body) }; },
  async importCAD({ text, format }) { const r = await K.importToStep(text, format); return { result: { step: r.step } }; },
  planModel({ entities }) {
    const body = K.buildPlanModel(entities);
    const mesh = K.tessellate(body, 0.5);
    return { result: mesh, transfer: meshTransfer(mesh) };
  },
  planStep({ entities }) { return { result: K.writeStep(K.buildPlanModel(entities)) }; },
  async exportAssembly({ parts, format }) {
    const shape = K.assemblyShape(parts.map((p) => ({ body: K.regenerate(p.features, { upTo: p.upTo }).body, m: p.m })));
    return { result: format === 'iges' ? await K.writeIges(shape) : K.writeStep(shape) };
  },
  drawView({ parts, views }) {
    const bodies = parts.map((p) => ({ body: K.regenerate(p.features, { upTo: p.upTo }).body, m: p.m })).filter((b) => b.body);
    if (!bodies.length) throw new Error('Nothing to draw');
    const shape = bodies.length === 1 && isIdent(bodies[0].m) ? bodies[0].body : K.assemblyShape(bodies);
    return { result: views.map((v) => (v.plane ? sectionView(shape, v.plane, v.dir, v.xDir, !!v.hidden) : hlrView(shape, v.dir, v.xDir, !!v.hidden))) };
  },
  linkBase({ features, index }) { return { result: K.linkBase(features, index) }; },
  ping() { return { result: 'pong' }; },
  info() { return { result: info }; },
};

parentPort.on('message', async ({ id, op, args }) => {
  try {
    await ready;
    const fn = ops[op];
    if (!fn) throw new Error('Unknown kernel op ' + op);
    const { result, transfer } = await fn(args || {});
    parentPort.postMessage({ id, result }, transfer || []);
  } catch (e) {
    parentPort.postMessage({ id, error: K.errText(e) });
  }
});
ready.then(() => parentPort.postMessage({ ready: true, info })).catch((e) => parentPort.postMessage({ fatal: String(e) }));
