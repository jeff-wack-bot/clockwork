// Sample Factory application: turns pointer, key and panel events into edits
// (most of them in editor.js), and keeps the view, inspector and audio in step.
// Every user gesture ends with app.commit(), which records an undo snapshot if
// the project changed.
(function () {
  'use strict';
  const G = window.GW, E = window.GW.Editor;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'samplefactory.board.v1', OLD_STORE = 'clockwork.grid.v1';   // a Clockwork Board project still opens
  const RATE_MIN = 0.5, RATE_MAX = G.FS;

  const app = {
    project: null, compiled: null, running: null, snap: null,
    version: 1, tool: 'select', layer: G.TOP,
    sel: null,            // Editor selection { F, blocks, cells, region }, or null
    hover: null, hotRegion: null, placing: null, pasting: null, drag: null, route: null,
    history: new E.History(200), clip: null,
  };
  window.gapp = app;

  // ---- visual style (the style lab) -----------------------------------------------
  const Q = new URLSearchParams(location.search);
  const EMBED = Q.get('embed') === '1';
  const STYLE_KEY = 'samplefactory.style.v1';
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
    if (c.ok) { app.running = c; app.host.load(c, scopeWins(c)); fetchSamples(c); }
    updateBanner();
  }

  // ---- sample stacks ------------------------------------------------------------
  // The project stores only a sample's id; the samples live in IndexedDB (or, for
  // the built-in song, are synthesized). Fetch whatever the program needs.
  app.missing = new Set();
  const fetching = new Set();
  function fetchSamples(c) {
    for (const pl of c.players) {
      const id = pl.sample;
      if (!id || app.host.lib.has(id) || fetching.has(id)) continue;
      fetching.add(id);
      GW.Samples.load(id).then((e) => {
        fetching.delete(id);
        if (e) { app.missing.delete(id); app.host.addSample(id, e.data); }
        else app.missing.add(id);
        app.view.dirty = true; updateBanner(); renderInspector();
      });
    }
  }
  const wavInput = $('#wav-input');
  let wavTarget = null;   // {F, b}: the block a chosen file goes into
  function pickWav(F, b) { wavTarget = { F, b }; wavInput.click(); }
  wavInput.addEventListener('change', () => {
    const f = wavInput.files[0]; wavInput.value = '';
    if (f && wavTarget) loadWavInto(wavTarget.F, wavTarget.b, f);
  });
  async function loadWavInto(F, b, file) {
    toast(`Decoding ${file.name}…`, 20000);
    let e;
    try { e = await GW.Samples.decode(file); } catch (err) { toast(`Could not decode ${file.name}: ${err && err.message || err}`); return; }
    app.host.addSample(e.id, e.data);
    app.missing.delete(e.id);
    Object.assign(b, { sample: e.id, name: e.name });
    selectBlock(F, b);
    app.changed(); app.commit('load WAV'); renderInspector();
    const secs = e.data.length / G.FS;
    toast(`${e.name}: ${e.data.length.toLocaleString('en-US')} samples (${fmtTime(secs)}), one per tick.` +
      (e.stored ? '' : ' It could not be saved in this browser, so you will need to load it again after a reload.'), 6000);
  }
  const fmtTime = (secs) => `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`;
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

  // ---- selection -------------------------------------------------------------------
  const sameFrame = (a, b) => !!(a && b && a.path === b.path && a.sheet === b.sheet);
  function select(sel) {
    app.sel = sel && (!E.isEmpty(sel) || sel.region) ? sel : null;
    renderInspector(); updateToolbar(); app.view.dirty = true;
  }
  function selectBlock(F, b) { const s = E.emptySelection(F); s.blocks.add(b.id); select(s); }
  // The one block selected, if exactly one block (and nothing else) is.
  function selBlock() {
    const s = app.sel;
    if (!s || s.blocks.size !== 1 || s.cells.size) return null;
    const b = s.F.sheet.blocks.find((x) => x.id === [...s.blocks][0]);
    return b ? { F: s.F, b } : null;
  }
  // The net shown in the inspector after clicking a trace.
  function selRegion() {
    const s = app.sel;
    return s && s.region && !s.blocks.size && s.F.sheet.regions[s.region] ? { F: s.F, rid: s.region } : null;
  }
  // The board that keyboard commands apply to: the selection's, else the one under the pointer.
  const activeFrame = () => (app.sel ? app.sel.F : app.hover && isLive(app.hover.F) ? app.hover.F : app.view.rootFrame());
  // Is this frame's board still part of the project (not left over from before an undo or a load)?
  const isLive = (F) => F.sheet === app.project.root || Object.values(app.project.defs).includes(F.sheet);

  // ---- undo --------------------------------------------------------------------------
  app.commit = (label) => {
    if (app.project && app.history.record(JSON.stringify(app.project), label)) updateToolbar();
  };
  function restore(r, verb) {
    if (!r) { toast(`Nothing to ${verb.toLowerCase()}.`); return; }
    app.project = JSON.parse(r.state);
    app.sel = null; app.route = null; app.placing = null; app.pasting = null; app.drag = null; app.hover = null; app.hotRegion = null;
    app.version++; app.changed(); updatePalette(); renderInspector(); updateToolbar();
    toast(`${verb}: ${r.label}`, 1800);
  }
  app.undo = () => restore(app.history.undo(), 'Undo');
  app.redo = () => restore(app.history.redo(), 'Redo');

  // ---- clipboard ---------------------------------------------------------------------
  // Kept in memory and in localStorage, so it survives a reload and works across tabs.
  const CLIP_KEY = 'samplefactory.clipboard';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function describe(sel) {
    const parts = [];
    if (sel.blocks.size) parts.push(plural(sel.blocks.size, 'block'));
    if (sel.cells.size) parts.push(plural(sel.cells.size, 'trace cell'));
    return parts.join(' and ');
  }
  function copySelection(cut) {
    const s = app.sel;
    if (E.isEmpty(s)) { toast('Nothing selected.'); return; }
    app.clip = E.copy(app.project, s.F, s);
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(app.clip)); } catch (err) { /* memory only */ }
    if (cut) {
      E.remove(app.project, s.F, s);
      select(null); app.changed(); app.commit('cut ' + describe(s));
    }
    toast(`${cut ? 'Cut' : 'Copied'} ${describe(s)}.`, 1800);
  }
  function clipboard() {
    if (app.clip) return app.clip;
    try { const c = JSON.parse(localStorage.getItem(CLIP_KEY)); if (c && c.kind === 'samplefactory.clip') return c; } catch (err) { /* none */ }
    return null;
  }
  function startPaste() {
    const clip = clipboard();
    if (!clip) { toast('The clipboard is empty: select something and press Ctrl+C.'); return; }
    app.pasting = clip; app.placing = null; app.route = null;
    updateToolbar(); app.view.dirty = true;
    toast('Click to paste (Shift-click to paste again), Esc to cancel.');
  }
  app.pasteOrigin = (h, clip) => ({ x: h.x - Math.floor((clip.w - 1) / 2), y: h.y - Math.floor((clip.h - 1) / 2) });
  function pasteAt(h, keep) {
    const clip = app.pasting, o = app.pasteOrigin(h, clip);
    const r = E.paste(app.project, h.F, clip, o.x, o.y);
    if (r.error) { toast(r.error); return; }
    if (!keep) app.pasting = null;
    select(r.sel); app.changed(); app.commit('paste');
  }
  // Duplicate: paste a copy right next to the selection if there is room, else let the user place it.
  function duplicate() {
    const s = app.sel;
    if (E.isEmpty(s)) { toast('Nothing selected.'); return; }
    const clip = E.copy(app.project, s.F, s), bb = E.bounds(s.F, app.project.defs, s);
    for (const [dx, dy] of [[0, clip.h + 1], [clip.w + 1, 0], [0, -clip.h - 1], [-clip.w - 1, 0], [2, 2]]) {
      if (!E.pasteProblem(app.project, s.F, clip, bb.x0 + dx, bb.y0 + dy)) {
        const r = E.paste(app.project, s.F, clip, bb.x0 + dx, bb.y0 + dy);
        select(r.sel); app.changed(); app.commit('duplicate ' + describe(s));
        return;
      }
    }
    app.clip = clip; startPaste();
  }
  function nudge(dx, dy) {
    const s = app.sel;
    if (E.isEmpty(s)) return;
    const r = E.rubberMove(app.project, s.F, s, E.snapshot(s.F.sheet), dx, dy);
    if (!r) { toast('Something is in the way.', 1500); return; }
    select(r.sel); app.version++; app.changed(); app.commit('move ' + describe(r.sel));
    if (r.unconnected.length) toast(`${plural(r.unconnected.length, 'pin')} could not be routed back.`, 3000);
  }
  function selectAll() {
    const F = activeFrame();
    select(E.selectAll(F, app.project.defs));
    toast(`Selected ${describe(app.sel || E.emptySelection(F)) || 'nothing'}.`, 1500);
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
  // Drop a WAV on the board: onto a Sample block to replace its song, or anywhere else for a new block.
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const p = pos(e), h = app.view.locate(p.x, p.y);
    if (!h) return;
    let b = h.occ && h.occ.block && h.occ.block.type === 'sample' ? h.occ.block : null;
    if (!b) {
      const ghost = Object.assign({ type: 'sample', rot: 0, loop: true }, { x: h.x - 5, y: h.y - 1 });
      if (!G.canPlace(h.F.sheet, app.project.defs, ghost)) { toast('No room for a Sample block there (10×3 cells).'); return; }
      b = G.addBlock(h.F.sheet, app.project.defs, ghost);
      app.changed(); app.commit('place Sample');
    }
    loadWavInto(h.F, b, f);
  });
  // Select tool: drag on empty board to box-select, click to select (Shift adds or
  // removes), drag a selected item to move the whole selection, drag a knob to turn
  // it. Right-, middle- or Space-drag pans in every tool; the wheel zooms.
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    const p = pos(e), h = app.view.locate(p.x, p.y);
    if (e.button === 1 || e.button === 2 || spaceDown || !h) { app.drag = { kind: 'pan', x: p.x, y: p.y }; setCursor(); return; }
    if (e.button !== 0) return;
    if (app.pasting) { pasteAt(h, e.shiftKey); return; }
    if (app.placing) { placeAt(h, e.shiftKey); return; }
    if (app.tool === 'erase') { app.drag = { kind: 'erase', F: h.F, last: null, both: e.shiftKey }; eraseTo(h); return; }
    if (app.tool === 'route') { app.route ? routeCommit(h) : routeStart(h); return; }
    if (app.tool === 'knob') { toggleKnob(h); return; }
    const krid = knobAt(h);
    if (krid) {
      const st = app.knobState(h.F.path + krid);
      if (st !== 'ok') { toast(st === 'written' ? 'This net is written by a block, so its handle is dead.' : 'This knob is overridden by a net outside the block.'); return; }
      const kb = h.F.sheet.regions[krid].knob;
      app.drag = { kind: 'knob', F: h.F, rid: krid, frac: GW.knobFrac(kb, regionValue(h.F, krid)), y: p.y };
      return;
    }
    const b = h.occ && h.occ.block, r = !b && regionAt(h);
    if (b || r) {
      const cur = app.sel && sameFrame(app.sel.F, h.F) ? app.sel : null;
      const track = r ? E.trackAt(h.F.sheet, app.project.defs, r.layer, h.x, h.y).map(([l, x, y]) => E.ck(l, x, y)) : [];
      const inSel = cur && (b ? cur.blocks.has(b.id) : cur.cells.has(E.ck(r.layer, h.x, h.y)));
      if (e.shiftKey && cur) {                         // add to, or take from, the selection
        if (b) { inSel ? cur.blocks.delete(b.id) : cur.blocks.add(b.id); }
        else for (const c of track) inSel ? cur.cells.delete(c) : cur.cells.add(c);
        if (r && !inSel) cur.region = r.rid;
        select(cur);
        return;
      }
      if (!inSel) {
        const s = E.emptySelection(h.F);
        if (b) s.blocks.add(b.id); else { track.forEach((c) => s.cells.add(c)); s.region = r.rid; }
        select(s);
      } else if (r && app.sel.region !== r.rid) { app.sel.region = r.rid; renderInspector(); }
      app.drag = { kind: 'move', F: h.F, hx: h.x, hy: h.y, dx: 0, dy: 0, moved: false, sel0: app.sel, snap: E.snapshot(h.F.sheet), unconnected: [] };
      setCursor();
      return;
    }
    app.drag = { kind: 'marquee', F: h.F, x0: h.x, y0: h.y, x1: h.x, y1: h.y, add: e.shiftKey, sx: p.x, sy: p.y, far: false };
  });

  // Board coordinates of a screen point in a given frame, even when the pointer has
  // wandered into a deeper (or shallower) board.
  function cellIn(F, p) {
    const w = app.view.toWorld(p.x, p.y);
    return { x: Math.floor((w.x - F.ox) / F.sc), y: Math.floor((w.y - F.oy) / F.sc) };
  }

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
    if (d && d.kind === 'move' && app.sel) {
      // Always from the board as it was at the start of the drag; blocks drag their
      // traces along (rubber-banding). Try the whole offset, then each axis alone,
      // so the selection slides along obstacles.
      const c = cellIn(d.F, p), wx = c.x - d.hx, wy = c.y - d.hy;
      if (wx !== d.dx || wy !== d.dy) {
        let done = false;
        for (const [ox, oy] of [[wx, wy], [wx, d.dy], [d.dx, wy]]) {
          if (ox === d.dx && oy === d.dy) continue;
          const r = E.rubberMove(app.project, d.F, d.sel0, d.snap, ox, oy);
          if (r) { app.sel = r.sel; d.dx = ox; d.dy = oy; d.unconnected = r.unconnected; d.moved = true; done = true; break; }
        }
        if (!done) { const r = E.rubberMove(app.project, d.F, d.sel0, d.snap, d.dx, d.dy); if (r) app.sel = r.sel; d.blocked = true; }
        app.version++;
      }
    }
    if (d && d.kind === 'marquee') {
      const c = cellIn(d.F, p);
      d.x1 = c.x; d.y1 = c.y;
      if (Math.hypot(p.x - d.sx, p.y - d.sy) > 4) d.far = true;
    }
    const r = h && regionAt(h);
    app.hotRegion = r ? { path: h.F.path, rid: r.rid } : null;
    if (!d) setCursor(h);
    updateStatus();
    app.view.dirty = true;
  });

  canvas.addEventListener('pointerup', () => {
    const d = app.drag;
    app.drag = null;
    setCursor(app.hover);
    if (!d) return;
    if (d.kind === 'marquee') {
      if (!d.far) { if (!d.add) select(null); }       // a click on empty board
      else {
        const base = d.add && app.sel && sameFrame(app.sel.F, d.F) ? app.sel : null;
        select(E.selectRect(d.F, app.project.defs, d, base));
      }
    }
    if (d.kind === 'move' && d.moved && (d.dx || d.dy)) {
      app.changed(); app.commit('move ' + describe(app.sel)); renderInspector();
      if (d.unconnected.length) toast(`${plural(d.unconnected.length, 'pin')} could not be routed back to ${d.unconnected.length === 1 ? 'its net' : 'their nets'}: route ${d.unconnected.length === 1 ? 'it' : 'them'} by hand (W).`, 5000);
    } else if (d.kind === 'move' && d.blocked && !d.moved) toast('Something is in the way.', 1500);
    if (d.kind === 'erase') { app.changed(); app.commit('erase'); }
    if (d.kind === 'knob') app.commit('turn knob');
    app.view.dirty = true;
  });
  canvas.addEventListener('pointerleave', () => { if (!app.drag) { app.hover = null; app.hotRegion = null; app.view.dirty = true; updateStatus(); } });

  // Cursor feedback: what a click here would do.
  function setCursor(h) {
    let c = 'default';
    const d = app.drag;
    if (d) c = d.kind === 'pan' ? 'grabbing' : d.kind === 'move' ? 'move' : d.kind === 'knob' ? 'ns-resize' : 'crosshair';
    else if (spaceDown) c = 'grab';
    else if (app.placing || app.pasting || app.tool === 'route' || app.tool === 'erase') c = 'crosshair';
    else if (app.tool === 'knob') c = 'cell';
    else if (h && knobAt(h)) c = 'ns-resize';
    else if (h && h.occ && h.occ.block) c = 'move';
    else if (h && regionAt(h)) c = 'pointer';
    canvas.style.cursor = c;
  }

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
    if (b && b.type === 'sample') { pickWav(h.F, b); return; }
    const krid = knobAt(h);
    if (krid && app.knobState(h.F.path + krid) === 'ok') {
      const kb = h.F.sheet.regions[krid].knob;
      const s = prompt(`Value for "${kb.label || krid}" (${kb.min} … ${kb.max})`, regionValue(h.F, krid));
      if (s !== null && Number.isFinite(Number(s))) { setRegionValue(h.F, krid, Number(s)); app.commit('set knob'); }
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
    app.version++; app.changed(); app.commit('route');
    if (blocked) toast('Something is in the way. Go around it, or press Tab to drop a via and pass under on the other layer.');
    else if (connected || cells.length === 1) endRoute();
    else routePreview(h);
  }
  function endRoute() { app.route = null; app.view.dirty = true; }

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
      app.version++; app.changed(); app.commit('via');
    }
    app.layer = next;
    updateToolbar(); app.view.dirty = true;
  }

  function toggleKnob(h) {
    const r = regionAt(h);
    if (!r) { toast('Click a region to give it a handle.'); return; }
    const reg = h.F.sheet.regions[r.rid];
    if (reg.knob) { delete reg.knob; app.changed(false); app.version++; app.commit('remove handle'); return; }
    if (written(h.F.path + r.rid)) { toast('This register is written by a block. Only unwritten registers can have handles.'); return; }
    const v = regionValue(h.F, r.rid);
    reg.knob = { x: h.x, y: h.y, label: '', min: v < 0 ? 2 * v : 0, max: v > 0 ? 2 * v : (v < 0 ? 0 : 1), scale: 'lin' };
    const s = E.emptySelection(h.F); s.region = r.rid; select(s);
    app.version++; app.changed(); app.commit('add handle');
  }

  function placeAt(h, keep) {
    const b = app.ghost(h);
    if (b.type === 'comp' && h.F.def && (b.def === h.F.def.name || G.uses(app.project.defs, b.def, h.F.def.name))) {
      toast(`"${b.def}" can't go inside itself.`); return;
    }
    if (!G.canPlace(h.F.sheet, app.project.defs, b)) { toast('No room: an IC can only sit where traces touch its pins.'); return; }
    const nb = G.addBlock(h.F.sheet, app.project.defs, { type: b.type, def: b.def, x: b.x, y: b.y, rot: b.rot,
      window: b.type === 'scope' ? 512 : undefined, loop: b.type === 'sample' ? true : undefined });
    selectBlock(h.F, nb);
    if (nb.type === 'sample') pickWav(h.F, nb);
    if (!keep) app.placing = null;
    updatePalette(); app.changed(); app.commit('place ' + (nb.def || G.info(nb.type).title));
  }

  // Delete removes the selection; with Shift, a clicked trace's whole net.
  function deleteSelection(wholeNet) {
    const s = app.sel;
    if (!s) return;
    const reg = selRegion();
    if (wholeNet && reg) { G.removeRegion(s.F.sheet, reg.rid); select(null); app.changed(); app.commit('delete net'); return; }
    if (E.isEmpty(s)) return;
    E.remove(app.project, s.F, s);
    select(null); app.changed(); app.commit('delete ' + describe(s));
  }
  function rotate() {
    if (app.placing) { if (app.placing.type !== 'comp') app.placing.rot = ((app.placing.rot || 0) + 1) & 3; app.view.dirty = true; return; }
    const one = selBlock();
    if (!one) { if (app.sel) toast('Select a single atom to rotate it.'); return; }
    const { F, b } = one;
    if (b.type === 'comp') { toast('Composite blocks cannot be rotated.'); return; }
    const trial = Object.assign({}, b, { rot: ((b.rot || 0) + 1) & 3 });
    if (!G.canPlace(F.sheet, app.project.defs, trial, b)) { toast('No room to rotate here.'); return; }
    b.rot = trial.rot; app.changed(); app.commit('rotate');
  }

  // ---- keyboard -----------------------------------------------------------------
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.querySelector('dialog[open]');
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const ARROWS = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (mod) {
      const act = { z: e.shiftKey ? app.redo : app.undo, y: app.redo, c: () => copySelection(false), x: () => copySelection(true),
        v: startPaste, d: duplicate, a: selectAll }[k];
      if (act) { e.preventDefault(); act(); }
      return;
    }
    if (ARROWS[k] && app.sel) { e.preventDefault(); const [dx, dy] = ARROWS[k], n = e.shiftKey ? 5 : 1; nudge(dx * n, dy * n); return; }
    if (e.key === 'Tab') { e.preventDefault(); toggleLayer(); }
    else if (e.key === ' ') { e.preventDefault(); spaceDown = true; setCursor(app.hover); }
    else if (e.key === 'Escape') {
      if (app.route) endRoute();
      else if (app.pasting) { app.pasting = null; updateToolbar(); }
      else if (app.placing) { app.placing = null; updatePalette(); updateToolbar(); }
      else if (app.sel) select(null);
      else zoomOut();
      setCursor(app.hover); app.view.dirty = true;
    }
    else if (e.key === 'Enter' && app.route) endRoute();
    else if (e.key === '/' && app.route) { app.route.hFirst = !app.route.hFirst; if (app.hover) routePreview(app.hover); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(e.shiftKey); }
    else if (e.key === '?') $('#help-dlg').showModal();
    else if (k === 'v') setTool('select');
    else if (k === 'w' || k === 'x') setTool('route');
    else if (k === 'e') setTool('erase');
    else if (k === 'k') setTool('knob');
    else if (k === 'r') rotate();
    else if (k === 'z') zoomOut();
    else if (k === 'f' && app.sel) zoomToSelection();
    else if (k === 'h' || e.key === 'Home') app.view.fitAll();
    else if (k === '.') { app.host.setRunning(false); app.host.step(); updateClock(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; setCursor(app.hover); } });
  function zoomToSelection() {
    const s = app.sel, bb = s && E.bounds(s.F, app.project.defs, s);
    if (!bb) return;
    const F = s.F;
    app.view.fitRect(F.ox + bb.x0 * F.sc, F.oy + bb.y0 * F.sc, F.ox + (bb.x1 + 1) * F.sc, F.oy + (bb.y1 + 1) * F.sc, 0.2);
  }

  // ---- toolbar ---------------------------------------------------------------------
  function setTool(t) { app.tool = t; app.placing = null; app.pasting = null; app.route = null; updateToolbar(); updatePalette(); app.view.dirty = true; }
  function updateToolbar() {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === app.tool && !app.placing && !app.pasting));
    $('#btn-layer').textContent = app.layer === G.TOP ? 'Top' : 'Bottom';
    $('#btn-layer').classList.toggle('bot', app.layer === G.BOT);
    const h = app.history;
    $('#btn-undo').disabled = !h.canUndo; $('#btn-undo').title = h.canUndo ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    $('#btn-redo').disabled = !h.canRedo; $('#btn-redo').title = h.canRedo ? `Redo ${h.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    const has = !!app.sel && !E.isEmpty(app.sel);
    for (const id of ['#btn-copy', '#btn-cut', '#btn-dup', '#btn-del']) $(id).disabled = !has;
    setCursor(app.hover);
    updateStatus();
  }
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-layer').addEventListener('click', toggleLayer);
  $('#btn-undo').addEventListener('click', () => app.undo());
  $('#btn-redo').addEventListener('click', () => app.redo());
  $('#btn-copy').addEventListener('click', () => copySelection(false));
  $('#btn-cut').addEventListener('click', () => copySelection(true));
  $('#btn-paste').addEventListener('click', startPaste);
  $('#btn-dup').addEventListener('click', duplicate);
  $('#btn-del').addEventListener('click', () => deleteSelection(false));

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
    $('#rate-label').textContent = rateLabel(h.rate).split(' · ')[0];
    $('#rate-label').title = rateLabel(h.rate);
    $('#btn-run').textContent = h.running ? '⏸' : '▶';
    $('#btn-run').title = h.running ? 'Pause the clock' : 'Run the clock';
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
  let paletteFilter = '';
  function updatePalette() {
    const q = paletteFilter.trim().toLowerCase();
    const item = (kind, type, sym, title, tip) => {
      if (q && !(title + ' ' + tip).toLowerCase().includes(q)) return '';
      const on = app.placing && app.placing.type === (kind === 'def' ? 'comp' : type) && (kind !== 'def' || app.placing.def === type);
      return `<div class="pitem${on ? ' on' : ''}" data-place="${kind}:${esc(type)}" title="${esc(tip)}"><span class="psym">${esc(sym)}</span><span>${esc(title)}</span></div>`;
    };
    let s = '<h3>Atoms</h3>';
    for (const t of G.ATOM_ORDER) s += item('atom', t, G.ATOMS[t].sym, G.ATOMS[t].title, G.ATOMS[t].eq + '\n' + G.DOCS[t]);
    s += '<h3>Sources</h3>';
    for (const t of G.SOURCE_ORDER) s += item('atom', t, G.SOURCES[t].sym, G.SOURCES[t].title, G.SOURCES[t].eq + '\n' + G.DOCS[t]);
    s += '<h3>Outputs</h3>';
    for (const t of G.SINK_ORDER) s += item('atom', t, G.SINKS[t].sym, G.SINKS[t].title, G.DOCS[t]);
    s += '<h3>Library</h3>';
    for (const n of Object.keys(app.project.defs).sort()) s += item('def', n, '▣', n, app.project.defs[n].description || '');
    s += '<div class="pbuttons"><button id="btn-newdef">+ New block</button></div>';
    s += '<p class="dim small">A constant is a net nobody writes. Route a short trace from an input pin, then give it a handle with the knob tool (K).</p>';
    // drop headings whose section is empty after filtering
    s = s.replace(/<h3>[^<]*<\/h3>(?=<h3>|<div class="pbuttons">)/g, '');
    $('#palette-list').innerHTML = s;
  }
  $('#palette-search').addEventListener('input', (e) => { paletteFilter = e.target.value; updatePalette(); });
  $('#palette-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; paletteFilter = ''; updatePalette(); e.target.blur(); }
    if (e.key === 'Enter') { const first = $('#palette-list [data-place]'); if (first) first.click(); e.target.blur(); }
  });
  $('#palette-list').addEventListener('click', (e) => {
    if (e.target.id === 'btn-newdef') return newDefinition();
    const it = e.target.closest('[data-place]');
    if (!it) return;
    const [kind, name] = it.dataset.place.split(':');
    app.placing = kind === 'def' ? { type: 'comp', def: name } : { type: name, rot: 0 };
    app.pasting = null;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    updatePalette(); updateToolbar();
    toast('Click to place, R to rotate, Shift-click to place several, Esc to cancel.');
  });
  function newDefinition() {
    const name = prompt('Name for the new block', 'MyBlock');
    if (!name) return;
    if (app.project.defs[name]) { toast(`"${name}" already exists.`); return; }
    app.project.defs[name] = G.makeDef(name, 4, 3, 8, [{ dir: 'in', row: 1, name: 'in' }, { dir: 'out', row: 1, name: 'out' }], '');
    app.placing = { type: 'comp', def: name };
    app.changed(); app.commit('new block ' + name); updatePalette(); updateToolbar();
    toast(`Place your "${name}" somewhere, then zoom into it to build its insides.`);
  }

  // ---- inspector -------------------------------------------------------------------
  function renderInspector() {
    const el = $('#inspector');
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
    const one = selBlock(), reg = selRegion();
    if (one) el.innerHTML = blockHtml(one.F, one.b);
    else if (reg) el.innerHTML = regionHtml(reg.F, reg.rid);
    else if (app.sel && !E.isEmpty(app.sel)) el.innerHTML = multiHtml(app.sel);
    else el.innerHTML = reportHtml();
  }
  function multiHtml(sel) {
    const types = {};
    for (const b of sel.F.sheet.blocks) if (sel.blocks.has(b.id)) { const n = b.type === 'comp' ? b.def : G.info(b.type).title; types[n] = (types[n] || 0) + 1; }
    const nets = new Set();
    for (const c of sel.cells) { const [l, x, y] = E.unck(c), rid = sel.F.sheet[l][G.key(x, y)]; if (rid) nets.add(rid); }
    let h = `<h2>${describe(sel)}</h2><p class="dim small">${where(sel.F)}${nets.size ? ` · traces from ${plural(nets.size, 'net')}` : ''}</p>`;
    if (Object.keys(types).length) h += '<table class="res">' + Object.entries(types).sort().map(([n, c]) => `<tr><td>${esc(n)}</td><td>${c}</td></tr>`).join('') + '</table>';
    h += `<p class="btnrow"><button data-act="copy">Copy</button> <button data-act="cut">Cut</button> <button data-act="dup">Duplicate</button> <button data-act="delete" class="danger">Delete</button></p>
      <p class="dim small">Drag any selected item to move them all, or use the arrow keys (Shift: 5 cells). Shift-click adds or removes items; F zooms to the selection.</p>`;
    return h;
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
      const alts = def ? swappable(F, b) : [];
      if (alts.length) {
        const n = F.sheet.blocks.filter((x) => x.type === 'comp' && x.def === b.def).length;
        h += `<h3>Swap chip</h3><p class="dim small">Chips with the same footprint and pins fit the same socket.</p>
          <label class="field"><span>Replace with</span><select data-prop="swap"><option value="">choose…</option>${alts.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>`;
        if (n > 1) h += `<label class="field"><span>All ${n} here</span><input type="checkbox" data-prop="swapall" checked></label>`;
      }
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
      if (b.type === 'sample') h0 += sampleHtml(F, b);
      if (b.type === 'scope') {
        h0 += `<label class="field"><span>Ticks shown</span><select data-prop="window">${[16, 64, 256, 512, 2048, 4800, 16384, 48000]
          .map((n) => `<option ${b.window === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
      }
      h0 += '<p class="dim small">R rotates.</p>';
      return h0 + '<p><button data-act="delete" class="danger">Delete</button></p>';
    }
  }

  function sampleHtml(F, b) {
    const e = b.sample && GW.Samples.get(b.sample);
    let h = '<h3>Song</h3>';
    if (!b.sample) h += '<p>No WAV loaded yet; it emits 0.</p>';
    else if (e) {
      const pl = app.running && app.running.players.find((x) => x.path === F.path + b.id);
      const at = pl && app.snap && app.snap.v ? app.snap.v[pl.v] || 0 : 0;
      h += `<p><b>${esc(e.name)}</b></p><table class="res">
        <tr><td>Samples in the stack</td><td>${e.data.length.toLocaleString('en-US')}</td></tr>
        <tr><td>Length at real time</td><td>${fmtTime(e.data.length / G.FS)}</td></tr>
        <tr><td>Read position</td><td data-live="pos">${Math.round(at).toLocaleString('en-US')}</td></tr></table>`;
    } else if (app.missing.has(b.sample)) h += `<p class="err small">"${esc(b.name || b.sample)}" is not stored in this browser. Load the WAV again.</p>`;
    else h += '<p class="dim">Loading…</p>';
    h += `<label class="field"><span>At the end</span><select data-prop="loop"><option value="1" ${b.loop !== false ? 'selected' : ''}>loop</option><option value="0" ${b.loop === false ? 'selected' : ''}>stop (emit 0)</option></select></label>`;
    h += '<p><button data-act="wav">Load WAV…</button></p>';
    h += '<p class="dim small">The file is mixed to mono and resampled to 48 kHz, so at real time one tick is one sample. Its read position is a counter that moves on at every clock edge, with the flip-flops; Reset rewinds it. Songs are kept in this browser (IndexedDB), not in exported files.</p>';
    return h;
  }

  // Definitions that fit the same socket: same footprint, same pins.
  function signature(def) { return JSON.stringify([def.fw, def.fh, def.ports.map((p) => p.dir + p.row).sort()]); }
  function swappable(F, b) {
    const sig = signature(app.project.defs[b.def]);
    return Object.keys(app.project.defs).sort().filter((n) => n !== b.def && signature(app.project.defs[n]) === sig &&
      !(F.def && (n === F.def.name || G.uses(app.project.defs, n, F.def.name))));
  }
  function swapChip(F, b, name, all) {
    const old = b.def;
    for (const x of all ? F.sheet.blocks.filter((q) => q.type === 'comp' && q.def === old) : [b]) {
      x.def = name;
      // knob settings made inside the old chip don't belong to the new one
      const prefix = F.path + x.id + '/';
      for (const k of Object.keys(app.project.values)) if (k.startsWith(prefix)) delete app.project.values[k];
    }
    if (document.activeElement) document.activeElement.blur();
    app.changed(); app.commit('swap chip'); renderInspector();
    toast(`Swapped ${all ? 'every ' + old : old} for ${name}.`);
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
    if (app.sel && app.sel.cells.size) h += `<p class="dim small">Selected: ${plural(app.sel.cells.size, 'trace cell')}, shown white. Delete removes them; Shift+Delete removes the whole net. Drag to move them.</p>`;
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
      <tr><td>Registers (flip-flop outputs)</td><td>${c.nRegs}</td></tr>
      <tr><td>Wires (settle within a tick)</td><td>${c.nNets - c.nRegs}</td></tr>
      <tr><td>Sample stacks</td><td>${c.players.length}</td></tr>
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
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'code') { $('#code-dlg pre').textContent = app.compiled.code; $('#code-dlg').showModal(); return; }
    if (act === 'delete') return deleteSelection(false);
    if (act === 'deletenet') return deleteSelection(true);
    if (act === 'copy') return copySelection(false);
    if (act === 'cut') return copySelection(true);
    if (act === 'dup') return duplicate();
    const one = selBlock(), reg = selRegion();
    if (one) {
      const s = one, b = one.b, def = b && app.project.defs[b.def];
      if (act === 'zoom') zoomToBlock(s.F, b);
      if (act === 'wav') pickWav(s.F, b);
      if (def && (act === 'addin' || act === 'addout')) {
        const dir = act === 'addin' ? 'in' : 'out';
        const used = new Set(def.ports.filter((p) => p.dir === dir).map((p) => p.row));
        let row = 0; while (used.has(row)) row++;
        if (row >= def.fh) { toast('No free row on that side; make the block taller first.'); return; }
        def.ports.push({ dir, row, name: dir + (def.ports.filter((p) => p.dir === dir).length + 1) });
        app.changed(); app.commit('add port'); renderInspector();
      }
      if (def && act === 'delport') { def.ports.splice(Number(e.target.dataset.i), 1); app.changed(); app.commit('remove port'); renderInspector(); }
    } else if (reg) {
      const r = reg.F.sheet.regions[reg.rid];
      if (act === 'rmknob') { delete r.knob; app.changed(); app.commit('remove handle'); renderInspector(); }
      if (act === 'default') { r.value = regionValue(reg.F, reg.rid); delete app.project.values[reg.F.path + reg.rid]; app.changed(); app.commit('set default'); renderInspector(); }
    }
  });
  $('#inspector').addEventListener('change', (e) => {
    const prop = e.target.dataset && e.target.dataset.prop;
    if (!prop) return;
    inspectorChange(prop, e.target.value);
    app.commit('edit ' + prop.split('.')[0]);
  });
  function inspectorChange(prop, v) {
    const num = Number(v), one = selBlock(), reg = selRegion();
    if (reg) {
      const r = reg.F.sheet.regions[reg.rid];
      if (prop === 'value' && Number.isFinite(num)) setRegionValue(reg.F, reg.rid, num);
      else if (prop.startsWith('knob.')) {
        const k = prop.slice(5);
        r.knob[k] = k === 'min' || k === 'max' ? (Number.isFinite(num) ? num : r.knob[k]) : v;
        app.changed(false);
      }
      return;
    }
    if (!one) return;
    const s = one, b = one.b;
    if (prop === 'window') { b.window = num; app.changed(); return; }
    if (prop === 'loop') { b.loop = v === '1'; app.changed(); return; }
    if (prop === 'swapall') return;
    if (prop === 'swap') {
      const all = $('#inspector [data-prop="swapall"]');
      if (v) swapChip(s.F, b, v, !!(all && all.checked));
      return;
    }
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
  }
  $('#inspector').addEventListener('focusout', () => setTimeout(() => { if (!$('#inspector').contains(document.activeElement)) renderInspector(); }, 0));

  // ---- status, banner, toast -----------------------------------------------------
  function updateStatus() {
    const h = app.hover;
    let s = '';
    if (h) {
      s = (h.F.chain.length ? 'Board › ' + h.F.chain.join(' › ') : 'Board') + `   ${h.x},${h.y}   ${app.layer === G.TOP ? 'top' : 'bottom'} layer`;
      const r = regionAt(h);
      if (r) {
        const key = h.F.path + r.rid;
        s += `   ·   ${r.rid}${written(key) ? ' (written)' : ' (constant)'} = ${GW.fmt(app.valueOf(key))}`;
      } else if (h.occ && h.occ.block) s += `   ·   ${h.occ.block.type === 'comp' ? h.occ.block.def : G.info(h.occ.block.type).title}${h.occ.pad ? ' pad ' + (h.occ.pad.name || h.occ.pad.dir) : ''}`;
      if (h.F.def) s += `   ·   editing "${h.F.def.name}", shared by ${instances(h.F.def.name)} instance(s)`;
    }
    $('#status').innerHTML = `<span>${esc(s)}</span><span class="hint">${esc(hint())}</span>`;
  }
  // What the pointer and keys do right now.
  function hint() {
    if (app.pasting) return 'click: paste · Shift-click: paste again · Esc: cancel';
    if (app.placing) return 'click: place · R: rotate · Shift-click: place several · Esc: cancel';
    if (app.route) return 'click: corner · /: flip corner · Tab: via · Esc: done';
    if (app.tool === 'route') return 'click a pin, a trace or the board to start a trace';
    if (app.tool === 'erase') return 'drag to erase · Shift: both layers';
    if (app.tool === 'knob') return 'click a constant net to add or remove a handle';
    if (app.sel && !E.isEmpty(app.sel)) return 'drag: move · arrows: nudge · Ctrl+C / X / D · Del: delete · Esc: deselect';
    return 'drag: box-select · click: select · Shift: add · right-drag: pan · wheel: zoom · ?: help';
  }
  function updateBanner() {
    const m = [];
    if (app.compiled && !app.compiled.ok) m.push(['err', '⚠ ' + app.compiled.errors[0].msg]);
    if (app.missing.size) m.push(['err', `${app.missing.size} sample stack(s) not stored in this browser: select the Sample block and load the WAV again.`]);
    if (app.snap && app.snap.bad) m.push(['err', 'The DAC saw NaN or ∞ — press Reset.']);
    $('#banner').innerHTML = m.map(([k, s]) => `<div class="${k}">${esc(s)}</div>`).join('');
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3500);
  }

  // ---- files and examples ----------------------------------------------------------
  // Load a project. With a label the load is an undoable step; without one it
  // starts a fresh history (page load).
  function loadProject(p, label) {
    p.values = p.values || {};
    app.project = p; app.sel = null; app.placing = null; app.pasting = null; app.route = null; app.hover = null; app.hotRegion = null; app.version++;
    if (label) app.commit(label); else app.history.reset(JSON.stringify(p));
    updatePalette(); app.changed();
    recompile(); renderInspector(); updateToolbar();
    requestAnimationFrame(() => app.view.fitAll());
  }
  $('#examples').innerHTML = '<option value="">Examples…</option>' + GW.EXAMPLES.map((x, i) => `<option value="${i}">${esc(x.title)}</option>`).join('');
  $('#examples').addEventListener('change', (e) => {
    const i = Number(e.target.value); e.target.value = '';
    if (!GW.EXAMPLES[i] || !confirm(`Load "${GW.EXAMPLES[i].title}"? This replaces the root sheet and refreshes the built-in blocks; blocks you made yourself are kept.`)) return;
    loadExample(i);
  });
  function loadExample(i) {
    loadProject(GW.exampleProject(i, app.project ? app.project.defs : null), app.project ? 'load ' + GW.EXAMPLES[i].title : null);
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
    a.download = 'sample-factory.json'; a.click();
    if (app.running && app.running.players.some((pl) => pl.sample && pl.sample !== GW.Samples.DEMO_ID)) toast('Exported the board. WAV files are not included: load them again after importing.');
  });
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!p.root || !p.defs) throw new Error('not a Sample Factory file');
      if (confirm('Replace the current project? (Ctrl+Z brings it back.)')) loadProject(p, 'import');
    } catch (err) { toast('Import failed: ' + err.message); }
  });
  $('#btn-help').addEventListener('click', () => $('#help-dlg').showModal());
  document.querySelectorAll('dialog .close').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---- start ------------------------------------------------------------------------
  app.host = new GW.Host((snap) => {
    const wasBad = app.snap && app.snap.bad;
    app.snap = snap;
    $('#ticks').textContent = 'tick ' + snap.ticks.toLocaleString('en-US');
    const live = document.querySelector('#inspector [data-live="pos"]'), one = selBlock();
    if (live && one && app.running) {
      const pl = app.running.players.find((x) => x.path === one.F.path + one.b.id);
      if (pl && snap.v) live.textContent = Math.round(snap.v[pl.v] || 0).toLocaleString('en-US');
    }
    app.view.dirty = true;
    if (!!snap.bad !== !!wasBad) updateBanner();
  }, (msg) => { if (msg) toast(msg); updateClock(); });
  app.view = new GW.View(app, canvas);
  $('#rate').value = 1;

  if (EMBED) document.body.classList.add('embed');
  let saved = null;
  try { saved = EMBED ? null : JSON.parse(localStorage.getItem(STORE) || localStorage.getItem(OLD_STORE)); } catch (e) { saved = null; }
  if (Q.has('example')) loadExample(Number(Q.get('example')) || 0);
  else if (saved && saved.root && saved.version === 2) { loadProject(saved); updateClock(); }
  else loadExample(2);
  if (Q.has('rate')) setRate(Math.min(RATE_MAX, Math.max(RATE_MIN, Number(Q.get('rate')) || RATE_MAX)));
  if (Q.has('focus')) setTimeout(() => focusOn(Q.get('focus')), 100);
  setTool('select');

  // Hooks for the interactivity tests (tests/ui/ui-tests.js, run by tests/run-ui.py).
  app.loadExample = loadExample;
  app.select = select;
  if (Q.get('uitest') === '1') {
    const sc = document.createElement('script');
    sc.src = 'tests/ui/ui-tests.js';
    document.body.appendChild(sc);
  }
})();
