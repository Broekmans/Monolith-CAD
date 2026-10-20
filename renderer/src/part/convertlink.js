// Part: linked Convert Entities (On Edge), 0.1.83. Before every rebuild, sketches with converted model edges are
// brought up to date in feature order (geometry moved onto the edges of the body just before the sketch, then the
// sketch solved with its own relations and dimensions), so later sketches follow earlier sketches / features.
// Pure geometry: linkgeom.js. Methods are mixed into PartDoc (see part.js); `this` is the PartDoc.
import { api } from '../api.js';
import { opt } from '../app/options.js';
import { toast, fmt } from '../ui.js';
import { solve as solveSketch } from '../sketch/solver.js';
import { relinkChain, hasLinks, hasFixed } from './linkgeom.js';
import { driveChain } from './drivechain.js';

export class PartConvertLink {
  linkOpts(extra = {}) {
    return { getBase: (features, index) => api.kernel('linkBase', { features, index }), solve: solveSketch, tolPct: opt('linkTolPct'), ...extra };
  }
  // Update linked sketches in `features` (in place). auto = also link fixed geometry of older parts that lies on edges.
  async relink(features, { upTo, auto = false, stopAt } = {}) {
    if (!opt('linkConvert')) return null;
    if (!features.some(hasLinks) && !(auto && features.some(hasFixed))) return null;
    try { return await relinkChain(features, this.linkOpts({ upTo: upTo ?? features.length, auto, stopAt })); } catch (e) { console.warn('relink', e); return null; }
  }
  // after a rebuild: warnings (edge not found / sketch cannot follow) shown on the sketch in the tree
  linkStatus(res, status) {
    if (!res?.warn?.size) return;
    for (const s of status) if (res.warn.has(s.id) && s.state === 'ok') { s.state = 'warn'; s.error = res.warn.get(s.id); }
  }
  linkedMessage(res) {
    if (!res?.linkedNow?.length) return;
    const n = res.linkedNow.reduce((a, x) => a + x.n, 0);
    const txt = `Linked ${n} converted edge${n > 1 ? 's' : ''} in ${res.linkedNow.map((x) => x.name).join(', ')} to the model (On Edge): they follow it when earlier sketches or features change`;
    this.app.setStatus(txt);
    try { window.__lithLog?.('LINK', JSON.stringify(res.linkedNow)); } catch { /* log optional */ }
  }

  // A dashed size in sketch `sk` that only follows converted (linked) edges: change the dimension in an earlier sketch
  // that drives it (drivechain.js). Replaces doc.features on success.
  async driveUpstream(sk, want) {
    const i = this.doc.features.findIndex((f) => f.id === sk.id);
    this.app.setBusy(true); this.app.setStatus('Finding the dimension in an earlier sketch that drives this size…');
    try {
      const best = await driveChain(this.doc.features, i, want, { ...this.linkOpts(), maxStep: opt('sizeStepPct') / 100,
        onProgress: (k, n) => this.app.setStatus(`Finding the dimension in an earlier sketch that drives this size… ${k}/${n}`) });
      if (best) this.doc.features = best.features;
      return best;
    } finally { this.app.setBusy(false); }
  }
  // applyShownDim for a dashed size that follows linked edges (called after beginChange)
  async applyUpstream(sk, want, reason) {
    const best = opt('driveUpstream') ? await this.driveUpstream(sk, want).catch((e) => { console.warn(e); return null; }) : null;
    if (!best) { this._last = null; toast(reason, 'warn', opt('toastWarnMs')); return false; }
    const pre = best.type === 'radius' ? 'R' : best.type === 'diameter' ? 'Ø' : '';
    this.commit('drive upstream');
    this.app.setStatus(this._statusAfter = `${best.sk}: dimension ${pre}${fmt(best.old, opt('partReportDecimals'))} → ${pre}${fmt(best.value, opt('partReportDecimals'))} (drives this size in ${sk.name}, now ${fmt(want.value, opt('partReportDecimals'))})`);
    try { window.__lithLog?.('DRIVE', best.sk, best.id, best.old, '->', best.value, 'size', want.value, 'in', sk.name); } catch { /* log optional */ }
    this.renderTree(); this.updateSketchDisplay();
    if (this.featUI) this.featUI.preview(); else this.regen();
    return true;
  }
}
