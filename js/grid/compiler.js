// Board compiler. Nets are wires carrying this tick's value; logic ICs (Add,
// Multiply, Greater-than, Switch) settle within the tick; the Delay is a
// flip-flop: the net it writes is a register, the only state there is.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;

  function compile(project) {
    const errors = [], warnings = [];
    const parent = new Map();           // union-find over net keys `${path}${rid}`
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const regions = new Map();          // key -> {path, sheet, rid, depth, region}
    const atoms = [];                   // {path, block, ins:[key|null], outs:[key|null], chain}
    const sinks = [];

    function visit(sheet, path, depth, chain) {
      for (const rid in sheet.regions) {
        const k = path + rid;
        parent.set(k, k);
        regions.set(k, { path, sheet, rid, depth, region: sheet.regions[rid] });
      }
      const netAt = (x, y) => { const r = sheet.top[G.key(x, y)]; return r ? path + r : null; };
      for (const b of sheet.blocks) {
        const fp = G.footprint(b, project.defs);
        const ins = fp.pads.filter((p) => p.dir === 'in').map((p) => netAt(p.x, p.y));
        const outs = fp.pads.filter((p) => p.dir === 'out').map((p) => netAt(p.x, p.y));
        if (G.ATOMS[b.type]) atoms.push({ path: path + b.id, block: b, ins, outs, chain });
        else if (G.SINKS[b.type]) sinks.push({ path: path + b.id, block: b, ins, chain });
        else if (b.type === 'comp') {
          const def = project.defs[b.def];
          if (!def) { errors.push({ msg: `Unknown IC "${b.def}"`, path: path + b.id }); continue; }
          if (chain.includes(b.def)) { errors.push({ msg: `"${b.def}" contains itself`, path: path + b.id }); continue; }
          const childPath = path + b.id + '/';
          visit(def, childPath, depth + 1, chain.concat([b.def]));
          // A pin is just copper: the outer and inner nets are the same net.
          for (const ip of G.innerPads(def)) {
            const inner = def.top[G.key(ip.x, ip.y)];
            const outer = (ip.dir === 'in' ? ins : outs)[ip.idx];
            if (inner && outer) union(outer, childPath + inner);
          }
        }
      }
    }
    visit(project.root, '', 0, []);

    // ---- nets and their writers ---------------------------------------------
    const nets = new Map();
    for (const k of regions.keys()) {
      const r = find(k);
      if (!nets.has(r)) nets.set(r, { keys: [], writers: [] });
      nets.get(r).keys.push(k);
    }
    const netOfKey = (k) => (k ? nets.get(find(k)) : null);
    for (const a of atoms) {
      a.outs.forEach((k) => { if (k) netOfKey(k).writers.push(a); });
      a.ins.forEach((k, i) => {
        if (!k) warnings.push({ msg: `${G.ATOMS[a.block.type].title}: input "${G.ATOMS[a.block.type].ins[i][2] || 'x'}" is not connected (reads 0)`, path: a.path });
      });
    }
    for (const s of sinks) if (s.block.type === 'dac' && !s.ins[0]) warnings.push({ msg: 'DAC pin is not connected', path: s.path });

    const problemPaths = [];
    const state = [], wires = [], params = [];
    const netOf = {}, knobState = {};
    for (const net of nets.values()) {
      net.keys.sort((a, b) => regions.get(a).depth - regions.get(b).depth);
      if (net.writers.length > 1) {
        errors.push({ msg: `A net has ${net.writers.length} writers (${net.writers.map((w) => w.path).join(', ')}). Only one IC may drive a net.`, path: net.writers[0].path });
        net.writers.forEach((w) => problemPaths.push(w.path));
      }
      const w = net.writers[0];
      if (w && w.block.type === 'delay') { net.ref = { k: 's', i: state.length }; state.push(net); }
      else if (w) { net.ref = { k: 'n', i: wires.length }; wires.push(net); }
      else {
        // Unwritten: a constant. The outermost net segment sets it (a knob there is
        // preferred); segments further inside are defaults that the outside overrides.
        const top = regions.get(net.keys[0]).depth;
        const withKnob = net.keys.filter((k) => regions.get(k).region.knob);
        const src = withKnob.find((k) => regions.get(k).depth === top) || net.keys[0];
        const reg = regions.get(src), ov = project.values && project.values[src];
        net.ref = { k: 'p', i: params.length };
        params.push(Number(ov !== undefined && reg.depth > 0 ? ov : reg.region.value) || 0);
        for (const k of withKnob) knobState[k] = k === src ? 'ok' : 'overridden';
      }
      if (w) for (const k of net.keys) if (regions.get(k).region.knob) knobState[k] = 'written';
      for (const k of net.keys) netOf[k] = net.ref;
    }
    // Snapshot layout: registers first, then wires.
    const vIndex = (ref) => (ref.k === 's' ? ref.i : state.length + ref.i);
    for (const k in netOf) if (netOf[k].k !== 'p') netOf[k] = Object.assign({ v: vIndex(netOf[k]) }, netOf[k]);

    // ---- schedule the logic (Kahn) --------------------------------------------
    const logic = atoms.filter((a) => a.block.type !== 'delay' && a.outs[0] && netOfKey(a.outs[0]).writers[0] === a);
    const writerOf = (k) => { const n = netOfKey(k); return n && n.writers[0]; };
    const deps = new Map(logic.map((a) => [a, []]));
    const users = new Map(logic.map((a) => [a, []]));
    for (const a of logic) {
      for (const k of a.ins) {
        const w = k && writerOf(k);
        if (w && w.block.type !== 'delay' && deps.has(w)) { deps.get(a).push(w); users.get(w).push(a); }
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
      errors.push({ msg: `Feedback loop without a flip-flop: ${[...left].map((a) => a.path).join(' → ')}. Put a Delay somewhere in the loop.`, path: [...left][0].path });
    }

    // ---- critical path: the longest chain of logic between flip-flops --------
    const depth = new Map(), via = new Map();
    for (const a of order) {
      let best = 0, bp = null;
      for (const d of deps.get(a)) if ((depth.get(d) || 0) > best) { best = depth.get(d); bp = d; }
      depth.set(a, best + 1); via.set(a, bp);
    }
    let end = null, critDepth = 0;
    for (const [a, d] of depth) if (d > critDepth) { critDepth = d; end = a; }
    const critical = [];
    for (let a = end; a; a = via.get(a)) critical.unshift({ path: a.path, name: a.chain.concat([G.ATOMS[a.block.type].title]).join(' › ') });

    // ---- code generation ------------------------------------------------------
    const ref = (k) => {
      if (!k) return '0';
      const r = netOfKey(k).ref;
      return r.k === 's' ? 's' + r.i : r.k === 'n' ? 'n' + r.i : `p[${r.i}]`;
    };
    const title = (a) => a.chain.concat([G.info(a.block.type).title]).join(' › ');
    const nodeCode = {};
    const L = [];
    L.push('// Clockwork Board program. Wires settle within the tick; flip-flops (Delays) hold state.');
    L.push(`// s = ${state.length} registers, n = ${wires.length} wires, p[] = ${params.length} constants`);
    L.push('return function run(N, p, s, d, sc, v) {');
    if (state.length) L.push('  let ' + state.map((n, i) => `s${i} = s[${i}]`).join(', ') + ';');
    for (let i = 0; i < wires.length; i += 12) L.push('  let ' + wires.slice(i, i + 12).map((n, j) => `n${i + j} = 0`).join(', ') + ';');
    L.push('  for (let i = 0; i < N; i++) {');
    L.push('    // logic, in dependency order');
    for (const a of order) {
      const line = `n${netOfKey(a.outs[0]).ref.i} = ${G.ATOMS[a.block.type].expr(a.ins.map(ref))};`;
      L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}`);
      nodeCode[a.path] = line;
    }
    const dacs = sinks.filter((x) => x.block.type === 'dac' && x.ins[0]);
    L.push('    // outputs');
    L.push(dacs.length ? `    d[i] = Math.max(-1, Math.min(1, ${dacs.map((x) => ref(x.ins[0])).join(' + ')}));` : '    d[i] = 0;');
    const scopes = sinks.filter((x) => x.block.type === 'scope');
    scopes.forEach((x, j) => L.push(`    sc[${j}][i] = ${ref(x.ins[0])};`.padEnd(44) + `// ${x.path} Scope`));
    const snap = state.map((n, i) => `v[${i}] = s${i};`).concat(wires.map((n, i) => `v[${state.length + i}] = n${i};`));
    if (snap.length) {
      L.push('    if (i === N - 1) { // what the wires and registers held during the last tick');
      for (let i = 0; i < snap.length; i += 8) L.push('      ' + snap.slice(i, i + 8).join(' '));
      L.push('    }');
    }
    const ffs = atoms.filter((a) => a.block.type === 'delay' && a.outs[0] && netOfKey(a.outs[0]).writers[0] === a);
    if (ffs.length) {
      L.push('    // clock edge: every flip-flop latches its input at once');
      L.push('    ' + ffs.map((a, j) => `const t${j} = ${ref(a.ins[0])};`).join(' '));
      ffs.forEach((a, j) => {
        const line = `s${netOfKey(a.outs[0]).ref.i} = t${j};`;
        L.push(`    ${line}`.padEnd(44) + `// ${a.path}  ${title(a)}`);
        nodeCode[a.path] = `s${netOfKey(a.outs[0]).ref.i} = ${ref(a.ins[0])};  (at the clock edge)`;
      });
    }
    L.push('  }');
    if (state.length) L.push('  ' + state.map((n, i) => `s[${i}] = s${i};`).join(' '));
    L.push('};');

    const resources = { adder: 0, multiplier: 0, comparator: 0, mux: 0, buffer: 0 };
    for (const a of atoms) resources[G.ATOMS[a.block.type].cost]++;

    return {
      ok: errors.length === 0, errors, warnings, problemPaths,
      code: L.join('\n'),
      nState: state.length, nNets: state.length + wires.length,
      params: Float64Array.from(params),
      regNames: state.map((n) => n.keys[0]),
      scopePaths: scopes.map((x) => x.path),
      netOf, knobState, nodeCode, resources, critical, critDepth,
      registers: state.map((n) => n.keys[0]),
      blocks: atoms.length,
    };
  }

  function instantiate(code) { return new Function(code)(); }

  const api = { compile, instantiate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
