// Geometry kernel regression tests (run: npm run test:kernel)
import initOpenCascade from 'opencascade.js/dist/node.js';
import assert from 'node:assert/strict';
import * as K from '../kernel/occ.mjs';
import { parseDxf, planToDxf } from '../renderer/src/io/dxf.js';
import { initSolver, solve, analyzeDefinition } from '../renderer/src/sketch/solver.js';

await K.initKernel(() => initOpenCascade({ module: { print() {}, printErr() {} } }));
await initSolver();
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const rect = (id, plane, x0, y0, x1, y1, extra = []) => ({ id, type: 'sketch', plane, geo: [
  { id: 'p1', type: 'point', x: x0, y: y0 }, { id: 'p2', type: 'point', x: x1, y: y0 }, { id: 'p3', type: 'point', x: x1, y: y1 }, { id: 'p4', type: 'point', x: x0, y: y1 },
  { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }, ...extra], cons: [] });
const circ = (id, plane, cx, cy, r) => ({ id, type: 'sketch', plane, geo: [{ id: 'c0', type: 'point', x: cx, y: cy }, { id: 'c', type: 'circle', c: 'c0', r }], cons: [] });
const vol = (f) => K.massProps(K.regenerate(f).body).volume;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('extrude with hole', () => near(vol([rect('s', K.STD_PLANES.Top, -50, -30, 50, 30, [{ id: 'pc', type: 'point', x: 0, y: 0 }, { id: 'c', type: 'circle', c: 'pc', r: 10 }]), { id: 'e', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }]), 120000 - Math.PI * 100 * 20));
test('revolve', () => near(vol([rect('s', K.STD_PLANES.Front, 0, 0, 20, 50), { id: 'r', type: 'revolve', sketch: 's', axis: { line: 'l4' }, angle: 360, op: 'boss' }]), Math.PI * 400 * 50));
test('shell', () => near(vol([rect('s', K.STD_PLANES.Top, -50, -30, 50, 30), { id: 'e', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' }, { id: 'sh', type: 'shell', faces: [{ c: [0, 20, 0], n: [0, 1, 0] }], thickness: 2 }]), 23232));
test('circular pattern + mirror', () => near(vol([circ('s1', K.STD_PLANES.Top, 0, 0, 50), { id: 'e1', type: 'extrude', sketch: 's1', depth: 10, end: 'blind', op: 'boss' },
  circ('s2', { origin: [0, 10, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, 35, 0, 5), { id: 'e2', type: 'extrude', sketch: 's2', end: 'throughAll', op: 'cut' },
  { id: 'cp', type: 'circularPattern', features: ['e2'], axis: 'Y', count: 6, angle: 360 },
  circ('s3', K.STD_PLANES.Right, 0, 20, 5), { id: 'e3', type: 'extrude', sketch: 's3', depth: 60, end: 'blind', op: 'boss' },
  { id: 'm', type: 'mirror', features: ['e3'], plane: 'Right' }]), Math.PI * 2500 * 10 - 6 * Math.PI * 250 + 2 * Math.PI * 25 * 60));
test('fillet survives upstream edit', () => {
  const f = [rect('s', K.STD_PLANES.Top, -50, -30, 50, 30), { id: 'e', type: 'extrude', sketch: 's', depth: 20, end: 'blind', op: 'boss' },
    { id: 'f', type: 'fillet', edges: [{ mid: [50, 10, 30], type: 'line', dir: [0, 1, 0], bb: { min: [-50, 0, -30], max: [50, 20, 30] } }], radius: 5 }];
  assert.equal(K.regenerate(f).status[2].state, 'ok');
  f[1].depth = 40;
  assert.equal(K.regenerate(f).status[2].state, 'ok');
});
test('STEP and IGES round trip', () => {
  const body = K.regenerate([rect('s', K.STD_PLANES.Top, 0, 0, 10, 10), { id: 'e', type: 'extrude', sketch: 's', depth: 10, end: 'blind', op: 'boss' }]).body;
  for (const [txt, fmt] of [[K.writeStep(body), 'step'], [K.writeIges(body), 'iges']]) {
    const r = K.importToStep(txt, fmt);
    near(K.massProps(K.regenerate([{ id: 'i', type: 'import', format: 'step', data: r.step }]).body).volume, 1000);
  }
});
test('plan model', () => assert.ok(K.massProps(K.buildPlanModel([{ id: 'w', type: 'wall', a: [0, 0], b: [4000, 0], t: 200, h: 2500 }, { id: 'd', type: 'door', wall: 'w', pos: 1000, w: 900, h: 2100 }])).volume > 0));
test('sketch solver: fully defined rectangle', () => {
  const sk = { geo: [{ id: 'O', type: 'point', x: 0, y: 0, fixed: true }, { id: 'p1', type: 'point', x: 1, y: 1 }, { id: 'p2', type: 'point', x: 50, y: 2 }, { id: 'p3', type: 'point', x: 52, y: 30 }, { id: 'p4', type: 'point', x: 0, y: 31 },
    { id: 'l1', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'l2', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'l3', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l4', type: 'line', p1: 'p4', p2: 'p1' }],
  cons: [{ id: 'h1', type: 'horizontal', l: 'l1' }, { id: 'h2', type: 'horizontal', l: 'l3' }, { id: 'v1', type: 'vertical', l: 'l2' }, { id: 'v2', type: 'vertical', l: 'l4' }, { id: 'co', type: 'coincident', a: 'O', b: 'p1' },
    { id: 'd1', type: 'length', l: 'l1', value: 80 }, { id: 'd2', type: 'length', l: 'l2', value: 40 }] };
  const r = solve(sk);
  assert.equal(r.dof, 0);
  assert.equal(analyzeDefinition(sk).size, 0);
  near(sk.geo.find((g) => g.id === 'p3').x, 80);
});
test('DXF write/read', () => {
  const ents = [{ type: 'line', a: [0, 0], b: [10, 0], layer: 'A' }, { type: 'arc', c: [0, 0], r: 5, a0: 0, a1: Math.PI / 2, layer: 'A' }, { type: 'polyline', pts: [[0, 0], [1, 0], [1, 1]], closed: true, layer: 'B' }, { type: 'text', p: [0, 0], h: 2, text: 'Hi', layer: 'B' }];
  const back = parseDxf(planToDxf([{ name: 'A', color: '#ff0000' }, { name: 'B', color: '#0000ff' }], ents));
  assert.equal(back.entities.length, 4);
  assert.deepEqual(back.layers.map((l) => l.name), ['A', 'B']);
});
{
  const { textGeometry } = await import('../renderer/src/sketch/fonts.js');
  const opentype = (await import('opentype.js')).default;
  const fs = await import('node:fs');
  const buf = fs.readFileSync('renderer/fonts/DejaVuSans.ttf');
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  test('sketch text engraving', () => {
    const { outline, segs } = textGeometry(font, "AB8's", 10);
    assert.ok(outline.length >= 7);
    const plate = rect('s', K.STD_PLANES.Top, -30, -15, 30, 15);
    const txt = { id: 't', type: 'sketch', plane: { origin: [0, 5, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, geo: [{ id: 'a', type: 'point', x: -15, y: -5 }, { id: 'tx', type: 'text', p: 'a', text: "AB8's", h: 10, rot: 0, outline, segs }], cons: [] };
    const r = K.regenerate([plate, { id: 'e', type: 'extrude', sketch: 's', depth: 5, end: 'blind', op: 'boss' }, txt, { id: 'c', type: 'extrude', sketch: 't', depth: 1, end: 'blind', op: 'cut' }]);
    assert.ok(r.status.every((x) => x.state === 'ok'));
    const v = K.massProps(r.body).volume;
    assert.ok(v < 9000 && v > 8700, 'engraved volume ' + v);
  });
}
test('cylinder axis + assembly export', () => {
  const f = [circ('s', K.STD_PLANES.Top, 5, 0, 4), { id: 'e', type: 'extrude', sketch: 's', depth: 10, end: 'blind', op: 'boss' }];
  const cyl = K.tessellate(K.regenerate(f).body).faces.find((x) => x.type === 'cylinder');
  near(cyl.r, 4); near(Math.abs(cyl.axis.d[1]), 1); near(cyl.axis.p[0], 5);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], T = [...I]; T[12] = 100;
  const shape = K.assemblyShape([{ body: K.regenerate(f).body, m: I }, { body: K.regenerate(f).body, m: T }]);
  const mp = K.massProps(shape); near(mp.volume, 2 * Math.PI * 160); near(mp.bbox.max[0], 109);
});
console.log(`\n${n} tests passed`);
