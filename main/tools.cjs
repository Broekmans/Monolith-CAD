// External tools: DWG <-> DXF through the ODA File Converter, installed font list.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.join(__dirname, '..');
const isTest = !!process.env.MONOLITH_TEST;

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

module.exports = { dwgToDxf, dxfToDwg, listFonts };
