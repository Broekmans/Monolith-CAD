# Copy of the synthetic building with a 1.0 m door gap in the west wall (doc y 5..6 m, z < 2.1 m)
import laspy, numpy as np, sys
las = laspy.read(sys.argv[1])
x = np.asarray(las.x) - 150000; y = np.asarray(las.y) - 450000; z = np.asarray(las.z)
cut = (x < 0.05) & (y > 5) & (y < 6) & (z < 2.1)
o = laspy.LasData(las.header); o.points = las.points[~cut]; o.write(sys.argv[2]); print(sys.argv[2], int(cut.sum()), 'points removed')
