// Sample Factory design files: the long-lived, versioned format for curated
// examples, library blocks and exported designs (see FORMAT.md for the
// specification and the compatibility rules).
//
// The format is deliberately not the app's internal representation. Blocks and
// wires are listed with stable ids; wires name their pins. There are two kinds of
// file: an *example* (a whole design: board and knob settings) and a *block* (one
// definition for the library). Both refer to library blocks by name, recording
// each one's pin signature, so curating a block's insides reaches everything that
// uses it, while a change to its pins is caught. A definition that differs from
// the library (or isn't in it) is stored in the file itself as a private copy.
// Writing is canonical (fixed key order, sorted ids), so saving an unchanged
// design gives byte-identical text and git diffs show real edits only.
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const G = node ? require('./model.js') : root.GW;
  const M = node ? require('./migrate.js') : root.GW.Migrate;
  if (node) require('./analog.js');   // the module and converter types

  const FORMAT = 'sample-factory-design';
  const VERSION = 6;

  // ---- encoding ----------------------------------------------------------------
  const cellSort = (a, b) => a[1] - b[1] || a[0] - b[0];
  // Known block fields in a fixed order; anything else is kept, after them.
  const BLOCK_KEYS = ['id', 'type', 'def', 'x', 'y', 'w', 'h', 'rot', 'value', 'width', 'parts', 'knob', 'params', 'name'];
  const STYLE_KEYS = ['color', 'width', 'droop', 'vias'];
  const KNOB_KEYS = ['label', 'min', 'max', 'scale'];
  function ordered(o, keys) {
    const out = {};
    for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
    for (const k of Object.keys(o).sort()) if (!(k in out) && o[k] !== undefined) out[k] = o[k];
    return out;
  }
  const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  function encodeSheet(sheet) {
    const blocks = sheet.blocks.slice().sort((a, b) => idNum(a.id) - idNum(b.id)).map((b) => {
      const c = ordered(b, BLOCK_KEYS);
      if (!c.rot) delete c.rot;
      if (c.params && !Object.keys(c.params).length) delete c.params;
      if (c.knob) c.knob = ordered(c.knob, KNOB_KEYS);
      return c;
    });
    const wires = (sheet.wires || []).slice().sort((a, b) => idNum(a.id) - idNum(b.id)).map((w) => {
      const o = { id: w.id, from: w.from, to: w.to };
      if (w.path && w.path.length) o.path = w.path.map(([x, y]) => [x, y]);
      if (w.style && Object.keys(w.style).length) o.style = ordered(w.style, STYLE_KEYS);
      return o;
    });
    return { nextId: sheet.nextId, blocks, wires };
  }
  // The definitions a design uses, directly or inside other definitions.
  function usedDefs(project) {
    const seen = new Set(), stack = [];
    const visitSheet = (sh) => { for (const b of sh.blocks) if (b.type === 'comp' && b.def) stack.push(b.def); };
    visitSheet(project.root);
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n) || !project.defs[n]) continue;
      seen.add(n);
      visitSheet(project.defs[n]);
    }
    return [...seen].sort();
  }
  // ---- definitions and the library -------------------------------------------------
  function encodeDef(d) {
    const size = d.iw && d.ih && (d.iw !== d.fw * d.s || d.ih !== d.fh * d.s) ? { iw: d.iw, ih: d.ih } : {};
    return Object.assign({ name: d.name, description: d.description || '', fw: d.fw, fh: d.fh, s: d.s }, size, {
      ports: d.ports.map((p) => { const o = ordered(p, ['dir', 'row', 'name', 'domain', 'width', 'value', 'knob']); if (o.knob) o.knob = ordered(o.knob, KNOB_KEYS); return o; }) }, encodeSheet(d));
  }
  // The pins a definition shows to the outside: what the layouts around it depend on.
  function sig(d) {
    const ports = d.ports.slice().sort((a, b) => (a.dir === b.dir ? a.row - b.row : a.dir === 'in' ? -1 : 1));
    return `${d.fw}x${d.fh} ` + ports.map((p) => `${p.dir}@${p.row}:${p.name}`).join(' ');
  }
  const defText = (d) => stringify(encodeDef(d));
  const sameDef = (a, b) => !!(a && b) && defText(a) === defText(b);
  // Every definition reachable from some starting names (not including them).
  function depsOf(defs, names) {
    const seen = new Set(), stack = [];
    for (const n of names) if (defs[n]) for (const b of defs[n].blocks) if (b.type === 'comp' && b.def) stack.push(b.def);
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n) || !defs[n]) continue;
      seen.add(n);
      for (const b of defs[n].blocks) if (b.type === 'comp' && b.def) stack.push(b.def);
    }
    return [...seen].sort();
  }
  // The definitions among `names` that a save would have to store privately:
  // new (not in the library) or changed (different from the library's copy).
  function changedDefs(defs, library, names) {
    return names.filter((n) => defs[n] && !sameDef(defs[n], library && library[n]));
  }
  // Library references and private copies for a set of definitions.
  function split(defs, library, names) {
    const uses = {}, priv = {};
    for (const n of names) {
      if (library && library[n] && sameDef(defs[n], library[n])) uses[n] = sig(defs[n]);
      else priv[n] = encodeDef(defs[n]);
    }
    return { uses, defs: priv };
  }

  // An example: the whole design. `library` (optional) is the block library; the
  // definitions identical to its blocks are stored as references.
  function encode(project, meta, library) {
    const parts = split(project.defs, library, usedDefs(project));
    const values = {};
    for (const k of Object.keys(project.values || {}).sort()) values[k] = project.values[k];
    return {
      format: FORMAT,
      version: VERSION,
      kind: 'example',
      meta: ordered(meta || {}, ['title', 'note', 'rate', 'view', 'author', 'tags']),
      uses: parts.uses,
      board: encodeSheet(project.root),
      defs: parts.defs,
      values,
    };
  }
  // A library block: one definition, with references to the blocks it contains.
  function encodeBlock(defs, name, meta, library) {
    const d = defs[name];
    if (!d) throw new Error('no block "' + name + '"');
    const parts = split(defs, library, depsOf(defs, [name]));
    return {
      format: FORMAT,
      version: VERSION,
      kind: 'block',
      meta: ordered(Object.assign({}, meta || {}, { title: name }), ['title', 'author', 'tags']),
      uses: parts.uses,
      block: encodeDef(d),
      defs: parts.defs,
    };
  }

  // Canonical text: two-space indentation, but arrays of numbers (cells, jack
  // references) on one line, so a net is a line or two, not hundreds; and small
  // objects (a block, a cable, a knob, a port) on one line each.
  function stringify(doc) {
    const flat = (v) => Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null || (Array.isArray(x) && x.every((y) => typeof y !== 'object')));
    const small = (v) => !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== 'object' || flat(x) ||
      (!Array.isArray(x) && Object.values(x).every((y) => y === null || typeof y !== 'object')));
    const inline = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? JSON.stringify(v)
      : '{' + Object.keys(v).map((k) => JSON.stringify(k) + ': ' + inline(v[k])).join(', ') + '}');
    const out = (v, ind) => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (flat(v)) return JSON.stringify(v);
      if (small(v)) { const s = inline(v); if (s.length + ind.length <= 120) return s; }
      const pad = ind + '  ';
      if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => pad + out(x, pad)).join(',\n') + '\n' + ind + ']' : '[]';
      const keys = Object.keys(v);
      return keys.length ? '{\n' + keys.map((k) => pad + JSON.stringify(k) + ': ' + out(v[k], pad)).join(',\n') + '\n' + ind + '}' : '{}';
    };
    return out(doc, '') + '\n';
  }

  // ---- decoding -------------------------------------------------------------------
  // Upgrades, one per format version: MIGRATIONS[n] turns a version-n document
  // into version n+1. A change to the format adds one; old files stay loadable.
  const MIGRATIONS = {
    // 1 → 2: files became examples or blocks, and could refer to library blocks.
    // A version-1 file kept a frozen copy of every definition: they stay private copies.
    1: (doc) => Object.assign({}, doc, { version: 2, kind: 'example', uses: {}, defs: doc.defs || {} }),
    // 2 → 3: painted nets on two layers became wires between pins, each routed along
    // the net's old cells; constants became Constant blocks; port nets, port defaults.
    2: (doc) => M.doc2to3(doc),
    // 3 → 4: one canvas for all three kinds of signal. The rack's modules and cables
    // moved onto the board; the speaker became an Out socket; scopes were dropped.
    3: (doc) => M.doc3to4(doc),
    // 4 → 5: no more Sample blocks (WAV players): sound from outside comes in through
    // In sockets. A Sample on the top board becomes an In socket with its pin in place.
    4: (doc) => M.doc4to5(doc),
    // 5 → 6: converters with a map in them (ADC, DAC, Quantizer, …) became library
    // blocks built from four crossings; an old one becomes a copy of its block.
    5: (doc) => M.doc5to6(doc),
  };

  function decodeSheet(s, extra) {
    const sheet = G.makeSheet(extra);
    sheet.nextId = s.nextId || 1;
    for (const b of s.blocks || []) sheet.blocks.push(JSON.parse(JSON.stringify(b)));
    for (const w of s.wires || []) sheet.wires.push(JSON.parse(JSON.stringify(w)));
    // ids are kept, so nextId must stay above every id in use
    const maxId = Math.max(0, ...sheet.blocks.map((b) => idNum(b.id)), ...sheet.wires.map((w) => idNum(w.id)));
    sheet.nextId = Math.max(sheet.nextId, maxId + 1);
    return sheet;
  }
  function decodeDef(d, name) {
    const size = d.iw && d.ih ? { iw: d.iw, ih: d.ih } : {};
    return decodeSheet(d, { name: name || d.name, fw: d.fw, fh: d.fh, s: d.s, ...size, ports: d.ports.map((p) => Object.assign({}, p)), description: d.description || '' });
  }
  function upgrade(input) {
    let doc = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
    if (doc.format !== FORMAT) return doc;
    if (doc.version > VERSION) throw new Error(`this design is format version ${doc.version}; this app reads up to ${VERSION}. Update the app.`);
    for (let v = doc.version; v < VERSION; v++) doc = MIGRATIONS[v](doc);
    return doc;
  }
  // Library references: present, and with the pins they had when the file was saved?
  // A block whose pins changed since the file was saved: its copies' wires move to
  // the ports of the same name (wires name pins by position, which may have
  // shifted); a wire to a port that is gone is dropped. `sheets` are the file's
  // sheets that may hold copies of it, `project` (if any) for knob settings.
  function checkUses(doc, defs, priv, warnings, sheets, project) {
    for (const [n, s] of Object.entries(doc.uses || {})) {
      if (priv[n]) continue;
      if (!defs[n]) { warnings.push(`uses library block "${n}", which is not in the library`); continue; }
      if (sig(defs[n]) === s) continue;
      const map = sigMap(s, defs[n]), gone = [];
      for (const sh of sheets || []) {
        for (const b of sh.blocks) if (b.type === 'comp' && b.def === n) gone.push(...G.remapPorts(sh, b.id, map));
      }
      if (project) remapValueKeys(project, n, map);
      warnings.push(`library block "${n}" has different pins than when this was saved (was ${s}; now ${sig(defs[n])}): wires follow its ports by name` +
        (gone.length ? `; ${gone.length} wire(s) to ports it no longer has were dropped` : ''));
    }
  }
  // Old position → new position of each port, from a pin signature and a definition:
  // by name, else (for a renamed port) by its row.
  function sigMap(s, def) {
    const old = { in: [], out: [] };
    for (const p of s.split(' ').slice(1)) { const m = /^(in|out)@(\d+):(.*)$/.exec(p); if (m) old[m[1]].push({ row: Number(m[2]), name: m[3] }); }
    const map = {};
    for (const dir of ['in', 'out']) {
      const now = G.portsOf(def, dir), used = new Set(), names = new Set(old[dir].map((o) => o.name));
      const take = (k) => { if (k >= 0) used.add(k); return k; };
      map[dir] = old[dir].map((o) => take(now.findIndex((p, i) => !used.has(i) && p.name === o.name)));
      map[dir] = map[dir].map((k, i) => (k >= 0 ? k : take(now.findIndex((p, j) => !used.has(j) && p.row === old[dir][i].row && !names.has(p.name)))));
    }
    return map;
  }
  function remapValueKeys(project, name, map) {
    const out = {};
    for (const [k, v] of Object.entries(project.values || {})) {
      const parts = k.split('/'), last = parts.pop(), m = /^port\.i(\d+)$/.exec(last);
      let sheet = project.root, def = null;
      for (const id of parts) { const b = sheet && sheet.blocks.find((x) => x.id === id); def = b && b.def; sheet = def && project.defs[def]; }
      if (m && def === name) { const n = map.in[Number(m[1])]; if (n >= 0) out[[...parts, 'port.i' + n].join('/')] = v; } else out[k] = v;
    }
    project.values = out;
  }
  // Wires must join pins that exist; one that doesn't is dropped, with a warning.
  function checkWires(where, sh, defs, warnings) {
    const bad = sh.wires.filter((w) => !G.pinOf(sh, defs, w.from) || !G.pinOf(sh, defs, w.to));
    for (const w of bad) warnings.push(`wire ${w.id} on ${where} joins a pin that doesn't exist (${!G.pinOf(sh, defs, w.from) ? w.from : w.to}); dropped`);
    if (bad.length) sh.wires = sh.wires.filter((w) => !bad.includes(w));
    G.mendPaths(sh, defs);   // traces left off a pin by a block that changed size since
  }
  // Module knobs: ones that no longer exist are dropped, missing ones get their defaults.
  function checkParams(where, sh, warnings) {
    for (const b of sh.blocks) {
      const spec = G.MODULES[b.type];
      if (!spec) continue;
      b.params = Object.assign({}, b.params || {});
      for (const k of Object.keys(b.params)) if (!spec.params.some((p) => p.id === k)) { warnings.push(`${spec.title} ${b.id} on ${where}: knob "${k}" no longer exists (ignored)`); delete b.params[k]; }
      for (const p of spec.params) if (b.params[p.id] === undefined) b.params[p.id] = p.def;
    }
  }
  // Accepts a design document (any version, either kind) or a raw project as the
  // app stores it internally. `library` supplies the blocks the file refers to;
  // the file's private copies win over it. Returns { kind, project, meta, warnings },
  // and for a block also { name, def }: its project is a workbench, the block on
  // an empty board.
  function decode(input, library) {
    const warnings = [];
    const doc = upgrade(input);
    if (doc.format !== FORMAT) {
      if (doc.root && doc.defs) {   // an internal project (localStorage, older exports)
        const p = doc;
        if (M.isOld(p)) M.project(p);   // drawn before wires: convert
        p.values = p.values || {};
        p.defs = Object.assign(copyDefs(library), p.defs);
        if (M.hasRack(p)) M.unrackProject(p);   // from before one canvas: modules onto the board
        if (M.hasSample(p)) M.unsampleProject(p);   // from before In sockets took the WAV player's place
        if (M.hasOldConverters(p)) M.convertProject(p);   // from before converters were library blocks
        p.version = 5;
        return { kind: 'example', project: p, meta: {}, warnings };
      }
      throw new Error('not a Sample Factory design');
    }
    const defs = copyDefs(library), priv = {};
    for (const [name, d] of Object.entries(doc.defs || {})) defs[name] = priv[name] = decodeDef(d, name);
    const checkPriv = () => { for (const name of Object.keys(priv)) { checkWires('"' + name + '"', defs[name], defs, warnings); checkParams('"' + name + '"', defs[name], warnings); } };
    if (doc.kind === 'block') {
      const def = decodeDef(doc.block);
      defs[def.name] = def;
      priv[def.name] = def;
      checkUses(doc, defs, priv, warnings, Object.values(priv));
      checkPriv();
      return { kind: 'block', name: def.name, def, project: bench(def, defs), meta: Object.assign({}, doc.meta || {}), warnings };
    }
    const project = { version: 5, root: decodeSheet(doc.board || {}), defs, values: Object.assign({}, doc.values || {}) };
    checkUses(doc, defs, priv, warnings, Object.values(priv).concat([project.root]), project);
    checkPriv();
    checkWires('the board', project.root, defs, warnings);
    checkParams('the board', project.root, warnings);
    return { kind: 'example', project, meta: Object.assign({}, doc.meta || {}), warnings };
  }
  // Designs get their own copies of the library's blocks: editing one must not touch the library.
  const copyDefs = (library) => (library ? JSON.parse(JSON.stringify(library)) : {});
  // The workbench for a block: one instance on an empty board, nothing else.
  const BENCH_AT = 2;
  function bench(def, defs) {
    const root = G.makeSheet();
    root.blocks.push({ id: 'b1', type: 'comp', def: def.name, x: BENCH_AT, y: BENCH_AT, rot: 0 });
    root.nextId = 2;
    return { version: 5, root, defs, values: {} };
  }

  // The library: every block file, in one map. Files refer to each other by name;
  // a reference to a missing block or to changed pins is a warning.
  function loadLibrary(files) {
    const defs = {}, warnings = [], fileOf = {}, docs = [];
    for (const { file, doc: input } of files) {
      const doc = upgrade(input);
      if (doc.format !== FORMAT || doc.kind !== 'block') { warnings.push(`${file}: not a library block`); continue; }
      const def = decodeDef(doc.block);
      if (defs[def.name]) warnings.push(`${file}: a second block called "${def.name}" (ignored)`);
      else { defs[def.name] = def; fileOf[def.name] = file; docs.push({ file, doc }); }
      if (Object.keys(doc.defs || {}).length) warnings.push(`${file}: has private copies of ${Object.keys(doc.defs).join(', ')} (save them to the library)`);
    }
    for (const { file, doc } of docs) {
      const w = [];
      checkUses(doc, defs, {}, w, [defs[doc.block.name]]);
      checkWires('"' + doc.block.name + '"', defs[doc.block.name], defs, w);
      warnings.push(...w.map((x) => `${file}: ${x}`));
    }
    return { defs, warnings, fileOf };
  }

  // A file name for a title: lower case, digits and dashes.
  const slug = (title) => String(title || 'design').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'design';

  // A manifest (examples/index.json, library/index.json): one entry per line
  // (tools/serve.py writes the same text).
  const manifestText = (m, key) => {
    key = key || (m.blocks ? 'blocks' : 'examples');
    const lines = (m[key] || []).map((e) => '    {' + Object.keys(e).map((k) => JSON.stringify(k) + ': ' + JSON.stringify(e[k])).join(', ') + '}');
    return `{\n  "${key}": [\n` + lines.join(',\n') + (lines.length ? '\n' : '') + '  ]\n}\n';
  };

  // A document brought up to the current version (for inspecting migrations).
  const upgradeDoc = (doc) => { const d = upgrade(doc); return d.block ? Object.assign({}, d, { block: encodeDef(decodeDef(d.block)) }) : d; };

  // ---- curation: renaming a block, and keeping a copy of one leaving the library --------
  // A block's name is how files refer to it: renaming it rewrites every reference
  // in a document (its uses, its private copies, the composite blocks on every
  // sheet; in its own file, its name and title). The result is canonical.
  function renameBlockInDoc(input, from, to) {
    const doc = JSON.parse(JSON.stringify(upgrade(input)));
    const sheets = [doc.board, doc.block, ...Object.values(doc.defs || {})].filter(Boolean);
    for (const sh of sheets) for (const b of sh.blocks || []) if (b.type === 'comp' && b.def === from) b.def = to;
    const rekey = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) : o);
    doc.uses = rekey(doc.uses);
    doc.defs = rekey(doc.defs);
    for (const [n, d] of Object.entries(doc.defs || {})) if (d.name !== undefined) d.name = n;
    if (doc.block && doc.block.name === from) { doc.block.name = to; doc.meta = Object.assign({}, doc.meta, { title: to }); }
    return doc;
  }
  // Does a document use a block (by name, at any depth)?
  const docUses = (doc, name) => !!((doc.uses && doc.uses[name]) || (doc.defs && doc.defs[name]));
  // A design that used a library block about to be deleted: the same design, with
  // that block (and whatever it contains that leaves too) as a private copy.
  function keepPrivate(input, name, library) {
    const d = decode(input, library), lib = Object.assign({}, library);
    delete lib[name];
    if (d.kind === 'block') return encodeBlock(d.project.defs, d.name, d.meta, lib);
    return encode(d.project, d.meta, lib);
  }

  const api = { FORMAT, VERSION, MIGRATIONS, BENCH_AT, encode, encodeBlock, encodeDef, decode, loadLibrary, stringify, usedDefs, depsOf, upgrade: upgradeDoc,
    renameBlockInDoc, docUses, keepPrivate,
    changedDefs, sameDef, sig, slug, manifestText };
  if (node) module.exports = api;
  else root.GW.Format = api;
})(typeof self !== 'undefined' ? self : this);
