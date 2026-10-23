// In-context references (0.1.132). While a part is edited from an assembly (part/context.js) its sketches can use the
// edges / corners of the other components (sketcher.ctxEdges): converted or snapped geometry keeps g.xref (see
// linkgeom.js applyXrefs). Each time the part is opened in context again, that geometry is moved onto the referenced
// edges as they are now (the other part changed or moved), the sketch is solved and the part rebuilt (one undo step).
// Opened on its own (or from another assembly) the geometry just stays fixed: "->?" in the tree.
// Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import { opt } from '../app/options.js';
import { solve as solveSketch } from '../sketch/solver.js';
import { applyXrefs, xrefBase, hasXrefs, followLinks, frameOfPlane } from './linkgeom.js';

const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* optional */ } };
export const samePath = (a, b) => !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
const asmName = (p) => (p || '').split(/[\\/]/).pop().replace(/\.lithasm$/i, '');

export class PartXref {
  // match candidates per component of the current context, only for references made in this assembly
  xrefBases() {
    const c = this._ctx; if (!c) return null;
    c._bases ??= new Map(c.items.filter((it) => it.mesh).map((it) => [it.comp, xrefBase(it.mesh, it.m)]));
    return { get: (comp, x) => (samePath(x?.asm, c.asmPath) ? c._bases.get(comp) : undefined) };
  }
  // null (no references) | 'in' (this part is open in the assembly they were made in) | 'out' (out of context)
  xrefState(f) {
    const sk = f?.type === 'sketch' ? f : f?.sketch ? this.F(f.sketch) : null;
    if (!hasXrefs(sk)) return null;
    const c = this._ctx;
    return c && sk.geo.some((g) => g.xref && samePath(g.xref.asm, c.asmPath)) ? 'in' : 'out';
  }
  xrefTip(f) {
    const sk = f?.type === 'sketch' ? f : this.F(f.sketch);
    const refs = new Map();
    for (const g of sk?.geo || []) if (g.xref) refs.set(`${g.xref.compName} in ${asmName(g.xref.asm)}`, 1);
    const st = this.xrefState(f);
    return `In-context references (->): ${[...refs.keys()].join(', ')}` + (st === 'out' ? '\nOut of context (->?): open the part from that assembly (Edit Part) to update them' : '');
  }
  // tree label suffix
  xrefMark(f) { const s = this.xrefState(f); return s === 'in' ? ' ->' : s === 'out' ? ' ->?' : ''; }

  // bring in-context geometry up to date with the context; returns the number of sketches changed
  async updateXrefs() {
    const c = this._ctx;
    this._xrefWarn = new Map();
    if (!c || !opt('asmXrefs')) return 0;
    const bases = this.xrefBases(), changed = [];
    let before = null;
    for (const f of this.doc.features) {
      if (!hasXrefs(f) || f.suppressed) continue;
      const sk = JSON.parse(JSON.stringify(f)), geo0 = JSON.parse(JSON.stringify(sk.geo));
      const r = applyXrefs(sk, bases, frameOfPlane(this.planeOf(f)), opt('linkTolPct'));
      if (r.missing.length) this._xrefWarn.set(f.id, `${r.missing.length} in-context reference${r.missing.length > 1 ? 's' : ''} not found on the other component${r.missing.length > 1 ? 's' : ''} - kept at the last position`);
      if (r.moved) {
        const s = followLinks(sk, geo0, solveSketch, opt('sizeStepPct') / 100);
        if (s && s.ok === false) { this._xrefWarn.set(f.id, 'The sketch cannot follow its in-context references (relations or dimensions conflict) - kept at the last position'); continue; }
      }
      if (JSON.stringify(sk) === JSON.stringify(f)) continue;
      before ??= this.snapshot();
      Object.assign(f, sk);
      changed.push(`${f.name}: ${r.moved} moved from ${[...r.comps].map((id) => c.items.find((it) => it.comp === id)?.name || id).join(', ')}`);
    }
    if (changed.length) {
      this._last = before; this.commit('update in-context references');
      log('XREF updated', changed.join(' | '));
      this._statusAfter = `In-context references updated: ${changed.join(' · ')}`;
      this.renderTree(); this.updateSketchDisplay();
      await this.regen();
    } else if (this._xrefWarn.size) { this.xrefStatus(this.status); this.renderTree(); }
    if (this._xrefWarn.size) log('XREF warn', [...this._xrefWarn].map(([id, t]) => `${this.F(id)?.name}: ${t}`).join(' | '));
    return changed.length;
  }
  // warnings of the last update, shown on the sketches in the tree (also after every rebuild)
  xrefStatus(status) {
    if (!this._xrefWarn?.size || !status) return;
    for (const s of status) if (this._xrefWarn.has(s.id) && s.state === 'ok') { s.state = 'warn'; s.error = this._xrefWarn.get(s.id); }
  }
  // right-click › Break External References: the geometry stays where it is, as plain fixed geometry
  breakXrefs(f) {
    if (!hasXrefs(f)) return;
    this.beginChange();
    let n = 0;
    for (const g of f.geo) if (g.xref) { delete g.xref; n++; }
    for (const c of f.cons || []) if (c.xref) delete c.xref;
    this._xrefWarn?.delete(f.id);
    this.commit('break external references');
    log('XREF break', f.name, n);
    this.app.setStatus(`${f.name}: ${n} in-context reference${n > 1 ? 's' : ''} broken (the geometry stays fixed where it is)`);
    this.renderTree();
  }
}
