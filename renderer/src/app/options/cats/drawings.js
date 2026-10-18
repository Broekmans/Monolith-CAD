// Options > Drawings: sheet look, snapping, point cloud views. Dimension / room styles are in the Drafting Standard.
const cat = 'Drawings';
export default [
  { key: '_std', cat, label: 'Drafting standard', type: 'button', text: 'Drafting Standard…', run: (a) => a.openDraftStd?.() },
  { key: 'paperColor', cat, group: 'Sheet', label: 'Paper colour on screen (PDF stays white)', type: 'color', def: '#f3e9cf' },
  { key: 'snapVertexPx', cat, group: 'Snapping', label: 'Snap to points / centres within', type: 'num', def: 8, min: 2, max: 30, step: 1, unit: 'px' },
  { key: 'snapEdgePx', cat, group: 'Snapping', label: 'Snap to edges within', type: 'num', def: 6, min: 2, max: 30, step: 1, unit: 'px' },
  { key: 'dotNormal', cat, group: 'Point cloud views', label: 'Dot spacing (density Normal) on paper', type: 'num', def: 0.25, min: 0.05, max: 2, step: 0.05, unit: 'mm' },
  { key: 'pixNormal', cat, group: 'Point cloud views', label: 'Density pixel (Normal) on paper', type: 'num', def: 0.1, min: 0.03, max: 1, step: 0.01, unit: 'mm' },
  { key: 'cloudThick', cat, group: 'Point cloud views', label: 'Section slice thickness for new sections', type: 'num', def: 0.3, min: 0.01, max: 10, step: 0.05, unit: 'm' },
  { key: 'planFrom', cat, group: 'Point cloud views', label: 'Floor plan slice from (above floor)', type: 'num', def: 1.0, min: -5, max: 20, step: 0.05, unit: 'm' },
  { key: 'planTo', cat, group: 'Point cloud views', label: 'Floor plan slice to', type: 'num', def: 1.3, min: -5, max: 20, step: 0.05, unit: 'm' },
  { key: 'slabFrom', cat, group: 'Point cloud views', label: 'Thick slice from (above floor)', type: 'num', def: 0.2, min: -5, max: 20, step: 0.05, unit: 'm' },
  { key: 'slabTo', cat, group: 'Point cloud views', label: 'Thick slice to', type: 'num', def: 1.7, min: -5, max: 20, step: 0.05, unit: 'm' },
];
