// Kernel worker thread: owns the OpenCascade WebAssembly instance and
// executes geometry requests from the main process.
import { parentPort } from 'node:worker_threads';
import initOpenCascade from 'opencascade.js/dist/node.js';
import * as K from './occ.mjs';

const quiet = { print: () => {}, printErr: () => {} };
const ready = K.initKernel(() => initOpenCascade({ module: quiet }));

function meshTransfer(m) {
  const transfer = [m.positions.buffer, m.indices.buffer];
  for (const e of m.edges) transfer.push(e.pts.buffer);
  return transfer;
}

const ops = {
  regen({ features, upTo }) {
    const r = K.regenerate(features, { upTo });
    const mesh = K.tessellate(r.body);
    try { const own = K.faceOwners(r.stages, r.body); mesh.faces.forEach((f) => { f.feat = own[f.id]; }); } catch { /* ownership is optional */ }
    return { result: { status: r.status, mesh }, transfer: meshTransfer(mesh) };
  },
  mass({ features, upTo }) {
    const r = K.regenerate(features, { upTo });
    return { result: K.massProps(r.body) };
  },
  exportStep({ features, upTo }) { return { result: K.writeStep(K.regenerate(features, { upTo }).body) }; },
  exportIges({ features, upTo }) { return { result: K.writeIges(K.regenerate(features, { upTo }).body) }; },
  importCAD({ text, format }) { const r = K.importToStep(text, format); return { result: { step: r.step } }; },
  planModel({ entities }) {
    const body = K.buildPlanModel(entities);
    const mesh = K.tessellate(body, 0.5);
    return { result: mesh, transfer: meshTransfer(mesh) };
  },
  planStep({ entities }) { return { result: K.writeStep(K.buildPlanModel(entities)) }; },
  exportAssembly({ parts, format }) {
    const shape = K.assemblyShape(parts.map((p) => ({ body: K.regenerate(p.features, { upTo: p.upTo }).body, m: p.m })));
    return { result: format === 'iges' ? K.writeIges(shape) : K.writeStep(shape) };
  },
  ping() { return { result: 'pong' }; },
};

parentPort.on('message', async ({ id, op, args }) => {
  try {
    await ready;
    const fn = ops[op];
    if (!fn) throw new Error('Unknown kernel op ' + op);
    const { result, transfer } = fn(args || {});
    parentPort.postMessage({ id, result }, transfer || []);
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
ready.then(() => parentPort.postMessage({ ready: true })).catch((e) => parentPort.postMessage({ fatal: String(e) }));
