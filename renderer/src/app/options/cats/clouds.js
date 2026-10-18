// Options > Point Clouds: defaults for new point cloud documents / scans.
const cat = 'Point Clouds';
export default [
  { key: 'cloudBudget', cat, label: 'Point budget for new documents', type: 'num', def: 10, min: 1, max: 100, step: 1, unit: 'M' },
  { key: 'cloudEdl', cat, label: 'Depth shading on in new documents', type: 'bool', def: true },
  { key: 'cloudEdlStrength', cat, label: 'Depth shading strength (new documents)', type: 'num', def: 1, min: 0.1, max: 5, step: 0.1 },
  { key: 'cloudPointSize', cat, label: 'Point size for added scans', type: 'num', def: 2, min: 1, max: 10, step: 0.5, unit: 'px' },
];
