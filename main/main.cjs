// Electron main process: windows, menus, file dialogs, IPC and app lifecycle.
// Kernel workers -> kernel.cjs, settings/logs/recent -> settings.cjs, DWG + fonts -> tools.cjs.
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
const { listProjects, createProject, openFolder, projectsRoot } = require('./projects.cjs');
const { pcCall, startWorker, kernel, stopWorkers, setKernelMode } = require('./kernel.cjs');
const { optionsCfg, trackOptions, writeDump, draftStd, logDir, pruneLogs, getLogCfg, setLogCfg, writeLog, getRecent, addRecent } = require('./settings.cjs');
const { dwgToDxf, dxfToDwg, converterStatus, setODAPath, listFonts } = require('./tools.cjs');
const { setupCloudIPC, stopCloudWorkers } = require('./cloudio.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'monolith', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

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
  // 0.1.129: popups / the Motion Study can become their own windows (renderer popout.js: window.open('about:blank') +
  // the live panel moved into it). Same process and origin as the main window; no menu; stays above its main window.
  win.webContents.setWindowOpenHandler(({ url }) => (url === 'about:blank' || url === '' ? {
    action: 'allow',
    overrideBrowserWindowOptions: { parent: win, useContentSize: true, autoHideMenuBar: true, minimizable: false, fullscreenable: false, backgroundColor: '#2a2f38', icon: path.join(ROOT, 'build', 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } },
  } : { action: 'deny' }));
  win.webContents.on('did-create-window', (child) => { try { child.setMenu(null); } catch { /* ok */ } });
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
  let w = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (w && !windows.has(w)) w = w.getParentWindow?.() || [...windows][0]; // 0.1.129: a popup window → its main window
  w?.webContents.send('menu', cmd, arg);
}

let uiDark = false, uiGrid = true, uiIso = true;
// Viewport menu state of the active document (null = no 3D document: items disabled)
let uiVp = null; // { layout, grid, multi }
function buildMenu() {
  const recent = getRecent();
  const tpl = [
    { label: '&File', submenu: [
      { label: 'New Part', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('new-part') },
      { label: 'New Plan / Drawing', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('new-plan') },
      { label: 'New Assembly', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('new-assembly') },
      { label: 'New Point Cloud', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('new-cloud') },
      { label: 'New Drawing', click: () => send('new-drawing') },
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
        { type: 'separator' },
        { label: 'DWG Converter…', click: () => send('dwg-converter') },
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
    { label: 'View&port', submenu: [
      ...[['single', 'Single View'], ['two-v', 'Two Views Side by Side'], ['two-h', 'Two Views Stacked'], ['four', 'Four Views']].map(([id, label]) => (
        { label, type: 'radio', checked: (uiVp?.layout || 'single') === id, enabled: !!uiVp, click: () => send('layout', id) })),
      { label: 'Custom (views closed)', type: 'radio', checked: uiVp?.layout === 'custom', enabled: false, visible: uiVp?.layout === 'custom' },
      { type: 'separator' },
      { label: uiVp?.max ? 'Restore Views' : 'Maximize View', enabled: !!uiVp?.multi, click: () => send('max-view') },
      { label: 'Minimize View', enabled: !!uiVp?.multi, click: () => send('min-view') },
      { label: 'Restore Minimized Views', enabled: !!uiVp?.mins, click: () => send('restore-mins') },
      { label: 'Close View', enabled: !!uiVp?.multi, click: () => send('close-view') },
      { label: 'Reset Views', enabled: !!uiVp, click: () => send('reset-views') },
      { type: 'separator' },
      { label: 'Show Grid in This Document', type: 'checkbox', checked: !!uiVp?.grid, enabled: !!uiVp && uiVp.grid !== null, click: (mi) => send('doc-grid', mi.checked) },
      { label: 'Grid On by Default', type: 'checkbox', checked: uiGrid, click: (mi) => send('grid', mi.checked) },
    ] },
    { label: '&Interface', submenu: [
      { label: 'Dark Mode', type: 'checkbox', checked: uiDark, click: (mi) => send('theme', mi.checked) },
      { label: 'Turn to Isometric for Features', type: 'checkbox', checked: uiIso, click: (mi) => send('iso-features', mi.checked) },
      { type: 'separator' },
      { label: 'UI Scale…', click: () => send('ui-scale') },
      { label: 'Reset UI Scale (100%)', click: () => send('ui-scale-reset') },
      { type: 'separator' },
      { label: 'Ribbon Buttons', submenu: [['large', 'Large'], ['medium', 'Medium'], ['small', 'Small']].map(([v, l]) => ({ label: l, click: () => send('ribbon-size', v) })) },
      { label: 'Show / Hide Quick Access Bar', click: () => send('qa-bar') },
      { label: 'Show / Hide Ribbon Group Names', click: () => send('ribbon-labels') },
    ] },
    { label: '&Tools', submenu: [
      { label: 'Options…', click: () => send('options') },
    ] },
    { label: '&Help', submenu: [
      { label: 'Keyboard && Mouse', accelerator: 'F1', click: () => send('shortcuts') },
      { label: 'About MonoLith', click: () => send('about') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
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
  ipcMain.handle('log:dump', (_e, n, t) => writeDump(n, t));
  ipcMain.handle('std:cfg', (_e, s) => draftStd(s));
  ipcMain.handle('options:cfg', (_e, o) => optionsCfg(o));
  ipcMain.handle('options:track', (_e, l) => trackOptions(l));
  ipcMain.handle('log:cfg', (_e, c) => (c ? setLogCfg(c) : getLogCfg()));
  ipcMain.on('ui:grid', (_e, g) => { if (uiGrid !== !!g) { uiGrid = !!g; buildMenu(); } });
  ipcMain.on('ui:iso', (_e, g) => { if (uiIso !== !!g) { uiIso = !!g; buildMenu(); } });
  ipcMain.on('ui:viewport', (_e, v) => { const j = JSON.stringify(v ?? null); if (j !== JSON.stringify(uiVp)) { uiVp = v ?? null; buildMenu(); } });
  ipcMain.on('ui:dark', (_e, d) => { if (uiDark !== !!d) { uiDark = !!d; buildMenu(); } });
  ipcMain.on('ui:zoom', (e, f) => { const z = Math.min(2, Math.max(0.6, +f || 1)); e.sender.setZoomFactor(z); });
  ipcMain.handle('kernel', (_e, op, args) => kernel(op, args));
  ipcMain.handle('kernel:mode', (_e, multi) => setKernelMode(multi));
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
  setupCloudIPC(ipcMain);
  ipcMain.handle('pc:info', (e, p) => pcCall('info', { path: p }, e.sender));
  ipcMain.handle('pc:load', (e, args) => pcCall('load', args, e.sender));
  ipcMain.handle('file:exists', (_e, p) => fs.existsSync(p));
  ipcMain.handle('file:save', async (e, opts = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath, filters: opts.filters });
    if (r.canceled || !r.filePath) return null;
    if (!opts.noWrite) fs.writeFileSync(r.filePath, opts.text ?? '', opts.latin1 || /\.(dxf|pdf)$/i.test(r.filePath) ? 'latin1' : 'utf8');
    addRecent(r.filePath); buildMenu();
    return r.filePath;
  });
  ipcMain.handle('file:writeBytes', (_e, p, bytes) => { fs.writeFileSync(p, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)); return true; }); // 0.1.122 Save Animation
  ipcMain.handle('file:write', (_e, p, text) => { fs.writeFileSync(p, text, /\.pdf$/i.test(p) ? 'latin1' : 'utf8'); addRecent(p); return true; });
  ipcMain.handle('dwg:toDxf', async (_e, p) => { try { const r = await dwgToDxf(p); return { ok: true, text: r.text, via: r.via }; } catch (err) { return { ok: false, error: String(err.message || err), status: converterStatus() }; } });
  ipcMain.handle('dwg:fromDxf', async (_e, text, outPath) => { try { return { ok: true, ...(await dxfToDwg(text, outPath)) }; } catch (err) { return { ok: false, error: String(err.message || err), status: converterStatus() }; } });
  ipcMain.handle('dwg:status', () => converterStatus());
  ipcMain.handle('dwg:setOda', (_e, p) => { try { return { ok: true, ...setODAPath(p) }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
  ipcMain.handle('win:new', (_e, kind, p) => { createWindow(p ? { open: p } : { kind }); return true; });
  ipcMain.on('win:title', (e, t) => { BrowserWindow.fromWebContents(e.sender)?.setTitle(t); });
  ipcMain.on('win:dirty', (e, d) => { BrowserWindow.fromWebContents(e.sender)?.setDocumentEdited?.(!!d); });
  ipcMain.on('win:confirmClose', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.forceClose = true; w.close(); } });
  ipcMain.handle('recent', () => getRecent());
  ipcMain.handle('projects:list', () => listProjects());
  ipcMain.handle('projects:create', (_e, name) => { try { return { dir: createProject(name) }; } catch (e) { return { error: e.message }; } });
  ipcMain.handle('projects:open-folder', (_e, dir) => openFolder(dir));
  ipcMain.handle('projects:root', () => projectsRoot());
  ipcMain.handle('fonts:list', () => listFonts());
  ipcMain.handle('fonts:read', (_e, p) => {
    if (!listFonts().some((f) => f.path === p)) throw new Error('Unknown font');
    return new Uint8Array(fs.readFileSync(p));
  });
  ipcMain.handle('info', () => ({ version: app.getVersion(), occt: (() => { try { return 'replicad-opencascadejs ' + require('replicad-opencascadejs/package.json').version + ' (WASM)'; } catch { return 'WASM'; } })(), electron: process.versions.electron }));
  ipcMain.handle('openExternal', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

// ---------------- app lifecycle ----------------
const fileArg = () => process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(lithprt|lithasm|lithpln|lithpcd|lithdrw|ekprt|ekasm|ekpln|dxf|dwg|step|stp|igs|iges|las|laz|ply|xyz|pts)$/i.test(a) && fs.existsSync(a));

if (!app.requestSingleInstanceLock() && !isTest) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const f = argv.find((a) => /\.(lithprt|lithasm|lithpln|lithpcd|lithdrw|ekprt|ekasm|ekpln|dxf|dwg|step|stp|igs|iges)$/i.test(a) && fs.existsSync(a));
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
  app.on('window-all-closed', () => { stopWorkers(); stopCloudWorkers(); app.quit(); });
}

module.exports = { kernel };
