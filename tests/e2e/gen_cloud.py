# Synthetic test scan for e2e_cloud: python3 gen_cloud.py 1e7 ../scratch/pc/big7.laz 7  (needs: pip install laspy lazrs)
import numpy as np, laspy, sys
n=int(float(sys.argv[1])); out=sys.argv[2]; fmt=int(sys.argv[3]) if len(sys.argv)>3 else 7
rng=np.random.default_rng(1)
# building: 30x20 m, 3 floors of 3.5 m; floors + walls
k=rng.integers(0,4,n)
x=rng.uniform(0,30,n); y=rng.uniform(0,20,n); z=rng.integers(0,3,n)*3.5
cls=np.full(n,2,np.uint8)
w=k>=2
side=rng.integers(0,4,n)
z=np.where(w, rng.uniform(0,10.5,n), z)
x=np.where(w&(side==0),0,x); x=np.where(w&(side==1),30,x)
y=np.where(w&(side==2),0,y); y=np.where(w&(side==3),20,y)
cls=np.where(w,6,cls).astype(np.uint8)
x+=rng.normal(0,0.003,n)+150000; y+=rng.normal(0,0.003,n)+450000; z+=rng.normal(0,0.003,n)
h=laspy.LasHeader(point_format=fmt, version="1.4" if fmt>=6 else "1.2")
h.scales=[0.001]*3; h.offsets=[150000,450000,0]
las=laspy.LasData(h); las.x=x; las.y=y; las.z=z
las.intensity=(rng.uniform(0,65535,n)).astype(np.uint16)
las.classification=cls
if fmt in (2,3,7,8):
  las.red=(x%1*65535).astype(np.uint16); las.green=(y%1*65535).astype(np.uint16); las.blue=(z/10.5*65535).clip(0,65535).astype(np.uint16)
las.write(out)
print(out, n)
