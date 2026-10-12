# Synthetic clouds for the registration test (e2e_cloudregister):
#   python3 tests/e2e/gen_register.py ../scratch/rg
#  room.las      : room 8x6x3 m with a block and a pillar, 1 mm noise (reference)
#  room_moved.las: an independent scan of the same room, moved by the inverse of TRUE (5.6 deg tilted axis, ~20 cm)
#  room_yaw.las  : the same, only turned 30 deg about Z and shifted 1 m (level-only test)
#  boxscan2.las  : surface of a 1000x600x400 mm box, corner at (3, 2, 0), turned 20 deg about Z, plus floor
#  truth.json    : abs transforms (p_true = R p_file + t) for room_moved / room_yaw, and the box placement
import sys, json, numpy as np, laspy
out = sys.argv[1]; rng = np.random.default_rng(11)
X0 = np.array([200000.0, 500000.0, 10.0])
def write(name, P):
    h = laspy.LasHeader(point_format=3, version='1.2'); h.scales = [0.0001] * 3; h.offsets = X0
    las = laspy.LasData(h); las.x, las.y, las.z = P[:, 0], P[:, 1], P[:, 2]; las.write(f'{out}/{name}')
def room(n):
    f = rng.integers(0, 9, n); a = rng.uniform(0, 1, n); b = rng.uniform(0, 1, n); z = np.zeros(n); o = np.ones(n)
    opts = [np.c_[a*8, b*6, z], np.c_[a*8, b*6, 3*o], np.c_[z, a*6, b*3], np.c_[8*o, a*6, b*3], np.c_[a*8, z, b*3], np.c_[a*8, 6*o, b*3],
            np.c_[2 + a*1.5, o, b*1.2], np.c_[2 + a*1.5, 1 + b*0.6, 1.2*o], np.c_[6 + 0.2*np.cos(a*6.283), 4 + 0.2*np.sin(a*6.283), b*3]]
    P = np.zeros((n, 3))
    for k in range(9): P[f == k] = opts[k][f == k]
    return P + rng.normal(0, 0.001, (n, 3))
def rotvec(w):
    th = np.linalg.norm(w); k = w / th; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K
write('room.las', room(250000) + X0)
def moved(R, t, n=200000):
    P = room(n) + X0
    return (P - t) @ R  # p_file = R^T (p_true - t)
c = X0 + [4, 3, 1.5]
R1 = rotvec(np.array([0.02, -0.03, 0.09])); t1 = c - R1 @ c + np.array([0.15, -0.12, 0.05])
write('room_moved.las', moved(R1, t1))
a = np.radians(30); R2 = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]]); t2 = c - R2 @ c + np.array([1.0, -0.5, 0.0])
write('room_yaw.las', moved(R2, t2))
b = np.radians(20); Rb = np.array([[np.cos(b), -np.sin(b), 0], [np.sin(b), np.cos(b), 0], [0, 0, 1]]); tb = X0 + [3, 2, 0]
n = 40000; f = rng.integers(0, 5, n); x, y, z = rng.uniform(0, 1, n), rng.uniform(0, 0.6, n), rng.uniform(0, 0.4, n)
z[f == 0] = 0.4; x[f == 1] = 1.0; x[f == 2] = 0.0; y[f == 3] = 0.0; y[f == 4] = 0.6
S = np.c_[x, y, z] @ Rb.T + tb + rng.normal(0, 0.0007, (n, 3))
fl = np.c_[rng.uniform(1.5, 5.5, 40000), rng.uniform(0.5, 4.5, 40000), rng.normal(0, 0.0007, 40000)] + X0
write('boxscan2.las', np.r_[S, fl])
json.dump({'moved': {'R': R1.ravel().tolist(), 't': t1.tolist()}, 'yaw': {'R': R2.ravel().tolist(), 't': t2.tolist()}, 'box': {'R': Rb.ravel().tolist(), 't': tb.tolist()}, 'X0': X0.tolist()}, open(f'{out}/truth.json', 'w'))
print('ok')
