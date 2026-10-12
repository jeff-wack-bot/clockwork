// Editing operations, without the DOM: selection, clipboard, move, delete and
// undo history. The app (app.js) turns pointer and key events into these calls;
// tests/editor.test.js drives them directly.
//
// A frame F is { sheet, path, def }: the board being edited, the path prefix of
// its nets ('' at the root, 'b3/' inside block b3), and the definition when the
// board is the inside of a composite block.
// A selection is { F, blocks: Set(block id), cells: Set('top:x,y'), region }:
// whole blocks plus individual trace cells on either layer. `region` is the net
// shown in the inspector when a trace was clicked.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;
  const LAYERS = [G.TOP, G.BOT];
  const ck = (l, x, y) => l + ':' + x + ',' + y;
  const unck = (c) => { const [l, k] = c.split(':'); const [x, y] = G.unkey(k); return [l, x, y]; };

  function emptySelection(F) { return { F, blocks: new Set(), cells: new Set(), region: null }; }
  const isEmpty = (sel) => !sel || (sel.blocks.size === 0 && sel.cells.size === 0);
  const count = (sel) => (sel ? sel.blocks.size + sel.cells.size : 0);

  // ---- picking -------------------------------------------------------------------
  // The track under a cell: the chain of trace cells between junctions, pins and vias.
  function trackAt(sheet, defs, layer, x, y) {
    const rid = sheet[layer][G.key(x, y)];
    if (!rid) return [];
    const occ = G.occupancy(sheet, defs);
    const nbrs = (cx, cy) => [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]].filter(([a, b]) => sheet[layer][G.key(a, b)] === rid);
    const node = (cx, cy) => { const k = G.key(cx, cy); return occ.has(k) || (sheet.top[k] && sheet.top[k] === sheet.bot[k]) || nbrs(cx, cy).length > 2; };
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

  // Everything inside a rectangle of cells (inclusive): blocks whose whole
  // footprint is inside, and every trace cell inside on both layers.
  function selectRect(F, defs, r, base) {
    const sel = base || emptySelection(F);
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    for (const b of F.sheet.blocks) {
      const fp = G.footprint(b, defs);
      if (b.x >= x0 && b.y >= y0 && b.x + fp.w - 1 <= x1 && b.y + fp.h - 1 <= y1) sel.blocks.add(b.id);
    }
    for (const l of LAYERS) for (const k in F.sheet[l]) {
      const [x, y] = G.unkey(k);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) sel.cells.add(ck(l, x, y));
    }
    return sel;
  }
  function selectAll(F, defs) {
    const sel = emptySelection(F);
    for (const b of F.sheet.blocks) sel.blocks.add(b.id);
    for (const l of LAYERS) for (const k in F.sheet[l]) sel.cells.add(l + ':' + k);
    return sel;
  }
  // Bounding box of a selection, in cells (inclusive).
  function bounds(F, defs, sel) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w - 1); y1 = Math.max(y1, y + h - 1); };
    for (const b of F.sheet.blocks) if (sel.blocks.has(b.id)) { const fp = G.footprint(b, defs); grow(b.x, b.y, fp.w, fp.h); }
    for (const c of sel.cells) { const [, x, y] = unck(c); grow(x, y, 1, 1); }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  // ---- clipboard -------------------------------------------------------------------
  // A clip is position-independent: blocks and cells relative to the selection's
  // top-left corner, the nets' constants and knobs, and per-instance knob values
  // of copied composite blocks.
  function copy(project, F, sel) {
    const defs = project.defs, bb = bounds(F, defs, sel);
    if (!bb) return null;
    const clip = { kind: 'samplefactory.clip', w: bb.x1 - bb.x0 + 1, h: bb.y1 - bb.y0 + 1, blocks: [], cells: [], regions: {}, values: {} };
    for (const b of F.sheet.blocks) {
      if (!sel.blocks.has(b.id)) continue;
      const c = JSON.parse(JSON.stringify(b));
      c.x -= bb.x0; c.y -= bb.y0;
      clip.blocks.push(c);
      const prefix = F.path + b.id + '/';
      for (const k in project.values) if (k.startsWith(prefix)) clip.values[b.id + '/' + k.slice(prefix.length)] = project.values[k];
    }
    for (const c of sel.cells) {
      const [l, x, y] = unck(c), rid = F.sheet[l][G.key(x, y)];
      if (!rid) continue;
      clip.cells.push([l, x - bb.x0, y - bb.y0, rid]);
      if (!clip.regions[rid]) {
        const reg = F.sheet.regions[rid], ov = project.values[F.path + rid];
        clip.regions[rid] = { value: F.path && ov !== undefined ? ov : reg.value };
      }
    }
    // a knob travels with its net if its cell was copied
    for (const rid in clip.regions) {
      const kb = F.sheet.regions[rid].knob;
      if (!kb) continue;
      const inside = clip.cells.some(([, x, y, r]) => r === rid && x === kb.x - bb.x0 && y === kb.y - bb.y0);
      if (inside) clip.regions[rid].knob = Object.assign({}, kb, { x: kb.x - bb.x0, y: kb.y - bb.y0 });
    }
    return clip;
  }

  // Can the clip go down with its top-left corner at (ax, ay)? Returns null if so,
  // else a reason.
  function pasteProblem(project, F, clip, ax, ay) {
    const defs = project.defs, sh = F.sheet;
    if (F.def) {
      for (const b of clip.blocks) {
        if (b.type === 'comp' && (b.def === F.def.name || G.uses(defs, b.def, F.def.name))) return `"${b.def}" can't go inside itself.`;
      }
    }
    for (const b of clip.blocks) if (b.type === 'comp' && !defs[b.def]) return `This board has no "${b.def}" block.`;
    const trial = { ...sh, blocks: sh.blocks.slice() };
    for (const b of clip.blocks) {
      const nb = Object.assign({}, b, { id: '__paste' + trial.blocks.length, x: b.x + ax, y: b.y + ay });
      if (!G.canPlace(trial, defs, nb)) return 'No room for the blocks here.';
      trial.blocks.push(nb);
    }
    const occ = G.occupancy(trial, defs);
    for (const [l, dx, dy] of clip.cells) {
      const x = dx + ax, y = dy + ay, k = G.key(x, y);
      if (!G.inBounds(sh, x, y)) return 'That would run off the board.';
      if (sh[l][k]) return 'The traces would cross other traces.';
      if (l === G.TOP) { const o = occ.get(k); if (o && !o.pad) return 'The traces would run over a block.'; }
    }
    return null;
  }

  function paste(project, F, clip, ax, ay) {
    const why = pasteProblem(project, F, clip, ax, ay);
    if (why) return { error: why };
    const sh = F.sheet, sel = emptySelection(F), ids = {};
    for (const b of clip.blocks) {
      const nb = Object.assign(JSON.parse(JSON.stringify(b)), { id: 'b' + sh.nextId++, x: b.x + ax, y: b.y + ay });
      ids[b.id] = nb.id;
      sh.blocks.push(nb);
      sel.blocks.add(nb.id);
    }
    for (const k in clip.values) {
      const i = k.indexOf('/'), id = ids[k.slice(0, i)];
      if (id) project.values[F.path + id + k.slice(i)] = clip.values[k];
    }
    const rids = {};
    for (const rid in clip.regions) {
      const r = clip.regions[rid];
      const props = { value: r.value };
      if (r.knob) props.knob = Object.assign({}, r.knob, { x: r.knob.x + ax, y: r.knob.y + ay });
      rids[rid] = G.newRegion(sh, props);
    }
    for (const [l, dx, dy, rid] of clip.cells) {
      sh[l][G.key(dx + ax, dy + ay)] = rids[rid];
      sel.cells.add(ck(l, dx + ax, dy + ay));
    }
    for (const rid in rids) G.split(sh, rids[rid]);   // a partial copy may fall apart
    return { sel };
  }

  // ---- delete and move ---------------------------------------------------------------
  function remove(project, F, sel) {
    const sh = F.sheet, touched = new Set();
    for (const id of sel.blocks) {
      const prefix = F.path + id + '/';
      for (const k of Object.keys(project.values)) if (k.startsWith(prefix)) delete project.values[k];
    }
    sh.blocks = sh.blocks.filter((b) => !sel.blocks.has(b.id));
    for (const c of sel.cells) {
      const [l, x, y] = unck(c), k = G.key(x, y), rid = sh[l][k];
      if (!rid) continue;
      delete sh[l][k];
      touched.add(rid);
      const reg = sh.regions[rid];
      if (reg && reg.knob && reg.knob.x === x && reg.knob.y === y && sh.top[k] !== rid && sh.bot[k] !== rid) delete reg.knob;
    }
    for (const rid of touched) G.split(sh, rid);
    return emptySelection(F);
  }

  // Move a selection by (dx, dy) cells. All or nothing: returns the moved
  // selection, or null if anything would collide. A pin may not land on a net
  // other than its own. With opts.trim (a set of net ids), moved blocks may sit on
  // those nets' traces: the cells under them are cut away.
  function move(project, F, sel, dx, dy, opts) {
    if (!dx && !dy) return sel;
    const trim = (opts && opts.trim) || new Set();
    const defs = project.defs, sh = F.sheet;
    // the board as it would be: moving cells lifted and put down again
    const top = Object.assign({}, sh.top), bot = Object.assign({}, sh.bot), layer = { top, bot };
    const lifted = [];
    for (const c of sel.cells) {
      const [l, x, y] = unck(c), k = G.key(x, y);
      if (!sh[l][k]) continue;
      lifted.push([l, x, y, sh[l][k]]);
      delete layer[l][k];
    }
    for (const [l, x, y, rid] of lifted) {
      const k = G.key(x + dx, y + dy);
      if (!G.inBounds(sh, x + dx, y + dy) || layer[l][k]) return null;
      layer[l][k] = rid;
    }
    const blocks = sh.blocks.map((b) => (sel.blocks.has(b.id) ? Object.assign({}, b, { x: b.x + dx, y: b.y + dy }) : b));
    const moving = new Set(lifted.map(([l, x, y]) => l + ':' + G.key(x + dx, y + dy)));
    const cutCells = [];
    for (const b of blocks) {
      if (!sel.blocks.has(b.id)) continue;
      const fp = G.footprint(b, defs), pads = new Map(fp.pads.map((q) => [G.key(q.x, q.y), q]));
      for (let yy = 0; yy < fp.h; yy++) for (let xx = 0; xx < fp.w; xx++) {
        const k = G.key(b.x + xx, b.y + yy), rid = top[k];
        if (!rid || moving.has(G.TOP + ':' + k)) continue;
        if (pads.has(k)) {
          // a pin may only land on its own net (whose id it carried before the move)
          const orig = sh.blocks.find((q) => q.id === b.id), was = G.footprint(orig, defs).pads.find((q) => q.dir === pads.get(k).dir && q.idx === pads.get(k).idx);
          if (sh.top[G.key(was.x, was.y)] === rid) continue;
          if (!trim.has(rid)) return null;
          delete top[k]; cutCells.push([b.x + xx, b.y + yy, rid]);       // another of the dragged blocks' nets: cut it here
        } else if (trim.has(rid)) { delete top[k]; cutCells.push([b.x + xx, b.y + yy, rid]); }
      }
    }
    const trial = { ...sh, top, bot, blocks };
    for (const b of blocks) if (sel.blocks.has(b.id) && !G.canPlace(trial, defs, b)) return null;
    const occ = G.occupancy(trial, defs);
    for (const [l, x, y] of lifted) {
      if (l !== G.TOP) continue;
      const o = occ.get(G.key(x + dx, y + dy));
      if (o && !o.pad) return null;
    }
    // commit
    sh.top = top; sh.bot = bot;
    for (const b of sh.blocks) if (sel.blocks.has(b.id)) { b.x += dx; b.y += dy; }
    const touched = new Set();
    for (const [l, x, y, rid] of lifted) {
      touched.add(rid);
      const kb = sh.regions[rid] && sh.regions[rid].knob;
      if (kb && kb.x === x && kb.y === y && !kb.moved) { kb.x += dx; kb.y += dy; kb.moved = true; }
    }
    for (const rid of touched) { const kb = sh.regions[rid] && sh.regions[rid].knob; if (kb) delete kb.moved; }
    for (const [x, y, rid] of cutCells) {
      touched.add(rid);
      const kb = sh.regions[rid] && sh.regions[rid].knob;
      if (kb && kb.x === x && kb.y === y) delete sh.regions[rid].knob;
    }
    for (const rid of touched) if (sh.regions[rid]) G.split(sh, rid);
    const out = emptySelection(F);
    sel.blocks.forEach((id) => out.blocks.add(id));
    for (const [l, x, y] of lifted) out.cells.add(ck(l, x + dx, y + dy));
    out.region = sel.region && sh.regions[sel.region] ? sel.region : null;
    return out;
  }

  // ---- rubber-band move ------------------------------------------------------------------
  // Moving blocks without their traces: the traces stay, and every pin whose trace
  // was left behind is routed back to its net. Always computed from the board as
  // it was when the drag started (`snap`), so dragging back and forth is exact.
  const snapshot = (sh) => JSON.parse(JSON.stringify({ top: sh.top, bot: sh.bot, regions: sh.regions, blocks: sh.blocks, nextId: sh.nextId }));
  function restore(sh, snap) { Object.assign(sh, snapshot(snap)); }
  function routeBox(sh, defs) {
    const b = G.bounds(sh);
    if (b) return b;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const blk of sh.blocks) { const fp = G.footprint(blk, defs); x0 = Math.min(x0, blk.x); y0 = Math.min(y0, blk.y); x1 = Math.max(x1, blk.x + fp.w); y1 = Math.max(y1, blk.y + fp.h); }
    for (const l of LAYERS) for (const k in sh[l]) { const [x, y] = G.unkey(k); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x0: x0 - 6, y0: y0 - 6, x1: x1 + 6, y1: y1 + 6 };
  }
  function rubberMove(project, F, sel, snap, dx, dy) {
    const sh = F.sheet, defs = project.defs;
    restore(sh, snap);
    if (!dx && !dy) return { sel, unconnected: [] };
    const attach = [];
    for (const b of sh.blocks) {
      if (!sel.blocks.has(b.id)) continue;
      for (const q of G.footprint(b, defs).pads) {
        const rid = sh.top[G.key(q.x, q.y)];
        if (rid && !sel.cells.has(ck(G.TOP, q.x, q.y))) attach.push({ id: b.id, dir: q.dir, idx: q.idx, rid });
      }
    }
    const out = move(project, F, sel, dx, dy, { trim: new Set(attach.map((a) => a.rid)) });
    if (!out) { restore(sh, snap); return null; }
    // Reconnect each pin to the rest of its net. The pin may be on empty board, or on
    // a fragment of its own net that the move cut off from the rest.
    const box = routeBox(sh, defs), unconnected = [];
    for (const a of attach) {
      if (!sh.regions[a.rid]) { unconnected.push(a); continue; }
      const b = sh.blocks.find((x) => x.id === a.id), q = G.footprint(b, defs).pads.find((p) => p.dir === a.dir && p.idx === a.idx);
      const k = G.key(q.x, q.y), here = sh.top[k];
      if (here && here !== a.rid) {
        if (snap.regions[here]) { unconnected.push(a); continue; }      // someone else's net (cannot happen: move refuses it)
        G.merge(sh, a.rid, here);
      }
      // cells of the net not connected to the pin
      const cells = G.cellsOf(sh, a.rid), set = new Set(cells.map(([l, x, y]) => l + ':' + G.key(x, y)));
      const reach = new Set(), queue = sh.top[k] === a.rid ? [[G.TOP, q.x, q.y]] : [];
      queue.forEach(([l, x, y]) => reach.add(l + ':' + G.key(x, y)));
      for (let i = 0; i < queue.length; i++) {
        const [l, x, y] = queue[i];
        for (const [nl, nx, ny] of [[l, x + 1, y], [l, x - 1, y], [l, x, y + 1], [l, x, y - 1], [l === G.TOP ? G.BOT : G.TOP, x, y]]) {
          const c = nl + ':' + G.key(nx, ny);
          if (set.has(c) && !reach.has(c)) { reach.add(c); queue.push([nl, nx, ny]); }
        }
      }
      const rest = cells.filter(([l, x, y]) => !reach.has(l + ':' + G.key(x, y)));
      if (!rest.length) continue;
      try { G.route(sh, defs, a.rid, rest, q, box); } catch (e) { unconnected.push(a); }
    }
    // scraps of trace cut off by the move, touching no pin and holding no knob, go
    const occ = G.occupancy(sh, defs);
    for (const rid of Object.keys(sh.regions)) {
      if (snap.regions[rid] || sh.regions[rid].knob) continue;
      if (!G.cellsOf(sh, rid).some(([l, x, y]) => l === G.TOP && occ.has(G.key(x, y)) && occ.get(G.key(x, y)).pad)) G.removeRegion(sh, rid);
    }
    return { sel: out, unconnected };
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

  const api = { Editor: { emptySelection, isEmpty, count, trackAt, selectRect, selectAll, bounds, copy, pasteProblem, paste, remove, move, rubberMove, snapshot, History, ck, unck } };
  if (typeof module === 'object' && module.exports) module.exports = api.Editor;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
