// Grid prototype application: tools, painting, knobs, inspector, persistence.
(function () {
  'use strict';
  const G = window.GW;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'clockwork.grid.v1';
  const RATE_MIN = 0.5, RATE_MAX = G.FS;

  const app = {
    project: null, compiled: null, running: null, snap: null,
    version: 1, tool: 'select', layer: G.TOP,
    sel: null, hover: null, hotRegion: null, placing: null, drag: null,
  };
  window.gapp = app;

  // ---- visual style (the style lab) -----------------------------------------------
  const Q = new URLSearchParams(location.search);
  const EMBED = Q.get('embed') === '1';
  const STYLE_KEY = 'clockwork.style.v2';  // v2: the defaults chosen from the style lab
  const STYLES = {
    ops: { label: 'Operations', options: { chip: 'IC packages', symbol: 'Signal-flow symbols', via: 'Special vias' } },
    branch: { label: 'Branch points (copy)', options: { none: 'Nothing', dot: 'Solder dot', copyvia: 'Copy via' } },
    dir: { label: 'Direction', options: { none: 'Nothing', arrows: 'Chevrons', flow: 'Flowing dashes', taper: 'Taper' } },
    reg: { label: 'Registers', options: { plain: 'Plain trace', pour: 'Copper pour (region)', double: 'Double outline' } },
  };
  app.style = { ops: 'via', branch: 'none', dir: 'taper', reg: 'plain' };
  try { if (!EMBED) Object.assign(app.style, JSON.parse(localStorage.getItem(STYLE_KEY) || '{}')); } catch (e) { /* keep defaults */ }
  for (const k in STYLES) if (Q.has(k) && STYLES[k].options[Q.get(k)]) app.style[k] = Q.get(k);
  app.netKind = (key) => { const r = app.running && app.running.netOf[key]; return r ? r.k : undefined; };
  // Time for the flowing-dash animation; it stops when the clock stops.
  let flowT = 0, flowLast = performance.now();
  app.flowTime = () => {
    const now = performance.now();
    if (app.host && app.host.running) flowT += Math.min(0.1, (now - flowLast) / 1000) * 1.5;
    flowLast = now;
    return flowT;
  };

  // ---- values -----------------------------------------------------------------
  app.valueOf = (key) => {
    const p = app.running, ref = p && p.netOf[key];
    if (!ref) return undefined;
    if (ref.k === 'p') return p.params[ref.i];
    return app.snap && app.snap.v && ref.v < app.snap.v.length ? app.snap.v[ref.v] : 0;
  };
  app.knobState = (key) => (app.compiled && app.compiled.knobState[key]) || 'ok';
  const written = (key) => { const r = app.compiled && app.compiled.netOf[key]; return r && r.k === 's'; };

  // ---- change propagation -----------------------------------------------------
  let saveTimer = null, compileQueued = false;
  app.changed = function (structural) {
    if (structural !== false) app.version++;
    clearTimeout(saveTimer);
    if (!EMBED) saveTimer = setTimeout(() => localStorage.setItem(STORE, JSON.stringify(app.project)), 500);
    if (!compileQueued) {
      compileQueued = true;
      requestAnimationFrame(() => { compileQueued = false; recompile(); renderInspector(); });
    }
    app.view.dirty = true;
  };
  function recompile() {
    const c = GW.compile(app.project);
    app.compiled = c;
    if (c.ok) { app.running = c; app.host.load(c, scopeWins(c)); }
    updateBanner();
  }
  function scopeWins(c) {
    return c.scopePaths.map((path) => { const b = blockAtPath(path); return (b && b.window) || 512; });
  }
  function blockAtPath(path) {
    const parts = path.split('/');
    let sheet = app.project.root, b = null;
    for (const id of parts) {
      if (!sheet) return null;
      b = sheet.blocks.find((x) => x.id === id);
      if (!b) return null;
      sheet = b.type === 'comp' ? app.project.defs[b.def] : null;
    }
    return b;
  }
  function instances(name) {
    let n = 0;
    for (const s of [app.project.root, ...Object.values(app.project.defs)]) n += s.blocks.filter((b) => b.type === 'comp' && b.def === name).length;
    return n;
  }

  // ---- setting values (constants and knobs) -------------------------------------
  // At the root a region's value is stored on the region; inside an instance it is
  // stored per instance, by absolute path, so every factory keeps its own knobs.
  function setRegionValue(F, rid, v) {
    if (F.path === '') F.sheet.regions[rid].value = v;
    else app.project.values[F.path + rid] = v;
    app.changed(false);
  }
  function regionValue(F, rid) {
    const ov = app.project.values[F.path + rid];
    return F.path !== '' && ov !== undefined ? ov : F.sheet.regions[rid].value;
  }

  // ---- pointer ------------------------------------------------------------------
  const canvas = $('#grid');
  let spaceDown = false;
  app.ghost = (h) => {
    const b = Object.assign({ x: 0, y: 0, rot: app.placing.rot || 0 }, app.placing);
    const fp = G.footprint(b, app.project.defs);
    b.x = h.x - Math.floor(fp.w / 2); b.y = h.y - Math.floor(fp.h / 2);
    return b;
  };
  function regionAt(h, preferLayer) {
    const k = G.key(h.x, h.y), sh = h.F.sheet;
    const first = preferLayer || app.layer, second = first === G.TOP ? G.BOT : G.TOP;
    if (sh[first][k]) return { rid: sh[first][k], layer: first };
    if (sh[second][k]) return { rid: sh[second][k], layer: second };
    return null;
  }
  function knobAt(h) {
    for (const rid in h.F.sheet.regions) {
      const kb = h.F.sheet.regions[rid].knob;
      if (kb && kb.x === h.x && kb.y === h.y) return rid;
    }
    return null;
  }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    const p = pos(e), h = app.view.locate(p.x, p.y);
    if (e.button === 1 || spaceDown || !h) { app.drag = { kind: 'pan', x: p.x, y: p.y }; return; }
    if (e.button === 2 || app.tool === 'erase') { app.drag = { kind: 'erase', F: h.F, last: null, both: e.shiftKey }; eraseTo(h); return; }
    if (e.button !== 0) return;
    if (app.placing) { placeAt(h, e.shiftKey); return; }
    if (app.tool === 'route') { app.route ? routeCommit(h) : routeStart(h); return; }
    if (app.tool === 'knob') { toggleKnob(h); return; }
    // select tool: knob → turn it; block → move it; region → select it; else pan
    const krid = knobAt(h);
    if (krid) {
      const st = app.knobState(h.F.path + krid);
      if (st !== 'ok') { toast(st === 'written' ? 'This register is written by a block, so its handle is dead.' : 'This knob is overridden by a register outside the block.'); return; }
      const kb = h.F.sheet.regions[krid].knob;
      app.drag = { kind: 'knob', F: h.F, rid: krid, frac: GW.knobFrac(kb, regionValue(h.F, krid)), y: p.y };
      return;
    }
    if (h.occ && h.occ.block) {
      const b = h.occ.block;
      app.sel = { kind: 'block', path: h.F.path, id: b.id, F: h.F };
      app.drag = { kind: 'move', F: h.F, b, x0: b.x, y0: b.y, hx: h.x, hy: h.y, moved: false };
      renderInspector(); app.view.dirty = true;
      return;
    }
    const r = regionAt(h);
    if (r) {
      app.sel = { kind: 'region', path: h.F.path, id: r.rid, F: h.F, run: trackAt(h.F.sheet, r.layer, h.x, h.y) };
      renderInspector(); app.view.dirty = true; return;
    }
    app.drag = { kind: 'pan', x: p.x, y: p.y, click: true, sx: p.x, sy: p.y };
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e), d = app.drag;
    if (d && d.kind === 'pan') { app.view.pan(p.x - d.x, p.y - d.y); d.x = p.x; d.y = p.y; }
    const h = app.view.locate(p.x, p.y);
    app.hover = h;
    if (app.route && h) routePreview(h);
    if (d && d.kind === 'erase' && h) eraseTo(h);
    if (d && d.kind === 'knob') {
      const kb = d.F.sheet.regions[d.rid].knob;
      d.frac = Math.min(1, Math.max(0, d.frac - (p.y - d.y) / 200 * (e.shiftKey ? 0.1 : 1)));
      d.y = p.y;
      setRegionValue(d.F, d.rid, GW.knobValue(kb, d.frac));
    }
    if (d && d.kind === 'move' && h && h.F.sheet === d.F.sheet && h.F.path === d.F.path) {
      const nx = d.x0 + h.x - d.hx, ny = d.y0 + h.y - d.hy;
      if (nx !== d.b.x || ny !== d.b.y) {
        const trial = Object.assign({}, d.b, { x: nx, y: ny });
        if (G.canPlace(d.F.sheet, app.project.defs, trial, d.b)) { d.b.x = nx; d.b.y = ny; d.moved = true; app.version++; }
      }
    }
    const r = h && regionAt(h);
    app.hotRegion = r ? { path: h.F.path, rid: r.rid } : null;
    updateStatus();
    app.view.dirty = true;
  });

  canvas.addEventListener('pointerup', (e) => {
    const d = app.drag;
    app.drag = null;
    if (!d) return;
    if (d.kind === 'pan' && d.click && Math.hypot(pos(e).x - d.sx, pos(e).y - d.sy) < 3) { app.sel = null; renderInspector(); }
    if (d.kind === 'move' && d.moved) app.changed();
    if (d.kind === 'erase') app.changed();
    app.view.dirty = true;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pos(e);
    app.view.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)));
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const p = pos(e), h = app.view.locate(p.x, p.y);
    if (!h) return;
    if (app.tool === 'route') return;
    const b = h.occ && h.occ.block;
    if (b && b.type === 'comp') { zoomToBlock(h.F, b); return; }
    const krid = knobAt(h);
    if (krid && app.knobState(h.F.path + krid) === 'ok') {
      const kb = h.F.sheet.regions[krid].knob;
      const s = prompt(`Value for "${kb.label || krid}" (${kb.min} … ${kb.max})`, regionValue(h.F, krid));
      if (s !== null && Number.isFinite(Number(s))) setRegionValue(h.F, krid, Number(s));
    }
  });
  function zoomToBlock(F, b) {
    const fp = G.footprint(b, app.project.defs);
    app.view.fitRect(F.ox + b.x * F.sc, F.oy + b.y * F.sc, F.ox + (b.x + fp.w) * F.sc, F.oy + (b.y + fp.h) * F.sc, 0.04);
  }
  function zoomOut() {
    const h = app.hover;
    if (h && h.F.parent && h.F.parent.parent) zoomToBlock(h.F.parent.parent, h.F.parent.inst);
    else app.view.fitAll();
  }

  // ---- routing ----------------------------------------------------------------------
  // Like a PCB router: click on a pin, a trace or empty board to start; the trace
  // follows the cursor as an L (/ flips the corner); click to fix a corner; ending
  // on a pin or another trace connects to it. Tab drops a via and changes layer.
  // A trace may not cross another net on the same layer: that is what layers are for.
  function lPath(a, b, hFirst) {
    const cells = [[a[0], a[1]]];
    let [x, y] = a;
    const stepX = () => { while (x !== b[0]) { x += Math.sign(b[0] - x); cells.push([x, y]); } };
    const stepY = () => { while (y !== b[1]) { y += Math.sign(b[1] - y); cells.push([x, y]); } };
    if (hFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
    return cells;
  }
  // Index of the last cell the trace can reach before something is in the way.
  function reach(F, rid, layer, cells) {
    const sh = F.sheet, occ = app.view.geom(sh).occ;
    let good = 0;
    for (let i = 1; i < cells.length; i++) {
      const [x, y] = cells[i], k = G.key(x, y), end = i === cells.length - 1;
      const other = sh[layer][k], o = layer === G.TOP ? occ.get(k) : null;
      if (!G.inBounds(sh, x, y) || (o && !o.pad)) break;          // off the board, or an IC body
      if (other && other !== rid && !end) break;                  // crossing another net
      if (o && o.pad && other !== rid && !end) break;             // running over a pin would connect it
      good = i;
    }
    return good;
  }
  function routeStart(h) {
    const sh = h.F.sheet, k = G.key(h.x, h.y), o = app.view.geom(sh).occ.get(k);
    if (!G.inBounds(sh, h.x, h.y) || (app.layer === G.TOP && o && !o.pad)) { toast('Start on a pin, a trace, or empty board.'); return; }
    app.route = { F: h.F, layer: app.layer, rid: sh[app.layer][k] || null, last: [h.x, h.y], hFirst: true, preview: null };
    routePreview(h);
  }
  function routePreview(h) {
    const r = app.route;
    if (!r || h.F.path !== r.F.path || h.F.sheet !== r.F.sheet) return;
    const cells = lPath(r.last, [h.x, h.y], r.hFirst);
    r.preview = { cells, good: reach(r.F, r.rid, r.layer, cells) };
    app.view.dirty = true;
  }
  function routeCommit(h) {
    const r = app.route;
    routePreview(h);
    if (!r.preview) return;
    const sh = r.F.sheet, occ = G.occupancy(sh, app.project.defs);
    const cells = r.preview.cells.slice(0, r.preview.good + 1);
    const [ex, ey] = cells[cells.length - 1], ek = G.key(ex, ey);
    const endsOn = sh[r.layer][ek], endPad = r.layer === G.TOP && occ.get(ek) && occ.get(ek).pad;
    if (!r.rid) r.rid = G.newRegion(sh);
    for (const [x, y] of cells) G.paint(sh, occ, r.layer, x, y, r.rid);
    const blocked = r.preview.good < r.preview.cells.length - 1;
    const connected = cells.length > 1 && ((endsOn && endsOn !== r.rid) || endPad);
    r.last = [ex, ey];
    app.version++; app.changed();
    if (blocked) toast('Something is in the way. Go around it, or press Tab to drop a via and pass under on the other layer.');
    else if (connected || cells.length === 1) endRoute();
    else routePreview(h);
  }
  function endRoute() { app.route = null; app.view.dirty = true; }

  // The track under a click: the chain of trace cells between junctions, pins and vias.
  function trackAt(sh, layer, x, y) {
    const rid = sh[layer][G.key(x, y)];
    if (!rid) return [];
    const occ = app.view.geom(sh).occ;
    const nbrs = (cx, cy) => [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]].filter(([a, b]) => sh[layer][G.key(a, b)] === rid);
    const node = (cx, cy) => { const k = G.key(cx, cy); return occ.has(k) || (sh.top[k] && sh.top[k] === sh.bot[k]) || nbrs(cx, cy).length > 2; };
    if (node(x, y)) return [[layer, x, y]];
    const seen = new Set([G.key(x, y)]);
    const walk = ([cx, cy]) => {
      const out = [];
      while (!seen.has(G.key(cx, cy)) && !node(cx, cy)) {
        seen.add(G.key(cx, cy)); out.push([layer, cx, cy]);
        const next = nbrs(cx, cy).find(([a, b]) => !seen.has(G.key(a, b)));
        if (!next) break;
        [cx, cy] = next;
      }
      return out;
    };
    const [a, b] = nbrs(x, y);
    const left = a ? walk(a) : [], right = b ? walk(b) : [];
    return left.reverse().concat([[layer, x, y]], right);
  }

  function eraseTo(h) {
    const d = app.drag;
    if (h.F.path !== d.F.path || h.F.sheet !== d.F.sheet) return;
    let [x, y] = d.last || [h.x, h.y];
    const hit = (cx, cy) => {
      for (const l of d.both ? [G.TOP, G.BOT] : [app.layer]) G.erase(d.F.sheet, l, cx, cy);
    };
    hit(x, y);
    while (x !== h.x || y !== h.y) {
      if (x !== h.x) x += Math.sign(h.x - x); else y += Math.sign(h.y - y);
      hit(x, y);
    }
    d.last = [h.x, h.y]; app.version++;
  }
  // Tab: change layer; while routing, drop a via where the trace is.
  function toggleLayer() {
    const r = app.route, next = app.layer === G.TOP ? G.BOT : G.TOP;
    if (r) {
      const sh = r.F.sheet, occ = G.occupancy(sh, app.project.defs), [x, y] = r.last;
      if (occ.has(G.key(x, y))) { toast('No via on a pin or under an IC.'); return; }
      if (sh[next][G.key(x, y)] && sh[next][G.key(x, y)] !== r.rid) { toast('Another net is on the other layer here.'); return; }
      if (!r.rid) { r.rid = G.newRegion(sh); G.paint(sh, occ, r.layer, x, y, r.rid); }
      G.paint(sh, occ, next, x, y, r.rid);
      r.layer = next;
      app.version++; app.changed();
    }
    app.layer = next;
    updateToolbar(); app.view.dirty = true;
  }

  function toggleKnob(h) {
    const r = regionAt(h);
    if (!r) { toast('Click a region to give it a handle.'); return; }
    const reg = h.F.sheet.regions[r.rid];
    if (reg.knob) { delete reg.knob; app.changed(false); app.version++; return; }
    if (written(h.F.path + r.rid)) { toast('This register is written by a block. Only unwritten registers can have handles.'); return; }
    const v = regionValue(h.F, r.rid);
    reg.knob = { x: h.x, y: h.y, label: '', min: v < 0 ? 2 * v : 0, max: v > 0 ? 2 * v : (v < 0 ? 0 : 1), scale: 'lin' };
    app.sel = { kind: 'region', path: h.F.path, id: r.rid, F: h.F };
    app.version++; app.changed();
  }

  function placeAt(h, keep) {
    const b = app.ghost(h);
    if (b.type === 'comp' && h.F.def && (b.def === h.F.def.name || G.uses(app.project.defs, b.def, h.F.def.name))) {
      toast(`"${b.def}" can't go inside itself.`); return;
    }
    if (!G.canPlace(h.F.sheet, app.project.defs, b)) { toast('No room: an IC can only sit where traces touch its pins.'); return; }
    const nb = G.addBlock(h.F.sheet, app.project.defs, { type: b.type, def: b.def, x: b.x, y: b.y, rot: b.rot, window: b.type === 'scope' ? 512 : undefined });
    app.sel = { kind: 'block', path: h.F.path, id: nb.id, F: h.F };
    if (!keep) app.placing = null;
    updatePalette(); app.changed();
  }

  // Delete removes the selected block, or the selected track; with Shift, the whole net.
  function deleteSelection(wholeNet) {
    const s = app.sel;
    if (!s) return;
    if (s.kind === 'block') s.F.sheet.blocks = s.F.sheet.blocks.filter((b) => b.id !== s.id);
    else if (!wholeNet && s.run && s.run.length) for (const [l, x, y] of s.run) G.erase(s.F.sheet, l, x, y);
    else G.removeRegion(s.F.sheet, s.id);
    app.sel = null; app.changed(); renderInspector();
  }
  function rotate() {
    if (app.placing) { if (app.placing.type !== 'comp') app.placing.rot = ((app.placing.rot || 0) + 1) & 3; app.view.dirty = true; return; }
    const s = app.sel;
    if (!s || s.kind !== 'block') return;
    const b = s.F.sheet.blocks.find((x) => x.id === s.id);
    if (!b || b.type === 'comp') { toast('Composite blocks cannot be rotated in this prototype.'); return; }
    const trial = Object.assign({}, b, { rot: ((b.rot || 0) + 1) & 3 });
    if (!G.canPlace(s.F.sheet, app.project.defs, trial, b)) { toast('No room to rotate here.'); return; }
    b.rot = trial.rot; app.changed();
  }

  // ---- keyboard -----------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Tab') { e.preventDefault(); toggleLayer(); }
    else if (e.key === ' ') { e.preventDefault(); spaceDown = true; }
    else if (e.key === 'Escape') {
      if (app.route) endRoute();
      else if (app.placing) { app.placing = null; updatePalette(); }
      else zoomOut();
      app.view.dirty = true;
    }
    else if (e.key === 'Enter' && app.route) endRoute();
    else if (e.key === '/' && app.route) { app.route.hFirst = !app.route.hFirst; if (app.hover) routePreview(app.hover); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(e.shiftKey); }
    else if (k === 'v') setTool('select');
    else if (k === 'w' || k === 'x') setTool('route');
    else if (k === 'e') setTool('erase');
    else if (k === 'k') setTool('knob');
    else if (k === 'r') rotate();
    else if (k === 'z') zoomOut();
    else if (k === 'h' || e.key === 'Home') app.view.fitAll();
    else if (k === '.') { app.host.setRunning(false); app.host.step(); updateClock(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

  // ---- toolbar ---------------------------------------------------------------------
  function setTool(t) { app.tool = t; app.placing = null; app.route = null; updateToolbar(); updatePalette(); app.view.dirty = true; }
  function updateToolbar() {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === app.tool && !app.placing));
    $('#btn-layer').textContent = app.layer === G.TOP ? 'Layer: top' : 'Layer: bottom';
    $('#btn-layer').classList.toggle('bot', app.layer === G.BOT);
    canvas.style.cursor = app.tool === 'route' || app.tool === 'erase' || app.placing ? 'crosshair' : 'default';
  }
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-layer').addEventListener('click', toggleLayer);

  // The single clock slider: log scale from 0.5 Hz up to real time.
  const rateFrom = (x) => (x >= 0.999 ? RATE_MAX : RATE_MIN * Math.pow(RATE_MAX / RATE_MIN, x));
  const sliderFrom = (r) => Math.log(r / RATE_MIN) / Math.log(RATE_MAX / RATE_MIN);
  function rateLabel(r) {
    if (r >= RATE_MAX) return 'real time · 48 kHz';
    const s = r >= 1000 ? (r / 1000).toFixed(r >= 10000 ? 0 : 1) + ' kHz' : r >= 10 ? r.toFixed(0) + ' Hz' : r.toFixed(1) + ' Hz';
    const slow = RATE_MAX / r;
    return `${s} · ${slow < 100 ? slow.toFixed(1) : Math.round(slow).toLocaleString('en-US')}× slower`;
  }
  function updateClock() {
    const h = app.host;
    $('#rate-label').textContent = rateLabel(h.rate);
    $('#btn-run').textContent = h.running ? 'Pause' : 'Run';
    $('#btn-audio').textContent = h.audioOn ? '■ DAC on' : '▶ Start audio';
    $('#btn-audio').classList.toggle('on', h.audioOn);
  }
  $('#rate').addEventListener('input', (e) => { app.host.setRate(rateFrom(Number(e.target.value))); updateClock(); });
  $('#btn-run').addEventListener('click', () => { app.host.setRunning(!app.host.running); updateClock(); });
  $('#btn-step').addEventListener('click', () => { app.host.setRunning(false); app.host.step(); updateClock(); });
  $('#btn-reset').addEventListener('click', () => { app.host.reset(); });
  $('#btn-audio').addEventListener('click', async () => {
    try { app.host.audioOn ? await app.host.stopAudio() : await app.host.startAudio(); }
    catch (err) { toast('Could not start audio: ' + err.message); }
    updateClock(); updateBanner();
  });
  function setRate(r) { app.host.setRate(r); $('#rate').value = sliderFrom(r); updateClock(); }

  // ---- palette ---------------------------------------------------------------------
  function updatePalette() {
    const item = (kind, type, sym, title, tip) => {
      const on = app.placing && app.placing.type === (kind === 'def' ? 'comp' : type) && (kind !== 'def' || app.placing.def === type);
      return `<div class="pitem${on ? ' on' : ''}" data-place="${kind}:${esc(type)}" title="${esc(tip)}"><span class="psym">${esc(sym)}</span><span>${esc(title)}</span></div>`;
    };
    let s = '<h3>Atoms</h3>';
    for (const t of G.ATOM_ORDER) s += item('atom', t, G.ATOMS[t].sym, G.ATOMS[t].title, G.ATOMS[t].eq + '\n' + G.DOCS[t]);
    s += '<h3>Outputs</h3>';
    for (const t of G.SINK_ORDER) s += item('atom', t, G.SINKS[t].sym, G.SINKS[t].title, G.DOCS[t]);
    s += '<h3>Library</h3>';
    for (const n of Object.keys(app.project.defs).sort()) s += item('def', n, '▣', n, app.project.defs[n].description || '');
    s += '<div class="pbuttons"><button id="btn-newdef">+ New block</button></div>';
    s += '<p class="dim small">A constant is a net nobody writes. Route a short trace from an input pin, then give it a handle with the knob tool (K).</p>';
    $('#palette').innerHTML = s;
  }
  $('#palette').addEventListener('click', (e) => {
    if (e.target.id === 'btn-newdef') return newDefinition();
    const it = e.target.closest('[data-place]');
    if (!it) return;
    const [kind, name] = it.dataset.place.split(':');
    app.placing = kind === 'def' ? { type: 'comp', def: name } : { type: name, rot: 0 };
    updatePalette(); updateToolbar();
    toast('Click to place, R to rotate, Shift-click to place several, Esc to cancel.');
  });
  function newDefinition() {
    const name = prompt('Name for the new block', 'MyBlock');
    if (!name) return;
    if (app.project.defs[name]) { toast(`"${name}" already exists.`); return; }
    app.project.defs[name] = G.makeDef(name, 4, 3, 8, [{ dir: 'in', row: 1, name: 'in' }, { dir: 'out', row: 1, name: 'out' }], '');
    app.placing = { type: 'comp', def: name };
    app.changed(); updatePalette(); updateToolbar();
    toast(`Place your "${name}" somewhere, then zoom into it to build its insides.`);
  }

  // ---- inspector -------------------------------------------------------------------
  function renderInspector() {
    const el = $('#inspector');
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
    const s = app.sel;
    if (s && s.kind === 'block') {
      const b = s.F.sheet.blocks.find((x) => x.id === s.id);
      if (b) { el.innerHTML = blockHtml(s.F, b); return; }
    }
    if (s && s.kind === 'region' && s.F.sheet.regions[s.id]) { el.innerHTML = regionHtml(s.F, s.id); return; }
    el.innerHTML = reportHtml();
  }
  const field = (label, prop, value, type, extra) =>
    `<label class="field"><span>${label}</span><input data-prop="${prop}" type="${type || 'text'}" value="${esc(value === undefined ? '' : value)}" ${extra || ''}></label>`;
  const where = (F) => (F.chain.length ? 'inside ' + F.chain.join(' › ') : 'root');

  function blockHtml(F, b) {
    if (b.type === 'comp') {
      const def = app.project.defs[b.def];
      let h = `<h2>${esc(b.def)} <span class="dim">${b.id}</span></h2><p class="dim small">${where(F)}</p>`;
      h += `<p>${esc(def ? def.description || 'Composite block.' : 'Missing definition!')}</p>`;
      h += '<p><button data-act="zoom">Zoom in ⤵</button></p>';
      if (def) {
        h += `<h3>Definition (shared by ${instances(b.def)})</h3>`;
        h += `<p class="dim small">Footprint ${def.fw}×${def.fh} cells; inside is ${def.s}× finer (${def.fw * def.s}×${def.fh * def.s}).</p>`;
        h += `<label class="field col"><span>Description</span><textarea data-prop="def.description" rows="3">${esc(def.description || '')}</textarea></label>`;
        h += '<h3>Ports</h3><table class="ports">';
        def.ports.forEach((p, i) => {
          h += `<tr><td>${p.dir}</td><td><input data-prop="port.${i}.name" value="${esc(p.name)}"></td>
            <td><input data-prop="port.${i}.row" type="number" min="0" max="${def.fh - 1}" value="${p.row}"></td>
            <td><button class="mini" data-act="delport" data-i="${i}">×</button></td></tr>`;
        });
        h += '</table><p><button data-act="addin">+ input</button> <button data-act="addout">+ output</button></p>';
        h += '<p class="dim small">Inputs sit on the left column and outputs on the right, at the given row. Inside, each port is a pad on the edge at the same place.</p>';
      }
      return h + '<p><button data-act="delete" class="danger">Delete</button></p>';
    } else {
      const t = G.info(b.type);
      let h0 = `<h2>${t.title} <span class="dim">${b.id}</span></h2><p class="dim small">${where(F)}</p>`;
      h0 += `<div class="eq">${esc(t.eq)}</div><p>${esc(G.DOCS[b.type])}</p>`;
      const code = app.compiled && app.compiled.nodeCode[F.path + b.id];
      if (code) h0 += `<h3>Compiled as</h3><pre class="code small">${esc(code)}</pre>`;
      if (b.type === 'scope') {
        h0 += `<label class="field"><span>Ticks shown</span><select data-prop="window">${[16, 64, 256, 512, 2048, 4800, 16384, 48000]
          .map((n) => `<option ${b.window === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
      }
      h0 += '<p class="dim small">R rotates.</p>';
      return h0 + '<p><button data-act="delete" class="danger">Delete</button></p>';
    }
  }

  function regionHtml(F, rid) {
    const reg = F.sheet.regions[rid], key = F.path + rid;
    const cells = G.cellsOf(F.sheet, rid);
    const vias = cells.filter(([l, x, y]) => l === G.TOP && F.sheet.bot[G.key(x, y)] === rid).length;
    const w = written(key), st = app.knobState(key), v = app.valueOf(key);
    let h = `<h2>Net ${rid}</h2><p class="dim small">${where(F)} · ${cells.length} cells${vias ? `, ${vias} via${vias > 1 ? 's' : ''}` : ''} · a register</p>`;
    h += `<div class="eq">${esc(GW.fmt(v) || '—')}</div>`;
    if (w) {
      h += '<p>Written by a block on every tick.</p>';
    } else {
      h += '<p>Nobody writes this register, so it is a constant.</p>';
      if (st === 'overridden') h += '<p class="dim">Its value is set by a register outside this block.</p>';
      else h += field(F.path ? 'Value (this instance)' : 'Value', 'value', regionValue(F, rid), 'number', 'step="any"');
      if (F.path && st !== 'overridden') h += `<p class="dim small">Default for new instances: ${GW.fmt(reg.value)} <button class="mini" data-act="default">make this the default</button></p>`;
    }
    if (reg.knob) {
      const k = reg.knob;
      h += '<h3>Handle</h3>';
      if (st !== 'ok') h += `<p class="err small">${st === 'written' ? 'Dead: the register is written by a block.' : 'Overridden from outside.'}</p>`;
      h += field('Label', 'knob.label', k.label);
      h += field('Min', 'knob.min', k.min, 'number', 'step="any"');
      h += field('Max', 'knob.max', k.max, 'number', 'step="any"');
      h += `<label class="field"><span>Scale</span><select data-prop="knob.scale">${['lin', 'log'].map((x) => `<option ${k.scale === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`;
      h += '<p><button data-act="rmknob">Remove handle</button></p>';
    } else if (!w) h += '<p class="dim small">Use the knob tool (K) on one of its cells to give it a handle.</p>';
    if (app.sel && app.sel.run && app.sel.run.length) h += `<p class="dim small">Selected track: ${app.sel.run.length} cell(s), shown white. Delete removes it; Shift+Delete removes the whole net.</p>`;
    h += '<p><button data-act="delete" class="danger">Delete track</button> <button data-act="deletenet" class="danger">Delete net</button></p>';
    return h;
  }

  function reportHtml() {
    const c = app.compiled;
    if (!c) return '';
    let h = '<h2>Design</h2>';
    if (c.errors.length) h += '<h3 class="err">Errors</h3><ul class="err">' + c.errors.map((e) => `<li>${esc(e.msg)}</li>`).join('') + '</ul><p class="dim small">The last error-free design keeps running.</p>';
    const r = c.resources;
    h += `<table class="res">
      <tr><td>Registers (flip-flop outputs)</td><td>${c.nState}</td></tr>
      <tr><td>Wires (settle within a tick)</td><td>${c.nNets - c.nState}</td></tr>
      <tr><td>Constants</td><td>${c.params.length}</td></tr>
      <tr><td>Adders</td><td>${r.adder}</td></tr><tr><td>Multipliers</td><td>${r.multiplier}</td></tr>
      <tr><td>Comparators</td><td>${r.comparator}</td></tr><tr><td>Switches</td><td>${r.mux}</td></tr>
      <tr><td>Flip-flops</td><td>${r.buffer}</td></tr></table>`;
    h += `<h3>Critical path: ${c.critDepth} operation${c.critDepth === 1 ? '' : 's'}</h3>
      <p class="dim small">The longest chain of logic between flip-flops. On real hardware all of it must settle within one clock period (${(1e6 / G.FS).toFixed(1)} µs here). Putting a flip-flop in the middle of the chain (pipelining) shortens it, at the cost of one tick of delay.</p>`;
    if (c.critical.length) h += `<ol class="crit small">${c.critical.map((x) => `<li>${esc(x.name)} <span class="dim">${esc(x.path)}</span></li>`).join('')}</ol>`;
    if (c.warnings.length) h += `<details><summary>${c.warnings.length} warning(s)</summary><ul>${c.warnings.map((w) => `<li>${esc(w.path)}: ${esc(w.msg)}</li>`).join('')}</ul></details>`;
    h += `<h3>Colour = value</h3><div class="legend"><div class="bar neg"></div><div class="bar pos"></div></div>
      <div class="legend-labels"><span>−10⁴</span><span>−1</span><span>0</span><span>1</span><span>10⁴</span></div>`;
    h += '<p><button data-act="code">Show compiled code</button></p>';
    return h;
  }

  $('#inspector').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act, s = app.sel;
    if (!act) return;
    if (act === 'code') { $('#code-dlg pre').textContent = app.compiled.code; $('#code-dlg').showModal(); return; }
    if (act === 'delete') return deleteSelection(false);
    if (act === 'deletenet') return deleteSelection(true);
    if (!s) return;
    if (s.kind === 'block') {
      const b = s.F.sheet.blocks.find((x) => x.id === s.id), def = b && app.project.defs[b.def];
      if (act === 'zoom') zoomToBlock(s.F, b);
      if (def && (act === 'addin' || act === 'addout')) {
        const dir = act === 'addin' ? 'in' : 'out';
        const used = new Set(def.ports.filter((p) => p.dir === dir).map((p) => p.row));
        let row = 0; while (used.has(row)) row++;
        if (row >= def.fh) { toast('No free row on that side; make the block taller first.'); return; }
        def.ports.push({ dir, row, name: dir + (def.ports.filter((p) => p.dir === dir).length + 1) });
        app.changed(); renderInspector();
      }
      if (def && act === 'delport') { def.ports.splice(Number(e.target.dataset.i), 1); app.changed(); renderInspector(); }
    } else {
      const reg = s.F.sheet.regions[s.id];
      if (act === 'rmknob') { delete reg.knob; app.changed(); renderInspector(); }
      if (act === 'default') { reg.value = regionValue(s.F, s.id); delete app.project.values[s.F.path + s.id]; app.changed(); renderInspector(); }
    }
  });
  $('#inspector').addEventListener('change', (e) => {
    const prop = e.target.dataset && e.target.dataset.prop, s = app.sel;
    if (!prop || !s) return;
    const v = e.target.value, num = Number(v);
    if (s.kind === 'region') {
      const reg = s.F.sheet.regions[s.id];
      if (prop === 'value' && Number.isFinite(num)) setRegionValue(s.F, s.id, num);
      else if (prop.startsWith('knob.')) {
        const k = prop.slice(5);
        reg.knob[k] = k === 'min' || k === 'max' ? (Number.isFinite(num) ? num : reg.knob[k]) : v;
        app.changed(false);
      }
      return;
    }
    const b = s.F.sheet.blocks.find((x) => x.id === s.id);
    if (!b) return;
    if (prop === 'window') { b.window = num; app.changed(); return; }
    const def = app.project.defs[b.def];
    if (prop === 'def.description') def.description = v;
    else if (prop.startsWith('port.')) {
      const [, i, k] = prop.split('.');
      const p = def.ports[Number(i)];
      if (k === 'name') p.name = v;
      else if (Number.isInteger(num) && num >= 0 && num < def.fh && !def.ports.some((q) => q !== p && q.dir === p.dir && q.row === num)) p.row = num;
      else { toast('That row is taken or outside the block.'); renderInspector(); return; }
    }
    app.changed();
  });
  $('#inspector').addEventListener('focusout', () => setTimeout(() => { if (!$('#inspector').contains(document.activeElement)) renderInspector(); }, 0));

  // ---- status, banner, toast -----------------------------------------------------
  function updateStatus() {
    const h = app.hover;
    if (!h) { $('#status').textContent = ''; return; }
    let s = (h.F.chain.length ? 'Board › ' + h.F.chain.join(' › ') : 'Board') + `   ${h.x},${h.y}   ${app.layer === G.TOP ? 'top' : 'bottom'} layer`;
    if (app.route) s += '   ·   routing: click = corner, / = flip, Tab = via, Esc = done';
    const r = regionAt(h);
    if (r) {
      const key = h.F.path + r.rid;
      s += `   ·   ${r.rid}${written(key) ? ' (written)' : ' (constant)'} = ${GW.fmt(app.valueOf(key))}`;
    } else if (h.occ && h.occ.block) s += `   ·   ${h.occ.block.type === 'comp' ? h.occ.block.def : G.info(h.occ.block.type).title}${h.occ.pad ? ' pad ' + (h.occ.pad.name || h.occ.pad.dir) : ''}`;
    if (h.F.def) s += `   ·   editing "${h.F.def.name}", shared by ${instances(h.F.def.name)} instance(s)`;
    $('#status').textContent = s;
  }
  function updateBanner() {
    const m = [];
    if (app.compiled && !app.compiled.ok) m.push(['err', '⚠ ' + app.compiled.errors[0].msg]);
    if (app.snap && app.snap.bad) m.push(['err', 'The DAC saw NaN or ∞ — press Reset.']);
    $('#banner').innerHTML = m.map(([k, s]) => `<div class="${k}">${esc(s)}</div>`).join('');
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3500);
  }

  // ---- files and examples ----------------------------------------------------------
  function loadProject(p) {
    p.values = p.values || {};
    app.project = p; app.sel = null; app.placing = null; app.version++;
    updatePalette(); app.changed();
    recompile(); renderInspector();
    requestAnimationFrame(() => app.view.fitAll());
  }
  $('#examples').innerHTML = '<option value="">Examples…</option>' + GW.EXAMPLES.map((x, i) => `<option value="${i}">${esc(x.title)}</option>`).join('');
  $('#examples').addEventListener('change', (e) => {
    const i = Number(e.target.value); e.target.value = '';
    if (!GW.EXAMPLES[i] || !confirm(`Load "${GW.EXAMPLES[i].title}"? This replaces the root sheet (the library is kept).`)) return;
    loadExample(i);
  });
  function loadExample(i) {
    loadProject(GW.exampleProject(i, app.project ? app.project.defs : null));
    app.host.reset(); setRate(GW.EXAMPLES[i].rate); app.host.setRunning(true); updateClock();
    if (!EMBED) toast(GW.EXAMPLES[i].note, 8000);
  }

  // Fly straight into a chain of ICs, e.g. "VCO>Phasor" (used by the style gallery).
  function focusOn(spec) {
    let F = app.view.rootFrame(), rect = null;
    for (const name of spec.split('>')) {
      const b = F.sheet.blocks.find((x) => x.type === 'comp' && x.def === name);
      if (!b) break;
      const fp = G.footprint(b, app.project.defs);
      rect = [F.ox + b.x * F.sc, F.oy + b.y * F.sc, F.ox + (b.x + fp.w) * F.sc, F.oy + (b.y + fp.h) * F.sc];
      F = app.view.child(F, b);
    }
    if (!rect) return;
    app.view.fitRect(rect[0], rect[1], rect[2], rect[3], 0.03);
    Object.assign(app.view.cam, app.view.target);
    app.view.dirty = true;
  }

  function renderStyleMenu() {
    let h = '';
    for (const k in STYLES) {
      h += `<fieldset><legend>${STYLES[k].label}</legend>`;
      for (const [v, label] of Object.entries(STYLES[k].options)) {
        h += `<label><input type="radio" name="st-${k}" value="${v}" ${app.style[k] === v ? 'checked' : ''}> ${label}</label>`;
      }
      h += '</fieldset>';
    }
    h += '<p class="dim small"><a href="styles.html" target="_blank">Compare all styles side by side →</a></p>';
    $('#style-pop').innerHTML = h;
  }
  $('#btn-style').addEventListener('click', () => { $('#style-pop').hidden = !$('#style-pop').hidden; renderStyleMenu(); });
  $('#style-pop').addEventListener('change', (e) => {
    const k = e.target.name && e.target.name.slice(3);
    if (!STYLES[k]) return;
    app.style[k] = e.target.value;
    localStorage.setItem(STYLE_KEY, JSON.stringify(app.style));
    app.view.dirty = true;
  });
  $('#btn-export').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(app.project)], { type: 'application/json' }));
    a.download = 'clockwork-grid.json'; a.click();
  });
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!p.root || !p.defs) throw new Error('not a Clockwork Grid file');
      if (confirm('Replace the current project?')) loadProject(p);
    } catch (err) { toast('Import failed: ' + err.message); }
  });
  $('#btn-help').addEventListener('click', () => $('#help-dlg').showModal());
  document.querySelectorAll('dialog .close').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---- start ------------------------------------------------------------------------
  app.host = new GW.Host((snap) => {
    const wasBad = app.snap && app.snap.bad;
    app.snap = snap;
    $('#ticks').textContent = 'tick ' + snap.ticks.toLocaleString('en-US');
    app.view.dirty = true;
    if (!!snap.bad !== !!wasBad) updateBanner();
  }, (msg) => { if (msg) toast(msg); updateClock(); });
  app.view = new GW.View(app, canvas);
  $('#rate').value = 1;

  if (EMBED) document.body.classList.add('embed');
  let saved = null;
  try { saved = EMBED ? null : JSON.parse(localStorage.getItem(STORE)); } catch (e) { saved = null; }
  if (Q.has('example')) loadExample(Number(Q.get('example')) || 0);
  else if (saved && saved.root && saved.version === 2) { loadProject(saved); updateClock(); }
  else loadExample(2);
  if (Q.has('rate')) setRate(Math.min(RATE_MAX, Math.max(RATE_MIN, Number(Q.get('rate')) || RATE_MAX)));
  if (Q.has('focus')) setTimeout(() => focusOn(Q.get('focus')), 100);
  setTool('select');
})();
