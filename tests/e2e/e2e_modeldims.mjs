// 0.1.85: dimensions on the model (double-clicked face) with extension lines, dimension lines and arrows like in the
// sketch; depth gets a line along the extrude direction. Needs ../scratch/hoesje.lithprt. Screenshots in tests/e2e/shots.
import fs from 'node:fs';
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/md', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/md/hoesje.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/md/hoesje.lithprt'); await W(5000); await idle();
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const show = async (name, view) => {
  return win.evaluate(([name, view]) => {
    const d = lithApp.doc, f = d.doc.features.find((x) => x.name === name);
    d.vp.setView(view, false); d.zoomFit(); d.showFeatureDims(f.id); d.vp.requestRender();
    return d.featureDims().map((x) => x.kind + ':' + x.text + (x.line ? ':line' : ''));
  }, [name, view]);
};
let L = await show('Cut-Extrude1', 'iso'); await W(600); await T.shot('modeldims-cut-iso');
console.log(L.join(' | '));
ok(L.some((x) => x === 'feat:Depth 5 mm:line'), '1 cut depth has a dimension line');
const hits = await win.evaluate(() => lithApp.doc._dimHits.map((h) => h.text + '@' + Math.round(h.x0) + ',' + Math.round(h.y0)));
console.log(hits.join(' '));
// label moved onto the dimension line: compare with lines off
await win.evaluate(() => lithApp.applyOptions({ modelDimLines: false })); await W(400);
const hits0 = await win.evaluate(() => lithApp.doc._dimHits.map((h) => h.text + '@' + Math.round(h.x0) + ',' + Math.round(h.y0)));
ok(hits0.join() !== hits.join(), '2 option off: labels back at their plain positions');
await win.evaluate(() => lithApp.applyOptions({ modelDimLines: true })); await W(300);
L = await show('Boss-Extrude1', 'right'); await W(600); await T.shot('modeldims-sketch1-right');
L = await show('Boss-Extrude1', 'iso'); await W(600); await T.shot('modeldims-sketch1-iso');
// double-click on a label still edits
const h = await win.evaluate(() => { const d = lithApp.doc, x = d._dimHits.find((k) => k.kind === 'cons'); const r = d.vp.el.getBoundingClientRect(); return x && { x: r.left + (x.x0 + x.x1) / 2, y: r.top + (x.y0 + x.y1) / 2, t: x.text }; });
await win.mouse.move(h.x, h.y); await win.mouse.dblclick(h.x, h.y); await W(400);
ok(await win.evaluate(() => !!document.querySelector('.dim-inline')), '3 double-click on ' + h.t + ' opens the inline editor');
await win.keyboard.press('Escape');
// 0.1.86: drag labels
const lab = (t) => win.evaluate((t) => { const d = lithApp.doc, x = d._dimHits.find((k) => k.text === t); const r = d.vp.el.getBoundingClientRect(); return x && { x: r.left + (x.x0 + x.x1) / 2, y: r.top + (x.y0 + x.y1) / 2 }; }, t);
const drag = async (p, dx, dy, esc) => { await win.mouse.move(p.x, p.y); await win.mouse.down(); for (let i = 1; i <= 6; i++) await win.mouse.move(p.x + dx * i / 6, p.y + dy * i / 6); if (esc) await win.keyboard.press('Escape'); await win.mouse.up(); await W(300); };
const c34 = () => win.evaluate(() => { const c = lithApp.doc.doc.features.find((f) => f.name === 'Sketch1').cons.find((x) => x.id === 'c34'); return { lp: c.lp.map((v) => +v.toFixed(1)), user: !!c.lpUser }; });
const before = await c34(); let p = await lab('148');
await drag(p, 0, -60);
const after = await c34(); const p2 = await lab('148');
console.log(JSON.stringify(before), JSON.stringify(after), JSON.stringify(p), JSON.stringify(p2));
ok(after.user && JSON.stringify(after.lp) !== JSON.stringify(before.lp) && Math.abs(p2.y - p.y) > 30, '5 drag 148 label: moved on screen, lp stored with lpUser');
await win.evaluate(() => lithApp.doc.undo()); await W(500); await idle();
await win.evaluate(() => { const d = lithApp.doc; d.showFeatureDims(d.doc.features.find((x) => x.name === 'Boss-Extrude1').id); }); await W(300);
ok(JSON.stringify(await c34()) === JSON.stringify(before), '6 undo puts it back');
p = await lab('148'); await drag(p, 50, 0, true);
ok(JSON.stringify(await c34()) === JSON.stringify(before), '7 Esc during the drag puts it back');
p = await lab('Depth 12 mm'); await drag(p, 80, 0);
const dep = await win.evaluate(() => lithApp.doc.doc.features.find((x) => x.name === 'Boss-Extrude1').depthAt);
ok(Array.isArray(dep), '8 depth label dragged: depthAt ' + JSON.stringify(dep?.map((v) => +v.toFixed(1))));
const au = await win.evaluate(() => lithApp.doc._dimHits.filter((k) => k.kind === 'auto').map((k) => k.text)); p = await lab(au[0]); await drag(p, 40, 40);
ok(await win.evaluate(() => Object.keys(lithApp.doc.doc.features.find((x) => x.name === 'Sketch1').autoLp || {}).length === 1), '9 dashed size ' + au[0] + ' dragged: stored in autoLp');
await T.shot('modeldims-dragged');
// keep labels near: a far stored lp is drawn next to the line
const near = await win.evaluate(() => { const d = lithApp.doc, c = d.doc.features.find((f) => f.name === 'Sketch1').cons.find((x) => x.id === 'c35'); c.lp = [0, -2000]; delete c.lpUser; d.vp.requestRender(); return true; });
await W(400); p = await lab('74'); const vpR = await win.evaluate(() => { const r = lithApp.doc.vp.el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
ok(p && p.x > vpR[0] && p.x < vpR[2] && p.y > vpR[1] && p.y < vpR[3], '10 far stored label drawn near its dimension (on screen)');
await win.evaluate(() => { const d = lithApp.doc; d.setViewLayout('single'); d.editSketch(d.doc.features.find((f) => f.name === 'Sketch1').id); }); await W(2500); await idle();
ok(await win.evaluate(() => lithApp.doc.sketcher._hitsBy.get(lithApp.doc.vp.pane).dims.length === 4), '4 sketch edit still draws its 4 dimensions');
await T.shot('modeldims-sketchedit'); await win.evaluate(() => lithApp.doc.exitSketch(false)); await W(800);
await win.evaluate(() => lithApp.onMenu('theme', true)); await W(500); await T.shot('modeldims-sketch1-iso-dark');
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
