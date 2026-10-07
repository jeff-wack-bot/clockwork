// Runtime for the grid prototype: one clock whose rate is a slider, from a
// crawl up to real time (one tick per audio sample). The model runs in the
// audio thread while the DAC is on, and on the main thread while it is off.
(function (root) {
  'use strict';

  // Shared by both threads: per-scope ring buffers of the most recent ticks.
  const RINGS_SRC = `
class Rings {
  constructor(n) { this.size = 1 << 16; this.bufs = Array.from({ length: n }, () => new Float32Array(this.size)); this.idx = 0; }
  push(src, N) {
    const m = this.size - 1;
    for (let k = 0; k < this.bufs.length; k++) { const b = this.bufs[k], s = src[k]; for (let i = 0; i < N; i++) b[(this.idx + i) & m] = s[i]; }
    this.idx = (this.idx + N) & m;
  }
  view(k, len) { // the last len ticks, decimated to at most 1024 points
    len = Math.min(len, this.size);
    const stride = Math.max(1, Math.floor(len / 1024)), n = Math.floor(len / stride), out = new Float32Array(n), m = this.size - 1;
    const start = this.idx - n * stride;
    for (let j = 0; j < n; j++) out[j] = this.bufs[k][(start + j * stride) & m];
    return out;
  }
  clear() { for (const b of this.bufs) b.fill(0); }
}`;

  const WORKLET_SRC = RINGS_SRC + `
class GridProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fn = null; this.p = new Float64Array(0); this.s = new Float64Array(0); this.v = new Float64Array(0);
    this.names = []; this.rings = new Rings(0); this.wins = []; this.sc = []; this.sc1 = [];
    this.rate = 48000; this.running = true; this.owner = false; this.acc = 0; this.ticks = 0; this.hold = 0;
    this.buf = new Float32Array(128); this.one = new Float32Array(1); this.steps = 0; this.since = 0; this.dirty = false; this.bad = false;
    this.port.onmessage = (e) => this.msg(e.data);
  }
  adopt(names, values) {
    const old = new Map(names.map((n, i) => [n, values[i]]));
    this.s = Float64Array.from(this.names, (n) => old.get(n) || 0);
  }
  msg(m) {
    if (m.type === 'program') {
      let fn;
      try { fn = new Function(m.code)(); } catch (err) { this.port.postMessage({ type: 'error', message: String(err) }); return; }
      const oldNames = this.names, oldS = this.s;
      this.fn = fn; this.names = m.regNames; this.adopt(oldNames, oldS);
      this.p = m.params; this.v = new Float64Array(m.nNets);
      this.wins = m.wins; this.rings = new Rings(m.wins.length);
      this.sc = m.wins.map(() => new Float32Array(128)); this.sc1 = m.wins.map(() => new Float32Array(1));
    } else if (m.type === 'params') this.p = m.params;
    else if (m.type === 'wins') this.wins = m.wins;
    else if (m.type === 'rate') this.rate = m.rate;
    else if (m.type === 'running') this.running = m.on;
    else if (m.type === 'step') this.steps++;
    else if (m.type === 'take') { this.adopt(m.state.names, m.state.values); this.ticks = m.state.ticks; this.owner = true; this.dirty = true; }
    else if (m.type === 'release') {
      this.owner = false;
      this.port.postMessage({ type: 'state', state: { names: this.names, values: this.s.slice(), ticks: this.ticks } });
    } else if (m.type === 'reset') { this.s.fill(0); this.ticks = 0; this.hold = 0; this.acc = 0; this.bad = false; this.rings.clear(); this.dirty = true; }
  }
  tick() {
    this.fn(1, this.p, this.s, this.one, this.sc1, this.v);
    this.rings.push(this.sc1, 1);
    this.hold = this.one[0]; this.ticks++; this.dirty = true;
  }
  process(inputs, outputs) {
    const out = outputs[0], ch = out[0], N = ch.length;
    if (!this.fn || !this.owner) { for (const c of out) c.fill(0); return true; }
    while (this.steps > 0) { this.steps--; this.tick(); }
    if (this.running && this.rate >= 48000) {
      // real time: exactly one tick per output sample
      if (this.buf.length !== N) { this.buf = new Float32Array(N); this.sc = this.sc.map(() => new Float32Array(N)); }
      this.fn(N, this.p, this.s, this.buf, this.sc, this.v);
      this.rings.push(this.sc, N);
      this.ticks += N; this.hold = this.buf[N - 1]; this.dirty = true;
      ch.set(this.buf);
    } else {
      // slower: tick when the accumulator overflows; the DAC holds its register in between
      const inc = this.running ? this.rate / 48000 : 0;
      for (let i = 0; i < N; i++) {
        this.acc += inc;
        if (this.acc >= 1) { this.acc -= 1; this.tick(); }
        ch[i] = this.hold;
      }
    }
    for (let i = 0; i < N; i++) if (!Number.isFinite(ch[i])) { ch.fill(0); this.bad = true; break; }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    this.since += N;
    if (this.dirty && (this.since >= 1600 || this.rate <= 120)) {
      this.since = 0; this.dirty = false;
      const scopes = this.wins.map((w, k) => this.rings.view(k, this.rate >= 2000 ? 2 * w : w));
      this.port.postMessage({ type: 'snap', v: this.v.slice(), ticks: this.ticks, scopes, bad: this.bad });
    }
    return true;
  }
}
registerProcessor('clockwork-grid', GridProcessor);
`;

  const Rings = new Function(RINGS_SRC + '\nreturn Rings;')();

  class Host {
    constructor(onSnap, onStatus) {
      this.onSnap = onSnap; this.onStatus = onStatus || (() => {});
      this.prog = null; this.fn = null; this.s = new Float64Array(0); this.v = new Float64Array(0);
      this.rings = new Rings(0); this.wins = [];
      this.rate = 48000; this.running = true; this.ticks = 0; this.due = 0;
      this.owner = 'main'; this.audioOn = false; this.ctx = null; this.node = null;
      this.last = 0;
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    post(m) { if (this.node) this.node.port.postMessage(m); }

    load(prog, wins) {
      if (this.prog && this.prog.code === prog.code) {
        this.prog = prog; this.post({ type: 'params', params: prog.params });
        if (wins.join() !== this.wins.join()) { this.wins = wins; this.post({ type: 'wins', wins }); }
        if (this.owner === 'main') this.publish();
        return;
      }
      const oldNames = this.prog ? this.prog.regNames : [], oldS = this.s;
      const map = new Map(oldNames.map((n, i) => [n, oldS[i]]));
      this.prog = prog; this.wins = wins;
      this.fn = GW.instantiate(prog.code);
      this.s = Float64Array.from(prog.regNames, (n) => map.get(n) || 0);
      this.v = new Float64Array(prog.nNets);
      this.rings = new Rings(wins.length);
      this.post({ type: 'program', code: prog.code, regNames: prog.regNames, nNets: prog.nNets, params: prog.params, wins });
      if (this.owner === 'main') this.publish();
    }

    setRate(r) { this.rate = r; this.post({ type: 'rate', rate: r }); }
    setRunning(on) { this.running = on; this.post({ type: 'running', on }); }
    step() { if (this.owner === 'worklet') this.post({ type: 'step' }); else { this.runMain(1); } }
    reset() {
      this.s.fill(0); this.v.fill(0); this.ticks = 0; this.rings = new Rings(this.wins.length);
      this.post({ type: 'reset' });
      if (this.owner === 'main') this.publish();
    }

    async startAudio() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: GW.FS, latencyHint: 'interactive' });
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(this.ctx, 'clockwork-grid', { numberOfInputs: 0, outputChannelCount: [2] });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => this.fromWorklet(e.data);
        const p = this.prog;
        if (p) this.post({ type: 'program', code: p.code, regNames: p.regNames, nNets: p.nNets, params: p.params, wins: this.wins });
        this.post({ type: 'rate', rate: this.rate }); this.post({ type: 'running', on: this.running });
      }
      this.post({ type: 'take', state: { names: this.prog ? this.prog.regNames : [], values: this.s, ticks: this.ticks } });
      this.owner = 'worklet';
      this.audioOn = true;
      this.onStatus();
      await this.ctx.resume();
    }

    async stopAudio() {
      if (this.owner === 'worklet') {
        await new Promise((resolve) => {
          this.pending = (st) => {
            const map = new Map(st.names.map((n, i) => [n, st.values[i]]));
            this.s = Float64Array.from(this.prog.regNames, (n) => map.get(n) || 0);
            this.ticks = st.ticks; resolve();
          };
          this.post({ type: 'release' });
        });
        this.owner = 'main';
      }
      this.audioOn = false;
      if (this.ctx) await this.ctx.suspend();
      this.onStatus();
    }

    fromWorklet(m) {
      if (m.type === 'snap' && this.owner === 'worklet') {
        this.ticks = m.ticks;
        this.onSnap({ v: m.v, ticks: m.ticks, scopes: m.scopes, bad: m.bad });
      } else if (m.type === 'state' && this.pending) { const f = this.pending; this.pending = null; f(m.state); }
      else if (m.type === 'error') this.onStatus('Audio thread: ' + m.message);
    }

    // Main-thread clock (DAC off): same program, same rate, no sound.
    runMain(n) {
      if (!this.fn || n <= 0) return;
      const sc = this.wins.map(() => new Float32Array(n));
      this.fn(n, this.prog.params, this.s, new Float32Array(n), sc, this.v);
      this.rings.push(sc, n);
      this.ticks += n;
      this.publish();
    }
    publish() {
      this.onSnap({ v: this.v, ticks: this.ticks,
        scopes: this.wins.map((w, k) => this.rings.view(k, this.rate >= 2000 ? 2 * w : w)) });
    }
    frame(t) {
      const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
      this.last = t;
      if (this.owner === 'main' && this.running && this.fn) {
        this.due += dt * this.rate;
        const n = Math.floor(this.due);
        if (n > 0) { this.due -= n; this.runMain(Math.min(n, GW.FS / 10)); }
      }
      requestAnimationFrame(this.frame);
    }
  }

  root.GW = Object.assign(root.GW || {}, { Host, WORKLET_SRC });
})(typeof self !== 'undefined' ? self : this);
