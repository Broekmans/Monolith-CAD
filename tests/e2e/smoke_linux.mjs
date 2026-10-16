// Linux build smoke test (used by .github/workflows/linux-release.yml and locally after scripts/linux.sh):
// starts the PACKAGED app (release/linux-unpacked/monolith), builds a box (kernel), imports a DWG with the
// bundled LibreDWG, checks the data folder (MONOLITH_HOME). Exit code 1 on any failure.
// Usage: xvfb-run -a node tests/e2e/smoke_linux.mjs [sample.dwg]
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const exe = path.resolve('release/linux-unpacked/monolith');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-home-'));
const dwg = process.argv[2] ? path.resolve(process.argv[2]) : null;
const fail = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail.push(m); };
const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part', MONOLITH_HOME: home, MONOLITH_NO_ODA: '1' }, timeout: 90000 });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
await win.waitForTimeout(5000);
const info = await win.evaluate(async () => ({ kind: lithApp.doc?.doc?.kind, version: (await window.monolith.info?.())?.version, dwg: await window.monolith.dwgStatus?.() }));
ok(info.kind === 'part', `app started, part document (version ${info.version})`);
ok(!!info.dwg?.libredwg, `bundled LibreDWG found: ${info.dwg?.libredwg}`);
// box 100 x 60 x 20 through the kernel
const box = await win.evaluate(async () => {
  const P = (id, x, y) => ({ id, type: 'point', x, y }), L = (id, p1, p2) => ({ id, type: 'line', p1, p2 });
  const sk = { id: 's', type: 'sketch', plane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, cons: [],
    geo: [P('p1', -50, -30), P('p2', 50, -30), P('p3', 50, 30), P('p4', -50, 30), L('l1', 'p1', 'p2'), L('l2', 'p2', 'p3'), L('l3', 'p3', 'p4'), L('l4', 'p4', 'p1')] };
  try {
    const r = await window.monolith.kernel('regen', { features: [sk, { id: 'e', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }] });
    if (r?.__error) return { err: r.__error };
    const p = r?.mesh?.positions || []; const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
    const size = hi.map((v, i) => Math.round(v - lo[i]));
    return size.join() === '100,20,60' ? { size } : { err: 'size ' + size.join(), keys: Object.keys(r || {}) };
  } catch (e) { return { err: e.message }; }
});
ok(!box.err, 'kernel builds a box ' + JSON.stringify(box).slice(0, 120));
if (dwg) {
  const r = await win.evaluate(async (p) => { try { const x = await window.monolith.dwgToDxf(p); return { len: x?.text?.length || 0, via: x?.via, err: x?.__error }; } catch (e) { return { err: e.message }; } }, dwg);
  ok(r.len > 1000 && !r.err, `DWG → DXF via ${r.via}: ${r.len} chars ${r.err || ''}`);
}
await win.evaluate(() => window.__lithLog?.('SMOKE', 'linux'));
ok(fs.existsSync(home), `data folder ${home}`);
ok(!errs.length, 'no page errors ' + errs.join(' | '));
await app.close().catch(() => {});
fs.rmSync(home, { recursive: true, force: true });
console.log(fail.length ? `${fail.length} FAILED` : 'ALL OK');
process.exit(fail.length ? 1 : 0);
