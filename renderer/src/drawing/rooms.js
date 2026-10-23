// Rooms in a drawing: the Room List panel (all rooms of all sheets with area, perimeter and size; sort by
// clicking a column head; rename in the list; CSV export), renaming a room / area on the sheet itself
// (double-click its name) and the movable reference dot of a room / area label (`a.dot`, view-model mm;
// without it the dot sits in the middle of the outline).
import { h, fmt, toast } from '../ui.js';
import { api } from '../api.js';
import { annValue, centroid } from './dims.js';
import { dragOut, enablePopOut } from '../popout.js';
import { opt } from '../app/options.js';

const log = (...a) => { try { window.__lithLog?.(...a); } catch {} };
const LIST_POS = 'monolith.roomListPos', LIST_SORT = 'monolith.roomListSort';
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
// natural sort: "Room 2" before "Room 10"
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const isRoom = (a) => a?.type === 'area' && (a.room || !!a.label);
export function roomInfo(a) {
  const P = a.pts || [];
  let per = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
  if (!P.length && a.r) per = 2 * Math.PI * a.r;
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  const w = P.length ? Math.max(...xs) - Math.min(...xs) : a.r ? 2 * a.r : 0, l = P.length ? Math.max(...ys) - Math.min(...ys) : w;
  return { area: Math.abs(annValue(a)) / 1e6, per: per / 1000, w: w / 1000, l: l / 1000, corners: P.length };
}
// dot position of an area label in view-model mm
export const dotOf = (a) => a.dot || (a.pts ? centroid(a.pts) : a.c);

export class DrawingRooms {
  // ---------- Room List panel ----------
  roomRows() {
    const rows = [];
    for (const v of this.doc.views) for (const a of v.anns || []) if (isRoom(a)) {
      const sh = this.doc.sheets.find((s) => s.id === v.sheet);
      rows.push({ v, a, name: a.label || '', where: `${sh?.name || ''} / ${v.name || ''}`, ...roomInfo(a) });
    }
    return rows;
  }
  cmdRoomList() { if (this._rl) this.closeRoomList(); else this.openRoomList(); }
  closeRoomList() { this._rl?.remove(); this._rl = null; this._rlSig = null; this.app.cm.refresh(); }
  openRoomList() {
    const el = (this._rl = h('div', { class: 'ann-props room-list' }));
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick']) el.addEventListener(ev, (e) => e.stopPropagation());
    const head = h('div', { class: 'ap-head' }, h('b', {}, 'Room List'), h('span', { class: 'ap-val' }), h('button', { class: 'mini txt', title: 'Save the list as a CSV file (opens in Excel)', onclick: () => this.exportRoomList() }, 'CSV'), h('button', { class: 'ap-x', title: 'Close', onclick: () => this.closeRoomList() }, '×'));
    head.style.cursor = 'move';
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, l0 = el.offsetLeft, t0 = el.offsetTop, wr = el.getBoundingClientRect(), grab = [x0 - wr.left, y0 - wr.top];
      const mv = (ev) => { if (dragOut(el, ev, grab)) { up(); return; } const host = this.vp.el.getBoundingClientRect(); el.style.left = Math.max(0, Math.min(host.width - el.offsetWidth, l0 + ev.clientX - x0)) + 'px'; el.style.top = Math.max(0, Math.min(host.height - opt('drPopupKeepPx'), t0 + ev.clientY - y0)) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); lsSet(LIST_POS, [el.offsetLeft, el.offsetTop]); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    this._rlBody = h('div', { class: 'rl-body' });
    el.append(head, this._rlBody);
    this.vp.el.appendChild(el);
    this.fillRoomList(true);
    const host = this.vp.el.getBoundingClientRect(), pos = lsGet(LIST_POS);
    const pm = opt('drPopupMarginPx'), x = pos ? pos[0] : pm, y = pos ? pos[1] : Math.max(pm, host.height - el.offsetHeight - pm);
    el.style.left = Math.max(0, Math.min(host.width - el.offsetWidth, x)) + 'px'; el.style.top = Math.max(0, Math.min(host.height - opt('drPopupKeepPx'), y)) + 'px';
    this.keepRoomListIn();
    enablePopOut(el, '.ap-head', 'monolith.roomList'); // 0.1.129: ⧉ = own window
    this.app.cm.refresh();
  }
  // called after every repaint: rebuild only when a name, value or the selection changed
  syncRoomList() { if (this._rl?.isConnected) this.fillRoomList(false); }
  fillRoomList(force) {
    const rows = this.roomRows(), dec = opt('drRoomListDec');
    const sig = JSON.stringify([rows.map((r) => [r.a.id, r.name, r.area.toFixed(4), r.per.toFixed(3)]), this.selAnn?.id, lsGet(LIST_SORT)]);
    if (!force && sig === this._rlSig) return;
    // do not pull a field away from under the cursor while typing a name
    const act = this._rl.ownerDocument.activeElement; // (the list may be in its own window, 0.1.129)
    if (!force && this._rl.contains(act) && act?.tagName === 'INPUT') return;
    this._rlSig = sig;
    const sort = lsGet(LIST_SORT) || { k: 'name', dir: 1 };
    const cmp = { name: (a, b) => coll.compare(a.name, b.name), area: (a, b) => a.area - b.area, per: (a, b) => a.per - b.per, w: (a, b) => a.w - b.w, l: (a, b) => a.l - b.l, where: (a, b) => coll.compare(a.where, b.where) }[sort.k] || ((a, b) => coll.compare(a.name, b.name));
    rows.sort((a, b) => cmp(a, b) * sort.dir || coll.compare(a.name, b.name));
    const cols = [['name', 'Name'], ['area', 'Area m²'], ['per', 'Perimeter m'], ['w', 'Width m'], ['l', 'Length m'], ['where', 'Sheet / view']];
    const th = (k, t) => h('th', { class: (sort.k === k ? 'on' : '') + (k === 'name' || k === 'where' ? '' : ' num'), title: 'Sort', onclick: () => { lsSet(LIST_SORT, { k, dir: sort.k === k ? -sort.dir : 1 }); this.fillRoomList(true); } }, t + (sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''));
    const tb = h('tbody');
    for (const r of rows) {
      const name = h('input', { type: 'text', value: r.name, placeholder: '(no name)' });
      name.addEventListener('change', () => this.renameRoom(r.v, r.a, name.value));
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = r.a.label || ''; name.blur(); } });
      const tr = h('tr', { class: this.selAnn?.id === r.a.id ? 'sel' : '' }, h('td', {}, name), h('td', { class: 'num' }, r.area.toFixed(dec)), h('td', { class: 'num' }, r.per.toFixed(dec)), h('td', { class: 'num' }, r.w.toFixed(dec)), h('td', { class: 'num' }, r.l.toFixed(dec)), h('td', { class: 'where' }, r.where));
      tr.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') this.selectRoom(r.v, r.a); });
      tb.append(tr);
    }
    const total = rows.reduce((s, r) => s + r.area, 0);
    const table = h('table', { class: 'rl-table' }, h('thead', {}, h('tr', {}, ...cols.map(([k, t]) => th(k, t)))), tb,
      h('tfoot', {}, h('tr', {}, h('td', {}, `${rows.length} room${rows.length === 1 ? '' : 's'}`), h('td', { class: 'num' }, total.toFixed(dec)), h('td', { colspan: '4' }, ''))));
    this._rlBody.replaceChildren(rows.length ? table : h('p', { class: 'ap-info' }, 'No rooms yet. Use Room Outline (or Polygon Area with a name) and they show up here.'));
    this._rl.querySelector('.ap-val').textContent = `${rows.length} · ${fmt(total, dec)} m²`;
    this.keepRoomListIn();
  }
  // a list that grew past the bottom moves up (it never covers the top less than 0)
  keepRoomListIn() {
    const el = this._rl; if (!el?.isConnected) return;
    const H = this.vp.el.clientHeight; if (el.offsetTop + el.offsetHeight > H - opt('drListSlackPx')) el.style.top = Math.max(0, H - el.offsetHeight - opt('drPopupEdgePx')) + 'px';
  }
  selectRoom(v, a) {
    if (v.sheet !== this.sheetId) this.showSheet(v.sheet);
    this.selAnn = { view: v.id, id: a.id }; this.sel = v.id; this.renderTree(); this.app.cm.refresh(); this.vp.requestRender();
  }
  renameRoom(v, a, name) {
    name = String(name ?? '').trim();
    if (name === (a.label || '')) return;
    this.change(() => { if (name) a.label = name; else delete a.label; });
    log('ANNSET', a.type, a.id, `label=${name}`);
    this.closeProps?.(); // the settings box shows the old name
  }
  async exportRoomList() {
    const rows = this.roomRows(); if (!rows.length) { toast('No rooms in this drawing'); return; }
    const sort = lsGet(LIST_SORT) || { k: 'name', dir: 1 };
    rows.sort((a, b) => (sort.k === 'name' || sort.k === 'where' ? coll.compare(a[sort.k], b[sort.k]) : a[sort.k] - b[sort.k]) * sort.dir);
    const cd = opt('drRoomCsvDec'), q = (s) => `"${String(s).replace(/"/g, '""')}"`, c = (x) => x.toFixed(cd).replace('.', ','); // Dutch Excel: ';' + decimal comma
    const lines = ['Name;Area m2;Perimeter m;Width m;Length m;Corners;Sheet / view', ...rows.map((r) => [q(r.name), c(r.area), c(r.per), c(r.w), c(r.l), r.corners, q(r.where)].join(';'))];
    lines.push(['"Total"', c(rows.reduce((s, r) => s + r.area, 0)), '', '', '', '', ''].join(';'));
    const def = (this.app.path ? this.app.path.replace(/\.[^.\\/]+$/, '') : this.doc.name) + ' rooms.csv';
    const p = await api.saveFile({ defaultPath: def, filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }], text: '﻿' + lines.join('\r\n') + '\r\n' });
    if (p) { toast(`Saved ${rows.length} rooms to ${p.split(/[\\/]/).pop()}`, 'ok', opt('drToastOkMs')); log('ROOMLIST csv', rows.length); }
  }
  // ---------- rename on the sheet: an input right over the text ----------
  inlineRename(s) {
    const a = this.ann(s.view, s.id), v = this.V(s.view); if (!a || a.type !== 'area') return false;
    const box = (this._annBoxes || []).find((q) => q.t === 'annbox' && q.ann === a.id)?.box; if (!box) return false;
    this._inline?.remove();
    const p0 = this.S2([box[0], box[3]]), p1 = this.S2([box[2], box[1]]), hpx = Math.max(opt('drRenameMinHPx'), Math.abs(p1[1] - p0[1])), pad = opt('drRenamePadPx');
    const inp = (this._inline = h('input', { type: 'text', class: 'inline-name', value: a.label || '', placeholder: 'Name' }));
    Object.assign(inp.style, { left: Math.min(p0[0], p1[0]) - pad + 'px', top: Math.min(p0[1], p1[1]) - pad + 'px', height: hpx + 2 * pad + 'px', width: Math.max(opt('drRenameMinWPx'), Math.abs(p1[0] - p0[0]) + opt('drRenameExtraWPx')) + 'px', fontSize: Math.max(opt('drRenameFontMinPx'), hpx * opt('drRenameFontK')) + 'px' });
    for (const ev of ['pointerdown', 'dblclick', 'wheel']) inp.addEventListener(ev, (e) => e.stopPropagation());
    let done = false;
    const finish = (ok) => { if (done) return; done = true; const val = inp.value; inp.remove(); this._inline = null; if (ok) this.renameRoom(v, a, val); this.vp.requestRender(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    this.vp.el.appendChild(inp);
    inp.focus(); inp.select();
    return true;
  }
  // ---------- the dot of a room / area label ----------
  dotGripAt(p) {
    const s = this.selAnn; if (!s || this.tool) return null;
    const a = this.ann(s.view, s.id), v = this.V(s.view); if (a?.type !== 'area') return null;
    const D = this.toSheetPt(v, dotOf(a)), k = Math.max(opt('geomEps'), Math.abs(this.affine().ex[0]));
    return Math.hypot(D[0] - p[0], D[1] - p[1]) * k <= opt('drGripPickPx') ? { a, v } : null;
  }
  drawDotGrip(ctx) {
    const s = this.selAnn; if (!s || this.tool) return;
    const a = this.ann(s.view, s.id), v = this.V(s.view); if (a?.type !== 'area') return;
    const D = this.S2(this.toSheetPt(v, dotOf(a)));
    ctx.save(); ctx.setLineDash([]); ctx.lineWidth = opt('drDotGripW'); ctx.strokeStyle = opt('drHandleColor'); ctx.beginPath(); ctx.arc(D[0], D[1], opt('drDotGripR'), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  dotDragStart(g, p) { return { dot: g, p0: p, snap: this.snapshot(), moved: false }; }
  dotDragMove(dr, p) { dr.dot.a.dot = this.toModel(dr.dot.v, p); }
  dotDragEnd(dr) { this.pushUndo(dr.snap); this.app.setDirty(true); log('ANNSET', 'area', dr.dot.a.id, 'dot'); }
}
