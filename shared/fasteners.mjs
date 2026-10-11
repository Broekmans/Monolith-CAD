// Fastener library (Toolbox): DIN/ISO bolts, screws, nuts and washers generated
// as ordinary part feature lists. Threads are not modelled (nominal diameter).
// Convention: axis = +Y. Bolts: underside of head at y=0, shank towards -Y
// (countersunk: top of head at y=0). Nuts/washers: bottom face at y=0.
const SIZES = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20', 'M24'];
const col = (arr) => Object.fromEntries(SIZES.map((s, i) => [s, arr[i]]).filter(([, v]) => v != null));
const D = col([3, 4, 5, 6, 8, 10, 12, 16, 20, 24]);
const PITCH = col([0.5, 0.7, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
const HEX_S = col([5.5, 7, 8, 10, 13, 17, 19, 24, 30, 36]); // DIN 933/934 (ISO: M10=16, M12=18)
const HEX_K = col([2, 2.8, 3.5, 4, 5.3, 6.4, 7.5, 10, 12.5, 15]);
const NUT_M = col([2.4, 3.2, 4, 5, 6.5, 8, 10, 13, 16, 19]); // DIN 934
const NYLOC_H = col([4, 5, 5, 6, 8, 10, 12, 16, 20, 24]); // DIN 985
const SHCS_DK = col([5.5, 7, 8.5, 10, 13, 16, 18, 24, 30, 36]); // DIN 912
const SHCS_S = col([2.5, 3, 4, 5, 6, 8, 10, 14, 17, 19]);
const SHCS_T = col([1.3, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]);
const CSK_DK = col([6, 8, 10, 12, 16, 20, 24, 30, 36]); // DIN 7991
const CSK_K = col([1.7, 2.3, 2.8, 3.3, 4.4, 5.5, 6.5, 7.5, 8.5]);
const CSK_S = col([2, 2.5, 3, 4, 5, 6, 8, 10, 12]);
const CSK_T = col([1.2, 1.8, 2.3, 2.5, 3.5, 4.4, 4.6, 5.3, 5.9]);
const W125_D1 = col([3.2, 4.3, 5.3, 6.4, 8.4, 10.5, 13, 17, 21, 25]); // DIN 125-A
const W125_D2 = col([7, 9, 10, 12, 16, 20, 24, 30, 37, 44]);
const W125_H = col([0.5, 0.8, 1, 1.6, 1.6, 2, 2.5, 3, 3, 4]);
const W9021_D2 = col([9, 12, 15, 18, 24, 30, 37, 50, 60, 72]); // DIN 9021
const W9021_H = col([0.8, 1, 1.2, 1.6, 2, 2.5, 3, 3, 4, 5]);
const LENGTHS = [6, 8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];

export const FASTENERS = [
  { id: 'DIN933', group: 'Bolts & screws', label: 'DIN 933 – Hex bolt, full thread (ISO 4017)', sizes: SIZES, lengths: (d) => LENGTHS.filter((l) => l >= 2 * d && l <= 10 * d + 40) },
  { id: 'DIN931', group: 'Bolts & screws', label: 'DIN 931 – Hex bolt, partial thread (ISO 4014)', sizes: SIZES.slice(2), lengths: (d) => LENGTHS.filter((l) => l >= 4 * d + 10 && l <= 12 * d + 60) },
  { id: 'DIN912', group: 'Bolts & screws', label: 'DIN 912 – Socket head cap screw (ISO 4762)', sizes: SIZES, lengths: (d) => LENGTHS.filter((l) => l >= 1.5 * d && l <= 10 * d + 40) },
  { id: 'DIN7991', group: 'Bolts & screws', label: 'DIN 7991 – Countersunk socket screw (ISO 10642)', sizes: SIZES.slice(0, 9), lengths: (d) => LENGTHS.filter((l) => l >= 2 * d && l <= 8 * d + 20) },
  { id: 'DIN934', group: 'Nuts', label: 'DIN 934 – Hex nut (ISO 4032)', sizes: SIZES },
  { id: 'DIN985', group: 'Nuts', label: 'DIN 985 – Nyloc nut, thin (ISO 10511)', sizes: SIZES },
  { id: 'DIN125', group: 'Washers', label: 'DIN 125-A – Plain washer (ISO 7089)', sizes: SIZES },
  { id: 'DIN9021', group: 'Washers', label: 'DIN 9021 – Large washer (ISO 7093)', sizes: SIZES },
];
export const fastenerDef = (id) => FASTENERS.find((f) => f.id === id);
export const hasLength = (id) => !!fastenerDef(id)?.lengths;
export const sizeDia = (size) => D[size];

const plane = (y) => ({ origin: [0, y, 0], normal: [0, 1, 0], xDir: [1, 0, 0] });
const FRONT = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
let uid = 0;
function polySketch(id, name, pl, pts, circles = []) {
  const geo = [];
  pts.forEach((p, i) => geo.push({ id: 'p' + i, type: 'point', x: p[0], y: p[1] }));
  pts.forEach((_, i) => geo.push({ id: 'l' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % pts.length) }));
  circles.forEach(([x, y, r], i) => geo.push({ id: 'cc' + i, type: 'point', x, y }, { id: 'c' + i, type: 'circle', c: 'cc' + i, r }));
  return { id, name, type: 'sketch', plane: pl, geo, cons: [], visible: false };
}
function circleSketch(id, name, pl, radii) {
  const geo = [];
  radii.forEach((r, i) => geo.push({ id: 'cc' + i, type: 'point', x: 0, y: 0 }, { id: 'c' + i, type: 'circle', c: 'cc' + i, r }));
  return { id, name, type: 'sketch', plane: pl, geo, cons: [], visible: false };
}
const hexPts = (s) => { const R = s / Math.sqrt(3); return Array.from({ length: 6 }, (_, i) => [R * Math.cos((i * Math.PI) / 3), R * Math.sin((i * Math.PI) / 3)]); };
const ext = (id, name, sketch, depth, extra = {}) => ({ id, name, type: 'extrude', sketch, depth, end: 'blind', op: 'boss', reverse: false, ...extra });

export function fastenerName(id, size, L) {
  return `${id.replace('DIN', 'DIN ')} ${size}${hasLength(id) ? 'x' + L : ''}`;
}

// -> part document (kind 'part')
export function fastenerPart(id, size, L) {
  const d = D[size];
  if (!d) throw new Error('Unknown size ' + size);
  uid++;
  const f = [];
  const props = { standard: id, size, pitch: PITCH[size] };
  if (id === 'DIN933' || id === 'DIN931') {
    f.push(circleSketch('s1', 'Shank', plane(0), [d / 2]), ext('e1', 'Shank', 's1', L, { reverse: true }));
    f.push(polySketch('s2', 'Head', plane(0), hexPts(HEX_S[size])), ext('e2', 'Head', 's2', HEX_K[size]));
    props.threadLength = id === 'DIN933' ? L : L <= 125 ? 2 * d + 6 : L <= 200 ? 2 * d + 12 : 2 * d + 25;
    props.s = HEX_S[size]; props.k = HEX_K[size];
  } else if (id === 'DIN912') {
    const k = d;
    f.push(circleSketch('s1', 'Shank', plane(0), [d / 2]), ext('e1', 'Shank', 's1', L, { reverse: true }));
    f.push(circleSketch('s2', 'Head', plane(0), [SHCS_DK[size] / 2]), ext('e2', 'Head', 's2', k));
    f.push(polySketch('s3', 'Socket', plane(k), hexPts(SHCS_S[size])), { ...ext('e3', 'Hex socket', 's3', SHCS_T[size]), op: 'cut' });
    props.dk = SHCS_DK[size]; props.k = k; props.socket = SHCS_S[size];
  } else if (id === 'DIN7991') {
    const dk = CSK_DK[size], k = CSK_K[size];
    // revolve profile in the XY plane (Front), axis Y; head top at y=0
    const prof = [[0, 0], [dk / 2, 0], [d / 2, -k], [d / 2, -L], [0, -L]];
    f.push(polySketch('s1', 'Profile', FRONT, prof), { id: 'r1', name: 'Body', type: 'revolve', sketch: 's1', axis: { line: 'l4' }, angle: 360, op: 'boss' });
    f.push(polySketch('s2', 'Socket', plane(0), hexPts(CSK_S[size])), { ...ext('e2', 'Hex socket', 's2', CSK_T[size]), op: 'cut' });
    props.dk = dk; props.k = k; props.socket = CSK_S[size];
  } else if (id === 'DIN934' || id === 'DIN985') {
    const m = id === 'DIN934' ? NUT_M[size] : NYLOC_H[size];
    f.push(polySketch('s1', 'Nut', plane(0), hexPts(HEX_S[size]), [[0, 0, d / 2]]), ext('e1', 'Nut', 's1', m));
    props.s = HEX_S[size]; props.m = m;
  } else if (id === 'DIN125' || id === 'DIN9021') {
    const d1 = id === 'DIN125' ? W125_D1[size] : W125_D1[size];
    const d2 = id === 'DIN125' ? W125_D2[size] : W9021_D2[size];
    const h = id === 'DIN125' ? W125_H[size] : W9021_H[size];
    f.push(circleSketch('s1', 'Washer', plane(0), [d2 / 2, d1 / 2]), ext('e1', 'Washer', 's1', h));
    props.d1 = d1; props.d2 = d2; props.h = h;
  } else throw new Error('Unknown standard ' + id);
  return { kind: 'part', version: 1, name: fastenerName(id, size, L), units: 'mm', material: 'Plain Carbon Steel', features: f, rollback: null, next: 20, fastener: props };
}
