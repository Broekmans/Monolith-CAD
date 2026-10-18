// Section View handles, drawn in each viewport pane's 2D overlay (Viewport._drawOverlay):
//  - the two dotted lines across the cut plane (glowing red, the colour of the cut face)
//  - an arrow at the plane centre along the plane normal
// Both can be dragged (sectionview.js ensureHandlers → secHandleAt): dragging moves the plane along its normal
// (Wouter 17-10-2026: "move the plane"). Hit areas are stored per pane (vp._secHit) — every pane draws its own.
// Look + grab distance: Options > Section View.
import * as THREE from 'three';
import { opt } from '../app/options.js';

// plane frame from the visible model box (same as the cut face): centre p0, in-plane u/v, half length h
export function secFrame(vp, sec) {
  const box = new THREE.Box3();
  vp.scene.traverse((o) => { if (o.isMesh && !o.userData.isCap && o.visible && o.geometry && !o.material?.transparent) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
  if (box.isEmpty()) return null;
  const n = new THREE.Vector3(...sec.n).normalize();
  const ctr = box.getCenter(new THREE.Vector3());
  const p0 = ctr.clone().addScaledVector(n, -(n.dot(ctr) + sec.c));
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = ref.addScaledVector(n, -n.dot(ref)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const size = box.getSize(new THREE.Vector3()).length();
  return { p0, n, u, v, h: Math.max(size * 0.6, 1), size };
}

const S = (vp, p) => vp.toScreen([p.x, p.y, p.z]);

export function drawSecHandles(vp, ctx) {
  const sec = vp.section;
  vp._secHit = null;
  if (!sec) return;
  const f = secFrame(vp, sec);
  if (!f) return;
  const { p0, n, u, v, h } = f;
  const lines = [[p0.clone().addScaledVector(u, -h), p0.clone().addScaledVector(u, h)], [p0.clone().addScaledVector(v, -h), p0.clone().addScaledVector(v, h)]].map(([a, b]) => [S(vp, a), S(vp, b)]);
  // arrow along the normal: length in px (Options), pointing to the side that stays visible
  const c = S(vp, p0), tip = S(vp, p0.clone().addScaledVector(n, -f.size * 0.01));
  let ad = [tip[0] - c[0], tip[1] - c[1]]; const al = Math.hypot(...ad);
  const L = opt('secArrowPx');
  const arrow = al > 1e-3 ? [c, [c[0] + ad[0] / al * L, c[1] + ad[1] / al * L]] : null;
  const hover = vp._secHover, col = opt('secColor'), glow = opt('secGlow');
  ctx.save();
  ctx.shadowColor = col; ctx.shadowBlur = glow;
  ctx.strokeStyle = col; ctx.lineCap = 'round';
  lines.forEach(([a, b], i) => {
    ctx.lineWidth = opt('secLineW') + (hover === 'line' + i ? 1.5 : 0);
    ctx.setLineDash([9, 6]);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col; // grab dots at both ends
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], hover === 'line' + i ? 5 : 3.5, 0, 7); ctx.fill(); }
  });
  if (arrow) {
    const [a, b] = arrow, dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, w = hover === 'arrow' ? 9 : 7;
    ctx.lineWidth = opt('secLineW') + 1 + (hover === 'arrow' ? 1 : 0);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(b[0] - ux * w, b[1] - uy * w); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(...b); ctx.lineTo(b[0] - ux * 2 * w - uy * w, b[1] - uy * 2 * w + ux * w); ctx.lineTo(b[0] - ux * 2 * w + uy * w, b[1] - uy * 2 * w - ux * w); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(a[0], a[1], 4, 0, 7); ctx.fill();
  }
  ctx.restore();
  if (vp._secLabel) { // value while dragging
    const [x, y, t] = vp._secLabel;
    ctx.font = '600 12px Segoe UI, sans-serif'; const w = ctx.measureText(t).width + 12;
    ctx.fillStyle = 'rgba(20,22,28,0.85)'; ctx.fillRect(x + 14, y - 22, w, 20);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 20, y - 12);
  }
  vp._secHit = { lines, arrow };
}

const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t); };
// 'arrow' | 'line0' | 'line1' | null at pane pixel p
export function secHandleAt(pane, p) {
  const hit = pane?._secHit; if (!hit) return null;
  const tol = opt('secGrabPx');
  if (hit.arrow && segDist(p, ...hit.arrow) <= tol + 2) return 'arrow';
  let best = null, bd = tol;
  hit.lines.forEach(([a, b], i) => { const d = segDist(p, a, b); if (d <= bd) { bd = d; best = 'line' + i; } });
  return best;
}
