// Grid model: sheets of cells, regions (registers), blocks (chips) and pads.
(function (root) {
  'use strict';

  const FS = 48000;
  const TOP = 'top', BOT = 'bot';
  const key = (x, y) => x + ',' + y;
  const unkey = (k) => k.split(',').map(Number);

  // Pads are [x, y, name] in the block's unrotated local frame.
  const ATOMS = {
    add: { title: 'Add', sym: '+', w: 3, h: 3, ins: [[0, 0, 'a'], [0, 2, 'b']], outs: [[2, 1, '']], cost: 'adder',
      eq: 'y = a + b', expr: (a) => `${a[0]} + ${a[1]}` },
    mul: { title: 'Multiply', sym: '×', w: 3, h: 3, ins: [[0, 0, 'a'], [0, 2, 'b']], outs: [[2, 1, '']], cost: 'multiplier',
      eq: 'y = a × b', expr: (a) => `${a[0]} * ${a[1]}` },
    gt: { title: 'Greater than', sym: '>', w: 3, h: 3, ins: [[0, 0, 'a'], [0, 2, 'b']], outs: [[2, 1, '']], cost: 'comparator',
      eq: 'y = (a > b) ? 1 : 0', expr: (a) => `(${a[0]} > ${a[1]} ? 1 : 0)` },
    switch: { title: 'Switch', sym: '?:', w: 3, h: 3, ins: [[0, 1, 'if'], [0, 0, 'then'], [0, 2, 'else']], outs: [[2, 1, '']], cost: 'mux',
      eq: 'y = (if > 0) ? then : else', expr: (a) => `(${a[0]} > 0 ? ${a[1]} : ${a[2]})` },
    delay: { title: 'Delay (flip-flop)', sym: 'z⁻¹', w: 3, h: 1, ins: [[0, 0, '']], outs: [[2, 0, '']], cost: 'buffer',
      eq: 'y[n] = x[n−1]', expr: (a) => a[0] },
  };
  const SINKS = {
    dac: { title: 'DAC', sym: '🔊', w: 3, h: 3, ins: [[0, 1, '']], outs: [], eq: 'speaker = clip(x, −1, 1)' },
    scope: { title: 'Scope', sym: '∿', w: 10, h: 5, ins: [[0, 2, '']], outs: [], eq: '(display only)' },
  };
  const DOCS = {
    add: 'Logic: its output net carries the sum of its inputs, settled within the same tick.',
    mul: 'Logic: its output net carries the product of its inputs, within the same tick.',
    gt: 'Logic: outputs 1 if a > b, else 0.',
    switch: 'Logic, a multiplexer: passes "then" if "if" > 0, else "else".',
    delay: 'A flip-flop: the only IC with memory. Its output net is a register that takes the input\'s value at each clock edge. Every feedback loop needs one.',
    dac: 'Sends the net on its pin to the speakers. Between ticks the speaker holds the last value.',
    scope: 'Plots the net on its pin over time. No effect on the computation.',
  };
  const ATOM_ORDER = ['add', 'mul', 'gt', 'switch', 'delay'];
  const SINK_ORDER = ['dac', 'scope'];
  const info = (type) => ATOMS[type] || SINKS[type] || null;

  // ---- sheets --------------------------------------------------------------
  function makeSheet(extra) {
    return Object.assign({ top: {}, bot: {}, regions: {}, blocks: [], nextId: 1 }, extra || {});
  }
  function makeDef(name, fw, fh, s, ports, description) {
    return makeSheet({ name, fw, fh, s: s || 8, ports: ports || [], description: description || '' });
  }
  const isDef = (sheet) => sheet.fw !== undefined;
  const bounds = (sheet) => (isDef(sheet) ? { x0: 0, y0: 0, x1: sheet.fw * sheet.s - 1, y1: sheet.fh * sheet.s - 1 } : null);
  function inBounds(sheet, x, y) {
    const b = bounds(sheet);
    return !b || (x >= b.x0 && y >= b.y0 && x <= b.x1 && y <= b.y1);
  }
  const portsOf = (def, dir) => def.ports.filter((p) => p.dir === dir).sort((a, b) => a.row - b.row);
  // Where a definition's port pads sit on its own inner grid.
  function innerPads(def) {
    const mid = Math.floor(def.s / 2);
    return [
      ...portsOf(def, 'in').map((p, i) => ({ x: 0, y: p.row * def.s + mid, dir: 'in', idx: i, name: p.name })),
      ...portsOf(def, 'out').map((p, i) => ({ x: def.fw * def.s - 1, y: p.row * def.s + mid, dir: 'out', idx: i, name: p.name })),
    ];
  }

  // ---- footprints ----------------------------------------------------------
  function rotate(x, y, w, h, rot) {
    switch (rot & 3) {
      case 1: return [h - 1 - y, x];
      case 2: return [w - 1 - x, h - 1 - y];
      case 3: return [y, w - 1 - x];
      default: return [x, y];
    }
  }
  function footprint(b, defs) {
    if (b.type === 'comp') {
      const def = defs[b.def];
      if (!def) return { w: 2, h: 2, pads: [] };
      return {
        w: def.fw, h: def.fh,
        pads: [
          ...portsOf(def, 'in').map((p, i) => ({ x: b.x, y: b.y + p.row, dir: 'in', idx: i, name: p.name })),
          ...portsOf(def, 'out').map((p, i) => ({ x: b.x + def.fw - 1, y: b.y + p.row, dir: 'out', idx: i, name: p.name })),
        ],
      };
    }
    const t = info(b.type), rot = b.rot || 0;
    const odd = rot & 1;
    const pad = (dir) => (p, i) => {
      const [px, py] = rotate(p[0], p[1], t.w, t.h, rot);
      return { x: b.x + px, y: b.y + py, dir, idx: i, name: p[2] };
    };
    return { w: odd ? t.h : t.w, h: odd ? t.w : t.h, pads: [...t.ins.map(pad('in')), ...t.outs.map(pad('out'))] };
  }

  // Map of top-layer cells covered by blocks: key -> {block, pad|null}.
  function occupancy(sheet, defs) {
    const occ = new Map();
    for (const b of sheet.blocks) {
      const fp = footprint(b, defs);
      for (let y = 0; y < fp.h; y++) for (let x = 0; x < fp.w; x++) occ.set(key(b.x + x, b.y + y), { block: b, pad: null });
      for (const p of fp.pads) occ.set(key(p.x, p.y), { block: b, pad: p });
    }
    if (isDef(sheet)) for (const p of innerPads(sheet)) occ.set(key(p.x, p.y), { block: null, pad: p, port: true });
    return occ;
  }

  // ---- regions -------------------------------------------------------------
  function newRegion(sheet, props) {
    const id = 'r' + sheet.nextId++;
    sheet.regions[id] = Object.assign({ value: 0 }, props || {});
    return id;
  }
  function cellsOf(sheet, rid) {
    const out = [];
    for (const layer of [TOP, BOT]) for (const k in sheet[layer]) if (sheet[layer][k] === rid) out.push([layer, ...unkey(k)]);
    return out;
  }
  function canPaint(sheet, occ, layer, x, y) {
    if (!inBounds(sheet, x, y)) return false;
    if (layer === TOP) { const o = occ.get(key(x, y)); if (o && !o.pad) return false; }
    return true;
  }
  function merge(sheet, keep, gone) {
    if (keep === gone) return;
    for (const layer of [TOP, BOT]) for (const k in sheet[layer]) if (sheet[layer][k] === gone) sheet[layer][k] = keep;
    const a = sheet.regions[keep], b = sheet.regions[gone];
    if (b && b.knob && !a.knob) { a.knob = b.knob; a.value = b.value; }
    delete sheet.regions[gone];
  }
  // Paint one cell into region rid. Returns 'ok', 'merged' or 'blocked'.
  function paint(sheet, occ, layer, x, y, rid) {
    const k = key(x, y), cur = sheet[layer][k];
    if (cur === rid) return 'ok';
    if (!canPaint(sheet, occ, layer, x, y)) return 'blocked';
    if (cur) { merge(sheet, rid, cur); return 'merged'; }
    sheet[layer][k] = rid;
    return 'ok';
  }
  // Split a region into its connected components (4-neighbours per layer, vias across).
  function split(sheet, rid) {
    const cells = new Set(cellsOf(sheet, rid).map(([l, x, y]) => l + ':' + key(x, y)));
    if (!cells.size) { delete sheet.regions[rid]; return [rid]; }
    const comps = [];
    while (cells.size) {
      const start = cells.values().next().value;
      const comp = [start]; cells.delete(start);
      for (let i = 0; i < comp.length; i++) {
        const [l, k] = comp[i].split(':'); const [x, y] = unkey(k);
        const nb = [[l, x + 1, y], [l, x - 1, y], [l, x, y + 1], [l, x, y - 1], [l === TOP ? BOT : TOP, x, y]];
        for (const [nl, nx, ny] of nb) {
          const c = nl + ':' + key(nx, ny);
          if (cells.has(c)) { cells.delete(c); comp.push(c); }
        }
      }
      comps.push(comp);
    }
    if (comps.length === 1) return [rid];
    const reg = sheet.regions[rid];
    const knobCell = reg.knob ? key(reg.knob.x, reg.knob.y) : null;
    let main = comps.findIndex((c) => knobCell && c.some((s) => s.endsWith(':' + knobCell)));
    if (main < 0) main = comps.reduce((bi, c, i) => (c.length > comps[bi].length ? i : bi), 0);
    const ids = [rid];
    comps.forEach((comp, i) => {
      if (i === main) return;
      const nid = newRegion(sheet, { value: reg.value });
      ids.push(nid);
      for (const c of comp) { const [l, k] = c.split(':'); sheet[l][k] = nid; }
    });
    return ids;
  }
  function erase(sheet, layer, x, y) {
    const k = key(x, y), rid = sheet[layer][k];
    if (!rid) return false;
    delete sheet[layer][k];
    const reg = sheet.regions[rid];
    if (reg && reg.knob && reg.knob.x === x && reg.knob.y === y && !sheet.top[k] && !sheet.bot[k]) delete reg.knob;
    split(sheet, rid);
    return true;
  }
  function removeRegion(sheet, rid) {
    for (const layer of [TOP, BOT]) for (const k in sheet[layer]) if (sheet[layer][k] === rid) delete sheet[layer][k];
    delete sheet.regions[rid];
  }

  // ---- blocks --------------------------------------------------------------
  function canPlace(sheet, defs, b, ignore) {
    const fp = footprint(b, defs);
    const others = occupancy({ ...sheet, blocks: sheet.blocks.filter((q) => q !== ignore && q !== b) }, defs);
    const pads = new Set(fp.pads.map((p) => key(p.x, p.y)));
    for (let y = 0; y < fp.h; y++) {
      for (let x = 0; x < fp.w; x++) {
        const cx = b.x + x, cy = b.y + y, k = key(cx, cy);
        if (!inBounds(sheet, cx, cy) || others.has(k)) return false;
        if (sheet.top[k] && !pads.has(k)) return false;
      }
    }
    return true;
  }
  function addBlock(sheet, defs, props) {
    const b = Object.assign({ id: 'b' + sheet.nextId++, rot: 0 }, props);
    if (!canPlace(sheet, defs, b)) { sheet.nextId--; return null; }
    sheet.blocks.push(b);
    return b;
  }

  // Does definition `name` contain an instance of `target`, at any depth?
  function uses(defs, name, target, seen) {
    const d = defs[name];
    seen = seen || new Set();
    if (!d || seen.has(name)) return false;
    seen.add(name);
    return d.blocks.some((b) => b.type === 'comp' && (b.def === target || uses(defs, b.def, target, seen)));
  }

  // Minimal binary heap of [priority, value] pairs.
  function heap() {
    const a = [];
    return {
      get length() { return a.length; },
      push(item) {
        a.push(item);
        for (let i = a.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (a[p][0] <= a[i][0]) break;
          [a[p], a[i]] = [a[i], a[p]]; i = p;
        }
      },
      pop() {
        const top = a[0], last = a.pop();
        if (a.length) {
          a[0] = last;
          for (let i = 0; ;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < a.length && a[l][0] < a[m][0]) m = l;
            if (r < a.length && a[r][0] < a[m][0]) m = r;
            if (m === i) break;
            [a[m], a[i]] = [a[i], a[m]]; i = m;
          }
        }
        return top;
      },
    };
  }

  // ---- maze router (used to lay out the starter library) --------------------
  // Lee/Dijkstra over (layer, x, y). Paints the found path into `rid`.
  function route(sheet, defs, rid, from, to, box) {
    const occ = occupancy(sheet, defs);
    const target = key(to.x, to.y);
    const own = (l, k) => sheet[l][k] === rid;
    const free = (l, x, y) => {
      if (x < box.x0 || y < box.y0 || x > box.x1 || y > box.y1 || !inBounds(sheet, x, y)) return false;
      const k = key(x, y);
      if (sheet[l][k] && !own(l, k)) return false;
      if (l === TOP) { const o = occ.get(k); if (o && k !== target && !(o.pad && own(l, k))) return false; }
      return true;
    };
    const crowd = (l, x, y) => {
      let c = 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const k = key(nx, ny);
        if (k === target) continue;
        if (sheet[l][k] && !own(l, k)) c += 2;
        if (l === TOP && occ.has(k) && !own(l, k)) c += 1;
      }
      return c;
    };
    const dist = new Map(), prev = new Map();
    const frontier = heap();
    const push = (s, d, p) => { if (!dist.has(s) || d < dist.get(s)) { dist.set(s, d); prev.set(s, p); frontier.push([d, s]); } };
    for (const [l, x, y] of from) push(l + ':' + key(x, y), 0, null);
    let found = null;
    while (frontier.length) {
      const [d, s] = frontier.pop();
      if (d > dist.get(s)) continue;
      const [l, k] = s.split(':'); const [x, y] = unkey(k);
      if (l === TOP && k === target) { found = s; break; }
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (free(l, nx, ny)) push(l + ':' + key(nx, ny), d + 1 + crowd(l, nx, ny) + (own(l, key(nx, ny)) ? -0.5 : 0), s);
      }
      const ol = l === TOP ? BOT : TOP;
      if (free(TOP, x, y) && free(BOT, x, y) && !occ.has(k)) push(ol + ':' + k, d + 6, s);
    }
    if (!found) throw new Error(`route failed: ${JSON.stringify(from[0])} → ${to.x},${to.y}`);
    for (let s = found; s; s = prev.get(s)) {
      const [l, k] = s.split(':'); const [x, y] = unkey(k);
      if (paint(sheet, occ, l, x, y, rid) === 'blocked') throw new Error('route painted into a blocked cell ' + s);
    }
  }

  // Builder used by the library: place chips, then wire pads with the router.
  function builder(sheet, defs) {
    const ids = {};
    const api = {
      sheet,
      block(name, type, x, y, extra) {
        const b = addBlock(sheet, defs, Object.assign({ type, x, y }, extra || {}));
        if (!b) throw new Error('cannot place ' + name + ' at ' + x + ',' + y);
        ids[name] = b;
        return b;
      },
      pad(ref) { // 'name.in0', 'name.out1', or 'port.in0' / 'port.out0' for a definition's own pads
        const [name, p] = ref.split('.');
        const dir = p.startsWith('in') ? 'in' : 'out', idx = Number(p.replace(/\D/g, ''));
        const pads = name === 'port' ? innerPads(sheet) : footprint(ids[name], defs).pads;
        const pad = pads.find((q) => q.dir === dir && q.idx === idx);
        if (!pad) throw new Error('no pad ' + ref);
        return pad;
      },
      // Connect a source pad to any number of sink pads with one region.
      net(src, sinks, props) {
        const s = api.pad(src), occ = occupancy(sheet, defs);
        const rid = newRegion(sheet, props);
        paint(sheet, occ, TOP, s.x, s.y, rid);
        for (const t of [].concat(sinks)) {
          const d = api.pad(t);
          route(sheet, defs, rid, cellsOf(sheet, rid), d, api.box());
        }
        return rid;
      },
      // A constant: a short region growing from an input pad in direction dir.
      konst(padRef, dir, len, value, knob) {
        const p = api.pad(padRef), occ = occupancy(sheet, defs);
        const rid = newRegion(sheet, { value });
        const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
        for (let i = 0; i <= len; i++) {
          if (paint(sheet, occ, TOP, p.x + dx * i, p.y + dy * i, rid) === 'blocked') throw new Error('constant blocked at ' + padRef);
        }
        if (knob) sheet.regions[rid].knob = Object.assign({ x: p.x + dx * len, y: p.y + dy * len }, knob);
        return rid;
      },
      box() {
        const b = bounds(sheet);
        if (b) return b;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const blk of sheet.blocks) {
          const fp = footprint(blk, defs);
          x0 = Math.min(x0, blk.x); y0 = Math.min(y0, blk.y);
          x1 = Math.max(x1, blk.x + fp.w); y1 = Math.max(y1, blk.y + fp.h);
        }
        return { x0: x0 - 3, y0: y0 - 3, x1: x1 + 3, y1: y1 + 3 };
      },
    };
    return api;
  }

  const api = {
    FS, TOP, BOT, ATOMS, SINKS, DOCS, ATOM_ORDER, SINK_ORDER, info, key, unkey,
    makeSheet, makeDef, isDef, bounds, inBounds, portsOf, innerPads, footprint, occupancy,
    newRegion, cellsOf, canPaint, paint, merge, split, erase, removeRegion, canPlace, addBlock, uses, route, builder,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
