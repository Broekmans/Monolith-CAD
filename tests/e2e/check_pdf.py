# Check a MonoLith drawing PDF: valid structure (pypdf), page sizes in mm, text, longest straight lines.
import sys, re
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
K = 72 / 25.4
for i, p in enumerate(r.pages):
    w, h = float(p.mediabox.width) / K, float(p.mediabox.height) / K
    data = p.get_contents().get_data().decode('latin1')
    lines = re.findall(r'([-\d.]+) ([-\d.]+) m ([-\d.]+) ([-\d.]+) l S', data)
    lens = sorted({round(((float(c) - float(a)) ** 2 + (float(d) - float(b)) ** 2) ** 0.5 / K, 2) for a, b, c, d in lines}, reverse=True)
    txt = p.extract_text().replace('\n', ' | ')
    print(f'page {i + 1}: {w:.1f} x {h:.1f} mm, {len(lines)} single lines, lengths (mm) {lens[:12]}')
    print('  text:', txt[:400])
print('pages', len(r.pages), 'OK')
