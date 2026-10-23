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
import { opt } from '../app/options.js';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { compKey, libText, newAssemblyDoc, COLORS, PALETTE, IDENT, partCache, partVersion, partSaved, loadPart, circle3, entityGeo, geoName, segDist } from './assembly.js';

export class AsmCommands {
  // ---------- Toolbox: DIN fastener library ----------
  // edit: Toolbox components to change (Edit Toolbox Definition, 0.1.118) — same group only (bolts / nuts / washers)
  cmdToolbox(v0 = null, edit = null) {
    if (edit && !edit.length) edit = null;
    const prev = edit ? { std: edit[0].lib.std, size: edit[0].lib.size, L: edit[0].lib.L ?? 25 } : this._tb || { std: 'DIN933', size: 'M8', L: 25 };
    const v = { ...prev, ...(v0 || {}) };
    const def = fastenerDef(v.std);
    if (!def.sizes.includes(v.size)) v.size = def.sizes.includes('M8') ? 'M8' : def.sizes[0];
    const lens = hasLength(v.std) ? def.lengths(sizeDia(v.size)) : [];
    if (lens.length && !lens.includes(+v.L)) v.L = lens.reduce((a, b) => (Math.abs(b - v.L) < Math.abs(a - v.L) ? b : a));
    if (!edit) this._tb = v;
    let info = '';
    try {
      const p = fastenerPart(v.std, v.size, +v.L).fastener;
      const names = { pitch: 'Pitch P', s: 'Across flats s', k: 'Head height k', m: 'Height m', dk: 'Head Ø dk', socket: 'Hex socket s', threadLength: 'Thread length b', d1: 'Inner Ø d1', d2: 'Outer Ø d2', h: 'Thickness h' };
      info = Object.entries(p).filter(([k]) => names[k]).map(([k, x]) => `${names[k]}: <b>${fmt(x)}</b>`).join('<br>');
    } catch (e) { info = e.message; }
    this.pmKind = 'toolbox';
    const fields = [
      { key: 'std', type: 'select', label: 'Standard', options: FASTENERS.filter((f) => !edit || f.group === fastenerDef(edit[0].lib.std).group).map((f) => ({ value: f.id, label: `${f.group}: ${f.label}` })) },
      { key: 'size', type: 'select', label: 'Size', options: def.sizes.map((s) => ({ value: s, label: s })) },
    ];
    if (lens.length) fields.push({ key: 'L', type: 'select', label: 'Length (mm)', options: lens.map((l) => ({ value: l, label: String(l) })) });
    fields.push({ type: 'info', html: `<div style="line-height:1.6">${info}<br><span class="muted">Threads are not modelled (nominal Ø). Axis = Y; bolts: underside of head at Y=0.</span></div>` });
    this.app.pm.show({
      title: edit ? `Edit Toolbox Definition${edit.length > 1 ? ` (${edit.length} parts)` : ` – ${edit[0].name}`}` : 'Toolbox – DIN fasteners', iconName: 'bolt', values: v, fields, okLabel: edit ? 'OK' : 'Insert',
      onChange: (vals, key) => { if (key === 'std' || key === 'size' || key === 'L') setTimeout(() => this.cmdToolbox({ ...vals }, edit), 0); },
      onOk: (vals) => {
        const lib = { std: vals.std, size: vals.size, ...(hasLength(vals.std) ? { L: +vals.L } : {}) };
        if (edit) { this.pmKind = null; setTimeout(() => { this.app.showPanel('tree'); this.applyToolboxEdit(edit.map((c) => c.id), lib); }, 0); return; }
        this._tb = { ...vals };
        this.pmKind = null;
        setTimeout(async () => { this.app.showPanel('tree'); await this.insertComponent(null, null, lib); }, 0);
      },
      onCancel: () => { this.pmKind = null; setTimeout(() => { if (!this.app.pm.open) this.app.showPanel('tree'); this.app.cm.refresh(); }, 0); },
    });
    this.app.showPanel('pm');
    this.app.cm.refresh();
  }
  // Edit Toolbox Definition: new standard/size/length for Toolbox components (one undo step); mated faces re-found
  async applyToolboxEdit(ids, lib) {
    const cs = ids.map((id) => this.C(id)).filter((c) => c?.lib);
    if (!cs.length) return;
    this.beginChange();
    this.app.setBusy(true);
    try {
      for (const c of cs) {
        const old = c.name;
        c.lib = { ...lib };
        const base = fastenerName(lib.std, lib.size, lib.L);
        const used = new Set(this.doc.components.filter((k) => k !== c).map((k) => k.name));
        let n = 1; while (used.has(`${base}<${n}>`)) n++;
        c.name = `${base}<${n}>`;
        try { window.__lithLog?.('TOOLBOX', old, '->', c.name); } catch { /* log optional */ }
      }
      await Promise.all(cs.map((c) => this.loadComp(c)));
      this.rematchAll();
      this.commit();
      this.solve();
      toast(cs.length > 1 ? `${cs.length} Toolbox parts changed to ${fastenerName(lib.std, lib.size, lib.L)}` : `Changed to ${cs[0].name}`, 'ok', 2500);
    } finally { this.app.setBusy(false); }
  }
  // Lock / unlock the rotation of concentric mates (the turn about the axis is kept as it is now)
  setLockRot(mates, on) {
    if (!mates.length) return;
    this.beginChange();
    for (const m of mates) {
      if (m.type !== 'concentric') continue;
      if (on) { m.lockRot = true; m.lockQ = M.lockQOf(this.CG(m.a.comp), this.CG(m.b.comp)); } else { delete m.lockRot; delete m.lockQ; }
    }
    this.commit();
    this.solve();
    this.app.setStatus(`${on ? 'Locked' : 'Unlocked'} rotation of ${mates.length} concentric mate${mates.length > 1 ? 's' : ''}`);
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
  deleteComponent(id) { this.deleteMates([], [id]); }
  deleteMate(id) { this.deleteMates([id]); }
  deleteComponents(ids) { this.deleteMates([], ids); }
  // 0.1.134: mates and components in one undo step (their mates go with deleted components; Motion Study steps of
  // deleted mates stay and show "(mate deleted)")
  deleteMates(mateIds = [], compIds = []) {
    const ms = new Set(mateIds), cs = new Set(compIds.filter((id) => this.C(id)));
    if (!ms.size && !cs.size) return;
    this.beginChange();
    this.doc.components = this.doc.components.filter((x) => !cs.has(x.id));
    this.doc.mates = this.doc.mates.filter((m) => !ms.has(m.id) && !cs.has(m.a.comp) && !cs.has(m.b.comp));
    this.sel = [];
    this.commit(); if (cs.size) this.syncScene(); this.solve();
    if (ms.size + cs.size > 1) window.__lithLog?.(`DELETE ${cs.size} components, ${ms.size} mates`);
  }
  // 0.1.134: Flip Mate Alignment (Angle: 180° further) / Flip Dimension (Distance: to the other side), like the Mate
  // dialog's Flip boxes; the mate keeps its value, the model follows (one undo step)
  flipMates(ms) {
    if (!ms.length) return;
    if (this._drv) this.endDriveSession();
    this.beginChange();
    for (const m of ms) {
      if (m.type === 'distance') { m.flipSide = !m.flipSide; m.side = -(m.side ?? 1); } else { m.flip = !m.flip; m.sense = -(m.sense ?? -1); }
    }
    // the model now reads 180° off (or on the other side): walk it to the mate's value like Drive does — a plain solve
    // starting exactly opposite does not move (no slope there)
    const vm = ms.filter((m) => m.type === 'angle' || m.type === 'distance');
    let res = { status: 'ok' };
    if (vm.length) {
      this._drv = { kind: 'flip', targets: [], hist: [], size: this.compSizes(), steps: 0, nHeld: 0, ms: 0, msMax: 0, err: 0 }; // own session (no second undo step)
      const targets = vm.map((m) => ({ id: m.id, value: m.value ?? 0 }));
      for (let k = 0; k < 6; k++) { res = this.driveTo(targets, 'flip'); if (res.status === 'ok' && res.part >= 1) break; }
      this.endDriveSession(); // commits (one undo step) + solve
    } else { this.commit(); this.solve(); }
    this.renderTree();
    if (res.status !== 'ok') toast(`${vm.map((m) => m.name).join(', ')}: flipped, but the model cannot get there from here (end of travel) — check the mates`, 'warn', 5000);
    window.__lithLog?.('MATE flip', ms.map((m) => m.name).join(', '), res.status);
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
    const values = { ents: items, type: edit?.type || 'coincident', value: edit?.value ?? 10, flip: !!edit?.flip, flipSide: !!edit?.flipSide, lockRot: !!edit?.lockRot,
      limits: !!edit?.limits, min: edit?.limits?.min ?? edit?.value ?? 0, max: edit?.limits?.max ?? (edit?.value ?? 0) + (edit?.type === 'angle' ? opt('asmLimitDefDeg') : opt('asmLimitDefMm')) };
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
      if (key === 'lockRot') this._userLock = true;
      if (key === 'value') this._userValue = true;
      if (key === 'limits' && v.limits && !this._limitsSet) { // first time on: Minimum = value, Maximum = value + default
        this._limitsSet = true; v.min = v.value; v.max = v.value + (v.type === 'angle' ? opt('asmLimitDefDeg') : opt('asmLimitDefMm'));
        this.app.pm.current?.setValue('min', v.min); this.app.pm.current?.setValue('max', v.max);
      }
      if (key === 'ents' && !edit) {
        const ok = M.validTypes(A.geo, B.geo);
        if (!this._userType || !ok.includes(v.type)) { v.type = M.defaultType(A.geo, B.geo); this.app.pm.current?.setValue('type', v.type); }
      }
      restorePoses();
      const cA = this.CG(A.comp), cB = this.CG(B.comp);
      // Lock rotation: on by default for a new concentric mate with a Toolbox part (Options > Assembly)
      if (!edit && !this._userLock && (key === 'ents' || key === 'type')) {
        const want = v.type === 'concentric' && !!(cA.lib || cB.lib) && !!opt('asmLockToolboxRot');
        if (v.lockRot !== want) { v.lockRot = want; this.app.pm.current?.setValue('lockRot', want); }
      }
      const gA = M.worldGeo(cA, A.geo), gB = M.worldGeo(cB, B.geo);
      if (!this._mateBase || key === 'ents') this._mateBase = { sense: M.currentSense(gA, gB), side: M.currentSide(gA, gB) };
      if (edit && !this._mateBaseFromEdit) { this._mateBaseFromEdit = true; this._mateBase = { sense: edit.sense * (edit.flip ? -1 : 1), side: (edit.side ?? 1) * (edit.flipSide ? -1 : 1) }; }
      if (key === 'type') this._mateBase.side = M.currentSide(gA, gB);
      const m = {
        id: edit?.id || '_draft', name: edit?.name, type: v.type, a: this.refOf(A), b: this.refOf(B),
        sense: this._mateBase.sense * (v.flip ? -1 : 1), side: this._mateBase.side * (v.flipSide ? -1 : 1), flip: !!v.flip, flipSide: !!v.flipSide,
      };
      if (v.type === 'distance' || v.type === 'angle') {
        // Angle (0.1.119): signed angle about a turning axis (the pivot's concentric mate, else the common axis now),
        // chosen so the angle as it is now is positive; old angle mates keep theirs (or none)
        if (v.type === 'angle') {
          m.axis = edit?.type === 'angle' && edit.axis ? edit.axis : M.angleAxisFor(m, this.doc.components, this.doc.mates);
          if (!(edit?.type === 'angle' && edit.axis)) { const byId = M.compMap(this.doc.components); if ((M.mateValue(m, byId) ?? 0) < 0) m.axis = m.axis.map((x) => -x); }
        }
        // a new mate starts at the value it has now (until a value is typed)
        if (!edit && !this._userValue && (key === 'ents' || key === 'type')) {
          const cur = M.mateValue(m, M.compMap(this.doc.components));
          if (cur != null && Number.isFinite(cur)) { v.value = Math.round(cur * 100) / 100; this.app.pm.current?.setValue('value', v.value); }
        }
        m.value = v.value;
        if (v.limits) m.limits = { min: Math.min(v.min, v.max), max: Math.max(v.min, v.max) };
      }
      if (v.type === 'lock') m.rel = M.relPose(cA, cB);
      if (v.type === 'concentric' && v.lockRot) m.lockRot = true; // lockQ is taken after the first solve (preview)
      return m;
    };
    const preview = (v, key) => {
      draft = build(v, key);
      const pm = this.app.pm.current;
      if (!draft) { restorePoses(); this.updatePoses(); pm?.setMessage('Select two faces or edges on different components. Width mate: select 2 parallel faces on one component and 2 on another.'); return; }
      if (draft.err) { pm?.setMessage(draft.err, 'error'); return; }
      this.solve(draft, { drag: null });
      if (draft.lockRot) { draft.lockQ = M.lockQOf(this.CG(draft.a.comp), this.CG(draft.b.comp)); this.solve(draft, { drag: null }); }
      const err = this.mateErr.get(draft.id);
      pm?.setMessage(err || (draft.type === 'width' ? 'Width: centred between the 2 faces of each component' : `${M.MATE_TYPES.find((t) => t.id === draft.type).label}: ${geoName(draft.a.geo)} ↔ ${geoName(draft.b.geo)}`), err ? 'error' : 'info');
      this.updateHighlights();
    };
    this._mateBase = null; this._mateBaseFromEdit = false; this._userType = !!edit; this._userLock = !!edit; this._userValue = !!edit; this._limitsSet = !!edit?.limits;
    this.pmKind = 'mate';
    this.app.pm.show({
      title: edit ? edit.name : 'Mate', iconName: 'mate', values,
      fields: [
        { key: 'ents', type: 'selbox', label: 'Entities to Mate', max: 4, accepts: (it) => !!it.geo, itemLabel: (it) => it.label },
        { type: 'group', label: 'Standard Mates', fields: [
          { key: 'type', type: 'select', label: 'Mate type', options: typeOpts },
          { key: 'value', type: 'number', label: 'Distance / Angle', unit: 'mm | °', step: 1 },
          { key: 'flip', type: 'check', label: 'Flip alignment' },
          { key: 'flipSide', type: 'check', label: 'Flip side (distance / tangent)' },
          { key: 'lockRot', type: 'check', label: 'Lock rotation (concentric)' }] },
        { type: 'group', label: 'Limits (Distance / Angle)', fields: [
          { key: 'limits', type: 'check', label: 'Limits: free between Minimum and Maximum' },
          { key: 'min', type: 'number', label: 'Minimum', unit: 'mm | °', step: 1 },
          { key: 'max', type: 'number', label: 'Maximum', unit: 'mm | °', step: 1 }] },
      ],
      onChange: (v, key) => { if (key === 'ents') { this._mateBase = null; } preview(v, key); },
      onOk: () => {
        if (!draft || draft.err) { toast(draft?.err || 'Select two entities on different components'); return false; }
        if (this.mateErr.get(draft.id)) { toast(this.mateErr.get(draft.id), 'error'); return false; }
        restorePoses();
        this.beginChange();
        this.solve(draft);
        if (edit) { const em = this.doc.mates.find((m) => m.id === edit.id); delete em.lockRot; delete em.lockQ; delete em.limits; delete em.axis; }
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
    this.app.floatPM?.(true); // 0.1.127: compact box over the view, the tree stays visible (origin planes, components) — like feature dialogs
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
    if (r.kind === 'plane') return { ...this.planeItem(r.comp, r.id), ...r }; // 0.1.127: origin planes
    const c = this.C(r.comp);
    return { ...r, key: `${r.comp}:${r.kind}:${r.id}`, label: `${geoName(r.geo)}@${c?.name || '?'}` };
  }

}
