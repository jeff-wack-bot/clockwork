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
// Run a program for N ticks (ins: a buffer per In socket). d: the Out sockets summed; tr: for each watched pin key,
// its value on every tick (read from the snapshot, one tick at a time).
function run(prog, N, ins, s, watch) {
  const fn = instantiate(prog.code);
  s = s || new Float64Array(prog.nState);
  const d = new Float32Array(N), v = new Float64Array(prog.nSnap);
  watch = watch || [];
  const tr = watch.map(() => new Float64Array(N));
  if (!watch.length) {
    const o = prog.outs.map(() => new Float32Array(N));
    fn(N, prog.params, s, o, ins || [], v);
    for (const x of o) for (let i = 0; i < N; i++) d[i] += x[i];
    return { s, d, tr };
  }
  const o1 = prog.outs.map(() => new Float32Array(1));
  for (let i = 0; i < N; i++) {
    fn(1, prog.params, s, o1, (ins || []).map((a) => a.subarray(i, i + 1)), v);
    for (const x of o1) d[i] += x[0];
    watch.forEach((k, j) => { const r = prog.netOf[k]; tr[j][i] = r.k === 'p' ? prog.params[r.i] : v[r.v]; });
  }
  return { s, d, tr };
}
const pin = (b, dir, i) => G.ep(b.id, dir, i || 0);
const defs = L.starterDefs();

test('wires join an output to inputs: an input takes one wire, an output feeds any number', () => {
  const sh = G.makeSheet();
  const a = G.addBlock(sh, defs, { type: 'delay', x: 0, y: 0 }), c = G.addBlock(sh, defs, { type: 'add', x: 6, y: 0 });
  const k = G.addBlock(sh, defs, { type: 'const', x: 0, y: 4, value: 2 });
  assert.ok(G.addWire(sh, G.ep(a.id, 'out', 0), G.ep(c.id, 'in', 0)));
  assert.ok(G.addWire(sh, G.ep(a.id, 'out', 0), G.ep(c.id, 'in', 1)));          // fan-out
  assert.strictEqual(G.addWire(sh, G.ep(c.id, 'in', 0), G.ep(a.id, 'in', 0)), null);   // input to input: no
  G.addWire(sh, G.ep(k.id, 'out', 0), G.ep(c.id, 'in', 1));                     // replaces the wire into b
  assert.deepStrictEqual(sh.wires.map((w) => [w.from, w.to]), [[G.ep(a.id, 'out', 0), G.ep(c.id, 'in', 0)], [G.ep(k.id, 'out', 0), G.ep(c.id, 'in', 1)]]);
  G.removeBlocks(sh, new Set([k.id]));
  assert.strictEqual(sh.wires.length, 1);                                       // its wires went with it
});

test('layers and vias are only drawing: a crossing dips under, the connections stay the same', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('a', 'delay', 0, 4); b.block('z', 'delay', 12, 4);                    // a horizontal wire...
  b.block('u', 'delay', 6, 0, { rot: 1 }); b.block('v', 'delay', 6, 8, { rot: 1 });   // ...and a vertical one across it
  b.net('a.out0', 'z.in0'); b.net('u.out0', 'v.in0');
  const L = G.renderLayout(r, defs);
  const bot = Object.keys(L.bot);
  assert.ok(bot.length >= 1, 'one trace passes under the other');
  const nets = new Set(Object.values(L.top).concat(Object.values(L.bot)));
  assert.strictEqual(nets.size, 2);
  const p = compile({ root: r, defs, values: {} });
  assert.ok(p.ok);
  assert.notStrictEqual(p.netOf[G.ep(r.blocks[0].id, 'out', 0)].i, p.netOf[G.ep(r.blocks[2].id, 'out', 0)].i, 'two separate nets');
});

test('blocks go anywhere but on other blocks; wires are re-drawn around them', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('a', 'delay', 0, 0); b.block('z', 'delay', 12, 0);
  b.net('a.out0', 'z.in0');
  assert.ok(G.canPlace(r, defs, { type: 'add', x: 5, y: 0, rot: 0 }), 'over a trace is fine');
  assert.ok(!G.canPlace(r, defs, { type: 'add', x: 11, y: 0, rot: 0 }), 'over a block is not');
  G.addBlock(r, defs, { type: 'add', x: 5, y: 0 });
  const route = G.routesOf(r, defs).get(r.wires[0].id);
  assert.ok(route && route.length >= 2, 'still drawn');
  assert.ok(compile({ root: r, defs, values: {} }).ok);
});

test('rotation moves the pads', () => {
  const fp = G.footprint({ type: 'delay', x: 0, y: 0, rot: 1 }, defs);
  assert.deepStrictEqual([fp.w, fp.h], [1, 3]);
  assert.deepStrictEqual(fp.pads.map((p) => [p.x, p.y]), [[0, 0], [0, 2]]);
});

test('counter: an Add and a flip-flop count; more flip-flops hold older counts', () => {
  const proj = L.exampleProject(0), p = compile(proj);
  assert.ok(p.ok, JSON.stringify(p.errors));
  const ff = proj.root.blocks.find((b) => b.type === 'delay' && b.x === 10);
  const { tr, s } = run(p, 5, null, null, [pin(ff, 'out')]);
  assert.deepStrictEqual(Array.from(tr[0]), [0, 1, 2, 3, 4]);
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
  const ph = b.block('ph', 'comp', 4, 0, { def: 'Phasor' });
  b.konst('ph.in0', 'left', 2, 480);
  const p = compile({ root: r, defs, values: {} });
  assert.ok(p.ok, JSON.stringify(p.errors));
  assert.strictEqual(p.nState, 1);
  const { tr } = run(p, 1200, null, null, [pin(ph, 'out', 0)]);
  const phase = Array.from(tr[0]);
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
  // the editor can't do it (an input takes one wire), but a hand-edited file can
  const r = G.makeSheet(), b = G.builder(r, defs);
  const a = b.block('a', 'delay', 0, 0), c = b.block('c', 'delay', 0, 6), z = b.block('z', 'delay', 8, 3);
  r.wires.push({ id: 'w1', from: pin(a, 'out'), to: pin(z, 'in') }, { id: 'w2', from: pin(c, 'out'), to: pin(z, 'in') });
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
  proj.root.blocks.find((x) => x.id === k).value = 7;
  const b = compile(proj);
  assert.strictEqual(a.code, b.code);
  assert.ok(Array.from(b.params).includes(7));
});


// An In socket and a flip-flop after it; watch both.
test('an In socket reads its input one sample per tick, on the clock that drives the flip-flops', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  const inp = b.block('in', 'in', 0, 1, { name: 'in' }), ff = b.block('ff', 'delay', 14, 1);
  b.net('in.out0', 'ff.in0');
  const prog = compile({ version: 4, root: r, defs, values: {} });
  assert.ok(prog.ok, JSON.stringify(prog.errors));
  assert.deepStrictEqual(prog.ins.map((x) => x.name), ['in']);
  const { tr } = run(prog, 4, [Float32Array.from([0.1, 0.2, 0.3, 0.4])], null, [pin(inp, 'out'), pin(ff, 'out')]);
  assert.deepStrictEqual(Array.from(tr[0], (x) => +x.toFixed(3)), [0.1, 0.2, 0.3, 0.4]);
  assert.deepStrictEqual(Array.from(tr[1], (x) => +x.toFixed(3)), [0, 0.1, 0.2, 0.3]);
  assert.deepStrictEqual(Array.from(run(prog, 2, null, null, [pin(inp, 'out')]).tr[0]), [0, 0], 'nothing linked: silence');
});

// ---- tuning library (Benson, chapter 5) -------------------------------------------
const TU = require('../js/grid/tunings.js');
// A one-off board: the named chip with constants on its inputs; watch every output.
function probe(defName, inputs, ticks) {
  const r = G.makeSheet(), b = G.builder(r, defs), def = defs[defName];
  const u = b.block('u', 'comp', 4, 2, { def: defName });
  const ins = inputs.map((v, i) => b.konst(`u.in${i}`, 'left', 3, v));
  const watch = G.portsOf(def, 'out').map((_, i) => pin(u, 'out', i));
  const project = { version: 3, root: r, defs, values: {} };
  return {
    run(vals, n) { vals.forEach((v, i) => { r.blocks.find((x) => x.id === ins[i]).value = v; }); const prog = compile(project); assert.ok(prog.ok, JSON.stringify(prog.errors)); return run(prog, n || ticks || 1, null, null, watch).tr; },
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
    b.block('ph', 'comp', 2, 2, { def: 'Phasor' }); const pp = b.block('p', 'comp', 12, 2, { def: name });
    b.konst('ph.in0', 'left', 3, 12000); b.konst('p.in1', 'left', 2, 100);          // a trigger every 4 ticks, tonic 100 Hz
    b.net('ph.out1', 'p.in0');
    const prog = compile({ version: 3, root: r, defs, values: {} });
    assert.ok(prog.ok, JSON.stringify(prog.errors));
    const { tr: sc } = run(prog, 4 * 16 + 4, null, null, [0, 1, 2].map((i) => pin(pp, 'out', i)));
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


test('loading an example refreshes stale built-in blocks and keeps the user\'s own', () => {
  // A project saved by an older version: its Phasor has the loop with no flip-flop in it.
  const stale = L.starterDefs();
  const ph = stale.Phasor, ff = ph.blocks.find((b) => b.type === 'delay');
  ff.type = 'add';                                   // the old design: no flip-flop in the loop
  const mine = G.makeDef('MyBlock', 4, 3, 8, [{ dir: 'in', row: 1, name: 'in' }, { dir: 'out', row: 1, name: 'out' }], '');
  stale.MyBlock = mine;
  assert.ok(!compile({ version: 3, root: L.exampleProject(5).root, defs: stale, values: {} }).ok);   // the reported bug
  for (let i = 0; i < L.EXAMPLES.length; i++) {
    const p = L.exampleProject(i, stale);
    assert.ok(compile(p).ok, L.EXAMPLES[i].title);
    assert.ok(p.defs.MyBlock, 'user block kept');
  }
});

console.log(`\n${passed} passed`);
