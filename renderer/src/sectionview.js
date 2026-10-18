// Section View (SolidWorks/Inventor-style): clip the 3D view with a plane.
// Plane = Front/Top/Right, a picked planar face (part or assembly component),
// or a line drawn across the viewport (plane contains the view direction).
// Sections are saved in the document as "Saved Views" (doc.doc.sections) and
// shown in the tree; the active one can be dragged / scrolled on its red cut face.
import * as THREE from 'three';
import { treeRow } from './treeui.js';
import { h, toast, contextMenu, promptText } from './ui.js';
import { icon } from './icons.js';
import { worldGeo } from '../../shared/mates.mjs';
import { secHandleAt } from './section/handles.js';
import { opt } from './app/options.js';

const NORMALS = { Front: [0, 0, 1], Top: [0, 1, 0], Right: [1, 0, 0] };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const r2 = (v) => Math.round(v * 100) / 100;

function sceneBox(doc) {
  const box = new THREE.Box3();
  doc.vp.scene.traverse((o) => { if (o.isMesh && !o.userData.isCap && o.visible && o.geometry && !o.material?.transparent) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
  return box;
}
function facePlane(doc, it) {
  if (!it || it.kind !== 'face') return null;
  if (it.comp && it.geo?.t === 'plane') { const c = doc.C?.(it.comp); if (!c) return null; const g = worldGeo(c, it.geo); return { p: g.p, n: unit(g.n) }; }
  if (it.plane) return { p: it.c || it.plane.origin, n: unit(it.plane.normal) };
  return null;
}
const isPlanarFace = (it) => it.kind === 'face' && (it.plane || it.geo?.t === 'plane');
const list = (doc) => (doc.doc.sections ||= []);
const activeSec = (doc) => list(doc).find((s) => s.id === doc.doc.secActive);
const dirty = (doc) => doc.app.setDirty(true);

function planeOf(s) {
  let n, base = 0;
  if (s.plane === 'Custom' && s.custom) { n = s.custom.n; base = dot(s.custom.p, n); } else n = NORMALS[s.plane] || NORMALS.Front;
  return { n, d: base + (Number(s.offset) || 0) };
}
function applySec(doc, s) {
  const vp = doc.vp;
  if (!s) { vp.section = null; vp.requestRender(); return; }
  const { n, d } = planeOf(s);
  const k = s.flip ? 1 : -1; // default: hide the side the normal points to
  vp.section = { n: n.map((x) => x * k), c: -k * d };
  vp.requestRender();
  ensureHandlers(doc);
}

// ---------- drag / scroll the red cut face, the dotted lines or the arrow (section/handles.js) ----------
function capHit(doc, e) {
  const vp = doc.vp, sec = vp.section;
  if (!sec) return null;
  const r = vp.el.getBoundingClientRect();
  const rc = vp.ray(e.clientX - r.left, e.clientY - r.top);
  const meshes = [];
  vp.scene.traverse((o) => { if (o.isMesh && !o.userData.isCap && o.visible && !o.material?.transparent && o.material?.side === THREE.DoubleSide) meshes.push(o); });
  const plane = new THREE.Plane(new THREE.Vector3(...sec.n), sec.c);
  for (const hit of rc.intersectObjects(meshes, false)) {
    if (plane.distanceToPoint(hit.point) < -1e-6) continue; // clipped away
    if (!hit.face) return null;
    const nW = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return nW.dot(rc.ray.direction) > 0 ? hit : null; // back face = cut surface
  }
  return null;
}
function ensureHandlers(doc) {
  if (doc._secHandlers) return;
  const vp = doc.vp, el = vp.el;
  let drag = null;
  const step = () => { const b = sceneBox(doc); return b.isEmpty() ? 1 : Math.max(0.1, r2(b.getSize(new THREE.Vector3()).length() * opt('secStepPct') / 100)); };
  const paneOf = (e) => vp.viewset?.paneOf(e.target) || vp.pane || vp;
  const handleAt = (e) => { const pn = paneOf(e), r = pn.el.getBoundingClientRect(); return secHandleAt(pn, [e.clientX - r.left, e.clientY - r.top]); };
  let hovPane = null;
  const setHover = (pn, k) => {
    if (hovPane && (hovPane !== pn || hovPane._secHover !== k)) { hovPane._secHover = null; hovPane.requestRender(); }
    if (pn && pn._secHover !== k) { pn._secHover = k; pn.requestRender(); }
    hovPane = k ? pn : null;
  };
  const move = (s, delta) => { s.offset = r2((Number(s.offset) || 0) + delta); applySec(doc, s); doc.app.pm.current?.setValue?.('offset', s.offset); doc.app.setStatus(`${s.name}: offset ${s.offset} mm`); };
  const cur = () => (doc._secPM ? doc._secDraft : activeSec(doc));
  const down = (e) => {
    if (e.button !== 0 || e.altKey || doc._secDraw || !vp.section || !cur()) return;
    const handle = handleAt(e);
    if (!handle && !capHit(doc, e)) return;
    e.stopPropagation(); e.preventDefault();
    const s = cur();
    const { n } = planeOf(s);
    const k = s.flip ? -1 : 1;
    const ctr = sceneBox(doc).getCenter(new THREE.Vector3()).toArray();
    const a = vp.toScreen(ctr), b = vp.toScreen(ctr.map((v, i) => v + n[i]));
    const sd = [b[0] - a[0], b[1] - a[1]];
    const pn = paneOf(e);
    drag = { s, x: e.clientX, y: e.clientY, off0: Number(s.offset) || 0, sd, len2: sd[0] ** 2 + sd[1] ** 2, k, pn, handle, scale: pn.scale };
    el.setPointerCapture?.(e.pointerId);
    el.style.cursor = 'grabbing';
    if (handle) setHover(pn, handle);
  };
  const mv = (e) => {
    if (drag) {
      e.stopPropagation();
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      // looking (almost) straight along the normal: mouse up/down moves the plane (1 px = 1 screen pixel in mm)
      const delta = drag.len2 < 4 ? -dy * drag.scale * (drag.s.flip ? -1 : 1) : (dx * drag.sd[0] + dy * drag.sd[1]) / drag.len2;
      drag.s.offset = drag.off0; move(drag.s, delta);
      const r = drag.pn.el.getBoundingClientRect();
      drag.pn._secLabel = [e.clientX - r.left, e.clientY - r.top, `${drag.s.offset} mm`];
      return;
    }
    if (vp.section && cur() && !doc._secDraw && !e.buttons) {
      const k = handleAt(e);
      setHover(paneOf(e), k);
      el.style.cursor = k ? 'move' : capHit(doc, e) ? 'grab' : '';
    }
  };
  const up = (e) => {
    if (!drag) return;
    e.stopPropagation();
    drag.pn._secLabel = null; drag.pn.requestRender();
    drag = null; el.style.cursor = '';
    if (!doc._secPM) { dirty(doc); doc.renderTree?.(); }
  };
  const wheel = (e) => {
    if (!vp.section || !cur() || (!handleAt(e) && !capHit(doc, e))) return;
    e.stopPropagation(); e.preventDefault();
    const s = cur();
    move(s, (e.deltaY < 0 ? 1 : -1) * step() * (e.shiftKey ? 0.1 : 1) * (s.flip ? -1 : 1));
    if (!doc._secPM) { clearTimeout(doc._secWheelT); doc._secWheelT = setTimeout(() => { dirty(doc); doc.renderTree?.(); }, 400); }
  };
  el.addEventListener('pointerdown', down, true);
  el.addEventListener('pointermove', mv, true);
  el.addEventListener('pointerup', up, true);
  el.addEventListener('wheel', wheel, { capture: true, passive: false });
  doc._secHandlers = true;
}

// ---------- commands ----------
export function toggleSection(doc) {
  if (doc._secPM) return;
  if (doc.vp.section && !doc.app.pm.open) { doc.doc.secActive = null; applySec(doc, null); dirty(doc); doc.renderTree?.(); doc.app.cm.refresh(); doc.app.setStatus('Section view off'); return; }
  if (doc.app.pm.open) { toast('Close the open PropertyManager first'); return; }
  const n = list(doc).reduce((m, s) => Math.max(m, +(s.name.match(/(\d+)$/)?.[1] || 0)), 0) + 1;
  const ctr = sceneBox(doc).getCenter(new THREE.Vector3()).toArray();
  const s = { id: 'sv' + Date.now().toString(36), name: `Cross section ${n}`, plane: 'Front', offset: r2(ctr[2] || 0), flip: false, custom: null };
  const selFace = doc.sel?.find(isPlanarFace);
  const fp = selFace && facePlane(doc, selFace);
  if (fp) Object.assign(s, { plane: 'Custom', offset: 0, custom: { ...fp, label: selFace.label || 'Face' } });
  openPM(doc, s, null);
}
export function editSection(doc, id) {
  if (doc.app.pm.open) { toast('Close the open PropertyManager first'); return; }
  const s = list(doc).find((x) => x.id === id);
  if (s) openPM(doc, JSON.parse(JSON.stringify(s)), s);
}
function activate(doc, id) {
  doc.doc.secActive = doc.doc.secActive === id ? null : id;
  applySec(doc, activeSec(doc) || null);
  dirty(doc); doc.renderTree?.(); doc.app.cm.refresh();
}

function openPM(doc, st, orig) {
  const vp = doc.vp;
  const prevActive = doc.doc.secActive;
  const ctr = sceneBox(doc).getCenter(new THREE.Vector3()).toArray();
  const values = { name: st.name, plane: st.plane, offset: st.offset, flip: st.flip, face: [] };
  doc._secDraft = st;
  const apply = () => applySec(doc, st);
  const setCustom = (custom) => {
    st.custom = custom; st.plane = 'Custom'; st.offset = 0;
    const pm = doc.app.pm.current;
    pm?.setValue('plane', 'Custom'); pm?.setValue('offset', 0);
    pm?.setMessage(`Plane: ${custom.label}. Drag the red lines / arrow or the cut face to move it.`);
    apply();
  };
  const endDraw = () => {
    const dr = doc._secDraw;
    if (!dr) return;
    const el = vp.el;
    el.removeEventListener('pointerdown', dr.down, true); el.removeEventListener('pointermove', dr.move, true); el.removeEventListener('pointerup', dr.up, true);
    vp.overlayDrawers = vp.overlayDrawers.filter((f) => f !== dr.draw);
    el.style.cursor = '';
    doc._secDraw = null;
    vp.requestRender();
  };
  const startDraw = () => {
    endDraw();
    const el = vp.el;
    const dr = { a: null, b: null };
    const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    dr.down = (e) => {
      if (e.button !== 0 || e.altKey) return;
      e.stopPropagation(); e.preventDefault();
      if (!dr.a) { dr.a = pos(e); dr.b = dr.a; vp.requestRender(); return; }
      dr.b = pos(e);
      if (Math.hypot(dr.b[0] - dr.a[0], dr.b[1] - dr.a[1]) < 4) return;
      const A = vp.ray(...dr.a).ray.origin, B = vp.ray(...dr.b).ray.origin;
      const n = unit(B.clone().sub(A).cross(vp.viewDir()).toArray());
      endDraw();
      setCustom({ p: A.toArray(), n, label: 'drawn line' });
    };
    dr.move = (e) => { if (dr.a) { dr.b = pos(e); vp.requestRender(); } };
    dr.up = (e) => { if (e.button === 0) e.stopPropagation(); };
    dr.draw = (ctx) => {
      if (!dr.a) return;
      ctx.strokeStyle = '#d03a2a'; ctx.lineWidth = 2; ctx.setLineDash([10, 4, 2, 4]);
      ctx.beginPath(); ctx.moveTo(...dr.a); ctx.lineTo(...dr.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#d03a2a'; for (const p of [dr.a, dr.b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 7); ctx.fill(); }
    };
    el.addEventListener('pointerdown', dr.down, true); el.addEventListener('pointermove', dr.move, true); el.addEventListener('pointerup', dr.up, true);
    vp.overlayDrawers.push(dr.draw);
    el.style.cursor = 'crosshair';
    doc._secDraw = dr;
    doc.app.pm.current?.setMessage('Click two points in the viewport to draw the cut line.');
  };
  const close = (ok) => {
    endDraw();
    doc._secPM = false; doc._secDraft = null;
    if (ok) {
      doc.beginChange?.();
      if (orig) Object.assign(orig, st); else list(doc).push(st);
      doc.doc.secActive = st.id;
      doc.commit?.();
      dirty(doc);
    } else doc.doc.secActive = prevActive;
    applySec(doc, activeSec(doc) || null);
    setTimeout(() => { if (!doc.app.pm.open) doc.app.showPanel('tree'); doc.renderTree?.(); doc.app.cm.refresh(); }, 0);
  };
  doc._secPM = true;
  doc.app.pm.show({
    title: orig ? `Edit ${st.name}` : 'Section View', iconName: 'section', values,
    fields: [
      { key: 'name', type: 'text', label: 'Name' },
      { key: 'face', type: 'selbox', label: 'Section face (click a planar face)', max: 1, accepts: isPlanarFace },
      { type: 'buttons', buttons: [{ label: 'Draw cut line', icon: 'line', tip: 'Click two points in the viewport; the cut goes through that line, straight into the screen', run: () => startDraw() }] },
      { key: 'plane', type: 'select', label: 'Section plane', options: [{ value: 'Front', label: 'Front Plane' }, { value: 'Top', label: 'Top Plane' }, { value: 'Right', label: 'Right Plane' }, { value: 'Custom', label: 'Face / drawn line' }] },
      { key: 'offset', type: 'number', label: 'Offset', unit: 'mm', step: 1 },
      { key: 'flip', type: 'check', label: 'Flip side' },
      { type: 'info', text: 'Drag the red dotted lines, the red arrow or the cut face (or scroll the mouse wheel over them) to move the section. It is saved under "Saved Views" in the tree.' },
    ],
    onChange: (v, key) => {
      if (key === 'name') { st.name = v.name || st.name; return; }
      if (key === 'face') { const it = v.face[0]; const fp = facePlane(doc, it); if (fp) setCustom({ ...fp, label: it.label || 'Face' }); return; }
      if (key === 'plane') {
        if (v.plane === 'Custom' && !st.custom) { doc.app.pm.current.setMessage('Click a planar face or use Draw cut line first.', 'error'); doc.app.pm.current.setValue('plane', st.plane); return; }
        st.plane = v.plane;
        st.offset = v.plane === 'Custom' ? 0 : r2(dot(ctr, NORMALS[v.plane]));
        doc.app.pm.current.setValue('offset', st.offset);
      }
      if (key === 'offset') st.offset = v.offset;
      if (key === 'flip') st.flip = v.flip;
      apply();
    },
    onOk: () => close(true),
    onCancel: () => close(false),
  });
  doc.app.showPanel('pm');
  apply();
}

// ---------- "Saved Views" rows for the FeatureManager / assembly tree ----------
export function sectionTreeRows(doc) {
  const secs = list(doc);
  // keep the viewport in step with the document (load, undo/redo)
  if (!doc._secPM) { const a = activeSec(doc); const want = !!a; if (want || doc.vp?.section) applySec(doc, a || null); }
  const frag = document.createDocumentFragment();
  if (!secs.length) return frag;
  doc._secOpen ??= true;
  const row = (depth, ic, label, opts = {}) => treeRow({ ...opts, depth, icon: ic, label, onEye: opts.eye !== undefined ? opts.onClick : undefined });
  frag.appendChild(row(1, 'folder', 'Saved Views', { count: secs.length, twisty: doc._secOpen, onTwisty: () => { doc._secOpen = !doc._secOpen; doc.renderTree(); } }));
  if (doc._secOpen) for (const s of secs) {
    const on = doc.doc.secActive === s.id;
    frag.appendChild(row(2, 'section', s.name, {
      sel: on, dim: !on, eye: on, tip: 'Click to turn on/off · double-click to edit',
      onClick: () => activate(doc, s.id),
      onDbl: () => editSection(doc, s.id),
      onMenu: (e) => contextMenu(e.clientX, e.clientY, [
        { label: on ? 'Turn Off' : 'Turn On', icon: on ? 'eyeOff' : 'eye', run: () => activate(doc, s.id) },
        { label: 'Edit Section…', icon: 'section', run: () => editSection(doc, s.id) },
        { label: 'Flip Side', run: () => { s.flip = !s.flip; if (on) applySec(doc, s); dirty(doc); } },
        { label: 'Rename…', run: async () => { const nm = await promptText('Section name', s.name); if (nm) { doc.beginChange?.(); s.name = nm; doc.commit?.(); doc.renderTree(); } } },
        '-', { label: 'Delete', icon: 'delete', run: () => { doc.beginChange?.(); doc.doc.sections = secs.filter((x) => x !== s); if (on) { doc.doc.secActive = null; applySec(doc, null); } doc.commit?.(); dirty(doc); doc.renderTree(); } },
      ]),
    }));
  }
  return frag;
}
