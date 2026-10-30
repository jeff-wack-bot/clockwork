// Run with: node tests/analog.test.js — the analog modules: what their circuits do,
// the clock-boundary semantics, and their panels on the board.
'use strict';
const assert = require('assert');
const G = require('../js/grid/model.js');
const A = require('../js/grid/analog.js');
const { compile, instantiate } = require('../js/grid/compiler.js');
const L = require('../js/grid/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 3).join('\n     ')); process.exitCode = 1; }
}
const defs = L.starterDefs();
const FS = G.FS;
// A board to patch modules on: each new module goes to the right of the last.
function blank() {
  const p = { version: 3, root: G.makeSheet(), defs, values: {} };
  p.x = 0;
  return p;
}
function mod(p, type, params) {
  const b = G.addBlock(p.root, defs, { type, x: p.x, y: 0, params: Object.assign(A.MODULES[type].defaults(), params || {}) });
  assert.ok(b, 'placed ' + type);
  p.x += G.footprint(b, defs).w + 1;
  return b;
}
const patch = (p, a, ai, b, bi) => assert.ok(G.addWire(p.root, G.ep(a.id, 'out', ai), G.ep(b.id, 'in', bi)), 'patched');
const jack = (b, i) => G.ep(b.id, 'out', i);
// A runnable program with persistent state, so a test can run, change knobs, and run on.
// run(N, watch): the Out sockets summed (d) and, per watched pin, its value every tick (tr).
function machine(p) {
  const c = compile(p);
  assert.ok(c.ok, JSON.stringify(c.errors));
  const fn = instantiate(c.code), s = new Float64Array(c.nState), v = new Float64Array(c.nSnap);
  return {
    c, s, v,
    run(N, watch, ins) {
      const d = new Float64Array(N), tr = (watch || []).map(() => new Float64Array(N));
      if (!tr.length) {
        const o = c.outs.map(() => new Float32Array(N));
        fn(N, c.params, s, o, ins || [], v);
        for (const x of o) for (let i = 0; i < N; i++) d[i] += x[i];
        return { d, tr };
      }
      const o1 = c.outs.map(() => new Float32Array(1));
      for (let i = 0; i < N; i++) {
        fn(1, c.params, s, o1, (ins || []).map((a) => a.subarray(i, i + 1)), v);
        for (const x of o1) d[i] += x[0];
        watch.forEach((k, j) => { const r = c.netOf[k]; tr[j][i] = r.k === 'p' ? c.params[r.i] : v[r.v]; });
      }
      return { d, tr };
    },
    state: (name) => s[c.regNames.indexOf(name)],
    set(path, id, value) { c.params[c.paramIndex[path + '#' + id]] = value; },
  };
}
const frac = (x) => x - Math.floor(x);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

// ---- oscillators ----------------------------------------------------------------------
test('VCO: 0 V is C4 and each volt doubles the frequency, exactly', () => {
  for (const volts of [0, 1, -2.5]) {
    const p = blank(), src = mod(p, 'atten', { a1: 0, o1: volts }), vco = mod(p, 'vco');
    patch(p, src, 0, vco, 0);
    const m = machine(p);
    m.run(10);
    const p1 = m.state(vco.id + '#ph');
    m.run(48000);
    const f = A.C4 * Math.pow(2, volts);
    assert.ok(Math.abs(m.state(vco.id + '#ph') - frac(p1 + 48000 * f / FS)) < 1e-6, `${volts} V`);
  }
});

test('VCO: TRACK scales the 1 V/oct input; DRIFT wanders but Reset replays it exactly', () => {
  const p = blank(), src = mod(p, 'atten', { a1: 0, o1: 1 }), vco = mod(p, 'vco', { track: 1 });
  patch(p, src, 0, vco, 0);
  let m = machine(p);
  m.run(10);
  const p1 = m.state(vco.id + '#ph');
  m.run(4800);
  assert.ok(Math.abs(m.state(vco.id + '#ph') - frac(p1 + 4800 * A.C4 * Math.pow(2, 1.01) / FS)) < 1e-6);
  vco.params.track = 0; vco.params.drift = 20;
  const a = machine(p).run(4800, [jack(vco, 2)]).tr[0], b = machine(p).run(4800, [jack(vco, 2)]).tr[0];
  assert.deepStrictEqual(a, b);                                         // pseudo-random, seeded: repeatable
  m = machine(p); m.run(48000 * 3);
  const dr = m.state(vco.id + '#dr');
  assert.ok(dr !== 0 && Math.abs(dr * 20) < 120, 'drift stays within a few semitones: ' + dr * 20 + ' cents');
});

test('VCO outputs are tick averages: far less aliasing than a naive sawtooth', () => {
  const f = 7040, p = blank(), src = mod(p, 'atten', { a1: 0, o1: Math.log2(f / A.C4) }), vco = mod(p, 'vco');
  patch(p, src, 0, vco, 0);
  const m = machine(p); m.run(100);
  const N = 4800, avg = m.run(N, [jack(vco, 2)]).tr[0];
  const ph0 = frac(m.state(vco.id + '#ph') - N * f / FS);
  const naive = Float64Array.from({ length: N }, (_, n) => 5 * (2 * frac(ph0 + n * f / FS) - 1));
  // energy below the fundamental can only be aliasing
  const alias = (x) => { let e = 0; for (let k = 1; k < f / 10 - 20; k++) { let re = 0, im = 0; for (let n = 0; n < N; n++) { const a = 2 * Math.PI * k * n / N; re += x[n] * Math.cos(a); im -= x[n] * Math.sin(a); } e += re * re + im * im; } return e; };
  const ea = alias(avg), en = alias(naive);
  assert.ok(ea < en / 4, `averaged ${ea.toExponential(2)} vs naive ${en.toExponential(2)}`);
});

// ---- filter, envelope, VCA ---------------------------------------------------------------
test('ladder filter: removes highs at low cutoff, and whistles at its cutoff with high resonance', () => {
  let p = blank();
  const src = mod(p, 'atten', { a1: 0, o1: Math.log2(5000 / A.C4) }), vco = mod(p, 'vco'), vcf = mod(p, 'vcf', { freq: 300, res: 0 });
  patch(p, src, 0, vco, 0); patch(p, vco, 2, vcf, 0);
  let m = machine(p); m.run(4800);
  const out = m.run(4800, [jack(vco, 2), jack(vcf, 0)]).tr;
  assert.ok(rms(out[1]) < 0.05 * rms(out[0]), `in ${rms(out[0]).toFixed(2)} V, out ${rms(out[1]).toFixed(3)} V`);
  p = blank();
  const f2 = mod(p, 'vcf', { freq: 1000, res: 1.1 });
  m = machine(p); m.run(48000);                     // nothing at the input: thermal noise starts it
  const y = m.run(48000, [jack(f2, 0)]).tr[0];
  let up = 0; for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) up++;
  assert.ok(up > 850 && up < 1150, 'self-oscillation at ' + up + ' Hz');
  const peak = Math.max(...y.map(Math.abs));
  assert.ok(peak > 0.3 && peak < 6, 'amplitude ' + peak.toFixed(2) + ' V');
});

test('ADSR: attack reaches 10 V in A seconds, settles at S, releases when the gate drops', () => {
  const p = blank(), gate = mod(p, 'atten', { a1: 0, o1: 10 }), env = mod(p, 'adsr', { a: 0.01, d: 0.05, s: 0.5, r: 0.05 });
  patch(p, gate, 0, env, 0);
  const m = machine(p);
  const y = m.run(4800, [jack(env, 0)]).tr[0];
  const top = y.findIndex((v) => v >= 10);
  assert.ok(top >= 470 && top <= 500, 'peak at tick ' + top);          // 0.01 s = 480 ticks (+ latency)
  assert.ok(Math.abs(y[4799] - 5) < 0.1, 'decay towards S·10 V: ' + y[4799]);
  m.set(gate.id, 'o1', 0);                                               // knob turned: the gate drops, no recompile
  const z = m.run(2404, [jack(env, 0)]).tr[0];
  assert.ok(Math.abs(z[2403] - 5 * 0.1) < 0.05, 'release covers 90% in R: ' + z[2403]);
});

test('VCA: an open CV input means fully open; a patched one scales; the rails saturate', () => {
  const p = blank(), src = mod(p, 'atten', { a1: 0, o1: 3, a2: 0, o2: 5 }), vca = mod(p, 'vca');
  patch(p, src, 0, vca, 0);
  let y = machine(p).run(4, [jack(vca, 0)]).tr[0];
  assert.strictEqual(y[3], 3, 'open');
  patch(p, src, 1, vca, 1);
  y = machine(p).run(4, [jack(vca, 0)]).tr[0];
  assert.strictEqual(y[3], 1.5, 'half open');
  src.params.o1 = 30; src.params.o2 = 10;                               // far past the rails, fully open
  y = machine(p).run(4, [jack(vca, 0)]).tr[0];
  assert.ok(y[3] > 10 && y[3] < 12, 'rails: ' + y[3]);
});

// ---- semantics ------------------------------------------------------------------------------
test('every analog module is a clock boundary: feedback through it is legal, through logic it is not', () => {
  const p = blank(), a = mod(p, 'vco', { fm: 0.5 }), b = mod(p, 'vco', { fm: 0.5 });
  patch(p, a, 0, b, 1); patch(p, b, 0, a, 1);
  assert.ok(compile(p).ok);
  const y = machine(p).run(48000, [jack(a, 0)]).tr[0];
  assert.ok(y.every(Number.isFinite) && rms(y) > 1);
  const q = blank(), g1 = mod(q, 'gain'), g2 = mod(q, 'gain');
  patch(q, g1, 0, g2, 0); patch(q, g2, 0, g1, 0);
  const c = compile(q);
  assert.ok(!c.ok && /Feedback loop/.test(c.errors[0].msg));
  // one tick of latency per analog module, none per utility
  const r = blank(), src = mod(r, 'atten', { a1: 0, o1: 2 }), gain = mod(r, 'gain', { k: 1 }), att = mod(r, 'atten');
  patch(r, src, 0, gain, 0); patch(r, gain, 0, att, 0);
  const out = machine(r).run(3, [jack(att, 0), jack(gain, 0)]).tr;
  assert.deepStrictEqual([...out[1]], [0, 2, 2]);                       // after the first analog module
  assert.deepStrictEqual([...out[0]], [0, 0, 2]);                       // after the second
});

test('the clock rate is irrelevant to the result: one tick at a time equals a block of ticks', () => {
  for (const i of [8, 9, 11, 12]) {
    const p = L.exampleProject(i);
    const a = machine(p), b = machine(p);
    const da = a.run(3000).d;
    const db = new Float64Array(3000);
    for (let n = 0; n < 3000; n++) db[n] = b.run(1).d[0];
    assert.deepStrictEqual(da, db, L.EXAMPLES[i].title);
  }
});

test('turning a module knob changes a parameter, not the program', () => {
  const p = L.exampleProject(8), c1 = compile(p);
  const vcf = p.root.blocks.find((m) => m.type === 'vcf');
  vcf.params.freq = 2000;
  const c2 = compile(p);
  assert.strictEqual(c1.code, c2.code);
  assert.strictEqual(c2.params[c2.paramIndex[vcf.id + '#freq']], 2000);
});

test('inside a composite block, a module\'s knobs are set per instance', () => {
  const inner = G.makeDef('Osc', 8, 13, 8, [{ dir: 'out', row: 6, name: 'saw', domain: 'analog' }]);
  inner.blocks.push({ id: 'b1', type: 'vco', x: 1, y: 1, params: A.MODULES.vco.defaults() });
  inner.wires.push({ id: 'w2', from: 'b1.o2', to: 'port.o0' });
  const D = Object.assign({}, defs, { Osc: inner });
  const p = { version: 3, root: G.makeSheet(), defs: D, values: { 'b1/b1#freq': 1 } };
  p.root.blocks.push({ id: 'b1', type: 'comp', def: 'Osc', x: 0, y: 0 }, { id: 'b2', type: 'comp', def: 'Osc', x: 10, y: 0 });
  const c = compile(p);
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.strictEqual(c.params[c.paramIndex['b1/b1#freq']], 1);
  assert.strictEqual(c.params[c.paramIndex['b2/b1#freq']], 0);
});

test('the analog examples compile cleanly and are audible', () => {
  for (let i = 8; i < L.EXAMPLES.length; i++) {
    const p = L.exampleProject(i), c = compile(p);
    assert.ok(c.ok, L.EXAMPLES[i].title + ': ' + JSON.stringify(c.errors));
    assert.deepStrictEqual(c.warnings, [], L.EXAMPLES[i].title);
    const song = Float32Array.from({ length: 48000 }, (_, k) => 0.5 * Math.sin(k / 20));
    const d = machine(p).run(48000, null, c.ins.map(() => song)).d;
    assert.ok(d.every(Number.isFinite), L.EXAMPLES[i].title);
    assert.ok(rms(d) > 0.01 && Math.max(...d.map(Math.abs)) < 1, `${L.EXAMPLES[i].title}: rms ${rms(d)}`);
  }
});

// ---- panels ---------------------------------------------------------------------------------
test('every panel fits in 3U, no two controls overlap, and every jack has a cell of its own', () => {
  for (const s of Object.values(A.MODULES).filter((m) => m.panel)) {
    const l = A.panelLayout(s, s.hp);
    assert.ok(l.h <= A.PANEL_H - 0.5, `${s.title} is ${l.h} HP tall`);
    const all = l.knobs.concat(l.ins, l.outs);
    for (const c of all) assert.ok(c.x - c.r >= 0 && c.x + c.r <= s.hp, `${s.title}: control outside the panel`);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      assert.ok(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) > all[i].r + all[j].r, `${s.title}: controls ${i} and ${j} overlap`);
    }
    const fp = G.footprint({ type: s.type, x: 0, y: 0 }, defs), cells = fp.pads.map((q) => q.x + ',' + q.y);
    assert.strictEqual(new Set(cells).size, cells.length, `${s.title}: two jacks in one cell`);
    assert.ok(fp.pads.every((q) => q.x >= 0 && q.y >= 0 && q.x < fp.w && q.y < fp.h), `${s.title}: a jack outside the footprint`);
  }
});

test('unknown block types are reported', () => {
  const p = blank();
  p.root.blocks.push({ id: 'b90', type: 'theremin', x: 0, y: 0 });
  const c = compile(p);
  assert.ok(!c.ok && /theremin/.test(c.errors[0].msg));
});

console.log(`\n${passed} passed`);
