// Canvas view of the grid: camera, recursive drawing of composites, hit-testing.
(function (root) {
  'use strict';
  const G = root.GW;

  const OPEN_PX = 9;      // inner cells this big (px) or bigger: you are "inside" the block
  const LID_FULL = 2.5;   // below this the lid is opaque

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
    if (v === undefined) return '#3a3f4d';
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

  class View {
    constructor(app, canvas) {
      this.app = app; this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.cam = { x: 20, y: 10, z: 24 };
      this.target = { x: 20, y: 10, z: 24 };
      this.anchor = null;
      this.dirty = true;
      this.cache = new WeakMap();
      this.resize();
      window.addEventListener('resize', () => { this.resize(); this.dirty = true; });
      const loop = () => { this.animate(); if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
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
    fitAll() {
      const b = this.extent(this.rootFrame());
      this.fitRect(b.x0, b.y0, b.x1, b.y1);
    }
    animate() {
      const c = this.cam, t = this.target;
      const lz = Math.log(c.z), ltz = Math.log(t.z);
      if (Math.abs(lz - ltz) < 1e-3 && (this.anchor || (Math.abs(c.x - t.x) * c.z < 0.3 && Math.abs(c.y - t.y) * c.z < 0.3))) {
        if (c.z !== t.z) { c.z = t.z; this.dirty = true; }
        if (this.anchor) { this.anchorTo(); this.anchor = null; t.x = c.x; t.y = c.y; }
        return;
      }
      const k = 0.22;
      c.z = Math.exp(lz + (ltz - lz) * k);
      if (this.anchor) this.anchorTo();
      else {
        // move in screen space so the zoom and the pan feel like one motion
        c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k;
      }
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
      const sh = F.sheet, defs = this.app.project.defs;
      if (G.isDef(sh)) return { x0: F.ox, y0: F.oy, x1: F.ox + sh.fw * sh.s * F.sc, y1: F.oy + sh.fh * sh.s * F.sc };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
      for (const b of sh.blocks) { const fp = G.footprint(b, defs); add(b.x, b.y, fp.w, fp.h); }
      for (const l of [G.TOP, G.BOT]) for (const k in sh[l]) { const [x, y] = G.unkey(k); add(x, y, 1, 1); }
      if (x0 === Infinity) return { x0: 0, y0: 0, x1: 30, y1: 20 };
      return { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 };
    }
    // Parsed cells, occupancy and label anchors of a sheet, cached per edit version.
    info(sheet) {
      let c = this.cache.get(sheet);
      if (c && c.ver === this.app.version) return c;
      const parse = (layer) => Object.entries(sheet[layer]).map(([k, rid]) => { const [x, y] = G.unkey(k); return [x, y, rid]; });
      const top = parse(G.TOP), bot = parse(G.BOT);
      const anchors = {};
      for (const [x, y, rid] of top.concat(bot)) {
        const a = anchors[rid];
        if (!a || y < a[1] || (y === a[1] && x < a[0])) anchors[rid] = [x, y];
      }
      for (const rid in sheet.regions) { const kb = sheet.regions[rid].knob; if (kb) anchors[rid] = [kb.x, kb.y]; }
      c = { ver: this.app.version, top, bot, anchors, occ: G.occupancy(sheet, this.app.project.defs) };
      this.cache.set(sheet, c);
      return c;
    }

    // Deepest frame under a screen point: zooming in far enough means being inside.
    locate(sx, sy) {
      const w = this.toWorld(sx, sy), defs = this.app.project.defs;
      let F = this.rootFrame();
      for (let depth = 0; depth < 12; depth++) {
        const fx = (w.x - F.ox) / F.sc, fy = (w.y - F.oy) / F.sc;
        const x = Math.floor(fx), y = Math.floor(fy);
        const o = this.info(F.sheet).occ.get(G.key(x, y));
        const b = o && o.block;
        if (b && b.type === 'comp' && defs[b.def] && this.cam.z * F.sc / defs[b.def].s >= OPEN_PX) { F = this.child(F, b); continue; }
        return { F, x, y, fx, fy, occ: o };
      }
      return null;
    }

    // ---- drawing ---------------------------------------------------------------
    draw() {
      if (!this.app.project) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#121419'; ctx.fillRect(0, 0, this.W, this.H);
      this.drawSheet(this.rootFrame());
      this.drawOverlay();
    }

    drawSheet(F) {
      const ctx = this.ctx, app = this.app, sh = F.sheet, z = this.cam.z, px = z * F.sc;
      const inf = this.info(sh);
      const S = (x, y) => this.toScreen(F.ox + x * F.sc, F.oy + y * F.sc);
      const tl = this.toWorld(0, 0), br = this.toWorld(this.W, this.H);
      const vx0 = Math.floor((tl.x - F.ox) / F.sc) - 1, vy0 = Math.floor((tl.y - F.oy) / F.sc) - 1;
      const vx1 = Math.ceil((br.x - F.ox) / F.sc) + 1, vy1 = Math.ceil((br.y - F.oy) / F.sc) + 1;
      const vis = (x, y) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
      const val = (rid) => app.valueOf(F.path + rid);
      const hot = app.hotRegion && app.hotRegion.path === F.path ? app.hotRegion.rid : null;
      const selR = app.sel && app.sel.kind === 'region' && app.sel.path === F.path ? app.sel.id : null;
      const botActive = app.layer === G.BOT;

      // background and grid
      const bd = G.bounds(sh);
      if (bd) {
        const a = S(bd.x0, bd.y0), b = S(bd.x1 + 1, bd.y1 + 1);
        ctx.fillStyle = '#171a21'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      }
      if (px >= 7) {
        const gx0 = bd ? Math.max(vx0, bd.x0) : vx0, gx1 = bd ? Math.min(vx1, bd.x1 + 1) : vx1;
        const gy0 = bd ? Math.max(vy0, bd.y0) : vy0, gy1 = bd ? Math.min(vy1, bd.y1 + 1) : vy1;
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.06, (px - 7) / 200 + 0.025)})`; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = gx0; x <= gx1; x++) { const a = S(x, gy0), b = S(x, gy1); ctx.moveTo(Math.round(a.x) + 0.5, a.y); ctx.lineTo(Math.round(b.x) + 0.5, b.y); }
        for (let y = gy0; y <= gy1; y++) { const a = S(gx0, y), b = S(gx1, y); ctx.moveTo(a.x, Math.round(a.y) + 0.5); ctx.lineTo(b.x, Math.round(b.y) + 0.5); }
        ctx.stroke();
      }

      const drawBottom = (alpha) => {
        ctx.globalAlpha = alpha;
        const inset = 0.28;
        for (const [x, y, rid] of inf.bot) {
          if (!vis(x, y)) continue;
          const p = S(x, y);
          ctx.fillStyle = colorOf(val(rid));
          ctx.fillRect(p.x + px * inset, p.y + px * inset, px * (1 - 2 * inset), px * (1 - 2 * inset));
          if (sh.bot[G.key(x + 1, y)] === rid) ctx.fillRect(p.x + px * (1 - inset), p.y + px * inset, px * 2 * inset, px * (1 - 2 * inset));
          if (sh.bot[G.key(x, y + 1)] === rid) ctx.fillRect(p.x + px * inset, p.y + px * (1 - inset), px * (1 - 2 * inset), px * 2 * inset);
          if (rid === hot || rid === selR) {
            ctx.strokeStyle = rid === selR ? '#f0a640' : '#ffffff'; ctx.lineWidth = 1;
            ctx.strokeRect(p.x + px * inset, p.y + px * inset, px * (1 - 2 * inset), px * (1 - 2 * inset));
          }
        }
        ctx.globalAlpha = 1;
      };
      drawBottom(botActive ? 0.9 : 0.55);

      // blocks
      for (const b of sh.blocks) this.drawBlock(F, b, S, px);

      // Pads of composites whose interior is showing: the outer region fades out
      // there with the lid, so the wire visibly continues inside.
      const padFade = new Map();
      for (const b of sh.blocks) {
        if (b.type !== 'comp' || !app.project.defs[b.def]) continue;
        const lid = this.lidAlpha(px / app.project.defs[b.def].s);
        if (lid < 1) for (const p of G.footprint(b, app.project.defs).pads) padFade.set(G.key(p.x, p.y), lid);
      }

      // top layer: filled cells; region boundaries drawn as darker edges
      const topAlpha = botActive ? 0.35 : 1;
      ctx.globalAlpha = topAlpha;
      const g = Math.max(0.5, px * 0.06);
      for (const [x, y, rid] of inf.top) {
        if (!vis(x, y)) continue;
        const p = S(x, y);
        const fade = padFade.get(G.key(x, y));
        ctx.globalAlpha = fade === undefined ? topAlpha : topAlpha * fade;
        ctx.fillStyle = colorOf(val(rid));
        ctx.fillRect(p.x + g, p.y + g, px - 2 * g, px - 2 * g);
        if (sh.top[G.key(x + 1, y)] === rid) ctx.fillRect(p.x + px - g, p.y + g, 2 * g, px - 2 * g);
        if (sh.top[G.key(x, y + 1)] === rid) ctx.fillRect(p.x + g, p.y + px - g, px - 2 * g, 2 * g);
      }
      ctx.globalAlpha = topAlpha;
      if (px >= 4) {
        // outline every region so neighbouring registers stay distinguishable
        ctx.lineWidth = Math.max(1, px * 0.05);
        for (const [x, y, rid] of inf.top) {
          if (!vis(x, y) || padFade.has(G.key(x, y))) continue;
          const p = S(x, y);
          const strong = rid === hot || rid === selR;
          ctx.strokeStyle = rid === selR ? '#f0a640' : strong ? '#ffffff' : 'rgba(0,0,0,0.55)';
          ctx.beginPath();
          if (sh.top[G.key(x, y - 1)] !== rid) { ctx.moveTo(p.x + g, p.y + g); ctx.lineTo(p.x + px - g, p.y + g); }
          if (sh.top[G.key(x, y + 1)] !== rid) { ctx.moveTo(p.x + g, p.y + px - g); ctx.lineTo(p.x + px - g, p.y + px - g); }
          if (sh.top[G.key(x - 1, y)] !== rid) { ctx.moveTo(p.x + g, p.y + g); ctx.lineTo(p.x + g, p.y + px - g); }
          if (sh.top[G.key(x + 1, y)] !== rid) { ctx.moveTo(p.x + px - g, p.y + g); ctx.lineTo(p.x + px - g, p.y + px - g); }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (botActive) drawBottom(0.75);

      // pads (drawn over regions so connections are visible), vias, inner ports
      if (px >= 3) {
        ctx.lineWidth = Math.max(1, px * 0.07);
        for (const [k, o] of inf.occ) {
          if (!o.pad || padFade.get(k) < 0.5) continue;
          const [x, y] = G.unkey(k);
          if (!vis(x, y)) continue;
          const p = S(x, y), r = px * 0.22;
          ctx.strokeStyle = sh.top[k] ? 'rgba(255,255,255,0.85)' : '#8b93a7';
          ctx.strokeRect(p.x + px / 2 - r, p.y + px / 2 - r, 2 * r, 2 * r);
          if (o.port && px >= 10) {
            ctx.fillStyle = '#9fd6a8'; ctx.font = `${Math.min(14, px * 0.45)}px system-ui`;
            ctx.textAlign = o.pad.dir === 'in' ? 'left' : 'right'; ctx.textBaseline = 'bottom';
            ctx.fillText((o.pad.dir === 'in' ? '▶ ' : '') + o.pad.name + (o.pad.dir === 'out' ? ' ▶' : ''), o.pad.dir === 'in' ? p.x : p.x + px, p.y - 1);
          }
        }
        for (const [x, y, rid] of inf.top) {
          if (sh.bot[G.key(x, y)] !== rid || !vis(x, y)) continue;
          const p = S(x, y);
          ctx.strokeStyle = '#e8ebf2'; ctx.lineWidth = Math.max(1, px * 0.08);
          ctx.beginPath(); ctx.arc(p.x + px / 2, p.y + px / 2, px * 0.2, 0, 7); ctx.stroke();
        }
      }

      // knobs and value labels
      for (const rid in sh.regions) {
        const reg = sh.regions[rid];
        if (reg.knob && vis(reg.knob.x, reg.knob.y)) this.drawKnob(F, rid, reg, S(reg.knob.x, reg.knob.y), px);
      }
      if (px >= 20) {
        ctx.font = `600 ${Math.min(16, px * 0.36)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const rid in inf.anchors) {
          const [x, y] = inf.anchors[rid];
          if (!vis(x, y) || !sh.regions[rid] || padFade.get(G.key(x, y)) < 0.5) continue;
          const kb = sh.regions[rid].knob;
          const p = S(x, y), v = val(rid);
          const ty = kb ? p.y + px * 1.15 : p.y + px / 2;
          const s = fmt(v);
          ctx.fillStyle = 'rgba(10,10,14,0.65)';
          const w = ctx.measureText(s).width + 6;
          ctx.fillRect(p.x + px / 2 - w / 2, ty - px * 0.22, w, px * 0.44);
          ctx.fillStyle = '#f2f4f8'; ctx.fillText(s, p.x + px / 2, ty);
        }
      }
    }

    // 1 = closed chip, 0 = fully open, in terms of the size of an inner cell
    lidAlpha(ipx) { return ipx < LID_FULL ? 1 : ipx >= OPEN_PX ? 0 : 1 - (ipx - LID_FULL) / (OPEN_PX - LID_FULL); }

    drawKnob(F, rid, reg, p, px) {
      const ctx = this.ctx, k = reg.knob, st = this.app.knobState(F.path + rid);
      const cx = p.x + px / 2, cy = p.y + px / 2;
      if (px < 7) { ctx.fillStyle = st === 'ok' ? '#f0a640' : '#6b7080'; ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); return; }
      const v = this.app.valueOf(F.path + rid);
      const frac = knobFrac(k, v === undefined ? reg.value : v);
      const r = px * 0.42;
      ctx.fillStyle = '#1e2129'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      ctx.lineWidth = Math.max(1.5, px * 0.09); ctx.lineCap = 'round';
      const a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * Math.min(1, Math.max(0, frac));
      ctx.strokeStyle = '#3a3f4d'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, a0, a0 + Math.PI * 1.5); ctx.stroke();
      ctx.strokeStyle = st === 'ok' ? '#f0a640' : '#6b7080';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, a0, Math.max(a0 + 0.01, a1)); ctx.stroke();
      ctx.strokeStyle = '#e8ebf2'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a1) * r * 0.6, cy + Math.sin(a1) * r * 0.6); ctx.stroke();
      if (st === 'written') {
        ctx.strokeStyle = '#ff6b6b'; ctx.beginPath();
        ctx.moveTo(cx - r * 0.6, cy - r * 0.6); ctx.lineTo(cx + r * 0.6, cy + r * 0.6);
        ctx.moveTo(cx + r * 0.6, cy - r * 0.6); ctx.lineTo(cx - r * 0.6, cy + r * 0.6); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      if (px >= 16 && k.label) {
        ctx.fillStyle = st === 'ok' ? '#ffd28a' : '#8a90a0'; ctx.font = `${Math.min(13, px * 0.32)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(k.label + (st === 'overridden' ? ' (set outside)' : st === 'written' ? ' (written)' : ''), cx, p.y - 1);
      }
    }

    drawBlock(F, b, S, px) {
      const ctx = this.ctx, app = this.app, defs = app.project.defs;
      const fp = G.footprint(b, defs);
      const a = S(b.x, b.y), w = fp.w * px, h = fp.h * px;
      if (a.x > this.W || a.y > this.H || a.x + w < 0 || a.y + h < 0) return;
      const sel = app.sel && app.sel.kind === 'block' && app.sel.path === F.path && app.sel.id === b.id;
      const problem = app.compiled && app.compiled.problemPaths.includes(F.path + b.id);
      const inset = Math.min(2, px * 0.08);
      if (b.type === 'comp') {
        const def = defs[b.def];
        ctx.fillStyle = '#191c24'; ctx.fillRect(a.x, a.y, w, h);
        let lid = 1;
        if (def) {
          const ipx = px / def.s;
          lid = this.lidAlpha(ipx);
          if (ipx >= 0.8) {
            ctx.save(); ctx.beginPath(); ctx.rect(a.x, a.y, w, h); ctx.clip();
            this.drawSheet(this.child(F, b));
            ctx.restore();
          }
        }
        if (lid > 0) {
          ctx.globalAlpha = 0.25 + 0.7 * lid; ctx.fillStyle = '#2b2f3a'; ctx.fillRect(a.x + inset, a.y + inset, w - 2 * inset, h - 2 * inset);
          ctx.globalAlpha = 1;
          if (px >= 6) {
            ctx.fillStyle = `rgba(240,166,64,${0.4 + 0.6 * lid})`;
            ctx.font = `600 ${Math.min(40, px * 0.8, h * 0.4, w / Math.max(3, (b.def || '').length) * 1.5)}px system-ui`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(b.def, a.x + w / 2, a.y + h / 2);
          }
        } else if (px >= 4) {
          ctx.fillStyle = '#f0a640'; ctx.font = `600 ${Math.min(18, px * 0.5)}px system-ui`;
          ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText(b.def + '  ' + b.id, a.x, a.y - 2);
        }
        ctx.strokeStyle = problem ? '#ff6b6b' : sel ? '#f0a640' : '#6b5a3a'; ctx.lineWidth = sel || problem ? 2 : 1;
        ctx.strokeRect(a.x + 0.5, a.y + 0.5, w - 1, h - 1);
        if (px >= 6 && lid > 0.3) {
          ctx.fillStyle = '#c8cdd8'; ctx.font = `${Math.min(12, px * 0.32)}px system-ui`; ctx.textBaseline = 'middle';
          for (const p of fp.pads) {
            const q = S(p.x, p.y);
            ctx.textAlign = p.dir === 'in' ? 'left' : 'right';
            ctx.fillText(p.name, p.dir === 'in' ? q.x + px * 0.8 : q.x + px * 0.2, q.y + px / 2);
          }
        }
        return;
      }
      const t = G.info(b.type);
      ctx.fillStyle = b.type === 'delay' ? '#22324a' : G.SINKS[b.type] ? '#352838' : '#2b303c';
      ctx.fillRect(a.x + inset, a.y + inset, w - 2 * inset, h - 2 * inset);
      ctx.strokeStyle = problem ? '#ff6b6b' : sel ? '#f0a640' : '#596075'; ctx.lineWidth = sel || problem ? 2 : 1;
      ctx.strokeRect(a.x + inset + 0.5, a.y + inset + 0.5, w - 2 * inset - 1, h - 2 * inset - 1);
      if (b.type === 'scope') { this.drawScope(F, b, a, w, h, px); return; }
      if (px >= 5) {
        ctx.fillStyle = b.type === 'delay' ? '#5ec8e5' : '#f0a640';
        ctx.font = `600 ${Math.min(px * 1.1, h * 0.7)}px ui-monospace, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.sym, a.x + w / 2, a.y + h / 2);
      }
      if (px >= 16) {
        ctx.fillStyle = '#9aa1b2'; ctx.font = `${Math.min(12, px * 0.3)}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const p of fp.pads) if (p.name) { const q = S(p.x, p.y); ctx.fillText(p.name, q.x + px / 2, q.y + px * 0.72); }
      }
    }

    drawScope(F, b, a, w, h, px) {
      const ctx = this.ctx, app = this.app;
      const k = app.running ? app.running.scopePaths.indexOf(F.path + b.id) : -1;
      const data = k >= 0 && app.snap && app.snap.scopes ? app.snap.scopes[k] : null;
      const x0 = a.x + px * 1.2, x1 = a.x + w - px * 0.4, y0 = a.y + px * 0.4, y1 = a.y + h - px * 0.4;
      ctx.fillStyle = '#0d1310'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      if (!data || !data.length || px < 3) return;
      let start = 0, len = data.length;
      let lo = Infinity, hi = -Infinity;
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
      for (let j = 0; j < len; j++) { const x = X(j), y = Y(data[start + j]); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      if (px >= 8) {
        ctx.fillStyle = '#6d8a75'; ctx.font = `${Math.min(11, px * 0.4)}px ui-monospace, monospace`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(fmt(hi), x0 + 3, y0 + 2);
        ctx.textBaseline = 'bottom'; ctx.fillText(fmt(lo), x0 + 3, y1 - 2);
      }
    }

    // Ghost of a block being placed, and the hover cell.
    drawOverlay() {
      const app = this.app, ctx = this.ctx, h = app.hover;
      if (!h) return;
      const px = this.cam.z * h.F.sc;
      const S = (x, y) => this.toScreen(h.F.ox + x * h.F.sc, h.F.oy + y * h.F.sc);
      if (app.placing) {
        const b = app.ghost(h);
        const fp = G.footprint(b, app.project.defs), p = S(b.x, b.y);
        const ok = G.canPlace(h.F.sheet, app.project.defs, b);
        ctx.fillStyle = ok ? 'rgba(240,166,64,0.25)' : 'rgba(255,80,80,0.25)';
        ctx.fillRect(p.x, p.y, fp.w * px, fp.h * px);
        ctx.strokeStyle = ok ? '#f0a640' : '#ff6b6b'; ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x, p.y, fp.w * px, fp.h * px);
        for (const q of fp.pads) { const s = S(q.x, q.y); ctx.strokeRect(s.x + px * 0.3, s.y + px * 0.3, px * 0.4, px * 0.4); }
      } else if (px >= 4) {
        const p = S(h.x, h.y);
        ctx.strokeStyle = app.layer === G.BOT ? 'rgba(94,200,229,0.8)' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, px - 1, px - 1);
      }
    }
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

  root.GW = Object.assign(root.GW || {}, { View, colorOf, fmt, knobFrac, knobValue, POS, NEG, OPEN_PX });
})(typeof self !== 'undefined' ? self : this);
