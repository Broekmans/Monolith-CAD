// Point cloud drawings, density look (default): standard 3 views as density rasters, walls darker than
// floors, floor plan preset, section A-A through the scan (slab), scale bar, darkness, PDF image true to
// scale, save/reopen. Needs: python3 tests/e2e/gen_cloud.py 3e6 ../scratch/dc/bld.laz 7
import { launch } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const DIR = '/tmp/dctest2';
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR);
const LAZ = path.resolve('../scratch/dc/bld.laz'), PDF = DIR + '/dens.pdf', DOC = DIR + '/dens.lithdrw';
const T = await launch('drawing');
const { win, W, idle } = T;
const busy = () => idle().catch(() => {});
console.time('3 views');
await win.evaluate((p) => lithApp.doc.addViews(p, ['front', 'top', 'right'], { auto: true, preset: 'full' }), LAZ); await busy();
console.timeEnd('3 views');
await W(800);
const R = (n) => win.evaluate((n) => { const v = lithApp.doc.doc.views.find((q) => q.name === n); const r = v.geom.raster; return r ? { w: r.w, h: r.h, pix: +r.pix.toFixed(2), ref: r.ref, box: v.geom.box.map(Math.round), png: r.png.length, color: v.cloud.color } : { dots: !!v.geom.dots }; }, n);
console.log('scale', await win.evaluate(() => lithApp.doc.sheet.scale.join(':')));
for (const n of ['Front', 'Top', 'Right']) console.log(n, JSON.stringify(await R(n)));
// tone at walls vs floor inside (top view): sample the loaded ink
const tones = await win.evaluate(async () => {
  const d = lithApp.doc, v = d.doc.views.find((q) => q.name === 'Top'), r = v.geom.raster;
  const img = new Image(); img.src = 'data:image/png;base64,' + r.png; await img.decode();
  const c = document.createElement('canvas'); c.width = r.w; c.height = r.h; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const at = (u, w) => { const i = Math.floor((u - r.x0) / r.pix), j = Math.floor((r.y1 - w) / r.pix); let m = 0; for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) m = Math.max(m, x.getImageData(i + a, j + b, 1, 1).data[0]); return m; };
  return { wallW: at(-15000, 0), wallN: at(0, 10000), floorMid: at(-5000, 3000), outside: at(-14000 - 0, 9000 + 3000) };
});
console.log('tones (wall > floor > outside=0):', JSON.stringify(tones));
await T.shot('dd1_density');
// floor plan preset on a new sheet
await win.evaluate(() => lithApp.doc.addSheet());
await win.evaluate((p) => lithApp.doc.addViews(p, ['top'], { auto: true, preset: 'plan' }), LAZ); await busy(); await W(500);
console.log('plan view:', await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; return JSON.stringify({ clip: v.cloud.clip, w: v.geom.raster.w, h: v.geom.raster.h, scale: d.sheet.scale.join(':') }); }));
// section through the plan: vertical cut at x = 0 (model), looking from the front
const cut = await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; return [d.toSheetPt(v, [0, -12000]), d.toSheetPt(v, [0, 12000]), v.pos]; });
await win.evaluate(() => lithApp.doc.cmdSection()); await W(200);
await win.evaluate((p) => lithApp.doc.tool.click(p), cut[0]); await W(200);
await win.evaluate((p) => lithApp.doc.tool.click(p), cut[1]); await busy(); await W(300);
await win.evaluate((p) => { lithApp.doc.tool.move(p); lithApp.doc.tool.click(p); }, [cut[2][0] + 120, cut[2][1]]); await busy(); await W(500);
const sec = await win.evaluate(() => { const v = lithApp.doc.doc.views.find((q) => q.cut); if (!v) return null; return { name: v.name, box: v.geom.box.map(Math.round), w: v.geom.raster?.w, h: v.geom.raster?.h, thick: v.cloud?.thick, plane: v.plane?.n?.map((x) => +x.toFixed(3)) }; });
console.log('section (box ≈ 20000 wide × 10500 high):', JSON.stringify(sec));
// scale bar next to the plan
await win.evaluate(() => lithApp.doc.cmdScaleBar());
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0], r = v.geom.box; d.tool.click(d.toSheetPt(v, [r[0], r[1] - 2000])); }); await W(200);
console.log('scale bar:', await win.evaluate(() => JSON.stringify(lithApp.doc.doc.views.flatMap((v) => (v.anns || []).filter((a) => a.type === 'scalebar').map((a) => a.len)))));
// darkness
await win.evaluate(() => { const d = lithApp.doc, v = d.doc.views.filter((q) => q.sheet === d.sheetId)[0]; d.setViewProp(v, { cloud: { ...v.cloud, dark: 1.4 } }); }); await W(400);
await T.shot('dd2_plan_section');
// PDF
await win.evaluate((p) => lithApp.doc.exportPdf(p), PDF); await W(300);
console.log('pdf bytes', fs.statSync(PDF).size);
try { console.log(execFileSync('python3', ['-c', `
import pypdf,sys
r=pypdf.PdfReader(sys.argv[1])
for i,p in enumerate(r.pages):
  ims=[]
  def vis(op,args,cm,tm):
    if op==b'Do': ims.append([round(v*25.4/72,2) for v in cm])
  p.extract_text(visitor_operand_before=vis)
  print('page',i+1,'images (a,b,c,d,e,f mm):',ims)
print(r.pages[1].extract_text()[:300].replace('\\n',' | '))
`, PDF], { encoding: 'utf8' })); } catch (e) { console.log('pdf check failed', e.stdout || e.message); }
// save + reopen
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.toJSON())); }, DOC);
console.log('drawing file bytes:', fs.statSync(DOC).size);
await win.evaluate(async () => { lithApp.dirty = false; await lithApp.closeTab(lithApp.cur()); });
await win.evaluate((p) => lithApp.open(p), DOC); await W(1200);
await T.shot('dd3_reopened');
console.log('ERRORS:', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
