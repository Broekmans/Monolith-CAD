// Options > Display: the Realistic display style and appearances (0.1.106, appearance/look.js + popup.js).
const cat = 'Display', R = 'Realistic';
export default [
  { key: 'realEdges', cat, group: R, label: 'Edges in Realistic (also in the Display Style menu)', type: 'bool', def: false },
  { key: 'realBackground', cat, group: R, label: 'Studio background', type: 'bool', def: true },
  { key: 'realBgTop', cat, group: R, label: 'Studio background top', type: 'color', def: '#f4f6f9' },
  { key: 'realBgBottom', cat, group: R, label: 'Studio background bottom', type: 'color', def: '#b7bfca' },
  { key: 'realBgTopDark', cat, group: R, label: 'Studio background top (dark mode)', type: 'color', def: '#565e70' }, // 0.1.114: Realistic was white in dark mode
  { key: 'realBgBottomDark', cat, group: R, label: 'Studio background bottom (dark mode)', type: 'color', def: '#2e333d' },
  { key: 'realEnvStrength', cat, group: R, label: 'Reflection strength', type: 'num', def: 1, min: 0, max: 3, step: 0.05 },
  { key: 'realExposure', cat, group: R, label: 'Brightness (exposure)', type: 'num', def: 0.9, min: 0.2, max: 3, step: 0.05 },
  { key: 'realLamps', cat, group: R, label: 'Viewport lamps in Realistic', type: 'num', def: 30, min: 0, max: 150, step: 5, unit: '%' },
  { key: 'realTextures', cat, group: R, label: 'Textures (brushed, wood, cast, knurl, grain)', type: 'bool', def: true },
  { key: 'realTexBump', cat, group: R, label: 'Texture relief', type: 'num', def: 1, min: 0, max: 3, step: 0.1, unit: '×' },
  { key: 'realShadow', cat, group: R, label: 'Ground shadow', type: 'bool', def: true },
  { key: 'realShadowPct', cat, group: R, label: 'Ground shadow strength', type: 'num', def: 75, oldDefs: [55], min: 0, max: 100, step: 5, unit: '%' },
  { key: 'realShadowSpread', cat, group: R, label: 'Ground shadow spread (% of the model size)', type: 'num', def: 10, min: 0, max: 30, step: 1, unit: '%' }, // 0.1.114
  { key: 'realReflect', cat, group: R, label: 'Floor reflection', type: 'bool', def: false },
  { key: 'realReflectPct', cat, group: R, label: 'Floor reflection strength', type: 'num', def: 25, min: 0, max: 100, step: 5, unit: '%' },
  // internal
  { key: 'realTexPx', hidden: true, label: 'Generated texture size (px)', def: 256 },
  { key: 'realShadowPx', hidden: true, label: 'Ground shadow: cells along the longer side', def: 256 },
  { key: 'realShadowMargin', hidden: true, label: 'Ground shadow: margin around the model (× its longer side)', def: 0.3 },
  { key: 'realShadowWide', hidden: true, label: 'Ground shadow: darkness of the wide soft layer (× strength)', def: 0.6 },
  { key: 'realShadowWideFade', hidden: true, label: 'Ground shadow: wide layer fades out at this height above the ground (× model height, at least × longer side 0.25)', def: 1 },
  { key: 'realShadowBlur', hidden: true, label: 'Ground shadow: blur radius (× shadow size)', def: 0.025 },
  { key: 'realShadowFade', hidden: true, label: 'Ground shadow: fades out at this height above the ground (× model height)', def: 0.35 },
  { key: 'realShadowGap', hidden: true, label: 'Ground shadow: below the model by (× its longer side)', def: 0.002 },
  { key: 'realReflectFade', hidden: true, label: 'Floor reflection: fades out at this depth (× model height)', def: 0.5 },
  { key: 'realEnvBlur', hidden: true, label: 'Reflection map blur (PMREM sigma)', def: 0.04 },
  { key: 'realClearcoatRough', hidden: true, label: 'Clear coat roughness', def: 0.08 },
  { key: 'appPopEdgePx', hidden: true, label: 'Appearance popup: distance from the view edge (px)', def: 12 },
  { key: 'appPopPollMs', hidden: true, label: 'Appearance popup: check for undo / closed document every (ms)', def: 500 },
  { key: 'appSwatchPx', hidden: true, label: 'Appearance popup: swatch size (px)', def: 22 },
];
