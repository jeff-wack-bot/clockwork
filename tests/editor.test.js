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
const counter = () => L.exampleProject(0);              // add (4,2), flip-flop (10,3), two more flip-flops, a scope
const rootF = (p) => ({ sheet: p.root, path: '', def: null });
const nets = (p) => Object.keys(p.root.regions).length;
// What the design computes, independent of where things sit and what they are called.
const shape = (p) => { const c = compile(p); return [c.ok, c.nState, c.nNets, c.params.length, c.blocks].join(','); };

test('a rectangle selects whole blocks inside it and every trace cell inside it', () => {
  const p = counter(), F = rootF(p);
  const sel = E.selectRect(F, p.defs, { x0: 0, y0: 0, x1: 13, y1: 6 });
  const ids = p.root.blocks.filter((b) => sel.blocks.has(b.id)).map((b) => b.type).sort();
  assert.deepStrictEqual(ids, ['add', 'delay']);                       // the add and the first flip-flop
  for (const c of sel.cells) { const [, x, y] = E.unck(c); assert.ok(x <= 13 && y <= 6); }
  assert.ok(sel.cells.size > 5);
  assert.strictEqual(E.selectRect(F, p.defs, { x0: 0, y0: 0, x1: 5, y1: 3 }).blocks.size, 0);   // only part of the add
});

test('copy and paste duplicates blocks and nets with new ids, keeping knobs and values', () => {
  const p = counter(), F = rootF(p), before = shape(p), n0 = nets(p), b0 = p.root.blocks.length;
  const all = E.selectAll(F, p.defs), clip = E.copy(p, F, all);
  assert.strictEqual(clip.blocks.length, b0);
  const knobbed = Object.values(clip.regions).filter((r) => r.knob);
  assert.strictEqual(knobbed.length, 1);                                // the "step" knob comes along
  const bb = E.bounds(F, p.defs, all);
  const r = E.paste(p, F, clip, bb.x0, bb.y1 + 3);                      // below the original
  assert.ok(!r.error, r.error);
  assert.strictEqual(p.root.blocks.length, 2 * b0);
  assert.strictEqual(nets(p), 2 * n0);
  assert.strictEqual(new Set(p.root.blocks.map((b) => b.id)).size, 2 * b0);
  assert.strictEqual(r.sel.blocks.size, b0);
  const c = compile(p);
  assert.ok(c.ok, JSON.stringify(c.errors));
  assert.strictEqual(c.nState, 2 * compile(counter()).nState);          // two independent counters
  assert.strictEqual(before, shape(counter()));
});

test('paste refuses to overlap blocks or cross traces, and changes nothing', () => {
  const p = counter(), F = rootF(p), clip = E.copy(p, F, E.selectAll(F, p.defs));
  const snap = JSON.stringify(p);
  const bb = E.bounds(F, p.defs, E.selectAll(F, p.defs));
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
  p.values[vco.id + '/r99'] = 123;
  const sel = E.emptySelection(F); sel.blocks.add(vco.id);
  const r = E.paste(p, F, E.copy(p, F, sel), 4, 14);
  assert.ok(!r.error, r.error);
  const id = [...r.sel.blocks][0];
  assert.strictEqual(p.values[id + '/r99'], 123);
});

test('moving everything keeps the design; a blocked move changes nothing', () => {
  const p = counter(), F = rootF(p), before = shape(p);
  let sel = E.selectAll(F, p.defs);
  sel = E.move(p, F, sel, 3, 2);
  assert.ok(sel);
  assert.strictEqual(shape(p), before);
  // move one flip-flop onto the add: refused
  const add = p.root.blocks.find((b) => b.type === 'add'), ff = p.root.blocks.find((b) => b.type === 'delay');
  const one = E.emptySelection(F); one.blocks.add(ff.id);
  const snap = JSON.stringify(p);
  assert.strictEqual(E.move(p, F, one, add.x - ff.x, add.y - ff.y), null);
  assert.strictEqual(JSON.stringify(p), snap);
});

test('moving part of a net splits it; the knob moves with its cell', () => {
  const p = counter(), F = rootF(p);
  const rid = Object.keys(p.root.regions).find((r) => p.root.regions[r].knob);
  const kb = Object.assign({}, p.root.regions[rid].knob);
  const sel = E.emptySelection(F);
  sel.cells.add(E.ck(G.TOP, kb.x, kb.y));
  const n0 = nets(p);
  const moved = E.move(p, F, sel, 0, -2);
  assert.ok(moved);
  assert.strictEqual(nets(p), n0 + 1);                                    // the lifted cell is its own net now
  const owner = p.root.top[G.key(kb.x, kb.y - 2)];
  assert.ok(owner && p.root.regions[owner].knob && p.root.regions[owner].knob.y === kb.y - 2);
});

test('delete removes blocks and cells and splits what is left', () => {
  const p = counter(), F = rootF(p);
  const ff = p.root.blocks.find((b) => b.type === 'delay' && b.x === 10);
  const sel = E.emptySelection(F); sel.blocks.add(ff.id);
  E.remove(p, F, sel);
  assert.ok(!p.root.blocks.includes(ff));
  // erase the middle of a long trace: it becomes two nets
  const p2 = counter(), F2 = rootF(p2);
  const k = Object.keys(p2.root.top).find((key) => { const [x, y] = G.unkey(key); return E.trackAt(p2.root, p2.defs, G.TOP, x, y).length >= 5; });
  const [x, y] = G.unkey(k), track = E.trackAt(p2.root, p2.defs, G.TOP, x, y), mid = track[Math.floor(track.length / 2)];
  const s2 = E.emptySelection(F2); s2.cells.add(E.ck(...mid));
  const n0 = nets(p2);
  E.remove(p2, F2, s2);
  assert.strictEqual(nets(p2), n0 + 1);
});

test('the track under a cell runs between junctions and pins', () => {
  const p = counter(), occ = G.occupancy(p.root, p.defs);
  for (const k in p.root.top) {
    const [x, y] = G.unkey(k), t = E.trackAt(p.root, p.defs, G.TOP, x, y);
    assert.ok(t.length >= 1);
    for (const [, cx, cy] of t.slice(1, -1)) assert.ok(!occ.has(G.key(cx, cy)), 'a pin inside a track');
  }
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

test('dragging a block without its traces re-routes its pins (rubber-band)', () => {
  const p = counter(), F = rootF(p), before = shape(p);
  const ff = p.root.blocks.find((b) => b.type === 'delay' && b.x === 18);   // sits on its own output trace's way
  const sel = E.emptySelection(F); sel.blocks.add(ff.id);
  assert.strictEqual(E.move(p, F, sel, 3, 0), null);                       // a strict move is blocked by its own trace
  const snap = E.snapshot(p.root);
  for (const [dx, dy] of [[3, 0], [0, 4], [-2, 3], [5, -2]]) {
    const r = E.rubberMove(p, F, sel, snap, dx, dy);
    assert.ok(r, `move ${dx},${dy}`);
    assert.strictEqual(r.unconnected.length, 0, `unconnected after ${dx},${dy}`);
    assert.strictEqual(shape(p), before, `same design after ${dx},${dy}`);
  }
  const back = E.rubberMove(p, F, sel, snap, 0, 0);                         // dragging back restores the original exactly
  assert.ok(back);
  assert.strictEqual(JSON.stringify(p.root), JSON.stringify(Object.assign({}, p.root, E.snapshot(snap))));
});

test('a pin may not land on another net; a pin that cannot be routed back is reported', () => {
  const p = counter(), F = rootF(p);
  const add = p.root.blocks.find((b) => b.type === 'add');
  const sel = E.emptySelection(F); sel.blocks.add(add.id);
  const snap = E.snapshot(p.root);
  const own = G.footprint(add, p.defs).pads.map((q) => p.root.top[G.key(q.x, q.y)]);
  let reported = 0;
  for (let dy = 1; dy <= 8; dy++) for (let dx = -3; dx <= 3; dx++) {
    const r = E.rubberMove(p, F, sel, snap, dx, dy);
    if (!r) continue;
    const pads = G.footprint(p.root.blocks.find((b) => b.id === add.id), p.defs).pads;
    pads.forEach((q, i) => {
      const rid = p.root.top[G.key(q.x, q.y)];
      assert.ok(!rid || rid === own[i], `pin ${i} on ${rid} after ${dx},${dy}`);
    });
    const missing = pads.filter((q, i) => p.root.top[G.key(q.x, q.y)] !== own[i]).length;
    assert.strictEqual(missing, r.unconnected.length, `reported unconnected pins after ${dx},${dy}`);
    reported += r.unconnected.length;
  }
  assert.ok(reported > 0, 'some position boxes a pin in');
});

console.log(`\n${passed} passed`);
