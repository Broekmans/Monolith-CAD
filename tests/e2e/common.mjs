import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
fs.mkdirSync('tests/e2e/shots', { recursive: true });
export async function launch(kind) {
  const app = await electron.launch({ executablePath: './node_modules/.bin/electron', args: ['.', '--no-sandbox'], env: { ...process.env, MONOLITH_TEST: '1', MONOLITH_KIND: kind }, timeout: 60000 });
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', (m) => { if (!/Security|WebGL|GPU stall|swiftshader|boot\]/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
  process.on('exit', () => console.log(logs.join('\n')));
  await win.waitForTimeout(3000);
  const W = (ms) => win.waitForTimeout(ms);
  const T = {
    app, win, logs, W,
    shot: async (n) => { await W(450); await win.screenshot({ path: `tests/e2e/shots/${n}.png` }); },
    idle: async () => { await W(300); await win.waitForFunction(() => !document.getElementById('busy').classList.contains('on'), null, { timeout: 30000 }); await W(200); },
    btn: (label) => win.locator(`.cm-btn:has-text("${label}")`).first().click(),
    tab: (label) => win.locator(`.cm-tab:has-text("${label}")`).click(),
    P: async (x, y) => win.evaluate(([x, y]) => { const sk = lithApp.doc.sketcher; const r = sk.vp.el.getBoundingClientRect(); const s = sk.scr([x, y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]),
    WP: async (p) => win.evaluate((p) => { const vp = lithApp.doc.vp; const r = vp.el.getBoundingClientRect(); const s = vp.toScreen(p); return [r.left + s[0], r.top + s[1]]; }, p),
    PP: async (x, y) => win.evaluate(([x, y]) => { const d = lithApp.doc; const r = d.vp.el.getBoundingClientRect(); const s = d.vp.toScreen([x, 0, -y]); return [r.left + s[0], r.top + s[1]]; }, [x, y]),
  };
  T.click = async (x, y) => { const [px, py] = await T.P(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(120); };
  T.dbl = async (x, y) => { const [px, py] = await T.P(x, y); await win.mouse.move(px, py, { steps: 2 }); await win.mouse.dblclick(px, py); await W(150); };
  T.clickWorld = async (p, mods = []) => { const [x, y] = await T.WP(p); await win.mouse.move(x, y, { steps: 2 }); for (const m of mods) await win.keyboard.down(m); await win.mouse.down(); await win.mouse.up(); for (const m of mods) await win.keyboard.up(m); await W(150); };
  T.clickPlan = async (x, y) => { const [px, py] = await T.PP(x, y); await win.mouse.move(px, py, { steps: 3 }); await win.mouse.down(); await win.mouse.up(); await W(100); };
  T.cmd = async (text) => { await win.keyboard.type(text); await win.keyboard.press('Enter'); await W(150); };
  T.ok = async () => { await win.locator('.pm-ok').click(); await T.idle(); };
  T.num = async (i, v) => { const inp = win.locator('.pm-numrow input').nth(i); await inp.fill(String(v)); await inp.press('Enter'); await T.idle(); };
  return T;
}
