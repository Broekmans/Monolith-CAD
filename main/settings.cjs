// Settings & logs: one-time migration from the old settings folder, action log (consent + daily files), recent files list.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.join(__dirname, '..');
const isTest = !!process.env.MONOLITH_TEST;

// One-time: carry recent files + action-log consent over from the pre-rename settings folder
function migrateSettings() {
  try {
    const ud = app.getPath('userData'), legacy = path.join(path.dirname(ud), ['EK', 'CAD'].join(''));
    if (!fs.existsSync(legacy)) return;
    fs.mkdirSync(ud, { recursive: true });
    for (const f of ['recent.json', 'actionlog.json']) {
      const src = path.join(legacy, f), dst = path.join(ud, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  } catch { /* ignore */ }
}
if (!isTest) migrateSettings();
// ---------- action log: <CAD Program>\Logs\MonoLith-YYYY-MM-DD.log (one file per day, 14 days kept) ----------
function logDir() {
  const d = app.isPackaged ? path.join(path.dirname(path.dirname(process.execPath)), 'Logs') : path.join(app.getPath('userData'), 'Logs');
  try { fs.mkdirSync(d, { recursive: true }); } catch { return app.getPath('userData'); }
  return d;
}
function pruneLogs() {
  try { const d = logDir(), cut = Date.now() - 14 * 864e5; for (const f of fs.readdirSync(d)) if (/^MonoLith-.*\.log$/i.test(f) && fs.statSync(path.join(d, f)).mtimeMs < cut) fs.unlinkSync(path.join(d, f)); } catch {}
}
const logCfgFile = () => path.join(app.getPath('userData'), 'actionlog.json');
let logCfg = null;
function getLogCfg() { if (!logCfg) { try { logCfg = JSON.parse(fs.readFileSync(logCfgFile(), 'utf8')); } catch { logCfg = { enabled: true, asked: false }; } if (isTest && !process.env.MONOLITH_LOGTEST) { logCfg.asked = true; logCfg.consentV = 9; } } return logCfg; }
function setLogCfg(c) { logCfg = { ...getLogCfg(), ...c }; try { fs.writeFileSync(logCfgFile(), JSON.stringify(logCfg)); } catch {} return logCfg; }
function writeLog(lines) {
  if (!getLogCfg().enabled) return;
  if ((isTest && !process.env.MONOLITH_LOGTEST) || !lines?.length) return;
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFile(path.join(logDir(), `MonoLith-${day}.log`), lines.join('\n') + '\n', () => {});
}

// ---------------- recent files ----------------
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function getRecent() { try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((p) => fs.existsSync(p)); } catch { return []; } }
function addRecent(p) {
  if (!/\.(lithprt|lithasm|lithpln|ekprt|ekasm|ekpln)$/i.test(p)) return;
  const list = [p, ...getRecent().filter((x) => x !== p)].slice(0, 12);
  try { fs.writeFileSync(recentFile(), JSON.stringify(list)); } catch { /* ignore */ }
  app.addRecentDocument?.(p);
}

module.exports = { logDir, pruneLogs, getLogCfg, setLogCfg, writeLog, getRecent, addRecent };
