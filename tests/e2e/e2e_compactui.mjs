// 0.1.128: compact layout — ribbon size (large / medium / small) + scale + group names, text on one line, thin / hidden
// quick access bar, logo at the right end of the ribbon, tree indent + row height, Motion Study: drag the top edge and
// the line after the step names (real mouse), stored as Options values. Needs ../scratch/motion/ (Slide and rotation test).
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const DIR = '/tmp/cu'; fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync('/home/claude/scratch/motion')) fs.copyFileSync(`/home/claude/scratch/motion/${f}`, `${DIR}/${f}`);
const A = `${DIR}/Slide and rotation test.lithasm`;
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); }); // 0.1.129: no popup windows left from another test
await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, A);
await W(1200); await idle();
const ribbon = () => win.evaluate(() => {
  const btns = [...document.querySelectorAll('.cm-btn')].filter((b) => b.offsetParent);
  const lines = btns.map((b) => { const l = b.querySelector('.lbl'); const cs = getComputedStyle(l); return Math.round(l.getBoundingClientRect().height / parseFloat(cs.lineHeight || cs.fontSize * 1.15)); });
  const ico = btns[0]?.querySelector('.ico').getBoundingClientRect();
  const lbl = btns[0]?.querySelector('.lbl').getBoundingClientRect();
  const qa = document.querySelector('.qa');
  const brand = document.querySelector('.cm-brand'), bar = document.querySelector('.cm-buttons');
  return { h: Math.round(document.querySelector('.cmdmgr').getBoundingClientRect().height), maxLines: Math.max(...lines), ico: Math.round(ico.width), beside: lbl.left >= ico.right - 1,
    labels: [...document.querySelectorAll('.cm-glabel')].filter((g) => g.offsetParent).length, qaH: Math.round(qa.getBoundingClientRect().height), qaShown: getComputedStyle(qa).display !== 'none',
    brandRight: brand ? Math.round(bar.getBoundingClientRect().right - brand.getBoundingClientRect().right) : null, brandOp: brand ? +getComputedStyle(brand).opacity : null, qaBrand: !!qa.querySelector('.brand'),
    busyInStatus: !!document.querySelector('.statusbar #busy') };
});
const set = (o) => win.evaluate((o) => lithApp.applyOptions(o), o);
await set({ ribbonSize: 'large', ribbonScalePct: 100, ribbonGroupLabels: true }); await W(300);
const L = await ribbon();
await T.shot('cu-large');
await set({ ribbonSize: 'medium' }); await W(300);
const Md = await ribbon();
await T.shot('cu-medium');
await set({ ribbonSize: 'small' }); await W(300);
const S = await ribbon();
await T.shot('cu-small');
check('Large: text on one line on every button ("Insert Component", "Motion Study")', L.maxLines === 1, JSON.stringify(L));
check('Medium (default): one line, smaller icon, ribbon lower than Large', Md.maxLines === 1 && Md.ico < L.ico && Md.h < L.h, `${Md.h} vs ${L.h} px, icon ${Md.ico} vs ${L.ico}`);
check('Small: text beside the icon, ribbon lower than Medium', S.beside && S.h < Md.h, `${S.h} px`);
await set({ ribbonSize: 'medium', ribbonScalePct: 130 }); await W(300);
const M130 = await ribbon();
check('Ribbon size 130 %: icons 1.3 × as big', Math.abs(M130.ico - Md.ico * 1.3) <= 1, `${M130.ico} vs ${Md.ico}`);
await set({ ribbonScalePct: 100, ribbonGroupLabels: false }); await W(300);
const NL = await ribbon();
check('group names off: none shown, ribbon lower', NL.labels === 0 && Md.labels > 0 && NL.h < Md.h, `${NL.labels} ${NL.h}`);
await set({ ribbonGroupLabels: true }); await W(300);
check('quick access bar thin (≤ 26 px), no logo in it; logo at the right end of the ribbon, dim; busy sign in the status bar', Md.qaShown && Md.qaH <= 26 && !Md.qaBrand && Md.brandRight !== null && Md.brandRight < 40 && Md.brandOp < 0.5 && Md.busyInStatus, JSON.stringify(Md));
await set({ qaBar: 'hidden' }); await W(300);
const H = await ribbon();
check('quick access bar hidden by option', !H.qaShown);
await set({ qaBar: 'thin' }); await W(300);
// tree indent + row height
const treeRows = () => win.evaluate(() => [...document.querySelectorAll('.tree .tr-row')].map((r) => ({ t: r.textContent.trim(), pad: parseFloat(r.style.paddingLeft), h: Math.round(r.getBoundingClientRect().height) })));
let tr = await treeRows();
const pin = tr.find((r) => /^Front Plane$/.test(r.t)); // assembly Origin → Front Plane: depth 2
check('tree: depth 2 row indented 4 + 2 × 4 px, rows 16 px (0.1.134 defaults)', pin && pin.pad === 12 && tr.every((r) => r.h === 16), `${JSON.stringify(pin)} heights ${[...new Set(tr.map((r) => r.h))]}`);
await set({ treeIndentPx: 16, treeRowPx: 26 }); await W(400);
tr = await treeRows();
check('Options: indent 16 px, row height 26 px → tree follows at once', tr.find((r) => r.t === 'Front Plane')?.pad === 36 && tr.every((r) => r.h === 26), JSON.stringify(tr.find((r) => r.t === 'Front Plane')));
await set({ treeIndentPx: 10, treeRowPx: 20 }); await W(300);
// Motion Study: drag the top edge and the names column
await T.btn('Motion Study'); await W(600);
const strip = () => win.evaluate(() => { const s = document.querySelector('.motion-strip'), n = s.querySelector('.ms-names'); return { h: Math.round(s.getBoundingClientRect().height), top: Math.round(s.getBoundingClientRect().top), w: Math.round(s.getBoundingClientRect().width), x: Math.round(s.getBoundingClientRect().left), names: Math.round(n.getBoundingClientRect().width), bottom: document.querySelector('.views').style.bottom, optH: lithApp.doc.app.root && window.__opt?.('asmMotionHeightPx') }; });
const s0 = await strip();
const g = await win.locator('.motion-strip .ms-resize').boundingBox();
await win.mouse.move(s0.x + s0.w / 2, g.y + g.height / 2); await W(100); await win.mouse.down(); await W(80);
await win.mouse.move(s0.x + s0.w / 2, g.y + g.height / 2 - 120, { steps: 8 }); await W(150); await win.mouse.up(); await W(500);
const s1 = await strip();
const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('monolith.options') || '{}'));
check('drag the top edge up 120 px → timeline 120 px taller, the view shortened, stored', Math.abs(s1.h - s0.h - 120) <= 2 && s1.bottom === s1.h + 'px' && Math.abs(stored.asmMotionHeightPx - s1.h) <= 1, `${s0.h} → ${s1.h}, bottom ${s1.bottom}, stored ${stored.asmMotionHeightPx}`);
const cg = await win.locator('.motion-strip .ms-colgrip').boundingBox();
await win.mouse.move(cg.x + cg.width / 2, cg.y + 20); await W(100); await win.mouse.down(); await W(80);
await win.mouse.move(cg.x + cg.width / 2 + 90, cg.y + 20, { steps: 8 }); await W(150); await win.mouse.up(); await W(500);
const s2 = await strip();
const stored2 = await win.evaluate(() => JSON.parse(localStorage.getItem('monolith.options') || '{}'));
check('drag the line after the step names 90 px right → column 90 px wider, stored', Math.abs(s2.names - s1.names - 90) <= 2 && Math.abs(stored2.asmMotionNamesPx - s2.names) <= 2, `${s1.names} → ${s2.names}, stored ${stored2.asmMotionNamesPx}`);
await T.btn('Motion Study'); await W(300); await T.btn('Motion Study'); await W(600);
const s3 = await strip();
check('closed and opened again: height and column width kept', s3.h === s2.h && s3.names === s2.names, JSON.stringify(s3));
await T.shot('cu-motion');
await set({ asmMotionHeightPx: 170, asmMotionNamesPx: 250 });
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
