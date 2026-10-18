// A dashed size in sketch i that only follows linked converted edges (On Edge): find the dimension in an earlier
// sketch that drives it (0.1.83). Per candidate: small change → rebuild the chain up to sketch i (relinkChain) →
// sensitivity → the value that gives `want` → check (one Newton correction if not linear). The smallest relative
// change wins (main sizes over small offsets). Pure (kernel access injected as getBase), also used by tests.
import { measure as measureDim, DIM_TYPES, solve as solveSketch } from '../sketch/solver.js';
import { relinkChain } from './linkgeom.js';
import { solveStepped } from './drive.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export function upstreamCandidates(features, i, max = 24) {
  const out = [];
  for (let j = i - 1; j >= 0 && out.length < max; j--) {
    const f = features[j];
    if (f.type !== 'sketch' || f.suppressed) continue;
    for (const c of f.cons || []) if (DIM_TYPES.has(c.type) && typeof c.value === 'number' && c.driving !== false && !c.driven) out.push({ j, id: c.id, old: c.value, sk: f.name, type: c.type });
  }
  return out;
}

// returns {j, id, old, value, sk, type, features (the whole feature list with the change applied)} or null
export async function driveChain(features, i, want, { getBase, solve = solveSketch, tolPct = 4, maxStep = 0.25, onProgress } = {}) {
  const tol = 1e-3 * Math.max(1, Math.abs(want.value));
  const link = { getBase, solve, tolPct, stopAt: i + 1 };
  const chain = async (fs) => { await relinkChain(fs, link); return measureDim(fs[i], want); };
  const cands = upstreamCandidates(features, i);
  if (!cands.length) return null;
  const base = clone(features);
  const S0 = await chain(base);
  const tryValue = async (c, v) => {
    const t = clone(base), s = t[c.j], cc = s.cons.find((x) => x.id === c.id);
    const r = solveStepped(s, cc, v, { maxStep, solve });
    if (!r || r.ok === false) return null;
    const S = await chain(t);
    return isFinite(S) ? { t, S } : null;
  };
  let best = null, n = 0;
  for (const c of cands) {
    onProgress?.(++n, cands.length);
    const d = Math.max(0.5, Math.abs(c.old) * 0.02);
    const a = await tryValue(c, c.old + d); if (!a) continue;
    let k = (a.S - S0) / d; if (Math.abs(k) < 1e-6) continue;
    let v = c.old + (want.value - S0) / k;
    if (!(v > 0) && c.old > 0) continue;
    let b = await tryValue(c, v); if (!b) continue;
    if (Math.abs(b.S - want.value) > tol && Math.abs(v - c.old) > 1e-9) { // not linear: one Newton step
      k = (b.S - S0) / (v - c.old); if (Math.abs(k) < 1e-6) continue;
      v = c.old + (want.value - S0) / k; if (!(v > 0) && c.old > 0) continue;
      b = await tryValue(c, v); if (!b) continue;
    }
    if (Math.abs(b.S - want.value) > tol) continue;
    const rel = Math.abs(v - c.old) / Math.max(Math.abs(c.old), 1e-9) + (c.type === want.type ? 0 : 1e-3);
    if (!best || rel < best.rel) best = { ...c, value: v, rel };
  }
  if (!best) return null;
  // final: rounded value (solver noise 158.00003 → 158) on the current features, chain rebuilt
  if (Math.abs(best.value - Math.round(best.value * 1000) / 1000) < 5e-4) best.value = Math.round(best.value * 1000) / 1000;
  const t = clone(features), s = t[best.j], cc = s.cons.find((x) => x.id === best.id);
  solveStepped(s, cc, best.value, { maxStep, solve });
  await relinkChain(t, link);
  best.features = t;
  best.size = measureDim(t[i], want);
  return best;
}
