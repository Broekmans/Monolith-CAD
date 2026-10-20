// 0.1.95: OK / Cancel buttons + value box in the clicked view (focus), Fillet: click a face = all its edges, display
// style per view, ghost on a tree click, edited tree row blue, main value highlighted, dialogs movable.
// Needs ../scratch/hoesje.lithprt.
import fs from 'node:fs';
import { launch } from './common.mjs';
const ok = (c, m) => { console.log((c ? 'ok - ' : 'FAIL - ') + m); if (!c) process.exitCode = 1; };
const T = await launch('part'); const { win, W, idle } = T;
fs.mkdirSync('/tmp/cf', { recursive: true }); fs.copyFileSync('/home/claude/scratch/hoesje.lithprt', '/tmp/cf/h.lithprt');
await win.evaluate((p) => lithApp.open(p), '/tmp/cf/h.lithprt'); await W(5000); await idle();
await win.evaluate(() => { localStorage.removeItem('monolith.dlgPos.pm'); lithApp.doc.setViewLayout('four'); }); await W(800);
const paneRect = (i) => win.evaluate((i) => { const r = lithApp.doc.viewSet.panes[i].el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }, i);
// focus = pane 0 (click on empty space)
let r0 = await paneRect(0);
await win.mouse.click(r0[0] + 30, r0[3] - 30); await W(300);
// fillet dialog
await T.tab('Features'); await T.btn('Fillet'); await W(800); await idle();
const cc = await win.evaluate(() => { const c = document.querySelector('.views-wrap .corner'); const r = c.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, getComputedStyle(c).display]; });
const cube0 = await win.evaluate(() => { const r = lithApp.doc.viewSet.panes[0].viewCube.el.getBoundingClientRect(); return [r.left, r.top]; });
ok(cc[4] !== 'none' && cc[0] >= r0[0] && cc[2] <= r0[2] && cc[1] >= r0[1] && cc[3] <= r0[3] && cc[2] <= cube0[0], `OK/Cancel inside the clicked view, left of its cube ${JSON.stringify(cc)} pane ${JSON.stringify(r0)}`);
// moving the mouse over another view does not move them
const r3 = await paneRect(3);
await win.mouse.move(r3[0] + 50, r3[1] + 80, { steps: 5 }); await W(300);
const cc2 = await win.evaluate(() => { const r = document.querySelector('.views-wrap .corner').getBoundingClientRect(); return [r.left, r.top]; });
const box = await win.evaluate(() => { const b = document.querySelector('.feat-val'); return b ? lithApp.doc.viewSet.paneOf(b) === lithApp.doc.viewSet.panes[0] : null; });
ok(Math.abs(cc2[0] - cc[0]) < 1 && Math.abs(cc2[1] - cc[1]) < 1 && box === true, 'mouse over another view: buttons and value box stay in the clicked view');
// main value highlighted; empty Edges box still active
let st = await win.evaluate(() => { const i = document.querySelector('.pm-numrow input.pm-main'); return { main: !!i, focus: document.activeElement === i, sel: !!document.querySelector('.pm-selbox.active') }; });
ok(st.main && st.sel, 'Fillet: Radius marked as main value, empty Edges box active ' + JSON.stringify(st));
// click a face (top of the plate, pane 0) = all its edges
await win.mouse.move(r0[0] + 30, r0[3] - 30); await W(100);
const face = await win.evaluate(() => { const d = lithApp.doc, m = d.pick.mesh; const f = m.faces.filter((x) => x.plane).sort((a, b) => b.area - a.area)[0]; return { id: f.id, c: f.c, n: m.edges.filter((e) => e.faces?.includes(f.id)).length }; });
await win.evaluate((f) => { const d = lithApp.doc; d.clickItem({ kind: 'face', id: f.id, c: f.c, key: 'face:' + f.id }, false); }, face); await W(400);
st = await win.evaluate(() => lithApp.pm.current.values.edges.length);
ok(face.n >= 3 && st === face.n, `face click adds its ${face.n} edges (${st})`);
await win.evaluate((f) => { lithApp.doc.clickItem({ kind: 'face', id: f.id, c: f.c, key: 'face:' + f.id }, false); }, face); await W(300);
ok(await win.evaluate(() => lithApp.pm.current.values.edges.length) === 0, 'second click on the face removes them');
// dialog movable by its title strip, place remembered
const h0 = await win.evaluate(() => { const r = document.querySelector('.pm-float .pm-header').getBoundingClientRect(); return [r.left + 60, r.top + 10]; });
await win.mouse.move(h0[0], h0[1]); await win.mouse.down(); await win.mouse.move(h0[0] + 120, h0[1] + 60, { steps: 6 }); await win.mouse.up(); await W(200);
const pos = await win.evaluate(() => JSON.parse(localStorage.getItem('monolith.dlgPos.pm') || 'null'));
ok(pos && pos[0] === 120 && pos[1] === 60, 'dialog dragged 120, 60 and remembered ' + JSON.stringify(pos));
// cancel with the in-view ✕
await win.locator('.views-wrap .corner .cc.cancel').click(); await W(500); await idle();
ok(await win.evaluate(() => !lithApp.pm.open && getComputedStyle(document.querySelector('.views-wrap .corner')).display === 'none'), 'in-view ✕ cancels, buttons gone');
// edit Cut-Extrude1: depth highlighted + focused, filled Sketch box not active; tree row blue; dialog opens at the remembered place
await win.evaluate(() => { const d = lithApp.doc; d.editFeature(d.doc.features.find((f) => f.name === 'Cut-Extrude1').id); }); await W(1500); await idle();
st = await win.evaluate(() => { const i = document.querySelector('.pm-numrow input.pm-main'); const row = document.querySelector('.tr-row.editing'); return { main: !!i, focus: document.activeElement === i, sel: !!document.querySelector('.pm-selbox.active'), border: row && getComputedStyle(row).borderTopColor, tr: getComputedStyle(document.querySelector('.pm-float')).translate }; });
ok(st.main && st.focus && !st.sel, 'Cut-Extrude1: Depth highlighted and focused, Sketch Profile box not active ' + JSON.stringify(st));
ok(st.border === 'rgb(47, 125, 225)', 'edited tree row in theme blue ' + st.border);
ok(st.tr === '120px 60px', 'dialog opens where it was dragged ' + st.tr);
await win.keyboard.press('Escape'); await win.evaluate(() => lithApp.pm.cancel()); await W(800); await idle();
// display style per view: pane 1 wireframe, others stay shaded with edges; saved with the views
await win.evaluate(() => { const set = lithApp.doc.viewSet; set.setActive(set.panes[1]); lithApp.doc.setDisplay('wire'); }); await W(300);
st = await win.evaluate(() => { const d = lithApp.doc, set = d.viewSet; return set.panes.map((p) => { set.beforePane(p); return [p.displayMode || '-', d.bodyMesh.material.visible, d.edgeLines.visible]; }); });
ok(st[1][0] === 'wire' && st[1][1] === false && st[0][1] === true && st[0][2] === true, 'pane 1 wireframe, pane 0 shaded with edges ' + JSON.stringify(st));
await win.evaluate(() => { const set = lithApp.doc.viewSet; set.setActive(set.panes[2]); lithApp.doc.setDisplay('shaded'); }); await W(200);
st = await win.evaluate(() => { const d = lithApp.doc; d.beforeSave(); return d.doc.viewLayout.views.map((v) => v.d || '-'); });
ok(st[1] === 'wire' && st[2] === 'shaded' && st[0] === '-', 'styles saved per view ' + JSON.stringify(st));
await T.shot('confirm-styles');
// tree click on Cut-Extrude1 = ghost of the removed volume over the model (model unchanged)
const before = await win.evaluate(() => lithApp.doc.mesh.positions.length);
await win.locator('.tr-row:has-text("Cut-Extrude1")').first().click(); await W(2500); await idle();
st = await win.evaluate(() => ({ g: !!lithApp.doc.ghost?.overlay, n: lithApp.doc.ghostGroup.children.length, mesh: lithApp.doc.mesh.positions.length }));
ok(st.g && st.n > 0 && st.mesh === before, 'tree click: ghost shown over the unchanged model ' + JSON.stringify(st));
await T.shot('confirm-treeghost');
await win.evaluate(() => lithApp.doc.clickItem(null)); await W(300);
ok(await win.evaluate(() => !lithApp.doc.ghost), 'selection cleared: ghost gone');
await T.app.close();
