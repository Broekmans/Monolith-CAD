// ViewSet shared constants + helpers (no class code).
import * as THREE from 'three';
import { opt } from '../app/options.js';

export const LAYOUTS = {
  single: { n: 1, label: 'Single View' },
  'two-v': { n: 2, label: 'Two Views Side by Side' },
  'two-h': { n: 2, label: 'Two Views Stacked' },
  four: { n: 4, label: 'Four Views' },
};
// standard views per layout (pane order: top-left, top-right, bottom-left, bottom-right)
export const DEFAULT_VIEWS = { single: ['iso'], 'two-v': ['front', 'iso'], 'two-h': ['front', 'iso'], four: ['front', 'iso', 'top', 'right'] };
// pane indices per column for the standard layouts
export const STD_COLS = { single: [[0]], 'two-v': [[0], [1]], 'two-h': [[0, 1]], four: [[0, 2], [1, 3]] };
export const SHARED = ['section', 'renderScene', 'onContextMenu', 'onMiddleClick', 'onViewChange', 'overlayDrawers'];
// px between panes (the divider): Options > Viewports > Divider width
export const gap = () => opt('dividerW');
export const MIN = 0.1; // smallest column / row fraction
export const ICON = {
  max: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  restore: '<svg viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.5V1.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  close: '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.4"/></svg>',
  min: '<svg viewBox="0 0 12 12"><path d="M2.5 9h7" stroke="currentColor" stroke-width="1.5"/></svg>',
  up: '<svg viewBox="0 0 12 12"><path d="M2.5 7.5L6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};
export const VIEW_NAMES = [[[0, 0, -1], 'Front'], [[0, 0, 1], 'Back'], [[1, 0, 0], 'Left'], [[-1, 0, 0], 'Right'], [[0, -1, 0], 'Top'], [[0, 1, 0], 'Bottom']];


export const r6 = (v) => Math.round(v * 1e6) / 1e6;
export function swapCam(a, b) {
  const t = { target: a.target.clone(), scale: a.scale, q: a.camera.quaternion.clone() };
  copyCam(b, a);
  b.anim = null; b.target.copy(t.target); b.scale = t.scale; b._applyQuat(t.q);
}
export function copyCam(a, b) {
  b.anim = null; b.target.copy(a.target); b.scale = a.scale; b._applyQuat(a.camera.quaternion.clone());
}
export function wrapRender(set, p, orig) {
  return () => { const old = set.renderPane; set.renderPane = p; try { orig(); } finally { set.renderPane = old; } };
}
export function slotOf(cols, p) {
  for (const col of cols) for (const row of col.rows) if (row.pane === p) return { col, row };
  return null;
}
// fractions sum to 1 again (after a close or loading)
export function norm(cols) {
  const sw = cols.reduce((s, c) => s + c.w, 0) || 1;
  for (const c of cols) { c.w /= sw; const sh = c.rows.reduce((s, r) => s + r.h, 0) || 1; for (const r of c.rows) r.h /= sh; }
}
// move the shared edge of a and b (sizes key k) so that a gets size `fa`; both keep at least MIN
export function edge(a, b, k, fa) {
  const tot = a[k] + b[k];
  a[k] = Math.min(tot - MIN, Math.max(MIN, fa));
  b[k] = tot - a[k];
}
// standard name when the columns match one, else 'custom'
export function layoutName(cols) {
  const sig = cols.map((c) => c.rows.length).join();
  return { 1: 'single', '1,1': 'two-v', 2: 'two-h', '2,2': 'four' }[sig] || 'custom';
}
export function validCols(cols, extra = []) {
  if (!Array.isArray(cols) || !cols.length) return null;
  const seen = new Set();
  for (const i of extra) { if (seen.has(i)) return null; seen.add(i); }
  for (const c of cols) {
    if (!(c?.w > 0) || !Array.isArray(c.rows) || !c.rows.length) return null;
    for (const r of c.rows) { if (!(r?.h > 0) || !Number.isInteger(r.i) || seen.has(r.i)) return null; seen.add(r.i); }
  }
  const n = seen.size;
  for (let i = 0; i < n; i++) if (!seen.has(i)) return null;
  return n <= 8 ? cols : null;
}

export const PROXY_SET = new Set(['requestRender', 'dispose']);
export function makeProxy(set) {
  return new Proxy({}, {
    get(_, k) {
      if (k === 'viewset') return set;
      if (k === 'el') return set.elProxy;
      if (k === 'pane') return set.cur;
      if (PROXY_SET.has(k)) return set[k].bind(set);
      const p = set.cur, v = p[k];
      return typeof v === 'function' ? v.bind(p) : v;
    },
    set(_, k, v) { if (SHARED.includes(k)) set.primary[k] = v; else set.cur[k] = v; return true; },
    has(_, k) { return k in set.cur; },
  });
}
export const ROOT_KEYS = new Set(['addEventListener', 'removeEventListener', 'contains']);
export function makeElProxy(set) {
  return new Proxy({}, {
    get(_, k) {
      const el = ROOT_KEYS.has(k) ? set.root : set.cur.el, v = el[k];
      return typeof v === 'function' ? v.bind(el) : v;
    },
    set(_, k, v) { set.cur.el[k] = v; return true; },
  });
}
