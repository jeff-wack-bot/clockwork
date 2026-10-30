// Converters as library blocks. The board has four crossings between domains
// (Voltmeter, AWG, Word, Value) that do nothing but cross; every map between
// domains is built from them and float arithmetic: these. Each is a 3×3 block
// with its signal in and out on the middle row and its settings (range, gain,
// binary point) as input pins above it, whose defaults are knobs: per copy, and
// wireable. The width of a word is a setting of the Word inside, so 12-bit and
// unsigned variants are blocks of their own (variant() makes one).
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const G = node ? require('./model.js') : root.GW;
  if (node) require('./analog.js');
  const C4 = 261.6255653005986;
  const knob = (label, min, max, scale) => ({ label, min, max, scale: scale || 'lin' });
  const P = (row, name, domain, value, k) => Object.assign({ dir: 'in', row, name }, domain === 'float' ? {} : { domain }, value !== undefined ? { value } : {}, k ? { knob: k } : {});
  const OUT = (domain) => Object.assign({ dir: 'out', row: 1, name: 'out' }, domain === 'float' ? {} : { domain });
  const IN = (domain) => P(1, 'in', domain);

  function make(name, ports, description, build) {
    const d = G.makeDef(name, 3, 3, 8, ports, description), b = G.builder(d, {});
    build(b);
    return d;
  }
  // x · 2^(−log₂ r): x / r, for r > 0, from the atoms
  function divide(b, src, by, at, x, y) {
    b.block(at + 'l', 'log2', x, y); b.block(at + 'n', 'mul', x + 4, y - 1); b.block(at + 'e', 'exp2', x + 8, y); b.block(at + 'm', 'mul', x + 12, y + 4);
    b.konst(at + 'n.in1', 'down', 2, -1);
    b.net(by, at + 'l.in0'); b.net(at + 'l.out0', at + 'n.in0'); b.net(at + 'n.out0', at + 'e.in0');
    b.net(src, at + 'm.in0'); b.net(at + 'e.out0', at + 'm.in1');
    return at + 'm.out0';
  }
  const BUILD = {
    ADC: (o) => make(o.name, [P(0, 'range', 'float', 5, knob('range V', 0.1, 12, 'log')), IN('analog'), OUT('fixed')],
      `Analog to fixed point, bipolar: ±range volts become the ${o.bits}-bit two's-complement codes, rounded, and clipped at the ends. Voltmeter, ÷ range, then a Word that takes a fraction of full scale.`,
      (b) => {
        b.block('vm', 'voltmeter', 2, 11); b.block('w', 'word', 19, 11, { params: { bits: o.bits, signed: 1, mode: 1, scale: 1 } });
        b.net('port.in1', 'vm.in0');
        b.net(divide(b, 'vm.out0', 'port.in0', 'd', 4, 2), 'w.in0');
        b.net('w.out0', 'port.out0');
      }),
    DAC: (o) => make(o.name, [P(0, 'range', 'float', 5, knob('range V', 0.1, 12, 'log')), IN('fixed'), OUT('analog')],
      o.signed ? 'Fixed point to analog, bipolar: the word read as a signed fraction of full scale (−1 … 1), times range: −range … +range volts, whatever the width of the bus.'
        : 'Fixed point to analog, one-sided: the word read as an unsigned fraction of full scale (0 … 1), times range: 0 … range volts, whatever the width of the bus.',
      (b) => {
        b.block('v', 'value', 3, 11, { params: { signed: o.signed, scale: 1 } }); b.block('m', 'mul', 10, 10); b.block('g', 'awg', 18, 11);
        b.net('port.in1', 'v.in0'); b.net('v.out0', 'm.in0'); b.net('port.in0', 'm.in1'); b.net('m.out0', 'g.in0'); b.net('g.out0', 'port.out0');
      }),
    Quantizer: (o) => make(o.name, [P(0, 'frac', 'float', 8, knob('frac bits', 0, 31)), IN('float'), OUT('fixed')],
      `Float to fixed point: the number times 2^frac (frac: the bits after the binary point), rounded and clipped to a ${o.bits}-bit ${o.signed ? 'signed' : 'unsigned'} word.`,
      (b) => {
        b.block('e', 'exp2', 3, 3); b.block('m', 'mul', 10, 10); b.block('w', 'word', 18, 11, { params: { bits: o.bits, signed: o.signed, mode: 1, scale: 0 } });
        b.net('port.in0', 'e.in0'); b.net('port.in1', 'm.in0'); b.net('e.out0', 'm.in1'); b.net('m.out0', 'w.in0'); b.net('w.out0', 'port.out0');
      }),
    Dequantizer: (o) => make(o.name, [P(0, 'frac', 'float', 8, knob('frac bits', 0, 31)), IN('fixed'), OUT('float')],
      `Fixed point to float: the word (${o.signed ? 'two\'s complement' : 'unsigned'}) divided by 2^frac.`,
      (b) => {
        b.block('v', 'value', 3, 11, { params: { signed: o.signed, scale: 0 } }); b.block('n', 'mul', 3, 2); b.block('e', 'exp2', 8, 3); b.block('m', 'mul', 14, 10);
        b.konst('n.in1', 'down', 2, -1);
        b.net('port.in0', 'n.in0'); b.net('n.out0', 'e.in0'); b.net('port.in1', 'v.in0'); b.net('v.out0', 'm.in0'); b.net('e.out0', 'm.in1'); b.net('m.out0', 'port.out0');
      }),
    'Scaled Voltmeter': (o) => make(o.name, [P(0, 'range', 'float', 1, knob('range V', 0.1, 100, 'log')), IN('analog'), OUT('float')],
      'Analog to float, scaled: the voltage divided by range (at range 5, ±5 V audio reads ±1).',
      (b) => {
        b.block('vm', 'voltmeter', 2, 11);
        b.net('port.in1', 'vm.in0');
        b.net(divide(b, 'vm.out0', 'port.in0', 'd', 4, 2), 'port.out0');
      }),
    'Scaled AWG': (o) => make(o.name, [P(0, 'gain', 'float', 1, knob('gain V', 0.01, 100, 'log')), IN('float'), OUT('analog')],
      'Float to analog, scaled: gain volts for every unit of the number.',
      (b) => {
        b.block('m', 'mul', 6, 10); b.block('g', 'awg', 16, 11);
        b.net('port.in1', 'm.in0'); b.net('port.in0', 'm.in1'); b.net('m.out0', 'g.in0'); b.net('g.out0', 'port.out0');
      }),
    'V/OCT → Hz': (o) => make(o.name, [IN('analog'), OUT('float')],
      'Analog to float, exponentially: Hz = 261.63 · 2^V (1 V/oct, 0 V = C4). A Voltmeter, 2ˣ, times C4.',
      (b) => {
        b.block('vm', 'voltmeter', 2, 11); b.block('e', 'exp2', 8, 12); b.block('m', 'mul', 14, 11);
        b.konst('m.in1', 'down', 3, C4);
        b.net('port.in0', 'vm.in0'); b.net('vm.out0', 'e.in0'); b.net('e.out0', 'm.in0'); b.net('m.out0', 'port.out0');
      }),
    'Hz → V/OCT': (o) => make(o.name, [IN('float'), OUT('analog')],
      'Float to analog, logarithmically: V = log₂(Hz / 261.63) (1 V/oct, 0 V = C4). Times 1/C4, log₂, an AWG.',
      (b) => {
        b.block('m', 'mul', 3, 11); b.block('l', 'log2', 9, 12); b.block('g', 'awg', 16, 11);
        b.konst('m.in1', 'down', 3, 1 / C4);
        b.net('port.in0', 'm.in0'); b.net('m.out0', 'l.in0'); b.net('l.out0', 'g.in0'); b.net('g.out0', 'port.out0');
      }),
  };
  // The library's converters, and the names of variants (a Word of another width, unsigned).
  const STANDARD = [
    { kind: 'ADC', name: 'ADC', bits: 8 }, { kind: 'DAC', name: 'DAC', signed: 1 }, { kind: 'DAC', name: 'DAC (one-sided)', signed: 0 },
    { kind: 'Quantizer', name: 'Quantizer', bits: 16, signed: 1 }, { kind: 'Dequantizer', name: 'Dequantizer', signed: 1 },
    { kind: 'Dequantizer', name: 'Dequantizer (unsigned)', signed: 0 },
    { kind: 'Scaled Voltmeter', name: 'Scaled Voltmeter' }, { kind: 'Scaled AWG', name: 'Scaled AWG' },
    { kind: 'V/OCT → Hz', name: 'V/OCT → Hz' }, { kind: 'Hz → V/OCT', name: 'Hz → V/OCT' },
  ];
  function variantName(kind, o) {
    if (kind === 'ADC') return o.bits === 8 ? 'ADC' : `ADC ${o.bits}-bit`;
    if (kind === 'Quantizer') return (o.bits === 16 ? 'Quantizer' : `Quantizer ${o.bits}-bit`) + (o.signed ? '' : ' (unsigned)');
    if (kind === 'Dequantizer') return o.signed ? 'Dequantizer' : 'Dequantizer (unsigned)';
    if (kind === 'DAC') return o.signed ? 'DAC' : 'DAC (one-sided)';
    return kind;
  }
  function variant(kind, o) { o = Object.assign({}, o); o.name = variantName(kind, o); return BUILD[kind](o); }
  const standard = () => STANDARD.map((o) => BUILD[o.kind](o));

  const api = { standard, variant, variantName, C4 };
  if (node) module.exports = api;
  else root.GW.Converters = api;
})(typeof self !== 'undefined' ? self : this);
