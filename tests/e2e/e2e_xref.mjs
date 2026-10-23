// 0.1.132: in-context references. Needs ../scratch/motion/ (Slide and rotation test); copy in /tmp/xr.
// Edit Part Blok-2<1> (slider) from the assembly → new sketch on its Front Plane → Convert Entities on an edge of
// Blok-1<1> (real mouse: hover + click) → the line keeps g.xref, tree "Sketch… ->"; Return → Save; the assembly shows
// Blok-2<1> "->"; drive Distance1 so the slider moves → Blok-2 row warns "out of date"; Edit Part again → the line
// follows (one undo step, log XREF updated), Return → Save → no warning; Blok-2 opened on its own → "->?", nothing moves;
// Break External References → plain fixed geometry.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/xr'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`, B2 = `${DIR}/Blok-2.lithprt`;
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); window.__xlog = []; const o = window.__lithLog; window.__lithLog = (...a) => { window.__xlog.push(a.join(' ')); return o?.(...a); }; });
const openAsm = async () => { await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A); await W(1200); await idle(); };
await openAsm();
const row = (key) => win.locator(`.tree .tr-row[data-item="${key}"]`);
const menuClick = async (key, label) => { await row(key).click({ button: 'right' }); await W(300); await win.locator(`.ctx-menu :text-is("${label}"), .menu :text-is("${label}")`).first().click(); await W(500); };
const waitCtx = async () => { for (let i = 0; i < 300 && !(await win.evaluate(() => !!lithApp.doc?._ctx && !document.getElementById('busy').classList.contains('on'))); i++) await W(100); await W(500); await idle(); };
const backToAsm = async (save = true) => {
  await win.locator('.ctx-banner .ctx-btn:has-text("Return to Assembly")').click(); await W(600);
  if (await win.locator('.dlg').count()) await win.locator(save ? '.dlg button.primary' : '.dlg button:has-text("Don\'t Save")').click();
  for (let i = 0; i < 100 && (await win.evaluate(() => lithApp.doc?.doc.kind)) !== 'assembly'; i++) await W(100);
  await W(1500); await idle();
};
const compRow = () => win.evaluate(() => { const c = lithApp.doc.doc.components.find((x) => x.name === 'Blok-2<1>'); const r = document.querySelector(`.tree .tr-row[data-item="comp:${c.id}"]`); return { text: r?.textContent.trim(), warn: r?.querySelector('.tr-warn')?.title || '' }; });
const slider = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.name === 'Blok-2<1>').id);

// 1. Edit Part → new sketch on Blok-2's Front Plane
await menuClick(`comp:${slider}`, 'Edit Part'); await waitCtx();
const nCtx = await win.evaluate(() => lithApp.doc._ctx.items.length);
await win.locator('.tree .tr-row:has-text("Front Plane")').first().click({ button: 'right' }); await W(300);
await win.locator('.ctx-menu :text-is("Sketch"), .menu :text-is("Sketch")').first().click(); await W(1500);
const inSk = await win.evaluate(() => !!lithApp.doc.sketcher);
// a Blok-1 line that the mouse can pick on its own: its midpoint picks exactly that edge
const cand = await win.evaluate(() => {
  const sk = lithApp.doc.sketcher, M = sk.modelSnapGeo(), r = sk.vp.el.getBoundingClientRect();
  const thr = 6 * sk.px; // within the pick distance
  const ctx = M.pickEdges.filter((x) => x.e.ctx && x.e.ctx.compName === 'Blok-1<1>' && x.e.type === 'line');
  for (const x of ctx) {
    const a = x.pts[0], b = x.pts[x.pts.length - 1], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = sk.scr(m), L = Math.hypot(...sk.scr(a).map((v, i) => v - sk.scr(b)[i]));
    if (L < 60 || s[0] < 20 || s[1] < 20 || s[0] > r.width - 20 || s[1] > r.height - 20) continue;
    if (sk.modelHoverAt(m, 1)?.e !== x.e) continue;
    if (M.verts.some((v) => Math.hypot(v[0] - m[0], v[1] - m[1]) < thr * 3)) continue;
    return { m, a, b, n: ctx.length, id: x.e.id };
  }
  return { n: ctx.length };
});
check('in the sketch: the other components\' edges can be picked', inSk && nCtx === 12 && cand.n > 0 && !!cand.m, `ctx ${nCtx} lines ${cand.n} ${cand.id || ''}`);
await win.locator('.cm-btn:has-text("Convert Entities")').first().click(); await W(300);
const [mx, my] = await T.P(cand.m[0], cand.m[1]);
await win.mouse.move(mx - 30, my - 30, { steps: 3 }); await win.mouse.move(mx, my, { steps: 6 }); await W(300);
await win.mouse.down(); await win.mouse.up(); await W(400);
await win.keyboard.press('Escape'); await W(300);
const made = await win.evaluate(() => { const sk = lithApp.doc.sketcher.sk; const g = sk.geo.find((x) => x.xref); const c = g && sk.cons.find((k) => k.e === g.id && k.type === 'fix'); const P = (id) => { const p = sk.geo.find((x) => x.id === id); return [p.x, p.y]; }; return g ? { type: g.type, comp: g.xref.compName, ref: g.xref.ref?.type, asm: g.xref.asm, fixX: c?.xref, onEdge: !!g.onEdge || !!c?.onEdge, p1: P(g.p1), p2: P(g.p2) } : null; });
const d0 = made && Math.min(Math.hypot(made.p1[0] - cand.a[0], made.p1[1] - cand.a[1]) + Math.hypot(made.p2[0] - cand.b[0], made.p2[1] - cand.b[1]), Math.hypot(made.p1[0] - cand.b[0], made.p1[1] - cand.b[1]) + Math.hypot(made.p2[0] - cand.a[0], made.p2[1] - cand.a[1]));
check('Convert Entities on a Blok-1 edge → line with an in-context reference (Fix "In Context", no On Edge)', made?.type === 'line' && made.comp === 'Blok-1<1>' && made.ref === 'line' && /Slide and rotation test\.lithasm$/.test(made.asm) && made.fixX === true && !made.onEdge && d0 < 1e-3, JSON.stringify(made));
// a line started on a corner of another component: that end is fixed there with an in-context reference
const vx = await win.evaluate(() => { const sk = lithApp.doc.sketcher, M = sk.modelSnapGeo(), r = sk.vp.el.getBoundingClientRect(); const v = M.verts.find((q) => { const s = sk.scr(q); return q.ctx && s[0] > 60 && s[1] > 60 && s[0] < r.width - 60 && s[1] < r.height - 60 && !M.verts.some((o) => o !== q && Math.hypot(o[0] - q[0], o[1] - q[1]) < 12 * sk.px) && !sk.sk.geo.some((g) => g.type === 'point' && Math.hypot(g.x - q[0], g.y - q[1]) < 12 * sk.px); }); return v ? { v: [v[0], v[1]], comp: v.ctx.compName, n: M.verts.filter((q) => q.ctx).length, px: sk.px } : { n: M.verts.filter((q) => q.ctx).length }; });
if (vx.v) {
  await win.locator('.cm-btn:has-text("Line")').first().click(); await W(300);
  const [vxs, vys] = await T.P(vx.v[0], vx.v[1]);
  await win.mouse.move(vxs + 3, vys + 2, { steps: 4 }); await W(150); await win.mouse.down(); await win.mouse.up(); await W(200);
  await win.mouse.move(vxs + 80, vys + 50, { steps: 4 }); await W(150); await win.mouse.down(); await win.mouse.up(); await W(200);
  await win.keyboard.press('Escape'); await W(200); await win.keyboard.press('Escape'); await W(200);
  const pv = await win.evaluate((v) => { const sk = lithApp.doc.sketcher.sk; const p = sk.geo.find((g) => g.type === 'point' && g.xref?.ref?.type === 'vertex'); return p ? { d: Math.hypot(p.x - v[0], p.y - v[1]), comp: p.xref.compName, fix: sk.cons.some((c) => c.e === p.id && c.xref) } : null; }, vx.v);
  check('Line started on a Blok-1 corner → that point is fixed there with an in-context reference', pv && pv.d < 1e-6 && pv.fix, JSON.stringify({ pv, vx }));
} else check('a corner of another component lies in the sketch plane (for the snap check)', false, JSON.stringify(vx));
await win.locator('.cm-btn:has-text("Exit Sketch")').first().click(); await W(800); await idle();
const skRow = await win.evaluate(() => { const d = lithApp.doc, f = d.doc.features.filter((x) => x.type === 'sketch').pop(); return { name: f.name, text: [...document.querySelectorAll('.tree .tr-row')].map((r) => r.textContent.trim()).find((t) => t.startsWith(f.name)), id: f.id }; });
check('part tree: the new sketch reads "-> "', skRow.text === `${skRow.name} ->`, JSON.stringify(skRow));
await backToAsm(true);
const disk1 = JSON.parse(fs.readFileSync(B2, 'utf8')).features.find((f) => f.id === skRow.id);
const r1 = await compRow();
check('saved; the assembly shows Blok-2<1> -> without a warning', !!disk1?.geo.some((g) => g.xref) && /Blok-2<1> ->$/.test(r1.text) && !r1.warn, JSON.stringify(r1));
await T.shot('xref-asm');

// 2. the slider moves (Distance1 -448.5 → -400) → out of date
await win.evaluate(() => { const d = lithApp.doc, m = d.doc.mates.find((x) => x.name === 'Distance1'); for (let v = -440; v <= -400; v += 10) d.driveTo([{ id: m.id, value: v }], 'drive'); d.endDriveSession(); d.renderTree(); });
await W(500);
const r2 = await compRow();
check('slider moved → Blok-2<1> warns: in-context references out of date', /out of date/.test(r2.warn), JSON.stringify(r2));

// 3. Edit Part again → the line follows the Blok-1 edge (48.5 mm along the slot in the slider's frame)
await win.evaluate(() => { window.__xlog.length = 0; });
await menuClick(`comp:${slider}`, 'Edit Part'); await waitCtx();
const upd = await win.evaluate((id) => {
  const d = lithApp.doc, f = d.F(id), g = f.geo.find((x) => x.xref);
  const P = (pid) => { const p = f.geo.find((x) => x.id === pid); return [p.x, p.y]; };
  return { p1: P(g.p1), p2: P(g.p2), dirty: !!d.app.dirty, undo: d.undoStack.length, log: window.__xlog.filter((l) => /^XREF/.test(l)), status: document.querySelector('.status, #status')?.textContent || '' };
}, skRow.id);
const mv = [upd.p1[0] - made.p1[0], upd.p1[1] - made.p1[1]], mv2 = [upd.p2[0] - made.p2[0], upd.p2[1] - made.p2[1]];
const dist = Math.hypot(...mv);
check('Edit Part → the line followed Blok-1 (both ends by the same ~48.5 mm), part changed, log XREF updated', Math.abs(dist - 48.5) < 0.5 && Math.hypot(mv[0] - mv2[0], mv[1] - mv2[1]) < 1e-3 && upd.dirty && upd.log.some((l) => /XREF updated .*Blok-1<1>/.test(l)), `moved ${mv.map((v) => v.toFixed(3))} ${JSON.stringify(upd.log)}`);
await win.keyboard.press('Control+z'); await W(1200); await idle();
const und = await win.evaluate((id) => { const f = lithApp.doc.F(id), g = f.geo.find((x) => x.xref), p = f.geo.find((x) => x.id === g.p1); return [p.x, p.y]; }, skRow.id);
await win.keyboard.press('Control+y'); await W(1200); await idle();
const red = await win.evaluate((id) => { const f = lithApp.doc.F(id), g = f.geo.find((x) => x.xref), p = f.geo.find((x) => x.id === g.p1); return [p.x, p.y]; }, skRow.id);
check('the update is one undo step (undo → old place, redo → new place)', Math.hypot(und[0] - made.p1[0], und[1] - made.p1[1]) < 1e-6 && Math.hypot(red[0] - upd.p1[0], red[1] - upd.p1[1]) < 1e-6, `${und} / ${red}`);
await backToAsm(true);
const r3 = await compRow();
check('Return → Save → Blok-2<1> -> without a warning again', /Blok-2<1> ->$/.test(r3.text) && !r3.warn, JSON.stringify(r3));

// 4. opened on its own: ->? and nothing moves
const before = JSON.parse(fs.readFileSync(B2, 'utf8')).features.find((f) => f.id === skRow.id);
await win.evaluate(async (p) => { await lithApp.open(p); }, B2); await W(1500); await idle();
const alone = await win.evaluate((id) => { const d = lithApp.doc, f = d.F(id); return { kind: d.doc.kind, ctx: !!d._ctx, text: [...document.querySelectorAll('.tree .tr-row')].map((r) => r.textContent.trim()).find((t) => t.startsWith(f.name)), geo: f.geo, dirty: !!d.app.dirty }; }, skRow.id);
const sameGeo = JSON.stringify(alone.geo.filter((g) => g.type === 'point').map((g) => [g.x, g.y])) === JSON.stringify(before.geo.filter((g) => g.type === 'point').map((g) => [g.x, g.y]));
check('Blok-2 opened on its own: "->?" (out of context), geometry not moved, not changed', alone.kind === 'part' && !alone.ctx && / ->\?$/.test(alone.text) && sameGeo && !alone.dirty, JSON.stringify({ ...alone, geo: undefined }));
// 5. Break External References
await win.locator(`.tree .tr-row:has-text("${skRow.name} ->?")`).first().click({ button: 'right' }); await W(300);
await win.locator('.ctx-menu :text-is("Break External References"), .menu :text-is("Break External References")').first().click(); await W(500);
const br = await win.evaluate((id) => { const d = lithApp.doc, f = d.F(id); return { xref: f.geo.some((g) => g.xref) || f.cons.some((c) => c.xref), fix: f.cons.filter((c) => c.type === 'fix').length, text: [...document.querySelectorAll('.tree .tr-row')].map((r) => r.textContent.trim()).find((t) => t.startsWith(f.name)), name: f.name }; }, skRow.id);
check('Break External References → plain Fix, no mark', !br.xref && br.fix >= 1 && br.text === br.name, JSON.stringify(br));
const errsPage = T.logs.filter((l) => /pageerror|Uncaught/.test(l));
check('no page errors', errsPage.length === 0, errsPage.slice(0, 2).join(' | '));
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
