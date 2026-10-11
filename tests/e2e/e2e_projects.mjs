// Projects on Home (folder = project, main/sub detection, cover thumbnail) + subassemblies + save thumbnail
import { launch } from './common.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lithproj-'));
process.env.MONOLITH_PROJECTS = root;
const P = path.join(root, 'Stonex'); fs.mkdirSync(P);
const Top = { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] };
const pt = (id, x, y) => ({ id, type: 'point', x, y });
const part = (name, w) => ({ kind: 'part', version: 1, name, units: 'mm', material: 'Not specified', rollback: null, next: 9, features: [
  { id: 's', name: 'Sketch1', type: 'sketch', plane: Top, geo: [pt('p1', -w, -20), pt('p2', w, -20), pt('p3', w, 20), pt('p4', -w, 20),
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }], cons: [] },
  { id: 'e', name: 'Boss-Extrude1', type: 'extrude', sketch: 's', depth: 10, end: 'blind', op: 'boss' }] });
const A = path.join(P, 'Stonex-01-001-000.lithprt'), B = path.join(P, 'Stonex-01-001-001.lithprt');
fs.writeFileSync(A, JSON.stringify(part('A', 30))); fs.writeFileSync(B, JSON.stringify(part('B', 15)));
const SUB = path.join(P, 'Stonex-01-001.lithasm'), MAIN = path.join(P, 'Stonex-01.lithasm');
const T = await launch('assembly');
const { win, W, idle } = T;
// build the subassembly: A + B, save it (gets thumbnail)
await win.evaluate((p) => lithApp.doc.insertComponent(p), A); await idle();
await win.evaluate((p) => lithApp.doc.insertComponent(p), B); await idle();
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; await lithApp.cur().save(); }, SUB); await W(500);
const sub = JSON.parse(fs.readFileSync(SUB, 'utf8'));
console.log('sub saved comps', sub.components.length, 'thumb', (sub.thumb || '').slice(0, 23), (sub.thumb || '').length);
// main assembly containing the subassembly + part A
await win.evaluate(() => lithApp.newDoc('assembly')); await W(800);
await win.evaluate((p) => lithApp.doc.insertComponent(p), SUB); await idle();
await win.evaluate((p) => lithApp.doc.insertComponent(p), A); await idle();
console.log('main comps', await win.evaluate(() => lithApp.doc.doc.components.map((c) => c.name + ':' + (c._part?.err || (c._part?.isAssembly ? 'asm ' : 'part ') + c._part?.mesh.faces.length)).join(', ')));
await win.evaluate(async (p) => { await window.monolith.writeFile(p, '{}'); lithApp.cur().path = p; await lithApp.cur().save(); }, MAIN); await W(500);
// self-insert refused
console.log('self insert', await win.evaluate(async (p) => { const r = await lithApp.doc.insertComponent(p); return r ? 'inserted!' : 'refused'; }, MAIN));
// export STEP flattens subassembly
// Home: projects
await win.evaluate(() => lithApp.root.showWelcome()); await W(800);
console.log('cards', await win.evaluate(() => [...document.querySelectorAll('.pj-card')].map((c) => c.innerText.replace(/\n/g, ' / ')).join(' | ')));
console.log('cover img', await win.evaluate(() => !!document.querySelector('.pj-card img')));
await win.locator('.pj-card').first().click(); await W(600);
console.log('files', await win.evaluate(() => [...document.querySelectorAll('.pj-card')].map((c) => c.innerText.replace(/\n/g, ' / ')).join(' | ')));
console.log('recent side', await win.evaluate(() => !!document.querySelector('.wl-side')));
await T.shot('projects_home');
console.log('errors', T.logs.filter((l) => /pageerror|error/i.test(l)).join('\n') || 'none');
await T.app.close();
