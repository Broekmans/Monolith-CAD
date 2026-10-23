// Options > General. One row = one setting; read anywhere with opt('key') (app/options.js).
// Row fields: key, cat (category in the Options window), group (sub-heading), label, type bool|num|pct|color|select|button|info,
// def (factory value), min/max/step/unit, choices [[value, label]] for select, apply(app, v) when the change needs an action.
const cat = 'General';
export default [
  { key: 'dark', cat, label: 'Dark mode', type: 'bool', def: true, apply: (a, v) => a.setTheme(v) },
  { key: 'uiScale', cat, label: 'UI scale', type: 'num', def: 100, min: 60, max: 200, step: 5, unit: '%', apply: (a, v) => a.setUiScale(v / 100, false) },
  { key: 'toastSec', cat, label: 'Messages stay visible for', type: 'num', def: 3.5, min: 1, max: 30, step: 0.5, unit: 's' },
  { key: 'actionLog', cat, group: 'Logging', label: 'Action log (Logs folder)', type: 'bool', def: true, apply: (a, v) => a.setActionLog?.(v) },
  { key: 'trackOptions', cat, group: 'Logging', label: 'Record my setting changes (Logs\\option-changes.json)', type: 'bool', def: true },
  { key: 'kernelMulti', cat, group: 'Geometry kernel', label: 'Use all CPU cores for rebuilds (booleans, meshing)', type: 'bool', def: false, oldDefs: [true], apply: (a, v) => a.setKernelMode?.(v) }, // 0.1.114: default off (Wouter's PC: only 0.2 s of 2 s faster on Tekst test)
  { key: 'kernelThreadsMax', hidden: true, label: 'Multi-thread kernel: at most this many threads', def: 16 },
  { key: 'logRebuildMs', hidden: true, label: 'Action log: rebuilds that take at least this long are logged with their time (ms)', def: 500 },
  { key: '_dwg', cat, group: 'Files', label: 'DWG converter', type: 'button', text: 'DWG Converter…', run: (a) => a.dwgHelp() },
];
