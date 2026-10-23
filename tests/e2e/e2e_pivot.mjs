// 0.1.136: middle-drag rotation turns about the point under the mouse (Options › View / Mouse "Rotate about the point
// under the mouse", default on): real middle drags in a part (Arm-1) and the Bucket assembly — the clicked model point
// stays on the same pixel; empty space → the centre of what is visible stays put; the orange rotation-centre mark
// shows while dragging and is gone after; Options off → the old behaviour (turns about the view's centre).
// Needs ../scratch/motion/ (Arm-1.lithprt) and ../scratch/b300/ (Bucket assembly); copies in /tmp/pv.
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/pv'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync('/home/claude/scratch/motion/Arm-1.lithprt', `${DIR}/Arm-1.lithprt`);
for (const f of fs.readdirSync('/home/claude/scratch/b300')) fs.copyFileSync(`/home/claude/scratch/b300/${f}`, `${DIR}/${f}`);
const T = await launch('part');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); });
const open = async (p, asm) => {
  await win.evaluate(async ([p, asm]) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && (asm ? d.doc?.kind === 'assembly' && d.doc.components.every((c) => c._part) : d.mesh)) { clearInterval(iv); r(); } }, 50); }); }, [p, asm]);
  await W(1200); await idle();
};
// a screen point (page px) on the model near the middle of the view + its world point (found with the view's own ray)
const modelPoint = () => win.evaluate(() => {
  const vp = lithApp.doc.vp, r = vp.el.getBoundingClientRect(), ms = [];
  vp.scene.traverseVisible((o) => { if (o.isMesh && !o.userData.isCap) ms.push(o); });
  let best = null;
  for (let i = 0; i < 400 && !best; i++) {
    const a = i * 2.4, rad = 4 * Math.sqrt(i), sx = vp.width / 2 + Math.cos(a) * rad * 4, sy = vp.height / 2 + Math.sin(a) * rad * 4;
    const h = vp.ray(sx, sy).intersectObjects(ms, false)[0];
    if (h) best = { x: r.left + sx, y: r.top + sy, p: h.point.toArray() };
  }
  return best;
});
const emptyPoint = () => win.evaluate(() => { // a corner of the view with nothing under it
  const vp = lithApp.doc.vp, r = vp.el.getBoundingClientRect(), ms = [];
  vp.scene.traverseVisible((o) => { if (o.isMesh && !o.userData.isCap) ms.push(o); });
  for (const [fx, fy] of [[0.88, 0.2], [0.12, 0.25], [0.85, 0.75], [0.2, 0.8]]) { const sx = vp.width * fx, sy = vp.height * fy; if (!vp.ray(sx, sy).intersectObjects(ms, false).length) return { x: r.left + sx, y: r.top + sy }; }
  return null;
});
const scr = (p) => win.evaluate((p) => { const vp = lithApp.doc.vp, r = vp.el.getBoundingClientRect(), s = vp.toScreen(p); return [r.left + s[0], r.top + s[1]]; }, p);
const camQ = () => win.evaluate(() => lithApp.doc.vp.camera.quaternion.toArray());
const middleDrag = async (x, y, dx, dy, during) => {
  await win.mouse.move(x, y); await W(100);
  await win.mouse.down({ button: 'middle' });
  await win.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  const mid = during ? await during() : null;
  await win.mouse.move(x + dx, y + dy, { steps: 6 });
  await win.mouse.up({ button: 'middle' }); await W(300);
  return mid;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const run = async (what) => {
  const mp = await modelPoint();
  check(`${what}: found a model point in the view`, !!mp, JSON.stringify(mp));
  if (!mp) return;
  const q0 = await camQ();
  const mark = await middleDrag(mp.x, mp.y, 90, 50, () => win.evaluate(() => { const vp = lithApp.doc.vp; return { on: !!vp._pivotMark, p: vp._pivotMark?.toArray() }; }));
  const after = await scr(mp.p), q1 = await camQ();
  check(`${what}: middle drag on the model turns the view, the clicked point stays on the same pixel`, dist(after, [mp.x, mp.y]) < 1.5 && q0.some((v, i) => Math.abs(v - q1[i]) > 0.01), `moved ${dist(after, [mp.x, mp.y]).toFixed(2)} px`);
  const markGone = await win.evaluate(() => !lithApp.doc.vp._pivotMark);
  check(`${what}: rotation centre mark shown while dragging (at the clicked point), gone after`, mark.on && Math.hypot(...mark.p.map((v, i) => v - mp.p[i])) < 1e-3 && markGone, JSON.stringify(mark));
  // empty space: the visible model's centre stays where it was
  const ep = await emptyPoint();
  if (ep) {
    const c = await win.evaluate((ep) => { const vp = lithApp.doc.vp; const r = vp.el.getBoundingClientRect(); const p = vp.pivotAt(ep.x - r.left, ep.y - r.top); return p ? p.toArray() : null; }, ep);
    const c0 = c && (await scr(c));
    await middleDrag(ep.x, ep.y, -70, 40);
    const c1 = c && (await scr(c));
    check(`${what}: middle drag on empty space turns about the centre of what is visible (it stays put)`, c && dist(c0, c1) < 1.5, c ? `${dist(c0, c1).toFixed(2)} px` : 'no centre');
  } else check(`${what}: found empty space`, false);
  // Options off → about the view's centre as before: the clicked point moves
  await win.evaluate(() => lithApp.applyOptions({ rotateAboutCursor: false })); await W(200);
  const mp2 = await modelPoint();
  const tgt = await win.evaluate(() => lithApp.doc.vp.target.toArray()), t0 = await scr(tgt);
  await middleDrag(mp2.x, mp2.y, 90, 50);
  const off = await scr(mp2.p), t1 = await scr(tgt), mk = await win.evaluate(() => !!lithApp.doc.vp._pivotMark);
  check(`${what}: Options off → turns about the view's centre (it stays put, the clicked point moves), no mark`, dist(t0, t1) < 1.5 && (dist(off, [mp2.x, mp2.y]) > 3 || Math.hypot(...mp2.p.map((v, i) => v - tgt[i])) < 1) && !mk, `centre ${dist(t0, t1).toFixed(2)} px, point ${dist(off, [mp2.x, mp2.y]).toFixed(1)} px`);
  await win.evaluate(() => lithApp.applyOptions({ rotateAboutCursor: true })); await W(200);
};
await open(`${DIR}/Arm-1.lithprt`, false);
await win.evaluate(() => lithApp.doc.vp.zoomAt(lithApp.doc.vp.width * 0.3, lithApp.doc.vp.height * 0.5, 0.5)); await W(300); // zoomed in off-centre: the case that swung out of view
await run('part');
// a pan then zoom far away: the view's centre is off the model — rotating on the model keeps it in view
await open(`${DIR}/Bucket assembly.lithasm`, true);
await win.evaluate(() => { const vp = lithApp.doc.vp; vp.panBy(vp.width * 0.25, 0); vp.zoomAt(vp.width * 0.7, vp.height * 0.5, 0.6); }); await W(300);
await run('assembly');
const def = await win.evaluate(async () => { const m = await import('./src/app/options/index.js').catch(() => null); return m ? m.factoryOf('rotateAboutCursor') : 'n/a'; });
check('factory default: on', def === true || def === 'n/a', String(def));
const pe = T.logs.filter((l) => /pageerror|Uncaught/.test(l));
check('no page errors', !pe.length, pe.slice(0, 2).join(' | '));
await T.app.close();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
