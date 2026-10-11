// Sample stacks: decoded WAV files, mixed to mono at GW.FS, kept in IndexedDB so a
// reload doesn't lose them. The project only stores a sample's id; the samples
// themselves are too big for localStorage or the exported JSON.
(function (root) {
  'use strict';
  const G = root.GW;
  const DB = 'sample-factory', STORE = 'samples';
  const BINS = 2048;   // overview resolution for drawing the whole song on a block

  const lib = new Map();   // id -> {id, name, rate, data: Float32Array, peaks: Float32Array}

  // Min/max per bin, for drawing the whole stack at a glance.
  function peaksOf(data) {
    const n = Math.min(BINS, data.length), out = new Float32Array(2 * n), per = data.length / n;
    for (let b = 0; b < n; b++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = Math.floor(b * per), e = Math.floor((b + 1) * per); i < e; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[2 * b] = lo; out[2 * b + 1] = hi;
    }
    return out;
  }
  // Content id: a hash of a strided subset of the samples, plus the length.
  function idOf(data) {
    const u = new Uint32Array(data.buffer, data.byteOffset, data.length);
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(u.length / 65536));
    for (let i = 0; i < u.length; i += step) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    return 'wav:' + h.toString(16) + ':' + data.length;
  }
  function entry(name, rate, data, id) {
    const e = { id: id || idOf(data), name, rate, data, peaks: peaksOf(data) };
    lib.set(e.id, e);
    return e;
  }

  // ---- IndexedDB ------------------------------------------------------------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'id' });
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
    }
    return dbp;
  }
  async function save(e) {
    try {
      const d = await db();
      await new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ id: e.id, name: e.name, rate: e.rate, data: e.data });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (err) { return false; }
  }
  async function load(id) {
    if (lib.has(id)) return lib.get(id);
    if (id === DEMO_ID) return demo();
    try {
      const d = await db();
      const rec = await new Promise((resolve, reject) => {
        const rq = d.transaction(STORE).objectStore(STORE).get(id);
        rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error);
      });
      return rec ? entry(rec.name, rec.rate, rec.data, rec.id) : null;
    } catch (err) { return null; }
  }

  // ---- decoding ----------------------------------------------------------------
  // The browser decodes and resamples to GW.FS, so one tick is one sample at real time.
  async function decode(file) {
    const buf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, G.FS);
    const audio = await new Promise((resolve, reject) => ctx.decodeAudioData(buf, resolve, reject));
    const n = audio.length, data = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < n; i++) data[i] += ch[i];
    }
    if (audio.numberOfChannels > 1) for (let i = 0; i < n; i++) data[i] /= audio.numberOfChannels;
    const e = entry(file.name.replace(/\.[^.]*$/, ''), G.FS, data);
    e.stored = await save(e);
    return e;
  }

  // ---- a built-in song, so the example works without a file --------------------------
  // Eight bars of plucked chords over a kick, synthesized once at load.
  const DEMO_ID = 'demo:factory-song';
  function demo() {
    if (lib.has(DEMO_ID)) return lib.get(DEMO_ID);
    const FS = G.FS, bpm = 112, beat = 60 / bpm, bars = 8, n = Math.round(bars * 4 * beat * FS);
    const data = new Float32Array(n);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];   // Am F C G
    const pluck = (t0, f, amp, decay) => {   // Karplus-Strong-ish: a decaying, softening saw
      const i0 = Math.round(t0 * FS), len = Math.min(n - i0, Math.round(FS * 1.2));
      let ph = 0;
      for (let i = 0; i < len; i++) {
        ph += f / FS; if (ph >= 1) ph -= 1;
        const t = i / FS, bright = Math.exp(-t * 6);
        data[i0 + i] += amp * Math.exp(-t * decay) * ((2 * ph - 1) * bright + Math.sin(2 * Math.PI * ph) * (1 - bright));
      }
    };
    for (let bar = 0; bar < bars; bar++) {
      const ch = chords[bar % 4];
      for (let b = 0; b < 4; b++) {
        const t = (bar * 4 + b) * beat;
        // kick
        const i0 = Math.round(t * FS), len = Math.min(n - i0, Math.round(FS * 0.25));
        let ph = 0;
        for (let i = 0; i < len; i++) { const tt = i / FS; ph += (45 + 120 * Math.exp(-tt * 30)) / FS; data[i0 + i] += 0.5 * Math.exp(-tt * 14) * Math.sin(2 * Math.PI * ph); }
        // arpeggio, two notes per beat
        pluck(t, hz(ch[(2 * b) % 3] + 12), 0.12, 5);
        pluck(t + beat / 2, hz(ch[(2 * b + 1) % 3] + 12), 0.1, 5);
      }
      pluck(bar * 4 * beat, hz(ch[0] - 12), 0.22, 1.5);   // bass
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
    for (let i = 0; i < n; i++) data[i] *= 0.8 / peak;
    return entry('Factory song (built in)', FS, data, DEMO_ID);
  }

  root.GW = Object.assign(root.GW || {}, { Samples: { lib, get: (id) => lib.get(id), load, decode, demo, DEMO_ID } });
})(typeof self !== 'undefined' ? self : this);
