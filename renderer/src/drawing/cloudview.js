// Point cloud views in drawings (mixin of DrawingDoc). A view's source can be a .lithpcd document (all
// its visible clouds with their Register transforms) or a loose scan file. The dots are computed in the
// main process (IPC cloud:drawView, main/clouddraw.cjs) and stored in the view (geom.dots), so the drawing
// opens without the scans. View options in v.cloud: {color: black|grey|rgb, size (paper mm), density:
// fine|normal|light, clip: {on, ref: back|front|floor, from, to (m)}}. Colour and size are display only;
// density and depth range need a recompute (done automatically).
import { h, fmt, toast } from '../ui.js';
import { api } from '../api.js';
import { opt } from '../app/options.js';
import { PC_EXTS } from '../pointcloud.js';
import { scaleVal } from './sheet.js';
import { upgradeDoc } from '../../../shared/format.mjs';

export const CLOUD_EXTS = ['lithpcd', ...PC_EXTS];
export const isCloudSrc = (p) => new RegExp(`\\.(${CLOUD_EXTS.join('|')})$`, 'i').test(p || '');
// Normal values from Options > Drawings; Fine / Light keep the same ratio to Normal (0.6 / 1.6 and 0.7 / 1.5: drDotFineK …)
export const DENSITY = { get fine() { return opt('dotNormal') * opt('drDotFineK'); }, get normal() { return opt('dotNormal'); }, get light() { return opt('dotNormal') * opt('drDotLightK'); } }; // paper mm per dot cell
export const PIXEL = { get fine() { return opt('pixNormal') * opt('drPixFineK'); }, get normal() { return opt('pixNormal'); }, get light() { return opt('pixNormal') * opt('drPixLightK'); } }; // paper mm per density pixel
export const PRESETS = { get plan() { return { from: opt('planFrom'), to: opt('planTo') }; }, get slab() { return { from: opt('slabFrom'), to: opt('slabTo') }; } };
export const cloudDefaults = () => ({ color: 'density', dark: 1, thick: opt('cloudThick'), size: opt('drDotSize'), density: 'normal', clip: { on: false, ref: 'back', from: 0, to: 1 } });
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const baseOf = (p) => p.split(/[\\/]/).pop();

export class DrawingClouds {
  cloudSources() { return (this.app.root?.tabs || this.app.tabs || []).filter((t) => t.path && /\.lithpcd$/i.test(t.path)).map((t) => t.path); }
  // open the clouds of a source: {list: [{id, transform}], origin, close()}
  async openCloudSource(src) {
    let recs, origin = null, partAlign = null;
    if (/\.lithpcd$/i.test(src)) {
      const tab = (this.app.root?.tabs || this.app.tabs || []).find((t) => t.path === src && t.doc?.doc?.kind === 'cloud');
      let d = tab?.doc?.doc;
      if (!d) { const f = await api.readFile(src); d = upgradeDoc(JSON.parse(f.text)).doc; }
      recs = (d.clouds || []).filter((r) => r.visible !== false);
      origin = d.origin || null; partAlign = d.partAlign || null;
      if (!recs.length) throw new Error(`${baseOf(src)} has no visible point clouds`);
    } else recs = [{ path: src }];
    const ids = [], list = [], req = Math.random();
    const off = api.onCloudProgress?.((p) => { if (p.req === req) this.app.setStatus(`${p.phase}… ${p.total ? Math.floor((p.done / p.total) * 100) : 0}%`); });
    try {
      for (const rec of recs) {
        let path = rec.cache || rec.path;
        if (!(await api.fileExists(path).catch(() => false))) {
          // moved together with the document: next to it (scans) or in its results folder (edits)
          const s = sepOf(src), alt = rec.cache ? dirOf(src) + s + baseOf(src).replace(/\.[^.]+$/, '') + ' clouds' + s + baseOf(path) : dirOf(src) + s + baseOf(path);
          if (await api.fileExists(alt).catch(() => false)) path = alt;
        }
        const r = rec.cache ? await api.cloudOpenCache(path) : await api.cloudOpen(path, req, {});
        if (!r || r.error) throw new Error(`${baseOf(path)}: ${r?.error || 'cannot open'}`);
        ids.push(r.id); list.push({ id: r.id, transform: rec.transform || null });
        if (!origin) origin = r.meta.origin;
      }
    } catch (e) { for (const id of ids) api.cloudClose(id); throw e; } finally { off?.(); }
    return { list, origin, partAlign, close: () => { for (const id of ids) api.cloudClose(id); } };
  }
  // items: [{dir, x, cloud?, scale?, sheet?, slab?}]; ctx = view whose options/scale apply when an item has none;
  // probe: only the box (coarse levels)
  async computeCloudViews(src, items, ctx = null, { probe = false, noOverlay = false } = {}) {
    const S = await this.openCloudSource(src);
    try {
      const views = items.map((it) => {
        const o = it.cloud || (ctx?.cloud ? { ...ctx.cloud, clip: { on: false } } : cloudDefaults());
        const sh = this.doc.sheets.find((x) => x.id === (it.sheet || ctx?.sheet)) || this.sheet;
        const s = scaleVal(it.scale || (it.sheet ? null : ctx?.scale) || sh.scale);
        const c = o.clip?.on ? { ref: o.clip.ref || 'back', from: +o.clip.from || 0, to: +o.clip.to || 0, level: o.clip.level | 0 } : null;
        const thick = (it.cloud?.thick ?? ctx?.cloud?.thick ?? opt('drCloudThickFallback')) * 1000;
        const depth = (it.cloud?.depth ?? ctx?.cloud?.depth ?? 0) * 1000; // view depth beyond the cut
        const slab = it.plane ? { p: it.plane.p, n: it.plane.n, lo: -thick / 2 - depth, hi: thick / 2 } : null;
        const raster = !probe && (o.color || 'density') === 'density' ? { pix: (PIXEL[o.density] || PIXEL.normal) / s } : null;
        return { dir: it.dir, x: it.x, cell: probe ? 1e9 : (DENSITY[o.density] || DENSITY.normal) / s, clip: c, slab, raster, _s: s };
      });
      const r = await api.cloudDrawView({ clouds: S.list, docOrigin: S.origin, views });
      if (!r || r.error) throw new Error(r?.error || 'cannot draw the point cloud');
      r.forEach((g, i) => { (g.dots || g.raster).s = views[i]._s; g.info.aligned = Object.keys(S.partAlign || {}); });
      if (!probe && !noOverlay) await this.addOverlays(items, r, ctx, S.partAlign);
      return r;
    } finally { S.close(); }
  }
  // Room tool on a full-depth (x-ray) top view: floors and ceilings fill every cell there, so walls can't
  // be told apart. Make a hidden floor-plan slice (floor + 1.0 … 1.3 m, the view's floor level) just for
  // finding the room outline; kept in memory per view and scale, not saved in the drawing.
  async roomFit(v, sl = PRESETS.plan) {
    const g = v.geom, clipOn = v.cloud?.clip?.on;
    const top = Math.abs(v.dir?.[1] || 0) > opt('drTopViewDot');
    if (clipOn || !top || !isCloudSrc(v.src)) return g?.fit || null;
    const key = `${v.id}|${g?.raster?.s || g?.dots?.s}|${v.cloud?.clip?.level | 0}|${sl.from}|${sl.to}`;
    this._roomFits ||= new Map();
    if (this._roomFits.has(key)) return this._roomFits.get(key);
    const it = { dir: v.dir, x: v.x, sheet: v.sheet, scale: v.scale, cloud: { ...(v.cloud || cloudDefaults()), color: 'density', clip: { on: true, ref: 'floor', from: sl.from, to: sl.to, level: v.cloud?.clip?.level | 0 } } };
    const r = await this.run(`Finding walls (slice ${sl.from}–${sl.to} m)`, () => this.computeCloudViews(v.src, [it], null, { noOverlay: true }));
    const f = r?.[0]?.fit || null;
    this._roomFits.set(key, f);
    return f;
  }
  // the slices room detection uses (room settings: low + high slice; the high one sees walls above
  // furniture, window sills and door heads). A view with its own slice / a side view uses its own sample.
  async roomFits(v, st) {
    const out = [], top = Math.abs(v.dir?.[1] || 0) > opt('drTopViewDot');
    if (v.cloud?.clip?.on || !top) return [v.geom?.fit].filter(Boolean);
    for (const [a, b] of [[st.lowFrom, st.lowTo], [st.highFrom, st.highTo]]) if (b > a) { const f = await this.roomFit(v, { from: a, to: b }); if (f) out.push(f); }
    return out;
  }
  // views whose dots were made for another scale than they now have: recompute (density follows the scale)
  async refreshCloudViews(vs = null) {
    const tol = opt('drCloudRescaleTol'), list = (vs || this.doc.views).filter((v) => (v.geom?.dots || v.geom?.raster) && isCloudSrc(v.src) && Math.abs((v.geom.dots || v.geom.raster).s / scaleVal(v.scale || this.doc.sheets.find((x) => x.id === v.sheet).scale) - 1) > tol);
    if (vs) for (const v of vs) if ((v.geom?.dots || v.geom?.raster) && !list.includes(v)) list.push(v);
    if (!list.length) return;
    const bySrc = new Map();
    for (const v of list) { if (!bySrc.has(v.src)) bySrc.set(v.src, []); bySrc.get(v.src).push(v); }
    await this.run('Updating point cloud views', async () => {
      for (const [src, arr] of bySrc) { const g = await this.computeCloudViews(src, arr); arr.forEach((v, i) => { v.geom = g[i]; }); }
    });
    this.app.setStatus(`Updated ${list.length} point cloud view${list.length > 1 ? 's' : ''}`);
    this.app.setDirty(true); this.renderTree(); this.vp.requestRender();
  }
  // view panel part for cloud views
  cloudPanel(v) {
    const o = (v.cloud ||= cloudDefaults()), info = v.geom?.info;
    const field = (label, input) => h('div', { class: 'pp-row' }, h('label', {}, label), input);
    const sel = (key, opts, recompute) => {
      const s = h('select', {}, ...opts.map(([val, l]) => h('option', { value: val, selected: String(o[key]) === String(val) }, l)));
      s.addEventListener('change', () => {
        const val = key === 'size' || key === 'dark' || key === 'thick' || key === 'depth' ? +s.value : s.value;
        const again = recompute || (key === 'color' && (o.color === 'density') !== (val === 'density'));
        this.change(() => { v.cloud = { ...o, [key]: val }; }); if (again) this.refreshCloudViews([v]);
      });
      return s;
    };
    const D = v.geom?.dots, I = info || D || {}, dens = (o.color || 'density') === 'density';
    const colors = [['density', 'Density (scan look)'], ['black', 'Points, black'], ...(I.hasI || I.hasRgb ? [['grey', I.hasI ? 'Points, grey (intensity)' : 'Points, grey']] : []), ...(I.hasRgb ? [['rgb', 'Points, scan colours (RGB)']] : [])];
    const num = (key, val) => { const i = h('input', { type: 'number', step: 0.05, value: val, style: { width: '60px' } }); i.addEventListener('keydown', (e) => e.stopPropagation()); i.addEventListener('change', () => this.setCloudClip(v, { [key]: +i.value })); return i; };
    const c = o.clip || { on: false, ref: 'back', from: 0, to: 1 };
    const on = h('input', { type: 'checkbox', checked: !!c.on }); on.addEventListener('change', () => this.setCloudClip(v, { on: on.checked }));
    const ref = h('select', {}, ...[['back', 'far side'], ['front', 'near side'], ['floor', 'floor']].map(([val, l]) => h('option', { value: val, selected: c.ref === val }, l)));
    ref.addEventListener('change', () => this.setCloudClip(v, { ref: ref.value }));
    return h('div', {}, h('div', { class: 'sp-sec' }, 'Point cloud'),
      field('Colour', sel('color', colors)),
      dens ? field('Darkness', sel('dark', [[0.5, 'Very light'], [0.75, 'Light'], [1, 'Normal'], [1.4, 'Dark'], [2, 'Very dark']])) : field('Point size', sel('size', [0.1, 0.15, 0.2, 0.25, 0.35, 0.5].map((s) => [s, `${s} mm`]))),
      (info?.aligned?.length) ? field('Overlay part', sel('overlay', [['', 'none'], ...info.aligned.map((f) => [f, f.split(/[\\/]/).pop()])], true)) : null,
      info?.overlayError ? h('p', { class: 'pm-info', style: { margin: '2px 8px', color: opt('drErrorText') } }, `Overlay: ${info.overlayError}`) : null,
      v.plane ? field('View depth (m)', sel('depth', [[0, '0 (slice only)'], [0.5, '0.5'], [1, '1'], [2, '2'], [5, '5'], [10, '10'], [1000, 'all (beyond the cut)']], true)) : null,
      v.plane ? field('Slice thickness', sel('thick', [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2].map((t) => [t, `${t} m`]), true)) : null,
      field('Density', sel('density', [['fine', 'Fine'], ['normal', 'Normal'], ['light', 'Light']], true)),
      h('label', { class: 'pp-check', style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 8px' } }, on, 'Depth range / slice'),
      field('Measured from', ref),
      (c.ref === 'floor' && info?.levels?.length > 1) ? field('Floor level', (() => { const L = info.levels, q = h('select', {}, ...L.map((z, i) => h('option', { value: i, selected: (c.level | 0) === i }, `Level ${i} (${i ? '+' : ''}${fmt((z - L[0]) / 1000, 2)} m)`))); q.addEventListener('change', () => this.setCloudClip(v, { level: +q.value })); return q; })()) : null,
      h('div', { class: 'pp-row' }, h('label', {}, 'From – to (m)'), h('span', { style: { display: 'flex', gap: '4px' } }, num('from', c.from), num('to', c.to))),
      info ? h('p', { class: 'pm-info', style: { margin: '2px 8px' } }, `Depth of the scan in this view: ${fmt((info.dMax - info.dMin) / 1000, 2)} m${Math.abs(v.dir[1]) > opt('drPlanViewDot') ? `; floor found ${fmt((info.floor - info.dMin) / 1000, 2)} m above the lowest point` : ''}. ${D ? `${D.n.toLocaleString()} dots.` : v.geom?.raster ? `Image ${v.geom.raster.w} × ${v.geom.raster.h} px.` : ''}`) : null);
  }
  setCloudClip(v, props) {
    this.change(() => { v.cloud = { ...(v.cloud || cloudDefaults()) }; v.cloud.clip = { ...(v.cloud.clip || {}), ...props }; });
    this.refreshCloudViews([v]);
  }
}
export function cloudNote() { toast('Section views of point clouds come in the next update', 'info', opt('drToastNoteMs')); }
