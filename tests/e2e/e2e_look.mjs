// Look check: fixed screenshots of a part, a sketch (light + dark) and model dimensions, to compare two builds pixel by pixel
// after a refactor (python3 tests/e2e/cmp_shots.py <dirA> <dirB>). Needs ../scratch/stonex001.lithprt. Shots: tests/e2e/shots/look-*.png
import fs from 'node:fs';
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/look', { recursive: true }); fs.copyFileSync('/home/claude/scratch/stonex001.lithprt', '/tmp/look/s.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/look/s.lithprt'); await W(9000); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.vp.setView?.('iso'); }); await W(1500);
await win.mouse.move(5, 5); await T.shot('look-part');
await win.evaluate(() => { const d = lithApp.doc; d.editSketch(d.doc.features.find((f) => f.name === 'Sketch4').id); }); await W(2500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.vp.normalTo(d.sketcher.fr); }); await W(1200);
await win.mouse.move(5, 5); await T.shot('look-sketch');
await win.evaluate(() => { const s = lithApp.doc.sketcher; s.sel.clear(); for (const g of s.sk.geo.slice(0, 6)) s.sel.add('geo:' + g.id); s.vp.requestRender?.(); s.redraw?.(); }); await W(600);
await T.shot('look-sketch-sel');
await win.evaluate(() => lithApp.setTheme?.(true)); await W(1200); await T.shot('look-sketch-dark');
await win.evaluate(() => lithApp.setTheme?.(false)); await W(800);
await win.evaluate(() => lithApp.doc.sketcher && lithApp.doc.exitSketch?.(false)); await W(2500); await idle();
await T.app.close();
