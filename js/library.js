// Starter library and example patches. Everything here is built from the same
// atoms the user has; nothing is privileged.
(function (root) {
  'use strict';
  const FS = 48000;

  // Tiny builder: blk(type, x, y, extra) returns an id; wire(a, ap, b, bp).
  function build(fn) {
    const P = { blocks: [], wires: [], nextId: 1 };
    const blk = (type, x, y, extra) => {
      const id = 'b' + P.nextId++;
      P.blocks.push(Object.assign({ id, type, x, y }, extra || {}));
      return id;
    };
    const wire = (a, ap, b, bp) => P.wires.push({ from: [a, ap], to: [b, bp] });
    fn(blk, wire);
    return P;
  }
  function def(name, description, fn) { return Object.assign({ name, description }, build(fn)); }
  const knob = (label, min, max, order, scale) => ({ label, kind: 'knob', min, max, order, scale: scale || 'lin' });

  // phase += Hz/fs; if phase > 1 then phase -= 1.
  function phasorBody(blk, wire, hzSource) {
    const k = blk('const', 40, 170, { value: 1 / FS, label: '1/fs' });
    const mul = blk('mul', 170, 90);
    const add = blk('add', 290, 110);
    const c1 = blk('copy', 400, 110);
    const one = blk('const', 400, 20, { value: 1 });
    const gt = blk('gt', 520, 40);
    const c2 = blk('copy', 520, 160);
    const neg = blk('const', 520, 270, { value: -1 });
    const sub = blk('add', 640, 200);
    const cg = blk('copy', 640, 40);
    const sw = blk('switch', 760, 120);
    const c3 = blk('copy', 880, 130);
    const dly = blk('delay', 520, 370, { label: 'phase' });
    wire(hzSource[0], hzSource[1], mul, 0); wire(k, 0, mul, 1);
    wire(mul, 0, add, 0); wire(dly, 0, add, 1);
    wire(add, 0, c1, 0);
    wire(c1, 0, gt, 0); wire(one, 0, gt, 1);
    wire(c1, 1, c2, 0);
    wire(c2, 0, sub, 0); wire(neg, 0, sub, 1);
    wire(gt, 0, cg, 0);
    wire(cg, 0, sw, 0); wire(sub, 0, sw, 1); wire(c2, 1, sw, 2);
    wire(sw, 0, c3, 0);
    wire(c3, 1, dly, 0);
    return { phase: [c3, 0], wrap: [cg, 1] };
  }

  const Phasor = def('Phasor',
    'A ramp from 0 to 1 at the given frequency (Hz). "wrap" is 1 for the single tick on which the ramp wraps around — a clock-enable pulse for slower logic.',
    (blk, wire) => {
      const hz = blk('inlet', 20, 60, { name: 'Hz' });
      const o = phasorBody(blk, wire, [hz, 0]);
      const op = blk('outlet', 1010, 110, { name: 'phase' });
      const ow = blk('outlet', 1010, 200, { name: 'wrap' });
      wire(o.phase[0], o.phase[1], op, 0);
      wire(o.wrap[0], o.wrap[1], ow, 0);
    });

  const VCO = def('VCO',
    'Sawtooth and pulse oscillator built on a Phasor. saw = 2·phase − 1; pulse = phase > width ? 1 : −1.',
    (blk, wire) => {
      const hz = blk('inlet', 20, 60, { name: 'Hz' });
      const ph = blk('comp', 130, 50, { def: 'Phasor' });
      const cp = blk('copy', 300, 50);
      const two = blk('const', 300, 150, { value: 2 });
      const m = blk('mul', 420, 20);
      const m1 = blk('const', 420, 110, { value: -1 });
      const a = blk('add', 540, 30);
      const pw = blk('const', 300, 240, { value: 0.5, panel: knob('width', 0.05, 0.95, 1) });
      const g = blk('gt', 420, 200);
      const p1 = blk('const', 420, 300, { value: 1 });
      const n1 = blk('const', 420, 380, { value: -1 });
      const s = blk('switch', 540, 240);
      const osaw = blk('outlet', 660, 40, { name: 'saw' });
      const opul = blk('outlet', 660, 250, { name: 'pulse' });
      wire(hz, 0, ph, 0); wire(ph, 0, cp, 0);
      wire(cp, 0, m, 0); wire(two, 0, m, 1); wire(m, 0, a, 0); wire(m1, 0, a, 1); wire(a, 0, osaw, 0);
      wire(cp, 1, g, 0); wire(pw, 0, g, 1);
      wire(g, 0, s, 0); wire(p1, 0, s, 1); wire(n1, 0, s, 2); wire(s, 0, opul, 0);
    });

  const SampleHold = def('Sample&Hold',
    'The clock-enable pattern: a Switch in front of a register. The output only changes on ticks where "en" > 0. This is how an FPGA runs logic slower than its clock (decimation).',
    (blk, wire) => {
      const x = blk('inlet', 20, 40, { name: 'x' });
      const en = blk('inlet', 20, 120, { name: 'en' });
      const s = blk('switch', 160, 60);
      const c = blk('copy', 280, 70);
      const d = blk('delay', 160, 200);
      const o = blk('outlet', 400, 70, { name: 'y' });
      wire(en, 0, s, 0); wire(x, 0, s, 1); wire(s, 0, c, 0);
      wire(c, 0, o, 0); wire(c, 1, d, 0); wire(d, 0, s, 2);
    });

  const Counter4 = def('Counter4',
    'Counts 0,1,2,3,0,… advancing only on ticks where "tick" > 0 (a clock enable).',
    (blk, wire) => {
      const tick = blk('inlet', 20, 30, { name: 'tick' });
      const d = blk('delay', 20, 300, { label: 'count' });
      const cd = blk('copy', 140, 300);
      const one = blk('const', 140, 200, { value: 1 });
      const a = blk('add', 260, 200);
      const ca = blk('copy', 370, 200);
      const lim = blk('const', 370, 100, { value: 3.5 });
      const g = blk('gt', 490, 110);
      const zero = blk('const', 490, 210, { value: 0 });
      const w = blk('switch', 610, 150);
      const en = blk('switch', 730, 60);
      const co = blk('copy', 850, 70);
      const o = blk('outlet', 970, 70, { name: 'step' });
      wire(d, 0, cd, 0);
      wire(cd, 0, a, 0); wire(one, 0, a, 1); wire(a, 0, ca, 0);
      wire(ca, 0, g, 0); wire(lim, 0, g, 1);
      wire(g, 0, w, 0); wire(zero, 0, w, 1); wire(ca, 1, w, 2);
      wire(tick, 0, en, 0); wire(w, 0, en, 1); wire(cd, 1, en, 2);
      wire(en, 0, co, 0); wire(co, 0, o, 0); wire(co, 1, d, 0);
    });

  const Seq4 = def('Seq4',
    'Four-step sequencer. Each "tick" advances one step; the output is the knob value of the current step. Step selection is a tree of comparators and switches.',
    (blk, wire) => {
      const tick = blk('inlet', 20, 40, { name: 'tick' });
      const cnt = blk('comp', 120, 30, { def: 'Counter4' });
      const c1 = blk('copy', 280, 30);
      const c2 = blk('copy', 390, 90);
      const c3 = blk('copy', 500, 150);
      const h1 = blk('const', 280, 140, { value: 0.5 });
      const h2 = blk('const', 390, 200, { value: 1.5 });
      const h3 = blk('const', 500, 260, { value: 2.5 });
      const g1 = blk('gt', 620, 60);
      const g2 = blk('gt', 620, 170);
      const g3 = blk('gt', 620, 280);
      const s1 = blk('const', 620, 380, { value: 110, panel: knob('step 1', 30, 1000, 1, 'log') });
      const s2 = blk('const', 620, 500, { value: 220, panel: knob('step 2', 30, 1000, 2, 'log') });
      const s3 = blk('const', 620, 620, { value: 164.8, panel: knob('step 3', 30, 1000, 3, 'log') });
      const s4 = blk('const', 620, 740, { value: 130.8, panel: knob('step 4', 30, 1000, 4, 'log') });
      const w1 = blk('switch', 760, 80);
      const w2 = blk('switch', 880, 180);
      const w3 = blk('switch', 1000, 280);
      const ov = blk('outlet', 1120, 280, { name: 'value' });
      const os = blk('outlet', 1120, 380, { name: 'step' });
      wire(tick, 0, cnt, 0); wire(cnt, 0, c1, 0);
      wire(c1, 0, g1, 0); wire(h1, 0, g1, 1); wire(c1, 1, c2, 0);
      wire(c2, 0, g2, 0); wire(h2, 0, g2, 1); wire(c2, 1, c3, 0);
      wire(c3, 0, g3, 0); wire(h3, 0, g3, 1); wire(c3, 1, os, 0);
      wire(g1, 0, w1, 0); wire(s2, 0, w1, 1); wire(s1, 0, w1, 2);
      wire(g2, 0, w2, 0); wire(s3, 0, w2, 1); wire(w1, 0, w2, 2);
      wire(g3, 0, w3, 0); wire(s4, 0, w3, 1); wire(w2, 0, w3, 2);
      wire(w3, 0, ov, 0);
    });

  const Decay = def('Decay',
    'Percussive envelope. Jumps to 1 when "trig" > 0, otherwise multiplies itself by "decay" every tick (exponential decay).',
    (blk, wire) => {
      const trig = blk('inlet', 20, 40, { name: 'trig' });
      const d = blk('delay', 20, 220);
      const k = blk('const', 140, 280, { value: 0.9997, panel: knob('decay', 0.999, 0.99995, 1) });
      const m = blk('mul', 160, 200);
      const one = blk('const', 160, 100, { value: 1 });
      const s = blk('switch', 300, 60);
      const c = blk('copy', 420, 70);
      const o = blk('outlet', 540, 70, { name: 'env' });
      wire(d, 0, m, 0); wire(k, 0, m, 1);
      wire(trig, 0, s, 0); wire(one, 0, s, 1); wire(m, 0, s, 2);
      wire(s, 0, c, 0); wire(c, 0, o, 0); wire(c, 1, d, 0);
    });

  const OnePole = def('OnePole',
    'The simplest low-pass filter: y[n] = y[n−1] + k·(x[n] − y[n−1]). k between 0 (closed) and 1 (open).',
    (blk, wire) => {
      const x = blk('inlet', 20, 40, { name: 'x' });
      const d = blk('delay', 20, 260);
      const cd = blk('copy', 140, 260);
      const neg = blk('const', 140, 160, { value: -1 });
      const inv = blk('mul', 260, 150);
      const diff = blk('add', 380, 50);
      const k = blk('const', 380, 160, { value: 0.05, panel: knob('k', 0.001, 1, 1, 'log') });
      const m = blk('mul', 500, 70);
      const y = blk('add', 620, 120);
      const c = blk('copy', 740, 120);
      const o = blk('outlet', 860, 120, { name: 'y' });
      wire(d, 0, cd, 0); wire(cd, 0, inv, 0); wire(neg, 0, inv, 1);
      wire(x, 0, diff, 0); wire(inv, 0, diff, 1);
      wire(diff, 0, m, 0); wire(k, 0, m, 1);
      wire(m, 0, y, 0); wire(cd, 1, y, 1);
      wire(y, 0, c, 0); wire(c, 0, o, 0); wire(c, 1, d, 0);
    });

  const SVF = def('SVF',
    'Chamberlin state-variable filter (resonant). lp += f·bp;  hp = x − lp − q·bp;  bp += f·hp. f ≈ 2π·fc/fs is set by the "cutoff" knob plus the "fmod" input; small q = strong resonance.',
    (blk, wire) => {
      const x = blk('inlet', 20, -40, { name: 'x' });
      const fm = blk('inlet', 20, 40, { name: 'fmod' });
      const fk = blk('const', 20, 120, { value: 0.08, panel: knob('cutoff', 0.005, 0.9, 1, 'log') });
      const fa = blk('add', 140, 60);
      const cf = blk('copy', 250, 60);
      const rbp = blk('delay', 20, 470, { label: 'bp' });
      const rlp = blk('delay', 20, 380, { label: 'lp' });
      const cb1 = blk('copy', 140, 470);
      const cb2 = blk('copy', 250, 490);
      const flp = blk('mul', 370, 160);           // f·bp[n−1]
      const lpn = blk('add', 490, 220);           // lp[n] = lp[n−1] + f·bp[n−1]
      const cl1 = blk('copy', 600, 220);
      const cl2 = blk('copy', 710, 300);
      const q = blk('const', 370, 560, { value: 0.3, panel: knob('damp', 0.05, 2, 2, 'log') });
      const qb = blk('mul', 490, 500);            // q·bp[n−1]
      const s1 = blk('add', 820, 420);            // lp + q·bp
      const neg = blk('const', 820, 520, { value: -1 });
      const ns = blk('mul', 940, 440);
      const hp = blk('add', 1060, 300);           // hp = x − (lp + q·bp)
      const ch = blk('copy', 1170, 300);
      const fhp = blk('mul', 1280, 200);          // f·hp
      const bpn = blk('add', 1400, 300);          // bp[n] = bp[n−1] + f·hp
      const cbo = blk('copy', 1510, 300);
      const olp = blk('outlet', 1640, 200, { name: 'lp' });
      const obp = blk('outlet', 1640, 300, { name: 'bp' });
      const ohp = blk('outlet', 1640, 400, { name: 'hp' });
      wire(fm, 0, fa, 0); wire(fk, 0, fa, 1); wire(fa, 0, cf, 0);
      wire(rbp, 0, cb1, 0); wire(cb1, 1, cb2, 0);
      wire(cf, 0, flp, 0); wire(cb1, 0, flp, 1);
      wire(rlp, 0, lpn, 0); wire(flp, 0, lpn, 1);
      wire(lpn, 0, cl1, 0); wire(cl1, 0, olp, 0); wire(cl1, 1, cl2, 0);
      wire(cl2, 1, rlp, 0);
      wire(cb2, 0, qb, 0); wire(q, 0, qb, 1);
      wire(cl2, 0, s1, 0); wire(qb, 0, s1, 1);
      wire(s1, 0, ns, 0); wire(neg, 0, ns, 1);
      wire(x, 0, hp, 0); wire(ns, 0, hp, 1);
      wire(hp, 0, ch, 0); wire(ch, 1, ohp, 0);
      wire(cf, 1, fhp, 0); wire(ch, 0, fhp, 1);
      wire(cb2, 1, bpn, 0); wire(fhp, 0, bpn, 1);
      wire(bpn, 0, cbo, 0); wire(cbo, 0, obp, 0); wire(cbo, 1, rbp, 0);
    });

  function starterDefs() {
    const defs = {};
    for (const d of [Phasor, VCO, SampleHold, Counter4, Seq4, Decay, OnePole, SVF]) defs[d.name] = JSON.parse(JSON.stringify(d));
    return defs;
  }

  // ---- Examples -------------------------------------------------------------

  const exCounter = {
    title: '1 · Counter (slow clock)',
    mode: 'slow',
    note: 'A register fed back through an adder counts ticks. Use the slow clock and Step to watch it.',
    root: build((blk, wire) => {
      const one = blk('const', 60, 80, { value: 1 });
      const add = blk('add', 200, 100);
      const c = blk('copy', 320, 100);
      const d = blk('delay', 200, 220, { label: 'count' });
      const s = blk('scope', 440, 60, { window: 64 });
      wire(one, 0, add, 0); wire(d, 0, add, 1); wire(add, 0, c, 0);
      wire(c, 0, s, 0); wire(c, 1, d, 0);
    }),
  };

  const exPhasor = {
    title: '2 · A tone from scratch',
    mode: 'audio',
    note: 'The Phasor circuit drawn out with atoms, turned into a sawtooth and sent to the speaker.',
    root: build((blk, wire) => {
      const hz = blk('const', 40, 60, { value: 220, panel: knob('Hz', 30, 2000, 1, 'log') });
      const o = phasorBody(blk, wire, [hz, 0]);
      const half = blk('const', 1000, 240, { value: -0.5 });
      const center = blk('add', 1000, 130);
      const vol = blk('const', 1120, 240, { value: 0.2, panel: knob('volume', 0, 0.5, 2) });
      const m = blk('mul', 1120, 140);
      const c = blk('copy', 1240, 150);
      const dac = blk('dac', 1360, 120);
      const sc = blk('scope', 1360, 220, { window: 1024 });
      wire(o.phase[0], o.phase[1], center, 0); wire(half, 0, center, 1);
      wire(center, 0, m, 0); wire(vol, 0, m, 1);
      wire(m, 0, c, 0); wire(c, 0, dac, 0); wire(c, 1, sc, 0);
    }),
  };

  const exSynth = {
    title: '3 · Sequenced synth',
    mode: 'audio',
    note: 'Tempo phasor → sequencer → VCO → resonant filter → envelope VCA → speaker. Open any module (double-click) to see its insides.',
    root: build((blk, wire) => {
      const tempo = blk('const', 20, 40, { value: 6, panel: knob('tempo Hz', 1, 20, 1, 'log') });
      const clk = blk('comp', 150, 40, { def: 'Phasor' });
      const cw = blk('copy', 310, 90);
      const seq = blk('comp', 420, 20, { def: 'Seq4' });
      const env = blk('comp', 420, 330, { def: 'Decay' });
      const vco = blk('comp', 650, 20, { def: 'VCO' });
      const ce = blk('copy', 620, 360);
      const depth = blk('const', 720, 470, { value: 0.25, panel: knob('env→cutoff', 0, 0.8, 2) });
      const md = blk('mul', 840, 400);
      const svf = blk('comp', 960, 20, { def: 'SVF' });
      const vca = blk('mul', 1200, 60);
      const vol = blk('const', 1200, 170, { value: 0.3, panel: knob('volume', 0, 1, 3) });
      const mv = blk('mul', 1320, 80);
      const co = blk('copy', 1430, 80);
      const dac = blk('dac', 1540, 40);
      const sc = blk('scope', 1540, 140, { window: 2048 });
      wire(tempo, 0, clk, 0); wire(clk, 1, cw, 0);
      wire(cw, 0, seq, 0); wire(cw, 1, env, 0);
      wire(seq, 0, vco, 0);
      wire(env, 0, ce, 0); wire(ce, 1, md, 0); wire(depth, 0, md, 1);
      wire(vco, 0, svf, 0); wire(md, 0, svf, 1);
      wire(svf, 0, vca, 0); wire(ce, 0, vca, 1);
      wire(vca, 0, mv, 0); wire(vol, 0, mv, 1);
      wire(mv, 0, co, 0); wire(co, 0, dac, 0); wire(co, 1, sc, 0);
    }),
  };

  const EXAMPLES = [exCounter, exPhasor, exSynth];

  function exampleProject(ex, existingDefs) {
    return {
      version: 1,
      root: JSON.parse(JSON.stringify(ex.root)),
      defs: Object.assign(starterDefs(), existingDefs || {}),
    };
  }

  const api = { starterDefs, EXAMPLES, exampleProject, buildPatch: build };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CW = Object.assign(root.CW || {}, api);
})(typeof self !== 'undefined' ? self : this);
