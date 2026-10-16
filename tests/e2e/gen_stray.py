# Copy of a LAZ with one stray point 200 m away (drawing views must keep the whole scan)
import laspy, numpy as np, sys
src, out = sys.argv[1], sys.argv[2]
las = laspy.read(src)
p = las.points[-1:].copy()
o = laspy.LasData(las.header)
o.points = laspy.ScaleAwarePointRecord(np.concatenate([las.points.array, p.array]), las.header.point_format, las.header.scales, las.header.offsets)
o.x[-1] = las.x.max() + 200.0
o.write(out)
print(out, len(o.points))
