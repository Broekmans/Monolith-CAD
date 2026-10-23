// Display style per view (0.1.95): Shaded With Edges / Shaded / Wireframe / Realistic (0.1.106). Faces and edges are
// always built once in the shared scene; before a view (pane) draws, the objects are switched to that view's style
// (pane.displayMode, else the document's displayMode). Body meshes carry userData.disp = 'body', edge lines 'edges'.
// Body meshes with userData.look (appearance/look.js) switch between their Shaded and Realistic material.
import { opt, setOpt } from './app/options.js';
export const DISPLAY_STYLES = [['realistic', 'Realistic', 'realistic'], ['shadedEdges', 'Shaded With Edges', 'shaded'], ['shaded', 'Shaded', 'shaded'], ['wire', 'Wireframe', 'wire']];
export function applyDisplay(objs, mode) {
  for (const o of objs) {
    if (!o) continue;
    if (o.userData.disp === 'body') {
      const L = o.userData.look;
      if (L) o.material = mode === 'realistic' ? L.real : L.shaded;
      o.material.visible = mode !== 'wire';
    } else if (o.userData.disp === 'edges') { o.visible = mode === 'realistic' ? !!opt('realEdges') : mode !== 'shaded'; o.material.depthTest = mode !== 'wire'; }
  }
}
// style of pane p (or the view the mouse works in)
export const paneDisplay = (doc, p) => (p || doc.viewSet?.active)?.displayMode || doc.displayMode;
// Display Style menu items: change the clicked / focused view only when there are several views
export function displayItems(doc, p) {
  const set = doc.viewSet, pane = p || set?.focus || set?.active, multi = set && set.visible().length > 1;
  const cur = multi ? paneDisplay(doc, pane) : doc.displayMode;
  return [
    ...DISPLAY_STYLES.map(([m, label, icon]) => ({ label: label + (multi ? ' (this view)' : '') + (m === cur ? '  ✓' : ''), icon, run: () => setDisplayStyle(doc, m, pane) })),
    { label: 'Edges in Realistic' + (opt('realEdges') ? '  ✓' : ''), run: () => { setOpt('realEdges', !opt('realEdges')); window.__lithLog?.(`DISPLAY realEdges ${opt('realEdges')}`); doc.vp.requestRender(); } },
  ];
}
export function setDisplayStyle(doc, m, pane) {
  const set = doc.viewSet;
  if (set && set.visible().length > 1) (pane || set.focus || set.active).displayMode = m;
  else { doc.displayMode = m; for (const q of set?.panes || []) delete q.displayMode; }
  window.__lithLog?.(`DISPLAY ${m}${set && set.visible().length > 1 ? ' view ' + set.panes.indexOf(pane || set.focus) : ''}`);
  doc.vp.requestRender();
}
