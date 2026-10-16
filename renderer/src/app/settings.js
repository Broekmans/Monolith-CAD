// Program settings: dark mode, UI scale (stored in localStorage, synced with the Interface menu).
import { cacheKey, packMesh } from '../meshcache.js';
import { h, CommandManager, PropertyManager, toast, dialog } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { initActionLog, askLogConsentOnce } from '../actionlog.js';
import { initSolver } from '../sketch/solver.js';
import { setSketchTheme } from '../sketch/sketcher.js';
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
    window.dispatchEvent(new Event('monolith-theme'));
    api.setDarkMenu(dark);
    if (!init) { try { this.doc?.vp?.requestRender?.(); } catch {} }
  }

  // viewport grid: program default (Interface menu, remembered); a document can override it (doc.grid)
  gridDefault() { try { return localStorage.getItem('monolith.grid') !== 'off'; } catch { return true; } }
  setGrid(on) {
    try { localStorage.setItem('monolith.grid', on ? 'on' : 'off'); } catch {}
    api.setGridMenu?.(on);
    for (const t of this.root?.tabs || this.tabs || []) { if (t.doc?.doc && 'grid' in t.doc.doc) delete t.doc.doc.grid; t.doc?.syncGrid?.(); }
    this.syncViewportMenu?.();
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
}
