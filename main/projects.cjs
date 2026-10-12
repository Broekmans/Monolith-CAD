// Projects: every subfolder of <CAD Program>\Projects is one project. Scans the .lith* files in it,
// finds the main assembly (an assembly no other assembly in the project uses), subassemblies and parts,
// and picks the project thumbnail: main assembly > subassembly > part.
const { app, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

function projectsRoot() {
  const d = process.env.MONOLITH_PROJECTS || (app.isPackaged ? path.join(path.dirname(path.dirname(process.execPath)), 'Projects') : path.join(app.getPath('userData'), 'Projects'));
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}
const KIND = { '.lithprt': 'part', '.lithasm': 'assembly', '.lithpln': 'plan', '.lithpcd': 'cloud', '.lithdrw': 'drawing' };
const norm = (p) => path.resolve(p).toLowerCase();

function walk(dir, out = [], depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.')) walk(p, out, depth + 1); } else if (KIND[path.extname(e.name).toLowerCase()]) out.push(p);
  }
  return out;
}
function readInfo(p) {
  const kind = KIND[path.extname(p).toLowerCase()];
  let st; try { st = fs.statSync(p); } catch { return null; }
  const info = { path: p, kind, name: path.basename(p, path.extname(p)), mtime: st.mtimeMs, thumb: null, uses: [] };
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    info.thumb = typeof d.thumb === 'string' ? d.thumb : null;
    if (kind === 'assembly') info.uses = (d.components || []).filter((c) => c.path).map((c) => c.path);
  } catch { /* unreadable: listed without thumbnail */ }
  return info;
}
function scanProject(dir) {
  const files = walk(dir).map(readInfo).filter(Boolean);
  const asms = files.filter((f) => f.kind === 'assembly');
  const used = new Set();
  for (const a of asms) for (const u of a.uses) { used.add(norm(u)); used.add(norm(path.join(path.dirname(a.path), path.basename(u)))); }
  const tops = asms.filter((a) => !used.has(norm(a.path)));
  // several unused assemblies: the one using the most files is the main one
  const main = tops.sort((a, b) => b.uses.length - a.uses.length || b.mtime - a.mtime)[0] || null;
  for (const f of files) f.role = f === main ? 'main' : f.kind === 'assembly' ? 'sub' : f.kind;
  const pick = (list) => list.find((f) => f.thumb) || list[0] || null;
  const subs = asms.filter((a) => a !== main).sort((a, b) => b.uses.length - a.uses.length);
  const parts = files.filter((f) => f.kind === 'part').sort((a, b) => b.mtime - a.mtime);
  const cover = (main && main.thumb ? main : null) || pick(subs) || pick(parts) || pick(files);
  const order = { main: 0, sub: 1, part: 2, plan: 3, cloud: 4, drawing: 5 };
  files.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const mtime = Math.max(0, ...files.map((f) => f.mtime));
  return { name: path.basename(dir), dir, main: main?.path || null, cover: cover ? { path: cover.path, thumb: cover.thumb, kind: cover.kind } : null, mtime,
    files: files.map(({ path: p, kind, name, role, thumb, mtime: m }) => ({ path: p, kind, name, role, thumb, mtime: m })) };
}
function listProjects() {
  const root = projectsRoot();
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { /* none */ }
  const list = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => scanProject(path.join(root, e.name)));
  return { root, projects: list.sort((a, b) => b.mtime - a.mtime) };
}
function createProject(name) {
  const clean = String(name || '').replace(/[<>:"/\\|?*]/g, '').trim();
  if (!clean) throw new Error('Invalid project name');
  const dir = path.join(projectsRoot(), clean);
  if (fs.existsSync(dir)) throw new Error('A project with this name already exists');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const openFolder = (dir) => shell.openPath(dir || projectsRoot());

module.exports = { projectsRoot, listProjects, scanProject, createProject, openFolder };
