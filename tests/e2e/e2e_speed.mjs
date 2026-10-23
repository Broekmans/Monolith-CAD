// Speed (0.1.107): a part opens with the model saved in the file at once (full rebuild behind it); the edit dialog
// (double click) reuses the preview of the tree click. Needs ../scratch/tekst.lithprt (Wouter's "Tekst test" part:
// sketch text cut + boss, slow to build). Prints times; checks: saved model shown < 3 s, edit preview shared.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
fs.mkdirSync('/tmp/spd', { recursive: true }); fs.copyFileSync('/home/claude/scratch/tekst.lithprt', '/tmp/spd/t.lithprt');
const T = await launch('part'); const { win, W, idle } = T;
await win.evaluate(() => { window.__L = []; const o = window.__lithLog; window.__lithLog = (...a) => { window.__L.push(a.join(' ')); return o?.(...a); }; });
const busy = () => win.evaluate(() => document.getElementById('busy').classList.contains('on'));
let want = null;
const waitIdle = async (max = 900000) => { const t0 = Date.now(); await W(300); while ((await busy()) || !(await win.evaluate((w) => lithApp.path === w && !!lithApp.doc?.status?.length && !!lithApp.doc?.bodyMesh, want))) { if (Date.now() - t0 > max) return -1; await W(250); } return Date.now() - t0; };
// 1. first open (file without saved model): full rebuild
let t0 = Date.now(); want = '/tmp/spd/t.lithprt';
await win.evaluate((p) => lithApp.open(p), '/tmp/spd/t.lithprt');
const full = await waitIdle();
console.log('open without saved model: rebuilt in', full + (Date.now() - t0 - full), 'ms');
check('built', await win.evaluate(() => !!lithApp.doc.bodyMesh));
// save a copy (with the saved model)
await win.evaluate(async () => { lithApp.path = '/tmp/spd/t2.lithprt'; await lithApp.save(); });
const hasCache = JSON.parse(fs.readFileSync('/tmp/spd/t2.lithprt', 'utf8')).cache?.mesh?.positions?.length > 0;
check('saved file has the model', hasCache);
fs.copyFileSync('/tmp/spd/t2.lithprt', '/tmp/spd/t3.lithprt'); want = '/tmp/spd/t3.lithprt'; // a new tab (t2 is open already)
// 2. reopen: model visible at once
t0 = Date.now();
await win.evaluate((p) => { lithApp.open(p); }, '/tmp/spd/t3.lithprt');
let shown = -1; for (let i = 0; i < 60; i++) { if (await win.evaluate((w) => lithApp.path === w && !!lithApp.doc?.bodyMesh && !lithApp.doc.status?.length, want)) { shown = Date.now() - t0; break; } await W(100); }
check('saved model shown fast', shown >= 0 && shown < 3000, shown + ' ms');
await win.mouse.move(5, 5); await T.shot('spd1_shown_while_rebuilding');
const rb = await waitIdle();
console.log('background rebuild done after', Date.now() - t0, 'ms');
check('rebuild log', await win.evaluate(() => window.__L.some((l) => l.includes('OPEN saved model shown'))));
// 3. tree click on Cut-Extrude1, then double click (edit) right away: preview shared, not calculated twice
const fid = await win.evaluate(() => lithApp.doc.doc.features.find((f) => f.name === 'Cut-Extrude1').id);
await win.evaluate(() => { window.__L.length = 0; });
t0 = Date.now();
await win.evaluate((id) => { const d = lithApp.doc; d.sel = [{ kind: 'feature', id, key: 'feature:' + id }]; d.afterSelection(); }, fid);
await W(400);
await win.evaluate((id) => lithApp.doc.editFeature(id), fid);
let ghost = -1; for (let i = 0; i < 1200; i++) { if (await win.evaluate(() => !!lithApp.doc.ghost && !lithApp.doc.ghost.overlay)) { ghost = Date.now() - t0; break; } await W(250); }
console.log('edit preview shown after', ghost, 'ms (from the tree click)');
check('edit preview shown', ghost > 0);
check('preview calculated once (shared)', await win.evaluate(() => window.__L.filter((l) => l.includes('PREVIEW shared')).length >= 1), JSON.stringify(await win.evaluate(() => window.__L.filter((l) => /PREVIEW|DISPLAY/.test(l)))));
await T.shot('spd2_edit_preview');
// 4. cancel, click again + edit again: everything from the cache now (instant)
await win.evaluate(() => lithApp.pm.cancel()); await waitIdle();
t0 = Date.now();
await win.evaluate((id) => { const d = lithApp.doc; d.sel = [{ kind: 'feature', id, key: 'feature:' + id }]; d.afterSelection(); }, fid);
await win.evaluate((id) => lithApp.doc.editFeature(id), fid);
ghost = -1; for (let i = 0; i < 400; i++) { if (await win.evaluate(() => !!lithApp.doc.ghost && !lithApp.doc.ghost.overlay)) { ghost = Date.now() - t0; break; } await W(100); }
check('second edit preview quick', ghost >= 0 && ghost < 5000, ghost + ' ms');
await win.evaluate(() => lithApp.pm.cancel()); await waitIdle();
await T.app.close();
console.log('ERRORS:', errs.length ? errs.join('; ') : 'none');
