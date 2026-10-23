// File format versions of MonoLith documents (.lithprt/.lithasm/.lithpln/.lithdrw/.lithpcd) and the steps that
// upgrade an older file when it is opened. Pure module (no app imports; shared/motion.mjs is pure too): used by the renderer and by node tests.
//
// RULE when the way something is SAVED changes (a field renamed, moved, a different unit or meaning):
//   1. raise FORMAT[kind] by one,
//   2. add STEPS[kind][old] = (d) => { …change d in place… } that turns a file of version `old` into `old + 1`,
//   3. add a case to tests/unit/format.mjs (an old-version document in, the new form out).
// New OPTIONAL fields that old files simply do not have need no step (the code gives them a default).
import { toAbsolute } from './motion.mjs';

export const FORMAT = { part: 2, assembly: 3, plan: 1, drawing: 1, cloud: 1 };

// STEPS[kind][v](doc) upgrades a version-v document to version v+1 (in place)
const STEPS = {
  part: {
    // 1 → 2 (0.1.115): before 0.1.93 Convert Entities / model snaps left `refKey` on REAL sketch geometry. Since 0.1.93
    // refKey means "invisible reference to a model edge" (always construction) and is left out of profiles, so such an
    // old line vanished from the profile (Stonex-01-001-000: Sketch2 open contour). Real geometry loses the old key.
    1: (d) => { for (const f of d.features || []) if (f?.type === 'sketch') for (const g of f.geo || []) if (g.refKey && !g.construction && g.type !== 'point') delete g.refKey; }, // points: vertex references (0.1.93) are points with refKey
  },
  assembly: {
    // 1 → 2 (0.1.124): Motion Study steps started "after" / "with" the previous step (+ delay, 0.1.122); now every step
    // has its own start time (s). The times are worked out once, so the motion plays as before.
    1: (d) => { if (Array.isArray(d.motion?.steps)) d.motion.steps = toAbsolute(d.motion.steps); },
    // 2 → 3 (0.1.127): nothing to change — mates may now use origin planes (ref kind 'plane', comp '@asm' = the assembly
    // itself). Raised so that older versions warn "newer version" instead of failing on such mates.
    2: () => {},
  },
  plan: {}, drawing: {}, cloud: {},
};

// Bring a document up to the current format. Returns { doc, kind, from, to, upgraded, newer }.
// Files without a version count as version 1. A file from a newer MonoLith (version above FORMAT) is left as it is
// (newer: true) so the caller can warn that saving it here may drop what this version does not know.
export function upgradeDoc(doc) {
  const kind = doc?.kind || 'part';
  const cur = FORMAT[kind];
  const from = Number.isFinite(+doc?.version) && +doc.version >= 1 ? +doc.version : 1;
  if (!doc || !cur) return { doc, kind, from, to: from, upgraded: false, newer: false };
  if (from > cur) return { doc, kind, from, to: from, upgraded: false, newer: true };
  let v = from;
  for (; v < cur; v++) {
    const step = STEPS[kind][v];
    if (!step) throw new Error(`No upgrade step for ${kind} format ${v} → ${v + 1}`);
    step(doc);
  }
  doc.version = cur;
  return { doc, kind, from, to: cur, upgraded: from < cur, newer: false };
}

// for tests: the step table (read only use)
export const _steps = STEPS;
