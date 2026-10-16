// Kernel worker thread: owns the OpenCascade WebAssembly instance and
// executes geometry requests from the main process.
import { parentPort } from 'node:worker_threads';
import initOpenCascade from 'opencascade.js/dist/node.js';
import * as K from './occ.mjs';
import { hlrView, sectionView } from './drawing.mjs';

const quiet = { print: () => {}, printErr: () => {} };
const ready = K.initKernel(() => initOpenCascade({ module: quiet }));

function meshTransfer(m) {
  const transfer = [m.positions.buffer, m.indices.buffer];
  for (const e of m.edges) transfer.push(e.pts.buffer);
  return transfer;
}

const isIdent = (m) => !m || m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
const ops = {
  regen({ features, upTo, ghost }) {
    const r = K.regenerate(features, { upTo });
    const mesh = K.tessellate(r.body);
    try { const own = K.faceOwners(r.stages, r.body); mesh.faces.forEach((f) => { f.feat = own[f.id]; }); } catch { /* ownership is optional */ }
    const transfer = meshTransfer(mesh);
    let g = null;
    if (ghost) {
      // feature preview: the body before the last feature + the last feature's tool (extruded / revolved profile)
      const last = features[features.length - 1], t = last && r.tools?.get(last.id);
      const prevBody = r.stages.filter((st) => st.id !== last?.id).pop()?.body || null;
      g = { id: last?.id, op: t?.op || null, prev: prevBody ? K.tessellate(prevBody) : null, tool: t ? K.tessellate(t.shape) : null };
      for (const m of [g.prev, g.tool]) if (m) transfer.push(...meshTransfer(m));
    }
    return { result: { status: r.status, mesh, ghost: g }, transfer };
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
  drawView({ parts, views }) {
    const bodies = parts.map((p) => ({ body: K.regenerate(p.features, { upTo: p.upTo }).body, m: p.m })).filter((b) => b.body);
    if (!bodies.length) throw new Error('Nothing to draw');
    const shape = bodies.length === 1 && isIdent(bodies[0].m) ? bodies[0].body : K.assemblyShape(bodies);
    return { result: views.map((v) => (v.plane ? sectionView(shape, v.plane, v.dir, v.xDir, !!v.hidden) : hlrView(shape, v.dir, v.xDir, !!v.hidden))) };
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
