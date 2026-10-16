// Editing a room / area outline by hand (selected area annotation with pts): grips on corners (squares)
// and wall middles (bars). Drag a wall = move it parallel, the neighbouring walls stretch (corners stay
// square); drag a corner = both walls at it move; right click: split wall here (adds a step to pull out),
// remove corner, make horizontal / vertical, back to detected. Ctrl + corner drag = that corner alone. While dragging, corners and walls snap
// to other room / area outlines only (not the scan); Shift = free.
// The outline is in view-model mm (a.pts); a hand edit sets a.edited.
import { fmt, dialog } from '../ui.js';
import { annValue } from './dims.js';
import { viewScale } from './sheet.js';
import { joinAcross } from './fit.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (a) => { const l = Math.hypot(a[0], a[1]); return l > 1e-9 ? [a[0] / l, a[1] / l] : null; };
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const signedArea = (P) => P.reduce((s, p, i) => s + p[0] * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * p[1], 0) / 2;

// outward normal of edge i (P[i] -> P[i+1]); null for a zero-length edge
export function edgeNormal(P, i) {
  const u = unit(sub(P[(i + 1) % P.length], P[i])); if (!u) return null;
  const sg = signedArea(P) > 0 ? 1 : -1;
  return [u[1] * sg, -u[0] * sg];
}
// move edge i by t mm along its outward normal; neighbours that cross it keep their line (the shared corner
// slides along them), parallel or zero-length neighbours are left in place (the corner moves straight,
// which makes a new square step). Returns a new array.
export function moveEdge(P, i, t) {
  const n = P.length, Q = P.map((p) => p.slice()), N = edgeNormal(P, i);
  if (!N) return Q;
  const a = i, b = (i + 1) % n, d = unit(sub(P[b], P[a]));
  const slide = (k, other) => {
    // corner k is shared with the neighbour edge running from/to `other`
    const nd = unit(sub(P[other], P[k]));
    if (!nd || Math.abs(cross(nd, d)) < 0.02) { Q[k] = [P[k][0] + N[0] * t, P[k][1] + N[1] * t]; return; }
    const s = t / dot(nd, N); // along the neighbour, so that the normal component is t
    Q[k] = [P[k][0] + nd[0] * s, P[k][1] + nd[1] * s];
  };
  slide(a, (a - 1 + n) % n);
  slide(b, (b + 1) % n);
  return Q;
}
// move corner i by the vector m: both walls at it move by their normal component
export function moveCorner(P, i, m) {
  const n = P.length, prev = (i - 1 + n) % n;
  let Q = P;
  const N1 = edgeNormal(P, prev); if (N1) Q = moveEdge(Q, prev, dot(m, N1));
  const N2 = edgeNormal(Q, i); if (N2) Q = moveEdge(Q, i, dot(m, N2));
  return Q;
}

// turn edge i around its midpoint to exactly horizontal (axis 0) or vertical (axis 1); its corners slide along
// the neighbouring walls (they keep their direction). A neighbour parallel to the new direction: the corner
// moves straight across. Returns a new array.
export function makeAxis(P, i, axis) {
  const n = P.length, a = i, b = (i + 1) % n, M = [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2], d = axis === 0 ? [1, 0] : [0, 1];
  const Q = P.map((p) => p.slice());
  const put = (k, other) => {
    const nd = unit(sub(P[other], P[k]));
    if (!nd || Math.abs(cross(nd, d)) < 0.02) { Q[k] = axis === 0 ? [P[k][0], M[1]] : [M[0], P[k][1]]; return; }
    // P[k] + nd·s lies on the new line: its cross-axis coordinate equals M's
    const c = 1 - axis, s = (M[c] - P[k][c]) / nd[c];
    Q[k] = [P[k][0] + nd[0] * s, P[k][1] + nd[1] * s];
  };
  put(a, (a - 1 + n) % n); put(b, (b + 1) % n);
  return Q;
}

export class DrawingOutline {
  // the selected annotation when it is an editable outline
  outlineAnn() { const s = this.selAnn; if (!s) return null; const a = this.ann(s.view, s.id); return a?.type === 'area' && a.pts?.length >= 3 ? { a, v: this.V(s.view) } : null; }
  // grip under sheet point p: corner (6 px) before wall (5 px from the line)
  outlineGripAt(p) {
    const o = this.outlineAnn(); if (!o || this.tool) return null;
    const k = Math.max(1e-6, Math.abs(this.affine().ex[0])), S = o.a.pts.map((q) => this.toSheetPt(o.v, q)), n = S.length;
    for (let i = 0; i < n; i++) if (Math.hypot(S[i][0] - p[0], S[i][1] - p[1]) * k <= 7) return { ...o, kind: 'corner', i };
    for (let i = 0; i < n; i++) {
      const A = S[i], B = S[(i + 1) % n], AB = sub(B, A), l2 = dot(AB, AB); if (l2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, dot(sub(p, A), AB) / l2)), F = [A[0] + AB[0] * t, A[1] + AB[1] * t];
      if (Math.hypot(F[0] - p[0], F[1] - p[1]) * k <= 5) return { ...o, kind: 'edge', i, t };
    }
    return null;
  }
  // grips, drawn on top of the sheet (screen px)
  drawOutlineGrips(ctx) {
    const o = this.outlineAnn(); if (!o || this.tool) return;
    const S = o.a.pts.map((q) => this.S2(this.toSheetPt(o.v, q))), n = S.length;
    ctx.save(); ctx.setLineDash([]); ctx.lineWidth = 1.2; ctx.strokeStyle = '#2a6fd6'; ctx.fillStyle = '#fff';
    for (let i = 0; i < n; i++) {
      const A = S[i], B = S[(i + 1) % n], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L > 30) { const m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L]; ctx.beginPath(); ctx.moveTo(m[0] - u[0] * 8, m[1] - u[1] * 8); ctx.lineTo(m[0] + u[0] * 8, m[1] + u[1] * 8); ctx.lineWidth = 4; ctx.stroke(); ctx.lineWidth = 1.2; }
    }
    for (const q of S) { ctx.fillRect(q[0] - 3.5, q[1] - 3.5, 7, 7); ctx.strokeRect(q[0] - 3.5, q[1] - 3.5, 7, 7); }
    // snap marker while dragging (magenta, like Smart Dimension), dotted guide for H/V alignment
    const sn = this._outSnap;
    if (sn) {
      ctx.strokeStyle = '#d81bd8'; ctx.lineWidth = 1.5;
      for (const gd of [sn.guide, sn.guide2]) if (gd) { const A = this.S2(this.toSheetPt(o.v, gd[0])), B = this.S2(this.toSheetPt(o.v, gd[1])); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); ctx.setLineDash([]); }
      if (sn.line) { const A = this.S2(this.toSheetPt(o.v, sn.line[0])), B = this.S2(this.toSheetPt(o.v, sn.line[1])); ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); ctx.lineWidth = 1.5; }
      if (sn.q) { const C = this.S2(this.toSheetPt(o.v, sn.q)); ctx.beginPath(); ctx.arc(C[0], C[1], 6, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
  }
  // drag start / move (sheet points); returns the drag state used by bind()
  outlineDragStart(g, p) { this._lastFit = null; return { outline: g, p0: p, pts0: g.a.pts.map((q) => q.slice()), snap: this.snapshot(), moved: false }; }
  // snapping is on while dragging; Shift = place freely (same as Smart Dimension)
  outlineDragMove(dr, p, shift, ctrl = false) {
    const { a, v, kind, i } = dr.outline, M0 = this.toModel(v, dr.p0), M1 = this.toModel(v, p);
    this._outSnap = null;
    const tag = () => (this._outSnap?.label ? `  ·  on ${this._outSnap.label}` : '');
    if (kind === 'corner') {
      // the corner goes where the mouse is (from where it was grabbed), or onto the snap target
      let T = add(dr.pts0[i], sub(M1, M0));
      if (!shift) { const sn = this.snapCorner(v, a, i, T, dr.pts0, ctrl); if (sn) { T = sn.q; this._outSnap = sn; } }
      const m = sub(T, dr.pts0[i]);
      // Ctrl + corner: only this corner moves, freely (walls at it may turn)
      if (ctrl) { const Q = dr.pts0.map((q) => q.slice()); Q[i] = T; a.pts = Q; this.app.setStatus(`Corner moved freely ${fmt(Math.hypot(m[0], m[1]), 0)} mm  ·  A = ${fmt(annValue(a) / 1e6, 2)} m²${tag()}`); return; }
      a.pts = moveCorner(dr.pts0, i, m); this.app.setStatus(`Corner moved ${fmt(Math.hypot(m[0], m[1]), 0)} mm  ·  A = ${fmt(annValue(a) / 1e6, 2)} m²${tag()}`); return;
    }
    const N = edgeNormal(dr.pts0, i); if (!N) return;
    let t = dot(sub(M1, M0), N);
    if (!shift) { const sn = this.snapWallT(v, a, dr.pts0, i, t); if (sn) { t = sn.t; this._outSnap = sn; } }
    a.pts = moveEdge(dr.pts0, i, t);
    this.app.setStatus(`Wall moved ${t >= 0 ? '+' : ''}${fmt(t, 0)} mm  ·  A = ${fmt(annValue(a) / 1e6, 2)} m²${tag()}`);
  }
  // other room / area outlines in the same view (model mm)
  otherOutlines(v, a) { return (v.anns || []).filter((b) => b !== a && b.type === 'area' && b.pts?.length >= 3).map((b) => ({ b, P: b.pts })); }
  // corner snap, model point T → {q, label, guide?, line?} or null. Only room / area outlines (never the scan):
  // corners of other rooms (8 px), walls of other rooms (6 px), H/V alignment with any other corner (6 px)
  snapCorner(v, a, i, T, P0 = a.pts, ctrl = false) {
    const s = viewScale(v, this.sheetOf(v)), px = 1 / (this.pxMm() * s), tc = 8 * px, te = 6 * px;
    const others = this.otherOutlines(v, a), nm = (b) => b.label || 'area';
    let best = null;
    for (const { b, P } of others) for (const q of P) { const d = Math.hypot(q[0] - T[0], q[1] - T[1]); if (d <= tc && (!best || d < best.d)) best = { q: q.slice(), d, label: `${nm(b)} corner` }; }
    if (best) return best;
    for (const { b, P } of others) for (let k = 0; k < P.length; k++) {
      const A = P[k], B = P[(k + 1) % P.length], AB = sub(B, A), l2 = dot(AB, AB); if (l2 < 1e-9) continue;
      const u = Math.max(0, Math.min(1, dot(sub(T, A), AB) / l2)), F = [A[0] + AB[0] * u, A[1] + AB[1] * u], d = Math.hypot(F[0] - T[0], F[1] - T[1]);
      if (d <= te && (!best || d < best.d)) best = { q: F, d, label: `${nm(b)} wall`, line: [A, B] };
    }
    if (best) return best;
    // alignment: x and / or y of another corner (this outline's other corners and other rooms)
    // (a normal corner drag also moves the two neighbouring corners: leave those out)
    const nP = P0.length, moving = (k) => k === i || (!ctrl && (k === (i + 1) % nP || k === (i - 1 + nP) % nP));
    const cand = [...P0.filter((_, k) => !moving(k)), ...others.flatMap((o) => o.P)];
    let bx = null, by = null;
    for (const q of cand) { const dx = Math.abs(q[0] - T[0]), dy = Math.abs(q[1] - T[1]); if (dx <= te && (!bx || dx < bx.d)) bx = { d: dx, q }; if (dy <= te && (!by || dy < by.d)) by = { d: dy, q }; }
    if (!bx && !by) return null;
    const q = [bx ? bx.q[0] : T[0], by ? by.q[1] : T[1]], src = bx?.q || by?.q;
    return { q, d: Math.min(bx?.d ?? Infinity, by?.d ?? Infinity), label: bx && by ? 'in line with two corners' : bx ? 'vertical with a corner' : 'horizontal with a corner', guide: [src, q], guide2: bx && by ? [by.q, q] : null };
  }
  // wall snap: offset t of edge i → {t, label, line} for a parallel wall of another room (6 px); not the scan
  snapWallT(v, a, P, i, t) {
    const s = viewScale(v, this.sheetOf(v)), te = 6 / (this.pxMm() * s), n = P.length, A = P[i], B = P[(i + 1) % n], N = edgeNormal(P, i), d = unit(sub(B, A));
    if (!N || !d) return null;
    let best = null;
    for (const { b, P: Q } of this.otherOutlines(v, a)) for (let k = 0; k < Q.length; k++) {
      const C = Q[k], D = Q[(k + 1) % Q.length], e = unit(sub(D, C)); if (!e || Math.abs(cross(e, d)) > 0.02) continue;
      const tt = dot(sub(C, A), N); if (Math.abs(tt - t) <= te && (!best || Math.abs(tt - t) < best.dd)) best = { t: tt, dd: Math.abs(tt - t), label: `${b.label || 'area'} wall`, line: [C, D] };
    }
    if (best) return best;
    return null;
  }
  outlineDragEnd(dr) { this._outSnap = null; dr.outline.a.edited = true; this.pushUndo(dr.snap); this.app.setDirty(true); this.closeProps?.(); try { window.__lithLog?.('OUTLINE', dr.outline.kind, dr.outline.i, 'area', (annValue(dr.outline.a) / 1e6).toFixed(3)); } catch {} }
  outlineMenu(p) {
    const g = this.outlineGripAt(p) || this.outlineEdgeNear(p); if (!g) return [];
    const { a } = g, items = [];
    if (g.kind === 'edge') items.push({ label: 'Split wall here', run: () => this.change(() => { const P = a.pts, A = P[g.i], B = P[(g.i + 1) % P.length], F = [A[0] + (B[0] - A[0]) * g.t, A[1] + (B[1] - A[1]) * g.t]; P.splice(g.i + 1, 0, F.slice(), F.slice()); a.edited = true; }) });
    if (g.kind === 'edge') {
      const P = a.pts, A = P[g.i], B = P[(g.i + 1) % P.length];
      const axis = (k, label) => ({ label, run: () => this.change(() => { a.pts = makeAxis(a.pts, g.i, k); a.edited = true; }) });
      if (Math.abs(A[1] - B[1]) > 0.01) items.push(axis(0, 'Make horizontal'));
      if (Math.abs(A[0] - B[0]) > 0.01) items.push(axis(1, 'Make vertical'));
    }
    if (g.kind === 'corner' && a.pts.length > 3) items.push({ label: 'Remove corner', run: () => this.change(() => { a.pts.splice(g.i, 1); a.edited = true; }) });
    if (a.edited && a.room) items.push({ label: 'Back to detected outline', run: () => this.resetOutline(g.v, a) });
    return items;
  }
  outlineEdgeNear(p) { return this.outlineGripAt(p); }
  async resetOutline(v, a) { this.pushUndo(); delete a.edited; await this.recomputeRoom(v, a, true); this.closeProps?.(); }
  // detection change on a hand-edited room: ask first
  async confirmOverwrite(a) {
    if (!a.edited) return true;
    const r = await dialog({ title: 'Room edited by hand', body: 'This room outline was edited by hand. Recalculate it with the detection settings and lose the hand edits?', buttons: [{ label: 'Recalculate', value: true, primary: true }, { label: 'Keep my edits', value: false }] });
    if (r) delete a.edited;
    return !!r;
  }
}

// union of closed outlines with only horizontal / vertical walls (rooms from the rectangle method, hand
// edits without Ctrl corners). Coordinate grid of all wall positions, cells inside any outline, outer
// boundary traced. Returns the outline, or null when an outline has slanted walls or the result falls apart
// into separate pieces (spaces that do not touch). Wall positions within `snap` mm are merged.
export function unionOrtho(polys, snap = 50, tol = 1) {
  for (const P of polys) for (let i = 0; i < P.length; i++) { const A = P[i], B = P[(i + 1) % P.length]; if (Math.abs(A[0] - B[0]) > tol && Math.abs(A[1] - B[1]) > tol) return null; }
  // wall positions closer than `snap` mm become one (the mean): no 10 mm slivers where two rooms meet
  const uniq = (v) => { v.sort((a, b) => a - b); const g = []; for (const x of v) { const c = g[g.length - 1]; if (c && x - c[c.length - 1] <= snap) c.push(x); else g.push([x]); } return g.map((c) => c.reduce((s, x) => s + x, 0) / c.length); };
  const xs = uniq(polys.flatMap((P) => P.map((p) => p[0]))), ys = uniq(polys.flatMap((P) => P.map((p) => p[1])));
  const nx = xs.length - 1, ny = ys.length - 1; if (nx < 1 || ny < 1) return null;
  const inside = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const on = new Uint8Array(nx * ny), at = (i, j) => (i >= 0 && j >= 0 && i < nx && j < ny ? on[j * nx + i] : 0);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2; if (polys.some((P) => inside(P, cx, cy))) on[j * nx + i] = 1; }
  // pieces: flood fill over 4-neighbours
  const seen = new Uint8Array(nx * ny); let pieces = 0;
  for (let k = 0; k < nx * ny; k++) if (on[k] && !seen[k]) { pieces++; const st = [k]; seen[k] = 1; while (st.length) { const c = st.pop(), i = c % nx, j = (c - i) / nx; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (at(a, b) && !seen[b * nx + a]) { seen[b * nx + a] = 1; st.push(b * nx + a); } } } }
  if (pieces !== 1) return null;
  // boundary edges counter-clockwise around filled cells (grid vertex indices), then chain them
  const next = new Map(), key = (i, j) => i + ',' + j;
  const edge = (a, b) => { const k = key(...a); if (!next.has(k)) next.set(k, []); next.get(k).push(b); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) edge([i, j], [i + 1, j]);
    if (!at(i + 1, j)) edge([i + 1, j], [i + 1, j + 1]);
    if (!at(i, j + 1)) edge([i + 1, j + 1], [i, j + 1]);
    if (!at(i - 1, j)) edge([i, j + 1], [i, j]);
  }
  const loops = [];
  while (next.size) {
    const [k0, l0] = next.entries().next().value; let cur = k0.split(',').map(Number), loop = [];
    let to = l0.pop(); if (!l0.length) next.delete(k0);
    loop.push(cur);
    for (let g = 0; g < 1e6; g++) {
      cur = to; const k = key(...cur); if (k === k0) break; loop.push(cur);
      const l = next.get(k); if (!l) break; to = l.pop(); if (!l.length) next.delete(k);
    }
    loops.push(loop);
  }
  const area = (L) => Math.abs(L.reduce((s, p, i) => { const q = L[(i + 1) % L.length]; return s + xs[p[0]] * ys[q[1]] - xs[q[0]] * ys[p[1]]; }, 0));
  loops.sort((a, b) => area(b) - area(a));
  const pts = loops[0].map(([i, j]) => [xs[i], ys[j]]);
  // drop points in the middle of a straight wall
  const out = pts.filter((p, i) => { const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length]; return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-6; });
  return out.length >= 4 ? out : null;
}

// two spaces of one room: overlapping / touching → union; on both sides of a wall (≤ maxGap mm) → union
// through the doorway(s) found in that wall. {poly, doors?} or {reason: 'slanted' | 'far' | 'closed'}
export function joinRooms(P, Q, d, maxGap = 400) {
  const slanted = (R) => R.some((A, i) => { const B = R[(i + 1) % R.length]; return Math.abs(A[0] - B[0]) > 1 && Math.abs(A[1] - B[1]) > 1; });
  if (slanted(P) || slanted(Q)) return { reason: 'slanted' };
  const U = unionOrtho([P, Q]);
  if (U) return { poly: U };
  if (!d || !(maxGap > 0)) return { reason: 'far' };
  const j = joinAcross(P, Q, d, maxGap);
  if (!Array.isArray(j)) return j;
  const U2 = unionOrtho([P, Q, ...j.map((b) => b.rect)]);
  return U2 ? { poly: U2, doors: j } : { reason: 'far' };
}
export const JOIN_MSG = {
  slanted: 'This room has a slanted wall (Ctrl corner): spaces can only be added to rooms with square walls',
  far: 'This space does not touch the room and is not just behind its wall (see "Join across walls up to" in the room settings)',
};
