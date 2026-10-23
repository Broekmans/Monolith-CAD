// 0.1.111/0.1.113: multi-thread geometry kernel (Options > General > Geometry kernel). Switches single <-> multi ONLY
// through the Options value (lithApp.applyOptions, like the Options window does) and checks the real action log file
// for the KERNEL lines — 0.1.111/0.1.112 passed the old version of this test while the setting never reached the kernel.
// Rebuilds Wouter's Tekst test part in both (same faces), logs the times. Needs ../scratch/tekst.lithprt.
import fs from 'node:fs';
import { _electron as electron } from 'playwright-core';
const errs = [];
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
const HOME = '/tmp/kmhome', UD = '/tmp/kmud';
for (const d of [HOME, UD]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
fs.writeFileSync(UD + '/actionlog.json', JSON.stringify({ enabled: true, asked: true, consentV: 9 }));
fs.mkdirSync('/tmp/km', { recursive: true }); fs.copyFileSync('/home/claude/scratch/tekst.lithprt', '/tmp/km/t.lithprt');
const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox', '--user-data-dir=' + UD],
  env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: 'part', MONOLITH_LOGTEST: '1', MONOLITH_HOME: HOME, MONOLITH_KERNEL: '' }, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => console.log('[pageerror]', e.message));
const W = (ms) => win.waitForTimeout(ms);
const idle = async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 60000 }); await W(200); };
const kernelLines = () => { let t = ''; try { for (const f of fs.readdirSync(HOME + '/Logs')) if (/^MonoLith-.*\.log$/.test(f)) t += fs.readFileSync(HOME + '/Logs/' + f, 'utf8'); } catch {} return t.split('\n').filter((l) => /\bKERNEL (multi|single|ERROR)/.test(l)); };
const waitLines = async (n) => { for (let i = 0; i < 40 && kernelLines().length < n; i++) await W(250); return kernelLines(); };
const setOpt = async (v) => { await win.evaluate((v) => lithApp.applyOptions({ kernelMulti: v }), v); };

await W(3000);
let L = await waitLines(1);
check('KERNEL line at start (0.1.114: single by default)', /KERNEL single \(\d+ cores\)/.test(L[0] || ''), L[0] || '(none)');
const rebuild = () => win.evaluate(async () => { const d = lithApp.doc; const t = performance.now(); const r = await window.monolith.kernel('regen', { features: d.doc.features }); return { s: +((performance.now() - t) / 1000).toFixed(2), ms: r.ms, faces: r.mesh.faces.length, err: r.status.filter((x) => x.state !== 'ok').length }; });
await win.evaluate((p) => lithApp.open(p), '/tmp/km/t.lithprt'); await W(3000); await idle();
const a = await rebuild(); console.log('single', JSON.stringify(a));

await setOpt(true); L = await waitLines(2);
check('Options on -> KERNEL multi in log', /KERNEL multi \(\d+ cores, \d+ threads\)/.test(L[1] || ''), L[1] || '(none)');
let i = await win.evaluate(() => window.monolith.kernel('info'));
check('kernel really multi', i?.mode === 'multi', JSON.stringify(i));
const b = await rebuild(); console.log('multi', JSON.stringify(b));
check('same model in both', a.faces === b.faces && a.err === 0 && b.err === 0, `${a.faces} ${b.faces}`);

await setOpt(false); L = await waitLines(3);
check('Options off -> KERNEL single in log', /KERNEL single/.test(L[2] || ''), L[2] || '(none)');
i = await win.evaluate(() => window.monolith.kernel('info'));
check('kernel really single', i?.mode === 'single', JSON.stringify(i));
const c = await rebuild(); console.log('single again', JSON.stringify(c));
console.log('log lines:\n' + kernelLines().join('\n'));
console.log('ERRORS:', errs.length ? errs.join(', ') : 'none');
await app.close(); process.exit(errs.length ? 1 : 0);
