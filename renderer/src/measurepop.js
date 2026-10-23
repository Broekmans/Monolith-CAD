// 0.1.134: Ctrl+click two faces / edges (part or assembly) → a small movable popup with the distance between them
// (normal distance when parallel, else the minimum distance and the angle; centre distance and ΔX ΔY ΔZ), and the
// main value in the status bar corner. Geometry: shared/measure.mjs. One popup per document; closes when the
// selection is not two faces / edges any more.
import { h, fmt, makeDraggable } from './ui.js';
import { opt } from './app/options.js';
import { measurePair } from '../../shared/measure.mjs';

const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* optional */ } };

export function closePairMeasure(doc) {
  if (!doc._measPop) return;
  doc._measPop.remove(); doc._measPop = null;
  doc.app.setCoords('');
}
// A, B: entities (entityOf) in one frame; names: their labels; host: element to place the popup at (the views)
export function showPairMeasure(doc, A, B, names, host) {
  if (!opt('measPair') || !A || !B) { closePairMeasure(doc); return null; }
  const r = measurePair(A, B, opt('measParTol')), d = opt('measPairDecimals');
  const mm = (v) => `${fmt(v, d)} mm`;
  const main = r.normal != null ? ['Normal distance', r.normal] : ['Minimum distance', r.min];
  let el = doc._measPop;
  const fresh = !el || !el.isConnected;
  if (fresh) {
    el = h('div', { class: 'ann-props app-pop meas-pop' });
    for (const ev of ['pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    doc._measPop = el;
  }
  const row = (label, val, cls = '') => h('div', { class: 'ap-row' + cls }, h('label', {}, label), h('span', { class: 'ap-val' }, val));
  el.replaceChildren(
    h('div', { class: 'ap-head' }, h('b', {}, 'Measure'), h('span', { class: 'ap-val' }, `${names[0]} · ${names[1]}`), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: () => closePairMeasure(doc) }, '×')),
    row(main[0], mm(main[1]), ' ap-main'),
    r.normal != null ? row('Minimum distance', mm(r.min)) : null,
    row('Center distance', mm(r.center)),
    r.angle != null ? row('Angle', `${fmt(r.angle, d)}°`) : null,
    row('ΔX  ΔY  ΔZ', r.dxyz.map((v) => fmt(v, d)).join('   ')),
  );
  if (fresh) {
    const b = (host || document.body).getBoundingClientRect(), e = opt('appPopEdgePx');
    el.style.left = Math.max(e, b.right - el.offsetWidth - e) + 'px'; el.style.top = b.top + e + 'px';
    makeDraggable(el, '.ap-head', 'monolith.measPos');
  }
  doc.app.setCoords(`${main[0] === 'Normal distance' ? 'Normal distance' : 'Distance'} ${mm(main[1])}`);
  log('MEASURE', names.join(' · '), `${main[0]} ${fmt(main[1], d)} mm, center ${fmt(r.center, d)} mm${r.angle != null ? `, angle ${fmt(r.angle, d)}°` : ''}`);
  return r;
}
