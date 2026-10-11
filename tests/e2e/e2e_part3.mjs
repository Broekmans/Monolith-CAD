import { launch } from './common.mjs';
const T = await launch('part');
const { win, W } = T;
// Revolve: sketch on Front plane: centerline on Y axis, closed profile
await win.locator('.tr-row:has-text("Front Plane")').click();
await T.tab('Sketch'); await T.btn('Sketch'); await W(700);
await win.evaluate(() => { const vp = lithApp.doc.vp; const sk = lithApp.doc.sketcher; vp.scale = 0.2; const off = vp.camera.position.clone().sub(vp.target); vp.target.set(...sk.to3([20, 25])); vp.camera.position.copy(vp.target).add(off); vp.requestRender(); });
await T.btn('Centerline'); await T.click(0, -10); await T.click(0, 60); await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
await T.btn('Line');
await T.click(10, 0); await T.click(40, 0); await T.click(40, 10); await T.click(20, 20); await T.click(20, 50); await T.click(10, 50); await T.click(10, 0);
await win.keyboard.press('Escape');
await T.btn('Tangent Arc'); await T.click(20, 50); 
// tangent arc from end of vertical line (20,20)->(20,50)
await T.click(30, 60); await win.keyboard.press('Escape');
await T.shot('r1_profile');
const st = await win.evaluate(() => ({ st: document.querySelector('.st-sketch').textContent, n: lithApp.doc.sketcher.sk.geo.length, cons: lithApp.doc.sketcher.sk.cons.map(c=>c.type).join(',') }));
console.log('profile', JSON.stringify(st));
// trim: remove the tangent arc again via trim tool click on arc
await T.btn('Trim Entities');
const arcMid = await win.evaluate(() => { const sk = lithApp.doc.sketcher; const a = sk.sk.geo.find(g=>g.type==='arc'); if (!a) return null; const c = sk.curveOf(a); let sw = c.a1 - c.a0; while (sw <= 0) sw += Math.PI*2; const t = c.a0 + sw/2; return [c.c[0] + c.r*Math.cos(t), c.c[1] + c.r*Math.sin(t)]; });
console.log('arc mid', arcMid);
if (arcMid) await T.click(arcMid[0], arcMid[1]);
await win.keyboard.press('Escape');
console.log('after trim geo', await win.evaluate(() => lithApp.doc.sketcher.sk.geo.filter(g=>g.type!=='point').map(g=>g.type).join(',')));
await win.locator('.cc.ok').click(); await T.idle();
await T.tab('Features'); await T.btn('Revolved Boss'); await T.idle();
console.log('axis options', await win.evaluate(() => [...document.querySelectorAll('.pm-field select option')].map(o=>o.textContent).join(' | ')));
await T.ok();
await win.evaluate(() => { lithApp.doc.vp.setView('iso', false); lithApp.doc.zoomFit(); });
await T.shot('r2_revolve');
console.log('status', await win.evaluate(() => JSON.stringify(lithApp.doc.status.map(s=>s.state+(s.error||'')))));
// Chamfer the top outer circular edge
const circ = await win.evaluate(() => lithApp.doc.mesh.edges.filter(e=>e.type==='circle').map(e=>({mid:e.mid, p:[e.pts[0],e.pts[1],e.pts[2]], id: e.id})));
console.log('circle edges', circ.length);
const outer = circ.sort((a,b)=> (b.mid[1]-a.mid[1]))[0];
await T.btn('Chamfer'); await T.idle();
// pick a point on that edge at quarter
const pt = await win.evaluate((id) => { const e = lithApp.doc.mesh.edges.find(x=>x.id===id); const i = Math.floor(e.pts.length/3/4)*3; return [e.pts[i],e.pts[i+1],e.pts[i+2]]; }, outer.id);
await T.clickWorld(pt);
await T.num(0, 2); await T.ok();
console.log('after chamfer', await win.evaluate(() => JSON.stringify(lithApp.doc.status.map(s=>s.state+(s.error||'')))));
// Mass properties dialog
await T.tab('Evaluate'); await T.btn('Mass Properties'); await W(1500);
await T.shot('r3_mass');
await win.locator('.dlg-buttons button').click();
// Circular pattern of a cut hole: sketch on top face
await T.tab('Features');
console.log(T.logs.length);
await T.app.close();
