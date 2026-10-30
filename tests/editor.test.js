// Run with: node tests/editor.test.js — the editing core (selection, clipboard, move, delete, undo).
'use strict';
const assert = require('assert');
const G = require('../js/grid/model.js');
const E = require('../js/grid/editor.js');
const { compile } = require('../js/grid/compiler.js');
const L = require('../js/grid/library.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.log('FAIL ' + name + '\n     ' + e.stack.split('\n').slice(0, 3).join('\n     ')); process.exitCode = 1; }
}
const defs = L.starterDefs();
const counter = () => L.exampleProject(0);              // add (4,2), flip-flop (10,3), two more flip-flops, a scope
const rootF = (p) => ({ sheet: p.root, path: '', def: null });
const nets = (p) => new Set(p.root.wires.map((w) => w.from)).size;
// What the design computes, independent of where things sit and what they are called.
const shape = (p) => { const c = compile(p); return [c.ok, c.nState, c.nNets, c.params.length, c.blocks].join(','); };

test('a rectangle selects whole blocks inside it and the wires wholly inside it', () => {
  const p = counter(), F = rootF(p);
  const sel = E.selectRect(F, p.defs, { x0: 0, y0: 0, x1: 13, y1: 6 });
  const ids = p.root.blocks.filter((b) => sel.blocks.has(b.id)).map((b) => b.type).sort();
  assert.deepStrictEqual(ids, ['add', 'const', 'delay']);              // the add, its step knob and the first flip-flop
  const routes = G.routesOf(p.root, p.defs);
  for (const id of sel.wires) for (const [x, y] of routes.get(id)) assert.ok(x <= 13 && y <= 6);
  assert.ok(sel.wires.size >= 2);
  assert.strictEqual(E.selectRect(F, p.defs, { x0: 0, y0: 0, x1: 5, y1: 3 }).blocks.size, 1);   // only the knob
});

test('copy and paste duplicates blocks and the wires between them, with new ids and knobs', () => {
  const p = counter(), F = rootF(p), before = shape(p), n0 = nets(p), b0 = p.root.blocks.length, w0 = p.root.wires.length;
  const all = E.selectAll(F), clip = E.copy(p, F, all);
  assert.strictEqual(clip.blocks.length, b0);
  assert.strictEqual(clip.wires.length, w0);
  assert.ok(clip.blocks.some((b) => b.type === 'const' && b.knob), 'the "step" knob comes along');
  const bb = E.bounds(F, p.defs, all);
  const r = E.paste(p, F, clip, bb.x0, bb.y1 + 3);                      // below the original
  assert.ok(!r.error, r.error);
  assert.strictEqual(p.root.blocks.length, 2 * b0);
  assert.strictEqual(p.root.wires.length, 2 * w0);
  assert.strictEqual(nets(p), 2 * n0);
  assert.strictEqual(new Set(p.root.blocks.map((b) => b.id).concat(p.root.wires.map((w) => w.id))).size, 2 * (b0 + w0));
  for (const w of p.root.wires) assert.ok(G.pathOk(p.root, p.defs, w), 'pasted traces still meet their pins');
  const c = compile(p);
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.strictEqual(c.nState, 2 * compile(counter()).nState);          // two independent counters
  assert.strictEqual(before, shape(counter()));
});

test('paste refuses to overlap blocks, and changes nothing', () => {
  const p = counter(), F = rootF(p), clip = E.copy(p, F, E.selectAll(F));
  const snap = JSON.stringify(p);
  const bb = E.bounds(F, p.defs, E.selectAll(F));
  const r = E.paste(p, F, clip, bb.x0 + 1, bb.y0);
  assert.ok(r.error);
  assert.strictEqual(JSON.stringify(p), snap);
});

test('a block cannot be pasted inside its own definition', () => {
  const p = L.exampleProject(1);                                         // tone: a VCO at the root
  const F = rootF(p), vco = p.root.blocks.find((b) => b.def === 'VCO');
  const sel = E.emptySelection(F); sel.blocks.add(vco.id);
  const clip = E.copy(p, F, sel);
  const inside = { sheet: p.defs.VCO, path: vco.id + '/', def: p.defs.VCO };
  assert.match(E.paste(p, inside, clip, 1, 1).error, /inside itself/);
  const phasor = { sheet: p.defs.Phasor, path: 'x/', def: p.defs.Phasor };   // VCO contains Phasor
  assert.match(E.paste(p, phasor, clip, 1, 1).error, /inside itself/);
});

test('per-instance knob values travel with a copied composite block', () => {
  const p = L.exampleProject(1), F = rootF(p), vco = p.root.blocks.find((b) => b.def === 'VCO');
  p.values[vco.id + '/port.i0'] = 123;
  const sel = E.emptySelection(F); sel.blocks.add(vco.id);
  const r = E.paste(p, F, E.copy(p, F, sel), 4, 14);
  assert.ok(!r.error, r.error);
  const id = [...r.sel.blocks][0];
  assert.strictEqual(p.values[id + '/port.i0'], 123);
});

test('moving everything keeps the design; a move onto another block changes nothing', () => {
  const p = counter(), F = rootF(p), before = shape(p);
  let sel = E.selectAll(F);
  sel = E.move(p, F, sel, 3, 2);
  assert.ok(sel);
  assert.strictEqual(shape(p), before);
  for (const w of p.root.wires) assert.ok(G.pathOk(p.root, p.defs, w));
  const add = p.root.blocks.find((b) => b.type === 'add'), ff = p.root.blocks.find((b) => b.type === 'delay');
  const one = E.emptySelection(F); one.blocks.add(ff.id);
  const snap = JSON.stringify(p);
  assert.strictEqual(E.move(p, F, one, add.x - ff.x, add.y - ff.y), null);
  assert.strictEqual(JSON.stringify(p), snap);
});

test('a moved block drags its wires along; dragging back restores the board exactly', () => {
  const p = counter(), F = rootF(p), before = shape(p);
  const ff = p.root.blocks.find((b) => b.type === 'delay' && b.x === 18);
  const sel = E.emptySelection(F); sel.blocks.add(ff.id);
  const snap = E.snapshot(p.root);
  for (const [dx, dy] of [[3, 0], [0, 4], [-2, 3], [5, -2]]) {
    const r = E.rubberMove(p, F, sel, snap, dx, dy);
    assert.ok(r, `move ${dx},${dy}`);
    assert.strictEqual(shape(p), before, `same design after ${dx},${dy}`);
    for (const w of p.root.wires) assert.ok(G.pathOk(p.root, p.defs, w), `trace of ${w.id} meets its pins after ${dx},${dy}`);
  }
  E.rubberMove(p, F, sel, snap, 0, 0);
  assert.strictEqual(JSON.stringify(E.snapshot(p.root)), JSON.stringify(snap));
});

test('moving one end of a hand-drawn wire keeps the trace near the other end', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('a', 'delay', 0, 0); b.block('z', 'delay', 20, 6);
  const w = G.addWire(r, G.ep(r.blocks[0].id, 'out', 0), G.ep(r.blocks[1].id, 'in', 0),
    [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6], [17, 6], [18, 6], [19, 6], [20, 6]]);
  const p = { version: 2, root: r, defs, values: {} }, F = rootF(p);
  const sel = E.emptySelection(F); sel.blocks.add(r.blocks[1].id);
  assert.ok(E.move(p, F, sel, 0, 3));
  assert.ok(G.pathOk(r, defs, w));
  assert.deepStrictEqual(w.path.slice(0, 13), [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 6]], 'the drawn part stays');
});

test('delete removes blocks with their wires, or just wires', () => {
  const p = counter(), F = rootF(p);
  const ff = p.root.blocks.find((b) => b.type === 'delay' && b.x === 10);
  const sel = E.emptySelection(F); sel.blocks.add(ff.id);
  const touching = p.root.wires.filter((w) => G.parseEp(w.from).b === ff.id || G.parseEp(w.to).b === ff.id).length;
  const n = p.root.wires.length;
  E.remove(p, F, sel);
  assert.ok(!p.root.blocks.includes(ff));
  assert.strictEqual(p.root.wires.length, n - touching);
  const s2 = E.emptySelection(F); s2.wires.add(p.root.wires[0].id);
  const b0 = p.root.blocks.length;
  E.remove(p, F, s2);
  assert.strictEqual(p.root.blocks.length, b0);
  assert.strictEqual(p.root.wires.length, n - touching - 1);
});

test('dragging a straight run of a trace sideways reshapes it, for every wire sharing it', () => {
  const r = G.makeSheet(), b = G.builder(r, defs);
  b.block('a', 'delay', 0, 0); b.block('y', 'delay', 20, 0); b.block('z', 'delay', 20, 4);
  const from = G.ep(r.blocks[0].id, 'out', 0);
  const trunk = [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0]];
  const w1 = G.addWire(r, from, G.ep(r.blocks[1].id, 'in', 0), trunk.concat([[11, 0], [12, 0], [13, 0], [14, 0], [15, 0], [16, 0], [17, 0], [18, 0], [19, 0], [20, 0]]));
  const w2 = G.addWire(r, from, G.ep(r.blocks[2].id, 'in', 0), trunk.concat([[10, 1], [10, 2], [10, 3], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4], [16, 4], [17, 4], [18, 4], [19, 4], [20, 4]]));
  const before = compile({ root: r, defs, values: {} }).code;
  const n = E.dragRun(r, defs, w2.id, [10, 2], 3);                         // the vertical drop, 3 cells right
  assert.strictEqual(n, 1);
  assert.ok(G.pathOk(r, defs, w2) && w2.path.some(([x, y]) => x === 13 && y === 2));
  assert.ok(!w2.path.some(([x, y]) => x === 10 && y === 2));
  assert.strictEqual(E.dragRun(r, defs, w1.id, [5, 0], 2), 2, 'the shared trunk moves for both wires');
  for (const w of r.wires) assert.ok(G.pathOk(r, defs, w));
  assert.deepStrictEqual(w1.path[0], [2, 0], 'pins stay put');
  assert.strictEqual(compile({ root: r, defs, values: {} }).code, before, 'reshaping never changes the design');
});

test('history: undo and redo walk snapshots; a new edit drops the redo branch', () => {
  const h = new E.History(5);
  h.reset('a');
  assert.ok(!h.canUndo && !h.canRedo);
  assert.ok(h.record('b', 'move'));
  assert.ok(!h.record('b', 'nothing'));                                   // unchanged: not recorded
  h.record('c', 'paste');
  assert.strictEqual(h.undoLabel, 'paste');
  assert.deepStrictEqual(h.undo(), { state: 'b', label: 'paste' });
  assert.deepStrictEqual(h.undo(), { state: 'a', label: 'move' });
  assert.strictEqual(h.undo(), null);
  assert.deepStrictEqual(h.redo(), { state: 'b', label: 'move' });
  h.record('d', 'delete');
  assert.ok(!h.canRedo);
  for (const s of ['e', 'f', 'g', 'h']) h.record(s);
  assert.strictEqual(h.stack.length, 5);                                  // capped
});

// ---- resizing a block --------------------------------------------------------------
{
  const F = require('../js/grid/format.js');
  const { readLibrary } = require('../tools/library-node.js');
  const fs = require('fs'), path = require('path');
  const library = readLibrary().defs;
  const phasorText = fs.readFileSync(path.join(__dirname, '..', 'library', 'phasor.json'), 'utf8');
  // The Phasor on a board, its outputs wired out to two flip-flops at the right.
  const wired = () => {
    const p = F.decode(phasorText, library).project, sh = p.root;
    const d1 = G.addBlock(sh, p.defs, { type: 'delay', x: 14, y: 2 }), d2 = G.addBlock(sh, p.defs, { type: 'delay', x: 14, y: 6 });
    G.addWire(sh, { from: 'b1.o0', to: d1.id + '.i0' }); G.addWire(sh, { from: 'b1.o1', to: d2.id + '.i0' });
    G.fixRoutes(sh, p.defs);
    return p;
  };
  const allOk = (sh, defs) => sh.wires.every((w) => G.pathOk(sh, defs, w));

  test('a block can be made smaller: the inside keeps its layout, the outside its wires', () => {
    const p = wired(), def = p.defs.Phasor;
    const inside = JSON.stringify([def.blocks, def.wires]), before = shape(p);
    const pads = JSON.stringify(G.innerPads(def)), inner0 = G.inner(def);
    assert.strictEqual(E.resizeDef(p, 'Phasor', { fw: 3 }), null);
    assert.deepStrictEqual([def.fw, def.fh, def.iw, def.ih], [3, 3, inner0.w, inner0.h]);
    assert.strictEqual(JSON.stringify([def.blocks, def.wires]), inside, 'nothing inside moved');
    assert.strictEqual(JSON.stringify(G.innerPads(def)), pads, 'the inner pads stay put');
    assert.strictEqual(shape(p), before);
    assert.ok(allOk(p.root, p.defs) && allOk(def, p.defs));
    assert.deepStrictEqual(G.pinOf(p.root, p.defs, 'b1.o0'), Object.assign(G.pinOf(p.root, p.defs, 'b1.o0'), { x: 4, y: 2 }));
    // saved and read back: the sizes survive, and the inside is still the curated one
    const again = F.decode(F.encodeBlock(p.defs, 'Phasor'), {}).def;
    assert.deepStrictEqual([again.fw, again.fh, again.iw, again.ih], [3, 3, inner0.w, inner0.h]);
    assert.strictEqual(JSON.stringify([again.blocks, again.wires]), inside);
  });

  test('back to the old size gives the file as it was', () => {
    const p = wired(), fw0 = p.defs.Phasor.fw;
    E.resizeDef(p, 'Phasor', { fw: 3 }); E.resizeDef(p, 'Phasor', { fw: fw0 });
    const doc = JSON.parse(phasorText);
    assert.strictEqual(F.stringify(F.encodeBlock(p.defs, 'Phasor', doc.meta, library)), phasorText);
  });

  test('a resize that does not fit is refused, with a reason, and changes nothing', () => {
    const p = wired(), was = JSON.stringify(p);
    assert.match(E.resizeDef(p, 'Phasor', { fw: 12 }), /no room/);                 // into the flip-flops
    assert.match(E.resizeDef(p, 'Phasor', { fh: 2 }), /row 2/);                    // the wrap output is on row 2
    assert.match(E.resizeDef(p, 'Phasor', { iw: 12 }), /can't be smaller/);         // the drawing is 20 wide
    assert.match(E.resizeDef(p, 'Phasor', { fw: 1 }), /2 wide/);
    assert.strictEqual(JSON.stringify(p), was);
  });

  test('a taller block spreads its pins; wires inside and out follow', () => {
    const p = wired(), before = shape(p);
    assert.strictEqual(E.resizeDef(p, 'Phasor', { fh: 4, ih: 16 }), null);
    assert.ok(allOk(p.root, p.defs) && allOk(p.defs.Phasor, p.defs));
    assert.strictEqual(shape(p), before);
  });
}

test('a copy of a block can have its own size in a design; the block, the program and the wires are unaffected', () => {
  const p = L.exampleProject(2), F = rootF(p), b = p.root.blocks.find((x) => x.def === 'Phasor'), code = compile(p).code, def = p.defs.Phasor;
  const fw0 = def.fw;
  assert.strictEqual(E.resizeInstance(p, F, b, 3, 6), null);
  const fp = G.footprint(b, p.defs);
  assert.deepStrictEqual([fp.w, fp.h, def.fw], [3, 6, fw0]);
  assert.deepStrictEqual(fp.pads.map((q) => [q.dir, q.y - b.y]), [['in', 0], ['out', 0], ['out', 4]], 'pins spread over the height');
  assert.strictEqual(compile(p).code, code);
  assert.ok(p.root.wires.every((w) => G.pathOk(p.root, p.defs, w)));
  assert.match(E.resizeInstance(p, F, b, 3, 1), /share a row/);
  assert.match(E.resizeInstance(p, F, b, 1, 3), /2 wide/);
  assert.strictEqual(E.resizeInstance(p, F, b, null, null), null);
  assert.ok(b.w === undefined && b.h === undefined);
  const Fm = require('../js/grid/format.js');
  E.resizeInstance(p, F, b, 4, 3);
  const back = Fm.decode(Fm.stringify(Fm.encode(p, {}, null))).project.root.blocks.find((x) => x.id === b.id);
  assert.deepStrictEqual([back.w, back.h], [4, undefined], 'saved with the design');
});

test('changing a block\'s ports moves every wire with its port, in its copies and inside it', () => {
  const p = L.exampleProject(2), defs = p.defs, F = rootF(p), code = compile(p).code;
  const copies = p.root.blocks.filter((b) => b.def === 'Phasor');
  const into = (sh, e) => sh.wires.filter((w) => w.to === e).map((w) => w.from).join();
  const was = copies.map((b) => into(p.root, G.ep(b.id, 'in', 0)));
  const insideWas = defs.Phasor.wires.filter((w) => w.from === 'port.i0').map((w) => w.to).join();
  // a new input above Hz
  E.portChange(p, 'Phasor', (d) => { d.ports.find((q) => q.name === 'Hz').row = 1; d.ports.push({ dir: 'in', row: 0, name: 'sync' }); });
  copies.forEach((b, i) => { assert.strictEqual(into(p.root, G.ep(b.id, 'in', 1)), was[i]); assert.strictEqual(into(p.root, G.ep(b.id, 'in', 0)), ''); });
  assert.strictEqual(defs.Phasor.wires.filter((w) => w.from === 'port.i1').map((w) => w.to).join(), insideWas, 'inside, too');
  assert.ok(defs.VCO.wires.some((w) => /\.i1$/.test(w.to) && defs.VCO.blocks.some((b) => b.def === 'Phasor' && w.to.startsWith(b.id + '.'))), 'and in the blocks that contain it');
  // remove it again: back to the same program
  const n = E.portChange(p, 'Phasor', (d) => { d.ports.splice(d.ports.findIndex((q) => q.name === 'sync'), 1); d.ports.find((q) => q.name === 'Hz').row = 0; });
  assert.strictEqual(n, 0, 'no wires were on it');
  assert.strictEqual(compile(p).code, code);
  void F;
});

console.log(`\n${passed} passed`);
