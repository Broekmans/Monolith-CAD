// 0.1.69: DWG without ODA: built-in LibreDWG fallback (import R2000 + R2018, export DWG 2000 + re-import), converter dialog.
// Needs a LibreDWG build for this OS: MONOLITH_LIBREDWG=<dir with dwg2dxf, dxf2dwg>; samples ../scratch/example_2000.dwg, example_2018.dwg
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
process.env.MONOLITH_NO_ODA = '1';
const S = (n) => path.resolve('../scratch/' + n);
const T = await launch('plan');
const { win, W, idle } = T;
const count = () => win.evaluate(() => { const d = lithApp.doc; const n = (d.doc.layers || []).reduce((a, l) => a + (l.entities?.length || 0), 0); return { n: n || d.doc.entities?.length || 0, status: document.querySelector('.st-left')?.textContent, layers: (d.doc.layers || []).length }; });
for (const f of ['example_2000.dwg', 'example_2018.dwg']) {
  const before = (await count()).n;
  await win.evaluate((p) => lithApp.importPath({ path: p, text: '' }), S(f)); await idle(); await W(500);
  const c = await count();
  console.log(f, 'entities +' + (c.n - before), '| status:', c.status, '| dialog:', await win.locator('.dlg').count());
}
// export as DWG (LibreDWG writes DWG 2000), then import that file again
const OUT = '/tmp/dwgtest/out.dwg'; fs.rmSync('/tmp/dwgtest', { recursive: true, force: true }); fs.mkdirSync('/tmp/dwgtest');
const dxf = fs.readFileSync(S('example_2000.dxf'), 'latin1');
const ex = await win.evaluate(async ([t, out]) => window.monolith.dxfToDwg(t, out), [dxf, OUT]);
console.log('export DXF → DWG:', JSON.stringify(ex), fs.existsSync(OUT) ? fs.statSync(OUT).size + ' bytes, header ' + fs.readFileSync(OUT).subarray(0, 6).toString('latin1') : 'missing');
if (fs.existsSync(OUT)) {
  const before = (await count()).n;
  await win.evaluate((p) => lithApp.importPath({ path: p, text: '' }), OUT); await idle(); await W(500);
  console.log('re-import of own DWG: entities +' + ((await count()).n - before), (await count()).status);
}
// converter dialog (File → DWG Converter…)
await win.evaluate(() => lithApp.onMenu('dwg-converter')); await W(500);
console.log('dialog:', await win.locator('.dlg').innerText().then((t) => t.replace(/\n+/g, ' | ')).catch(() => 'none'));
await T.shot('dwg-dialog');
await T.app.close();
