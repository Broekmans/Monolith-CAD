// 0.1.115: a part saved before 0.1.93 (Wouter's Stonex-01-001-000, 11-10-2026) had `refKey` on a REAL sketch line;
// since 0.1.93 that meant "invisible reference" → Sketch2 open contour, Boss-Extrude2 + Fillet1/2/5 errors.
// The part format step 1 → 2 (shared/format.mjs) drops it on open. Needs ../scratch/s0/saved.lithprt (copy of
// CAD Program\Saved parts\Stonex-01-001-000.lithprt). Opens it through lithApp.open (format upgrade + auto-link).
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
fs.mkdirSync('/tmp/orf', { recursive: true }); fs.copyFileSync('/home/claude/scratch/s0/saved.lithprt', '/tmp/orf/s.lithprt');
const T = await launch('part'); const { win, W, idle } = T;
await win.evaluate((p) => lithApp.open(p), '/tmp/orf/s.lithprt'); await W(8000); await idle(); await W(3000); await idle();
const st = await win.evaluate(() => {
  const d = lithApp.doc, s = d.status || d.featStatus || d.lastStatus || [];
  const bad = (Array.isArray(s) ? s : Object.values(s)).filter((x) => x && x.state && x.state !== 'ok').map((x) => `${x.name || x.id}:${x.state}`);
  const sk2 = d.doc.features.find((f) => f.name === 'Sketch2');
  return { version: d.doc.version, bad, statusLen: Array.isArray(s) ? s.length : Object.keys(s).length, g48: sk2.geo.find((g) => g.id === 'g48'), faces: d.bodyMesh?.userData?.faces?.length ?? null, tree: [...document.querySelectorAll('.tree .err, .tree .warn, .tr.err, .tr.warn')].map((e) => e.textContent.trim()).slice(0, 10) };
});
console.log(JSON.stringify(st));
check('upgraded to part format 2', st.version === 2, String(st.version));
check('Sketch2 line g48 is a normal line again', st.g48 && !st.g48.refKey && !st.g48.construction, JSON.stringify(st.g48));
check('no rebuild errors / warnings', st.statusLen > 0 && st.bad.length === 0 && st.tree.length === 0, JSON.stringify({ bad: st.bad, tree: st.tree }));
const shown = await win.evaluate(() => lithApp.doc.sketcher ? null : !!lithApp.doc.bodyMesh);
check('model shown', shown === true);
await T.shot('orf_stonex000');
console.log('ERRORS:', errs.length ? errs.join(', ') : 'none');
await T.app.close(); process.exit(errs.length ? 1 : 0);
