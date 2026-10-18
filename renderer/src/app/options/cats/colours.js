// Options > Colours: model, selection and sketch colours (Part + Assembly).
const cat = 'Colours';
export default [
  { key: 'bodyColor', cat, group: 'Model', label: 'Part body', type: 'color', def: '#cfd6df' },
  { key: 'edgeColor', cat, group: 'Model', label: 'Edges', type: 'color', def: '#111111' },
  { key: 'planeColor', cat, group: 'Model', label: 'Planes', type: 'color', def: '#6a9ad8' },
  { key: 'hoverColor', cat, group: 'Selection', label: 'Highlight under the mouse', type: 'color', def: '#ff9a1a' },
  { key: 'selColor', cat, group: 'Selection', label: 'Selected', type: 'color', def: '#1e90ff' },
  { key: 'skSel', cat, group: 'Sketch', label: 'Selected sketch item', type: 'color', def: '#d81bd8' },
  { key: 'skHover', cat, group: 'Sketch', label: 'Sketch item under the mouse / preview', type: 'color', def: '#ff8a00' },
  { key: 'shownSkLight', cat, group: 'Sketch', label: 'Highlighted sketch on the model (light)', type: 'color', def: '#1660d8' },
  { key: 'shownSkDark', cat, group: 'Sketch', label: 'Highlighted sketch on the model (dark)', type: 'color', def: '#6fb4ff' },
];
