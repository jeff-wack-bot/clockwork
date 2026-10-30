// Board compiler. A net is a source pin and every pin wired to it (across block
// boundaries: a pin is the same net as the port inside). Every net carries one
// kind of signal: float numbers, fixed-point words or analog voltages; a wire
// between two kinds is an error, and converters cross between them.
//
// Logic settles within the tick: the float ICs (Add, Multiply, Greater-than,
// Switch), the gates, Split and Join, and the converters. Delays and D flip-flops
// are registers. Analog modules (analog.js) are circuits
// sampled by the same clock: their outputs are registers too, and at the clock
// edge each integrates its equations across one tick.
//
// A fixed-point word is an unsigned integer of its bus's width (at most 32 bits);
// widths are worked out from the drivers. In and Out sockets on the top board are
// the program's audio inputs and outputs.
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const G = node ? require('./model.js') : root.GW;
  const A = node ? require('./analog.js') : root.GW.Analog;

  // A stable 32-bit seed per module path, for its noise.
  function seedOf(path) {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) || 1;
  }

  function compile(project) {
    const errors = [], warnings = [];
    const parent = new Map();           // union-find over pin keys `${path}${endpoint}`
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    // Constants are weak drivers: a Constant (or Voltage, or Bits) block, or an input
    // port's default. A net driven by an IC ignores them; otherwise the outermost one
    // sets it (one with a knob preferred), so a wire from outside a block overrides
    // the default inside.
    const consts = [];                  // {key, id, depth, value, knob, width?}
    const atoms = [];                   // float logic and flip-flops: {path, block, ins:[key], outs:[key], chain}
    const gates = [];                   // fixed point: gates, D flip-flops, Split, Join
    const sockets = [];                 // In and Out: {path, block, ins, outs}
    const mods = [];                    // analog modules and converters: {kind, spec, path, ins, outs, chain, param(id)}
    const domOf = new Map();            // pin key -> domain
    const pseudo = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };

    function visit(sheet, path, depth, chain) {
      const here = new Map();           // endpoint -> domain, on this sheet
      const pin = (id, dir, i, dom) => { const e = G.ep(id, dir, i), k = pseudo(path + e); here.set(e, dom); domOf.set(k, dom); return k; };
      if (G.isDef(sheet)) {
        G.portsOf(sheet, 'in').forEach((p, i) => {
          const dom = p.domain || 'float', k = pin('port', 'in', i, dom), id = path + G.ep('port', 'in', i), ov = project.values && project.values[id];
          const c = { key: k, id, depth, value: Number(ov !== undefined ? ov : p.value) || 0, knob: !!p.knob };
          if (dom === 'fixed') { c.width = clampW(p.width || 8); c.value = word(c.value, c.width); }
          consts.push(c);
        });
        G.portsOf(sheet, 'out').forEach((p, i) => pin('port', 'out', i, p.domain || 'float'));
      }
      for (const b of sheet.blocks) {
        const fp = G.footprint(b, project.defs);
        const ins = fp.pads.filter((p) => p.dir === 'in').map((p) => pin(b.id, 'in', p.idx, p.dom));
        const outs = fp.pads.filter((p) => p.dir === 'out').map((p) => pin(b.id, 'out', p.idx, p.dom));
        const bp = path + b.id;
        if (b.type === 'const' || b.type === 'volts' || b.type === 'bits') {
          const ov = depth > 0 && project.values ? project.values[bp] : undefined;
          const c = { key: outs[0], id: bp, depth, value: Number(ov !== undefined ? ov : b.value) || 0, knob: !!b.knob };
          if (b.type === 'bits') { c.width = clampW(b.width || 8); c.value = word(c.value, c.width); }
          consts.push(c);
          continue;
        }
        const spec = G.MODULES[b.type];
        if (G.ATOMS[b.type]) atoms.push({ path: bp, block: b, ins, outs, chain });
        else if (G.GATES[b.type]) gates.push({ path: bp, block: b, ins, outs, chain, parts: G.partsOf(b) });
        else if (G.IO[b.type]) {
          if (depth > 0) { errors.push({ msg: `${G.IO[b.type].title} sockets belong on the top board; inside a block, use its ports`, path: bp }); continue; }
          sockets.push({ path: bp, block: b, ins, outs });
        } else if (spec) {
          // At the root a knob's value is on the block; inside an instance, per instance by path.
          const param = (id) => {
            const ov = depth > 0 && project.values ? project.values[bp + '#' + id] : undefined;
            const own = b.params && b.params[id];
            const p = spec.params.find((q) => q.id === id);
            return Number(ov !== undefined ? ov : own !== undefined ? own : p.def);
          };
          mods.push({ kind: spec.kind, spec, path: bp, block: b, ins, outs, chain, param });
        } else if (b.type === 'comp') {
          const def = project.defs[b.def];
          if (!def) { errors.push({ msg: `Unknown IC "${b.def}"`, path: bp }); continue; }
          if (chain.includes(b.def)) { errors.push({ msg: `"${b.def}" contains itself`, path: bp }); continue; }
          const childPath = bp + '/';
          visit(def, childPath, depth + 1, chain.concat([b.def]));
          // A pin is just copper: the outer and inner nets are the same net.
          for (const ip of G.innerPads(def)) union((ip.dir === 'in' ? ins : outs)[ip.idx], childPath + G.ep('port', ip.dir, ip.idx));
        } else errors.push({ msg: `Unknown block type "${b.type}"`, path: bp });
      }
      for (const w of sheet.wires || []) {
        const a = here.get(w.from), z = here.get(w.to);
        if (a && z && a !== z) { errors.push({ msg: `A wire joins ${a} to ${z} (${w.from} → ${w.to}); put a converter between them`, path: path + w.id }); continue; }
        union(pseudo(path + w.from), pseudo(path + w.to));
      }
    }
    visit(project.root, '', 0, []);

    // ---- nets and their writers ---------------------------------------------
    const nets = new Map();
    for (const k of parent.keys()) {
      const r = find(k);
      if (!nets.has(r)) nets.set(r, { keys: [], writers: [], consts: [], dom: null });
      const n = nets.get(r), d = domOf.get(k);
      n.keys.push(k);
      if (d && n.dom && d !== n.dom && !n.mixed) {
        n.mixed = true;
        errors.push({ msg: `A net joins ${n.dom} and ${d} pins (${n.keys[0]}, ${k}); a block's port and what is wired to it must be the same kind`, path: k.replace(/\.[io]\d+$/, '') });
      }
      n.dom = n.dom || d || null;
    }
    const netOfKey = (k) => (k ? nets.get(find(k)) : null);
    for (const c of consts) netOfKey(c.key).consts.push(c);
    // An input that nothing reaches: no wire, no constant, no other pin.
    const open = (k) => { const n = netOfKey(k); return n.keys.length === 1 && !n.consts.length; };
    const titleOf = (a) => (a.spec ? a.spec.title : G.info(a.block.type).title);
    for (const a of atoms.concat(gates)) {
      a.outs.forEach((k, i) => { if (k) { netOfKey(k).writers.push(a); if (a.block.type === 'dff' && i === 1) netOfKey(k).qbar = true; } });
      const t = G.info(a.block.type), fp = G.footprint(a.block, project.defs).pads.filter((p) => p.dir === 'in');
      a.ins.forEach((k, i) => { if (open(k)) warnings.push({ msg: `${t.title}: input "${(fp[i] && fp[i].name) || 'x'}" is not connected (reads 0)`, path: a.path }); });
    }
    for (const so of sockets) so.outs.forEach((k) => netOfKey(k).writers.push(so));
    // a module reads its default from an input nothing reaches
    for (const md of mods) md.ins = md.ins.map((k) => (k && open(k) ? null : k));
    for (const md of mods) md.outs.forEach((k) => { if (k) netOfKey(k).writers.push(md); });
    for (const so of sockets) if (so.block.type === 'out' && open(so.ins[0])) warnings.push({ msg: `Out "${so.block.name || 'out'}" is not connected`, path: so.path });
    // Flip-flops and analog modules drive registers: their outputs only change at the clock edge.
    const clocked = (w) => w.kind === 'analog' || (w.block && (w.block.type === 'delay' || w.block.type === 'dff'));

    // ---- bus widths ------------------------------------------------------------
    // A fixed-point bus is as wide as what drives it: a Bits constant, a converter's
    // BITS, a Split's field, a Join's total, or a gate's widest input (a flip-flop
    // passes its width on). Loops settle in a few rounds; anything left is 1 bit.
    const width = new Map();            // net -> bits
    const W = (k) => (k ? width.get(netOfKey(k)) || 0 : 0);
    const setW = (k, w) => { const n = k && netOfKey(k); if (n && w > (width.get(n) || 0)) { width.set(n, clampW(w)); return true; } return false; };
    for (const n of nets.values()) if (n.dom === 'fixed' && !n.writers.length && n.consts.length) {
      const c = n.consts.slice().sort((a, b) => a.depth - b.depth || (b.knob - a.knob))[0];
      width.set(n, c.width || 1);
    }
    for (let round = 0, changed = true; changed && round < 66; round++) {
      changed = false;
      for (const g of gates) {
        const t = g.block.type;
        if (t === 'split') {
          g.outs.forEach((k, i) => { changed = setW(k, g.parts[i]) || changed; });
        } else if (t === 'join') changed = setW(g.outs[0], g.parts.reduce((x, y) => x + y, 0)) || changed;
        else {
          const w = Math.max(0, ...g.ins.map(W));
          if (w) for (const k of g.outs) changed = setW(k, w) || changed;
        }
      }
      for (const md of mods) if (md.spec.width) changed = setW(md.outs[0], md.param('bits')) || changed;
    }
    for (const n of nets.values()) if (n.dom === 'fixed' && !width.has(n)) width.set(n, 1);
    for (const md of mods) md.ins.forEach((k, i) => {
      if (k && md.spec.ins[i].dom === 'fixed' && W(k) > 32) errors.push({ msg: `${md.spec.title}: its input is wider than 32 bits`, path: md.path });
    });
    const mask = (w) => String(Math.pow(2, w) - 1);

    const problemPaths = [];
    const state = [], wires = [], params = [];
    const netOf = {}, knobState = {}, widths = {};
    for (const net of nets.values()) {
      if (net.writers.length > 1) {
        errors.push({ msg: `A net has ${net.writers.length} writers (${net.writers.map((w) => w.path).join(', ')}). Only one IC may drive a net.`, path: net.writers[0].path });
        net.writers.forEach((w) => problemPaths.push(w.path));
      }
      const w = net.writers[0];
      // (a D flip-flop's Q̄ is not a register of its own: it is ¬Q, worked out within the tick)
      if (w && clocked(w) && !net.qbar) { net.ref = { k: 's', i: state.length }; state.push(net); }
      else if (w) { net.ref = { k: 'n', i: wires.length }; wires.push(net); }
      else {
        // A constant: the outermost one, a knob preferred among equals.
        const cs = net.consts.slice().sort((a, b) => a.depth - b.depth || (b.knob - a.knob));
        const src = cs[0];
        net.ref = { k: 'p', i: params.length };
        params.push(src ? (net.dom === 'fixed' ? word(src.value, width.get(net)) : src.value) : 0);
        for (const c of net.consts) if (c.knob) knobState[c.id] = c === src ? 'ok' : 'overridden';
      }
      if (w) for (const c of net.consts) if (c.knob) knobState[c.id] = 'written';
      for (const k of net.keys) { netOf[k] = net.ref; if (net.dom === 'fixed') widths[k] = width.get(net); }
    }
    // Snapshot layout: registers first, then wires.
    const vIndex = (ref) => (ref.k === 's' ? ref.i : state.length + ref.i);
    for (const k in netOf) if (netOf[k].k !== 'p') netOf[k] = Object.assign({ v: vIndex(netOf[k]) }, netOf[k]);

    // Module knobs are constants too: one parameter each, so turning one never recompiles.
    const paramIndex = {};
    for (const md of mods) {
      md.p = {};
      for (const p of md.spec.params) { md.p[p.id] = params.length; paramIndex[md.path + '#' + p.id] = params.length; params.push(md.param(p.id)); }
    }

    // ---- schedule the logic (Kahn) --------------------------------------------
    const drives = (a) => a.outs.some((k) => k && netOfKey(k).writers[0] === a);
    const logic = atoms.filter((a) => a.block.type !== 'delay' && drives(a))
      .concat(gates.filter((g) => g.block.type !== 'dff' && drives(g)))
      .concat(mods.filter((md) => md.kind === 'logic' && drives(md)));
    const writerOf = (k) => { const n = netOfKey(k); return n && n.writers[0]; };
    const deps = new Map(logic.map((a) => [a, []]));
    const users = new Map(logic.map((a) => [a, []]));
    for (const a of logic) {
      for (const k of a.ins) {
        const w = k && writerOf(k);
        if (w && !clocked(w) && deps.has(w) && !deps.get(a).includes(w)) { deps.get(a).push(w); users.get(w).push(a); }
      }
    }
    const indeg = new Map(logic.map((a) => [a, deps.get(a).length]));
    const order = [], queue = logic.filter((a) => indeg.get(a) === 0);
    while (queue.length) {
      const a = queue.shift();
      order.push(a);
      for (const u of users.get(a)) { indeg.set(u, indeg.get(u) - 1); if (indeg.get(u) === 0) queue.push(u); }
    }
    if (order.length < logic.length) {
      const left = new Set(logic.filter((a) => !order.includes(a)));
      let changed = true;
      while (changed) {   // keep only the loop itself, not what hangs off it
        changed = false;
        for (const a of left) if (!users.get(a).some((u) => left.has(u))) { left.delete(a); changed = true; }
      }
      for (const a of left) problemPaths.push(a.path);
      errors.push({ msg: `Feedback loop without a flip-flop: ${[...left].map((a) => a.path).join(' → ')}. Put a Delay or a D flip-flop (or an analog module) somewhere in the loop.`, path: [...left][0].path });
    }

    // ---- critical path: the longest chain of logic between flip-flops --------
    const title = (a) => a.chain.concat([titleOf(a)]).join(' › ');
    const depth = new Map(), via = new Map();
    for (const a of order) {
      let best = 0, bp = null;
      for (const d of deps.get(a)) if ((depth.get(d) || 0) > best) { best = depth.get(d); bp = d; }
      depth.set(a, best + 1); via.set(a, bp);
    }
    let end = null, critDepth = 0;
    for (const [a, d] of depth) if (d > critDepth) { critDepth = d; end = a; }
    const critical = [];
    for (let a = end; a; a = via.get(a)) critical.unshift({ path: a.path, name: title(a) });

    // ---- code generation ------------------------------------------------------
    const ref = (k) => {
      if (!k) return '0';
      const r = netOfKey(k).ref;
      return r.k === 's' ? 's' + r.i : r.k === 'n' ? 'n' + r.i : `p[${r.i}]`;
    };
    const num = (x) => String(x);
    const nodeCode = {};
    const L = [];
    const analog = mods.filter((md) => md.kind === 'analog');
    // Private state of the analog modules (capacitor voltages, phases, noise seeds):
    // persisted like registers, after them.
    const qs = [];
    for (const md of analog) { md.q = {}; for (const id of md.spec.state) { md.q[id] = qs.length; qs.push(md.path + '#' + id); } }
    L.push('// Sample Factory program. Wires settle within the tick; flip-flops (Delays, D flip-flops) hold state.');
    L.push(`// s = ${state.length} registers, n = ${wires.length} wires, p[] = ${params.length} constants` + (analog.length ? `, q = ${qs.length} analog state variables` : ''));
    if (mods.length) { L.push('// ---- shared by the analog modules and converters'); L.push(A.PRELUDE); }
    const qBase = state.length, qSnap = state.length + wires.length;
    const nS = qBase + qs.length;
    // Sockets: outputs from the top of the board down, then inputs the same way.
    const byPlace = (a, b) => a.block.y - b.block.y || a.block.x - b.block.x;
    const outs = sockets.filter((x) => x.block.type === 'out').sort(byPlace), ins = sockets.filter((x) => x.block.type === 'in').sort(byPlace);
    L.push(`// o[] = ${outs.length} audio output(s), I[] = ${ins.length} audio input(s)`);
    const tables = [], atLut = L.length;   // a Table's points, as constants before run
    L.push('return function run(N, p, s, o, I, v) {');
    if (state.length) for (let i = 0; i < state.length; i += 12) L.push('  let ' + state.slice(i, i + 12).map((n, j) => `s${i + j} = s[${i + j}]`).join(', ') + ';');
    outs.forEach((so, j) => L.push(`  const o${j} = o[${j}];`.padEnd(44) + `// ${so.path}  Out "${so.block.name || 'out'}"`));
    ins.forEach((so, j) => L.push(`  const I${j} = I && I[${j}];`.padEnd(44) + `// ${so.path}  In "${so.block.name || 'in'}"`));
    for (let i = 0; i < qs.length; i += 10) L.push('  let ' + qs.slice(i, i + 10).map((n, j) => `q${i + j} = s[${qBase + i + j}]`).join(', ') + ';');
    for (let i = 0; i < wires.length; i += 12) L.push('  let ' + wires.slice(i, i + 12).map((n, j) => `n${i + j} = 0`).join(', ') + ';');
    L.push('  for (let i = 0; i < N; i++) {');
    ins.forEach((so, j) => {
      const o = so.outs[0];
      if (netOfKey(o).writers[0] !== so) return;
      const line = `n${netOfKey(o).ref.i} = I${j} ? I${j}[i] : 0;`;
      L.push(`    ${line}`.padEnd(44) + `// ${so.path}  In "${so.block.name || 'in'}"`);
      nodeCode[so.path] = line;
    });
    const dffs = gates.filter((g) => g.block.type === 'dff' && drives(g));
    for (const a of dffs) {
      const [q, qb] = a.outs;
      if (netOfKey(qb).writers[0] !== a) continue;
      const line = `n${netOfKey(qb).ref.i} = (~${ref(q)} & ${mask(W(qb))}) >>> 0;`;
      L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}: Q̄`);
    }
    L.push('    // logic, in dependency order');
    for (const a of order) {
      const lines = [];
      const out = (k) => `n${netOfKey(k).ref.i}`;
      const t = a.block && a.block.type;
      if (a.spec) {
        const expr = a.spec.expr(a.ins.map((k, i) => (k ? ref(k) : num(a.spec.ins[i].def))), (id) => `p[${a.p[id]}]`, { w: (i) => Math.max(1, W(a.ins[i])) });
        lines.push(`${out(a.outs[0])} = ${expr};`);
      } else if (t === 'table') {
        const pts = G.tablePoints(a.block), j = tables.length;
        tables.push(pts);
        lines.push(`${out(a.outs[0])} = lut(${a.ins[0] ? ref(a.ins[0]) : '0'}, TX${j}, TY${j});`);
      } else if (G.ATOMS[t]) lines.push(`${out(a.outs[0])} = ${G.ATOMS[t].expr(a.ins.map(ref))};`);
      else if (t === 'split') {
        let lo = 0;
        a.outs.forEach((k, i) => {
          const n = a.parts[i];
          if (netOfKey(k).writers[0] === a) lines.push(`${out(k)} = ((${ref(a.ins[0])} >>> ${lo}) & ${mask(n)}) >>> 0;`);
          lo += n;
        });
      } else if (t === 'join') {
        let lo = 0;
        const terms = a.ins.map((k, i) => { const n = a.parts[i], term = `((${ref(k)} & ${mask(n)}) >>> 0)${lo ? ' * ' + Math.pow(2, lo) : ''}`; lo += n; return term; });
        lines.push(`${out(a.outs[0])} = ${terms.join(' + ')};`);
      } else lines.push(`${out(a.outs[0])} = ${G.GATES[t].expr(a.ins.map(ref), mask(W(a.outs[0])))};`);
      for (const line of lines) L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}`);
      nodeCode[a.path] = lines.join('\n');
    }
    L.push('    // outputs');
    outs.forEach((so, j) => {
      const line = `o${j}[i] = ${so.ins[0] && !open(so.ins[0]) ? `Math.max(-1, Math.min(1, ${ref(so.ins[0])}))` : '0'};`;
      L.push(`    ${line}`.padEnd(44) + `// ${so.path}  Out "${so.block.name || 'out'}"`);
      nodeCode[so.path] = line;
    });
    const snap = state.map((n, i) => `v[${i}] = s${i};`).concat(wires.map((n, i) => `v[${state.length + i}] = n${i};`))
      .concat(qs.map((n, i) => `v[${qSnap + i}] = q${i};`));
    if (snap.length) {
      L.push('    if (i === N - 1) { // what the wires and registers held during the last tick');
      for (let i = 0; i < snap.length; i += 8) L.push('      ' + snap.slice(i, i + 8).join(' '));
      L.push('    }');
    }
    const ffs = atoms.filter((a) => a.block.type === 'delay' && drives(a));
    if (ffs.length || dffs.length || analog.length) L.push('    // clock edge: every flip-flop latches its input at once' + (analog.length ? ',\n    // every analog module integrates across the next tick with its inputs held' : ''));
    if (ffs.length) L.push('    ' + ffs.map((a, j) => `const t${j} = ${ref(a.ins[0])};`).join(' '));
    if (dffs.length) L.push('    ' + dffs.map((a, j) => `const d${j} = ${ref(a.ins[0])};`).join(' '));
    // Analog inputs are read before any module updates, so the order of the updates doesn't matter.
    let u = 0;
    for (const md of analog) {
      md.u = md.ins.map((k) => (k ? 'u' + u++ : null));
      const reads = md.ins.map((k, i) => (k ? `const ${md.u[i]} = ${ref(k)};` : null)).filter(Boolean);
      if (reads.length) L.push('    ' + reads.join(' '));
    }
    for (const md of analog) {
      const spec = md.spec, scratch = [];
      const c = {
        in: (id) => { const i = spec.ins.findIndex((x) => x.id === id); return md.u[i] || num(spec.ins[i].def); },
        conn: (id) => !!md.u[spec.ins.findIndex((x) => x.id === id)],
        p: (id) => `p[${md.p[id]}]`,
        pIndex: (id) => md.p[id],
        s: (id) => 'q' + md.q[id],
        out: (id) => {
          const i = spec.outs.findIndex((x) => x.id === id), k = md.outs[i];
          if (k && netOfKey(k).writers[0] === md) return 's' + netOfKey(k).ref.i;
          if (!scratch.includes(i)) scratch.push(i);
          return '_o' + i;
        },
        used: (id) => { const k = md.outs[spec.outs.findIndex((x) => x.id === id)]; return !!(k && netOfKey(k).writers[0] === md); },
        seed: seedOf(md.path),
      };
      let body = spec.code(c);
      if (scratch.length) body = `let ${scratch.map((i) => '_o' + i + ' = 0').join(', ')};\n` + body;
      L.push(`    { // ${md.path}  ${title(md)}`);
      for (const line of body.split('\n')) L.push('      ' + line);
      L.push('    }');
      nodeCode[md.path] = body;
    }
    ffs.forEach((a, j) => {
      const line = `s${netOfKey(a.outs[0]).ref.i} = t${j};`;
      L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}`);
      nodeCode[a.path] = `s${netOfKey(a.outs[0]).ref.i} = ${ref(a.ins[0])};  (at the clock edge)`;
    });
    dffs.forEach((a, j) => {
      const q = a.outs[0];
      if (netOfKey(q).writers[0] !== a) return;
      const line = `s${netOfKey(q).ref.i} = d${j};`;
      L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}`);
      nodeCode[a.path] = `s${netOfKey(q).ref.i} = ${ref(a.ins[0])};  (at the clock edge)` + (a.outs[1] ? `\nQ̄ = ¬Q, within the tick` : '');
    });
    L.push('  }');
    if (state.length) L.push('  ' + state.map((n, i) => `s[${i}] = s${i};`).join(' '));
    if (qs.length) L.push('  ' + qs.map((n, i) => `s[${qBase + i}] = q${i};`).join(' '));
    L.push('};');
    if (tables.length) {
      L.splice(atLut, 0, '// Tables: their points, and the straight line between the two around x',
        'const lut = (x, X, Y) => { if (!(x > X[0])) return Y[0]; const n = X.length - 1; if (x >= X[n]) return Y[n]; let i = 1; while (X[i] < x) i++; return Y[i - 1] + (Y[i] - Y[i - 1]) * (x - X[i - 1]) / (X[i] - X[i - 1]); };',
        ...tables.map((pts, j) => `const TX${j} = ${JSON.stringify(pts.map((q) => q[0]))}, TY${j} = ${JSON.stringify(pts.map((q) => q[1]))};`));
    }

    const resources = { adder: 0, multiplier: 0, comparator: 0, mux: 0, buffer: 0, exp: 0, rom: 0,
      analog: analog.length, utility: mods.filter((md) => md.kind === 'logic').length,
      gate: gates.filter((g) => !['dff', 'split', 'join'].includes(g.block.type)).length, dff: gates.filter((g) => g.block.type === 'dff').length };
    for (const a of atoms) resources[G.ATOMS[a.block.type].cost]++;
    const qIndex = {};
    qs.forEach((n, i) => { qIndex[n] = qSnap + i; });

    return {
      ok: errors.length === 0, errors, warnings, problemPaths,
      code: L.join('\n'),
      nState: nS, nRegs: state.length, nNets: state.length + wires.length, nSnap: qSnap + qs.length,
      params: Float64Array.from(params),
      regNames: state.map((n) => n.keys[0]).concat(qs),
      outs: outs.map((so) => ({ path: so.path, name: so.block.name || 'out' })),
      ins: ins.map((so) => ({ path: so.path, name: so.block.name || 'in' })),
      netOf, widths, knobState, nodeCode, resources, critical, critDepth, paramIndex, qIndex,
      registers: state.map((n) => n.keys[0]),
      blocks: atoms.length + gates.length,
    };
  }

  // A fixed-point word: a whole number of `w` bits (two's complement for negatives).
  const clampW = (w) => Math.max(1, Math.min(32, Math.round(Number(w)) || 1));
  function word(v, w) { const m = Math.pow(2, w); v = Math.round(Number(v)) || 0; return ((v % m) + m) % m; }

  function instantiate(code) { return new Function(code)(); }

  const api = { compile, instantiate, word };
  if (node) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
