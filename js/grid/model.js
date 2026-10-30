// Board model: sheets with blocks (chips) and wires. A wire joins an output pin
// to an input pin, like a patch cable: an input takes one wire, an output feeds
// any number. A wire may carry a route, the cells its trace runs through; the
// route is only for drawing (as a PCB trace) and for curating layouts, never for
// connectivity. Layers and vias are chosen by the renderer (renderLayout).
(function (root) {
  'use strict';

  const FS = 48000;
  const TOP = 'top', BOT = 'bot';
  const key = (x, y) => x + ',' + y;
  const unkey = (k) => k.split(',').map(Number);

  // Every pin carries one of three kinds of signal: 'float' (numbers, drawn as
  // circuit-board traces), 'fixed' (words of bits, drawn as barcodes) and 'analog'
  // (voltages, drawn as patch cables). A wire joins two pins of the same domain;
  // converters (analog.js) cross between them.
  const DOMAINS = ['float', 'fixed', 'analog'];
  const CABLE_COLORS = ['#e8c547', '#e5603d', '#5ec8e5', '#7bd389', '#c77dff', '#f28ab2', '#f0f0f0'];
  // Pads are [x, y, name, domain?] in the block's unrotated local frame; a pad
  // without a domain has the block's (dom, float by default).
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
    exp2: { title: 'Power of two', sym: '2ˣ', w: 3, h: 1, ins: [[0, 0, 'x']], outs: [[2, 0, '']], cost: 'exp',
      eq: 'y = 2^x', expr: (a) => `Math.pow(2, ${a[0]})` },
    log2: { title: 'Logarithm (base 2)', sym: 'log₂', w: 3, h: 1, ins: [[0, 0, 'x']], outs: [[2, 0, '']], cost: 'exp',
      eq: 'y = log₂ x  (x ≤ 0 reads as 10⁻³⁰⁰)', expr: (a) => `Math.log2(Math.max(1e-300, ${a[0]}))` },
    // a ROM: the curve through the block's points, straight between them, flat beyond the ends (compiler.js)
    table: { title: 'Table', sym: '⌇', w: 4, h: 3, ins: [[0, 1, 'x']], outs: [[3, 1, '']], cost: 'rom',
      eq: 'y = the curve through its points at x' },
  };
  // Fixed point: logic gates on words. Every gate works on all the bits of its
  // bus at once; a bus is as wide as what drives it (gates: their widest input).
  // m is the mask of the output's width.
  const g2 = (title, sym, op, invert) => ({ title, sym, w: 3, h: 3, dom: 'fixed', ins: [[0, 0, 'a'], [0, 2, 'b']], outs: [[2, 1, '']],
    eq: `y = ${invert ? '¬(' : ''}a ${sym} b${invert ? ')' : ''}`, expr: (a, m) => invert ? `(~(${a[0]} ${op} ${a[1]}) & ${m}) >>> 0` : `((${a[0]} ${op} ${a[1]}) & ${m}) >>> 0` });
  const GATES = {
    and: g2('AND', '∧', '&'), or: g2('OR', '∨', '|'), xor: g2('XOR', '⊕', '^'),
    nand: g2('NAND', '∧', '&', true), nor: g2('NOR', '∨', '|', true), xnor: g2('XNOR', '⊕', '^', true),
    not: { title: 'NOT', sym: '¬', w: 3, h: 1, dom: 'fixed', ins: [[0, 0, '']], outs: [[2, 0, '']], eq: 'y = ¬a', expr: (a, m) => `(~${a[0]} & ${m}) >>> 0` },
    dff: { title: 'D flip-flop', sym: 'D', w: 3, h: 3, dom: 'fixed', ins: [[0, 0, 'D']], outs: [[2, 0, 'Q'], [2, 2, 'Q̄']], eq: 'Q[n] = D[n−1], Q̄ = ¬Q' },
    // variable footprints (see footprint): a bus split into fields, and fields joined into a bus
    split: { title: 'Split', sym: '⟨', w: 2, h: 1, dom: 'fixed', ins: [[0, 0, '']], outs: [], eq: 'fields of a bus, low bits first' },
    join: { title: 'Join', sym: '⟩', w: 2, h: 1, dom: 'fixed', ins: [], outs: [[1, 0, '']], eq: 'a bus from fields, low bits first' },
  };
  // A constant for each domain. (Sound from outside comes in through In sockets.)
  const SOURCES = {
    const: { title: 'Constant', sym: 'c', w: 1, h: 1, ins: [], outs: [[0, 0, '']], eq: 'y = c' },
    bits: { title: 'Bits', sym: '01', w: 1, h: 1, dom: 'fixed', ins: [], outs: [[0, 0, '']], eq: 'a fixed word' },
    volts: { title: 'Voltage', sym: 'V', w: 1, h: 1, dom: 'analog', ins: [], outs: [[0, 0, '']], eq: 'a fixed voltage' },
  };
  // The design's own inputs and outputs: audio sockets (PipeWire ports when the bridge runs).
  const IO = {
    in: { title: 'In', sym: '▷', w: 3, h: 1, ins: [], outs: [[2, 0, '']], eq: 'audio in' },
    out: { title: 'Out', sym: '▷', w: 3, h: 1, ins: [[0, 0, '']], outs: [], eq: 'audio out' },
  };
  const DOCS = {
    add: 'Logic: its output net carries the sum of its inputs, settled within the same tick.',
    mul: 'Logic: its output net carries the product of its inputs, within the same tick.',
    gt: 'Logic: outputs 1 if a > b, else 0.',
    switch: 'Logic, a multiplexer: passes "then" if "if" > 0, else "else".',
    exp2: 'Logic: 2 to the power of its input, exact. With log₂ it makes pitch (1 V/oct is 2^V), decibels, and division (a / b = a · 2^−log₂ b).',
    log2: 'Logic: the base-2 logarithm of its input (zero or less reads as a very small number).',
    table: 'Logic, a ROM: the curve through a list of points, straight between them and flat beyond the first and last. Edit the points in the inspector. Any map from numbers to numbers: a scale, a waveshaper, a converter\'s law.',
    delay: 'A flip-flop: the only IC with memory. Its output net is a register that takes the input\'s value at each clock edge. Every feedback loop needs one.',
    const: 'A fixed number, optionally with a knob. Wire it to any number of inputs. Inside a block, a constant is a default: a wire from outside the block overrides it.',
    bits: 'A fixed-point word: WIDTH bits, set bit by bit (click them) or as a number. Inside a block it is a default, like a Constant.',
    volts: 'A fixed voltage, optionally with a knob: an analog Constant.',
    and: 'Fixed point: bitwise AND of two buses, within the tick.', or: 'Fixed point: bitwise OR.', xor: 'Fixed point: bitwise exclusive OR.',
    nand: 'Fixed point: bitwise NOT-AND.', nor: 'Fixed point: bitwise NOT-OR.', xnor: 'Fixed point: bitwise equivalence (NOT-XOR).',
    not: 'Fixed point: inverts every bit of the bus.',
    dff: 'Fixed point: a D flip-flop for every bit of the bus. Q takes D at each clock edge; Q̄ is its inverse. Every loop of gates needs one.',
    split: 'Fixed point: splits a bus into fields, low bits first (set the field widths in the inspector; 1,1,1,1 gives the four low bits one by one).',
    join: 'Fixed point: joins fields into one bus, the first input in the low bits.',
    in: 'An audio input of the design: a socket other programs can play into (a PipeWire port when the bridge runs; otherwise the microphone).',
    out: 'An audio output of the design: a socket other programs can listen to (a PipeWire port when the bridge runs). In the browser the first two Outs are the left and right speakers; a single Out plays on both.',
  };
  const ATOM_ORDER = ['add', 'mul', 'gt', 'switch', 'delay', 'exp2', 'log2', 'table'];
  // A Table's points, [[x, y], …] sorted by x (two at least; a straight line through 0,0 and 1,1 by default).
  function tablePoints(b) {
    const pts = (Array.isArray(b.points) ? b.points : []).filter((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)).map((q) => [q[0], q[1]]);
    pts.sort((a, c) => a[0] - c[0]);
    return pts.length >= 2 ? pts : pts.length === 1 ? [pts[0], [pts[0][0] + 1, pts[0][1]]] : [[0, 0], [1, 1]];
  }
  const GATE_ORDER = ['and', 'or', 'xor', 'not', 'nand', 'nor', 'xnor', 'dff', 'split', 'join'];
  const IO_ORDER = ['in', 'out'];
  const SOURCE_ORDER = ['const'];
  // Analog modules and converters register here (analog.js); MODULE_INFO holds
  // their board footprints in the same form as the atoms'.
  const MODULES = {}, MODULE_INFO = {};
  // Block types that only old files have (version 3 and before), for reading them:
  // migrate.js turns them into today's. (The old speaker 'dac' had the pin where the DAC converter has it.)
  const LEGACY = {
    scope: { title: 'Scope (old)', sym: '∿', w: 10, h: 5, ins: [[0, 2, '']], outs: [] },
    torack: { title: 'To rack (old)', sym: '→R', w: 3, h: 3, ins: [[0, 1, '']], outs: [] },
    fromrack: { title: 'From rack (old)', sym: 'R→', w: 3, h: 3, ins: [], outs: [[2, 1, '']] },
    sample: { title: 'Sample (old)', sym: '▤', w: 10, h: 3, ins: [], outs: [[9, 1, '']] },
    // converters before the crossings (format 5 and before): library blocks now
    adc: { title: 'ADC (old)', w: 3, h: 3, ins: [[0, 1, '', 'analog']], outs: [[2, 1, '', 'fixed']] },
    dac: { title: 'DAC (old)', w: 3, h: 3, ins: [[0, 1, '', 'fixed']], outs: [[2, 1, '', 'analog']] },
    quant: { title: 'Quantizer (old)', w: 3, h: 3, ins: [[0, 1, '', 'float']], outs: [[2, 1, '', 'fixed']] },
    dequant: { title: 'Dequantizer (old)', w: 3, h: 3, ins: [[0, 1, '', 'fixed']], outs: [[2, 1, '', 'float']] },
    v2hz: { title: 'V/OCT → Hz (old)', w: 3, h: 3, ins: [[0, 1, '', 'analog']], outs: [[2, 1, '', 'float']] },
    hz2v: { title: 'Hz → V/OCT (old)', w: 3, h: 3, ins: [[0, 1, '', 'float']], outs: [[2, 1, '', 'analog']] },
  };
  const info = (type) => ATOMS[type] || GATES[type] || SOURCES[type] || IO[type] || MODULE_INFO[type] || LEGACY[type] || null;
  const domOf = (t, pin) => pin[3] || t.dom || 'float';

  // ---- sheets --------------------------------------------------------------
  function makeSheet(extra) {
    return Object.assign({ blocks: [], wires: [], nextId: 1 }, extra || {});
  }
  function makeDef(name, fw, fh, s, ports, description) {
    return makeSheet({ name, fw, fh, s: s || 8, ports: ports || [], description: description || '' });
  }
  const isDef = (sheet) => sheet.fw !== undefined;
  // A definition's own board: iw × ih fine cells, by default s times its footprint.
  // The footprint can be resized without touching what is drawn inside.
  const inner = (def) => ({ w: def.iw || def.fw * def.s, h: def.ih || def.fh * def.s });
  // How the inside is drawn in the footprint: scale (outer cells per inner cell) and offset, centred.
  // (w, h: the footprint it is drawn in, when a copy has a size of its own)
  function innerFit(def, w, h) {
    w = w || def.fw; h = h || def.fh;
    const n = inner(def), k = Math.min(w / n.w, h / n.h);
    return { k, dx: (w - n.w * k) / 2, dy: (h - n.h * k) / 2 };
  }
  // A copy of a composite block can have a size of its own in the design it sits
  // in (b.w × b.h), without changing the block. Its pins spread over that height:
  // a port's row r of fh becomes ⌊r·h/fh⌋. Null when two pins on one side would share a row.
  function instanceRows(def, h) {
    if (!h || h === def.fh) return null;
    const rows = new Map();
    for (const dir of ['in', 'out']) {
      const seen = new Set();
      for (const p of portsOf(def, dir)) {
        const r = Math.floor(p.row * h / def.fh);
        if (seen.has(r)) return false;
        seen.add(r); rows.set(p, r);
      }
    }
    return rows;
  }
  function instanceSize(b, def) {
    const w = b.w || def.fw, h = b.h || def.fh;
    return instanceRows(def, h) === false ? { w, h: def.fh, rows: null } : { w, h, rows: instanceRows(def, h) };
  }
  const bounds = (sheet) => { if (!isDef(sheet)) return null; const n = inner(sheet); return { x0: 0, y0: 0, x1: n.w - 1, y1: n.h - 1 }; };
  function inBounds(sheet, x, y) {
    const b = bounds(sheet);
    return !b || (x >= b.x0 && y >= b.y0 && x <= b.x1 && y <= b.y1);
  }
  const portsOf = (def, dir) => def.ports.filter((p) => p.dir === dir).sort((a, b) => a.row - b.row);
  // Where a definition's port pads sit on its own inner grid.
  function innerPads(def) {
    const n = inner(def), pitch = n.h / def.fh, y = (row) => Math.floor(row * pitch + pitch / 2);
    return [
      ...portsOf(def, 'in').map((p, i) => ({ x: 0, y: y(p.row), dir: 'in', idx: i, name: p.name, dom: p.domain || 'float' })),
      ...portsOf(def, 'out').map((p, i) => ({ x: n.w - 1, y: y(p.row), dir: 'out', idx: i, name: p.name, dom: p.domain || 'float' })),
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
      const { w, h, rows } = instanceSize(b, def), row = (p) => (rows ? rows.get(p) : p.row);
      return {
        w, h,
        pads: [
          ...portsOf(def, 'in').map((p, i) => ({ x: b.x, y: b.y + row(p), dir: 'in', idx: i, name: p.name, dom: p.domain || 'float' })),
          ...portsOf(def, 'out').map((p, i) => ({ x: b.x + w - 1, y: b.y + row(p), dir: 'out', idx: i, name: p.name, dom: p.domain || 'float' })),
        ],
      };
    }
    let t = info(b.type);
    if (!t) return { w: 1, h: 1, pads: [] };
    if (b.type === 'split' || b.type === 'join') t = fieldsShape(t, b.type, partsOf(b));
    const rot = t.module ? 0 : b.rot || 0, odd = rot & 1;
    const pad = (dir) => (p, i) => {
      const [px, py] = rotate(p[0], p[1], t.w, t.h, rot);
      const q = { x: b.x + px, y: b.y + py, dir, idx: i, name: p[2], dom: domOf(t, p) };
      if (p[4] !== undefined) { q.fx = b.x + p[4]; q.fy = b.y + p[5]; }   // a jack's exact centre
      return q;
    };
    return { w: odd ? t.h : t.w, h: odd ? t.w : t.h, pads: [...t.ins.map(pad('in')), ...t.outs.map(pad('out'))] };
  }

  // Split and Join: one field per pin, on every other row.
  const partsOf = (b) => (Array.isArray(b.parts) && b.parts.length ? b.parts : [1, 1, 1, 1]);
  function fieldsShape(t, type, parts) {
    const h = 2 * parts.length - 1, names = [];
    let lo = 0;
    for (const n of parts) { names.push(n === 1 ? String(lo) : `${lo + n - 1}:${lo}`); lo += n; }
    return Object.assign({}, t, { h, ins: type === 'split' ? t.ins : parts.map((n, i) => [0, 2 * i, names[i]]),
      outs: type === 'join' ? t.outs : parts.map((n, i) => [1, 2 * i, names[i]]) });
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

  // ---- blocks --------------------------------------------------------------
  // A block may go wherever it doesn't overlap another block (or a port pad);
  // wires are re-routed around it, or pass under it.
  function canPlace(sheet, defs, b, ignore) {
    const fp = footprint(b, defs);
    const others = occupancy({ ...sheet, blocks: sheet.blocks.filter((q) => q !== ignore && q !== b) }, defs);
    for (let y = 0; y < fp.h; y++) {
      for (let x = 0; x < fp.w; x++) {
        const cx = b.x + x, cy = b.y + y;
        if (!inBounds(sheet, cx, cy) || others.has(key(cx, cy))) return false;
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

  // ---- pins and wires ----------------------------------------------------------
  // An endpoint is "<block id>.i<n>" / "<block id>.o<n>" (the block's n-th input or
  // output pin, in footprint order), or "port.i<n>" / "port.o<n>" for a
  // definition's own ports seen from inside (an input port is a source there, an
  // output port a sink).
  const ep = (b, dir, i) => `${b}.${dir === 'in' ? 'i' : 'o'}${i}`;
  function parseEp(e) {
    const m = /^(.*)\.([io])(\d+)$/.exec(e);
    return m ? { b: m[1], dir: m[2] === 'i' ? 'in' : 'out', i: Number(m[3]) } : null;
  }
  // Does a value come out of this endpoint (inside its sheet)?
  const isSource = (e) => { const p = parseEp(e); return !!p && (p.b === 'port' ? p.dir === 'in' : p.dir === 'out'); };
  // Where an endpoint's pad is: {x, y, dir, idx, name}.
  function pinOf(sheet, defs, e) {
    const p = parseEp(e);
    if (!p) return null;
    if (p.b === 'port') return isDef(sheet) ? innerPads(sheet).find((q) => q.dir === p.dir && q.idx === p.i) || null : null;
    const b = sheet.blocks.find((x) => x.id === p.b);
    return b ? footprint(b, defs).pads.find((q) => q.dir === p.dir && q.idx === p.i) || null : null;
  }
  // The endpoint whose pad is at a cell, if any.
  function endpointAt(sheet, defs, x, y) {
    const o = occupancy(sheet, defs).get(key(x, y));
    if (!o || !o.pad) return null;
    return o.port ? ep('port', o.pad.dir, o.pad.idx) : ep(o.block.id, o.pad.dir, o.pad.idx);
  }
  const domainAt = (sheet, defs, e) => { const p = pinOf(sheet, defs, e); return p ? p.dom : null; };
  // Why a wire from `from` to `to` can't be made, or null if it can.
  function wireProblem(sheet, defs, from, to) {
    if (!isSource(from) || isSource(to)) return 'A wire goes from an output to an input.';
    const a = domainAt(sheet, defs, from), b = domainAt(sheet, defs, to);
    if (!a || !b) return 'No such pin.';
    if (a !== b) return `That joins ${a} to ${b}: use a converter between them.`;
    return null;
  }
  // Analog wires are patch cables: they hang between their jacks and are never routed.
  const isCable = (sheet, defs, w) => domainAt(sheet, defs, w.from) === 'analog';
  const wiresInto = (sheet, e) => sheet.wires.filter((w) => w.to === e);
  const wiresFrom = (sheet, e) => sheet.wires.filter((w) => w.from === e);
  const wiresAt = (sheet, e) => sheet.wires.filter((w) => w.from === e || w.to === e);
  // Connect a source to a sink. An input takes one wire, so one already there is replaced.
  function addWire(sheet, from, to, path) {
    if (!isSource(from) || isSource(to)) return null;
    sheet.wires = sheet.wires.filter((w) => w.to !== to);
    const w = { id: 'w' + sheet.nextId++, from, to };
    if (path && path.length) w.path = path.map(([x, y]) => [x, y]);
    sheet.wires.push(w);
    return w;
  }
  // A block's ports were renumbered (one added, removed or moved): rewrite the
  // wires at block `id` (or at "port", inside the definition itself) by `map`,
  // { in: [old index -> new index or -1], out: [...] }. Wires to a port that is
  // gone are removed and returned.
  function remapPorts(sheet, id, map) {
    const dropped = [];
    sheet.wires = sheet.wires.filter((w) => {
      for (const end of ['from', 'to']) {
        const p = parseEp(w[end]);
        if (!p || p.b !== id) continue;
        const k = (map[p.dir] || [])[p.i];
        if (k === undefined) continue;
        if (k < 0) { dropped.push(w); return false; }
        w[end] = ep(id, p.dir, k);
      }
      return true;
    });
    return dropped;
  }
  function removeWires(sheet, ids) { sheet.wires = sheet.wires.filter((w) => !ids.has(w.id)); }
  // Remove blocks and every wire attached to them.
  function removeBlocks(sheet, ids) {
    sheet.blocks = sheet.blocks.filter((b) => !ids.has(b.id));
    sheet.wires = sheet.wires.filter((w) => !ids.has(parseEp(w.from).b) && !ids.has(parseEp(w.to).b));
  }
  // Is a stored route still a route between the wire's pads?
  function pathOk(sheet, defs, w) {
    const p = w.path, a = pinOf(sheet, defs, w.from), b = pinOf(sheet, defs, w.to);
    if (!p || p.length < 2 || !a || !b) return false;
    if (p[0][0] !== a.x || p[0][1] !== a.y || p[p.length - 1][0] !== b.x || p[p.length - 1][1] !== b.y) return false;
    for (let i = 1; i < p.length; i++) if (Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]) !== 1) return false;
    return true;
  }
  // Remove back-and-forth steps and loops from a route.
  function tidy(path) {
    const out = [];
    for (const c of path) {
      const i = out.findIndex((q) => q[0] === c[0] && q[1] === c[1]);
      if (i >= 0) out.length = i + 1; else out.push([c[0], c[1]]);
    }
    return out;
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

  // ---- the router ---------------------------------------------------------------
  // Shortest route over the grid from any of `starts` to `to`, for drawing. Block
  // bodies and other pins are expensive (the trace would pass under them); cells of
  // other nets cost a crossing; cells of the wire's own net are cheap, so branches
  // share copper; turns cost a little, so routes stay straight.
  function routeCells(sheet, defs, starts, to, opts) {
    opts = opts || {};
    const occ = occupancy(sheet, defs), own = opts.own || new Set(), other = opts.other || new Map();
    const target = key(to.x, to.y);
    const box = opts.box || bounds(sheet) || (() => {
      let x0 = Math.min(to.x, ...starts.map((c) => c[0])), y0 = Math.min(to.y, ...starts.map((c) => c[1]));
      let x1 = Math.max(to.x, ...starts.map((c) => c[0])), y1 = Math.max(to.y, ...starts.map((c) => c[1]));
      for (const b of sheet.blocks) { const fp = footprint(b, defs); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + fp.w); y1 = Math.max(y1, b.y + fp.h); }
      return { x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: y1 + 4 };
    })();
    const startSet = new Set(starts.map(([x, y]) => key(x, y)));
    const cost = (x, y) => {
      const k = key(x, y);
      if (k === target) return 1;
      if (x < box.x0 || y < box.y0 || x > box.x1 || y > box.y1) return Infinity;
      const o = occ.get(k);
      let c = 1;
      if (o && !startSet.has(k)) c += o.pad ? 40 : 10;
      if (own.has(k)) c = Math.min(c, 0.35);
      else if (other.has(k)) c += 5 * other.get(k);
      return c;
    };
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const dist = new Map(), prev = new Map(), q = heap();
    for (const [x, y] of starts) for (let d = 0; d < 4; d++) { const s = key(x, y) + '|' + d; dist.set(s, 0); prev.set(s, null); q.push([0, s]); }
    let found = null;
    while (q.length) {
      const [dd, s] = q.pop();
      if (dd > dist.get(s)) continue;
      const [k, d] = s.split('|'), [x, y] = unkey(k);
      if (k === target) { found = s; break; }
      for (let nd = 0; nd < 4; nd++) {
        const nx = x + DIRS[nd][0], ny = y + DIRS[nd][1], c = cost(nx, ny);
        if (c === Infinity) continue;
        const ns = key(nx, ny) + '|' + nd, v = dd + c + (nd === Number(d) ? 0 : 0.5);
        if (!dist.has(ns) || v < dist.get(ns)) { dist.set(ns, v); prev.set(ns, s); q.push([v, ns]); }
      }
    }
    if (!found) return null;
    const out = [];
    for (let s = found; s; s = prev.get(s)) out.unshift(unkey(s.split('|')[0]));
    // the start set may have produced the same cell twice (direction states)
    return tidy(out);
  }
  // A route for wire `w`, starting from its net's existing routes where that is
  // shorter: `routes` maps wire id -> cells for the wires already drawn.
  function routeWire(sheet, defs, w, routes) {
    const a = pinOf(sheet, defs, w.from), b = pinOf(sheet, defs, w.to);
    if (!a || !b) return null;
    const own = new Map();          // cell -> route from the source to it
    own.set(key(a.x, a.y), [[a.x, a.y]]);
    const other = new Map();
    for (const v of sheet.wires) {
      const r = routes.get(v.id);
      if (!r || v.id === w.id) continue;
      if (v.from === w.from) r.forEach((c, i) => { const k = key(c[0], c[1]); if (!own.has(k)) own.set(k, r.slice(0, i + 1)); });
      else for (const c of r) { const k = key(c[0], c[1]); other.set(k, (other.get(k) || 0) + 1); }
    }
    const cells = routeCells(sheet, defs, [...own.keys()].map(unkey), b, { own: new Set(own.keys()), other });
    if (!cells) return null;
    return tidy(own.get(key(cells[0][0], cells[0][1])).concat(cells.slice(1)));
  }
  // Every wire's route: its own if still valid, else a fresh one (deterministic).
  function routesOf(sheet, defs) {
    const routes = new Map();
    const routed = sheet.wires.filter((w) => !isCable(sheet, defs, w));
    for (const w of routed) if (pathOk(sheet, defs, w)) routes.set(w.id, w.path);
    for (const w of routed) if (!routes.has(w.id)) { const r = routeWire(sheet, defs, w, routes); if (r) routes.set(w.id, r); }
    return routes;
  }
  // Give every wire without a valid route a stored one (e.g. after building or moving).
  function fixRoutes(sheet, defs) {
    const routes = routesOf(sheet, defs);
    for (const w of sheet.wires) { const r = routes.get(w.id); if (r && !pathOk(sheet, defs, w)) w.path = r.map(([x, y]) => [x, y]); }
    for (const w of sheet.wires) if (w.path && isCable(sheet, defs, w)) delete w.path;
  }

  // A wire one of whose pins has moved: keep its trace from the end that stayed,
  // up to the first cell where `moved(cell)` says the old shape no longer holds,
  // and route the rest to the pin where it is now. `end` is the moved end.
  function reattach(sh, defs, w, r, end, moved) {
    const kept = end === 'from' ? r.slice().reverse() : r.slice();
    let n = 1;
    while (n < kept.length - 1 && !moved(kept[n])) n++;
    const stay = kept.slice(0, n);
    const pin = pinOf(sh, defs, w[end]);
    const own = new Set(), other = new Map();
    for (const v of sh.wires) {
      const rv = v.path && v !== w ? v.path : null;
      if (!rv) continue;
      for (const c of rv) { const k = key(c[0], c[1]); if (v.from === w.from) own.add(k); else other.set(k, (other.get(k) || 0) + 1); }
    }
    const tail = pin && routeCells(sh, defs, [stay[stay.length - 1]], pin, { other, own });
    if (!tail) { delete w.path; return; }
    const path = tidy(stay.concat(tail.slice(1)));
    w.path = end === 'from' ? path.reverse() : path;
  }

  // Stored traces whose end is no longer on its pin (a block's footprint changed
  // since the file was saved): keep each from the end that is still right.
  function mendPaths(sheet, defs) {
    const occ = occupancy(sheet, defs);
    let n = 0;
    for (const w of sheet.wires) {
      const p = w.path, a = pinOf(sheet, defs, w.from), b = pinOf(sheet, defs, w.to);
      if (!p || p.length < 2 || !a || !b || pathOk(sheet, defs, w)) continue;
      const at = (c, q) => c[0] === q.x && c[1] === q.y;
      const end = at(p[0], a) && !at(p[p.length - 1], b) ? 'to' : !at(p[0], a) && at(p[p.length - 1], b) ? 'from' : null;
      if (!end) continue;
      const old = end === 'to' ? p[p.length - 1] : p[0], bid = parseEp(w[end]).b;
      const inBlock = (c) => { const o = occ.get(key(c[0], c[1])); return !!(o && o.block && o.block.id === bid); };
      reattach(sheet, defs, w, p, end, (c) => (c[0] === old[0] && c[1] === old[1]) || inBlock(c));
      n++;
    }
    return n;
  }

  // ---- drawing as a circuit board -----------------------------------------------------
  // The layout the renderer draws: for each net (a source and its wires) the cells
  // its traces cover, each on the top or the bottom layer, with vias where a trace
  // changes layer. A trace takes the top layer unless another net got there first,
  // or a block or another pin is in the way; then it dips to the bottom layer. This
  // is drawing only: connections are the wires.
  function renderLayout(sheet, defs) {
    const occ = occupancy(sheet, defs), routes = routesOf(sheet, defs);
    const top = {}, bot = {}, regions = {}, netOfWire = new Map();
    const nets = new Map();   // source endpoint -> wires (float wires: fixed are barcodes, analog cables)
    for (const w of sheet.wires) {
      if (domainAt(sheet, defs, w.from) !== 'float') continue;
      if (!nets.has(w.from)) nets.set(w.from, []);
      nets.get(w.from).push(w);
    }
    // pins belong to their nets
    const padNet = new Map();
    for (const [src, ws] of nets) {
      for (const w of ws) for (const e of [w.from, w.to]) { const p = pinOf(sheet, defs, e); if (p) padNet.set(key(p.x, p.y), src); }
    }
    for (const [k, src] of padNet) top[k] = src;
    for (const [src, ws] of nets) {
      regions[src] = { value: 0 };
      const layer = new Map();
      // hand-placed vias first: the trace starts on top and changes layer at each one
      for (const w of ws) {
        const r = routes.get(w.id), vias = w.style && w.style.vias;
        if (!r || !Array.isArray(vias)) continue;
        const at = new Set(vias.filter((i) => i > 0 && i < r.length - 1));
        let l = TOP;
        r.forEach(([x, y], i) => {
          const k = key(x, y);
          if (at.has(i)) { layer.set(k, 'via'); top[k] = src; bot[k] = src; l = l === TOP ? BOT : TOP; return; }
          if (layer.has(k)) return;
          layer.set(k, l);
          if (l === TOP && !(top[k] && top[k] !== src)) top[k] = src; else bot[k] = src;
        });
      }
      for (const w of ws) {
        netOfWire.set(w.id, src);
        const r = routes.get(w.id);
        if (!r) continue;
        for (const [x, y] of r) {
          const k = key(x, y);
          if (layer.has(k)) continue;
          const o = occ.get(k);
          const mine = padNet.get(k) === src;
          const blocked = (o && !mine) || (top[k] && top[k] !== src);
          layer.set(k, blocked ? BOT : TOP);
          if (blocked) bot[k] = src; else top[k] = src;
        }
      }
      // vias: wherever a route steps between layers, on the top-layer side
      for (const w of ws) {
        const r = routes.get(w.id);
        if (!r) continue;
        for (let i = 1; i < r.length; i++) {
          const a = key(r[i - 1][0], r[i - 1][1]), b = key(r[i][0], r[i][1]);
          if (layer.get(a) === layer.get(b) || layer.get(a) === 'via' || layer.get(b) === 'via') continue;
          const t = layer.get(a) === TOP ? a : b;
          if (!bot[t] || bot[t] === src) bot[t] = src;
        }
      }
    }
    return { top, bot, regions, routes, netOfWire };
  }

  // ---- builder (used to lay out the generated library and examples) ------------------
  function builder(sheet, defs) {
    const ids = {};
    const routes = new Map();
    const b = {
      sheet,
      block(name, type, x, y, extra) {
        const blk = addBlock(sheet, defs, Object.assign({ type, x, y }, extra || {}));
        if (!blk) throw new Error('cannot place ' + name + ' at ' + x + ',' + y);
        ids[name] = blk;
        return blk;
      },
      // 'name.in0', 'name.out1', or 'port.in0' / 'port.out0' for a definition's own ports
      ep(ref) {
        const [name, p] = ref.split('.');
        const dir = p.startsWith('in') ? 'in' : 'out', idx = Number(p.replace(/\D/g, ''));
        if (name === 'port') return ep('port', dir, idx);
        if (!ids[name]) throw new Error('no block ' + name);
        return ep(ids[name].id, dir, idx);
      },
      // Wire one source to any number of sinks, routing each wire. With
      // props.value on an input port, that is the port's default.
      net(src, sinks, props) {
        const from = b.ep(src);
        if (!isSource(from)) throw new Error(src + ' is not a source');
        if (props && props.value !== undefined && from.startsWith('port.')) b.portDefault(src, props.value);
        for (const t of [].concat(sinks)) {
          const why = wireProblem(sheet, defs, from, b.ep(t));
          if (why) throw new Error('cannot wire ' + src + ' → ' + t + ': ' + why);
          const w = addWire(sheet, from, b.ep(t));
          if (props && props.style) w.style = Object.assign({}, props.style);
          if (isCable(sheet, defs, w)) continue;
          const r = routeWire(sheet, defs, w, routes);
          if (r) { w.path = r; routes.set(w.id, r); }
        }
        return from;
      },
      portDefault(ref, value, knob) {
        const e = parseEp(b.ep(ref)), port = portsOf(sheet, 'in')[e.i];
        port.value = value;
        if (knob) port.knob = Object.assign({}, knob);
      },
      // A constant on a block's input: a Constant block `len` cells away in
      // direction dir, wired along the straight run. Returns the Constant's id.
      konst(padRef, dir, len, value, knob) {
        const to = b.ep(padRef), p = pinOf(sheet, defs, to);
        if (isSource(to)) return null;   // a stub on an output was only ever a drawing
        const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
        // the constant of the pin's kind: a number, a voltage, or a word of bits
        const kind = { float: { type: 'const' }, analog: { type: 'volts' }, fixed: { type: 'bits', width: 8 } }[p.dom || 'float'];
        const c = addBlock(sheet, defs, Object.assign({ x: p.x + dx * len, y: p.y + dy * len, value }, kind));
        if (!c) throw new Error('constant blocked at ' + padRef);
        if (knob) c.knob = Object.assign({}, knob);
        const path = [];
        for (let i = len; i >= 0; i--) path.push([p.x + dx * i, p.y + dy * i]);
        const w = addWire(sheet, ep(c.id, 'out', 0), to, kind.type === 'volts' ? null : path);
        if (w.path) routes.set(w.id, w.path);
        return c.id;
      },
      // A Constant block at (or near) a cell, wired to the given sinks.
      constant(name, x, y, value, knob, sinks) {
        const free = nearestFree(sheet, defs, x, y);
        const c = b.block(name, 'const', free[0], free[1], { value });
        if (knob) c.knob = Object.assign({}, knob);
        if (sinks) b.net(name + '.out0', sinks);
        return c.id;
      },
    };
    return b;
  }
  // The nearest cell (breadth first) where a 1×1 block fits.
  function nearestFree(sheet, defs, x, y) {
    const occ = occupancy(sheet, defs), seen = new Set([key(x, y)]), q = [[x, y]];
    for (let i = 0; i < q.length && i < 10000; i++) {
      const [cx, cy] = q[i];
      if (!occ.has(key(cx, cy)) && inBounds(sheet, cx, cy)) return [cx, cy];
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) if (!seen.has(key(nx, ny))) { seen.add(key(nx, ny)); q.push([nx, ny]); }
    }
    return [x, y];
  }

  const api = {
    FS, TOP, BOT, DOMAINS, CABLE_COLORS, ATOMS, GATES, SOURCES, IO, MODULES, MODULE_INFO, DOCS, ATOM_ORDER, GATE_ORDER, SOURCE_ORDER, IO_ORDER, info, domOf, partsOf, tablePoints, key, unkey,
    makeSheet, makeDef, isDef, bounds, inBounds, portsOf, innerPads, footprint, occupancy, canPlace, addBlock, uses,
    ep, parseEp, isSource, pinOf, endpointAt, domainAt, wireProblem, isCable, remapPorts, wiresInto, wiresFrom, wiresAt, addWire, removeWires, removeBlocks, pathOk, tidy,
    heap, routeCells, routeWire, routesOf, fixRoutes, renderLayout, builder, nearestFree, inner, innerFit, instanceRows, reattach, mendPaths,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
