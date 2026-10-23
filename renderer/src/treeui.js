// Shared browser-tree row (Part, Assembly, Saved Views): chevron, icon, label,
// count badge, eye button, states sel / dim / err / editing (green).
import { h } from './ui.js';
import { icon } from './icons.js';
import { opt } from './app/options.js';

// left padding of a tree row at depth (Options > Interface > Tree, 0.1.128)
export const treePad = (depth) => opt('treePadPx') + (depth || 0) * opt('treeIndentPx');

const CHEVRON = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// o: { icon, label, depth, sel, dim, err, warn (orange ⚠), tip, editing, count, twisty (true open / false closed / undefined none),
//      onTwisty, eye (true visible / false hidden / undefined none), onEye, onClick, onDbl, onMenu, onEnter, onLeave, data {k: v} }
export function treeRow(o) {
  const cls = ['tr-row'];
  if (o.sel) cls.push('sel');
  if (o.dim) cls.push('dim');
  if (o.err) cls.push('err');
  if (o.editing) cls.push('editing');
  if (o.twisty !== undefined) cls.push('folder');
  if (o.eye === false) cls.push('hidden-item');
  const r = h('div', { class: cls.join(' '), style: { paddingLeft: treePad(o.depth) + 'px' }, title: o.tip || '' },
    o.twisty !== undefined
      ? h('span', { class: 'twisty' + (o.twisty ? ' open' : ''), html: CHEVRON, onclick: (e) => { e.stopPropagation(); o.onTwisty?.(); } })
      : h('span', { class: 'twisty' }),
    h('span', { class: 'ico sm', html: icon(o.icon) }),
    h('span', { class: 'tr-label' }, o.label),
    o.count !== undefined ? h('span', { class: 'tr-count' }, `(${o.count})`) : null,
    o.err ? h('span', { class: 'tr-err', title: o.err }, '⚠') : o.warn ? h('span', { class: 'tr-err tr-warn', title: o.warn }, '⚠') : null,
    o.eye !== undefined ? h('button', {
      class: 'tr-eye' + (o.eye ? '' : ' off'), title: o.eye ? 'Hide' : 'Show', html: icon(o.eye ? 'eye' : 'eyeOff'),
      onclick: (e) => { e.stopPropagation(); o.onEye?.(); }, ondblclick: (e) => e.stopPropagation(),
    }) : null);
  if (o.data) for (const [k, v] of Object.entries(o.data)) r.dataset[k] = v;
  if (o.twisty !== undefined && !o.onClick) r.addEventListener('dblclick', (e) => { e.stopPropagation(); o.onTwisty?.(); });
  r.addEventListener('click', (e) => o.onClick?.(e));
  r.addEventListener('dblclick', (e) => o.onDbl?.(e));
  r.addEventListener('contextmenu', (e) => { e.preventDefault(); o.onMenu?.(e); });
  r.addEventListener('mouseenter', () => o.onEnter?.());
  r.addEventListener('mouseleave', () => o.onLeave?.());
  return r;
}

// Folder open state: per document in memory (`doc._treeOpen`), defaults remembered in localStorage.
const LS = 'monolith.treeOpen';
function defaults() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
export function folderOpen(doc, key, dflt = true) {
  doc._treeOpen ??= {};
  if (!(key in doc._treeOpen)) { const d = defaults(); doc._treeOpen[key] = key in d ? d[key] : dflt; }
  return doc._treeOpen[key];
}
export function toggleFolder(doc, key) {
  doc._treeOpen[key] = !doc._treeOpen[key];
  try { const d = defaults(); d[key] = doc._treeOpen[key]; localStorage.setItem(LS, JSON.stringify(d)); } catch { /* storage off */ }
  doc.renderTree();
}

// 0.1.134: Shift+click in a tree = everything between the last clicked row (anchor) and this one, like a file list.
// items: Map key → item of the rows that can be range-selected; same(a, b) = may be in one range (e.g. both mates).
// Returns the items in tree order (anchor and target included), or null when there is no usable anchor.
export function rangeItems(treeEl, items, anchorKey, key, same = () => true) {
  if (!anchorKey || !items.has(anchorKey) || !items.has(key) || !same(items.get(anchorKey), items.get(key))) return null;
  const order = [];
  for (const r of treeEl.querySelectorAll('[data-item]')) { const k = r.dataset.item; if (items.has(k) && !order.includes(k)) order.push(k); }
  const a = order.indexOf(anchorKey), b = order.indexOf(key);
  if (a < 0 || b < 0) return null;
  return order.slice(Math.min(a, b), Math.max(a, b) + 1).map((k) => items.get(k)).filter((it) => same(it, items.get(key)));
}
