// 0.1.134: Angle mates no longer come back 180° off after a part changed (rematch keeps the face's side), Flip Mate
// Alignment, Motion Study takes over (no write-back, closing restores the tree pose, own step name and Flip, several
// steps selected + deleted), Shift+click ranges in the tree + Delete (n), Ctrl+click two faces → distance popup and
// status bar, tree defaults. Needs ../scratch/b300/ (Bucket assembly); copy in /tmp/st.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/st'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/b300')) fs.copyFileSync(`/home/claude/scratch/b300/${f}`, `${DIR}/${f}`);
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); window.__xlog = []; const o = window.__lithLog; window.__lithLog = (...a) => { window.__xlog.push(a.join(' ')); return o?.(...a); }; });
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, `${DIR}/Bucket assembly.lithasm`);
await W(1200); await idle();
const menu = async (loc, label) => { await loc.click({ button: 'right' }); await W(300); const it = win.locator(`.ctx-menu .ctx-item:has-text("${label}")`).first(); const n = await it.count(); if (n) await it.click(); else await win.keyboard.press('Escape'); await W(500); return n; };
const poses = () => win.evaluate(() => JSON.stringify(lithApp.doc.doc.components.map((c) => [c.pos.map((v) => +v.toFixed(4)), c.rot.map((v) => +v.toFixed(5))])));

// 0) defaults
const defs = await win.evaluate(() => [lithApp.opt ? 0 : 0, getComputedStyle(document.body).getPropertyValue('--tree-row')]);
const ind = await win.evaluate(async () => (await import('./src/app/options.js').catch(() => null)) ? 1 : 0).catch(() => 0);
void ind;
check('tree row height default 16 px', /16px/.test(defs[1]), defs[1]);

// 1) rematch keeps the side of a planar face: Angle3's face on Arm-1<1>, its stored centre moved onto the opposite face
const rm = await win.evaluate(() => {
  const d = lithApp.doc, m = d.doc.mates.find((x) => x.name === 'Angle3'), r = m.b.comp === 'c4' && m.b.kind === 'face' ? m.b : m.a;
  const part = d.partOf(d.C(r.comp)), faces = part.mesh.faces.filter((f) => f.type === 'plane');
  const me = faces.find((f) => f.id === r.id), n = me.plane.normal;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const opp = faces.filter((f) => dot(f.plane.normal, n) < -0.999).sort((a, b) => Math.hypot(...a.c.map((v, i) => v - me.c[i])) - Math.hypot(...b.c.map((v, i) => v - me.c[i])))[0];
  if (!opp) return { none: true };
  const id0 = r.id; r.c = [...opp.c]; r.id = -1; // as if the part changed and only the opposite face is near the old place
  d.rematchAll();
  const now = part.mesh.faces.find((f) => f.id === r.id);
  return { id0, id: r.id, opp: opp.id, dot: dot(now.plane.normal, n) };
});
check('rematch: a planar face is not swapped for the face on the other side', !rm.none && rm.id !== rm.opp && rm.dot > 0.999, JSON.stringify(rm));
await win.evaluate(() => lithApp.doc.undo?.()); // (rematch makes no undo step; reload the file state below)
await win.evaluate(async (p) => { const t = lithApp.root.active; lithApp.root.closeTab?.(t, true); }, null).catch(() => {});
await W(600);
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, `${DIR}/Bucket assembly.lithasm`);
await W(1000); await idle();

// 2) Flip Mate Alignment from the tree (one undo step, the model follows, the value stays)
const a2 = await win.evaluate(() => lithApp.doc.doc.mates.find((m) => m.name === 'Angle2').id);
const p0 = await poses(), u0 = await win.evaluate(() => lithApp.doc.undoStack.length);
const s0 = await win.evaluate((id) => { const m = lithApp.doc.doc.mates.find((x) => x.id === id); return [m.sense, !!m.flip, m.value]; }, a2);
const n2 = await menu(win.locator(`.tree .tr-row[data-item="mate:${a2}"]`).first(), 'Flip Mate Alignment');
await W(500);
const s1 = await win.evaluate((id) => { const m = lithApp.doc.doc.mates.find((x) => x.id === id); return [m.sense, !!m.flip, m.value]; }, a2);
const p1 = await poses();
check('right-click Angle2 › Flip Mate Alignment: sense flipped, value kept, model moved, one undo step', n2 && s1[0] === -s0[0] && s1[1] !== s0[1] && s1[2] === s0[2] && p1 !== p0 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === u0 + 1, `${JSON.stringify(s0)} → ${JSON.stringify(s1)}`);
await win.evaluate(() => lithApp.doc.undo()); await W(800);
check('undo → back', (await poses()) === p0);

// 3) Motion Study takes over
const tree0 = await win.evaluate(() => JSON.stringify(lithApp.doc.doc.mates.map((m) => [m.id, m.value, m.limits || null])));
const pTree = await poses(), u1 = await win.evaluate(() => lithApp.doc.undoStack.length);
await win.locator('.cm-btn:has-text("Motion Study")').first().click(); await W(1000);
await win.locator('.motion-strip .ms-btn[title="To the end"]').click(); await W(1500);
const lbl = await win.evaluate((id) => document.querySelector(`.tree .tr-row[data-item="mate:${id}"]`)?.textContent || '', a2);
const pEnd = await poses();
const tree1 = await win.evaluate(() => JSON.stringify(lithApp.doc.doc.mates.map((m) => [m.id, m.value, m.limits || null])));
check('study open, To the end: model moved, tree values unchanged, no undo step, tree says (Motion Study)', pEnd !== pTree && tree1 === tree0 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === u1 && /Motion Study/.test(lbl), lbl);
// step name (popup Name field) + Flip in the study
const nm = win.locator('.motion-strip .ms-name[data-i="1"]');
await nm.click(); await W(500);
const ni = win.locator('.step-pop .ap-row:has(label:text-is("Name")) input');
await ni.fill('Arm up'); await ni.dispatchEvent('change'); await W(500);
const lab = await win.locator('.motion-strip .ms-name[data-i="1"]').textContent();
check('step Name → shown in the timeline', /^2\. Arm up/.test(lab.trim()), lab);
const m18 = await win.evaluate(() => lithApp.doc.doc.motion.steps[1].mate);
const tv = await win.evaluate((id) => { const m = lithApp.doc.doc.mates.find((x) => x.id === id); return [m.sense, !!m.flip]; }, m18);
const pf0 = await poses();
await win.locator('.step-pop .ap-row:has(label:text-is("Flip")) button').click(); await W(1200);
const fl = await win.evaluate((id) => ({ flips: lithApp.doc.doc.motion.flips || [], m: (() => { const m = lithApp.doc.doc.mates.find((x) => x.id === id); return [m.sense, !!m.flip]; })(), lab: document.querySelector('.motion-strip .ms-name[data-i="1"]').textContent }), m18);
check('Flip in the step popup: only this study (doc.motion.flips), the tree mate unchanged, model moved', fl.flips.includes(m18) && JSON.stringify(fl.m) === JSON.stringify(tv) && (await poses()) !== pf0 && /flipped/.test(fl.lab), JSON.stringify(fl));
await win.keyboard.press('Escape'); await W(300);
// several steps: click 1, Shift+click 3 → right-click › Delete Steps (3)
const nSteps = await win.evaluate(() => lithApp.doc.doc.motion.steps.length);
await win.locator('.motion-strip .ms-name[data-i="0"]').click(); await W(400); await win.keyboard.press('Escape'); await W(300);
await win.locator('.motion-strip .ms-name[data-i="2"]').click({ modifiers: ['Shift'] }); await W(400);
const nSel = await win.evaluate(() => lithApp.doc._mt.selIds.size);
const selBars = await win.locator('.motion-strip .ms-stepbar.sel').count();
const u2 = await win.evaluate(() => lithApp.doc.undoStack.length);
const hit = await menu(win.locator('.motion-strip .ms-name[data-i="1"]'), 'Delete Steps (3)');
const nAfter = await win.evaluate(() => lithApp.doc.doc.motion.steps.length);
check('Shift+click steps 1…3 → 3 selected (bars too) → right-click › Delete Steps (3): one undo step', nSel === 3 && selBars === 3 && hit && nAfter === nSteps - 3 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === u2 + 1, `sel ${nSel} bars ${selBars} steps ${nSteps} → ${nAfter}`);
await win.evaluate(() => lithApp.doc.undo()); await W(800);
check('undo → the 3 steps are back', (await win.evaluate(() => lithApp.doc.doc.motion.steps.length)) === nSteps);
// close the study → back at the tree pose
await win.locator('.motion-strip .ms-x').click(); await W(1200);
const pBack = await poses();
const dr = await win.evaluate(() => lithApp.doc.doc.mates.filter((m) => m._drive != null || m._flip).length);
check('closing the study → the model is back at the tree values (no study values left)', dr === 0 && (await win.evaluate(() => JSON.stringify(lithApp.doc.doc.mates.map((m) => [m.id, m.value, m.limits || null])))) === tree0, `${dr} still driven`);
void pBack;

// 4) tree: Shift+click range of mates → Delete (n), one undo step
const mates = await win.evaluate(() => lithApp.doc.doc.mates.map((m) => m.id));
await win.locator(`.tree .tr-row[data-item="mate:${mates[1]}"]`).last().click(); await W(300);
await win.locator(`.tree .tr-row[data-item="mate:${mates[4]}"]`).last().click({ modifiers: ['Shift'] }); await W(400);
const selM = await win.evaluate(() => lithApp.doc.sel.filter((s) => s.kind === 'mate').length);
const u3 = await win.evaluate(() => lithApp.doc.undoStack.length);
const hitD = await menu(win.locator(`.tree .tr-row[data-item="mate:${mates[2]}"]`).last(), 'Delete (4)');
check('tree: Shift+click mates 2…5 → 4 selected → right-click › Delete (4), one undo step', selM === 4 && hitD && (await win.evaluate(() => lithApp.doc.doc.mates.length)) === mates.length - 4 && (await win.evaluate(() => lithApp.doc.undoStack.length)) === u3 + 1, `sel ${selM}`);
await win.evaluate(() => lithApp.doc.undo()); await W(800);
// components range
const comps = await win.evaluate(() => lithApp.doc.doc.components.map((c) => c.id));
await win.keyboard.press('Shift+C'); await W(300);
await win.locator(`.tree .tr-row[data-item="comp:${comps[0]}"]`).click(); await W(300);
await win.locator(`.tree .tr-row[data-item="comp:${comps[3]}"]`).click({ modifiers: ['Shift'] }); await W(400);
const selC = await win.evaluate(() => lithApp.doc.sel.filter((s) => s.kind === 'comp').length);
check('tree: Shift+click components 1…4 → 4 selected', selC === 4, selC);
await win.keyboard.press('Escape'); await W(300);

// 5) Ctrl+click two parallel planar faces of two components → popup with the normal distance + status bar
const pair = await win.evaluate(() => {
  const d = lithApp.doc, r = d.vp.el.getBoundingClientRect(), hits = [];
  for (let y = 0.15; y < 0.95; y += 0.015) for (let x = 0.08; x < 0.95; x += 0.015) {
    const cx = r.left + r.width * x, cy = r.top + r.height * y, p = d.pickAt({ clientX: cx, clientY: cy });
    if (p?.kind === 'face' && p.geo?.t === 'plane') { const q1 = d.pickAt({ clientX: cx + 3, clientY: cy + 3 }), q2 = d.pickAt({ clientX: cx - 3, clientY: cy - 3 }); if (q1?.key === p.key && q2?.key === p.key) hits.push({ x: cx, y: cy, p }); }
  }
  const M = d.C.bind(d);
  const nW = (h) => { const c = M(h.p.comp), q = c.rot, v = h.p.geo.n; const [x, y, z, w] = q; const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2]; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    const a = hits[i], b = hits[j]; if (a.p.comp === b.p.comp) continue;
    const na = nW(a), nb = nW(b), dd = Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]);
    if (dd > 1 - 1e-6) return { a: [a.x, a.y], b: [b.x, b.y], la: a.p.label, lb: b.p.label };
  }
  return null;
});
check('found two parallel faces of two components in the view', !!pair, JSON.stringify(pair));
if (pair) {
  await win.mouse.click(pair.a[0], pair.a[1]); await W(400);
  await win.keyboard.down('Control'); await win.mouse.click(pair.b[0], pair.b[1]); await win.keyboard.up('Control'); await W(600);
  const mp = await win.evaluate(() => ({ pop: document.querySelector('.meas-pop')?.textContent || '', coords: document.querySelector('.st-coords')?.textContent || '', n: lithApp.doc.sel.length }));
  const num = parseFloat((mp.pop.match(/Normal distance([\d.,-]+)/) || [])[1]);
  const fromCoords = parseFloat((mp.coords.match(/([\d.]+) mm/) || [])[1]);
  check('Ctrl+click the second face → popup "Normal distance", the same value in the status bar corner', mp.n === 2 && Number.isFinite(num) && Math.abs(num - fromCoords) < 1e-6 && /Normal distance/.test(mp.coords), JSON.stringify(mp));
  await win.keyboard.press('Escape'); await W(400);
  check('Esc → popup closed, corner cleared', (await win.locator('.meas-pop').count()) === 0 && (await win.evaluate(() => document.querySelector('.st-coords')?.textContent || '')) === '');
}
// 6) part tree: Shift+click range of features → right-click shows Delete (n)
{
  const arm = await win.evaluate(() => lithApp.doc.doc.components.find((c) => c.name === 'Arm-1<1>').id);
  await win.locator(`.tree .tr-row[data-item="comp:${arm}"]`).dblclick(); await W(1000);
  for (let i = 0; i < 300 && !(await win.evaluate(() => !!lithApp.doc?._ctx && !document.getElementById('busy').classList.contains('on'))); i++) await W(100);
  const keys = await win.evaluate(() => lithApp.doc.doc.features.filter((f) => f.type !== 'sketch').map((f) => 'feature:' + f.id));
  await win.locator(`.tree .tr-row[data-item="${keys[0]}"]`).click(); await W(300);
  await win.locator(`.tree .tr-row[data-item="${keys[2]}"]`).click({ modifiers: ['Shift'] }); await W(400);
  const ps = await win.evaluate(() => lithApp.doc.sel.map((s) => s.key));
  await win.locator(`.tree .tr-row[data-item="${keys[1]}"]`).click({ button: 'right' }); await W(300);
  const items = await win.evaluate(() => [...document.querySelectorAll('.ctx-menu .ctx-item')].map((b) => b.textContent.trim()));
  await win.keyboard.press('Escape'); await W(200);
  const k0 = ps.indexOf(keys[0]), k2 = ps.indexOf(keys[2]);
  check('part tree: Shift+click a range of features → all rows between selected, right-click › Delete (n)', ps.length >= 3 && k0 >= 0 && k2 >= 0 && items.some((t) => t.startsWith(`Delete (${ps.length})`)), `${ps.join(',')} | ${items.join(',')}`);
}
const pe = T.logs.filter((l) => /pageerror|Uncaught/.test(l));
check('no page errors', pe.length === 0, pe.slice(0, 2).join(' | '));
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
