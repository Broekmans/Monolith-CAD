// Old-format (.ekprt) file opens; tab gets no path, save suggests .lithprt next to it
import { launch } from './common.mjs';
const T = await launch('part');
const { win, W } = T;
const p = '/tmp/legacy_test.ekprt';
await win.evaluate(async (p) => { await window.monolith.writeFile(p, JSON.stringify(lithApp.doc.doc)); }, p);
await win.evaluate(async (p) => { await lithApp.open(p); }, p); await W(2000); await T.idle();
console.log('legacy', await win.evaluate(() => JSON.stringify([lithApp.doc.doc.kind, lithApp.path, lithApp.cur().path, lithApp.cur().suggestPath])));
await T.app.close();
