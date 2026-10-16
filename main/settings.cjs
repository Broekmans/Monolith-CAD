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
// ---------- data folder: Logs, Projects, drafting-standard.json, monolith-options.json ----------
// Windows: the folder that holds the MonoLith\ install folder (<CAD Program>). Linux/macOS: the program may run from a
// read-only place (AppImage), so ~/MonoLith (env MONOLITH_HOME overrides everywhere). Development: userData.
function dataRoot() {
  if (process.env.MONOLITH_HOME) return process.env.MONOLITH_HOME;
  if (!app.isPackaged) return app.getPath('userData');
  if (process.platform === 'win32') return path.dirname(path.dirname(process.execPath));
  return path.join(os.homedir(), 'MonoLith');
}
// ---------- action log: <data folder>\Logs\MonoLith-YYYY-MM-DD.log (one file per day, 14 days kept) ----------
function logDir() {
  const d = path.join(dataRoot(), 'Logs');
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

// ---------- drafting standard (company / user): <CAD Program>\drafting-standard.json ----------
const stdFile = () => process.env.MONOLITH_STD || path.join(path.dirname(logDir()), 'drafting-standard.json');
function draftStd(s) {
  if (s && typeof s === 'object') { try { fs.writeFileSync(stdFile(), JSON.stringify(s, null, 2)); } catch (e) { return { __error: e.message }; } return { ...s, __path: stdFile() }; }
  try { return { ...JSON.parse(fs.readFileSync(stdFile(), 'utf8')), __path: stdFile() }; } catch { return { __path: stdFile() }; }
}

// ---------- Options "My Defaults": <CAD Program>\monolith-options.json (Tools > Options… > Save as My Defaults) ----------
const optFile = () => process.env.MONOLITH_OPTIONS || path.join(path.dirname(logDir()), 'monolith-options.json');
function optionsCfg(o) {
  if (o && typeof o === 'object') { try { fs.writeFileSync(optFile(), JSON.stringify(o, null, 2)); } catch (e) { return { __error: e.message }; } return { ...o, __path: optFile() }; }
  if (isTest && !process.env.MONOLITH_OPTIONS) return { __path: optFile() };
  try { return { ...JSON.parse(fs.readFileSync(optFile(), 'utf8')), __path: optFile() }; } catch { return { __path: optFile() }; }
}

// test dumps (room detection input + result) in Logs\rooms, last 20 kept; only when the action log is on
function writeDump(name, text) {
  if (!getLogCfg().enabled || (isTest && !process.env.MONOLITH_LOGTEST && !process.env.MONOLITH_DUMPTEST)) return null;
  try {
    const d = path.join(logDir(), 'rooms'); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, String(name).replace(/[^\w.-]+/g, '_')); fs.writeFileSync(f, text);
    const all = fs.readdirSync(d).filter((x) => x.endsWith('.json')).map((x) => ({ x, t: fs.statSync(path.join(d, x)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const o of all.slice(20)) fs.unlinkSync(path.join(d, o.x));
    return f;
  } catch { return null; }
}

module.exports = { dataRoot, optionsCfg, writeDump, draftStd, logDir, pruneLogs, getLogCfg, setLogCfg, writeLog, getRecent, addRecent };
