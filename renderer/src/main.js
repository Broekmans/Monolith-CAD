// Application shell: layout, tabs, welcome screen, menus and keyboard routing.
// File management (open/save/import) -> app/files.js, program settings (theme, UI scale) -> app/settings.js.
import { cacheKey, packMesh } from './meshcache.js';
import { h, CommandManager, PropertyManager, toast, dialog, promptText } from './ui.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { initActionLog, askLogConsentOnce } from './actionlog.js';
import { initSolver } from './sketch/solver.js';
import { setSketchTheme } from './sketch/sketcher.js';
import { PartDoc, newPartDoc } from './part/part.js';
import { PlanDoc, newPlanDoc } from './plan/plan.js';
import { AssemblyDoc, newAssemblyDoc, partSaved, partCache } from './assembly/assembly.js';
import { PC_EXTS, isPointCloud, askImportOptions } from './pointcloud.js';
import { AppFiles } from './app/files.js';
import { AppSettings } from './app/settings.js';
import { opt } from './app/options.js';
export const EXT = { part: 'lithprt', plan: 'lithpln', assembly: 'lithasm', cloud: 'lithpcd', drawing: 'lithdrw' };
export const extOf = (k) => EXT[k] || 'lithprt';

export const APP_NAME = 'MonoLith';
export const SLOTS = ['cmd', 'tree', 'props', 'pm', 'views', 'headsUp', 'corner', 'sketchStatus', 'toggles', 'right'];

export class App {
  constructor() {
    this.doc = null;
    this.path = null;
    this.dirty = false;
    this.root = this;
    try { this.currentProject = localStorage.getItem('monolith.project') || null; } catch { this.currentProject = null; }
    this.tabs = [];
    this.active = this;
    this.buildLayout();
    this.bindGlobal();
  }

  buildLayout() {
    const root = document.getElementById('app');
    const qa = h('div', { class: 'qa' },
      h('div', { class: 'brand', html: icon('part') }, h('span', {}, APP_NAME)),
      ...[['newDoc', 'New (Ctrl+N)', () => this.newDialog()], ['open', 'Open (Ctrl+O)', () => this.open()], ['save', 'Save (Ctrl+S)', () => this.save()],
        ['undo', 'Undo (Ctrl+Z)', () => this.doc?.undo()], ['redo', 'Redo (Ctrl+Y)', () => this.doc?.redo()]]
        .map(([ic, tip, run]) => h('button', { class: 'qa-btn', title: tip, html: icon(ic), onclick: run })),
      h('div', { class: 'doc-title', id: 'docTitle' }, ''),
      h('button', { class: 'qa-btn qa-opt', title: 'Options (Tools > Options…)', html: icon('gear'), onclick: () => this.optionsDialog() }),
      h('div', { class: 'busy', id: 'busy' }, h('span', { class: 'spinner' }), 'Rebuilding…'));
    this.setTheme(opt('dark'), true); // Tools > Options (app/options.js)
    this.setUiScale(opt('uiScale') / 100, false);
    this.loadMyDefaults?.(); // first start: "My Defaults" file
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
  clearPartCacheForTest() { partCache.clear(); }
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
    // a floating PropertyManager (feature dialogs) sits over the 3D view: the tree stays in the left panel
    const fl = this.el.pm.classList.contains('pm-float');
    if (fl && which === 'pm') which = this.doc?.sketcher ? 'props' : 'tree';
    this.panel = which;
    this.el.tree.style.display = which === 'tree' ? '' : 'none';
    this.el.props.style.display = which === 'props' ? '' : 'none';
    this.el.pm.style.display = (fl ? this.pm.open : which === 'pm') ? '' : 'none';
    this.renderLeftTabs();
  }
  floatPM(on) {
    const pm = this.el.pm;
    pm.classList.toggle('pm-float', !!on);
    if (on) { const r = this.el.views.getBoundingClientRect(); Object.assign(pm.style, { left: r.left + 8 + 'px', top: r.top + 8 + 'px', maxHeight: Math.max(200, r.height - 16) + 'px' }); }
    else Object.assign(pm.style, { left: '', top: '', maxHeight: '' });
  }
  renderLeftTabs() {
    if (!this.isActive()) return;
    const kind = this.doc?.doc.kind;
    const tabs = kind === 'drawing' ? [['tree', 'drawing', 'Sheets & Views'], ['pm', 'check', 'PropertyManager']] : kind === 'cloud' ? [['tree', 'cloud', 'Point Clouds'], ['pm', 'check', 'PropertyManager']] : kind === 'plan' ? [['tree', 'layers', 'Layers & Properties']] : kind === 'assembly' ? [['tree', 'assembly', 'Assembly'], ['pm', 'check', 'PropertyManager']] : [['tree', 'part', 'FeatureManager'], ['props', 'relation', 'Sketch'], ['pm', 'check', 'PropertyManager']];
    this.el.leftTabs.innerHTML = '';
    for (const [id, ic, tip] of tabs) {
      if (id === 'pm' && (!this.pm.open || this.el.pm.classList.contains('pm-float'))) continue;
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
    pm.close = (...a) => { const r = pmClose(...a); t.floatPM(false); if (t.panel === 'pm') t.showPanel(t.doc?.sketcher ? 'props' : 'tree'); else t.showPanel(t.panel); return r; };
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
    t.syncViewportMenu();
    requestAnimationFrame(() => t.doc?.viewSet?.placeHud()); // view toolbar under the active view's cube
  }
  // Viewport menu (main process) shows the active document's layout + grid
  syncViewportMenu() {
    const d = this.root.active?.doc;
    api.setViewportMenu(d?.viewSet ? { layout: d.viewSet.layout, grid: d.toggleGrid ? !!d.gridOn : null, multi: d.viewSet.visible().length > 1 || !!d.viewSet.max, max: !!d.viewSet.max, mins: d.viewSet.minimized().length } : null);
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
      mk(t, name + (t.dirty ? ' *' : ''), kind === 'drawing' ? 'drawing' : kind === 'cloud' ? 'cloud' : kind === 'plan' ? 'plan' : kind === 'assembly' ? 'assembly' : 'part');
    }
  }
  closeDoc() { this.root.closeTab(this); }

  // ---------- welcome ----------
  async showWelcome() {
    const w = this.el.welcome;
    w.style.display = 'block';
    w.innerHTML = '';
    let recent = [], pj = { projects: [], root: '' };
    try { recent = (await api.recent()) || []; } catch { /* ignore */ }
    try { pj = (await api.projects()) || pj; } catch { /* ignore */ }
    const info = await api.info().catch(() => ({}));
    const logc = (await api.logCfg?.().catch(() => null)) || { enabled: true };
    const kindIco = (p) => icon(/\.lithdrw$/i.test(p) ? 'drawing' : /\.lithpcd$/i.test(p) ? 'cloud' : /\.(lith|ek)pln$/i.test(p) ? 'plan' : /\.(lith|ek)asm$/i.test(p) ? 'assembly' : 'part');
    const base = (p) => p.split(/[\\/]/).pop();
    const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
    const thumbEl = (f, cls = 'pj-thumb') => h('div', { class: cls }, f?.thumb ? h('img', { src: f.thumb, alt: '' }) : h('span', { class: 'pj-noimg', html: icon(f?.kind === 'drawing' ? 'drawing' : f?.kind === 'assembly' ? 'assembly' : f?.kind === 'plan' ? 'plan' : f?.kind === 'cloud' ? 'cloud' : 'part') }));
    const cur = pj.projects.find((x) => x.dir === this.root.currentProject);

    // ----- main column: projects grid, or the files of the selected project -----
    let mainCol;
    if (cur) {
      const ROLE = { main: 'Main assembly', sub: 'Subassembly', part: 'Part', plan: 'Plan', cloud: 'Point cloud', drawing: 'Drawing' };
      mainCol = h('div', { class: 'wl-main' },
        h('div', { class: 'pj-bar' },
          h('button', { class: 'pj-btn', onclick: () => { this.root.setProject(null); } }, '← All projects'),
          h('h2', {}, cur.name),
          h('span', { class: 'pj-spacer' }),
          cur.main ? h('button', { class: 'pj-btn primary', onclick: () => this.open(cur.main) }, 'Open main assembly') : null,
          h('button', { class: 'pj-btn', onclick: () => api.openProjectFolder(cur.dir) }, 'Show folder')),
        h('div', { class: 'pj-new' }, 'New in this project: ',
          h('button', { class: 'pj-btn', onclick: () => this.newDoc('part') }, 'Part'),
          h('button', { class: 'pj-btn', onclick: () => this.newDoc('assembly') }, 'Assembly'),
          h('button', { class: 'pj-btn', onclick: () => this.newDoc('drawing') }, 'Drawing'),
          h('button', { class: 'pj-btn', onclick: () => this.newDoc('plan') }, 'Plan'),
          h('button', { class: 'pj-btn', onclick: () => this.newDoc('cloud') }, 'Point Cloud')),
        cur.files.length ? h('div', { class: 'pj-grid' }, cur.files.map((f) => h('button', { class: 'pj-card file ' + f.role, title: f.path, onclick: () => this.open(f.path) },
          thumbEl(f), h('div', { class: 'pj-name' }, h('span', { class: 'ico sm', html: kindIco(f.path) }), f.name), h('small', { class: 'pj-role' }, ROLE[f.role] || f.kind))))
          : h('p', { class: 'pj-empty' }, 'No MonoLith files in this project yet. Files you save while this project is open go into its folder.'));
    } else {
      mainCol = h('div', { class: 'wl-main' },
        h('div', { class: 'wl-cards' },
          h('button', { class: 'wl-card', onclick: () => this.newDoc('part') }, h('span', { class: 'big', html: icon('part') }), h('b', {}, 'New Part'), h('small', {}, 'Sketch, extrude, revolve, fillet — with a full feature history.')),
          h('button', { class: 'wl-card', onclick: () => this.newDoc('plan') }, h('span', { class: 'big', html: icon('plan') }), h('b', {}, 'New Plan'), h('small', {}, '2D drafting with a command line, walls, doors and windows.')),
          h('button', { class: 'wl-card', onclick: () => this.newDoc('drawing') }, h('span', { class: 'big', html: icon('drawing') }), h('b', {}, 'New Drawing'), h('small', {}, 'Views of parts and assemblies on paper sheets (A4–A0), exported as PDF.')),
          h('button', { class: 'wl-card', onclick: () => this.newDoc('assembly') }, h('span', { class: 'big', html: icon('assembly') }), h('b', {}, 'New Assembly'), h('small', {}, 'Insert parts and subassemblies, position them with mates.')),
          h('button', { class: 'wl-card', onclick: () => this.newDoc('cloud') }, h('span', { class: 'big', html: icon('cloud') }), h('b', {}, 'New Point Cloud'), h('small', {}, 'Open laser scans (LAS, LAZ, PLY, XYZ) — also very large ones.')),
          h('button', { class: 'wl-card', onclick: () => this.open() }, h('span', { class: 'big', html: icon('open') }), h('b', {}, 'Open…'), h('small', {}, 'MonoLith documents, scans, or import STEP, IGES, DXF and DWG.'))),
        h('div', { class: 'pj-bar' }, h('h2', {}, 'Projects'), h('span', { class: 'pj-spacer' }),
          h('button', { class: 'pj-btn primary', onclick: () => this.newProject() }, '+ New project'),
          h('button', { class: 'pj-btn', onclick: () => api.openProjectFolder(), title: pj.root }, 'Projects folder')),
        pj.projects.length ? h('div', { class: 'pj-grid' }, pj.projects.map((p) => h('button', { class: 'pj-card', title: p.dir, onclick: () => { this.root.setProject(p.dir); } },
          thumbEl(p.cover), h('div', { class: 'pj-name' }, p.name),
          h('small', { class: 'pj-role' }, `${p.files.filter((f) => f.kind === 'assembly').length} assemblies · ${p.files.filter((f) => f.kind === 'part').length} parts`))))
          : h('p', { class: 'pj-empty' }, `No projects yet. Click "New project", or put a folder with your files in ${pj.root}.`));
    }
    // ----- side column: recent files, settings, version -----
    const side = h('div', { class: 'wl-side' },
      h('h3', {}, 'Recent'),
      recent.length ? recent.slice(0, 12).map((p) => h('button', { class: 'wl-r', title: p, onclick: () => this.open(p) }, h('span', { class: 'ico sm', html: kindIco(p) }), h('span', { class: 'wl-rt' }, h('b', {}, base(p)), h('small', {}, dirOf(p))))) : h('p', { class: 'pj-empty' }, 'Nothing yet'),
      h('label', { class: 'wl-log', title: 'Keeps a log of your actions and errors in the Logs folder, to help find problems' },
        h('input', { type: 'checkbox', checked: logc.enabled !== false, onchange: (e) => api.logCfg({ enabled: e.target.checked, asked: true }) }), ' Record action log (for troubleshooting)'),
      h('div', { class: 'wl-foot' }, `Version ${info.version || ''} · Geometry: OpenCascade ${info.occt || ''} · Sketch solver: FreeCAD PlaneGCS`));
    w.append(h('div', { class: 'wl wl-wide' },
      h('div', { class: 'wl-head' }, h('span', { class: 'wl-logo', html: icon('part') }), h('div', {}, h('h1', {}, APP_NAME), h('p', {}, 'Parametric CAD for engineering and architecture'))),
      h('div', { class: 'wl-cols' }, mainCol, side)));
    this.updateTitle();
  }
  // selected project (remembered between sessions); new files are saved into its folder
  setProject(dir) { this.root.currentProject = dir; try { localStorage.setItem('monolith.project', dir || ''); } catch {} this.root.showWelcome(); }
  async newProject() {
    const name = await promptText('New project name', '');
    if (!name) return;
    const r = await api.createProject(name);
    if (r?.error) { toast(r.error, 'error'); return; }
    this.root.setProject(r.dir);
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
      case 'grid': this.setGrid(!!arg); break;
      case 'iso-features': this.setIsoForFeatures(!!arg); break;
      case 'layout': d?.setViewLayout?.(arg); this.syncViewportMenu(); break;
      case 'reset-views': d?.resetViews?.(); break;
      case 'max-view': { const s = d?.viewSet; if (s) (s.max ? s.restoreViews() : s.maximize()); break; }
      case 'close-view': d?.viewSet?.closePane(); break;
      case 'min-view': d?.viewSet?.minimize(); break;
      case 'restore-mins': d?.viewSet?.restoreMinimized(); break;
      case 'doc-grid': if (d?.toggleGrid && d.gridOn !== !!arg) d.toggleGrid(); this.syncViewportMenu(); break;
      case 'ui-scale': this.uiScaleDialog(); break;
      case 'options': this.optionsDialog(); break;
      case 'ui-scale-reset': this.setUiScale(1); break;
      case 'new-part': this.newDoc('part'); break;
      case 'new-plan': this.newDoc('plan'); break;
      case 'new-assembly': this.newDoc('assembly'); break;
      case 'new-cloud': this.newDoc('cloud'); break;
      case 'new-drawing': this.newDoc('drawing'); break;
      case 'open': this.open(arg); break;
      case 'save': this.save(); break;
      case 'save-as': this.save(true); break;
      case 'import': this.importFile(); break;
      case 'import-pc': this.importPointCloud(); break;
      case 'export-step': if (d?.exportCAD) d.exportCAD('step'); else d?.exportStep(); break;
      case 'export-iges': if (d?.exportCAD) d.exportCAD('iges'); else toast('IGES export is available for parts'); break;
      case 'export-dxf': if (d?.doc.kind === 'plan') d.exportDxf('dxf'); else if (d?.sketcher) d.exportSketchDxf(d.sketcher.sk); else toast('Select or edit a sketch, or use a Plan document, to export DXF'); break;
      case 'export-dwg': if (d?.doc.kind === 'plan') d.exportDxf('dwg'); else toast('DWG export is available for Plan documents'); break;
      case 'dwg-converter': this.dwgHelp(); break;
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
      ['Point Cloud', ''], ['F', 'Zoom to fit'], ['Ctrl+1 … Ctrl+7', 'Standard views'], ['Del', 'Remove the selected scan from the document'],
      ['Plan', ''], ['Type a command', 'LINE (L), PLINE, REC, CIRCLE (C), ARC, TEXT, DLI, WALL (W), DOOR, WINDOW, MOVE (M), COPY (CO), RO, SC, MI, O, TR, F, X, E'], ['Coordinates', 'x,y   @dx,dy   @dist<angle   or a distance along the cursor'],
      ['F3 / F7 / F8 / F9', 'Object snap / Grid / Ortho / Snap'], ['Space or Enter', 'Repeat last command / finish'],
    ];
    dialog({ title: 'Keyboard & Mouse', body: h('table', { class: 'keys' }, rows.map(([a, b]) => (b === '' ? h('tr', {}, h('th', { colspan: 2 }, a)) : h('tr', {}, h('td', {}, a), h('td', {}, b))))) });
  }
}

// mix in methods split off into separate files
for (const M of [AppFiles, AppSettings]) for (const k of Object.getOwnPropertyNames(M.prototype)) if (k !== 'constructor') Object.defineProperty(App.prototype, k, Object.getOwnPropertyDescriptor(M.prototype, k));

export async function boot() {
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
  else if (kind === 'part' || kind === 'plan' || kind === 'assembly' || kind === 'cloud' || kind === 'drawing') await app.newDoc(kind);
}
boot();
