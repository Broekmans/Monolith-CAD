// Left panel "Selection": facts about the selected annotation (room / area, dimension, note, scale bar),
// read-only; refreshed from draw() when the item changes (drag, recalc, undo). Changing settings stays
// in the settings box (props.js).
import { h, fmt } from '../ui.js';
import { annValue, annText } from './dims.js';
import { roomInfo, isRoom } from './rooms.js';
import { styleOf } from './styles.js';
import { opt } from '../app/options.js';

const TYPE = { len: 'Length', angle: 'Angle', dia: 'Diameter', rad: 'Radius', area: 'Area', note: 'Note', scalebar: 'Scale bar' };
const MODE = { h: 'horizontal', v: 'vertical', aligned: 'aligned', auto: 'aligned' };
const AREA_U = { m2: ['m²', 1e6], cm2: ['cm²', 100], mm2: ['mm²', 1] };

export class DrawingInfo {
  // signature of what the panel shows: rebuild only when it changes
  infoSig() {
    const s = this.selAnn, a = s && this.ann(s.view, s.id);
    return a ? JSON.stringify([s.view, a, this.doc.dimUnits, this.doc.areaUnits, this.doc.dimDec]) : '';
  }
  infoPanel() {
    const el = h('div', { class: 'pc-panel sel-info' });
    this._infoEl = el; this._infoSig = null;
    this.fillInfo();
    return el;
  }
  syncInfo() { if (this._infoEl?.isConnected && this.infoSig() !== this._infoSig) this.fillInfo(); }
  fillInfo() {
    const el = this._infoEl; if (!el) return;
    this._infoSig = this.infoSig();
    el.innerHTML = '';
    const s = this.selAnn, a = s && this.ann(s.view, s.id), v = s && this.V(s.view);
    el.style.display = a ? '' : 'none';
    if (!a) return;
    const d = this.doc, dec = d.dimDec ?? 2, units = d.dimUnits || 'mm', m = units === 'm', dM = opt('drInfoDecM'), dMm = opt('drInfoDecMm'), at = opt('drRoomAxisTol');
    const L = (x) => (m ? fmt(x / 1000, Math.max(dec, dM)) + ' m' : fmt(x, dec) + ' mm');
    const row = (label, val, tip) => h('div', { class: 'pp-row ro', title: tip || '' }, h('label', {}, label), h('span', {}, val));
    const room = a.type === 'area' && isRoom(a);
    el.append(h('div', { class: 'sp-sec' }, 'Selection: ' + (room ? 'Room' : TYPE[a.type] || a.type)));
    if (a.type === 'area') {
      const ri = roomInfo(a), [au, ak] = AREA_U[d.areaUnits || 'm2'] || AREA_U.m2, st = styleOf(d, a);
      el.append(row('Name', a.label || '—'), row('Area', `${fmt(Math.abs(annValue(a)) / ak, au === 'm²' ? dM : dMm)} ${au}`), row('Perimeter', fmt(ri.per, dM) + ' m'),
        a.pts ? row('Width × length', `${fmt(ri.w, dM)} × ${fmt(ri.l, dM)} m`, 'Outer size of the outline (along X and Y of the view)') : row('Diameter', L(2 * (a.r || 0))),
        a.pts ? row('Corners', String(ri.corners)) : null);
      if (room) {
        const sl = st.highTo > st.highFrom ? `floor + ${st.lowFrom}–${st.lowTo} m and ${st.highFrom}–${st.highTo} m` : `floor + ${st.lowFrom}–${st.lowTo} m`;
        el.append(row('Detection', st.method === 'follow' ? 'Follow the walls' : 'Walls from the click'), row('Slices', sl, 'Height slices of the scan used to find the walls (top views without their own slice)'),
          row('Spaces', String(a.qs?.length || 1), 'Clicks joined into this room (Shift+click)'), row('Offset', st.offset ? L(st.offset) : '0'), row('Edited by hand', a.edited ? 'yes' : 'no'));
      }
      if (a.pts?.length) {
        const walls = a.pts.map((p, i) => { const q = a.pts[(i + 1) % a.pts.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]); });
        const det = h('details', { class: 'ap-more', style: { margin: '2px 8px' } }, h('summary', {}, `Walls (${walls.length}): ${L(Math.min(...walls))} … ${L(Math.max(...walls))}`),
          ...walls.map((w, i) => row(`Wall ${i + 1}`, L(w), Math.abs(a.pts[i][0] - a.pts[(i + 1) % a.pts.length][0]) < at ? 'vertical' : Math.abs(a.pts[i][1] - a.pts[(i + 1) % a.pts.length][1]) < at ? 'horizontal' : 'slanted')));
        el.append(det);
      }
    } else if (a.type === 'note') {
      el.append(row('Text', a.text || ''), row('Leader', a.anchor ? 'yes' : 'no'));
    } else if (a.type === 'scalebar') {
      el.append(row('Length', L(a.len)), row('Parts', String(a.n || 5)));
    } else {
      const val = annValue(a);
      el.append(row('Value', a.type === 'angle' ? fmt(val, Math.max(dec, dMm)) + '°' : L(val)),
        a.override || a.prefix || a.suffix ? row('Shown as', annText(a, dec, units, d.areaUnits)) : null,
        a.type === 'len' ? row('Direction', MODE[a.mode] || 'aligned') : null,
        a.chain != null ? row('Chain', `part ${a.chain + 1}`) : null);
      if (a.a && a.b) el.append(row('From', `X ${fmt(a.a[0], dMm)}  Y ${fmt(a.a[1], dMm)}`, 'Model coordinates of the view (mm)'), row('To', `X ${fmt(a.b[0], dMm)}  Y ${fmt(a.b[1], dMm)}`));
      el.append(row('Attached to', a.fit ? `scan wall, fitted line ± ${fmt(a.fit.sigma, dMm)} mm (${a.fit.n} points)` : 'points / edges of the view', a.fit ? 'Snapped to a straight wall fitted through the scan points; ± = scatter (1σ) of the points around the line' : ''));
    }
    el.append(row('View', v?.name || ''));
  }
}
