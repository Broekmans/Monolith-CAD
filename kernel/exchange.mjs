// Kernel file exchange: STEP / IGES read & write, assembly export.
import { oc, PR } from './core.mjs';
import { tessellate } from './mesh.mjs';

export function readStepText(text, fmt = 'step') {
  const path = `/in_${Date.now()}.${fmt === 'iges' ? 'igs' : 'stp'}`;
  oc.FS.writeFile(path, text);
  const reader = fmt === 'iges' ? new oc.IGESControl_Reader_1() : new oc.STEPControl_Reader_1();
  const st = reader.ReadFile(path);
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`Could not read ${fmt.toUpperCase()} file`);
  reader.TransferRoots(PR());
  const shape = reader.OneShape();
  oc.FS.unlink(path);
  if (shape.IsNull()) throw new Error('File contains no shapes');
  return shape;
}

// ---------- exchange ----------
export function writeStep(shape) {
  if (!shape) throw new Error('Nothing to export');
  const w = new oc.STEPControl_Writer_1();
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
  const builder = new oc.BRep_Builder();
  const comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  let n = 0;
  for (const { body, m } of parts) {
    if (!body) continue;
    const t = new oc.gp_Trsf_1();
    t.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
    builder.Add(comp, new oc.BRepBuilderAPI_Transform_2(body, t, true).Shape());
    n++;
  }
  if (!n) throw new Error('Nothing to export');
  return comp;
}

export function writeIges(shape) {
  if (!shape) throw new Error('Nothing to export');
  const w = new oc.IGESControl_Writer_2('MM', 1); // 1 = B-rep (solid) mode
  w.AddShape(shape, PR());
  w.ComputeModel();
  const path = '/out.igs';
  w.Write_2(path, false);
  const txt = oc.FS.readFile(path, { encoding: 'utf8' });
  oc.FS.unlink(path);
  return txt;
}

// Convert an IGES/STEP file into STEP text so it can be stored in a part.
export function importToStep(text, format) {
  const shape = readStepText(text, format);
  return { step: format === 'step' ? text : writeStep(shape), mesh: tessellate(shape) };
}
