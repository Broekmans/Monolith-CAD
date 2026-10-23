// Origin planes in assemblies (0.1.127): the assembly's own Front / Top / Right Plane (fixed world planes, mate ref
// comp = M.GROUND_ID) and every component's part origin planes (they move with the component). Shown when the tree eye
// is on (doc.planesShown / component.planesShown, saved), when hovered, selected, in the Mate dialog or part of a
// hovered / selected mate. Shown planes can be picked in the view. A plane ref never needs re-matching (rematchAll).
// Methods are mixed into AssemblyDoc (see assembly.js); `this` is the AssemblyDoc.
import * as THREE from 'three';
import { opt } from '../app/options.js';
import * as M from '../../../shared/mates.mjs';
import { COLORS } from './assembly.js';
import { contextMenu } from '../ui.js';

export const PLANE_IDS = ['Front', 'Top', 'Right'];
const X_DIR = { Front: [1, 0, 0], Top: [1, 0, 0], Right: [0, 0, -1] }; // as the part's STD_PLANES
export const planeName = (id) => `${id} Plane`;
export const isGround = (id) => id === M.GROUND_ID;

export class AsmPlanes {
  // a pickable plane item (tree row, view pick, Mate dialog)
  planeItem(comp, id, point = null) {
    return { ...M.planeRef(comp, id), point, key: `${comp}:plane:${id}`, label: `${planeName(id)}@${isGround(comp) ? this.doc.name : this.C(comp)?.name || '?'}` };
  }
  // name of a mate reference's owner in labels: the plane name for the assembly's own planes
  refOwner(r) { return isGround(r?.comp) ? planeName(r.id) : this.C(r?.comp)?.name; }
  CG(id) { return isGround(id) ? M.GROUND : this.C(id); } // component or the assembly itself
  planesShownOf(comp) { return (isGround(comp) ? this.doc.planesShown : this.C(comp)?.planesShown) || []; }
  // tree eye: one undo step, saved with the assembly
  togglePlaneShown(comp, id) {
    const owner = isGround(comp) ? this.doc : this.C(comp);
    if (!owner) return;
    this.beginChange();
    const list = new Set(owner.planesShown || []);
    if (list.has(id)) list.delete(id); else list.add(id);
    if (list.size) owner.planesShown = PLANE_IDS.filter((k) => list.has(k)); else delete owner.planesShown;
    this.commit();
    this.updateHighlights(); this.renderTree();
  }
  // half size of a component's planes: from its part box (like the part's own planes)
  compPlaneSize(v) {
    const b = v?.part?.geom?.boundingBox;
    if (!b) return opt('planeSizeDefault');
    const s = b.getSize(new THREE.Vector3());
    return Math.max(opt('planeSizeMin'), Math.max(s.x, s.y, s.z) * opt('planeSizeFactor'));
  }
  // half size of the assembly planes: reaches past every component (they go through the origin)
  asmPlaneSize() {
    const b = this.assemblyBox();
    if (b.isEmpty()) return opt('planeSizeDefault');
    const r = Math.max(...[b.min, b.max].flatMap((p) => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)]));
    return Math.max(opt('planeSizeMin'), r * opt('asmPlaneSizeFactor'));
  }
  // draw the planes: shown (eye) + highlighted items (list of {comp, id, col}); called from updateHighlights
  updatePlanes(hl = []) {
    if (!this.planeGroup) { this.planeGroup = new THREE.Group(); this.scene.add(this.planeGroup); }
    const groups = [this.planeGroup, ...[...this.views.values()].map((v) => v.planes).filter(Boolean)];
    for (const g of groups) for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    const want = new Map(); // key → {comp, id, col}
    const add = (comp, id, col) => { const k = `${comp}:${id}`; const w = want.get(k); if (!w || col !== COLORS.plane) want.set(k, { comp, id, col }); };
    for (const id of this.doc.planesShown || []) add(M.GROUND_ID, id, COLORS.plane);
    for (const c of this.doc.components) if (!c.hidden) for (const id of c.planesShown || []) add(c.id, id, COLORS.plane);
    for (const h of hl) add(h.comp, h.id, h.col);
    for (const w of want.values()) {
      let g, S;
      if (isGround(w.comp)) { g = this.planeGroup; S = this.asmPlaneSize(); } else {
        const c = this.C(w.comp), v = this.views.get(w.comp);
        if (!c || !v || c.hidden) continue;
        if (!v.planes) { v.planes = new THREE.Group(); v.group.add(v.planes); }
        g = v.planes; S = this.compPlaneSize(v);
      }
      const n = M.ORIGIN_PLANES[w.id], x = X_DIR[w.id], y = M.cross(n, x);
      const corners = [[-S, -S], [S, -S], [S, S], [-S, S]].map(([u, t]) => new THREE.Vector3(x[0] * u + y[0] * t, x[1] * u + y[1] * t, x[2] * u + y[2] * t));
      const mesh = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]),
        new THREE.MeshBasicMaterial({ color: w.col, transparent: true, opacity: opt('planeOpacityPct') / 100, side: THREE.DoubleSide, depthWrite: false }));
      mesh.userData.plane = { comp: w.comp, id: w.id };
      mesh.renderOrder = 2;
      g.add(mesh);
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...corners, corners[0]]), new THREE.LineBasicMaterial({ color: w.col, transparent: true, opacity: opt('planeEdgeOpacity') })));
    }
  }
  planeNormalTo(comp, id) {
    const c = isGround(comp) ? M.GROUND : this.C(comp);
    if (!c) return;
    const n = M.qrot(c.rot, M.ORIGIN_PLANES[id]), x = M.qrot(c.rot, X_DIR[id]);
    this.vp.normalTo({ o: [...c.pos], n, x, y: M.cross(n, x) });
  }
  // tree rows of the three planes of comp (assembly or component) at depth
  planeRows(comp, depth, row, selKeys) {
    const shown = this.planesShownOf(comp);
    return PLANE_IDS.map((id) => {
      const it = this.planeItem(comp, id), on = shown.includes(id);
      return row({
        icon: 'plane', label: planeName(id), depth, sel: selKeys.has(it.key), eye: on, data: { item: it.key },
        tip: isGround(comp) ? `The assembly's ${planeName(id)} — click it with Mate open to mate a part to it` : `${planeName(id)} of ${this.C(comp)?.name} — moves with the component`,
        onEye: () => this.togglePlaneShown(comp, id),
        onClick: (e) => this.clickItem(this.planeItem(comp, id), e.ctrlKey || e.shiftKey),
        onEnter: () => { this.hover = this.planeItem(comp, id); this.updateHighlights(); }, onLeave: () => { this.hover = null; this.updateHighlights(); },
        onMenu: (e) => contextMenu(e.clientX, e.clientY, [
          { label: 'Mate', icon: 'mate', run: () => { const p = this.planeItem(comp, id); if (!this.sel.some((s) => s.key === p.key)) this.sel = [...this.sel.filter((s) => s.geo), p].slice(-4); this.cmdMate(); } },
          { label: 'Normal To', icon: 'normalTo', run: () => this.planeNormalTo(comp, id) },
          { label: on ? 'Hide' : 'Show', icon: on ? 'eyeOff' : 'eye', run: () => this.togglePlaneShown(comp, id) },
        ]),
      });
    });
  }
  // a shown plane under the mouse (only where no face of the model is hit, like in the part)
  pickPlane(rc) {
    const meshes = [this.planeGroup, ...[...this.views.values()].map((v) => (v.group.visible ? v.planes : null))].filter(Boolean).flatMap((g) => g.children.filter((o) => o.userData.plane));
    if (!meshes.length) return null;
    const hit = rc.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const { comp, id } = hit.object.userData.plane;
    return this.planeItem(comp, id, hit.point.toArray());
  }
}
