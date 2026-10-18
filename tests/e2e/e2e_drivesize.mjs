// 0.1.77: editing a dashed size that follows from other dimensions changes the driving dimension (Wouter's Stonex part,
// copy it to ../scratch/stonex-part.lithprt first). Expect c122 = 15, no warning toast.
import { launch } from './common.mjs';
const T = await launch('part'); const { win, W, idle } = T;
await win.evaluate((p) => lithApp.open(p), '/home/claude/scratch/stonex-part.lithprt'); await W(4000); await idle();
const r = await win.evaluate(async () => {
  const t = lithApp.root.tabs.find((x) => /stonex-part/.test(x.path || '')); const d = t?.doc; if (!d) return { tabs: lithApp.root.tabs.map((x) => x.path) };
  const sk = d.doc.features.find((f) => f.name === 'Sketch3');
  d.dimFeat = sk.id; d.showFeatureDims?.(sk.id);
  const items = (d.featureDims?.() || []).filter((x) => x.kind === 'auto');
  const r10 = items.find((x) => /^R/.test(x.text));
  if (!r10) return { items: items.map((x) => x.text) };
  d.applyShownDim(r10, '15');
  return { status: document.querySelector('.status, #status')?.textContent, c122: sk.cons.find((c) => c.id === 'c122').value, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) };
});
console.log(JSON.stringify(r)); await W(3000); await idle();
console.log('ERRORS:', T.logs?.length ? T.logs.join('\n') : 'none');
await T.app.close();
