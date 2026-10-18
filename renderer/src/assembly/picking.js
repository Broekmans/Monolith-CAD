// Assembly: picking, dragging, highlights
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
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
              if (this.displayMode === 'wire' || depth <= faceDepth + this.vp.scale * 8) { bd = d; best = { c, ed, w }; }
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
    return null;
  }

  bindViewport() {
    const el = this.vp.el;
    el.addEventListener('pointermove', (e) => {
      if (this.drag) { this.dragMove(e); return; }
      if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 4) { this.dragStart(this._down, e); return; }
      const p = navHeld(e) ? null : this.pickAt(e);
      if ((p?.key || null) !== (this.hover?.key || null)) { this.hover = p; this.updateHighlights(); }
    });
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
  }
  clickItem(p, additive) {
    const pm = this.app.pm.current;
    if (pm) { if (p && pm.offer(p)) this.updateHighlights(); return; }
    if (!p) this.sel = [];
    else if (additive) { const i = this.sel.findIndex((s) => s.key === p.key); if (i >= 0) this.sel.splice(i, 1); else this.sel.push(p); }
    else this.sel = [p];
    this.updateHighlights(); this.renderTree(); this.app.cm.refresh();
    if (p) this.app.setStatus(`${p.label}   ·   drag to move${this.C(p.comp)?.fixed ? ' (fixed)' : ''}, Shift+drag to rotate`);
  }
  dragStart(d, e) {
    const p = d.pick;
    if (!p) { this._down = null; return; }
    const c = this.C(p.comp);
    if (!c || c.fixed) { this._down = null; this.app.setStatus(`${c?.name} is fixed — right-click › Float to move it`); return; }
    const box = this.views.get(c.id).part.geom.boundingBox;
    const center = box.getCenter(new THREE.Vector3()).toArray();
    this.drag = { c, rotate: d.shift, x0: d.x, y0: d.y, grabLocal: M.invPoint(c, p.point), grabWorld: p.point, pos0: [...c.pos], rot0: [...c.rot], centerLocal: center };
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
    M.solveMates(this.doc.components, this.doc.mates.filter((m) => !this.mateErr?.has(m.id)), { drag: { comp: c.id, pts: target, w: 0.05 }, iters: 12 });
    this.updatePoses();
    g.moved = true;
  }
  dragEnd() {
    const g = this.drag;
    this.drag = null;
    this.vp.el.style.cursor = '';
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
    if (this.hover) items.push({ ...this.hover, col: COLORS.hover });
    for (const it of items) {
      const v = this.views.get(it.comp);
      if (!v) continue;
      const mesh = v.part.mesh;
      if (it.kind === 'comp') {
        const g = new THREE.LineSegments(v.part.egeom, new THREE.LineBasicMaterial({ color: it.col, depthTest: false, transparent: true, opacity: 0.8 }));
        g.renderOrder = 3; v.hl.add(g); continue;
      }
      if (it.kind === 'face') {
        const f = mesh.faces.find((x) => x.id === it.id);
        if (!f) continue;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', v.part.geom.getAttribute('position'));
        geom.setIndex(Array.from(mesh.indices.slice(f.start, f.start + f.count)));
        v.hl.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: it.col, transparent: true, opacity: 0.45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false })));
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
