// Drafting standard: annotation look (text, lines, arrows, room outlines) and room straightening values.
// Resolution order: built-in STD_DEF < company standard (drafting-standard.json in the CAD Program folder,
// loaded at start, importable/exportable) < drawing (doc.style) < one annotation (a.style).
// New drawings copy the company standard into doc.style, so a drawing looks the same on every PC.
import { ROOM_DEF } from './fit.js';

export const STD_DEF = {
  textH: 3.5, textColor: '#000000',
  lineW: 0.25, lineColor: '#000000',
  arrow: 'filled', arrowSize: 3,
  extGap: 1, extOver: 2,
  outlineW: 0.25, outlineColor: '#000000', outlineDash: 'chain',
  fillColor: '#2a6fd6', fillOpacity: 10, // room / area infill, opacity % (0 = no infill)
  ...ROOM_DEF,
};
// keys a user can set, grouped for the popup / Drafting Standard dialog
export const TEXT_H = [1.8, 2.5, 3.5, 5, 7, 10];
export const LINE_W = [0.05, 0.09, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1];
export const ARROWS = [['filled', 'Filled arrow'], ['open', 'Open arrow'], ['tick', 'Architectural tick'], ['dot', 'Dot']];
export const DASHES = { chain: [4, 1, 1, 1], dashed: [3, 1.5], solid: null };
export const DASH_NAMES = [['chain', 'Chain (dash-dot)'], ['dashed', 'Dashed'], ['solid', 'Solid']];
export const KEYS = Object.keys(STD_DEF);

let company = {};
export function setCompanyStd(s) { company = clean(s || {}); }
export function companyStd() { return { ...company }; }
// only known keys with sane values
export function clean(s) {
  const o = {};
  for (const k of KEYS) {
    if (s?.[k] == null) continue;
    const d = STD_DEF[k], v = s[k];
    if (typeof d === 'number') { const n = Number(v); if (isFinite(n) && (n >= 0 || k === 'offset')) o[k] = n; }
    else if (typeof v === 'string') o[k] = v;
  }
  return o;
}
export function styleOf(doc, a) { return { ...STD_DEF, ...company, ...(doc?.style || {}), ...(a?.style || {}) }; }
export const ROOM_KEYS = ['method', 'tol', 'cover', 'look', 'maxSize', 'face', 'furniture', 'minWall', 'jog', 'angle', 'close', 'offset', 'join', 'lowFrom', 'lowTo', 'highFrom', 'highTo'];
export const roomOpts = (st) => Object.fromEntries(ROOM_KEYS.map((k) => [k, st[k]]));
