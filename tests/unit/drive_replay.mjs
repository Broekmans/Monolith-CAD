// Every dashed (auto) size of every sketch in a .lithprt changed: shows which existing dimension drives it
// (driveSize in part/drive.js) or why it cannot. Usage: node tests/unit/drive_replay.mjs <part.lithprt> [add=5 | =700]
// "=700" sets every size to 700 (big jump, 0.1.83: walked in steps), otherwise each size + add.
import fs from 'node:fs';
import * as S from '../../renderer/src/sketch/solver.js';
import { driveSize, autoDims } from '../../renderer/src/part/drive.js';
await S.initSolver();
const arg = process.argv[3] || '5', abs = arg.startsWith('='), num = parseFloat(abs ? arg.slice(1) : arg);
const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const sk of doc.features.filter((f) => f.type === 'sketch')) {
  const s0 = JSON.parse(JSON.stringify(sk)); S.solve(s0);
  for (const d of autoDims(s0)) {
    const t = JSON.parse(JSON.stringify(s0));
    const want = { ...d.cons, value: abs ? num : d.value + num };
    t.cons.push({ id: 'cNEW', ...want }); const r = S.solve(t); t.cons.pop(); S.solve(t);
    const t0 = Date.now(); const dr = driveSize(t, want, r);
    console.log(sk.name, d.text, '→', want.value.toFixed(2), dr.cons ? `drives ${dr.cons.id} ${dr.cons.type} ${dr.old} → ${dr.value}; size now ${S.measure(t, want).toFixed(3)}` : dr.reason.slice(0, 60), `${Date.now() - t0} ms`);
  }
}
