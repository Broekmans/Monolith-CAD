// Options > View / Mouse: navigation speeds, view turning, standard-view animation.
const cat = 'View / Mouse';
export default [
  { key: 'rotateSpeed', cat, group: 'Mouse', label: 'Rotate speed (middle drag, view cube drag)', type: 'num', def: 100, min: 20, max: 400, step: 5, unit: '%' },
  { key: 'wheelZoom', cat, group: 'Mouse', label: 'Wheel zoom speed', type: 'num', def: 100, min: 25, max: 400, step: 5, unit: '%' },
  { key: 'dragZoomSpeed', cat, group: 'Mouse', label: 'Ctrl + middle drag zoom speed', type: 'num', def: 100, min: 20, max: 400, step: 5, unit: '%' },
  { key: 'midDouble', cat, group: 'Mouse', label: 'Double middle click = Zoom to Fit', type: 'bool', def: true },
  { key: 'midDoubleMs', cat, group: 'Mouse', label: 'Double click time', type: 'num', def: 450, min: 200, max: 1000, step: 50, unit: 'ms' },
  { key: 'navHighlight', cat, group: 'Mouse', label: 'Highlight faces while rotating / panning', type: 'bool', def: false },
  { key: '_mouse', cat, group: 'Mouse', label: 'Mouse', type: 'info', text: 'Middle drag = rotate · Shift + middle = pan · Ctrl + middle = zoom · right drag = pan' },
  { key: 'viewAnimMs', cat, group: 'Views', label: 'Turn to a standard view in (0 = jump)', type: 'num', def: 280, min: 0, max: 2000, step: 20, unit: 'ms' },
  { key: 'arrowStep', cat, group: 'Views', label: 'Arrow keys turn the view by', type: 'num', def: 15, min: 1, max: 90, step: 1, unit: '°' },
  { key: 'isoFeatures', cat, group: 'Views', label: 'Turn to Isometric for features', type: 'bool', def: true, apply: (a, v) => a.setIsoForFeatures(v, true) },
  { key: 'isoTol', cat, group: 'Views', label: 'Only when looking at the sketch within', type: 'num', def: 10, min: 1, max: 45, step: 1, unit: '°' },
];
