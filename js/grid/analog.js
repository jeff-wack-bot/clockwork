// Analog modules: continuous-time circuits simulated on the board's one clock.
//
// One tick is always 1/48000 s of simulated time, whatever the clock slider says:
// the slider only changes how fast ticks happen, so at a slow clock the analog
// parts run in slow motion, exactly like the digital ones.
//
// An analog module is sampled by the clock. During tick n its outputs hold what
// they measured over the previous tick (like a flip-flop's output, or an ADC);
// at the clock edge it integrates its circuit equations across the next 1/48000 s
// with its inputs held at their tick-n values (like a DAC). So every analog
// module is a clock boundary: feedback through analog modules is always legal,
// as it is with patch cables, and each one adds one tick (20.8 µs) of latency.
//
// Voltages are plain numbers: 1 V = 1.0. Eurorack conventions: pitch 1 V/oct with
// 0 V = C4 (261.63 Hz), audio ±5 V, gates and envelopes 0–10 V. Gate inputs are
// Schmitt triggers (on above 0.7 V, off below 0.3 V), so the board's 0/1 logic
// works as a gate too.
//
// Analog modules sit on the board as their panels (2 HP to a cell), knobs and
// jacks included; their wires are patch cables. Besides them this file defines
// the four crossings between the three signal domains: Voltmeter and AWG (analog
// ↔ float) and Word and Value (float ↔ fixed point). They only cross: every map
// (ADC, DAC, ranges, pitch) is a library block built from them. Exact and
// combinational, like the board's logic.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;
  const C4 = 261.6255653005986;

  // ---- parameters ------------------------------------------------------------------
  const P = (id, label, min, max, def, o) => Object.assign({ id, label, min, max, def, scale: 'lin', unit: '' }, o || {});
  const log = { scale: 'log' };
  const fmtNum = (v, d) => {
    const a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + 'k';
    return v.toFixed(d === undefined ? (a >= 100 ? 0 : a >= 10 ? 1 : 2) : d);
  };
  const secs = (v) => (v < 1 ? fmtNum(v * 1000) + ' ms' : fmtNum(v) + ' s');
  function showParam(p, v) {
    if (p.show) return p.show(v);
    if (p.options) return p.options[Math.round(v)] || String(v);
    if (p.unit === 's') return secs(v);
    return fmtNum(v) + (p.unit ? ' ' + p.unit : '');
  }
  // Knob position in [0, 1] and back.
  function paramFrac(p, v) {
    if (p.scale === 'log') return Math.log(Math.max(v, p.min) / p.min) / Math.log(p.max / p.min);
    return (v - p.min) / ((p.max - p.min) || 1);
  }
  function paramValue(p, f) {
    f = Math.min(1, Math.max(0, f));
    let v = p.scale === 'log' ? p.min * Math.pow(p.max / p.min, f) : p.min + f * (p.max - p.min);
    if (p.options || p.int) v = Math.round(v);
    return v;
  }

  const In = (id, label, def, dom) => ({ id, label, def: def || 0, dom: dom || 'analog' });
  const Out = (id, label, dom) => ({ id, label, dom: dom || 'analog' });
  const pitchHz = (v) => fmtNum(C4 * Math.pow(2, v)) + ' Hz';

  // ---- shared code, emitted once at the top of a program that uses any of this -----
  const PRELUDE = `const DT = 1 / 48000, TAU = 2 * Math.PI, C4 = ${C4};
// tanh-like saturation (exact at 0, flat beyond ±3); the ±12 V power rails: linear
// up to ±10 V, then bending smoothly into 12 V, so ordinary voltages pass exactly
const sat = (x) => (x <= -3 ? -1 : x >= 3 ? 1 : x * (27 + x * x) / (27 + 9 * x * x));
const rail = (x) => (x > 10 ? 10 + 2 * sat((x - 10) / 2) : x < -10 ? -10 - 2 * sat((-x - 10) / 2) : x);
// antiderivatives of the oscillator shapes, so an output can be the waveform's
// average over the tick (an integrating ADC: no aliasing from the sampling itself)
const iSaw = (x) => { const f = x - Math.floor(x); return f * f - f; };
const iTri = (x) => { const f = x - Math.floor(x); return f < 0.5 ? 2 * f * f - f : -2 * f * f + 3 * f - 1; };
const iSin = (x) => (1 - Math.cos(TAU * x)) / TAU;
const iSqr = (x, w) => { const k = Math.floor(x), f = x - k; return k * (2 * w - 1) + (f < w ? f : 2 * w - f); };
// xorshift32 noise source; seeds live in the module's state, so Reset repeats the noise
const xs = (r) => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return r >>> 0; };
const gauss = (a, b) => Math.sqrt(-2 * Math.log(a / 4294967296 + 1e-12)) * Math.cos(TAU * b / 4294967296);
// Schmitt trigger: on above 0.7 V, off below 0.3 V
const schmitt = (was, v) => (was ? v > 0.3 : v > 0.7);
// fixed point: a word of b bits as an unsigned integer; signed words in two's complement
const toFix = (x, b, sg) => { const lo = sg ? -Math.pow(2, b - 1) : 0, hi = sg ? Math.pow(2, b - 1) - 1 : Math.pow(2, b) - 1; let q = Math.round(x); if (!(q >= lo)) q = lo; if (q > hi) q = hi; return q < 0 ? q + Math.pow(2, b) : q; };
const fromFix = (x, b, sg) => (sg && x >= Math.pow(2, b - 1) ? x - Math.pow(2, b) : x);
const wrapFix = (x, b) => { const m = Math.pow(2, b), q = Math.round(x); return q === q ? ((q % m) + m) % m : 0; };`;

  // ---- the modules ---------------------------------------------------------------------
  // kind: 'analog' (sampled circuit) or 'logic' (exact, within the tick); chip: a
  // small converter chip rather than a panel. hp: panel width (1 HP = 5.08 mm).
  // Pins are analog unless they say otherwise (dom).
  // code(c) is the update at the clock edge; c.in(id), c.p(id), c.s(id), c.out(id).
  const MODULES = {
    vco: {
      kind: 'analog', title: 'VCO', hp: 14, sym: 'VCO', color: '#2b3442',
      ins: [In('voct', 'V/OCT'), In('fm', 'FM'), In('pwm', 'PWM'), In('sync', 'SYNC')],
      outs: [Out('sin', 'SIN'), Out('tri', 'TRI'), Out('saw', 'SAW'), Out('sqr', 'SQR')],
      params: [P('freq', 'FREQ', -4, 4, 0, { unit: 'V', show: pitchHz }), P('fine', 'FINE', -1, 1, 0, { unit: 'st' }),
        P('pw', 'PW', 0.05, 0.95, 0.5), P('fm', 'FM', -1, 1, 0, { unit: 'oct/V' }),
        P('drift', 'DRIFT', 0, 30, 0, { unit: '¢' }), P('track', 'TRACK', -3, 3, 0, { unit: '%' })],
      state: ['ph', 'dr', 'rng', 'gate'],
      doc: 'Voltage-controlled oscillator with an exponential converter: f = 261.63 Hz · 2^(FREQ + FINE/12 + V/OCT·(1 + TRACK%) + FM·fm + drift). The core is a phase that runs from 0 to 1 at f; the outputs (±5 V) are the waveforms averaged over each tick, which is what an integrating converter would measure, so they stay clean at high pitch. DRIFT is a slow random wander of the pitch (in cents, time constant 2 s), TRACK a scaling error of the 1 V/oct input: the two imperfections of real oscillators, at 0 by default. SYNC resets the phase on a rising edge; PWM adds 0.1 per volt to the pulse width.',
      code: (c) => {
        const on = (id) => c.used(id);
        const avg = { sin: `5 * (iSin(y) - iSin(x)) / dp`, tri: `5 * (iTri(y) - iTri(x)) / dp`, saw: `5 * (iSaw(y) - iSaw(x)) / dp`, sqr: `5 * (iSqr(y, w) - iSqr(x, w)) / dp` };
        const pt = { sin: `5 * Math.sin(TAU * x)`, tri: `5 * (x < 0.5 ? 4 * x - 1 : 3 - 4 * x)`, saw: `5 * (2 * x - 1)`, sqr: `x < w ? 5 : -5` };
        const ids = ['sin', 'tri', 'saw', 'sqr'].filter(on);
        return `let v = ${c.p('freq')} + ${c.p('fine')} / 12 + ${c.in('voct')} * (1 + ${c.p('track')} / 100) + ${c.p('fm')} * ${c.in('fm')};
if (${c.p('drift')} > 0) { let r = ${c.s('rng')} || ${c.seed}; const a = (r = xs(r)), b = (r = xs(r)); ${c.s('rng')} = r; ${c.s('dr')} += -${c.s('dr')} * DT / 2 + Math.sqrt(DT) * gauss(a, b); v += ${c.s('dr')} * ${c.p('drift')} / 1200; }
const dp = Math.min(0.5, C4 * Math.pow(2, v) * DT);${on('sqr') ? ` const w = Math.min(0.98, Math.max(0.02, ${c.p('pw')} + ${c.in('pwm')} / 10));` : ''}
${c.conn('sync') ? `const g = schmitt(${c.s('gate')}, ${c.in('sync')}); if (g && !${c.s('gate')}) ${c.s('ph')} = 0; ${c.s('gate')} = g ? 1 : 0;\n` : ''}const x = ${c.s('ph')}, y = x + dp;
${ids.length ? `if (dp > 1e-7) { ${ids.map((id) => `${c.out(id)} = ${avg[id]};`).join(' ')} }
else { ${ids.map((id) => `${c.out(id)} = ${pt[id]};`).join(' ')} }
` : ''}${c.s('ph')} = y - Math.floor(y);`;
      },
    },
    lfo: {
      kind: 'analog', title: 'LFO', hp: 10, sym: 'LFO', color: '#2b3442',
      ins: [In('rate', 'RATE'), In('reset', 'RESET')],
      outs: [Out('sin', 'SIN'), Out('tri', 'TRI'), Out('saw', 'SAW'), Out('sqr', 'SQR')],
      params: [P('rate', 'RATE', 0.01, 50, 1, Object.assign({ unit: 'Hz' }, log)), P('amp', 'LEVEL', 0, 5, 5, { unit: 'V' })],
      state: ['ph', 'gate'],
      doc: 'Low-frequency oscillator. The RATE input is 1 V/oct (each volt doubles the rate). Outputs swing ±LEVEL. RESET restarts the cycle on a rising edge.',
      code: (c) => {
        const a = c.p('amp'), sh = { sin: `${a} * Math.sin(TAU * x)`, tri: `${a} * (x < 0.5 ? 4 * x - 1 : 3 - 4 * x)`, saw: `${a} * (2 * x - 1)`, sqr: `x < 0.5 ? ${a} : -${a}` };
        return `${c.conn('reset') ? `const g = schmitt(${c.s('gate')}, ${c.in('reset')}); if (g && !${c.s('gate')}) ${c.s('ph')} = 0; ${c.s('gate')} = g ? 1 : 0;\n` : ''}let x = ${c.s('ph')} + ${c.p('rate')} * ${c.conn('rate') ? `Math.pow(2, ${c.in('rate')})` : '1'} * DT; x -= Math.floor(x); ${c.s('ph')} = x;
${['sin', 'tri', 'saw', 'sqr'].filter((id) => c.used(id)).map((id) => `${c.out(id)} = ${sh[id]};`).join(' ')}`;
      },
    },
    vcf: {
      kind: 'analog', title: 'Ladder VCF', hp: 12, sym: 'VCF', color: '#33302a',
      ins: [In('in', 'IN'), In('cv', 'CUTOFF'), In('res', 'RES')],
      outs: [Out('lp', 'LP24'), Out('lp2', 'LP12'), Out('hp', 'HP')],
      params: [P('freq', 'CUTOFF', 20, 20000, 1000, Object.assign({ unit: 'Hz' }, log)), P('res', 'RES', 0, 1.2, 0.3),
        P('cv', 'CV AMT', -1, 1, 1, { unit: 'oct/V' }), P('drive', 'DRIVE', 0.2, 5, 1)],
      state: ['y1', 'y2', 'y3', 'y4', 'rng'],
      doc: 'Four-pole transistor ladder (Moog type): four one-pole stages, the input saturated (tanh) together with the feedback from the last stage, k = 4·RES. Above RES ≈ 1 it whistles at the cutoff on its own: like the real circuit, a whisper of thermal noise is enough to start it. Simulated with 4 substeps per tick. Cutoff = CUTOFF · 2^(CV AMT · CUTOFF in), so the CUTOFF input is 1 V/oct at CV AMT = 1. RES in adds 0.1 per volt. Outputs: LP24 (last stage), LP12 (second stage) and HP (a mix of the stages).',
      code: (c) => `const fc = Math.min(20000, Math.max(5, ${c.p('freq')} * Math.pow(2, ${c.p('cv')} * ${c.in('cv')})));
const g = 1 - Math.exp(-TAU * fc * DT / 4), k = 4 * Math.max(0, ${c.p('res')} + ${c.in('res')} / 10);
let r = xs(${c.s('rng')} || ${c.seed}); ${c.s('rng')} = r;
const x = ${c.p('drive')} * ${c.in('in')} / 5 + (r / 4294967296 - 0.5) * 1e-6;
let y1 = ${c.s('y1')}, y2 = ${c.s('y2')}, y3 = ${c.s('y3')}, y4 = ${c.s('y4')}, u = 0;
for (let m = 0; m < 4; m++) {
  u = sat(x - k * y4);
  y1 += g * (u - y1); y2 += g * (y1 - y2); y3 += g * (y2 - y3); y4 += g * (y3 - y4);
}
${c.s('y1')} = y1; ${c.s('y2')} = y2; ${c.s('y3')} = y3; ${c.s('y4')} = y4;
${c.out('lp')} = 5 * y4; ${c.out('lp2')} = 5 * y2; ${c.out('hp')} = 5 * (u - 4 * y1 + 6 * y2 - 4 * y3 + y4);`,
    },
    vca: {
      kind: 'analog', title: 'VCA', hp: 8, sym: 'VCA', color: '#2b3442',
      ins: [In('in', 'IN'), In('cv', 'CV', 10)],
      outs: [Out('out', 'OUT')],
      params: [P('level', 'LEVEL', 0, 1, 1, { small: true }), P('resp', 'EXP', 0, 1, 0, { small: true })],
      state: [],
      doc: 'Voltage-controlled amplifier: OUT = IN · LEVEL · response(CV/10), bending softly into the ±12 V rails above 10 V. With nothing in CV it is fully open (the jack is normalled to 10 V). EXP bends the response from linear (0) towards cubic (1), which sounds more even for envelopes.',
      code: (c) => `const a = Math.min(1, Math.max(0, ${c.in('cv')} / 10)), e = ${c.p('resp')};
${c.out('out')} = rail(${c.in('in')} * ${c.p('level')} * ((1 - e) * a + e * a * a * a));`,
    },
    adsr: {
      kind: 'analog', title: 'ADSR', hp: 10, sym: 'ADSR', color: '#33302a',
      ins: [In('gate', 'GATE'), In('retrig', 'RETRIG')],
      outs: [Out('env', 'ENV')],
      params: [P('a', 'A', 0.001, 10, 0.01, Object.assign({ unit: 's' }, log)), P('d', 'D', 0.001, 10, 0.3, Object.assign({ unit: 's' }, log)),
        P('s', 'S', 0, 1, 0.5), P('r', 'R', 0.001, 10, 0.5, Object.assign({ unit: 's' }, log))],
      state: ['env', 'stage', 'gate', 'trig'],
      doc: 'Envelope generator built like the analog ones: a capacitor charged and discharged through resistors, so every segment is an exponential curve. Attack charges towards 13 V and turns into decay when it reaches 10 V (so A is the attack time); decay falls towards S·10 V and release towards 0 V, A, D and R being the times to cover 90% of the way. GATE is a Schmitt trigger; a rising edge on RETRIG restarts the attack while the gate is held.',
      code: (c) => `const gt = schmitt(${c.s('gate')}, ${c.in('gate')}), tr = schmitt(${c.s('trig')}, ${c.in('retrig')});
if ((gt && !${c.s('gate')}) || (gt && tr && !${c.s('trig')})) ${c.s('stage')} = 1;
if (!gt) ${c.s('stage')} = 0;
${c.s('gate')} = gt ? 1 : 0; ${c.s('trig')} = tr ? 1 : 0;
let y = ${c.s('env')};
if (${c.s('stage')} === 1) {
  y = 13 + (y - 13) * Math.exp(-DT * Math.log(13 / 3) / ${c.p('a')});
  if (y >= 10) { y = 10; ${c.s('stage')} = 2; }
} else if (${c.s('stage')} === 2) {
  const t = 10 * ${c.p('s')}; y = t + (y - t) * Math.exp(-DT * Math.LN10 / ${c.p('d')});
} else y = y * Math.exp(-DT * Math.LN10 / ${c.p('r')});
${c.s('env')} = y; ${c.out('env')} = y;`,
    },
    mixer: {
      kind: 'analog', title: 'Mixer', hp: 14, sym: 'MIX', color: '#2b3442',
      ins: [In('in1', 'IN 1'), In('in2', 'IN 2'), In('in3', 'IN 3'), In('in4', 'IN 4')],
      outs: [Out('out', 'OUT'), Out('inv', 'INV')],
      params: [P('l1', 'L1', 0, 1, 0.8, { small: true }), P('l2', 'L2', 0, 1, 0.8, { small: true }), P('l3', 'L3', 0, 1, 0.8, { small: true }),
        P('l4', 'L4', 0, 1, 0.8, { small: true }), P('master', 'MASTER', 0, 1.5, 1)],
      state: [],
      doc: 'Four-channel DC-coupled mixer: OUT = MASTER · Σ Lᵢ·INᵢ, saturating at the ±12 V rails; INV is the same, inverted.',
      code: (c) => `const m = rail(${c.p('master')} * (${c.p('l1')} * ${c.in('in1')} + ${c.p('l2')} * ${c.in('in2')} + ${c.p('l3')} * ${c.in('in3')} + ${c.p('l4')} * ${c.in('in4')}));
${c.out('out')} = m; ${c.out('inv')} = -m;`,
    },
    noise: {
      kind: 'analog', title: 'Noise', hp: 4, sym: 'NSE', color: '#2b3442',
      ins: [], outs: [Out('white', 'WHITE'), Out('pink', 'PINK')],
      params: [P('amp', 'LEVEL', 0, 5, 2, { unit: 'V', small: true })],
      state: ['rng', 'b0', 'b1', 'b2'],
      doc: 'Noise source: WHITE is Gaussian (LEVEL is its RMS voltage); PINK falls by 3 dB per octave (Paul Kellet\'s three-pole filter). The noise is pseudo-random and seeded per module, so Reset replays it exactly.',
      code: (c) => `let r = ${c.s('rng')} || ${c.seed}; const a = (r = xs(r)), b = (r = xs(r)); ${c.s('rng')} = r;
const w = gauss(a, b) * ${c.p('amp')};
${c.s('b0')} = 0.99765 * ${c.s('b0')} + w * 0.0990460; ${c.s('b1')} = 0.96300 * ${c.s('b1')} + w * 0.2965164; ${c.s('b2')} = 0.57000 * ${c.s('b2')} + w * 1.0526913;
${c.out('white')} = w; ${c.out('pink')} = 0.25 * (${c.s('b0')} + ${c.s('b1')} + ${c.s('b2')} + w * 0.1848);`,
    },
    slew: {
      kind: 'analog', title: 'Glide', hp: 6, sym: 'GLD', color: '#2b3442',
      ins: [In('in', 'IN')], outs: [Out('out', 'OUT')],
      params: [P('rise', 'RISE', 0.0001, 5, 0.05, Object.assign({ unit: 's' }, log)), P('fall', 'FALL', 0.0001, 5, 0.05, Object.assign({ unit: 's' }, log))],
      state: ['y'],
      doc: 'Portamento: an RC lag. OUT follows IN exponentially, with time constant RISE when going up and FALL when going down. On a pitch voltage this is a glide that is even in musical intervals, which is why 1 V/oct makes portamento so easy.',
      code: (c) => `const x = ${c.in('in')}, y = ${c.s('y')}, t = x > y ? ${c.p('rise')} : ${c.p('fall')};
${c.s('y')} = x + (y - x) * Math.exp(-DT / t); ${c.out('out')} = ${c.s('y')};`,
    },
    atten: {
      kind: 'analog', title: 'Attenuverter', hp: 8, sym: 'ATT', color: '#2b3442',
      ins: [In('in1', 'IN 1'), In('in2', 'IN 2')], outs: [Out('out1', 'OUT 1'), Out('out2', 'OUT 2')],
      params: [P('a1', 'ATT 1', -1, 1, 1, { small: true }), P('o1', 'OFS 1', -10, 10, 0, { unit: 'V', small: true }),
        P('a2', 'ATT 2', -1, 1, 1, { small: true }), P('o2', 'OFS 2', -10, 10, 0, { unit: 'V', small: true })],
      state: [],
      doc: 'Two channels of OUT = ATT · IN + OFFSET (scale, invert, shift a voltage), limited by the ±12 V rails. With nothing in IN it is a voltage source.',
      code: (c) => `${c.out('out1')} = rail(${c.p('a1')} * ${c.in('in1')} + ${c.p('o1')}); ${c.out('out2')} = rail(${c.p('a2')} * ${c.in('in2')} + ${c.p('o2')});`,
    },
    seq8: {
      kind: 'analog', title: 'Analog Sequencer', hp: 30, sym: 'SEQ', color: '#33302a',
      ins: [In('clock', 'CLOCK'), In('reset', 'RESET')], outs: [Out('cv', 'CV'), Out('gate', 'GATE')],
      params: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => P('k' + i, String(i + 1), 0, 1, [0, 0.25, 0.5833, 0.4167, 0.5833, 0.25, 0.3333, 0.0833][i], { small: true }))
        .concat([P('len', 'STEPS', 1, 8, 8, { int: true, small: true }), P('range', 'RANGE', 0, 2, 0, { options: ['1 V', '2 V', '5 V'], small: true }),
          P('quant', 'QUANT', 0, 1, 1, { options: ['off', 'semi'], small: true })]),
      state: ['pos', 'clk', 'rst'],
      doc: 'Eight knobs read in turn, one step per rising CLOCK edge (a Schmitt trigger): CV = knob · RANGE, optionally rounded to semitones (1/12 V). GATE passes the clock through while it is high. RESET goes back to step 1. Like the Moog 960, the step logic is a counter; the knobs are just voltages.',
      code: (c) => `const ck = schmitt(${c.s('clk')}, ${c.in('clock')}), rs = schmitt(${c.s('rst')}, ${c.in('reset')});
if (rs && !${c.s('rst')}) ${c.s('pos')} = 0;
else if (ck && !${c.s('clk')}) ${c.s('pos')} = ${c.s('pos')} % Math.max(1, Math.round(${c.p('len')})) + 1;
${c.s('clk')} = ck ? 1 : 0; ${c.s('rst')} = rs ? 1 : 0;
const st = Math.max(0, ${c.s('pos')} - 1), rg = [1, 2, 5][Math.round(${c.p('range')})] || 1;
let cv = p[${c.pIndex('k0')} + st] * rg; if (${c.p('quant')} >= 0.5) cv = Math.round(cv * 12) / 12;
${c.out('cv')} = cv; ${c.out('gate')} = ck ? 10 : 0;`,
    },
    clock: {
      kind: 'analog', title: 'Clock', hp: 10, sym: 'CLK', color: '#33302a',
      ins: [In('reset', 'RESET')], outs: [Out('clk', 'BEAT'), Out('bar', 'BAR'), Out('x2', '×2')],
      params: [P('bpm', 'BPM', 20, 300, 120, { int: true }), P('pw', 'WIDTH', 0.05, 0.95, 0.5, { small: true })],
      state: ['ph', 'rst'],
      doc: 'Tempo source: BEAT is a 10 V gate on every beat, BAR on the first beat of every 4, ×2 at twice the tempo; WIDTH is the fraction of the period the gates stay high.',
      code: (c) => `const rs = schmitt(${c.s('rst')}, ${c.in('reset')}); if (rs && !${c.s('rst')}) ${c.s('ph')} = 0; ${c.s('rst')} = rs ? 1 : 0;
let x = ${c.s('ph')} + ${c.p('bpm')} / 60 * DT; if (x >= 4) x -= 4; ${c.s('ph')} = x;
const f = x - Math.floor(x), w = ${c.p('pw')}, f2 = 2 * x - Math.floor(2 * x);
${c.out('clk')} = f < w ? 10 : 0; ${c.out('bar')} = x < w ? 10 : 0; ${c.out('x2')} = f2 < w ? 10 : 0;`,
    },

    // ---- utilities: exact, within the tick (no latency) -------------------------------
    gain: {
      kind: 'logic', title: 'Gain', hp: 4, sym: '×k', color: '#263a33',
      ins: [In('in', 'IN')], outs: [Out('out', 'OUT')],
      params: [P('k', 'GAIN', -10, 10, 0.2, { small: true })],
      doc: 'Exact multiplication of a voltage by a knob, within the tick (no latency, unlike the Attenuverter, which is a circuit).',
      expr: (a, p) => `${a[0]} * ${p('k')}`,
    },

    // ---- crossings: one domain in, another out, and no more than that takes ----------
    // Small chips; each pin says its domain. Every other map (ranges, offsets, laws,
    // pitch) is built from these and float arithmetic, as library blocks.
    voltmeter: {
      kind: 'logic', chip: true, title: 'Voltmeter', sym: 'V', color: '#2b3442',
      ins: [In('in', 'IN', 0, 'analog')], outs: [Out('out', 'OUT', 'float')], params: [],
      doc: 'Analog to float: the voltage as a number (1 V reads 1.0). Scaling is arithmetic after it, or a library block (Scaled Voltmeter).',
      expr: (a) => a[0],
    },
    awg: {
      kind: 'logic', chip: true, title: 'AWG', sym: 'AWG', color: '#2b3442',
      ins: [In('in', 'IN', 0, 'float')], outs: [Out('out', 'OUT', 'analog')], params: [],
      doc: 'Arbitrary waveform generator, float to analog: the number as a voltage (1.0 is 1 V), held through each tick.',
      expr: (a) => a[0],
    },
    word: {
      kind: 'logic', chip: true, title: 'Word', sym: 'W', color: '#2a2e36',
      ins: [In('in', 'IN', 0, 'float')], outs: [Out('out', 'OUT', 'fixed')],
      params: [P('bits', 'BITS', 1, 32, 8, { int: true, structural: true }), P('signed', 'SIGNED', 0, 1, 1, { options: ['unsigned', 'signed'] }),
        P('mode', 'OUT OF RANGE', 0, 1, 1, { options: ['wrap', 'clip'] }), P('scale', 'TAKES', 0, 1, 0, { options: ['an integer', 'a fraction of full scale'] })],
      doc: 'Float to fixed point: the number rounded to an integer, as a word of BITS bits (two\'s complement for negatives). It takes an integer, or a fraction of full scale (−1 … 1 signed, 0 … 1 unsigned, times 2^(BITS−1) or 2^BITS). Out of range it wraps round, as hardware does, or clips to the largest and smallest words.',
      width: (p) => p('bits'),
      expr: (a, p) => { const x = `(${p('scale')} >= 0.5 ? ${a[0]} * Math.pow(2, ${p('bits')} - (${p('signed')} >= 0.5 ? 1 : 0)) : ${a[0]})`; return `(${p('mode')} >= 0.5 ? toFix(${x}, ${p('bits')}, ${p('signed')}) : wrapFix(${x}, ${p('bits')}))`; },
    },
    value: {
      kind: 'logic', chip: true, title: 'Value', sym: '#', color: '#2a2e36',
      ins: [In('in', 'IN', 0, 'fixed')], outs: [Out('out', 'OUT', 'float')],
      params: [P('signed', 'SIGNED', 0, 1, 1, { options: ['unsigned', 'signed'] }), P('scale', 'READS AS', 0, 1, 0, { options: ['an integer', 'a fraction of full scale'] })],
      doc: 'Fixed point to float: the word as the integer it spells, unsigned or (two\'s complement) signed; or as a fraction of full scale (−1 … 1 signed, 0 … 1 unsigned), whatever the width of the bus. A bus doesn\'t say how to read its top bit or where its point is; this does.',
      expr: (a, p, c) => `(${p('scale')} >= 0.5 ? fromFix(${a[0]}, ${c.w(0)}, ${p('signed')}) / Math.pow(2, ${c.w(0)} - (${p('signed')} >= 0.5 ? 1 : 0)) : fromFix(${a[0]}, ${c.w(0)}, ${p('signed')}))`,
    },
  };
  const BOARD_ORDER = ['vco', 'lfo', 'vcf', 'vca', 'adsr', 'mixer', 'noise', 'slew', 'atten', 'seq8', 'clock', 'gain'];
  const CONVERTER_ORDER = ['voltmeter', 'awg', 'word', 'value'];

  // ---- panel layout (in HP; a 3U panel is 25.3 HP tall) ----------------------------------
  const PANEL_H = 25.3;
  const KNOB = { big: { r: 1.5, w: 4.4, h: 5.3 }, small: { r: 1.05, w: 3.4, h: 4.3 } };
  const JACK = { r: 0.95, w: 3.3, h: 4.1 };
  // Flow layout: knobs, then inputs, then outputs (on a plate), each section in rows.
  function flow(items, hp, y, cell) {
    const out = [];
    let row = [], rowW = 0;
    const flush = () => {
      if (!row.length) return;
      const h = Math.max(...row.map((it) => cell(it).h));
      let x = (hp - rowW) / 2;
      for (const it of row) { const c = cell(it); out.push(Object.assign({}, it, { x: x + c.w / 2, y: y + h / 2, r: c.r })); x += c.w; }
      y += h; row = []; rowW = 0;
    };
    for (const it of items) {
      const c = cell(it);
      if (rowW + c.w > hp - 0.4 && row.length) flush();
      row.push(it); rowW += c.w;
    }
    flush();
    return { items: out, y };
  }
  // Layout for a module: {hp, knobs:[{id,x,y,r}], ins:[{x,y,r}], outs:[...], plate:{y0,y1}, h}
  function panelLayout(spec, hp) {
    hp = hp || spec.hp;
    const knobs = flow(spec.params.map((p, i) => ({ id: p.id, i, small: !!p.small })), hp, 4.0, (it) => (it.small ? KNOB.small : KNOB.big));
    let y = knobs.y + (spec.params.length ? 0.3 : 0);
    const ins = flow(spec.ins.map((p, i) => ({ id: p.id, i })), hp, y, () => JACK);
    y = ins.y + 0.3;
    const plate0 = y;
    const outs = flow(spec.outs.map((p, i) => ({ id: p.id, i })), hp, y + 0.2, () => JACK);
    return { hp, knobs: knobs.items, ins: ins.items, outs: outs.items, plate: spec.outs.length ? { y0: plate0, y1: outs.y + 0.2 } : null, h: outs.y + 0.2 };
  }

  // ---- footprints on the board --------------------------------------------------------
  // A module is its panel, at 2 HP per cell: knobs and jacks where the panel layout
  // puts them. Jacks are pins (their cell is where cables plug in; fx, fy the
  // exact centre for drawing). Converters are small chips, input left, output right.
  const CELL_HP = 2;
  for (const [type, m] of Object.entries(MODULES)) {
    m.type = type;
    m.defaults = () => Object.fromEntries(m.params.map((p) => [p.id, p.def]));
    if (m.chip) {
      m.w = 3; m.h = 3;
      m.pins = { ins: m.ins.map((p) => [0, 1, p.label, p.dom]), outs: m.outs.map((p) => [2, 1, p.label, p.dom]) };
      m.eq = m.title;
      continue;
    }
    const lay = panelLayout(m);
    m.w = Math.ceil(m.hp / CELL_HP); m.h = Math.ceil(PANEL_H / CELL_HP);
    const pin = (p, j) => [Math.floor(j.x / CELL_HP), Math.floor(j.y / CELL_HP), p.label, p.dom, j.x / CELL_HP, j.y / CELL_HP];
    m.pins = { ins: m.ins.map((p, i) => pin(p, lay.ins[i])), outs: m.outs.map((p, i) => pin(p, lay.outs[i])) };
    m.panel = { lay, scale: 1 / CELL_HP };
    m.eq = m.kind === 'analog' ? 'analog: sampled at the clock edge' : m.title;
  }

  const api = { C4, MODULES, BOARD_ORDER, CONVERTER_ORDER, PRELUDE, PANEL_H, CELL_HP, panelLayout, showParam, paramFrac, paramValue };
  Object.assign(G.MODULES, MODULES);
  for (const m of Object.values(MODULES)) {
    G.MODULE_INFO[m.type] = { title: m.title, sym: m.sym, w: m.w, h: m.h, ins: m.pins.ins, outs: m.pins.outs, eq: m.eq, module: m, dom: 'analog' };
    G.DOCS[m.type] = m.doc;
  }
  G.Analog = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
