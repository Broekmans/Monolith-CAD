import { launch } from './common.mjs';
import path from 'node:path';
const kind = process.argv[2] || 'plan';
const T = await launch(kind);
const { win, W } = T;
const file = path.resolve('scratch/pc/room.laz');
const p = win.evaluate((f) => lithApp.importPointCloud(f), file);
await win.waitForSelector('.dlg'); await W(300);
await T.shot(`pc0_dialog_${kind}`);
console.log('dialog', await win.evaluate(() => document.querySelector('.dlg-body').innerText.replace(/\n/g, ' | ').slice(0, 300)));
await win.locator('.dlg-buttons button.primary').click();
await p; await T.idle(); await W(1500);
console.log('loaded', await win.evaluate(() => { const d = lithApp.doc; const v = [...d.clouds.views.values()][0]; return v ? v.data.kept + ' box ' + [v.box.min.x, v.box.min.y, v.box.min.z, v.box.max.x, v.box.max.y, v.box.max.z].map(x => x.toFixed(0)).join(',') : 'none'; }));
if (kind === 'plan') {
  await win.evaluate(() => { const d = lithApp.doc; d.vp3.setView('iso', false); const v = [...d.clouds.views.values()][0]; d.vp3.fit(v.box); d.vp3.requestRender(); });
  await T.shot('pc1_plan');
  // floor plan slice
  await win.locator('button:has-text("Floor plan slice")').click(); await W(500);
  await T.shot('pc2_plan_slice');
  // trace a wall snapping to scan points
  await win.locator('.viewport.paper').first().click({ position: { x: 5, y: 5 } }); await win.keyboard.press('Escape');
  await T.cmd('WALL');
  const s1 = await win.evaluate(() => { const d = lithApp.doc; return d.snap([300, 500]); });
  console.log('snap near corner', JSON.stringify(s1));
  await T.clickPlan(300, 500); await T.clickPlan(8200, 500); await win.keyboard.press('Escape');
  console.log('walls', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.entities.filter(e => e.type === 'wall').map(w => [w.a.map(Math.round), w.b.map(Math.round)]))));
  await T.shot('pc3_traced');
  // save + reopen keeps the cloud
  const doc = await win.evaluate(() => JSON.stringify(lithApp.doc.doc));
  await win.evaluate(async (d) => { lithApp.dirty = false; await lithApp.loadDoc(JSON.parse(d)); }, doc); await W(3000); await T.idle();
  console.log('reopened clouds', await win.evaluate(() => lithApp.doc.clouds.views.size));
} else {
  await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); }); await W(400);
  await T.shot('pc1_part');
  await win.locator('.tr-row:has-text("room.laz")').click(); await W(400);
  await win.locator('.pm-body select').selectOption('elevation'); await W(300);
  await T.shot('pc2_part_elev');
}
console.log('ERRORS:', T.logs.filter(l => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
