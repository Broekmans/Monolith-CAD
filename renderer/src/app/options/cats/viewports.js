// Options > Viewports: several views, view cube, view toolbar, grid.
const cat = 'Viewports';
export default [
  { key: 'scaleWithView', cat, group: 'Views', label: 'Model scales with the view when resizing', type: 'bool', def: true },
  { key: 'dividerW', cat, group: 'Views', label: 'Divider width between views', type: 'num', def: 4, min: 2, max: 16, step: 1, unit: 'px' },
  { key: 'cubePct', cat, group: 'View cube', label: 'View cube size (of the shorter side of the view)', type: 'num', def: 16, oldDefs: [22], min: 5, max: 60, step: 1, unit: '%' },
  { key: 'cubeMin', cat, group: 'View cube', label: 'View cube minimum', type: 'num', def: 64, min: 32, max: 256, step: 4, unit: 'px' },
  { key: 'cubeMax', cat, group: 'View cube', label: 'View cube maximum', type: 'num', def: 128, min: 32, max: 320, step: 4, unit: 'px' },
  { key: 'hudPos', cat, group: 'View toolbar', label: 'View toolbar position', type: 'select', def: 'cube', choices: [['cube', 'Under the view cube (vertical)'], ['left', 'Left of the view cube'], ['top', 'Top centre']] },
  { key: 'hudScale', cat, group: 'View toolbar', label: 'View toolbar scale', type: 'num', def: 100, min: 50, max: 200, step: 5, unit: '%' },
  { key: 'gridDefault', cat, group: 'Grid', label: 'Grid on by default', type: 'bool', def: false, oldDefs: [true], apply: (a, v) => a.setGrid(v, true) },
  { key: 'gridMinor', cat, group: 'Grid', label: 'Minor lines', type: 'pct', def: 60, min: 0, max: 100 },
  { key: 'gridMajor', cat, group: 'Grid', label: 'Major lines', type: 'pct', def: 85, min: 0, max: 100 },
];
