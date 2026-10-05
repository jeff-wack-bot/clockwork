// Run with: node tests/test.js
'use strict';
const assert = require('assert');
const { compile, instantiate } = require('../js/compiler.js');
const L = require('../js/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

// Run a compiled program for N ticks, returning DAC output and scope buffers.
function run(prog, N, state) {
  const fn = instantiate(prog.code);
  const r = state || new Float64Array(prog.regNames.length);
  const d = new Float32Array(N);
  const sc = prog.scopePaths.map(() => new Float64Array(N));
  const v = new Float64Array(prog.nNets);
  fn(N, prog.params, r, d, sc, v);
  return { d, sc, r, v };
}
const project = (root, defs) => ({ version: 1, root, defs: defs || L.starterDefs() });

test('counter counts ticks', () => {
  const p = compile(L.exampleProject(L.EXAMPLES[0]));
  assert.ok(p.ok, JSON.stringify(p.errors));
  const { sc } = run(p, 5);
  assert.deepStrictEqual(Array.from(sc[0]), [1, 2, 3, 4, 5]);
});

test('combinational loop is detected and localised', () => {
  const root = L.buildPatch((blk, wire) => {
    const one = blk('const', 0, 0, { value: 1 });
    const a = blk('add', 0, 0);
    const c = blk('copy', 0, 0);
    const s = blk('scope', 0, 0);
    wire(one, 0, a, 0); wire(a, 0, c, 0); wire(c, 0, a, 1); wire(c, 1, s, 0);
  });
  const p = compile(project(root));
  assert.ok(!p.ok);
  assert.match(p.errors[0].msg, /Combinational loop/);
  assert.deepStrictEqual(p.problemPaths.sort(), ['b2', 'b3']);
});

test('fan-out without Copy is rejected', () => {
  const root = L.buildPatch((blk, wire) => {
    const one = blk('const', 0, 0, { value: 1 });
    const s1 = blk('scope', 0, 0);
    const s2 = blk('scope', 0, 0);
    wire(one, 0, s1, 0); wire(one, 0, s2, 0);
  });
  const p = compile(project(root));
  assert.ok(!p.ok);
  assert.match(p.errors[0].msg, /Copy/);
});

test('Phasor at 480 Hz has a period of 100 ticks', () => {
  const root = L.buildPatch((blk, wire) => {
    const hz = blk('const', 0, 0, { value: 480 });
    const ph = blk('comp', 0, 0, { def: 'Phasor' });
    const s1 = blk('scope', 0, 0);
    const s2 = blk('scope', 0, 0);
    wire(hz, 0, ph, 0); wire(ph, 0, s1, 0); wire(ph, 1, s2, 0);
  });
  const p = compile(project(root));
  assert.ok(p.ok, JSON.stringify(p.errors));
  const { sc } = run(p, 1000);
  const wraps = Array.from(sc[1]).map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(wraps.length, 10);
  for (let k = 1; k < wraps.length; k++) assert.strictEqual(wraps[k] - wraps[k - 1], 100);
  assert.ok(Math.max(...sc[0]) <= 1 && Math.min(...sc[0]) >= 0);
});

test('instance panel values override definition defaults', () => {
  const root = L.buildPatch((blk, wire) => {
    const t = blk('const', 0, 0, { value: 1 });
    const seq = blk('comp', 0, 0, { def: 'Seq4', params: { b12: 999 } });
    const s = blk('scope', 0, 0);
    wire(t, 0, seq, 0); wire(seq, 0, s, 0);
  });
  const p = compile(project(root));
  assert.ok(p.ok, JSON.stringify(p.errors));
  const { sc } = run(p, 8);
  // counter: 1,2,3,0,1,2,3,0 -> step 1 (b12) is selected when count = 0
  assert.deepStrictEqual(Array.from(sc[0]), [220, 164.8, 130.8, 999, 220, 164.8, 130.8, 999]);
});

test('Sample&Hold only updates when enabled (clock enable / decimation)', () => {
  const root = L.buildPatch((blk, wire) => {
    const one = blk('const', 0, 0, { value: 1 });
    const add = blk('add', 0, 0);
    const c = blk('copy', 0, 0);
    const d = blk('delay', 0, 0);
    const en = blk('comp', 0, 0, { def: 'Phasor' });
    const hz = blk('const', 0, 0, { value: 48000 / 4 });
    const sh = blk('comp', 0, 0, { def: 'Sample&Hold' });
    const s = blk('scope', 0, 0);
    wire(one, 0, add, 0); wire(d, 0, add, 1); wire(add, 0, c, 0); wire(c, 1, d, 0);
    wire(hz, 0, en, 0);
    wire(c, 0, sh, 0); wire(en, 1, sh, 1); wire(sh, 0, s, 0);
  });
  const p = compile(project(root));
  assert.ok(p.ok, JSON.stringify(p.errors));
  const out = Array.from(run(p, 12).sc[0]);
  // held value changes only every 4th tick
  const changes = out.filter((x, i) => i > 0 && x !== out[i - 1]).length;
  assert.ok(changes >= 2 && changes <= 3, out.join(','));
});

test('the sequenced synth compiles, makes bounded sound and reports resources', () => {
  const p = compile(L.exampleProject(L.EXAMPLES[2]));
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.strictEqual(p.warnings.length, 0, JSON.stringify(p.warnings));
  const { d } = run(p, 48000);
  const peak = Math.max(...Array.from(d).map(Math.abs));
  assert.ok(peak > 0.05 && peak < 0.95, 'peak ' + peak + ' (should be audible and not clipping)');
  assert.ok(p.resources.register >= 6);
  assert.ok(p.critDepth > 3);
});

test('SVF is stable and passes DC through its low-pass output', () => {
  const root = L.buildPatch((blk, wire) => {
    const x = blk('const', 0, 0, { value: 1 });
    const s = blk('comp', 0, 0, { def: 'SVF' });
    const a = blk('scope', 0, 0);
    wire(x, 0, s, 0); wire(s, 0, a, 0);
  });
  const p = compile(project(root));
  const lp = run(p, 20000).sc[0];
  assert.ok(Math.abs(lp[19999] - 1) < 1e-3, 'lp settles to 1, got ' + lp[19999]);
  assert.ok(Math.max(...lp) < 2, 'bounded overshoot');
});

test('every starter module compiles on its own without errors', () => {
  const defs = L.starterDefs();
  for (const name of Object.keys(defs)) {
    const root = L.buildPatch((blk) => { blk('comp', 0, 0, { def: name }); });
    const p = compile(project(root, defs));
    assert.ok(p.ok, name + ': ' + JSON.stringify(p.errors));
  }
});

test('changing a constant does not change the generated code', () => {
  const ex = L.exampleProject(L.EXAMPLES[1]);
  const a = compile(ex);
  ex.root.blocks[0].value = 440;
  const b = compile(ex);
  assert.strictEqual(a.code, b.code);
  assert.notStrictEqual(a.params[0], b.params[0]);
});

test('recursive composite is an error, not a hang', () => {
  const defs = { Loop: { name: 'Loop', blocks: [{ id: 'b1', type: 'comp', def: 'Loop', x: 0, y: 0 }], wires: [], nextId: 2 } };
  const root = L.buildPatch((blk) => { blk('comp', 0, 0, { def: 'Loop' }); });
  const p = compile(project(root, defs));
  assert.ok(!p.ok);
  assert.match(p.errors[0].msg, /contains itself/);
});

console.log(`\n${passed} passed`);
