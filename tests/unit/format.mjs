// File format upgrades (shared/format.mjs): node tests/unit/format.mjs [file.lith*…]
// Extra arguments: real documents that must open unchanged at the current format.
import fs from 'node:fs';
import { FORMAT, upgradeDoc, _steps } from '../../shared/format.mjs';
import { totalTime, valuesAt } from '../../shared/motion.mjs';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// 1. every kind has a version and new documents are current
for (const k of ['part', 'assembly', 'plan', 'drawing', 'cloud']) ok(FORMAT[k] >= 1, `${k} has format ${FORMAT[k]}`);
const cur = upgradeDoc({ kind: 'part', version: FORMAT.part, features: [] });
ok(!cur.upgraded && !cur.newer && cur.doc.version === FORMAT.part, 'current part stays as it is');

// 2. a file without a version counts as version 1
const nov = upgradeDoc({ kind: 'plan', entities: [] });
ok(nov.from === 1 && nov.doc.version === FORMAT.plan, 'no version → 1 → current');

// 3. a file from a newer program is left alone and flagged
const nw = upgradeDoc({ kind: 'drawing', version: FORMAT.drawing + 3, x: 1 });
ok(nw.newer && nw.doc.version === FORMAT.drawing + 3 && nw.doc.x === 1, 'newer file flagged, untouched');

// 4. steps run in order (temporary fake format 1 → 3 for 'cloud')
const save = FORMAT.cloud;
FORMAT.cloud = 3;
_steps.cloud[1] = (d) => { d.clouds = d.scans; delete d.scans; };
_steps.cloud[2] = (d) => { d.clouds.forEach((c) => { c.path = c.file; delete c.file; }); };
const old = upgradeDoc({ kind: 'cloud', version: 1, scans: [{ file: 'a.laz' }] });
ok(old.upgraded && old.from === 1 && old.to === 3 && old.doc.version === 3 && old.doc.clouds[0].path === 'a.laz' && !old.doc.scans, 'steps 1→2→3 applied in order');
let threw = false;
FORMAT.cloud = 4;
try { upgradeDoc({ kind: 'cloud', version: 1, scans: [] }); } catch { threw = true; }
ok(threw, 'missing step is an error, not a silent half upgrade');
delete _steps.cloud[1]; delete _steps.cloud[2]; FORMAT.cloud = save;

// 5. part 1 → 2: old refKey on real sketch geometry removed; invisible references (construction) keep it
{
  const sk = { type: 'sketch', geo: [{ id: 'a', type: 'line', refKey: 'e:1', construction: false }, { id: 'b', type: 'point', refKey: 'v:1' }, { id: 'c', type: 'line', refKey: 'e:2', construction: true }, { id: 'd', type: 'line' }] };
  const r = upgradeDoc({ kind: 'part', version: 1, features: [sk, { type: 'extrude' }] });
  const G = (id) => r.doc.features[0].geo.find((g) => g.id === id);
  ok(r.doc.version >= 2 && !('refKey' in G('a')) && G('b').refKey === 'v:1' && G('c').refKey === 'e:2' && !('refKey' in G('d')), 'part 1→2: old refKey dropped from real lines, construction references + vertex reference points kept');
}

// 5b. assembly 1 → 2 (0.1.124): Motion Study steps after/with + delay → own start times
{
  const r = upgradeDoc({ kind: 'assembly', version: 1, components: [], mates: [], motion: { playback: 'loop', steps: [
    { id: 'a', mate: 'm1', from: 0, to: 1, dur: 1, after: true }, { id: 'b', mate: 'm2', from: 0, to: 1, dur: 2, after: true, delay: 0.5 }, { id: 'c', mate: 'm1', from: 1, to: 0, dur: 1, after: false, delay: 0.25 }] } });
  const st = r.doc.motion.steps;
  ok(r.doc.version >= 2 && st.map((s) => s.start).join() === '0,1.5,1.75' && st.every((s) => !('after' in s) && !('delay' in s)) && r.doc.motion.playback === 'loop', 'assembly 1→2: steps get their own start time, after/delay gone');
  ok(upgradeDoc({ kind: 'assembly', version: 1, components: [], mates: [] }).doc.version === FORMAT.assembly, 'assembly 1→2 without a motion study');
}
{ // 0.1.127: assembly 2 → 3 changes nothing (mates may use origin planes from now on; older versions warn)
  const src = { kind: 'assembly', version: 2, components: [{ id: 'c1', pos: [1, 2, 3], rot: [0, 0, 0, 1] }], mates: [{ id: 'm1', type: 'coincident', a: { comp: 'c1', kind: 'face', id: 3 }, b: { comp: 'c1', kind: 'face', id: 4 } }], motion: { steps: [{ id: 's', mate: 'm1', start: 0.5, dur: 1 }] } };
  const r = upgradeDoc(JSON.parse(JSON.stringify(src)));
  ok(FORMAT.assembly === 3 && r.doc.version === 3 && JSON.stringify({ ...r.doc, version: 2 }) === JSON.stringify(src), 'assembly 2→3: version raised, nothing else changed');
}
// 6. real files (a version-1 part only gets its version raised unless it has old refKeys on real geometry)
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const old = (d.features || []).reduce((n, f) => n + (f.geo || []).filter((g) => g.refKey && !g.construction && g.type !== 'point').length, 0);
  const before = JSON.stringify(d);
  const r = upgradeDoc(d);
  if (old) ok(!r.newer && r.upgraded && JSON.stringify(r.doc).length < before.length, `${f.split('/').pop()}: ${r.kind} format ${r.from} → ${r.to}, ${old} old refKey(s) on real geometry removed`);
  else if (r.kind === 'assembly' && r.from < 2 && JSON.parse(before).motion?.steps?.length) { // motion steps get own start times: same motion
    const o = JSON.parse(before), T = totalTime(o.motion.steps), ts = Array.from({ length: 41 }, (_, k) => (k / 40) * T);
    const same = ts.every((t) => JSON.stringify(valuesAt(o.motion.steps, t)) === JSON.stringify(valuesAt(r.doc.motion.steps, t)));
    ok(!r.newer && same && JSON.stringify({ ...o, version: undefined, motion: undefined }) === JSON.stringify({ ...r.doc, version: undefined, motion: undefined }), `${f.split('/').pop()}: assembly format ${r.from} → ${r.to}, motion steps → own start times, same values at 41 times, rest unchanged`);
  } else ok(!r.newer && JSON.stringify({ ...JSON.parse(before), version: undefined }) === JSON.stringify({ ...r.doc, version: undefined }), `${f.split('/').pop()}: ${r.kind} format ${r.from} → ${r.to}, content unchanged`);
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
