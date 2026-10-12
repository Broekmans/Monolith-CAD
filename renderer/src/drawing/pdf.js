// Minimal vector PDF writer for drawing sheets (one page per sheet, true scale: 1 mm = 72/25.4 pt).
// Text uses the standard Helvetica fonts (WinAnsi), so no font embedding is needed.
const K = 72 / 25.4;
const n = (v) => (Math.round(v * K * 1000) / 1000).toString();
// WinAnsi: Latin-1 range maps 1:1 for the characters we use; others -> '?'
const WIN = { '€': 128, '‚': 130, '„': 132, '…': 133, '–': 150, '—': 151, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149 };
function pdfStr(s) {
  let out = '(';
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (WIN[ch]) c = WIN[ch]; else if (c > 255) c = 63;
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + ')';
}
// Helvetica widths (1/1000 em) for ASCII 32..126, for right / centre aligned text
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
export function textWidth(s, size, bold = false) {
  let w = 0;
  for (const ch of String(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? HW[c - 32] : 556; }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}
// cap height ≈ 0.72 em: text sizes in prims are cap heights (mm, as on technical drawings)
export const EM = 1 / 0.72;

function hex(c) { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return '0 0 0'; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => (x / 255).toFixed(3)).join(' '); }

function pageContent(prims) {
  const ops = ['1 J 1 j'];
  let lw = -1, dash = '', col = '0 0 0';
  for (const p of prims) {
    if (p.t === 'sel' || p.t === 'annbox') continue;
    if (p.t === 'fill') {
      const c = hex(p.color); ops.push(`${c} rg`);
      const q = p.pts; let s = `${n(q[0])} ${n(q[1])} m`; for (let i = 2; i < q.length; i += 2) s += ` ${n(q[i])} ${n(q[i + 1])} l`; ops.push(s + ' h f');
      continue;
    }
    if (p.t === 'line' || p.t === 'circle') {
      if (p.w !== lw) { ops.push(`${n(p.w)} w`); lw = p.w; }
      const d = p.dash ? `[${p.dash.map(n).join(' ')}] 0 d` : '[] 0 d';
      if (d !== dash) { ops.push(d); dash = d; }
      const c = hex(p.color);
      if (c !== col) { ops.push(`${c} RG`); col = c; }
      if (p.t === 'circle') {
        const [cx, cy] = p.c, r = p.r, k = 0.5523 * r;
        ops.push(`${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c S`);
        continue;
      }
      const q = p.pts;
      if (q.length < 4) continue;
      let s = `${n(q[0])} ${n(q[1])} m`;
      for (let i = 2; i < q.length; i += 2) s += ` ${n(q[i])} ${n(q[i + 1])} l`;
      ops.push(s + ' S');
    } else if (p.t === 'text') {
      const size = p.size * EM, w = textWidth(p.text, size, p.bold);
      const x = p.align === 'c' ? p.x - w / 2 : p.align === 'r' ? p.x - w : p.x;
      const tc = hex(p.color);
      if (p.rot) {
        const c = Math.cos(p.rot), s = Math.sin(p.rot), ox = p.align === 'c' ? -w / 2 : p.align === 'r' ? -w : 0;
        const X = p.x + ox * c, Y = p.y + ox * s;
        ops.push(`BT ${tc} rg /${p.bold ? 'F2' : 'F1'} ${n(size)} Tf ${c.toFixed(6)} ${s.toFixed(6)} ${(-s).toFixed(6)} ${c.toFixed(6)} ${n(X)} ${n(Y)} Tm ${pdfStr(p.text)} Tj ET`);
      } else ops.push(`BT ${tc} rg /${p.bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(x)} ${n(p.y)} Td ${pdfStr(p.text)} Tj ET`);
    }
  }
  return ops.join('\n');
}

// pages: [{w, h (mm), prims}] -> PDF file as a binary string (chars 0..255)
export function makePdf(pages, { title = 'Drawing', creator = 'MonoLith' } = {}) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const cat = add(''), pagesId = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pg of pages) {
    const c = pageContent(pg.prims);
    const cs = add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pg.w)} ${n(pg.h)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cs} 0 R >>`));
  }
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfStr(title)} /Creator ${pdfStr(creator)} /Producer ${pdfStr(creator)} >>`);
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}
