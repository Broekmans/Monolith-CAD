// Options > Sketch: picking distances while sketching, Convert Entities links, big size changes.
const cat = 'Sketch';
export default [
  { key: 'skPickPx', cat, label: 'Pick / snap distance', type: 'num', def: 8, min: 3, max: 30, step: 1, unit: 'px' },
  { key: 'skDragPx', cat, label: 'Mouse moves before a drag starts', type: 'num', def: 4, min: 1, max: 20, step: 1, unit: 'px' },
  { key: 'linkConvert', cat, group: 'Convert Entities', label: 'Link converted edges to the model (On Edge)', type: 'bool', def: true },
  { key: 'linkOld', cat, group: 'Convert Entities', label: 'Link old converted edges when opening a part', type: 'bool', def: true },
  { key: 'linkTolPct', cat, group: 'Convert Entities', label: 'Edge match tolerance', type: 'num', def: 4, min: 0.5, max: 20, step: 0.5, unit: '% of part size' },
  { key: 'driveUpstream', cat, group: 'Sizes', label: 'Size that follows converted edges changes the sketch that made them', type: 'bool', def: true },
  { key: 'sizeStepPct', cat, group: 'Sizes', label: 'Large size changes: largest step per solve', type: 'num', def: 25, min: 5, max: 100, step: 5, unit: '%' },
];
