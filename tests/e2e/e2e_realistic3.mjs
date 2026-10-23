// 0.1.114: Realistic in dark mode uses the dark studio colours (realBgTopDark/BottomDark); the ground shadow has a
// wide soft layer (realShadowSpread) so a flat part also shows a shadow past its edges. Needs ../scratch/tekst.lithprt.
// Shots: tests/e2e/shots/rs*.png. Also runs on 0.1.113 (base) for before/after shots — the 0.1.114 checks then FAIL.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
fs.mkdirSync('/tmp/rs', { recursive: true }); fs.copyFileSync('/home/claude/scratch/tekst.lithprt', '/tmp/rs/t.lithprt');
const T = await launch('part'); const { win, W, idle } = T;
await win.evaluate(() => lithApp.applyOptions({ dark: true })); await W(500);
await win.evaluate((p) => lithApp.open(p), '/tmp/rs/t.lithprt'); await W(5000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout?.('single'); d.vp.setView?.('iso'); }); await W(1500);
await win.mouse.move(5, 5);
await win.evaluate(() => lithApp.doc.setDisplay('realistic')); await W(2000);
const bg = () => win.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => c.parentElement?.style.background || '').filter(Boolean)[0] || '');
let b = await bg();
check('dark mode: dark studio background', /86, 94, 112|#565e70/i.test(b), b);
await T.shot('rs1_dark_realistic');
// shadow outside the model's footprint: ring of cells just outside the model's box (texture covers box + margin)
const ring = () => win.evaluate(() => {
  const s = lithApp.doc.stage.shadow, t = s.material.map.image, nx = t.width, nz = t.height;
  s.geometry.computeBoundingBox();
  const w = s.geometry.boundingBox.max.x - s.geometry.boundingBox.min.x, d = s.geometry.boundingBox.max.z - s.geometry.boundingBox.min.z;
  // model box from the body meshes
  const mb = lithApp.doc.bodyMesh.geometry; mb.computeBoundingBox(); const m = mb.boundingBox.clone().applyMatrix4(lithApp.doc.bodyMesh.matrixWorld);
  const x0 = s.position.x - w / 2, z0 = s.position.z - d / 2, big = Math.max(m.max.x - m.min.x, m.max.z - m.min.z);
  let sum = 0, n = 0, mx = 0;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = x0 + ((i + 0.5) / nx) * w, z = z0 + ((k + 0.5) / nz) * d;
    const dx = Math.max(m.min.x - x, 0, x - m.max.x), dz = Math.max(m.min.z - z, 0, z - m.max.z), dist = Math.hypot(dx, dz);
    if (dist > 0.02 * big && dist < 0.1 * big) { const a = t.data[(k * nx + i) * 4 + 3]; sum += a; n++; mx = Math.max(mx, a); }
  }
  return { mean: +(sum / Math.max(1, n)).toFixed(1), max: mx, cells: n };
});
const r1 = await ring(); console.log('ring 2–10 % outside the model', JSON.stringify(r1));
check('shadow visible past the edges (mean alpha > 25; 0.1.113 ≈ 6)', r1.mean > 25, JSON.stringify(r1));
await win.evaluate(() => lithApp.applyOptions({ realShadowSpread: 0 })); await W(1500);
const r0 = await ring(); console.log('spread 0', JSON.stringify(r0));
check('spread 0 = only the contact shadow (less outside)', r0.mean < r1.mean * 0.6, `${r0.mean} < ${r1.mean}`);
await win.evaluate(() => lithApp.applyOptions({ realShadowSpread: 10 })); await W(1500);
await win.evaluate(() => lithApp.applyOptions({ dark: false })); await W(1500);
b = await bg();
check('light mode: light studio background', /244, 246, 249|#f4f6f9/i.test(b), b);
await win.mouse.move(5, 5); await T.shot('rs2_light_realistic');
await win.evaluate(() => lithApp.applyOptions({ dark: true })); await W(800);
await win.evaluate(() => lithApp.doc.setDisplay('shadedEdges')); await W(1200);
b = await bg();
check('Shaded With Edges: no studio background', !/gradient/.test(b), b);
await T.shot('rs3_dark_shaded');
console.log('ERRORS:', errs.length ? errs.join(', ') : 'none');
await T.close?.(); await T.app.close(); process.exit(errs.length ? 1 : 0);
