// Starter library for the grid prototype. Chips are placed by hand; the wiring
// is laid out by the maze router so the layouts stay valid.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;
  const FS = G.FS;
  const knob = (label, min, max, scale) => ({ label, min, max, scale: scale || 'lin' });

  // Put a knob on the region cell nearest to (x, y) that is not a pad.
  function knobNear(sheet, defs, rid, x, y, k) {
    const occ = G.occupancy(sheet, defs);
    const cells = G.cellsOf(sheet, rid).filter(([l, cx, cy]) => l === G.TOP && !occ.has(G.key(cx, cy)));
    cells.sort((a, b) => (Math.abs(a[1] - x) + Math.abs(a[2] - y)) - (Math.abs(b[1] - x) + Math.abs(b[2] - y)));
    sheet.regions[rid].knob = Object.assign({ x: cells[0][1], y: cells[0][2] }, k);
  }

  function phasor(defs) {
    const d = G.makeDef('Phasor', 5, 3, 8, [
      { dir: 'in', row: 0, name: 'Hz' }, { dir: 'out', row: 0, name: 'phase' }, { dir: 'out', row: 2, name: 'wrap' },
    ], 'Ramp 0→1 at the given frequency. phase + Hz/fs, minus 1 when it passes 1, into a flip-flop that holds the phase until the next tick. "wrap" is 1 on the tick the ramp wraps.');
    const b = G.builder(d, defs);
    b.block('mul', 'mul', 5, 3); b.block('add', 'add', 12, 3);
    b.block('gt', 'gt', 20, 0); b.block('sub', 'add', 20, 6);
    b.block('sw', 'switch', 27, 5); b.block('ff', 'delay', 27, 13);
    b.konst('mul.in1', 'down', 2, 1 / FS);
    b.konst('gt.in1', 'left', 2, 1);
    b.konst('sub.in1', 'left', 2, -1);
    const hz = b.net('port.in0', 'mul.in0', { value: 220 });
    knobNear(d, defs, hz, 1, 4, knob('Hz', 20, 2000, 'log'));
    b.net('mul.out0', 'add.in0');
    b.net('add.out0', ['gt.in0', 'sub.in0', 'sw.in2']);
    b.net('gt.out0', ['sw.in0', 'port.out1']);
    b.net('sub.out0', 'sw.in1');
    b.net('sw.out0', 'ff.in0');
    b.net('ff.out0', ['add.in1', 'port.out0']);
    return d;
  }

  function vco(defs) {
    const d = G.makeDef('VCO', 4, 3, 8, [{ dir: 'in', row: 1, name: 'Hz' }, { dir: 'out', row: 1, name: 'saw' }],
      'Sawtooth oscillator: a Phasor, then 2·phase − 1. Zoom in further to see the Phasor inside.');
    const b = G.builder(d, defs);
    b.block('ph', 'comp', 4, 9, { def: 'Phasor' });
    b.block('m2', 'mul', 13, 8); b.block('a1', 'add', 19, 8);
    b.konst('m2.in1', 'down', 2, 2);
    b.konst('a1.in1', 'down', 2, -1);
    const hz = b.net('port.in0', 'ph.in0', { value: 110 });
    knobNear(d, defs, hz, 1, 12, knob('Hz', 20, 2000, 'log'));
    b.net('ph.out0', 'm2.in0');
    b.net('m2.out0', 'a1.in0');
    b.net('a1.out0', 'port.out0');
    return d;
  }

  function decay(defs) {
    const d = G.makeDef('Decay', 4, 3, 8, [{ dir: 'in', row: 0, name: 'trig' }, { dir: 'out', row: 1, name: 'env' }],
      'Percussive envelope: on a trigger the flip-flop is loaded with 1, otherwise with env·decay.');
    const b = G.builder(d, defs);
    b.block('sw', 'switch', 10, 3); b.block('ff', 'delay', 17, 4); b.block('m', 'mul', 10, 12);
    b.konst('sw.in1', 'up', 2, 1);
    b.konst('m.in1', 'down', 3, 0.9998, knob('decay', 0.999, 0.99999));
    b.net('port.in0', 'sw.in0');
    b.net('sw.out0', 'ff.in0');
    b.net('ff.out0', ['m.in0', 'port.out0']);
    b.net('m.out0', 'sw.in2');
    return d;
  }

  function seq4(defs) {
    const d = G.makeDef('Seq4', 5, 4, 8, [{ dir: 'in', row: 0, name: 'phase' }, { dir: 'out', row: 1, name: 'Hz' }],
      'Four-step sequencer driven by a slow phase (0→1 per bar). Comparators pick the quarter; a tree of switches picks that step\'s knob. Zoom in to turn the knobs.');
    const b = G.builder(d, defs);
    b.block('g1', 'gt', 8, 2); b.block('g2', 'gt', 8, 10); b.block('g3', 'gt', 8, 18);
    b.block('w1', 'switch', 18, 2); b.block('w2', 'switch', 26, 10); b.block('w3', 'switch', 32, 18);
    b.konst('g1.in1', 'down', 2, 0.25);
    b.konst('g2.in1', 'down', 2, 0.5);
    b.konst('g3.in1', 'down', 2, 0.75);
    b.konst('w1.in2', 'down', 3, 110, knob('step 1', 30, 1000, 'log'));
    b.konst('w1.in1', 'up', 2, 220, knob('step 2', 30, 1000, 'log'));
    b.konst('w2.in1', 'up', 3, 164.8, knob('step 3', 30, 1000, 'log'));
    b.konst('w3.in1', 'up', 3, 130.8, knob('step 4', 30, 1000, 'log'));
    b.net('port.in0', ['g1.in0', 'g2.in0', 'g3.in0']);
    b.net('g1.out0', 'w1.in0');
    b.net('g2.out0', 'w2.in0');
    b.net('g3.out0', 'w3.in0');
    b.net('w1.out0', 'w2.in2');
    b.net('w2.out0', 'w3.in2');
    b.net('w3.out0', 'port.out0');
    return d;
  }

  function onePole(defs) {
    const d = G.makeDef('OnePole', 4, 3, 8, [{ dir: 'in', row: 1, name: 'x' }, { dir: 'out', row: 1, name: 'y' }],
      'Low-pass filter y[n] = (1−k)·y[n−1] + k·x[n]. The flip-flop holds y between ticks.');
    const b = G.builder(d, defs);
    b.block('mb', 'mul', 5, 11); b.block('ma', 'mul', 14, 3); b.block('ad', 'add', 20, 10); b.block('ff', 'delay', 25, 11);
    b.block('kn', 'mul', 5, 17); b.block('k1', 'add', 10, 17);
    b.konst('kn.in1', 'down', 2, -1);
    b.konst('k1.in1', 'down', 2, 1);
    const k = b.net('mb.in1', 'kn.in0', { value: 0.08 });
    knobNear(d, defs, k, 2, 15, knob('k', 0.001, 1, 'log'));
    b.net('port.in0', 'mb.in0');
    b.net('kn.out0', 'k1.in0');
    b.net('k1.out0', 'ma.in1');
    b.net('mb.out0', 'ad.in1');
    b.net('ma.out0', 'ad.in0');
    b.net('ad.out0', 'ff.in0');
    b.net('ff.out0', ['ma.in0', 'port.out0']);
    return d;
  }

  function starterDefs() {
    const defs = {};
    for (const make of [phasor, vco, decay, seq4, onePole]) { const d = make(defs); defs[d.name] = d; }
    return defs;
  }

  // ---- examples --------------------------------------------------------------
  function exCounter(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('add', 'add', 4, 2); b.block('ff', 'delay', 10, 3);
    b.block('d1', 'delay', 12, 9); b.block('d2', 'delay', 18, 9);
    b.block('scope', 'scope', 16, 0, { window: 16 });
    b.konst('add.in0', 'left', 2, 1, knob('step', 0, 4));
    b.net('add.out0', 'ff.in0');
    b.net('ff.out0', ['add.in1', 'd1.in0', 'scope.in0']);
    b.net('d1.out0', 'd2.in0');
    b.konst('d2.out0', 'right', 3, 0);
    return r;
  }
  function exTone(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('vco', 'comp', 4, 2, { def: 'VCO' });
    b.block('vol', 'mul', 11, 2);
    b.block('dac', 'dac', 17, 0); b.block('scope', 'scope', 17, 4);
    b.konst('vco.in0', 'left', 3, 220, knob('Hz', 30, 2000, 'log'));
    b.konst('vol.in1', 'down', 2, 0.2, knob('volume', 0, 0.5));
    b.net('vco.out0', 'vol.in0');
    b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }
  function exSynth(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('sp', 'comp', 6, 2, { def: 'Phasor' });
    b.block('mq', 'mul', 6, 8);
    b.block('bp', 'comp', 12, 8, { def: 'Phasor' });
    b.block('sq', 'comp', 20, 8, { def: 'Seq4' });
    b.block('vco', 'comp', 28, 8, { def: 'VCO' });
    b.block('lp', 'comp', 35, 8, { def: 'OnePole' });
    b.block('env', 'comp', 35, 1, { def: 'Decay' });
    b.block('vca', 'mul', 42, 8); b.block('vol', 'mul', 47, 8);
    b.block('dac', 'dac', 53, 5); b.block('scope', 'scope', 53, 10);
    b.konst('mq.in1', 'down', 2, 0.25);
    b.konst('vol.in1', 'down', 3, 0.3, knob('volume', 0, 1));
    const tempo = b.net('sp.in0', 'mq.in0', { value: 4 });
    knobNear(r, defs, tempo, 3, 5, knob('steps/s', 0.5, 16, 'log'));
    b.net('mq.out0', 'bp.in0');
    b.net('bp.out0', 'sq.in0');
    b.net('sq.out0', 'vco.in0');
    b.net('vco.out0', 'lp.in0');
    b.net('sp.out1', 'env.in0');
    b.net('lp.out0', 'vca.in0');
    b.net('env.out0', 'vca.in1');
    b.net('vca.out0', 'vol.in0');
    b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }

  const EXAMPLES = [
    { title: '1 · Counter and pipeline', rate: 4, make: exCounter,
      note: 'Add and flip-flop make a counter: the Add settles to count + step within the tick, and the flip-flop stores it at the clock edge. Each extra flip-flop holds the count one tick longer. Drag the "step" knob.' },
    { title: '2 · A tone (zoom into the VCO)', rate: FS, make: exTone,
      note: 'Zoom into the VCO with the mouse wheel to find its Phasor, and into that to see the registers that make the ramp.' },
    { title: '3 · Sequenced synth', rate: FS, make: exSynth,
      note: 'No panels: to change the melody, zoom into Seq4 and turn its knobs. Slide the clock down to hear (and see) it slow to a crawl.' },
  ];

  function exampleProject(i, existingDefs) {
    const defs = Object.assign(starterDefs(), existingDefs || {});
    return { version: 2, root: EXAMPLES[i].make(defs), defs, values: {} };
  }

  const api = { starterDefs, EXAMPLES, exampleProject };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
