// SVG patch editor: draws the current patch and turns pointer gestures into edits.
(function (root) {
  'use strict';

  const HEAD = 18, PORT_DY = 20, CELL_W = 56, CELL_H = 64;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmt(v) {
    if (v === undefined || v === null) return '';
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
    return String(Number(v.toPrecision(4)));
  }

  function knobFrac(p, v) {
    if (p.scale === 'log' && p.min > 0 && p.max > 0) return Math.log(Math.max(v, p.min) / p.min) / Math.log(p.max / p.min);
    return (v - p.min) / ((p.max - p.min) || 1);
  }
  function knobValue(p, frac) {
    frac = Math.min(1, Math.max(0, frac));
    if (p.scale === 'log' && p.min > 0 && p.max > 0) return p.min * Math.pow(p.max / p.min, frac);
    return p.min + frac * (p.max - p.min);
  }
  function polar(cx, cy, r, deg) {
    const a = deg * Math.PI / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }
  function arc(cx, cy, r, a0, a1) {
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }

  class Editor {
    constructor(app, svg) {
      this.app = app;
      this.svg = svg;
      svg.innerHTML = `
        <defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" class="griddot"/></pattern></defs>
        <rect id="bg" width="100%" height="100%" fill="url(#grid)"/>
        <g id="vp"><g id="wires"></g><g id="blocks"></g>
          <path id="tempwire" class="wire temp" d=""/><rect id="boxsel" class="boxsel" width="0" height="0"/></g>`;
      this.vp = svg.querySelector('#vp');
      this.wiresG = svg.querySelector('#wires');
      this.blocksG = svg.querySelector('#blocks');
      this.temp = svg.querySelector('#tempwire');
      this.box = svg.querySelector('#boxsel');
      this.views = {};      // pan/zoom per navigation location
      this.drag = null;
      this.pending = false;
      this.geoms = new Map();
      this.valueEls = [];
      this.scopeEls = [];
      svg.addEventListener('pointerdown', (e) => this.onDown(e));
      window.addEventListener('pointermove', (e) => this.onMove(e));
      window.addEventListener('pointerup', (e) => this.onUp(e));
      svg.addEventListener('dblclick', (e) => this.onDbl(e));
      svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      svg.addEventListener('dragover', (e) => e.preventDefault());
      svg.addEventListener('drop', (e) => this.onDrop(e));
    }

    get view() {
      const k = this.app.navKey();
      if (!this.views[k]) { this.views[k] = { x: 40, y: 40, k: 1 }; this.fitPending = true; }
      return this.views[k];
    }

    toWorld(e) {
      const r = this.svg.getBoundingClientRect(), v = this.view;
      return { x: (e.clientX - r.left - v.x) / v.k, y: (e.clientY - r.top - v.y) / v.k };
    }

    // ---- geometry ------------------------------------------------------------
    geom(b) {
      const defs = this.app.project.defs;
      const pr = CW.ports(b, defs);
      const nIn = pr.ins.length, nOut = pr.outs.length;
      let w = 64, bodyH = Math.max(1, nIn, nOut) * PORT_DY + 8, controls = [], cols = 0;
      if (b.type === 'comp') {
        const def = defs[b.def];
        controls = def ? CW.panelControls(def) : [];
        cols = Math.min(3, controls.length);
        const maxLabel = Math.max(0, ...pr.ins.map((s) => s.length)) + Math.max(0, ...pr.outs.map((s) => s.length));
        w = Math.max(120, cols * CELL_W + 10, 40 + maxLabel * 6.5, 24 + (b.def || '').length * 7.5);
      } else if (b.type === 'const') {
        w = 76;
        if (b.panel) { controls = [b]; cols = 1; }
      } else if (b.type === 'scope') { w = 200; bodyH = 100; }
      else if (b.type === 'inlet' || b.type === 'outlet') { w = 92; }
      else if (b.type === 'dac') { w = 70; }
      else if (b.type === 'switch') { w = 80; }
      const panelH = controls.length ? Math.ceil(controls.length / Math.max(1, cols)) * CELL_H : 0;
      const portY = (i) => HEAD + 4 + PORT_DY * i + PORT_DY / 2;
      return {
        w, h: HEAD + bodyH + panelH, pr, controls, cols, bodyH, panelY: HEAD + bodyH,
        ins: pr.ins.map((_, i) => ({ x: 0, y: portY(i) })),
        outs: pr.outs.map((_, i) => ({ x: w, y: portY(i) })),
      };
    }

    // ---- rendering -----------------------------------------------------------
    requestRender() {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.render(); });
    }

    render() {
      const app = this.app, patch = app.patch();
      const v = this.view; // creating a new view marks it for fitting
      if (this.fitPending) { this.fitPending = false; this.fit(); }
      this.vp.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
      this.geoms = new Map(patch.blocks.map((b) => [b.id, this.geom(b)]));
      const byId = new Map(patch.blocks.map((b) => [b.id, b]));
      const problems = app.problemIds();

      let ws = '';
      patch.wires.forEach((w, i) => {
        const a = byId.get(w.from[0]), b = byId.get(w.to[0]);
        if (!a || !b) return;
        const ga = this.geoms.get(a.id), gb = this.geoms.get(b.id);
        const pa = ga.outs[w.from[1]], pb = gb.ins[w.to[1]];
        if (!pa || !pb) return;
        const d = this.wirePath(a.x + pa.x, a.y + pa.y, b.x + pb.x, b.y + pb.y);
        ws += `<g data-wire="${i}" class="${app.selWire === i ? 'selected' : ''}">
          <path class="wire" d="${d}"/><path class="wirehit" d="${d}"/></g>`;
      });
      this.wiresG.innerHTML = ws;

      let bs = '';
      for (const b of patch.blocks) bs += this.blockSvg(b, this.geoms.get(b.id), app.sel.has(b.id), problems.has(b.id));
      this.blocksG.innerHTML = bs;
      this.valueEls = [...this.blocksG.querySelectorAll('[data-val]')].map((el) => {
        const [id, port] = el.dataset.val.split(':');
        return { el, id, port };
      });
      this.scopeEls = [...this.blocksG.querySelectorAll('[data-scope]')].map((el) => ({
        id: el.dataset.scope,
        line: el.querySelector('.trace'), dots: el.querySelector('.dots'),
        hi: el.querySelector('.hi'), lo: el.querySelector('.lo'),
        w: Number(el.dataset.w),
      }));
      this.updateLive();
    }

    wirePath(x1, y1, x2, y2) {
      const dx = Math.max(30, Math.abs(x2 - x1) / 2);
      return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
    }

    blockSvg(b, g, selected, problem) {
      const info = CW.info(b.type);
      const def = b.type === 'comp' ? this.app.project.defs[b.def] : null;
      let title = info ? info.title : (b.def || '?');
      if (b.type === 'const' && b.label) title = b.label;
      let s = `<g data-block="${b.id}" transform="translate(${b.x},${b.y})" class="block t-${b.type}${selected ? ' selected' : ''}${problem ? ' problem' : ''}">`;
      s += `<rect class="body" width="${g.w}" height="${g.h}" rx="4"/>`;
      s += `<rect class="head" width="${g.w}" height="${HEAD}" rx="4"/><rect class="head" y="${HEAD - 4}" width="${g.w}" height="4"/>`;
      s += `<text class="title" x="${g.w / 2}" y="13">${esc(title)}</text>`;
      const cx = g.w / 2, cy = HEAD + g.bodyH / 2 + 5;
      if (CW.ATOMS[b.type] && b.type !== 'const') {
        const sx = info.ins.length > 1 ? cx + 6 : cx; // leave room for input labels
        s += `<text class="symbol" x="${sx}" y="${cy + 3}">${esc(info.symbol)}</text>`;
      } else if (b.type === 'const') {
        s += `<text class="cval" x="${cx}" y="${cy}">${esc(fmt(b.value))}</text>`;
      } else if (b.type === 'inlet' || b.type === 'outlet') {
        s += `<text class="pname" x="${cx}" y="${cy}">${esc(b.name || '')}</text>`;
      } else if (b.type === 'dac') {
        s += `<text class="symbol small" x="${cx}" y="${cy}">🔊</text>`;
      } else if (b.type === 'scope') {
        s += `<g data-scope="${b.id}" data-w="${g.w}"><rect class="screen" x="4" y="${HEAD + 4}" width="${g.w - 8}" height="${g.bodyH - 8}"/>
          <polyline class="trace" points=""/><g class="dots"></g>
          <text class="hi" x="8" y="${HEAD + 15}"></text><text class="lo" x="8" y="${HEAD + g.bodyH - 8}"></text></g>`;
      } else if (b.type === 'comp' && !def) {
        s += `<text class="pname" x="${cx}" y="${cy}">missing</text>`;
      }
      const showIn = g.pr.ins.length > 1 || b.type === 'comp';
      const showOut = g.pr.outs.length > 1 || b.type === 'comp';
      g.ins.forEach((p, i) => {
        s += `<circle class="port in" data-port="in" data-idx="${i}" cx="${p.x}" cy="${p.y}" r="5"/>`;
        if (showIn) s += `<text class="plabel" x="${p.x + 8}" y="${p.y + 3.5}">${esc(g.pr.ins[i])}</text>`;
      });
      g.outs.forEach((p, i) => {
        s += `<circle class="port out" data-port="out" data-idx="${i}" cx="${p.x}" cy="${p.y}" r="5"/>`;
        if (showOut) s += `<text class="plabel r" x="${p.x - 8}" y="${p.y + 3.5}">${esc(g.pr.outs[i])}</text>`;
        s += `<text class="val" data-val="${b.id}:${i}" x="${p.x + 7}" y="${p.y - 6}"></text>`;
      });
      g.controls.forEach((c, i) => {
        const col = i % g.cols, row = Math.floor(i / g.cols);
        const x0 = (g.w - g.cols * CELL_W) / 2 + col * CELL_W, y0 = g.panelY + row * CELL_H;
        const val = b.type === 'comp' ? CW.controlValue(b, c) : c.value;
        s += this.controlSvg(b.id, c, val, x0, y0);
      });
      if (b.label && b.type !== 'const') s += `<text class="note" x="${g.w / 2}" y="${g.h + 12}">${esc(b.label)}</text>`;
      if (b.type === 'comp' && def && def.description) s += `<title>${esc(def.description)}</title>`;
      else if (info) s += `<title>${esc(info.title + ': ' + info.eq)}</title>`;
      return s + '</g>';
    }

    controlSvg(owner, c, val, x0, y0) {
      const p = c.panel, cx = x0 + CELL_W / 2, cy = y0 + 32;
      const lab = (p.label || '').slice(0, 10);
      let s = `<g class="ctl" data-ctl="${c.id}" data-owner="${owner}" data-kind="${p.kind}">
        <rect class="ctlhit" x="${x0 + 2}" y="${y0 + 2}" width="${CELL_W - 4}" height="${CELL_H - 4}" rx="3"/>
        <text class="clabel" x="${cx}" y="${y0 + 12}">${esc(lab)}</text>`;
      const on = val >= (p.min + p.max) / 2;
      if (p.kind === 'toggle') {
        s += `<rect class="toggle${on ? ' on' : ''}" x="${cx - 15}" y="${cy - 9}" width="30" height="18" rx="9"/>
          <circle class="tknob" cx="${on ? cx + 6 : cx - 6}" cy="${cy}" r="6"/>`;
      } else if (p.kind === 'button') {
        s += `<circle class="button${on ? ' on' : ''}" cx="${cx}" cy="${cy}" r="12"/>`;
      } else {
        const a = -135 + 270 * Math.min(1, Math.max(0, knobFrac(p, val)));
        const [px, py] = polar(cx, cy, 10, a);
        s += `<circle class="knob" cx="${cx}" cy="${cy}" r="14"/>
          <path class="karc bg" d="${arc(cx, cy, 17, -135, 135)}"/>
          <path class="karc" d="${arc(cx, cy, 17, -135, Math.max(a, -134.9))}"/>
          <line class="kptr" x1="${cx}" y1="${cy}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}"/>`;
      }
      s += `<text class="cvalsm" x="${cx}" y="${y0 + 60}">${esc(fmt(val))}</text></g>`;
      return s;
    }

    // Live values (port numbers and scopes), called whenever a snapshot arrives.
    updateLive() {
      const app = this.app, snap = app.snap, prog = app.running;
      const path = app.viewPath();
      const ok = snap && prog && path !== null;
      for (const { el, id, port } of this.valueEls) {
        const net = ok ? prog.portNets[path + '|' + id + '|' + port] : undefined;
        el.textContent = net === undefined || net < 0 || !snap.v || net >= snap.v.length ? '' : fmt(snap.v[net]);
      }
      for (const sc of this.scopeEls) {
        const k = ok ? prog.scopePaths.indexOf(path + sc.id) : -1;
        const data = k >= 0 && snap.scopes[k] ? snap.scopes[k].data : null;
        this.drawScope(sc, data, snap && snap.mode);
      }
    }

    drawScope(sc, data, mode) {
      if (!data || !data.length) { sc.line.setAttribute('points', ''); sc.dots.innerHTML = ''; sc.hi.textContent = ''; sc.lo.textContent = ''; return; }
      let lo = Infinity, hi = -Infinity;
      for (const x of data) { if (x < lo) lo = x; if (x > hi) hi = x; }
      let start = 0, len = data.length;
      if (mode === 'audio') {
        // trigger on a rising crossing of the midpoint, in the older half of the buffer
        len = Math.floor(data.length / 2);
        const mid = (lo + hi) / 2;
        start = len;
        for (let j = 1; j < len; j++) if (data[j - 1] < mid && data[j] >= mid) { start = j; break; }
        lo = Infinity; hi = -Infinity;
        for (let j = start; j < start + len; j++) { if (data[j] < lo) lo = data[j]; if (data[j] > hi) hi = data[j]; }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { sc.hi.textContent = 'NaN'; return; }
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      const x0 = 6, x1 = sc.w - 6, y0 = HEAD + 8, y1 = HEAD + 92;
      const X = (j) => x0 + (x1 - x0) * j / Math.max(1, len - 1);
      const Y = (v) => y1 - (y1 - y0) * (v - lo) / (hi - lo);
      let pts = '';
      if (mode === 'slow') {
        let dots = '';
        for (let j = 0; j < len; j++) {
          const y = Y(data[start + j]).toFixed(1);
          pts += `${X(j - 0.5).toFixed(1)},${y} ${X(j + 0.5).toFixed(1)},${y} `;
          dots += `<circle cx="${X(j).toFixed(1)}" cy="${y}" r="1.6"/>`;
        }
        sc.dots.innerHTML = dots;
      } else {
        for (let j = 0; j < len; j++) pts += `${X(j).toFixed(1)},${Y(data[start + j]).toFixed(1)} `;
        sc.dots.innerHTML = '';
      }
      sc.line.setAttribute('points', pts);
      sc.hi.textContent = fmt(hi);
      sc.lo.textContent = fmt(lo);
    }

    fit() {
      const patch = this.app.patch(), v = this.view;
      if (!patch.blocks.length) { Object.assign(v, { x: 40, y: 40, k: 1 }); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of patch.blocks) {
        const g = this.geom(b);
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + g.w + 40); y1 = Math.max(y1, b.y + g.h + 20);
      }
      const r = this.svg.getBoundingClientRect();
      const k = Math.min(1.2, (r.width - 60) / (x1 - x0), (r.height - 60) / (y1 - y0));
      v.k = Math.max(0.3, k);
      v.x = (r.width - (x1 - x0) * v.k) / 2 - x0 * v.k;
      v.y = (r.height - (y1 - y0) * v.k) / 2 - y0 * v.k;
    }

    // ---- interaction ---------------------------------------------------------
    hit(e) {
      const t = e.target;
      const blockEl = t.closest && t.closest('[data-block]');
      return {
        blockEl,
        id: blockEl ? blockEl.dataset.block : null,
        port: t.closest && t.closest('[data-port]'),
        ctl: t.closest && t.closest('[data-ctl]'),
        wire: t.closest && t.closest('[data-wire]'),
      };
    }

    onDown(e) {
      if (e.button !== 0 && e.button !== 1) return;
      const app = this.app, patch = app.patch(), h = this.hit(e);
      const w = this.toWorld(e);
      this.downAt = { x: e.clientX, y: e.clientY };
      if (e.button === 1) { this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y }; return; }
      if (h.port) {
        const idx = Number(h.port.dataset.idx), dir = h.port.dataset.port;
        if (dir === 'in') {
          // pick up an existing wire from its input end
          const wi = patch.wires.findIndex((x) => x.to[0] === h.id && x.to[1] === idx);
          if (wi >= 0) {
            const old = patch.wires.splice(wi, 1)[0];
            app.changed();
            this.drag = { kind: 'wire', dir: 'out', id: old.from[0], idx: old.from[1] };
          } else this.drag = { kind: 'wire', dir: 'in', id: h.id, idx };
        } else this.drag = { kind: 'wire', dir: 'out', id: h.id, idx };
        this.onMove(e);
        return;
      }
      if (h.ctl) { this.ctlDown(e, h.ctl); return; }
      if (h.id) {
        if (e.shiftKey) { app.sel.has(h.id) ? app.sel.delete(h.id) : app.sel.add(h.id); }
        else if (!app.sel.has(h.id)) { app.sel.clear(); app.sel.add(h.id); }
        app.selWire = null;
        app.selectionChanged();
        const orig = new Map();
        for (const b of patch.blocks) if (app.sel.has(b.id)) orig.set(b.id, { x: b.x, y: b.y });
        this.drag = { kind: 'move', sx: w.x, sy: w.y, orig, moved: false };
        return;
      }
      if (h.wire) {
        app.sel.clear(); app.selWire = Number(h.wire.dataset.wire);
        app.selectionChanged(); this.render();
        return;
      }
      if (e.shiftKey) this.drag = { kind: 'box', sx: w.x, sy: w.y };
      else this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, click: true };
    }

    onMove(e) {
      const d = this.drag;
      if (!d) return;
      const app = this.app, w = this.toWorld(e);
      if (d.kind === 'pan') {
        this.view.x = d.vx + e.clientX - d.sx; this.view.y = d.vy + e.clientY - d.sy;
        this.vp.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
      } else if (d.kind === 'move') {
        const dx = Math.round((w.x - d.sx) / 10) * 10, dy = Math.round((w.y - d.sy) / 10) * 10;
        if (dx || dy) d.moved = true;
        for (const b of app.patch().blocks) {
          const o = d.orig.get(b.id);
          if (o) { b.x = o.x + dx; b.y = o.y + dy; }
        }
        this.requestRender();
      } else if (d.kind === 'wire') {
        const b = app.patch().blocks.find((x) => x.id === d.id), g = this.geoms.get(d.id);
        if (!b || !g) return;
        const p = (d.dir === 'out' ? g.outs : g.ins)[d.idx];
        const px = b.x + p.x, py = b.y + p.y;
        this.temp.setAttribute('d', d.dir === 'out' ? this.wirePath(px, py, w.x, w.y) : this.wirePath(w.x, w.y, px, py));
      } else if (d.kind === 'box') {
        const x = Math.min(d.sx, w.x), y = Math.min(d.sy, w.y);
        Object.entries({ x, y, width: Math.abs(w.x - d.sx), height: Math.abs(w.y - d.sy) }).forEach(([k, v]) => this.box.setAttribute(k, v));
      } else if (d.kind === 'knob') {
        const p = d.c.panel;
        const fine = e.shiftKey ? 0.1 : 1;
        d.frac = Math.min(1, Math.max(0, d.frac - (e.clientY - d.ly) / 200 * fine));
        d.ly = e.clientY;
        this.setControl(d.owner, d.c, knobValue(p, d.frac));
      }
    }

    onUp(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const app = this.app;
      if (d.kind === 'pan' && d.click && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 3) {
        app.sel.clear(); app.selWire = null; app.selectionChanged(); this.render();
      } else if (d.kind === 'move' && d.moved) {
        app.changed();
      } else if (d.kind === 'wire') {
        this.temp.setAttribute('d', '');
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const port = el && el.closest('[data-port]');
        if (port) {
          const id = port.closest('[data-block]').dataset.block, idx = Number(port.dataset.idx);
          if (port.dataset.port !== d.dir) {
            if (d.dir === 'out') app.connect(d.id, d.idx, id, idx);
            else app.connect(id, idx, d.id, d.idx);
          }
        }
      } else if (d.kind === 'box') {
        this.box.setAttribute('width', 0); this.box.setAttribute('height', 0);
        const w = this.toWorld(e);
        const x0 = Math.min(d.sx, w.x), x1 = Math.max(d.sx, w.x), y0 = Math.min(d.sy, w.y), y1 = Math.max(d.sy, w.y);
        for (const b of app.patch().blocks) {
          const g = this.geoms.get(b.id);
          if (b.x < x1 && b.x + g.w > x0 && b.y < y1 && b.y + g.h > y0) app.sel.add(b.id);
        }
        app.selectionChanged(); this.render();
      } else if (d.kind === 'button') {
        this.setControl(d.owner, d.c, d.c.panel.min);
      }
    }

    ctlDown(e, el) {
      const owner = this.app.patch().blocks.find((b) => b.id === el.dataset.owner);
      const c = owner.type === 'comp' ? this.app.project.defs[owner.def].blocks.find((b) => b.id === el.dataset.ctl) : owner;
      const p = c.panel, val = owner.type === 'comp' ? CW.controlValue(owner, c) : c.value;
      if (p.kind === 'toggle') this.setControl(owner, c, val >= (p.min + p.max) / 2 ? p.min : p.max);
      else if (p.kind === 'button') { this.setControl(owner, c, p.max); this.drag = { kind: 'button', owner, c }; }
      else this.drag = { kind: 'knob', owner, c, frac: knobFrac(p, val), ly: e.clientY };
    }

    setControl(owner, c, v) {
      if (owner.type === 'comp') { owner.params = owner.params || {}; owner.params[c.id] = v; }
      else c.value = v;
      this.app.changed();
    }

    onDbl(e) {
      // the first click may have re-rendered the block, so look up what is under the pointer now
      const app = this.app, h = this.hit({ target: document.elementFromPoint(e.clientX, e.clientY) || e.target });
      if (!h.id) return;
      const b = app.patch().blocks.find((x) => x.id === h.id);
      if (h.ctl) {
        const c = b.type === 'comp' ? app.project.defs[b.def].blocks.find((x) => x.id === h.ctl.dataset.ctl) : b;
        const cur = b.type === 'comp' ? CW.controlValue(b, c) : c.value;
        const s = prompt(`Value for "${c.panel.label}" (${c.panel.min} … ${c.panel.max})`, cur);
        if (s !== null && s.trim() !== '' && Number.isFinite(Number(s))) this.setControl(b, c, Number(s));
        return;
      }
      if (b.type === 'comp') app.enter(b.id);
      else if (b.type === 'const') {
        const s = prompt('Constant value', b.value);
        if (s !== null && s.trim() !== '' && Number.isFinite(Number(s))) { b.value = Number(s); app.changed(); }
      } else if (b.type === 'inlet' || b.type === 'outlet') {
        const s = prompt('Port name', b.name || '');
        if (s !== null) { b.name = s; app.changed(); }
      }
    }

    onWheel(e) {
      e.preventDefault();
      const r = this.svg.getBoundingClientRect(), v = this.view;
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = mx - (mx - v.x) * k / v.k; v.y = my - (my - v.y) * k / v.k; v.k = k;
      this.vp.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
    }

    onDrop(e) {
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      if (!data) return;
      const w = this.toWorld(e);
      const [kind, name] = data.split(':');
      this.app.addBlock(kind === 'def' ? 'comp' : name, Math.round(w.x / 10) * 10, Math.round(w.y / 10) * 10, kind === 'def' ? name : null);
    }

    center() {
      const r = this.svg.getBoundingClientRect(), v = this.view;
      return { x: Math.round(((r.width / 2 - v.x) / v.k - 40) / 10) * 10, y: Math.round(((r.height / 2 - v.y) / v.k - 30) / 10) * 10 };
    }
  }

  root.CW = Object.assign(root.CW || {}, { Editor, fmt });
})(typeof self !== 'undefined' ? self : this);
