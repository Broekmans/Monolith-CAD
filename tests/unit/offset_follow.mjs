// 0.1.94: offset of model edges follows the model. node tests/unit/offset_follow.mjs <part> <sketch> <dimId> <value> <offsetSketch>
// Changes one dimension, relinks the chain (as the app does on rebuild) and prints the extent of every offset chain.
import fs from 'node:fs';
import initOpenCascade from 'replicad-opencascadejs';
import * as K from '../../kernel/occ.mjs';
import { initSolver, solve } from '../../renderer/src/sketch/solver.js';
import { relinkChain } from '../../renderer/src/part/linkgeom.js';
import { solveStepped } from '../../renderer/src/part/drive.js';
await K.initKernel(() => initOpenCascade({ print() {}, printErr() {} }));
await initSolver();
const [file, skName, dimId, value, offName] = process.argv.slice(2);
const F = JSON.parse(fs.readFileSync(file, 'utf8')).features;
const getBase = async (features, i) => K.linkBase(features, i);
const ext = () => {
  const sk = F.find((f) => f.name === offName), G = (id) => sk.geo.find((g) => g.id === id);
  return sk.cons.filter((c) => c.type === 'offset').map((m) => {
    const xs = [], ys = [];
    for (const c of sk.cons.filter((k) => k.id === m.id || k.of === m.id)) { const g = G(c.a); for (const k of ['p1', 'p2', 's', 'e']) if (g[k]) { xs.push(G(g[k]).x); ys.push(G(g[k]).y); } }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => +v.toFixed(3));
  });
};
await relinkChain(F, { getBase, solve, auto: true });
console.log('before', JSON.stringify(ext()));
const sk = F.find((f) => f.name === skName), c = sk.cons.find((x) => x.id === dimId);
console.log(`${skName} ${dimId} ${c.value} → ${value}`, solveStepped(sk, c, +value).ok);
const r = await relinkChain(F, { getBase, solve });
const r2 = solve(F.find((f) => f.name === offName));
console.log('after ', JSON.stringify(ext()), 'changed', r.changed, 'solve', r2.ok, 'conflicting', JSON.stringify(r2.conflicting), 'redundant', JSON.stringify(r2.redundant));
const st = K.regenerate(F).status.filter((s) => s.state !== 'ok'); console.log('status not ok:', JSON.stringify(st));
