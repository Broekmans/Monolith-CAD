// Rigid transforms for registration (point pairs + ICP). Used by the renderer (live point-pair solve)
// and the point cloud worker (ICP). A transform is {R: 3x3 row-major, t: [3]} with p' = R p + t.

export const IDENT = () => ({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
export const rot = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
export const apply = (T, v) => rot(T.R, v).map((x, i) => x + T.t[i]);
export function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
// A after B: p -> A(B(p))
export const compose = (A, B) => ({ R: mul3(A.R, B.R), t: rot(A.R, B.t).map((x, i) => x + A.t[i]) });
export const invert = (T) => { const Rt = [T.R[0], T.R[3], T.R[6], T.R[1], T.R[4], T.R[7], T.R[2], T.R[5], T.R[8]]; return { R: Rt, t: rot(Rt, T.t).map((x) => -x) }; };
// the same transform expressed in a frame shifted by `o` (frame coords = abs - o): T_abs from T_frame
export const fromFrame = (T, o) => ({ R: T.R.slice(), t: T.t.map((x, i) => x + o[i]).map((x, i) => x - rot(T.R, o)[i]) });
export const toFrame = (T, o) => ({ R: T.R.slice(), t: T.t.map((x, i) => x - o[i] + rot(T.R, o)[i]) });
// rotation from a rotation vector (Rodrigues)
export function rotVec(a, b, c) {
  const th = Math.hypot(a, b, c);
  if (th < 1e-15) return [1, -c, b, c, 1, -a, -b, a, 1];
  const x = a / th, y = b / th, z = c / th, C = Math.cos(th), S = Math.sin(th), V = 1 - C;
  return [C + x * x * V, x * y * V - z * S, x * z * V + y * S, y * x * V + z * S, C + y * y * V, y * z * V - x * S, z * x * V - y * S, z * y * V + x * S, C + z * z * V];
}
// angle of a rotation (degrees) and whether it tilts Z
export const angleDeg = (R) => (Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * 180) / Math.PI;

// symmetric 4x4 eigen (Jacobi): largest eigenvector
function maxEig4(N) {
  const a = N.map((r) => r.slice()), V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 4; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 4; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
  }
  let b = 0; for (let i = 1; i < 4; i++) if (a[i][i] > a[b][b]) b = i;
  return [V[0][b], V[1][b], V[2][b], V[3][b]];
}

// Best rigid transform taking src[i] onto dst[i] (least squares, no scale; Horn's quaternion method).
// level: rotation about Z only (tilt kept). Returns {R, t, rms, res: [per pair distance]} or null.
export function solvePairs(src, dst, { level = false, w = null } = {}) {
  const n = src.length;
  if (n < (level ? 2 : 3)) return null;
  let W = 0; const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; W += wi; for (let d = 0; d < 3; d++) { cs[d] += wi * src[i][d]; cd[d] += wi * dst[i][d]; } }
  for (let d = 0; d < 3; d++) { cs[d] /= W; cd[d] /= W; }
  let R;
  if (level) {
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const wi = w ? w[i] : 1, x = src[i][0] - cs[0], y = src[i][1] - cs[1], u = dst[i][0] - cd[0], v = dst[i][1] - cd[1];
      sa += wi * (x * u + y * v); sb += wi * (x * v - y * u);
    }
    const th = Math.atan2(sb, sa), c = Math.cos(th), s = Math.sin(th);
    R = [c, -s, 0, s, c, 0, 0, 0, 1];
  } else {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
      const wi = w ? w[i] : 1, a = [0, 1, 2].map((d) => src[i][d] - cs[d]), b = [0, 1, 2].map((d) => dst[i][d] - cd[d]);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += wi * a[r] * b[c];
    }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz], [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
    const [q0, qx, qy, qz] = maxEig4(N);
    R = [q0 * q0 + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - q0 * qz), 2 * (qx * qz + q0 * qy),
      2 * (qy * qx + q0 * qz), q0 * q0 - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - q0 * qx),
      2 * (qz * qx - q0 * qy), 2 * (qz * qy + q0 * qx), q0 * q0 - qx * qx - qy * qy + qz * qz];
  }
  const t = rot(R, cs).map((x, d) => cd[d] - x);
  const T = { R, t };
  const res = src.map((p, i) => { const q = apply(T, p); return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1], q[2] - dst[i][2]); });
  return { R, t, rms: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n), res };
}

// solve a small symmetric positive system (Gaussian elimination with pivoting); returns null if singular
export function solveSym(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
