// 0.1.118: Lock rotation (concentric mates) + Edit Toolbox Definition, through the tree right-click menus and the
// PropertyManagers, on a copy of Wouter's "Slide and rotation test" (6 DIN fasteners). Needs ../scratch/motion/.
import fs from 'node:fs';
import { launch } from './common.mjs';
import * as M from '../../shared/mates.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/tbe'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const doc = () => win.evaluate(() => JSON.parse(JSON.stringify(lithApp.doc.toJSON())));
const id = async (name) => (await doc()).components.find((c) => c.name === name)?.id;
const rowR = async (cid) => { await win.locator(`.tree .tr-row[data-item="comp:${cid}"]`).first().click({ button: 'right' }); await W(250); };
const menu = () => win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => b.textContent.trim()));
const pick = async (label) => { await win.locator(`.ctx-item:has-text("${label}")`).first().click(); await W(500); await idle(); };
const sel = async (i, v) => { await win.locator('.pm-body select').nth(i).selectOption(String(v)); await W(400); };
const err = (d) => { const by = new Map(d.components.map((c) => [c.id, c])); return Math.max(...d.mates.filter((m) => !m.suppressed).map((m) => M.mateError(m, by))); };
const B50 = await id('DIN 933 M24x50<1>');

// 1) right-click one bolt → Lock Rotation
await rowR(B50);
let items = await menu();
check('bolt menu has Edit Toolbox Definition + Lock Rotation', items.some((t) => t.startsWith('Edit Toolbox Definition')) && items.includes('Lock Rotation'), items.slice(0, 4).join(' | '));
await pick('Lock Rotation');
let d = await doc();
const concOf = (d, cid) => d.mates.filter((m) => m.type === 'concentric' && (m.a.comp === cid || m.b.comp === cid));
check('its concentric mates are locked (lockQ stored)', concOf(d, B50).length === 2 && concOf(d, B50).every((m) => m.lockRot && m.lockQ?.length === 4), concOf(d, B50).map((m) => m.name).join());
// 2) select all fasteners (Ctrl+click) → right-click → Lock Rotation (all)
const libs = d.components.filter((c) => c.lib).map((c) => c.id);
await win.locator(`.tree .tr-row[data-item="comp:${libs[0]}"]`).first().click(); await W(150);
for (const c of libs.slice(1)) { await win.keyboard.down('Control'); await win.locator(`.tree .tr-row[data-item="comp:${c}"]`).first().click(); await win.keyboard.up('Control'); await W(120); }
await rowR(libs[1]);
items = await menu();
await pick('Lock Rotation');
d = await doc();
const allConc = d.mates.filter((m) => m.type === 'concentric' && libs.some((c) => m.a.comp === c || m.b.comp === c));
check('6 selected fasteners → all their concentric mates locked', allConc.length >= 6 && allConc.every((m) => m.lockRot), `${allConc.filter((m) => m.lockRot).length}/${allConc.length}`);
check('locking keeps the pose, no mate errors', err(d) < 1e-4 && (await win.evaluate(() => lithApp.doc.mateErr.size)) === 0, err(d).toExponential(1));
const dof = await win.evaluate(() => Object.fromEntries([...lithApp.doc.dof].map(([k, v]) => [k, v.dof])));
check('bolt on the fixed base now fully defined', dof[await id('DIN 933 M24x80<2>')] === 0, JSON.stringify(dof));
// 3) undo the last lock, redo
await win.evaluate(() => lithApp.doc.undo()); await W(400);
d = await doc();
check('undo → only the first bolt locked', d.mates.filter((m) => m.lockRot).length === 2, d.mates.filter((m) => m.lockRot).length);
await win.evaluate(() => lithApp.doc.redo()); await W(400);
// 4) Edit Toolbox Definition: M24x80<1> → M20x100
const B80 = await id('DIN 933 M24x80<1>');
await win.locator(`.tree .tr-row[data-item="comp:${B80}"]`).first().click(); await W(150);
await rowR(B80); await pick('Edit Toolbox Definition');
const title = await win.evaluate(() => lithApp.pm.current?.opts?.title || document.querySelector('.pm-title')?.textContent);
const stdOpts = await win.evaluate(() => [...document.querySelectorAll('.pm-body select')[0].options].map((o) => o.value));
check('PM opens with the bolt values, standards = bolts only', /Edit Toolbox Definition/.test(title || '') && stdOpts.every((s) => ['DIN933', 'DIN931', 'DIN912', 'DIN7991'].includes(s)), `${title} ${stdOpts}`);
const cur = await win.evaluate(() => [...document.querySelectorAll('.pm-body select')].map((s) => s.value));
check('PM shows DIN933 / M24 / 80', cur.join() === 'DIN933,M24,80', cur.join());
await sel(1, 'M20'); await sel(2, '100');
await T.ok(); await W(800); await idle();
d = await doc();
let c = d.components.find((k) => k.id === B80);
check('bolt changed: lib + name', c.lib.std === 'DIN933' && c.lib.size === 'M20' && c.lib.L === 100 && c.name === 'DIN 933 M20x100<1>', `${c.name} ${JSON.stringify(c.lib)}`);
const shank = await win.evaluate((cid) => { const v = lithApp.doc.views.get(cid); return v.part.mesh.faces.filter((f) => f.type === 'cylinder').map((f) => +f.r.toFixed(2)); }, B80);
check('new geometry loaded (shank r 10)', shank.includes(10), shank.join());
check('mates still solved after the change', (await win.evaluate(() => lithApp.doc.mateErr.size)) === 0 && err(d) < 1e-3, err(d).toExponential(1));
await T.shot('toolboxedit-m20');
await win.evaluate(() => lithApp.doc.undo()); await W(1500); await idle();
d = await doc(); c = d.components.find((k) => k.id === B80);
const shank2 = await win.evaluate((cid) => { const v = lithApp.doc.views.get(cid); return v?.part?.mesh.faces.filter((f) => f.type === 'cylinder').map((f) => +f.r.toFixed(2)); }, B80);
check('undo → M24x80 back, geometry too', c.name === 'DIN 933 M24x80<1>' && c.lib.size === 'M24' && (shank2 || []).includes(12), `${c.name} ${shank2}`);
// 5) three washers at once → DIN 9021
const ws = d.components.filter((k) => k.lib?.std === 'DIN125').map((k) => k.id);
await win.locator(`.tree .tr-row[data-item="comp:${ws[0]}"]`).first().click(); await W(150);
for (const w of ws.slice(1)) { await win.keyboard.down('Control'); await win.locator(`.tree .tr-row[data-item="comp:${w}"]`).first().click(); await win.keyboard.up('Control'); await W(120); }
await rowR(ws[0]);
items = await menu();
check('menu shows the count of selected washers', items.some((t) => t === `Edit Toolbox Definition… (${ws.length})`), items[0]);
await pick('Edit Toolbox Definition');
await sel(0, 'DIN9021'); await T.ok(); await W(1000); await idle();
d = await doc();
check('all washers → DIN 9021, unique names', ws.every((w) => d.components.find((k) => k.id === w).lib.std === 'DIN9021') && new Set(d.components.map((k) => k.name)).size === d.components.length, ws.map((w) => d.components.find((k) => k.id === w).name).join());
check('mates still solved (washers)', (await win.evaluate(() => lithApp.doc.mateErr.size)) === 0 && err(d) < 1e-3, err(d).toExponential(1));
// 6) a NEW concentric mate with a Toolbox part: Lock rotation is ticked by default (Options asmLockToolboxRot)
const B80b = await id('DIN 933 M24x80<2>');
await win.evaluate((cid) => { const d = lithApp.doc; for (const m of [...d.doc.mates]) if (m.a.comp === cid || m.b.comp === cid) d.deleteMate(m.id); }, B80b); await W(300);
const offerAxis = (cname, pred) => win.evaluate(([cname, pred]) => {
  const d = lithApp.doc, c = d.doc.components.find((k) => k.name === cname), v = d.views.get(c.id);
  const f = v.part.mesh.faces.find(new Function('f', 'return ' + pred));
  lithApp.pm.current.offer({ comp: c.id, kind: 'face', id: f.id, c: f.c, point: f.c, key: `${c.id}:face:${f.id}`, label: f.type, geo: { t: 'axis', p: f.axis.p, d: f.axis.d, r: f.r } });
}, [cname, pred]);
const mateLock = async () => {
  await T.btn('Mate'); await W(300);
  await offerAxis('DIN 933 M24x80<2>', "f.type==='cylinder'"); await W(200);
  await offerAxis('Blok-1<1>', "f.type==='cylinder' && Math.abs(f.r - 13) < 0.1"); await W(300);
  const v = await win.evaluate(() => ({ type: lithApp.pm.current.values?.type ?? document.querySelector('.pm-body select')?.value, lock: [...document.querySelectorAll('.pm-body input[type=checkbox]')].map((x) => x.checked) }));
  await T.ok(); await W(300); await win.keyboard.press('Escape'); await W(300);
  return v;
};
let v = await mateLock();
d = await doc();
let nm = d.mates.filter((m) => m.a.comp === B80b || m.b.comp === B80b);
check('new concentric mate with a bolt: Lock rotation ticked + stored', nm.length === 1 && nm[0].type === 'concentric' && nm[0].lockRot && nm[0].lockQ, JSON.stringify(v) + ' ' + JSON.stringify(nm.map((m) => [m.type, m.lockRot])));
await win.evaluate((cid) => { const d = lithApp.doc; for (const m of [...d.doc.mates]) if (m.a.comp === cid || m.b.comp === cid) d.deleteMate(m.id); }, B80b); await W(300);
await win.evaluate(() => lithApp.applyOptions({ asmLockToolboxRot: false }));
v = await mateLock();
d = await doc(); nm = d.mates.filter((m) => m.a.comp === B80b || m.b.comp === B80b);
check('Options off: new mate not locked', nm.length === 1 && !nm[0].lockRot, JSON.stringify(nm.map((m) => [m.type, m.lockRot])));
await win.evaluate(() => lithApp.applyOptions({ asmLockToolboxRot: true }));
// 7) mate row right-click: Unlock Rotation
const lm = d.mates.find((m) => m.lockRot);
await win.locator(`.tree .tr-row[data-item="mate:${lm.id}"]`).first().click({ button: 'right' }); await W(250);
items = await menu();
check('locked mate menu says Unlock Rotation', items.includes('Unlock Rotation'), items.join(' | '));
await pick('Unlock Rotation');
d = await doc();
check('mate unlocked (lockQ removed)', !d.mates.find((m) => m.id === lm.id).lockRot && !d.mates.find((m) => m.id === lm.id).lockQ);
await T.shot('toolboxedit-end');
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
await T.app.close();
process.exit(errs.length ? 1 : 0);
