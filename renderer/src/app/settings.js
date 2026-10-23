// Program settings: dark mode, UI scale, grid … (values in app/options.js, synced with the Interface / Viewport menus)
// and the Options window (Tools > Options…).
import { qs } from '../popout.js';
import { cacheKey, packMesh } from '../meshcache.js';
import { h, CommandManager, PropertyManager, toast, dialog } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { OPTIONS_DEF, OPTIONS_SHOWN, OPT_CATS, opt, allOpts, setOpts, setOpt, factory, factoryOf, myDefaults, setMine, hasStored, clean } from './options.js';
import { initActionLog, askLogConsentOnce } from '../actionlog.js';
import { initSolver } from '../sketch/solver.js';
import { setSketchTheme, applySketchColours } from '../sketch/sketcher.js';
import { PartDoc, newPartDoc } from '../part/part.js';
import { PlanDoc, newPlanDoc } from '../plan/plan.js';
import { AssemblyDoc, newAssemblyDoc, partSaved, partCache } from '../assembly/assembly.js';
import { PC_EXTS, isPointCloud, askImportOptions } from '../pointcloud.js';
import { EXT, extOf, APP_NAME, SLOTS, boot, App } from '../main.js';

export class AppSettings {
  setTheme(dark, init) {
    document.body.classList.toggle('dark', dark);
    setSketchTheme(dark);
    try { localStorage.setItem('monolith.theme', dark ? 'dark' : 'light'); } catch {}
    if (!init) setOpt('dark', !!dark);
    window.dispatchEvent(new Event('monolith-theme'));
    api.setDarkMenu(dark);
    if (init) { api.setIsoMenu?.(this.isoForFeatures()); api.setGridMenu?.(this.gridDefault()); }
    if (!init) { try { this.doc?.vp?.requestRender?.(); } catch {} }
  }

  // viewport grid: program default (Options / Viewport menu); a document can override it (doc.grid)
  gridDefault() { return opt('gridDefault'); }
  setGrid(on) {
    setOpt('gridDefault', !!on);
    try { localStorage.setItem('monolith.grid', on ? 'on' : 'off'); } catch {}
    api.setGridMenu?.(on);
    for (const t of this.root?.tabs || this.tabs || []) { if (t.doc?.doc && 'grid' in t.doc.doc) delete t.doc.doc.grid; t.doc?.syncGrid?.(); }
    this.syncViewportMenu?.();
  }

  // feature dialogs turn the view to Isometric when you look straight at the sketch (Options / Interface menu)
  isoForFeatures() { return opt('isoFeatures'); }
  setIsoForFeatures(on) { setOpt('isoFeatures', !!on); try { localStorage.setItem('monolith.isoFeat', on ? 'on' : 'off'); } catch {} api.setIsoMenu?.(on); }

  // 0.1.128: compact layout (Options > Interface): ribbon size / scale / group labels, quick access bar, tree rows
  applyInterface() {
    const b = document.body, rs = opt('ribbonSize');
    for (const k of ['large', 'medium', 'small']) b.classList.toggle('rb-' + k, rs === k);
    b.classList.toggle('rb-nolabels', !opt('ribbonGroupLabels'));
    b.classList.toggle('qa-hidden', opt('qaBar') === 'hidden');
    const st = document.documentElement.style;
    st.setProperty('--rb', String(opt('ribbonScalePct') / 100));
    st.setProperty('--tree-row', opt('treeRowPx') + 'px');
  }
  setUiScale(f, save = true) {
    f = Math.min(2, Math.max(0.6, Math.round(f * 20) / 20));
    this.uiScale = f; api.setZoom(f);
    if (save) { setOpt('uiScale', Math.round(f * 100)); try { localStorage.setItem('monolith.uiScale', String(f)); } catch {} }
  }
  setActionLog(on) { api.logCfg?.({ enabled: !!on, asked: true }); }
  // 0.1.111: single / multi-thread geometry kernel (main/kernel.cjs restarts its workers when this changes)
  async setKernelMode(on) {
    // no optional chaining here: `api.kernelMode?.(x).catch()` silently skipped the whole call when the bridge was missing (0.1.111/0.1.112)
    const info = await Promise.resolve(api.kernelMode(!!on)).catch((e) => { window.__lithLog?.('KERNEL ERROR mode', e?.message || e); return null; });
    if (info) try { window.__lithLog?.(`KERNEL ${info.mode} (${info.cores} cores${info.threads ? ', ' + info.threads + ' threads' : ''})${info.fallback ? ' — multi-thread build failed: ' + info.fallback : ''}`); } catch { /* log optional */ }
    return info;
  }
  openDraftStd() {
    if (this.doc?.cmdDraftStd) { closeOptions(); this.doc.cmdDraftStd(); } else toast('Open or select a drawing first: the Drafting Standard belongs to drawings (button on the Annotate tab)');
  }

  // first start without stored options: take "My Defaults" from <CAD Program>\monolith-options.json
  async loadMyDefaults() {
    const f = await api.optionsCfg?.().catch(() => null);
    const { __path, __error, ...o } = f || {};
    this.optionsPath = __path;
    setMine(o);
    if (!hasStored() && Object.keys(clean(o)).length) this.applyOptions(o);
  }
  // set values and run what must happen for them (theme, UI scale …); repaint documents
  applyOptions(o, changedOnly = true) {
    const before = allOpts(), changed = setOpts(o);
    const keys = changedOnly ? changed : Object.keys(clean(o));
    for (const k of keys) { const d = OPTIONS_DEF.find((x) => x.key === k); if (d?.apply && before[k] !== undefined) d.apply(this, opt(k)); }
    applySketchColours();
    for (const t of this.root?.tabs || this.tabs || []) {
      t.doc?.refreshGhost?.(); t.doc?.applyColors?.(); t.doc?.vp?.requestRender?.(); t.doc?.updateSketchDisplay?.();
      t.doc?.viewSet?.place?.(); // view cube size, divider width, view toolbar position
    }
    return changed;
  }

  // Tools > Options…: categories left, label | control rows right; changes preview live, Cancel puts them back
  async optionsDialog() {
    closeOptions();
    const logc = (await api.logCfg?.().catch(() => null)) || {};
    if (logc.enabled !== undefined && logc.enabled !== opt('actionLog')) setOpt('actionLog', logc.enabled !== false);
    if (this.optionsPath === undefined) await this.loadMyDefaults();
    const start = allOpts();
    let cat = (() => { try { return localStorage.getItem('monolith.optionsCat'); } catch { return null; } })();
    if (!OPT_CATS.includes(cat)) cat = OPT_CATS[0];
    const list = h('div', { class: 'opt-cats' }), rows = h('div', { class: 'opt-rows' });
    const msg = h('div', { class: 'opt-msg' }, '');
    const set = (k, v) => { this.applyOptions({ [k]: v }); };
    const control = (d) => {
      const v = opt(d.key);
      if (d.type === 'bool') { const i = h('input', { type: 'checkbox', checked: v }); i.addEventListener('change', () => set(d.key, i.checked)); i.dataset.key = d.key; return i; }
      if (d.type === 'color') { const i = h('input', { type: 'color', value: v }); i.addEventListener('input', () => set(d.key, i.value)); i.dataset.key = d.key; return i; }
      if (d.type === 'button') return h('button', { class: 'opt-btn', onclick: () => d.run(this) }, d.text);
      if (d.type === 'select') {
        const s = h('select', { class: 'opt-sel' }, ...d.choices.map(([c, l]) => h('option', { value: c, selected: c === v }, l)));
        s.dataset.key = d.key; s.addEventListener('change', () => set(d.key, s.value)); return s;
      }
      if (d.type === 'info') return h('span', { class: 'opt-info' }, d.text);
      const i = h('input', { type: 'number', value: String(v), min: d.min, max: d.max, step: d.step || 1 });
      i.dataset.key = d.key;
      const commit = () => { const n = +i.value; if (!Number.isFinite(n) || i.value === '') { i.value = String(opt(d.key)); return; } set(d.key, n); i.value = String(opt(d.key)); };
      i.addEventListener('change', commit);
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } e.stopPropagation(); });
      return h('span', { class: 'opt-num' }, i, h('span', { class: 'unit' }, d.type === 'pct' ? '%' : d.unit || ''));
    };
    // rows of one category with sub-headings (row.group); a search shows matching rows of every category
    const search = h('input', { class: 'opt-search', type: 'search', placeholder: 'Search settings…' });
    search.addEventListener('input', () => show());
    search.addEventListener('keydown', (e) => e.stopPropagation());
    // rows of one category come from several cats files: keep each sub-heading together (order of first appearance)
    const byGroup = (defs) => { const o = []; for (const d of defs) if (!o.includes(d.group || '')) o.push(d.group || ''); return o.flatMap((g) => defs.filter((d) => (d.group || '') === g)); };
    const rowsOf = (defs, withCat) => {
      const out = []; let g = null;
      for (const d of defs) {
        const head = withCat ? d.cat + (d.group ? ' · ' + d.group : '') : d.group || null;
        if (head !== g) { g = head; if (head) out.push(h('div', { class: 'opt-group' }, head)); }
        const changed = 'def' in d && opt(d.key) !== factoryOf(d.key);
        out.push(h('div', { class: 'opt-row' + (changed ? ' changed' : ''), title: changed ? 'Changed (factory: ' + factoryOf(d.key) + ')' : '' }, h('label', {}, d.label), control(d)));
      }
      return out;
    };
    const show = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(search, ...OPT_CATS.map((c) => h('button', { class: 'opt-cat' + (c === cat && !q ? ' on' : ''), onclick: () => { cat = c; search.value = ''; try { localStorage.setItem('monolith.optionsCat', c); } catch {} show(); } }, c)));
      if (q) {
        const hits = OPTIONS_SHOWN.filter((d) => (d.label + ' ' + d.cat + ' ' + (d.group || '') + ' ' + d.key).toLowerCase().includes(q));
        rows.replaceChildren(h('div', { class: 'opt-head' }, `Search: ${hits.length} setting${hits.length === 1 ? '' : 's'}`), ...rowsOf(hits, true));
      } else rows.replaceChildren(h('div', { class: 'opt-head' }, cat), ...rowsOf(byGroup(OPTIONS_SHOWN.filter((d) => d.cat === cat)), false));
    };
    const load = (o, text) => { this.applyOptions(o); show(); msg.textContent = text; };
    const exportJson = async () => {
      const p = await api.saveFile({ defaultPath: 'monolith-options.json', filters: [{ name: 'Options', extensions: ['json'] }], text: JSON.stringify(allOpts(), null, 2) });
      if (p) msg.textContent = 'Exported ' + p.split(/[\\/]/).pop();
    };
    const importJson = async () => {
      const f = await api.openFile({ filters: [{ name: 'Options', extensions: ['json'] }] }); if (!f?.text) return;
      try { const o = clean(JSON.parse(f.text)); load(o, `Imported ${Object.keys(o).length} settings from ${f.path.split(/[\\/]/).pop()} (OK keeps them)`); } catch { msg.textContent = 'Not an options file'; }
    };
    const saveMine = async () => {
      const r = await api.optionsCfg?.(allOpts());
      if (r?.__error) { msg.textContent = 'Could not save: ' + r.__error; return; }
      this.optionsPath = r?.__path; setMine(allOpts());
      msg.textContent = 'Saved as My Defaults' + (r?.__path ? ' (' + r.__path.split(/[\\/]/).pop() + ')' : '');
    };
    const foot = h('div', { class: 'opt-foot' },
      h('button', { class: 'opt-btn', title: 'Store these settings as your own defaults (file in the CAD Program folder)', onclick: saveMine }, 'Save as My Defaults'),
      h('button', { class: 'opt-btn', onclick: () => load(myDefaults(), 'My Defaults loaded') }, 'Back to My Defaults'),
      h('button', { class: 'opt-btn', onclick: () => load(factory(), 'Factory defaults loaded') }, 'Reset to Factory Defaults'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'opt-btn', onclick: importJson }, 'Import…'),
      h('button', { class: 'opt-btn', onclick: exportJson }, 'Export…'));
    show();
    const body = h('div', { class: 'opt-body' }, h('div', { class: 'opt-main' }, list, rows), foot, msg);
    const r = await dialog({ title: 'Options', body, buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }] });
    if (r !== 'ok' && !closeOptions.forced) this.applyOptions(start); // Cancel / Esc / × : back to the values before
    else if (r === 'ok') this.trackOptions(start, allOpts());
    closeOptions.forced = false;
  }

  // Your setting changes (OK in Options): action log line per setting + Logs\option-changes.json summary
  // (per key: factory value, your value, number of changes, last date). Claude reads it to propose new factory defaults.
  trackOptions(before, after) {
    const ch = Object.keys(after).filter((k) => after[k] !== before[k] && !k.startsWith('_'));
    if (!ch.length) return [];
    for (const k of ch) { try { window.__lithLog?.('OPTION', k, JSON.stringify(before[k]), '->', JSON.stringify(after[k]), 'factory', JSON.stringify(factoryOf(k))); } catch {} }
    if (opt('trackOptions')) Promise.resolve(api.trackOptions?.(ch.map((k) => ({ key: k, from: before[k], to: after[k], factory: factoryOf(k), label: OPTIONS_DEF.find((d) => d.key === k)?.label })))).catch(() => {});
    return ch;
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
}

// close an open Options window without undoing (used when a button inside opens another dialog)
function closeOptions() { const b = qs('.dlg .opt-body')?.closest('.dlg'); if (b) { closeOptions.forced = true; b.querySelector('.dlg-buttons button.primary')?.click(); } } // the dialog may be in its own window (0.1.129)
