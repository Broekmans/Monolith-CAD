// Edit in Context (0.1.130): a part tab opened from an assembly shows the other components around it — transparent,
// in their places relative to the edited component — plus a bar "Editing <comp> in <assembly>" with Context on/off and
// Return to Assembly (asks to save; the assembly then reloads the part, re-matches and solves its mates).
// ctx = { asm (AssemblyDoc), comp (component), items [{geom, egeom, m (16, part-local)}], openedHere }.
import * as THREE from 'three';
import { h, dialog, toast } from '../ui.js';
import { opt, optHex } from '../app/options.js';

import * as M from '../../../shared/mates.mjs';

const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* optional */ } };

// 0.1.133: carry a view from one document to another whose coordinates are m4 × these (THREE.Matrix4): same viewing
// direction, centre and zoom, so the model stays where it was on the screen (Edit Part / Return to Assembly).
// fromRect: where the source view was on the screen (it may be hidden by now); the target is shifted so the model stays
// on the same screen pixels even when the two views sit a little differently (other ribbon height).
export const viewRect = (doc) => (doc?.viewSet?.active || doc?.vp)?.el?.getBoundingClientRect?.();
export function carryView(fromDoc, toDoc, m4, fromRect = viewRect(fromDoc)) {
  const a = fromDoc?.viewSet?.active || fromDoc?.vp, b = toDoc?.viewSet?.active || toDoc?.vp;
  if (!a?.camera || !b?.camera || !a.target) return false;
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  m4.decompose(pos, q, sc);
  b.anim = null;
  b.target.copy(a.target).applyMatrix4(m4);
  b.scale = a.scale;
  b._applyQuat(q.multiply(a.camera.quaternion.clone()));
  const r = b.el?.getBoundingClientRect?.();
  if (fromRect?.width && r?.width) {
    const dx = (r.left + r.width / 2) - (fromRect.left + fromRect.width / 2), dy = (r.top + r.height / 2) - (fromRect.top + fromRect.height / 2);
    b.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(b.camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(b.camera.matrixWorld, 1);
    b.target.addScaledVector(right, dx * b.scale).addScaledVector(up, -dy * b.scale);
    b._applyQuat(b.camera.quaternion.clone());
  }
  b.requestRender?.();
  return true;
}
const poseM = (c) => new THREE.Matrix4().fromArray(M.poseMatrix(c));

export function setAsmContext(pd, ctx) {
  clearAsmContext(pd);
  if (opt('asmCtxKeepView')) carryView(ctx.asm, pd, poseM(ctx.comp).invert(), ctx.fromRect); // assembly → part frame: no jump of the view
  const g = new THREE.Group(); g.name = 'asm-context'; g.userData.noPivot = true; // 0.1.136: never a rotation centre
  const col = optHex('asmCtxColor'), op = opt('asmCtxOpacityPct') / 100;
  const mat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  const emat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: Math.min(1, op * opt('asmCtxEdgeFactor')), depthWrite: false });
  for (const it of ctx.items) {
    const m4 = new THREE.Matrix4().fromArray(it.m);
    const mesh = new THREE.Mesh(it.geom, mat); mesh.matrixAutoUpdate = false; mesh.matrix.copy(m4); mesh.renderOrder = 1; mesh.userData.ctx = true;
    g.add(mesh);
    if (it.egeom) { const l = new THREE.LineSegments(it.egeom, emat); l.matrixAutoUpdate = false; l.matrix.copy(m4); l.userData.ctx = true; g.add(l); }
  }
  g.visible = !!opt('asmCtxShow');
  pd.scene.add(g);
  const asmName = (ctx.asm.app.path || '').split(/[\\/]/).pop().replace(/\.lithasm$/i, '') || ctx.asm.doc.name;
  const ctxBtn = h('button', { class: 'ctx-btn' + (g.visible ? ' on' : ''), title: 'Show / hide the other components of the assembly' }, 'Context');
  ctxBtn.addEventListener('click', () => { g.visible = !g.visible; ctxBtn.classList.toggle('on', g.visible); pd.vp.requestRender(); });
  const banner = h('div', { class: 'ctx-banner' },
    h('span', {}, 'Editing ', h('b', {}, ctx.comp.name), ' in ', h('b', {}, asmName)),
    ctxBtn,
    h('button', { class: 'ctx-btn primary', title: 'Back to the assembly (asks to save the part when it changed)', onclick: () => returnToAssembly(pd) }, 'Return to Assembly'));
  pd.app.el.views.appendChild(banner);
  pd._ctx = { ...ctx, asmPath: ctx.asm.app.path || '', group: g, mat, emat, banner };
  pd.sketcher?.ctxEdges && (pd.sketcher._msg = null); // in-context edges for an open sketch (0.1.132)
  pd.renderTree?.();
  pd.vp.requestRender();
  log('INCONTEXT edit', ctx.comp.name, 'in', asmName, `${ctx.items.length} other components`);
}

export function clearAsmContext(pd) {
  const c = pd._ctx; if (!c) return;
  c.group.parent?.remove(c.group); c.mat.dispose(); c.emat.dispose(); c.banner.remove();
  pd._ctx = null;
  if (pd.sketcher) pd.sketcher._msg = null;
  pd.renderTree?.(); // -> becomes ->? (0.1.132)
  pd.vp?.requestRender?.();
}

export async function returnToAssembly(pd) {
  const c = pd._ctx; if (!c) return;
  const t = pd.app, root = t.root;
  if (t.pm.open || pd.sketcher) { toast('Finish the open dialog or sketch first (OK / Exit Sketch), then Return to Assembly', 'warn', 4000); return; }
  const asmTab = root.tabs.find((x) => x.doc === c.asm);
  let saved = false;
  if (t.dirty) {
    // 0.1.131: say so when the part does not rebuild cleanly (the assembly would get the model without those features)
    const bad = (pd.status || []).filter((x) => x.state === 'error').map((x) => `${pd.F?.(x.id)?.name || x.id}: ${x.error}`);
    const body = h('div', {}, h('p', {}, `Save ${pd.title} and update the assembly?`),
      bad.length ? h('p', { class: 'dlg-warn' }, `Rebuild errors — the assembly will get the model without these features: ${bad.join(' · ')}`) : null);
    const r = await dialog({ title: 'Return to Assembly', body, buttons: [{ label: 'Cancel', value: null }, { label: "Don't Save", value: 'no' }, { label: bad.length ? 'Save anyway' : 'Save', value: 'yes', primary: true }] });
    if (!r) return;
    if (r === 'yes') { if (!(await t.save())) return; saved = true; }
  }
  log('INCONTEXT return', c.comp.name, saved ? 'saved' : t.dirty ? 'not saved' : 'no changes', (pd.status || []).some((x) => x.state === 'error') ? '(with rebuild errors)' : '');
  clearAsmContext(pd);
  const partRect = viewRect(pd);
  if (asmTab) root.activate(asmTab); // onActivate reloads the parts saved meanwhile (re-match + solve)
  if (asmTab && opt('asmCtxKeepView')) carryView(pd, c.asm, poseM(c.comp), partRect); // part frame → assembly (0.1.133)
  if (c.openedHere && !t.dirty) root.closeTab(t);
}
