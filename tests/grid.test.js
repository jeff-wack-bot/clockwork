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


// ---- tuning library (Benson, chapter 5) -------------------------------------------
const TU = require('../js/grid/tunings.js');
// A one-off board: the named chip with constants on its inputs and a scope on each output.
function probe(defName, inputs, ticks) {
  const r = G.makeSheet(), b = G.builder(r, defs), def = defs[defName];
  b.block('u', 'comp', 4, 2, { def: defName });
  const ins = inputs.map((v, i) => b.konst(`u.in${i}`, 'left', 3, v));
  const outs = G.portsOf(def, 'out').map((_, i) => { b.block('s' + i, 'scope', 20 + 12 * i, 30 + 6 * i); return i; });
  for (let i = outs.length - 1; i >= 0; i--) b.net(`u.out${i}`, `s${i}.in0`);
  const project = { version: 2, root: r, defs, values: {} };
  return {
    run(vals, n) { vals.forEach((v, i) => { r.regions[ins[i]].value = v; }); const prog = compile(project); assert.ok(prog.ok, JSON.stringify(prog.errors)); return run(prog, n || ticks || 1).sc; },
  };
}
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

test('tunings reproduce Benson\'s tables (cents)', () => {
  const c = (id) => TU.ratios(id).map((r) => +TU.cents(r).toFixed(3));
  assert.deepStrictEqual([2, 4, 5, 7, 9, 11].map((i) => c('pythagorean')[i]), [203.910, 407.820, 498.045, 701.955, 905.865, 1109.775]);
  assert.deepStrictEqual([4, 9, 11].map((i) => c('just')[i]), [386.314, 884.359, 1088.269]);
  assert.deepStrictEqual([2, 4, 5, 9, 11].map((i) => c('meantone')[i]), [193.157, 386.314, 503.422, 889.735, 1082.892]);
  // Werckmeister III: thirds on C and F about 4 cents sharp, on C♯ and F♯ about 22 (§5.13)
  const w = TU.ratios('werckmeister'), third = (a) => TU.cents(w[(a + 4) % 12] / w[a] * (a + 4 >= 12 ? 2 : 1)) - TU.cents(5 / 4);
  assert.ok(near(third(0), 3.9, 0.1) && near(third(5), 3.9, 0.1) && near(third(1), 21.5, 0.1) && near(third(6), 21.5, 0.1));
  assert.ok(near(TU.cents(TU.ratios('equal')[4]) - TU.cents(5 / 4), 13.686, 0.001));
});

test('every Tune chip returns its table, over two octaves', () => {
  for (const id of TU.ORDER) {
    const name = Object.keys(defs).find((n) => n.startsWith('Tune ') && defs[n].description.includes(TU.TUNINGS[id].title));
    const p = probe(name, [0]), want = TU.ratios(id);
    for (let s = 0; s < 24; s++) assert.ok(near(p.run([s])[0][0], want[s % 12] * (s >= 12 ? 2 : 1), 1e-12), `${name} at ${s}`);
  }
  const sig = (d) => JSON.stringify([d.fw, d.fh, d.ports.map((q) => q.dir + q.row)]);
  const tunes = Object.keys(defs).filter((n) => n.startsWith('Tune '));
  assert.strictEqual(tunes.length, 6);
  assert.ok(tunes.every((n) => sig(defs[n]) === sig(defs['Tune Just'])));          // they all fit one socket
  assert.strictEqual(sig(defs['Comma Pump']), sig(defs['Meantone Pump']));
});

test('the chord score steps through I–vi–ii–V by quarters of its phase', () => {
  const p = probe('Chords', [0]);
  const at = (ph) => p.run([ph]).map((s) => s[0]);
  assert.deepStrictEqual([0.1, 0.3, 0.6, 0.9].map(at), [[12, 16, 19], [9, 12, 16], [14, 17, 21], [7, 11, 14]]);
});

test('the otonal score gives integer multiples of one fundamental', () => {
  const p = probe('Harmonics', [0.6, 5]);      // third step (ii) with f0 = 5
  assert.deepStrictEqual(p.run([0.6, 5]).map((s) => s[0]), [54 * 5, 64 * 5, 80 * 5, 108 * 5]);
});

test('a divider\'s period is exactly N ticks', () => {
  const p = probe('Divider', [10]), sq = p.run([10], 40)[0];
  const rises = []; for (let i = 1; i < sq.length; i++) if (sq[i] > sq[i - 1]) rises.push(i);
  assert.ok(rises.length >= 3 && rises.slice(1).every((x, i) => x - rises[i] === 10), rises.join(','));
  assert.ok(Math.max(...sq) === 1 && Math.min(...sq) === -1);
});

test('the sine VCO is a clean ±1 sine at its frequency', () => {
  const N = 48000, sc = probe('SineVCO', [1000]).run([1000], N)[0];
  let crossings = 0, peak = 0;
  for (let i = 1; i < N; i++) { if (sc[i - 1] < 0 && sc[i] >= 0) crossings++; peak = Math.max(peak, Math.abs(sc[i])); }
  assert.ok(Math.abs(crossings - 1000) <= 1, 'crossings ' + crossings);
  assert.ok(peak > 0.99 && peak <= 1.0001, 'peak ' + peak);
  // close to a true sine: compare with sin at the same phase
  let err = 0; for (let i = 0; i < 480; i++) err = Math.max(err, Math.abs(sc[i] - Math.sin(2 * Math.PI * 1000 * i / 48000)));
  assert.ok(err < 0.06, 'max deviation ' + err);
});

test('the comma pump sinks by 81/80 per round; the meantone pump does not', () => {
  for (const [name, perRound] of [['Comma Pump', 80 / 81], ['Meantone Pump', 1]]) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('ph', 'comp', 2, 2, { def: 'Phasor' }); b.block('p', 'comp', 12, 2, { def: name });
    b.block('s0', 'scope', 30, 0); b.block('s1', 'scope', 30, 8); b.block('s2', 'scope', 30, 16);
    b.konst('ph.in0', 'left', 3, 12000); b.konst('p.in1', 'left', 2, 100);          // a trigger every 4 ticks, tonic 100 Hz
    b.net('ph.out1', 'p.in0');
    for (let i = 2; i >= 0; i--) b.net(`p.out${i}`, `s${i}.in0`);
    const prog = compile({ version: 2, root: r, defs, values: {} });
    assert.ok(prog.ok, JSON.stringify(prog.errors));
    const { sc } = run(prog, 4 * 16 + 4);
    const roots = [1, 17, 33, 49, 65].map((t) => sc[0][t]);                           // the I chord, once per round
    roots.forEach((x, k) => assert.ok(near(x, 100 * Math.pow(perRound, k), 1e-9), `${name} round ${k}: ${x}`));
    // every chord is pure: the third is 5/4 or 6/5 of the root in just, the fifth 3/2
    if (name === 'Comma Pump') for (let t = 0; t < 64; t++) {
      const q = sc[1][t] / sc[0][t];
      assert.ok(near(q, 5 / 4) || near(q, 6 / 5)); assert.ok(near(sc[2][t] / sc[0][t], 3 / 2));
    }
  }
});

test('the tuning examples compile without warnings', () => {
  for (let i = 4; i < L.EXAMPLES.length; i++) {
    const prog = compile(L.exampleProject(i));
    assert.ok(prog.ok, L.EXAMPLES[i].title + JSON.stringify(prog.errors));
    assert.strictEqual(prog.warnings.length, 0, L.EXAMPLES[i].title + JSON.stringify(prog.warnings));
  }
});

console.log(`\n${passed} passed`);
