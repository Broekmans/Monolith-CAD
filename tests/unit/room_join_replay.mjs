// Rerun a Shift+click join from room test files (CAD Program\Logs\rooms): first file = the room, the others
// are added one by one (same as Room Outline Shift+click), optional settings JSON, optional SVG.
//   node tests/unit/room_join_replay.mjs a.json b.json [c.json ...] ['{"join":400}'] [out.svg]
import fs from 'node:fs';
import { fitData, roomAt, mergeData, near } from '../../renderer/src/drawing/fit.js';
import { joinRooms } from '../../renderer/src/drawing/outline.js';
const args = process.argv.slice(2), files = args.filter((a) => a.endsWith('.json')), extra = args.find((a) => a.startsWith('{')), svgOut = args.find((a) => a.endsWith('.svg'));
const area = (Q) => Math.abs(Q.reduce((a, p, i) => a + p[0] * Q[(i + 1) % Q.length][1] - Q[(i + 1) % Q.length][0] * p[1], 0)) / 2e6;
let poly = null, d = null; const clicks = [];
for (const f of files) {
  const R = JSON.parse(fs.readFileSync(f, 'utf8')), opts = { ...R.opts, ...(extra ? JSON.parse(extra) : {}) };
  d = mergeData((R.fits || [R.fit]).map(fitData));
  const P = roomAt(d, R.q, 25000, opts); clicks.push(R.q);
  if (!P) { console.log(f.split(/[\\/]/).pop(), 'no room'); continue; }
  if (!poly) { poly = P; console.log('room', area(P).toFixed(3)); continue; }
  const J = joinRooms(poly, P, d, opts.join ?? 400);
  console.log('add', area(P).toFixed(3), '→', J.poly ? `${area(J.poly).toFixed(3)} m² ${J.poly.length} corners doorways ${J.doors ? J.doors.map((b) => (b.full ? "full " : "") + Math.round(b.width)).join('/') : '-'}` : J.reason);
  if (J.poly) poly = J.poly;
}
if (svgOut && poly) {
  const all = [...poly, ...clicks], bx = [Math.min(...all.map((p) => p[0])) - 1500, Math.min(...all.map((p) => p[1])) - 1500, Math.max(...all.map((p) => p[0])) + 1500, Math.max(...all.map((p) => p[1])) + 1500];
  const W = 1400, k = W / (bx[2] - bx[0]), H = Math.round((bx[3] - bx[1]) * k), X = (x) => ((x - bx[0]) * k).toFixed(1), Y = (y) => ((bx[3] - y) * k).toFixed(1);
  const ids = near(d, [(bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2], Math.hypot(bx[2] - bx[0], bx[3] - bx[1]) / 2);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${ids.map((i) => `M${X(d.x[i])} ${Y(d.y[i])}h1`).join('')}" stroke="#555" stroke-width="1.2"/>`;
  s += `<polygon points="${poly.map((p) => X(p[0]) + ',' + Y(p[1])).join(' ')}" fill="rgba(40,110,220,.15)" stroke="#2a6fd6" stroke-width="2"/>`;
  for (const q of clicks) s += `<circle cx="${X(q[0])}" cy="${Y(q[1])}" r="6" fill="#d0f"/>`;
  fs.writeFileSync(svgOut, s + '</svg>');
}
