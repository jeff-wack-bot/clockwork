// From painted copper to wires: converts boards drawn in the old two-layer model
// (nets as painted regions on a top and a bottom layer, joined by vias) into the
// wire model (pin-to-pin wires with routes). Used by format version 2 → 3 and for
// projects saved in the browser before the change.
//
// Every net becomes wires from its source to each pin that reads it, and each
// wire's route follows the net's own cells (through its vias), so a hand-drawn
// layout keeps its shape. A net nobody drives becomes a Constant block, placed
// at the net's knob, else at the free end of its stub. A net driven by an input
// port of a definition gives that port its default value (and knob).
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const G = node ? require('./model.js') : root.GW;
  const TOP = 'top', BOT = 'bot';
  const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;

  // A pin signature ("5x3 in@0:Hz out@0:phase out@2:wrap") back to a footprint.
  function defFromSig(name, sig) {
    const [size, ...ps] = sig.split(' ');
    const [fw, fh] = size.split('x').map(Number);
    return { name, fw, fh, s: 8, blocks: [], ports: ps.map((p) => { const m = /^(in|out)@(\d+):(.*)$/.exec(p); return { dir: m[1], row: Number(m[2]), name: m[3] }; }) };
  }

  // sheet: { blocks, nextId, regions: {rid: {value, knob}}, top: {key: rid}, bot: {key: rid} } plus, for a
  // definition, its fw/fh/s/ports. defs: footprints of the blocks it contains.
  // Returns { sheet (wire model), ports: port index -> {value, knob}, renamed: rid -> new value key, report }.
  function convertSheet(old, defs) {
    const isDef = old.fw !== undefined;
    const sheet = G.makeSheet(isDef ? { name: old.name, fw: old.fw, fh: old.fh, s: old.s, description: old.description || '',
      ports: old.ports.map((p) => Object.assign({}, p)) } : {});
    sheet.blocks = old.blocks.map((b) => JSON.parse(JSON.stringify(b)));
    sheet.nextId = old.nextId || 1;
    const cells = {};   // rid -> {top: Set, bot: Set}
    for (const layer of [TOP, BOT]) for (const k in old[layer] || {}) {
      const rid = old[layer][k];
      (cells[rid] = cells[rid] || { top: new Set(), bot: new Set() })[layer].add(k);
    }
    const report = { nets: 0, wires: 0, constants: 0, dropped: [] };
    const renamed = {}, ports = {};
    let occ = G.occupancy(sheet, defs);
    const padEp = (o) => (o.port ? G.ep('port', o.pad.dir, o.pad.idx) : G.ep(o.block.id, o.pad.dir, o.pad.idx));
    const states = (rid, l, k) => {   // neighbours in the net: 4 on the same layer, and the via
      const [x, y] = G.unkey(k), out = [];
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) { const nk = G.key(nx, ny); if (cells[rid][l].has(nk)) out.push([l, nk]); }
      const ol = l === TOP ? BOT : TOP;
      if (cells[rid][ol].has(k)) out.push([ol, k]);
      return out;
    };
    for (const rid of Object.keys(old.regions || {}).sort((a, b) => idNum(a) - idNum(b))) {
      const reg = old.regions[rid];
      if (!cells[rid]) continue;
      report.nets++;
      const pads = [...cells[rid].top].map((k) => occ.get(k)).filter((o) => o && o.pad);
      const isSrc = (o) => (o.port ? o.pad.dir === 'in' : o.pad.dir === 'out');
      const sources = pads.filter(isSrc), sinks = pads.filter((o) => !isSrc(o));
      if (!sinks.length) { if (pads.length || cells[rid].top.size) report.dropped.push(rid + ' (nothing reads it)'); continue; }
      let start, from, extra = null;
      if (sources.length) {
        const s = sources[0];
        if (sources.length > 1) report.dropped.push(`${rid}: ${sources.length - 1} extra driver(s)`);
        start = [TOP, G.key(s.pad.x, s.pad.y)]; from = padEp(s);
        if (s.port) {
          ports[s.pad.idx] = { value: reg.value || 0, knob: reg.knob ? { label: reg.knob.label || '', min: reg.knob.min, max: reg.knob.max, scale: reg.knob.scale || 'lin' } : null };
          renamed[rid] = G.ep('port', 'in', s.pad.idx);
        }
      } else {
        // a constant: at its knob if that cell is free, else at the free end of the stub
        const free = (k) => !occ.has(k);
        let at = null;
        if (reg.knob) { const kk = G.key(reg.knob.x, reg.knob.y); if ((cells[rid].top.has(kk) || cells[rid].bot.has(kk)) && free(kk)) at = kk; }
        if (!at) {
          const dist = new Map(), q = sinks.map((o) => [TOP, G.key(o.pad.x, o.pad.y)]);
          q.forEach(([l, k]) => dist.set(l + k, 0));
          let best = null, bestD = -1;
          for (let i = 0; i < q.length; i++) {
            const [l, k] = q[i], d = dist.get(l + k);
            if (free(k) && d > bestD) { best = k; bestD = d; }
            for (const [nl, nk] of states(rid, l, k)) if (!dist.has(nl + nk)) { dist.set(nl + nk, d + 1); q.push([nl, nk]); }
          }
          at = best;
        }
        if (!at) {   // every cell is a pin: put it next to the first one
          const s = sinks[0], [x, y] = G.nearestFree(sheet, defs, s.pad.x, s.pad.y);
          at = G.key(x, y); extra = at;
        }
        const [x, y] = G.unkey(at);
        const c = { id: rid, type: 'const', x, y, rot: 0, value: reg.value || 0 };
        if (reg.knob) c.knob = { label: reg.knob.label || '', min: reg.knob.min, max: reg.knob.max, scale: reg.knob.scale || 'lin' };
        sheet.blocks.push(c);
        occ = G.occupancy(sheet, defs);
        report.constants++;
        start = [cells[rid].top.has(at) || extra ? TOP : BOT, at]; from = G.ep(rid, 'out', 0);
      }
      // routes: the net's own cells, breadth first from the source
      const prev = new Map([[start[0] + start[1], null]]), q = [start];
      if (extra) {   // the constant sits beside the net: step onto it at the pin
        const s = sinks[0], k = G.key(s.pad.x, s.pad.y);
        prev.set(TOP + k, start); q.push([TOP, k]);
      }
      for (let i = 0; i < q.length; i++) {
        for (const nx of states(rid, q[i][0], q[i][1])) if (!prev.has(nx[0] + nx[1])) { prev.set(nx[0] + nx[1], q[i]); q.push(nx); }
      }
      for (const o of sinks) {
        const end = [TOP, G.key(o.pad.x, o.pad.y)];
        if (!prev.has(end[0] + end[1])) { report.dropped.push(`${rid}: pin ${padEp(o)} unreachable`); continue; }
        const path = [];
        for (let st = end; st; st = prev.get(st[0] + st[1])) {
          const c = G.unkey(st[1]);
          if (!path.length || path[0][0] !== c[0] || path[0][1] !== c[1]) path.unshift(c);   // a via is one cell
        }
        const w = { id: 'w' + sheet.nextId++, from, to: padEp(o) };
        if (path.length >= 2) w.path = path;
        sheet.wires.push(w);
        report.wires++;
      }
    }
    for (const [i, d] of Object.entries(ports)) {
      const p = G.portsOf(sheet, 'in')[Number(i)];
      p.value = d.value;
      if (d.knob) p.knob = d.knob;
    }
    return { sheet, renamed, report };
  }

  // Per-instance knob settings were stored by net id; a net that became a port's
  // default is now addressed as "port.i<n>". Walk each path to its definition.
  function renameValues(values, rootSheet, defs, renamed, rack) {
    const out = {};
    for (const [k, v] of Object.entries(values || {})) {
      const parts = k.split('/');
      let sheet = rootSheet, def = null;
      const last = parts.pop();
      if (parts.length && parts[0].startsWith('R:')) {
        const m = rack && rack.modules.find((x) => 'R:' + x.id === parts[0]);
        def = m && m.def; sheet = def && defs[def]; parts.shift();
      }
      for (const id of parts) {
        const b = sheet && sheet.blocks.find((x) => x.id === id);
        def = b && b.def; sheet = def && defs[def];
      }
      const r = def && renamed[def] && renamed[def][last];
      out[r ? [...k.split('/').slice(0, -1), r].join('/') : k] = v;
    }
    return out;
  }

  // A version-2 design document → version 3 (the same document, wires instead of nets).
  function doc2to3(doc) {
    const fromDoc = (s, extra) => {
      const old = Object.assign({ blocks: s.blocks || [], nextId: s.nextId || 1, regions: {}, top: {}, bot: {} }, extra || {});
      for (const n of s.nets || []) {
        old.regions[n.id] = { value: n.value || 0 };
        if (n.knob) old.regions[n.id].knob = n.knob;
        for (const [x, y] of n.top || []) old.top[G.key(x, y)] = n.id;
        for (const [x, y] of n.bot || []) old.bot[G.key(x, y)] = n.id;
      }
      return old;
    };
    const defs = {};
    for (const [n, sig] of Object.entries(doc.uses || {})) defs[n] = defFromSig(n, sig);
    for (const [n, d] of Object.entries(doc.defs || {})) defs[n] = { name: n, fw: d.fw, fh: d.fh, s: d.s, ports: d.ports, blocks: [] };
    if (doc.block) defs[doc.block.name] = { name: doc.block.name, fw: doc.block.fw, fh: doc.block.fh, s: doc.block.s, ports: doc.block.ports, blocks: [] };
    const renamed = {};
    const conv = (d) => {
      const r = convertSheet(fromDoc(d, { name: d.name, fw: d.fw, fh: d.fh, s: d.s, ports: d.ports, description: d.description }), defs);
      renamed[d.name] = r.renamed;
      return toDocSheet(r.sheet, true);
    };
    const out = Object.assign({}, doc, { version: 3 });
    out.defs = {};
    for (const [n, d] of Object.entries(doc.defs || {})) out.defs[n] = conv(Object.assign({ name: n }, d));
    if (doc.block) out.block = conv(doc.block);
    if (doc.board) {
      const r = convertSheet(fromDoc(doc.board), defs);
      out.board = toDocSheet(r.sheet, false);
      // value keys: only private definitions are known here; library blocks were
      // migrated with the same rule, so the same renaming applies to them
      out.values = renameValues(doc.values, r.sheet, Object.assign({}, defs, out.defs), renamed, doc.rack);
    }
    return out;
  }
  // The document form of a sheet (format.js writes the canonical one).
  function toDocSheet(s, isDef) {
    const d = { nextId: s.nextId, blocks: s.blocks, wires: s.wires };
    if (isDef) Object.assign(d, { name: s.name, description: s.description, fw: s.fw, fh: s.fh, s: s.s, ports: s.ports });
    return d;
  }

  // A project saved by the app before wires (localStorage, undo history): every
  // sheet converted in place, knob keys renamed. Returns the report per sheet.
  function project(p) {
    const reports = {}, renamed = {};
    const oldDefs = p.defs;
    for (const [n, d] of Object.entries(oldDefs)) {
      if (!d.regions) continue;
      const r = convertSheet(d, oldDefs);
      renamed[n] = r.renamed; reports[n] = r.report;
      p.defs[n] = r.sheet;
    }
    if (p.root && p.root.regions) {
      const r = convertSheet(p.root, p.defs);
      p.root = r.sheet; reports['(board)'] = r.report;
      p.values = renameValues(p.values, p.root, p.defs, renamed, p.rack);
    }
    return reports;
  }
  const isOld = (p) => !!(p && ((p.root && p.root.regions) || Object.values(p.defs || {}).some((d) => d.regions)));


  // ---- version 3 → 4: one canvas for every kind of signal --------------------------------
  // The rack is gone: its modules move onto the board below everything else (2 HP
  // to a cell, a row of the rack every 14 cells), its cables become wires, and its
  // chips become composite blocks. The board's speaker (the old DAC) becomes an Out
  // socket, To rack and From rack become an AWG and a Voltmeter, the rack's Audio
  // Out a Voltmeter (scaled as the Audio Out scaled) into an Out, and scopes are
  // dropped. Where a wire now joins two kinds of signal (an analog jack straight to
  // a float pin, as the rack allowed), a converter goes between them.
  const ROW_CELLS = 14;
  function unrack(sheet, rack, values, defs, report) {
    const isRoot = sheet.fw === undefined;
    const newId = () => 'b' + sheet.nextId++;
    const dropped = new Set();
    const toCh = {}, fromCh = {};   // rack bus channel -> AWG / Voltmeters that replaced the links
    for (const b of sheet.blocks) {
      if (b.type === 'dac') { Object.keys(b).forEach((k) => { if (!['id', 'x', 'y'].includes(k)) delete b[k]; }); Object.assign(b, { type: 'out', y: b.y + 1, name: 'out' }); report.sockets++; }
      else if (b.type === 'scope') { dropped.add(b.id); report.scopes++; }
      else if (b.type === 'torack' || b.type === 'fromrack') {
        const ch = Math.round((b.params && b.params.ch) || 1), to = b.type === 'torack';
        Object.assign(b, { type: to ? 'awg' : 'voltmeter', params: to ? { gain: 1 } : { range: 1 } });
        if (to) toCh[ch] = b.id; else (fromCh[ch] = fromCh[ch] || []).push(b.id);
        report.links++;
      }
    }
    sheet.blocks = sheet.blocks.filter((b) => !dropped.has(b.id));
    sheet.wires = sheet.wires.filter((w) => !dropped.has(G.parseEp(w.from).b) && !dropped.has(G.parseEp(w.to).b));
    if (rack && rack.modules && rack.modules.length) {
      let x0 = 0, y0 = 0;
      if (sheet.blocks.length) {
        x0 = Infinity; y0 = -Infinity;
        for (const b of sheet.blocks) { const fp = G.footprint(b, defs); x0 = Math.min(x0, b.x); y0 = Math.max(y0, b.y + fp.h); }
        for (const w of sheet.wires) for (const [, y] of w.path || []) y0 = Math.max(y0, y + 1);
        y0 += 3;
      }
      const mid = new Map();   // rack module id -> {id, m}
      const audio = [];
      for (const m of rack.modules) {
        const x = x0 + Math.floor(m.x / 2), y = y0 + m.row * ROW_CELLS;
        if (m.type === 'scope2') { report.scopes++; continue; }
        if (m.type === 'bus') { mid.set(m.id, { bus: true }); continue; }
        if (m.type === 'audio') { audio.push({ m, x, y }); mid.set(m.id, { audio: audio[audio.length - 1] }); continue; }
        const b = m.type === 'chip' ? { id: newId(), type: 'comp', def: m.def, x, y } : { id: newId(), type: m.type, x, y, params: Object.assign({}, m.params || {}) };
        sheet.blocks.push(b);
        mid.set(m.id, { id: b.id, m });
        for (const k of Object.keys(values || {})) {
          if (!k.startsWith('R:' + m.id + '/')) continue;
          values[b.id + k.slice(('R:' + m.id).length)] = values[k]; delete values[k];
        }
        report.modules++;
      }
      // a jack, by port id or by position, as an endpoint
      const jack = (ref, dir) => {
        const e = mid.get(ref[0]);
        if (!e || !e.id) return null;
        const b = sheet.blocks.find((q) => q.id === e.id);
        let i = ref[1];
        if (typeof i !== 'number') {
          if (b.type === 'comp') i = G.portsOf(defs[b.def] || { ports: [] }, dir).findIndex((p) => p.name === ref[1]);
          else {
            // (the old converter modules are gone from today's table: their jacks by the ids they had)
            const OLD = { v2hz: { ins: ['v'], outs: ['hz'] }, hz2v: { ins: ['hz'], outs: ['v'] }, gain: { ins: ['in'], outs: ['out'] } };
            const m = G.MODULES[b.type], ids = m ? (dir === 'in' ? m.ins : m.outs).map((p) => p.id) : ((OLD[b.type] || {})[dir === 'in' ? 'ins' : 'outs'] || []);
            i = ids.indexOf(ref[1]);
          }
        }
        return i >= 0 ? G.ep(e.id, dir, i) : null;
      };
      const busIndex = (ref, dir) => (typeof ref[1] === 'number' ? ref[1] + 1 : Number(String(ref[1]).slice(1)));
      const wire = (from, to, color) => {
        const w = { id: 'w' + sheet.nextId++, from, to };
        if (color !== undefined) w.style = { color: G.CABLE_COLORS[color % G.CABLE_COLORS.length] };
        sheet.wires = sheet.wires.filter((q) => q.to !== to);
        sheet.wires.push(w);
        report.cables++;
      };
      const audioIn = new Map();   // audio module id -> {l: [src, color], r: [...]}
      for (const c of rack.cables || []) {
        const fe = mid.get(c.from[0]), te = mid.get(c.to[0]);
        if (!fe || !te) continue;
        if (te.audio) { const a = audioIn.get(c.to[0]) || {}; a[c.to[1] === 'r' || c.to[1] === 1 ? 'r' : 'l'] = [c.from, c.color]; audioIn.set(c.to[0], a); continue; }
        if (te.bus) {   // into the bus: on to the Voltmeters that were From rack blocks
          const src = fe.bus ? null : jack(c.from, 'out');
          if (src) for (const id of fromCh[busIndex(c.to, 'in')] || []) wire(src, G.ep(id, 'in', 0), c.color);
          continue;
        }
        const dst = jack(c.to, 'in');
        if (!dst) continue;
        if (fe.bus) { const id = toCh[busIndex(c.from, 'out')]; if (id) wire(G.ep(id, 'out', 0), dst, c.color); continue; }
        const src = jack(c.from, 'out');
        if (src) wire(src, dst, c.color);
      }
      // Audio Out: (L + R)/2 · level, ±5 V full scale, R normalled to L
      for (const { m, x, y } of audio) {
        const a = audioIn.get(m.id) || {}, level = (m.params && m.params.level !== undefined) ? m.params.level : 0.7;
        const sides = a.l && a.r ? [['l', 'L'], ['r', 'R']] : a.l ? [['l', 'out']] : a.r ? [['r', 'out']] : [];
        sides.forEach(([side, name], k) => {
          const vm = { id: newId(), type: 'voltmeter', x, y: y + 4 * k, params: { range: (sides.length === 2 ? 10 : 5) / (level || 1e-9) } };
          const out = { id: newId(), type: 'out', x: x + 4, y: y + 4 * k + 1, name };
          sheet.blocks.push(vm, out);
          const src = jack(a[side][0], 'out');
          if (src) wire(src, G.ep(vm.id, 'in', 0), a[side][1]);
          sheet.wires.push({ id: 'w' + sheet.nextId++, from: G.ep(vm.id, 'out', 0), to: G.ep(out.id, 'in', 0) });
          report.sockets++;
        });
      }
    }
    // a From rack that only fed scopes: nothing reads it now
    const dead = new Set(Object.values(fromCh).flat().filter((id) => !sheet.wires.some((w) => G.parseEp(w.from).b === id)));
    if (dead.size) { G.removeBlocks(sheet, dead); report.links -= dead.size; }
    settle(sheet, defs);
    // converters where a wire joins two kinds of signal
    for (const w of sheet.wires.slice()) {
      const a = G.domainAt(sheet, defs, w.from), z = G.domainAt(sheet, defs, w.to);
      if (!a || !z || a === z) continue;
      const type = a === 'analog' && z === 'float' ? 'voltmeter' : a === 'float' && z === 'analog' ? 'awg' : null;
      if (!type) continue;
      const pin = G.pinOf(sheet, defs, w.to), at = spot(sheet, defs, 3, 3, pin.x - 4, pin.y - 1);
      const cv = { id: newId(), type, x: at[0], y: at[1], params: type === 'awg' ? { gain: 1 } : { range: 1 } };
      sheet.blocks.push(cv);
      const to = w.to;
      w.to = G.ep(cv.id, 'in', 0); delete w.path;
      sheet.wires.push({ id: 'w' + sheet.nextId++, from: G.ep(cv.id, 'out', 0), to });
      report.converters++;
    }
    for (const w of sheet.wires) if (G.domainAt(sheet, defs, w.from) === 'analog') delete w.path;
    void isRoot;
  }
  // Blocks that now overlap (a module's panel is bigger than its old footprint) move down until they fit.
  function settle(sheet, defs) {
    for (const b of sheet.blocks) {
      const others = Object.assign({}, sheet, { blocks: sheet.blocks.filter((q) => q !== b) });
      for (let n = 0; n < 400 && !G.canPlace(others, defs, b); n++) b.y++;
    }
  }
  // A free w × h place near (x, y).
  function spot(sheet, defs, w, h, x, y) {
    const probe = { id: '_', type: 'awg', x, y };
    for (let r = 0; r < 60; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        probe.x = x + dx; probe.y = y + dy;
        if (probe.x >= 0 && probe.y >= 0 && G.canPlace(sheet, defs, probe)) return [probe.x, probe.y];
      }
    }
    return [x, y];
  }
  // The footprints a document's sheets need, for blocks that are not in it (signatures).
  function footprints(doc) {
    const defs = {};
    for (const [n, sig] of Object.entries(doc.uses || {})) defs[n] = defFromSig(n, sig);
    for (const [n, d] of Object.entries(doc.defs || {})) defs[n] = Object.assign({ blocks: [], wires: [] }, d, { name: n });
    if (doc.block) defs[doc.block.name] = Object.assign({ blocks: [], wires: [] }, doc.block);
    return defs;
  }
  function doc3to4(doc) {
    const out = JSON.parse(JSON.stringify(doc));
    out.version = 4;
    const defs = footprints(out), report = newReport();
    const sheetOf = (d) => Object.assign({ blocks: [], wires: [], nextId: 1 }, d);
    for (const [n, d] of Object.entries(out.defs || {})) { const s = sheetOf(d); unrack(s, null, null, defs, report); out.defs[n] = s; defs[n] = Object.assign({}, defs[n], s); }
    if (out.block) { const s = sheetOf(out.block); unrack(s, null, null, defs, report); out.block = s; }
    if (out.kind === 'example' || out.board) {
      const s = sheetOf(out.board || {});
      out.values = out.values || {};
      unrack(s, out.rack, out.values, defs, report);
      out.board = { nextId: s.nextId, blocks: s.blocks, wires: s.wires };
      delete out.rack;
      if (out.meta) {
        delete out.meta.view;
        if (out.meta.camera) { delete out.meta.camera.rack; if (!Object.keys(out.meta.camera).length) delete out.meta.camera; }
      }
    }
    return out;
  }
  const newReport = () => ({ modules: 0, cables: 0, sockets: 0, links: 0, scopes: 0, converters: 0 });
  // An internal project (localStorage) from before: the same, in place.
  function unrackProject(p) {
    const report = newReport();
    for (const d of Object.values(p.defs)) unrack(d, null, null, p.defs, report);
    p.values = p.values || {};
    unrack(p.root, p.rack, p.values, p.defs, report);
    delete p.rack;
    return report;
  }
  // Internal projects carry a version: 3 is one canvas for every domain (no rack, Out sockets).
  const hasRack = (p) => !!p && !(p.version >= 3);


  // ---- version 4 → 5: no more Sample blocks ------------------------------------------------
  // Sound from outside comes in through In sockets (the microphone, or anything
  // linked to them in PipeWire). A Sample on the top board becomes an In socket
  // whose output pin is where the Sample's was, so its wires stay as they were;
  // inside a block (where sockets don't belong) it becomes a Constant 0.
  function unsample(sheet, isRoot, report) {
    const names = new Set(sheet.blocks.filter((b) => b.type === 'in').map((b) => b.name || 'in'));
    for (const b of sheet.blocks) {
      if (b.type !== 'sample') continue;
      let name = 'in';
      for (let n = 2; names.has(name); n++) name = 'in' + n;
      names.add(name);
      const id = b.id, x = b.x, y = b.y;
      for (const k of Object.keys(b)) delete b[k];
      if (isRoot) Object.assign(b, { id, type: 'in', x: x + 7, y: y + 1, name });
      else Object.assign(b, { id, type: 'const', x: x + 9, y: y + 1, value: 0 });
      report.samples++;
    }
  }
  function doc4to5(doc) {
    const out = JSON.parse(JSON.stringify(doc)), report = { samples: 0 };
    out.version = 5;
    if (out.board) unsample(out.board, true, report);
    if (out.block) unsample(out.block, false, report);
    for (const d of Object.values(out.defs || {})) unsample(d, false, report);
    return out;
  }
  const hasSample = (p) => !!p && !(p.version >= 4);
  function unsampleProject(p) {
    const report = { samples: 0 };
    unsample(p.root, true, report);
    for (const d of Object.values(p.defs || {})) unsample(d, false, report);
    return report;
  }


  // ---- version 5 → 6: converters become library blocks -----------------------------------
  // The board keeps four crossings that only cross (Voltmeter, AWG, Word, Value);
  // every converter with a map in it is a library block (converters.js). An old
  // converter becomes a copy of the block of the same kind, where it was: its
  // signal pins are where they were; its settings go to the copy's setting pins
  // (as this copy's values at the top board, as the default of a private variant
  // inside a block). A width or signedness the library's block doesn't have is a
  // private variant, carried in the file.
  const CV = () => (node ? require('./converters.js') : root.GW.Converters);
  const CONVERTED = {
    adc: (p) => ({ kind: 'ADC', o: { bits: p.bits === undefined ? 8 : p.bits }, set: { range: p.range === undefined ? 5 : p.range } }),
    dac: (p) => ({ kind: 'DAC', o: { signed: 1 }, set: { range: p.range === undefined ? 5 : p.range } }),
    quant: (p) => ({ kind: 'Quantizer', o: { bits: p.bits === undefined ? 16 : p.bits, signed: p.signed === undefined ? 1 : p.signed }, set: { frac: p.frac === undefined ? 8 : p.frac } }),
    dequant: (p) => ({ kind: 'Dequantizer', o: { signed: p.signed === undefined ? 1 : p.signed }, set: { frac: p.frac === undefined ? 8 : p.frac } }),
    voltmeter: (p) => (p.range === undefined || p.range === 1 ? null : { kind: 'Scaled Voltmeter', o: {}, set: { range: p.range } }),
    awg: (p) => (p.gain === undefined || p.gain === 1 ? null : { kind: 'Scaled AWG', o: {}, set: { gain: p.gain } }),
    v2hz: () => ({ kind: 'V/OCT → Hz', o: {}, set: {} }),
    hz2v: () => ({ kind: 'Hz → V/OCT', o: {}, set: {} }),
  };
  // sheets: [{sheet, path}] where path is the value-key prefix at the top board, or null inside a block.
  // Returns the definitions it used, by name.
  function convertConverters(sheets, values, report) {
    const used = {};
    for (const { sheet, top } of sheets) {
      for (const b of sheet.blocks) {
        const f = CONVERTED[b.type];
        if (!f) continue;
        const c = f(b.params || {});
        if (!c) { delete b.params; continue; }   // a plain Voltmeter or AWG: the crossing itself
        let def = CV().variant(c.kind, c.o);
        const ins = G.portsOf(def, 'in'), signalIn = ins.findIndex((p) => p.name === 'in');
        // settings: per copy at the top board, else in a private variant's defaults
        const differs = Object.entries(c.set).filter(([k, v]) => ins.find((p) => p.name === k).value !== v);
        if (differs.length && !top) {
          def = JSON.parse(JSON.stringify(def));
          def.name = `${def.name} (${differs.map(([k, v]) => k + ' ' + v).join(', ')})`;
          for (const [k, v] of differs) ins.forEach((p, i) => { if (p.name === k) def.ports.find((q) => q.dir === 'in' && q.name === k).value = v; });
        }
        used[def.name] = def;
        for (const w of sheet.wires) if (w.to === G.ep(b.id, 'in', 0)) w.to = G.ep(b.id, 'in', signalIn);
        for (const k of Object.keys(b)) if (!['id', 'x', 'y'].includes(k)) delete b[k];
        Object.assign(b, { type: 'comp', def: def.name });
        if (top) for (const [k, v] of differs) values[b.id + '/' + G.ep('port', 'in', ins.findIndex((p) => p.name === k))] = v;
        report.converters++;
      }
    }
    return used;
  }
  function doc5to6(doc) {
    const out = JSON.parse(JSON.stringify(doc)), report = { converters: 0 };
    out.version = 6;
    out.values = out.values || {};
    const sheets = [];
    if (out.board) sheets.push({ sheet: out.board, top: true });
    if (out.block) sheets.push({ sheet: out.block, top: false });
    for (const d of Object.values(out.defs || {})) sheets.push({ sheet: d, top: false });
    const used = convertConverters(sheets, out.values, report);
    if (!out.board) delete out.values;
    // the library's own converters are referred to by name; variants travel with the file
    const std = new Map(CV().standard().map((d) => [d.name, d]));
    for (const [n, d] of Object.entries(used)) {
      if (std.has(n) && JSON.stringify(std.get(n)) === JSON.stringify(d)) {
        const ports = d.ports.slice().sort((a, b) => (a.dir === b.dir ? a.row - b.row : a.dir === 'in' ? -1 : 1));
        out.uses = Object.assign({}, out.uses, { [n]: `${d.fw}x${d.fh} ` + ports.map((p) => `${p.dir}@${p.row}:${p.name}`).join(' ') });
      } else {
        out.defs = Object.assign({}, out.defs, { [n]: Object.assign({ name: n, description: d.description, fw: d.fw, fh: d.fh, s: d.s, ports: d.ports }, { nextId: d.nextId, blocks: d.blocks, wires: d.wires }) });
      }
    }
    return out;
  }
  const hasOldConverters = (p) => !!p && !(p.version >= 5);
  function convertProject(p) {
    const report = { converters: 0 };
    const sheets = [{ sheet: p.root, top: true }].concat(Object.values(p.defs).map((d) => ({ sheet: d, top: false })));
    p.values = p.values || {};
    const used = convertConverters(sheets, p.values, report);
    for (const [n, d] of Object.entries(used)) if (!p.defs[n]) p.defs[n] = d;
    return report;
  }

  const api = { convertSheet, doc2to3, project, isOld, defFromSig, renameValues, doc3to4, unrack, unrackProject, hasRack, doc4to5, unsampleProject, hasSample, doc5to6, convertProject, hasOldConverters };
  if (node) module.exports = api;
  else root.GW.Migrate = api;
})(typeof self !== 'undefined' ? self : this);
