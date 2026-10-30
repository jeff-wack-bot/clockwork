// Board view. Each kind of signal has its own look: float wires are PCB traces
// between pads, coloured by value, with vias where they change layer (placed by
// hand, or by the renderer where traces cross: G.renderLayout); fixed-point wires
// are barcodes, one stripe per bit, white for 1 and black for 0; analog wires are
// patch cables hanging between jacks. Atoms and gates are drawn as symbols,
// analog modules as their panels, composite ICs with their own board inside.
// Trace geometry is cached as Path2D in board units, so a frame costs one stroke
// per net, at any zoom and nesting depth.
(function (root) {
  'use strict';
  const G = root.GW;

  // Trace width factors from narrowest (reach 0, at a reader) to widest (the driver).
  const TAPER = [0.55, 0.69, 0.82, 0.96, 1.1, 1.24, 1.37, 1.5];
  const TAPER_FLAT = 3;   // nets with no driver: no direction to show
  const taperBucket = (r) => Math.max(0, Math.min(TAPER.length - 1, Math.round(r * (TAPER.length - 1))));
  const ENTER_PX = 6;     // inner board units this big (px) or bigger: you are working inside the IC
  const MIN_INNER = 0.3;  // below this an IC's board is too small to be worth drawing
  const SKETCH_PX = 4;    // below this a board is drawn as one stroke per layer (colours are invisible anyway)
  const W_TOP = 0.34, W_BOT = 0.2, W_CASE = 0.5;

  // ---- colormap: [0,1] linear on the first half, then log up to 1e4 ----------
  const POS = ['#2a2233', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcd06a', '#fcfdbf'];
  const NEG = ['#22282f', '#0b3a5c', '#13668f', '#2a9bbd', '#59c7d9', '#a6e6ea', '#e6fbff'];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function lut(stops) {
    const rgb = stops.map(hex), out = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (rgb.length - 1), j = Math.min(rgb.length - 2, Math.floor(t)), f = t - j;
      out.push(`rgb(${rgb[j].map((c, k) => Math.round(c + (rgb[j + 1][k] - c) * f)).join(',')})`);
    }
    return out;
  }
  const POS_LUT = lut(POS), NEG_LUT = lut(NEG);
  function colorOf(v) {
    if (v === undefined) return '#4a5060';
    if (!Number.isFinite(v)) return '#ff2bd6';
    const a = Math.abs(v);
    const x = a <= 1 ? a * 0.5 : 0.5 + 0.5 * Math.min(1, Math.log10(a) / 4);
    return (v < 0 ? NEG_LUT : POS_LUT)[Math.round(x * 255)];
  }
  function fmt(v) {
    if (v === undefined) return '';
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
    return String(Number(v.toPrecision(3)));
  }
  function knobFrac(k, v) {
    if (k.scale === 'log' && k.min > 0 && k.max > 0) return Math.log(Math.max(v, k.min) / k.min) / Math.log(k.max / k.min);
    return (v - k.min) / ((k.max - k.min) || 1);
  }
  function knobValue(k, f) {
    f = Math.min(1, Math.max(0, f));
    if (k.scale === 'log' && k.min > 0 && k.max > 0) return k.min * Math.pow(k.max / k.min, f);
    return k.min + f * (k.max - k.min);
  }

  // Trace path through a list of cells [[x, y], ...] (centres of a Manhattan path).
  function pathOf(cells) {
    const p = new Path2D();
    cells.forEach(([x, y], i) => (i ? p.lineTo(x + 0.5, y + 0.5) : p.moveTo(x + 0.5, y + 0.5)));
    if (cells.length === 1) p.lineTo(cells[0][0] + 0.5, cells[0][1] + 0.5);
    return p;
  }

  class View {
    constructor(app, canvas) {
      this.app = app; this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.cam = { x: 20, y: 10, z: 24 };
      this.target = { x: 20, y: 10, z: 24 };
      this.anchor = null;
      this.dirty = true;
      this.cache = new WeakMap();
      this.rcache = new WeakMap();
      this.resize();
      // follow the canvas's real size, whatever changes the layout (window, panels, embedding)
      new ResizeObserver(() => { this.resize(); this.dirty = true; }).observe(canvas);
      const loop = () => {
        this.animate();
        if (this.app.style && this.app.style.dir === 'flow' && this.app.host && this.app.host.running) this.dirty = true;
        if (this.dirty && this.app.project) { this.dirty = false; this.draw(); }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      this.W = r.width; this.H = r.height; this.dpr = dpr;
      this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    }

    // ---- camera ----------------------------------------------------------------
    toWorld(sx, sy) { return { x: this.cam.x + (sx - this.W / 2) / this.cam.z, y: this.cam.y + (sy - this.H / 2) / this.cam.z }; }
    toScreen(wx, wy) { return { x: (wx - this.cam.x) * this.cam.z + this.W / 2, y: (wy - this.cam.y) * this.cam.z + this.H / 2 }; }
    zoomAt(sx, sy, factor) {
      const w = this.toWorld(sx, sy);
      this.target.z = Math.min(20000, Math.max(2, this.target.z * factor));
      this.anchor = { wx: w.x, wy: w.y, sx, sy };
    }
    pan(dx, dy) {
      this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z;
      this.target.x = this.cam.x; this.target.y = this.cam.y; this.anchor = null;
      this.dirty = true;
    }
    fitRect(x0, y0, x1, y1, pad) {
      pad = pad === undefined ? 0.08 : pad;
      const w = x1 - x0, h = y1 - y0;
      this.target.z = Math.min(20000, Math.max(2, Math.min(this.W / (w * (1 + 2 * pad)), this.H / (h * (1 + 2 * pad)))));
      this.target.x = (x0 + x1) / 2; this.target.y = (y0 + y1) / 2;
      this.anchor = null;
    }
    fitAll() { const b = this.extent(this.rootFrame()); this.fitRect(b.x0, b.y0, b.x1, b.y1); }
    animate() {
      const c = this.cam, t = this.target;
      const lz = Math.log(c.z), ltz = Math.log(t.z);
      const still = Math.abs(lz - ltz) < 1e-3 && (this.anchor || (Math.abs(c.x - t.x) * c.z < 0.3 && Math.abs(c.y - t.y) * c.z < 0.3));
      if (still) {
        if (c.z !== t.z) { c.z = t.z; this.dirty = true; }
        if (this.anchor) { this.anchorTo(); this.anchor = null; t.x = c.x; t.y = c.y; }
        return;
      }
      const k = 0.25;
      c.z = Math.exp(lz + (ltz - lz) * k);
      if (this.anchor) this.anchorTo();
      else { c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k; }
      this.dirty = true;
    }
    anchorTo() {
      const a = this.anchor, c = this.cam;
      c.x = a.wx - (a.sx - this.W / 2) / c.z; c.y = a.wy - (a.sy - this.H / 2) / c.z;
    }

    // ---- frames ----------------------------------------------------------------
    rootFrame() { return { sheet: this.app.project.root, path: '', ox: 0, oy: 0, sc: 1, inst: null, parent: null, chain: [] }; }
    child(F, b) {
      const def = this.app.project.defs[b.def];
      const fp = G.footprint(b, this.app.project.defs), f = G.innerFit(def, fp.w, fp.h);
      return { sheet: def, def, path: F.path + b.id + '/', ox: F.ox + (b.x + f.dx) * F.sc, oy: F.oy + (b.y + f.dy) * F.sc, sc: F.sc * f.k, inst: b, parent: F, chain: F.chain.concat([b.def]) };
    }
    extent(F) {
      const sh = F.sheet;
      if (G.isDef(sh)) { const n = G.inner(sh); return { x0: F.ox, y0: F.oy, x1: F.ox + n.w * F.sc, y1: F.oy + n.h * F.sc }; }
      const g = this.geom(sh), bb = g.bbox || { x0: 0, y0: 0, x1: 30, y1: 20 };
      const L = F.path === '' ? this.graphLayout() : null;
      if (!L) return bb;
      const out = Object.assign({}, bb);
      for (const box of L.nodes.values()) { out.x0 = Math.min(out.x0, box.x - 1); out.y0 = Math.min(out.y0, box.y - 1); out.x1 = Math.max(out.x1, box.x + box.w + 1); out.y1 = Math.max(out.y1, box.y + box.h + 1); }
      return out;
    }

    // A board as the renderer draws it: the sheet plus, per net (keyed by its
    // source pin), the cells its traces cover on each layer.
    rendered(sheet) {
      if (sheet.layout) return sheet;
      const c = this.rcache.get(sheet);
      if (c && c.ver === this.app.version) return c.r;
      const L = G.renderLayout(sheet, this.app.project.defs);
      const r = Object.assign({}, sheet, { top: L.top, bot: L.bot, regions: L.regions, layout: L, src: sheet });
      this.rcache.set(sheet, { ver: this.app.version, r });
      return r;
    }
    routes(sheet) { return this.rendered(sheet).layout.routes; }

    // Everything about a board that only changes when it is edited.
    geom(sheet) {
      sheet = this.rendered(sheet);
      let g = this.cache.get(sheet);
      if (g && g.ver === this.app.version && g.ops === this.app.style.ops) return g;
      const defs = this.app.project.defs;
      const occ = G.occupancy(sheet, defs);
      const blocks = sheet.blocks.map((b) => ({ b, fp: G.footprint(b, defs) }));
      // Composite pins sit on the package edge: traces stop at the edge, not the cell centre.
      const edge = new Map();
      for (const { b, fp } of blocks) {
        if (b.type !== 'comp') continue;
        for (const p of fp.pads) edge.set(G.key(p.x, p.y), p.dir === 'in' ? [p.x, p.y + 0.5] : [p.x + 1, p.y + 0.5]);
      }
      // Which way does the value flow? Walk every net outward from the pin that
      // drives it (an output pin, or an input port seen from inside an IC; for a
      // constant, its knob). Each cell learns its distance from the driver.
      const drivers = new Map();
      const addDriver = (l, x, y) => {
        const rid = sheet[l][G.key(x, y)];
        if (!rid) return;
        if (!drivers.has(rid)) drivers.set(rid, []);
        drivers.get(rid).push([l, x, y]);
      };
      for (const { fp } of blocks) for (const p of fp.pads) if (p.dir === 'out') addDriver(G.TOP, p.x, p.y);
      if (G.isDef(sheet)) for (const p of G.innerPads(sheet)) if (p.dir === 'in') addDriver(G.TOP, p.x, p.y);
      for (const rid in sheet.regions) {
        const kb = sheet.regions[rid].knob;
        if (kb && !drivers.has(rid)) addDriver(sheet.top[G.key(kb.x, kb.y)] === rid ? G.TOP : G.BOT, kb.x, kb.y);
      }
      // A constant with no knob enters at its free end: the cell farthest from the
      // pins that read it.
      const readers = new Map();
      for (const [k, o] of occ) if (o.pad && sheet.top[k]) {
        const rid = sheet.top[k];
        if (!readers.has(rid)) readers.set(rid, []);
        readers.get(rid).push([G.TOP, ...G.unkey(k)]);
      }
      for (const [rid, pins] of readers) {
        if (drivers.has(rid)) continue;
        const seen = new Set(pins.map(([l, x, y]) => l + ':' + G.key(x, y))), q = pins.slice();
        for (let i = 0; i < q.length; i++) {
          const [l, x, y] = q[i];
          for (const [nl, nx, ny] of [[l, x + 1, y], [l, x - 1, y], [l, x, y + 1], [l, x, y - 1], [l === G.TOP ? G.BOT : G.TOP, x, y]]) {
            const c = nl + ':' + G.key(nx, ny);
            if (sheet[nl][G.key(nx, ny)] === rid && !seen.has(c)) { seen.add(c); q.push([nl, nx, ny]); }
          }
        }
        if (q.length > pins.length) addDriver(...q[q.length - 1]);
      }
      // Width follows how much of the net still lies downstream: each cell's
      // "reach" is the distance to the farthest cell beyond it (away from the
      // driver), as a fraction of the reach at the driver. So every net is widest
      // at its driver and narrowest at every reader, never widens along the flow,
      // and at a branch the long run keeps its width while a short spur starts thin.
      const dist = new Map(), reach = new Map();
      const around = (l, x, y) => [[l, x + 1, y], [l, x - 1, y], [l, x, y + 1], [l, x, y - 1], [l === G.TOP ? G.BOT : G.TOP, x, y]];
      for (const [rid, starts] of drivers) {
        const q = [];
        for (const [l, x, y] of starts) { const c = l + ':' + G.key(x, y); if (!dist.has(c)) { dist.set(c, 0); q.push([l, x, y]); } }
        for (let i = 0; i < q.length; i++) {
          const [l, x, y] = q[i], d = dist.get(l + ':' + G.key(x, y));
          for (const [nl, nx, ny] of around(l, x, y)) {
            const c = nl + ':' + G.key(nx, ny);
            if (sheet[nl][G.key(nx, ny)] !== rid || dist.has(c)) continue;
            dist.set(c, d + 1); q.push([nl, nx, ny]);
          }
        }
        const down = new Map();
        for (let i = q.length - 1; i >= 0; i--) {
          const [l, x, y] = q[i], c = l + ':' + G.key(x, y), d = dist.get(c);
          let h = 0;
          for (const [nl, nx, ny] of around(l, x, y)) {
            const n = nl + ':' + G.key(nx, ny);
            if (down.has(n) && dist.get(n) === d + 1) h = Math.max(h, down.get(n) + 1);
          }
          down.set(c, h);
        }
        const top = Math.max(1, ...starts.map(([l, x, y]) => down.get(l + ':' + G.key(x, y)) || 0));
        for (const [c, h] of down) reach.set(c, h / top);
      }
      const traces = { top: new Map(), bot: new Map() };
      const taper = { top: new Map(), bot: new Map() };   // rid -> TAPER.length paths, by reach
      const chevrons = { top: [], bot: [] };
      const junctions = [];
      const pt = (x, y) => edge.get(G.key(x, y)) || [x + 0.5, y + 0.5];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
      for (const layer of [G.TOP, G.BOT]) {
        const cells = sheet[layer];
        const D = (x, y) => dist.get(layer + ':' + G.key(x, y));
        for (const k in cells) {
          const rid = cells[k], [x, y] = G.unkey(k);
          grow(x, y, 1, 1);
          let p = traces[layer].get(rid);
          if (!p) {
            p = new Path2D(); traces[layer].set(rid, p);
            taper[layer].set(rid, TAPER.map(() => new Path2D()));
          }
          let linked = false;
          for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
            if (cells[G.key(nx, ny)] !== rid) continue;
            // orient the segment downstream
            let a = [x, y], b = [nx, ny];
            if (D(nx, ny) !== undefined && D(x, y) !== undefined && D(nx, ny) < D(x, y)) [a, b] = [b, a];
            const pa = pt(a[0], a[1]), pb = pt(b[0], b[1]);
            p.moveTo(pa[0], pa[1]); p.lineTo(pb[0], pb[1]); linked = true;
            const d = D(a[0], a[1]);
            const ra = reach.get(layer + ':' + G.key(a[0], a[1])), rb = reach.get(layer + ':' + G.key(b[0], b[1]));
            const bucket = ra === undefined || rb === undefined ? TAPER_FLAT : taperBucket((ra + rb) / 2);
            const tp = taper[layer].get(rid)[bucket];
            tp.moveTo(pa[0], pa[1]); tp.lineTo(pb[0], pb[1]);
            if (d !== undefined && d % 3 === 1) chevrons[layer].push([rid, (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, pb[0] - pa[0], pb[1] - pa[1]]);
          }
          if (!linked && cells[G.key(x - 1, y)] !== rid && cells[G.key(x, y - 1)] !== rid) { const a = pt(x, y); p.moveTo(a[0], a[1]); p.lineTo(a[0], a[1]); }
          // a branch point: the value arrives on one side and leaves on two or more
          const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => cells[G.key(x + dx, y + dy)] === rid);
          if (nb.length >= 3 && !occ.has(k)) {
            const here = D(x, y);
            junctions.push([layer, x, y, rid, nb.map(([dx, dy]) => [dx, dy, here !== undefined && D(x + dx, y + dy) < here])]);
          }
        }
      }
      // Atoms drawn as vias or symbols have no leads of their own: each net's copper
      // continues from the pin to the glyph as part of the net, so trace and lead
      // are one stroke (no end cap or casing between them) at the net's width.
      const ops = this.app.style.ops;
      if (ops !== 'chip') {
        for (const { b, fp } of blocks) {
          const t = G.ATOMS[b.type];
          if (!t) continue;
          const R = ops === 'via' ? 0.42 : b.type === 'delay' ? 0.42 : 0.72;
          const rot = ((b.rot || 0) & 3) * Math.PI / 2, cs = Math.cos(rot), sn = Math.sin(rot);
          const cx = b.x + fp.w / 2, cy = b.y + fp.h / 2;
          const S = ([lx, ly]) => { const u = lx - t.w / 2, v = ly - t.h / 2; return [cx + u * cs - v * sn, cy + u * sn + v * cs]; };
          const mid = [t.w / 2, t.h / 2];
          const lines = [...t.ins.map(([lx, ly]) => [[lx + 0.5, ly + 0.5], [mid[0] - R - 0.1, ly + 0.5], mid]),
            ...t.outs.map(([lx, ly]) => [[lx + 0.5, ly + 0.5], mid])];
          const pads = [...fp.pads.filter((q) => q.dir === 'in'), ...fp.pads.filter((q) => q.dir === 'out')];
          pads.forEach((pad, i) => {
            const rid = sheet.top[G.key(pad.x, pad.y)];
            if (!rid || !traces.top.has(rid)) return;
            const pts = lines[i].map(S), r = reach.get(G.TOP + ':' + G.key(pad.x, pad.y));
            const add = (path) => { path.moveTo(pts[0][0], pts[0][1]); for (let j = 1; j < pts.length; j++) path.lineTo(pts[j][0], pts[j][1]); };
            add(traces.top.get(rid));
            add(taper.top.get(rid)[r === undefined ? TAPER_FLAT : taperBucket(r)]);
          });
        }
      }
      const all = {};
      for (const layer of [G.TOP, G.BOT]) { all[layer] = new Path2D(); for (const p of traces[layer].values()) all[layer].addPath(p); }
      const vias = [];
      for (const k in sheet.top) if (sheet.bot[k] === sheet.top[k]) vias.push([...G.unkey(k), sheet.top[k]]);
      const pads = [];
      for (const [k, o] of occ) if (o.pad && !(o.block && o.block.type === 'comp')) pads.push([...G.unkey(k), o]);
      const anchors = {};
      for (const layer of [G.TOP, G.BOT]) {
        for (const k in sheet[layer]) {
          const rid = sheet[layer][k], [x, y] = G.unkey(k), a = anchors[rid];
          if (occ.has(k) || (a && (y > a[1] || (y === a[1] && x >= a[0])))) continue;
          anchors[rid] = [x, y];
        }
      }
      for (const rid in sheet.regions) { const kb = sheet.regions[rid].knob; if (kb) anchors[rid] = [kb.x, kb.y]; }
      for (const { b, fp } of blocks) grow(b.x, b.y, fp.w, fp.h);
      // a float net's look, from its wires: colour and width belong to the whole net
      const netStyle = new Map();
      for (const w of sheet.wires) {
        if (!w.style || !sheet.regions[w.from]) continue;
        const st = netStyle.get(w.from) || {};
        if (w.style.color && !st.color) st.color = w.style.color;
        if (w.style.width && !st.width) st.width = w.style.width;
        netStyle.set(w.from, st);
      }
      g = { ver: this.app.version, ops: this.app.style.ops, occ, blocks, traces, taper, reach, chevrons, junctions, driven: new Set(drivers.keys()), all, vias, pads, anchors, netStyle,
        bbox: x0 === Infinity ? null : { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 } };
      this.cache.set(sheet, g);
      return g;
    }

    // Deepest frame under a screen point: zoomed in far enough, you are inside the IC.
    locate(sx, sy) {
      const w = this.toWorld(sx, sy), defs = this.app.project.defs;
      let F = this.rootFrame();
      for (let depth = 0; depth < 12; depth++) {
        const fx = (w.x - F.ox) / F.sc, fy = (w.y - F.oy) / F.sc;
        const x = Math.floor(fx), y = Math.floor(fy);
        const o = this.geom(F.sheet).occ.get(G.key(x, y));
        const b = o && o.block;
        // Zoomed in far enough, you are inside the block, except on one of its pins'
        // tabs on the edge: a pin belongs to the board it sits on. (Only the tab: a
        // pin's cell is a large part of the inside once you are working in there.)
        const onTab = o && o.pad && (o.pad.dir === 'in' ? fx - x < 0.35 : fx - x > 0.65) && fy - y > 0.15 && fy - y < 0.85;
        const bench = F.path === '' && this.app.benchBlock && this.app.benchBlock() === b;   // the block editor's block: always its inside
        if (b && b.type === 'comp' && (!onTab || bench) && defs[b.def] && this.cam.z * F.sc * (() => { const q = G.footprint(b, defs); return G.innerFit(defs[b.def], q.w, q.h).k; })() >= ENTER_PX) { F = this.child(F, b); continue; }
        return { F, x, y, fx, fy, occ: o };
      }
      return null;
    }

    // ---- drawing ---------------------------------------------------------------
    draw() {
      if (!this.app.project) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, this.W, this.H);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      this.drawBoard(this.rootFrame());
      this.drawGraph();
      this.drawOverlay();
    }

    // Draw in board units of frame F.
    board(F) {
      const s = this.dpr * this.cam.z * F.sc;
      this.ctx.setTransform(s, 0, 0, s, this.dpr * ((F.ox - this.cam.x) * this.cam.z + this.W / 2), this.dpr * ((F.oy - this.cam.y) * this.cam.z + this.H / 2));
    }
    screen() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

    drawBoard(F) {
      const ctx = this.ctx, app = this.app, sh = this.rendered(F.sheet), px = this.cam.z * F.sc;
      const g = this.geom(sh);
      const val = (rid) => app.valueOf(F.path + rid);
      const hot = app.hotRegion && app.hotRegion.path === F.path ? app.hotRegion.rid : null;
      const sel = app.sel && app.sel.F.path === F.path && app.sel.F.sheet === F.sheet ? app.sel : null;   // the selection, if it is on this board
      const botActive = false;   // the bottom layer is always drawn behind (layers are the renderer's)
      // trace widths are in board units, capped in pixels so an outer board's
      // traces don't swamp the inner board you have zoomed into
      const cap = (w, maxPx) => Math.min(w, maxPx / px);
      const wTop = cap(W_TOP, 10), wBot = cap(W_BOT, 6), wCase = cap(W_CASE, 15);

      this.board(F);
      if (G.isDef(sh)) {
        ctx.fillStyle = '#171a20';
        const n = G.inner(sh); ctx.fillRect(0, 0, n.w, n.h);
      }
      if (px < SKETCH_PX) {
        // far away: the board's structure, one stroke per layer
        ctx.globalAlpha = 0.8; ctx.lineWidth = W_BOT; ctx.strokeStyle = '#3d3550'; ctx.stroke(g.all.bot);
        ctx.lineWidth = W_TOP; ctx.strokeStyle = '#7a5a78'; ctx.stroke(g.all.top);
        ctx.globalAlpha = 1;
        for (const { b, fp } of g.blocks) this.drawPackage(F, b, fp, px);
        return;
      }
      const style = app.style;
      const kind = (rid) => app.netKind(F.path + rid);   // 's' register, 'n' wire, 'p' constant
      // One net's copper; with the taper style it is thick at the driver, thin at the readers.
      const strokeNet = (layer, rid, width) => {
        const ns = g.netStyle.get(rid);
        if (ns && ns.width) width *= ns.width;
        if (style.dir === 'taper') {
          g.taper[layer].get(rid).forEach((tp, k) => { ctx.lineWidth = width * TAPER[k]; ctx.stroke(tp); });
        } else { ctx.lineWidth = width; ctx.stroke(g.traces[layer].get(rid)); }
      };
      // Registers as regions: a soft copper pour around every flip-flop's net, or a double outline.
      const registers = (layer, width) => {
        if (style.reg === 'plain') return;
        for (const rid of g.traces[layer].keys()) {
          if (kind(rid) !== 's') continue;
          ctx.strokeStyle = colorOf(val(rid));
          if (style.reg === 'pour') { ctx.globalAlpha = 0.3; strokeNet(layer, rid, cap(1.15, 46)); ctx.globalAlpha = 1; }
          else { strokeNet(layer, rid, width + cap(0.32, 9)); ctx.strokeStyle = '#08090c'; strokeNet(layer, rid, width + cap(0.14, 4)); }
        }
      };
      // bottom layer: thin traces, under the packages
      const strokeLayer = (layer, width, alpha) => {
        ctx.globalAlpha = alpha;
        for (const rid of g.traces[layer].keys()) { const ns = g.netStyle.get(rid); ctx.strokeStyle = (ns && ns.color) || colorOf(val(rid)); strokeNet(layer, rid, width); }
        ctx.globalAlpha = 1;
      };
      const highlight = (layer, width) => {
        for (const [rid, color] of [[hot, 'rgba(255,255,255,0.55)'], [sel && sel.net, '#f0a640']]) {
          const p = rid && g.traces[layer].get(rid);
          if (p) { ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(p); }
        }
      };
      highlight(G.BOT, wBot + cap(0.2, 6));
      registers(G.BOT, wBot);
      strokeLayer(G.BOT, wBot, botActive ? 1 : 0.6);

      // packages (and the boards inside composite ICs); atoms drawn as glyphs come
      // after the top layer, since their nets' copper runs underneath them
      const glyphs = style.ops !== 'chip';
      for (const { b, fp } of g.blocks) if (!(glyphs && G.ATOMS[b.type])) this.drawPackage(F, b, fp, px);

      // top layer: dark casing, then the coloured copper
      this.board(F);
      ctx.globalAlpha = botActive ? 0.35 : 1;
      highlight(G.TOP, wCase + cap(0.16, 5));
      registers(G.TOP, wCase);
      ctx.strokeStyle = '#08090c';
      if (style.dir === 'taper') for (const rid of g.traces.top.keys()) strokeNet(G.TOP, rid, wCase);
      else { ctx.lineWidth = wCase; ctx.stroke(g.all.top); for (const [rid, ns] of g.netStyle) if (ns.width > 1 && g.traces.top.get(rid)) strokeNet(G.TOP, rid, wCase); }
      strokeLayer(G.TOP, wTop, botActive ? 0.35 : 1);
      ctx.globalAlpha = 1;
      if (botActive) strokeLayer(G.BOT, wBot, 0.9);
      this.drawDirection(F, g, px, wTop, wBot, cap);
      this.drawJunctions(F, g, px, wTop, cap);
      if (glyphs) { for (const { b, fp } of g.blocks) if (G.ATOMS[b.type]) this.drawPackage(F, b, fp, px); this.board(F); }
      this.drawBarcodes(F, sh, px, sel);
      this.board(F);
      if (sel && sel.wires.size) {
        // selected wires: their traces in white, on top
        const p = new Path2D(), routes = sh.layout.routes;
        for (const id of sel.wires) {
          const r = routes.get(id);
          if (r) r.forEach(([x, y], i) => (i ? p.lineTo(x + 0.5, y + 0.5) : p.moveTo(x + 0.5, y + 0.5)));
        }
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = wTop * 0.45; ctx.stroke(p);
      }

      // pads and vias
      if (px >= 2.5) {
        ctx.lineWidth = cap(0.08, 2);
        for (const [x, y, o] of g.pads) {
          if (style.ops !== 'chip' && o.block && G.ATOMS[o.block.type]) continue;
          if (o.block && G.MODULES[o.block.type] && G.MODULES[o.block.type].panel) continue;   // jacks are on the panel
          const dom = o.pad.dom || 'float';
          if (dom === 'analog') { this.drawJack(x + 0.5, y + 0.5, 0.36, px); this.board(F); continue; }
          if (dom === 'fixed') {
            const e = o.port ? G.ep('port', o.pad.dir, o.pad.idx) : G.ep(o.block.id, o.pad.dir, o.pad.idx), v = val(e);
            ctx.fillStyle = v === undefined ? '#14161b' : v % 2 ? '#f4f4f4' : '#050506';
            ctx.strokeStyle = o.port ? '#9fd6a8' : '#bfc5d2';
            ctx.fillRect(x + 0.22, y + 0.22, 0.56, 0.56); ctx.strokeRect(x + 0.22, y + 0.22, 0.56, 0.56);
            continue;
          }
          const rid = sh.top[G.key(x, y)];
          ctx.fillStyle = rid ? colorOf(val(rid)) : '#14161b';
          ctx.strokeStyle = o.port ? '#9fd6a8' : '#c9a35b';
          ctx.fillRect(x + 0.2, y + 0.2, 0.6, 0.6); ctx.strokeRect(x + 0.2, y + 0.2, 0.6, 0.6);
        }
        for (const [x, y, rid] of g.vias) {
          ctx.fillStyle = colorOf(val(rid)); ctx.strokeStyle = '#e8ebf2'; ctx.lineWidth = cap(0.09, 2);
          ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.27, 0, 7); ctx.fill(); ctx.stroke();
        }
      }

      // text and knobs in screen space
      this.screen();
      const S = (x, y) => this.toScreen(F.ox + x * F.sc, F.oy + y * F.sc);
      const onScreen = (p, m) => p.x > -m && p.y > -m && p.x < this.W + m && p.y < this.H + m;
      if (px >= 10) {
        ctx.font = `${Math.min(13, px * 0.42)}px system-ui`; ctx.textBaseline = 'middle';
        for (const [x, y, o] of g.pads) {
          if (!o.port) continue;
          const p = S(x, y);
          if (!onScreen(p, 100)) continue;
          ctx.fillStyle = '#9fd6a8';
          ctx.textAlign = o.pad.dir === 'in' ? 'left' : 'right';
          ctx.fillText(o.pad.dir === 'in' ? '▶ ' + o.pad.name : o.pad.name + ' ▶', o.pad.dir === 'in' ? p.x + px : p.x, p.y - px * 0.4);
        }
      }
      // knobs: on Constant blocks, and on input ports with a default
      for (const b of F.sheet.blocks) {
        if (b.type !== 'const' && b.type !== 'volts' && b.type !== 'bits') continue;
        const p = S(b.x, b.y);
        if (!onScreen(p, px * 4)) continue;
        if (b.type === 'bits') this.drawBitsValue(F, b, p, px);
        else if (b.knob) this.drawKnob(F.path + b.id, F.path + G.ep(b.id, 'out', 0), b.knob, b.value, p, px, b.type === 'volts');
        else this.drawConstValue(F.path + G.ep(b.id, 'out', 0), b.value, p, px, b.type === 'volts');
      }
      if (G.isDef(F.sheet)) {
        for (const pad of G.innerPads(F.sheet)) {
          const port = pad.dir === 'in' && G.portsOf(F.sheet, 'in')[pad.idx];
          if (!port || !port.knob) continue;
          const p = S(pad.x + 1, pad.y), k = G.ep('port', 'in', pad.idx);
          if (onScreen(p, px)) this.drawKnob(F.path + k, F.path + k, port.knob, port.value || 0, p, px);
        }
      }
      if (px >= 18) {
        ctx.font = `600 ${Math.min(14, px * 0.36)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const constNet = (rid) => { const e = G.parseEp(rid), b = e && F.sheet.blocks.find((x) => x.id === e.b); return !!(b && b.type === 'const'); };
        for (const rid in g.anchors) {
          if (!sh.regions[rid] || constNet(rid)) continue;   // a Constant shows its own value
          const [x, y] = g.anchors[rid], p = S(x, y);
          if (!onScreen(p, 50)) continue;
          const s = fmt(val(rid)), ty = p.y + px / 2;
          const w = ctx.measureText(s).width + 6;
          ctx.fillStyle = 'rgba(10,10,14,0.7)'; ctx.fillRect(p.x + px / 2 - w / 2, ty - 8, w, 16);
          ctx.fillStyle = '#f2f4f8'; ctx.fillText(s, p.x + px / 2, ty);
        }
      }
      this.drawCables(F, px, sel);
    }

    // Direction cues: chevrons pointing downstream, or dashes flowing away from the driver.
    drawDirection(F, g, px, wTop, wBot, cap) {
      const ctx = this.ctx, app = this.app, dir = app.style.dir;
      if (dir === 'arrows' && px >= 5) {
        ctx.strokeStyle = 'rgba(8,9,12,0.9)';
        for (const layer of [G.TOP, G.BOT]) {
          const w = layer === G.TOP ? wTop : wBot, a = w * 0.42;
          ctx.lineWidth = cap(0.06, 2);
          ctx.beginPath();
          for (const [, mx, my, dx, dy] of g.chevrons[layer]) {
            const nx = -dy, ny = dx;   // normal to the direction of flow
            ctx.moveTo(mx - dx * a + nx * a, my - dy * a + ny * a);
            ctx.lineTo(mx + dx * a * 0.6, my + dy * a * 0.6);
            ctx.lineTo(mx - dx * a - nx * a, my - dy * a - ny * a);
          }
          ctx.stroke();
        }
      } else if (dir === 'flow' && px >= 3) {
        const t = app.flowTime();
        ctx.setLineDash([0.18, 0.32]);
        ctx.lineDashOffset = -t;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        for (const [layer, w] of [[G.TOP, wTop], [G.BOT, wBot]]) {
          ctx.lineWidth = w * 0.38;
          for (const [rid, p] of g.traces[layer]) if (g.driven.has(rid)) ctx.stroke(p);
        }
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
    }

    // Branch points, where one value is copied to several readers.
    drawJunctions(F, g, px, wTop, cap) {
      const ctx = this.ctx, app = this.app, branch = app.style.branch;
      if (branch === 'none' || px < 3) return;
      for (const [layer, x, y, rid, arms] of g.junctions) {
        const cx = x + 0.5, cy = y + 0.5, color = colorOf(app.valueOf(F.path + rid));
        const w = layer === G.TOP ? wTop : wTop * 0.6;
        if (branch === 'dot') {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, w * 1.05, 0, 7); ctx.fill();
          ctx.strokeStyle = '#08090c'; ctx.lineWidth = cap(0.05, 1.5); ctx.stroke();
        } else {
          // a copy via: dark ring with one spoke per branch; the spoke the value arrives on is white
          const r = Math.max(w * 1.25, 0.3);
          ctx.fillStyle = '#0d0f13'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
          ctx.lineWidth = cap(0.08, 3);
          for (const [dx, dy, upstream] of arms) {
            ctx.strokeStyle = upstream ? '#ffffff' : color;
            ctx.beginPath(); ctx.moveTo(cx + dx * r * 0.25, cy + dy * r * 0.25); ctx.lineTo(cx + dx * r, cy + dy * r); ctx.stroke();
          }
          ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
        }
      }
    }

    // An atom drawn as a signal-flow symbol, or as a special via where its traces meet.
    drawOp(F, b, fp, px, outline) {
      const ctx = this.ctx, app = this.app, sh = this.rendered(F.sheet), t = G.ATOMS[b.type], via = app.style.ops === 'via';
      const val = (p) => { const rid = sh.top[G.key(p.x, p.y)]; return rid ? app.valueOf(F.path + rid) : undefined; };
      const ins = fp.pads.filter((p) => p.dir === 'in'), outs = fp.pads.filter((p) => p.dir === 'out');
      // work in the block's own, unrotated frame
      this.board(F);
      ctx.translate(b.x + fp.w / 2, b.y + fp.h / 2); ctx.rotate((b.rot || 0) * Math.PI / 2); ctx.translate(-t.w / 2, -t.h / 2);
      const mx = t.w / 2, my = t.h / 2;
      const lw = (w, maxPx) => Math.min(w, maxPx / px);
      const R = via ? 0.42 : b.type === 'delay' ? 0.42 : 0.72;
      const vout = outs[0] ? val(outs[0]) : undefined;
      const ring = outline || (via ? '#e8ebf2' : '#d9b36c');
      ctx.lineWidth = lw(outline ? 0.12 : 0.08, outline ? 3 : 2);
      ctx.fillStyle = via ? colorOf(vout) : '#14161b';
      ctx.strokeStyle = ring;
      // on a via the glyph sits on the output colour: light on the dark end of the colormap, dark on the bright end
      const bright = vout !== undefined && Number.isFinite(vout) && (Math.abs(vout) <= 1 ? Math.abs(vout) * 0.5 : 0.5 + 0.5 * Math.min(1, Math.log10(Math.abs(vout)) / 4)) > 0.55;
      const glyph = via && bright ? '#0b0c10' : '#e8ebf2';
      ctx.beginPath();
      if (b.type === 'switch') {           // multiplexer: a trapezoid, "1" on top, "0" below
        const h0 = via ? 0.45 : 1.1, h1 = via ? 0.25 : 0.5, w0 = via ? 0.4 : 0.6;
        ctx.moveTo(mx - w0, my - h0); ctx.lineTo(mx + w0, my - h1); ctx.lineTo(mx + w0, my + h1); ctx.lineTo(mx - w0, my + h0); ctx.closePath();
      } else if (b.type === 'gt') {        // comparator: a triangle pointing at its output
        const h = via ? 0.48 : 0.9;
        ctx.moveTo(mx - h * 0.8, my - h); ctx.lineTo(mx + h * 0.9, my); ctx.lineTo(mx - h * 0.8, my + h); ctx.closePath();
      } else if (b.type === 'delay') {     // flip-flop: a square with a clock notch
        ctx.rect(mx - R, my - R * 0.8, 2 * R, 1.6 * R);
      } else if (b.type === 'table') {     // a ROM: a box with its curve in it
        ctx.rect(0.75, 0.3, t.w - 1.5, t.h - 0.6);
      } else if (b.type === 'exp2' || b.type === 'log2') {
        ctx.rect(mx - 0.62, my - 0.4, 1.24, 0.8);
      } else ctx.arc(mx, my, R, 0, 7);     // summing junction / multiplier: a circle
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = glyph; ctx.lineWidth = lw(via ? 0.07 : 0.08, 2.5);
      ctx.beginPath();
      const g = R * 0.55;
      if (b.type === 'add') { ctx.moveTo(mx - g, my); ctx.lineTo(mx + g, my); ctx.moveTo(mx, my - g); ctx.lineTo(mx, my + g); }
      if (b.type === 'mul') { const q = g * 0.75; ctx.moveTo(mx - q, my - q); ctx.lineTo(mx + q, my + q); ctx.moveTo(mx + q, my - q); ctx.lineTo(mx - q, my + q); }
      if (b.type === 'delay') { ctx.moveTo(mx - R * 0.35, my + R * 0.8); ctx.lineTo(mx, my + R * 0.35); ctx.lineTo(mx + R * 0.35, my + R * 0.8); }
      if (b.type === 'table') {
        const pts = G.tablePoints(b), x0 = pts[0][0], x1 = pts[pts.length - 1][0];
        let y0 = Math.min(...pts.map((q) => q[1])), y1 = Math.max(...pts.map((q) => q[1]));
        if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
        const X = (x) => 1 + (t.w - 2) * (x - x0) / ((x1 - x0) || 1), Y = (y) => t.h - 0.55 - (t.h - 1.1) * (y - y0) / (y1 - y0);
        pts.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1]))));
      }
      ctx.stroke();
      if (px * (via ? 0.25 : 0.4) >= 6) {
        // small text marks: + and − on the comparator, 1 and 0 on the switch, z⁻¹ on the flip-flop
        ctx.fillStyle = glyph; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const f = via ? 0.28 : 0.32;
        ctx.font = `600 ${f}px ui-monospace, monospace`;
        if (b.type === 'gt') { ctx.fillText('+', mx - R * 0.35, my - R * 0.45); ctx.fillText('−', mx - R * 0.35, my + R * 0.45); }
        if (b.type === 'switch') { const h0 = via ? 0.3 : 0.7; ctx.fillText('1', mx - 0.15, my - h0); ctx.fillText('0', mx - 0.15, my + h0); }
        if (b.type === 'delay' && !via) ctx.fillText('z⁻¹', mx, my - 0.06);
        if (b.type === 'exp2' || b.type === 'log2') { ctx.font = `600 ${b.type === 'exp2' ? 0.42 : 0.3}px ui-monospace, monospace`; ctx.fillText(t.sym, mx, my + 0.02); }
      }
    }

    drawPackage(F, b, fp, px) {
      const ctx = this.ctx, app = this.app, defs = app.project.defs;
      const a = this.toScreen(F.ox + b.x * F.sc, F.oy + b.y * F.sc), w = fp.w * px, h = fp.h * px;
      if (a.x > this.W || a.y > this.H || a.x + w < 0 || a.y + h < 0) return;
      const selected = !!(app.sel && app.sel.F.path === F.path && app.sel.F.sheet === F.sheet && app.sel.blocks.has(b.id));
      const problem = app.compiled && app.compiled.problemPaths.includes(F.path + b.id);
      const outline = problem ? '#ff6b6b' : selected ? '#f0a640' : null;
      this.board(F);
      if (b.type === 'comp') {
        const def = defs[b.def];
        ctx.fillStyle = '#15181e'; ctx.fillRect(b.x, b.y, fp.w, fp.h);
        // pins straddling the package edge, in their kind's colour
        if (def && px * G.innerFit(def, fp.w, fp.h).k >= MIN_INNER) {
          ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, fp.w, fp.h); ctx.clip();
          this.drawBoard(this.child(F, b));
          ctx.restore();
          this.board(F);
        }
        ctx.lineWidth = Math.min(outline ? 0.08 : 0.05, (outline ? 3 : 1.5) / px); ctx.strokeStyle = outline || '#7a6640';
        ctx.strokeRect(b.x, b.y, fp.w, fp.h);
        const PIN = { float: '#d9b36c', fixed: '#e8e8e8', analog: '#5ec8e5' };
        for (const p of fp.pads) {
          ctx.fillStyle = PIN[p.dom] || PIN.float;
          ctx.fillRect(p.dir === 'in' ? p.x - 0.22 : p.x + 0.78, p.y + 0.24, 0.44, 0.52);
          ctx.strokeStyle = '#0b0c10'; ctx.lineWidth = Math.min(0.04, 1 / px);
          ctx.strokeRect(p.dir === 'in' ? p.x - 0.22 : p.x + 0.78, p.y + 0.24, 0.44, 0.52);
        }
        this.screen();
        if (px >= 14 && !(def && px * G.innerFit(def, fp.w, fp.h).k >= ENTER_PX)) {   // pin names, just outside the edge
          ctx.font = `${Math.min(12, px * 0.34)}px system-ui`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#c3c8d4';
          for (const p of fp.pads) {
            const q = this.toScreen(F.ox + (p.dir === 'in' ? p.x - 0.3 : p.x + 1.3) * F.sc, F.oy + (p.y + 0.5) * F.sc);
            ctx.textAlign = p.dir === 'in' ? 'right' : 'left';
            ctx.fillText(p.name, q.x, q.y);
          }
        }
        if (px >= 3) {
          const ipx = def ? px * G.innerFit(def, fp.w, fp.h).k : 0;
          ctx.fillStyle = '#f0a640'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
          ctx.font = `600 ${Math.max(9, Math.min(16, px * 0.45))}px system-ui`;
          ctx.fillText(b.def + (ipx >= ENTER_PX ? '' : '  ' + b.id), a.x, a.y - 2);
        }
        return;
      }
      const t = G.info(b.type);
      if (b.type === 'const' || b.type === 'volts' || b.type === 'bits') {   // drawn with the knobs, on top of its pad
        if (outline) { this.board(F); ctx.lineWidth = Math.min(0.12, 3 / px); ctx.strokeStyle = outline; ctx.strokeRect(b.x - 0.05, b.y - 0.05, 1.1, 1.1); }
        this.screen(); return;
      }
      const mod = G.MODULES[b.type];
      if (mod && mod.panel) { this.drawPanel(F, b, fp, px, outline); this.screen(); return; }
      if (mod && mod.chip) { this.drawConverter(F, b, fp, px, outline); this.screen(); return; }
      if (G.GATES[b.type]) { this.drawGate(F, b, fp, px, outline); this.screen(); return; }
      if (G.IO[b.type]) { this.drawSocket(F, b, fp, px, outline); this.screen(); return; }
      if (G.ATOMS[b.type] && app.style.ops !== 'chip') { this.drawOp(F, b, fp, px, outline); this.screen(); return; }
      ctx.fillStyle = b.type === 'delay' ? '#1f2d40' : '#242833';
      ctx.fillRect(b.x + 0.12, b.y + 0.12, fp.w - 0.24, fp.h - 0.24);
      ctx.lineWidth = Math.min(outline ? 0.1 : 0.05, (outline ? 3 : 1.5) / px); ctx.strokeStyle = outline || '#59607a';
      ctx.strokeRect(b.x + 0.12, b.y + 0.12, fp.w - 0.24, fp.h - 0.24);
      this.screen();
      if (px >= 5) {
        ctx.fillStyle = b.type === 'delay' ? '#5ec8e5' : '#f0a640';
        ctx.font = `600 ${Math.min(px * 1.1, h * 0.7, w / Math.max(2, t.sym.length) * 1.3)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.sym, a.x + w / 2 + (fp.w === 3 ? px * 0.25 : 0), a.y + h / 2);
      }
      if (px >= 16) {
        ctx.fillStyle = '#9aa1b2'; ctx.font = `${Math.min(12, px * 0.3)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const p of fp.pads) if (p.name) { const q = this.toScreen(F.ox + p.x * F.sc, F.oy + p.y * F.sc); ctx.fillText(p.name, q.x + px / 2, q.y + px * 0.8); }
      }
    }

    // A knob at screen cell p: its state key (for "overridden"/"written") and the
    // pin whose value it shows.
    drawKnob(stateKey, valueKey, k, fallback, p, px, volts) {
      const ctx = this.ctx, st = this.app.knobState(stateKey);
      const cx = p.x + px / 2, cy = p.y + px / 2;
      if (px < 7) { ctx.fillStyle = st === 'ok' ? '#f0a640' : '#6b7080'; ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); return; }
      const v = st === 'ok' ? this.app.valueOf(valueKey) : fallback;
      const frac = knobFrac(k, v === undefined ? fallback : v);
      const r = px * 0.45;
      ctx.fillStyle = '#1e2129'; ctx.strokeStyle = '#4a5163'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.stroke();
      ctx.lineWidth = Math.max(1.5, px * 0.09);
      const a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * Math.min(1, Math.max(0, frac));
      ctx.strokeStyle = '#3a3f4d'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, a0, a0 + Math.PI * 1.5); ctx.stroke();
      ctx.strokeStyle = st === 'ok' ? '#f0a640' : '#6b7080';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, a0, Math.max(a0 + 0.01, a1)); ctx.stroke();
      ctx.strokeStyle = '#e8ebf2'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a1) * r * 0.6, cy + Math.sin(a1) * r * 0.6); ctx.stroke();
      if (st === 'written') {
        ctx.strokeStyle = '#ff6b6b'; ctx.beginPath();
        ctx.moveTo(cx - r * 0.6, cy - r * 0.6); ctx.lineTo(cx + r * 0.6, cy + r * 0.6);
        ctx.moveTo(cx + r * 0.6, cy - r * 0.6); ctx.lineTo(cx - r * 0.6, cy + r * 0.6); ctx.stroke();
      }
      if (px >= 16 && (k.label || volts)) {
        ctx.fillStyle = st === 'ok' ? (volts ? '#9fe3f2' : '#ffd28a') : '#8a90a0'; ctx.font = `${Math.min(13, px * 0.32)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText((k.label ? k.label + ' ' : '') + (volts ? fmt(v === undefined ? fallback : v) + ' V' : '') + (st === 'overridden' ? ' (set outside)' : st === 'written' ? ' (written)' : ''), cx, p.y - 1);
      }
    }
    // A Constant without a knob: its value in a small tag.
    drawConstValue(valueKey, fallback, p, px, volts) {
      const ctx = this.ctx, v = this.app.valueOf(valueKey), cx = p.x + px / 2, cy = p.y + px / 2;
      const st = this.app.compiled && this.app.compiled.knobState;
      ctx.fillStyle = '#c9a35b';
      if (px < 9) { ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); return; }
      const t = fmt(v === undefined ? fallback : v) + (volts ? ' V' : '');
      ctx.font = `600 ${Math.min(13, px * 0.42)}px ui-monospace, monospace`;
      const w = Math.max(px * 0.8, ctx.measureText(t).width + 6), h = Math.min(px * 0.8, 18);
      ctx.fillStyle = volts ? '#13262c' : '#2a2416'; ctx.strokeStyle = volts ? '#5ec8e5' : '#c9a35b'; ctx.lineWidth = 1;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h); ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = '#f2e3c2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t, cx, cy + 0.5);
      void st;
    }

    // ---- PipeWire: the other programs' nodes beside the design, and the links -----------------
    // This design's ports are its sockets: an Out's PipeWire end is its tip, an In's its tail.
    socketPoints() {
      const out = [];
      for (const b of this.app.project.root.blocks) {
        if (b.type === 'out') out.push({ b, dir: 'out', name: b.name || 'out', at: [b.x + 3, b.y + 0.5] });
        if (b.type === 'in') out.push({ b, dir: 'in', name: b.name || 'in', at: [b.x, b.y + 0.5] });
      }
      return out;
    }
    graphLayout() {
      const br = this.app.bridge;
      if (!br || !br.connected) return null;
      const g = this.geom(this.app.project.root), bb = g.bbox || { x0: 0, y0: 0, x1: 20, y1: 10 };
      return br.place(bb);
    }
    linkPath(a, b) {
      const dx = Math.max(3, Math.abs(b[0] - a[0]) / 2);
      return { a, b, c1: [a[0] + dx, a[1]], c2: [b[0] - dx, b[1]] };
    }
    bez3(p, t) {
      const u = 1 - t;
      return [0, 1].map((k) => u * u * u * p.a[k] + 3 * u * u * t * p.c1[k] + 3 * u * t * t * p.c2[k] + t * t * t * p.b[k]);
    }
    // What of the graph is at a root-board point: { port } or { link } or { node }, or null.
    graphHit(fx, fy) {
      const L = this.graphLayout();
      if (!L || fx === undefined) return null;
      const br = this.app.bridge, tol = Math.max(0.3, 5 / this.cam.z);
      for (const q of L.ports.values()) if (Math.hypot(q.x - fx, q.y - fy) < Math.max(0.45, tol)) return { port: q.p };
      const socks = this.socketPoints();
      for (const l of br.graph.links) {
        const a = br.portPoint(l.out, socks), b = br.portPoint(l.in, socks);
        if (!a || !b) continue;
        const p = this.linkPath(a, b);
        for (let t = 0.03; t <= 0.97; t += 1 / 40) { const q = this.bez3(p, t); if (Math.hypot(q[0] - fx, q[1] - fy) < tol) return { link: l }; }
      }
      for (const box of L.nodes.values()) if (fx >= box.x && fx <= box.x + box.w && fy >= box.y && fy <= box.y + box.h) return { node: box.n };
      return null;
    }
    drawGraph() {
      const L = this.graphLayout();
      if (!L) return;
      const ctx = this.ctx, app = this.app, br = app.bridge, F = this.rootFrame(), px = this.cam.z;
      const socks = this.socketPoints();
      this.board(F);
      for (const box of L.nodes.values()) {
        ctx.fillStyle = '#161b22'; ctx.strokeStyle = '#3d4656'; ctx.lineWidth = Math.min(0.06, 1.5 / px);
        roundRect(ctx, box.x, box.y, box.w, box.h, 0.4); ctx.fill(); ctx.stroke();
      }
      // links: green where this design is one end
      ctx.lineCap = 'round';
      for (const l of br.graph.links) {
        const a = br.portPoint(l.out, socks), b = br.portPoint(l.in, socks);
        if (!a || !b) continue;
        const p = this.linkPath(a, b), mine = [l.out, l.in].some((id) => { const q = br.portOf(id); return q && q.node === br.graph.self; });
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.bezierCurveTo(p.c1[0], p.c1[1], p.c2[0], p.c2[1], b[0], b[1]);
        ctx.lineWidth = Math.min(0.22, 3 / px) * (app.pwSel === l.id ? 1.8 : 1);
        ctx.strokeStyle = app.pwSel === l.id ? '#ffffff' : mine ? '#6fdc8c' : '#7a8496'; ctx.stroke();
      }
      const d = app.drag;
      if (d && d.kind === 'pwlink' && d.at) {
        const a = br.portPoint(d.port.id, socks) || [0, 0], b = [d.at.x, d.at.y], out = d.port.dir === 'out';
        const p = out ? this.linkPath(a, b) : this.linkPath(b, a);
        ctx.setLineDash([0.4, 0.3]); ctx.lineWidth = Math.min(0.2, 3 / px); ctx.strokeStyle = '#6fdc8c';
        ctx.beginPath(); ctx.moveTo(p.a[0], p.a[1]); ctx.bezierCurveTo(p.c1[0], p.c1[1], p.c2[0], p.c2[1], p.b[0], p.b[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const q of L.ports.values()) {
        ctx.fillStyle = q.p.dir === 'out' ? '#6fdc8c' : '#5ec8e5';
        ctx.beginPath(); ctx.arc(q.x, q.y, 0.28, 0, 7); ctx.fill();
      }
      for (const s of socks) if (br.selfPort(s.dir, s.name)) { ctx.fillStyle = '#6fdc8c'; ctx.beginPath(); ctx.arc(s.at[0], s.at[1], 0.22, 0, 7); ctx.fill(); }
      for (const box of L.nodes.values()) {
        const n = box.n;
        this.label(F, (n.desc || n.name).slice(0, 28), box.x + 0.4, box.y + 0.75, 0.5, '#e8ebf2', 'left', '600');
        this.label(F, n.cls || n.app || '', box.x + 0.4, box.y + 1.4, 0.32, '#8a90a0', 'left');
      }
      for (const q of L.ports.values()) this.label(F, q.p.name, q.p.dir === 'out' ? q.x - 0.45 : q.x + 0.45, q.y, 0.34, '#c3c8d4', q.p.dir === 'out' ? 'right' : 'left');
      this.screen();
    }

    // ---- fixed point: barcodes ----------------------------------------------------------
    // A bus is a ribbon with one stripe per bit, white for 1 and black for 0, the low
    // bit on the left of the way the value flows, following its route with square corners.
    drawBarcodes(F, sh, px, sel) {
      const ctx = this.ctx, app = this.app, defs = app.project.defs, routes = sh.layout.routes;
      const fixed = F.sheet.wires.filter((w) => G.domainAt(F.sheet, defs, w.from) === 'fixed' && routes.get(w.id));
      if (!fixed.length) return;
      this.board(F);
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      for (const w of fixed) {
        const r = routes.get(w.id), key = F.path + w.from;
        const n = Math.max(1, (app.compiled && app.compiled.widths[key]) || 1), v = app.valueOf(key);
        const sw = Math.min(0.13, 0.66 / n, 16 / px / n), half = n * sw / 2;   // capped on screen, like traces, when zoomed into a block
        const pts = r.map(([x, y]) => [x + 0.5, y + 0.5]);
        const line = (o) => {   // the route offset sideways by o (left of travel positive), mitred at the corners
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(pts.length - 1, i + 1)];
            const d1 = i > 0 ? [b[0] - a[0], b[1] - a[1]] : [c[0] - b[0], c[1] - b[1]];
            const d2 = i < pts.length - 1 ? [c[0] - b[0], c[1] - b[1]] : d1;
            const n1 = [d1[1], -d1[0]], n2 = [d2[1], -d2[0]];
            const same = n1[0] === n2[0] && n1[1] === n2[1];
            const x = b[0] + o * (same ? n1[0] : n1[0] + n2[0]), y = b[1] + o * (same ? n1[1] : n1[1] + n2[1]);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
        };
        const picked = sel && sel.wires.has(w.id);
        const edge = (w.style && w.style.color) || (sel && sel.net === w.from ? '#f0a640' : '#5a6070');
        ctx.strokeStyle = picked ? '#ffffff' : edge; ctx.lineWidth = 2 * half + Math.max(0.05, Math.min(0.12, 2 / px));
        line(0); ctx.stroke();
        if (px * sw < 1.2) { ctx.strokeStyle = '#8a8f9c'; ctx.lineWidth = 2 * half; line(0); ctx.stroke(); continue; }
        for (let k = 0; k < n; k++) {
          const bit = v === undefined ? 0 : Math.floor(v / Math.pow(2, k)) % 2;
          ctx.strokeStyle = bit ? '#f4f4f4' : '#050506'; ctx.lineWidth = sw * 1.02;
          line(half - (k + 0.5) * sw); ctx.stroke();
        }
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    }

    // ---- analog: patch cables -------------------------------------------------------------
    // Where a cable plugs in: the jack's centre (exact on a panel), else the pin's cell.
    jackPoint(sheet, e) {
      const p = G.pinOf(sheet, this.app.project.defs, e);
      if (!p) return null;
      return p.fx !== undefined ? [p.fx, p.fy] : [p.x + 0.5, p.y + 0.5];
    }
    // A cable hangs under its own weight: a quadratic curve whose middle sags by `droop`.
    cablePath(a, b, droop) {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]), sag = (droop === undefined ? 1 : droop) * Math.min(9, 0.6 + d * 0.22);
      return { a, b, c: [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + sag] };
    }
    bez(p, t) {
      const u = 1 - t;
      return [u * u * p.a[0] + 2 * u * t * p.c[0] + t * t * p.b[0], u * u * p.a[1] + 2 * u * t * p.c[1] + t * t * p.b[1]];
    }
    cablesOf(F) {
      const defs = this.app.project.defs, out = [];
      F.sheet.wires.forEach((w, i) => {
        if (G.domainAt(F.sheet, defs, w.from) !== 'analog') return;
        const a = this.jackPoint(F.sheet, w.from), b = this.jackPoint(F.sheet, w.to);
        if (a && b) out.push({ w, i, p: this.cablePath(a, b, w.style && w.style.droop) });
      });
      return out;
    }
    // The cable under a point of frame F (board units), topmost first.
    cableAt(F, fx, fy) {
      if (fx === undefined) return null;
      const tol = Math.max(0.22, 5 / (this.cam.z * F.sc)), cs = this.cablesOf(F);
      for (let n = cs.length - 1; n >= 0; n--) {
        for (let t = 0.04; t <= 0.96; t += 1 / 40) { const q = this.bez(cs[n].p, t); if (Math.hypot(q[0] - fx, q[1] - fy) < tol) return cs[n].w; }
      }
      return null;
    }
    strokeCable(p, color, hot, px) {
      const ctx = this.ctx, wd = Math.min(0.32, Math.max(0.16, 3 / px));
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.a[0], p.a[1]); ctx.quadraticCurveTo(p.c[0], p.c[1], p.b[0], p.b[1]);
      ctx.lineWidth = wd * (hot ? 1.9 : 1.45); ctx.strokeStyle = hot ? '#ffffff' : 'rgba(0,0,0,0.55)'; ctx.stroke();
      ctx.lineWidth = wd; ctx.strokeStyle = color; ctx.stroke();
      for (const e of [p.a, p.b]) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(e[0], e[1], 0.3, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.arc(e[0], e[1], 0.14, 0, 7); ctx.fill();
      }
    }
    drawCables(F, px, sel) {
      const ctx = this.ctx, app = this.app, d = app.drag;
      const cs = this.cablesOf(F);
      const wireDrag = d && d.kind === 'wire' && d.dom === 'analog' && d.F.sheet === F.sheet ? d : null;
      if (!cs.length && !wireDrag) return;
      this.board(F);
      ctx.globalAlpha = px < 4 ? 0.6 : 0.92;
      for (const { w, i, p } of cs) {
        const hot = !!(sel && sel.wires.has(w.id));
        this.strokeCable(p, (w.style && w.style.color) || G.CABLE_COLORS[i % G.CABLE_COLORS.length], hot, px);
      }
      ctx.globalAlpha = 1;
      if (wireDrag && wireDrag.at) {
        const a = [wireDrag.start.fx !== undefined ? wireDrag.start.fx : wireDrag.start.x + 0.5, wireDrag.start.fy !== undefined ? wireDrag.start.fy : wireDrag.start.y + 0.5];
        const b = wireDrag.target ? this.jackPoint(F.sheet, wireDrag.target) : [wireDrag.at.x, wireDrag.at.y];
        const style = wireDrag.picked && wireDrag.picked.style;
        const color = (style && style.color) || G.CABLE_COLORS[F.sheet.wires.filter((x) => x.style && x.style.color).length % G.CABLE_COLORS.length];
        this.strokeCable(wireDrag.from ? this.cablePath(a, b, style && style.droop) : this.cablePath(b, a, style && style.droop), color, false, px);
      }
      this.screen();
    }

    // ---- analog modules: panels with knobs and jacks ----------------------------------------
    drawPanel(F, b, fp, px, outline) {
      const ctx = this.ctx, app = this.app, m = G.MODULES[b.type], lay = m.panel.lay, k = m.panel.scale;
      const x = b.x, y = b.y, w = fp.w, h = G.Analog.PANEL_H * k;
      this.board(F);
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, shade(m.color, 18)); grad.addColorStop(1, shade(m.color, -6));
      ctx.fillStyle = grad; ctx.fillRect(x + 0.03, y, w - 0.06, h);
      ctx.strokeStyle = outline || 'rgba(255,255,255,0.14)'; ctx.lineWidth = Math.min(outline ? 0.12 : 0.04, (outline ? 3 : 1) / px);
      ctx.strokeRect(x + 0.03, y, w - 0.06, h);
      if (px < 3) return;
      ctx.fillStyle = '#9aa0ab';
      for (const [cx, cy] of [[x + 0.45, y + 0.3], [x + w - 0.45, y + h - 0.3]]) { ctx.beginPath(); ctx.arc(cx, cy, 0.15, 0, 7); ctx.fill(); }
      if (lay.plate) { ctx.fillStyle = 'rgba(0,0,0,0.38)'; roundRect(ctx, x + 0.18, y + lay.plate.y0 * k, w - 0.36, (lay.plate.y1 - lay.plate.y0) * k, 0.25); ctx.fill(); }
      const title = m.title.length * 0.45 > m.hp - 0.6 ? m.sym : m.title;
      this.label(F, title, x + w / 2, y + 0.95, Math.min(0.62, (w - 0.3) / Math.max(3, title.length) * 1.75), '#eef0f5', 'center', '700');
      if (px >= 12) this.label(F, m.kind === 'analog' ? 'analog' : 'exact', x + w / 2, y + 1.5, 0.28, 'rgba(255,255,255,0.45)', 'center');
      const param = (id) => { const ov = app.project.values[F.path + b.id + '#' + id], own = b.params && b.params[id]; return F.path && ov !== undefined ? ov : own !== undefined ? own : m.params.find((q) => q.id === id).def; };
      this.board(F);
      for (const q of lay.knobs) {
        const p = m.params.find((z) => z.id === q.id);
        this.drawPanelKnob(x + q.x * k, y + q.y * k, q.r * k, G.Analog.paramFrac(p, param(q.id)), p, px);
        if (b.type === 'seq8' && /^k\d$/.test(q.id)) {   // the sequencer's step lights
          const c = app.running, qi = c && c.qIndex[F.path + b.id + '#pos'];
          const pos = qi !== undefined && app.snap && app.snap.v ? app.snap.v[qi] || 0 : 0;
          ctx.fillStyle = Math.max(0, pos - 1) === Number(q.id.slice(1)) ? '#ff5a4a' : '#3a1d1d';
          ctx.beginPath(); ctx.arc(x + q.x * k, y + (q.y - q.r - 0.75) * k, 0.16, 0, 7); ctx.fill();
        }
        this.label(F, p.label, x + q.x * k, y + (q.y + q.r + 0.75) * k, 0.31, '#c3c8d4', 'center');
        this.board(F);
      }
      for (const dir of ['in', 'out']) {
        (dir === 'in' ? lay.ins : lay.outs).forEach((j, i) => {
          const port = (dir === 'in' ? m.ins : m.outs)[i];
          this.drawJack(x + j.x * k, y + j.y * k, j.r * k, px);
          this.label(F, port.label, x + j.x * k, y + (j.y - j.r - 0.45) * k, 0.3, dir === 'in' ? '#c3c8d4' : '#f2f4f8', 'center');
          if (dir === 'out') { this.board(F); this.drawLed(x + (j.x + j.r + 0.35) * k, y + (j.y - j.r - 0.15) * k, app.valueOf(F.path + G.ep(b.id, 'out', i))); }
          this.board(F);
        });
      }
    }
    drawPanelKnob(cx, cy, r, frac, p, px) {
      const ctx = this.ctx;
      frac = Math.min(1, Math.max(0, frac));
      ctx.fillStyle = '#16181d'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      ctx.lineWidth = Math.min(0.03, 1 / px); ctx.strokeStyle = '#5b6170'; ctx.stroke();
      if (px * r < 2) return;
      const a0 = Math.PI * 0.75, span = Math.PI * 1.5, a1 = a0 + span * frac;
      ctx.lineWidth = r * 0.18;
      ctx.strokeStyle = '#353a46'; ctx.beginPath(); ctx.arc(cx, cy, r * 1.22, a0, a0 + span); ctx.stroke();
      const mid = p.min < 0 && p.max > 0 ? a0 + span * G.Analog.paramFrac(p, 0) : a0;
      ctx.strokeStyle = '#f0a640'; ctx.beginPath(); ctx.arc(cx, cy, r * 1.22, Math.min(mid, a1), Math.max(mid, a1) + 0.001); ctx.stroke();
      ctx.lineWidth = r * 0.16; ctx.strokeStyle = '#eef0f5';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a1) * r * 0.25, cy + Math.sin(a1) * r * 0.25); ctx.lineTo(cx + Math.cos(a1) * r * 0.85, cy + Math.sin(a1) * r * 0.85); ctx.stroke();
    }
    drawJack(cx, cy, r, px) {
      const ctx = this.ctx;
      ctx.fillStyle = '#b9bec8'; ctx.beginPath();
      for (let n = 0; n < 6; n++) { const a = Math.PI / 6 + n * Math.PI / 3; ctx.lineTo(cx + Math.cos(a) * r * 1.12, cy + Math.sin(a) * r * 1.12); }
      ctx.closePath(); ctx.fill();
      if (px * r < 1.5) return;
      ctx.fillStyle = '#2b2f37'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, 0, 7); ctx.fill();
      ctx.fillStyle = '#050608'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.48, 0, 7); ctx.fill();
    }
    drawLed(cx, cy, v) {
      const ctx = this.ctx;
      let col = '#2a2d33';
      if (v !== undefined && Number.isFinite(v) && Math.abs(v) > 1e-3) {
        const a = Math.min(1, Math.abs(v) / 5);
        col = v > 0 ? `rgba(90,255,120,${0.25 + 0.75 * a})` : `rgba(255,80,70,${0.25 + 0.75 * a})`;
      } else if (v !== undefined && !Number.isFinite(v)) col = '#ff2bd6';
      ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(cx, cy, 0.15, 0, 7); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, 0.11, 0, 7); ctx.fill();
    }
    // Text in board units of frame F, drawn in screen pixels (tiny fonts under a scaled transform render badly).
    label(F, txt, x, y, size, color, align, weight) {
      const ctx = this.ctx, px = size * this.cam.z * F.sc;
      if (px < 4.5) return;
      const p = this.toScreen(F.ox + x * F.sc, F.oy + y * F.sc);
      this.screen();
      ctx.font = `${weight || '500'} ${Math.min(px, 40)}px system-ui, sans-serif`;
      ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, p.x, p.y);
    }

    // ---- fixed point: logic gates in their classic shapes ------------------------------------
    drawGate(F, b, fp, px, outline) {
      const ctx = this.ctx, app = this.app, t = G.info(b.type);
      const shape = b.type === 'split' || b.type === 'join' ? null : t;
      this.board(F);
      if (!shape) return this.drawFields(F, b, fp, px, outline);
      ctx.save();
      ctx.translate(b.x + fp.w / 2, b.y + fp.h / 2); ctx.rotate((b.rot || 0) * Math.PI / 2); ctx.translate(-t.w / 2, -t.h / 2);
      const lw = (w, maxPx) => Math.min(w, maxPx / px);
      const ins = t.ins.map(([x, y]) => [x + 0.5, y + 0.5]), outs = t.outs.map(([x, y]) => [x + 0.5, y + 0.5]);
      const ink = outline || '#e8ebf2', fill = '#15171c';
      ctx.lineWidth = lw(0.08, 2.5); ctx.strokeStyle = '#9aa1b2';
      // leads from the pins to the body
      const x0 = 0.9, x1 = t.w - 0.9, my = t.h / 2;
      ctx.beginPath();
      for (const [px0, py0] of ins) { ctx.moveTo(px0, py0); ctx.lineTo(x0 + 0.15, py0); }
      for (const [px0, py0] of outs) { ctx.moveTo(x1, py0); ctx.lineTo(px0, py0); }
      ctx.stroke();
      ctx.fillStyle = fill; ctx.strokeStyle = ink; ctx.lineWidth = lw(outline ? 0.12 : 0.08, outline ? 3 : 2);
      const top = b.type === 'not' ? my - 0.42 : 0.2, bot = b.type === 'not' ? my + 0.42 : t.h - 0.2;
      const inv = b.type === 'nand' || b.type === 'nor' || b.type === 'xnor' || b.type === 'not';
      const bx1 = inv ? x1 - 0.22 : x1;
      ctx.beginPath();
      if (b.type === 'and' || b.type === 'nand') {          // D shape
        const rr = (bot - top) / 2;
        ctx.moveTo(x0, top); ctx.lineTo(bx1 - rr, top); ctx.arc(bx1 - rr, my, rr, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x0, bot); ctx.closePath();
      } else if (b.type === 'or' || b.type === 'nor' || b.type === 'xor' || b.type === 'xnor') {   // shield
        const l = x0 + 0.05;
        ctx.moveTo(l, top); ctx.quadraticCurveTo(l + 0.55, top, bx1, my); ctx.quadraticCurveTo(l + 0.55, bot, l, bot);
        ctx.quadraticCurveTo(l + 0.32, my, l, top); ctx.closePath();
      } else if (b.type === 'not') {                       // triangle
        ctx.moveTo(x0, top); ctx.lineTo(bx1, my); ctx.lineTo(x0, bot); ctx.closePath();
      } else if (b.type === 'dff') {                       // a box with a clock wedge
        ctx.rect(x0, 0.15, x1 - x0, t.h - 0.3);
      }
      ctx.fill(); ctx.stroke();
      if (b.type === 'xor' || b.type === 'xnor') { ctx.beginPath(); ctx.moveTo(x0 - 0.15, top); ctx.quadraticCurveTo(x0 + 0.17, my, x0 - 0.15, bot); ctx.stroke(); }
      if (inv) { ctx.beginPath(); ctx.arc(bx1 + 0.11, my, 0.11, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.stroke(); }
      if (b.type === 'dff') {
        ctx.beginPath(); ctx.moveTo(x0, t.h - 0.85); ctx.lineTo(x0 + 0.3, t.h - 0.65); ctx.lineTo(x0, t.h - 0.45); ctx.stroke();
        ctx.restore();
        if (px >= 14) {
          const P = (lx, ly) => [b.x + lx, b.y + ly];   // dff is never rotated far from upright in practice; labels follow the unrotated frame
          if (!(b.rot & 3)) {
            this.label(F, 'D', ...P(x0 + 0.25, 0.5), 0.32, '#e8ebf2', 'left', '600');
            this.label(F, 'Q', ...P(x1 - 0.25, 0.5), 0.32, '#e8ebf2', 'right', '600');
            this.label(F, 'Q̄', ...P(x1 - 0.25, t.h - 0.5), 0.32, '#e8ebf2', 'right', '600');
          }
        }
        return;
      }
      ctx.restore();
      void app;
    }
    // Split and Join: a bus ripper, a heavy bar with one lead per field.
    drawFields(F, b, fp, px, outline) {
      const ctx = this.ctx, split = b.type === 'split';
      const barX = split ? b.x + 0.75 : b.x + 1.25;
      ctx.strokeStyle = '#9aa1b2'; ctx.lineWidth = Math.min(0.08, 2.5 / px);
      ctx.beginPath();
      for (const p of fp.pads) {
        const cy = p.y + 0.5;
        if (split && p.dir === 'out') { ctx.moveTo(barX, cy); ctx.lineTo(p.x + 0.5, cy); }
        if (!split && p.dir === 'in') { ctx.moveTo(p.x + 0.5, cy); ctx.lineTo(barX, cy); }
        if (split && p.dir === 'in') { ctx.moveTo(p.x + 0.5, cy); ctx.lineTo(barX, cy); }
        if (!split && p.dir === 'out') { ctx.moveTo(barX, cy); ctx.lineTo(p.x + 0.5, cy); }
      }
      ctx.stroke();
      ctx.fillStyle = outline || '#e8ebf2';
      ctx.fillRect(barX - 0.12, b.y + 0.15, 0.24, fp.h - 0.3);
      if (px >= 16) for (const p of fp.pads) if (p.name && (split ? p.dir === 'out' : p.dir === 'in')) this.label(F, p.name, split ? p.x + 0.55 : p.x + 0.45, p.y + 0.15, 0.26, '#9aa1b2', 'center');
    }

    // ---- converters: a chip half in one domain, half in the other -------------------------------
    drawConverter(F, b, fp, px, outline) {
      const ctx = this.ctx, m = G.MODULES[b.type], x = b.x, y = b.y, w = fp.w, h = fp.h;
      const tone = { float: '#3a2e18', fixed: '#e8e8e8', analog: '#1d3a44' };
      this.board(F);
      ctx.save(); roundRect(ctx, x + 0.25, y + 0.25, w - 0.5, h - 0.5, 0.3); ctx.clip();
      ctx.fillStyle = tone[m.ins[0].dom]; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = tone[m.outs[0].dom]; ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
      if (m.ins[0].dom === 'fixed' || m.outs[0].dom === 'fixed') {   // the fixed half as a little barcode
        const left = m.ins[0].dom === 'fixed';
        ctx.fillStyle = '#050506';
        for (let i = 0; i < 6; i++) if ((0b101101 >> i) & 1) ctx.fillRect(left ? x + 0.35 + i * 0.13 : x + w - 1.15 + i * 0.13, left ? y + 0.3 : y + h - 0.75, 0.08, 0.42);
      }
      ctx.restore();
      ctx.lineWidth = Math.min(outline ? 0.12 : 0.06, (outline ? 3 : 1.5) / px); ctx.strokeStyle = outline || '#8a90a0';
      roundRect(ctx, x + 0.25, y + 0.25, w - 0.5, h - 0.5, 0.3); ctx.stroke();
      const sym = m.sym, size = Math.min(0.62, 1.25 / Math.max(1.6, sym.length * 0.62));
      ctx.fillStyle = 'rgba(10,12,16,0.75)'; roundRect(ctx, x + w / 2 - size * sym.length * 0.31 - 0.1, y + h / 2 - size * 0.55, size * sym.length * 0.62 + 0.2, size * 1.1, 0.15); ctx.fill();
      this.label(F, sym, x + w / 2, y + h / 2, size, '#f2f4f8', 'center', '700');
    }

    // ---- sockets: the design's audio inputs and outputs ---------------------------------------------
    drawSocket(F, b, fp, px, outline) {
      const ctx = this.ctx, app = this.app, out = b.type === 'out', x = b.x, y = b.y, w = fp.w;
      this.board(F);
      ctx.fillStyle = '#1b2a22'; ctx.strokeStyle = outline || '#6fdc8c'; ctx.lineWidth = Math.min(outline ? 0.12 : 0.07, (outline ? 3 : 2) / px);
      ctx.beginPath();
      if (out) { ctx.moveTo(x + 0.55, y + 0.12); ctx.lineTo(x + w - 0.45, y + 0.12); ctx.lineTo(x + w - 0.05, y + 0.5); ctx.lineTo(x + w - 0.45, y + 0.88); ctx.lineTo(x + 0.55, y + 0.88); }
      else { ctx.moveTo(x + 0.05, y + 0.12); ctx.lineTo(x + w - 0.55, y + 0.12); ctx.lineTo(x + w - 0.55, y + 0.88); ctx.lineTo(x + 0.05, y + 0.88); ctx.lineTo(x + 0.45, y + 0.5); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      const c = app.running, list = c ? (out ? c.outs : c.ins) : [], i = list.findIndex((q) => q.path === F.path + b.id);
      this.label(F, (i >= 0 ? (i + 1) + ' · ' : '') + (b.name || b.type), x + w / 2 + (out ? 0.1 : -0.2), y + 0.5, 0.36, '#d8f5e0', 'center', '600');
      if (px >= 10) this.label(F, out ? 'OUT' : 'IN', out ? x + w - 0.3 : x + 0.3, y - 0.25, 0.26, '#6fdc8c', 'center', '700');
    }
    // A Bits constant: its word as a little barcode, and the number.
    drawBitsValue(F, b, p, px) {
      const ctx = this.ctx, w = Math.max(1, Math.min(32, b.width || 8)), v = this.app.valueOf(F.path + G.ep(b.id, 'out', 0));
      const val = v === undefined ? GW.word(b.value || 0, w) : v;
      const cx = p.x + px / 2, cy = p.y + px / 2;
      if (px < 6) { ctx.fillStyle = '#e8e8e8'; ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); return; }
      const sw = Math.max(1, Math.min(px * 0.14, 6)), bw = sw * w, h = Math.min(px * 0.8, 18);
      const x0 = cx - bw / 2;
      ctx.fillStyle = '#8a8f9c'; ctx.fillRect(x0 - 2, cy - h / 2 - 2, bw + 4, h + 4);
      for (let k = 0; k < w; k++) { ctx.fillStyle = Math.floor(val / Math.pow(2, w - 1 - k)) % 2 ? '#f4f4f4' : '#050506'; ctx.fillRect(x0 + k * sw, cy - h / 2, sw, h); }
      if (px >= 14) {
        ctx.font = `600 ${Math.min(12, px * 0.34)}px ui-monospace, monospace`; ctx.fillStyle = '#c3c8d4';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`${val} · ${w} bit${w === 1 ? '' : 's'}`, cx, cy + h / 2 + 4);
      }
    }

    // Placement ghost, the trace being routed, and the snap cursor.
    drawOverlay() {
      const app = this.app, ctx = this.ctx, h = app.hover, r = app.route, E = GW.Editor;
      const rectOf = (F, x0, y0, x1, y1) => {   // cells (inclusive) of frame F, on screen
        const a = this.toScreen(F.ox + Math.min(x0, x1) * F.sc, F.oy + Math.min(y0, y1) * F.sc);
        const b = this.toScreen(F.ox + (Math.max(x0, x1) + 1) * F.sc, F.oy + (Math.max(y0, y1) + 1) * F.sc);
        return [a.x, a.y, b.x - a.x, b.y - a.y];
      };
      // a dashed box around a selection of more than one thing
      const sel = app.sel;
      if (sel && E && E.count(sel) > 1 && !(app.drag && app.drag.kind === 'marquee')) {
        const bb = E.bounds(sel.F, app.project.defs, sel);
        if (bb) {
          const [x, y, w, hh] = rectOf(sel.F, bb.x0, bb.y0, bb.x1, bb.y1);
          ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(240,166,64,0.8)'; ctx.lineWidth = 1;
          ctx.strokeRect(x - 3, y - 3, w + 6, hh + 6); ctx.setLineDash([]);
        }
      }
      // the box being dragged out
      const d = app.drag;
      if (d && d.kind === 'marquee' && d.far) {
        const [x, y, w, hh] = rectOf(d.F, d.x0, d.y0, d.x1, d.y1);
        ctx.fillStyle = 'rgba(94,200,229,0.10)'; ctx.fillRect(x, y, w, hh);
        ctx.strokeStyle = '#5ec8e5'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
      }
      // what a paste would put down, green if it fits
      if (app.pasting && h && E) {
        const clip = app.pasting, o = app.pasteOrigin(h, clip);
        const ok = !E.pasteProblem(app.project, h.F, clip, o.x, o.y);
        ctx.fillStyle = ok ? 'rgba(111,220,140,0.22)' : 'rgba(255,80,80,0.25)';
        ctx.strokeStyle = ok ? '#6fdc8c' : '#ff6b6b'; ctx.lineWidth = 1.5;
        for (const b of clip.blocks) {
          const fp = G.footprint(Object.assign({}, b, { x: b.x + o.x, y: b.y + o.y }), app.project.defs);
          const [x, y, w, hh] = rectOf(h.F, b.x + o.x, b.y + o.y, b.x + o.x + fp.w - 1, b.y + o.y + fp.h - 1);
          ctx.fillRect(x, y, w, hh); ctx.strokeRect(x, y, w, hh);
        }
        for (const w of clip.wires || []) for (const [dx, dy] of w.path || []) {
          const [x, y, ww, hh] = rectOf(h.F, dx + o.x, dy + o.y, dx + o.x, dy + o.y);
          ctx.fillRect(x + ww * 0.35, y + hh * 0.35, ww * 0.3, hh * 0.3);
        }
      }
      // a wire being drawn: by dragging from a pin, or corner by corner with the Wire tool
      const wd = app.drag && app.drag.kind === 'wire' ? app.drag : r;
      if (wd && wd.preview && wd.preview.length) {
        this.board(wd.F);
        ctx.lineWidth = W_TOP; ctx.setLineDash([0.5, 0.35]);
        ctx.strokeStyle = wd.target ? '#6fdc8c' : '#f0a640';
        ctx.stroke(pathOf(wd.preview));
        ctx.setLineDash([]);
        this.screen();
      }
      // where a wire being dragged can go: every pin it can connect to is ringed, the one it would snap to filled
      const dw = app.drag && app.drag.kind === 'wire' ? app.drag : null;
      const ring = (F, x, y, color, fill) => {
        const q = this.toScreen(F.ox + x * F.sc, F.oy + y * F.sc), rr = Math.max(6, Math.min(14, this.cam.z * F.sc * 0.5));
        ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, 7);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      };
      if (dw && dw.cands) {
        for (const q of dw.cands) if (q.e !== dw.target) ring(dw.F, q.x, q.y, 'rgba(111,220,140,0.75)');
        const t = dw.target && dw.cands.find((q) => q.e === dw.target);
        if (t) ring(dw.F, t.x, t.y, '#6fdc8c', 'rgba(111,220,140,0.35)');
        if (!dw.cands.length && dw.at) {
          const q = this.toScreen(dw.F.ox + dw.at.x * dw.F.sc, dw.F.oy + dw.at.y * dw.F.sc);
          ctx.fillStyle = '#f0a640'; ctx.font = '12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText('nothing on this board to connect to', q.x + 12, q.y - 8);
        }
      }
      if (!h) return;
      const px = this.cam.z * h.F.sc;
      const S = (x, y) => this.toScreen(h.F.ox + x * h.F.sc, h.F.oy + y * h.F.sc);
      // a pin under the pointer: drag from it to wire
      const hp = !dw && !app.placing && !app.pasting && app.tool === 'select' && app.pinAt ? app.pinAt(h) : null;
      if (hp) {
        const p = G.pinOf(h.F.sheet, app.project.defs, hp), b = G.parseEp(hp).b, blk = h.F.sheet.blocks.find((x) => x.id === b);
        const x = blk && blk.type === 'comp' ? (p.dir === 'in' ? p.x : p.x + 1) : p.fx !== undefined ? p.fx : p.x + 0.5;
        ring(h.F, x, p.fy !== undefined ? p.fy : p.y + 0.5, '#f0a640');
      }
      if (app.placing) {
        const b = app.ghost(h);
        const fp = G.footprint(b, app.project.defs), p = S(b.x, b.y);
        const ok = G.canPlace(h.F.sheet, app.project.defs, b);
        ctx.fillStyle = ok ? 'rgba(240,166,64,0.2)' : 'rgba(255,80,80,0.25)';
        ctx.fillRect(p.x, p.y, fp.w * px, fp.h * px);
        ctx.strokeStyle = ok ? '#f0a640' : '#ff6b6b'; ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x, p.y, fp.w * px, fp.h * px);
        for (const q of fp.pads) { const s = S(q.x, q.y); ctx.strokeRect(s.x + px * 0.25, s.y + px * 0.25, px * 0.5, px * 0.5); }
      } else if (app.tool === 'route' && px >= 3) {
        const p = S(h.x + 0.5, h.y + 0.5);
        ctx.strokeStyle = '#f0a640'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, px * 0.3), 0, 7);
        ctx.moveTo(p.x - px * 0.6, p.y); ctx.lineTo(p.x + px * 0.6, p.y); ctx.moveTo(p.x, p.y - px * 0.6); ctx.lineTo(p.x, p.y + px * 0.6);
        ctx.stroke();
      }
    }
  }

  function shade(hex, pct) {
    const n = parseInt(hex.slice(1), 16), f = (c) => Math.max(0, Math.min(255, Math.round(c + 255 * pct / 100)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  root.GW = Object.assign(root.GW || {}, { View, colorOf, fmt, knobFrac, knobValue, POS, NEG, ENTER_PX });
})(typeof self !== 'undefined' ? self : this);
