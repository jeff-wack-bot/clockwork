// Runtime: executes the compiled program either in the audio thread at 48 kHz
// or on the main thread at a slow, human-watchable clock rate.
(function (root) {
  'use strict';

  // The AudioWorklet source is kept as a string so it can be loaded from a
  // Blob URL, which lets index.html run straight from the file system.
  const WORKLET_SRC = `
class ClockworkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fn = null; this.p = new Float64Array(0); this.r = new Float64Array(0); this.v = new Float64Array(0);
    this.regNames = []; this.running = false; this.ticks = 0;
    this.RING = 1 << 17; this.rings = []; this.sc = []; this.idx = 0; this.wins = [];
    this.d = new Float32Array(128); this.sinceSnap = 0; this.bad = false;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  migrate(names, values) {
    const old = new Map(names.map((n, i) => [n, values[i]]));
    const r = new Float64Array(this.regNames.length);
    this.regNames.forEach((n, i) => { if (old.has(n)) r[i] = old.get(n); });
    this.r = r;
  }
  onMsg(m) {
    if (m.type === 'program') {
      let fn;
      try { fn = new Function(m.code)(); } catch (err) { this.port.postMessage({ type: 'error', message: String(err) }); return; }
      const oldNames = this.regNames, oldR = this.r;
      this.fn = fn; this.regNames = m.regNames; this.migrate(oldNames, oldR);
      this.p = m.params; this.v = new Float64Array(m.nNets);
      this.rings = m.wins.map(() => new Float32Array(this.RING));
      this.sc = m.wins.map(() => new Float32Array(128));
      this.wins = m.wins;
    } else if (m.type === 'params') { this.p = m.params; }
    else if (m.type === 'wins') { this.wins = m.wins; }
    else if (m.type === 'run') {
      if (m.state) { this.migrate(m.state.names, m.state.values); this.ticks = m.state.ticks; }
      this.running = true;
    } else if (m.type === 'pause') {
      this.running = false;
      this.port.postMessage({ type: 'state', state: { names: this.regNames, values: this.r.slice(), ticks: this.ticks } });
    } else if (m.type === 'reset') { this.r.fill(0); this.ticks = 0; this.bad = false; }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const N = out[0].length;
    if (!this.fn || !this.running) { for (const ch of out) ch.fill(0); return true; }
    if (this.d.length !== N) { this.d = new Float32Array(N); this.sc = this.sc.map(() => new Float32Array(N)); }
    this.fn(N, this.p, this.r, this.d, this.sc, this.v);
    this.ticks += N;
    for (let i = 0; i < N; i++) if (!Number.isFinite(this.d[i])) { this.d.fill(0); this.bad = true; break; }
    for (const ch of out) ch.set(this.d);
    const mask = this.RING - 1;
    for (let k = 0; k < this.sc.length; k++) {
      const ring = this.rings[k], src = this.sc[k];
      for (let i = 0; i < N; i++) ring[(this.idx + i) & mask] = src[i];
    }
    this.idx = (this.idx + N) & mask;
    this.sinceSnap += N;
    if (this.sinceSnap >= 2048) { this.sinceSnap = 0; this.snapshot(); }
    return true;
  }
  snapshot() {
    const mask = this.RING - 1;
    const scopes = this.rings.map((ring, k) => {
      const len = Math.min(2 * (this.wins[k] || 1024), this.RING);
      const stride = Math.max(1, Math.floor(len / 1024));
      const n = Math.floor(len / stride);
      const data = new Float32Array(n);
      const start = this.idx - n * stride;
      for (let j = 0; j < n; j++) data[j] = ring[(start + j * stride) & mask];
      return { data, stride };
    });
    this.port.postMessage({ type: 'snap', v: this.v.slice(), ticks: this.ticks, scopes, bad: this.bad });
  }
}
registerProcessor('clockwork', ClockworkProcessor);
`;

  const SLOW_HISTORY = 64;

  class Host {
    constructor(onSnap, onStatus) {
      this.onSnap = onSnap;
      this.onStatus = onStatus || (() => {});
      this.prog = null;       // last compiled program loaded
      this.fn = null;         // main-thread instance of it
      this.mode = 'audio';    // 'audio' | 'slow'
      this.owner = 'main';    // which thread currently holds the register state
      this.r = new Float64Array(0);
      this.ticks = 0;
      this.slowRate = 4;      // Hz
      this.slowRunning = true;
      this.slowAcc = 0;
      this.history = [];      // per scope: recent samples in slow mode
      this.wins = [];
      this.ctx = null; this.node = null;
      this.audioOn = false;
      this.lastFrame = 0;
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    // Accept a new compile result. Constant-only changes keep everything running.
    load(prog, wins) {
      this.wins = wins;
      if (this.prog && this.prog.code === prog.code) {
        this.prog = prog;
        if (this.node) this.node.port.postMessage({ type: 'params', params: prog.params });
        this.setWins(wins);
        return;
      }
      const oldNames = this.prog ? this.prog.regNames : [];
      const oldR = this.r;
      this.prog = prog;
      this.fn = CW.instantiate(prog.code);
      const map = new Map(oldNames.map((n, i) => [n, oldR[i]]));
      this.r = Float64Array.from(prog.regNames, (n) => map.get(n) || 0);
      this.v = new Float64Array(prog.nNets);
      this.history = prog.scopePaths.map(() => new Array(SLOW_HISTORY).fill(0));
      if (this.node) {
        this.node.port.postMessage({ type: 'program', code: prog.code, regNames: prog.regNames, nNets: prog.nNets, params: prog.params, wins });
      }
    }

    setWins(wins) {
      this.wins = wins;
      if (this.node) this.node.port.postMessage({ type: 'wins', wins });
    }

    async startAudio() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: CW.FS, latencyHint: 'interactive' });
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(this.ctx, 'clockwork', { numberOfInputs: 0, outputChannelCount: [2] });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => this.onWorklet(e.data);
        if (this.prog) {
          const p = this.prog;
          this.node.port.postMessage({ type: 'program', code: p.code, regNames: p.regNames, nNets: p.nNets, params: p.params, wins: this.wins });
        }
      }
      await this.ctx.resume();
      this.audioOn = true;
      if (this.mode === 'audio') this.handToWorklet();
      this.onStatus();
    }

    async stopAudio() {
      if (this.mode === 'audio') await this.takeFromWorklet();
      if (this.ctx) await this.ctx.suspend();
      this.audioOn = false;
      this.onStatus();
    }

    handToWorklet() {
      if (this.owner === 'worklet' || !this.node) return;
      this.node.port.postMessage({ type: 'run', state: { names: this.prog ? this.prog.regNames : [], values: this.r, ticks: this.ticks } });
      this.owner = 'worklet';
    }

    takeFromWorklet() {
      if (this.owner !== 'worklet') return Promise.resolve();
      return new Promise((resolve) => {
        this.pendingState = (state) => {
          const map = new Map(state.names.map((n, i) => [n, state.values[i]]));
          this.r = Float64Array.from(this.prog.regNames, (n) => map.get(n) || 0);
          this.ticks = state.ticks;
          this.owner = 'main';
          resolve();
        };
        this.node.port.postMessage({ type: 'pause' });
      });
    }

    onWorklet(m) {
      if (m.type === 'snap' && this.owner === 'worklet') {
        this.ticks = m.ticks;
        this.onSnap({ v: m.v, ticks: m.ticks, scopes: m.scopes, mode: 'audio', bad: m.bad });
      } else if (m.type === 'state' && this.pendingState) {
        const f = this.pendingState; this.pendingState = null; f(m.state);
      } else if (m.type === 'error') {
        this.onStatus('Audio thread error: ' + m.message);
      }
    }

    async setMode(mode) {
      if (mode === this.mode) return;
      this.mode = mode;
      if (mode === 'slow') await this.takeFromWorklet();
      else if (this.audioOn) this.handToWorklet();
      this.onStatus();
    }

    reset() {
      this.r.fill(0);
      this.ticks = 0;
      this.history = this.history.map((h) => h.fill(0));
      if (this.node) this.node.port.postMessage({ type: 'reset' });
      if (this.owner === 'main') this.runTicks(0);
    }

    // Main-thread execution, one tick at a time so every value can be seen.
    runTicks(n) {
      if (!this.fn) return;
      const sc = this.history.map(() => new Float64Array(1));
      const d = new Float32Array(1);
      for (let k = 0; k < n; k++) {
        this.fn(1, this.prog.params, this.r, d, sc, this.v);
        this.ticks++;
        for (let s = 0; s < sc.length; s++) { this.history[s].shift(); this.history[s].push(sc[s][0]); }
      }
      this.onSnap({
        v: this.v, ticks: this.ticks, mode: 'slow',
        scopes: this.history.map((h) => ({ data: h, stride: 1 })),
      });
    }

    step() { if (this.owner === 'main') this.runTicks(1); }

    loop(t) {
      const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
      this.lastFrame = t;
      if (this.mode === 'slow' && this.slowRunning && this.owner === 'main' && this.fn) {
        this.slowAcc += dt * this.slowRate;
        const n = Math.floor(this.slowAcc);
        if (n > 0) { this.slowAcc -= n; this.runTicks(n); }
      }
      requestAnimationFrame(this.loop);
    }
  }

  root.CW = Object.assign(root.CW || {}, { Host, WORKLET_SRC });
})(typeof self !== 'undefined' ? self : this);
