// Options (Tools > Options…): every program setting, read everywhere with opt(key).
// The settings themselves live per category in ./cats/*.js (one row per setting) — to add one:
//   1. add a row to the matching cats file (key, label, type, def …), 2. read it with opt('key') where the value is used.
// Rows with hidden: true are internal values (tolerances, sizes, colours of small marks …): declared here once, not shown
// in the Options window, never stored — opt() always returns the factory value. Showing one later = remove hidden.
// No fixed look/behaviour values in code: every such value is a row here (see claude/ekcad-workflow.md, ground-up rules).
// Values: factory defaults (rows' def) < "My Defaults" file (<CAD Program>\monolith-options.json, IPC options:cfg)
// < current values (localStorage monolith.options). Pure module (no app imports) so any code can read it.
import general from './cats/general.js';
import view from './cats/view.js';
import viewports from './cats/viewports.js';
import colours from './cats/colours.js';
import sketch from './cats/sketch.js';
import features from './cats/features.js';
import drawings from './cats/drawings.js';
import clouds from './cats/clouds.js';
import section from './cats/section.js';
import common from './cats/common.js';
import sketchvals from './cats/sketchvals.js';
import partvals from './cats/partvals.js';
import drawingvals from './cats/drawingvals.js';

export const OPTIONS_DEF = [...general, ...view, ...viewports, ...colours, ...sketch, ...features, ...section, ...drawings, ...clouds, ...common, ...sketchvals, ...partvals, ...drawingvals];
export const OPTIONS_SHOWN = OPTIONS_DEF.filter((d) => !d.hidden);
export const OPT_CATS = [...new Set(OPTIONS_SHOWN.map((d) => d.cat))];
const TEST = !!globalThis.window?.monolith?.isTest;
const DEF = Object.fromEntries(OPTIONS_DEF.filter((d) => 'def' in d).map((d) => [d.key, d.def]));
if (TEST) DEF.dark = false; // e2e tests start light
const LS = 'monolith.options';
// Factory default changed later (row field oldDefs): a stored value equal to an old factory default follows the new one
// (current values store every key, so without this a new default never reaches existing users).
function upgrade(o) {
  for (const d of OPTIONS_DEF) if (d.oldDefs && d.key in o && d.oldDefs.includes(o[d.key])) delete o[d.key];
  return o;
}

let cur = null, mine = null; // current values, "My Defaults" (file)
export const factory = () => ({ ...DEF });
export const factoryOf = (k) => DEF[k];
export const myDefaults = () => ({ ...DEF, ...(mine || {}) });
export function clean(o) {
  const r = {};
  for (const d of OPTIONS_DEF) {
    if (d.hidden || !('def' in d) || !(d.key in (o || {}))) continue;
    let v = o[d.key];
    if (d.type === 'bool') v = !!v;
    else if (d.type === 'color') { if (!/^#[0-9a-f]{6}$/i.test(String(v))) continue; }
    else if (d.type === 'select') { if (!d.choices.some(([c]) => c === v)) continue; }
    else if (d.type === 'num' || d.type === 'pct') { v = +v; if (!Number.isFinite(v)) continue; v = Math.min(d.max ?? 1e9, Math.max(d.min ?? -1e9, v)); }
    r[d.key] = v;
  }
  return r;
}
// first start of 0.1.75: carry the old single settings over
function migrate() {
  const o = {}, g = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  if (g('monolith.theme')) o.dark = g('monolith.theme') === 'dark';
  if (g('monolith.grid')) o.gridDefault = g('monolith.grid') !== 'off';
  if (g('monolith.isoFeat')) o.isoFeatures = g('monolith.isoFeat') !== 'off';
  if (+g('monolith.uiScale')) o.uiScale = Math.round(+g('monolith.uiScale') * 100);
  return o;
}
function load() {
  if (cur) return cur;
  let s = null; try { s = TEST ? null : JSON.parse(localStorage.getItem(LS) || 'null'); } catch {}
  cur = { ...DEF, ...(s ? upgrade(clean(s)) : TEST ? {} : clean(migrate())) };
  cur._stored = !!s;
  return cur;
}
export function opt(k) { const c = load(); return k in c ? c[k] : DEF[k]; }
const HIDDEN = new Set(OPTIONS_DEF.filter((d) => d.hidden).map((d) => d.key));
export function allOpts() { const { _stored, ...c } = load(); for (const k of HIDDEN) delete c[k]; return c; }
// set current values (remembered); returns the keys that changed
export function setOpts(o) {
  const c = load(), n = clean(o), changed = [];
  for (const [k, v] of Object.entries(n)) if (c[k] !== v) { c[k] = v; changed.push(k); }
  c._stored = true;
  try { const { _stored, ...save } = c; localStorage.setItem(LS, JSON.stringify(save)); } catch {}
  return changed;
}
export const setOpt = (k, v) => setOpts({ [k]: v });
export function hasStored() { return load()._stored; }
export function setMine(o) { mine = o ? upgrade(clean(o)) : null; }
// colour option as a THREE-style number
export const optHex = (k) => parseInt(String(opt(k)).slice(1), 16);
