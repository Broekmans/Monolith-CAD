// File format versions of MonoLith documents (.lithprt/.lithasm/.lithpln/.lithdrw/.lithpcd) and the steps that
// upgrade an older file when it is opened. Pure module (no app imports): used by the renderer and by node tests.
//
// RULE when the way something is SAVED changes (a field renamed, moved, a different unit or meaning):
//   1. raise FORMAT[kind] by one,
//   2. add STEPS[kind][old] = (d) => { …change d in place… } that turns a file of version `old` into `old + 1`,
//   3. add a case to tests/unit/format.mjs (an old-version document in, the new form out).
// New OPTIONAL fields that old files simply do not have need no step (the code gives them a default).
export const FORMAT = { part: 1, assembly: 1, plan: 1, drawing: 1, cloud: 1 };

// STEPS[kind][v](doc) upgrades a version-v document to version v+1 (in place)
const STEPS = { part: {}, assembly: {}, plan: {}, drawing: {}, cloud: {} };

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
