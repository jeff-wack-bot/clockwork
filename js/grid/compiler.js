// Grid compiler: every region is a register; every block is one pipeline stage.
(function (root) {
  'use strict';
  const G = (typeof module === 'object' && module.exports) ? require('./model.js') : root.GW;

  function compile(project) {
    const errors = [], warnings = [];
    const parent = new Map();           // union-find over region keys `${path}${rid}`
    const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const regions = new Map();          // key -> {path, sheet, rid, depth}
    const atoms = [];                   // {path, block, ins:[key|null], outs:[key|null]}
    const sinks = [];

    function visit(sheet, path, depth, chain) {
      for (const rid in sheet.regions) {
        const k = path + rid;
        parent.set(k, k);
        regions.set(k, { path, sheet, rid, depth, region: sheet.regions[rid] });
      }
      const regAt = (x, y) => { const r = sheet.top[G.key(x, y)]; return r ? path + r : null; };
      for (const b of sheet.blocks) {
        const fp = G.footprint(b, project.defs);
        const ins = fp.pads.filter((p) => p.dir === 'in').map((p) => regAt(p.x, p.y));
        const outs = fp.pads.filter((p) => p.dir === 'out').map((p) => regAt(p.x, p.y));
        if (G.ATOMS[b.type]) atoms.push({ path: path + b.id, block: b, ins, outs, chain });
        else if (G.SINKS[b.type]) sinks.push({ path: path + b.id, block: b, ins, chain });
        else if (b.type === 'comp') {
          const def = project.defs[b.def];
          if (!def) { errors.push({ msg: `Unknown block "${b.def}"`, path: path + b.id }); continue; }
          if (chain.includes(b.def)) { errors.push({ msg: `"${b.def}" contains itself`, path: path + b.id }); continue; }
          const childPath = path + b.id + '/';
          visit(def, childPath, depth + 1, chain.concat([b.def]));
          // A port is not a stage: the outer and inner regions become one register.
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
    const nets = new Map(); // root key -> {keys:[], writer:atom|null, index}
    for (const k of regions.keys()) {
      const r = find(k);
      if (!nets.has(r)) nets.set(r, { keys: [], writers: [] });
      nets.get(r).keys.push(k);
    }
    for (const a of atoms) {
      a.outs.forEach((k) => { if (k) nets.get(find(k)).writers.push(a); });
      a.ins.forEach((k, i) => {
        if (!k) warnings.push({ msg: `${G.ATOMS[a.block.type].title}: input "${G.ATOMS[a.block.type].ins[i][2]}" has no region (reads 0)`, path: a.path });
      });
    }
    for (const s of sinks) if (s.block.type === 'dac' && !s.ins[0]) warnings.push({ msg: 'DAC has no region on its pad', path: s.path });

    const state = [], params = [];       // driven nets -> registers; unwritten nets -> parameters
    const netOf = {};                    // region key -> {k:'s'|'p', i}
    const knobState = {};                // region key -> 'ok' | 'written' | 'overridden'
    const problemPaths = [];
    for (const net of nets.values()) {
      net.keys.sort((a, b) => regions.get(a).depth - regions.get(b).depth);
      if (net.writers.length > 1) {
        errors.push({ msg: `A register has ${net.writers.length} writers (${net.writers.map((w) => w.path).join(', ')}). A region may be written by only one block.`, path: net.writers[0].path });
        net.writers.forEach((w) => problemPaths.push(w.path));
      }
      if (net.writers.length) {
        net.ref = { k: 's', i: state.length };
        state.push(net);
        for (const k of net.keys) if (regions.get(k).region.knob) knobState[k] = 'written';
      } else {
        // The outermost region sets an unwritten register (a knob there is preferred);
        // regions further inside are defaults that something outside overrides.
        const top = regions.get(net.keys[0]).depth;
        const withKnob = net.keys.filter((k) => regions.get(k).region.knob);
        const src = withKnob.find((k) => regions.get(k).depth === top) || net.keys[0];
        const reg = regions.get(src);
        const ov = project.values && project.values[src];
        net.ref = { k: 'p', i: params.length };
        params.push(Number(ov !== undefined && reg.depth > 0 ? ov : reg.region.value) || 0);
        net.source = src;
        for (const k of withKnob) knobState[k] = k === src ? 'ok' : 'overridden';
      }
      for (const k of net.keys) netOf[k] = net.ref;
    }

    // ---- code generation ----------------------------------------------------
    const ref = (k) => {
      if (!k) return '0';
      const r = nets.get(find(k)).ref;
      return r.k === 's' ? 's' + r.i : `p[${r.i}]`;
    };
    const title = (a) => a.chain.concat([G.info(a.block.type).title]).join(' › ');
    const L = [];
    L.push('// Clockwork Grid program. Every region is a register; every block is one pipeline stage.');
    L.push(`// s0…s${Math.max(0, state.length - 1)} = ${state.length} written registers, p[] = ${params.length} unwritten (constant) registers`);
    L.push('return function run(N, p, s, d, sc, v) {');
    if (state.length) L.push('  let ' + state.map((n, i) => `s${i} = s[${i}]`).join(', ') + ';');
    L.push('  for (let i = 0; i < N; i++) {');
    const dacs = sinks.filter((x) => x.block.type === 'dac' && x.ins[0]);
    L.push('    // sinks read the registers as they are during this tick');
    L.push(dacs.length ? `    d[i] = Math.max(-1, Math.min(1, ${dacs.map((x) => ref(x.ins[0])).join(' + ')}));` : '    d[i] = 0;');
    const scopes = sinks.filter((x) => x.block.type === 'scope');
    scopes.forEach((x, j) => L.push(`    sc[${j}][i] = ${ref(x.ins[0])};`.padEnd(42) + `// ${x.path} Scope`));
    L.push('    // every block computes its next value from the current registers…');
    const nodeCode = {};
    const latches = [];
    for (const a of atoms) {
      const out = a.outs[0];
      if (!out) continue;
      const net = nets.get(find(out));
      if (net.writers[0] !== a) continue;
      const t = 't' + net.ref.i;
      const line = `const ${t} = ${G.ATOMS[a.block.type].expr(a.ins.map(ref))};`;
      L.push(`    ${line}`.padEnd(42) + `// ${a.path}  ${title(a)}`);
      nodeCode[a.path] = line;
      latches.push(`s${net.ref.i} = ${t};`);
    }
    if (latches.length) {
      L.push('    // …and all registers latch at once (the clock edge)');
      for (let i = 0; i < latches.length; i += 8) L.push('    ' + latches.slice(i, i + 8).join(' '));
    }
    L.push('  }');
    if (state.length) L.push('  ' + state.map((n, i) => `s[${i}] = v[${i}] = s${i};`).join(' '));
    L.push('};');

    // ---- analysis -----------------------------------------------------------
    const resources = { adder: 0, multiplier: 0, comparator: 0, mux: 0, buffer: 0 };
    for (const a of atoms) resources[G.ATOMS[a.block.type].cost]++;
    // Feedback loops: cycles in the graph register -> block -> register.
    const succ = state.map(() => new Set());
    for (const a of atoms) {
      if (!a.outs[0]) continue;
      const to = nets.get(find(a.outs[0])).ref;
      if (to.k !== 's') continue;
      for (const k of a.ins) {
        if (!k) continue;
        const from = nets.get(find(k)).ref;
        if (from.k === 's') succ[from.i].add(to.i);
      }
    }
    const loops = shortestLoops(succ).map((cycle) => ({
      latency: cycle.length,
      regions: cycle.map((i) => state[i].keys[0]),
    }));

    return {
      ok: errors.length === 0, errors, warnings, problemPaths,
      code: L.join('\n'), nState: state.length,
      params: Float64Array.from(params),
      regNames: state.map((n) => n.keys[0]),
      scopePaths: scopes.map((x) => x.path),
      netOf, knobState, nodeCode, resources, loops,
      blocks: atoms.length,
    };
  }

  // For every strongly connected component, the shortest cycle through it.
  function shortestLoops(succ) {
    const n = succ.length, index = new Array(n).fill(-1), low = new Array(n), on = new Array(n).fill(false);
    const stack = [], comps = [];
    let counter = 0;
    function strong(v) {
      index[v] = low[v] = counter++; stack.push(v); on[v] = true;
      for (const w of succ[v]) {
        if (index[w] < 0) { strong(w); low[v] = Math.min(low[v], low[w]); }
        else if (on[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (low[v] === index[v]) {
        const c = [];
        let w;
        do { w = stack.pop(); on[w] = false; c.push(w); } while (w !== v);
        comps.push(c);
      }
    }
    for (let v = 0; v < n; v++) if (index[v] < 0) strong(v);
    const out = [];
    for (const c of comps) {
      if (c.length === 1 && !succ[c[0]].has(c[0])) continue;
      const inC = new Set(c);
      let best = null;
      for (const s of c) {
        const prev = new Map([[s, null]]), q = [s];
        let hit = null;
        for (let i = 0; i < q.length && hit === null; i++) {
          for (const w of succ[q[i]]) {
            if (!inC.has(w)) continue;
            if (w === s) { hit = q[i]; break; }
            if (!prev.has(w)) { prev.set(w, q[i]); q.push(w); }
          }
        }
        if (hit === null) continue;
        const cyc = [];
        for (let x = hit; x !== null; x = prev.get(x)) cyc.unshift(x);
        if (!best || cyc.length < best.length) best = cyc;
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => a.length - b.length);
  }

  function instantiate(code) { return new Function(code)(); }

  const api = { compile, instantiate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, api);
})(typeof self !== 'undefined' ? self : this);
