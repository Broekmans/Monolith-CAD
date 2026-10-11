// Application shell: layout, welcome screen, document lifecycle, file I/O,
// menus and keyboard routing.
import { h, CommandManager, PropertyManager, toast, dialog } from './ui.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { initActionLog, askLogConsentOnce } from './actionlog.js';
import { initSolver } from './sketch/solver.js';
import { setSketchTheme } from './sketch/sketcher.js';
import { PartDoc, newPartDoc } from './part/part.js';
import { PlanDoc, newPlanDoc } from './plan/plan.js';
import { AssemblyDoc, newAssemblyDoc, partSaved } from './assembly/assembly.js';
const EXT = { part: 'lithprt', plan: 'lithpln', assembly: 'lithasm' };
const extOf = (k) => EXT[k] || 'lithprt';
import { PC_EXTS, isPointCloud, askImportOptions } from './pointcloud.js';

const APP_NAME = 'MonoLith';
const SLOTS = ['cmd', 'tree', 'props', 'pm', 'views', 'headsUp', 'corner', 'sketchStatus', 'toggles', 'right'];

class App {
  constructor() {
    this.doc = null;
    this.path = null;
    this.dirty = false;
    this.root = this;
    this.tabs = [];
    this.active = this;
    this.buildLayout();
    this.bindGlobal();
  }

  setTheme(dark, init) {
    document.body.classList.toggle('dark', dark);
    setSketchTheme(dark);
    try { localStorage.setItem('monolith.theme', dark ? 'dark' : 'light'); } catch {}
    window.dispatchEvent(new Event('monolith-theme'));
    api.setDarkMenu(dark);
    if (!init) { try { this.doc?.vp?.requestRender?.(); } catch {} }
  }

  setUiScale(f, save = true) {
    f = Math.min(2, Math.max(0.6, Math.round(f * 20) / 20));
    this.uiScale = f; api.setZoom(f);
    if (save) { try { localStorage.setItem('monolith.uiScale', String(f)); } catch {} }
  }
  uiScaleDialog() {
    const start = this.uiScale || 1;
    const val = h('b', { style: 'min-width:48px;display:inline-block;text-align:right' }, Math.round(start * 100) + '%');
    const sl = h('input', { type: 'range', min: '60', max: '200', step: '5', value: String(Math.round(start * 100)), style: 'flex:1' });
    sl.addEventListener('input', () => { val.textContent = sl.value + '%'; });
    sl.addEventListener('change', () => this.setUiScale(+sl.value / 100, false)); // live preview on release
    dialog({ title: 'UI Scale', body: h('div', { style: 'min-width:340px' },
      h('p', {}, 'Make buttons, text and panels bigger or smaller. The 3D view stays sharp.'),
      h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('span', {}, '60%'), sl, h('span', {}, '200%'), val)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] })
      .then((ok) => this.setUiScale(ok ? +sl.value / 100 : start, true));
  }

  buildLayout() {
    const root = document.getElementById('app');
    const qa = h('div', { class: 'qa' },
      h('div', { class: 'brand', html: icon('part') }, h('span', {}, APP_NAME)),
      ...[['newDoc', 'New (Ctrl+N)', () => this.newDialog()], ['open', 'Open (Ctrl+O)', () => this.open()], ['save', 'Save (Ctrl+S)', () => this.save()],
        ['undo', 'Undo (Ctrl+Z)', () => this.doc?.undo()], ['redo', 'Redo (Ctrl+Y)', () => this.doc?.redo()]]
        .map(([ic, tip, run]) => h('button', { class: 'qa-btn', title: tip, html: icon(ic), onclick: run })),
      h('div', { class: 'doc-title', id: 'docTitle' }, ''),
      h('div', { class: 'busy', id: 'busy' }, h('span', { class: 'spinner' }), 'Rebuilding…'));
    let dark = false; try { dark = localStorage.getItem('monolith.theme') === 'dark'; } catch {}
    this.setTheme(dark, true);
    let sc = 1; try { sc = +localStorage.getItem('monolith.uiScale') || 1; } catch {}
    this.setUiScale(sc, false);
    this.el = {};
    this.el.cmd = h('div', { class: 'cmdmgr' });
    this.el.tree = h('div', { class: 'panel tree' });
    this.el.props = h('div', { class: 'panel props' });
    this.el.pm = h('div', { class: 'panel pmroot' });
    this.el.leftTabs = h('div', { class: 'left-tabs' });
    this.el.left = h('div', { class: 'left' }, this.el.leftTabs, this.el.tree, this.el.props, this.el.pm);
    this.el.views = h('div', { class: 'views' });
    this.el.headsUp = h('div', { class: 'headsup' });
    this.el.corner = h('div', { class: 'corner' });
    const viewsWrap = h('div', { class: 'views-wrap' }, this.el.views, this.el.headsUp, this.el.corner);
    const splitter = h('div', { class: 'splitter' });
    this.el.body = h('div', { class: 'body' }, this.el.left, splitter, viewsWrap);
    // command line (plan)
    this.el.cmdLog = h('div', { class: 'cl-log' });
    this.el.cmdPrompt = h('span', { class: 'cl-prompt' }, 'Command:');
    this.el.cmdInput = h('input', { class: 'cl-input', spellcheck: 'false' });
    this.el.cmdline = h('div', { class: 'cmdline', style: { display: 'none' } }, this.el.cmdLog, h('div', { class: 'cl-row' }, h('span', { class: 'cl-icon' }, '›'), this.el.cmdPrompt, this.el.cmdInput));
    // status bar
    this.el.status = h('span', { class: 'st-left' }, 'Ready');
    this.el.sketchStatus = h('span', { class: 'st-sketch' });
    this.el.coords = h('span', { class: 'st-coords' });
    this.el.toggles = h('span', { class: 'st-toggles' });
    this.el.right = h('span', { class: 'st-right' });
    const status = h('div', { class: 'statusbar' }, this.el.status, h('span', { class: 'grow' }), this.el.sketchStatus, this.el.coords, this.el.toggles, this.el.right);
    this.el.welcome = h('div', { class: 'welcome' });
    this.el.docTabs = h('div', { class: 'doctabs' });
    root.append(qa, this.el.cmd, this.el.body, this.el.cmdline, status, this.el.docTabs, this.el.welcome);
    this.cm = new CommandManager(this.el.cmd);
    this.pm = new PropertyManager(this.el.pm);
    this.wrapPM(this);
    this.renderDocTabs();
    // splitter drag
    splitter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const start = e.clientX, w0 = this.el.left.offsetWidth;
      const mv = (ev) => { this.el.left.style.width = Math.max(200, Math.min(600, w0 + ev.clientX - start)) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    this.el.cmdInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || (e.key === ' ' && !/[A-Za-z@<,]/.test(this.el.cmdInput.value.slice(-1)) && this.el.cmdInput.value.trim() === '')) {
        e.preventDefault();
        const v = this.el.cmdInput.value; this.el.cmdInput.value = '';
        this.logCommand(`${this.el.cmdPrompt.textContent} ${v}`);
        this.cur().cmdHandler?.(v);
        this.el.cmdInput.blur();
      } else if (e.key === ' ' && this.el.cmdInput.value.trim() && !this.cur().doc?.cmd) {
        e.preventDefault();
        const v = this.el.cmdInput.value; this.el.cmdInput.value = '';
        this.cur().cmdHandler?.(v); this.el.cmdInput.blur();
      } else if (e.key === 'Escape') { this.el.cmdInput.value = ''; this.el.cmdInput.blur(); this.cur().doc?.onKey?.(e); }
    });
  }

  // ---------- shell API used by documents ----------
  setStatus(t, kind = '') { this.el.status.textContent = t; this.el.status.className = 'st-left ' + kind; }
  setStatusRight(t) { this.el.right.textContent = t; }
  setCoords(t) { this.el.coords.textContent = t; }
  setSketchStatus(st) {
    this.el.sketchStatus.textContent = st ? st.text : '';
    this.el.sketchStatus.className = 'st-sketch ' + (st?.cls || '');
    this.el.sketchStatus.style.display = st ? 'inline-block' : 'none';
    if (this.doc?.sketcher) this.el.sketchStatus.textContent = `Editing ${this.doc.sketcher.sk.name}   ${st.text}`;
  }
  setToggles(list) {
    this.el.toggles.innerHTML = '';
    for (const t of list) this.el.toggles.appendChild(h('button', { class: 'tog' + (t.on ? ' on' : ''), title: t.key, onclick: t.run }, t.label));
  }
  setBusy(b) { document.getElementById('busy').classList.toggle('on', !!b); }
  setDirty(d) { this.dirty = d; this.updateTitle(); api.setDirty(this.root.tabs.some((t) => t.dirty)); }
  updateTitle() {
    this.root.renderDocTabs();
    if (!this.isActive()) return;
    const name = this.doc ? this.doc.title : '';
    const file = this.path ? this.path.split(/[\\/]/).pop() : name + '.' + extOf(this.doc?.doc.kind);
    document.getElementById('docTitle').textContent = this.doc ? `${file}${this.dirty ? ' *' : ''}` : '';
    api.setTitle(this.doc ? `${file}${this.dirty ? ' *' : ''} - ${APP_NAME}` : APP_NAME);
  }
  showPanel(which) {
    this.panel = which;
    this.el.tree.style.display = which === 'tree' ? '' : 'none';
    this.el.props.style.display = which === 'props' ? '' : 'none';
    this.el.pm.style.display = which === 'pm' ? '' : 'none';
    this.renderLeftTabs();
  }
  renderLeftTabs() {
    if (!this.isActive()) return;
    const kind = this.doc?.doc.kind;
    const tabs = kind === 'plan' ? [['tree', 'layers', 'Layers & Properties']] : kind === 'assembly' ? [['tree', 'assembly', 'Assembly'], ['pm', 'check', 'PropertyManager']] : [['tree', 'part', 'FeatureManager'], ['props', 'relation', 'Sketch'], ['pm', 'check', 'PropertyManager']];
    this.el.leftTabs.innerHTML = '';
    for (const [id, ic, tip] of tabs) {
      if (id === 'pm' && !this.pm.open) continue;
      if (id === 'props' && !this.doc?.sketcher) continue;
      this.el.leftTabs.appendChild(h('button', { class: 'lt' + (this.panel === id ? ' on' : ''), title: tip, onclick: () => this.showPanel(id) }, h('span', { class: 'ico sm', html: icon(ic) }), h('span', {}, tip)));
    }
  }
  setConfirmCorner(c) {
    const el = this.el.corner;
    el.innerHTML = '';
    if (!c) { el.style.display = 'none'; if (['part', 'assembly'].includes(this.doc?.doc.kind) && !this.doc.sketcher && !this.pm.open) this.showPanel('tree'); return; }
    el.style.display = 'flex';
    el.append(h('button', { class: 'cc ok', title: c.okTip || 'OK', html: icon(c.okTip === 'Exit Sketch' ? 'exitSketch' : 'check'), onclick: c.ok }),
      h('button', { class: 'cc cancel', title: c.cancelTip || 'Cancel', html: icon('cancel'), onclick: c.cancel }));
  }
  showCommandLine(on, handler) { this.cmdOn = on; this.cmdHandler = handler; if (this.isActive()) this.el.cmdline.style.display = on ? '' : 'none'; }
  setPrompt(t) { this.el.cmdPrompt.textContent = t; }
  logCommand(t) {
    const log = this.el.cmdLog;
    log.appendChild(h('div', {}, t));
    while (log.children.length > 50) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  cmdInputHasText() { return this.el.cmdInput.value.trim().length > 0; }
  focusCommandLine(ch) { this.el.cmdInput.focus(); if (ch) this.el.cmdInput.value += ch; }

  // ---------- documents & tabs ----------
  // Each open document lives in a tab: an object inheriting from the App with its own
  // doc/path/dirty, command manager, property manager and UI slot elements, so a
  // document always renders into its own DOM even while its tab is hidden.
  isActive() { return this.root.active === this; }
  cur() { return this.root.active; }
  wrapPM(t) {
    const pm = t.pm, pmShow = pm.show.bind(pm), pmClose = pm.close.bind(pm);
    pm.show = (...a) => { const r = pmShow(...a); t.showPanel('pm'); return r; };
    pm.close = (...a) => { const r = pmClose(...a); if (t.panel === 'pm') t.showPanel(t.doc?.sketcher ? 'props' : 'tree'); else t.renderLeftTabs(); return r; };
  }
  newTab() {
    const app = this.root;
    const t = Object.create(app);
    t.el = Object.create(app.el);
    for (const k of SLOTS) {
      const n = app.el[k].cloneNode(false);
      n.removeAttribute('id'); n.innerHTML = '';
      t.el[k] = n;
    }
    t.cm = new CommandManager(t.el.cmd);
    t.pm = new PropertyManager(t.el.pm);
    t.doc = null; t.path = null; t.dirty = false; t.cmdOn = false; t.cmdHandler = null; t.panel = 'tree';
    app.wrapPM(t);
    app.tabs.push(t);
    app.activate(t);
    return t;
  }
  activate(t) {
    const app = this.root;
    const old = app.active;
    if (old === t && app.shown) return;
    const from = app.shown || app.el;
    for (const k of SLOTS) if (from[k] !== t.el[k]) from[k].replaceWith(t.el[k]);
    app.shown = t.el;
    app.active = t;
    document.body.dataset.kind = t.doc ? t.doc.doc.kind : '';
    app.el.welcome.style.display = t === app ? 'block' : 'none';
    app.el.cmdline.style.display = t.cmdOn ? '' : 'none';
    t.renderLeftTabs();
    t.updateTitle();
    t.doc?.vp?.requestRender?.(); t.doc?.vp3?.requestRender?.();
    t.doc?.onActivate?.();
  }
  cycleTab(dir) {
    const app = this.root, list = [app, ...app.tabs];
    const i = list.indexOf(app.active);
    app.activate(list[(i + dir + list.length) % list.length]);
  }
  async closeTab(t) {
    const app = this.root;
    if (t === app) return;
    if (t.dirty) {
      app.activate(t);
      const r = await dialog({ title: 'Save changes?', body: h('p', {}, `Save changes to ${t.doc?.title} before closing?`), buttons: [{ label: 'Cancel', value: null }, { label: "Don't Save", value: 'no' }, { label: 'Save', value: 'yes', primary: true }] });
      if (!r || (r === 'yes' && !(await t.save()))) return;
    }
    const idx = app.tabs.indexOf(t);
    if (app.active === t) app.activate(app.tabs[idx + 1] || app.tabs[idx - 1] || app);
    try { t.pm.close(false); t.doc?.dispose(); } catch (e) { console.error(e); }
    app.tabs.splice(idx, 1);
    api.setDirty(app.tabs.some((x) => x.dirty));
    app.renderDocTabs();
  }
  renderDocTabs() {
    const app = this.root, bar = app.el.docTabs;
    if (!bar) return;
    bar.innerHTML = '';
    const mk = (t, label, ic) => {
      const b = h('div', { class: 'dt' + (app.active === t ? ' on' : ''), title: label, onclick: () => app.activate(t), onauxclick: (e) => { if (e.button === 1) app.closeTab(t); } },
        h('span', { class: 'ico sm', html: icon(ic) }), h('span', { class: 'dt-name' }, label));
      if (t !== app) b.appendChild(h('button', { class: 'dt-x', title: 'Close', onclick: (e) => { e.stopPropagation(); app.closeTab(t); } }, '×'));
      bar.appendChild(b);
    };
    mk(app, 'Home', 'home');
    for (const t of app.tabs) {
      const kind = t.doc?.doc.kind;
      const name = t.path ? t.path.split(/[\\/]/).pop() : (t.doc?.title || 'Document') + '.' + extOf(kind);
      mk(t, name + (t.dirty ? ' *' : ''), kind === 'plan' ? 'plan' : kind === 'assembly' ? 'assembly' : 'part');
    }
  }
  async loadDoc(docData, path = null) {
    const app = this.root;
    if (path) { const ex = app.tabs.find((t) => t.path === path); if (ex) { app.activate(ex); return; } }
    const t = app.newTab();
    // old-format files (.ek*) open normally; the first Save asks where to store the new .lith* file
    const legacy = path && /\.ek(prt|asm|pln)$/i.test(path);
    t.path = legacy ? null : path;
    t.suggestPath = legacy ? path.replace(/\.ek(prt|asm|pln)$/i, '.lith$1') : null;
    t.dirty = false;
    t.doc = docData.kind === 'plan' ? new PlanDoc(t, docData) : docData.kind === 'assembly' ? new AssemblyDoc(t, docData) : new PartDoc(t, docData);
    document.body.dataset.kind = docData.kind;
    t.showPanel('tree');
    t.doc.init();
    t.updateTitle();
    t.renderLeftTabs();
  }
  closeDoc() { this.root.closeTab(this); }

  async newDoc(kind) {
    const app = this.root;
    app.docCounter ||= { part: 0, plan: 0, assembly: 0 };
    const n = ++app.docCounter[kind];
    await this.loadDoc(kind === 'plan' ? newPlanDoc(`Plan${n}`) : kind === 'assembly' ? newAssemblyDoc(`Assembly${n}`) : newPartDoc(`Part${n}`));
  }
  async newDialog() {
    const pick = await dialog({
      title: 'New Document',
      body: h('div', { class: 'newdlg' },
        h('div', { class: 'nd' }, h('span', { html: icon('part') }), h('b', {}, 'Part'), h('small', {}, 'Feature-based 3D part: sketches, extrudes, revolves, fillets…')),
        h('div', { class: 'nd' }, h('span', { html: icon('plan') }), h('b', {}, 'Plan / Drawing'), h('small', {}, '2D drafting and architecture: walls, doors, windows, DXF/DWG')),
        h('div', { class: 'nd' }, h('span', { html: icon('assembly') }), h('b', {}, 'Assembly'), h('small', {}, 'Insert parts and position them with mates'))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Assembly', value: 'assembly' }, { label: 'Part', value: 'part' }, { label: 'Plan', value: 'plan', primary: true }],
    });
    if (pick) this.newDoc(pick);
  }

  async open(pathArg) {
    const f = pathArg ? await api.readFile(pathArg) : await api.openFile({ filters: [{ name: 'MonoLith documents', extensions: ['lithprt', 'lithasm', 'lithpln', 'ekprt', 'ekasm', 'ekpln'] }, { name: 'CAD files', extensions: ['dxf', 'dwg', 'step', 'stp', 'igs', 'iges'] }, { name: 'Point clouds', extensions: PC_EXTS }, { name: 'All files', extensions: ['*'] }] });
    if (!f) return;
    const ext = f.path.split('.').pop().toLowerCase();
    if (isPointCloud(f.path)) {
      // a scan opened on its own starts a Plan (scan-to-plan); use Import to add it to a part
      await this.loadDoc(newPlanDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await this.importPointCloud(f.path);
      return;
    }
    if (['dxf', 'dwg'].includes(ext)) {
      await this.loadDoc(newPlanDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await this.importPath(f);
      return;
    }
    if (['step', 'stp', 'igs', 'iges'].includes(ext)) {
      await this.loadDoc(newPartDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await this.importPath(f);
      return;
    }
    let data;
    try { data = JSON.parse(f.text); } catch { toast('Not a valid MonoLith document', 'error'); return; }
    await this.loadDoc(data, f.path);
  }

  async save(as = false) {
    if (!this.doc) return false;
    const kind = this.doc.doc.kind;
    const ext = extOf(kind);
    const text = JSON.stringify(this.doc.toJSON ? this.doc.toJSON() : this.doc.doc);
    let path = this.path;
    if (!path || as) {
      path = await api.saveFile({ defaultPath: (!as && this.suggestPath) || `${this.doc.title}.${ext}`, filters: [{ name: { plan: 'MonoLith Plan', assembly: 'MonoLith Assembly' }[kind] || 'MonoLith Part', extensions: [ext] }], text });
      if (!path) return false;
    } else await api.writeFile(path, text);
    this.path = path; this.suggestPath = null;
    if (kind === 'part') partSaved(path);
    this.setDirty(false);
    toast(`Saved ${path.split(/[\\/]/).pop()}`, 'ok', 2000);
    return true;
  }

  async importFile() {
    if (!this.doc) return;
    const filters = this.doc.doc.kind === 'plan'
      ? [{ name: 'Drawings & point clouds', extensions: ['dxf', 'dwg', ...PC_EXTS] }]
      : [{ name: 'CAD models, sketches & point clouds', extensions: ['step', 'stp', 'igs', 'iges', 'dxf', 'dwg', ...PC_EXTS] }];
    const f = await api.openFile({ filters });
    if (f) await this.importPath(f);
  }
  async importPointCloud(path) {
    if (!this.doc) return;
    if (!path) {
      const f = await api.openFile({ filters: [{ name: 'Point clouds', extensions: PC_EXTS }], noRead: true });
      if (!f) return;
      path = f.path;
    }
    let rec;
    try { rec = await askImportOptions(path); } catch (e) { toast('Cannot read point cloud: ' + e.message, 'error'); return; }
    if (rec) await this.doc.addPointCloud(rec);
  }
  async importPath(f) {
    if (isPointCloud(f.path)) { await this.importPointCloud(f.path); return; }
    const name = f.path.split(/[\\/]/).pop();
    const ext = name.split('.').pop().toLowerCase();
    let text = f.text;
    if (ext === 'dwg') {
      const r = await api.dwgToDxf(f.path);
      if (!r?.ok) { this.dwgHelp(r?.error); return; }
      text = r.text;
    }
    if (ext === 'dxf' || ext === 'dwg') {
      if (this.doc.doc.kind === 'plan') this.doc.importDxfText(text, name);
      else this.doc.importDxf(text, name);
      return;
    }
    if (this.doc.doc.kind !== 'part') { toast('STEP/IGES can be imported into a Part document'); return; }
    await this.doc.importCAD(text, ext.startsWith('ig') ? 'iges' : 'step', name);
  }

  async dwgHelp(err) {
    await dialog({
      title: 'DWG conversion',
      body: h('div', {}, h('p', {}, 'DWG files are converted through the free ODA File Converter, which was not found or failed on this computer.'),
        err ? h('p', { class: 'muted' }, String(err)) : null,
        h('p', {}, 'Install it from opendesign.com (ODA File Converter, free) and try again. MonoLith looks for it in C:\\Program Files\\ODA\\. DXF import/export works without it.')),
      buttons: [{ label: 'Open download page', value: 'dl' }, { label: 'OK', primary: true }],
    }).then((v) => { if (v === 'dl') api.openExternal('https://www.opendesign.com/guestfiles/oda_file_converter'); });
  }

  // ---------- welcome ----------
  async showWelcome() {
    const w = this.el.welcome;
    w.style.display = 'block';
    w.innerHTML = '';
    let recent = [];
    try { recent = (await api.recent()) || []; } catch { /* ignore */ }
    const info = await api.info().catch(() => ({}));
    const logc = (await api.logCfg?.().catch(() => null)) || { enabled: true };
    w.append(h('div', { class: 'wl' },
      h('div', { class: 'wl-head' }, h('span', { class: 'wl-logo', html: icon('part') }), h('div', {}, h('h1', {}, APP_NAME), h('p', {}, 'Parametric CAD for engineering and architecture'))),
      h('div', { class: 'wl-cards' },
        h('button', { class: 'wl-card', onclick: () => this.newDoc('part') }, h('span', { class: 'big', html: icon('part') }), h('b', {}, 'New Part'), h('small', {}, 'Sketch on a plane, constrain with relations and dimensions, then extrude, revolve, fillet and pattern — with a full feature history.')),
        h('button', { class: 'wl-card', onclick: () => this.newDoc('plan') }, h('span', { class: 'big', html: icon('plan') }), h('b', {}, 'New Plan / Drawing'), h('small', {}, '2D drafting with object snaps and a command line, plus walls, doors, windows and slabs with a live 3D model.')),
        h('button', { class: 'wl-card', onclick: () => this.newDoc('assembly') }, h('span', { class: 'big', html: icon('assembly') }), h('b', {}, 'New Assembly'), h('small', {}, 'Insert saved parts and position them with mates: coincident, concentric, distance, angle, parallel, tangent…')),
        h('button', { class: 'wl-card', onclick: () => this.open() }, h('span', { class: 'big', html: icon('open') }), h('b', {}, 'Open…'), h('small', {}, 'MonoLith documents, or import STEP, IGES, DXF and DWG files.'))),
      recent.length ? h('div', { class: 'wl-recent' }, h('h3', {}, 'Recent'), recent.slice(0, 8).map((p) => h('button', { class: 'wl-r', onclick: () => this.open(p) }, h('span', { class: 'ico sm', html: icon(p.endsWith('.lithpln') ? 'plan' : p.endsWith('.lithasm') ? 'assembly' : 'part') }), p))) : null,
      h('label', { class: 'wl-log', title: 'Keeps a log of your actions and errors in the Logs folder, to help find problems' },
        h('input', { type: 'checkbox', checked: logc.enabled !== false, onchange: (e) => api.logCfg({ enabled: e.target.checked, asked: true }) }), ' Record action log (for troubleshooting)'),
      h('div', { class: 'wl-foot' }, `Version ${info.version || ''}  ·  Geometry: OpenCascade ${info.occt || ''} · Sketch solver: FreeCAD PlaneGCS`)));
    this.updateTitle();
  }

  // ---------- global input ----------
  bindGlobal() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && t !== document.body;
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.cur().save(e.shiftKey); return; }
      if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); this.open(); return; }
      if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); this.newDialog(); return; }
      if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); if (!document.querySelector('.dlg-back')) this.cycleTab(e.shiftKey ? -1 : 1); return; }
      if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); this.closeTab(this.cur()); return; }
      if (typing) return;
      if (document.querySelector('.dlg-back')) return;
      if (this.cur().doc?.onKey?.(e)) e.preventDefault();
    });
    api.onMenu((cmd, arg) => this.cur().onMenu(cmd, arg));
    api.onBeforeClose(async () => {
      for (const t of this.tabs.filter((x) => x.dirty)) {
        this.activate(t);
        const r = await dialog({ title: 'Save changes?', body: h('p', {}, `Save changes to ${t.doc?.title} before closing?`), buttons: [{ label: 'Cancel', value: null }, { label: "Don't Save", value: 'no' }, { label: 'Save', value: 'yes', primary: true }] });
        if (!r || (r === 'yes' && !(await t.save()))) return;
      }
      api.confirmClose();
    });
  }

  async onMenu(cmd, arg) {
    const d = this.doc;
    switch (cmd) {
      case 'theme': this.setTheme(!!arg); break;
      case 'ui-scale': this.uiScaleDialog(); break;
      case 'ui-scale-reset': this.setUiScale(1); break;
      case 'new-part': this.newDoc('part'); break;
      case 'new-plan': this.newDoc('plan'); break;
      case 'new-assembly': this.newDoc('assembly'); break;
      case 'open': this.open(arg); break;
      case 'save': this.save(); break;
      case 'save-as': this.save(true); break;
      case 'import': this.importFile(); break;
      case 'import-pc': this.importPointCloud(); break;
      case 'export-step': if (d?.exportCAD) d.exportCAD('step'); else d?.exportStep(); break;
      case 'export-iges': if (d?.exportCAD) d.exportCAD('iges'); else toast('IGES export is available for parts'); break;
      case 'export-dxf': if (d?.doc.kind === 'plan') d.exportDxf('dxf'); else if (d?.sketcher) d.exportSketchDxf(d.sketcher.sk); else toast('Select or edit a sketch, or use a Plan document, to export DXF'); break;
      case 'export-dwg': if (d?.doc.kind === 'plan') d.exportDxf('dwg'); else toast('DWG export is available for Plan documents'); break;
      case 'undo': d?.undo(); break;
      case 'redo': d?.redo(); break;
      case 'zoom-fit': d?.zoomFit ? d.zoomFit() : d?.zoomExtents(); break;
      case 'view': d?.viewport?.setView(arg); break;
      case 'shortcuts': this.showShortcuts(); break;
      case 'about': {
        const info = await api.info();
        dialog({ title: `About ${APP_NAME}`, body: h('div', {}, h('p', {}, h('b', {}, `${APP_NAME} ${info.version}`)), h('p', {}, 'Standalone CAD for engineering parts and architectural plans.'), h('p', { class: 'muted' }, 'Built with Electron, three.js, OpenCascade (opencascade.js, LGPL-2.1) and FreeCAD PlaneGCS (LGPL).')) });
        break;
      }
      default:
    }
  }

  showShortcuts() {
    const rows = [
      ['Mouse', ''], ['Middle drag', 'Rotate (part) / Pan (plan)'], ['Ctrl + middle drag / right drag', 'Pan'], ['Wheel', 'Zoom at cursor'], ['Alt + left drag', 'Rotate (no middle button)'],
      ['Part', ''], ['Ctrl+1 … Ctrl+7', 'Front, Back, Left, Right, Top, Bottom, Isometric'], ['Ctrl+8', 'Normal To'], ['F', 'Zoom to fit'], ['Arrow keys', 'Rotate view 15°'],
      ['Sketch', ''], ['L / R / C / A', 'Line / Rectangle / Circle / Arc'], ['D', 'Smart Dimension'], ['T', 'Trim'], ['Esc', 'End tool / clear selection'], ['Del', 'Delete selection'],
      ['Plan', ''], ['Type a command', 'LINE (L), PLINE, REC, CIRCLE (C), ARC, TEXT, DLI, WALL (W), DOOR, WINDOW, MOVE (M), COPY (CO), RO, SC, MI, O, TR, F, X, E'], ['Coordinates', 'x,y   @dx,dy   @dist<angle   or a distance along the cursor'],
      ['F3 / F7 / F8 / F9', 'Object snap / Grid / Ortho / Snap'], ['Space or Enter', 'Repeat last command / finish'],
    ];
    dialog({ title: 'Keyboard & Mouse', body: h('table', { class: 'keys' }, rows.map(([a, b]) => (b === '' ? h('tr', {}, h('th', { colspan: 2 }, a)) : h('tr', {}, h('td', {}, a), h('td', {}, b))))) });
  }
}

async function boot() {
  initActionLog();
  const app = new App();
  // tests/devtools: lithApp forwards to the active tab
  window.lithApp = new Proxy({}, { get: (_, k) => { const t = app.active; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }, set: (_, k, v) => { app.active[k] = v; return true; } });
  try {
    console.log('[boot] solver init');
    await initSolver(() => './planegcs.wasm');
    console.log('[boot] solver ready');
  } catch (e) { console.error('[boot] solver failed', e); toast('Sketch solver failed to load: ' + e.message, 'error', 10000); }
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind');
  const open = q.get('open');
  await app.showWelcome();
  await askLogConsentOnce(dialog, h);
  if (!open && !kind) await app.showWelcome(); // refresh the toggle
  if (open) await app.open(open);
  else if (kind === 'part' || kind === 'plan' || kind === 'assembly') await app.newDoc(kind);
}
boot();
