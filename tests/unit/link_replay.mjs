// 0.1.83: linked Convert Entities on a real part. Usage: node tests/unit/link_replay.mjs <part.lithprt> [sketchName dimId value]
// Links fixed converted geometry (autoLink), then optionally changes one dimension and rebuilds the chain; prints the
// linked sketches' geometry and the body's bounding box.
// node tests/unit/link_replay.mjs <part> drive Sketch2 158 168 = set Sketch2's dashed size 158 to 168: finds the
// dimension in an earlier sketch that drives it (driveChain).
import fs from 'node:fs';
import initOpenCascade from 'opencascade.js/dist/node.js';
import * as K from '../../kernel/occ.mjs';
import { initSolver, solve } from '../../renderer/src/sketch/solver.js';
import { relinkChain } from '../../renderer/src/part/linkgeom.js';
import { solveStepped, autoDims } from '../../renderer/src/part/drive.js';
import { driveChain } from '../../renderer/src/part/drivechain.js';
await K.initKernel(() => initOpenCascade({ module: { print() {}, printErr() {} } }));
await initSolver();
const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const F = doc.features;
const getBase = async (features, i) => K.linkBase(features, i);
const bb = () => { const b = K.bbox(K.regenerate(F).body); return b.min.map((v, k) => +(b.max[k] - v).toFixed(3)); };
const t0 = Date.now();
const r0 = await relinkChain(F, { getBase, solve, auto: true });
console.log('auto-linked:', JSON.stringify(r0.linkedNow), 'warn:', [...r0.warn], `${Date.now() - t0} ms`, 'bbox', bb());
const show = () => { for (const f of F.filter((x) => x.type === 'sketch')) { const G = new Map(f.geo.map((g) => [g.id, g])); const L = f.geo.filter((g) => g.onEdge).map((g) => g.type === 'line' ? `${g.id}(${[G.get(g.p1), G.get(g.p2)].map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' → ')})` : g.type === 'point' ? `${g.id}(${g.x.toFixed(2)},${g.y.toFixed(2)})` : `${g.id} r${g.r.toFixed(2)}`); if (L.length) console.log(' ', f.name, L.join('  ')); } };
show();
if (process.argv[3] === 'drive') {
  const i = F.findIndex((f) => f.name === process.argv[4]);
  const d = autoDims(F[i]).find((x) => Math.abs(x.value - +process.argv[5]) < 1e-3);
  const want = { ...d.cons, value: +process.argv[6] };
  const t1 = Date.now();
  const best = await driveChain(F, i, want, { getBase, solve });
  console.log(best ? `${best.sk} ${best.id} ${best.type} ${best.old} → ${best.value}; size now ${best.size.toFixed(3)}` : 'no driving dimension found', `${Date.now() - t1} ms`);
  if (best) { F.splice(0, F.length, ...best.features); console.log('bbox', bb()); show(); }
} else if (process.argv[3]) {
  const sk = F.find((f) => f.name === process.argv[3]), c = sk.cons.find((x) => x.id === process.argv[4]);
  console.log(`${sk.name} ${c.id} ${c.value} → ${process.argv[5]}`);
  console.log('solve', solveStepped(sk, c, +process.argv[5]).ok);
  const t1 = Date.now();
  const r = await relinkChain(F, { getBase, solve });
  console.log('changed', r.changed, 'warn', [...r.warn], `${Date.now() - t1} ms`, 'bbox', bb());
  show();
  const st = K.regenerate(F).status.filter((s) => s.state !== 'ok'); console.log('status not ok:', JSON.stringify(st));
}
