// Run with: node tests/format.test.js — design files (FORMAT.md), the curated
// examples in examples/, and the compatibility lock.
//
// The lock (tests/compat.lock.json) records everything a saved design depends on:
// each block type's board footprint, pins and pin domains, and each module's knob ids. If a change alters any of it, this test fails. Then either undo
// the change, or add a migration in js/grid/format.js that rewrites old designs,
// and refresh the lock with: UPDATE_LOCK=1 node tests/format.test.js
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const G = require('../js/grid/model.js');
const F = require('../js/grid/format.js');
const { compile, instantiate } = require('../js/grid/compiler.js');
const L = require('../js/grid/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; }
}
const EX = path.join(__dirname, '..', 'examples');

const gen = L.starterDefs();   // the generated library (what library/ was seeded from)

test('every generated example survives a round trip, self-contained or referring to the library', () => {
  for (let i = 0; i < L.EXAMPLES.length; i++) {
    const p = L.exampleProject(i);
    for (const lib of [null, gen]) {
      const text = F.stringify(F.encode(p, { title: 't' }, lib));
      const d = F.decode(text, lib || undefined);
      assert.deepStrictEqual(d.warnings, []);
      assert.strictEqual(F.stringify(F.encode(d.project, d.meta, lib)), text, L.EXAMPLES[i].title);
      assert.strictEqual(compile(d.project).code, compile(p).code, L.EXAMPLES[i].title);
    }
  }
});

test('an example refers to library blocks by name, and keeps its own copy of a block it changed', () => {
  const p = L.exampleProject(1);                                  // a tone: VCO with a Phasor inside
  let doc = F.encode(p, {}, gen);
  assert.deepStrictEqual(Object.keys(doc.uses), ['Phasor', 'VCO']);
  assert.deepStrictEqual(doc.defs, {});
  assert.strictEqual(doc.uses.Phasor, 'in@0:Hz out@0:phase out@2:wrap'.replace(/^/, '5x3 '));
  p.defs = JSON.parse(JSON.stringify(p.defs));
  p.defs.Phasor.description = 'my own Phasor';
  doc = F.encode(p, {}, gen);
  assert.deepStrictEqual(Object.keys(doc.uses), ['VCO']);
  assert.deepStrictEqual(Object.keys(doc.defs), ['Phasor']);
  const d = F.decode(doc, gen);                                   // the library's VCO, with this design's Phasor inside
  assert.strictEqual(d.project.defs.Phasor.description, 'my own Phasor');
  d.project.defs.VCO.description = 'edited in the design';
  assert.notStrictEqual(gen.VCO.description, 'edited in the design', 'editing a design never touches the library');
  assert.ok(d.project.defs['Tune Just'], 'the rest of the library is available');
});

test('curating a library block reaches the designs that use it; changing its pins is reported', () => {
  const doc = F.encode(L.exampleProject(1), {}, gen);
  const lib = JSON.parse(JSON.stringify(gen));
  lib.Phasor.description = 'curated';
  assert.strictEqual(F.decode(doc, lib).project.defs.Phasor.description, 'curated');
  lib.Phasor.ports.push({ dir: 'in', row: 2, name: 'reset' });
  const w = F.decode(doc, lib).warnings;
  assert.ok(w.some((x) => /"Phasor" has different pins/.test(x)), w.join('; '));
  delete lib.VCO;
  assert.ok(F.decode(doc, lib).warnings.some((x) => /"VCO", which is not in the library/.test(x)));
});

test('a block file: one definition, opened on a workbench', () => {
  const doc = F.encodeBlock(gen, 'VCO', {}, gen);
  assert.strictEqual(doc.kind, 'block');
  assert.deepStrictEqual(Object.keys(doc.uses), ['Phasor']);
  const d = F.decode(F.stringify(doc), gen);
  assert.strictEqual(d.kind, 'block');
  assert.strictEqual(d.name, 'VCO');
  assert.deepStrictEqual(d.project.root.blocks.map((b) => [b.type, b.def, b.x]), [['comp', 'VCO', F.BENCH_AT]]);
  assert.ok(compile(d.project).ok);
  assert.strictEqual(F.stringify(F.encodeBlock(d.project.defs, 'VCO', d.meta, gen)), F.stringify(doc));
});

const FIX = path.join(__dirname, 'fixtures');
test('version 1 files still open: painted nets become wires along the same cells', () => {
  const d = F.decode(fs.readFileSync(path.join(FIX, 'counter-v1.json'), 'utf8'));
  assert.deepStrictEqual(d.warnings, []);
  const c = compile(d.project);
  assert.ok(c.ok, JSON.stringify(c.errors));
  const fn = instantiate(c.code), s = new Float64Array(c.nState), v = new Float64Array(c.nSnap), seen = [];
  const ff = d.project.root.blocks.find((b) => b.type === 'delay' && d.project.root.wires.some((w) => w.from === G.ep(b.id, 'out', 0) && /i1$/.test(w.to)));
  for (let i = 0; i < 5; i++) { fn(1, c.params, s, [], [], v, []); seen.push(v[c.netOf[G.ep(ff.id, 'out', 0)].v]); }
  assert.deepStrictEqual(seen, [0, 1, 2, 3, 4], 'it still counts');
  assert.ok(!d.project.root.blocks.some((b) => b.type === 'scope'), 'its scope was dropped (format 4)');
  const knob = d.project.root.blocks.find((b) => b.type === 'const');
  assert.deepStrictEqual([knob.id, knob.x, knob.y, knob.value, knob.knob.label], ['r6', 2, 2, 1, 'step'], 'the knob became a Constant at its cell');
  for (const w of d.project.root.wires) assert.ok(G.pathOk(d.project.root, d.project.defs, w), w.id + ' follows the old cells to its pins');
});

test('a project saved in the browser before wires converts on load, knob settings and all', () => {
  const v1 = JSON.parse(fs.readFileSync(path.join(FIX, 'counter-v1.json'), 'utf8'));
  // the app's own (internal) form of that design, as an old localStorage save held it
  const root = { blocks: v1.board.blocks, nextId: v1.board.nextId, regions: {}, top: {}, bot: {} };
  for (const n of v1.board.nets) {
    root.regions[n.id] = { value: n.value };
    if (n.knob) root.regions[n.id].knob = n.knob;
    for (const [x, y] of n.top) root.top[x + ',' + y] = n.id;
  }
  const d = F.decode({ version: 2, root, defs: {}, values: {} });
  assert.ok(!d.project.root.regions && d.project.root.wires.length >= 5);
  const c = compile(d.project);
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.strictEqual(c.params[c.netOf[G.ep('r6', 'out', 0)].i], 1, 'the step knob kept its value');
});

test('old and odd input: internal projects load, lost knobs and jacks are reported, newer versions refused', () => {
  const raw = L.exampleProject(2);
  const d = F.decode(JSON.parse(JSON.stringify(raw)));
  assert.strictEqual(compile(d.project).code, compile(raw).code);
  const doc = F.encode(L.exampleProject(8), {});
  doc.board.blocks.find((b) => b.type === 'clock').params.wobble = 3;   // a knob a newer (or older) app had
  doc.board.wires[0].to = doc.board.wires[0].to.replace(/\d+$/, '9');    // a jack that isn't there
  const r = F.decode(doc);
  assert.strictEqual(r.warnings.length, 2, r.warnings.join('; '));
  assert.ok(compile(r.project).ok);
  assert.throws(() => F.decode(Object.assign({}, doc, { version: F.VERSION + 1 })), /format version/);
  assert.throws(() => F.decode({ hello: 1 }), /not a Sample Factory design/);
  const odd = F.encode(L.exampleProject(0), {});
  odd.board.wires[0].to = 'b99.i0';                                 // a hand edit to a block that isn't there
  const dd = F.decode(odd);
  assert.ok(dd.warnings.some((w) => /doesn't exist/.test(w)) && dd.project.root.wires.length === odd.board.wires.length - 1);
});

test('ids survive, and new ids never collide with them', () => {
  const doc = F.encode(L.exampleProject(0), {});
  doc.board.nextId = 1;                                           // a hand-edited file with a stale counter
  const d = F.decode(doc);
  const b = G.addBlock(d.project.root, d.project.defs, { type: 'add', x: 40, y: 40 });
  assert.ok(!doc.board.blocks.some((x) => x.id === b.id) && !doc.board.wires.some((n) => n.id === b.id));
});

// ---- the curated library and examples --------------------------------------------------
const { readLibrary } = require('../tools/library-node.js');
const LIB = readLibrary(), library2 = LIB.defs;
test('the library: every block in library/index.json loads, without warnings, in canonical form', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'library')).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  assert.deepStrictEqual(LIB.manifest.blocks.map((e) => e.file).slice().sort(), files, 'manifest lists exactly the files');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'library', 'index.json'), 'utf8'), F.manifestText(LIB.manifest, 'blocks'));
  assert.deepStrictEqual(LIB.warnings, []);
  for (const e of LIB.manifest.blocks) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'library', e.file), 'utf8'), doc = JSON.parse(text);
    assert.strictEqual(doc.meta.title, e.title, e.file);
    assert.strictEqual(doc.block.name, e.title, e.file);
    assert.strictEqual(F.stringify(F.encodeBlock(library2, e.title, doc.meta, library2)), text, e.file + ' is canonical');
    const bench = F.decode(text, library2);
    assert.ok(compile(bench.project).ok, e.title + ' compiles on its workbench');
  }
});

const manifest = JSON.parse(fs.readFileSync(path.join(EX, 'index.json'), 'utf8'));
test('the examples manifest lists exactly the files in examples/, with their titles', () => {
  const files = fs.readdirSync(EX).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  assert.deepStrictEqual(manifest.examples.map((e) => e.file).slice().sort(), files);
  assert.strictEqual(fs.readFileSync(path.join(EX, 'index.json'), 'utf8'), F.manifestText(manifest, 'examples'), 'manifest is in canonical form');
  for (const e of manifest.examples) {
    const doc = JSON.parse(fs.readFileSync(path.join(EX, e.file), 'utf8'));
    assert.strictEqual(doc.meta.title, e.title, e.file);
  }
});
for (const e of manifest.examples) {
  test(`curated: ${e.title}: loads with the library without warnings, compiles, and is in canonical form`, () => {
    const text = fs.readFileSync(path.join(EX, e.file), 'utf8');
    const d = F.decode(text, library2);
    assert.deepStrictEqual(d.warnings, []);
    const c = compile(d.project);
    assert.ok(c.ok, JSON.stringify(c.errors));
    // loading and saving again must not rewrite the file
    assert.strictEqual(F.stringify(F.encode(d.project, d.meta, library2)), text);
  });
}

// ---- the move to wires (format 3) --------------------------------------------------------
test('the curated Phasor (drawn in format 2) migrated cell for cell', () => {
  const old = JSON.parse(fs.readFileSync(path.join(FIX, 'phasor-curated-v2.json'), 'utf8'));
  const cur = F.upgrade(old);   // (library/phasor.json has been curated again since, in format 3)
  // every block where it was
  for (const b of old.block.blocks) assert.ok(cur.block.blocks.some((x) => x.id === b.id && x.x === b.x && x.y === b.y), b.id);
  // every trace runs on the cells that were drawn, and every drawn path between pins is still there
  const drawn = new Set(old.block.nets.flatMap((n) => n.top.concat(n.bot).map(([x, y]) => x + ',' + y)));
  for (const w of cur.block.wires) for (const [x, y] of w.path) assert.ok(drawn.has(x + ',' + y), `${w.id} at ${x},${y}`);
  const used = new Set(cur.block.wires.flatMap((w) => w.path.map(([x, y]) => x + ',' + y)));
  const constCells = new Set(cur.block.blocks.filter((b) => b.type === 'const').map((b) => b.x + ',' + b.y));
  for (const c of drawn) assert.ok(used.has(c) || constCells.has(c), 'drawn cell ' + c + ' is still drawn');
});

test('behaviour is unchanged: every example and every library block computes what it did when recorded', () => {
  const rec = JSON.parse(fs.readFileSync(path.join(FIX, 'behaviour.json'), 'utf8'));
  const { run, harness, N } = require('../tools/behaviour.js');
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const same = (a, b, what) => {
    assert.ok(!a.errors && !b.errors, what + ': ' + JSON.stringify(a.errors || b.errors));
    const sigs = [['out', a.out, b.out]].concat(a.probes.map((s, i) => ['output ' + i, s, b.probes[i]]));
    for (const [n, x, y] of sigs) {
      assert.ok(y, `${what}: ${n} missing`);
      assert.ok(close(x.sum, y.sum) && close(x.sum2, y.sum2), `${what}: ${n} sums ${x.sum} vs ${y.sum}`);
      x.at.forEach((v, k) => assert.ok(close(v, y.at[k]), `${what}: ${n} at ${k}`));
    }
  };
  // (examples deleted since the recording are skipped: curation may remove them)
  for (const [file, r] of Object.entries(rec.examples).filter(([f]) => manifest.examples.some((e) => e.file === f))) {
    same(r, run(F.decode(fs.readFileSync(path.join(EX, file), 'utf8'), library2).project, 10 * N), file);
  }
  for (const [name, r] of Object.entries(rec.blocks).filter(([n]) => library2[n])) same(r, run(harness(JSON.parse(JSON.stringify(library2)), name)), name);
});

// ---- the compatibility lock ------------------------------------------------------------
function lockNow() {
  const board = {};
  for (const [type, t] of Object.entries(Object.assign({}, G.ATOMS, G.GATES, G.SOURCES, G.IO, G.MODULE_INFO)).sort()) {
    board[type] = { w: t.w, h: t.h, ins: t.ins.map((p) => [p[0], p[1], G.domOf(t, p)]), outs: t.outs.map((p) => [p[0], p[1], G.domOf(t, p)]) };
  }
  const modules = {};
  for (const [type, m] of Object.entries(G.MODULES).sort()) modules[type] = { params: m.params.map((p) => p.id) };
  return { note: 'What saved designs depend on. See tests/format.test.js before changing it.', formatVersion: F.VERSION, board, modules };
}
test('compatibility lock: footprints, widths, jack and knob ids are unchanged', () => {
  const file = path.join(__dirname, 'compat.lock.json'), now = lockNow();
  const text = JSON.stringify(now, null, 1) + '\n';
  if (process.env.UPDATE_LOCK === '1' || !fs.existsSync(file)) { fs.writeFileSync(file, text); console.log('     (lock written)'); return; }
  const was = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diffs = [];
  for (const sec of ['board', 'modules']) {
    for (const t of Object.keys(was[sec])) {
      if (!now[sec][t]) diffs.push(`${sec} ${t}: removed`);
      else if (JSON.stringify(was[sec][t]) !== JSON.stringify(now[sec][t])) diffs.push(`${sec} ${t}: ${JSON.stringify(was[sec][t])} → ${JSON.stringify(now[sec][t])}`);
    }
    // new types and appended knobs are fine; record them in the lock
  }
  if (was.formatVersion !== now.formatVersion) diffs.push(`format version ${was.formatVersion} → ${now.formatVersion}`);
  assert.deepStrictEqual(diffs, [], 'changes that could break saved designs (add a migration, then UPDATE_LOCK=1):\n     ' + diffs.join('\n     '));
  if (text !== fs.readFileSync(file, 'utf8')) console.log('     (new block types since the lock was written: run with UPDATE_LOCK=1 to record them)');
});

test('a library block saved at a new size: designs using it load with their traces kept and compute the same', () => {
  const { readJson, manifest, ROOT } = require('../tools/library-node.js');
  const files = manifest('library', 'blocks').blocks.map((e) => ({ file: e.file, doc: readJson(path.join(ROOT, 'library', e.file)) }));
  const ph = files.find((f) => f.file === 'phasor.json').doc;
  Object.assign(ph.block, { fw: 3, iw: 40, ih: 24 });                   // the Phasor made as small as an Add
  const lib = F.loadLibrary(files).defs;
  const sheets = (p) => [p.root, ...Object.values(p.defs)];
  const kept = (p) => sheets(p).every((sh) => sh.wires.every((w) => G.isCable(sh, p.defs, w) || G.pathOk(sh, p.defs, w)));
  const exDir = path.join(__dirname, '..', 'examples');
  for (const f of fs.readdirSync(exDir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
    const text = fs.readFileSync(path.join(exDir, f), 'utf8');
    if (!text.includes('"Phasor"')) continue;
    const was = F.decode(text, library2), now = F.decode(text, lib);
    assert.ok(!now.warnings.some((w) => /dropped/.test(w)), f + ': ' + now.warnings.join('; '));
    assert.ok(kept(now.project), f + ': every trace still ends on its pin');
    const c0 = compile(was.project), c1 = compile(now.project);
    assert.strictEqual(c1.ok, c0.ok, f);
    assert.strictEqual([c1.nState, c1.nNets].join(), [c0.nState, c0.nNets].join(), f + ' computes the same');
  }
  // inside the VCO the Phasor's outputs moved two cells left; the traces kept their far ends
  const vco = lib.VCO, b = vco.blocks.find((x) => x.def === 'Phasor');
  for (const w of vco.wires.filter((x) => x.from.startsWith(b.id + '.o'))) assert.strictEqual(w.path[0][0], b.x + 2);
});

// ---- curation: renaming a block everywhere, keeping a copy of one leaving the library --------
test('renaming a library block rewrites every file that uses it; they all still load cleanly, canonically', () => {
  const { readJson } = require('../tools/library-node.js');
  const files = {};
  for (const e of LIB.manifest.blocks) files['library/' + e.file] = readJson(path.join(__dirname, '..', 'library', e.file));
  for (const e of manifest.examples) files['examples/' + e.file] = readJson(path.join(EX, e.file));
  const out = {};
  for (const [f, d] of Object.entries(files)) out[f] = F.docUses(d, 'Phasor') || (d.block && d.block.name === 'Phasor') ? F.renameBlockInDoc(d, 'Phasor', 'Ramp') : d;
  assert.ok(out['library/vco.json'].uses.Ramp && !out['library/vco.json'].uses.Phasor);
  assert.strictEqual(out['library/phasor.json'].block.name, 'Ramp');
  assert.strictEqual(out['library/phasor.json'].meta.title, 'Ramp');
  const lib = F.loadLibrary(Object.entries(out).filter(([f]) => f.startsWith('library/')).map(([file, doc]) => ({ file, doc })));
  assert.deepStrictEqual(lib.warnings, []);
  for (const [f, d] of Object.entries(out)) {
    if (!f.startsWith('examples/')) continue;
    const r = F.decode(d, lib.defs);
    assert.deepStrictEqual(r.warnings, [], f);
    assert.strictEqual(F.stringify(F.encode(r.project, r.meta, lib.defs)), F.stringify(d), f + ' is canonical');
    assert.strictEqual(compile(r.project).code, compile(F.decode(files[f], library2).project).code.replace(/Phasor/g, 'Ramp'), f + ' computes the same');
  }
});

test('a design using a block that leaves the library keeps its own copy, and opens the same without it', () => {
  const text = fs.readFileSync(path.join(EX, 'a-tone-zoom-into-the-vco.json'), 'utf8');
  const kept = F.keepPrivate(text, 'VCO', library2);
  assert.deepStrictEqual(Object.keys(kept.defs), ['VCO']);
  assert.ok(!kept.uses.VCO && kept.uses.Phasor, 'the Phasor inside it is still the library\'s');
  const lib = Object.assign({}, library2); delete lib.VCO;
  const r = F.decode(kept, lib);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(compile(r.project).code, compile(F.decode(text, library2).project).code);
});

test('a file saved before a block\'s ports changed: its wires follow the ports by name', () => {
  const text = fs.readFileSync(path.join(EX, 'sequenced-synth.json'), 'utf8');
  const lib = JSON.parse(JSON.stringify(library2)), ph = lib.Phasor;
  // a new input above Hz: Hz goes from input 0 to input 1; and the "wrap" output is renamed away
  ph.ports.find((p) => p.name === 'Hz').row = 1;
  ph.ports.push({ dir: 'in', row: 0, name: 'sync' });
  const before = F.decode(text, library2).project, after = F.decode(text, lib);
  assert.ok(after.warnings.some((w) => /"Phasor" has different pins.*follow its ports by name/.test(w)), after.warnings.join('; '));
  const copies = after.project.root.blocks.filter((b) => b.def === 'Phasor').map((b) => b.id);
  for (const id of copies) {
    const into = (sh, e) => sh.wires.filter((w) => w.to === e).map((w) => w.from);
    assert.deepStrictEqual(into(after.project.root, G.ep(id, 'in', 1)), into(before.root, G.ep(id, 'in', 0)), id + ': Hz kept its wire');
    assert.deepStrictEqual(into(after.project.root, G.ep(id, 'in', 0)), [], id + ': the new port has none');
  }
  assert.ok(compile(after.project).ok);
});

console.log(`\n${passed} passed`);
