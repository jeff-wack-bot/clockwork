// Board view: nets drawn as traces between pads, ICs as packages, composite ICs
// drawn with their own board inside. Geometry is cached as Path2D in board
// units, so a frame costs one stroke per net, at any zoom and nesting depth.
(function (root) {
  'use strict';
  const G = root.GW;

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
      this.resize();
      // follow the canvas's real size, whatever changes the layout (window, panels, embedding)
      new ResizeObserver(() => { this.resize(); this.dirty = true; }).observe(canvas);
      const loop = () => {
        this.animate();
        if (this.app.style && this.app.style.dir === 'flow' && this.app.host && this.app.host.running) this.dirty = true;
        if (this.dirty) { this.dirty = false; this.draw(); }
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
      return { sheet: def, def, path: F.path + b.id + '/', ox: F.ox + b.x * F.sc, oy: F.oy + b.y * F.sc, sc: F.sc / def.s, inst: b, parent: F, chain: F.chain.concat([b.def]) };
    }
    extent(F) {
      const sh = F.sheet;
      if (G.isDef(sh)) return { x0: F.ox, y0: F.oy, x1: F.ox + sh.fw * sh.s * F.sc, y1: F.oy + sh.fh * sh.s * F.sc };
      const g = this.geom(sh);
      return g.bbox || { x0: 0, y0: 0, x1: 30, y1: 20 };
    }

    // Everything about a board that only changes when it is edited.
    geom(sheet) {
      let g = this.cache.get(sheet);
      if (g && g.ver === this.app.version) return g;
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
      const dist = new Map(), far = new Map();
      for (const [rid, starts] of drivers) {
        const q = [];
        for (const [l, x, y] of starts) { const c = l + ':' + G.key(x, y); if (!dist.has(c)) { dist.set(c, 0); q.push([l, x, y]); } }
        let maxd = 0;
        for (let i = 0; i < q.length; i++) {
          const [l, x, y] = q[i], d = dist.get(l + ':' + G.key(x, y));
          maxd = Math.max(maxd, d);
          for (const [nl, nx, ny] of [[l, x + 1, y], [l, x - 1, y], [l, x, y + 1], [l, x, y - 1], [l === G.TOP ? G.BOT : G.TOP, x, y]]) {
            const c = nl + ':' + G.key(nx, ny);
            if (sheet[nl][G.key(nx, ny)] !== rid || dist.has(c)) continue;
            dist.set(c, d + 1); q.push([nl, nx, ny]);
          }
        }
        far.set(rid, maxd);
      }
      const traces = { top: new Map(), bot: new Map() };
      const taper = { top: new Map(), bot: new Map() };   // rid -> 4 paths, thick near the driver
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
            taper[layer].set(rid, [new Path2D(), new Path2D(), new Path2D(), new Path2D()]);
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
            const bucket = d === undefined ? 1 : Math.min(3, Math.floor(4 * d / (far.get(rid) + 1)));
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
      g = { ver: this.app.version, occ, blocks, traces, taper, chevrons, junctions, driven: new Set(drivers.keys()), all, vias, pads, anchors,
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
        if (b && b.type === 'comp' && defs[b.def] && this.cam.z * F.sc / defs[b.def].s >= ENTER_PX) { F = this.child(F, b); continue; }
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
      this.drawOverlay();
    }

    // Draw in board units of frame F.
    board(F) {
      const s = this.dpr * this.cam.z * F.sc;
      this.ctx.setTransform(s, 0, 0, s, this.dpr * ((F.ox - this.cam.x) * this.cam.z + this.W / 2), this.dpr * ((F.oy - this.cam.y) * this.cam.z + this.H / 2));
    }
    screen() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

    drawBoard(F) {
      const ctx = this.ctx, app = this.app, sh = F.sheet, px = this.cam.z * F.sc;
      const g = this.geom(sh);
      const val = (rid) => app.valueOf(F.path + rid);
      const hot = app.hotRegion && app.hotRegion.path === F.path ? app.hotRegion.rid : null;
      const sel = app.sel && app.sel.kind === 'region' && app.sel.path === F.path ? app.sel : null;
      const botActive = app.layer === G.BOT;
      // trace widths are in board units, capped in pixels so an outer board's
      // traces don't swamp the inner board you have zoomed into
      const cap = (w, maxPx) => Math.min(w, maxPx / px);
      const wTop = cap(W_TOP, 10), wBot = cap(W_BOT, 6), wCase = cap(W_CASE, 15);

      this.board(F);
      if (G.isDef(sh)) {
        ctx.fillStyle = '#171a20';
        ctx.fillRect(0, 0, sh.fw * sh.s, sh.fh * sh.s);
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
        if (style.dir === 'taper') {
          g.taper[layer].get(rid).forEach((tp, k) => { ctx.lineWidth = width * (1.5 - 0.3 * k); ctx.stroke(tp); });
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
        for (const rid of g.traces[layer].keys()) { ctx.strokeStyle = colorOf(val(rid)); strokeNet(layer, rid, width); }
        ctx.globalAlpha = 1;
      };
      const highlight = (layer, width) => {
        for (const [rid, color] of [[hot, 'rgba(255,255,255,0.55)'], [sel && sel.id, '#f0a640']]) {
          const p = rid && g.traces[layer].get(rid);
          if (p) { ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(p); }
        }
      };
      highlight(G.BOT, wBot + cap(0.2, 6));
      registers(G.BOT, wBot);
      strokeLayer(G.BOT, wBot, botActive ? 1 : 0.6);

      // packages (and the boards inside composite ICs)
      for (const { b, fp } of g.blocks) this.drawPackage(F, b, fp, px);

      // top layer: dark casing, then the coloured copper
      this.board(F);
      ctx.globalAlpha = botActive ? 0.35 : 1;
      highlight(G.TOP, wCase + cap(0.16, 5));
      registers(G.TOP, wCase);
      ctx.strokeStyle = '#08090c';
      if (style.dir === 'taper') for (const rid of g.traces.top.keys()) strokeNet(G.TOP, rid, wCase);
      else { ctx.lineWidth = wCase; ctx.stroke(g.all.top); }
      strokeLayer(G.TOP, wTop, botActive ? 0.35 : 1);
      ctx.globalAlpha = 1;
      if (botActive) strokeLayer(G.BOT, wBot, 0.9);
      this.drawDirection(F, g, px, wTop, wBot, cap);
      this.drawJunctions(F, g, px, wTop, cap);
      if (sel && sel.run && sel.run.length) {
        ctx.lineWidth = wTop * 0.45; ctx.strokeStyle = '#ffffff';
        ctx.stroke(pathOf(sel.run.map(([, x, y]) => [x, y])));
      }

      // pads and vias
      if (px >= 2.5) {
        ctx.lineWidth = cap(0.08, 2);
        for (const [x, y, o] of g.pads) {
          if (style.ops !== 'chip' && o.block && G.ATOMS[o.block.type]) continue;
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
      for (const rid in sh.regions) {
        const kb = sh.regions[rid].knob;
        if (kb) { const p = S(kb.x, kb.y); if (onScreen(p, px)) this.drawKnob(F, rid, sh.regions[rid], p, px); }
      }
      if (px >= 18) {
        ctx.font = `600 ${Math.min(14, px * 0.36)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const rid in g.anchors) {
          if (!sh.regions[rid]) continue;
          const [x, y] = g.anchors[rid], p = S(x, y);
          if (!onScreen(p, 50)) continue;
          const s = fmt(val(rid)), ty = sh.regions[rid].knob ? p.y + px * 1.15 : p.y + px / 2;
          const w = ctx.measureText(s).width + 6;
          ctx.fillStyle = 'rgba(10,10,14,0.7)'; ctx.fillRect(p.x + px / 2 - w / 2, ty - 8, w, 16);
          ctx.fillStyle = '#f2f4f8'; ctx.fillText(s, p.x + px / 2, ty);
        }
      }
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
      const ctx = this.ctx, app = this.app, sh = F.sheet, t = G.ATOMS[b.type], via = app.style.ops === 'via';
      const val = (p) => { const rid = sh.top[G.key(p.x, p.y)]; return rid ? app.valueOf(F.path + rid) : undefined; };
      const ins = fp.pads.filter((p) => p.dir === 'in'), outs = fp.pads.filter((p) => p.dir === 'out');
      // work in the block's own, unrotated frame
      this.board(F);
      ctx.translate(b.x + fp.w / 2, b.y + fp.h / 2); ctx.rotate((b.rot || 0) * Math.PI / 2); ctx.translate(-t.w / 2, -t.h / 2);
      const mx = t.w / 2, my = t.h / 2;
      const lw = (w, maxPx) => Math.min(w, maxPx / px);
      const leadW = via ? lw(W_TOP, 10) : lw(0.11, 3);
      const R = via ? 0.42 : b.type === 'delay' ? 0.42 : 0.72;
      const lead = (pts, v) => {
        if (via) {   // traces running into the via, with the usual casing
          ctx.strokeStyle = '#08090c'; ctx.lineWidth = lw(W_CASE, 15);
          ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        }
        ctx.strokeStyle = colorOf(v); ctx.lineWidth = leadW;
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      };
      t.ins.forEach(([lx, ly], i) => lead([[lx + 0.5, ly + 0.5], [mx - R - 0.1, ly + 0.5], [mx, my]], val(ins[i])));
      t.outs.forEach(([lx, ly], i) => lead([[mx, my], [lx + 0.5, ly + 0.5]], val(outs[i])));
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
      } else ctx.arc(mx, my, R, 0, 7);     // summing junction / multiplier: a circle
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = glyph; ctx.lineWidth = lw(via ? 0.07 : 0.08, 2.5);
      ctx.beginPath();
      const g = R * 0.55;
      if (b.type === 'add') { ctx.moveTo(mx - g, my); ctx.lineTo(mx + g, my); ctx.moveTo(mx, my - g); ctx.lineTo(mx, my + g); }
      if (b.type === 'mul') { const q = g * 0.75; ctx.moveTo(mx - q, my - q); ctx.lineTo(mx + q, my + q); ctx.moveTo(mx + q, my - q); ctx.lineTo(mx - q, my + q); }
      if (b.type === 'delay') { ctx.moveTo(mx - R * 0.35, my + R * 0.8); ctx.lineTo(mx, my + R * 0.35); ctx.lineTo(mx + R * 0.35, my + R * 0.8); }
      ctx.stroke();
      if (px * (via ? 0.25 : 0.4) >= 6) {
        // small text marks: + and − on the comparator, 1 and 0 on the switch, z⁻¹ on the flip-flop
        ctx.fillStyle = glyph; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const f = via ? 0.28 : 0.32;
        ctx.font = `600 ${f}px ui-monospace, monospace`;
        if (b.type === 'gt') { ctx.fillText('+', mx - R * 0.35, my - R * 0.45); ctx.fillText('−', mx - R * 0.35, my + R * 0.45); }
        if (b.type === 'switch') { const h0 = via ? 0.3 : 0.7; ctx.fillText('1', mx - 0.15, my - h0); ctx.fillText('0', mx - 0.15, my + h0); }
        if (b.type === 'delay' && !via) ctx.fillText('z⁻¹', mx, my - 0.06);
      }
    }

    drawPackage(F, b, fp, px) {
      const ctx = this.ctx, app = this.app, defs = app.project.defs;
      const a = this.toScreen(F.ox + b.x * F.sc, F.oy + b.y * F.sc), w = fp.w * px, h = fp.h * px;
      if (a.x > this.W || a.y > this.H || a.x + w < 0 || a.y + h < 0) return;
      const selected = app.sel && app.sel.kind === 'block' && app.sel.path === F.path && app.sel.id === b.id;
      const problem = app.compiled && app.compiled.problemPaths.includes(F.path + b.id);
      const outline = problem ? '#ff6b6b' : selected ? '#f0a640' : null;
      this.board(F);
      if (b.type === 'comp') {
        const def = defs[b.def];
        ctx.fillStyle = '#15181e'; ctx.fillRect(b.x, b.y, fp.w, fp.h);
        // pins straddling the package edge
        ctx.fillStyle = '#c9a35b';
        for (const p of fp.pads) ctx.fillRect(p.dir === 'in' ? p.x - 0.12 : p.x + 0.88, p.y + 0.3, 0.24, 0.4);
        if (def && px / def.s >= MIN_INNER) {
          ctx.save(); ctx.beginPath(); ctx.rect(b.x, b.y, fp.w, fp.h); ctx.clip();
          this.drawBoard(this.child(F, b));
          ctx.restore();
          this.board(F);
        }
        ctx.lineWidth = Math.min(outline ? 0.08 : 0.05, (outline ? 3 : 1.5) / px); ctx.strokeStyle = outline || '#7a6640';
        ctx.strokeRect(b.x, b.y, fp.w, fp.h);
        this.screen();
        if (px >= 3) {
          const ipx = def ? px / def.s : 0;
          ctx.fillStyle = '#f0a640'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
          ctx.font = `600 ${Math.max(9, Math.min(16, px * 0.45))}px system-ui`;
          ctx.fillText(b.def + (ipx >= ENTER_PX ? '' : '  ' + b.id), a.x, a.y - 2);
        }
        return;
      }
      const t = G.info(b.type);
      if (G.ATOMS[b.type] && app.style.ops !== 'chip') { this.drawOp(F, b, fp, px, outline); this.screen(); return; }
      ctx.fillStyle = b.type === 'delay' ? '#1f2d40' : G.SINKS[b.type] ? '#2e2333' : '#242833';
      ctx.fillRect(b.x + 0.12, b.y + 0.12, fp.w - 0.24, fp.h - 0.24);
      ctx.lineWidth = Math.min(outline ? 0.1 : 0.05, (outline ? 3 : 1.5) / px); ctx.strokeStyle = outline || '#59607a';
      ctx.strokeRect(b.x + 0.12, b.y + 0.12, fp.w - 0.24, fp.h - 0.24);
      if (b.type === 'scope') { this.screen(); this.drawScope(F, b, a, w, h, px); return; }
      this.screen();
      if (px >= 5) {
        ctx.fillStyle = b.type === 'delay' ? '#5ec8e5' : '#f0a640';
        ctx.font = `600 ${Math.min(px * 1.1, h * 0.7)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.sym, a.x + w / 2 + (fp.w === 3 ? px * 0.25 : 0), a.y + h / 2);
      }
      if (px >= 16) {
        ctx.fillStyle = '#9aa1b2'; ctx.font = `${Math.min(12, px * 0.3)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const p of fp.pads) if (p.name) { const q = this.toScreen(F.ox + p.x * F.sc, F.oy + p.y * F.sc); ctx.fillText(p.name, q.x + px / 2, q.y + px * 0.8); }
      }
    }

    drawKnob(F, rid, reg, p, px) {
      const ctx = this.ctx, k = reg.knob, st = this.app.knobState(F.path + rid);
      const cx = p.x + px / 2, cy = p.y + px / 2;
      if (px < 7) { ctx.fillStyle = st === 'ok' ? '#f0a640' : '#6b7080'; ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); return; }
      const v = this.app.valueOf(F.path + rid);
      const frac = knobFrac(k, v === undefined ? reg.value : v);
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
      if (px >= 16 && k.label) {
        ctx.fillStyle = st === 'ok' ? '#ffd28a' : '#8a90a0'; ctx.font = `${Math.min(13, px * 0.32)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(k.label + (st === 'overridden' ? ' (set outside)' : st === 'written' ? ' (written)' : ''), cx, p.y - 1);
      }
    }

    drawScope(F, b, a, w, h, px) {
      const ctx = this.ctx, app = this.app;
      const k = app.running ? app.running.scopePaths.indexOf(F.path + b.id) : -1;
      const data = k >= 0 && app.snap && app.snap.scopes ? app.snap.scopes[k] : null;
      const x0 = a.x + px * 1.2, x1 = a.x + w - px * 0.4, y0 = a.y + px * 0.4, y1 = a.y + h - px * 0.4;
      ctx.fillStyle = '#0d1310'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (!data || !data.length || px < 3) return;
      let start = 0, len = data.length, lo = Infinity, hi = -Infinity;
      for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (app.host.rate >= 2000) {
        len = Math.floor(data.length / 2); start = len;
        const mid = (lo + hi) / 2;
        for (let j = 1; j < len; j++) if (data[j - 1] < mid && data[j] >= mid) { start = j; break; }
        lo = Infinity; hi = -Infinity;
        for (let j = start; j < start + len; j++) { if (data[j] < lo) lo = data[j]; if (data[j] > hi) hi = data[j]; }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      const X = (j) => x0 + 2 + (x1 - x0 - 4) * j / Math.max(1, len - 1);
      const Y = (v) => y1 - 3 - (y1 - y0 - 6) * (v - lo) / (hi - lo);
      ctx.strokeStyle = '#6fdc8c'; ctx.lineWidth = 1.3; ctx.beginPath();
      const stride = Math.max(1, Math.floor(len / Math.max(16, x1 - x0)));  // about one point per pixel
      for (let j = 0; j < len; j += stride) { const x = X(j), y = Y(data[start + j]); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      if (px >= 8) {
        ctx.fillStyle = '#6d8a75'; ctx.font = `${Math.min(11, px * 0.4)}px ui-monospace, monospace`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(fmt(hi), x0 + 3, y0 + 2);
        ctx.textBaseline = 'bottom'; ctx.fillText(fmt(lo), x0 + 3, y1 - 2);
      }
    }

    // Placement ghost, the trace being routed, and the snap cursor.
    drawOverlay() {
      const app = this.app, ctx = this.ctx, h = app.hover, r = app.route;
      if (r && r.preview) {
        this.board(r.F);
        ctx.lineWidth = r.layer === G.TOP ? W_TOP : W_BOT;
        ctx.setLineDash([0.5, 0.35]);
        const ok = r.preview.cells.slice(0, r.preview.good + 1), bad = r.preview.cells.slice(r.preview.good);
        ctx.strokeStyle = r.layer === G.TOP ? '#f0a640' : '#5ec8e5'; ctx.stroke(pathOf(ok));
        if (bad.length > 1) { ctx.strokeStyle = '#ff6b6b'; ctx.stroke(pathOf(bad)); }
        ctx.setLineDash([]);
        this.screen();
      }
      if (!h) return;
      const px = this.cam.z * h.F.sc;
      const S = (x, y) => this.toScreen(h.F.ox + x * h.F.sc, h.F.oy + y * h.F.sc);
      if (app.placing) {
        const b = app.ghost(h);
        const fp = G.footprint(b, app.project.defs), p = S(b.x, b.y);
        const ok = G.canPlace(h.F.sheet, app.project.defs, b);
        ctx.fillStyle = ok ? 'rgba(240,166,64,0.2)' : 'rgba(255,80,80,0.25)';
        ctx.fillRect(p.x, p.y, fp.w * px, fp.h * px);
        ctx.strokeStyle = ok ? '#f0a640' : '#ff6b6b'; ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x, p.y, fp.w * px, fp.h * px);
        for (const q of fp.pads) { const s = S(q.x, q.y); ctx.strokeRect(s.x + px * 0.25, s.y + px * 0.25, px * 0.5, px * 0.5); }
      } else if ((app.tool === 'route' || app.tool === 'erase') && px >= 3) {
        const p = S(h.x + 0.5, h.y + 0.5);
        ctx.strokeStyle = app.layer === G.BOT ? '#5ec8e5' : '#f0a640'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, px * 0.3), 0, 7);
        ctx.moveTo(p.x - px * 0.6, p.y); ctx.lineTo(p.x + px * 0.6, p.y); ctx.moveTo(p.x, p.y - px * 0.6); ctx.lineTo(p.x, p.y + px * 0.6);
        ctx.stroke();
      }
    }
  }

  root.GW = Object.assign(root.GW || {}, { View, colorOf, fmt, knobFrac, knobValue, POS, NEG, ENTER_PX });
})(typeof self !== 'undefined' ? self : this);
