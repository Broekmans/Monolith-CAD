// Options (Tools > Options…): one table of program settings, read everywhere with opt(key).
// Values: factory defaults (OPTIONS_DEF) < "My Defaults" file (<CAD Program>\monolith-options.json, IPC options:cfg)
// < current values (localStorage monolith.options, written on OK). "Save as My Defaults" writes the file,
// "Back to My Defaults" / "Reset to Factory Defaults" load them into the window (OK applies).
// Pure module (no app imports) so viewport.js / part code can read it.

// type: bool | num | color | pct (number 0–100 shown with %) | select | button
// apply(app, v): run when the value changes (theme, UI scale …); others are read live via opt()
export const OPTIONS_DEF = [
  // General
  { key: 'dark', cat: 'General', label: 'Dark mode', type: 'bool', def: true, apply: (a, v) => a.setTheme(v) },
  { key: 'uiScale', cat: 'General', label: 'UI scale', type: 'num', def: 100, min: 60, max: 200, step: 5, unit: '%', apply: (a, v) => a.setUiScale(v / 100, false) },
  { key: 'actionLog', cat: 'General', label: 'Action log (Logs folder)', type: 'bool', def: true, apply: (a, v) => a.setActionLog?.(v) },
  { key: '_dwg', cat: 'General', label: 'DWG converter', type: 'button', text: 'DWG Converter…', run: (a) => a.dwgHelp() },
  // View / Mouse
  { key: 'gridDefault', cat: 'View / Mouse', label: 'Grid on by default', type: 'bool', def: true, apply: (a, v) => a.setGrid(v, true) },
  { key: 'midDouble', cat: 'View / Mouse', label: 'Double middle click = Zoom to Fit', type: 'bool', def: true },
  { key: 'midDoubleMs', cat: 'View / Mouse', label: 'Double click time', type: 'num', def: 450, min: 200, max: 1000, step: 50, unit: 'ms' },
  { key: 'isoFeatures', cat: 'View / Mouse', label: 'Turn to Isometric for features', type: 'bool', def: true, apply: (a, v) => a.setIsoForFeatures(v, true) },
  { key: 'isoTol', cat: 'View / Mouse', label: 'Only when looking at the sketch within', type: 'num', def: 10, min: 1, max: 45, step: 1, unit: '°' },
  { key: 'wheelZoom', cat: 'View / Mouse', label: 'Wheel zoom speed', type: 'num', def: 100, min: 25, max: 400, step: 5, unit: '%' },
  { key: '_mouse', cat: 'View / Mouse', label: 'Mouse', type: 'info', text: 'Middle drag = rotate · Shift + middle = pan · Ctrl + middle = zoom · right drag = pan' },
  // Viewports
  { key: 'scaleWithView', cat: 'Viewports', label: 'Model scales with the view when resizing', type: 'bool', def: true },
  // Feature preview (ghost)
  { key: 'ghostBoss', cat: 'Feature Preview', label: 'Boss colour', type: 'color', def: '#f2b630' },
  { key: 'ghostCut', cat: 'Feature Preview', label: 'Cut colour', type: 'color', def: '#e0463c' },
  { key: 'ghostFace', cat: 'Feature Preview', label: 'Face opacity', type: 'pct', def: 8, min: 0, max: 100 },
  { key: 'ghostBehind', cat: 'Feature Preview', label: 'Opacity inside the body', type: 'pct', def: 4, min: 0, max: 100 },
  { key: 'ghostEdge', cat: 'Feature Preview', label: 'Edge opacity', type: 'pct', def: 100, min: 0, max: 100 },
  { key: 'ghostPrev', cat: 'Feature Preview', label: 'Body before feature (fillet, shell, patterns)', type: 'pct', def: 10, min: 0, max: 100 },
  { key: 'profileFill', cat: 'Feature Preview', label: 'Profile fill opacity', type: 'pct', def: 35, min: 0, max: 100 },
  // Feature values
  { key: 'enterTwice', cat: 'Feature Values', label: 'Enter twice to confirm (first Enter = preview)', type: 'bool', def: true },
  { key: 'wheelStep', cat: 'Feature Values', label: 'Mouse wheel step (mm / °)', type: 'num', def: 1, min: 0.01, max: 1000, step: 0.5 },
  { key: 'wheelNewOnly', cat: 'Feature Values', label: 'Wheel changes the value only for new features', type: 'bool', def: true },
  // Dimensions on the model
  { key: 'autoDims', cat: 'Dimensions', label: 'Show sizes without dimensions (dashed)', type: 'bool', def: true },
  { key: 'shownSkLight', cat: 'Dimensions', label: 'Highlighted sketch colour (light)', type: 'color', def: '#1660d8' },
  { key: 'shownSkDark', cat: 'Dimensions', label: 'Highlighted sketch colour (dark)', type: 'color', def: '#6fb4ff' },
  // Drawings
  { key: '_std', cat: 'Drawings', label: 'Drafting standard', type: 'button', text: 'Drafting Standard…', run: (a) => a.openDraftStd?.() },
  // Point clouds
  { key: 'cloudBudget', cat: 'Point Clouds', label: 'Point budget for new documents', type: 'num', def: 10, min: 1, max: 100, step: 1, unit: 'M' },
  { key: 'cloudEdl', cat: 'Point Clouds', label: 'Depth shading on in new documents', type: 'bool', def: true },
];
export const OPT_CATS = [...new Set(OPTIONS_DEF.map((d) => d.cat))];
const TEST = !!globalThis.window?.monolith?.isTest;
const DEF = Object.fromEntries(OPTIONS_DEF.filter((d) => 'def' in d).map((d) => [d.key, d.def]));
if (TEST) DEF.dark = false; // e2e tests start light
const LS = 'monolith.options';

let cur = null, mine = null; // current values, "My Defaults" (file)
export const factory = () => ({ ...DEF });
export const myDefaults = () => ({ ...DEF, ...(mine || {}) });
export function clean(o) {
  const r = {};
  for (const d of OPTIONS_DEF) {
    if (!('def' in d) || !(d.key in (o || {}))) continue;
    let v = o[d.key];
    if (d.type === 'bool') v = !!v;
    else if (d.type === 'color') { if (!/^#[0-9a-f]{6}$/i.test(String(v))) continue; }
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
  cur = { ...DEF, ...(s ? clean(s) : TEST ? {} : clean(migrate())) };
  cur._stored = !!s;
  return cur;
}
export function opt(k) { const c = load(); return k in c ? c[k] : DEF[k]; }
export function allOpts() { const { _stored, ...c } = load(); return c; }
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
export function setMine(o) { mine = o ? clean(o) : null; }
