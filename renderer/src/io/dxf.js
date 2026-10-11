// DXF import (via dxf-parser) and R12 DXF export for plans and sketches.
import DxfParser from 'dxf-parser';

// ---------- AutoCAD Color Index ----------
const ACI_BASE = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000', 8: '#808080', 9: '#c0c0c0' };
export function aciToHex(i) {
  if (ACI_BASE[i]) return ACI_BASE[i];
  if (i >= 250 && i <= 255) { const v = Math.round(51 + (i - 250) * 40.8); return rgbHex(v, v, v); }
  if (i >= 10 && i <= 249) {
    const hue = (Math.floor(i / 10) - 1) * 15;
    const k = i % 10;
    const vals = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3];
    const sat = k % 2 === 0 ? 1 : 0.5;
    return hsvHex(hue, sat, vals[k]);
  }
  return '#000000';
}
function rgbHex(r, g, b) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
function hsvHex(hh, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return rgbHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
export function hexToAci(hex) {
  if (!hex) return 7;
  const p = (s) => parseInt(s, 16);
  const [r, g, b] = [p(hex.slice(1, 3)), p(hex.slice(3, 5)), p(hex.slice(5, 7))];
  let best = 7, bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const hx = aciToHex(i);
    const d = (p(hx.slice(1, 3)) - r) ** 2 + (p(hx.slice(3, 5)) - g) ** 2 + (p(hx.slice(5, 7)) - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ---------- import ----------
function bulgeArc(p1, p2, bulge) {
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const ux = (p2[0] - p1[0]) / d, uy = (p2[1] - p1[1]) / d;
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const k = (d / 2) * (1 - bulge * bulge) / (2 * bulge);
  const c = [mx - uy * k, my + ux * k];
  const r = (d / 2) * (1 + bulge * bulge) / (2 * Math.abs(bulge));
  let a0 = Math.atan2(p1[1] - c[1], p1[0] - c[0]), a1 = Math.atan2(p2[1] - c[1], p2[0] - c[0]);
  if (bulge < 0) [a0, a1] = [a1, a0];
  return { c, r, a0, a1 };
}

function xform(pt, t) {
  // t: {pos, scale:[sx,sy], rot (rad), base}
  let x = (pt[0] - t.base[0]) * t.scale[0], y = (pt[1] - t.base[1]) * t.scale[1];
  const c = Math.cos(t.rot), s = Math.sin(t.rot);
  return [t.pos[0] + x * c - y * s, t.pos[1] + x * s + y * c];
}

// Parse DXF into neutral 2D entities with layer names and colors.
export function parseDxf(text) {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  const layers = [];
  const layerTable = dxf.tables?.layer?.layers || {};
  for (const [name, L] of Object.entries(layerTable)) {
    layers.push({ name, color: L.color !== undefined ? '#' + Number(L.color).toString(16).padStart(6, '0') : aciToHex(L.colorIndex ?? 7), visible: L.visible !== false, locked: false });
  }
  const out = [];
  const ident = { pos: [0, 0], scale: [1, 1], rot: 0, base: [0, 0] };
  const compose = (outer, inner) => ({ apply: (p) => xform(xform(p, inner), outer) });
  const P = (v) => [v.x, v.y];
  const walk = (ents, T, depth, inheritLayer) => {
    if (depth > 8) return;
    const X = (p) => (T.apply ? T.apply(p) : xform(p, T));
    const scaleK = T.k ?? 1;
    for (const e of ents || []) {
      const layer = e.layer === '0' && inheritLayer ? inheritLayer : e.layer || '0';
      const color = e.colorIndex && e.colorIndex !== 256 && e.colorIndex !== 0 ? aciToHex(e.colorIndex) : undefined;
      const base = { layer, ...(color ? { color } : {}) };
      switch (e.type) {
        case 'LINE': out.push({ type: 'line', a: X(P(e.vertices[0])), b: X(P(e.vertices[1])), ...base }); break;
        case 'LWPOLYLINE': case 'POLYLINE': {
          const vs = e.vertices || [];
          const closed = !!e.shape || !!(e.closed);
          const hasBulge = vs.some((v) => v.bulge);
          if (!hasBulge) { out.push({ type: 'polyline', pts: vs.map((v) => X(P(v))), closed, ...base }); break; }
          const n = vs.length;
          for (let i = 0; i < (closed ? n : n - 1); i++) {
            const a = P(vs[i]), b = P(vs[(i + 1) % n]);
            if (vs[i].bulge) {
              const arc = bulgeArc(a, b, vs[i].bulge);
              const pts = [];
              let sw = arc.a1 - arc.a0; while (sw <= 0) sw += Math.PI * 2;
              for (let k = 0; k <= 24; k++) { const t = arc.a0 + (sw * k) / 24; pts.push(X([arc.c[0] + arc.r * Math.cos(t), arc.c[1] + arc.r * Math.sin(t)])); }
              if (T === ident || T.simple) out.push({ type: 'arc', c: X(arc.c), r: arc.r * scaleK, a0: arc.a0 + (T.rot || 0), a1: arc.a1 + (T.rot || 0), ...base });
              else out.push({ type: 'polyline', pts, closed: false, ...base });
            } else out.push({ type: 'line', a: X(a), b: X(b), ...base });
          }
          break;
        }
        case 'CIRCLE': out.push({ type: 'circle', c: X(P(e.center)), r: e.radius * scaleK, ...base }); break;
        case 'ARC': {
          const r0 = T.rot || 0;
          out.push({ type: 'arc', c: X(P(e.center)), r: e.radius * scaleK, a0: e.startAngle + r0, a1: e.endAngle + r0, ...base });
          break;
        }
        case 'ELLIPSE': {
          const c = P(e.center), mj = P(e.majorAxisEndPoint), ratio = e.axisRatio;
          const a = Math.hypot(mj[0], mj[1]), rot = Math.atan2(mj[1], mj[0]);
          let s0 = e.startAngle ?? 0, s1 = e.endAngle ?? Math.PI * 2; if (s1 <= s0) s1 += Math.PI * 2;
          const pts = [];
          for (let k = 0; k <= 64; k++) {
            const t = s0 + ((s1 - s0) * k) / 64;
            const x = a * Math.cos(t), y = a * ratio * Math.sin(t);
            pts.push(X([c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)]));
          }
          out.push({ type: 'polyline', pts, closed: false, ...base });
          break;
        }
        case 'SPLINE': {
          const src = (e.fitPoints?.length ? e.fitPoints : e.controlPoints) || [];
          if (src.length > 1) out.push({ type: 'polyline', pts: src.map((v) => X(P(v))), closed: !!e.closed, ...base });
          break;
        }
        case 'TEXT': case 'MTEXT': {
          const p = e.startPoint || e.position;
          if (!p) break;
          const txt = String(e.text || '').replace(/\\P/g, '\n').replace(/\{|\}|\\[A-Za-z][^;]*;/g, '');
          out.push({ type: 'text', p: X(P(p)), h: (e.textHeight || e.height || 2.5) * scaleK, text: txt, rot: ((e.rotation || 0) * Math.PI) / 180 + (T.rot || 0), ...base });
          break;
        }
        case 'POINT': out.push({ type: 'point', p: X(P(e.position)), ...base }); break;
        case 'INSERT': {
          const blk = dxf.blocks?.[e.name];
          if (!blk) break;
          const inner = { pos: P(e.position), scale: [e.xScale ?? 1, e.yScale ?? 1], rot: ((e.rotation || 0) * Math.PI) / 180, base: blk.position ? P(blk.position) : [0, 0] };
          const outer = T;
          const combined = { apply: (p) => (outer.apply ? outer.apply(xform(p, inner)) : xform(xform(p, inner), outer)), rot: (outer.rot || 0) + inner.rot, k: (outer.k ?? 1) * Math.abs(inner.scale[0]) };
          walk(blk.entities, combined, depth + 1, layer);
          break;
        }
        case 'DIMENSION': {
          const blk = e.block && dxf.blocks?.[e.block];
          if (blk) walk(blk.entities, T, depth + 1, layer);
          break;
        }
        case 'SOLID': case '3DFACE': {
          const vs = (e.points || e.vertices || []).map((v) => X(P(v)));
          if (vs.length >= 3) out.push({ type: 'polyline', pts: vs, closed: true, ...base });
          break;
        }
        default:
      }
    }
  };
  ident.simple = true;
  walk(dxf.entities, ident, 0, null);
  void compose;
  const units = dxf.header?.$INSUNITS;
  return { layers, entities: out, units };
}

// Import DXF geometry into a Sketcher as lines/arcs/circles (unconstrained,
// with coincident relations where endpoints meet).
export function dxfToSketch(text, sk) {
  const { entities } = parseDxf(text);
  const created = [];
  let n = 0;
  const addLine = (a, b) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) return; const l = sk.addLine(a, b); created.push(l.p1, l.p2); n++; };
  for (const e of entities) {
    if (e.type === 'line') addLine(e.a, e.b);
    else if (e.type === 'polyline') { for (let i = 1; i < e.pts.length; i++) addLine(e.pts[i - 1], e.pts[i]); if (e.closed && e.pts.length > 2) addLine(e.pts[e.pts.length - 1], e.pts[0]); }
    else if (e.type === 'circle') { const c = sk.addPoint(e.c[0], e.c[1]); sk.sk.geo.push({ id: sk.gid(), type: 'circle', c, r: e.r }); n++; }
    else if (e.type === 'arc') {
      const s = [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)], t = [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)];
      const g = sk.makeArc(e.c, s, t, e.r, null); created.push(g.s, g.e); n++;
    }
  }
  // coincident relations for matching endpoints
  const tol = 1e-6;
  const pts = created.map((id) => sk.G(id));
  const used = new Set();
  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < pts.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(pts[i].x - pts[j].x) < tol && Math.abs(pts[i].y - pts[j].y) < tol) { sk.addCons({ type: 'coincident', a: pts[i].id, b: pts[j].id }); used.add(j); }
    }
  }
  return n;
}

// ---------- export (AutoCAD R12 ASCII DXF) ----------
class DxfWriter {
  constructor() { this.out = []; }
  g(code, val) { this.out.push(String(code), typeof val === 'number' ? fmtNum(val) : String(val)); }
  text() { return this.out.join('\r\n') + '\r\n'; }
}
function fmtNum(v) { return Number.isInteger(v) ? String(v) : (Math.round(v * 1e8) / 1e8).toString(); }

function writeDxf(layers, ents) {
  const w = new DxfWriter();
  w.g(0, 'SECTION'); w.g(2, 'HEADER');
  w.g(9, '$ACADVER'); w.g(1, 'AC1009');
  w.g(9, '$INSUNITS'); w.g(70, 4);
  w.g(9, '$MEASUREMENT'); w.g(70, 1);
  w.g(0, 'ENDSEC');
  w.g(0, 'SECTION'); w.g(2, 'TABLES');
  w.g(0, 'TABLE'); w.g(2, 'LTYPE'); w.g(70, 2);
  w.g(0, 'LTYPE'); w.g(2, 'CONTINUOUS'); w.g(70, 0); w.g(3, 'Solid line'); w.g(72, 65); w.g(73, 0); w.g(40, 0);
  w.g(0, 'LTYPE'); w.g(2, 'DASHED'); w.g(70, 0); w.g(3, '__ __ __'); w.g(72, 65); w.g(73, 2); w.g(40, 15); w.g(49, 10); w.g(49, -5);
  w.g(0, 'ENDTAB');
  w.g(0, 'TABLE'); w.g(2, 'LAYER'); w.g(70, layers.length);
  for (const L of layers) {
    w.g(0, 'LAYER'); w.g(2, sanitize(L.name)); w.g(70, 0); w.g(62, (L.visible === false ? -1 : 1) * hexToAci(L.color)); w.g(6, 'CONTINUOUS');
  }
  w.g(0, 'ENDTAB');
  w.g(0, 'TABLE'); w.g(2, 'STYLE'); w.g(70, 1);
  w.g(0, 'STYLE'); w.g(2, 'STANDARD'); w.g(70, 0); w.g(40, 0); w.g(41, 1); w.g(50, 0); w.g(71, 0); w.g(42, 2.5); w.g(3, 'txt'); w.g(4, '');
  w.g(0, 'ENDTAB');
  w.g(0, 'ENDSEC');
  w.g(0, 'SECTION'); w.g(2, 'ENTITIES');
  for (const e of ents) {
    const common = () => { w.g(8, sanitize(e.layer || '0')); if (e.color) w.g(62, hexToAci(e.color)); if (e.ltype) w.g(6, e.ltype); };
    switch (e.type) {
      case 'line': w.g(0, 'LINE'); common(); w.g(10, e.a[0]); w.g(20, e.a[1]); w.g(30, 0); w.g(11, e.b[0]); w.g(21, e.b[1]); w.g(31, 0); break;
      case 'circle': w.g(0, 'CIRCLE'); common(); w.g(10, e.c[0]); w.g(20, e.c[1]); w.g(30, 0); w.g(40, e.r); break;
      case 'arc': w.g(0, 'ARC'); common(); w.g(10, e.c[0]); w.g(20, e.c[1]); w.g(30, 0); w.g(40, e.r); w.g(50, deg(e.a0)); w.g(51, deg(e.a1)); break;
      case 'polyline':
        w.g(0, 'POLYLINE'); common(); w.g(66, 1); w.g(10, 0); w.g(20, 0); w.g(30, 0); w.g(70, e.closed ? 1 : 0);
        for (const p of e.pts) { w.g(0, 'VERTEX'); w.g(8, sanitize(e.layer || '0')); w.g(10, p[0]); w.g(20, p[1]); w.g(30, 0); }
        w.g(0, 'SEQEND'); w.g(8, sanitize(e.layer || '0'));
        break;
      case 'text':
        w.g(0, 'TEXT'); common(); w.g(10, e.p[0]); w.g(20, e.p[1]); w.g(30, 0); w.g(40, e.h); w.g(1, String(e.text).replace(/\n/g, ' ')); if (e.rot) w.g(50, deg(e.rot));
        if (e.align === 'center') { w.g(72, 1); w.g(73, 2); w.g(11, e.p[0]); w.g(21, e.p[1]); w.g(31, 0); }
        break;
      case 'point': w.g(0, 'POINT'); common(); w.g(10, e.p[0]); w.g(20, e.p[1]); w.g(30, 0); break;
      default:
    }
  }
  w.g(0, 'ENDSEC');
  w.g(0, 'EOF');
  return w.text();
}
const deg = (r) => { let d = (r * 180) / Math.PI; d %= 360; if (d < 0) d += 360; return d; };
const sanitize = (s) => String(s).replace(/[<>/\\":;?*|=']/g, '_') || '0';

export function sketchToDxf(sketch) {
  const pts = new Map(sketch.geo.filter((g) => g.type === 'point').map((p) => [p.id, [p.x, p.y]]));
  const ents = [];
  for (const g of sketch.geo) {
    const layer = g.construction ? 'CONSTRUCTION' : 'SKETCH';
    if (g.type === 'line') ents.push({ type: 'line', a: pts.get(g.p1), b: pts.get(g.p2), layer, ltype: g.construction ? 'DASHED' : undefined });
    else if (g.type === 'circle') ents.push({ type: 'circle', c: pts.get(g.c), r: g.r, layer });
    else if (g.type === 'text') {
      const a = pts.get(g.p);
      String(g.text).split('\n').forEach((line, i) => ents.push({ type: 'text', p: [a[0] + Math.sin(g.rot || 0) * i * g.h * 1.45, a[1] - Math.cos(g.rot || 0) * i * g.h * 1.45], h: g.h, text: line, rot: g.rot || 0, layer: 'TEXT' }));
    }
    else if (g.type === 'arc') {
      const c = pts.get(g.c), s = pts.get(g.s), e = pts.get(g.e);
      ents.push({ type: 'arc', c, r: g.r, a0: Math.atan2(s[1] - c[1], s[0] - c[0]), a1: Math.atan2(e[1] - c[1], e[0] - c[0]), layer });
    }
  }
  return writeDxf([{ name: '0', color: '#000000' }, { name: 'SKETCH', color: '#000000' }, { name: 'CONSTRUCTION', color: '#808080' }, { name: 'TEXT', color: '#000000' }], ents);
}

// Plan entities are exploded into DXF primitives by `explodePlan` (in plan.js).
export function planToDxf(layers, primitives) {
  return writeDxf(layers, primitives);
}
