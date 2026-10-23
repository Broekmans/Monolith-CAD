// Part features under the components + Edit in Context (0.1.130). The tree shows a component's own features (from
// the part file loaded for the assembly); hover = the faces that feature made on that component (mesh face.feat).
// Edit Part / Edit Feature / Edit Sketch open the part in its own tab with the rest of the assembly around it
// (part/context.js); Return to Assembly saves and the assembly reloads the part (onActivate → rematchAll → solve).
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import * as THREE from 'three';
import { contextMenu, toast } from '../ui.js';
import * as M from '../../../shared/mates.mjs';
import { FEATURE_META, metaKey } from '../part/part.js';
import { setAsmContext } from '../part/context.js';
import { applyXrefs, xrefBase, hasXrefs, frameOfPlane } from '../part/linkgeom.js';
import { samePath } from '../part/xref.js';

const same = (a, b) => !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
export const canEditInContext = (c, part) => !!c && !c.lib && !!c.path && !!part && !part.isAssembly;

export class AsmInContext {
  // tree rows of the part's features under component c (none for Toolbox parts and subassemblies)
  featRows(c, depth, row, selKeys) {
    const part = this.partOf(c), data = part?.data;
    if (!canEditInContext(c, part) || !Array.isArray(data?.features)) return [];
    const roll = data.rollback ?? Infinity;
    return data.features.map((f, i) => {
      const it = this.featItem(c, f);
      const meta = FEATURE_META[metaKey(f)] || { icon: 'part' };
      const sketch = f.type === 'sketch';
      return row({
        icon: meta.icon, label: f.name + (hasXrefs(f) || hasXrefs(data.features.find((x) => x.id === f.sketch)) ? ' ->' : ''), depth, sel: selKeys.has(it.key), dim: i >= roll || !!f.suppressed, data: { item: it.key },
        tip: `${f.name} of ${c.name}${i >= roll ? ' (below the rollback bar)' : f.suppressed ? ' (suppressed)' : ''}\nDouble-click: edit in the part, with the assembly around it`,
        onClick: (e) => this.clickItem(this.featItem(c, f), e.ctrlKey || e.shiftKey),
        onEnter: () => { this.hover = this.featItem(c, f); this.updateHighlights(); }, onLeave: () => { this.hover = null; this.updateHighlights(); },
        onDbl: () => this.editInContext(c, f),
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [
          { label: sketch ? 'Edit Sketch' : 'Edit Feature', icon: sketch ? 'sketch' : meta.icon, run: () => this.editInContext(c, f) },
          { label: 'Edit Part', icon: 'part', run: () => this.editInContext(c) },
          { label: 'Open Part', icon: 'part', run: () => this.openComp(c) },
        ]),
      });
    });
  }
  // 0.1.132: in-context references of component c made in this assembly → {n, stale, comps} (null when none).
  // stale = the referenced components changed or moved since the part was last edited in context.
  xrefInfo(c) {
    const part = this.partOf(c), feats = part?.data?.features;
    if (!canEditInContext(c, part) || !Array.isArray(feats)) return null;
    const here = this.app.path || '';
    const sks = feats.filter((f) => hasXrefs(f) && f.geo.some((g) => g.xref && samePath(g.xref.asm, here)));
    if (!sks.length) return null;
    const ids = new Set(); for (const f of sks) for (const g of f.geo) if (g.xref) ids.add(g.xref.comp);
    const others = [...ids].map((id) => this.C(id)).filter(Boolean);
    const key = [c, ...others].map((k) => M.poseMatrix(k).map((v) => v.toFixed(4)).join(',')).join(';');
    const parts = [part, ...others.map((k) => this.partOf(k))];
    const memo = c._xrefMemo;
    if (memo && memo.key === key && memo.parts.length === parts.length && memo.parts.every((p, i) => p === parts[i])) return memo.val;
    const inv = new THREE.Matrix4().fromArray(M.poseMatrix(c)).invert();
    const bases = new Map();
    for (const k of others) { const mesh = this.partOf(k)?.mesh; if (mesh) bases.set(k.id, xrefBase(mesh, inv.clone().multiply(new THREE.Matrix4().fromArray(M.poseMatrix(k))).toArray())); }
    let stale = false, n = 0;
    for (const f of sks) {
      if (f.suppressed || !f.plane) continue;
      const sk = JSON.parse(JSON.stringify(f));
      const r = applyXrefs(sk, { get: (id, x) => (samePath(x?.asm, here) ? bases.get(id) : undefined) }, frameOfPlane(f.plane));
      n += r.linked - r.outside.length;
      if (r.moved || r.missing.length) stale = true;
    }
    const val = { n, stale, comps: others.map((k) => k.name) };
    Object.defineProperty(c, '_xrefMemo', { value: { key, parts, val }, writable: true, enumerable: false, configurable: true });
    return val;
  }
  featItem(c, f) { return { kind: 'feat', comp: c.id, id: f.id, ftype: f.type, key: `${c.id}:feat:${f.id}`, label: `${f.name}@${c.name}` }; }
  // the other components, placed in the edited component's part frame (inverse of its pose × theirs)
  contextItems(c) {
    const inv = new THREE.Matrix4().fromArray(M.poseMatrix(c)).invert();
    const out = [];
    for (const k of this.doc.components) {
      if (k.id === c.id || k.hidden) continue;
      const v = this.views.get(k.id); if (!v) continue;
      const m = inv.clone().multiply(new THREE.Matrix4().fromArray(M.poseMatrix(k)));
      out.push({ geom: v.part.geom, egeom: v.part.egeom, m: m.toArray(), name: k.name, comp: k.id, file: k.path || '', mesh: this.partOf(k)?.mesh || v.part.mesh }); // mesh: edges for in-context references (0.1.132)
    }
    return out;
  }
  // open the part of c in its own tab with the assembly around it; target feature → its dialog / the sketch
  async editInContext(c, target = null) {
    const part = this.partOf(c);
    if (!canEditInContext(c, part)) {
      if (c?.lib) toast('A Toolbox part is made from its Toolbox definition: right-click › Edit Toolbox Definition…', 'warn', 4000);
      else if (part?.isAssembly) this.openComp(c);
      else toast(`${c?.name}: the part file could not be loaded`, 'error');
      return null;
    }
    const root = this.app.root;
    const fromRect = (this.viewSet?.active || this.vp)?.el?.getBoundingClientRect(); // 0.1.133: the view carries over
    let t = root.tabs.find((x) => same(x.path, c.path));
    const openedHere = !t;
    if (t) root.activate(t); else { await this.app.open(c.path); t = root.tabs.find((x) => same(x.path, c.path)); }
    if (!t?.doc || t.doc.doc.kind !== 'part') { toast(`Could not open ${c.path}`, 'error'); return null; }
    // wait until the part has rebuilt (its feature dialogs need the model)
    for (let i = 0; i < 600 && (document.getElementById('busy')?.classList.contains('on') || !t.doc.mesh); i++) await new Promise((r) => setTimeout(r, 50));
    setAsmContext(t.doc, { asm: this, comp: c, items: this.contextItems(c), fromRect, openedHere: openedHere || !!t.doc._ctx?.openedHere });
    await t.doc.updateXrefs?.(); // 0.1.132: in-context geometry follows the other components as they are now
    if (target) {
      const f = t.doc.doc.features.find((x) => x.id === target.id);
      if (!f) toast(`${target.name} is not in the part any more`, 'warn');
      else if (f.type === 'sketch') t.doc.editSketch(f.id);
      else t.doc.editFeature(f.id);
    }
    return t;
  }
}
