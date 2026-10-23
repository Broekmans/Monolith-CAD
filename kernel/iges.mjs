// IGES read / write (0.1.109). The kernel build used since 0.1.109 has no IGES classes, so IGES goes through the older
// OpenCascade build, loaded only when an IGES file is opened or saved. Shapes never cross between the two builds:
// they are exchanged as STEP text.
let old = null;
async function oldOc() {
  if (!old) {
    const init = (await import('opencascade.js/dist/node.js')).default;
    old = await init({ module: { print() {}, printErr() {} } });
  }
  return old;
}
const PRo = (oc) => new oc.Message_ProgressRange_1();
const readText = (oc, path) => { const t = oc.FS.readFile(path, { encoding: 'utf8' }); oc.FS.unlink(path); return t; };

export async function igesToStep(text) {
  const oc = await oldOc();
  const inp = `/in_${Date.now()}.igs`;
  oc.FS.writeFile(inp, text);
  const r = new oc.IGESControl_Reader_1();
  const st = r.ReadFile(inp);
  oc.FS.unlink(inp);
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('Could not read IGES file');
  r.TransferRoots(PRo(oc));
  const shape = r.OneShape();
  if (shape.IsNull()) throw new Error('File contains no shapes');
  const w = new oc.STEPControl_Writer_1();
  if (w.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, PRo(oc)) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP transfer failed');
  w.Write('/iges.step');
  return readText(oc, '/iges.step');
}

export async function stepToIges(stepText) {
  const oc = await oldOc();
  oc.FS.writeFile('/in.step', stepText);
  const r = new oc.STEPControl_Reader_1();
  const st = r.ReadFile('/in.step');
  oc.FS.unlink('/in.step');
  if (st !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('IGES export failed');
  r.TransferRoots(PRo(oc));
  const w = new oc.IGESControl_Writer_2('MM', 1); // 1 = B-rep (solid) mode
  w.AddShape(r.OneShape(), PRo(oc));
  w.ComputeModel();
  w.Write_2('/out.igs', false);
  return readText(oc, '/out.igs');
}
