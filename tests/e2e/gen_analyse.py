# Synthetic clouds for the analysis test (e2e_cloudanalyse / node check):
#  shapes.las : floor plane z=0 (10x10 m), sphere r=1 at (5,5,2), cylinder r=0.5 axis Z at (2,8), z 0.2..2.2
#  plane0.las : plane z=0, 4x4 m, 2 cm grid + 1 mm noise    plane50.las : the same raised by 50 mm
#  boxscan.las: surface of a box 1000x600x400 mm (scan coords m, origin corner at (1,1,0)), with 3 mm bulges
import sys, numpy as np, laspy
out = sys.argv[1]; rng = np.random.default_rng(7)
X0 = np.array([200000.0, 500000.0, 10.0])  # georeferenced offset
def write(name, P, extra=None):
    h = laspy.LasHeader(point_format=3, version='1.2'); h.scales = [0.0001] * 3; h.offsets = X0
    las = laspy.LasData(h); P = P + X0
    las.x, las.y, las.z = P[:, 0], P[:, 1], P[:, 2]
    las.write(f'{out}/{name}')
n = 120000
fl = np.c_[rng.uniform(0, 10, n), rng.uniform(0, 10, n), rng.normal(0, 0.0005, n)]
u = rng.normal(size=(60000, 3)); u /= np.linalg.norm(u, axis=1)[:, None]; sp = u + [5, 5, 2]
a = rng.uniform(0, 2 * np.pi, 40000); cy = np.c_[2 + 0.5 * np.cos(a), 8 + 0.5 * np.sin(a), rng.uniform(0.2, 2.2, 40000)]
write('shapes.las', np.r_[fl, sp, cy])
g = np.arange(0, 4, 0.02); xx, yy = np.meshgrid(g, g); m = xx.size
p0 = np.c_[xx.ravel(), yy.ravel(), rng.normal(0, 0.001, m)]
write('plane0.las', p0)
p1 = np.c_[xx.ravel() + 0.007, yy.ravel() + 0.011, 0.05 + rng.normal(0, 0.001, m)]
write('plane50.las', p1)
# box surface (m): 1.0 x 0.6 x 0.4 at (1,1,0); points 2 cm away outside on top, 3 mm inside on +x face
S = []
for i in range(30000):
    f = rng.integers(6); x, y, z = rng.uniform(0, 1), rng.uniform(0, 0.6), rng.uniform(0, 0.4)
    if f == 0: z, d = 0.4, (0, 0, 0.02)
    elif f == 1: z, d = 0.0, (0, 0, 0)
    elif f == 2: x, d = 1.0, (-0.003, 0, 0)
    elif f == 3: x, d = 0.0, (0, 0, 0)
    elif f == 4: y, d = 0.0, (0, 0, 0)
    else: y, d = 0.6, (0, 0, 0)
    S.append([1 + x + d[0], 1 + y + d[1], z + d[2]])
write('boxscan.las', np.array(S))
print('ok')
