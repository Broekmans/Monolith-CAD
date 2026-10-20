// Offset Entities (0.1.94): sketch side of the tool. The host (part/sketching.js cmdOffset) shows the popup and
// calls startOffset / setOffsetOpts / finishOffset / cancelOffset. Clicks pick sketch entities or model edges
// (model edges get invisible linked references, like Smart Dimension); the result is linked to its base by offset
// relations + one offset dimension (sketch/offset.js addOffset), so it follows the base and the model.
import { dist } from './geom2d.js';
import { sketchChain, addOffset, gatherChain } from './offset.js';
import { toast, h, fmt } from '../ui.js';
import { opt } from '../app/options.js';

export class SketchOffset {
  startOffset(opts) {
    this.cancelTool?.();
    this.endMirror?.();
    this.offsetMode = { picks: [], opts: { ...opts }, snap: JSON.stringify(this.sk), undoLen: this.undoStack.length, preview: null, err: null, alt: null, sideLocked: false };
    this.sel.clear();
    this.offsetBoxMake();
    this.host.onToolChanged?.('offset');
    this.vp.requestRender();
  }
  setOffsetOpts(opts) {
    const m = this.offsetMode; if (!m) return;
    const chainChanged = !!m.opts.selectChain !== !!opts.selectChain;
    // Reverse ticked / unticked by hand: the side no longer follows the mouse (0.1.96)
    if (!!opts.reverse !== !!m.opts.reverse) m.sideLocked = true;
    m.opts = { ...opts };
    if (chainChanged) m.picks = m.picks.map((pk) => ({ ...pk, chain: sketchChain(this.sk, pk.id, { selectChain: !!opts.selectChain, tol: opt('offsetChainTol') }) })).filter((pk) => pk.chain);
    this.updateOffsetPreview();
  }
  // click: toggle the chain under the mouse (sketch entity, else model edge)
  offsetClick(p, sx, sy, e) {
    const m = this.offsetMode;
    const hit = this.pick(p, sx, sy, { points: false, dims: false });
    let id = hit && hit.kind === 'geo' && ['line', 'arc', 'circle'].includes(this.G(hit.id)?.type) ? hit.id : null;
    if (!id) id = this.offsetModelPick(p);
    if (!id && e && this.offsetFacePick(e)) return; // 0.1.97: a flat face = all its edges
    if (!id) { toast('Click a sketch line, arc or circle, a model edge or a flat model face.'); return; }
    const was = m.picks.findIndex((pk) => pk.chain.items.some((it) => it.id === id));
    if (was >= 0) m.picks.splice(was, 1);
    else {
      const chain = sketchChain(this.sk, id, { selectChain: !!m.opts.selectChain, tol: opt('offsetChainTol') });
      if (chain) m.picks.push({ id, chain });
    }
    this.updateOffsetPreview();
  }
  // model edge under p + (Select chain) its connected model edges: in-plane edges join in-plane ones, edges off the
  // sketch plane join edges at the same depth only (0.1.98)
  offsetModelChain(p) {
    const thr = opt('skPickPx') * this.px;
    const be = this.pickModelEdge(p, thr * opt('skEdgePickFactor'));
    if (!be) return null;
    const list = this.modelSnapGeo().pickEdges || [];
    let edges = [be];
    if (this.offsetMode.opts.selectChain && (be.inPlane || be.flat !== false)) {
      const pool = list.filter((x) => x.inPlane === be.inPlane && (be.inPlane || (x.flat !== false && Math.abs(x.depth - be.depth) < opt('skInPlaneTol'))));
      const eps = opt('geomEps'), curves = pool.map((x) => ({ kind: dist(x.pts[0], x.pts[x.pts.length - 1]) < eps ? 'circle' : 'line', a: x.pts[0], b: x.pts[x.pts.length - 1], c: x.pts[0], r: 1 }));
      const i0 = pool.indexOf(be);
      if (i0 >= 0) edges = gatherChain(curves, i0, { tol: opt('offsetModelChainTol') }).items.map((it) => pool[it.i]);
    }
    return { be, edges };
  }
  // model edge chain → reference geometry; returns the clicked edge's ref id
  offsetModelPick(p) {
    const mc = this.offsetModelChain(p); if (!mc) return null;
    let first = null;
    for (const e of mc.edges) { const id = this.refForModelEdge(e, { full: true }); if (e === mc.be) first = id; }
    this.resolve(false);
    return first;
  }
  // hover (0.1.98): what a click would take lights up — sketch chain, model edge chain or a flat face
  offsetHoverAt(p, sx, sy, e) {
    const m = this.offsetMode; if (!m) return;
    let hv = null;
    const hit = this.pick(p, sx, sy, { points: false, dims: false });
    const id = hit && hit.kind === 'geo' && ['line', 'arc', 'circle'].includes(this.G(hit.id)?.type) ? hit.id : null;
    if (id) { const ch = sketchChain(this.sk, id, { selectChain: !!m.opts.selectChain, tol: opt('offsetChainTol') }); if (ch) hv = { key: 'g' + ch.items.map((it) => it.id).join(), geo: ch.items.map((it) => it.id) }; }
    if (!hv) { const mc = this.offsetModelChain(p); if (mc) hv = { key: 'e' + mc.edges.map((x) => x.e.id).join(), polys: mc.edges.map((x) => x.pts) }; }
    if (!hv && e) {
      const f = this.offsetFaceAt(e);
      if (f?.ok) hv = { key: 'f' + f.id, polys: f.pool.map((x) => x.pts), fill: stitchLoops(f.pool.map((x) => x.pts)) };
    }
    if ((hv?.key || null) !== (m.hover?.key || null)) { m.hover = hv; this.vp.requestRender(); }
  }
  // flat model face under the mouse: { id, ok (parallel to the sketch), pool (its projected edges) }
  offsetFaceAt(e) {
    const f = this.host.faceAt?.(e); if (!f) return null;
    const n = f.plane?.normal, fn = this.fr.n, nn = n && (Array.isArray(n) ? n : [n.x, n.y, n.z]);
    const ok = !!nn && Math.abs(nn[0] * fn[0] + nn[1] * fn[1] + nn[2] * fn[2]) >= opt('skCoplanarDot');
    const pool = ok ? (this.modelSnapGeo().pickEdges || []).filter((x) => x.e.faces?.includes(f.id)) : [];
    return { id: f.id, ok: ok && pool.length > 0, parallel: ok, pool };
  }
  // flat model face parallel to the sketch → its edge loops as linked references, each loop one chain (toggles)
  offsetFacePick(e) {
    const m = this.offsetMode, ff = this.offsetFaceAt(e); if (!ff) return false;
    if (!ff.parallel) { toast('Only flat faces parallel to the sketch can be offset. Click its edges instead.', 'warn'); return true; }
    const f = { id: ff.id }, pool = ff.pool;
    if (!pool.length) return false;
    // clicked this face before: remove its chains
    const was = m.picks.filter((pk) => pk.face === f.id);
    if (was.length) { m.picks = m.picks.filter((pk) => pk.face !== f.id); this.updateOffsetPreview(); return true; }
    const ids = pool.map((x) => this.refForModelEdge(x, { full: true })).filter(Boolean);
    this.resolve(false);
    const used = new Set();
    for (const id of ids) {
      if (used.has(id)) continue;
      const chain = sketchChain(this.sk, id, { selectChain: true, tol: opt('offsetModelChainTol') });
      if (!chain) continue;
      chain.items.forEach((it) => used.add(it.id));
      m.picks.push({ id, chain, face: f.id });
    }
    window.__lithLog?.(`OFFSET face ${f.id} ${pool.length} edges`);
    this.updateOffsetPreview();
    return true;
  }
  offsetSpec() {
    const m = this.offsetMode, o = m.opts;
    return { chains: m.picks.map((pk) => pk.chain), dist: Math.abs(+o.dist || 0), reverse: !!o.reverse, both: !!o.both, cap: !!o.cap, baseConstruction: !!o.baseConstruction };
  }
  // preview = the result on a copy of the sketch
  updateOffsetPreview() {
    const m = this.offsetMode; if (!m) return;
    m.preview = null; m.err = null; m.raw = null;
    const run = (spec) => {
      const copy = JSON.parse(JSON.stringify(this.sk));
      const r = addOffset(copy, spec);
      if (r.err) return { err: r.err };
      const G = new Map(copy.geo.map((g) => [g.id, g]));
      return { prev: r.made.map((id) => G.get(id)).filter(Boolean).map((g) => ({ g, G })) };
    };
    // 0.1.97: tiny offsets to both sides, made once per chain set: which side is which (also when the real offset fails)
    const pkey = m.picks.map((pk) => pk.chain.items.map((it) => it.id).join()).join('|');
    if (m.picks.length && m.probeKey !== pkey) {
      const sp = { ...this.offsetSpec(), dist: opt('offsetProbeDist'), both: false, cap: false, baseConstruction: false };
      const f = run({ ...sp, reverse: false }), t = run({ ...sp, reverse: true });
      m.probe = f.prev && t.prev ? { f: f.prev, t: t.prev } : null; m.probeKey = pkey;
    }
    if (m.picks.length && this.offsetSpec().dist > 0) {
      const spec = this.offsetSpec(), a = run(spec);
      if (a.err) { m.err = a.err; m.raw = this.offsetRaw(spec); } else m.preview = a.prev;
    }
    this.host.onOffsetChanged?.(m);
    this.vp.requestRender();
  }
  // OK: add the entities for real; returns false (+ message) when nothing / not possible
  finishOffset() {
    const m = this.offsetMode; if (!m) return true;
    if (!m.picks.length) { toast('Select sketch entities or model edges to offset.', 'warn'); return false; }
    const spec = this.offsetSpec();
    if (!(spec.dist > 0)) { toast('Enter an offset distance above 0.', 'warn'); return false; }
    const r = addOffset(this.sk, spec);
    if (r.err) { toast(r.err, 'error'); return false; }
    const s = this.resolve(true);
    void s;
    this.undoStack.length = m.undoLen; this.undoStack.push(m.snap); this.redoStack = [];
    this.offsetMode = null; this.offsetBoxEnd();
    this.sel.clear(); r.made.forEach((id) => this.sel.add('geo:' + id));
    window.__lithLog?.(`OFFSET ${spec.chains.length} chain(s) ${r.made.length} entities d ${spec.dist}${spec.both ? ' both' : ''}`);
    this.host.onToolChanged?.(null);
    this.renderPanel?.(); this.vp.requestRender();
    return true;
  }
  cancelOffset() {
    const m = this.offsetMode; if (!m) return;
    this.sk = JSON.parse(m.snap); this.undoStack.length = m.undoLen;
    this.offsetMode = null; this.offsetBoxEnd(); this.sel.clear();
    this.resolve(true);
    this.host.onToolChanged?.(null);
  }
  // preview drawing (called from draw())
  drawOffsetPreview(ctx, COL) {
    const m = this.offsetMode; if (!m) return;
    ctx.save(); ctx.lineWidth = opt('offsetPreviewLineW'); ctx.setLineDash(opt('offsetPreviewDash')); ctx.strokeStyle = COL.preview;
    const S = (q) => this.scr(q);
    // offset not possible: every entity shifted by the distance, untrimmed, in red (0.1.97)
    if (m.err && m.raw) {
      ctx.strokeStyle = opt('offsetErrColor');
      const xm = opt('offsetErrMarkPx');
      for (const r of m.raw) {
        ctx.beginPath();
        if (r.a) { const a = S(r.a), b = S(r.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
        else if (r.r > 0) { for (let k = 0; k <= 64; k++) { const t = r.a0 + (r.a1 - r.a0) * k / 64, q = S([r.c[0] + r.r * Math.cos(t), r.c[1] + r.r * Math.sin(t)]); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); } }
        else { const c = S(r.c); ctx.moveTo(c[0] - xm, c[1] - xm); ctx.lineTo(c[0] + xm, c[1] + xm); ctx.moveTo(c[0] + xm, c[1] - xm); ctx.lineTo(c[0] - xm, c[1] + xm); }
        ctx.stroke();
      }
      ctx.strokeStyle = COL.preview;
    }
    for (const { g, G } of m.preview || []) {
      const P = (id) => { const p = G.get(id); return [p.x, p.y]; };
      ctx.beginPath();
      if (g.type === 'line') { const a = S(P(g.p1)), b = S(P(g.p2)); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      else {
        const c = P(g.c); let a0 = 0, a1 = 2 * Math.PI;
        if (g.type === 'arc') { const s = P(g.s), e = P(g.e); a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI; }
        for (let k = 0; k <= 64; k++) { const t = a0 + (a1 - a0) * k / 64, q = S([c[0] + g.r * Math.cos(t), c[1] + g.r * Math.sin(t)]); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
      }
      ctx.stroke();
    }
    // hover (0.1.98): face fill + its edges / the chain a click would take, in the ghost colour
    const hv = m.hover;
    if (hv) {
      ctx.setLineDash([]); ctx.lineWidth = opt('skHoverHighlightW'); ctx.strokeStyle = COL.preview;
      if (hv.fill?.length) {
        ctx.save(); ctx.globalAlpha = opt('offsetHoverFill'); ctx.fillStyle = COL.preview; ctx.beginPath();
        for (const loop of hv.fill) loop.forEach((q, i) => { const s2 = S(q); if (i) ctx.lineTo(s2[0], s2[1]); else ctx.moveTo(s2[0], s2[1]); });
        ctx.fill('evenodd'); ctx.restore();
      }
      for (const poly of hv.polys || []) { ctx.beginPath(); poly.forEach((q, i) => { const s2 = S(q); if (i) ctx.lineTo(s2[0], s2[1]); else ctx.moveTo(s2[0], s2[1]); }); ctx.stroke(); }
      for (const gid of hv.geo || []) { const g = this.G(gid); if (g) { ctx.beginPath(); this.offsetPath(ctx, g, S); ctx.stroke(); } }
    }
    // picked base chains highlighted in the selection blue (0.1.98)
    ctx.setLineDash([]); ctx.lineWidth = opt('skLineWSel'); ctx.strokeStyle = COL.sel;
    for (const pk of m.picks) for (const it of pk.chain.items) {
      const g = this.G(it.id); if (!g) continue;
      ctx.beginPath();
      if (g.type === 'line') { const a = S(this.P(g.p1)), b = S(this.P(g.p2)); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      else {
        const c = this.P(g.c); let a0 = 0, a1 = 2 * Math.PI;
        if (g.type === 'arc') { const s = this.P(g.s), e = this.P(g.e); a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI; }
        for (let k = 0; k <= 64; k++) { const t = a0 + (a1 - a0) * k / 64, q = S([c[0] + g.r * Math.cos(t), c[1] + g.r * Math.sin(t)]); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
      }
      ctx.stroke();
    }
    ctx.restore();
    this.drawOffsetBox(ctx);
  }

  // path of a sketch line / arc / circle (current sketch)
  offsetPath(ctx, g, S) {
    if (g.type === 'line') { const a = S(this.P(g.p1)), b = S(this.P(g.p2)); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); return; }
    const c = this.P(g.c); let a0 = 0, a1 = 2 * Math.PI;
    if (g.type === 'arc') { const s0 = this.P(g.s), e0 = this.P(g.e); a0 = Math.atan2(s0[1] - c[1], s0[0] - c[0]); a1 = Math.atan2(e0[1] - c[1], e0[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI; }
    for (let k = 0; k <= 64; k++) { const t = a0 + (a1 - a0) * k / 64, q = S([c[0] + g.r * Math.cos(t), c[1] + g.r * Math.sin(t)]); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
  }

  // ---------------- 0.1.96: distance box + drag arrow on the sketch ----------------
    // Reverse value for the side of the chain the mouse is on (null: on the chain / unknown), from the tiny probes
  offsetSideAt(p) {
    const m = this.offsetMode; if (!m?.probe) return null;
    const BP = (id) => { const q = this.G(id); return [q.x, q.y]; };
    let dB = Infinity; for (const pk of m.picks) for (const it of pk.chain.items) { const g = this.G(it.id); if (g) { const c = geoClosest(g, BP, p); dB = Math.min(dB, Math.hypot(c[0] - p[0], c[1] - p[1])); } }
    if (dB < opt('offsetSideDeadPx') * this.px) return null;
    const dF = offsetNear(p, m.probe.f), dT = offsetNear(p, m.probe.t);
    if (Math.abs(dF - dT) < opt('offsetSideTol')) return null;
    return dT < dF;
  }
  // untrimmed offset of every base entity (red warning drawing): direction per entity from the probe of this side
  offsetRaw(spec) {
    const m = this.offsetMode, pr = m.probe && (spec.reverse ? m.probe.t : m.probe.f); if (!pr) return null;
    const BP = (id) => { const q = this.G(id); return [q.x, q.y]; }, d = spec.dist, out = [];
    for (const pk of m.picks) for (const it of pk.chain.items) {
      const g = this.G(it.id); if (!g) continue;
      const mid = geoMid(g, BP);
      let c = null, bd = Infinity;
      for (const { g: q, G } of pr) { const P = (id) => { const z = G.get(id); return [z.x, z.y]; }; const k = geoClosest(q, P, mid), dd = Math.hypot(k[0] - mid[0], k[1] - mid[1]); if (dd < bd) { bd = dd; c = k; } }
      if (!c) continue;
      if (g.type === 'line') {
        const L = Math.hypot(c[0] - mid[0], c[1] - mid[1]) || 1, n = [(c[0] - mid[0]) / L * d, (c[1] - mid[1]) / L * d], a = BP(g.p1), b = BP(g.p2);
        out.push({ a: [a[0] + n[0], a[1] + n[1]], b: [b[0] + n[0], b[1] + n[1]] });
      } else {
        const cc = BP(g.c), grow = Math.hypot(c[0] - cc[0], c[1] - cc[1]) > g.r ? 1 : -1;
        let a0 = 0, a1 = 2 * Math.PI;
        if (g.type === 'arc') { const s0 = BP(g.s), e0 = BP(g.e); a0 = Math.atan2(s0[1] - cc[1], s0[0] - cc[0]); a1 = Math.atan2(e0[1] - cc[1], e0[0] - cc[0]); if (a1 <= a0) a1 += 2 * Math.PI; }
        out.push({ c: cc, r: g.r + grow * d, a0, a1 });
      }
    }
    return out;
  }
  offsetBoxMake() {
    this.offsetBoxEnd();
    const inp = h('input', { type: 'text', spellcheck: 'false', value: fmt(+this.offsetMode.opts.dist || 0, 4) });
    const box = h('div', { class: 'feat-val off-val', title: 'Enter = apply, Enter again = OK · Esc = Cancel' }, h('label', {}, 'Distance'), inp, h('span', { class: 'unit' }, 'mm'));
    const grip = h('div', { class: 'feat-grip off-grip', title: 'Drag to change the distance (and the side)' });
    for (const ev of ['pointerdown', 'dblclick']) box.addEventListener(ev, (e) => e.stopPropagation());
    inp.addEventListener('input', () => { inp._typed = true; });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const typed = inp._typed; inp._typed = false;
        const r = this.offsetApply(inp.value);
        if (r === 'same' && !typed) this.offsetUI?.ok?.(); else if (r) inp.select();
      } else if (e.key === 'Escape') { e.preventDefault(); this.offsetUI?.cancel?.(); }
    });
    inp.addEventListener('change', () => this.offsetApply(inp.value));
    box.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      const st = opt('wheelStep') || 1, cur = +this.offsetMode?.opts.dist || 0, next = +(cur + (e.deltaY < 0 ? st : -st)).toFixed(6);
      if (next > 0) { inp.value = fmt(next, 4); this.offsetApply(String(next)); }
    }, { passive: false });
    grip.addEventListener('pointerdown', (e) => this.offsetGripDown(e));
    box.style.display = 'none'; grip.style.display = 'none';
    this.vp.el.append(box, grip);
    this._offBox = { box, inp, grip };
  }
  offsetBoxEnd() { const b = this._offBox; if (!b) return; b.box.remove(); b.grip.remove(); this._offBox = null; }
  // value from the box / arrow → the dialog field (offsetUI.setDist updates the popup and calls setOffsetOpts)
  offsetApply(text) {
    const m = this.offsetMode, b = this._offBox; if (!m) return false;
    const n = Number(String(text).replace(',', '.').trim());
    if (!isFinite(n) || n <= 0) { b?.inp.classList.add('bad'); return false; }
    b?.inp.classList.remove('bad');
    if (+m.opts.dist === n) return 'same';
    if (this.offsetUI?.setDist) this.offsetUI.setDist(n); else this.setOffsetOpts({ ...m.opts, dist: n });
    return true;
  }
  // box at the first offset entity, arrow from the base chain to it (only in the view clicked last)
  drawOffsetBox(ctx) {
    const m = this.offsetMode, b = this._offBox; if (!m || !b) return;
    const set = this.vp.viewset;
    if (set && set.panes.length > 1) {
      const fp = set.focus || set.active;
      if (this.vp.pane !== fp) return;
      if (b.box.parentElement !== fp.el) fp.el.append(b.box, b.grip);
    }
    const a = this.offsetAnchor();
    if (!a) { b.box.style.display = 'none'; b.grip.style.display = 'none'; return; }
    if (document.activeElement !== b.inp && !b.drag) b.inp.value = fmt(+m.opts.dist || 0, 4);
    b.box.classList.toggle('err', !!m.err); b.grip.classList.toggle('err', !!m.err);
    const AC = m.err ? opt('offsetErrColor') : opt('dragArrowColor');
    const s = this.scr(a.p), q = this.scr(a.base);
    let ux = 1; // box on the side the arrow points to, so it stays off the other side (where the mouse flips it)
    if (a.arrow) {
      ctx.save(); ctx.strokeStyle = AC; ctx.fillStyle = AC; ctx.lineWidth = opt('dragArrowLineW'); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.beginPath(); ctx.arc(q[0], q[1], opt('dragArrowDotPx'), 0, Math.PI * 2); ctx.fill();
      const L = Math.hypot(s[0] - q[0], s[1] - q[1]);
      if (L > 1) {
        const uy = (s[1] - q[1]) / L; ux = (s[0] - q[0]) / L;
        const hl = opt('dragArrowHeadPx'), hw = opt('dragArrowHeadHalfPx'), go = opt('dragGripOffsetPx');
        ctx.beginPath(); ctx.moveTo(s[0] + ux * hl, s[1] + uy * hl); ctx.lineTo(s[0] - uy * hw, s[1] + ux * hw); ctx.lineTo(s[0] + uy * hw, s[1] - ux * hw); ctx.closePath(); ctx.fill();
        Object.assign(b.grip.style, { left: s[0] + ux * go + 'px', top: s[1] + uy * go + 'px', display: '' });
      } else b.grip.style.display = 'none';
      ctx.restore();
    } else b.grip.style.display = 'none';
    // near the right edge the box goes left of the arrow tip (else focusing its field scrolls the whole view)
    const W = b.box.parentElement?.clientWidth || 1e9, bw = b.box.offsetWidth || opt('offsetBoxWidthPx');
    const gap = opt('valueBoxGapPx'), mR = opt('valueBoxMarginPx'), mL = opt('valueBoxMarginLeftPx');
    let x = ux < -opt('offsetBoxFlipDir') ? s[0] - gap - bw : s[0] + gap;
    if (x + bw > W - mR) x = s[0] - gap - bw; else if (x < mL) x = s[0] + gap;
    Object.assign(b.box.style, { left: Math.max(mL, x) + 'px', top: s[1] + 'px', display: '' });
    const par = b.box.parentElement; if (par && (par.scrollLeft || par.scrollTop)) { par.scrollLeft = 0; par.scrollTop = 0; }
  }
  // anchor: a base point (where the arrow was last dragged, else the middle of the first offset entity's base) and
  // the arrow tip on the offset (or, when the offset fails, the base point moved by the distance to this side)
  offsetAnchor() {
    const m = this.offsetMode; if (!m?.picks.length) return null;
    const BP = (id) => { const p = this.G(id); return [p.x, p.y]; };
    const items = m.picks.flatMap((pk) => pk.chain.items.map((it) => this.G(it.id))).filter(Boolean);
    if (!items.length) return null;
    const nearBase = (q) => { let best = null, bd = Infinity; for (const g of items) { const c = geoClosest(g, BP, q), d = Math.hypot(c[0] - q[0], c[1] - q[1]); if (d < bd) { bd = d; best = c; } } return best; };
    let base;
    if (m.anchorAt) base = nearBase(m.anchorAt);
    else if (m.preview?.length) { const { g, G } = m.preview[0]; base = nearBase(geoMid(g, (id) => { const p = G.get(id); return [p.x, p.y]; })); }
    else base = geoMid(items[0], BP);
    if (m.preview?.length) {
      let tip = null, bd = Infinity;
      for (const { g, G } of m.preview) { const c = geoClosest(g, (id) => { const p = G.get(id); return [p.x, p.y]; }, base), d = Math.hypot(c[0] - base[0], c[1] - base[1]); if (d < bd) { bd = d; tip = c; } }
      return { p: tip, base, arrow: true };
    }
    const pr = m.probe && (m.opts.reverse ? m.probe.t : m.probe.f), d = +m.opts.dist || 0;
    if (pr && d > 0) {
      let c = null, bd = Infinity;
      for (const { g, G } of pr) { const k = geoClosest(g, (id) => { const p = G.get(id); return [p.x, p.y]; }, base), dd = Math.hypot(k[0] - base[0], k[1] - base[1]); if (dd < bd) { bd = dd; c = k; } }
      const L = bd || 1;
      if (c) return { p: [base[0] + (c[0] - base[0]) / L * d, base[1] + (c[1] - base[1]) / L * d], base, arrow: true };
    }
    return { p: base, base, arrow: false };
  }
  // drag the arrow: distance = mouse distance to the base chain, side = side of the mouse
  offsetGripDown(e) {
    const m = this.offsetMode, b = this._offBox; if (!m || !b) return;
    e.preventDefault(); e.stopPropagation();
    const base = m.picks.flatMap((pk) => pk.chain.items.map((it) => this.G(it.id))).filter(Boolean);
    const BP = (id) => { const p = this.G(id); return [p.x, p.y]; };
    const [z0, z1] = opt('dragStepZoom'), [st0, st1, st2] = opt('dragSnapSteps');
    const step = this.px > z0 ? st0 : this.px > z1 ? st1 : st2; // mm per pixel → round steps (as the feature arrow)
    b.drag = true; b.grip.setPointerCapture(e.pointerId);
    let raf = 0, want = +m.opts.dist || 0;
    let lastP = null;
    const mv = (ev) => {
      const { p } = this.local(ev);
      let d = Infinity, near = null; for (const g of base) { const c = geoClosest(g, BP, p), dd = Math.hypot(c[0] - p[0], c[1] - p[1]); if (dd < d) { d = dd; near = c; } }
      const st = ev.shiftKey ? step / opt('dragFineDiv') : step;
      want = +Math.max(st, Math.round(d / st) * st).toFixed(6);
      if (near) m.anchorAt = near; // the arrow stays at the chain point under the mouse (0.1.97)
      b.inp.value = fmt(want, 4); lastP = p;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        // side first (dragging through the chain reverses it), then the distance; one preview update
        const r = m.opts.both || m.sideLocked ? null : this.offsetSideAt(lastP);
        const flip = r !== null && r !== !!m.opts.reverse;
        if (flip) { m.opts.reverse = r; this.offsetUI?.setReverse?.(r); }
        if (this.offsetApply(String(want)) === 'same' && flip) this.updateOffsetPreview();
        this.vp.requestRender();
      });
    };
    const up = () => { b.grip.removeEventListener('pointermove', mv); b.grip.removeEventListener('pointerup', up); b.drag = false; this.offsetApply(String(want)); this.host.app?.setStatus?.(`Offset distance ${fmt(want, 3)} mm`); };
    b.grip.addEventListener('pointermove', mv); b.grip.addEventListener('pointerup', up);
  }
}

// ---------------- small 2D helpers (P(id) → [x, y]) ----------------

// edge polylines → closed loops (endpoint matching), for the face hover fill
function stitchLoops(polys, tol = opt('offsetModelChainTol')) {
  const left = polys.map((p) => p.slice()), loops = [];
  const eq = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  while (left.length) {
    let loop = left.shift();
    for (let guard = 0; guard < 1000 && !eq(loop[0], loop[loop.length - 1]); guard++) {
      const end = loop[loop.length - 1];
      const i = left.findIndex((q) => eq(q[0], end) || eq(q[q.length - 1], end));
      if (i < 0) break;
      const q = left.splice(i, 1)[0];
      loop = loop.concat(eq(q[0], end) ? q.slice(1) : q.slice(0, -1).reverse());
    }
    loops.push(loop);
  }
  return loops;
}

function geoMid(g, P) {
  if (g.type === 'line') { const a = P(g.p1), b = P(g.p2); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  const c = P(g.c);
  let t = Math.PI / 4;
  if (g.type === 'arc') { const s = P(g.s), e = P(g.e); const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI; t = (a0 + a1) / 2; }
  return [c[0] + g.r * Math.cos(t), c[1] + g.r * Math.sin(t)];
}
function geoClosest(g, P, q) {
  if (g.type === 'line') {
    const a = P(g.p1), b = P(g.p2), dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
    return [a[0] + dx * t, a[1] + dy * t];
  }
  const c = P(g.c), d = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
  if (g.type === 'arc') { // outside the arc's sweep: nearest end point
    const s = P(g.s), e = P(g.e), a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]); if (a1 <= a0) a1 += 2 * Math.PI;
    let t = Math.atan2(q[1] - c[1], q[0] - c[0]); while (t < a0) t += 2 * Math.PI;
    if (t > a1) return Math.hypot(q[0] - s[0], q[1] - s[1]) < Math.hypot(q[0] - e[0], q[1] - e[1]) ? s : e;
  }
  return [c[0] + (q[0] - c[0]) * g.r / d, c[1] + (q[1] - c[1]) * g.r / d];
}
// distance from p to the nearest entity of a preview list ({ g, G })
function offsetNear(p, list) {
  let d = Infinity;
  for (const { g, G } of list) { const P = (id) => { const q = G.get(id); return [q.x, q.y]; }; const c = geoClosest(g, P, p); d = Math.min(d, Math.hypot(c[0] - p[0], c[1] - p[1])); }
  return d;
}
