// Action log: records what the user does (button clicks, menu commands, keys,
// PM field edits, viewport clicks, file actions) plus errors, so problems can
// be reconstructed afterwards. Written by main.cjs to <CAD Program>\Logs.
import { api } from './api.js';

let buf = [];
const ts = () => new Date().toTimeString().slice(0, 8);
const short = (v) => { const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })(); return s && s.length > 300 ? s.slice(0, 300) + '…' : s; };

export function log(...parts) {
  let doc = ''; try { doc = window.lithApp?.path?.split(/[\\/]/).pop() || ''; } catch {}
  buf.push(`${ts()} ${doc ? '[' + doc + '] ' : ''}${(parts[0] === 'ROOMPTS' ? parts.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 20000)) : parts.map(short)).join(' ')}`);
  if (buf.length > 50) flush();
}
function flush() { if (buf.length) { api.log(buf); buf = []; } }

const labelOf = (el) => {
  const t = el.getAttribute('title') || el.getAttribute('data-cmd') || el.getAttribute('aria-label') || '';
  const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return [t, txt && txt !== t ? txt : ''].filter(Boolean).join(' / ') || el.className || el.tagName;
};
const fieldLabel = (el) => {
  const row = el.closest('.pm-field, label, tr');
  const l = row?.matches('label') ? row : row?.querySelector('label, th');
  const pm = el.closest('.pm')?.querySelector('.pm-title, h2, h3')?.textContent?.trim();
  return ((pm ? pm + ' › ' : '') + (l?.textContent || el.name || el.placeholder || 'field')).trim().slice(0, 60);
};
const mods = (e) => (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '');

export function initActionLog() {
  window.__lithLog = log; // toasts (ui.js) go into the log too
  globalThis.lithLog = log;
  setInterval(flush, 2000);
  window.addEventListener('beforeunload', flush);
  window.addEventListener('error', (e) => { log('ERROR', e.message, `${e.filename?.split('/').pop()}:${e.lineno}`, e.error?.stack?.split('\n').slice(1, 4).join(' | ') || ''); flush(); });
  window.addEventListener('unhandledrejection', (e) => { log('ERROR (promise)', e.reason?.message || e.reason, e.reason?.stack?.split('\n').slice(1, 4).join(' | ') || ''); flush(); });
  const ce = console.error.bind(console);
  console.error = (...a) => { log('console.error', ...a.map((x) => x?.message || x)); ce(...a); };

  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('button, [data-cmd], .ctx-item, .tree-row, .tr, .dt, li, a');
    if (el) log('click', labelOf(el));
  }, true);
  document.addEventListener('dblclick', (e) => {
    if (e.target.tagName === 'CANVAS') log('double-click viewport', `${Math.round(e.offsetX)},${Math.round(e.offsetY)}`);
    else { const el = e.target.closest?.('[title], .tree-row, .tr, div'); if (el) log('double-click', labelOf(el)); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'CANVAS') log('mouse', ['left', 'middle', 'right'][e.button] || e.button, mods(e) + 'down in viewport at', `${Math.round(e.offsetX)},${Math.round(e.offsetY)}`);
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target; if (!el.matches?.('input, select, textarea')) return;
    log('set', fieldLabel(el), '=', el.type === 'checkbox' ? el.checked : el.value);
  }, true);
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    // a held key repeats ~30×/s: log it once; a lone modifier (Ctrl, Shift, Alt) is not an action
    if (e.repeat || /^(Control|Shift|Alt|Meta)$/.test(k)) return;
    const inField = e.target.matches?.('input, textarea');
    if (e.ctrlKey || e.altKey || /^(Escape|Enter|Delete|Backspace|Tab|F\d+)$/.test(k) || (!inField && k.length === 1 && k !== ' '))
      if (!(inField && !e.ctrlKey && !e.altKey && !/^(Escape|Enter)$/.test(k))) log('key', mods(e) + k);
  }, true);
  api.onMenu?.((cmd, arg) => log('menu', cmd, arg ?? ''));
  api.info?.().then((i) => log('session start', i)).catch(() => {});
}

// Consent / toggle helpers (setting stored by main in userData/actionlog.json; on by default)
export async function askLogConsentOnce(dialog, h) {
  const c = await api.logCfg?.(); if (!c || (c.asked && c.consentV >= 2)) return;
  const dir = (await api.logDir?.().catch(() => '')) || 'the Logs folder next to the program';
  const li = (...t) => h('li', {}, ...t);
  const v = await dialog({ title: 'Action log — your permission', body: h('div', { class: 'consent' },
    h('p', {}, 'MonoLith can keep a simple text log of what you do in the program. If something goes wrong, the log shows the steps that led to the problem, so it can be found and fixed faster.'),
    h('h4', {}, 'What is recorded'),
    h('ul', {},
      li('Commands and buttons you click, menu choices and keyboard shortcuts'),
      li('Values you type into fields (for example a dimension or extrude depth)'),
      li('Mouse clicks in the 3D view (screen position only)'),
      li('The name of the open document, the program version and the time'),
      li('Error messages from the program')),
    h('h4', {}, 'What is NOT recorded'),
    h('ul', {},
      li('Your models or drawings themselves'),
      li('Rotating, panning or zooming the view'),
      li('Anything you do in other programs, screenshots, or personal data such as your name, account or location')),
    h('h4', {}, 'What happens with the data'),
    h('ul', {},
      li('The log is stored only on this computer, in: ', h('code', {}, dir)),
      li('It is never sent anywhere automatically — MonoLith does not upload it, and there is no tracking or analytics.'),
      li('It only leaves your computer if you choose to share it yourself, for example with support when reporting a problem.'),
      li('One plain text file per day; files older than 14 days are deleted automatically. You can open, read or delete them at any time.')),
    h('p', {}, 'You can change this choice at any time with the "Record action log" checkbox on the Home screen. Turning it off stops recording immediately; existing log files stay until they are 14 days old or you delete them.')),
    buttons: [{ label: 'No, don\'t record', value: false }, { label: 'Yes, record a log', value: true, primary: true }] });
  await api.logCfg({ enabled: v !== false, asked: true, consentV: 2 });
}
