// Starter library for the grid prototype. Chips are placed by hand; the wiring
// is laid out by the maze router so the layouts stay valid.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;
  const TU = (typeof module === 'object' && module.exports) ? require('./tunings.js') : root.GW.Tunings;
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

  // ---- tuning library (Benson, chapter 5) --------------------------------------
  // In a digital oscillator frequency is linear in the phase increment, so an
  // interval is a multiplication and a tuning is a table of ratios. The blocks
  // below take that literally: tuning ROMs, harmonic-number scores, a register
  // that multiplies its way through a progression, and integer-period dividers.

  // A copy of a laid-out definition with different constants: same footprint and
  // wiring, so one chip can be swapped for another on the board.
  function variant(def, name, description, consts) {
    const d = JSON.parse(JSON.stringify(def));
    d.name = name; d.description = description;
    for (const [rid, value, label] of consts) {
      d.regions[rid].value = value;
      if (label !== undefined && d.regions[rid].knob) d.regions[rid].knob.label = label;
    }
    return d;
  }

  function mux4(defs) {
    const d = G.makeDef('Mux4', 4, 5, 8, [{ dir: 'in', row: 0, name: 'phase' }, { dir: 'in', row: 1, name: 's1' }, { dir: 'in', row: 2, name: 's2' },
      { dir: 'in', row: 3, name: 's3' }, { dir: 'in', row: 4, name: 's4' }, { dir: 'out', row: 2, name: 'out' }],
    'Four-way selector addressed by a phase 0→1: s1 for the first quarter, s2 for the second, and so on. Three comparators and a chain of three switches.');
    const b = G.builder(d, defs);
    b.block('g1', 'gt', 6, 1); b.block('g2', 'gt', 12, 1); b.block('g3', 'gt', 18, 1);
    b.block('w1', 'switch', 8, 14); b.block('w2', 'switch', 16, 20); b.block('w3', 'switch', 24, 26);
    b.konst('g1.in1', 'down', 2, 0.25); b.konst('g2.in1', 'down', 2, 0.5); b.konst('g3.in1', 'down', 2, 0.75);
    b.net('g1.out0', 'w1.in0'); b.net('g2.out0', 'w2.in0'); b.net('g3.out0', 'w3.in0');
    b.net('port.in0', ['g1.in0', 'g2.in0', 'g3.in0']);
    b.net('port.in1', 'w1.in2'); b.net('port.in2', 'w1.in1'); b.net('port.in3', 'w2.in1'); b.net('port.in4', 'w3.in1');
    b.net('w1.out0', 'w2.in2'); b.net('w2.out0', 'w3.in2'); b.net('w3.out0', 'port.out0');
    return d;
  }

  // A score: n lanes of four steps, each step a constant with a knob, outputs on
  // alternate rows. With `times`, every lane is multiplied by an extra input.
  function score(defs, name, values, labels, k, description, times) {
    const n = values.length, fh = Math.max(3, 2 * n - 1);
    const ports = [{ dir: 'in', row: 0, name: 'phase' }, ...values.map((_, i) => ({ dir: 'out', row: 2 * i, name: labels[i] }))];
    if (times) ports.push({ dir: 'in', row: fh - 1, name: times });
    const d = G.makeDef(name, times ? 5 : 4, fh, 8, ports, description);
    const b = G.builder(d, defs);
    for (let i = 0; i < n; i++) b.block('m' + i, 'comp', 18, 2 + 16 * i, { def: 'Mux4' });
    if (times) for (let i = 0; i < n; i++) b.block('x' + i, 'mul', 28, 3 + 16 * i);
    for (let i = 0; i < n; i++) for (let s = 0; s < 4; s++) b.konst(`m${i}.in${s + 1}`, 'left', s % 2 ? 3 : 5, values[i][s], knob(`${labels[i]}·${s + 1}`, k[0], k[1], k[2]));
    b.net('port.in0', values.map((_, i) => `m${i}.in0`));
    if (times) {
      for (let i = n - 1; i >= 0; i--) { b.net(`m${i}.out0`, `x${i}.in0`); b.net(`x${i}.out0`, `port.out${i}`); }
      b.net('port.in1', values.map((_, i) => `x${i}.in1`).reverse());
    } else for (let i = 0; i < n; i++) b.net(`m${i}.out0`, `port.out${i}`);
    return d;
  }

  // Four VCOs mixed down, inputs on alternate rows to line up with a 4-lane score.
  function bank4(defs) {
    const d = G.makeDef('Bank4', 6, 7, 8, [0, 1, 2, 3].map((i) => ({ dir: 'in', row: 2 * i, name: 'Hz' + (i + 1) })).concat([{ dir: 'out', row: 3, name: 'mix' }]),
      'Four sawtooth VCOs summed and scaled by 0.2.');
    const b = G.builder(d, defs);
    for (let i = 0; i < 4; i++) b.block('v' + i, 'comp', 8, 3 + 16 * i, { def: 'VCO' });
    b.block('a1', 'add', 22, 10); b.block('a2', 'add', 22, 42); b.block('a3', 'add', 30, 26); b.block('g', 'mul', 38, 27);
    b.konst('g.in1', 'down', 2, 0.2);
    for (let i = 0; i < 4; i++) b.net(`port.in${i}`, `v${i}.in0`);
    b.net('v0.out0', 'a1.in0'); b.net('v1.out0', 'a1.in1'); b.net('v2.out0', 'a2.in0'); b.net('v3.out0', 'a2.in1');
    b.net('a1.out0', 'a3.in0'); b.net('a2.out0', 'a3.in1'); b.net('a3.out0', 'g.in0'); b.net('g.out0', 'port.out0');
    return d;
  }

  function divider(defs) {
    const d = G.makeDef('Divider', 4, 3, 8, [{ dir: 'in', row: 1, name: 'N' }, { dir: 'out', row: 1, name: 'sq' }],
      'Counter oscillator: counts ticks 0…N−1 and starts again, so its frequency is exactly 48000/N Hz, a subharmonic of the clock. Output is a ±1 square wave. The FPGA way to make a tone.');
    const b = G.builder(d, defs);
    b.block('inc', 'add', 4, 2); b.block('nm', 'add', 4, 14); b.block('gw', 'gt', 11, 6); b.block('sw', 'switch', 17, 2); b.block('ff', 'delay', 23, 3);
    b.block('h', 'mul', 4, 19); b.block('gs', 'gt', 13, 17); b.block('m2', 'mul', 19, 17); b.block('a1', 'add', 25, 17);
    b.konst('inc.in1', 'down', 2, 1); b.konst('nm.in1', 'down', 2, -0.5); b.konst('sw.in1', 'up', 1, 0);
    b.konst('h.in1', 'down', 2, 0.5); b.konst('m2.in1', 'down', 2, 2); b.konst('a1.in1', 'down', 2, -1);
    b.net('port.in0', ['nm.in0', 'h.in0']);
    b.net('inc.out0', ['gw.in0', 'sw.in2']); b.net('nm.out0', 'gw.in1'); b.net('gw.out0', 'sw.in0');
    b.net('sw.out0', 'ff.in0'); b.net('ff.out0', ['inc.in0', 'gs.in0']);
    b.net('h.out0', 'gs.in1'); b.net('gs.out0', 'm2.in0'); b.net('m2.out0', 'a1.in0'); b.net('a1.out0', 'port.out0');
    return d;
  }

  function sineVco(defs) {
    const d = G.makeDef('SineVCO', 6, 3, 8, [{ dir: 'in', row: 1, name: 'Hz' }, { dir: 'out', row: 1, name: 'sin' }],
      'Nearly pure tone: a Phasor bent into a parabolic sine, −4u(1−|u|) with u = 2·phase − 1. Harmonics are 28 dB down, so beats and comma shifts are easy to hear.');
    const b = G.builder(d, defs);
    b.block('ph', 'comp', 3, 9, { def: 'Phasor' });
    b.block('m2', 'mul', 11, 9); b.block('u', 'add', 16, 9); b.block('pos', 'gt', 22, 3); b.block('neg', 'mul', 22, 15);
    b.block('sw', 'switch', 28, 8); b.block('one', 'add', 33, 9); b.block('pr', 'mul', 38, 9); b.block('sc', 'mul', 43, 9);
    b.konst('m2.in1', 'down', 2, 2); b.konst('u.in1', 'down', 2, -1); b.konst('pos.in1', 'left', 2, 0); b.konst('neg.in1', 'down', 2, -1);
    b.konst('one.in1', 'down', 2, 1); b.konst('sc.in1', 'down', 2, -4);
    const hz = b.net('port.in0', 'ph.in0', { value: 220 });
    knobNear(d, defs, hz, 1, 12, knob('Hz', 20, 2000, 'log'));
    b.net('ph.out0', 'm2.in0'); b.net('m2.out0', 'u.in0');
    b.net('u.out0', ['pos.in0', 'neg.in0', 'sw.in2', 'pr.in0']);
    b.net('pos.out0', 'sw.in0'); b.net('neg.out0', 'sw.in1'); b.net('sw.out0', 'one.in0'); b.net('one.out0', 'pr.in1');
    b.net('pr.out0', 'sc.in0'); b.net('sc.out0', 'port.out0');
    return d;
  }

  // Tuning ROM: semitones above the tonic (0…23) in, frequency ratio out. One
  // octave fold, then a priority chain of 11 comparators and switches picks one
  // of twelve constants: the tuning. Every tuning is the same chip with
  // different constants.
  const romConsts = [];   // rid of the constant for each semitone, filled when laid out
  function romLayout(defs) {
    const id = 'just', ratios = TU.ratios(id), SP = 6, X = (k) => 14 + SP * k;
    const d = G.makeDef('Tune Just', 11, 3, 8, [{ dir: 'in', row: 1, name: 'semi' }, { dir: 'out', row: 1, name: 'ratio' }], '');
    const b = G.builder(d, defs);
    b.block('gO', 'gt', 4, 3); b.block('sO', 'add', 4, 15); b.block('swD', 'switch', 10, 9); b.block('swO', 'switch', 10, 18);
    for (let k = 1; k <= 11; k++) { b.block('g' + k, 'gt', X(k), 4); b.block('w' + k, 'switch', X(k), 13); }
    b.block('mf', 'mul', X(11) + 4, 11);
    b.konst('gO.in1', 'left', 2, 11.5); b.konst('sO.in1', 'left', 2, -12);
    b.konst('swO.in1', 'left', 2, 2); b.konst('swO.in2', 'left', 2, 1);
    romConsts[0] = b.konst('w1.in2', 'left', 2, ratios[0], knob(TU.label(id, 0), 1, 2));
    for (let k = 1; k <= 11; k++) {
      b.konst('g' + k + '.in1', 'left', 2, k - 0.5);
      romConsts[k] = b.konst('w' + k + '.in1', 'left', 2, ratios[k], knob(TU.label(id, k), 1, 2));
    }
    for (let k = 1; k <= 11; k++) b.net('g' + k + '.out0', 'w' + k + '.in0');
    for (let k = 2; k <= 11; k++) b.net('w' + (k - 1) + '.out0', 'w' + k + '.in2');
    b.net('gO.out0', ['swD.in0', 'swO.in0']);
    b.net('sO.out0', 'swD.in1');
    b.net('port.in0', ['gO.in0', 'sO.in0', 'swD.in2']);
    b.net('swD.out0', Array.from({ length: 11 }, (_, k) => 'g' + (k + 1) + '.in0'));
    b.net('w11.out0', 'mf.in0'); b.net('swO.out0', 'mf.in1'); b.net('mf.out0', 'port.out0');
    return d;
  }
  const ROM_NAMES = { pythagorean: 'Tune Pythagorean', just: 'Tune Just', meantone: 'Tune Meantone', werckmeister: 'Tune Werckmeister', vallotti: 'Tune Vallotti', equal: 'Tune Equal' };
  function roms(defs) {
    const base = romLayout(defs);
    return TU.ORDER.map((id) => {
      const t = TU.TUNINGS[id], r = TU.ratios(id);
      return variant(base, ROM_NAMES[id],
        `Tuning ROM, ${t.title} (Benson ${t.section}). Semitones above the tonic in (0–23), frequency ratio out. ${t.note} Swap it for another Tune chip to retune everything it feeds.`,
        r.map((v, k) => [romConsts[k], v, TU.label(id, k)]));
    });
  }

  // Comma pump: a register holds the chord root as a ratio of the tonic, and every
  // chord change multiplies it by an interval. With just intervals the progression
  // I–vi–ii–V–I comes back a syntonic comma (81:80) flat each time round (§5.8, 5.11).
  const pumpConsts = {};
  function pumpLayout(defs, moves, third, minorThird, fifth) {
    const d = G.makeDef('Comma Pump', 8, 5, 8, [{ dir: 'in', row: 0, name: 'trig' }, { dir: 'in', row: 4, name: 'tonic' },
      { dir: 'out', row: 0, name: 'root' }, { dir: 'out', row: 2, name: 'third' }, { dir: 'out', row: 4, name: 'fifth' }], '');
    const b = G.builder(d, defs);
    // step counter 0…3, advanced by trig
    b.block('inc', 'add', 5, 2); b.block('gw', 'gt', 11, 2); b.block('swN', 'switch', 17, 1); b.block('swC', 'switch', 24, 1); b.block('ffC', 'delay', 30, 2);
    b.konst('inc.in1', 'down', 2, 1); b.konst('gw.in1', 'down', 2, 3.5); b.konst('swN.in1', 'up', 1, 0);
    // the interval for the step being entered
    b.block('h1', 'gt', 6, 9); b.block('h2', 'gt', 12, 9); b.block('h3', 'gt', 18, 9);
    b.block('x1', 'switch', 9, 17); b.block('x2', 'switch', 15, 17); b.block('x3', 'switch', 21, 17);
    b.konst('h1.in1', 'down', 2, 0.5); b.konst('h2.in1', 'down', 2, 1.5); b.konst('h3.in1', 'down', 2, 2.5);
    pumpConsts.m1 = b.konst('x1.in1', 'left', 2, moves[1], knob('→vi', 0.5, 2));
    pumpConsts.m2 = b.konst('x2.in1', 'left', 1, moves[2], knob('→ii', 0.5, 2));
    pumpConsts.m3 = b.konst('x3.in1', 'left', 1, moves[3], knob('→V', 0.5, 2));
    pumpConsts.m0 = b.konst('x1.in2', 'down', 2, moves[0], knob('→I', 0.5, 2));
    // root register, stored as ratio − 1 so that Reset (0) means the tonic
    b.block('r1', 'add', 28, 11); b.block('rm', 'mul', 34, 16); b.block('r2', 'add', 40, 16); b.block('swR', 'switch', 46, 15); b.block('ffR', 'delay', 52, 16);
    b.konst('r1.in1', 'down', 2, 1); b.konst('r2.in1', 'down', 2, -1);
    // chord quality: steps 1 and 2 (vi, ii) are minor
    b.block('q1', 'gt', 5, 26); b.block('q2', 'gt', 5, 33); b.block('y1', 'switch', 12, 31); b.block('y2', 'switch', 18, 26);
    b.konst('q1.in1', 'left', 2, 0.5); b.konst('q2.in1', 'left', 2, 2.5);
    pumpConsts.maj = b.konst('y1.in1', 'up', 2, third, knob('maj 3rd', 1, 1.5));
    pumpConsts.min = b.konst('y1.in2', 'down', 2, minorThird, knob('min 3rd', 1, 1.5));
    pumpConsts.maj2 = b.konst('y2.in2', 'down', 2, third);
    // outputs in Hz
    b.block('oR', 'mul', 34, 26); b.block('oT', 'mul', 46, 20); b.block('oF', 'mul', 46, 30);
    pumpConsts.fifth = b.konst('oF.in1', 'down', 2, fifth, knob('5th', 1.4, 1.6));
    b.net('ffC.out0', ['inc.in0', 'swC.in2', 'q1.in0', 'q2.in0']);
    b.net('inc.out0', ['gw.in0', 'swN.in2']); b.net('gw.out0', 'swN.in0');
    b.net('swN.out0', ['swC.in1', 'h1.in0', 'h2.in0', 'h3.in0']);
    b.net('port.in0', ['swC.in0', 'swR.in0']); b.net('swC.out0', 'ffC.in0');
    b.net('h1.out0', 'x1.in0'); b.net('h2.out0', 'x2.in0'); b.net('h3.out0', 'x3.in0');
    b.net('x1.out0', 'x2.in2'); b.net('x2.out0', 'x3.in2'); b.net('x3.out0', 'rm.in1');
    b.net('ffR.out0', ['r1.in0', 'swR.in2']); b.net('r1.out0', ['rm.in0', 'oR.in1']); b.net('rm.out0', 'r2.in0'); b.net('r2.out0', 'swR.in1'); b.net('swR.out0', 'ffR.in0');
    b.net('q1.out0', 'y2.in0'); b.net('q2.out0', 'y1.in0'); b.net('y1.out0', 'y2.in1'); b.net('y2.out0', 'oT.in1');
    b.net('port.in1', 'oR.in0'); b.net('oR.out0', ['oT.in0', 'oF.in0', 'port.out0']); b.net('oT.out0', 'port.out1'); b.net('oF.out0', 'port.out2');
    return d;
  }
  function pumps(defs) {
    const just = [2 / 3, 5 / 6, 4 / 3, 4 / 3];
    const base = pumpLayout(defs, just, 5 / 4, 6 / 5, 3 / 2);
    const mt = TU.ratios('meantone'), [C, , D, Eb, E, , , Gm, , A] = mt;
    const moves = [C / Gm, A / 2, 2 * D / A, Gm / D];   // the same root motion, in ¼-comma meantone
    const set = (m, maj, min, f) => [[pumpConsts.m0, m[0]], [pumpConsts.m1, m[1]], [pumpConsts.m2, m[2]], [pumpConsts.m3, m[3]],
      [pumpConsts.maj, maj], [pumpConsts.maj2, maj], [pumpConsts.min, min], [pumpConsts.fifth, f]];
    return [
      variant(base, 'Comma Pump', 'Plays I–vi–ii–V over and over, tuning every chord justly against the one before. A flip-flop holds the root as a ratio of the tonic; each trigger multiplies it by the next interval (×5/6, ×4/3, ×4/3, ×2/3). Every chord is a pure 4:5:6 or 10:12:15, but each round trip ends 81/80 (21.5 cents) flat: the syntonic comma of Benson §5.8 and §5.11. Reset brings it back.', set(just, 5 / 4, 6 / 5, 3 / 2)),
      variant(base, 'Meantone Pump', 'The same progression with the intervals of ¼-comma meantone (§5.12): fifths a quarter comma narrow, pure major thirds. The four moves multiply to exactly 1, so the root never drifts. Swap with Comma Pump to compare.', set(moves, E / C, Eb / C, Gm / C)),
    ];
  }

  // Laying out the library with the router takes a while, so it is done once and copied.
  // In the browser the result is also kept in localStorage, keyed by a hash of the
  // code that builds it, so a reload doesn't route everything again.
  let starter = null;
  const BUILDERS = () => [phasor, vco, decay, seq4, onePole, mux4, bank4, divider, sineVco, score, romLayout, roms, pumpLayout, pumps, variant, starterDefs, G.route, G.builder];
  function cacheKey() {
    let h = 5381;
    const src = BUILDERS().map((f) => f.toString()).join('\n') + JSON.stringify(TU.TUNINGS);
    for (let i = 0; i < src.length; i++) h = (Math.imul(h, 33) ^ src.charCodeAt(i)) >>> 0;
    return 'samplefactory.library.' + h.toString(36);
  }
  function starterDefs() {
    const store = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!starter && store) {
      try { starter = store.getItem(cacheKey()); } catch (e) { starter = null; }
    }
    if (!starter) {
      const defs = {};
      const add = (d) => { defs[d.name] = d; };
      for (const make of [phasor, vco, decay, seq4, onePole, mux4, bank4, divider, sineVco]) add(make(defs));
      add(score(defs, 'Chords', [[12, 9, 14, 7], [16, 12, 17, 11], [19, 16, 21, 14]], ['v1', 'v2', 'v3'], [0, 23],
        'Chord score: three voices, four steps, each step a number of semitones above the tonic (0–23). Feed it to Tune chips. The default is I–vi–ii–V in C: C E G, A C E, D F A, G B D.'));
      add(score(defs, 'Harmonics', [[48, 40, 54, 36], [60, 48, 64, 45], [72, 60, 80, 54], [96, 80, 108, 64]], ['h1', 'h2', 'h3', 'h4'], [1, 128],
        'Otonal score: four voices, four steps, each a harmonic number of one fundamental f0, multiplied by f0 to give Hz. With f0 = C4/48 the default steps are I = 48:60:72:96, vi = 40:48:60:80, ii = 54:64:80:108 and V7 = 36:45:54:64: just intonation as a subset of one harmonic series (Benson §5.5–5.7).', 'f0'));
      add(score(defs, 'Periods', [[216, 180, 216, 240], [180, 144, 180, 192], [144, 120, 144, 160]], ['N1', 'N2', 'N3'], [2, 512],
        'Utonal score for Dividers: three voices, four steps, each a period in ticks. Periods 6:5:4 give a just minor triad (10:12:15, §5.6) and 15:12:10 a just major triad (4:5:6).'));
      roms(defs).forEach(add);
      pumps(defs).forEach(add);
      starter = JSON.stringify(defs);
      if (store) {
        try {
          for (const k of Object.keys(store)) if (k.startsWith('samplefactory.library.')) store.removeItem(k);
          store.setItem(cacheKey(), starter);
        } catch (e) { /* full or unavailable: build again next time */ }
      }
    }
    return JSON.parse(starter);
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

  // A sample stack through a filter. The built-in song is synthesized at load time
  // (samples.js); load your own WAV into the block from the panel on the right.
  function exSample(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('song', 'sample', 2, 2, { sample: 'demo:factory-song', name: 'Factory song (built in)', loop: true });
    b.block('lp', 'comp', 15, 2, { def: 'OnePole' });
    b.block('vol', 'mul', 22, 2);
    b.block('dac', 'dac', 28, 0); b.block('scope', 'scope', 28, 4, { window: 4800 });
    b.konst('vol.in1', 'down', 2, 0.5, knob('volume', 0, 1));
    b.net('song.out0', 'lp.in0');
    b.net('lp.out0', 'vol.in0');
    b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }

  // I–vi–ii–V from a chord score through three tuning ROMs (Benson §5.11).
  function exTuning(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('bar', 'comp', 2, 2, { def: 'Phasor' }); b.block('beat', 'comp', 2, 12, { def: 'Phasor' });
    b.block('score', 'comp', 12, 2, { def: 'Chords' });
    for (let i = 0; i < 3; i++) {
      b.block('rom' + i, 'comp', 20, 1 + 6 * i, { def: 'Tune Just' });
      b.block('x' + i, 'mul', 35, 1 + 6 * i);
      b.block('v' + i, 'comp', 41, 1 + 6 * i, { def: 'VCO' });
    }
    b.block('a1', 'add', 49, 3); b.block('a2', 'add', 54, 8);
    b.block('env', 'comp', 41, 20, { def: 'Decay' }); b.block('vca', 'mul', 59, 9); b.block('vol', 'mul', 64, 9);
    b.block('dac', 'dac', 70, 6); b.block('scope', 'scope', 70, 12, { window: 2048 });
    b.konst('bar.in0', 'left', 3, 0.5, knob('bars/s', 0.05, 2, 'log'));
    b.konst('beat.in0', 'left', 3, 2);
    b.konst('vol.in1', 'down', 2, 0.4, knob('volume', 0, 1));
    b.net('bar.out0', 'score.in0');
    for (let i = 2; i >= 0; i--) b.net(`score.out${i}`, `rom${i}.in0`);
    for (let i = 0; i < 3; i++) { b.net(`rom${i}.out0`, `x${i}.in0`); b.net(`x${i}.out0`, `v${i}.in0`); }
    const tonic = b.net('x2.in1', ['x1.in1', 'x0.in1'], { value: 130.81 });
    knobNear(r, defs, tonic, 37, 16, knob('tonic Hz', 50, 400, 'log'));
    b.net('v0.out0', 'a1.in0'); b.net('v1.out0', 'a1.in1'); b.net('a1.out0', 'a2.in0'); b.net('v2.out0', 'a2.in1');
    b.net('beat.out1', 'env.in0');
    b.net('a2.out0', 'vca.in0'); b.net('env.out0', 'vca.in1'); b.net('vca.out0', 'vol.in0');
    b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }
  // Chords as harmonic numbers of one fundamental (otonal).
  function exHarmonics(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('bar', 'comp', 2, 2, { def: 'Phasor' }); b.block('beat', 'comp', 2, 14, { def: 'Phasor' });
    b.block('score', 'comp', 12, 2, { def: 'Harmonics' }); b.block('bank', 'comp', 21, 2, { def: 'Bank4' });
    b.block('env', 'comp', 21, 13, { def: 'Decay' }); b.block('vca', 'mul', 31, 4); b.block('vol', 'mul', 36, 4);
    b.block('dac', 'dac', 42, 1); b.block('scope', 'scope', 42, 7, { window: 4800 });
    b.konst('bar.in0', 'left', 3, 0.5, knob('bars/s', 0.05, 2, 'log'));
    b.konst('beat.in0', 'left', 3, 2);
    b.konst('score.in1', 'left', 3, 261.63 / 48, knob('f0 Hz', 2, 20, 'log'));
    b.konst('vol.in1', 'down', 2, 0.5, knob('volume', 0, 1));
    b.net('bar.out0', 'score.in0');
    for (let i = 3; i >= 0; i--) b.net(`score.out${i}`, `bank.in${i}`);
    b.net('beat.out1', 'env.in0');
    b.net('bank.out0', 'vca.in0'); b.net('env.out0', 'vca.in1'); b.net('vca.out0', 'vol.in0');
    b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }
  // The comma pump: a register multiplies its way round I–vi–ii–V–I.
  function exPump(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('tick', 'comp', 2, 2, { def: 'Phasor' });
    b.block('pump', 'comp', 12, 2, { def: 'Comma Pump' });
    for (let i = 0; i < 3; i++) b.block('s' + i, 'comp', 25, 1 + 6 * i, { def: 'SineVCO' });
    b.block('a1', 'add', 35, 4); b.block('a2', 'add', 40, 9); b.block('vol', 'mul', 45, 9);
    b.block('dac', 'dac', 51, 6); b.block('scope', 'scope', 51, 12, { window: 4800 });
    b.konst('tick.in0', 'left', 3, 1, knob('chords/s', 0.2, 8, 'log'));
    b.konst('pump.in1', 'left', 3, 261.63, knob('tonic Hz', 50, 600, 'log'));
    b.konst('vol.in1', 'down', 2, 0.3, knob('volume', 0, 1));
    b.net('tick.out1', 'pump.in0');
    for (let i = 2; i >= 0; i--) b.net(`pump.out${i}`, `s${i}.in0`);
    b.net('s0.out0', 'a1.in0'); b.net('s1.out0', 'a1.in1'); b.net('a1.out0', 'a2.in0'); b.net('s2.out0', 'a2.in1');
    b.net('a2.out0', 'vol.in0'); b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }
  // Integer-period dividers: chords as subharmonics of the clock (utonal).
  function exDividers(defs) {
    const r = G.makeSheet(), b = G.builder(r, defs);
    b.block('bar', 'comp', 2, 2, { def: 'Phasor' });
    b.block('score', 'comp', 12, 2, { def: 'Periods' });
    for (let i = 0; i < 3; i++) b.block('d' + i, 'comp', 20, 1 + 6 * i, { def: 'Divider' });
    b.block('a1', 'add', 28, 4); b.block('a2', 'add', 33, 9); b.block('vol', 'mul', 38, 9);
    b.block('dac', 'dac', 44, 6); b.block('scope', 'scope', 44, 12, { window: 2048 });
    b.konst('bar.in0', 'left', 3, 0.25, knob('bars/s', 0.05, 2, 'log'));
    b.konst('vol.in1', 'down', 2, 0.15, knob('volume', 0, 0.5));
    b.net('bar.out0', 'score.in0');
    for (let i = 2; i >= 0; i--) b.net(`score.out${i}`, `d${i}.in0`);
    b.net('d0.out0', 'a1.in0'); b.net('d1.out0', 'a1.in1'); b.net('a1.out0', 'a2.in0'); b.net('d2.out0', 'a2.in1');
    b.net('a2.out0', 'vol.in0'); b.net('vol.out0', ['dac.in0', 'scope.in0']);
    return r;
  }

  const EXAMPLES = [
    { title: '1 · Counter and pipeline', rate: 4, make: exCounter,
      note: 'Add and flip-flop make a counter: the Add settles to count + step within the tick, and the flip-flop stores it at the clock edge. Each extra flip-flop holds the count one tick longer. Drag the "step" knob.' },
    { title: '2 · A tone (zoom into the VCO)', rate: FS, make: exTone,
      note: 'Zoom into the VCO with the mouse wheel to find its Phasor, and into that to see the registers that make the ramp.' },
    { title: '3 · Sequenced synth', rate: FS, make: exSynth,
      note: 'No panels: to change the melody, zoom into Seq4 and turn its knobs. Slide the clock down to hear (and see) it slow to a crawl.' },
    { title: '4 · Sample player (WAV)', rate: FS, make: exSample,
      note: 'The long block is a stack of every sample in a song, emitted one per tick. Turn the filter knob inside OnePole, slide the clock down to step through the song, or select the block and load your own WAV (or drop one on the board).' },
    { title: '5 · Six temperaments (tuning ROMs)', rate: FS, make: exTuning,
      note: 'I–vi–ii–V: a chord score gives semitone numbers, three Tune chips turn them into ratios. It starts in just intonation, where ii (D⁰ F⁰ A⁻¹) is out of tune. Select a Tune chip and swap it, all three at once, for Meantone, Werckmeister, Vallotti, Equal or Pythagorean.' },
    { title: '6 · Chords as harmonics (otonal)', rate: FS, make: exHarmonics,
      note: 'Every chord is a set of harmonic numbers of one fundamental, f0 = C4/48 ≈ 5.45 Hz: 48:60:72:96, 40:48:60:80, 54:64:80:108, 36:45:54:64. Zoom into Harmonics to change them.' },
    { title: '7 · The comma pump', rate: FS, make: exPump,
      note: 'A flip-flop holds the root; each chord change multiplies it by a just interval. Every chord is pure, but each time round I–vi–ii–V–I the whole thing sinks by 81/80. Watch the root trace. Swap the pump for Meantone Pump and it stays put.' },
    { title: '8 · Dividers (utonal)', rate: FS, make: exDividers,
      note: 'Counters that divide the 48 kHz clock by whole numbers: periods 216:180:144 (= 6:5:4) give a just minor triad, 180:144:120 (15:12:10) a just major one.' },
  ];

  function exampleProject(i, existingDefs) {
    const defs = Object.assign(starterDefs(), existingDefs || {});
    return { version: 2, root: EXAMPLES[i].make(defs), defs, values: {} };
  }

  const api = { starterDefs, EXAMPLES, exampleProject };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
