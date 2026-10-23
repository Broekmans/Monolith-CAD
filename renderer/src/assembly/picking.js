// Assembly: picking, dragging, highlights
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import { opt } from '../app/options.js';
import { showPairMeasure, closePairMeasure } from '../measurepop.js';
import { entityOf } from '../../../shared/measure.mjs';
import { paneDisplay } from '../displaystyle.js';
import * as THREE from 'three';
import { Viewport, navHeld } from '../viewport.js';
import { h, fmt, contextMenu, toast, dialog, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { toggleSection, sectionTreeRows } from '../sectionview.js';
import { api } from '../api.js';
import { circleFrom3 } from '../sketch/geom2d.js';
import * as M from '../../../shared/mates.mjs';
import { FASTENERS, fastenerDef, fastenerPart, fastenerName, hasLength, sizeDia } from '../../../shared/fasteners.mjs';
import { compKey, libText, newAssemblyDoc, COLORS, PALETTE, IDENT, partCache, partVersion, partSaved, loadPart, circle3, entityGeo, geoName, segDist } from './assembly.js';

export class AsmPicking {
  // ======================= picking & dragging =======================
  pickAt(e) {
    const r = this.vp.el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const rc = this.vp.ray(sx, sy);
    const meshes = [...this.views.values()].filter((v) => v.group.visible).map((v) => v.mesh);
    this.compGroup.updateMatrixWorld(true);
    const hits = rc.intersectObjects(meshes, false);
    const hit = hits[0];
    const faceDepth = hit ? hit.distance : Infinity;
    const viewDir = this.vp.viewDir();
    // edges in screen space
    let best = null, bd = 6;
    for (const c of this.doc.components) {
      const v = this.views.get(c.id);
      if (!v || c.hidden) continue;
      for (const ed of v.part.mesh.edges) {
        if (ed.type !== 'line' && ed.type !== 'circle') continue;
        const p = ed.pts;
        let prev = null;
        for (let i = 0; i < p.length; i += 3) {
          const w = M.xfPoint(c, [p[i], p[i + 1], p[i + 2]]);
          const s = this.vp.toScreen(w);
          if (prev) {
            const d = segDist([sx, sy], prev.s, s);
            if (d < bd) {
              const depth = new THREE.Vector3(...w).sub(rc.ray.origin).dot(viewDir);
              if (paneDisplay(this) === 'wire' || depth <= faceDepth + this.vp.scale * 8) { bd = d; best = { c, ed, w }; }
            }
          }
          prev = { s };
        }
      }
    }
    const mk = (c, kind, id, cen, point) => {
      const geo = entityGeo(this.views.get(c.id).part.mesh, kind, id);
      return { comp: c.id, kind, id, c: cen, geo, point, key: `${c.id}:${kind}:${id}`, label: `${kind === 'face' ? (geo ? geoName(geo) : 'Face') : geo ? geoName(geo) : 'Edge'}@${c.name}` };
    };
    if (best) return mk(best.c, 'edge', best.ed.id, best.ed.mid, best.w);
    if (hit) {
      const cid = hit.object.userData.comp;
      const c = this.C(cid), v = this.views.get(cid);
      const fid = v.part.faceOfTri[hit.faceIndex];
      const f = v.part.mesh.faces.find((x) => x.id === fid);
      return mk(c, 'face', fid, f.c, hit.point.toArray());
    }
    return this.pickPlane(rc); // 0.1.127: a shown origin plane
  }

  bindViewport() {
    const el = this.vp.el;
    el.addEventListener('pointermove', (e) => {
      if (this.drag) { this.dragMove(e); return; }
      if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 4) { this.dragStart(this._down, e); return; }
      const p = navHeld(e) ? null : this.pickAt(e);
      if ((p?.key || null) !== (this.hover?.key || null)) { this.hover = p; this.updateHighlights(); }
    });
    // mouse leaves the view (e.g. to the tree): no hover left behind in the view (0.1.121)
    el.addEventListener('pointerleave', () => { if (!this.drag && this.hover && this.hover.kind !== 'mate') { this.hover = null; this.updateHighlights(); } });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      this._down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, pick: this.pickAt(e) };
    });
    this._onUp = (e) => {
      if (this.drag) { this.dragEnd(); this._down = null; return; }
      const d = this._down;
      this._down = null;
      if (!d || e.button !== 0 || e.target !== el && !el.contains(e.target)) return;
      this.clickItem(d.pick, e.ctrlKey || e.shiftKey);
    };
    window.addEventListener('pointerup', this._onUp);
    // 0.1.133: double-click a component in the view = Edit Part (in context); Toolbox parts / subassemblies as in the tree
    el.addEventListener('dblclick', (e) => {
      if (e.button !== 0 || this.app.pm.open || this.drag) return;
      const p = this.pickAt(e), c = p && p.comp !== M.GROUND_ID ? this.C(p.comp) : null;
      if (c) this.editInContext(c);
    });
  }
  clickItem(p, additive, fromTree = false) {
    const pm = this.app.pm.current;
    if (pm) { if (p && pm.offer(p)) this.updateHighlights(); return; }
    if (!p) this.sel = [];
    else if (additive) { const i = this.sel.findIndex((s) => s.key === p.key); if (i >= 0) this.sel.splice(i, 1); else this.sel.push(p); }
    else this.sel = [p];
    // 0.1.134: not for clicks in the tree itself — opening / closing rows there moved the rows between the two clicks of
    // a double-click (Edit Part hit another row)
    const show = fromTree ? null : this.autoExpandSel(p);
    this.updateHighlights(); this.renderTree(); this.app.cm.refresh();
    if (show) this.app.el.tree.querySelector(`[data-item="comp:${show}"]`)?.scrollIntoView({ block: 'nearest' });
    this.pairMeasure();
    if (p) this.app.setStatus(p.kind === 'feat' ? `${p.label}   ·   double-click or right-click › Edit Feature to change it (the part opens with the assembly around it)` : p.comp === M.GROUND_ID ? `${p.label}   ·   the assembly's own plane: use it in Mate` : `${p.label}   ·   drag to move${this.C(p.comp)?.fixed ? ' (fixed)' : ''}, Shift+drag to rotate`);
  }
  // 0.1.134: two faces / edges selected (Ctrl+click) → distance popup + status bar corner (world frame)
  pairMeasure() {
    const ok = !this.app.pm.open && this.sel.length === 2 && this.sel.every((s) => (s.kind === 'face' || s.kind === 'edge') && this.partOf(this.C(s.comp) || {}));
    if (!ok) { closePairMeasure(this); return; }
    const [A, B] = this.sel.map((s) => { const c = this.C(s.comp); return entityOf(this.partOf(c).mesh, s.kind, s.id, (p) => M.xfPoint(c, p), (d) => M.qrot(c.rot, d)); });
    showPairMeasure(this, A, B, this.sel.map((s) => s.label || s.key), this.viewSet?.root || this.vp.el);
  }
  // 0.1.116: a component picked in the view or the tree opens in the tree (its "Mates in …"); components opened this
  // way close again when another component is picked; ones the user opened stay. Returns the id to scroll to.
  autoExpandSel(p) {
    if (!p?.comp || p.comp === M.GROUND_ID || p.kind === 'feat' || p.kind === 'plane' || !opt('asmTreeExpandSel')) return null; // rows inside a component: already open, do not scroll the tree under the mouse
    this._compOpen ??= new Map();
    const keep = new Set(this.sel.map((s) => s.comp).filter((id) => id && id !== M.GROUND_ID));
    for (const [id, how] of [...this._compOpen]) if (how === 'auto' && !keep.has(id)) this._compOpen.delete(id);
    for (const id of keep) if (!this._compOpen.has(id)) this._compOpen.set(id, 'auto'); // 0.1.133: also without mates (planes / features)
    this._treeOpen ??= {}; if (this._treeOpen.comps === false) this._treeOpen.comps = true; // Components folder (not stored as a default)
    return p.comp;
  }
  dragStart(d, e) {
    const p = d.pick;
    if (!p) { this._down = null; return; }
    const c = this.C(p.comp);
    if (M.GROUND_ID === p.comp) { this._down = null; return; } // the assembly's own planes do not move
    if (!c || c.fixed) { this._down = null; this.app.setStatus(`${c?.name} is fixed — right-click › Float to move it`); return; }
    const box = this.views.get(c.id).part.geom.boundingBox;
    const center = box.getCenter(new THREE.Vector3()).toArray();
    // radius of every component (rotation part of a move, for the dead-point / branch check); library fasteners
    // are round (they may spin freely about their axis), so only their axis point counts
    const size = new Map(this.doc.components.map((k) => { const b = this.views.get(k.id)?.part?.geom?.boundingBox; return [k.id, k.lib ? 0 : b ? Math.max(1, b.getSize(new THREE.Vector3()).length() / 2) : 100]; }));
    const ab = this.assemblyBox(), aR = ab.isEmpty() ? 0 : ab.getSize(new THREE.Vector3()).length() / 2;
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2, aR * opt('asmDragStepRefPct') / 100); // pieces of a fast move: small parts (washers) use a share of the assembly size
    this.drag = { c, radius, rotate: d.shift, x0: d.x, y0: d.y, grabLocal: M.invPoint(c, p.point), grabWorld: p.point, pos0: [...c.pos], rot0: [...c.rot], centerLocal: center,
      step: { comp: c.id, pts: [], prev: null }, size, stats: { steps: 0, held: 0, jumps: 0, retrace: 0, err: 0, ms: 0, msMax: 0, by: new Set() } };
    this.vp.el.style.cursor = d.shift ? 'grab' : 'move';
    this.dragMove(e);
  }
  dragMove(e) {
    const g = this.drag;
    const r = this.vp.el.getBoundingClientRect();
    const c = g.c;
    let target;
    if (!g.rotate) {
      const n = this.vp.viewDir().toArray();
      const fr = { o: g.grabWorld, n, x: [1, 0, 0], y: [0, 1, 0] };
      const rc = this.vp.ray(e.clientX - r.left, e.clientY - r.top);
      const o = rc.ray.origin.toArray(), dir = rc.ray.direction.toArray();
      const t = M.dot(M.sub(fr.o, o), n) / (M.dot(dir, n) || 1e-9);
      target = [{ local: g.grabLocal, target: M.add(o, M.mulv(dir, t)) }];
    } else {
      const cam = this.vp.camera;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).toArray();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).toArray();
      const dx = (e.clientX - g.x0) * 0.01, dy = (e.clientY - g.y0) * 0.01;
      const q = M.qnorm(M.qmul(M.qmul(M.qexp(M.mulv(up, dx)), M.qexp(M.mulv(right, dy))), g.rot0));
      const ctrW = M.xfPoint({ pos: g.pos0, rot: g.rot0 }, g.centerLocal);
      const pose = { rot: q, pos: M.sub(ctrW, M.qrot(q, g.centerLocal)) };
      target = [[0, 0, 0], [60, 0, 0], [0, 60, 0], [0, 0, 60]].map((v) => { const local = M.add(g.centerLocal, v); return { local, target: M.xfPoint(pose, local) }; });
    }
    // 0.1.117: the mates are never stretched — at the end of travel / a dead point the parts stop
    const t0 = performance.now();
    g.step.pts = target;
    const res = M.dragStep(this.doc.components, this.doc.mates.filter((m) => !this.mateErr?.has(m.id)), g.step, {
      w: opt('asmDragW'), iters: opt('asmDragIters'), fixIters: opt('asmDragFixIters'), tol: opt('asmDragTol'),
      ratio: opt('asmDragRatio'), minMove: opt('asmDragMinMove'), split: opt('asmDragSplit'), size: g.size,
      maxStep: g.radius * opt('asmDragMaxStepPct') / 100, maxPieces: opt('asmDragMaxPieces') });
    const ms = performance.now() - t0, st = g.stats;
    st.steps++; st.ms += ms; st.msMax = Math.max(st.msMax, ms); st.err = Math.max(st.err, res.err || 0);
    if (res.status === 'limit') st.held++; else if (res.status === 'jump') st.jumps++;
    if (res.retrace) st.retrace++;
    if (res.status !== 'ok' || res.retrace) for (const id of res.held) st.by.add(id);
    if (res.status !== 'ok') {
      this.app.setStatus(`${c.name}: end of travel — ${res.status === 'jump' ? 'the mechanism is at a dead point' : 'the mates cannot be held any further'}`);
      g.atLimit = true;
    } else if (g.atLimit) { g.atLimit = false; this.app.setStatus(`${c.name}   ·   drag to move, Shift+drag to rotate`); }
    if (res.part > 0 || res.retrace) { this.updatePoses(); g.moved = true; }
  }
  dragEnd() {
    const g = this.drag;
    this.drag = null;
    this.vp.el.style.cursor = '';
    const st = g.stats;
    if (st?.steps) try {
      const by = [...st.by].map((id) => this.C(id)?.name).filter(Boolean);
      window.__lithLog?.(`DRAG ${g.c.name}${g.rotate ? ' (rotate)' : ''}: ${st.steps} steps, stopped at a limit ${st.held + st.jumps} (mates ${st.held}, dead point/jump ${st.jumps}), retraced ${st.retrace}${by.length ? `, limit set by ${by.join(', ')}` : ''}, max mate error ${st.err.toPrecision(2)} mm, ${(st.ms / st.steps).toFixed(1)} ms avg, ${st.msMax.toFixed(1)} ms max`);
    } catch { /* log optional */ }
    if (!g.moved) return;
    const after = this.doc.components.map((c) => ({ pos: [...c.pos], rot: [...c.rot] }));
    // record undo from the pre-drag state
    g.c.pos = g.pos0; g.c.rot = g.rot0;
    const before = this.snapshot();
    this.doc.components.forEach((c, i) => { c.pos = after[i].pos; c.rot = after[i].rot; });
    this._last = before;
    this.solve();
    this.commit();
  }

  clearHL() { for (const v of this.views.values()) for (const o of [...v.hl.children]) { v.hl.remove(o); o.geometry?.dispose(); } }
  // Options > Colours changed: edges + highlights (component colours stay per component)
  applyColors() {
    this.compGroup?.traverse((o) => { if (o.isLineSegments && !o.userData.hl) o.material.color.setHex(COLORS.edge); });
    this.updateHighlights(); this.vp?.requestRender();
  }
  updateHighlights() {
    this.clearHL();
    const pmItems = this.app.pm.current ? Object.values(this.app.pm.current.selboxes).flatMap((b) => b.items) : [];
    const items = [...this.sel, ...pmItems].map((s) => ({ ...s, col: COLORS.sel }));
    for (const s of this.sel) if (s.kind === 'mate') { const m = this.doc.mates.find((x) => x.id === s.id); if (m) for (const r of [m.a, m.b, m.a2, m.b2]) if (r) items.push({ ...r, col: COLORS.sel }); }
    if (this.hover?.kind === 'mate') { // 0.1.121: a mate row hovered in the tree → its faces / edges, seen through the model
      const m = this.doc.mates.find((x) => x.id === this.hover.id);
      if (m) for (const r of [m.a, m.b, m.a2, m.b2]) if (r) items.push({ ...r, col: COLORS.hover, through: true });
    } else if (this.hover) items.push({ ...this.hover, col: COLORS.hover });
    this.updatePlanes(items.filter((it) => it.kind === 'plane').map((it) => ({ comp: it.comp, id: it.id, col: it.col }))); // 0.1.127
    for (const it of items) {
      const v = this.views.get(it.comp);
      if (!v) continue;
      const mesh = v.part.mesh;
      if (it.kind === 'comp') {
        const g = new THREE.LineSegments(v.part.egeom, new THREE.LineBasicMaterial({ color: it.col, depthTest: false, transparent: true, opacity: 0.8 }));
        g.renderOrder = 3; v.hl.add(g); continue;
      }
      if (it.kind === 'feat') { // 0.1.130: the faces a part feature made on this component
        const idx = [];
        for (const f of mesh.faces) if (f.feat === it.id) for (let k = f.start; k < f.start + f.count; k++) idx.push(mesh.indices[k]);
        if (!idx.length) continue;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', v.part.geom.getAttribute('position')); geom.setIndex(idx);
        v.hl.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: it.col, transparent: true, opacity: 0.45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false })));
        continue;
      }
      if (it.kind === 'face') {
        const f = mesh.faces.find((x) => x.id === it.id);
        if (!f) continue;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', v.part.geom.getAttribute('position'));
        geom.setIndex(Array.from(mesh.indices.slice(f.start, f.start + f.count)));
        const fm = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: it.col, transparent: true, opacity: it.through ? opt('asmMateHoverOpacity') : 0.45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false, depthTest: !it.through }));
        if (it.through) fm.renderOrder = 3;
        v.hl.add(fm);
      } else if (it.kind === 'edge') {
        const ed = mesh.edges.find((x) => x.id === it.id);
        if (!ed) continue;
        const segs = [];
        for (let i = 3; i < ed.pts.length; i += 3) segs.push(...ed.pts.slice(i - 3, i + 3));
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
        const l = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: it.col, depthTest: false, linewidth: 2 }));
        l.renderOrder = 4; v.hl.add(l);
      }
    }
    this.vp.requestRender();
  }

}
