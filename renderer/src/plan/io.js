// Plan: DXF/DWG/STEP import and export
// Methods are mixed into PlanDoc (see plan.js); `this` is the PlanDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, promptText, evalNumber } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import * as G from './planGeom.js';
const { dist, add, sub, mul, lerp } = G;
import { parseDxf, planToDxf, skippedText } from '../io/dxf.js';
import { circleFrom3, cross2 } from '../sketch/geom2d.js';
import { CloudManager, cloudPanel } from '../pointcloud.js';
import { newPlanDoc, LAYER_FOR, pointInPoly, polyArea, seqCommand, selectThen, COMMANDS, dimCommand, kindFor, openingCommand, nearestWall, xformCommand, offsetEntity, lineIntersect, trimEntity, filletLines } from './plan.js';

export class PlanIO {
  // ======================= import / export =======================
  importDxfText(text, name) {
    let res;
    try { res = parseDxf(text); } catch (e) { toast('Could not read DXF: ' + e.message, 'error'); return; }
    this.change(() => {
      for (const L of res.layers) if (!this.doc.layers.some((x) => x.name === L.name)) this.doc.layers.push(L);
      for (const e of res.entities) {
        if (!this.doc.layers.some((x) => x.name === e.layer)) this.doc.layers.push({ name: e.layer, color: '#000000', visible: true, locked: false });
        this.addEntity(e);
      }
    });
    this.zoomExtents();
    const sk = skippedText(res.skipped);
    if (sk) toast(`Imported ${res.entities.length} entities from ${name} — ${sk}${res.skipped.IMAGE && !res.entities.length ? '. This file only holds raster pictures; picture import is not supported yet.' : ''}`, res.entities.length ? 'info' : 'error', 9000);
    else toast(`Imported ${res.entities.length} entities from ${name}`, 'ok');
  }

  explodeForDxf() {
    const walls = this.wallMap();
    const openingsOf = new Map();
    for (const e of this.doc.entities) if (e.type === 'door' || e.type === 'window') { if (!openingsOf.has(e.wall)) openingsOf.set(e.wall, []); openingsOf.get(e.wall).push(e); }
    const out = [];
    for (const e of this.doc.entities) {
      const base = { layer: e.layer, ...(e.color ? { color: e.color } : {}) };
      switch (e.type) {
        case 'line': case 'circle': case 'arc': case 'polyline': case 'text': case 'point': out.push({ ...e, ...base }); break;
        case 'wall': for (const poly of G.wallPieces(e, openingsOf.get(e.id) || [])) out.push({ type: 'polyline', pts: poly, closed: true, ...base }); break;
        case 'door': case 'window': {
          const w = walls.get(e.wall);
          if (w) for (const pr of G.openingPrims(e, w)) out.push({ ...pr, ...base });
          break;
        }
        case 'dim': {
          const g = G.dimGeom(e);
          out.push({ type: 'line', a: e.a, b: g.d1, ...base }, { type: 'line', a: e.b, b: g.d2, ...base }, { type: 'line', a: g.d1, b: g.d2, ...base });
          const tick = this.S.dimTextH * 0.4;
          for (const t of [g.d1, g.d2]) out.push({ type: 'line', a: [t[0] - tick, t[1] - tick], b: [t[0] + tick, t[1] + tick], ...base });
          let ang = Math.atan2(g.dir[1], g.dir[0]); if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI;
          out.push({ type: 'text', p: add(g.mid, mul([-Math.sin(ang), Math.cos(ang)], this.S.dimTextH * 0.6)), h: this.S.dimTextH, text: fmt(g.value, 0), rot: ang, align: 'center', ...base });
          break;
        }
        default:
      }
    }
    return out;
  }
  async exportDxf(kind) {
    const text = planToDxf(this.doc.layers, this.explodeForDxf());
    if (kind === 'dwg') {
      const path = await api.saveFile({ defaultPath: `${this.doc.name}.dwg`, filters: [{ name: 'AutoCAD Drawing', extensions: ['dwg'] }], noWrite: true });
      if (!path) return;
      const r = await api.dxfToDwg(text, path);
      if (r?.ok) toast(`Exported ${path.split(/[\\/]/).pop()} (${r.version}, ${r.via})${/LibreDWG/.test(r.via || '') ? ' · for newer DWG versions install the ODA File Converter (File → DWG Converter…)' : ''}`, 'ok', 6000); else this.app.dwgHelp(r?.error, () => this.exportDxf('dwg'));
      return;
    }
    const path = await api.saveFile({ defaultPath: `${this.doc.name}.dxf`, filters: [{ name: 'DXF', extensions: ['dxf'] }], text });
    if (path) toast(`Exported ${path}`, 'ok');
  }
  async exportStep() {
    const ents = this.visibleEntities().filter((e) => ['wall', 'door', 'window'].includes(e.type) || (e.type === 'polyline' && e.closed && e.slab));
    try {
      const text = await api.kernel('planStep', { entities: ents });
      const path = await api.saveFile({ defaultPath: `${this.doc.name}.step`, filters: [{ name: 'STEP', extensions: ['step', 'stp'] }], text });
      if (path) toast(`Exported ${path}`, 'ok');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }

  dispose() { this.clouds?.dispose(); this.vp.dispose(); this.vp3.dispose(); this.app.showCommandLine(false); }
}
