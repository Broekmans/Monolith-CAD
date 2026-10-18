// Options > Feature Preview / Feature Values / Dimensions (Part feature dialogs).
export default [
  { key: 'ghostBoss', cat: 'Feature Preview', label: 'Boss colour', type: 'color', def: '#f2b630' },
  { key: 'ghostCut', cat: 'Feature Preview', label: 'Cut colour', type: 'color', def: '#f2b630', oldDefs: ['#e0463c'] }, // yellow since 0.1.82 (Wouter)
  { key: 'ghostFace', cat: 'Feature Preview', label: 'Face opacity', type: 'pct', def: 8, min: 0, max: 100 },
  { key: 'ghostBehind', cat: 'Feature Preview', label: 'Opacity inside the body', type: 'pct', def: 4, min: 0, max: 100 },
  { key: 'ghostEdge', cat: 'Feature Preview', label: 'Edge opacity', type: 'pct', def: 100, min: 0, max: 100 },
  { key: 'ghostPrev', cat: 'Feature Preview', label: 'Body before feature (fillet, shell, patterns)', type: 'pct', def: 10, min: 0, max: 100 },
  { key: 'profileFill', cat: 'Feature Preview', label: 'Profile fill opacity', type: 'pct', def: 35, min: 0, max: 100 },
  { key: 'enterTwice', cat: 'Feature Values', label: 'Enter twice to confirm (first Enter = preview)', type: 'bool', def: true },
  { key: 'wheelStep', cat: 'Feature Values', label: 'Mouse wheel step (mm / °)', type: 'num', def: 1, min: 0.01, max: 1000, step: 0.5 },
  { key: 'wheelNewOnly', cat: 'Feature Values', label: 'Wheel changes the value only for new features', type: 'bool', def: true },
  { key: 'autoDims', cat: 'Dimensions', label: 'Show sizes without dimensions (dashed)', type: 'bool', def: true },
  { key: 'modelDimLines', cat: 'Dimensions', label: 'Show dimension lines on the model (double-clicked face)', type: 'bool', def: true },
];
