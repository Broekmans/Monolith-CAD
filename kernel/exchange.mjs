// Kernel file exchange: STEP / IGES read & write, assembly export.
import { oc, PR, compoundOf } from './core.mjs';
import { tessellate } from './mesh.mjs';
import { igesToStep, stepToIges } from './iges.mjs';

// STEP text -> shape (IGES: convert with igesToStep first)
export function readStepText(text) {
  const path = `/in_${Date.now()}.stp`;
  oc.FS.writeFile(path, text);
  const reader = new oc.STEPControl_Reader();
  const st = reader.ReadFile(path);
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) { oc.FS.unlink(path); throw new Error('Could not read STEP file'); }
  reader.TransferRoots(PR());
  const shape = reader.OneShape();
  oc.FS.unlink(path);
  if (shape.IsNull()) throw new Error('File contains no shapes');
  return shape;
}

// ---------- exchange ----------
export function writeStep(shape) {
  if (!shape) throw new Error('Nothing to export');
  const w = new oc.STEPControl_Writer();
  const st = w.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, PR());
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP transfer failed');
  const path = '/out.step';
  w.Write(path);
  const txt = oc.FS.readFile(path, { encoding: 'utf8' });
  oc.FS.unlink(path);
  return txt;
}

// assembly: each part body placed with a 4x4 column-major matrix, written as one compound
export function assemblyShape(parts) {
  const shapes = [];
  for (const { body, m } of parts) {
    if (!body) continue;
    const t = new oc.gp_Trsf();
    t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
    shapes.push(new oc.BRepBuilderAPI_Transform(body, t, true).Shape());
  }
  if (!shapes.length) throw new Error('Nothing to export');
  return compoundOf(shapes);
}

export async function writeIges(shape) {
  if (!shape) throw new Error('Nothing to export');
  return stepToIges(writeStep(shape));
}

// Convert an IGES/STEP file into STEP text so it can be stored in a part.
export async function importToStep(text, format) {
  const step = format === 'iges' ? await igesToStep(text) : text;
  return { step, mesh: tessellate(readStepText(step)) };
}
