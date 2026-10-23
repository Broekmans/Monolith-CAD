// 0.1.133: Edit Part keeps the view, picked component highlighted in the tree, face → its feature in the part tree,
// double-click a component in the view = Edit Part, Shift+C collapses the tree. Needs ../scratch/b300/ (Bucket assembly),
// copy in /tmp/cv.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/cv'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/b300')) fs.copyFileSync(`/home/claude/scratch/b300/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Bucket assembly.lithasm`;
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); });
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
await win.keyboard.press('Control+7'); await W(800); // isometric
await win.evaluate(() => lithApp.doc.zoomFit()); await W(600);
// a pixel on a face of Rotator-1<1>
const spot = await win.evaluate(() => {
  const d = lithApp.doc, c = d.doc.components.find((x) => x.name === 'Rotator-1<1>'), r = d.vp.el.getBoundingClientRect();
  for (let y = 0.2; y < 0.95; y += 0.02) for (let x = 0.1; x < 0.95; x += 0.02) {
    const cx = r.left + r.width * x, cy = r.top + r.height * y, p = d.pickAt({ clientX: cx, clientY: cy });
    if (p?.comp === c.id && p.kind === 'face') {
      const p2 = d.pickAt({ clientX: cx + 3, clientY: cy + 3 }), p3 = d.pickAt({ clientX: cx - 3, clientY: cy - 3 });
      if (p2?.key === p.key && p3?.key === p.key) return { x: cx, y: cy, comp: c.id, world: p.point, face: p.id };
    }
  }
  return null;
});
check('found a face of Rotator-1<1> in the view', !!spot, JSON.stringify(spot));
await win.locator('.tree').evaluate((t) => { t.scrollTop = 0; });
await win.mouse.move(spot.x, spot.y, { steps: 4 }); await W(200); await win.mouse.down(); await win.mouse.up(); await W(600);
const tr = await win.evaluate((id) => { const row = document.querySelector(`.tree .tr-row[data-item="comp:${id}"]`), t = document.querySelector('.tree').getBoundingClientRect(), r = row?.getBoundingClientRect(); return { sel: row?.classList.contains('sel'), inView: r && r.top >= t.top - 1 && r.bottom <= t.bottom + 1, open: lithApp.doc._compOpen?.has(id), kind: lithApp.doc.sel[0]?.kind }; }, spot.comp);
check('click a Rotator face in the view → Rotator-1<1> highlighted in the tree, scrolled to and opened', tr.sel && tr.inView && tr.open && tr.kind === 'face', JSON.stringify(tr));
// double-click in the view → Edit Part; the same model point stays on the same pixel
const asmPx = await win.evaluate((w) => { const vp = lithApp.doc.viewSet.active || lithApp.doc.vp, r = vp.el.getBoundingClientRect(), s = vp.toScreen(w); return [r.left + s[0], r.top + s[1]]; }, spot.world);
await win.mouse.dblclick(spot.x, spot.y); await W(1000);
for (let i = 0; i < 300 && !(await win.evaluate(() => !!lithApp.doc?._ctx && !document.getElementById('busy').classList.contains('on'))); i++) await W(100);
await W(800);
const pv = await win.evaluate(({ w, comp }) => {
  const d = lithApp.doc, asm = d._ctx.asm, c = asm.C(comp);
  // world → part frame (inverse pose)
  const q = c.rot, p = c.pos, v = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
  const qi = [-q[0], -q[1], -q[2], q[3]], rot = (qq, a) => { const [x, y, z, s] = qq, ix = s * a[0] + y * a[2] - z * a[1], iy = s * a[1] + z * a[0] - x * a[2], iz = s * a[2] + x * a[1] - y * a[0], iw = -x * a[0] - y * a[1] - z * a[2]; return [ix * s + iw * -x + iy * -z - iz * -y, iy * s + iw * -y + iz * -x - ix * -z, iz * s + iw * -z + ix * -y - iy * -x]; };
  const loc = rot(qi, v);
  const vp = d.viewSet.active || d.vp, r = vp.el.getBoundingClientRect(), s = vp.toScreen(loc);
  return { kind: d.doc.kind, name: d._ctx.comp.name, px: [r.left + s[0], r.top + s[1]], loc };
}, { w: spot.world, comp: spot.comp });
const dpx = Math.hypot(pv.px[0] - asmPx[0], pv.px[1] - asmPx[1]);
check('double-click → Edit Part Rotator-1<1>; the model point stays on the same pixel (no view jump)', pv.kind === 'part' && pv.name === 'Rotator-1<1>' && dpx < 2, `moved ${dpx.toFixed(2)} px ${JSON.stringify(pv.px)} vs ${JSON.stringify(asmPx)}`);
await T.shot('ctxview-part');
// part: click the face → the feature that made it is highlighted
await win.mouse.move(pv.px[0] + 1, pv.px[1] + 1, { steps: 3 }); await W(200); await win.mouse.down(); await win.mouse.up(); await W(600);
const own = await win.evaluate(() => { const d = lithApp.doc, s = d.sel[0], f = s?.kind === 'face' ? d.mesh.faces.find((x) => x.id === s.id) : null, F = f && d.F(f.feat); const rows = [...document.querySelectorAll('.tree .tr-row.sel')].map((r) => r.textContent.trim()); return { kind: s?.kind, feat: F?.name, rows }; });
check('part: click a face → the feature that made it is highlighted in the tree', own.kind === 'face' && !!own.feat && own.rows.some((t) => t.startsWith(own.feat)), JSON.stringify(own));
// Shift+C in the part
await win.mouse.move(pv.px[0] + 200, pv.px[1] - 200); await win.keyboard.press('Shift+C'); await W(400);
const pc = await win.evaluate(() => { const d = lithApp.doc; return { open: Object.entries(d._treeOpen || {}).filter(([, v]) => v).map(([k]) => k), exp: d.expanded?.size, planes: !![...document.querySelectorAll('.tree .tr-row')].find((r) => r.textContent.trim() === 'Front Plane'), sk: !!d.sketcher }; });
check('part: Shift+C collapses every folder (no Front Plane row), no sketch tool started', pc.open.length === 0 && !pc.exp && !pc.planes && !pc.sk, JSON.stringify(pc));
// turn the view in the part, then Return → the assembly keeps that view
await win.keyboard.press('ArrowLeft'); await W(400);
const partPx = await win.evaluate((loc) => { const vp = lithApp.doc.viewSet.active || lithApp.doc.vp, r = vp.el.getBoundingClientRect(), s = vp.toScreen(loc); return [r.left + s[0], r.top + s[1]]; }, pv.loc);
await win.locator('.ctx-banner .ctx-btn:has-text("Return to Assembly")').click(); await W(800);
if (await win.locator('.dlg').count()) await win.locator('.dlg button:has-text("Don\'t Save")').click();
for (let i = 0; i < 100 && (await win.evaluate(() => lithApp.doc?.doc.kind)) !== 'assembly'; i++) await W(100);
await W(1000); await idle();
const backPx = await win.evaluate((w) => { const vp = lithApp.doc.viewSet.active || lithApp.doc.vp, r = vp.el.getBoundingClientRect(), s = vp.toScreen(w); return [r.left + s[0], r.top + s[1]]; }, spot.world);
const dback = Math.hypot(backPx[0] - partPx[0], backPx[1] - partPx[1]);
check('Return to Assembly keeps the (turned) view: the point stays on its pixel', dback < 2 && Math.hypot(partPx[0] - asmPx[0], partPx[1] - asmPx[1]) > 5, `moved ${dback.toFixed(2)} px`);
// Shift+C in the assembly
await win.keyboard.press('Shift+C'); await W(400);
const ac = await win.evaluate(() => { const d = lithApp.doc, rows = [...document.querySelectorAll('.tree .tr-row')]; return { comps: rows.filter((r) => (r.dataset.item || '').startsWith('comp:')).length, inner: rows.filter((r) => /:feat:|^mate:/.test(r.dataset.item || '') || r.dataset.folder?.startsWith('compMates')).length, origin: rows.some((r) => r.textContent.trim() === 'Front Plane'), n: d.doc.components.length }; });
check('assembly: Shift+C closes every component and folder, the component list stays', ac.comps === ac.n && ac.inner === 0 && !ac.origin, JSON.stringify(ac));
// double-click a component row → Edit Part
const rid = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.name === 'BAse-1<1>').id);
await win.locator(`.tree .tr-row[data-item="comp:${rid}"]`).dblclick(); await W(1000);
for (let i = 0; i < 300 && !(await win.evaluate(() => !!lithApp.doc?._ctx && !document.getElementById('busy').classList.contains('on'))); i++) await W(100);
const dr = await win.evaluate(() => ({ kind: lithApp.doc.doc.kind, comp: lithApp.doc._ctx?.comp.name }));
check('double-click a component row → Edit Part (in context)', dr.kind === 'part' && dr.comp === 'BAse-1<1>', JSON.stringify(dr));
const pe = T.logs.filter((l) => /pageerror|Uncaught/.test(l));
check('no page errors', pe.length === 0, pe.slice(0, 2).join(' | '));
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
