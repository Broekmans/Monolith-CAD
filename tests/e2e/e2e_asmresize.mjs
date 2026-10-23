// 0.1.131: mates follow a part that changed size. Needs ../scratch/b300/ (Wouter's Bucket assembly + parts, Arm-1 300 long)
// and ../scratch/arm/arm-now.lithprt (the same Arm-1 made 800 long). The assembly is opened with the 300 arm and saved
// (components get partBox), then Arm-1 is swapped for the 800 one: the concentric mates must stay on the end holes
// (x = ±400, not the old ±150 position), 0 mate errors. Also: an old assembly without partBox and a part reloaded while
// the assembly is open (box before the reload).
import fs from 'node:fs';
import { launch } from './common.mjs';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const A = '/tmp/rz/a', B = '/tmp/rz/b';
for (const d of [A, B]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); for (const f of fs.readdirSync('/home/claude/scratch/b300')) if (/\.lith(prt|asm)$/.test(f)) fs.copyFileSync(`/home/claude/scratch/b300/${f}`, `${d}/${f}`); }
const T = await launch('assembly');
const { win, W, idle } = T;
await win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('monolith.pop.')) localStorage.removeItem(k); });
const open = async (p) => { await win.evaluate(async (p) => { await lithApp.open(p); await new Promise((r) => { const iv = setInterval(() => { const d = lithApp.doc; if (d && d.doc.kind === 'assembly' && d.app.path === p && d.doc.components.every((c) => c._part)) { clearInterval(iv); r(); } }, 50); }); }, p); await W(2000); await idle(); };
const info = () => win.evaluate(() => { const d = lithApp.doc; const holes = d.doc.mates.filter((m) => m.type === 'concentric').flatMap((m) => [m.a, m.b].filter((r) => /^Arm/.test(d.C(r.comp)?.name || '')).map((r) => Math.round(r.c[0]))); return { errs: [...(d.mateErr || new Map()).keys()].length, holes, box: d.doc.components.find((c) => /^Arm/.test(c.name))?.partBox }; });
await open(`${A}/Bucket assembly.lithasm`);
const i0 = await info();
check('300 arm: no mate errors, end holes at ±151, partBox stored', i0.errs === 0 && i0.holes.every((x) => Math.abs(Math.abs(x) - 151) <= 1) && Math.abs(i0.box?.max?.[0] - 193.296) < 0.01, JSON.stringify(i0));
await win.evaluate(async (p) => { const t = lithApp.root.active; t.path = p; await t.save(); }, `${B}/Bucket assembly.lithasm`); await W(600);
await win.evaluate(() => lithApp.root.closeTab(lithApp.root.active)); await W(500);
fs.writeFileSync(`${B}/Bucket assembly.lithasm`, fs.readFileSync(`${B}/Bucket assembly.lithasm`, 'utf8').replaceAll('/tmp/rz/a/', '/tmp/rz/b/'));
fs.copyFileSync('/home/claude/scratch/arm/arm-now.lithprt', `${B}/Arm-1.lithprt`);
await open(`${B}/Bucket assembly.lithasm`);
const i1 = await info();
check('part saved 800 long while the assembly was closed: mates on the end holes (±400), no mate errors', i1.errs === 0 && i1.holes.every((x) => Math.abs(Math.abs(x) - 400) <= 1), JSON.stringify(i1));
// part reloaded while the assembly is open (back to 300): uses the box before the reload
fs.copyFileSync(`${A}/Arm-1.lithprt`, `${B}/Arm-1.lithprt`);
await win.evaluate(async () => { const d = lithApp.doc; await d.reloadAll(true); }); await W(1500); await idle();
const i2 = await info();
check('reloaded back to 300 while open: mates back on ±151, no mate errors', i2.errs === 0 && i2.holes.every((x) => Math.abs(Math.abs(x) - 151) <= 1), JSON.stringify(i2));
await T.close?.();
console.log(errs.length ? `FAILED ${errs.length}: ${errs.join(' | ')}` : 'ALL OK');
process.exit(errs.length ? 1 : 0);
