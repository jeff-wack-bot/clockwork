#!/usr/bin/env node
// Behaviour fingerprints: what every curated example and every library block
// computes, so a change to the engine can be checked against the one before it.
//   node tools/behaviour.js > tests/fixtures/behaviour.json   (record)
// tests/format.test.js compares the current engine with the recording.
'use strict';
const fs = require('fs'), path = require('path');
const G = require('../js/grid/model.js');
const F = require('../js/grid/format.js');
const { compile, instantiate } = require('../js/grid/compiler.js');
const { ROOT, readLibrary } = require('./library-node.js');

const N = 4800, EVERY = 16;
// Every EVERY-th value, and sums over every value (so single-tick pulses count too),
// of the Out sockets (summed) and of any pins being watched.
function run(project, n) {
  n = n || N;
  const every = EVERY * n / N, watch = project.watch || [];
  const c = compile(project);
  if (!c.ok) return { errors: c.errors.map((e) => e.msg) };
  const fn = instantiate(c.code), d = new Float64Array(n), tr = watch.map(() => new Float64Array(n));
  // what used to be a song in a Sample block now comes in through the In sockets
  const song = Float32Array.from({ length: n }, (_, k) => 0.5 * Math.sin(k / 9)), I = c.ins.map(() => song);
  const s = new Float64Array(c.nState), v = new Float64Array(c.nSnap);
  if (!watch.length) {
    const o = c.outs.map(() => new Float32Array(n));
    fn(n, c.params, s, o, I, v);
    for (const x of o) for (let i = 0; i < n; i++) d[i] += x[i];
  } else {
    const o1 = c.outs.map(() => new Float32Array(1));
    for (let i = 0; i < n; i++) {
      fn(1, c.params, s, o1, I.map((a) => a.subarray(i, i + 1)), v);
      for (const x of o1) d[i] += x[0];
      watch.forEach((k, j) => { const r = c.netOf[k]; tr[j][i] = r.k === 'p' ? c.params[r.i] : v[r.v]; });
    }
  }
  const pick = (a) => ({ at: Array.from({ length: N / EVERY }, (_, i) => +a[i * every].toPrecision(10)),
    sum: +a.reduce((x, y) => x + y, 0).toPrecision(10), sum2: +a.reduce((x, y) => x + y * y, 0).toPrecision(10) });
  return { out: pick(d), probes: tr.map(pick) };
}
// A block on its own: a constant on every input; every output watched.
function harness(lib, name) {
  const def = lib[name], root = G.makeSheet(), b = G.builder(root, lib);
  const ins = G.portsOf(def, 'in'), outs = G.portsOf(def, 'out');
  const dut = b.block('dut', 'comp', 8, 2, { def: name });
  const val = (n) => (/hz/i.test(n) ? 440 : /f0/.test(n) ? 5.45 : /phase/.test(n) ? 0.6 : /^N/.test(n) ? 200 : /trig/.test(n) ? 1 : 7);
  ins.forEach((p, i) => b.konst(`dut.in${i}`, 'left', 3, val(p.name)));
  return { version: 3, root, defs: lib, values: {}, watch: outs.map((p, i) => G.ep(dut.id, 'out', i)) };
}
module.exports = { run, harness, N };
if (require.main !== module) return;
const L = readLibrary(), out = { note: 'Recorded by tools/behaviour.js; see tests/format.test.js.', N, every: EVERY, examples: {}, blocks: {} };
const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'index.json'), 'utf8'));
for (const e of man.examples) out.examples[e.file] = run(F.decode(fs.readFileSync(path.join(ROOT, 'examples', e.file), 'utf8'), L.defs).project, 10 * N);
for (const name of Object.keys(L.defs).sort()) out.blocks[name] = run(harness(JSON.parse(JSON.stringify(L.defs)), name));
process.stdout.write(JSON.stringify(out) + '\n');
