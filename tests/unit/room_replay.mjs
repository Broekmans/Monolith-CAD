// Rerun the room detection of a room test file (CAD Program\Logs\rooms\room-*.json, written by the app on
// every Room click) with the same scan sample, optionally other settings, and draw it as SVG.
//   node tests/unit/room_replay.mjs <room.json> ['{"close":1600}'] [out.svg]
import fs from 'node:fs';
import { fitData, roomAt, near, mergeData } from '../../renderer/src/drawing/fit.js';
const [file, optsJson, svgOut] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
const opts = { ...R.opts, ...(optsJson ? JSON.parse(optsJson) : {}) };
const d = mergeData((R.fits || [R.fit]).map(fitData));
const area = (Q) => Math.abs(Q.reduce((a, p, i) => a + p[0] * Q[(i + 1) % Q.length][1] - Q[(i + 1) % Q.length][0] * p[1], 0)) / 2e6;
const t0 = performance.now(), poly = roomAt(d, R.q, 25000, opts);
console.log(JSON.stringify({ file: file.split(/[\\/]/).pop(), view: R.view, q: R.q.map(Math.round), opts, pts: d.n, cell: +d.cell.toFixed(1), logged: R.result ? { area: +area(R.result).toFixed(3), n: R.result.length } : null, now: poly ? { area: +area(poly).toFixed(3), n: poly.length } : null, ms: Math.round(performance.now() - t0) }));
if (svgOut) {
  const P = poly || R.result || [], all = [...P, R.q];
  const bx = [Math.min(...all.map((p) => p[0])) - 1500, Math.min(...all.map((p) => p[1])) - 1500, Math.max(...all.map((p) => p[0])) + 1500, Math.max(...all.map((p) => p[1])) + 1500];
  const W = 1400, k = W / (bx[2] - bx[0]), H = Math.round((bx[3] - bx[1]) * k), X = (x) => ((x - bx[0]) * k).toFixed(1), Y = (y) => ((bx[3] - y) * k).toFixed(1);
  const cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2, ids = near(d, [cx, cy], Math.hypot(bx[2] - bx[0], bx[3] - bx[1]) / 2 + 100);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff">`;
  s += `<path d="${ids.filter((i) => d.x[i] >= bx[0] && d.x[i] <= bx[2] && d.y[i] >= bx[1] && d.y[i] <= bx[3]).map((i) => `M${X(d.x[i])} ${Y(d.y[i])}h1`).join('')}" stroke="#555" stroke-width="1.2"/>`;
  if (R.result) s += `<polygon points="${R.result.map((p) => X(p[0]) + ',' + Y(p[1])).join(' ')}" fill="none" stroke="#e33" stroke-width="2" stroke-dasharray="6 3"/>`;
  if (poly) s += `<polygon points="${poly.map((p) => X(p[0]) + ',' + Y(p[1])).join(' ')}" fill="rgba(40,110,220,.12)" stroke="#2a6fd6" stroke-width="2"/>`;
  s += `<circle cx="${X(R.q[0])}" cy="${Y(R.q[1])}" r="6" fill="#d0f"/><text x="8" y="20" font-size="16">${R.view} q=${R.q.map(Math.round)} red=logged blue=now ${JSON.stringify(opts)}</text></svg>`;
  fs.writeFileSync(svgOut, s);
}
