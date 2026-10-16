// Selection popup: click an annotation (dimension, note, room / area, scale bar) -> a small settings box next
// to it. Closes when the selection goes (click on empty paper, Esc, Delete, undo) or a tool starts; clicking
// another annotation switches it. Every change is one undo step. Also the Drafting Standard dialog
// (drawing defaults + company standard file, import / export).
import { h, fmt, toast } from '../ui.js';
import { api } from '../api.js';
import { annValue } from './dims.js';
import { fitData, roomAt } from './fit.js';
import { unionOrtho, joinRooms, JOIN_MSG } from './outline.js';
import { ROOM_KEYS, STD_DEF, TEXT_H, LINE_W, ARROWS, DASH_NAMES, KEYS, styleOf, roomOpts, clean, companyStd, setCompanyStd } from './styles.js';

const log = (...a) => { try { window.__lithLog?.(...a); } catch {} };
const TYPE_NAME = { len: 'Dimension', rad: 'Radius', dia: 'Diameter', ang: 'Angle', area: 'Area', note: 'Note', scalebar: 'Scale Bar' };

export class DrawingProps {
  // called after every repaint: open / switch / close / reposition the popup
  syncProps() {
    const s = this.selAnn, a = s && !this.tool && this.ann(s.view, s.id);
    if (!a) { this.closeProps(); return; }
    const key = s.view + '|' + s.id;
    if (this._propsKey !== key || !this._props?.isConnected) { this.closeProps(); this.openProps(this.V(s.view), a); this._propsKey = key; }
    this.placeProps();
  }
  closeProps() { this._props?.remove(); this._props = null; this._propsKey = null; }
  placeProps() {
    const el = this._props; if (!el) return;
    const s = this.selAnn, boxes = (this._annBoxes || []).filter((q) => q.ann === s.id && q.t === 'annbox');
    const host = this.vp.el.getBoundingClientRect();
    let x = host.width - el.offsetWidth - 12, y = 12;
    const saved = propsPos();
    if (saved) { x = saved[0]; y = saved[1]; }
    else if (boxes.length) {
      const b = boxes[0].box, p1 = this.S2([b[2], b[3]]), p0 = this.S2([b[0], b[1]]);
      x = p1[0] + 16; y = p1[1] - 8;
      if (x + el.offsetWidth > host.width - 8) x = p0[0] - el.offsetWidth - 16;
    }
    if (saved) { x = Math.max(0, Math.min(host.width - el.offsetWidth, x)); y = Math.max(0, Math.min(host.height - 30, y)); } else { x = Math.max(8, Math.min(host.width - el.offsetWidth - 8, x)); y = Math.max(8, Math.min(host.height - el.offsetHeight - 8, y)); }
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  // one change of an annotation, logged (action log) so test values can be read back later
  annSet(a, fn, what) { this.change(fn); log('ANNSET', a.type, a.id, what); }
  openProps(v, a) {
    const st = styleOf(this.doc, a), own = a.style || {};
    const el = (this._props = h('div', { class: 'ann-props' }));
    // stop keys and mouse from reaching the drawing (Delete in a field must not delete the annotation)
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick']) el.addEventListener(ev, (e) => e.stopPropagation());
    const sec = (t) => h('div', { class: 'ap-sec' }, t);
    const row = (label, input, mark) => h('div', { class: 'ap-row' + (mark ? ' own' : '') }, h('label', { title: mark ? 'Set on this item (differs from the drawing default)' : '' }, label), input);
    const setStyle = (k, val) => { this.annSet(a, () => { (a.style ||= {})[k] = val; }, `${k}=${val}`); if (ROOM_KEYS.includes(k) && a.type === 'area') this.recomputeRoom(v, a); };
    const select = (k, opts) => { const s = h('select', {}, ...opts.map(([val, lab]) => h('option', { value: String(val), selected: String(st[k]) === String(val) }, lab))); s.addEventListener('change', () => setStyle(k, typeof STD_DEF[k] === 'number' ? Number(s.value) : s.value)); return row(labelOf(k), s, k in own); };
    const num = (k, unit, step = 1, neg = false) => { const i = h('input', { type: 'number', value: String(st[k]), step: String(step), ...(neg ? {} : { min: '0' }) }); i.addEventListener('change', () => { const n = parseFloat(String(i.value).replace(',', '.')); if (isFinite(n) && (neg || n >= 0)) setStyle(k, n); }); return row(labelOf(k) + (unit ? ` (${unit})` : ''), i, k in own); };
    // line weight: type any value (mm, down to 0.01) or pick a standard one from the list
    const weight = (k) => {
      const id = 'lw-list', i = h('input', { type: 'number', value: String(st[k]), step: '0.01', min: '0.01', list: id });
      if (!document.getElementById(id)) document.body.appendChild(h('datalist', { id }, ...LINE_W.map((x) => h('option', { value: String(x) }))));
      i.addEventListener('change', () => { const n = parseFloat(String(i.value).replace(',', '.')); if (isFinite(n) && n > 0) setStyle(k, Math.max(0.01, Math.round(n * 1000) / 1000)); });
      return row(labelOf(k) + ' (mm)', i, k in own);
    };
    const color = (k) => { const i = h('input', { type: 'color', value: st[k] || '#000000' }); i.addEventListener('change', () => setStyle(k, i.value)); return row(labelOf(k), i, k in own); };
    const text = (label, key, ph = '') => { const i = h('input', { type: 'text', value: a[key] || '', placeholder: ph }); i.addEventListener('change', () => this.annSet(a, () => { if (i.value) a[key] = i.value; else delete a[key]; }, `${key}=${i.value}`)); return row(label, i); };
    const t = a.type, room = t === 'area' && !!a.pts && (a.room || /^Room /.test(a.label || ''));
    const head = h('div', { class: 'ap-head' }, h('b', {}, room ? 'Room' : TYPE_NAME[t] || t), h('span', { class: 'ap-val' }, valueLine(this.doc, a)), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: () => { this.selAnn = null; this.renderTree(); this.app.cm.refresh(); this.vp.requestRender(); } }, '×'));
    el.append(head);
    // drag the box by its title; the spot is remembered for every next box (also after a restart)
    head.style.cursor = 'move';
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, l0 = el.offsetLeft, t0 = el.offsetTop;
      const mv = (ev) => { const host = this.vp.el.getBoundingClientRect(); const x = Math.max(0, Math.min(host.width - el.offsetWidth, l0 + ev.clientX - x0)), y = Math.max(0, Math.min(host.height - 30, t0 + ev.clientY - y0)); el.style.left = x + 'px'; el.style.top = y + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setPropsPos([el.offsetLeft, el.offsetTop]); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    let box = el; const add = (...x) => box.append(...x);
    // rooms: detection settings first, then the outline look, the rest folded away
    if (room) {
      if (v.geom?.fit) {
        const rect = st.method !== 'follow';
        const m = h('select', {}, h('option', { value: 'rect', selected: rect }, 'Walls from the click (rectangle)'), h('option', { value: 'follow', selected: !rect }, 'Follow the walls (any shape)'));
        m.addEventListener('change', () => { setStyle('method', m.value); this.closeProps(); this.vp.requestRender(); });
        add(sec('Room detection'), row('Method', m, 'method' in own));
        if (rect) add(num('tol', 'mm', 10), num('cover', '%', 5), num('look', 'mm', 50), num('face', '%', 5), num('furniture', 'mm', 250), num('maxSize', 'm', 1));
        else add(num('tol', 'mm', 10), num('minWall', 'mm', 50), num('jog', 'mm', 25), num('angle', '°', 1), num('close', 'mm', 100));
        add(num('offset', 'mm', 10, true), num('join', 'mm', 50));
        const sl = (k1, k2, label) => { const mk = (k) => { const i = h('input', { type: 'number', step: '0.1', value: String(st[k]) }); i.addEventListener('change', () => { const n = parseFloat(String(i.value).replace(',', '.')); if (isFinite(n) && n >= 0) setStyle(k, n); }); return i; }; return row(label, h('div', { class: 'ap-two' }, mk(k1), mk(k2)), k1 in own || k2 in own); };
        add(sl('lowFrom', 'lowTo', 'Low slice, floor + m'), sl('highFrom', 'highTo', 'High slice, floor + m (0–0 = off)'));
        add(h('p', { class: 'ap-info' }, rect
          ? 'From the click the program looks left, right, up and down for the first straight wall: a band of ± "wall straightness" whose points cover at least "wall coverage" of the room length (furniture is short and is skipped). Within "look past furniture" behind it the densest band wins. Walls are searched in two height slices together: a band that only shows in the low slice (desks, low cabinets) is skipped when a full-height wall follows within "skip furniture up to". The wall line is put on the room side of the scan scatter, where the point density reaches "wall face" % of the wall (0 = middle of the scatter). Shift+click with Room Outline adds another space to this room; a space just behind a wall (up to "join across walls") is joined through the doorway in that wall. Offset moves the outline out (+) or in (−).'
          : 'The room is grown from the click and its outline follows the walls. Wall straightness: how far a wall may wander and still be one wall; shorter walls than the min. length are left out; parallel pieces closer than the max. step become one wall; walls within the angle are made square; openings narrower than "close openings" are closed.'));
      }
      if (a.edited) add(h('div', { class: 'ap-btns' }, h('span', { class: 'ap-info', style: 'margin:0;flex:1' }, 'Edited by hand'), h('button', { class: 'mini txt', onclick: () => this.resetOutline(v, a) }, 'Back to detected')));
      add(sec('Room outline'), weight('outlineW'), color('outlineColor'), select('outlineDash', DASH_NAMES), color('fillColor'), num('fillOpacity', '%', 5));
      add(h('div', { class: 'ap-btns' }, h('button', { class: 'mini txt', title: 'Room line style and detection values of this room become the default for new rooms in this drawing and in new drawings (drafting-standard.json)', onclick: () => this.saveMyStandard(a) }, 'Save as my standard')));
      const det = h('details', { class: 'ap-more' }, h('summary', {}, 'Text & label'));
      el.append(det); box = det;
    }
    // ---- text ----
    add(sec('Text'));
    if (t === 'note') { const ta = h('textarea', { rows: 2 }, a.text || ''); ta.addEventListener('change', () => this.annSet(a, () => { a.text = ta.value; }, 'text')); add(row('Text', ta)); }
    else if (t === 'area') add(text('Name', 'label', room ? 'Room 1' : ''));
    if (t !== 'note' && t !== 'scalebar') add(text('Prefix', 'prefix', 'e.g. 2×'), text('Value override', 'override', 'measured value'), text('Suffix', 'suffix', 'e.g. TYP'));
    add(select('textH', TEXT_H.map((x) => [x, x + ' mm'])), color('textColor'));
    // ---- lines ----
    add(sec(t === 'area' ? 'Leader line' : 'Lines'));
    add(weight('lineW'), color('lineColor'));
    if (t !== 'area' && t !== 'scalebar') add(select('arrow', ARROWS), num('arrowSize', 'mm', 0.5));
    if (t === 'len' || t === 'ang') add(num('extGap', 'mm', 0.5), num('extOver', 'mm', 0.5));
    if (t === 'area' && a.pts && !room) add(sec('Outline'), weight('outlineW'), color('outlineColor'), select('outlineDash', DASH_NAMES), color('fillColor'), num('fillOpacity', '%', 5));
    // ---- position ----
    add(sec('Position'));
    const P = this.toSheetPt(v, a.at), posIn = (i) => { const n = h('input', { type: 'number', step: '0.5', value: fmt(P[i], 1) }); n.addEventListener('change', () => { const x = parseFloat(String(n.value).replace(',', '.')); if (!isFinite(x)) return; const q = this.toSheetPt(v, a.at); q[i] = x; this.annSet(a, () => { a.at = this.toModel(v, q); }, `at${'xy'[i]}=${x}`); }); return n; };
    add(row('Text X / Y (sheet mm)', h('div', { class: 'ap-two' }, posIn(0), posIn(1))));
    if (t === 'len') {
      const geo = () => { const A = this.toSheetPt(v, a.a), B = this.toSheetPt(v, a.b), Q = this.toSheetPt(v, a.at); const u = a.mode === 'h' ? [1, 0] : a.mode === 'v' ? [0, 1] : unit([B[0] - A[0], B[1] - A[1]]); const n = [-u[1], u[0]]; return { Q, n, off: (Q[0] - A[0]) * n[0] + (Q[1] - A[1]) * n[1] }; };
      const i = h('input', { type: 'number', step: '1', value: fmt(geo().off, 1) });
      i.addEventListener('change', () => { const x = parseFloat(String(i.value).replace(',', '.')); if (!isFinite(x)) return; const g = geo(), d = x - g.off; this.annSet(a, () => { a.at = this.toModel(v, [g.Q[0] + g.n[0] * d, g.Q[1] + g.n[1] * d]); }, `offset=${x}`); });
      const m = h('select', {}, ...[['aligned', 'Aligned'], ['h', 'Horizontal'], ['v', 'Vertical']].map(([val, lab]) => h('option', { value: val, selected: a.mode === val }, lab)));
      m.addEventListener('change', () => this.annSet(a, () => { a.mode = m.value; }, `mode=${m.value}`));
      add(row('Dimension line offset (mm)', i), row('Direction', m));
    }
    if (t === 'scalebar') { const i = h('input', { type: 'number', step: '0.5', value: String(a.len / 1000) }); i.addEventListener('change', () => { const x = parseFloat(String(i.value).replace(',', '.')); if (x > 0) this.annSet(a, () => { a.len = x * 1000; }, `len=${x}`); }); add(row('Length (m)', i)); }
    // ---- buttons ----
    const btn = (label, tip, fn) => h('button', { class: 'mini txt', title: tip, onclick: fn }, label);
    add(h('div', { class: 'ap-btns' },
      btn('Set as default', 'Use this item\'s look for new annotations in this drawing (Drafting Standard)', () => { const s = { ...(a.style || {}) }; if (!Object.keys(s).length) { toast('Nothing changed on this item yet'); return; } this.change(() => { this.doc.style = { ...(this.doc.style || {}), ...s }; }); log('STYLE drawing default', JSON.stringify(s)); toast('Drawing default updated'); }),
      btn('Reset', 'Back to the drawing default', () => this.annSet(a, () => { delete a.style; }, 'reset'))));
    this.vp.el.appendChild(el);
  }
  // room look + detection values -> drawing default + company standard file (used for every new room)
  async saveMyStandard(a) {
    const st = styleOf(this.doc, a), keep = Object.fromEntries(['outlineW', 'outlineColor', 'outlineDash', 'fillColor', 'fillOpacity', ...ROOM_KEYS].map((k) => [k, st[k]]));
    this.change(() => { this.doc.style = { ...(this.doc.style || {}), ...keep }; });
    const all = clean({ ...companyStd(), ...keep }), r = await api.draftStd(all);
    if (r?.__error) { toast('Saved in this drawing; could not write the standard file: ' + r.__error, 'error', 6000); return; }
    setCompanyStd(all); log('STYLE my standard', r?.__path, JSON.stringify(keep));
    toast('Saved as your standard: new rooms and new drawings use these values', 'info', 5000);
  }
  // recalculate a room outline after a straightening change
  async recomputeRoom(v, a, force = false) {
    try {
      if (!force && !(await this.confirmOverwrite(a))) return;
      const st = styleOf(this.doc, a), qs = a.qs?.length > 1 ? a.qs : [a.q || a.at];
      let poly = null;
      for (const q of qs) { const r = await this.roomCompute(v, q, st, a.label); if (!r.poly) { poly = null; break; } if (!poly) { poly = r.poly; continue; } const J = joinRooms(poly, r.poly, r.d, st.join); poly = J.poly; if (!poly) { toast('The spaces of this room can no longer be joined with these values: ' + (JOIN_MSG[J.reason] || ''), 'info', 7000); return; } }
      if (!poly) { toast(st.method === 'rect' ? 'No wall found in one of the 4 directions with these values (try a lower wall coverage or the high slice)' : 'No closed room with these values (it leaks: try a bigger "close openings")', 'info', 6000); return; }
      a.pts = poly; this.app.setDirty(true); this.vp.requestRender();
      log('ROOM recalc', v.name, a.label || '', 'area', (annValue(a) / 1e6).toFixed(3), 'n', poly.length, JSON.stringify(roomOpts(st)));
    } catch (e) { console.error('room recalc', e); toast('Could not recalculate the room: ' + e.message, 'error', 5000); }
  }
  // ======================= Drafting Standard =======================
  cmdDraftStd() {
    const d = this.doc, st = styleOf(d, null);
    const opt = (arr, fmtL = (x) => x) => arr.map((x) => (Array.isArray(x) ? { value: String(x[0]), label: x[1] } : { value: String(x), label: fmtL(x) }));
    const mm = (x) => x + ' mm';
    this.app.pm.show({
      title: 'Drafting Standard', iconName: 'gear',
      values: { dec: d.dimDec ?? 2, units: d.dimUnits || 'mm', area: d.areaUnits || 'm2', snap: d.snapMode || 'first', ...Object.fromEntries(KEYS.map((k) => [k, String(st[k])])) },
      fields: [
        { type: 'info', text: 'Defaults of this drawing. Click an annotation to change only that one.' },
        { type: 'group', label: 'Units', fields: [
          { key: 'units', type: 'select', label: 'Units', options: [{ value: 'mm', label: 'mm' }, { value: 'm', label: 'm (buildings, scans)' }] },
          { key: 'area', type: 'select', label: 'Area units', options: [{ value: 'm2', label: 'm²' }, { value: 'cm2', label: 'cm²' }, { value: 'mm2', label: 'mm²' }] },
          { key: 'dec', type: 'number', label: 'Decimals (trailing zeros left out)', min: 0, step: 1 },
          { key: 'snap', type: 'select', label: 'Snapping on point clouds', options: [{ value: 'first', label: 'Horizontal/vertical walls first' }, { value: 'axis', label: 'Only horizontal/vertical walls' }, { value: 'any', label: 'Any direction' }] },
        ] },
        { type: 'group', label: 'Text', fields: [
          { key: 'textH', type: 'select', label: 'Text height', options: opt(TEXT_H, mm) },
          { key: 'textColor', type: 'color', label: 'Text colour' },
        ] },
        { type: 'group', label: 'Dimension lines', fields: [
          { key: 'lineW', type: 'number', label: 'Dimension line weight (mm)', min: 0.01, step: 0.05 },
          { key: 'lineColor', type: 'color', label: 'Line colour' },
          { key: 'arrow', type: 'select', label: 'Arrow', options: opt(ARROWS) },
          { key: 'arrowSize', type: 'number', label: 'Arrow size (mm)', min: 0, step: 0.5 },
          { key: 'extGap', type: 'number', label: 'Extension line gap (mm)', min: 0, step: 0.5 },
          { key: 'extOver', type: 'number', label: 'Extension line overshoot (mm)', min: 0, step: 0.5 },
        ] },
        { type: 'group', label: 'Room / area outline', fields: [
          { key: 'outlineW', type: 'number', label: 'Room / area outline weight (mm)', min: 0.01, step: 0.05 },
          { key: 'outlineColor', type: 'color', label: 'Outline colour' },
          { key: 'outlineDash', type: 'select', label: 'Outline line type', options: opt(DASH_NAMES) },
          { key: 'fillColor', type: 'color', label: 'Infill colour' },
          { key: 'fillOpacity', type: 'number', label: 'Infill opacity (%, 0 = none)', min: 0, step: 5 },
        ] },
        { type: 'group', label: 'Room detection (scans)', fields: [
          { key: 'method', type: 'select', label: 'Room: method', options: [{ value: 'rect', label: 'Walls from the click (rectangle)' }, { value: 'follow', label: 'Follow the walls (any shape)' }] },
          { key: 'cover', type: 'number', label: 'Room: wall coverage (%)', min: 0, step: 5 },
          { key: 'face', type: 'number', label: 'Room: wall face at (% of the wall density; 0 = middle of the scatter)', min: 0, step: 5 },
          { key: 'furniture', type: 'number', label: 'Room: skip furniture up to (mm, low slice only)', min: 0, step: 250 },
          { key: 'look', type: 'number', label: 'Room: look past furniture (mm)', min: 0, step: 50 },
          { key: 'maxSize', type: 'number', label: 'Room: max. room size (m)', min: 1, step: 1 },
          { key: 'lowFrom', type: 'number', label: 'Room: low slice from (floor + m)', min: 0, step: 0.1 },
          { key: 'lowTo', type: 'number', label: 'Room: low slice to (m)', min: 0, step: 0.1 },
          { key: 'highFrom', type: 'number', label: 'Room: high slice from (m)', min: 0, step: 0.1 },
          { key: 'highTo', type: 'number', label: 'Room: high slice to (m, 0 = off)', min: 0, step: 0.1 },
          { key: 'tol', type: 'number', label: 'Room: wall straightness (mm)', min: 0, step: 10 },
          { key: 'close', type: 'number', label: 'Room: close openings up to (mm)', min: 0, step: 100 },
          { key: 'offset', type: 'number', label: 'Room: offset, + out / − in (mm)', step: 10 },
          { key: 'join', type: 'number', label: 'Room: join across walls up to (mm, Shift+click)', min: 0, step: 50 },
          { key: 'minWall', type: 'number', label: 'Room: min. wall length (mm)', min: 0, step: 50 },
          { key: 'jog', type: 'number', label: 'Room: max. step in a wall (mm)', min: 0, step: 25 },
          { key: 'angle', type: 'number', label: 'Room: square within (°)', min: 0, step: 1 },
        ] },
        { type: 'buttons', buttons: [
          { label: 'Save as company standard', run: (pm) => this.saveCompanyStd(pm.values) },
          { label: 'Load company standard', run: () => this.loadCompanyStd() },
          { label: 'Import…', run: () => this.importStd() },
          { label: 'Export…', run: (pm) => this.exportStd(pm.values) }] },
      ],
      onOk: (v) => {
        this.change(() => {
          d.dimDec = Math.max(0, Math.min(4, Math.round(v.dec))); d.dimUnits = v.units === 'm' ? 'm' : 'mm'; d.areaUnits = ['m2', 'cm2', 'mm2'].includes(v.area) ? v.area : 'm2'; d.snapMode = ['first', 'axis', 'any'].includes(v.snap) ? v.snap : 'first'; this._lastFit = null;
          d.style = styleValues(v);
        });
        log('STYLE drawing', JSON.stringify(d.style));
        return true;
      },
    });
  }
  async saveCompanyStd(vals) {
    const s = styleValues(vals || styleOf(this.doc, null)), r = await api.draftStd(s);
    if (r?.__error) { toast('Could not save: ' + r.__error, 'error'); return; }
    setCompanyStd(s); log('STYLE company saved', r?.__path, JSON.stringify(s)); toast('Company standard saved: ' + (r?.__path || ''), 'info', 5000);
  }
  async loadCompanyStd() {
    const r = await api.draftStd(); const s = clean(r || {});
    if (!Object.keys(s).length) { toast('No company standard saved yet'); return; }
    setCompanyStd(s); this.app.pm.cancel?.(); this.change(() => { this.doc.style = { ...s }; }); log('STYLE company loaded', JSON.stringify(s)); toast('Company standard applied to this drawing');
  }
  async importStd() {
    const f = await api.openFile({ filters: [{ name: 'Drafting standard', extensions: ['json'] }] }); if (!f) return;
    let s; try { s = clean(JSON.parse(f.text)); } catch { toast('Not a drafting standard file', 'error'); return; }
    if (!Object.keys(s).length) { toast('No drafting standard values in this file', 'error'); return; }
    this.app.pm.cancel?.(); this.change(() => { this.doc.style = { ...(this.doc.style || {}), ...s }; }); log('STYLE imported', f.path, JSON.stringify(s));
    toast('Imported into this drawing. Use "Save as company standard" to make it the default for new drawings.', 'info', 6000);
  }
  async exportStd(vals) {
    const s = styleValues(vals || styleOf(this.doc, null));
    const p = await api.saveFile({ defaultPath: 'drafting-standard.json', filters: [{ name: 'Drafting standard', extensions: ['json'] }], text: JSON.stringify(s, null, 2) });
    if (p) toast('Exported: ' + p);
  }
}
const POS_KEY = 'monolith.propsPos';
function propsPos() { try { const v = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); return Array.isArray(v) && v.length === 2 && v.every(isFinite) ? v : null; } catch { return null; } }
function setPropsPos(p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p.map(Math.round))); } catch {} }
const LABELS = { textH: 'Text height', textColor: 'Text colour', lineW: 'Line weight', lineColor: 'Line colour', arrow: 'Arrow', arrowSize: 'Arrow size', extGap: 'Extension gap', extOver: 'Extension overshoot', outlineW: 'Line weight', outlineColor: 'Colour', outlineDash: 'Line type', fillColor: 'Infill colour', fillOpacity: 'Infill opacity', tol: 'Wall straightness', cover: 'Wall coverage', look: 'Look past furniture', maxSize: 'Max. room size', face: 'Wall face at', furniture: 'Skip furniture up to', minWall: 'Min. wall length', jog: 'Max. step in a wall', angle: 'Square within', close: 'Close openings up to', offset: 'Offset (+ out / − in)', join: 'Join across walls up to' };
const labelOf = (k) => LABELS[k] || k;
const unit = (d) => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
function styleValues(v) { const o = {}; for (const k of KEYS) if (v[k] != null && v[k] !== '') o[k] = typeof STD_DEF[k] === 'number' ? Number(v[k]) : String(v[k]); return clean(o); }
function valueLine(doc, a) {
  const v = annValue(a);
  if (a.type === 'area') return fmt(v / 1e6, 2) + ' m²' + (a.pts ? `, ${a.pts.length} corners` : '');
  if (a.type === 'ang') return fmt(v, 2) + '°';
  if (a.type === 'note') return '';
  return fmt(v, 2) + ' mm' + (a.fit ? `  ±${fmt(a.fit.sigma, 1)}` : '');
}
