// Appearance popup (0.1.106): library swatches per category + Colour / Roughness / Metalness / Opacity, in the
// compact popup style (like the drawing's room popup). Used for a part (stored in the part file: doc.appearance)
// and for an assembly component (override stored in the assembly: component.appearance). Every change = one undo step.
import { h, makeDraggable } from '../ui.js';
import { opt } from '../app/options.js';
import { APPEARANCES, APPEARANCE_CATS, TEXTURES } from './library.js';

const log = (...a) => { try { window.__lithLog?.(...a); } catch {} };
let open = null;
export function closeAppearance() { if (!open) return; clearInterval(open.timer); document.removeEventListener('keydown', open.onKey, true); open.el.remove(); open = null; }

// doc: Part or Assembly document (beginChange / commit / vp); o = { title, name, holder() → object with .appearance,
// resolve() → resolved appearance, source() → text where it comes from, clearLabel }
export function openAppearance(doc, o) {
  closeAppearance();
  const el = h('div', { class: 'ann-props app-pop' });
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
  document.body.appendChild(el);
  const st = { pending: false };
  const own = () => o.holder()?.appearance || null;
  const redraw = () => { doc.vp.requestRender(); };
  // one undo step: fn changes the holder's appearance
  const change = (fn, what) => { const hd = o.holder(); if (!hd) return closeAppearance(); doc.beginChange(); fn(hd); if (hd.appearance && !Object.keys(hd.appearance).length) delete hd.appearance; doc.commit(); log('APPEARANCE', o.title, o.name, what); doc.renderTree?.(); redraw(); fill(); };
  // sliders: live while dragging, one undo step on release
  const live = (k, v) => { const hd = o.holder(); if (!hd) return; if (!st.pending) { doc.beginChange(); st.pending = true; } hd.appearance = { ...(hd.appearance || {}), [k]: v }; redraw(); };
  const done = (k) => { if (!st.pending) return; st.pending = false; doc.commit(); log('APPEARANCE', o.title, o.name, `${k}=${o.holder()?.appearance?.[k]}`); fill(); };

  function fill() {
    const a = o.resolve(), mine = own(), px = opt('appSwatchPx');
    el.replaceChildren();
    const head = h('div', { class: 'ap-head' }, h('b', {}, 'Appearance'), h('span', { class: 'ap-val' }, o.name), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: closeAppearance }, '×'));
    el.append(head);
    el.append(h('div', { class: 'app-cur' }, h('span', { class: 'app-sw big', style: `background:${a.color};opacity:${a.opacity ?? 1}` }), h('div', {}, h('div', { class: 'app-name' }, a.name || 'Default colour'), h('div', { class: 'ap-info' }, o.source()))));
    for (const cat of APPEARANCE_CATS) {
      el.append(h('div', { class: 'ap-sec' }, cat));
      el.append(h('div', { class: 'app-grid' }, ...APPEARANCES.filter((x) => x.cat === cat).map((x) => h('button', {
        class: 'app-sw' + (a.name === x.name ? ' on' : ''), title: x.name, style: `width:${px}px;height:${px}px;background:${swatchBg(x)}`,
        onclick: () => change((hd) => { hd.appearance = { name: x.name }; }, `name=${x.name}`),
      }))));
    }
    el.append(h('div', { class: 'ap-sec' }, 'Adjust'));
    const row = (label, input, set) => h('div', { class: 'ap-row' + (set ? ' own' : '') }, h('label', { title: set ? 'Changed by hand' : '' }, label), input);
    const col = h('input', { type: 'color', value: a.color });
    col.addEventListener('input', () => live('color', col.value));
    col.addEventListener('change', () => done('color'));
    el.append(row('Colour', col, mine?.color != null));
    const slider = (k, label, v, scale = 1) => {
      const num = h('span', { class: 'app-num' }, fmtv(v * scale));
      const r = h('input', { type: 'range', min: '0', max: String(scale), step: String(scale / 100), value: String(v * scale) });
      r.addEventListener('input', () => { num.textContent = fmtv(+r.value); live(k, +r.value / scale); });
      r.addEventListener('change', () => done(k));
      return row(label, h('div', { class: 'app-sl' }, r, num), mine?.[k] != null);
    };
    el.append(slider('roughness', 'Roughness', a.roughness), slider('metalness', 'Metalness', a.metalness), slider('opacity', 'Opacity (%)', a.opacity ?? 1, 100));
    // texture (0.1.110): generated, Realistic only; scale on a doubling scale (¼× … 4×)
    const sel = h('select', {}, h('option', { value: 'none', selected: !a.tex }, 'None'), ...Object.entries(TEXTURES).map(([k, t]) => h('option', { value: k, selected: a.tex === k }, t.label)));
    sel.addEventListener('change', () => change((hd) => { hd.appearance = { ...(hd.appearance || {}), tex: sel.value }; }, `tex=${sel.value}`));
    el.append(row('Texture', sel, mine?.tex != null));
    if (a.tex) {
      const sc = a.texScale ?? 1, num = h('span', { class: 'app-num' }, fmtv(sc) + '×');
      const r = h('input', { type: 'range', min: '-2', max: '2', step: '0.05', value: String(Math.log2(sc)) });
      r.addEventListener('input', () => { const v = Math.round(2 ** +r.value * 100) / 100; num.textContent = fmtv(v) + '×'; live('texScale', v); });
      r.addEventListener('change', () => done('texScale'));
      el.append(row('Texture scale', h('div', { class: 'app-sl' }, r, num), mine?.texScale != null));
    }
    el.append(h('div', { class: 'ap-info' }, 'Shaded styles show the colour; Realistic also shows reflections, gloss, opacity and the texture.'));
    el.append(h('div', { class: 'ap-btns' }, h('button', { disabled: !mine, onclick: () => change((hd) => { delete hd.appearance; }, 'clear') }, o.clearLabel)));
  }
  fill();
  // top right of the views; dragged by its title (remembered)
  const host = (doc.viewSet?.root || doc.vp.el).getBoundingClientRect(), e = opt('appPopEdgePx');
  el.style.left = Math.max(e, host.right - el.offsetWidth - e) + 'px'; el.style.top = host.top + e + 'px';
  makeDraggable(el, '.ap-head', 'monolith.appearancePos');
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeAppearance(); } };
  document.addEventListener('keydown', onKey, true);
  // another document / tab shown, or the part / component gone: close; changed elsewhere (undo / redo): show it
  let shown = JSON.stringify(o.resolve()) + JSON.stringify(own());
  const timer = setInterval(() => {
    const r = doc.viewSet?.root;
    if (!o.holder() || (r && (!r.isConnected || !r.offsetParent))) return closeAppearance();
    const now = JSON.stringify(o.resolve()) + JSON.stringify(own());
    if (now !== shown && !st.pending && !el.contains(document.activeElement)) fill();
    shown = now;
  }, opt('appPopPollMs'));
  open = { el, onKey, timer };
  log('APPEARANCE open', o.title, o.name);
  return el;
}
const fmtv = (v) => String(Math.round(v * 100) / 100);
// swatch: a little shading so metal / gloss / glass read differently (glass: checkerboard behind)
function swatchBg(x) {
  const hi = x.metalness > 0.5 ? 'rgba(255,255,255,.75)' : x.roughness < 0.4 ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.18)';
  const op = x.opacity ?? 1, n = parseInt(x.color.slice(1), 16), rgba = `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${op})`;
  const layers = [`radial-gradient(circle at 32% 28%, ${hi}, transparent 55%)`, `linear-gradient(160deg, transparent 50%, rgba(0,0,0,.35))`, `linear-gradient(${rgba}, ${rgba})`];
  if (op < 1) layers.push('repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0 / 8px 8px');
  return layers.join(', ');
}
