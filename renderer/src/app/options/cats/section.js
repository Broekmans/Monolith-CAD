// Options > Section View: look and grab distance of the section plane handles (dotted lines + arrow).
const cat = 'Section View';
export default [
  { key: 'secColor', cat, label: 'Handle colour (dotted lines, arrow)', type: 'color', def: '#ff3b2f' },
  { key: 'secGlow', cat, label: 'Glow', type: 'num', def: 8, min: 0, max: 30, step: 1, unit: 'px' },
  { key: 'secLineW', cat, label: 'Line width', type: 'num', def: 1.5, min: 0.5, max: 6, step: 0.5, unit: 'px' },
  { key: 'secArrowPx', cat, label: 'Arrow length', type: 'num', def: 60, min: 20, max: 200, step: 5, unit: 'px' },
  { key: 'secGrabPx', cat, label: 'Grab the lines / arrow within', type: 'num', def: 8, min: 3, max: 30, step: 1, unit: 'px' },
  { key: 'secStepPct', cat, label: 'Mouse wheel step (of the part size)', type: 'num', def: 1, min: 0.1, max: 20, step: 0.1, unit: '%' },
];
