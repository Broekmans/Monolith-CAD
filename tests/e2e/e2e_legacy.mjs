// Old-format files: .ekprt opens with path switched to .lithprt; existing .lithprt sibling is preferred;
// assembly components pointing at .ekprt use the .lithprt next to it
import { launch } from './common.mjs';
import fs from 'node:fs';
const T = await launch('part');
const { win, W } = T;
const p = '/tmp/legacy_test.ekprt', np = '/tmp/legacy_test.lithprt';
fs.rmSync(np, { force: true });
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.doc)); }, p);
await win.evaluate(async (p) => { await lithApp.open(p); }, p); await W(2000); await T.idle();
console.log('no sibling', await win.evaluate(() => lithApp.cur().path));
await win.evaluate(() => lithApp.cur().save()); await W(500);
console.log('saved lith exists', fs.existsSync(np), 'has cache', !!JSON.parse(fs.readFileSync(np, 'utf8')).cache);
{ const d = JSON.parse(fs.readFileSync(np, 'utf8')); console.log('format', d.version === 1 && /^\d+\.\d+\.\d+$/.test(d.savedWith) ? 'OK' : 'BAD', d.version, d.savedWith); }
await win.evaluate(async () => { for (const t of [...lithApp.tabs]) { t.dirty = false; await lithApp.closeTab(t); } });
await win.evaluate(async (p) => { await lithApp.open(p); }, p); await W(1500);
console.log('sibling', await win.evaluate(() => lithApp.cur().path));
// assembly referencing the old file
const asm = { kind: 'assembly', version: 1, name: 'A', units: 'mm', components: [{ id: 'c1', name: 'L<1>', path: p, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: true }], mates: [], next: 2 };
fs.writeFileSync('/tmp/legacy_asm.lithasm', JSON.stringify(asm));
await win.evaluate(() => lithApp.clearPartCacheForTest());
await win.evaluate(async () => { await lithApp.open('/tmp/legacy_asm.lithasm'); }); await W(2000); await T.idle();
console.log('asm comp', await win.evaluate(() => [lithApp.doc.doc.components[0].path, !!lithApp.doc.doc.components[0]._part?.mesh, lithApp.cur().dirty].join(' ')));
// file format: a file from a newer program opens with a warning; a file without version opens as version 1
{
  const d = JSON.parse(fs.readFileSync(np, 'utf8'));
  fs.writeFileSync('/tmp/fmt_new.lithprt', JSON.stringify({ ...d, version: 99 }));
  const { version, ...nov } = d; fs.writeFileSync('/tmp/fmt_nov.lithprt', JSON.stringify(nov));
  await win.evaluate(async () => { await lithApp.open('/tmp/fmt_new.lithprt'); }); await W(1500); await T.idle();
  const warn = await win.evaluate(() => [...document.querySelectorAll('.toast.warn')].map((t) => t.textContent).join(' | '));
  console.log('newer', /newer MonoLith version/.test(warn) ? 'OK' : 'BAD', await win.evaluate(() => lithApp.doc.doc.version + ' ' + !!lithApp.doc.mesh));
  await win.evaluate(async () => { await lithApp.open('/tmp/fmt_nov.lithprt'); }); await W(1500); await T.idle();
  console.log('no version', await win.evaluate(() => lithApp.doc.doc.version === 1 && !!lithApp.doc.mesh ? 'OK' : 'BAD'));
}
await T.app.close();
