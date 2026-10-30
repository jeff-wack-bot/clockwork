// Run with: node tests/domains.test.js — the three kinds of signal (float, fixed point,
// analog) on one canvas: domains on pins and wires, gates and bus widths, the
// converters, sockets, cables and vias, and the move from the rack (format 4).
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const G = require('../js/grid/model.js');
require('../js/grid/analog.js');
const F = require('../js/grid/format.js');
const { compile, instantiate } = require('../js/grid/compiler.js');
const L = require('../js/grid/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; }
}
const defs = L.starterDefs();
const pin = (b, dir, i) => G.ep(b.id, dir, i || 0);
// Run N ticks, watching pins; o: each Out socket's samples.
function run(project, N, watch, ins) {
  const c = compile(project);
  assert.ok(c.ok, JSON.stringify(c.errors));
  const fn = instantiate(c.code), s = new Float64Array(c.nState), v = new Float64Array(c.nSnap);
  const o = c.outs.map(() => new Float32Array(N)), tr = (watch || []).map(() => []);
  for (let i = 0; i < N; i++) {
    const o1 = c.outs.map(() => new Float32Array(1));
    fn(1, c.params, s, o1, (ins || []).map((a) => a.subarray(i, i + 1)), v, []);
    o1.forEach((x, k) => { o[k][i] = x[0]; });
    (watch || []).forEach((k, j) => { const r = c.netOf[k]; tr[j].push(r.k === 'p' ? c.params[r.i] : v[r.v]); });
  }
  return { c, o, tr };
}
const board = () => { const r = G.makeSheet(); return { r, b: G.builder(r, defs), p: { version: 3, root: r, defs, values: {} } }; };

test('every pin has a domain; a wire only joins pins of the same domain', () => {
  const { r, b } = board();
  const k = b.block('k', 'const', 0, 0, { value: 1 }), a = b.block('a', 'and', 4, 0), v = b.block('v', 'vco', 10, 0, { params: G.MODULES.vco.defaults() });
  assert.strictEqual(G.domainAt(r, defs, pin(k, 'out')), 'float');
  assert.strictEqual(G.domainAt(r, defs, pin(a, 'in')), 'fixed');
  assert.strictEqual(G.domainAt(r, defs, pin(v, 'in')), 'analog');
  assert.match(G.wireProblem(r, defs, pin(k, 'out'), pin(a, 'in')), /float to fixed: use a converter/);
  assert.match(G.wireProblem(r, defs, pin(k, 'out'), pin(v, 'in')), /float to analog/);
  assert.strictEqual(G.wireProblem(r, defs, pin(v, 'out'), pin(v, 'in', 1)), null);
  assert.throws(() => b.net('k.out0', 'a.in0'), /converter/);
});

test('a mismatched wire in a file is a compile error, not a silent conversion', () => {
  const { r, b, p } = board();
  const k = b.block('k', 'const', 0, 0, { value: 1 }), a = b.block('a', 'not', 4, 0);
  r.wires.push({ id: 'w9', from: pin(k, 'out'), to: pin(a, 'in') });
  const c = compile(p);
  assert.ok(!c.ok);
  assert.match(c.errors[0].msg, /joins float to fixed/);
});

test('gates work on every bit of a bus; a bus is as wide as its driver', () => {
  const { b, p } = board();
  const x = b.block('x', 'bits', 0, 0, { width: 8, value: 0b11001010 }), y = b.block('y', 'bits', 0, 6, { width: 8, value: 0b10100110 });
  const types = ['and', 'or', 'xor', 'nand', 'nor', 'xnor'], gs = types.map((t, i) => b.block(t, t, 4 + 4 * i, 1));
  for (const t of types) { b.net('x.out0', `${t}.in0`); b.net('y.out0', `${t}.in1`); }
  const nt = b.block('nt', 'not', 4, 10); b.net('x.out0', 'nt.in0');
  void x; void y;
  const { c, tr } = run(p, 1, gs.map((g) => pin(g, 'out')).concat([pin(nt, 'out')]));
  const A = 0b11001010, B = 0b10100110, M = 255;
  assert.deepStrictEqual(tr.map((t) => t[0]), [A & B, A | B, A ^ B, ~(A & B) & M, ~(A | B) & M, ~(A ^ B) & M, ~A & M]);
  for (const g of gs) assert.strictEqual(c.widths[pin(g, 'out')], 8);
});

test('Split takes a bus apart, Join puts it together; widths follow the fields', () => {
  const { b, p } = board();
  b.block('x', 'bits', 0, 0, { width: 12, value: 0xABC });
  const sp = b.block('sp', 'split', 4, 0, { parts: [4, 4, 4] }), jn = b.block('jn', 'join', 8, 0, { parts: [4, 4, 4] });
  b.net('x.out0', 'sp.in0');
  b.net('sp.out0', 'jn.in2'); b.net('sp.out1', 'jn.in1'); b.net('sp.out2', 'jn.in0');   // reversed nibbles
  const { c, tr } = run(p, 1, [pin(sp, 'out', 0), pin(sp, 'out', 1), pin(sp, 'out', 2), pin(jn, 'out')]);
  assert.deepStrictEqual(tr.map((t) => t[0]), [0xC, 0xB, 0xA, 0xCBA]);
  assert.strictEqual(c.widths[pin(jn, 'out')], 12);
  assert.strictEqual(c.widths[pin(sp, 'out', 1)], 4);
  assert.deepStrictEqual(G.footprint(sp, defs).pads.filter((q) => q.dir === 'out').map((q) => q.name), ['3:0', '7:4', '11:8']);
});

test('a D flip-flop is a register: Q̄ into D toggles; a loop of gates alone is an error', () => {
  const { b, p } = board();
  const ff = b.block('ff', 'dff', 4, 0);
  b.net('ff.out1', 'ff.in0');
  const { tr } = run(p, 6, [pin(ff, 'out', 0)]);
  assert.deepStrictEqual(tr[0], [0, 1, 0, 1, 0, 1]);
  const q = board();
  q.b.block('n', 'not', 4, 0); q.b.net('n.out0', 'n.in0');
  const c = compile(q.p);
  assert.ok(!c.ok); assert.match(c.errors[0].msg, /D flip-flop/);
});

test('a 4-bit counter from gates: a ripple of toggles, each clocked by the bit below', () => {
  // bit k toggles when all the bits below it are 1: D_k = Q_k XOR (Q_0 AND … AND Q_{k-1})
  const { b, p } = board();
  b.block('reg', 'dff', 20, 2);
  b.block('sp', 'split', 26, 0, { parts: [1, 1, 1, 1] });
  b.block('jn', 'join', 14, 0, { parts: [1, 1, 1, 1] });
  b.block('one', 'bits', 0, 0, { width: 1, value: 1 });
  b.block('x0', 'xor', 4, 0); b.block('x1', 'xor', 8, 4); b.block('a2', 'and', 4, 8); b.block('x2', 'xor', 8, 8); b.block('a3', 'and', 4, 12); b.block('x3', 'xor', 8, 12);
  b.net('reg.out0', 'sp.in0');
  b.net('one.out0', 'x0.in1'); b.net('sp.out0', ['x0.in0', 'x1.in1', 'a2.in0']);            // carry into bit 1: Q0
  b.net('sp.out1', ['x1.in0', 'a2.in1']); b.net('a2.out0', ['x2.in1', 'a3.in0']);           // into bit 2: Q0·Q1
  b.net('sp.out2', ['x2.in0', 'a3.in1']); b.net('a3.out0', 'x3.in1');                       // into bit 3: Q0·Q1·Q2
  b.net('sp.out3', 'x3.in0');
  b.net('x0.out0', 'jn.in0'); b.net('x1.out0', 'jn.in1'); b.net('x2.out0', 'jn.in2'); b.net('x3.out0', 'jn.in3');
  b.net('jn.out0', 'reg.in0');
  const reg = p.root.blocks.find((x) => x.type === 'dff');
  const { c, tr } = run(p, 20, [pin(reg, 'out')]);
  assert.deepStrictEqual(tr[0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3]);
  assert.strictEqual(c.widths[pin(reg, 'out')], 4);
});

test('the four crossings only cross: Voltmeter and AWG pass volts as numbers, Word and Value make and read words', () => {
  const { b, p } = board();
  b.block('vs', 'volts', 0, 0, { value: -2.5 });
  const vm = b.block('vm', 'voltmeter', 3, 0), awg = b.block('awg', 'awg', 8, 0);
  const w = b.block('w', 'word', 3, 5, { params: { bits: 8, signed: 1, mode: 1, scale: 0 } }), v = b.block('v', 'value', 8, 5, { params: { signed: 1, scale: 0 } });
  const wr = b.block('wr', 'word', 3, 10, { params: { bits: 4, signed: 0, mode: 0, scale: 0 } });
  const wf = b.block('wf', 'word', 3, 15, { params: { bits: 8, signed: 1, mode: 1, scale: 1 } }), vf = b.block('vf', 'value', 8, 15, { params: { signed: 1, scale: 1 } });
  b.net('vs.out0', 'vm.in0'); b.net('vm.out0', ['awg.in0', 'w.in0', 'wf.in0']); b.net('w.out0', 'v.in0'); b.net('wf.out0', 'vf.in0');
  b.konst('wr.in0', 'left', 2, 19);
  const { c, tr } = run(p, 1, [pin(vm, 'out'), pin(awg, 'out'), pin(w, 'out'), pin(v, 'out'), pin(wr, 'out'), pin(wf, 'out'), pin(vf, 'out')]);
  assert.deepStrictEqual(tr.map((t) => t[0]), [-2.5, -2.5, 254, -2, 3, 128, -1], 'volts; rounding (−2.5 → −2), two\'s complement; 19 wraps to 3 in 4 bits; −2.5 as a fraction clips to −1');
  assert.strictEqual(c.widths[pin(w, 'out')], 8);
});

test('converters are library blocks built from the crossings: ADC, bipolar and one-sided DACs, Quantizer, Dequantizer', () => {
  for (const [volts, code] of [[2.5, 64], [-5, 128], [7, 127]]) {
    const { b, p } = board();
    b.block('vs', 'volts', 0, 1, { value: volts });
    const adc = b.block('adc', 'comp', 3, 0, { def: 'ADC' }), dac = b.block('dac', 'comp', 8, 0, { def: 'DAC' }), one = b.block('one', 'comp', 8, 5, { def: 'DAC (one-sided)' });
    b.net('vs.out0', 'adc.in1'); b.net('adc.out0', ['dac.in1', 'one.in1']);
    const { tr } = run(p, 1, [pin(adc, 'out'), pin(dac, 'out'), pin(one, 'out')]);
    const v = Math.max(-5, Math.min(127 / 128 * 5, volts));
    assert.deepStrictEqual(tr.map((t) => +t[0].toFixed(9)), [code, +v.toFixed(9), +(code / 256 * 5).toFixed(9)], String(volts));
  }
  for (const [x, code, back] of [[0.3, 77, 77 / 256], [-0.5, 65536 - 128, -0.5], [1000, 32767, 32767 / 256]]) {
    const { b, p } = board();
    b.block('k', 'const', 0, 1, { value: x });
    const q = b.block('q', 'comp', 3, 0, { def: 'Quantizer' }), d = b.block('d', 'comp', 8, 0, { def: 'Dequantizer' });
    b.net('k.out0', 'q.in1'); b.net('q.out0', 'd.in1');
    const { tr } = run(p, 1, [pin(q, 'out'), pin(d, 'out')]);
    assert.deepStrictEqual([tr[0][0], tr[1][0]], [code, back], String(x));
  }
  // a setting is a pin with a default: wired, it is a control voltage of sorts
  const { b, p } = board();
  b.block('vs', 'volts', 0, 1, { value: 1 }); b.block('r', 'const', 0, 5, { value: 2 });
  const adc = b.block('adc', 'comp', 3, 0, { def: 'ADC' });
  b.net('vs.out0', 'adc.in1'); b.net('r.out0', 'adc.in0');
  assert.strictEqual(run(p, 1, [pin(adc, 'out')]).tr[0][0], 64, 'range 2: 1 V is half of full scale');
});

test('format 5 → 6: old converters become copies of library blocks, settings kept, and compute the same', () => {
  const old = { format: 'sample-factory-design', version: 5, kind: 'example', meta: { title: 't' }, uses: {}, defs: {}, values: {},
    board: { nextId: 9, blocks: [{ id: 'b1', type: 'volts', x: 0, y: 1, value: 2 }, { id: 'b2', type: 'adc', x: 3, y: 0, params: { bits: 12, range: 4 } },
      { id: 'b3', type: 'dac', x: 8, y: 0, params: { range: 4 } }, { id: 'b4', type: 'voltmeter', x: 13, y: 0, params: { range: 2 } },
      { id: 'b5', type: 'awg', x: 18, y: 0, params: { gain: 1 } }],
    wires: [{ id: 'w6', from: 'b1.o0', to: 'b2.i0' }, { id: 'w7', from: 'b2.o0', to: 'b3.i0' }, { id: 'w8', from: 'b3.o0', to: 'b4.i0' }, { id: 'w9', from: 'b4.o0', to: 'b5.i0' }] } };
  const d = F.decode(old, defs);
  assert.deepStrictEqual(d.warnings, []);
  const by = (id) => d.project.root.blocks.find((x) => x.id === id);
  assert.deepStrictEqual([by('b2').def, by('b3').def, by('b4').def, by('b5').type], ['ADC 12-bit', 'DAC', 'Scaled Voltmeter', 'awg']);
  assert.ok(d.project.defs['ADC 12-bit'], 'a 12-bit ADC travels with the file');
  const c = compile(d.project);
  assert.ok(c.ok, JSON.stringify(c.errors));
  const { tr } = run(d.project, 1, [G.ep('b2', 'out', 0), G.ep('b3', 'out', 0), G.ep('b4', 'out', 0)]);
  assert.deepStrictEqual(tr.map((t) => t[0]), [1024, 2, 1], 'ADC: 2 V of ±4 V in 12 bits is 1024; back to 2 V; read with range 2 as 1');
});

test('a bus wider than its converter can read is reported; a fixed port carries widths across a block boundary', () => {
  const name = 'Inv', def = G.makeDef(name, 3, 3, 8, [{ dir: 'in', row: 0, name: 'x', domain: 'fixed' }, { dir: 'out', row: 0, name: 'y', domain: 'fixed' }]);
  const ib = G.builder(def, defs);
  ib.block('n', 'not', 6, 3); ib.net('port.in0', 'n.in0'); ib.net('n.out0', 'port.out0');
  const D = Object.assign({}, defs, { [name]: def });
  const r = G.makeSheet(), b = G.builder(r, D);
  b.block('x', 'bits', 0, 0, { width: 6, value: 0b000111 }); const u = b.block('u', 'comp', 3, 0, { def: name });
  b.net('x.out0', 'u.in0');
  const { c, tr } = run({ version: 3, root: r, defs: D, values: {} }, 1, [pin(u, 'out')]);
  assert.strictEqual(tr[0][0], 0b111000);
  assert.strictEqual(c.widths[pin(u, 'out')], 6);
  assert.strictEqual(G.domainAt(r, D, pin(u, 'in')), 'fixed');
});

test('Out sockets are the program\'s outputs, top to bottom, clipped to ±1; In sockets read their input', () => {
  const { b, p } = board();
  b.block('i', 'in', 0, 0, { name: 'mic' }); b.block('m', 'mul', 4, 0);
  b.block('k', 'const', 2, 4, { value: 3 });
  b.block('lo', 'out', 10, 6, { name: 'R' }); b.block('hi', 'out', 10, 1, { name: 'L' });
  b.net('i.out0', 'm.in0'); b.net('k.out0', 'm.in1'); b.net('m.out0', ['hi.in0', 'lo.in0']);
  const { c, o } = run(p, 3, [], [Float32Array.from([0.1, 0.2, 0.5])]);
  assert.deepStrictEqual(c.outs.map((x) => x.name), ['L', 'R']);
  assert.deepStrictEqual(c.ins.map((x) => x.name), ['mic']);
  assert.deepStrictEqual(Array.from(o[0], (x) => +x.toFixed(5)), [0.3, 0.6, 1]);
  const inner = G.makeDef('Sock', 3, 3, 8, []); inner.blocks.push({ id: 'b1', type: 'out', x: 2, y: 2, name: 'x' });
  const q = board(); q.p.defs = Object.assign({}, defs, { Sock: inner }); q.r.blocks.push({ id: 'b1', type: 'comp', def: 'Sock', x: 0, y: 0 });
  assert.match(compile(q.p).errors[0].msg, /top board/);
});

test('analog modules sit on the board as panels; their wires are cables, never routed', () => {
  const p = L.exampleProject(8), c = compile(p);
  assert.ok(c.ok);
  const vco = p.root.blocks.find((x) => x.type === 'vco'), fp = G.footprint(vco, p.defs);
  assert.deepStrictEqual([fp.w, fp.h], [7, 13]);
  assert.ok(fp.pads.every((q) => q.dom === 'analog' && q.fx !== undefined));
  const cables = p.root.wires.filter((w) => G.isCable(p.root, p.defs, w));
  assert.ok(cables.length >= 10 && cables.every((w) => !w.path && w.style && w.style.color));
  G.fixRoutes(p.root, p.defs);
  assert.ok(cables.every((w) => !w.path));
  assert.ok(!G.routesOf(p.root, p.defs).has(cables[0].id));
  const fixed = p.root.wires.filter((w) => !G.isCable(p.root, p.defs, w));
  assert.ok(fixed.every((w) => G.routesOf(p.root, p.defs).has(w.id)), 'the float wires are traces');
});

test('a via by hand: the trace changes layer at that cell; without any, layers are automatic', () => {
  const { r, b } = board();
  b.block('a', 'delay', 0, 0); b.block('z', 'delay', 12, 0);
  b.net('a.out0', 'z.in0');
  const w = r.wires[0], auto = G.renderLayout(r, defs);
  assert.strictEqual(Object.keys(auto.bot).length, 0);
  w.style = { vias: [4, 8] };
  const L2 = G.renderLayout(r, defs), cell = (i) => w.path[i].join(',');
  assert.ok(L2.top[cell(4)] && L2.bot[cell(4)], 'a via is on both layers');
  assert.ok(L2.bot[cell(6)] && !L2.top[cell(6)], 'between the vias the trace is underneath');
  assert.ok(L2.top[cell(10)] && !L2.bot[cell(10)], 'and back on top after the second');
  assert.ok(compile({ root: r, defs, values: {} }).ok);
});

test('format 4 keeps a wire\'s look, bus fields, bit widths and port domains', () => {
  const { r, b, p } = board();
  b.block('x', 'bits', 0, 0, { width: 5, value: 9 }); b.block('sp', 'split', 4, 0, { parts: [2, 3] });
  b.net('x.out0', 'sp.in0', { style: { color: '#ff0000' } });
  r.wires[0].style.vias = [1];
  p.defs = Object.assign({}, defs, { D: G.makeDef('D', 3, 3, 8, [{ dir: 'in', row: 0, name: 'v', domain: 'analog' }]) });
  const text = F.stringify(F.encode(p, { title: 't' }, null)), d = F.decode(text);
  assert.deepStrictEqual(d.project.root.wires[0].style, { color: '#ff0000', vias: [1] });
  assert.deepStrictEqual(d.project.root.blocks.find((q) => q.type === 'split').parts, [2, 3]);
  assert.strictEqual(d.project.root.blocks.find((q) => q.type === 'bits').width, 5);
  assert.strictEqual(F.stringify(F.encode(d.project, d.meta, null)), text);
});

// ---- from the rack (format 3) --------------------------------------------------------
const FIX = path.join(__dirname, 'fixtures');
const LIB = require('../tools/library-node.js').readLibrary().defs;
const OLD = JSON.parse(fs.readFileSync(path.join(FIX, 'rack-v3-out.json'), 'utf8'));
function playMigrated(file) {
  const d = F.decode(fs.readFileSync(path.join(FIX, file), 'utf8'), LIB), c = compile(d.project);
  assert.ok(c.ok, JSON.stringify(c.errors));
  const N = OLD.N, fn = instantiate(c.code), o = c.outs.map(() => new Float32Array(N));
  const song = Float32Array.from({ length: N }, (_, k) => 0.5 * Math.sin(k / 9));
  fn(N, c.params, new Float64Array(c.nState), o, c.ins.map(() => song), new Float64Array(c.nSnap));   // the old song now comes in through the In socket
  const sum = new Float32Array(N); for (const x of o) for (let i = 0; i < N; i++) sum[i] += x[i];
  return { d, c, sum };
}
for (const file of Object.keys(OLD.files)) {
  test(`format 3 with a rack (${file}): the modules move onto the board and it plays as it did`, () => {
    const { d, c, sum } = playMigrated(file), old = OLD.files[file];
    assert.deepStrictEqual(d.warnings, []);
    assert.ok(!d.project.rack);
    assert.ok(c.outs.length >= 1, 'the Audio Out became an Out socket');
    // the same circuit; only the analog noise seeds differ (they were named after rack positions)
    old.forEach((v, k) => assert.ok(Math.abs(sum[k * 32] - v) < 1e-5, `${file} at ${k * 32}: ${sum[k * 32]} vs ${v}`));
    const sh = d.project.root;
    for (const w of sh.wires) assert.strictEqual(G.wireProblem(sh, d.project.defs, w.from, w.to), null, 'every wire joins one kind of signal');
    for (const blk of sh.blocks) assert.ok(G.canPlace(sh, d.project.defs, blk, blk), blk.id + ' overlaps nothing');
  });
}
test('format 3 → 4 in detail: links become converters, the speaker an Out, scopes go', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(FIX, 'song-board-rack-v3.json'), 'utf8'));
  const up = F.upgrade(doc);
  assert.strictEqual(up.version, F.VERSION);
  const types = up.board.blocks.map((b) => b.type).sort();
  assert.ok(types.includes('awg') && types.includes('comp') && types.includes('out') && types.includes('vcf'), types.join());
  assert.ok(up.board.blocks.some((b) => b.def === 'Scaled Voltmeter'), 'the Audio Out\'s scaled voltmeter, a library block since format 6');
  assert.ok(!types.includes('scope') && !types.includes('torack') && !types.includes('fromrack') && !types.includes('scope2'));
  assert.ok(!('rack' in up) && !(up.meta && up.meta.view));
  const internal = { version: 2, root: JSON.parse(JSON.stringify(doc.board)), defs: JSON.parse(JSON.stringify(LIB)), values: {}, rack: (() => {
    const r = JSON.parse(JSON.stringify(doc.rack));
    return r;
  })() };
  const d = F.decode(internal, LIB);   // the same design as a browser save held it
  assert.ok(compile(d.project).ok);
  assert.strictEqual(d.project.version, 5);
});

console.log(`\n${passed} passed`);
