// Run with: node tests/grid.test.js
'use strict';
const assert = require('assert');
const G = require('../js/grid/model.js');
const { compile, instantiate } = require('../js/grid/compiler.js');
const L = require('../js/grid/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 3).join('\n     ')); process.exitCode = 1; }
}
function run(prog, N, w, s) {
  const fn = instantiate(prog.code);
  s = s || new Float64Array(prog.nState);
  const d = new Float32Array(N);
  const sc = prog.scopePaths.map(() => new Float64Array(N));
  fn(N, prog.params, s, d, sc, new Float64Array(prog.nSnap), w);
  return { s, d, sc };
}
const defs = L.starterDefs();

test('painting, merging and splitting regions', () => {
  const sh = G.makeSheet(), occ = G.occupancy(sh, defs);
  const a = G.newRegion(sh), b = G.newRegion(sh);
  for (let x = 0; x < 5; x++) G.paint(sh, occ, G.TOP, x, 0, a);
  G.paint(sh, occ, G.TOP, 4, 1, b);
  assert.strictEqual(G.paint(sh, occ, G.TOP, 4, 0, b), 'merged');      // painting into a joins
  assert.strictEqual(Object.keys(sh.regions).length, 1);
  G.erase(sh, G.TOP, 2, 0);                                             // cutting splits
  assert.strictEqual(Object.keys(sh.regions).length, 2);
});

test('a via joins layers; the bottom layer passes under blocks', () => {
  const sh = G.makeSheet();
  G.addBlock(sh, defs, { type: 'add', x: 2, y: 0 });
  const occ = G.occupancy(sh, defs), r = G.newRegion(sh);
  assert.strictEqual(G.paint(sh, occ, G.TOP, 3, 1, r), 'blocked');      // chip body
  assert.strictEqual(G.paint(sh, occ, G.TOP, 2, 0, r), 'ok');           // pad
  for (let x = 0; x < 7; x++) assert.strictEqual(G.paint(sh, occ, G.BOT, x, 1, r), 'ok');
  G.erase(sh, G.TOP, 2, 0);
  assert.strictEqual(G.cellsOf(sh, r).length, 7);
});

test('blocks cannot be placed over a region except on their pads', () => {
  const sh = G.makeSheet(), occ = G.occupancy(sh, defs), r = G.newRegion(sh);
  G.paint(sh, occ, G.TOP, 1, 1, r);
  assert.ok(!G.canPlace(sh, defs, { type: 'add', x: 0, y: 0, rot: 0 }));
  assert.ok(G.canPlace(sh, defs, { type: 'add', x: 1, y: 1, rot: 0 }));  // (1,1) is pad "a"
});

test('rotation moves the pads', () => {
  const fp = G.footprint({ type: 'delay', x: 0, y: 0, rot: 1 }, defs);
  assert.deepStrictEqual([fp.w, fp.h], [1, 3]);
  assert.deepStrictEqual(fp.pads.map((p) => [p.x, p.y]), [[0, 0], [0, 2]]);
});

test('counter: an Add and a flip-flop count; more flip-flops hold older counts', () => {
  const p = compile(L.exampleProject(0));
  assert.ok(p.ok, JSON.stringify(p.errors));
  const { sc, s } = run(p, 5);
  assert.deepStrictEqual(Array.from(sc[0]), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(s).sort((a, b) => a - b), [3, 4, 5]); // after 5 ticks: count 5, 4, 3
});

test('a feedback loop without a flip-flop is an error', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('add', 'add', 4, 2);
  b.konst('add.in0', 'left', 2, 1);
  b.net('add.out0', 'add.in1');
  const p = compile({ root: r, defs, values: {} });
  assert.ok(!p.ok);
  assert.match(p.errors[0].msg, /without a flip-flop/);
  assert.deepStrictEqual(p.problemPaths, ['b1']);
});

test('Phasor at 480 Hz: a period of exactly 100 ticks', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('ph', 'comp', 4, 0, { def: 'Phasor' });
  b.block('s1', 'scope', 12, 0); b.block('s2', 'scope', 12, 6);
  b.konst('ph.in0', 'left', 2, 480);
  b.net('ph.out0', 's1.in0'); b.net('ph.out1', 's2.in0');
  const p = compile({ root: r, defs, values: {} });
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.strictEqual(p.nState, 1);
  const { sc } = run(p, 1200);
  const phase = Array.from(sc[0]);
  assert.ok(Math.max(...phase) <= 1 && Math.min(...phase) >= 0);
  const wraps = phase.map((x, i) => (i > 0 && x < phase[i - 1] ? i : -1)).filter((i) => i > 0);
  assert.ok(wraps.length >= 10);
  for (let k = 1; k < wraps.length; k++) assert.strictEqual(wraps[k] - wraps[k - 1], 100);
  assert.notStrictEqual(phase[301], phase[302]);   // it moves every tick now
});

test('an outer knob overrides the inner default; inner knobs on written registers are dead', () => {
  const p = compile(L.exampleProject(1));
  const st = Object.entries(p.knobState);
  assert.ok(st.some(([k, s]) => k === 'b3' || s === 'ok'));
  assert.ok(st.some(([k, s]) => k.startsWith('b1/') && s === 'overridden'), JSON.stringify(st));
});

test('per-instance knob values are stored by path', () => {
  const proj = L.exampleProject(1);
  const a = compile(proj);
  const vcoKnob = Object.keys(a.knobState).find((k) => k.startsWith('b1/') && k.split('/').length === 2);
  proj.values[vcoKnob] = 999;  // overridden from outside, so has no effect
  assert.deepStrictEqual(Array.from(compile(proj).params), Array.from(a.params));
});

test('two writers on one net is an error', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('a', 'delay', 0, 0); b.block('c', 'delay', 0, 2);
  const occ = G.occupancy(r, defs), rid = G.newRegion(r);
  for (const [x, y] of [[2, 0], [3, 0], [3, 1], [3, 2], [2, 2]]) G.paint(r, occ, G.TOP, x, y, rid);
  const p = compile({ root: r, defs, values: {} });
  assert.ok(!p.ok);
  assert.match(p.errors[0].msg, /2 writers/);
});

test('sequenced synth: audible, not clipping, steps through the sequence', () => {
  const p = compile(L.exampleProject(2));
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.strictEqual(p.nState, 5);  // three phasors, an envelope and a filter
  const N = 48000 * 2, { d } = run(p, N);
  const peak = Math.max(...Array.from(d, Math.abs));
  assert.ok(peak > 0.05 && peak < 0.95, 'peak ' + peak);
});

test('generated code does not change when a knob turns', () => {
  const proj = L.exampleProject(2);
  const a = compile(proj);
  const k = Object.keys(a.knobState).find((x) => a.knobState[x] === 'ok' && !x.includes('/'));
  const [rid] = [k];
  proj.root.regions[rid].value = 7;
  const b = compile(proj);
  assert.strictEqual(a.code, b.code);
  assert.ok(Array.from(b.params).includes(7));
});


// A Sample block, a flip-flop after it, and scopes on both.
function sampleSheet(loop) {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('song', 'sample', 0, 0, { sample: 'x', loop });
  b.block('ff', 'delay', 14, 1);
  b.block('sa', 'scope', 20, 4); b.block('sb', 'scope', 20, 10);
  b.net('song.out0', ['ff.in0', 'sa.in0']);
  b.net('ff.out0', 'sb.in0');
  return { version: 2, root: r, defs, values: {} };
}

test('a sample stack emits one sample per tick and loops', () => {
  const prog = compile(sampleSheet(true));
  assert.ok(prog.ok, JSON.stringify(prog.errors));
  assert.strictEqual(prog.nState, 2);                        // the flip-flop and the read position
  assert.strictEqual(prog.players.length, 1);
  const song = Float32Array.from([0.1, 0.2, 0.3]);
  const { sc, s } = run(prog, 7, [song]);
  assert.deepStrictEqual(Array.from(sc[0], (x) => +x.toFixed(3)), [0.1, 0.2, 0.3, 0.1, 0.2, 0.3, 0.1]);
  // the flip-flop shows the sample from the previous tick: the same clock drives both
  assert.deepStrictEqual(Array.from(sc[1], (x) => +x.toFixed(3)), [0, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3]);
  assert.strictEqual(s[prog.players[0].s], 1);               // read position persists between blocks of ticks
  const again = run(prog, 2, [song], s);
  assert.deepStrictEqual(Array.from(again.sc[0], (x) => +x.toFixed(3)), [0.2, 0.3]);
});

test('a sample stack can play once, and emits 0 with no WAV loaded', () => {
  const prog = compile(sampleSheet(false));
  const { sc } = run(prog, 5, [Float32Array.from([0.5, -0.5])]);
  assert.deepStrictEqual(Array.from(sc[0]), [0.5, -0.5, 0, 0, 0]);
  assert.deepStrictEqual(Array.from(run(prog, 3).sc[0]), [0, 0, 0]);
  const empty = sampleSheet(true); delete empty.root.blocks[0].sample;
  assert.ok(compile(empty).warnings.some((w) => /no WAV/.test(w.msg)));
});

test('the sample example compiles and its counter is named by path', () => {
  const prog = compile(L.exampleProject(3));
  assert.ok(prog.ok);
  assert.strictEqual(prog.players[0].sample, 'demo:factory-song');
  assert.ok(prog.regNames.includes(prog.players[0].path + '#pos'));
});

console.log(`\n${passed} passed`);
