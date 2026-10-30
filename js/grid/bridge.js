// The app's end of the PipeWire bridge (tools/pwbridge.py, run by the user).
//
// While connected, the design is a PipeWire node with a port for each socket,
// named as the sockets are: Out sockets play into it, In sockets hear what is
// linked to it. Every other audio node in PipeWire is shown on the board beside
// the design, Helvum-style, with the links between them; dragging from a port to
// a port (or to a socket) links them, and a selected link can be deleted.
(function (root) {
  'use strict';
  const BLOCK = 1024;   // frames per message to the bridge

  class Bridge {
    constructor(app, url) {
      this.app = app; this.url = url || 'ws://127.0.0.1:8765';
      this.ws = null; this.connected = false; this.node = null;
      this.graph = { nodes: [], ports: [], links: [], self: null };
      this.layout = null;     // where the other nodes are drawn: { nodes: Map(id -> box), ports: Map(id -> point) }
      this.pending = [];      // Out audio not yet sent: Float32Array[] per block
      this.sent = 0; this.received = 0;
    }
    connect() {
      if (this.ws) return;
      let ws;
      try { ws = new WebSocket(this.url); } catch (err) { this.status('Could not reach the bridge: ' + err.message); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { this.connected = true; this.ports(); this.app.host.tap(true); this.status(); };
      ws.onclose = (e) => {
        this.closed = { code: e.code, reason: e.reason, clean: e.wasClean };
        const was = this.connected;
        this.ws = null; this.connected = false; this.graph = { nodes: [], ports: [], links: [], self: null }; this.layout = null;
        this.app.host.tap(false); this.app.host.feed(null);
        this.status(was ? 'PipeWire bridge disconnected.' : 'No PipeWire bridge at ' + this.url + ': run python3 tools/pwbridge.py as yourself.');
      };
      ws.onmessage = (e) => this.message(e.data);
      this.app.host.onAudio = (outs) => this.audio(outs);
    }
    disconnect() { if (this.ws) this.ws.close(); }
    status(msg) { if (msg) this.app.toast(msg, 6000); this.app.view.dirty = true; if (this.app.bridgeChanged) this.app.bridgeChanged(); }

    // The program changed: the node's ports follow its sockets.
    program(c) { this.prog = c; if (this.connected) this.ports(); }
    ports() {
      const c = this.prog || this.app.running;
      if (!c || !this.ws) return;
      this.send({ type: 'ports', outs: c.outs.map((o) => o.name), ins: c.ins.map((o) => o.name) });
    }
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

    // Out sockets, block by block from the audio thread, sent in larger pieces.
    audio(outs) {
      if (!this.connected || !outs.length) return;
      this.pending.push(outs);
      const frames = this.pending.reduce((n, b) => n + b[0].length, 0);
      if (frames < BLOCK) return;
      const nch = outs.length, buf = new ArrayBuffer(8 + 4 * nch * frames), head = new Uint32Array(buf, 0, 2);
      head[0] = nch; head[1] = frames;
      for (let k = 0; k < nch; k++) {
        const ch = new Float32Array(buf, 8 + 4 * k * frames, frames);
        let at = 0;
        for (const b of this.pending) { if (b[k]) ch.set(b[k], at); at += b[0].length; }
      }
      this.pending = [];
      if (this.ws.bufferedAmount < 1 << 20) { this.ws.send(buf); this.sent += frames; }
    }
    message(data) {
      if (typeof data !== 'string') {   // audio for the In sockets: (channels, frames), then float32 per channel
        const head = new Uint32Array(data, 0, 2), nch = head[0], n = head[1], ins = [];
        for (let k = 0; k < nch; k++) ins.push(new Float32Array(data.slice(8 + 4 * k * n, 8 + 4 * (k + 1) * n)));
        this.app.host.feed(ins);
        this.received += n;
        return;
      }
      const m = JSON.parse(data);
      if (m.type === 'hello') { this.node = m.node; this.status(`Connected to PipeWire: this design is the node "${m.name}".`); }
      else if (m.type === 'graph') { this.graph = m; this.layout = null; this.status(); }
      else if (m.type === 'error') this.app.toast('PipeWire: ' + m.message, 6000);
    }

    // ---- the graph on the board ---------------------------------------------------------
    nodeOf(id) { return this.graph.nodes.find((n) => n.id === id); }
    portOf(id) { return this.graph.ports.find((p) => p.id === id); }
    // This design's own port for a socket (by name and kind, in order).
    selfPort(dir, name, nth) {
      const ps = this.graph.ports.filter((p) => p.node === this.graph.self && p.dir === dir && p.name === name);
      return ps[nth || 0] || null;
    }
    // The other nodes: sources on the left of the design, everything else on the right,
    // each a box with its inputs down the left edge and its outputs down the right.
    place(bbox) {
      const key = JSON.stringify(bbox) + this.graph.nodes.length + ':' + this.graph.ports.length;
      if (this.layout && this.layout.key === key) return this.layout;
      const nodes = new Map(), ports = new Map(), W = 10;
      const others = this.graph.nodes.filter((n) => n.id !== this.graph.self);
      const portsOf = (n) => this.graph.ports.filter((p) => p.node === n.id && !p.monitor);
      const cols = { left: { x: bbox.x0 - W - 8, y: bbox.y0 }, right: { x: bbox.x1 + 8, y: bbox.y0 } };
      for (const n of others.slice().sort((a, b) => (a.desc || a.name).localeCompare(b.desc || b.name))) {
        const ps = portsOf(n);
        if (!ps.length) continue;
        const ins = ps.filter((p) => p.dir === 'in'), outs = ps.filter((p) => p.dir === 'out');
        const col = ins.length ? cols.right : cols.left, h = 2 + Math.max(ins.length, outs.length) * 1.2;
        const box = { n, x: col.x, y: col.y, w: W, h };
        nodes.set(n.id, box);
        ins.forEach((p, i) => ports.set(p.id, { p, x: box.x, y: box.y + 2 + i * 1.2, box }));
        outs.forEach((p, i) => ports.set(p.id, { p, x: box.x + W, y: box.y + 2 + i * 1.2, box }));
        col.y += h + 1.5;
      }
      this.layout = { key, nodes, ports };
      return this.layout;
    }
    // Where a port is drawn: another node's port, or the socket on the board that is this design's port.
    portPoint(id, sockets) {
      const L = this.layout, q = L && L.ports.get(id);
      if (q) return [q.x, q.y];
      const p = this.portOf(id);
      if (!p || p.node !== this.graph.self) return null;
      const s = sockets.find((x) => x.dir === p.dir && x.name === p.name);
      return s ? s.at : null;
    }
    link(outId, inId) { this.send({ type: 'link', out: outId, in: inId }); }
    unlink(id) { this.send({ type: 'unlink', id }); }
  }

  root.GW = Object.assign(root.GW || {}, { Bridge });
})(typeof self !== 'undefined' ? self : this);
