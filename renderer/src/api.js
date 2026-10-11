// Bridge to the Electron main process (exposed by preload.cjs).
const bridge = globalThis.window?.monolith || {};

export const api = {
  kernel: (op, args) => bridge.kernel(op, args).then((r) => { if (r && r.__error) { globalThis.lithLog?.('KERNEL ERROR', op, r.__error); throw new Error(r.__error); } return r; }),
  openFile: (opts) => bridge.openFile(opts), // -> {path, text|base64} | null
  saveFile: (opts) => bridge.saveFile(opts), // {defaultPath, filters, text} -> path | null
  writeFile: (path, text) => bridge.writeFile(path, text),
  readFile: (path) => bridge.readFile(path),
  dwgToDxf: (path) => bridge.dwgToDxf(path),
  dxfToDwg: (dxfText, outPath) => bridge.dxfToDwg(dxfText, outPath),
  newWindow: (kind, path) => bridge.newWindow(kind, path),
  setTitle: (t) => bridge.setTitle(t),
  setDirty: (d) => bridge.setDirty(d),
  log: (lines) => bridge.log?.(lines),
  logCfg: (c) => bridge.logCfg?.(c),
  logDir: () => bridge.logDir?.(),
  setDarkMenu: (d) => bridge.setDarkMenu?.(d),
  setZoom: (f) => bridge.setZoom?.(f),
  onMenu: (fn) => bridge.onMenu(fn),
  onBeforeClose: (fn) => bridge.onBeforeClose(fn),
  confirmClose: () => bridge.confirmClose(),
  recent: () => bridge.recent(),
  projects: () => bridge.projects(),
  createProject: (name) => bridge.createProject(name),
  openProjectFolder: (dir) => bridge.openProjectFolder(dir),
  listFonts: () => bridge.listFonts(),
  readFont: (p) => bridge.readFont(p),
  info: () => bridge.info(),
  pcInfo: (p) => bridge.pcInfo(p),
  pcLoad: (args) => bridge.pcLoad(args),
  fileExists: (p) => bridge.fileExists(p),
  onPcProgress: (fn) => bridge.onPcProgress(fn),
  openExternal: (url) => bridge.openExternal(url),
};
