// Compiler: project (hierarchical patch) -> flat netlist -> straight-line JavaScript.
(function (root) {
  'use strict';
  const B = (typeof module === 'object' && module.exports) ? require('./blocks.js') : root.CW;

  const MAX_TRACE = 2000;

  function compile(project) {
    const errors = [];   // {msg, path}
    const warnings = []; // {msg, path}
    const nodes = [];    // atomic + sink blocks of the flattened design
    const nets = [];     // nets[k] = {node, port}
    const portNets = {}; // `${ctxPath}|${blockId}|${port}` -> net (for live display)
    const contexts = [];

    // ---- 1. Expand the hierarchy -------------------------------------------
    function makeCtx(patch, path, parent, inst, chain) {
      const ctx = {
        patch, path, parent, inst, chain,
        byId: new Map(), wireTo: new Map(), nodeById: new Map(), children: {},
        inlets: B.boundary(patch, 'inlet'), outlets: B.boundary(patch, 'outlet'),
      };
      for (const b of patch.blocks) ctx.byId.set(b.id, b);
      const fanout = new Map();
      for (const w of patch.wires) {
        const key = w.to[0] + ':' + w.to[1];
        if (ctx.wireTo.has(key)) errors.push({ msg: `Input ${key} has two drivers`, path: path + w.to[0] });
        ctx.wireTo.set(key, w);
        const fk = w.from[0] + ':' + w.from[1];
        fanout.set(fk, (fanout.get(fk) || 0) + 1);
      }
      for (const [fk, n] of fanout) {
        if (n > 1) errors.push({ msg: `Output ${fk} drives ${n} inputs — use a Copy block to fan out`, path: path + fk.split(':')[0] });
      }
      contexts.push(ctx);
      return ctx;
    }

    function expand(ctx) {
      for (const b of ctx.patch.blocks) {
        if (B.ATOMS[b.type] || b.type === 'dac' || b.type === 'scope') {
          const nOut = B.ATOMS[b.type] ? B.ATOMS[b.type].outs.length : 0;
          const node = { path: ctx.path + b.id, block: b, type: b.type, ctx, inputs: [], outNets: [] };
          for (let k = 0; k < nOut; k++) { node.outNets.push(nets.length); nets.push({ node, port: k }); }
          ctx.nodeById.set(b.id, node);
          nodes.push(node);
        } else if (b.type === 'comp') {
          const def = project.defs[b.def];
          if (!def) { errors.push({ msg: `Unknown block type "${b.def}"`, path: ctx.path + b.id }); continue; }
          if (ctx.chain.includes(b.def)) { errors.push({ msg: `"${b.def}" contains itself`, path: ctx.path + b.id }); continue; }
          const child = makeCtx(def, ctx.path + b.id + '/', ctx, b, ctx.chain.concat([b.def]));
          ctx.children[b.id] = child;
          expand(child);
        }
      }
    }

    const rootCtx = makeCtx(project.root, '', null, null, []);
    expand(rootCtx);

    // ---- 2. Resolve every input to the atomic output that drives it ---------
    // Inlets, outlets and composite boundaries are pure wiring and vanish here.
    let trace = 0;
    function driver(ctx, blockId, port) {
      const w = ctx.wireTo.get(blockId + ':' + port);
      return w ? source(ctx, w.from[0], w.from[1]) : -1;
    }
    function source(ctx, id, port) {
      if (++trace > MAX_TRACE) throw new Error('loop of pure wires');
      const b = ctx.byId.get(id);
      if (!b) return -1;
      if (b.type === 'inlet') {
        if (!ctx.parent) return -1;
        return driver(ctx.parent, ctx.inst.id, ctx.inlets.indexOf(b));
      }
      if (b.type === 'comp') {
        const child = ctx.children[id];
        const ob = child && child.outlets[port];
        return ob ? driver(child, ob.id, 0) : -1;
      }
      const node = ctx.nodeById.get(id);
      return node && port < node.outNets.length ? node.outNets[port] : -1;
    }
    function resolve(fn) {
      trace = 0;
      try { return fn(); } catch (e) { return -2; }
    }

    for (const node of nodes) {
      const nIn = B.info(node.type).ins.length;
      for (let i = 0; i < nIn; i++) {
        const net = resolve(() => driver(node.ctx, node.block.id, i));
        if (net === -2) errors.push({ msg: 'Wires form a loop through composite boundaries', path: node.path });
        node.inputs.push(net < 0 ? -1 : net);
        if (net === -1 && node.type !== 'scope') {
          warnings.push({ msg: `${B.info(node.type).title}: input "${B.info(node.type).ins[i]}" is unconnected (reads 0)`, path: node.path });
        }
      }
    }
    for (const ctx of contexts) {
      for (const b of ctx.patch.blocks) {
        const n = B.ports(b, project.defs).outs.length;
        for (let k = 0; k < n; k++) portNets[ctx.path + '|' + b.id + '|' + k] = resolve(() => source(ctx, b.id, k));
      }
    }

    // ---- 3. Parameters (constants live in an array so knobs never recompile)
    const params = [];
    for (const node of nodes) {
      if (node.type !== 'const') continue;
      node.param = params.length;
      params.push(Number(B.controlValue(node.ctx.inst, node.block)) || 0);
    }

    // ---- 4. Schedule the combinational logic (Kahn's algorithm) -------------
    // Registers (unit delays) break dependencies: their output is last tick's value.
    const comb = nodes.filter((n) => n.type !== 'delay');
    const producer = (net) => nets[net].node;
    const succ = new Map(comb.map((n) => [n, []]));
    const indeg = new Map(comb.map((n) => [n, 0]));
    for (const n of comb) {
      for (const net of n.inputs) {
        if (net < 0) continue;
        const p = producer(net);
        if (p.type === 'delay') continue;
        succ.get(p).push(n);
        indeg.set(n, indeg.get(n) + 1);
      }
    }
    const order = [];
    const queue = comb.filter((n) => indeg.get(n) === 0);
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      for (const s of succ.get(n)) {
        indeg.set(s, indeg.get(s) - 1);
        if (indeg.get(s) === 0) queue.push(s);
      }
    }
    const problemPaths = [];
    if (order.length < comb.length) {
      // Peel off nodes that merely hang off the loop, leaving the loop itself.
      const left = new Set(comb.filter((n) => !order.includes(n)));
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of left) {
          if (!succ.get(n).some((s) => left.has(s))) { left.delete(n); changed = true; }
        }
      }
      for (const n of left) problemPaths.push(n.path);
      errors.push({
        msg: `Combinational loop: ${[...left].map((n) => n.path).join(' → ')}. Every feedback loop needs a Unit delay.`,
        path: problemPaths[0],
      });
    }
    for (const e of errors) if (e.path && !problemPaths.includes(e.path)) problemPaths.push(e.path);

    // ---- 5. Analysis: resources and critical path ---------------------------
    const resources = { adder: 0, multiplier: 0, comparator: 0, mux: 0, register: 0, constant: 0, copy: 0 };
    for (const n of nodes) {
      const c = B.ATOMS[n.type] && B.ATOMS[n.type].cost;
      if (c) resources[c]++;
      if (n.type === 'const') resources.constant++;
      if (n.type === 'copy') resources.copy++;
    }
    const opsPerTick = resources.adder + resources.multiplier + resources.comparator + resources.mux;
    const depth = new Map();
    const via = new Map();
    for (const n of order) {
      let best = 0, bestP = null;
      for (const net of n.inputs) {
        if (net < 0) continue;
        const p = producer(net);
        if (p.type === 'delay') continue;
        const d = depth.get(p) || 0;
        if (d > best) { best = d; bestP = p; }
      }
      const own = (B.ATOMS[n.type] && B.ATOMS[n.type].cost) ? 1 : 0;
      depth.set(n, best + own);
      via.set(n, bestP);
    }
    let critEnd = null, critDepth = 0;
    for (const [n, d] of depth) if (d > critDepth) { critDepth = d; critEnd = n; }
    const critical = [];
    for (let n = critEnd; n; n = via.get(n)) {
      if (B.ATOMS[n.type] && B.ATOMS[n.type].cost) critical.unshift({ path: n.path, name: n.ctx.chain.concat([B.info(n.type).title]).join(' › ') });
    }

    // ---- 6. Code generation -------------------------------------------------
    const nv = (net) => (net < 0 ? '0' : 'n' + net);
    const registers = nodes.filter((n) => n.type === 'delay');
    const dacs = nodes.filter((n) => n.type === 'dac');
    const scopes = nodes.filter((n) => n.type === 'scope');
    const nodeCode = {};
    const label = (n) => `${n.path}  ${n.ctx.chain.concat([B.info(n.type).title]).join(' › ')}${n.block.label ? ' "' + n.block.label + '"' : ''}`;
    const L = [];
    L.push('// Clockwork compiled program. One call runs N ticks of the clock.');
    L.push(`// p = parameters (${params.length} constants), r = register state (${registers.length} unit delays)`);
    L.push(`// d = DAC output buffer, sc = scope buffers, v = snapshot of all ${nets.length} wires`);
    L.push('return function run(N, p, r, d, sc, v) {');
    if (registers.length) {
      L.push('  // registers: state that survives from one tick to the next');
      L.push('  let ' + registers.map((n, i) => `${nv(n.outNets[0])} = r[${i}]`).join(', ') + ';');
    }
    const combNets = order.filter((n) => n.outNets.length).flatMap((n) => n.outNets);
    if (combNets.length) {
      L.push('  // wires: combinational values, recomputed every tick');
      for (let i = 0; i < combNets.length; i += 12) {
        L.push('  let ' + combNets.slice(i, i + 12).map((k) => `n${k} = 0`).join(', ') + ';');
      }
    }
    L.push('  for (let i = 0; i < N; i++) {');
    L.push('    // ---- combinational logic, in dependency order');
    for (const n of order) {
      let line = null;
      if (n.type === 'const') line = `${nv(n.outNets[0])} = p[${n.param}];`;
      else if (n.type === 'copy') line = `${nv(n.outNets[0])} = ${nv(n.inputs[0])}; ${nv(n.outNets[1])} = ${nv(n.inputs[0])};`;
      else if (B.ATOMS[n.type]) line = `${nv(n.outNets[0])} = ${B.ATOMS[n.type].expr(n.inputs.map(nv))};`;
      if (line) { L.push(`    ${line.padEnd(38)} // ${label(n)}`); nodeCode[n.path] = line; }
    }
    L.push('    // ---- outputs');
    const dacExpr = dacs.length ? dacs.map((n) => nv(n.inputs[0])).join(' + ') : '0';
    L.push(dacs.length ? `    d[i] = Math.max(-1, Math.min(1, ${dacExpr}));` : '    d[i] = 0;');
    for (const n of dacs) nodeCode[n.path] = `d[i] += ${nv(n.inputs[0])}  (then clipped to ±1)`;
    scopes.forEach((n, k) => {
      const line = `sc[${k}][i] = ${nv(n.inputs[0])};`;
      L.push(`    ${line.padEnd(38)} // ${label(n)}`);
      nodeCode[n.path] = line;
    });
    L.push('    if (i === N - 1) { // snapshot of the last tick, for display');
    for (let k = 0; k < nets.length; k += 8) {
      const chunk = [];
      for (let j = k; j < Math.min(k + 8, nets.length); j++) chunk.push(`v[${j}] = n${j};`);
      L.push('      ' + chunk.join(' '));
    }
    L.push('    }');
    if (registers.length) {
      L.push('    // ---- clock edge: all registers latch simultaneously');
      if (registers.length === 1) {
        const n = registers[0];
        const line = `${nv(n.outNets[0])} = ${nv(n.inputs[0])};`;
        L.push(`    ${line.padEnd(38)} // ${label(n)}`);
        nodeCode[n.path] = `${line}  (at the clock edge)`;
      } else {
        L.push('    const ' + registers.map((n, i) => `t${i} = ${nv(n.inputs[0])}`).join(', ') + ';');
        registers.forEach((n, i) => {
          const line = `${nv(n.outNets[0])} = t${i};`;
          L.push(`    ${line.padEnd(38)} // ${label(n)}`);
          nodeCode[n.path] = `${nv(n.outNets[0])} = ${nv(n.inputs[0])};  (at the clock edge)`;
        });
      }
    }
    L.push('  }');
    if (registers.length) L.push('  ' + registers.map((n, i) => `r[${i}] = ${nv(n.outNets[0])};`).join(' '));
    L.push('};');

    return {
      ok: errors.length === 0,
      errors, warnings, problemPaths,
      code: L.join('\n'),
      params: Float64Array.from(params),
      regNames: registers.map((n) => n.path),
      nNets: nets.length,
      scopePaths: scopes.map((n) => n.path),
      portNets, nodeCode,
      resources, opsPerTick, critical, critDepth: critDepth,
      blockCount: nodes.length,
    };
  }

  // Build the runnable function from generated code (used by both threads).
  function instantiate(code) { return new Function(code)(); }

  const api = { compile, instantiate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CW = Object.assign(root.CW || {}, api);
})(typeof self !== 'undefined' ? self : this);
