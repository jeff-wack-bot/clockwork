// Editing operations, without the DOM: selection, clipboard, move, delete,
// reshaping a trace, and undo history. The app (app.js) turns pointer and key
// events into these calls; tests/editor.test.js drives them directly.
//
// A frame F is { sheet, path, def }: the board being edited, the path prefix of
// its pins ('' at the root, 'b3/' inside block b3), and the definition when the
// board is the inside of a composite block.
// A selection is { F, blocks: Set(block id), wires: Set(wire id), net }: whole
// blocks and wires. `net` is the source endpoint of the net shown in the
// inspector when a trace was clicked.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;
  const k2 = (x, y) => x + ',' + y;

  function emptySelection(F) { return { F, blocks: new Set(), wires: new Set(), net: null }; }
  const isEmpty = (sel) => !sel || (sel.blocks.size === 0 && sel.wires.size === 0);
  const count = (sel) => (sel ? sel.blocks.size + sel.wires.size : 0);
  const blockOf = (e) => G.parseEp(e).b;

  // ---- picking -------------------------------------------------------------------
  // The wires whose traces run through a cell, and the net they belong to.
  // `routes` is G.routesOf(sheet, defs) (the view keeps one cached).
  function wiresAtCell(sheet, routes, x, y) {
    return sheet.wires.filter((w) => { const r = routes.get(w.id); return r && r.some((c) => c[0] === x && c[1] === y); });
  }
  function netAt(sheet, routes, x, y) {
    const ws = wiresAtCell(sheet, routes, x, y);
    if (!ws.length) return null;
    const net = ws[0].from;
    return { net, wire: ws[0], wires: sheet.wires.filter((w) => w.from === net) };
  }

  // Everything inside a rectangle of cells (inclusive): blocks whose whole
  // footprint is inside, and wires whose whole trace is inside.
  function selectRect(F, defs, r, base, routes) {
    const sel = base || emptySelection(F);
    routes = routes || G.routesOf(F.sheet, defs);
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    for (const b of F.sheet.blocks) {
      const fp = G.footprint(b, defs);
      if (inside(b.x, b.y) && inside(b.x + fp.w - 1, b.y + fp.h - 1)) sel.blocks.add(b.id);
    }
    for (const w of F.sheet.wires) { const rt = routes.get(w.id); if (rt && rt.every(([x, y]) => inside(x, y))) sel.wires.add(w.id); }
    return sel;
  }
  function selectAll(F) {
    const sel = emptySelection(F);
    for (const b of F.sheet.blocks) sel.blocks.add(b.id);
    for (const w of F.sheet.wires) sel.wires.add(w.id);
    return sel;
  }
  // Bounding box of a selection, in cells (inclusive).
  function bounds(F, defs, sel, routes) {
    routes = routes || G.routesOf(F.sheet, defs);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w - 1); y1 = Math.max(y1, y + h - 1); };
    for (const b of F.sheet.blocks) if (sel.blocks.has(b.id)) { const fp = G.footprint(b, defs); grow(b.x, b.y, fp.w, fp.h); }
    for (const w of F.sheet.wires) if (sel.wires.has(w.id)) for (const [x, y] of routes.get(w.id) || []) grow(x, y, 1, 1);
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }
  // The wires a set of blocks takes along: those with both ends on them.
  const wiresAmong = (sheet, ids) => sheet.wires.filter((w) => ids.has(blockOf(w.from)) && ids.has(blockOf(w.to)));

  // ---- clipboard -------------------------------------------------------------------
  // A clip is position-independent: blocks relative to the selection's top-left
  // corner, the wires between them (with their traces), and the knob settings of
  // copied blocks inside an instance.
  function copy(project, F, sel, routes) {
    const defs = project.defs;
    routes = routes || G.routesOf(F.sheet, defs);
    const ids = new Set(sel.blocks), bb = bounds(F, defs, { blocks: ids, wires: new Set() }, routes);
    if (!bb) return null;
    const clip = { kind: 'samplefactory.clip2', w: bb.x1 - bb.x0 + 1, h: bb.y1 - bb.y0 + 1, blocks: [], wires: [], values: {} };
    for (const b of F.sheet.blocks) {
      if (!ids.has(b.id)) continue;
      const c = JSON.parse(JSON.stringify(b));
      c.x -= bb.x0; c.y -= bb.y0;
      if (b.type === 'const' && F.path && project.values[F.path + b.id] !== undefined) c.value = project.values[F.path + b.id];
      clip.blocks.push(c);
      // knob settings inside a composite block ('id/…') or of an analog module ('id#knob')
      for (const sep of ['/', '#']) {
        const prefix = F.path + b.id + sep;
        for (const k in project.values) if (k.startsWith(prefix)) clip.values[b.id + sep + k.slice(prefix.length)] = project.values[k];
      }
    }
    for (const w of wiresAmong(F.sheet, ids)) {
      const r = routes.get(w.id);
      clip.wires.push({ from: w.from, to: w.to, path: r ? r.map(([x, y]) => [x - bb.x0, y - bb.y0]) : undefined });
    }
    return clip;
  }
  // Why a clip can't go at (ax, ay), or null if it can.
  function pasteProblem(project, F, clip, ax, ay) {
    const sh = F.sheet, defs = project.defs;
    const trial = { ...sh, blocks: sh.blocks.slice() };
    for (const b of clip.blocks) {
      if (b.type === 'comp' && F.def && (b.def === F.def.name || G.uses(defs, b.def, F.def.name))) return `"${b.def}" can't go inside itself.`;
      const nb = Object.assign({}, b, { id: '_' + b.id, x: b.x + ax, y: b.y + ay });
      if (!G.canPlace(trial, defs, nb)) return 'No room there: the blocks would overlap.';
      trial.blocks.push(nb);
    }
    return null;
  }
  function paste(project, F, clip, ax, ay) {
    const why = pasteProblem(project, F, clip, ax, ay);
    if (why) return { error: why };
    const sh = F.sheet, sel = emptySelection(F), ids = {};
    for (const b of clip.blocks) {
      const nb = Object.assign(JSON.parse(JSON.stringify(b)), { id: (b.type === 'const' ? 'c' : 'b') + sh.nextId++, x: b.x + ax, y: b.y + ay });
      ids[b.id] = nb.id;
      sh.blocks.push(nb);
      sel.blocks.add(nb.id);
    }
    for (const k in clip.values) {
      const i = k.search(/[/#]/), id = ids[k.slice(0, i)];
      if (id) project.values[F.path + id + k.slice(i)] = clip.values[k];
    }
    const re = (e) => { const p = G.parseEp(e); return G.ep(ids[p.b], p.dir, p.i); };
    for (const w of clip.wires) {
      const nw = G.addWire(sh, re(w.from), re(w.to), w.path && w.path.map(([x, y]) => [x + ax, y + ay]));
      if (nw) sel.wires.add(nw.id);
    }
    return { sel };
  }

  // ---- delete ---------------------------------------------------------------------
  function remove(project, F, sel) {
    const sh = F.sheet;
    for (const id of sel.blocks) {
      for (const k of Object.keys(project.values)) if (k.startsWith(F.path + id + '/') || k.startsWith(F.path + id + '#') || k === F.path + id) delete project.values[k];
    }
    G.removeBlocks(sh, sel.blocks);
    G.removeWires(sh, sel.wires);
  }

  // ---- move ---------------------------------------------------------------------
  // Move the selected blocks by (dx, dy): all or nothing (blocks can't overlap).
  // Wires come along: a wire between two moved blocks keeps its trace, shifted;
  // a wire with one end moved keeps its trace from the end that stayed and is
  // re-routed from there to the pin's new place.
  function move(project, F, sel, dx, dy) {
    const sh = F.sheet, defs = project.defs;
    if (!dx && !dy) return sel;
    const moving = sh.blocks.filter((b) => sel.blocks.has(b.id));
    const others = { ...sh, blocks: sh.blocks.filter((b) => !sel.blocks.has(b.id)) };
    for (const b of moving) if (!G.canPlace(others, defs, Object.assign({}, b, { x: b.x + dx, y: b.y + dy }))) return null;
    const routes = G.routesOf(sh, defs);
    for (const b of moving) { b.x += dx; b.y += dy; }
    const occ = G.occupancy(sh, defs);
    const movedAt = (c) => { const o = occ.get(k2(c[0], c[1])); return !!(o && o.block && sel.blocks.has(o.block.id)); };
    for (const w of sh.wires) {
      const a = sel.blocks.has(blockOf(w.from)), z = sel.blocks.has(blockOf(w.to)), r = routes.get(w.id);
      if (!a && !z) continue;
      if (!r) { delete w.path; continue; }
      if (a && z) { w.path = r.map(([x, y]) => [x + dx, y + dy]); continue; }
      G.reattach(sh, defs, w, r, a ? 'from' : 'to', movedAt);
    }
    return sel;
  }
  // ---- changing a block's ports ----------------------------------------------------------
  // Wires name a block's pins by position (its n-th input), so adding, removing or
  // moving a port would shift the wires below it onto other ports. portChange runs
  // `mutate(def)` and then moves every wire to the port it was on, by port, in
  // every sheet of the project (copies of the block, and its own inside), and the
  // per-copy knob settings of input defaults with them. Wires to a removed port go.
  // Returns the number of wires removed.
  function portChange(project, name, mutate) {
    const defs = project.defs, def = defs[name];
    const before = { in: G.portsOf(def, 'in'), out: G.portsOf(def, 'out') };
    mutate(def);
    const map = {};
    for (const dir of ['in', 'out']) { const after = G.portsOf(def, dir); map[dir] = before[dir].map((p) => after.indexOf(p)); }
    const same = ['in', 'out'].every((d) => map[d].every((k, i) => k === i)) && G.portsOf(def, 'in').length === before.in.length && G.portsOf(def, 'out').length === before.out.length;
    let dropped = 0;
    if (!same) {
      dropped += G.remapPorts(def, 'port', map).length;
      for (const sh of [project.root, ...Object.values(defs)]) {
        for (const b of sh.blocks) if (b.type === 'comp' && b.def === name) dropped += G.remapPorts(sh, b.id, map).length;
      }
      remapValues(project, name, map);
    }
    // a port that changed its kind of signal can't keep wires of the other kind
    for (const sh of [project.root, ...Object.values(defs)]) {
      const bad = new Set(sh.wires.filter((w) => G.pinOf(sh, defs, w.from) && G.pinOf(sh, defs, w.to) && G.wireProblem(sh, defs, w.from, w.to)).map((w) => w.id));
      if (bad.size) { G.removeWires(sh, bad); dropped += bad.size; }
      G.mendPaths(sh, defs);
    }
    return dropped;
  }
  // Knob settings of input defaults are kept per copy as "<path>/port.i<n>".
  function remapValues(project, name, map) {
    const vals = project.values || {}, out = {};
    for (const [k, v] of Object.entries(vals)) {
      const parts = k.split('/'), last = parts.pop(), m = /^port\.i(\d+)$/.exec(last);
      let sheet = project.root, def = null;
      for (const id of parts) { const b = sheet && sheet.blocks.find((x) => x.id === id); def = b && b.def; sheet = def && project.defs[def]; }
      if (m && def === name) { const n = map.in[Number(m[1])]; if (n >= 0) out[[...parts, 'port.i' + n].join('/')] = v; }
      else out[k] = v;
    }
    project.values = out;
  }

  // ---- the size of one copy -------------------------------------------------------------
  // A composite block's size in the design it sits in (w × h cells), not the
  // block's: its inside is drawn scaled to fit, its pins spread over the height.
  // Null size (or the block's own) goes back to the block's footprint. Wires keep
  // their traces up to the pin that moved. Returns an error message, or null.
  function resizeInstance(project, F, b, w, h) {
    const sh = F.sheet, defs = project.defs, def = defs[b.def];
    if (!def) return 'No such block.';
    w = w || def.fw; h = h || def.fh;
    if (![w, h].every((v) => Number.isInteger(v) && v >= 1 && v <= 40)) return 'Sizes are whole numbers of cells, 1 to 40.';
    if (G.portsOf(def, 'in').length && G.portsOf(def, 'out').length && w < 2) return 'A block with inputs and outputs needs to be at least 2 wide.';
    if (G.instanceRows(def, h) === false) return `At ${h} tall two of its pins would share a row; make it taller.`;
    const trial = Object.assign({}, b, { w: w === def.fw ? undefined : w, h: h === def.fh ? undefined : h });
    if (!G.canPlace(sh, defs, trial, b)) return 'No room for that size here; move it or what is beside it first.';
    const routes = G.routesOf(sh, defs);
    const was = new Map(sh.wires.flatMap((x) => [[x.id + '>from', G.pinOf(sh, defs, x.from)], [x.id + '>to', G.pinOf(sh, defs, x.to)]]));
    if (trial.w === undefined) delete b.w; else b.w = trial.w;
    if (trial.h === undefined) delete b.h; else b.h = trial.h;
    const occ = G.occupancy(sh, defs);
    for (const x of sh.wires) {
      const r = routes.get(x.id);
      for (const end of ['from', 'to']) {
        if (blockOf(x[end]) !== b.id || !r) continue;
        const p0 = was.get(x.id + '>' + end), p1 = G.pinOf(sh, defs, x[end]);
        if (!p0 || !p1 || (p0.x === p1.x && p0.y === p1.y)) continue;
        G.reattach(sh, defs, x, r, end, (c) => (c[0] === p0.x && c[1] === p0.y) || (() => { const o = occ.get(k2(c[0], c[1])); return !!(o && o.block === b); })());
      }
    }
    return null;
  }

  // ---- resizing a block ----------------------------------------------------------------
  // A definition's footprint (fw × fh cells, what the boards around it see) and its
  // inside (iw × ih fine cells, its own board) are set separately: the inside is
  // drawn scaled into the footprint. Every instance changes size in place, keeping
  // its top-left corner; wires keep their traces and only re-route the last stretch
  // to a pin that moved. Returns an error message, or null when done.
  function resizeDef(project, name, size) {
    const defs = project.defs, def = defs[name];
    if (!def) return 'No such block.';
    const cur = G.inner(def);
    const fw = size.fw !== undefined ? size.fw : def.fw, fh = size.fh !== undefined ? size.fh : def.fh;
    const iw = size.iw !== undefined ? size.iw : cur.w, ih = size.ih !== undefined ? size.ih : cur.h;
    if (![fw, fh, iw, ih].every((v) => Number.isInteger(v) && v >= 1)) return 'Sizes are whole numbers of cells, at least 1.';
    if (fw > 40 || fh > 40 || iw > 400 || ih > 400) return 'That is bigger than a block can be.';
    const ins = G.portsOf(def, 'in'), outs = G.portsOf(def, 'out');
    if (ins.length && outs.length && fw < 2) return 'A block with inputs and outputs needs to be at least 2 wide.';
    const low = def.ports.find((p) => p.row >= fh);
    if (low) return `Port "${low.name}" is on row ${low.row}; move it up before making the block ${fh} tall.`;
    if (ih < fh) return `The inside needs at least one fine row per pin row (${fh}).`;
    // the inside must still hold everything drawn on it
    let mx = 0, my = 0;
    for (const b of def.blocks) { const fp = G.footprint(b, defs); mx = Math.max(mx, b.x + fp.w); my = Math.max(my, b.y + fp.h); }
    for (const w of def.wires) for (const [x, y] of w.path || []) { mx = Math.max(mx, x + 1); my = Math.max(my, y + 1); }
    if (iw < mx || ih < my) return `The inside has things out to ${mx}×${my}; it can't be smaller than that.`;
    // every instance must have room to grow where it is
    const homes = [project.root, ...Object.values(defs)].filter((sh) => sh && sh !== def && sh.blocks.some((b) => b.type === 'comp' && b.def === name));
    const trial = Object.assign({}, def, { fw, fh });
    const trialDefs = Object.assign({}, defs, { [name]: trial });
    for (const sh of homes) {
      for (const b of sh.blocks) if (b.type === 'comp' && b.def === name && !G.canPlace(sh, trialDefs, b)) {
        return `${name} ${b.id}${sh === project.root ? '' : ' (in ' + sh.name + ')'} has no room to grow there; move it or what is beside it first.`;
      }
    }
    // pins before, then apply
    const before = (sh) => G.routesOf(sh, defs);
    const pinsNow = (sh, which) => new Map(sh.wires.flatMap((w) => [[w.id + '>from', G.pinOf(sh, defs, w.from)], [w.id + '>to', G.pinOf(sh, defs, w.to)]]).filter(([, p]) => p && which(p)));
    const saved = homes.map((sh) => ({ sh, routes: before(sh), pins: pinsNow(sh, () => true) }));
    const inside = { routes: before(def), pins: pinsNow(def, () => true) };
    Object.assign(def, { fw, fh, iw, ih });
    if (iw === fw * def.s && ih === fh * def.s) { delete def.iw; delete def.ih; }
    const mend = (sh, routes, oldPins, inBlock) => {
      for (const w of sh.wires) {
        const r = routes.get(w.id);
        for (const end of ['from', 'to']) {
          const was = oldPins.get(w.id + '>' + end), now = G.pinOf(sh, defs, w[end]);
          if (!was || !now || (was.x === now.x && was.y === now.y) || !r) continue;
          const oldPin = (c) => c[0] === was.x && c[1] === was.y;
          G.reattach(sh, defs, w, r, end, (c) => oldPin(c) || inBlock(w[end], c));
        }
      }
    };
    for (const { sh, routes, pins } of saved) {
      const occ = G.occupancy(sh, defs);
      mend(sh, routes, pins, (e, c) => { const o = occ.get(k2(c[0], c[1])); return !!(o && o.block && o.block.id === blockOf(e)); });
    }
    mend(def, inside.routes, inside.pins, () => false);
    return null;
  }
  // A move computed from the board as it was when the drag started (`snap`), so
  // dragging back and forth is exact.
  const snapshot = (sh) => JSON.parse(JSON.stringify({ blocks: sh.blocks, wires: sh.wires, nextId: sh.nextId }));
  function restore(sh, snap) { Object.assign(sh, JSON.parse(JSON.stringify(snap))); }
  function rubberMove(project, F, sel, snap, dx, dy) {
    restore(F.sheet, snap);
    const out = move(project, F, sel, dx, dy);
    if (!out) { restore(F.sheet, snap); return null; }
    return { sel: out };
  }

  // ---- reshaping a trace ------------------------------------------------------------
  // Drag the straight run of a wire's trace through cell `at` sideways by `d` cells.
  // The run's ends stretch to stay connected; every wire of the same net that runs
  // along the same cells moves with it, so a shared trunk stays shared. The pins
  // at either end never move. Returns the number of wires changed.
  function dragRun(sheet, defs, wireId, at, d, routes) {
    routes = routes || G.routesOf(sheet, defs);
    const w = sheet.wires.find((x) => x.id === wireId), P = w && routes.get(wireId);
    if (!P || !d) return 0;
    const i = P.findIndex((c) => c[0] === at[0] && c[1] === at[1]);
    if (i < 0) return 0;
    // where the net branches: those cells stay put, like the pins
    const nbrs = new Map();
    for (const v of sheet.wires) {
      if (v.from !== w.from || !routes.get(v.id)) continue;
      const Q = routes.get(v.id);
      for (let j = 1; j < Q.length; j++) {
        const u = k2(Q[j - 1][0], Q[j - 1][1]), t = k2(Q[j][0], Q[j][1]);
        if (!nbrs.has(u)) nbrs.set(u, new Set()); if (!nbrs.has(t)) nbrs.set(t, new Set());
        nbrs.get(u).add(t); nbrs.get(t).add(u);
      }
    }
    const junction = (j) => (nbrs.get(k2(P[j][0], P[j][1])) || new Set()).size >= 3;
    const same = (j, axis) => j >= 0 && j < P.length && P[j][axis] === P[i][axis];
    // the coordinate shared along the run (and changed by d): y for a horizontal run
    const axis = same(i - 1, 1) || same(i + 1, 1) ? 1 : 0;
    let a = i, b = i;
    while (same(a - 1, axis) && !junction(a - 1)) a--;
    while (same(b + 1, axis) && !junction(b + 1)) b++;
    a = Math.max(a, 1); b = Math.min(b, P.length - 2);   // the pins stay where they are
    if (a > b || junction(i)) return 0;
    const run = P.slice(a, b + 1).map(([x, y]) => k2(x, y)), changed = [];
    const shift = ([x, y]) => (axis === 1 ? [x, y + d] : [x + d, y]);
    // straight steps from one cell to another: across the run's direction first
    const link = (from, to) => {
      const out = [];
      let [x, y] = from;
      while (x !== to[0] || y !== to[1]) {
        if (axis === 1 ? y !== to[1] : x === to[0]) y += Math.sign(to[1] - y); else x += Math.sign(to[0] - x);
        out.push([x, y]);
      }
      return out;
    };
    for (const v of sheet.wires) {
      if (v.from !== w.from) continue;
      const Q = routes.get(v.id);
      if (!Q) continue;
      const s = Q.findIndex((c) => k2(c[0], c[1]) === run[0]);
      if (s < 1 || s + run.length > Q.length - 1 || !run.every((c, j) => k2(Q[s + j][0], Q[s + j][1]) === c)) continue;
      const moved = Q.slice(s, s + run.length).map(shift), before = Q.slice(0, s), after = Q.slice(s + run.length);
      const path = before.concat(link(before[before.length - 1], moved[0]).slice(0, -1), moved,
        link(moved[moved.length - 1], after[0]).slice(0, -1), after);
      changed.push([v, G.tidy(path)]);
    }
    for (const [v, path] of changed) v.path = path;
    return changed.length;
  }

  // ---- undo history ------------------------------------------------------------------
  // Snapshots of the whole project (JSON), one per user gesture. Nothing is
  // recorded unless the project actually changed.
  class History {
    constructor(limit) { this.limit = limit || 200; this.stack = []; this.i = -1; }
    reset(state) { this.stack = [{ state, label: '' }]; this.i = 0; }
    record(state, label) {
      if (this.i >= 0 && this.stack[this.i].state === state) return false;
      this.stack.length = this.i + 1;
      this.stack.push({ state, label: label || 'edit' });
      if (this.stack.length > this.limit) this.stack.shift();
      this.i = this.stack.length - 1;
      return true;
    }
    get canUndo() { return this.i > 0; }
    get canRedo() { return this.i < this.stack.length - 1; }
    get undoLabel() { return this.canUndo ? this.stack[this.i].label : ''; }
    get redoLabel() { return this.canRedo ? this.stack[this.i + 1].label : ''; }
    undo() { if (!this.canUndo) return null; const label = this.stack[this.i].label; this.i--; return { state: this.stack[this.i].state, label }; }
    redo() { if (!this.canRedo) return null; this.i++; return { state: this.stack[this.i].state, label: this.stack[this.i].label }; }
  }

  const api = { Editor: { emptySelection, isEmpty, count, wiresAtCell, netAt, selectRect, selectAll, bounds, wiresAmong, copy, pasteProblem, paste, remove, move, rubberMove, dragRun, resizeDef, resizeInstance, portChange, snapshot, History } };
  if (typeof module === 'object' && module.exports) module.exports = api.Editor;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
