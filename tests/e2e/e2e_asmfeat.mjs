// 0.1.130: part features under the components + Edit in Context. Needs ../scratch/motion/ (Slide and rotation test).
// Copy in /tmp/af. Arm-1<1> expands to its planes + features (Sketch1, Boss-Extrude1, Fillet1); hover a feature → its faces
// light up; double-click Boss-Extrude1 → Arm-1.lithprt opens in its own tab with the 12 other components around it
// (transparent, placed in the arm's frame) and the Boss-Extrude dialog; depth 40 → 55, OK; Return to Assembly → Save →
// the file has depth 55, the assembly reloads it (all three arms), mates still hold, the part tab closes again.
// Toolbox parts: no Edit Part. Edit Part from the component menu + Return without changes.
import fs from 'node:fs';
import { launch } from './common.mjs';
import * as M from '../../shared/mates.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/af'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); });
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const asmTab = await win.evaluate(() => lithApp.root.tabs.indexOf(lithApp.root.active));
const arm = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.name === 'Arm-1<1>').id);
const row = (key) => win.locator(`.tree .tr-row[data-item="${key}"]`);
await win.locator(`.tree .tr-row[data-item="comp:${arm}"] .twisty`).click(); await W(400);
const rows = await win.evaluate((arm) => [...document.querySelectorAll('.tree .tr-row')].filter((r) => (r.dataset.item || '').startsWith(arm + ':')).map((r) => r.textContent.trim()), arm);
check('Arm-1<1> expands to its planes and its features', rows.join('|') === 'Front Plane|Top Plane|Right Plane|Sketch1|Boss-Extrude1|Fillet1', rows.join('|'));
// hover a feature → faces lit
const hlCount = () => win.evaluate((arm) => lithApp.doc.views.get(arm).hl.children.length, arm);
const f3 = await win.evaluate((arm) => lithApp.doc.C(arm)._part.data.features.find((f) => f.name === 'Boss-Extrude1').id, arm);
await row(`${arm}:feat:${f3}`).hover(); await W(300);
const lit = await hlCount();
const nFaces = await win.evaluate(([arm, id]) => lithApp.doc.views.get(arm).part.mesh.faces.filter((f) => f.feat === id).length, [arm, f3]);
await win.mouse.move(700, 400); await W(200); await win.locator('.tree').hover({ position: { x: 5, y: 5 } }); await W(200);
check('hover Boss-Extrude1 → its faces on Arm-1<1> light up; leave → off', lit === 1 && nFaces > 0 && (await hlCount()) === 0, `${lit} highlight, ${nFaces} faces`);
// Toolbox: no Edit Part
const bolt = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.lib).id);
await row(`comp:${bolt}`).click({ button: 'right' }); await W(300);
const boltMenu = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item, .menu .mi, .cmenu button, .context-menu button')].map((b) => b.textContent.trim()));
await win.keyboard.press('Escape'); await W(200);
const armMenuHas = async () => { await row(`comp:${arm}`).click({ button: 'right' }); await W(300); const m = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item, .menu .mi, .cmenu button, .context-menu button')].map((b) => b.textContent.trim())); await win.keyboard.press('Escape'); await W(200); return m; };
const armMenu = await armMenuHas();
check('component menu: Edit Part for Arm-1<1>, not for a Toolbox bolt', armMenu.some((t) => /^Edit Part/.test(t)) && !boltMenu.some((t) => /^Edit Part/.test(t)), `${armMenu.slice(0, 4).join(',')} / ${boltMenu.slice(0, 4).join(',')}`);
// double-click Boss-Extrude1 → part tab with context + the feature dialog
await win.evaluate(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej ' + (e.reason?.stack || e.reason))); });
const nTabs = await win.evaluate(() => lithApp.root.tabs.length);
await row(`${arm}:feat:${f3}`).dblclick(); await W(800);
const tq = Date.now(); for (let i = 0; i < 400 && !(await win.evaluate(() => lithApp.doc?.doc.kind === "part" && lithApp.pm.open)); i++) await W(100); console.log("waited", Date.now() - tq, JSON.stringify(await win.evaluate(() => window.__errs)), T.logs.slice(-5).join(' || '));
const pt = await win.evaluate(() => { const d = lithApp.doc; const g = d._ctx?.group; return { kind: d.doc.kind, path: lithApp.root.active.path, pm: lithApp.pm.current?.title || document.querySelector('.pm-title')?.textContent, ctx: g ? g.children.filter((o) => o.isMesh).length : -1, vis: g?.visible, banner: document.querySelector('.ctx-banner')?.textContent, tabs: lithApp.root.tabs.length }; });
check('double-click → Arm-1 part tab, Boss-Extrude1 dialog, the 12 other components around it, bar shown', pt.kind === 'part' && /Arm-1\.lithprt$/.test(pt.path) && /Boss-Extrude1|Extrude/.test(pt.pm || '') && pt.ctx === 12 && pt.vis && /Editing Arm-1<1> in Slide and rotation test/.test(pt.banner) && pt.tabs === nTabs + 1, JSON.stringify(pt));
// context placement: Blok-1 (fixed base) in the arm frame = inverse(arm pose) × Blok-1 pose
const place = await win.evaluate(() => {
  const asm = lithApp.doc._ctx.asm, d = lithApp.doc;
  const arm = asm.doc.components.find((c) => c.name === 'Arm-1<1>'), b1 = asm.doc.components.find((c) => c.name === 'Blok-1<1>');
  const ix = d._ctx.items.findIndex((x) => x.name === 'Blok-1<1>');
  const m = d._ctx.group.children.filter((o) => o.isMesh)[ix].matrix.elements;
  return { m: Array.from(m), arm: { pos: arm.pos, rot: arm.rot }, b1: { pos: b1.pos, rot: b1.rot } };
});
const pW = M.xfPoint(place.b1, [10, 20, 30]); // a point of Blok-1 in the world
const pLocal = M.invPoint(place.arm, pW); // the same point in the arm's frame
const e = place.m, pm = [e[0] * 10 + e[4] * 20 + e[8] * 30 + e[12], e[1] * 10 + e[5] * 20 + e[9] * 30 + e[13], e[2] * 10 + e[6] * 20 + e[10] * 30 + e[14]];
check('context: Blok-1 is placed where it is relative to the arm', Math.hypot(...pm.map((v, i) => v - pLocal[i])) < 1e-3, `${pm.map((v) => v.toFixed(2))} vs ${pLocal.map((v) => v.toFixed(2))}`);
await T.shot('asmfeat-context');
// Context toggle
await win.locator('.ctx-banner .ctx-btn:has-text("Context")').click(); await W(200);
const off = await win.evaluate(() => lithApp.doc._ctx.group.visible);
await win.locator('.ctx-banner .ctx-btn:has-text("Context")').click(); await W(200);
check('Context button hides / shows the other components', off === false && (await win.evaluate(() => lithApp.doc._ctx.group.visible)) === true);
// change the depth 40 → 55, OK
const inp = win.locator('.pm-numrow input').first(); await inp.fill('55'); await inp.press('Enter'); await idle();
await win.locator('.pm-ok').click(); await idle(); await W(500);
// Return while nothing open → Save
await win.locator('.ctx-banner .ctx-btn:has-text("Return to Assembly")').click(); await W(600);
const dlgTitle = await win.evaluate(() => document.querySelector('.dlg .dlg-title span')?.textContent);
await win.locator('.dlg button.primary').click(); await W(1500); await idle();
for (let i = 0; i < 100 && (await win.evaluate(() => lithApp.doc?.doc.kind)) !== 'assembly'; i++) await W(100);
await W(1500); await idle();
const disk = JSON.parse(fs.readFileSync(`${DIR}/Arm-1.lithprt`, 'utf8'));
const after = await win.evaluate(() => { const d = lithApp.doc; return { kind: d.doc.kind, tabs: lithApp.root.tabs.length, depths: d.doc.components.filter((c) => /^Arm-1/.test(c.name)).map((c) => c._part?.data?.features.find((f) => f.type === 'extrude')?.depth), err: [...(d.mateErr || new Map()).keys()] }; });
const s = await win.evaluate(() => { const d = lithApp.doc; return { comps: d.doc.components.map((c) => ({ id: c.id, pos: c.pos, rot: c.rot })), mates: d.doc.mates }; });
const by = M.compMap(s.comps);
const worst = Math.max(...s.mates.filter((m) => !M.mateOff(m)).map((m) => M.mateError(m, by)).filter(Number.isFinite));
check('Return → "Save?" → saved (depth 55 in the file), back in the assembly, part tab closed', dlgTitle === 'Return to Assembly' && disk.features.find((f) => f.type === 'extrude').depth === 55 && after.kind === 'assembly' && after.tabs === nTabs, `${dlgTitle} ${JSON.stringify(after)}`);
check('the assembly reloaded the part for all three arms; mates still hold', after.depths.length === 3 && after.depths.every((v) => v === 55) && worst < 1e-3, `${after.depths} worst ${worst.toExponential(1)} errs ${after.err}`);
// Edit Part from the component menu, Return without changes → no question, tab closes
await row(`comp:${arm}`).click({ button: 'right' }); await W(300);
await win.locator('.ctx-menu :text-is("Edit Part"), .menu :text-is("Edit Part")').first().click(); await W(800);
for (let i = 0; i < 100 && !(await win.evaluate(() => !!lithApp.doc?._ctx)); i++) await W(100);
const inPart = await win.evaluate(() => [lithApp.doc.doc.kind, !!lithApp.pm.open]);
await win.locator('.ctx-banner .ctx-btn:has-text("Return to Assembly")').click(); await W(800);
check('Edit Part (no dialog) → Return with no changes: no question, back, tab closed', inPart[0] === 'part' && !inPart[1] && (await win.locator('.dlg').count()) === 0 && (await win.evaluate(() => lithApp.doc.doc.kind)) === 'assembly' && (await win.evaluate(() => lithApp.root.tabs.length)) === nTabs, JSON.stringify(inPart));
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
