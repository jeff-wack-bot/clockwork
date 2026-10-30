// Runtime: one clock whose rate is a slider, from a crawl up to real time (one
// tick per audio sample). The model runs in the audio thread while sound is on,
// and on the main thread while it is off.
//
// The program's Out sockets are its audio outputs and its In sockets its inputs.
// In the browser the first two Outs are the left and right speakers (a single Out
// plays on both) and the Ins read the microphone's channels. Every Out is also
// handed to `onAudio` in blocks, for the PipeWire bridge (bridge.js), which can
// feed the Ins as well.
(function (root) {
  'use strict';

  const WORKLET_SRC = `
class GridProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fn = null; this.p = new Float64Array(0); this.s = new Float64Array(0); this.v = new Float64Array(0);
    this.names = [];
    this.nOut = 0; this.nIn = 0; this.o = []; this.o1 = []; this.hold = []; this.ext = null; this.tap = false;
    this.rate = 48000; this.running = true; this.owner = false; this.acc = 0; this.ticks = 0;
    this.steps = 0; this.since = 0; this.dirty = false; this.bad = false;
    this.port.onmessage = (e) => this.msg(e.data);
  }
  adopt(names, values) {
    const old = new Map(names.map((n, i) => [n, values[i]]));
    this.s = Float64Array.from(this.names, (n) => old.get(n) || 0);
  }
  shape(nOut, nIn) {
    this.nOut = nOut; this.nIn = nIn;
    this.o = Array.from({ length: nOut }, () => new Float32Array(128)); this.o1 = Array.from({ length: nOut }, () => new Float32Array(1));
    this.hold = new Float64Array(nOut);
  }
  msg(m) {
    if (m.type === 'program') {
      let fn;
      try { fn = new Function(m.code)(); } catch (err) { this.port.postMessage({ type: 'error', message: String(err) }); return; }
      const oldNames = this.names, oldS = this.s;
      this.fn = fn; this.names = m.regNames; this.adopt(oldNames, oldS);
      this.p = m.params; this.v = new Float64Array(m.nSnap);
      this.shape(m.nOut, m.nIn);
    } else if (m.type === 'params') this.p = m.params;
    else if (m.type === 'rate') this.rate = m.rate;
    else if (m.type === 'running') this.running = m.on;
    else if (m.type === 'tap') this.tap = m.on;
    else if (m.type === 'ext') {   // input from the bridge, a block per In: queued, read out as it is needed
      if (!m.ins) { this.ext = null; return; }
      if (!this.ext) this.ext = [];
      m.ins.forEach((b, k) => {
        const r = this.ext[k] || (this.ext[k] = { buf: new Float32Array(1 << 15), r: 0, n: 0 });
        const size = r.buf.length;
        for (let i = 0; i < b.length; i++) r.buf[(r.r + r.n + i) % size] = b[i];
        r.n = Math.min(size, r.n + b.length);
        if (r.n > 9600) { r.r = (r.r + r.n - 4096) % size; r.n = 4096; }   // more than 200 ms behind: catch up
      });
    }
    else if (m.type === 'step') this.steps++;
    else if (m.type === 'take') { this.adopt(m.state.names, m.state.values); this.ticks = m.state.ticks; this.owner = true; this.dirty = true; }
    else if (m.type === 'release') {
      this.owner = false;
      this.port.postMessage({ type: 'state', state: { names: this.names, values: this.s.slice(), ticks: this.ticks } });
    } else if (m.type === 'reset') { this.s.fill(0); this.ticks = 0; this.hold.fill(0); this.acc = 0; this.bad = false; this.dirty = true; }
  }
  // the inputs for this block: the bridge's if it sends them, else the microphone's channels
  inputs(inp, N) {
    const out = [];
    for (let k = 0; k < this.nIn; k++) {
      const r = this.ext && this.ext[k];
      if (r) {
        const b = (this.extOut = this.extOut || [])[k] && this.extOut[k].length === N ? this.extOut[k] : (this.extOut[k] = new Float32Array(N));
        const take = Math.min(N, r.n);
        for (let i = 0; i < take; i++) b[i] = r.buf[(r.r + i) % r.buf.length];
        b.fill(0, take);
        r.r = (r.r + take) % r.buf.length; r.n -= take;
        out.push(b);
      } else out.push((inp && inp[k]) || null);
    }
    return out;
  }
  tick(I, i) {
    const one = I.map((c) => (c ? c.subarray(i, i + 1) : null));
    this.fn(1, this.p, this.s, this.o1, one, this.v);
    for (let k = 0; k < this.nOut; k++) this.hold[k] = this.o1[k][0];
    this.ticks++; this.dirty = true;
  }
  process(inputs, outputs) {
    const out = outputs[0], N = out[0].length;
    if (!this.fn || !this.owner) { for (const c of out) c.fill(0); return true; }
    const I = this.inputs(inputs[0], N);
    while (this.steps > 0) { this.steps--; this.tick(I, 0); }
    if (this.o.length && this.o[0].length !== N) this.o = this.o.map(() => new Float32Array(N));
    if (this.running && this.rate >= 48000) {
      // real time: exactly one tick per output sample
      this.fn(N, this.p, this.s, this.o, I, this.v);
      this.ticks += N; this.dirty = true;
      for (let k = 0; k < this.nOut; k++) this.hold[k] = this.o[k][N - 1];
    } else {
      // slower: tick when the accumulator overflows; the outputs hold in between
      const inc = this.running ? this.rate / 48000 : 0;
      for (let i = 0; i < N; i++) {
        this.acc += inc;
        if (this.acc >= 1) { this.acc -= 1; this.tick(I, i); }
        for (let k = 0; k < this.nOut; k++) this.o[k][i] = this.hold[k];
      }
    }
    for (const b of this.o) for (let i = 0; i < N; i++) if (!Number.isFinite(b[i])) { b.fill(0); this.bad = true; break; }
    // the speakers: Out 1 left, Out 2 right; one Out on both
    const L = this.o[0], R = this.o[1] || this.o[0];
    if (L) { out[0].set(L); if (out[1]) out[1].set(R); } else for (const c of out) c.fill(0);
    if (this.tap && this.nOut) this.port.postMessage({ type: 'audio', o: this.o.map((b) => b.slice()) });
    this.since += N;
    if (this.dirty && (this.since >= 1600 || this.rate <= 120)) {
      this.since = 0; this.dirty = false;
      this.port.postMessage({ type: 'snap', v: this.v.slice(), ticks: this.ticks, bad: this.bad });
    }
    return true;
  }
}
registerProcessor('clockwork-grid', GridProcessor);
`;

  class Host {
    constructor(onSnap, onStatus) {
      this.onSnap = onSnap; this.onStatus = onStatus || (() => {});
      this.onAudio = null;   // (outs: Float32Array[]) => void, for the bridge
      this.prog = null; this.fn = null; this.s = new Float64Array(0); this.v = new Float64Array(0);
      this.rate = 48000; this.running = true; this.ticks = 0; this.due = 0;
      this.owner = 'main'; this.audioOn = false; this.ctx = null; this.node = null; this.mic = null;
      this.last = 0;
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    post(m) { if (this.node) this.node.port.postMessage(m); }

    programMsg(p) { return { type: 'program', code: p.code, regNames: p.regNames, nSnap: p.nSnap, params: p.params, nOut: p.outs.length, nIn: p.ins.length }; }

    load(prog) {
      if (this.prog && this.prog.code === prog.code) {
        this.prog = prog; this.post({ type: 'params', params: prog.params });
        if (this.owner === 'main') this.publish();
        return;
      }
      const oldNames = this.prog ? this.prog.regNames : [], oldS = this.s;
      const map = new Map(oldNames.map((n, i) => [n, oldS[i]]));
      this.prog = prog;
      this.fn = GW.instantiate(prog.code);
      this.s = Float64Array.from(prog.regNames, (n) => map.get(n) || 0);
      this.v = new Float64Array(prog.nSnap);
      this.post(this.programMsg(prog));
      if (this.audioOn && prog.ins.length && !this.mic) this.openMic();
      if (this.owner === 'main') this.publish();
    }

    setRate(r) { this.rate = r; this.post({ type: 'rate', rate: r }); }
    setRunning(on) { this.running = on; this.post({ type: 'running', on }); }
    step() { if (this.owner === 'worklet') this.post({ type: 'step' }); else { this.runMain(1); } }
    reset() {
      this.s.fill(0); this.v.fill(0); this.ticks = 0;
      this.post({ type: 'reset' });
      if (this.owner === 'main') this.publish();
    }
    // Every Out, block by block, to `onAudio` (the bridge); inputs from it into the Ins.
    tap(on) { this.tapping = on; this.post({ type: 'tap', on }); }
    feed(ins) { this.post({ type: 'ext', ins }); }

    async startAudio() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: GW.FS, latencyHint: 'interactive' });
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(this.ctx, 'clockwork-grid', { numberOfInputs: 1, outputChannelCount: [2] });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => this.fromWorklet(e.data);
        const p = this.prog;
        if (p) this.post(this.programMsg(p));
        this.post({ type: 'rate', rate: this.rate }); this.post({ type: 'running', on: this.running });
        if (this.tapping) this.tap(true);
      }
      this.post({ type: 'take', state: { names: this.prog ? this.prog.regNames : [], values: this.s, ticks: this.ticks } });
      this.owner = 'worklet';
      this.audioOn = true;
      this.onStatus();
      await this.ctx.resume();
      if (this.prog && this.prog.ins.length && !this.mic) this.openMic();
    }
    // The microphone (or whatever the system routes to the browser's input) into the In sockets.
    async openMic() {
      if (!navigator.mediaDevices || this.mic === false) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } });
        this.mic = this.ctx.createMediaStreamSource(stream);
        this.mic.connect(this.node);
      } catch (err) { this.mic = false; this.onStatus('No audio input: ' + err.message); }
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
        this.onSnap({ v: m.v, ticks: m.ticks, bad: m.bad });
      } else if (m.type === 'audio') { if (this.onAudio) this.onAudio(m.o); }
      else if (m.type === 'state' && this.pending) { const f = this.pending; this.pending = null; f(m.state); }
      else if (m.type === 'error') this.onStatus('Audio thread: ' + m.message);
    }

    // Main-thread clock (sound off): same program, same rate, no sound.
    runMain(n) {
      if (!this.fn || n <= 0) return;
      const o = this.prog.outs.map(() => new Float32Array(n));
      this.fn(n, this.prog.params, this.s, o, [], this.v);
      this.ticks += n;
      if (this.onAudio && this.tapping && o.length) this.onAudio(o);   // sound off: the bridge still gets the Outs
      this.publish();
    }
    publish() { this.onSnap({ v: this.v, ticks: this.ticks }); }
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
