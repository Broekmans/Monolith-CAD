// Options > Interface (0.1.128): compact layout — ribbon size / scale / group labels, quick access bar, tree indent and
// row height. Applied as body classes + CSS variables by settings.js applyInterface().
const cat = 'Interface';
const ui = (a) => a.applyInterface?.();
export default [
  { key: 'ribbonSize', cat, group: 'Ribbon', label: 'Ribbon buttons', type: 'select', def: 'medium', choices: [['large', 'Large (icon above the text)'], ['medium', 'Medium (smaller icon, text below)'], ['small', 'Small (icon with the text beside it)']], apply: ui },
  { key: 'ribbonScalePct', cat, group: 'Ribbon', label: 'Ribbon size', type: 'num', def: 100, min: 70, max: 130, step: 5, unit: '%', apply: ui },
  { key: 'ribbonGroupLabels', cat, group: 'Ribbon', label: 'Show the group names under the buttons (Component, Position …)', type: 'bool', def: true, apply: ui },
  { key: 'qaBar', cat, group: 'Quick access bar', label: 'Bar above the ribbon (New, Open, Save, Undo, Redo, file name)', type: 'select', def: 'thin', choices: [['thin', 'Thin'], ['hidden', 'Hidden']], apply: ui },
  { key: 'treeIndentPx', cat, group: 'Tree', label: 'Indent per level', type: 'num', def: 4, oldDefs: [10], min: 4, max: 24, step: 1, unit: 'px', apply: (a) => { ui(a); a.cur?.().doc?.renderTree?.(); } },
  { key: 'treeRowPx', cat, group: 'Tree', label: 'Row height', type: 'num', def: 16, oldDefs: [20], min: 16, max: 32, step: 1, unit: 'px', apply: ui },
  { key: 'treePadPx', hidden: true, label: 'Tree: space left of the first level', def: 4, unit: 'px' },
];
