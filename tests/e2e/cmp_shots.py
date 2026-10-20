# Compare two folders of look-*.png screenshots: python3 tests/e2e/cmp_shots.py <dirA> <dirB>
import sys, glob, os
from PIL import Image, ImageChops
a, b = sys.argv[1], sys.argv[2]
for f in sorted(glob.glob(os.path.join(a, 'look-*.png'))):
    g = os.path.join(b, os.path.basename(f))
    if not os.path.exists(g): print('missing', g); continue
    d = ImageChops.difference(Image.open(f).convert('RGB'), Image.open(g).convert('RGB'))
    n = sum(1 for p in d.getdata() if max(p) > 8)
    print(os.path.basename(f), 'differing pixels:', n, 'bbox', d.getbbox())
