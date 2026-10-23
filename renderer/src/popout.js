// Popups in their own windows (0.1.129): a live panel (popup, floating dialog, Motion Study strip) is MOVED into a
// second Electron window opened with window.open('about:blank') — same process and origin, so all its listeners and
// state keep working (main.cjs setWindowOpenHandler: no menu, stays above the main window, may go to another screen).
// - popOut(el, o) / dock(el) / isPopped(el); the window gets the program's stylesheet, theme classes and CSS variables.
// - Keys typed in the window reach the program as before: Esc always, other keys when no field / the popup took them.
// - The program removing the element (its own close) closes the window; the user closing the window docks the element
//   and runs o.onUserClose (default: the popup's own Close / Cancel button).
// - o.key: the window's place + size are remembered (localStorage monolith.pop.<key>) → wantsPop(key) re-opens it there.
// - enablePopOut(el, handleSel, key): ⧉ button in the header (kept through re-renders) + drag the header past the edge
//   of the main window = pop out there. Used by ui.js makeDraggable / dragByTitle (all movable popups and dialogs).
import { opt } from './app/options.js';

const popped = new Map(); // el → {win, key, restore, onUserClose, ro, mo, iv}
const memKey = (key) => 'monolith.pop.' + key;
const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* optional */ } };
export const isPopped = (el) => popped.has(el);
export const popWindows = () => [...popped.values()].map((p) => p.win).filter((w) => !w.closed);
// document.querySelector over the main window and every popup window
export const qs = (sel) => document.querySelector(sel) || popWindows().map((w) => w.document.querySelector(sel)).find(Boolean) || null;
export function wantsPop(key) { if (!key) return null; try { return JSON.parse(localStorage.getItem(memKey(key)) || 'null'); } catch { return null; } }
const remember = (key, v) => { if (!key) return; try { if (v) localStorage.setItem(memKey(key), JSON.stringify(v)); else localStorage.removeItem(memKey(key)); } catch { /* no storage */ } };
const zoom = () => (opt('uiScale') || 100) / 100;
const CLOSE_SEL = ['.pm-cancel', '.ap-x', '.dlg-x', '.ms-x', '.mb-btn[title="Cancel"]'];
function syncLook(d) {
  d.body.className = 'pop-body ' + document.body.className;
  d.documentElement.style.cssText = document.documentElement.style.cssText;
  d.body.style.zoom = String(zoom());
}

// o: {key, title, at:[screenX, screenY], size:[w, h] (CSS px of the element), fill (element fills the window, user sizes it),
//     onUserClose(), onDock()}
export function popOut(el, o = {}) {
  if (popped.has(el) || !el.isConnected) return null;
  const z = zoom(), r = el.getBoundingClientRect();
  const mem = o.key ? wantsPop(o.key) : null;
  const w = Math.round(mem?.w || (o.size?.[0] ?? r.width) * z), hh = Math.round(mem?.h || (o.size?.[1] ?? r.height) * z);
  const x = Math.round(mem?.x ?? o.at?.[0] ?? window.screenX + r.left * z + 40), y = Math.round(mem?.y ?? o.at?.[1] ?? window.screenY + r.top * z + 40);
  const win = window.open('about:blank', '', `popup=yes,left=${x},top=${y},width=${Math.max(120, w)},height=${Math.max(60, hh)}`);
  if (!win) return null;
  const d = win.document;
  d.open(); d.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>'); d.close();
  d.title = o.title || el.querySelector('.ap-head b, .pm-title, .dlg-title span, .ms-title, .mb-title')?.textContent || 'MonoLith';
  const link = d.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('styles.css', location.href).href; d.head.appendChild(link);
  syncLook(d);
  const restore = { parent: el.parentNode, next: el.nextSibling, css: el.style.cssText };
  if (o.fill) el.classList.add('popped-fill'); else el.classList.add('popped');
  el.style.translate = ''; el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; el.style.maxHeight = '';
  d.body.appendChild(el);
  const p = { win, key: o.key || null, restore, onUserClose: o.onUserClose, onDock: o.onDock, fill: !!o.fill, closing: false };
  popped.set(el, p);
  // fit the window to the element (popups that change size, e.g. rows added); fill panels are sized by the user
  const fit = () => { if (p.fill || win.closed) return; const dw = Math.ceil(el.offsetWidth * z) - win.innerWidth, dh = Math.ceil(el.offsetHeight * z) - win.innerHeight; if (Math.abs(dw) > 1 || Math.abs(dh) > 1) try { win.resizeBy(dw, dh); } catch { /* ok */ } };
  p.ro = new ResizeObserver(fit); p.ro.observe(el); setTimeout(fit, 50);
  // the program removed the element (its own close) → close the window
  p.mo = new MutationObserver(() => { if (el.parentNode !== d.body) finish(el, false); }); p.mo.observe(d.body, { childList: true });
  // theme / ribbon size / UI scale changes follow
  p.look = new MutationObserver(() => syncLook(d)); p.look.observe(document.body, { attributes: true, attributeFilter: ['class'] }); p.look.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  // keys → the main window (Esc always; others when nothing in the popup took them)
  const fwd = (e) => { const ev = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true }); document.dispatchEvent(ev); if (ev.defaultPrevented) e.preventDefault(); };
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape') fwd(e); }, true); // (the popup's own Esc handling still runs)
  d.addEventListener('keydown', (e) => { if (e.key !== 'Escape' && !e.target.closest?.('input, select, textarea')) fwd(e); });
  // place + size remembered while it is a window
  p.iv = setInterval(() => { if (!win.closed && p.key) remember(p.key, { x: win.screenX, y: win.screenY, w: p.fill ? win.innerWidth : 0, h: p.fill ? win.innerHeight : 0 }); }, 1000);
  win.addEventListener('pagehide', () => { if (!p.closing) finish(el, true); });
  if (p.key) remember(p.key, { x, y, w: p.fill ? w : 0, h: p.fill ? hh : 0 });
  log('WINDOW out', o.key || el.className.split(' ')[0]);
  return win;
}
// back into the main window (user = by the ⧉ / window close; forget = no longer re-opened as a window)
export function dock(el, { forget = false } = {}) { if (popped.has(el)) finish(el, false, forget); }
function finish(el, byUser, forget = false) {
  const p = popped.get(el); if (!p) return;
  popped.delete(el); p.closing = true;
  clearInterval(p.iv); p.ro.disconnect(); p.mo.disconnect(); p.look.disconnect();
  if (!p.win.closed && p.key) remember(p.key, { x: p.win.screenX, y: p.win.screenY, w: p.fill ? p.win.innerWidth : 0, h: p.fill ? p.win.innerHeight : 0 });
  if (forget) remember(p.key, null);
  el.classList.remove('popped', 'popped-fill');
  el.style.cssText = p.restore.css;
  if (el.parentNode === p.win.document.body) { // still shown (not removed by the program) → back into the main window
    if (p.restore.parent?.isConnected) p.restore.parent.insertBefore(el, p.restore.next?.parentNode === p.restore.parent ? p.restore.next : null); else document.body.appendChild(el); }
  if (!p.win.closed) try { p.win.close(); } catch { /* ok */ }
  log('WINDOW in', p.key || el.className.split(' ')[0], byUser ? '(window closed)' : forget ? '(docked)' : '');
  el._drag?.apply?.();
  p.onDock?.(byUser);
  if (byUser && el.isConnected) { if (p.onUserClose) p.onUserClose(); else (CLOSE_SEL.map((s) => el.querySelector(s)).find(Boolean))?.click(); }
}

// ⧉ in the header of a movable popup + "drag past the edge = own window" (called by makeDraggable / dragByTitle)
export function enablePopOut(el, handleSel, key, o = {}) {
  if (el._pop) return el._pop;
  const btn = () => {
    const b = document.createElement('button');
    b.className = 'pop-btn'; b.type = 'button'; b.textContent = '⧉';
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); if (isPopped(el)) dock(el, { forget: true }); else popOut(el, { key, ...o }); sync(); });
    return b;
  };
  const sync = () => {
    const head = el.querySelector(handleSel); if (!head) return;
    let b = head.querySelector(':scope > .pop-btn, :scope .pm-actions > .pop-btn');
    if (!b) {
      b = btn();
      const acts = head.querySelector('.pm-actions'), x = head.querySelector(':scope > .ap-x, :scope > .dlg-x');
      if (acts) acts.prepend(b); else if (x) x.before(b); else head.appendChild(b);
    }
    const on = isPopped(el);
    b.title = on ? 'Back into the MonoLith window' : 'Open in its own window (you can move it onto another screen)';
    b.classList.toggle('on', on);
    b.style.display = el._drag?.off && !on ? 'none' : '';
  };
  const mo = new MutationObserver(sync); mo.observe(el, { childList: true, subtree: true });
  sync();
  el._pop = { sync, key, o, open: (at) => popOut(el, { key, at, ...o }) };
  // re-open as a window where it was last time
  if (key && wantsPop(key)) setTimeout(() => { if (el.isConnected && !isPopped(el) && !el._drag?.off && el.getClientRects().length > 0) { popOut(el, { key, ...o }); sync(); } }, 0);
  return el._pop;
}
// during a header drag: the pointer left the main window → pop out at that screen position (grab = pointer offset in px)
export function dragOut(el, ev, grab) {
  if (!el._pop || isPopped(el)) return false;
  const out = ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight;
  if (!out) return false;
  const z = zoom();
  popOut(el, { key: el._pop.key, at: [Math.round(ev.screenX - grab[0] * z), Math.round(ev.screenY - grab[1] * z)], ...el._pop.o });
  el._pop.sync();
  return true;
}
