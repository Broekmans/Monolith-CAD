// Small DOM toolkit: element builder, CommandManager ribbon, PropertyManager
// panel, context menus, toasts and dialogs.
import { icon } from './icons.js';
import { opt } from './app/options.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const fmt = (v, d = 2) => {
  if (!isFinite(v)) return '-';
  let s = Number(v).toFixed(d);
  s = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return s === '-0' ? '0' : s;
};

// ---------------- CommandManager ----------------
export class CommandManager {
  constructor(root) {
    this.root = root;
    this.tabs = [];
    this.active = 0;
    this.buttons = [];
  }
  setTabs(tabs, activeName) {
    this.tabs = tabs;
    const idx = tabs.findIndex((t) => t.name === activeName);
    this.active = idx >= 0 ? idx : Math.min(this.active, tabs.length - 1);
    this.render();
  }
  selectTab(name) {
    const i = this.tabs.findIndex((t) => t.name === name);
    if (i >= 0 && i !== this.active) { this.active = i; this.render(); }
  }
  render() {
    this.root.innerHTML = '';
    this.buttons = [];
    const bar = h('div', { class: 'cm-buttons' });
    const tab = this.tabs[this.active];
    if (tab) {
      for (const group of tab.groups) {
        // a group is an array of buttons; `group.label` (or {label, items}) = name shown under the group
        const items = Array.isArray(group) ? group : group.items || [];
        const row = h('div', { class: 'cm-grow' });
        const g = h('div', { class: 'cm-group' }, row, group.label ? h('div', { class: 'cm-glabel' }, group.label) : null);
        for (const b of items) {
          if (!b) continue;
          if (b === '|') { row.appendChild(h('div', { class: 'cm-sep' })); continue; }
          const btn = h('button', { class: 'cm-btn' + (b.small ? ' small' : ''), title: b.tip || b.label, 'data-cmd': b.id, onclick: () => b.run() },
            h('span', { class: 'ico', html: icon(b.icon) }), h('span', { class: 'lbl' }, b.label));
          this.buttons.push({ el: btn, def: b });
          row.appendChild(btn);
        }
        bar.appendChild(g);
      }
    }
    const tabsEl = h('div', { class: 'cm-tabs' }, this.tabs.map((t, i) => h('button', {
      class: 'cm-tab' + (i === this.active ? ' active' : ''), onclick: () => { this.active = i; this.render(); },
    }, t.name)));
    this.root.append(bar, tabsEl);
    this.refresh();
  }
  refresh() {
    for (const { el, def } of this.buttons) {
      el.disabled = def.enabled ? !def.enabled() : false;
      el.classList.toggle('on', !!(def.active && def.active()));
    }
  }
}

// name a ribbon group: grp('Create', [buttons]) -> the array with .label (shown under the group)
export const grp = (label, items) => Object.assign(items, { label });

// ---------------- PropertyManager ----------------
// fields: {key, type:'number'|'select'|'color'|'check'|'selbox'|'text'|'info'|'buttons'|'group', ...}
export class PropertyManager {
  constructor(root) {
    this.root = root;
    this.current = null;
  }
  get open() { return !!this.current; }
  show({ title, iconName, fields, values = {}, onOk, onCancel, onChange, message, okLabel }) {
    this.close(false);
    const pm = { values: { ...values }, inputs: {}, activeSel: null, selboxes: {} };
    this.current = pm;
    const fire = (key) => { onChange?.(pm.values, key); };
    const body = h('div', { class: 'pm-body' });
    const addField = (f, parent) => {
      const wrap = h('div', { class: 'pm-field pmf-' + f.type });
      if (f.type === 'group') {
        const grp = h('div', { class: 'pm-group' }, h('div', { class: 'pm-group-title' }, f.label));
        f.fields.forEach((ff) => addField(ff, grp));
        parent.appendChild(grp);
        return;
      }
      if (f.type === 'info') { wrap.appendChild(h('div', { class: 'pm-info', html: f.html || '' }, f.text || '')); parent.appendChild(wrap); pm.inputs[f.key || 'info'] = wrap; return; }
      if (f.type === 'buttons') {
        const row = h('div', { class: 'pm-buttons' });
        for (const b of f.buttons) row.appendChild(h('button', { class: 'pm-bbtn', title: b.tip || b.label, onclick: () => b.run(pm) }, b.icon ? h('span', { class: 'ico', html: icon(b.icon) }) : null, h('span', {}, b.label)));
        wrap.appendChild(row); parent.appendChild(wrap); pm.inputs[f.key || 'buttons'] = row; return;
      }
      const label = f.label ? h('label', {}, f.icon ? h('span', { class: 'ico sm', html: icon(f.icon) }) : null, f.label) : null;
      if (f.type === 'number') {
        const inp = h('input', { type: 'text', value: String(pm.values[f.key] ?? f.default ?? 0), spellcheck: 'false' });
        const commit = () => {
          const v = evalNumber(inp.value);
          if (v === null || (f.min !== undefined && v < f.min)) { inp.classList.add('bad'); return; }
          inp.classList.remove('bad');
          pm.values[f.key] = v; fire(f.key);
        };
        inp.addEventListener('change', commit);
        inp.addEventListener('input', () => { inp._typed = true; });
        // Enter: apply a changed value (preview updates); Enter again with the value unchanged = OK
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const v = evalNumber(inp.value), typed = inp._typed; inp._typed = false;
            if (!typed && v !== null && v === +pm.values[f.key] && pm.onOk && this.current === pm) this.ok();
            else { commit(); if (!opt('enterTwice') && pm.onOk && this.current === pm && !inp.classList.contains('bad')) this.ok(); else inp.select(); }
          }
          e.stopPropagation();
        });
        const spin = (d) => { const v = (evalNumber(inp.value) ?? 0) + d * (f.step || 1); inp.value = String(+v.toFixed(6)); commit(); };
        const row = h('div', { class: 'pm-numrow' }, inp, f.unit ? h('span', { class: 'unit' }, f.unit) : null,
          h('div', { class: 'spin' }, h('button', { onclick: () => spin(1) }, '▲'), h('button', { onclick: () => spin(-1) }, '▼')));
        wrap.append(label || '', row);
        pm.inputs[f.key] = inp;
      } else if (f.type === 'text') {
        const inp = h('input', { type: 'text', value: String(pm.values[f.key] ?? '') });
        inp.addEventListener('input', () => { pm.values[f.key] = inp.value; fire(f.key); });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        wrap.append(label || '', inp);
        pm.inputs[f.key] = inp;
      } else if (f.type === 'select') {
        const sel = h('select', {}, f.options.map((o) => h('option', { value: o.value, selected: String(pm.values[f.key]) === String(o.value) }, o.label)));
        sel.addEventListener('change', () => { pm.values[f.key] = sel.value; fire(f.key); });
        wrap.append(label || '', sel);
        pm.inputs[f.key] = sel;
      } else if (f.type === 'color') {
        const inp = h('input', { type: 'color', value: String(pm.values[f.key] || '#000000') });
        inp.addEventListener('change', () => { pm.values[f.key] = inp.value; fire(f.key); });
        wrap.append(label || '', inp);
        pm.inputs[f.key] = inp;
      } else if (f.type === 'check') {
        const cb = h('input', { type: 'checkbox', checked: !!pm.values[f.key] });
        cb.addEventListener('change', () => { pm.values[f.key] = cb.checked; fire(f.key); });
        wrap.append(h('label', { class: 'pm-check' }, cb, f.label));
        pm.inputs[f.key] = cb;
      } else if (f.type === 'selbox') {
        const list = h('div', { class: 'pm-selbox', tabindex: 0 });
        const box = { el: list, items: pm.values[f.key] || [], accepts: f.accepts, max: f.max, key: f.key, label: f.itemLabel || ((x) => x.label || x.kind) };
        pm.values[f.key] = box.items;
        pm.selboxes[f.key] = box;
        list.addEventListener('click', () => { pm.activeSel = f.key; renderBoxes(); });
        wrap.append(label || '', list);
      }
      parent.appendChild(wrap);
    };
    const renderBoxes = () => {
      for (const [k, box] of Object.entries(pm.selboxes)) {
        box.el.classList.toggle('active', pm.activeSel === k);
        box.el.innerHTML = '';
        if (!box.items.length) box.el.appendChild(h('div', { class: 'pm-sel-empty' }, 'Select in graphics area'));
        box.items.forEach((it, i) => box.el.appendChild(h('div', { class: 'pm-sel-item' }, h('span', {}, box.label(it)),
          h('button', { class: 'x', title: 'Remove', onclick: (e) => { e.stopPropagation(); box.items.splice(i, 1); renderBoxes(); fire(k); } }, '×'))));
      }
    };
    pm.renderBoxes = renderBoxes;
    fields.forEach((f) => addField(f, body));
    const firstSel = fields.flatMap((f) => (f.type === 'group' ? f.fields : [f])).find((f) => f.type === 'selbox');
    if (firstSel) pm.activeSel = firstSel.key;
    // offer a selection to the active selection box; returns true if consumed
    pm.offer = (item) => {
      const box = pm.selboxes[pm.activeSel];
      if (!box || (box.accepts && !box.accepts(item))) {
        // try other boxes that accept it
        const other = Object.values(pm.selboxes).find((b) => !b.accepts || b.accepts(item));
        if (!other) return false;
        pm.activeSel = other.key;
        return pm.offer(item);
      }
      const same = box.items.findIndex((x) => x.key === item.key);
      if (same >= 0) box.items.splice(same, 1);
      else {
        if (box.max === 1) box.items.length = 0;
        box.items.push(item);
      }
      renderBoxes();
      fire(box.key);
      return true;
    };
    pm.setValue = (k, v) => {
      pm.values[k] = v;
      const inp = pm.inputs[k];
      if (inp) { if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = String(v); }
      if (pm.selboxes[k]) { pm.selboxes[k].items = v; pm.values[k] = v; renderBoxes(); }
    };
    pm.setMessage = (txt, kind = 'info') => {
      msg.textContent = txt || '';
      msg.className = 'pm-msg ' + kind;
      msg.style.display = txt ? '' : 'none';
    };
    const msg = h('div', { class: 'pm-msg' });
    const header = h('div', { class: 'pm-header' },
      h('span', { class: 'ico', html: icon(iconName || 'sketch') }), h('span', { class: 'pm-title' }, title),
      h('div', { class: 'pm-actions' },
        onOk ? h('button', { class: 'pm-ok', title: okLabel || 'OK (Enter)', html: icon('check'), onclick: () => this.ok() }) : null,
        h('button', { class: 'pm-cancel', title: 'Cancel (Esc)', html: icon('cancel'), onclick: () => this.cancel() })));
    pm.onOk = onOk; pm.onCancel = onCancel;
    this.root.innerHTML = '';
    // footer OK / Cancel (shown when the PropertyManager floats over the 3D view)
    const foot = h('div', { class: 'pm-foot' },
      onOk ? h('button', { class: 'pm-foot-ok primary', onclick: () => this.ok() }, okLabel && okLabel.length < 14 ? okLabel : 'OK') : null,
      h('button', { class: 'pm-foot-cancel', onclick: () => this.cancel() }, 'Cancel'));
    this.root.append(header, msg, body, foot);
    this.root.classList.add('show');
    pm.setMessage(message || '');
    renderBoxes();
    return pm;
  }
  ok() {
    const pm = this.current;
    if (!pm) return;
    const res = pm.onOk?.(pm.values);
    if (res === false) return; // validation failed
    this.close(false);
  }
  cancel() {
    const pm = this.current;
    if (!pm) return;
    this.close(true);
  }
  close(cancelled) {
    const pm = this.current;
    this.current = null;
    this.root.classList.remove('show');
    this.root.innerHTML = '';
    if (pm && cancelled) pm.onCancel?.();
  }
}

// Evaluate simple arithmetic like "25.4*2" or "100/3" safely.
export function evalNumber(s) {
  s = String(s).trim().replace(/,/g, '.').replace(/mm$/i, '').replace(/°|deg$/i, '');
  if (!/^[-+*/().\d\s eE]+$/.test(s) || !s) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${s});`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch { return null; }
}

// ---------------- popups ----------------
let menuEl = null;
export function contextMenu(x, y, items) {
  closeMenu();
  menuEl = h('div', { class: 'ctx-menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'ctx-sep' }) :
    h('button', { class: 'ctx-item', disabled: it.disabled, onclick: () => { closeMenu(); it.run(); } },
      it.icon ? h('span', { class: 'ico sm', html: icon(it.icon) }) : h('span', { class: 'ico sm' }), h('span', {}, it.label),
      it.key ? h('span', { class: 'ctx-key' }, it.key) : null))));
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
}
function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
export function closeMenu() {
  document.removeEventListener('pointerdown', onDocDown, true);
  menuEl?.remove(); menuEl = null;
}

export function toast(text, kind = 'info', ms = opt('toastSec') * 1000) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.appendChild(host); }
  try { window.__lithLog?.('MESSAGE', kind, text); } catch {}
  const t = h('div', { class: 'toast ' + kind }, text);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// Inline value editor (SolidWorks "Modify" box) placed at screen coords.
export function modifyBox(x, y, value, { title = 'Modify', unit = 'mm', onApply, onCancel, onLive } = {}) {
  document.querySelector('.modify-box')?.remove();
  const inp = h('input', { type: 'text', value: String(value) });
  let done = false;
  const apply = () => {
    const v = evalNumber(inp.value);
    if (v === null) { inp.classList.add('bad'); return; }
    done = true; box.remove(); onApply?.(v);
  };
  const cancel = () => { if (done) return; done = true; box.remove(); onCancel?.(); };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') apply();
    if (e.key === 'Escape') cancel();
  });
  inp.addEventListener('input', () => { const v = evalNumber(inp.value); if (v !== null) onLive?.(v); });
  const box = h('div', { class: 'modify-box' },
    h('div', { class: 'mb-title' }, title),
    h('div', { class: 'mb-row' },
      h('button', { class: 'mb-btn', html: icon('check'), title: 'Apply', onclick: apply }),
      h('button', { class: 'mb-btn', html: icon('cancel'), title: 'Cancel', onclick: cancel }),
    ),
    h('div', { class: 'mb-row' }, inp, h('span', { class: 'unit' }, unit)));
  document.body.appendChild(box);
  box.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  box.style.top = Math.min(y, window.innerHeight - 110) + 'px';
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  return { close: cancel };
}

// Move a dialog by dragging its title strip (0.1.87); the offset is remembered per dialog title and kept on screen.
export function dragByTitle(dlg, key) {
  const head = dlg.querySelector('.dlg-title'); if (!head) return;
  head.classList.add('movable');
  let off = [0, 0];
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (Array.isArray(v)) off = v; } catch { /* none */ }
  const apply = () => {
    dlg.style.translate = `${off[0]}px ${off[1]}px`;
    const r = head.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight; // title stays reachable
    let dx = 0, dy = 0;
    if (r.right < 80) dx = 80 - r.right; if (r.left > W - 80) dx = W - 80 - r.left;
    if (r.top < 0) dy = -r.top; if (r.bottom > H) dy = H - r.bottom;
    if (dx || dy) { off = [off[0] + dx, off[1] + dy]; dlg.style.translate = `${off[0]}px ${off[1]}px`; }
  };
  apply();
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, o0 = off.slice();
    const mv = (ev) => { off = [o0[0] + ev.clientX - x0, o0[1] + ev.clientY - y0]; apply(); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); try { localStorage.setItem(key, JSON.stringify(off)); } catch { /* no storage */ } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}

export function dialog({ title, body, buttons = [{ label: 'OK', primary: true }] }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'dlg-back' });
    const close = (v) => { back.remove(); resolve(v); };
    const dlg = h('div', { class: 'dlg' }, h('div', { class: 'dlg-title' }, h('span', {}, title), h('button', { class: 'dlg-x', title: 'Close (Esc)', onclick: () => close(null) }, '×')), h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-buttons' }, buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => close(b.value ?? b.label) }, b.label))));
    back.appendChild(dlg);
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    document.body.appendChild(back);
    dragByTitle(dlg, 'monolith.dlgPos.' + title);
    dlg.querySelector('button.primary')?.focus();
  });
}

export async function promptText(title, value = '') {
  const inp = h('input', { type: 'text', value, class: 'dlg-input' });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.closest('.dlg').querySelector('button.primary').click(); });
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  const r = await dialog({ title, body: inp, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: 'ok' }] });
  return r === 'ok' ? inp.value : null;
}
