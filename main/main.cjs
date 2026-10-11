// Electron main process: windows, menus, file dialogs, kernel worker and
// DWG conversion through the ODA File Converter.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
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

protocol.registerSchemesAsPrivileged([{ scheme: 'monolith', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// ---------------- kernel worker ----------------
let worker = null;
let nextId = 1;
const pending = new Map();
// ---------------- point cloud worker ----------------
let pcWorker = null;
let pcNext = 1;
const pcPending = new Map();
function pcCall(op, args, sender) {
  if (!pcWorker) {
    const p = path.join(ROOT, 'kernel', 'pointcloud.mjs').replace('app.asar', 'app.asar.unpacked');
    pcWorker = new Worker(pathToFileURL(p));
    pcWorker.on('message', (m) => {
      const q = pcPending.get(m.id);
      if (!q) return;
      if (m.progress !== undefined) { if (!q.sender.isDestroyed()) q.sender.send('pc-progress', m.progress); return; }
      pcPending.delete(m.id);
      if (m.error) q.reject(new Error(m.error)); else q.resolve(m.result);
    });
    pcWorker.on('error', (e) => { for (const q of pcPending.values()) q.reject(e); pcPending.clear(); pcWorker = null; });
  }
  return new Promise((resolve, reject) => {
    const id = pcNext++;
    pcPending.set(id, { resolve, reject, sender });
    pcWorker.postMessage({ id, op, args });
  });
}

function startWorker() {
  const kernelPath = path.join(ROOT, 'kernel', 'worker.mjs').replace('app.asar', 'app.asar.unpacked');
  worker = new Worker(pathToFileURL(kernelPath));
  worker.on('message', (m) => {
    if (m.ready || m.fatal) { if (m.fatal) console.error('Kernel failed:', m.fatal); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.resolve({ __error: m.error }); else p.resolve(m.result);
  });
  worker.on('error', (e) => { console.error('Kernel worker error', e); for (const p of pending.values()) p.resolve({ __error: String(e) }); pending.clear(); startWorker(); });
}
function kernel(op, args) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    worker.postMessage({ id, op, args });
  });
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

// ---------------- windows ----------------
const windows = new Set();
function createWindow(query = {}) {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    show: false, backgroundColor: '#eef1f5', title: 'MonoLith',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windows.add(win);
  const qs = new URLSearchParams(query).toString();
  win.loadURL(`monolith://app/index.html${qs ? '?' + qs : ''}`);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('close', (e) => {
    if (win.forceClose || isTest) return;
    e.preventDefault();
    win.webContents.send('before-close');
  });
  win.on('closed', () => windows.delete(win));
  return win;
}

function send(cmd, arg) {
  const w = BrowserWindow.getFocusedWindow() || [...windows][0];
  w?.webContents.send('menu', cmd, arg);
}

let uiDark = false;
function buildMenu() {
  const recent = getRecent();
  const tpl = [
    { label: '&File', submenu: [
      { label: 'New Part', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('new-part') },
      { label: 'New Plan / Drawing', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('new-plan') },
      { label: 'New Assembly', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('new-assembly') },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Open Recent', submenu: recent.length ? recent.map((p) => ({ label: p, click: () => send('open', p) })) : [{ label: '(none)', enabled: false }] },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
      { type: 'separator' },
      { label: 'Import (STEP, IGES, DXF, DWG)…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
      { label: 'Import Point Cloud (LAS, LAZ, PLY, XYZ, PTS)…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('import-pc') },
      { label: 'Export', submenu: [
        { label: 'STEP (.step)…', click: () => send('export-step') },
        { label: 'IGES (.igs)…', click: () => send('export-iges') },
        { label: 'DXF (.dxf)…', click: () => send('export-dxf') },
        { label: 'DWG (.dwg)…', click: () => send('export-dwg') },
      ] },
      { type: 'separator' },
      { label: 'New Window', click: () => createWindow() },
      { role: 'quit', label: 'Exit' },
    ] },
    { label: '&Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo'), registerAccelerator: false },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('redo'), registerAccelerator: false },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
    ] },
    { label: '&View', submenu: [
      { label: 'Zoom to Fit', click: () => send('zoom-fit') },
      { type: 'separator' },
      ...['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].map((v) => ({ label: v === 'iso' ? 'Isometric' : v[0].toUpperCase() + v.slice(1), click: () => send('view', v) })),
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools', label: 'Developer Tools' },
    ] },
    { label: '&Interface', submenu: [
      { label: 'Dark Mode', type: 'checkbox', checked: uiDark, click: (mi) => send('theme', mi.checked) },
      { type: 'separator' },
      { label: 'UI Scale…', click: () => send('ui-scale') },
      { label: 'Reset UI Scale (100%)', click: () => send('ui-scale-reset') },
    ] },
    { label: '&Help', submenu: [
      { label: 'Keyboard && Mouse', accelerator: 'F1', click: () => send('shortcuts') },
      { label: 'About MonoLith', click: () => send('about') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------------- DWG via ODA File Converter ----------------
function findODA() {
  const candidates = [];
  const roots = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean).map((r) => path.join(r, 'ODA'))
    : ['/usr/bin', '/usr/local/bin', '/opt/ODAFileConverter'];
  for (const r of roots) {
    try {
      if (process.platform !== 'win32') { const p = path.join(r, 'ODAFileConverter'); if (fs.existsSync(p)) candidates.push(p); continue; }
      for (const d of fs.readdirSync(r)) {
        const p = path.join(r, d, 'ODAFileConverter.exe');
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch { /* not installed */ }
  }
  return candidates.sort().pop() || null;
}
function runODA(inDir, outDir, version, type) {
  const exe = findODA();
  if (!exe) return Promise.reject(new Error('ODA File Converter not found'));
  return new Promise((resolve, reject) => {
    execFile(exe, [inDir, outDir, version, type, '0', '1', '*.*'], { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}
async function dwgToDxf(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-'));
  const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir); fs.mkdirSync(outDir);
  fs.copyFileSync(file, path.join(inDir, path.basename(file)));
  await runODA(inDir, outDir, 'ACAD2018', 'DXF');
  const out = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.dxf'));
  if (!out) throw new Error('Conversion produced no DXF');
  const text = fs.readFileSync(path.join(outDir, out), 'latin1');
  fs.rmSync(tmp, { recursive: true, force: true });
  return text;
}
async function dxfToDwg(text, outPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-'));
  const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir); fs.mkdirSync(outDir);
  const base = path.basename(outPath).replace(/\.dwg$/i, '');
  fs.writeFileSync(path.join(inDir, base + '.dxf'), text, 'latin1');
  await runODA(inDir, outDir, 'ACAD2018', 'DWG');
  const out = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.dwg'));
  if (!out) throw new Error('Conversion produced no DWG');
  fs.copyFileSync(path.join(outDir, out), outPath);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------- installed fonts ----------------
function fontDirs() {
  if (process.platform === 'win32') {
    const dirs = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  if (process.platform === 'darwin') return ['/Library/Fonts', '/System/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')];
  return ['/usr/share/fonts', path.join(os.homedir(), '.fonts')];
}
// Read the full font name (nameID 4) from a TrueType/OpenType 'name' table.
function fontName(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0);
    const numTables = head.readUInt16BE(4);
    const dir = Buffer.alloc(numTables * 16); fs.readSync(fd, dir, 0, dir.length, 12);
    for (let i = 0; i < numTables; i++) {
      if (dir.toString('latin1', i * 16, i * 16 + 4) !== 'name') continue;
      const off = dir.readUInt32BE(i * 16 + 8), len = dir.readUInt32BE(i * 16 + 12);
      const t = Buffer.alloc(Math.min(len, 65536)); fs.readSync(fd, t, 0, t.length, off);
      const count = t.readUInt16BE(2), strOff = t.readUInt16BE(4);
      let best = null;
      for (let k = 0; k < count; k++) {
        const r = 6 + k * 12;
        const plat = t.readUInt16BE(r), lang = t.readUInt16BE(r + 4), nameId = t.readUInt16BE(r + 6), l = t.readUInt16BE(r + 8), o = t.readUInt16BE(r + 10);
        if (nameId !== 4) continue;
        const raw = t.subarray(strOff + o, strOff + o + l);
        if (plat === 3) {
          const sw = Buffer.from(raw); sw.swap16();
          const str = sw.toString('utf16le');
          if (lang === 0x409) return str;
          best = best || str;
        } else if (plat === 1 && !best) best = raw.toString('latin1');
      }
      return best;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
let fontList = null;
function listFonts() {
  if (fontList) return fontList;
  const out = [];
  const walk = (dir, depth = 0) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/\.(ttf|otf)$/i.test(e.name)) {
        try { const n = fontName(p); if (n) out.push({ name: n, path: p }); } catch { /* unreadable font */ }
      }
    }
  };
  fontDirs().forEach((d) => walk(d));
  const seen = new Set();
  fontList = out.filter((f) => !seen.has(f.name) && seen.add(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  return fontList;
}

// ---------------- IPC ----------------
function readDoc(p) {
  const ext = path.extname(p).toLowerCase();
  const enc = ext === '.dxf' ? 'latin1' : 'utf8';
  if (ext === '.dwg') return { path: p, text: '' };
  let text = fs.readFileSync(p, enc);
  if (ext === '.dxf' && /\$DWGCODEPAGE[\s\S]{0,40}UTF-?8/i.test(text.slice(0, 4000))) text = fs.readFileSync(p, 'utf8');
  return { path: p, text };
}
function setupIPC() {
  pruneLogs();
  writeLog([`${new Date().toTimeString().slice(0, 8)} ===== MonoLith ${app.getVersion()} started =====`]);
  ipcMain.on('log', (_e, lines) => writeLog(lines));
  ipcMain.handle('log:dir', () => logDir());
  ipcMain.handle('log:cfg', (_e, c) => (c ? setLogCfg(c) : getLogCfg()));
  ipcMain.on('ui:dark', (_e, d) => { if (uiDark !== !!d) { uiDark = !!d; buildMenu(); } });
  ipcMain.on('ui:zoom', (e, f) => { const z = Math.min(2, Math.max(0.6, +f || 1)); e.sender.setZoomFactor(z); });
  ipcMain.handle('kernel', (_e, op, args) => kernel(op, args));
  ipcMain.handle('file:open', async (e, opts = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts.filters });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    addRecent(p); buildMenu();
    if (opts.noRead || /\.(las|laz|ply|xyz|pts|txt|csv)$/i.test(p)) return { path: p, text: '' };
    return readDoc(p);
  });
  ipcMain.handle('file:read', (_e, p) => { addRecent(p); if (/\.(las|laz|ply|xyz|pts|txt|csv)$/i.test(p)) return { path: p, text: '' }; return readDoc(p); });
  ipcMain.handle('pc:info', (e, p) => pcCall('info', { path: p }, e.sender));
  ipcMain.handle('pc:load', (e, args) => pcCall('load', args, e.sender));
  ipcMain.handle('file:exists', (_e, p) => fs.existsSync(p));
  ipcMain.handle('file:save', async (e, opts = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters: opts.filters });
    if (r.canceled || !r.filePath) return null;
    if (!opts.noWrite) fs.writeFileSync(r.filePath, opts.text ?? '', /\.dxf$/i.test(r.filePath) ? 'latin1' : 'utf8');
    addRecent(r.filePath); buildMenu();
    return r.filePath;
  });
  ipcMain.handle('file:write', (_e, p, text) => { fs.writeFileSync(p, text, 'utf8'); addRecent(p); return true; });
  ipcMain.handle('dwg:toDxf', async (_e, p) => { try { return { ok: true, text: await dwgToDxf(p) }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
  ipcMain.handle('dwg:fromDxf', async (_e, text, outPath) => { try { await dxfToDwg(text, outPath); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
  ipcMain.handle('win:new', (_e, kind, p) => { createWindow(p ? { open: p } : { kind }); return true; });
  ipcMain.on('win:title', (e, t) => { BrowserWindow.fromWebContents(e.sender)?.setTitle(t); });
  ipcMain.on('win:dirty', (e, d) => { BrowserWindow.fromWebContents(e.sender)?.setDocumentEdited?.(!!d); });
  ipcMain.on('win:confirmClose', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.forceClose = true; w.close(); } });
  ipcMain.handle('recent', () => getRecent());
  ipcMain.handle('fonts:list', () => listFonts());
  ipcMain.handle('fonts:read', (_e, p) => {
    if (!listFonts().some((f) => f.path === p)) throw new Error('Unknown font');
    return new Uint8Array(fs.readFileSync(p));
  });
  ipcMain.handle('info', () => ({ version: app.getVersion(), occt: '7.6 (WASM)', electron: process.versions.electron }));
  ipcMain.handle('openExternal', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

// ---------------- app lifecycle ----------------
const fileArg = () => process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(lithprt|lithasm|lithpln|ekprt|ekasm|ekpln|dxf|dwg|step|stp|igs|iges|las|laz|ply|xyz|pts)$/i.test(a) && fs.existsSync(a));

if (!app.requestSingleInstanceLock() && !isTest) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const f = argv.find((a) => /\.(lithprt|lithasm|lithpln|ekprt|ekasm|ekpln|dxf|dwg|step|stp|igs|iges)$/i.test(a) && fs.existsSync(a));
    const w = [...windows][0];
    if (!w) { createWindow(f ? { open: f } : {}); return; }
    if (w.isMinimized()) w.restore();
    w.focus();
    if (f) w.webContents.send('menu', 'open', f); // opens in a new tab
  });
  app.whenReady().then(() => {
    protocol.handle('monolith', (req) => {
      const u = new URL(req.url);
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(RENDERER, rel));
      if (!full.startsWith(RENDERER)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(full).toString());
    });
    startWorker();
    setupIPC();
    buildMenu();
    const f = fileArg();
    const kind = process.env.MONOLITH_KIND;
    createWindow(f ? { open: f } : kind ? { kind } : {});
  });
  app.on('window-all-closed', () => { worker?.terminate(); pcWorker?.terminate(); app.quit(); });
}

module.exports = { kernel };
