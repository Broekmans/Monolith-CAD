// 0.1.70: Open… from Home for DXF (plan tab gets the import, not Home), skipped-entity message (IMAGE), ribbon group labels, popup style.
// needs ../scratch/ortho_layout.dxf (GeoSLAM layout: 4 IMAGE entities only); a small DXF is written here.
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
const T = await launch('part');
const { win, W, idle } = T;
const small = path.resolve('../scratch/small.dxf');
fs.writeFileSync(small, ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0', '0', 'CIRCLE', '8', '0', '10', '50', '20', '50', '40', '20', '0', 'IMAGE', '8', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
// ribbon group labels on the Part ribbon
console.log('part labels:', await win.evaluate(() => [...document.querySelectorAll('.cm-glabel')].map((e) => e.textContent).join(' | ')));
await T.tab('Features'); await W(200);
console.log('features labels:', await win.evaluate(() => [...document.querySelectorAll('.cm-glabel')].map((e) => e.textContent).join(' | ')));
await T.shot('open-ribbon');
const openHome = async (p) => {
  await win.evaluate(async (p) => { const r = lithApp.root; r.activate(r); await r.open(p); }, p); await idle(); await W(400);
  return win.evaluate(() => ({ kind: lithApp.doc?.doc.kind, title: lithApp.doc?.title, n: lithApp.doc?.doc.entities?.length, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }));
};
console.log('open small.dxf from Home:', JSON.stringify(await openHome(small)));
console.log('plan labels:', await win.evaluate(() => [...document.querySelectorAll('.cm-glabel')].map((e) => e.textContent).join(' | ')));
await W(3600);
console.log('open ortho_layout.dxf from Home:', JSON.stringify(await openHome(path.resolve('../scratch/ortho_layout.dxf'))));
// popup style: dialog with header strip + close button
await win.evaluate(() => lithApp.onMenu('dwg-converter')); await W(500);
console.log('dialog header:', await win.evaluate(() => { const t = document.querySelector('.dlg-title'); const cs = getComputedStyle(t); return t.innerText.replace(/\n/g, ' ') + ' | ' + cs.textTransform + ' | x=' + !!t.querySelector('.dlg-x'); }));
await T.shot('open-dialog');
await win.locator('.dlg-x').click(); await W(200);
console.log('dialog closed by ×:', (await win.locator('.dlg').count()) === 0);
await T.app.close();
