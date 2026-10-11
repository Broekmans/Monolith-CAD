// Assembly: Toolbox, Mate and Measure PropertyManagers
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import * as THREE from 'three';
import { Viewport } from '../viewport.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import * as M from '../../../shared/mates.mjs';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { compKey, libText, newAssemblyDoc, COLORS, PALETTE, IDENT, partCache, partVersion, partSaved, loadPart, circle3, entityGeo, geoName, segDist } from './assembly.js';

export class AsmCommands {
  // ---------- Toolbox: DIN fastener library ----------
  cmdToolbox(v0 = null) {
    const prev = this._tb || { std: 'DIN933', size: 'M8', L: 25 };
    const v = { ...prev, ...(v0 || {}) };
    const def = fastenerDef(v.std);
    if (!def.sizes.includes(v.size)) v.size = def.sizes.includes('M8') ? 'M8' : def.sizes[0];
    const lens = hasLength(v.std) ? def.lengths(sizeDia(v.size)) : [];
    if (lens.length && !lens.includes(+v.L)) v.L = lens.reduce((a, b) => (Math.abs(b - v.L) < Math.abs(a - v.L) ? b : a));
    this._tb = v;
    let info = '';
    try {
      const p = fastenerPart(v.std, v.size, +v.L).fastener;
      const names = { pitch: 'Pitch P', s: 'Across flats s', k: 'Head height k', m: 'Height m', dk: 'Head Ø dk', socket: 'Hex socket s', threadLength: 'Thread length b', d1: 'Inner Ø d1', d2: 'Outer Ø d2', h: 'Thickness h' };
      info = Object.entries(p).filter(([k]) => names[k]).map(([k, x]) => `${names[k]}: <b>${fmt(x)}</b>`).join('<br>');
    } catch (e) { info = e.message; }
    this.pmKind = 'toolbox';
    const fields = [
      { key: 'std', type: 'select', label: 'Standard', options: FASTENERS.map((f) => ({ value: f.id, label: `${f.group}: ${f.label}` })) },
      { key: 'size', type: 'select', label: 'Size', options: def.sizes.map((s) => ({ value: s, label: s })) },
    ];
    if (lens.length) fields.push({ key: 'L', type: 'select', label: 'Length (mm)', options: lens.map((l) => ({ value: l, label: String(l) })) });
    fields.push({ type: 'info', html: `<div style="line-height:1.6">${info}<br><span class="muted">Threads are not modelled (nominal Ø). Axis = Y; bolts: underside of head at Y=0.</span></div>` });
    this.app.pm.show({
      title: 'Toolbox – DIN fasteners', iconName: 'bolt', values: v, fields, okLabel: 'Insert',
      onChange: (vals, key) => { if (key === 'std' || key === 'size' || key === 'L') setTimeout(() => this.cmdToolbox({ ...vals }), 0); },
      onOk: (vals) => {
        const lib = { std: vals.std, size: vals.size, ...(hasLength(vals.std) ? { L: +vals.L } : {}) };
        this._tb = { ...vals };
        this.pmKind = null;
        setTimeout(async () => { this.app.showPanel('tree'); await this.insertComponent(null, null, lib); }, 0);
      },
      onCancel: () => { this.pmKind = null; setTimeout(() => { if (!this.app.pm.open) this.app.showPanel('tree'); this.app.cm.refresh(); }, 0); },
    });
    this.app.showPanel('pm');
    this.app.cm.refresh();
  }
  selectedComps() {
    return [...new Set(this.sel.map((s) => s.comp).filter(Boolean))].map((id) => this.C(id)).filter(Boolean);
  }
  toggleFixSelected() {
    const cs = this.selectedComps();
    if (!cs.length) { toast('Select a component first'); return; }
    this.beginChange();
    const fix = !cs[0].fixed;
    for (const c of cs) c.fixed = fix;
    this.commit(); this.solve();
  }
  toggleHideSelected() {
    const cs = this.selectedComps();
    if (!cs.length) { toast('Select a component first'); return; }
    this.beginChange();
    const hide = !cs[0].hidden;
    for (const c of cs) c.hidden = hide;
    this.commit(); this.syncScene(); this.renderTree();
  }
  deleteComponent(id) {
    const c = this.C(id);
    if (!c) return;
    this.beginChange();
    this.doc.components = this.doc.components.filter((x) => x.id !== id);
    this.doc.mates = this.doc.mates.filter((m) => m.a.comp !== id && m.b.comp !== id);
    this.sel = [];
    this.commit(); this.syncScene(); this.solve();
  }
  deleteMate(id) {
    this.beginChange();
    this.doc.mates = this.doc.mates.filter((m) => m.id !== id);
    this.sel = [];
    this.commit(); this.solve();
  }
  async renameAsm() {
    const n = await promptText('Rename assembly', this.doc.name);
    if (n) { this.beginChange(); this.doc.name = n; this.commit(); this.renderTree(); this.app.updateTitle(); }
  }

  // ---------- mate PropertyManager ----------
  cmdMate(edit = null) {
    const items = edit ? [edit.a, edit.a2, edit.b, edit.b2].filter(Boolean).map((r) => this.refItem(r)) : this.sel.filter((s) => s.geo).slice(0, 4);
    const save = this.doc.components.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
    const restorePoses = () => this.doc.components.forEach((c, i) => { if (save[i]) { c.pos = [...save[i].pos]; c.rot = [...save[i].rot]; } });
    const values = { ents: items, type: edit?.type || 'coincident', value: edit?.value ?? 10, flip: !!edit?.flip, flipSide: !!edit?.flipSide };
    let draft = null;
    const typeOpts = M.MATE_TYPES.map((t) => ({ value: t.id, label: t.label }));
    const build = (v, key) => {
      if (v.ents.length === 3) return { err: 'Width mate: select one more face (2 faces on each component)' };
      if (v.ents.length === 4) {
        const g = M.widthGroups(v.ents);
        if (g.err) return g;
        if (v.type !== 'width') { v.type = 'width'; this.app.pm.current?.setValue('type', 'width'); }
        restorePoses();
        return { id: edit?.id || '_draft', name: edit?.name, type: 'width', a: this.refOf(g.a), a2: this.refOf(g.a2), b: this.refOf(g.b), b2: this.refOf(g.b2) };
      }
      if (v.type === 'width' && key !== 'ents') return { err: 'Width mate: select 2 parallel faces on one component, then 2 on the other' };
      const [A, B] = v.ents;
      if (!A || !B) return null;
      if (A.comp === B.comp) return { err: A.geo.t === 'plane' && B.geo.t === 'plane' ? 'Width mate: now select 2 faces on the other component' : 'Select entities on two different components' };
      if (key === 'type') this._userType = true;
      if (key === 'ents' && !edit) {
        const ok = M.validTypes(A.geo, B.geo);
        if (!this._userType || !ok.includes(v.type)) { v.type = M.defaultType(A.geo, B.geo); this.app.pm.current?.setValue('type', v.type); }
      }
      restorePoses();
      const cA = this.C(A.comp), cB = this.C(B.comp);
      const gA = M.worldGeo(cA, A.geo), gB = M.worldGeo(cB, B.geo);
      if (!this._mateBase || key === 'ents') this._mateBase = { sense: M.currentSense(gA, gB), side: M.currentSide(gA, gB) };
      if (edit && !this._mateBaseFromEdit) { this._mateBaseFromEdit = true; this._mateBase = { sense: edit.sense * (edit.flip ? -1 : 1), side: (edit.side ?? 1) * (edit.flipSide ? -1 : 1) }; }
      if (key === 'type') this._mateBase.side = M.currentSide(gA, gB);
      const m = {
        id: edit?.id || '_draft', name: edit?.name, type: v.type, a: this.refOf(A), b: this.refOf(B),
        sense: this._mateBase.sense * (v.flip ? -1 : 1), side: this._mateBase.side * (v.flipSide ? -1 : 1), flip: !!v.flip, flipSide: !!v.flipSide,
      };
      if (v.type === 'distance' || v.type === 'angle') m.value = v.value;
      if (v.type === 'lock') m.rel = M.relPose(cA, cB);
      return m;
    };
    const preview = (v, key) => {
      draft = build(v, key);
      const pm = this.app.pm.current;
      if (!draft) { restorePoses(); this.updatePoses(); pm?.setMessage('Select two faces or edges on different components. Width mate: select 2 parallel faces on one component and 2 on another.'); return; }
      if (draft.err) { pm?.setMessage(draft.err, 'error'); return; }
      this.solve(draft, { drag: null });
      const err = this.mateErr.get(draft.id);
      pm?.setMessage(err || (draft.type === 'width' ? 'Width: centred between the 2 faces of each component' : `${M.MATE_TYPES.find((t) => t.id === draft.type).label}: ${geoName(draft.a.geo)} ↔ ${geoName(draft.b.geo)}`), err ? 'error' : 'info');
      this.updateHighlights();
    };
    this._mateBase = null; this._mateBaseFromEdit = false; this._userType = !!edit;
    this.pmKind = 'mate';
    this.app.pm.show({
      title: edit ? edit.name : 'Mate', iconName: 'mate', values,
      fields: [
        { key: 'ents', type: 'selbox', label: 'Entities to Mate', max: 4, accepts: (it) => !!it.geo, itemLabel: (it) => it.label },
        { type: 'group', label: 'Standard Mates', fields: [
          { key: 'type', type: 'select', label: 'Mate type', options: typeOpts },
          { key: 'value', type: 'number', label: 'Distance / Angle', unit: 'mm | °', min: 0, step: 1 },
          { key: 'flip', type: 'check', label: 'Flip alignment' },
          { key: 'flipSide', type: 'check', label: 'Flip side (distance / tangent)' }] },
      ],
      onChange: (v, key) => { if (key === 'ents') { this._mateBase = null; } preview(v, key); },
      onOk: () => {
        if (!draft || draft.err) { toast(draft?.err || 'Select two entities on different components'); return false; }
        if (this.mateErr.get(draft.id)) { toast(this.mateErr.get(draft.id), 'error'); return false; }
        restorePoses();
        this.beginChange();
        this.solve(draft);
        if (edit) Object.assign(this.doc.mates.find((m) => m.id === edit.id), draft, { name: draft.type === edit.type ? edit.name : M.MATE_TYPES.find((t) => t.id === draft.type).label + (this.doc.mates.filter((m) => m.type === draft.type).length + 1) });
        else {
          draft.id = this.newId('m');
          const base = M.MATE_TYPES.find((t) => t.id === draft.type).label;
          draft.name = base + (this.doc.mates.filter((m) => m.type === draft.type).length + 1);
          this.doc.mates.push(draft);
        }
        this.commit();
        this.endMatePM();
        this.solve();
        if (!edit) setTimeout(() => this.cmdMate(), 0); // keep mating like SolidWorks; Esc ends
      },
      onCancel: () => { restorePoses(); this.endMatePM(); this.solve(); },
    });
    this.app.showPanel('pm');
    this.sel = [];
    preview(this.app.pm.current.values, 'ents');
    this.app.cm.refresh();
  }
  endMatePM() { this.pmKind = null; this._mateBase = null; setTimeout(() => { if (!this.app.pm.open) this.app.showPanel('tree'); this.app.cm.refresh(); this.updateHighlights(); }, 0); }
  // ---------- measure ----------
  cmdMeasure() {
    const ent = (it) => {
      const c = this.C(it.comp), part = this.partOf(c || {});
      if (!c || !part) return null;
      const list = it.kind === 'face' ? part.mesh.faces : part.mesh.edges;
      const e = list.find((x) => x.id === it.id);
      if (!e) return null;
      const o = { e, c: M.xfPoint(c, e.c || e.mid) };
      if (e.plane) o.n = M.qrot(c.rot, e.plane.normal);
      return o;
    };
    const show = (v) => {
      const items = (v.items || []).map((it) => ({ it, x: ent(it) })).filter((o) => o.x);
      const lines = [];
      for (const { it, x } of items) {
        if (it.kind === 'edge') {
          let s = `${it.label}: length ${fmt(x.e.length ?? 0, 3)} mm`;
          if (x.e.type === 'circle') { const cc = circle3(x.e.pts); if (cc) s += `, Ø ${fmt(2 * cc.r, 3)} mm`; }
          lines.push(s);
        } else lines.push(`${it.label}: area ${fmt(x.e.area ?? 0, 3)} mm²`);
      }
      if (items.length === 2) {
        const [a, b] = items.map((o) => o.x);
        lines.push(`Center distance: ${fmt(M.len(M.sub(a.c, b.c)), 3)} mm`);
        if (a.n && b.n) {
          const d = Math.abs(M.dot(a.n, b.n));
          if (d > 0.9999) lines.push(`Normal distance: ${fmt(Math.abs(M.dot(M.sub(b.c, a.c), a.n)), 3)} mm`);
          else lines.push(`Angle: ${fmt((Math.acos(Math.min(1, d)) * 180) / Math.PI, 3)}°`);
        }
      }
      const r = this.app.pm.current?.inputs.result;
      if (r) r.innerHTML = lines.map((l) => `<div>${l}</div>`).join('') || 'Select edges or faces.';
      this.updateHighlights();
    };
    const end = () => { this.pmKind = null; setTimeout(() => { if (!this.app.pm.open) this.app.showPanel('tree'); this.app.cm.refresh(); this.updateHighlights(); }, 0); };
    this.pmKind = 'measure';
    this.app.pm.show({
      title: 'Measure', iconName: 'measure', values: { items: this.sel.filter((s) => s.kind === 'face' || s.kind === 'edge') },
      fields: [{ key: 'items', type: 'selbox', label: 'Selections', accepts: (it) => it.kind === 'edge' || it.kind === 'face' }, { key: 'result', type: 'info', text: 'Select edges or faces.' }],
      onChange: show, onCancel: end, okLabel: 'Close',
      onOk: () => { end(); return true; },
    });
    this.app.showPanel('pm');
    this.sel = [];
    show(this.app.pm.current.values);
    this.app.cm.refresh();
  }
  refOf(it) { return { comp: it.comp, kind: it.kind, id: it.id, c: it.c, geo: it.geo }; }
  refItem(r) {
    const c = this.C(r.comp);
    return { ...r, key: `${r.comp}:${r.kind}:${r.id}`, label: `${geoName(r.geo)}@${c?.name || '?'}` };
  }

}
