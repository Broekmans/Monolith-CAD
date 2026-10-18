// 0.1.81: Section View handles — glowing red dotted lines + arrow, dragged with the real mouse (moves the plane),
// hover, wheel, four views (handles per pane), Options colour.
import { launch } from './common.mjs';
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => lithApp.doc.insertComponent(null, null, { std: 'DIN912', size: 'M10', L: 40 })); await idle();
await T.btn('Section View'); await W(400);
await win.evaluate(() => lithApp.doc.vp.setView('iso', false)); await W(400);
const off = () => win.evaluate(() => lithApp.doc._secDraft?.offset ?? lithApp.doc.doc.sections.find((s) => s.id === lithApp.doc.doc.secActive)?.offset);
const hit = (i = 0) => win.evaluate((i) => { const p = lithApp.doc.viewSet.panes[i], h = p._secHit, r = p.el.getBoundingClientRect(); if (!h) return null;
  const mid = ([a, b], t = 0.3) => [r.left + a[0] + (b[0] - a[0]) * t, r.top + a[1] + (b[1] - a[1]) * t];
  return { line0: mid(h.lines[0]), line1: mid(h.lines[1], 0.75), arrow: h.arrow && mid(h.arrow, 0.6), ad: h.arrow && [h.arrow[1][0] - h.arrow[0][0], h.arrow[1][1] - h.arrow[0][1]] }; }, i);
let H = await hit();
console.log('1 handles drawn:', !!H, 'arrow dir', JSON.stringify(H?.ad?.map(Math.round)));
// red glow pixel on the line
const px = await (async () => { const r = { x: H.line0[0] - 6, y: H.line0[1] - 6, width: 12, height: 12 }; const png = (await win.screenshot({ clip: r })).toString('base64');
  return win.evaluate(async (png) => { const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, im.width, im.height).data; let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 110) red++; return red; }, png); })();
console.log('1 red pixels around the line:', px > 3);
// hover → cursor
await win.mouse.move(H.line0[0], H.line0[1]); await W(200);
console.log('2 hover line:', await win.evaluate(() => [lithApp.doc.viewSet.panes[0]._secHover, lithApp.doc.viewSet.panes[0].el.style.cursor || document.querySelector('.viewset').style.cursor]));
// drag the dotted line along the arrow direction → offset changes, label shown
const o0 = await off();
const L = Math.hypot(...H.ad), ux = H.ad[0] / L, uy = H.ad[1] / L;
await win.mouse.down(); await win.mouse.move(H.line0[0] + ux * 40, H.line0[1] + uy * 40, { steps: 6 }); await W(150);
const lab = await win.evaluate(() => lithApp.doc.viewSet.panes[0]._secLabel?.[2]);
await win.mouse.up(); await W(300);
const o1 = await off();
console.log('3 drag line 40 px:', o0, '→', o1, 'label while dragging', lab, 'moved', Math.abs(o1 - o0) > 1);
// drag back the other way with the second line
H = await hit();
await win.mouse.move(H.line1[0], H.line1[1]); await win.mouse.down(); await win.mouse.move(H.line1[0] - ux * 40, H.line1[1] - uy * 40, { steps: 6 }); await win.mouse.up(); await W(300);
const o2 = await off();
console.log('4 drag line 2 back 40 px:', o2, 'back near start', Math.abs(o2 - o0) < 0.5);
// arrow drag + wheel
H = await hit();
if (H.arrow) { await win.mouse.move(H.arrow[0], H.arrow[1]); await win.mouse.down(); await win.mouse.move(H.arrow[0] + ux * 30, H.arrow[1] + uy * 30, { steps: 5 }); await win.mouse.up(); await W(300); }
const o3 = await off();
console.log('5 drag arrow 30 px:', o2, '→', o3, 'moved', Math.abs(o3 - o2) > 1);
H = await hit(); await win.mouse.move(H.line0[0], H.line0[1]); await win.mouse.wheel(0, -100); await W(300);
console.log('6 wheel over line:', o3, '→', await off());
// nothing else got picked / camera did not rotate during drags
console.log('7 camera still iso:', await win.evaluate(() => lithApp.doc.vp.viewDir().toArray().map((v) => Math.round(v * 100) / 100).join()));
await T.ok(); await W(300);
// four views: drag in pane 3 (handles per pane)
await win.evaluate(() => lithApp.onMenu('layout', 'four')); await W(800);
const H3 = await hit(3);
const o4 = await off();
const L3 = Math.hypot(...(H3.ad || [1, 0])), u3 = H3.ad ? [H3.ad[0] / L3, H3.ad[1] / L3] : [0, -1];
await win.mouse.move(H3.line0[0], H3.line0[1]); await win.mouse.down(); await win.mouse.move(H3.line0[0] + u3[0] * 30, H3.line0[1] + u3[1] * 30, { steps: 5 }); await win.mouse.up(); await W(300);
const o5 = await off();
console.log('8 four views, pane 3 has handles', !!H3, 'drag:', o4, '→', o5, 'moved', Math.abs(o5 - o4) > 0.5, 'saved section dirty', await win.evaluate(() => lithApp.doc.app.dirty ?? null));
// Options: colour
await win.evaluate(() => lithApp.applyOptions({ secColor: '#00ff00' })); await W(300);
console.log('9 colour option', await win.evaluate(() => lithApp.doc.viewSet.panes[0]._secHit != null));
await win.evaluate(() => lithApp.applyOptions({ secColor: '#ff3b2f' })); await T.shot('sec3');
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
