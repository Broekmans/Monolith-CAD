import { launch } from './common.mjs';
const T = await launch('part');
const { win, W } = T;
const errs = () => T.logs.filter(l => /pageerror|error/i.test(l));
await win.locator('.tr-row:has-text("Right Plane")').click();
await T.tab('Sketch'); await T.btn('Sketch'); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.scale = 0.35; vp.requestRender(); });
await T.btn('Straight Slot'); await T.click(-30, 0); await T.click(30, 0); await T.click(0, 10); await win.keyboard.press('Escape');
await T.btn('Centerpoint Arc'); await T.click(0, 40); await T.click(20, 40); await T.click(0, 60); await win.keyboard.press('Escape');
await T.btn('3 Point Arc'); await T.click(-40, 30); await T.click(-20, 30); await T.click(-30, 38); await win.keyboard.press('Escape');
await T.btn('Point'); await T.click(40, 40); await win.keyboard.press('Escape');
// select two lines of the slot and add equal, select a line and toggle construction
await win.keyboard.press('Escape');
const slotLines = await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter(g => g.type === 'line' && !g.construction).map(g => g.id));
console.log('slot lines', slotLines.length);
// click on top slot line (y=10)
await T.click(0, 10);
console.log('rels', await win.evaluate(() => [...document.querySelectorAll('.sp-rel')].map(b => b.textContent).join(',')));
await win.locator('.sp-rel:has-text("Horizontal")').click().catch(() => {});
// drag the arc's start point
const [px, py] = await T.P(20, 40); await win.mouse.move(px, py); await win.mouse.down(); await win.mouse.move(px + 30, py - 20, { steps: 5 }); await win.mouse.up(); await W(300);
// box select all and delete via key, then undo
const a = await T.P(-60, 70), b = await T.P(60, -20);
await win.mouse.move(a[0], a[1]); await win.mouse.down(); await win.mouse.move(b[0], b[1], { steps: 5 }); await win.mouse.up(); await W(200);
console.log('selected', await win.evaluate(() => lithApp.doc.sketcher.sel.size));
await win.keyboard.press('Delete'); await W(200);
console.log('after delete geo', await win.evaluate(() => lithApp.doc.sketcher.sk.geo.length));
await win.keyboard.press('Control+z'); await W(300);
console.log('after undo geo', await win.evaluate(() => lithApp.doc.sketcher.sk.geo.length));
await T.shot('m1_sketch');
await win.locator('.cc.ok').click(); await T.idle();
await T.tab('Features'); await T.btn('Extruded Boss'); await T.idle();
await win.locator('.pm-field select').first().selectOption('midplane'); await T.idle();
await T.num(0, 40); await T.ok();
console.log('status', await win.evaluate(() => JSON.stringify(lithApp.doc.status.map(s => s.state + (s.error || '')))));
// rollback + suppress + delete via context menus (API)
await win.evaluate(() => lithApp.doc.setRollback(0)); await T.idle();
console.log('rolled', await win.evaluate(() => lithApp.doc.mesh?.faces.length ?? 0));
await win.evaluate(() => lithApp.doc.setRollback(null)); await T.idle();
await win.evaluate(() => { const f = lithApp.doc.doc.features.find(f => f.type === 'extrude'); f.suppressed = true; lithApp.doc.regen(); }); await T.idle();
console.log('suppressed faces', await win.evaluate(() => lithApp.doc.mesh?.faces.length ?? 0));
await win.evaluate(() => { const f = lithApp.doc.doc.features.find(f => f.type === 'extrude'); f.suppressed = false; lithApp.doc.regen(); }); await T.idle();
// convert entities: new sketch on Front plane, convert an edge
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(300);
await win.locator('.tr-row:has-text("Front Plane")').click();
await T.tab('Sketch'); await T.btn('Sketch'); await W(800);
await win.evaluate(() => lithApp.doc.zoomFit()); await W(300);
await T.btn('Convert Entities'); await W(200);
const edge = await win.evaluate(() => { const e = lithApp.doc.mesh.edges.find(e => e.type === 'line' && Math.abs(e.mid[0] - 20) < 1e-3); if (!e) return null; const vp = lithApp.doc.vp; const r = vp.el.getBoundingClientRect(); const s = vp.toScreen(e.mid); return [r.left + s[0], r.top + s[1]]; });
console.log('convert edge at', edge);
if (edge) { await win.mouse.click(edge[0], edge[1]); await W(300); }
await win.keyboard.press('Escape');
console.log('converted geo', await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter(g => g.type !== 'point').length));
await win.locator('.cc.cancel').click(); await T.idle();
// save to temp path and reopen
const path = '/tmp/monolith_test.lithprt';
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.doc)); }, path);
await win.evaluate(async (p) => { lithApp.dirty = false; lithApp.path = null; lithApp.doc.doc.features = []; await lithApp.open(p); }, path); await W(3000); await T.idle();
console.log('reopened', await win.evaluate(() => lithApp.doc.doc.features.length + ' ' + JSON.stringify(lithApp.doc.status.map(s => s.state))));
await T.shot('m2_reopened');
console.log('ERRORS:', errs().join('\n') || 'none');
await T.app.close();
