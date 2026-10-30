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
    version: 1, tool: 'select', mode: 'board',
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
    if (c.ok) { app.running = c; app.host.load(c); if (app.bridge) app.bridge.program(c); }
    updateBanner();
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
  // A knob is on a Constant (or Voltage) block, on an input port's default value,
  // or on a module's panel. At the root (and on a block's workbench) turning it sets
  // the value itself; inside an instance it is stored per instance, by path, so
  // every copy keeps its own knobs. A knob target is { F, b } for a constant,
  // { F, port: i } for input port i, or { F, b, param: id } for a module's knob.
  const isConst = (b) => !!b && (b.type === 'const' || b.type === 'volts' || b.type === 'bits');
  const portOf = (t) => G.portsOf(t.F.sheet, 'in')[t.port];
  const paramSpec = (t) => G.MODULES[t.b.type].params.find((q) => q.id === t.param);
  const knobKey = (t) => t.F.path + (t.param ? t.b.id + '#' + t.param : t.b ? t.b.id : G.ep('port', 'in', t.port));
  const knobPin = (t) => t.F.path + (t.b ? G.ep(t.b.id, 'out', 0) : G.ep('port', 'in', t.port));
  const knobOf = (t) => (t.param ? paramSpec(t) : t.b ? t.b.knob : portOf(t).knob);
  const ownValue = (t) => (t.param ? (t.b.params && t.b.params[t.param] !== undefined ? t.b.params[t.param] : paramSpec(t).def) : t.b ? t.b.value : portOf(t).value) || 0;
  const knobFrac = (t, v) => (t.param ? G.Analog.paramFrac(paramSpec(t), v) : GW.knobFrac(knobOf(t), v));
  const knobFromFrac = (t, f) => (t.param ? G.Analog.paramValue(paramSpec(t), f) : GW.knobValue(knobOf(t), f));
  // On a block's workbench (one instance on an empty board) knobs set the block's defaults.
  const direct = (F) => F.path === '' || (app.curated && app.curated.kind === 'block' && F.path === 'b1/' && app.project.root.blocks.length === 1);
  function knobValue(t) {
    const ov = app.project.values[knobKey(t)];
    return !direct(t.F) && ov !== undefined ? ov : ownValue(t);
  }
  function setKnobValue(t, v) {
    if (t.param && t.F.path === '') { t.b.params = t.b.params || {}; t.b.params[t.param] = v; }
    else if (t.param) app.project.values[knobKey(t)] = v;
    else if (direct(t.F)) { if (t.b) t.b.value = v; else portOf(t).value = v; delete app.project.values[knobKey(t)]; }
    else app.project.values[knobKey(t)] = v;
    app.changed(!!(t.param && paramSpec(t).structural));
  }
  function knobValueOf(t) {
    if (!t.param) return knobValue(t);
    const ov = app.project.values[knobKey(t)];
    return t.F.path && ov !== undefined ? ov : ownValue(t);
  }
  app.knobValue = knobValue;

  // ---- selection -------------------------------------------------------------------
  const sameFrame = (a, b) => !!(a && b && a.path === b.path && a.sheet === b.sheet);
  function select(sel) {
    app.sel = sel && (!E.isEmpty(sel) || sel.net) ? sel : null;
    renderInspector(true); updateToolbar(); app.view.dirty = true;
  }
  function selectBlock(F, b) { const s = E.emptySelection(F); s.blocks.add(b.id); select(s); }
  // The one block selected, if exactly one block (and nothing else) is.
  function selBlock() {
    const s = app.sel;
    if (!s || s.blocks.size !== 1 || s.wires.size) return null;
    const b = s.F.sheet.blocks.find((x) => x.id === [...s.blocks][0]);
    return b ? { F: s.F, b } : null;
  }
  // The net shown in the inspector after clicking a trace.
  function selNet() {
    const s = app.sel;
    return s && s.net && !s.blocks.size && s.F.sheet.wires.some((w) => w.from === s.net) ? { F: s.F, net: s.net } : null;
  }
  // The board that keyboard commands apply to: the selection's, else the one under the pointer.
  const activeFrame = () => (app.sel ? app.sel.F : app.hover && isLive(app.hover.F) ? app.hover.F : app.view.rootFrame());
  // Is this frame's board still part of the project (not left over from before an undo or a load)?
  const isLive = (F) => F.sheet === app.project.root || Object.values(app.project.defs).includes(F.sheet);
  // A pin as words: "Add b3 · a", "port Hz".
  function pinName(F, e) {
    const p = G.parseEp(e);
    if (!p) return e;
    if (p.b === 'port') { const port = G.portsOf(F.sheet, p.dir)[p.i]; return `port ${port ? port.name : p.i}`; }
    const b = F.sheet.blocks.find((x) => x.id === p.b), pad = G.pinOf(F.sheet, app.project.defs, e);
    const name = !b ? p.b : b.type === 'comp' ? b.def : G.info(b.type).title;
    return `${name} ${p.b}${pad && pad.name ? ' · ' + pad.name : ''}`;
  }

  // ---- undo --------------------------------------------------------------------------
  app.commit = (label) => {
    if (app.project && app.history.record(JSON.stringify(app.project), label)) { updateToolbar(); updatePalette(); updateCurated(); }   // the palette marks edited blocks
  };
  function restore(r, verb) {
    if (!r) { toast(`Nothing to ${verb.toLowerCase()}.`); return; }
    app.project = JSON.parse(r.state);
    app.sel = null; app.route = null; app.placing = null; app.pasting = null; app.drag = null; app.hover = null; app.hotRegion = null;
    app.version++; app.changed(); updatePalette(); renderInspector(true); updateToolbar(); updateCurated();
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
    if (sel.wires.size) parts.push(plural(sel.wires.size, 'wire'));
    return parts.join(' and ');
  }
  function copySelection(cut) {
    const s = app.sel;
    if (E.isEmpty(s)) { toast('Nothing selected.'); return; }
    if (!s.blocks.size) { toast('Copy works on blocks (and the wires between them): select some blocks.'); return; }
    app.clip = E.copy(app.project, s.F, s, routesOf(s.F));
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(app.clip)); } catch (err) { /* memory only */ }
    if (cut) {
      E.remove(app.project, s.F, s);
      select(null); app.changed(); app.commit('cut ' + describe(s));
    }
    toast(`${cut ? 'Cut' : 'Copied'} ${plural(app.clip.blocks.length, 'block')}${app.clip.wires.length ? ' and ' + plural(app.clip.wires.length, 'wire') + ' between them' : ''}.`, 1800);
  }
  function clipboard() {
    if (app.clip) return app.clip;
    try { const c = JSON.parse(localStorage.getItem(CLIP_KEY)); if (c && c.kind === 'samplefactory.clip2') return c; } catch (err) { /* none */ }
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
    if (!s || !s.blocks.size) { toast('Select some blocks to duplicate.'); return; }
    const clip = E.copy(app.project, s.F, s, routesOf(s.F)), bb = E.bounds(s.F, app.project.defs, { blocks: s.blocks, wires: new Set() }, routesOf(s.F));
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
    if (!s || !s.blocks.size) return;
    const r = E.rubberMove(app.project, s.F, s, E.snapshot(s.F.sheet), dx, dy);
    if (!r) { toast('Something is in the way.', 1500); return; }
    select(r.sel); app.version++; app.changed(); app.commit('move ' + describe(r.sel));
  }
  function selectAll() {
    const F = activeFrame();
    select(E.selectAll(F));
    toast(`Selected ${describe(app.sel || E.emptySelection(F)) || 'nothing'}.`, 1500);
  }

  // ---- what can be edited ----------------------------------------------------------
  // A block is edited only where it is the open file: the design's own board, and,
  // in the block editor, the inside of the block being edited. Zoomed into any
  // other block you can look and turn its knobs (they are this design's settings),
  // but a click or a drag acts on the block as a whole, on the board it sits on.
  const benchBlock = () => (benchDef() ? app.project.root.blocks[0] : null);
  app.benchBlock = benchBlock;
  const editable = (F) => F.path === '' || (!!benchBlock() && F.path === benchBlock().id + '/' && F.parent && F.parent.path === '');
  // The pointer as the editable board under it sees it.
  function lift(h) {
    if (!h || editable(h.F)) return h;
    let F = h.F;
    while (F.parent && !editable(F)) F = F.parent;
    const wx = h.F.ox + h.fx * h.F.sc, wy = h.F.oy + h.fy * h.F.sc;
    const fx = (wx - F.ox) / F.sc, fy = (wy - F.oy) / F.sc, x = Math.floor(fx), y = Math.floor(fy);
    return { F, x, y, fx, fy, occ: app.view.geom(F.sheet).occ.get(G.key(x, y)), lifted: h };
  }
  app.lift = lift;

  // ---- pointer ------------------------------------------------------------------
  const canvas = $('#grid');
  let spaceDown = false;
  app.ghost = (h) => {
    const b = Object.assign({ x: 0, y: 0, rot: app.placing.rot || 0 }, app.placing);
    const fp = G.footprint(b, app.project.defs);
    b.x = h.x - Math.floor(fp.w / 2); b.y = h.y - Math.floor(fp.h / 2);
    return b;
  };
  const routesOf = (F) => app.view.routes(F.sheet);
  // The knob at a cell: on a Constant, or beside an input port.
  function knobAt(h) {
    const o = h.occ;
    if (o && o.block && (o.block.type === 'const' || o.block.type === 'volts') && o.block.knob) return { F: h.F, b: o.block };
    const m = o && o.block && G.MODULES[o.block.type];
    if (m && m.panel && h.fx !== undefined) {
      const k = 1 / G.Analog.CELL_HP, lx = h.fx - o.block.x, ly = h.fy - o.block.y;
      for (const q of m.panel.lay.knobs) if (Math.hypot(lx - q.x * k, ly - q.y * k) <= (q.r + 0.4) * k) return { F: h.F, b: o.block, param: q.id };
    }
    if (G.isDef(h.F.sheet)) {
      for (const pad of G.innerPads(h.F.sheet)) {
        if (pad.dir === 'in' && pad.x + 1 === h.x && pad.y === h.y && G.portsOf(h.F.sheet, 'in')[pad.idx].knob) return { F: h.F, port: pad.idx };
      }
    }
    return null;
  }
  // The pin under the pointer: its cell, or the tab of a composite block's pin,
  // which straddles the block's edge (half of it lies in the next cell out).
  function pinAt(h) {
    const bench = h.F.path === '' ? benchBlock() : null;   // in the block editor its own pins lead nowhere: its inside is the work
    if (h.occ && h.occ.pad) return bench && h.occ.block === bench ? null : G.endpointAt(h.F.sheet, app.project.defs, h.x, h.y);
    if (h.fx === undefined) return null;
    for (const b of h.F.sheet.blocks) {
      if (b.type !== 'comp' || b === bench) continue;
      for (const p of G.footprint(b, app.project.defs).pads) {
        const ex = p.dir === 'in' ? p.x : p.x + 1;
        if (Math.abs(h.fx - ex) < 0.3 && h.fy > p.y + 0.15 && h.fy < p.y + 0.85) return G.ep(b.id, p.dir, p.idx);
      }
    }
    return null;
  }
  const netAtCell = (h) => E.netAt(h.F.sheet, routesOf(h.F), h.x, h.y);
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Select tool, like patching a rack:
  //   drag from a pin to a pin: a wire (from an input that has one: pick it up and move it, or drop it to remove it)
  //   drag a block: move it (selected blocks move together; wires follow)
  //   click a trace: select its wire and show its net; drag it: move that straight run sideways
  //   drag a knob: turn it;  drag on empty board: box-select
  // Right-, middle- or Space-drag pans in every tool; the wheel zooms.
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no capture */ }
    const p = pos(e), deep = app.view.locate(p.x, p.y), h = lift(deep);
    if (e.button === 1 || e.button === 2 || spaceDown || !h) { app.drag = { kind: 'pan', x: p.x, y: p.y }; setCursor(); return; }
    if (e.button !== 0) return;
    // a knob inside a block (this design's setting for that copy) turns at any depth
    const dk = deep !== h && !app.placing && !app.pasting && app.tool !== 'route' ? knobAt(deep) : null;
    if (dk) {
      const st = app.knobState(knobKey(dk));
      if (st === 'ok') { app.drag = { kind: 'knob', t: dk, frac: knobFrac(dk, knobValueOf(dk)), y: p.y }; return; }
    }
    if (app.pasting) { pasteAt(h, e.shiftKey); return; }
    if (app.placing) { placeAt(h, e.shiftKey); return; }
    if (app.tool === 'route') { routeClick(h); return; }
    const gh = h.F.path === '' ? app.view.graphHit(h.fx, h.fy) : null;
    app.pwSel = gh && gh.link ? gh.link.id : null;
    if (gh && gh.port) { app.drag = { kind: 'pwlink', port: gh.port, at: { x: h.fx, y: h.fy } }; select(null); return; }
    if (gh) { select(null); app.view.dirty = true; return; }
    const kt = knobAt(h);
    if (kt) {
      const st = app.knobState(knobKey(kt));
      if (st !== 'ok') { toast(st === 'written' ? 'This knob\'s net is driven by a block, so the knob is dead.' : 'This knob is overridden by a wire or a knob outside the block.'); return; }
      app.drag = { kind: 'knob', t: kt, frac: knobFrac(kt, knobValueOf(kt)), y: p.y };
      return;
    }
    const cur = app.sel && sameFrame(app.sel.F, h.F) ? app.sel : null;
    const b = h.occ && h.occ.block, pin = pinAt(h);
    // a pin starts a wire, unless its block is selected (then the drag moves it)
    if (pin && !(b && cur && cur.blocks.has(b.id))) { wireStart(h, pin, e); return; }
    // patch cables hang in front of everything
    const cab = app.view.cableAt(h.F, h.fx, h.fy);
    if (cab) {
      if (e.shiftKey && cur) { cur.wires.has(cab.id) ? cur.wires.delete(cab.id) : cur.wires.add(cab.id); select(cur); return; }
      const s = E.emptySelection(h.F); s.wires.add(cab.id); s.net = cab.from; select(s);
      return;
    }
    if (b) {
      if (e.shiftKey && cur) { cur.blocks.has(b.id) ? cur.blocks.delete(b.id) : cur.blocks.add(b.id); select(cur); return; }
      if (!cur || !cur.blocks.has(b.id)) selectBlock(h.F, b);
      app.drag = { kind: 'move', F: h.F, hx: h.x, hy: h.y, dx: 0, dy: 0, moved: false, sel0: app.sel, snap: E.snapshot(h.F.sheet) };
      setCursor();
      return;
    }
    const n = netAtCell(h);
    if (n) {
      if (e.shiftKey && cur) {
        cur.wires.has(n.wire.id) ? cur.wires.delete(n.wire.id) : cur.wires.add(n.wire.id);
        cur.net = n.net; select(cur);
        return;
      }
      const s = E.emptySelection(h.F);
      s.wires.add(n.wire.id); s.net = n.net;
      select(s);
      app.drag = { kind: 'run', F: h.F, wire: n.wire.id, at: [h.x, h.y], snap: E.snapshot(h.F.sheet), d: 0, horizontal: runIsHorizontal(h, n.wire.id) };
      setCursor();
      return;
    }
    app.drag = { kind: 'marquee', F: h.F, x0: h.x, y0: h.y, x1: h.x, y1: h.y, add: e.shiftKey, sx: p.x, sy: p.y, far: false };
  });
  // Is the trace through this cell running left-right (so a drag moves it up or down)?
  function runIsHorizontal(h, wid) {
    const r = routesOf(h.F).get(wid), i = r ? r.findIndex((c) => c[0] === h.x && c[1] === h.y) : -1;
    if (i < 0) return true;
    return (r[i - 1] && r[i - 1][1] === h.y) || (r[i + 1] && r[i + 1][1] === h.y);
  }

  // Board coordinates of a screen point in a given frame, even when the pointer has
  // wandered into a deeper (or shallower) board.
  function cellIn(F, p) {
    const w = app.view.toWorld(p.x, p.y);
    return { x: Math.floor((w.x - F.ox) / F.sc), y: Math.floor((w.y - F.oy) / F.sc) };
  }

  // ---- wires by dragging ----------------------------------------------------------------
  function wireStart(h, pin, e) {
    const F = h.F, defs = app.project.defs;
    const d = { kind: 'wire', F, preview: [], target: null };
    if (G.isSource(pin)) d.from = pin;
    else {
      const old = G.wiresInto(F.sheet, pin)[0];
      if (old && !e.altKey) { d.from = old.from; d.picked = old; d.snap = E.snapshot(F.sheet); G.removeWires(F.sheet, new Set([old.id])); app.version++; }
      else d.to = pin;
    }
    d.start = G.pinOf(F.sheet, defs, d.from || d.to);
    d.dom = d.start.dom;
    d.cands = wireCandidates(F, d);
    app.drag = d;
    setCursor();
  }
  // Every pin on the board this wire could end on: inputs for a wire from an
  // output (and the other way round), of the same kind of signal.
  function wireCandidates(F, d) {
    const sh = F.sheet, defs = app.project.defs, out = [], start = d.from || d.to;
    const add = (e, p) => {
      if (e === start) return;
      const [a, z] = d.from ? [d.from, e] : [e, d.to];
      if (G.wireProblem(sh, defs, a, z)) return;
      out.push({ e, x: p.fx !== undefined ? p.fx : p.x + 0.5, y: p.fy !== undefined ? p.fy : p.y + 0.5 });
    };
    for (const b of sh.blocks) for (const p of G.footprint(b, defs).pads) add(G.ep(b.id, p.dir, p.idx), p);
    if (G.isDef(sh)) for (const p of G.innerPads(sh)) add(G.ep('port', p.dir, p.idx), p);
    return out;
  }
  // The trace a new wire would get: routed like the builder routes, sharing its net's copper.
  function routeFor(F, from, to) {
    const tmp = { id: '_new', from, to };
    const sh = Object.assign({}, F.sheet, { wires: F.sheet.wires.concat([tmp]) });
    return G.routeWire(sh, app.project.defs, tmp, routesOf(F));
  }
  function wireMove(d, h, p) {
    const c = cellIn(d.F, p), defs = app.project.defs;
    const w = app.view.toWorld(p.x, p.y);
    d.at = { x: (w.x - d.F.ox) / d.F.sc, y: (w.y - d.F.oy) / d.F.sc };   // the loose end, in the wire's board
    // the pin under the pointer, else the nearest pin it could connect to (it snaps
    // within a cell and a half, or 18 pixels when zoomed out)
    let e = h && sameFrame(h.F, d.F) ? pinAt(h) : null;
    if (!e || e === (d.from || d.to)) {
      const reach = Math.max(1.5, 18 / (app.view.cam.z * d.F.sc));
      let best = null, bd = reach;
      for (const q of d.cands || []) { const dist = Math.hypot(q.x - d.at.x, q.y - d.at.y); if (dist < bd) { bd = dist; best = q; } }
      if (best) e = best.e;
    }
    const ends = e && (d.from ? [d.from, e] : [e, d.to]);
    const ok = e && e !== (d.from || d.to) && !G.wireProblem(d.F.sheet, defs, ends[0], ends[1]);
    d.target = ok ? e : null;
    d.wrong = e && !ok && e !== (d.from || d.to) ? G.wireProblem(d.F.sheet, defs, ends[0], ends[1]) : null;
    if (d.dom === 'analog') { d.preview = []; return; }
    if (ok) d.preview = routeFor(d.F, d.from || e, d.from ? e : d.to) || [];
    else {
      const a = [d.start.x, d.start.y], cells = [a];
      let [x, y] = a;
      while (x !== c.x) { x += Math.sign(c.x - x); cells.push([x, y]); }
      while (y !== c.y) { y += Math.sign(c.y - y); cells.push([x, y]); }
      d.preview = cells;
    }
    if (d.target && !d.from) d.preview = d.preview.slice().reverse();
    void defs;
  }
  function wireEnd(d) {
    const F = d.F;
    if (!d.target) {
      if (d.wrong) toast(d.wrong, 3000);
      if (d.picked) { app.version++; app.changed(); app.commit('remove wire'); toast('Wire removed.', 1500); }
      return;
    }
    const from = d.from || d.target, to = d.from ? d.target : d.to;
    const replaced = G.wiresInto(F.sheet, to).length && !(d.picked && d.picked.to === to);
    const cable = d.dom === 'analog';
    const w = G.addWire(F.sheet, from, to, cable ? null : routeFor(F, from, to));
    if (!w) return;
    if (d.picked && d.picked.style) w.style = clone(d.picked.style);
    else if (cable) w.style = { color: G.CABLE_COLORS[F.sheet.wires.filter((x) => x.style && x.style.color).length % G.CABLE_COLORS.length] };
    const s = E.emptySelection(F); s.wires.add(w.id); s.net = from;
    app.version++; app.changed(); app.commit(d.picked ? 'move wire' : 'wire');
    select(s);
    if (replaced) toast('That input already had a wire; it has been replaced (an input takes one wire).', 3000);
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e), d = app.drag;
    if (d && d.kind === 'pan') { app.view.pan(p.x - d.x, p.y - d.y); d.x = p.x; d.y = p.y; }
    const deep = app.view.locate(p.x, p.y), h = lift(deep);
    app.hover = h; app.hoverDeep = deep;
    if (app.route && h) routePreview(h);
    if (d && d.kind === 'wire') wireMove(d, h, p);
    if (d && d.kind === 'pwlink') { const w = app.view.toWorld(p.x, p.y); d.at = { x: w.x, y: w.y }; }
    if (d && d.kind === 'knob') {
      d.frac = Math.min(1, Math.max(0, d.frac - (p.y - d.y) / 200 * (e.shiftKey ? 0.1 : 1)));
      d.y = p.y;
      setKnobValue(d.t, knobFromFrac(d.t, d.frac));
    }
    if (d && d.kind === 'move' && app.sel) {
      // Always from the board as it was at the start of the drag; wires follow.
      // Try the whole offset, then each axis alone, so the selection slides along obstacles.
      const c = cellIn(d.F, p), wx = c.x - d.hx, wy = c.y - d.hy;
      if (wx !== d.dx || wy !== d.dy) {
        let done = false;
        for (const [ox, oy] of [[wx, wy], [wx, d.dy], [d.dx, wy]]) {
          if (ox === d.dx && oy === d.dy) continue;
          const r = E.rubberMove(app.project, d.F, d.sel0, d.snap, ox, oy);
          if (r) { app.sel = r.sel; d.dx = ox; d.dy = oy; d.moved = true; done = true; break; }
        }
        if (!done) { E.rubberMove(app.project, d.F, d.sel0, d.snap, d.dx, d.dy); d.blocked = true; }
        app.version++;
      }
    }
    if (d && d.kind === 'run') {
      // reshape: the straight run under the pointer follows it sideways
      const c = cellIn(d.F, p), off = d.horizontal ? c.y - d.at[1] : c.x - d.at[0];
      if (off !== d.d) {
        Object.assign(d.F.sheet, JSON.parse(JSON.stringify(d.snap)));
        d.d = off;
        if (off) d.changed = E.dragRun(d.F.sheet, app.project.defs, d.wire, d.at, off, G.routesOf(d.F.sheet, app.project.defs));
        app.version++;
      }
    }
    if (d && d.kind === 'marquee') {
      const c = cellIn(d.F, p);
      d.x1 = c.x; d.y1 = c.y;
      if (Math.hypot(p.x - d.sx, p.y - d.sy) > 4) d.far = true;
    }
    const n = h && !(h.occ && h.occ.block) ? netAtCell(h) : null;
    app.hotRegion = n ? { path: h.F.path, rid: n.net } : null;
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
        select(E.selectRect(d.F, app.project.defs, d, base, routesOf(d.F)));
      }
    }
    if (d.kind === 'wire') wireEnd(d);
    if (d.kind === 'pwlink') pwLinkEnd(d);
    if (d.kind === 'move' && d.moved && (d.dx || d.dy)) { app.changed(); app.commit('move ' + describe(app.sel)); renderInspector(); }
    else if (d.kind === 'move' && d.blocked && !d.moved) toast('Something is in the way.', 1500);
    if (d.kind === 'run' && d.d) { app.changed(); app.commit('reshape trace'); }
    if (d.kind === 'knob') app.commit('turn knob');
    app.view.dirty = true;
  });
  canvas.addEventListener('pointerleave', () => { if (!app.drag) { app.hover = null; app.hotRegion = null; app.view.dirty = true; updateStatus(); } });

  // Cursor feedback: what a press here would do.
  function setCursor(h) {
    let c = 'default';
    const d = app.drag;
    if (d) c = d.kind === 'pan' ? 'grabbing' : d.kind === 'move' ? 'move' : d.kind === 'knob' ? 'ns-resize' : d.kind === 'run' ? (d.horizontal ? 'row-resize' : 'col-resize') : 'crosshair';
    else if (spaceDown) c = 'grab';
    else if (app.placing || app.pasting || app.tool === 'route') c = 'crosshair';
    else if ((h && knobAt(h)) || (app.hoverDeep && app.hoverDeep !== h && knobAt(app.hoverDeep))) c = 'ns-resize';
    else if (h && pinAt(h) && !(h.occ && h.occ.block && app.sel && app.sel.blocks.has(h.occ.block.id))) c = 'crosshair';
    else if (h && h.occ && h.occ.block) c = 'move';
    else if (h && netAtCell(h)) c = runIsHorizontal(h, netAtCell(h).wire.id) ? 'row-resize' : 'col-resize';
    canvas.style.cursor = c;
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pos(e);
    app.view.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018)));
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const p = pos(e), deep = app.view.locate(p.x, p.y), h = lift(deep);
    if (!h) return;
    if (app.tool === 'route') return;
    const dk = deep !== h ? knobAt(deep) : null;
    if (dk && dk.param) { setKnobValue(dk, paramSpec(dk).def); app.commit('reset knob'); renderInspector(); return; }
    const kt = knobAt(h), b = h.occ && h.occ.block;
    if (kt && kt.param) { const p = paramSpec(kt); setKnobValue(kt, p.def); app.commit('reset knob'); renderInspector(); return; }
    if (b && (b.type === 'in' || b.type === 'out')) {
      const nm = prompt(`Name of this ${b.type === 'in' ? 'input' : 'output'} socket`, b.name || b.type);
      if (nm) { b.name = nm.trim() || b.type; app.changed(); app.commit('rename socket'); renderInspector(); }
      return;
    }
    if (b && b.type === 'bits') {
      const t = { F: h.F, b }, w = Math.max(1, Math.min(32, b.width || 8));
      const sv = prompt(`Value (${w} bits: 0 … ${Math.pow(2, w) - 1}, or 0b…, 0x…)`, knobValue(t));
      if (sv !== null && Number.isFinite(Number(sv))) { setKnobValue(t, GW.word(Number(sv), w)); app.changed(); app.commit('set bits'); renderInspector(); }
      return;
    }
    if (!b && toggleVia(h)) return;
    if (kt || (b && (b.type === 'const' || b.type === 'volts'))) {
      const t = kt || { F: h.F, b };
      if (app.knobState(knobKey(t)) !== 'ok' && knobOf(t)) return;
      const k = knobOf(t);
      const s = prompt(`Value${k && k.label ? ' for "' + k.label + '"' : ''}${k ? ` (${k.min} … ${k.max})` : ''}`, knobValue(t));
      if (s !== null && Number.isFinite(Number(s))) { setKnobValue(t, Number(s)); app.commit('set value'); renderInspector(); }
      return;
    }
    if (b && b.type === 'comp') { zoomToBlock(h.F, b); return; }
  });
  // A via by hand: double-click a float trace to change layer there; again to remove it.
  function toggleVia(h) {
    const n = netAtCell(h);
    if (!n || G.domainAt(h.F.sheet, app.project.defs, n.net) !== 'float') return false;
    const routes = routesOf(h.F), ws = h.F.sheet.wires.filter((w) => w.from === n.net);
    let hit = false;
    for (const w of ws) {
      const r = routes.get(w.id), i = r ? r.findIndex((c) => c[0] === h.x && c[1] === h.y) : -1;
      if (i <= 0 || i >= r.length - 1) continue;
      w.path = r.map(([x, y]) => [x, y]);
      w.style = w.style || {};
      const vias = (w.style.vias || []).slice(), at = vias.indexOf(i);
      if (at >= 0) vias.splice(at, 1); else vias.push(i);
      w.style.vias = vias.sort((a, b) => a - b);
      hit = true;
    }
    if (!hit) return false;
    app.version++; app.changed(); app.commit('via'); renderInspector();
    return true;
  }
  // Edit block…: open a block in the block editor. One the library doesn't have yet
  // (made in this design, or this design's own version) is saved there first.
  async function editBlock(name) {
    const file = app.library.fileOf[name];
    if (file && blockStatus()[name] !== 'edited') { await app.files.openFile('library', file); return; }
    if (!app.curator) { toast(`"${name}" is not a library file this page can open; save it to the library with Save… first.`, 6000); return; }
    const verb = file ? 'save your changes to it in the library' : 'add it to the library';
    if (!confirm(`To edit "${name}" in the block editor, ${verb} first? (Every design that uses the library's ${name} gets this version.)`)) return;
    try { await saveBlock(name, file || GW.Format.slug(name) + '.json'); await app.reloadCatalogue(); } catch (err) { toast('Could not save: ' + err.message, 6000); return; }
    await app.files.openFile('library', app.library.fileOf[name]);
  }
  function zoomToBlock(F, b) {
    const fp = G.footprint(b, app.project.defs);
    app.view.fitRect(F.ox + b.x * F.sc, F.oy + b.y * F.sc, F.ox + (b.x + fp.w) * F.sc, F.oy + (b.y + fp.h) * F.sc, 0.04);
  }
  function zoomOut() {
    const h = app.hover;
    if (h && h.F.parent && h.F.parent.parent) zoomToBlock(h.F.parent.parent, h.F.parent.inst);
    else app.view.fitAll();
  }

  // ---- PipeWire links: from a port of another program to a port, or to a socket ------------
  function pwLinkEnd(d) {
    const br = app.bridge, h = app.hover;
    if (!br || !h || h.F.path !== '') return;
    const gh = app.view.graphHit(h.fx, h.fy);
    let other = gh && gh.port;
    const b = h.occ && h.occ.block;
    if (!other && b && (b.type === 'in' || b.type === 'out')) other = br.selfPort(b.type, b.name || b.type);
    if (!other) return;
    if (other.dir === d.port.dir) { toast('A link goes from an output port to an input port.'); return; }
    const [o, i] = d.port.dir === 'out' ? [d.port, other] : [other, d.port];
    br.link(o.id, i.id);
  }
  app.bridgeChanged = () => { updateBridgeButton(); renderInspector(); };
  function updateBridgeButton() {
    const b = $('#btn-bridge'), br = app.bridge;
    b.classList.toggle('on', !!(br && br.connected));
    b.textContent = br && br.connected ? 'PipeWire ●' : 'PipeWire';
  }
  $('#btn-bridge').addEventListener('click', () => {
    if (!app.bridge) app.bridge = new GW.Bridge(app);
    if (app.bridge.connected) app.bridge.disconnect(); else app.bridge.connect();
  });

  // ---- the Wire tool: a trace drawn corner by corner -----------------------------------
  // Click a pin (or a trace, to branch from its net) to start; click to place
  // corners (/ flips the corner); click a pin to finish. The wire keeps exactly the
  // trace you drew. Esc cancels.
  function lPath(a, b, hFirst) {
    const cells = [[a[0], a[1]]];
    let [x, y] = a;
    const stepX = () => { while (x !== b[0]) { x += Math.sign(b[0] - x); cells.push([x, y]); } };
    const stepY = () => { while (y !== b[1]) { y += Math.sign(b[1] - y); cells.push([x, y]); } };
    if (hFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
    return cells;
  }
  function routeClick(h) {
    const r = app.route, pin = pinAt(h);
    if (!r) {
      if (pin) { app.route = { F: h.F, from: G.isSource(pin) ? pin : null, to: G.isSource(pin) ? null : pin, cells: [[h.x, h.y]], hFirst: true }; routePreview(h); return; }
      const n = netAtCell(h);
      if (n) {   // branch from a trace: the new wire shares the net's copper up to here
        const route = routesOf(h.F).get(n.wire.id), i = route.findIndex((c) => c[0] === h.x && c[1] === h.y);
        app.route = { F: h.F, from: n.net, to: null, cells: route.slice(0, i + 1).map(([x, y]) => [x, y]), hFirst: true };
        routePreview(h); return;
      }
      toast('Start on a pin, or on a trace to branch from it.');
      return;
    }
    if (!sameFrame(h.F, r.F)) return;
    const last = r.cells[r.cells.length - 1], leg = lPath(last, [h.x, h.y], r.hFirst).slice(1);
    const fits = pin && (r.from ? !G.isSource(pin) : G.isSource(pin));
    if (fits) {
      let cells = G.tidy(r.cells.concat(leg));
      const from = r.from || pin, to = r.from ? pin : r.to;
      if (!r.from) cells = cells.reverse();
      const replaced = G.wiresInto(r.F.sheet, to).length;
      const w = G.addWire(r.F.sheet, from, to, cells);
      app.route = null;
      if (w) {
        const s = E.emptySelection(r.F); s.wires.add(w.id); s.net = from;
        app.version++; app.changed(); app.commit('draw wire'); select(s);
        if (replaced) toast('That input already had a wire; it has been replaced.', 3000);
      }
      return;
    }
    if (pin) { toast(r.from ? 'Finish on an input (a block\'s left side, or an output port).' : 'Finish on an output.'); return; }
    r.cells = G.tidy(r.cells.concat(leg));   // a corner
    routePreview(h);
  }
  function routePreview(h) {
    const r = app.route;
    if (!r || !sameFrame(h.F, r.F)) return;
    const last = r.cells[r.cells.length - 1];
    r.preview = r.cells.concat(lPath(last, [h.x, h.y], r.hFirst).slice(1));
    const pin = pinAt(h);
    r.target = pin && (r.from ? !G.isSource(pin) : G.isSource(pin)) ? pin : null;
    app.view.dirty = true;
  }
  function endRoute() { app.route = null; app.view.dirty = true; }

  function placeAt(h, keep) {
    const b = app.ghost(h);
    if (b.type === 'comp' && h.F.def && (b.def === h.F.def.name || G.uses(app.project.defs, b.def, h.F.def.name))) {
      toast(`"${b.def}" can't go inside itself.`); return;
    }
    if (!G.canPlace(h.F.sheet, app.project.defs, b)) { toast('No room: blocks can\'t overlap.'); return; }
    const props = { type: b.type, def: b.def, x: b.x, y: b.y, rot: b.rot };
    if (b.type === 'const') Object.assign(props, { value: 1, knob: { label: '', min: 0, max: 1, scale: 'lin' } });
    if (b.type === 'volts') Object.assign(props, { value: 0, knob: { label: '', min: -10, max: 10, scale: 'lin' } });
    if (b.type === 'bits') Object.assign(props, { value: 0, width: 8 });
    if (b.type === 'split' || b.type === 'join') props.parts = [1, 1, 1, 1];
    if (b.type === 'table') props.points = [[0, 0], [1, 1]];
    if (G.MODULES[b.type]) { props.params = G.MODULES[b.type].defaults(); props.rot = 0; }
    if (b.type === 'in' || b.type === 'out') {
      const names = new Set(app.project.root.blocks.filter((x) => x.type === b.type).map((x) => x.name));
      let n = 1; while (names.has(b.type + (n > 1 ? n : ''))) n++;
      props.name = b.type + (n > 1 ? n : '');
    }
    const nb = G.addBlock(h.F.sheet, app.project.defs, props);
    selectBlock(h.F, nb);
    if (!keep) app.placing = null;
    updatePalette(); app.changed(); app.commit('place ' + (nb.def || G.info(nb.type).title));
  }

  // Delete removes the selection; with Shift, the whole net of a clicked trace.
  function deleteSelection(wholeNet) {
    if (app.pwSel && app.bridge) { app.bridge.unlink(app.pwSel); app.pwSel = null; return; }
    const s = app.sel;
    if (!s) return;
    const n = selNet();
    if (wholeNet && n) {
      G.removeWires(s.F.sheet, new Set(s.F.sheet.wires.filter((w) => w.from === n.net).map((w) => w.id)));
      select(null); app.changed(); app.commit('delete net'); return;
    }
    if (E.isEmpty(s)) return;
    E.remove(app.project, s.F, s);
    select(null); app.changed(); app.commit('delete ' + describe(s));
  }
  function rotate() {
    if (app.placing) { if (app.placing.type !== 'comp') app.placing.rot = ((app.placing.rot || 0) + 1) & 3; app.view.dirty = true; return; }
    const one = selBlock();
    if (!one) { if (app.sel) toast('Select a single atom to rotate it.'); return; }
    const { F, b } = one;
    if (b.type === 'comp' || G.MODULES[b.type]) { toast(b.type === 'comp' ? 'Composite blocks cannot be rotated.' : 'Modules and converters cannot be rotated.'); return; }
    const trial = Object.assign({}, b, { rot: ((b.rot || 0) + 1) & 3 });
    if (!G.canPlace(F.sheet, app.project.defs, trial, b)) { toast('No room to rotate here.'); return; }
    b.rot = trial.rot;
    for (const w of G.wiresAt(F.sheet, G.ep(b.id, 'in', 0)).concat(F.sheet.wires.filter((x) => G.parseEp(x.from).b === b.id || G.parseEp(x.to).b === b.id))) delete w.path;
    G.fixRoutes(F.sheet, app.project.defs);
    app.changed(); app.commit('rotate');
  }

  // ---- keyboard -----------------------------------------------------------------
  const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.querySelector('dialog[open]');
  // Ctrl+S and Ctrl+O work everywhere (in a text field too), and never reach the browser's own.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !['s', 'o'].includes(e.key.toLowerCase())) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (document.querySelector('dialog[open]')) return;
    if (e.key.toLowerCase() === 's') quickSave(); else app.files.open();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const ARROWS = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (mod) {
      const act = { z: e.shiftKey ? app.redo : app.undo, y: app.redo, c: () => editCmd('copy'), x: () => editCmd('cut'),
        v: () => editCmd('paste'), d: () => editCmd('dup'), a: () => editCmd('all') }[k];
      if (act) { e.preventDefault(); act(); }
      return;
    }
    if (e.key === '?') { $('#help-dlg').showModal(); return; }
    if (k === '.') { app.host.setRunning(false); app.host.step(); updateClock(); return; }
    if (ARROWS[k] && app.sel && app.sel.blocks.size) { e.preventDefault(); const [dx, dy] = ARROWS[k], n = e.shiftKey ? 5 : 1; nudge(dx * n, dy * n); return; }
    if (e.key === ' ') { e.preventDefault(); spaceDown = true; setCursor(app.hover); }
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
    else if (k === 'v') setTool('select');
    else if (k === 'w') setTool('route');
    else if (k === 'r') rotate();
    else if (k === 'z') zoomOut();
    else if (k === 'f' && app.sel) zoomToSelection();
    else if (k === 'h' || e.key === 'Home') app.view.fitAll();
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; setCursor(app.hover); } });
  // Edit commands go to whichever view is showing.
  function editCmd(cmd) {
    ({ copy: () => copySelection(false), cut: () => copySelection(true), paste: startPaste, dup: duplicate,
      delete: () => deleteSelection(false), all: selectAll })[cmd]();
  }
  function zoomToSelection() {
    const s = app.sel, bb = s && E.bounds(s.F, app.project.defs, s, routesOf(s.F));
    if (!bb) return;
    const F = s.F;
    app.view.fitRect(F.ox + bb.x0 * F.sc, F.oy + bb.y0 * F.sc, F.ox + (bb.x1 + 1) * F.sc, F.oy + (bb.y1 + 1) * F.sc, 0.2);
  }

  // ---- toolbar ---------------------------------------------------------------------
  function setTool(t) { app.tool = t; app.placing = null; app.pasting = null; app.route = null; updateToolbar(); updatePalette(); app.view.dirty = true; }
  function updateToolbar() {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === app.tool && !app.placing && !app.pasting));
    const h = app.history;
    $('#btn-undo').disabled = !h.canUndo; $('#btn-undo').title = h.canUndo ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    $('#btn-redo').disabled = !h.canRedo; $('#btn-redo').title = h.canRedo ? `Redo ${h.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    const has = !!app.sel && !E.isEmpty(app.sel);
    for (const id of ['#btn-copy', '#btn-cut', '#btn-dup']) $(id).disabled = !has;
    $('#btn-del').disabled = !has;
    setCursor(app.hover);
    updateStatus();
  }
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-undo').addEventListener('click', () => app.undo());
  $('#btn-redo').addEventListener('click', () => app.redo());
  $('#btn-copy').addEventListener('click', () => editCmd('copy'));
  $('#btn-cut').addEventListener('click', () => editCmd('cut'));
  $('#btn-paste').addEventListener('click', () => editCmd('paste'));
  $('#btn-dup').addEventListener('click', () => editCmd('dup'));
  $('#btn-del').addEventListener('click', () => editCmd('delete'));

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
    $('#btn-audio').textContent = h.audioOn ? '■ Sound on' : '▶ Start audio';
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
    const typeItem = (t) => { const i = G.info(t); return item('atom', t, i.sym, i.title, (i.eq && i.eq !== i.title ? i.eq + '\n' : '') + (G.DOCS[t] || '')); };
    let s = '<h3 class="dom-float">Float</h3>';
    for (const t of G.ATOM_ORDER.concat(G.SOURCE_ORDER)) s += typeItem(t);
    s += '<h3 class="dom-fixed">Fixed point</h3>';
    for (const t of G.GATE_ORDER.concat(['bits'])) s += typeItem(t);
    s += '<h3 class="dom-analog">Analog</h3>';
    for (const t of G.Analog.BOARD_ORDER.concat(['volts'])) s += typeItem(t);
    // a block crosses domains when its ports are of more than one kind: a converter
    const crossing = (n) => new Set(app.project.defs[n].ports.map((p) => p.domain || 'float')).size > 1;
    s += '<h3>Converters</h3>';
    for (const t of G.Analog.CONVERTER_ORDER) s += typeItem(t);
    s += '<h3>Sockets</h3>';
    for (const t of G.IO_ORDER) s += typeItem(t);
    s += '<h3>Library</h3>';
    const st = blockStatus();
    for (const n of Object.keys(app.project.defs).sort().filter(crossing)) {
      s = s.replace('<h3>Sockets</h3>', item('def', n, '⇄', n, app.project.defs[n].description || '') + '<h3>Sockets</h3>');
    }
    for (const n of Object.keys(app.project.defs).sort().filter((x) => !crossing(x))) {
      s += item('def', n, st[n] ? '▣•' : '▣', n, (st[n] ? `(${STATUS_WORD[st[n]]}: Save… puts it in the library)\n` : '') + (app.project.defs[n].description || ''));
    }
    s += '<div class="pbuttons"><button id="btn-newdef">+ New block</button></div>';
    s += '<p class="dim small">Drag from a pin to a pin to wire them: float pins with traces, fixed-point pins with barcodes, analog jacks with cables. Different kinds only meet through a converter.</p>';
    // drop headings whose section is empty after filtering
    s = s.replace(/<h3[^>]*>[^<]*<\/h3>(?=<h3|<div class="pbuttons">)/g, '');
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
  // + New block: a new library block, made in Files and opened in the block editor.
  async function newDefinition() {
    if (!app.curator) { toast('New blocks are library files: serve the app with tools/serve.py to make them.', 6000); return; }
    await app.files.open('library');
    app.files.startEdit('new', 'library', null, 'NewBlock');
  }

  // ---- inspector -------------------------------------------------------------------
  // force: redraw even under a field being typed in (after a change to what the inspector shows)
  function renderInspector(force) {
    const el = $('#inspector');
    // don't redraw under a field being typed in (buttons, checkboxes and menus don't count)
    const a = document.activeElement;
    if (!force && el.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'button', 'range', 'color'].includes(a.type)))) return;
    const one = selBlock(), net = selNet();
    if (one) el.innerHTML = blockHtml(one.F, one.b);
    else if (net && app.sel.wires.size <= 1) el.innerHTML = netHtml(net.F, net.net);
    else if (app.sel && !E.isEmpty(app.sel)) el.innerHTML = multiHtml(app.sel);
    else el.innerHTML = reportHtml();
  }
  function multiHtml(sel) {
    const types = {};
    for (const b of sel.F.sheet.blocks) if (sel.blocks.has(b.id)) { const n = b.type === 'comp' ? b.def : G.info(b.type).title; types[n] = (types[n] || 0) + 1; }
    const nets = new Set(sel.F.sheet.wires.filter((w) => sel.wires.has(w.id)).map((w) => w.from));
    let h = `<h2>${describe(sel)}</h2><p class="dim small">${where(sel.F)}${nets.size ? ` · wires of ${plural(nets.size, 'net')}` : ''}</p>`;
    if (Object.keys(types).length) h += '<table class="res">' + Object.entries(types).sort().map(([n, c]) => `<tr><td>${esc(n)}</td><td>${c}</td></tr>`).join('') + '</table>';
    h += `<p class="btnrow"><button data-act="copy">Copy</button> <button data-act="cut">Cut</button> <button data-act="dup">Duplicate</button> <button data-act="delete" class="danger">Delete</button></p>
      <p class="dim small">Drag a selected block to move them all (their wires follow), or use the arrow keys (Shift: 5 cells). Shift-click adds or removes items; F zooms to the selection. Copy takes the blocks and the wires between them.</p>`;
    return h;
  }
  const field = (label, prop, value, type, extra) =>
    `<label class="field"><span>${label}</span><input data-prop="${prop}" type="${type || 'text'}" value="${esc(value === undefined ? '' : value)}" ${extra || ''}></label>`;
  const where = (F) => (F.chain.length ? 'inside ' + F.chain.join(' › ') : 'root');

  // The block editor: a library block open on its workbench (its one instance on an empty board).
  const benchDef = () => {
    const c = app.curated, bs = app.project.root.blocks;
    return c && c.kind === 'block' && bs.length === 1 && bs[0].type === 'comp' && bs[0].def === c.name && app.project.defs[c.name] ? c.name : null;
  };
  function sizeHtml(def) {
    const n = G.inner(def);
    return `<h3>Size</h3><table class="ports size">
      <tr><td>Block</td><td><input data-prop="size.fw" type="number" min="1" max="40" value="${def.fw}"></td><td>×</td><td><input data-prop="size.fh" type="number" min="1" max="40" value="${def.fh}"></td><td class="dim small">cells</td></tr>
      <tr><td>Inside</td><td><input data-prop="size.iw" type="number" min="1" max="400" value="${n.w}"></td><td>×</td><td><input data-prop="size.ih" type="number" min="1" max="400" value="${n.h}"></td><td class="dim small">fine cells</td></tr></table>
      <p class="dim small">The block's size on the boards it sits on (an Add is 3×3), and the size of its own board inside. They are separate: the inside keeps its layout and is drawn scaled to fit. Every design using this block sees the new size.</p>`;
  }
  // The block editor: everything about the block itself, with or without a selection.
  function definitionHtml(name) {
    const def = app.project.defs[name];
    let h = `<h2>Block ${esc(name)}</h2><p class="dim small">The block editor. Ctrl+S saves it to the library; every design that uses it gets this version. Rename it from Files….</p>`;
    h += `<label class="field col"><span>Description</span><textarea data-prop="def.description" rows="3">${esc(def.description || '')}</textarea></label>`;
    h += sizeHtml(def);
    h += portGridHtml(def);
    const ins = def.ports.map((p, i) => [p, i]).filter(([p]) => p.dir === 'in');
    if (ins.length) {
      h += '<h3>Input defaults</h3><p class="dim small">What an input reads inside the block when nothing outside is wired to it, like a normalled jack. A knob shows it on the block\'s own board.</p><table class="ports">';
      for (const [p, i] of ins) {
        h += `<tr><td>${esc(p.name)}</td><td><input data-prop="pdef.${i}.value" type="number" step="any" value="${esc(p.value || 0)}"></td>
          <td><label class="small"><input type="checkbox" data-prop="pdef.${i}.knob" ${p.knob ? 'checked' : ''}> knob</label></td></tr>`;
      }
      h += '</table>';
    }
    return h;
  }
  // The ports: a column of inputs and one of outputs, a row for every row of the
  // block. Each port can be renamed, given a kind of signal, removed, or dragged
  // (or moved with ↑ ↓) to another row; an empty row has a + to add one there.
  function portGridHtml(def) {
    const at = (dir, r) => def.ports.findIndex((p) => p.dir === dir && p.row === r);
    let h = `<h3>Ports</h3><table class="portgrid"><thead><tr><th></th><th>Inputs</th><th>Outputs</th></tr></thead><tbody>`;
    for (let r = 0; r < def.fh; r++) {
      h += `<tr><td class="rownum">${r}</td>`;
      for (const dir of ['in', 'out']) {
        const i = at(dir, r);
        h += `<td data-cell="${dir}:${r}">`;
        if (i < 0) h += `<button class="mini addhere" data-act="addport" data-dir="${dir}" data-row="${r}" title="Add an ${dir === 'in' ? 'input' : 'output'} on row ${r}">+</button>`;
        else {
          const p = def.ports[i], dom = p.domain || 'float';
          h += `<div class="port dom-${dom}" draggable="true" data-port="${i}" title="Drag to another row">
            <div class="prow"><span class="grip">⋮⋮</span><input data-prop="port.${i}.name" value="${esc(p.name)}" aria-label="name"><button class="mini" data-act="delport" data-i="${i}" title="Remove this port (and its wires)">×</button></div>
            <div class="prow"><select data-prop="port.${i}.domain" aria-label="kind of signal">${G.DOMAINS.map((d) => `<option ${d === dom ? 'selected' : ''}>${d}</option>`).join('')}</select>
            <button class="mini" data-act="portmove" data-i="${i}" data-by="-1" ${r ? '' : 'disabled'} title="Up a row">↑</button><button class="mini" data-act="portmove" data-i="${i}" data-by="1" ${r < def.fh - 1 ? '' : 'disabled'} title="Down a row">↓</button></div></div>`;
        }
        h += '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table><p class="dim small">A row for every row of the block (make it taller under Size for more). Drag a port to another row, or onto another port to swap them; its wires go with it. Inside, each port is a pad on the edge of the board, to wire to.</p>';
    return h;
  }
  // Move a port of the block being edited to another row of its side, swapping with one already there.
  function movePort(i, row) {
    const name = benchDef(), def = name && app.project.defs[name], p = def && def.ports[i];
    if (!p || row < 0 || row >= def.fh || row === p.row) return;
    E.portChange(app.project, name, () => {
      const q = def.ports.find((x) => x !== p && x.dir === p.dir && x.row === row);
      if (q) q.row = p.row;
      p.row = row;
    });
    app.version++; app.changed(); app.commit('move port'); renderInspector(true);
  }
  // A composite block in a design: what it is, and its size here. The block itself is edited in the block editor.
  function compHtml(F, b) {
    const def = app.project.defs[b.def];
    let h = `<h2>${esc(b.def)} <span class="dim">${b.id}</span></h2><p class="dim small">${where(F)}</p>`;
    h += `<p>${esc(def ? def.description || 'Composite block.' : 'Missing definition!')}</p>`;
    h += '<p class="btnrow"><button data-act="zoom">Zoom in ⤵</button> <button data-act="editblock">Edit block…</button></p>';
    if (def) {
      const fp = G.footprint(b, app.project.defs), own = b.w || b.h;
      h += `<h3>Size here</h3><table class="ports size">
        <tr><td>Width</td><td><input data-prop="isize.w" type="number" min="1" max="40" value="${fp.w}"></td><td>Height</td><td><input data-prop="isize.h" type="number" min="1" max="40" value="${fp.h}"></td></tr></table>
        <p class="dim small">How big this copy is on this board (the block's own size is ${def.fw}×${def.fh}${own ? ` <button class="mini" data-act="isizereset">back to ${def.fw}×${def.fh}</button>` : ''}). Only the drawing changes: its inside is shown scaled to fit, and its pins spread over its height. Its ports, defaults and inside are edited in the block editor (Edit block…).</p>`;
    }
    const alts = def ? swappable(F, b) : [];
    if (alts.length) {
      const n = F.sheet.blocks.filter((x) => x.type === 'comp' && x.def === b.def).length;
      h += `<h3>Swap chip</h3><p class="dim small">Blocks with the same pins fit the same socket.</p>
        <label class="field"><span>Replace with</span><select data-prop="swap"><option value="">choose…</option>${alts.map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>`;
      if (n > 1) h += `<label class="field"><span>All ${n} here</span><input type="checkbox" data-prop="swapall" checked></label>`;
    }
    return h + '<p><button data-act="delete" class="danger">Delete</button></p>';
  }
  function blockHtml(F, b) {
    if (b.type === 'comp') {
      // on its workbench, the block is the block editor
      if (F.path === '' && benchDef() === b.def) return definitionHtml(b.def);
      return compHtml(F, b);
    } else {
      const t = G.info(b.type);
      let h0 = `<h2>${t.title} <span class="dim">${b.id}</span></h2><p class="dim small">${where(F)}</p>`;
      h0 += `<div class="eq">${esc(t.eq)}</div><p>${esc(G.DOCS[b.type])}</p>`;
      const code = app.compiled && app.compiled.nodeCode[F.path + b.id];
      if (code) h0 += `<h3>Compiled as</h3><pre class="code small">${esc(code)}</pre>`;
      if (b.type === 'const' || b.type === 'volts') h0 += constHtml(F, b);
      if (b.type === 'bits') h0 += bitsHtml(F, b);
      if (b.type === 'table') h0 += tableHtml(F, b);
      if (b.type === 'split' || b.type === 'join') h0 += field('Fields (bits, low first)', 'parts', G.partsOf(b).join(','), 'text');
      if (b.type === 'in' || b.type === 'out') h0 += socketHtml(F, b);
      if (G.MODULES[b.type]) h0 += moduleParamsHtml(F, b);
      if (G.ATOMS[b.type] || G.GATES[b.type]) h0 += '<p class="dim small">R rotates.</p>';
      return h0 + '<p><button data-act="delete" class="danger">Delete</button></p>';
    }
  }

  // Knobs of an analog module or utility placed on the board.
  function moduleParam(F, b, id) {
    const p = G.MODULES[b.type].params.find((q) => q.id === id), ov = app.project.values[F.path + b.id + '#' + id];
    return F.path && ov !== undefined ? ov : b.params && b.params[id] !== undefined ? b.params[id] : p.def;
  }
  function moduleParamsHtml(F, b) {
    const m = G.MODULES[b.type];
    let h = '';
    if (m.kind === 'analog') h += '<p class="small">An analog circuit, sampled by the clock: its outputs change at the clock edge, one tick after its inputs, so it can close a feedback loop on its own.</p>';
    if (!m.params.length) return h;
    h += '<h3>Knobs</h3>';
    for (const p of m.params) {
      const v = moduleParam(F, b, p.id);
      h += `<label class="field"><span>${esc(p.label)}</span><input type="number" step="any" data-prop="mparam.${esc(p.id)}" value="${+Number(v).toPrecision(6)}"></label>
        <div class="dim small knobval">${esc(G.Analog.showParam(p, v))}${p.unit && !p.show ? '' : ''} · ${p.min} … ${p.max}</div>`;
    }
    if (F.path) h += '<p class="dim small">Settings here belong to this instance only.</p>';
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

  // Bits: a fixed-point word, edited bit by bit (high bits first, as written) or as a number.
  function bitsHtml(F, b) {
    const t = { F, b }, w = Math.max(1, Math.min(32, b.width || 8)), v = GW.word(knobValue(t), w);
    let h = field('Width (bits)', 'bits.width', w, 'number', 'min="1" max="32" step="1"');
    h += field(direct(F) ? 'Value' : 'Value (this instance)', 'bits.value', v, 'number', 'step="1"');
    h += '<div class="bitrow">';
    for (let i = w - 1; i >= 0; i--) h += `<label class="bit" title="bit ${i}"><input type="checkbox" data-prop="bits.bit.${i}" ${Math.floor(v / Math.pow(2, i)) % 2 ? 'checked' : ''}><span>${i}</span></label>`;
    h += `</div><p class="dim small">0x${v.toString(16).toUpperCase()} · as signed ${v >= Math.pow(2, w - 1) ? v - Math.pow(2, w) : v}. Inside a block it is a default that a wire from outside overrides.</p>`;
    return h;
  }
  // A Table: its points, one "x y" per line.
  function tableHtml(F, b) {
    const pts = G.tablePoints(b);
    return `<h3>Points</h3><label class="field col"><span class="dim small">x y, one point a line; straight lines between them, flat beyond the ends</span>
      <textarea data-prop="table.points" rows="${Math.min(14, pts.length + 2)}" class="mono">${esc(pts.map((q) => q.join(' ')).join('\n'))}</textarea></label>
      <p class="dim small">A ROM, or a law: a converter's curve, a scale, a waveshaper. ${pts.length} points from x = ${GW.fmt(pts[0][0])} to ${GW.fmt(pts[pts.length - 1][0])}.</p>`;
  }
  // An In or Out socket: its name, which is the port's name in PipeWire.
  function socketHtml(F, b) {
    const c = app.running, list = c ? (b.type === 'out' ? c.outs : c.ins) : [], i = list.findIndex((x) => x.path === F.path + b.id);
    let h = field('Name', 'sock.name', b.name || b.type, 'text');
    if (b.type === 'out') h += `<p class="small">${i < 0 ? 'Not an output yet.' : `Output ${i + 1} of ${list.length}` + (i === 0 ? (list.length === 1 ? ': both speakers.' : ': the left speaker.') : i === 1 ? ': the right speaker.' : ': not on the speakers (PipeWire only).')}</p>`;
    else h += `<p class="small">${i < 0 ? '' : `Input ${i + 1} of ${list.length}: microphone channel ${i + 1} in the browser.`}</p>`;
    const br = app.bridge;
    if (br && br.connected) {
      const mine = br.selfPort(b.type, b.name || b.type);
      const ends = mine ? br.graph.links.filter((l) => (b.type === 'out' ? l.out : l.in) === mine.id).map((l) => ({ l, p: br.portOf(b.type === 'out' ? l.in : l.out) })) : [];
      const name = (p) => { const n = p && br.nodeOf(p.node); return n ? `${n.desc || n.name}: ${p.name}` : '?'; };
      h += `<h3>PipeWire</h3><p class="small">${mine ? `Port "${esc(mine.name)}" of this design's node.` : 'Waiting for the bridge to make its port…'}</p>`;
      if (ends.length) h += '<ul class="small">' + ends.map(({ l, p }) => `<li>${b.type === 'out' ? '→' : '←'} ${esc(name(p))} <button class="mini" data-act="unlink" data-id="${l.id}">×</button></li>`).join('') + '</ul>';
      const cands = br.graph.ports.filter((p) => p.node !== br.graph.self && p.dir === (b.type === 'out' ? 'in' : 'out') && !p.monitor);
      if (mine && cands.length) h += `<label class="field"><span>Link to</span><select data-prop="pwlink"><option value="">choose…</option>${cands.map((p) => `<option value="${p.id}">${esc(name(p))}</option>`).join('')}</select></label>`;
    } else h += '<p class="dim small">With the PipeWire bridge (run <code>python3 tools/pwbridge.py</code> as yourself, then press PipeWire), every socket is a port of a "Sample Factory" node in PipeWire, to be patched in Helvum or here.</p>';
    return h;
  }
  // A Constant: its value, and its knob.
  function knobFields(k, pre) {
    let h = field('Label', pre + '.label', k.label);
    h += field('Min', pre + '.min', k.min, 'number', 'step="any"');
    h += field('Max', pre + '.max', k.max, 'number', 'step="any"');
    h += `<label class="field"><span>Scale</span><select data-prop="${pre}.scale">${['lin', 'log'].map((x) => `<option ${k.scale === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`;
    return h;
  }
  function constHtml(F, b) {
    const t = { F, b }, st = app.knobState(knobKey(t));
    let h = b.type === 'volts' ? '<p class="small">An analog constant: a voltage.</p>' : '';
    if (st === 'written') h += '<p class="err small">Its net is driven by a block, so this constant is ignored.</p>';
    else if (st === 'overridden') h += '<p class="dim small">A wire or constant outside this block sets this net; this one is the default.</p>';
    h += field(direct(F) ? 'Value' : 'Value (this instance)', 'const.value', knobValue(t), 'number', 'step="any"');
    if (!direct(F)) h += `<p class="dim small">Default: ${GW.fmt(b.value || 0)} <button class="mini" data-act="default">make this the default</button></p>`;
    h += `<label class="field"><span>Knob</span><input type="checkbox" data-prop="const.knob" ${b.knob ? 'checked' : ''}></label>`;
    if (b.knob) h += knobFields(b.knob, 'cknob');
    h += '<p class="dim small">Drag from its pin to wire it to any number of inputs. Drag the knob to turn it; double-click to type a value.</p>';
    return h;
  }
  // A net: one source and the wires from it.
  function netHtml(F, net) {
    const ws = F.sheet.wires.filter((w) => w.from === net), key = F.path + net, ref = app.compiled && app.compiled.netOf[key];
    let h = `<h2>Net</h2><p class="dim small">${where(F)} · from ${esc(pinName(F, net))}</p>`;
    h += `<div class="eq">${esc(GW.fmt(app.valueOf(key)) || '—')}</div>`;
    h += `<p class="small">${ref && ref.k === 's' ? 'A register: it changes at the clock edge.' : ref && ref.k === 'p' ? 'A constant.' : 'Logic: it settles within the tick.'}</p>`;
    h += `<h3>${plural(ws.length, 'wire')}</h3><ul class="small">` + ws.map((w) => `<li>${app.sel && app.sel.wires.has(w.id) ? '<b>' : ''}→ ${esc(pinName(F, w.to))}${app.sel && app.sel.wires.has(w.id) ? '</b>' : ''}</li>`).join('') + '</ul>';
    const dom = G.domainAt(F.sheet, app.project.defs, net) || 'float';
    const w0 = ws.find((w) => app.sel && app.sel.wires.has(w.id)) || ws[0], st = (w0 && w0.style) || {};
    if (dom === 'fixed') { const wd = app.compiled && app.compiled.widths[key]; h += `<p class="small">A fixed-point bus of ${wd || '?'} bit${wd === 1 ? '' : 's'}: a barcode, white for 1 and black for 0, the low bit on the left of the way it flows.</p>`; }
    h += '<h3>Look</h3>';
    const color = st.color || (dom === 'analog' ? G.CABLE_COLORS[0] : '#000000');
    h += `<label class="field"><span>Colour</span><input type="color" data-prop="style.color" value="${esc(/^#[0-9a-f]{6}$/i.test(color) ? color : '#000000')}"> ${st.color ? '<button class="mini" data-act="nocolor">none</button>' : ''}</label>`;
    if (dom === 'float') {
      h += `<label class="field"><span>Trace width</span><input type="range" min="0.4" max="3" step="0.1" data-prop="style.width" value="${st.width || 1}"></label>`;
      const vias = ws.reduce((n, w) => n + ((w.style && w.style.vias) || []).length, 0);
      h += `<p class="dim small">Colour and width belong to the whole net (one copper trace). Double-click a trace to put a via there (the trace changes layer); double-click a via to remove it. ${vias ? `${plural(vias, 'via')} placed by hand. <button class="mini" data-act="novias">automatic vias</button>` : 'Until you place one, vias are drawn where traces cross.'}</p>`;
    } else if (dom === 'analog') {
      h += `<label class="field"><span>Droop</span><input type="range" min="0" max="3" step="0.05" data-prop="style.droop" value="${st.droop === undefined ? 1 : st.droop}"></label>`;
      h += '<p class="dim small">A patch cable: it hangs between its jacks. Colour and droop are this cable\'s.</p>';
    } else h += '<p class="dim small">The colour edges the barcode of the whole net.</p>';
    const routed = dom !== 'analog';
    h += `<p class="btnrow">${routed ? '<button data-act="reroute">Re-route</button> ' : ''}<button data-act="delete" class="danger">Delete wire</button> <button data-act="deletenet" class="danger">Delete net</button></p>`;
    if (routed) h += '<p class="dim small">Drag the trace sideways to move that straight run; the wire stays connected. Re-route lets the router draw it again.</p>';
    return h;
  }

  function reportHtml() {
    const c = app.compiled;
    if (!c) return '';
    const bench = benchDef();
    let h = bench ? definitionHtml(bench) + '<h3>Inside</h3>' : '<h2>Design</h2>';
    if (c.errors.length) h += '<h3 class="err">Errors</h3><ul class="err">' + c.errors.map((e) => `<li>${esc(e.msg)}</li>`).join('') + '</ul><p class="dim small">The last error-free design keeps running.</p>';
    const r = c.resources;
    h += `<table class="res">
      <tr><td>Registers (flip-flop outputs)</td><td>${c.nRegs}</td></tr>
      <tr><td>Wires (settle within a tick)</td><td>${c.nNets - c.nRegs}</td></tr>
      <tr><td>Constants</td><td>${c.params.length}</td></tr>
      <tr><td>Adders</td><td>${r.adder}</td></tr><tr><td>Multipliers</td><td>${r.multiplier}</td></tr>
      <tr><td>Comparators</td><td>${r.comparator}</td></tr><tr><td>Switches</td><td>${r.mux}</td></tr>
      <tr><td>Flip-flops</td><td>${r.buffer}</td></tr>
      ${r.gate || r.dff ? `<tr><td>Gates</td><td>${r.gate}</td></tr><tr><td>D flip-flops</td><td>${r.dff}</td></tr>` : ''}
      ${r.analog ? `<tr><td>Analog modules (sampled at the edge)</td><td>${r.analog}</td></tr>` : ''}
      ${r.utility ? `<tr><td>Converters and utilities</td><td>${r.utility}</td></tr>` : ''}
      <tr><td>Audio outputs / inputs</td><td>${c.outs.length} / ${c.ins.length}</td></tr></table>`;
    h += `<h3>Critical path: ${c.critDepth} operation${c.critDepth === 1 ? '' : 's'}</h3>
      <p class="dim small">The longest chain of logic between flip-flops. On real hardware all of it must settle within one clock period (${(1e6 / G.FS).toFixed(1)} µs here). Putting a flip-flop in the middle of the chain (pipelining) shortens it, at the cost of one tick of delay.</p>`;
    if (c.critical.length) h += `<ol class="crit small">${c.critical.map((x) => `<li>${esc(x.name)} <span class="dim">${esc(x.path)}</span></li>`).join('')}</ol>`;
    if (c.warnings.length) h += `<details><summary>${c.warnings.length} warning(s)</summary><ul>${c.warnings.map((w) => `<li>${esc(w.path)}: ${esc(w.msg)}</li>`).join('')}</ul></details>`;
    h += `<h3>Float trace colour = value</h3><div class="legend"><div class="bar neg"></div><div class="bar pos"></div></div>
      <div class="legend-labels"><span>−10⁴</span><span>−1</span><span>0</span><span>1</span><span>10⁴</span></div>
      <p class="dim small">Fixed-point buses are barcodes (white 1, black 0); analog cables have their own colours, and output jacks a light for their voltage.</p>`;
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
    if (act === 'unlink' && app.bridge) { app.bridge.unlink(Number(e.target.dataset.id)); return; }
    const one = selBlock(), net = selNet();
    const bench = benchDef(), bdef = bench && app.project.defs[bench];
    if (bdef && (act === 'addport' || act === 'delport' || act === 'portmove')) {
      if (act === 'addport') {
        const dir = e.target.dataset.dir, row = Number(e.target.dataset.row), names = new Set(bdef.ports.map((p) => p.name));
        let n = 1; while (names.has(dir + n)) n++;
        E.portChange(app.project, bench, (d) => d.ports.push({ dir, row, name: dir + n }));
        app.version++; app.changed(); app.commit('add port'); renderInspector(true);
        const inp = $(`#inspector [data-cell="${dir}:${row}"] input`);
        if (inp) { inp.focus(); inp.select(); }   // name it straight away
      }
      if (act === 'portmove') movePort(Number(e.target.dataset.i), bdef.ports[Number(e.target.dataset.i)].row + Number(e.target.dataset.by));
      if (act === 'delport') {
        const n = E.portChange(app.project, bench, (d) => d.ports.splice(Number(e.target.dataset.i), 1));
        if (n) toast(`Removed the port and the ${plural(n, 'wire')} to it.`, 2500);
        app.version++; app.changed(); app.commit('remove port'); renderInspector(true);
      }
      return;
    }
    if (one) {
      const s = one, b = one.b;
      if (act === 'zoom') zoomToBlock(s.F, b);
      if (act === 'editblock') editBlock(b.def);
      if (act === 'isizereset') { E.resizeInstance(app.project, s.F, b, null, null); app.version++; app.changed(); app.commit('size of ' + b.def); renderInspector(); }
      if (act === 'default' && b.type === 'const') { const t = { F: s.F, b }; b.value = knobValue(t); delete app.project.values[knobKey(t)]; app.changed(); app.commit('set default'); renderInspector(); }
    } else if (net) {
      const ws = net.F.sheet.wires.filter((w) => w.from === net.net), dom = G.domainAt(net.F.sheet, app.project.defs, net.net);
      if (act === 'nocolor') { for (const w of dom === 'analog' ? ws.filter((w) => app.sel.wires.has(w.id)) : ws) if (w.style) delete w.style.color; styleDone(); }
      if (act === 'novias') { for (const w of ws) if (w.style) delete w.style.vias; styleDone(); }
      if (act === 'reroute') {
        const ws = net.F.sheet.wires.filter((w) => w.from === net.net && (!app.sel.wires.size || app.sel.wires.has(w.id)));
        for (const w of ws) delete w.path;
        G.fixRoutes(net.F.sheet, app.project.defs);
        app.version++; app.changed(); app.commit('re-route'); renderInspector();
      }
    }
  });
  function styleDone() {
    for (const w of app.sel.F.sheet.wires) if (w.style && !Object.keys(w.style).length) delete w.style;
    app.version++; app.changed(); app.commit('wire look'); renderInspector();
  }
  $('#inspector').addEventListener('input', (e) => {   // sliders show their effect while dragging
    const prop = e.target.dataset && e.target.dataset.prop;
    if (prop && prop.startsWith('style.') && e.target.type === 'range') { styleChange(prop.slice(6), e.target.value); app.version++; app.view.dirty = true; }
  });
  // A wire's look: on float and fixed nets the whole net shares it; a cable has its own.
  function styleChange(k, v) {
    const n = selNet();
    if (!n) return;
    const ws = n.F.sheet.wires.filter((w) => w.from === n.net), dom = G.domainAt(n.F.sheet, app.project.defs, n.net);
    const targets = dom === 'analog' ? ws.filter((w) => app.sel.wires.has(w.id)) : ws;
    for (const w of targets.length ? targets : ws) { w.style = w.style || {}; w.style[k] = k === 'color' ? v : Number(v); }
  }
  // dragging a port to another row of the grid
  let portDrag = null;
  $('#inspector').addEventListener('dragstart', (e) => {
    const pe = e.target.closest && e.target.closest('.port[data-port]');
    if (!pe) return;
    portDrag = Number(pe.dataset.port);
    e.dataTransfer.setData('text/plain', 'port ' + portDrag); e.dataTransfer.effectAllowed = 'move';
  });
  const dropCell = (e) => {
    const td = e.target.closest && e.target.closest('td[data-cell]'), def = benchDef() && app.project.defs[benchDef()];
    if (!td || portDrag === null || !def || !def.ports[portDrag]) return null;
    const [dir, row] = td.dataset.cell.split(':');
    return dir === def.ports[portDrag].dir ? { td, row: Number(row) } : null;
  };
  $('#inspector').addEventListener('dragover', (e) => {
    const c = dropCell(e);
    for (const t of document.querySelectorAll('#inspector td.drop')) t.classList.remove('drop');
    if (c) { e.preventDefault(); c.td.classList.add('drop'); }
  });
  $('#inspector').addEventListener('drop', (e) => {
    const c = dropCell(e);
    if (!c) return;
    e.preventDefault();
    const i = portDrag; portDrag = null;
    movePort(i, c.row);
  });
  $('#inspector').addEventListener('dragend', () => { portDrag = null; for (const t of document.querySelectorAll('#inspector td.drop')) t.classList.remove('drop'); });
  $('#inspector').addEventListener('change', (e) => {
    const prop = e.target.dataset && e.target.dataset.prop;
    if (!prop) return;
    inspectorChange(prop, e.target.value);
    app.commit('edit ' + prop.split('.')[0]);
  });
  function inspectorChange(prop, v) {
    const num = Number(v), one = selBlock();
    if (prop.startsWith('isize.') && one && one.b.type === 'comp') {
      const fp = G.footprint(one.b, app.project.defs), w = prop === 'isize.w' ? num : fp.w, h = prop === 'isize.h' ? num : fp.h;
      const err = E.resizeInstance(app.project, one.F, one.b, w, h);
      if (err) toast(err);
      app.version++; app.changed(); renderInspector();
      return;
    }
    if (prop.startsWith('size.')) {
      const name = benchDef();
      if (!name) return;
      const err = E.resizeDef(app.project, name, { [prop.slice(5)]: num });
      if (err) toast(err);
      app.changed(); renderInspector();
      return;
    }
    if (prop.startsWith('style.')) { styleChange(prop.slice(6), v); app.version++; app.changed(); return; }
    if (prop === 'def.description' || prop.startsWith('port.') || prop.startsWith('pdef.')) { definitionChange(prop, v, num); return; }
    if (!one) return;
    const s = one, b = one.b;
    if (prop.startsWith('bits.')) {
      const t = { F: s.F, b }, w = Math.max(1, Math.min(32, b.width || 8));
      if (prop === 'bits.width' && Number.isInteger(num) && num >= 1 && num <= 32) { b.width = num; b.value = GW.word(b.value || 0, num); app.version++; }
      else if (prop === 'bits.value' && Number.isFinite(num)) setKnobValue(t, GW.word(num, w));
      else if (prop.startsWith('bits.bit.')) {
        const i = Number(prop.slice(9)), cur = GW.word(knobValue(t), w), on = Math.floor(cur / Math.pow(2, i)) % 2;
        setKnobValue(t, cur + (on ? -1 : 1) * Math.pow(2, i));
      }
      app.changed(); renderInspector(); return;
    }
    if (prop === 'parts') {
      const parts = String(v).split(/[ ,]+/).map(Number).filter((x) => Number.isInteger(x) && x >= 1);
      const trial = Object.assign({}, b, { parts });
      if (!parts.length || parts.length > 16 || parts.reduce((x, y) => x + y, 0) > 32) toast('Fields are whole numbers of bits, at most 16 fields and 32 bits in all.');
      else if (!G.canPlace(s.F.sheet, app.project.defs, trial, b)) toast('No room for that many fields here.');
      else { b.parts = parts; s.F.sheet.wires = s.F.sheet.wires.filter((w) => G.pinOf(s.F.sheet, app.project.defs, w.from) && G.pinOf(s.F.sheet, app.project.defs, w.to)); G.fixRoutes(s.F.sheet, app.project.defs); app.version++; }
      app.changed(); renderInspector(); return;
    }
    if (prop === 'sock.name') { b.name = String(v).trim() || b.type; app.changed(); return; }
    if (prop === 'table.points') {
      const pts = String(v).split('\n').map((l) => l.trim().split(/[\s,;]+/).map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite));
      if (pts.length < 2) { toast('A table needs two points at least, "x y" a line.'); renderInspector(true); return; }
      b.points = pts.sort((x, y) => x[0] - y[0]);
      app.version++; app.changed(); renderInspector(true); return;
    }
    if (prop === 'pwlink' && v && app.bridge) {
      const mine = app.bridge.selfPort(b.type, b.name || b.type);
      if (mine) b.type === 'out' ? app.bridge.link(mine.id, Number(v)) : app.bridge.link(Number(v), mine.id);
      return;
    }
    if (b.type === 'const' || b.type === 'volts') {
      const t = { F: s.F, b };
      if (prop === 'const.value' && Number.isFinite(num)) setKnobValue(t, num);
      else if (prop === 'const.knob') {
        const on = $('#inspector [data-prop="const.knob"]').checked, val = knobValue(t);
        if (on) b.knob = { label: '', min: Math.min(0, val), max: Math.max(1, val * 2 || 1), scale: 'lin' }; else delete b.knob;
        app.version++; app.changed(); renderInspector();
      } else if (prop.startsWith('cknob.') && b.knob) {
        const k = prop.slice(6);
        b.knob[k] = k === 'min' || k === 'max' ? (Number.isFinite(num) ? num : b.knob[k]) : v;
        app.changed(false);
      }
      return;
    }
    if (prop.startsWith('mparam.')) {
      const id = prop.slice(7), p = G.MODULES[b.type].params.find((q) => q.id === id);
      if (!p || !Number.isFinite(num)) return;
      const v = p.int || p.options ? Math.round(num) : num;
      if (s.F.path) app.project.values[s.F.path + b.id + '#' + id] = v;
      else { b.params = b.params || {}; b.params[id] = v; }
      app.changed(!!p.structural); renderInspector();
      return;
    }
    if (prop === 'loop') { b.loop = v === '1'; app.changed(); return; }
    if (prop === 'swapall') return;
    if (prop === 'swap') {
      const all = $('#inspector [data-prop="swapall"]');
      if (v) swapChip(s.F, b, v, !!(all && all.checked));
      return;
    }
    app.changed();
  }
  // The block editor's fields: the block on the workbench.
  function definitionChange(prop, v, num) {
    const name = benchDef(), def = name && app.project.defs[name];
    if (!def) return;
    if (prop === 'def.description') def.description = v;
    else if (prop.startsWith('pdef.')) {
      const [, i, k] = prop.split('.'), p = def.ports[Number(i)];
      if (k === 'value' && Number.isFinite(num)) p.value = num;
      if (k === 'knob') {
        if ($(`#inspector [data-prop="pdef.${i}.knob"]`).checked) p.knob = { label: p.name, min: Math.min(0, p.value || 0), max: Math.max(1, (p.value || 0) * 2 || 1), scale: (p.value || 0) > 0 ? 'log' : 'lin' };
        else delete p.knob;
        if (p.knob && p.knob.scale === 'log') p.knob.min = Math.max(1e-3, (p.value || 1) / 10);
        app.version++;
      }
    } else if (prop.startsWith('port.')) {
      const [, i, k] = prop.split('.');
      const p = def.ports[Number(i)];
      if (k === 'name') p.name = v;
      else if (k === 'domain') {
        const n = E.portChange(app.project, name, () => { if (v === 'float') delete p.domain; else p.domain = v; });
        if (n) toast(`${plural(n, 'wire')} of the old kind of signal removed.`, 2500);
        app.version++;
      } else if (Number.isInteger(num) && num >= 0 && num < def.fh && !def.ports.some((q) => q !== p && q.dir === p.dir && q.row === num)) {
        E.portChange(app.project, name, () => { p.row = num; });   // moving a port can reorder them: wires stay on it
        app.version++;
      }
      else { toast('That row is taken or outside the block.'); renderInspector(); return; }
    }
    app.changed();
  }
  $('#inspector').addEventListener('focusout', () => setTimeout(() => { if (!$('#inspector').contains(document.activeElement)) renderInspector(); }, 0));

  // ---- status, banner, toast -----------------------------------------------------
  function updateStatus() {
    const h = app.hoverDeep || app.hover, ro = !!(app.hoverDeep && app.hover && app.hoverDeep !== app.hover);
    let s = '';
    if (h) {
      s = (h.F.chain.length ? 'Board › ' + h.F.chain.join(' › ') : 'Board') + `   ${h.x},${h.y}`;
      const pin = pinAt(h), kt = knobAt(h), n = !(h.occ && h.occ.block) ? netAtCell(h) : null;
      if (kt && kt.param) { const p = paramSpec(kt); s += `   ·   ${p.label} = ${G.Analog.showParam(p, knobValueOf(kt))}`; }
      else if (kt) { const k = knobOf(kt); s += `   ·   knob ${k.label || ''} = ${GW.fmt(knobValue(kt))}${app.knobState(knobKey(kt)) !== 'ok' ? ' (' + app.knobState(knobKey(kt)) + ')' : ''}`; }
      else if (pin) {
        const w = G.isSource(pin) ? G.wiresFrom(h.F.sheet, pin).length : G.wiresInto(h.F.sheet, pin).length;
        const pad = G.pinOf(h.F.sheet, app.project.defs, pin), v = app.valueOf(h.F.path + pin), wd = app.compiled && app.compiled.widths[h.F.path + pin];
        const shown = pad.dom === 'fixed' && v !== undefined ? bitsText(v, wd || 1) : GW.fmt(v) + (pad.dom === 'analog' ? ' V' : '');
        s += `   ·   ${pinName(h.F, pin)} (${pad.dom}) = ${shown}   ·   ${w ? plural(w, 'wire') : 'not wired'}${ro ? '' : ' · drag to wire'}`;
      } else if (n) s += `   ·   net from ${pinName(h.F, n.net)} = ${GW.fmt(app.valueOf(h.F.path + n.net))}`;
      else if (h.occ && h.occ.block) s += `   ·   ${h.occ.block.type === 'comp' ? h.occ.block.def : G.info(h.occ.block.type).title}`;
      if (ro) s += `   ·   inside ${h.F.chain[h.F.chain.length - 1]}: to change it, open it (select it, Edit block…)`;
      else if (h.F.def) s += `   ·   editing "${h.F.def.name}"`;
    }
    $('#status').innerHTML = `<span>${esc(s)}</span><span class="hint">${esc(hint())}</span>`;
  }
  const bitsText = (v, w) => (w <= 16 ? Math.round(v).toString(2).padStart(w, '0') + ' = ' : '') + Math.round(v) + ` (${w} bit${w === 1 ? '' : 's'})`;
  // What the pointer and keys do right now.
  function hint() {
    if (app.pasting) return 'click: paste · Shift-click: paste again · Esc: cancel';
    if (app.placing) return 'click: place · R: rotate · Shift-click: place several · Esc: cancel';
    if (app.drag && app.drag.kind === 'pwlink') return 'release on a port of another program, or on a socket, to link them in PipeWire';
    if (app.drag && app.drag.kind === 'wire') return 'release on a pin to wire it · anywhere else to cancel' + (app.drag.picked ? ' (and remove the wire)' : '');
    if (app.route) return 'click: corner · /: flip corner · click a pin: finish · Esc: cancel';
    if (app.tool === 'route') return 'click a pin, or a trace to branch from it, then click corners and finish on a pin';
    if (app.sel && !E.isEmpty(app.sel)) return 'drag a block: move · drag a trace: reshape · arrows: nudge · Ctrl+C / X / D · Del: delete · Esc: deselect';
    return 'drag pin → pin: wire · drag a block: move · drag on empty board: select · right-drag: pan · wheel: zoom · ?: help';
  }
  function updateBanner() {
    const m = [];
    if (app.compiled && !app.compiled.ok) m.push(['err', '⚠ ' + app.compiled.errors[0].msg]);
    const lw = app.library ? app.library.warnings : [];
    if (lw.length) m.push(['err', `Library: ${lw[0]}${lw.length > 1 ? ` (and ${lw.length - 1} more)` : ''}`]);
    if (app.snap && app.snap.bad) m.push(['err', 'An Out socket saw NaN or ∞ — press Reset.']);
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
    if (GW.Migrate.isOld(p)) GW.Migrate.project(p);   // saved before wires: painted nets become wires
    if (GW.Migrate.hasRack(p)) GW.Migrate.unrackProject(p);   // saved before one canvas: the rack moves onto the board
    if (GW.Migrate.hasSample(p)) GW.Migrate.unsampleProject(p);   // saved before In sockets replaced the WAV player
    if (GW.Migrate.hasOldConverters(p)) GW.Migrate.convertProject(p);   // saved before converters were library blocks
    p.version = 5;
    const refreshed = syncWithLibrary(p);
    if (refreshed.length && !EMBED) setTimeout(() => toast(`Updated from the library: ${refreshed.join(', ')}.`, 5000), 0);
    app.project = p; app.sel = null; app.placing = null; app.pasting = null; app.route = null; app.hover = null; app.hotRegion = null; app.version++;
    if (label) app.commit(label); else app.history.reset(JSON.stringify(p));
    updatePalette(); app.changed();
    recompile(); renderInspector(); updateToolbar();
    app.view.fitted = false;
    requestAnimationFrame(() => { const v = app.view; v.resize(); app.fitView(v, 'board'); v.fitted = true; });
  }
  // A view's first framing after a load: the design's saved opening view, else everything.
  app.openCamera = null;
  app.fitView = (v, mode) => {
    const r = app.openCamera && app.openCamera[mode];
    if (r) { v.fitRect(r[0], r[1], r[2], r[3], 0); Object.assign(v.cam, v.target); v.anchor = null; v.dirty = true; } else v.fitAll();
  };

  // ---- the catalogue: curated examples and the block library ------------------------------
  // Both are design files in the repository (see FORMAT.md): examples/ holds whole
  // designs, library/ one block each. The library is where every design's blocks
  // come from, and designs refer to its blocks by name, so curating a block's
  // insides reaches every design that uses it. Served by tools/serve.py, the page
  // can also save into both folders ("Save…").
  const CURATED_KEY = 'samplefactory.curated';
  app.manifest = null; app.libManifest = null; app.curator = false;
  app.library = { defs: null, fileOf: {}, warnings: [], source: 'generated', text: {} };
  const libraryDefs = () => app.library.defs || GW.starterDefs();
  app.libraryDefs = libraryDefs;
  try { app.curated = JSON.parse(localStorage.getItem(CURATED_KEY)) || null; } catch (e) { app.curated = null; }
  function setCurated(c) {
    app.curated = c;
    try { c ? localStorage.setItem(CURATED_KEY, JSON.stringify(c)) : localStorage.removeItem(CURATED_KEY); } catch (e) { /* not kept */ }
    updateCurated();
  }
  // The file the design came from, and whether it has changed since it was opened or saved.
  const stateHash = () => fnv(JSON.stringify(app.project));
  function updateCurated() {
    const el = $('#curated'), c = app.curated;
    if (!el) return;
    if (!c || !c.file) { el.hidden = true; return; }
    const dirty = !!app.project && c.saved !== stateHash();
    el.hidden = false;
    el.textContent = `${c.folder || (c.kind === 'block' ? 'library' : 'examples')}/${c.file}${dirty ? ' •' : ''}`;
    el.classList.toggle('dirty', dirty);
    el.title = (dirty ? 'Changed since it was opened or saved. ' : 'Saved. ') + (app.curator ? 'Ctrl+S (or click) saves it.' : 'Served without tools/serve.py: use Save… to download it.');
  }
  app.updateCurated = updateCurated;
  async function fetchCatalogue() {
    let man = null, lib = null;
    try {
      const r = await fetch('api/curate', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); app.curator = !!j.ok; man = j.manifest; lib = j.library; app.trash = j.trash || []; }
    } catch (e) { /* not the curator server */ }
    const getJson = async (url) => { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
    if (!man) man = await getJson('examples/index.json');
    if (!lib) lib = await getJson('library/index.json');
    app.manifest = man; app.libManifest = lib;
    if (lib && lib.blocks && lib.blocks.length) {
      const files = await Promise.all(lib.blocks.map(async (e) => ({ file: e.file, doc: await getJson('library/' + encodeURIComponent(e.file)) })));
      const missing = files.filter((f) => !f.doc).map((f) => f.file);
      const L = GW.Format.loadLibrary(files.filter((f) => f.doc));
      app.library = { defs: L.defs, fileOf: L.fileOf, warnings: missing.map((f) => `${f}: could not be read`).concat(L.warnings), source: 'files', text: {} };
    } else app.library.warnings = location.protocol === 'file:' ? [] : ['library/ could not be read: using the blocks built into the app'];
    renderOpenMenu();
  }
  app.manifestReady = fetchCatalogue();
  app.reloadCatalogue = async () => { await fetchCatalogue(); app.library.text = {}; updatePalette(); updateCurated(); };

  // Which blocks in the open design differ from the library. A design remembers, per
  // block, the library version it started from (project.base: a hash of the block's
  // text), so an edited block can be told apart from one the library has since improved.
  const fnv = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const defText = (d) => GW.Format.stringify(GW.Format.encodeDef(d));
  const libText = (n) => { const lib = libraryDefs()[n]; if (!lib) return undefined; return app.library.text[n] || (app.library.text[n] = defText(lib)); };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // Bring a design up to date with the library: add blocks it doesn't have, note which
  // ones match, and replace unedited blocks the library has improved (if their pins are
  // the same). Returns the names replaced.
  function syncWithLibrary(p) {
    const lib = libraryDefs(), updated = [];
    p.base = p.base || {};
    for (const n of Object.keys(lib)) {
      const lt = libText(n);
      if (!p.defs[n]) { p.defs[n] = clone(lib[n]); p.base[n] = fnv(lt); continue; }
      const t = defText(p.defs[n]);
      if (t === lt) { p.base[n] = fnv(lt); continue; }
      if (p.base[n] !== undefined && fnv(t) === p.base[n] && GW.Format.sig(p.defs[n]) === GW.Format.sig(lib[n])) {
        p.defs[n] = clone(lib[n]); p.base[n] = fnv(lt); updated.push(n);
      }
    }
    return updated;
  }
  // name -> 'edited' (changed since it came from the library), 'own' (the design's own
  // version of a library block) or 'new' (not in the library). Unchanged blocks are absent.
  function blockStatus() {
    const p = app.project, out = {};
    for (const n of Object.keys(p.defs)) {
      const t = defText(p.defs[n]), lt = libText(n), b = p.base && p.base[n];
      if (t === lt) continue;
      out[n] = lt === undefined ? 'new' : b !== undefined && fnv(t) !== b ? 'edited' : 'own';
    }
    return out;
  }
  app.blockStatus = blockStatus;
  const STATUS_WORD = { edited: 'edited', own: 'differs from the library', new: 'new, not in the library' };

  function renderOpenMenu() {
    let h = '<option value="">Open…</option>';
    const ex = (app.manifest && app.manifest.examples) || [], bl = (app.libManifest && app.libManifest.blocks) || [];
    if (ex.length) h += '<optgroup label="Examples">' + ex.map((x, i) => `<option value="c:${esc(x.file)}">${i + 1} · ${esc(x.title)}</option>`).join('') + '</optgroup>';
    if (bl.length) h += '<optgroup label="Library blocks">' + bl.slice().sort((a, b) => a.title.localeCompare(b.title)).map((x) => `<option value="b:${esc(x.file)}">${esc(x.title)}</option>`).join('') + '</optgroup>';
    if (!ex.length) h += '<optgroup label="Examples (built in)">' + GW.EXAMPLES.map((x, i) => `<option value="g:${i}">${esc(x.title)}</option>`).join('') + '</optgroup>';
    $('#examples').innerHTML = h;
  }
  renderOpenMenu();
  // Opening replaces the design; say what unsaved block edits there are (undo brings them back).
  function confirmReplace(what) {
    const st = blockStatus(), edited = Object.keys(st).filter((n) => st[n] === 'edited' || st[n] === 'new');
    return confirm(`Open ${what}? This replaces the current design (Ctrl+Z brings it back).` +
      (edited.length ? `\n\nBlocks with changes not saved to the library: ${edited.join(', ')}.` : ''));
  }
  $('#examples').addEventListener('change', (e) => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    if (v.startsWith('c:') || v.startsWith('b:')) {
      const lib = v.startsWith('b:'), list = lib ? app.libManifest.blocks : app.manifest.examples, it = list.find((x) => x.file === v.slice(2));
      if (it && confirmReplace(lib ? `the block "${it.title}"` : `"${it.title}"`)) loadDesignFile(it.file, false, lib ? 'library' : 'examples');
      return;
    }
    const i = Number(v.slice(2));
    if (GW.EXAMPLES[i] && confirmReplace(`"${GW.EXAMPLES[i].title}"`)) loadExample(i);
  });
  // Open a design document (an example, or a block on its workbench).
  function openDesign(doc, label, file, folder) {
    const r = GW.Format.decode(doc, libraryDefs());
    const m = r.meta || {};
    if (r.kind === 'block') {
      // zoomed in, so the block's insides fill the window
      const d = r.def, a = GW.Format.BENCH_AT, pad = 0.02;
      app.openCamera = { board: [a - pad * d.fw, a - pad * d.fh, a + d.fw * (1 + pad), a + d.fh * (1 + pad)] };
    } else app.openCamera = m.camera || null;
    loadProject(r.project, label);
    app.host.reset();
    setRate(r.kind === 'example' && m.rate ? Math.min(RATE_MAX, Math.max(RATE_MIN, Number(m.rate))) : RATE_MAX);
    app.host.setRunning(true); updateClock();
    setCurated(file ? { kind: r.kind, folder: folder || 'examples', file, name: r.name, meta: m, saved: stateHash() } : null);
    if (r.warnings.length) toast(`Opened with ${plural(r.warnings.length, 'warning')}: ${r.warnings.join('; ')}`, 10000);
    else if (r.kind === 'block' && !EMBED) toast(`The ${r.name} block on its workbench. Edit its insides, then Save… → Block "${r.name}" puts it back in the library.`, 6000);
    else if (m.note && !EMBED) toast(m.note, 8000);
    return r;
  }
  async function loadDesignFile(file, fresh, folder) {
    folder = folder || 'examples';
    try {
      const res = await fetch(folder + '/' + encodeURIComponent(file), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const doc = await res.json();
      openDesign(doc, fresh ? null : 'open ' + ((doc.meta && doc.meta.title) || file), file, folder);
    } catch (err) { toast(`Could not open ${folder}/${file}: ${err.message}`); }
  }
  app.loadDesignFile = loadDesignFile; app.openDesign = openDesign;
  function loadExample(i) {
    app.openCamera = null; setCurated(null);
    loadProject(GW.exampleProject(i, app.project ? app.project.defs : null, libraryDefs()), app.project ? 'load ' + GW.EXAMPLES[i].title : null);
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
  // ---- design files: export, import, save as example ----------------------------------
  function download(text, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; a.click();
  }
  // The visible part of the board, in cells: the design's opening view.
  function cameraNow() {
    const v = app.view, a = v.toWorld(0, 0), b = v.toWorld(v.W, v.H);
    return v.W > 0 && v.H > 0 ? { board: [a.x, a.y, b.x, b.y].map((x) => Math.round(x * 100) / 100) } : {};
  }
  // An example refers to the library's blocks; an export carries copies of them all,
  // so it opens anywhere.
  app.designText = (meta, selfContained) => GW.Format.stringify(GW.Format.encode(app.project,
    meta || (app.curated && app.curated.kind === 'example' && app.curated.meta) || {}, selfContained ? null : libraryDefs()));
  app.blockText = (name) => GW.Format.stringify(GW.Format.encodeBlock(app.project.defs, name, {}, libraryDefs()));
  $('#btn-export').addEventListener('click', () => {
    const meta = Object.assign({}, (app.curated && app.curated.kind === 'example' && app.curated.meta) || {}, { rate: app.host.rate });
    download(app.designText(meta, true), (app.curated && app.curated.kind === 'example' ? app.curated.file.replace(/\.json$/, '') : 'sample-factory') + '.json');
  });

  // ---- Save…: the whole design as an example, or a block into the library -------------------
  const rateText = (r) => (r >= RATE_MAX ? 'real time' : rateLabel(r).split(' · ')[0]);
  let svBlocks = {};   // name -> status, for the "What" choices
  let svExample = { title: '', file: '' };   // the example fields, kept while a block is chosen
  // The block the user is looking at or has selected, if any.
  function blockInFocus() {
    const one = selBlock();
    if (one && one.b.type === 'comp') return one.b.def;
    const F = app.sel ? app.sel.F : app.hover && app.hover.F;
    return F && F.def ? F.def.name : null;
  }
  function openSaveDialog() {
    const d = $('#save-dlg'), cur = app.curated;
    const m = (cur && cur.kind === 'example' && cur.meta) || {};
    svBlocks = blockStatus();
    const focus = cur && cur.kind === 'block' ? cur.name : blockInFocus();
    if (focus && app.project.defs[focus] && !svBlocks[focus]) svBlocks[focus] = 'same';
    const names = Object.keys(svBlocks).sort((a, b) => (svBlocks[a] === 'same') - (svBlocks[b] === 'same') || a.localeCompare(b));
    $('#sv-what').innerHTML = '<option value="example">The whole design, as an example</option>' +
      names.map((n) => `<option value="block:${esc(n)}">Block "${esc(n)}" into the library (${svBlocks[n] === 'same' ? 'no changes' : STATUS_WORD[svBlocks[n]]})</option>`).join('');
    const want = cur && cur.kind === 'block' ? 'block:' + cur.name : focus && svBlocks[focus] && svBlocks[focus] !== 'same' ? 'block:' + focus : 'example';
    $('#sv-what').value = want;
    $('#sv-title').value = m.title || '';
    $('#sv-note').value = m.note || '';
    $('#sv-rate').innerHTML = `<option value="${app.host.rate}">as now (${esc(rateText(app.host.rate))})</option>` +
      (app.host.rate < RATE_MAX ? `<option value="${RATE_MAX}">real time</option>` : '') +
      (m.rate && m.rate !== app.host.rate && m.rate < RATE_MAX ? `<option value="${m.rate}">as saved (${esc(rateText(m.rate))})</option>` : '');
    $('#sv-cam').checked = true;
    $('#sv-file').value = cur && cur.kind === 'example' ? cur.file.replace(/\.json$/, '') : '';
    $('#sv-title').readOnly = false;
    svWhat();
    d.showModal();
    (svTarget() ? $('#sv-desc') : $('#sv-title')).focus();
  }
  const svTarget = () => { const v = $('#sv-what').value; return v.startsWith('block:') ? v.slice(6) : null; };
  // Show the fields for what is being saved.
  function svWhat() {
    const n = svTarget();
    $('#save-dlg').classList.toggle('blockmode', !!n);
    if (!$('#sv-title').readOnly) svExample = { title: $('#sv-title').value, file: $('#sv-file').value };
    $('#sv-title').readOnly = !!n;
    if (n) {
      $('#sv-title').value = n;
      $('#sv-desc').value = app.project.defs[n].description || '';
      $('#sv-file').value = (app.library.fileOf[n] || GW.Format.slug(n) + '.json').replace(/\.json$/, '');
    } else { $('#sv-title').value = svExample.title; $('#sv-file').value = svExample.file; }
    $('#sv-save').textContent = n ? 'Save to library/' : 'Save to examples/';
    $('#sv-save').disabled = !app.curator;
    $('#sv-save').title = app.curator ? '' : 'Only when the app is served by tools/serve.py';
    svStatus();
  }
  function svFile() { return GW.Format.slug($('#sv-file').value.trim() || $('#sv-title').value) + '.json'; }
  // Blocks that saving `n` also saves: the ones inside it that differ from the library, innermost first.
  function svChain(n) {
    const st = blockStatus(), defs = app.project.defs;
    const deps = GW.Format.depsOf(defs, [n]).filter((x) => st[x]), done = [], left = new Set(deps);
    while (left.size) {
      const next = [...left].find((x) => GW.Format.depsOf(defs, [x]).every((y) => !left.has(y))) || [...left][0];
      done.push(next); left.delete(next);
    }
    return done;
  }
  function svStatus() {
    const n = svTarget(), f = svFile();
    let s;
    if (n) {
      const chain = svChain(n), users = Object.keys(app.project.defs).filter((x) => x !== n && GW.Format.depsOf(app.project.defs, [x]).includes(n));
      const pinsChanged = libraryDefs()[n] && GW.Format.sig(libraryDefs()[n]) !== GW.Format.sig(app.project.defs[n]);
      s = `File: library/${f}` + (app.library.fileOf[n] ? ' (replaces the library\'s version)' : ' (a new block in the library)') + '.';
      if (chain.length) s += ` Also saves the blocks inside it that changed: ${chain.join(', ')}.`;
      s += ' Every example and block that uses it will use this version.';
      if (users.length) s += ` In the library, ${users.join(', ')} contain${users.length === 1 ? 's' : ''} it.`;
      if (pinsChanged) s += ' Its pins have changed: the files that use it are updated too, their wires following its ports by name.';
    } else {
      const exists = app.manifest && app.manifest.examples.some((x) => x.file === f);
      const own = Object.entries(blockStatus()).filter(([x]) => GW.Format.usedDefs(app.project).includes(x)).map(([x]) => x);
      s = `File: examples/${f}` + (exists ? ' (replaces the one in the menu)' : ' (new; added at the end of the menu)') + '.';
      if (own.length) s += ` It keeps its own versions of ${own.join(', ')} (they differ from the library); to share them, save them to the library first.`;
    }
    if (!app.curator) s += ' This page is not served by tools/serve.py, so it can only download the file.';
    $('#sv-status').textContent = s;
  }
  function svMeta() {
    const meta = { title: $('#sv-title').value.trim() || 'Untitled', note: $('#sv-note').value.trim(), rate: Number($('#sv-rate').value) };
    if (!meta.note) delete meta.note;
    if ($('#sv-cam').checked) meta.camera = cameraNow();
    return meta;
  }
  // The block's description is part of the block: an edit like any other.
  function svApplyDescription(n) {
    const d = app.project.defs[n], v = $('#sv-desc').value.trim();
    if ((d.description || '') !== v) { d.description = v; app.changed(); app.commit('describe ' + n); }
  }
  // The curator server's requests (tools/serve.py).
  async function api(method, path, body) {
    const r = await fetch('api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    let j;
    try { j = await r.json(); } catch (e) { j = { ok: false, error: r.statusText }; }
    if (!r.ok || !j.ok) throw new Error(j.error || r.statusText);
    if (j.trash) app.trash = j.trash;
    return j;
  }
  const put = (folder, file, text) => api('PUT', `${folder}/${file}`, text);
  for (const id of ['#sv-title', '#sv-file']) $(id).addEventListener('input', svStatus);
  $('#sv-what').addEventListener('change', svWhat);
  $('#sv-download').addEventListener('click', () => {
    const n = svTarget();
    if (n) { svApplyDescription(n); download(app.blockText(n), svFile()); }
    else download(app.designText(svMeta()), svFile());
    $('#save-dlg').close();
  });
  // Save block n into library/<file>, after the blocks inside it that changed.
  async function saveBlock(n, file) {
    const saved = [], repinned = [];
    for (const x of svChain(n).concat([n])) {
      const was = libraryDefs()[x];
      if (was && GW.Format.sig(was) !== GW.Format.sig(app.project.defs[x])) repinned.push(x);
      const f = x === n ? file : app.library.fileOf[x] || GW.Format.slug(x) + '.json';
      const j = await put('library', f, app.blockText(x));
      // the library now has this version: designs refer to it from here on
      app.library.defs = Object.assign({}, libraryDefs(), { [x]: clone(app.project.defs[x]) });
      app.library.fileOf[x] = f; delete app.library.text[x];
      app.project.base = app.project.base || {};
      app.project.base[x] = fnv(libText(x));
      app.libManifest = j.manifest;
      saved.push(`library/${f}`);
    }
    // its pins changed: the files that use it are brought up to date (wires follow the ports by name)
    if (repinned.length) {
      const updated = await app.files.updateUsers(repinned);
      if (updated.length) saved.push(`and updated ${updated.length} file${updated.length === 1 ? '' : 's'} that use${updated.length === 1 ? 's' : ''} ${repinned.join(', ')} (${updated.join(', ')})`);
    }
    if (app.curated && app.curated.kind === 'block' && app.curated.name === n) setCurated(Object.assign({}, app.curated, { file, saved: stateHash() }));
    renderOpenMenu(); updatePalette();
    return saved;
  }
  async function saveExample(meta, file) {
    const j = await put('examples', file, app.designText(meta));
    app.manifest = j.manifest; renderOpenMenu();
    setCurated({ kind: 'example', folder: 'examples', file, meta, saved: stateHash() });
    return j;
  }
  // Ctrl+S: the open example or block, back to its file, as it is; anything else opens Save….
  async function quickSave() {
    const c = app.curated;
    if (!c || !app.curator || !c.file) { openSaveDialog(); return; }
    try {
      if (c.kind === 'block') { const saved = await saveBlock(c.name, c.file); toast(`Saved ${saved.join(', ')}.`, 2500); }
      else { await saveExample(c.meta || {}, c.file); toast(`Saved examples/${c.file}.`, 2500); }
    } catch (err) { toast('Could not save: ' + err.message, 6000); }
  }
  app.quickSave = quickSave;
  $('#sv-save').addEventListener('click', async () => {
    const n = svTarget();
    try {
      if (n) {
        svApplyDescription(n);
        const saved = await saveBlock(n, svFile());
        $('#save-dlg').close();
        toast(`Saved ${saved.join(', ')}.`, 4000);
      } else {
        const meta = svMeta(), file = svFile(), exists = app.manifest && app.manifest.examples.some((x) => x.file === file);
        if (exists && !(app.curated && app.curated.kind === 'example' && app.curated.file === file) && !confirm(`examples/${file} already exists. Replace it?`)) return;
        const j = await saveExample(meta, file);
        $('#save-dlg').close();
        toast(`Saved examples/${file}${j.replaced ? ' (replaced)' : ''}. It is in the Open menu.`, 4000);
      }
    } catch (err) { $('#sv-status').textContent = 'Could not save: ' + err.message; }
  });
  $('#btn-save-example').addEventListener('click', openSaveDialog);
  $('#curated').addEventListener('click', quickSave);
  // The Files manager (files.js): examples and blocks, new, open, duplicate, rename, delete, reorder, trash.
  app.files = new GW.Files(app, { api, put, libraryDefs, setCurated, stateHash, loadDesignFile, openDesign, renderOpenMenu, confirmReplace, toast, clone });
  $('#btn-files').addEventListener('click', () => app.files.open());
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      GW.Format.decode(doc);   // check it before asking
      if (confirm('Replace the current project? (Ctrl+Z brings it back.)')) openDesign(doc, 'import', null);
    } catch (err) { toast('Import failed: ' + err.message); }
  });
  $('#btn-help').addEventListener('click', () => $('#help-dlg').showModal());
  document.querySelectorAll('dialog .close').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  Object.assign(app, { toast, renderInspector, updateToolbar, updatePalette, updateStatus, updateClock, setRate });

  // ---- start ------------------------------------------------------------------------
  app.host = new GW.Host((snap) => {
    const wasBad = app.snap && app.snap.bad;
    app.snap = snap;
    $('#ticks').textContent = 'tick ' + snap.ticks.toLocaleString('en-US');
    $('#ticks').title = `${(snap.ticks / G.FS).toFixed(4)} s of simulated time (a tick is always 1/48 000 s)`;
    app.view.dirty = true;
    if (!!snap.bad !== !!wasBad) updateBanner();
  }, (msg) => { if (msg) toast(msg); updateClock(); });
  app.view = new GW.View(app, canvas);
  $('#rate').value = 1;

  if (EMBED) document.body.classList.add('embed');
  // Hooks for the interactivity tests (tests/ui/ui-tests.js, run by tests/run-ui.py).
  app.loadExample = loadExample;
  app.pinAt = pinAt;
  app.select = select;

  // Start once the library is in: every design's blocks come from it.
  app.started = (async () => {
    await app.manifestReady;
    let saved = null;
    try { saved = EMBED ? null : JSON.parse(localStorage.getItem(STORE) || localStorage.getItem(OLD_STORE)); } catch (e) { saved = null; }
    const firstExample = app.manifest && app.manifest.examples.find((x) => x.file === 'sequenced-synth.json');
    if (Q.has('design')) { loadExample(2); await loadDesignFile(Q.get('design'), true); }
    else if (Q.has('example')) loadExample(Number(Q.get('example')) || 0);
    else if (saved && saved.root && saved.version >= 2) { loadProject(saved); updateClock(); } else if (firstExample) await loadDesignFile(firstExample.file, true);
    else loadExample(2);
    if (Q.has('rate')) setRate(Math.min(RATE_MAX, Math.max(RATE_MIN, Number(Q.get('rate')) || RATE_MAX)));
    if (Q.has('focus')) setTimeout(() => focusOn(Q.get('focus')), 100);
    if (Q.has('files')) app.files.open(Q.get('files') || 'examples');   // index.html?files=library opens Files on that tab
    setTool('select');
    updateBanner(); updateCurated();
    if (Q.get('uitest') === '1') {
      const sc = document.createElement('script');
      sc.src = 'tests/ui/ui-tests.js';
      document.body.appendChild(sc);
    }
  })();
})();
