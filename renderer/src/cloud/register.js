// Point cloud registration (Register tab, mixed into CloudDoc; `this` is the CloudDoc).
// Align Clouds: a moving cloud onto a reference cloud. Align Part: a part/assembly onto a scan (the part
// moves, the scan keeps its coordinates). Both: point pairs (live least-squares solve) and/or ICP
// refinement (main/cloudio.cjs registerCloud, worker kernel/cloud/register.mjs).
// Results: cloud -> rec.transform (absolute, baked at edits/export) + rec.registration;
// part -> doc.partAlign[file] = 4x4 (document frame, column-major), used by Cloud to Part.
import * as THREE from 'three';
import { h, fmt, toast } from '../ui.js';
import { api } from '../api.js';
import { opt, optHex } from '../app/options.js';
import { SCAN_TO_WORLD } from './layer.js';
import { loadPart } from '../assembly/assembly.js';
import { IDENT, apply, compose, invert, solvePairs, fromFrame, toFrame, angleDeg } from '../../../shared/rigid.mjs';

const mm = (v) => (v === v ? fmt(v * 1000, opt('pcMmDec')) + ' mm' : '—');
const fileName = (p) => p.split(/[\\/]/).pop();
// {R,t} (document frame) <-> THREE.Matrix4
const toM4 = (T) => new THREE.Matrix4().set(T.R[0], T.R[1], T.R[2], T.t[0], T.R[3], T.R[4], T.R[5], T.t[1], T.R[6], T.R[7], T.R[8], T.t[2], 0, 0, 0, 1);

class PairTool {
  constructor(doc, st) {
    this.doc = doc; this.vp = doc.vp; this.st = st; this.hover = null; this.raf = 0;
    this.draw = (ctx) => doc.drawPairs(ctx, this.hover);
    this.vp.overlayDrawers.push(this.draw);
    const el = this.vp.el;
    this.onMove = (e) => {
      const r = el.getBoundingClientRect(); const xy = [e.clientX - r.left, e.clientY - r.top];
      if (e.buttons) return;
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.hover = doc.regPick(...xy); this.vp.requestRender(); });
    };
    this.onDown = (e) => {
      if (e.button !== 0 || e.altKey) return;
      const r = el.getBoundingClientRect();
      const hit = doc.regPick(e.clientX - r.left, e.clientY - r.top);
      if (!hit) { doc.app.setStatus(st.half ? 'Click the same spot on the reference (blue)' : `Click a point on the ${st.part ? 'part' : 'moving cloud'} (orange)`); return; }
      doc.regClick(hit);
    };
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    el.style.cursor = 'crosshair';
  }
  onKey(e) { if (e.key === 'Backspace') { this.doc.regUndoPick(); return true; } return false; }
  onContext() { return true; }
  dispose() {
    const el = this.vp.el;
    cancelAnimationFrame(this.raf);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerdown', this.onDown);
    el.style.cursor = '';
    this.vp.overlayDrawers = this.vp.overlayDrawers.filter((d) => d !== this.draw);
    this.vp.requestRender();
  }
}

export class CloudRegister {
  registerTab() {
    const C = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
    const idle = () => !this.app.pm.open && !this.tool && !this.busy;
    const loaded = () => this.doc.clouds.filter((r) => this.layers.has(r.id));
    return { name: 'Register', groups: [
      [C('regClouds', 'Align Clouds', 'mate', () => this.cmdRegister('cloud'), { enabled: () => idle() && loaded().length >= 2, tip: 'Align one cloud to another: pick 3 or more matching point pairs and/or refine with ICP' })],
      [C('regPart', 'Align Part', 'mate', () => this.cmdRegister('part'), { enabled: () => idle() && loaded().length >= 1, tip: 'Put a part or assembly on the scan with point pairs and ICP (the part moves; used by Cloud to Part)' })],
      [C('regReport', 'Report', 'export', () => this.exportRegReport(), { enabled: () => !!this.selRec()?.registration, tip: 'Save the registration result (matrix, RMS) of the selected cloud as a text file' })],
      [C('undo', 'Undo', 'undo', () => this.undo(), { enabled: () => idle() && this.undoStack.length > 0 }),
        C('redo', 'Redo', 'redo', () => this.redo(), { enabled: () => idle() && this.redoStack.length > 0 })],
    ] };
  }

  // ---------------- the registration session ----------------
  // st: {part, mov (rec | null), ref (rec), base (abs {R,t} of the moving cloud | doc 4x4 of the part),
  //      D (abs frame correction), pairs [{a, b}] (a: moving side at base, abs; b: reference, abs), half}
  cmdRegister(kind) {
    this.app.pm.close(false); this.endTool();
    const part = kind === 'part';
    const clouds = this.doc.clouds.filter((r) => this.layers.has(r.id));
    const sel = this.targets()[0];
    const st = { part, pairs: [], half: null, D: IDENT(), icp: null, snap: this.snapshot() };
    this.reg = st;
    if (part) {
      st.ref = sel && this.layers.has(sel.id) ? sel : clouds.find((r) => r.visible !== false) || clouds[0];
      st.files = (this.app.tabs || []).filter((t) => t.path && /\.lith(prt|asm)$/i.test(t.path)).map((t) => t.path);
      st.file = st.files[0] || null;
    } else {
      st.mov = sel && this.layers.has(sel.id) ? sel : clouds[clouds.length - 1];
      st.ref = clouds.find((r) => r.id !== st.mov.id && r.visible !== false) || clouds.find((r) => r.id !== st.mov.id);
      st.base = st.mov.transform ? JSON.parse(JSON.stringify(st.mov.transform)) : null;
      for (const r of [st.mov, st.ref]) if (r.visible === false) { r.visible = true; this.layers.get(r.id).applyStyle(); }
    }
    const opts = (list) => list.map((r) => ({ value: r.id, label: r.name }));
    const sp = Math.max(opt('pcMinSpacing'), this.spacingEstimate(this.layers.get(st.ref.id)));
    const pm = this.app.pm.show({
      title: part ? 'Align Part' : 'Align Clouds', iconName: part ? 'part' : 'cloud',
      values: { mov: st.mov?.id, ref: st.ref.id, file: st.file || '', level: false, maxDist: part ? opt('pcIcpPartDist') : opt('pcIcpCloudDist'), iters: opt('pcIcpIters'), overlap: opt('pcIcpOverlap') },
      message: part ? 'Click a point on the part (orange), then the same spot on the scan (blue). 3 pairs or more; then Refine. The scan keeps its coordinates.'
        : 'Click a point on the moving cloud (orange), then the same spot on the reference (blue). 3 pairs or more; then Refine. Backspace removes the last click.',
      fields: [
        ...(part ? [
          ...(st.files.length ? [{ key: 'file', type: 'select', label: 'Part', options: st.files.map((f) => ({ value: f, label: fileName(f) })) }] : []),
          { type: 'buttons', buttons: [{ label: 'Choose part or assembly file…', icon: 'open', run: async () => { const f = await api.openFile({ filters: [{ name: 'Parts and assemblies', extensions: ['lithprt', 'lithasm', 'ekprt', 'ekasm'] }], noRead: true }); if (f) await this.regLoadPart(f.path); } }] },
          { type: 'info', key: 'pinfo', text: '' },
          { key: 'ref', type: 'select', label: 'Scan', options: opts(clouds) },
          { type: 'buttons', buttons: [{ label: 'Put part on the scan', icon: 'move', run: () => { this.regSnapPart(); } }] },
        ] : [
          { key: 'mov', type: 'select', label: 'Moving cloud', options: opts(clouds) },
          { key: 'ref', type: 'select', label: 'Reference (stays)', options: opts(clouds) },
        ]),
        { key: 'level', type: 'check', label: 'Level only (rotate about Z, keep tilt)' },
        { type: 'info', key: 'pairs', text: '' },
        { type: 'buttons', buttons: [{ label: 'Clear pairs', icon: 'delete', run: () => { st.pairs = []; st.half = null; this.regSolve(); } }] },
        { type: 'group', label: 'Refine (ICP)', fields: [
          { key: 'maxDist', type: 'number', label: 'Start search distance', unit: 'cm', min: 0.1, step: 5 },
          { key: 'iters', type: 'number', label: 'Max. iterations', min: 1, step: 10 },
          { key: 'overlap', type: 'number', label: 'Overlap', unit: '%', min: 10, step: 5 },
          { type: 'buttons', buttons: [{ label: 'Refine with ICP', icon: 'rotate', run: () => this.regICP() }] },
          { type: 'info', key: 'icp', text: `The clouds must already be roughly aligned (within the start search distance). Typical point spacing: ${fmt(sp * 100, opt('pcSpacingDec'))} cm.` }] },
      ],
      onChange: (v, key) => this.regChange(v, key),
      onOk: () => this.regApply(),
      onCancel: () => this.regEnd(true),
    });
    st.pm = pm;
    this.tool = new PairTool(this, st);
    if (part) { pm.inputs.pinfo.textContent = st.file ? '' : 'Choose a part.'; if (st.file) this.regLoadPart(st.file); }
    this.regSolve();
    this.app.cm.refresh();
  }
  regChange(v, key) {
    const st = this.reg; if (!st) return;
    if (key === 'level') { this.regSolve(); return; }
    if (key === 'file') { this.regLoadPart(v.file); return; }
    if (key === 'mov' || key === 'ref') {
      const pick = (id) => this.doc.clouds.find((r) => r.id === id);
      if (!st.part) {
        if (v.mov === v.ref) { st.pm.setMessage('Moving cloud and reference must be different', 'error'); return; }
        if (key === 'mov') { this.regRestoreMov(); st.mov = pick(v.mov); st.base = st.mov.transform ? JSON.parse(JSON.stringify(st.mov.transform)) : null; }
        else st.ref = pick(v.ref);
      } else st.ref = pick(v.ref);
      for (const r of [st.mov, st.ref]) if (r && r.visible === false) { r.visible = true; this.layers.get(r.id).applyStyle(); }
      st.pairs = []; st.half = null; st.D = IDENT(); st.icp = null;
      st.pm.setMessage('');
      this.regSolve();
    }
  }
  // moving cloud back to where it was when the session started
  regRestoreMov() { const st = this.reg; if (!st?.mov) return; st.mov.transform = st.base ? JSON.parse(JSON.stringify(st.base)) : null; this.layers.get(st.mov.id)?.setPlacement(); this.scheduleLOD(); }

  // ---------------- part ----------------
  async regLoadPart(file) {
    const st = this.reg; if (!st) return;
    st.file = file;
    const info = st.pm.inputs.pinfo;
    info.textContent = 'Loading part…';
    const r = await loadPart(file);
    if (this.reg !== st) return;
    if (r.err) { info.textContent = 'Cannot use this file: ' + r.err; st.mesh = null; return; }
    st.mesh = r.mesh;
    if (!st.preview) { st.preview = new THREE.Group(); st.preview.matrixAutoUpdate = false; this.overlay.add(st.preview); }
    st.preview.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    st.preview.clear();
    // geometry in the document frame (m, Z up)
    const P = r.mesh.positions, Q = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) { Q[i] = P[i] / 1000; Q[i + 1] = -P[i + 2] / 1000; Q[i + 2] = P[i + 1] / 1000; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Q, 3));
    g.setIndex(new THREE.BufferAttribute(r.mesh.indices, 1));
    g.computeBoundingBox();
    st.partBox = g.boundingBox.clone();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: opt('pcPartFillColor'), transparent: true, opacity: opt('pcPartOpacityAlign'), depthWrite: false, side: THREE.DoubleSide }));
    st.pickMesh = mesh;
    st.preview.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, opt('pcPartEdgeAngle')), new THREE.LineBasicMaterial({ color: optHex('pcPartEdgeColor'), depthTest: false, transparent: true }));
    edges.renderOrder = 10; st.preview.add(edges);
    const b = st.partBox;
    info.textContent = `${fileName(file)}: ${(r.mesh.indices.length / 3).toLocaleString()} triangles, ${fmt(b.max.x - b.min.x, opt('pcSizeDec'))} × ${fmt(b.max.y - b.min.y, opt('pcSizeDec'))} × ${fmt(b.max.z - b.min.z, opt('pcSizeDec'))} m`;
    const saved = this.doc.partAlign?.[file];
    st.pairs = []; st.half = null; st.D = IDENT(); st.icp = null;
    if (saved) st.base = new THREE.Matrix4().fromArray(saved);
    else { st.base = new THREE.Matrix4(); this.regSnapPart(true); }
    this.regSolve();
  }
  // rough start: part centre on the scan centre (plan), bottoms level
  regSnapPart(keep) {
    const st = this.reg; if (!st?.partBox) return;
    const pb = st.partBox.clone().applyMatrix4(keep ? new THREE.Matrix4() : this.regPartMatrix()), b = this.layers.get(st.ref.id).docBox();
    const d = new THREE.Vector3((b.min.x + b.max.x) / 2 - (pb.min.x + pb.max.x) / 2, (b.min.y + b.max.y) / 2 - (pb.min.y + pb.max.y) / 2, b.min.z - pb.min.z);
    st.base = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(keep ? new THREE.Matrix4() : this.regPartMatrix());
    st.pairs = []; st.half = null; st.D = IDENT(); st.icp = null;
    this.regSolve();
  }
  // current part placement (document frame): D (abs -> doc frame) * base
  regPartMatrix() { const st = this.reg; return toM4(toFrame(st.D, this.doc.origin)).multiply(st.base); }

  // ---------------- picking ----------------
  regPick(sx, sy) {
    const st = this.reg; if (!st) return null;
    const movSide = !st.half;
    if (movSide && st.part) {
      if (!st.pickMesh) return null;
      const rc = new THREE.Raycaster(), W = this.vp.width, H = this.vp.height;
      rc.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), this.vp.camera);
      st.preview.updateMatrixWorld(true);
      const hit = rc.intersectObject(st.pickMesh, false)[0];
      if (!hit) return null;
      const p = hit.point.clone().applyMatrix4(new THREE.Matrix4().copy(SCAN_TO_WORLD).invert()), o = this.doc.origin;
      return { abs: [p.x + o[0], p.y + o[1], p.z + o[2]], side: 'mov' };
    }
    const L = this.layers.get((movSide ? st.mov : st.ref).id);
    const r = L?.pickNear(this.vp, sx, sy);
    if (!r) return null;
    const o = this.doc.origin;
    return { abs: [r.doc[0] + o[0], r.doc[1] + o[1], r.doc[2] + o[2]], side: movSide ? 'mov' : 'ref' };
  }
  regClick(hit) {
    const st = this.reg;
    if (hit.side === 'mov') st.half = apply(invert(st.D), hit.abs); // back to the start placement
    else { st.pairs.push({ a: st.half, b: hit.abs }); st.half = null; }
    this.regSolve();
  }
  regUndoPick() { const st = this.reg; if (!st) return; if (st.half) st.half = null; else st.pairs.pop(); this.regSolve(); }
  // (tests) add a pair directly: a = moving side at its start placement, b = reference (absolute)
  regAddPair(a, b) { this.reg.pairs.push({ a, b }); this.regSolve(); }

  // ---------------- solving ----------------
  regSolve() {
    const st = this.reg; if (!st) return;
    const level = !!st.pm.values.level;
    const need = level ? 2 : 3;
    if (st.pairs.length >= need) {
      const r = solvePairs(st.pairs.map((p) => p.a), st.pairs.map((p) => p.b), { level });
      if (r) { st.D = { R: r.R, t: r.t }; st.solve = r; st.icp = null; }
    } else { st.solve = null; if (!st.icp) st.D = IDENT(); }
    this.regPlace();
    this.regPanel();
  }
  regPlace() {
    const st = this.reg;
    if (st.part) {
      if (st.preview && st.base) { st.preview.matrix.copy(SCAN_TO_WORLD).multiply(this.regPartMatrix()); st.preview.matrixWorldNeedsUpdate = true; }
    } else {
      st.mov.transform = compose(st.D, st.base || IDENT());
      this.layers.get(st.mov.id).setPlacement();
      this.scheduleLOD();
    }
    this.vp.requestRender();
  }
  regPanel() {
    const st = this.reg, el = st.pm.inputs.pairs, level = !!st.pm.values.level;
    el.innerHTML = '';
    const need = level ? 2 : 3;
    const rows = st.pairs.map((p, i) => h('div', { class: 'pp-row ro' }, h('label', {}, `Pair ${i + 1}`),
      h('span', {}, st.solve ? mm(st.solve.res[i]) : '—', ' ', h('button', { class: 'mini txt', title: 'Remove this pair', onclick: () => { st.pairs.splice(i, 1); this.regSolve(); } }, '×'))));
    el.append(...rows);
    let msg = st.pairs.length < need ? `${st.pairs.length} pair${st.pairs.length === 1 ? '' : 's'} – ${need - st.pairs.length} more needed${st.half ? ' (now click the reference)' : ''}.`
      : `${st.pairs.length} pairs · RMS ${mm(st.solve?.rms)}${st.half ? ' · now click the reference' : ''}`;
    if (st.solve) msg += ` · rotation ${fmt(angleDeg(st.D.R), opt('pcRegDec'))}° · shift ${fmt(Math.hypot(...this.regShift()), opt('pcRegDec'))} m`;
    el.append(h('div', { class: 'pm-info' }, msg));
    if (st.solve && st.pairs.length > need) {
      const worst = st.solve.res.indexOf(Math.max(...st.solve.res));
      if (st.solve.res[worst] > opt('pcPairOutlierK') * st.solve.rms && st.solve.res[worst] > opt('pcPairOutlierMin')) el.append(h('div', { class: 'pm-msg error' }, `Pair ${worst + 1} does not fit the others well – check or remove it.`));
    }
  }
  // movement of the moving side's centre (m), for display
  regShift() {
    const st = this.reg;
    let c;
    if (st.part) { if (!st.partBox) return [0, 0, 0]; const v = st.partBox.getCenter(new THREE.Vector3()).applyMatrix4(st.base); c = [v.x + this.doc.origin[0], v.y + this.doc.origin[1], v.z + this.doc.origin[2]]; } else { const b = this.layers.get(st.mov.id).box, m = this.layers.get(st.mov.id).meta.origin; c = apply(st.base || IDENT(), [(b.min.x + b.max.x) / 2 + m[0], (b.min.y + b.max.y) / 2 + m[1], (b.min.z + b.max.z) / 2 + m[2]]); }
    const q = apply(st.D, c); return [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
  }
  async regICP() {
    const st = this.reg; if (!st || this.busy) return;
    const v = st.pm.values;
    if (!(v.maxDist > 0)) return;
    if (st.part && !st.mesh) { st.pm.setMessage('Choose a part first', 'error'); return; }
    const O = this.doc.origin;
    let mov;
    if (st.part) {
      const M = this.regPartMatrix(), P = st.pickMesh.geometry.getAttribute('position').array, I = st.mesh.indices, tris = new Float32Array(I.length * 3), q = new THREE.Vector3();
      for (let k = 0; k < I.length; k++) { q.fromArray(P, I[k] * 3).applyMatrix4(M); tris[k * 3] = q.x; tris[k * 3 + 1] = q.y; tris[k * 3 + 2] = q.z; }
      mov = { tris };
    } else mov = { cloud: { id: this.layers.get(st.mov.id).id, transform: st.mov.transform || null } };
    const spec = { mov, ref: { cloud: { id: this.layers.get(st.ref.id).id, transform: st.ref.transform || null } }, docOrigin: O, maxDist: v.maxDist / 100, iters: Math.round(v.iters), overlap: Math.max(opt('pcIcpOverlapMin'), Math.min(1, v.overlap / 100)), level: !!v.level, minDist: Math.max(opt('pcIcpMinDistMin'), this.spacingEstimate(this.layers.get(st.ref.id)) / opt('pcIcpMinDistDiv')) };
    const req = Math.random();
    this.busy = true; this.app.setBusy(true); this.app.cm.refresh();
    const off = api.onCloudProgress((p) => { if (p.req === req) this.showProgress('Refine (ICP)', p); });
    let r;
    try { r = await api.cloudRegister(spec, req); } catch (e) { r = { error: e.message }; } finally { off?.(); this.showProgress(null); this.app.setBusy(false); this.busy = false; this.app.cm.refresh(); }
    if (this.reg !== st) return;
    const out = st.pm.inputs.icp;
    if (!r || r.error) { out.textContent = 'ICP failed: ' + (r?.error || 'unknown error'); return; }
    if (!(r.rms === r.rms)) { out.textContent = 'ICP found too few matching points. Align roughly with point pairs first, or use a larger start search distance.'; return; }
    // r.T is a document-frame correction on top of the current placement
    st.D = compose(fromFrame(r.T, O), st.D);
    st.icp = r; st.solve = null; st.pairs = [];
    this.regPlace(); this.regPanel();
    out.textContent = `ICP: RMS ${mm(r.rms)} · overlap ${fmt(r.overlap * 100, opt('pcOverlapDec'))}% · ${r.iterations} iterations · ${r.sample.toLocaleString()} sample points (${fmt(r.seconds, opt('pcSecDec'))} s). Total: rotation ${fmt(angleDeg(st.D.R), opt('pcRegDec'))}°, shift ${fmt(Math.hypot(...this.regShift()), opt('pcRegDec'))} m.`;
    if (r.overlap < opt('pcIcpLowOverlap')) out.textContent += ' Low overlap: check the result.';
    this.regLast = r; // (tests)
  }
  regApply() {
    const st = this.reg; if (!st) return true;
    if (st.part) {
      if (!st.mesh || !st.base) { st.pm.setMessage('Choose a part first', 'error'); return false; }
      this.doc.partAlign ||= {};
      this.doc.partAlign[st.file] = this.regPartMatrix().toArray();
      this.undoStack.push(st.snap); this.redoStack = [];
      this.app.setStatus(`${fileName(st.file)} placed on ${st.ref.name}${st.icp ? ` (ICP RMS ${mm(st.icp.rms)})` : st.solve ? ` (pairs RMS ${mm(st.solve.rms)})` : ''}. Cloud to Part uses this placement.`);
    } else {
      if (!st.solve && !st.icp) { this.regEnd(true); return true; }
      st.mov.registration = { ref: st.ref.name, pairs: st.solve ? st.pairs.length : 0, pairsRms: st.solve?.rms ?? null, icpRms: st.icp?.rms ?? null, overlap: st.icp?.overlap ?? null, level: !!st.pm.values.level, date: new Date().toISOString(), D: st.D };
      this.undoStack.push(st.snap); this.redoStack = [];
      this.app.setStatus(`${st.mov.name} aligned to ${st.ref.name}: rotation ${fmt(angleDeg(st.D.R), opt('pcRegDec'))}°, shift ${fmt(Math.hypot(...this.regShift()), opt('pcRegDec'))} m`);
    }
    this.regEnd(false);
    this.app.setDirty(true);
    this.renderTree();
    return true;
  }
  regEnd(cancel) {
    const st = this.reg; if (!st) return;
    if (cancel && !st.part) this.regRestoreMov();
    if (st.preview) { this.overlay.remove(st.preview); st.preview.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
    this.reg = null;
    this.endTool();
  }
  drawPairs(ctx, hover) {
    const st = this.reg; if (!st) return;
    const S = (a) => this.absToScreen(a);
    const C_MOV = opt('pcMovColor'), C_REF = opt('pcRefColor'), to = opt('pcPairTextOff');
    const dot = (q, col, n) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcPairDotR'), 0, Math.PI * 2); ctx.fill(); if (n) { ctx.font = opt('pcPairFont'); ctx.lineWidth = opt('pcPairHaloW'); ctx.strokeStyle = opt('pcPairHalo'); ctx.strokeText(n, q[0] + to, q[1] - to); ctx.fillText(n, q[0] + to, q[1] - to); } };
    st.pairs.forEach((p, i) => {
      const a = S(apply(st.D, p.a)), b = S(p.b);
      ctx.strokeStyle = opt('pcPairLine'); ctx.lineWidth = opt('pcPairLineW'); ctx.setLineDash(opt('pcPairDash'));
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); ctx.setLineDash([]);
      dot(a, C_MOV, String(i + 1)); dot(b, C_REF, String(i + 1));
    });
    if (st.half) dot(S(apply(st.D, st.half)), C_MOV, String(st.pairs.length + 1));
    if (hover) { const q = S(hover.abs); ctx.strokeStyle = hover.side === 'mov' ? C_MOV : C_REF; ctx.lineWidth = opt('pcToolLineW'); ctx.beginPath(); ctx.arc(q[0], q[1], opt('pcHoverRingR'), 0, Math.PI * 2); ctx.stroke(); }
  }

  // ---------------- report ----------------
  async exportRegReport(rec = this.selRec()) {
    const g = rec?.registration; if (!g) return;
    const T = rec.transform || IDENT(), f = (x) => x.toFixed(opt('pcReportRDec'));
    const lines = [`Registration of ${rec.name}`, `Reference: ${g.ref}`, `Date: ${g.date}`, g.level ? 'Mode: level only (rotation about Z)' : 'Mode: full rotation',
      g.pairs ? `Point pairs: ${g.pairs}, RMS ${mm(g.pairsRms)}` : 'Point pairs: none', g.icpRms != null ? `ICP: RMS ${mm(g.icpRms)}, overlap ${fmt(g.overlap * 100, opt('pcReportPctDec'))}%` : 'ICP: not used',
      `Rotation of this step: ${fmt(angleDeg(g.D.R), opt('pcReportDegDec'))} deg`, '', 'Total transformation (absolute coordinates, row by row; p\' = M p):',
      ...[0, 1, 2].map((i) => `${f(T.R[i * 3])} ${f(T.R[i * 3 + 1])} ${f(T.R[i * 3 + 2])} ${T.t[i].toFixed(opt('pcReportTDec'))}`), '0 0 0 1', ''];
    const def = (this.app.path ? this.app.path.replace(/[^\\/]*$/, '') : '') + `${rec.name.replace(/\.[^.]+$/, '')} registration.txt`;
    const p = await api.saveFile({ defaultPath: def, filters: [{ name: 'Text', extensions: ['txt'] }], text: lines.join('\r\n') });
    if (p) toast(`Saved report to ${fileName(p)}`, 'ok', opt('pcToastOkMs'));
  }
}
