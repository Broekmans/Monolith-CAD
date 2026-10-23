// File management: new/open/save documents, old-format (.ek*) handling, import of CAD files and point clouds.
import * as THREE from 'three';
import { cacheKey, packMesh } from '../meshcache.js';
import { h, CommandManager, PropertyManager, toast, dialog } from '../ui.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { initActionLog, askLogConsentOnce } from '../actionlog.js';
import { initSolver } from '../sketch/solver.js';
import { setSketchTheme } from '../sketch/sketcher.js';
import { PartDoc, newPartDoc } from '../part/part.js';
import { PlanDoc, newPlanDoc } from '../plan/plan.js';
import { AssemblyDoc, newAssemblyDoc, partSaved, partCache } from '../assembly/assembly.js';
import { PC_EXTS, isPointCloud, askImportOptions } from '../pointcloud.js';
import { CloudDoc, newCloudDoc, CLOUD_EXTS } from '../cloud/clouddoc.js';
import { DrawingDoc, newDrawingDoc } from '../drawing/drawing.js';
import { EXT, extOf, APP_NAME, SLOTS, boot, App } from '../main.js';
import { upgradeDoc } from '../../../shared/format.mjs';

export class AppFiles {
  async loadDoc(docData, path = null) {
    const app = this.root;
    if (path) { const ex = app.tabs.find((t) => t.path === path); if (ex) { app.activate(ex); return; } }
    // file format: older files are upgraded step by step (shared/format.mjs); a newer file opens with a warning
    if (path) {
      const name = path.split(/[\\/]/).pop();
      let up; try { up = upgradeDoc(docData); } catch (e) { toast(`${name}: ${e.message}`, 'error'); return null; }
      if (up.upgraded) { window.__lithLog?.('FORMAT', name, `upgraded ${up.kind} format ${up.from} -> ${up.to}`); toast(`${name} was made with an older format. It is updated now and will be saved in the new format when you save it`, 'info', 4000); }
      if (up.newer) { window.__lithLog?.('FORMAT', name, `newer ${up.kind} format ${up.from}`); toast(`${name} was made with a newer ${APP_NAME} version. You can view it; saving it here may lose things this version does not know.`, 'warn', 9000); }
    }
    const t = app.newTab();
    // old-format files (.ek*) open normally; the first Save asks where to store the new .lith* file
    // old-format file (.ek*): from now on it lives as .lith* next to it; Save writes there directly
    t.path = path ? path.replace(/\.ek(prt|asm|pln)$/i, '.lith$1') : null;
    t.dirty = false;
    // part: the saved model is shown at once while the features rebuild (0.1.107); not kept in the document itself
    let openCache = null;
    if (docData.kind === 'part') { openCache = docData.cache || null; delete docData.cache; }
    t.doc = docData.kind === 'drawing' ? new DrawingDoc(t, docData) : docData.kind === 'cloud' ? new CloudDoc(t, docData) : docData.kind === 'plan' ? new PlanDoc(t, docData) : docData.kind === 'assembly' ? new AssemblyDoc(t, docData) : new PartDoc(t, docData);
    if (openCache) t.doc._openCache = { ...docData, cache: openCache };
    document.body.dataset.kind = docData.kind;
    t.showPanel('tree');
    t.doc.init();
    t.syncViewportMenu?.();
    t.updateTitle();
    t.renderLeftTabs();
    return t;
  }

  async newDoc(kind) {
    const app = this.root;
    app.docCounter ||= { part: 0, plan: 0, assembly: 0, cloud: 0, drawing: 0 };
    const n = ++app.docCounter[kind];
    await this.loadDoc(kind === 'drawing' ? newDrawingDoc(`Drawing${n}`) : kind === 'cloud' ? newCloudDoc(`PointCloud${n}`) : kind === 'plan' ? newPlanDoc(`Plan${n}`) : kind === 'assembly' ? newAssemblyDoc(`Assembly${n}`) : newPartDoc(`Part${n}`));
  }

  async newDialog() {
    const pick = await dialog({
      title: 'New Document',
      body: h('div', { class: 'newdlg' },
        h('div', { class: 'nd' }, h('span', { html: icon('part') }), h('b', {}, 'Part'), h('small', {}, 'Feature-based 3D part: sketches, extrudes, revolves, fillets…')),
        h('div', { class: 'nd' }, h('span', { html: icon('plan') }), h('b', {}, 'Plan'), h('small', {}, '2D drafting and architecture: walls, doors, windows, DXF/DWG')),
        h('div', { class: 'nd' }, h('span', { html: icon('drawing') }), h('b', {}, 'Drawing'), h('small', {}, 'Views of parts and assemblies on paper sheets, PDF export')),
        h('div', { class: 'nd' }, h('span', { html: icon('assembly') }), h('b', {}, 'Assembly'), h('small', {}, 'Insert parts and position them with mates')),
        h('div', { class: 'nd' }, h('span', { html: icon('cloud') }), h('b', {}, 'Point Cloud'), h('small', {}, 'View and edit laser scans (LAS, LAZ, PLY, XYZ)'))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Drawing', value: 'drawing' }, { label: 'Point Cloud', value: 'cloud' }, { label: 'Assembly', value: 'assembly' }, { label: 'Part', value: 'part' }, { label: 'Plan', value: 'plan', primary: true }],
    });
    if (pick) this.newDoc(pick);
  }

  async open(pathArg) {
    if (pathArg && /\.ek(prt|asm|pln)$/i.test(pathArg)) {
      const np = pathArg.replace(/\.ek(prt|asm|pln)$/i, '.lith$1');
      if (await api.fileExists(np).catch(() => false)) pathArg = np;
    }
    let f = pathArg ? await api.readFile(pathArg) : await api.openFile({ filters: [{ name: 'MonoLith documents', extensions: ['lithprt', 'lithasm', 'lithpln', 'lithpcd', 'lithdrw', 'ekprt', 'ekasm', 'ekpln'] }, { name: 'CAD files', extensions: ['dxf', 'dwg', 'step', 'stp', 'igs', 'iges'] }, { name: 'Point clouds', extensions: PC_EXTS }, { name: 'All files', extensions: ['*'] }] });
    if (!f) return;
    if (!pathArg && /\.ek(prt|asm|pln)$/i.test(f.path)) {
      const np = f.path.replace(/\.ek(prt|asm|pln)$/i, '.lith$1');
      if (await api.fileExists(np).catch(() => false)) { f = await api.readFile(np); toast(`Opened ${np.split(/[\\/]/).pop()} (newer format)`, 'info', 3000); }
    }
    const ext = f.path.split('.').pop().toLowerCase();
    if (isPointCloud(f.path)) {
      // a scan opened on its own starts a Point Cloud document; Import adds it to a part or plan as reference
      const t = await this.loadDoc(newCloudDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await t.doc.addCloud(f.path);
      return;
    }
    if (['dxf', 'dwg'].includes(ext)) {
      const t = await this.loadDoc(newPlanDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await t.importPath(f); // the new tab, not the tab Open was clicked in (Home has no document)
      return;
    }
    if (['step', 'stp', 'igs', 'iges'].includes(ext)) {
      const t = await this.loadDoc(newPartDoc(f.path.split(/[\\/]/).pop().replace(/\.\w+$/, '')));
      await t.importPath(f);
      return;
    }
    let data;
    try { data = JSON.parse(f.text); } catch { toast('Not a valid MonoLith document', 'error'); return; }
    await this.loadDoc(data, f.path);
  }

  async save(as = false) {
    if (!this.doc) return false;
    const kind = this.doc.doc.kind;
    const ext = extOf(kind);
    this.doc.beforeSave?.(); // e.g. store the viewport layout + views
    let data = this.doc.toJSON ? this.doc.toJSON() : this.doc.doc;
    if (kind === 'part') {
      // embed the finished mesh so assemblies load this part without rebuilding it
      const sm = this.doc.savedMesh, { cache: _old, ...rest } = data;
      const key = cacheKey(rest.features, rest.rollback ?? undefined);
      data = sm && sm.key === key ? { ...rest, cache: { key, mesh: packMesh(sm.mesh) } } : rest;
    }
    const thumb = this.doc.makeThumb ? this.doc.makeThumb() : makeThumb(this.doc.vp, this.doc.thumbBox?.());
    if (thumb) data = { ...data, thumb }; // shown on the Home screen project cards
    const info = await api.info().catch(() => null);
    if (info?.version) data = { ...data, savedWith: info.version }; // program version that wrote the file (for support)
    const text = JSON.stringify(data);
    let path = this.path;
    if (!path || as) {
      // new files go into the project picked on the Home screen (if any)
      const pd = this.root.currentProject;
      const dir = as && path ? path.replace(/[\\/][^\\/]*$/, '') : pd;
      const def = (dir ? dir + (dir.includes('\\') ? '\\' : '/') : '') + `${this.doc.title}.${ext}`;
      path = await api.saveFile({ defaultPath: def, filters: [{ name: { drawing: 'MonoLith Drawing', plan: 'MonoLith Plan', assembly: 'MonoLith Assembly', cloud: 'MonoLith Point Cloud' }[kind] || 'MonoLith Part', extensions: [ext] }], text });
      if (!path) return false;
    } else await api.writeFile(path, text);
    this.path = path;
    if (kind === 'part' || kind === 'assembly') partSaved(path); // assemblies using it reload it
    this.setDirty(false);
    this.doc.afterSave?.();
    toast(`Saved ${path.split(/[\\/]/).pop()}`, 'ok', 2000);
    return true;
  }

  async importFile() {
    if (!this.doc) return;
    if (this.doc.doc.kind === 'cloud') { await this.doc.addCloudDialog(); return; }
    const filters = this.doc.doc.kind === 'plan'
      ? [{ name: 'Drawings & point clouds', extensions: ['dxf', 'dwg', ...PC_EXTS] }]
      : [{ name: 'CAD models, sketches & point clouds', extensions: ['step', 'stp', 'igs', 'iges', 'dxf', 'dwg', ...PC_EXTS] }];
    const f = await api.openFile({ filters });
    if (f) await this.importPath(f);
  }

  async importPointCloud(path) {
    if (!this.doc) return;
    if (this.doc.doc.kind === 'cloud') { if (path) await this.doc.addCloud(path); else await this.doc.addCloudDialog(); return; }
    if (!path) {
      const f = await api.openFile({ filters: [{ name: 'Point clouds', extensions: PC_EXTS }], noRead: true });
      if (!f) return;
      path = f.path;
    }
    let rec;
    try { rec = await askImportOptions(path); } catch (e) { toast('Cannot read point cloud: ' + e.message, 'error'); return; }
    if (rec) await this.doc.addPointCloud(rec);
  }

  async importPath(f) {
    if (isPointCloud(f.path)) { await this.importPointCloud(f.path); return; }
    const name = f.path.split(/[\\/]/).pop();
    const ext = name.split('.').pop().toLowerCase();
    let text = f.text;
    if (ext === 'dwg') {
      this.setStatus(`Converting ${name}…`); this.setBusy?.(true);
      let r;
      try { r = await api.dwgToDxf(f.path); } finally { this.setBusy?.(false); }
      if (!r?.ok) { this.dwgHelp(r?.error, () => this.importPath(f)); return; }
      text = r.text;
      this.setStatus(`${name} converted with ${r.via}`);
      window.__lithLog?.(`MESSAGE info DWG ${name} converted with ${r.via}`);
    }
    if (ext === 'dxf' || ext === 'dwg') {
      if (this.doc.doc.kind === 'plan') this.doc.importDxfText(text, name);
      else this.doc.importDxf(text, name);
      return;
    }
    if (this.doc.doc.kind !== 'part') { toast('STEP/IGES can be imported into a Part document'); return; }
    await this.doc.importCAD(text, ext.startsWith('ig') ? 'iges' : 'step', name);
  }

  // DWG converters: which one is used, own ODA path ("Browse"), download page. retry() runs the import/export again.
  async dwgHelp(err, retry = null) {
    const st = (await api.dwgStatus?.().catch(() => null)) || {};
    const line = (label, v) => h('div', { class: 'dwg-row' }, h('b', {}, label), h('span', { class: v ? '' : 'muted' }, v || 'not found'));
    const body = h('div', { class: 'dwg-help' },
      err ? h('p', {}, 'The DWG file could not be converted.') : h('p', {}, 'MonoLith converts DWG files to DXF and back with one of these converters:'),
      err ? h('p', { class: 'muted' }, String(err)) : null,
      line('ODA File Converter', st.oda), line('Built-in (LibreDWG)', st.libredwg ? 'ready — opens all DWG versions, saves DWG 2000' : null),
      h('p', { class: 'muted' }, 'The ODA File Converter (free, opendesign.com) gives the best results and saves DWG 2018. If you installed it somewhere else than C:\\Program Files\\ODA\\, use "Browse for ODA File Converter…". DXF import/export works without any converter.'));
    const v = await dialog({
      title: 'DWG converter', body,
      buttons: [{ label: 'Open download page', value: 'dl' }, { label: 'Browse for ODA File Converter…', value: 'browse' }, ...(st.own ? [{ label: 'Forget own path', value: 'forget' }] : []), { label: 'OK', primary: true }],
    });
    if (v === 'dl') api.openExternal('https://www.opendesign.com/guestfiles/oda_file_converter');
    if (v === 'forget') { await api.dwgSetOda(null); toast('Own ODA File Converter path removed'); }
    if (v === 'browse') {
      const f = await api.openFile({ filters: [{ name: 'ODA File Converter', extensions: ['exe'] }], noRead: true });
      if (!f) return;
      const r = await api.dwgSetOda(f.path);
      if (!r?.ok) { toast(r?.error || 'Not the ODA File Converter', 'error'); return; }
      toast('ODA File Converter set: ' + r.oda, 'ok');
      if (retry) retry();
    }
  }

}

// small JPEG of the model (isometric, zoomed to fit) for the Home screen; the user's view is not changed
export function makeThumb(vp, boxIn = null) {
  try {
    vp = vp?.viewset?.primary || vp; // several panes: render with pane 0's own renderer
    const r = vp?.renderer, src = r?.domElement;
    if (!src || !src.width || !vp.width || !vp.height) return null;
    const box = boxIn && !boxIn.isEmpty() ? boxIn.clone() : new THREE.Box3();
    if (!boxIn) vp.scene.traverse((o) => { if (o.isMesh && o.visible && !o.userData.isCap && !o.material?.transparent && o.geometry) { o.geometry.computeBoundingBox(); if (o.geometry.boundingBox) box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    if (box.isEmpty()) return null;
    const TW = 320, TH = 200, A = TW / TH;
    const center = box.getCenter(new THREE.Vector3());
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    cam.up.set(0, 1, 0);
    cam.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(50000));
    cam.lookAt(center); cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    let w = 1e-6, hh = 1e-6;
    for (let i = 0; i < 8; i++) { const q = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center); w = Math.max(w, Math.abs(q.dot(right))); hh = Math.max(hh, Math.abs(q.dot(up))); }
    const Wc = vp.width, Hc = vp.height, cw = Math.min(Wc, Hc * A), ch = cw / A;
    const sc = Math.max((2 * w) / (cw * 0.85), (2 * hh) / (ch * 0.85)); // world units per css px
    cam.left = -Wc / 2 * sc; cam.right = Wc / 2 * sc; cam.top = Hc / 2 * sc; cam.bottom = -Hc / 2 * sc; cam.updateProjectionMatrix();
    r.setViewport(0, 0, Wc, Hc); r.clear(); r.render(vp.scene, cam); // only the model (no view cube/triad)
    const dpr = src.width / Wc, c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    const g = c.getContext('2d');
    g.fillStyle = '#e9edf2'; g.fillRect(0, 0, TW, TH);
    g.drawImage(src, ((Wc - cw) / 2) * dpr, ((Hc - ch) / 2) * dpr, cw * dpr, ch * dpr, 0, 0, TW, TH);
    vp.requestRender();
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}
