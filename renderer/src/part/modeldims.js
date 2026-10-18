// Dimensions shown on the model after double-clicking a face (0.1.85): the same extension lines, dimension line,
// arrows and angle arcs as inside the sketch (sketch/draw.js dimLines), drawn in the label's colour; the label sits on
// its dimension line. Feature depth gets a dimension line along the extrude direction.
import { Sketcher } from '../sketch/sketcher.js';
import { to3 } from './part.js';

// light stand-in for a Sketcher so dimLines / dimAnchor / dirOf work on a stored sketch
export function sketchView(sk) {
  const gm = new Map(sk.geo.map((g) => [g.id, g]));
  const v = Object.create(null);
  v.sk = sk;
  v.G = (id) => gm.get(id);
  v.P = (id) => { const p = gm.get(id); return [p.x, p.y]; };
  for (const k of ['dimLines', 'dimAnchor', 'dirOf']) v[k] = Sketcher.prototype[k];
  return v;
}

// draws the lines of shown dimension d ({c, fr, sk}) and returns the label's screen position (or null)
export function drawModelDimLines(ctx, vp, d, color, dashed) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([4, 3]);
  let at = null;
  try {
    if (d.line) at = depthLine(ctx, vp, d.line);
    else if (d.c && d.skRef) {
      const v = d._view || (d._view = sketchView(d.skRef));
      const anchor = v.dimAnchor(d.c);
      const L = [anchor[0] + (d.c.lp?.[0] ?? 0), anchor[1] + (d.c.lp?.[1] ?? 0)];
      const r = v.dimLines(ctx, d.c, L, (p) => vp.toScreen(to3(d.fr, p)), d.c.type, '');
      at = r?.labelAt || null;
    }
  } catch { at = null; }
  ctx.restore();
  return at;
}

// feature depth: dimension line between two model points with arrows at both ends, short end ticks
function depthLine(ctx, vp, { a, b }) {
  const s = vp.toScreen(a), e = vp.toScreen(b);
  const L = Math.hypot(e[0] - s[0], e[1] - s[1]); if (L < 4) return null;
  const u = [(e[0] - s[0]) / L, (e[1] - s[1]) / L], n = [-u[1], u[0]];
  const seg = (p, q) => { ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
  const arrow = (tip, dir) => { ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(tip[0] - dir[0] * 9 + dir[1] * 2.6, tip[1] - dir[1] * 9 - dir[0] * 2.6); ctx.lineTo(tip[0] - dir[0] * 9 - dir[1] * 2.6, tip[1] - dir[1] * 9 + dir[0] * 2.6); ctx.fill(); };
  seg(s, e);
  seg([s[0] - n[0] * 6, s[1] - n[1] * 6], [s[0] + n[0] * 6, s[1] + n[1] * 6]);
  seg([e[0] - n[0] * 6, e[1] - n[1] * 6], [e[0] + n[0] * 6, e[1] + n[1] * 6]);
  ctx.setLineDash([]);
  arrow(e, u); arrow(s, [-u[0], -u[1]]);
  return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
}
