// Plan: layers / point clouds / properties panels
// Methods are mixed into PlanDoc (see plan.js); `this` is the PlanDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, promptText, evalNumber } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import * as G from './planGeom.js';
const { dist, add, sub, mul, lerp } = G;
import { parseDxf, planToDxf } from '../io/dxf.js';
import { circleFrom3, cross2 } from '../sketch/geom2d.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { newPlanDoc, LAYER_FOR, pointInPoly, polyArea, seqCommand, selectThen, COMMANDS, dimCommand, kindFor, openingCommand, nearestWall, xformCommand, offsetEntity, lineIntersect, trimEntity, filletLines } from './plan.js';

export class PlanPanels {
  // ======================= panels =======================
  renderPanel() {
    const root = this.app.el.tree;
    root.innerHTML = '';
    // ---- layers
    const layers = h('div', { class: 'lp' });
    layers.append(h('div', { class: 'sp-sec row' }, 'Layers', h('button', { class: 'mini', title: 'New layer', html: icon('plus'), onclick: () => this.addLayer() })));
    for (const L of this.doc.layers) {
      const cur = this.doc.current === L.name;
      const count = this.doc.entities.filter((e) => e.layer === L.name).length;
      const color = h('input', { type: 'color', value: L.color, class: 'lp-color', title: 'Layer color' });
      color.addEventListener('input', () => { L.color = color.value; this.vp.requestRender(); });
      color.addEventListener('change', () => this.app.setDirty(true));
      const row = h('div', { class: 'lp-row' + (cur ? ' cur' : ''), title: cur ? 'Current layer' : 'Double-click to make current' },
        h('button', { class: 'mini', title: L.visible ? 'Hide' : 'Show', html: icon(L.visible ? 'eye' : 'eyeOff'), onclick: () => { L.visible = !L.visible; this.renderPanel(); this.afterChange(); } }),
        h('button', { class: 'mini', title: L.locked ? 'Unlock' : 'Lock', html: icon(L.locked ? 'lock' : 'unlock'), onclick: () => { L.locked = !L.locked; this.renderPanel(); } }),
        color, h('span', { class: 'lp-name' }, L.name), h('span', { class: 'lp-count' }, String(count)));
      row.addEventListener('dblclick', () => { this.doc.current = L.name; this.renderPanel(); });
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        contextMenu(ev.clientX, ev.clientY, [
          { label: 'Set Current', run: () => { this.doc.current = L.name; this.renderPanel(); } },
          { label: 'Rename…', run: async () => { const n = await promptText('Rename layer', L.name); if (n && !this.doc.layers.some((x) => x.name === n)) this.change(() => { this.doc.entities.forEach((e) => { if (e.layer === L.name) e.layer = n; }); if (this.doc.current === L.name) this.doc.current = n; L.name = n; }); } },
          { label: 'Move Selection Here', disabled: !this.sel.size, run: () => this.change(() => { for (const id of this.sel) { const e = this.E(id); if (e) e.layer = L.name; } }) },
          { label: 'Select Objects on Layer', run: () => { this.doc.entities.filter((e) => e.layer === L.name).forEach((e) => this.sel.add(e.id)); this.renderPanel(); this.vp.requestRender(); } },
          '-', { label: 'Delete Layer', disabled: L.name === '0' || count > 0, run: () => this.change(() => { this.doc.layers = this.doc.layers.filter((x) => x !== L); if (this.doc.current === L.name) this.doc.current = '0'; }) },
        ]);
      });
      layers.appendChild(row);
    }
    root.appendChild(layers);
    // ---- point clouds
    if (this.doc.pointClouds?.length) {
      const pcs = h('div', { class: 'lp' }, h('div', { class: 'sp-sec row' }, 'Point Clouds', h('button', { class: 'mini', title: 'Import point cloud', html: icon('plus'), onclick: () => this.app.importPointCloud() })));
      for (const rec of this.doc.pointClouds) {
        const v = this.clouds?.views.get(rec.id);
        const r = h('div', { class: 'lp-row' + (this.selCloud === rec.id ? ' cur' : ''), title: rec.path },
          h('button', { class: 'mini', title: rec.visible === false ? 'Show' : 'Hide', html: icon(rec.visible === false ? 'eyeOff' : 'eye'), onclick: (e) => { e.stopPropagation(); rec.visible = rec.visible === false; v?.refresh(); this.app.setDirty(true); this.renderPanel(); this.vp.requestRender(); this.vp3.requestRender(); } }),
          h('span', { class: 'ico sm', html: icon('cloud') }), h('span', { class: 'lp-name' }, rec.name), h('span', { class: 'lp-count' }, v ? (v.data.kept / 1e6).toFixed(1) + 'M' : 'missing'));
        r.addEventListener('click', () => { this.selCloud = rec.id; this.sel.clear(); this.renderPanel(); this.vp.requestRender(); });
        pcs.appendChild(r);
      }
      root.appendChild(pcs);
    }
    // ---- properties
    if (this.selCloud && !this.sel.size) {
      const rec = this.doc.pointClouds?.find((r) => r.id === this.selCloud);
      if (rec) {
        root.appendChild(h('div', { class: 'pp' }, h('div', { class: 'sp-sec' }, 'Point Cloud Properties'), cloudPanel(rec, this.clouds.views.get(rec.id), {
          onChange: () => { this.app.setDirty(true); this.vp.requestRender(); this.vp3.requestRender(); },
          onRemove: () => this.removePointCloud(rec.id),
          onZoom: () => { const v = this.clouds.views.get(rec.id); if (v) { this.vp.fit({ min: [v.box.min.x, 0, v.box.min.z], max: [v.box.max.x, 0, v.box.max.z] }); this.vp3.fit(v.box); } },
          onReload: async () => { await this.clouds.load(rec); this.renderPanel(); },
        })));
        return;
      }
    }
    const props = h('div', { class: 'pp' });
    const sel = [...this.sel].map((id) => this.E(id)).filter(Boolean);
    props.appendChild(h('div', { class: 'sp-sec' }, sel.length ? `Properties  (${sel.length} selected)` : 'Properties'));
    if (!sel.length) {
      props.appendChild(this.settingsPanel());
    } else {
      props.appendChild(this.propsPanel(sel));
    }
    root.appendChild(props);
  }

  field(label, value, onSet, { type = 'number', options = null, step } = {}) {
    let inp;
    if (options) {
      inp = h('select', {}, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
      inp.addEventListener('change', () => onSet(inp.value));
    } else if (type === 'check') {
      inp = h('input', { type: 'checkbox', checked: !!value });
      inp.addEventListener('change', () => onSet(inp.checked));
    } else {
      inp = h('input', { type: 'text', value: value === '*varies*' ? '' : type === 'number' ? fmt(value, 4) : value, placeholder: value === '*varies*' ? '*varies*' : '' });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => { if (type === 'number') { const v = evalNumber(inp.value); if (v !== null) onSet(v); } else onSet(inp.value); });
    }
    void step;
    return h('div', { class: 'pp-row' }, h('label', {}, label), inp);
  }

  settingsPanel() {
    const s = this.S;
    const set = (k) => (v) => { s[k] = v; this.app.setDirty(true); };
    return h('div', {},
      h('div', { class: 'sp-hint' }, 'Nothing selected. Drawing defaults:'),
      this.field('Current layer', this.doc.current, (v) => { this.doc.current = v; }, { options: this.doc.layers.map((l) => ({ value: l.name, label: l.name })) }),
      this.field('Grid spacing', s.gridSize, set('gridSize')),
      this.field('Wall thickness', s.wallT, set('wallT')), this.field('Wall height', s.wallH, set('wallH')),
      this.field('Wall justification', s.wallJ, set('wallJ'), { options: [{ value: 'center', label: 'Center' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] }),
      this.field('Door width', s.doorW, set('doorW')), this.field('Door height', s.doorH, set('doorH')),
      this.field('Window width', s.winW, set('winW')), this.field('Window height', s.winH, set('winH')), this.field('Sill height', s.winSill, set('winSill')),
      this.field('Slab thickness', s.slabT, set('slabT')), this.field('Text height', s.textH, set('textH')), this.field('Dim text height', s.dimTextH, set('dimTextH')));
  }

  propsPanel(sel) {
    const wrap = h('div', {});
    const types = [...new Set(sel.map((e) => e.type))];
    const common = (k) => { const v = sel.map((e) => e[k]); return v.every((x) => JSON.stringify(x) === JSON.stringify(v[0])) ? v[0] : '*varies*'; };
    const setAll = (fn) => this.change(() => { for (const e of sel) { const live = this.E(e.id); if (live && this.editable(live)) fn(live); } });
    wrap.append(h('div', { class: 'pp-type' }, types.length === 1 ? types[0][0].toUpperCase() + types[0].slice(1) + (sel.length > 1 ? ` (${sel.length})` : '') : `All (${sel.length})`));
    wrap.append(this.field('Layer', common('layer'), (v) => setAll((e) => { e.layer = v; }), { options: [...(common('layer') === '*varies*' ? [{ value: '*varies*', label: '*varies*' }] : []), ...this.doc.layers.map((l) => ({ value: l.name, label: l.name }))] }));
    const colorIn = h('input', { type: 'color', value: common('color') && common('color') !== '*varies*' ? common('color') : this.layer(sel[0].layer).color });
    colorIn.addEventListener('change', () => setAll((e) => { e.color = colorIn.value; }));
    wrap.append(h('div', { class: 'pp-row' }, h('label', {}, 'Color'), h('div', { class: 'pp-inline' }, colorIn, h('button', { class: 'mini txt', onclick: () => setAll((e) => { delete e.color; }) }, 'ByLayer'))));
    if (sel.length === 1) {
      const e = sel[0];
      const num = (label, get, set) => wrap.append(this.field(label, get(), (v) => setAll((x) => set(x, v))));
      const pt = (label, k) => { num(label + ' X', () => e[k][0], (x, v) => { x[k] = [v, x[k][1]]; }); num(label + ' Y', () => e[k][1], (x, v) => { x[k] = [x[k][0], v]; }); };
      switch (e.type) {
        case 'line': pt('Start', 'a'); pt('End', 'b'); wrap.append(this.ro('Length', fmt(dist(e.a, e.b), 3)), this.ro('Angle', fmt((Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI, 3) + '°')); break;
        case 'circle': pt('Center', 'c'); num('Radius', () => e.r, (x, v) => { x.r = v; }); wrap.append(this.ro('Area', fmt(Math.PI * e.r * e.r, 2))); break;
        case 'arc': pt('Center', 'c'); num('Radius', () => e.r, (x, v) => { x.r = v; }); num('Start angle', () => (e.a0 * 180) / Math.PI, (x, v) => { x.a0 = (v * Math.PI) / 180; }); num('End angle', () => (e.a1 * 180) / Math.PI, (x, v) => { x.a1 = (v * Math.PI) / 180; }); break;
        case 'polyline': {
          wrap.append(this.field('Closed', e.closed, (v) => setAll((x) => { x.closed = v; }), { type: 'check' }));
          let L = 0; for (let i = 1; i < e.pts.length; i++) L += dist(e.pts[i - 1], e.pts[i]); if (e.closed) L += dist(e.pts[e.pts.length - 1], e.pts[0]);
          wrap.append(this.ro('Vertices', String(e.pts.length)), this.ro('Length', fmt(L, 2)));
          if (e.closed) {
            wrap.append(this.ro('Area', fmt(Math.abs(polyArea(e.pts)), 2)));
            wrap.append(this.field('Slab (3D)', !!e.slab, (v) => setAll((x) => { if (v) x.slab = x.slab || this.S.slabT; else delete x.slab; }), { type: 'check' }));
            if (e.slab) { num('Slab thickness', () => e.slab, (x, v) => { x.slab = v; }); num('Top elevation', () => e.elev ?? 0, (x, v) => { x.elev = v; }); }
          }
          break;
        }
        case 'text': wrap.append(this.field('Contents', e.text, (v) => setAll((x) => { x.text = v; }), { type: 'text' })); num('Height', () => e.h, (x, v) => { x.h = v; }); num('Rotation', () => ((e.rot || 0) * 180) / Math.PI, (x, v) => { x.rot = (v * Math.PI) / 180; }); pt('Position', 'p'); break;
        case 'dim': wrap.append(this.ro('Measurement', fmt(G.dimGeom(e).value, 3))); wrap.append(this.field('Type', e.kind, (v) => setAll((x) => { x.kind = v; }), { options: [{ value: 'aligned', label: 'Aligned' }, { value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }] })); break;
        case 'wall':
          pt('Start', 'a'); pt('End', 'b');
          wrap.append(this.ro('Length', fmt(dist(e.a, e.b), 2)));
          num('Thickness', () => e.t, (x, v) => { x.t = v; }); num('Height', () => e.h, (x, v) => { x.h = v; }); num('Base elevation', () => e.base ?? 0, (x, v) => { x.base = v; });
          wrap.append(this.field('Justification', e.justify || 'center', (v) => setAll((x) => { x.justify = v; }), { options: [{ value: 'center', label: 'Center' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }] }));
          break;
        case 'door': case 'window':
          num('Width', () => e.w, (x, v) => { x.w = v; }); num('Height', () => e.h, (x, v) => { x.h = v; }); num('Offset along wall', () => e.pos, (x, v) => { x.pos = v; });
          if (e.type === 'window') num('Sill height', () => e.sill, (x, v) => { x.sill = v; });
          else wrap.append(h('div', { class: 'pp-row' }, h('label', {}, 'Swing'), h('div', { class: 'pp-inline' },
            h('button', { class: 'mini txt', onclick: () => setAll((x) => { x.side = -(x.side ?? 1); }) }, 'Flip side'),
            h('button', { class: 'mini txt', onclick: () => setAll((x) => { x.hinge = -(x.hinge ?? 1); }) }, 'Flip hinge'))));
          break;
        default:
      }
    } else if (types.length === 1 && types[0] === 'wall') {
      wrap.append(this.field('Thickness', common('t'), (v) => setAll((x) => { x.t = v; })), this.field('Height', common('h'), (v) => setAll((x) => { x.h = v; })));
    }
    wrap.append(h('button', { class: 'sp-btn danger', onclick: () => this.eraseSelection() }, h('span', { class: 'ico sm', html: icon('delete') }), 'Erase (Del)'));
    return wrap;
  }
  ro(label, value) { return h('div', { class: 'pp-row ro' }, h('label', {}, label), h('span', {}, value)); }

  async addLayer() {
    const n = await promptText('New layer name', `Layer${this.doc.layers.length}`);
    if (!n) return;
    if (this.doc.layers.some((l) => l.name === n)) { toast('A layer with that name already exists'); return; }
    this.change(() => { this.doc.layers.push({ name: n, color: '#000000', visible: true, locked: false }); this.doc.current = n; });
  }

}
