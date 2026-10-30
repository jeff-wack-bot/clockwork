// Interactivity tests: run inside the real page (index.html?uitest=1), driving it
// with synthetic pointer and keyboard events and checking the resulting project.
// tests/run-ui.py serves the page, opens it in headless Firefox and collects the
// report, which is POSTed to /__ui_result (and shown on the page).
(async () => {
  'use strict';
  const app = window.gapp, G = window.GW, E = G.Editor;
  const canvas = document.getElementById('grid');
  const results = [], errors = [];
  window.__uiResults = results; window.__uiErrors = errors;
  window.addEventListener('error', (e) => errors.push(e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.confirm = () => true;
  window.prompt = () => null;

  const frames = async (n) => { for (let i = 0; i < (n || 2); i++) await new Promise((r) => requestAnimationFrame(r)); };
  const settle = () => { Object.assign(app.view.cam, app.view.target); app.view.anchor = null; app.view.dirty = true; };
  async function fresh(example, rect) {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const search = document.getElementById('palette-search');
    if (search.value) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
    app.loadExample(example);
    await frames(3);
    const r = rect || [-2, -2, 30, 16];
    app.view.fitRect(r[0], r[1], r[2], r[3], 0); settle();
    app.select(null);
    await frames(2);
  }
  const root = () => app.project.root;
  const blockAt = (x, y) => root().blocks.find((b) => { const fp = G.footprint(b, app.project.defs); return x >= b.x && y >= b.y && x < b.x + fp.w && y < b.y + fp.h; });
  const selTypes = () => (app.sel ? root().blocks.filter((b) => app.sel.blocks.has(b.id)).map((b) => b.type).sort() : []);

  // Events at the centre of root-board cell (x, y).
  function at(x, y) {
    const r = canvas.getBoundingClientRect(), p = app.view.toScreen(x + 0.5, y + 0.5);
    return { clientX: r.left + p.x, clientY: r.top + p.y };
  }
  function ptr(type, x, y, o) {
    o = o || {};
    const c = o.client || at(x, y);
    canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      button: o.button || 0, buttons: type === 'pointerup' ? 0 : (o.button === 2 ? 2 : 1), shiftKey: !!o.shift, clientX: c.clientX, clientY: c.clientY }));
  }
  async function click(x, y, o) { ptr('pointermove', x, y, o); ptr('pointerdown', x, y, o); ptr('pointerup', x, y, o); await frames(2); }
  async function drag(x0, y0, x1, y1, o) {
    ptr('pointermove', x0, y0, o); ptr('pointerdown', x0, y0, o);
    const n = 6;
    for (let i = 1; i <= n; i++) ptr('pointermove', x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, o);
    ptr('pointerup', x1, y1, o);
    await frames(2);
  }
  async function key(k, o) {
    o = o || {};
    const init = { key: k, bubbles: true, cancelable: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
    await frames(2);
  }
  function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'expected'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
  function ok(v, msg) { if (!v) throw new Error(msg || 'assertion failed'); }
  async function test(name, fn) {
    const t0 = performance.now();
    try { await fn(); results.push({ name, ok: true, ms: Math.round(performance.now() - t0) }); }
    catch (e) { results.push({ name, ok: false, error: (e && e.message || String(e)) + ' | ' + String(e && e.stack || '').split('\n').slice(0, 2).join(' | ') }); }
    // leave no mode behind
    app.drag = null; app.pasting = null; app.placing = null; app.route = null;
  }

  // Wait for the page to finish starting up.
  for (let i = 0; i < 100 && !(app && app.project && app.compiled); i++) await new Promise((r) => setTimeout(r, 50));

  // The counter example: add (4,2), flip-flop (10,3), flip-flops (12,9) and (18,9), the step knob
  // (a Constant) at (2,2). A flip-flop is 3 cells wide: input pin, body, output pin; pins start wires.
  await test('dragging on empty board box-selects the blocks inside', async () => {
    await fresh(0);
    await drag(1, 0, 13, 6);
    eq(selTypes(), ['add', 'const', 'delay'], 'selected blocks');
    ok(app.sel.wires.size >= 2, 'the wires inside too');
  });

  await test('click selects, Shift-click adds and removes, clicking empty board deselects', async () => {
    await fresh(0);
    await click(5, 3);
    eq(selTypes(), ['add']);
    await click(19, 9, { shift: true });
    eq(selTypes(), ['add', 'delay']);
    await click(19, 9, { shift: true });
    eq(selTypes(), ['add']);
    await click(1, 14);
    eq(app.sel, null, 'selection after clicking empty board');
  });

  await test('dragging a block moves it; undo and redo walk the move', async () => {
    await fresh(0);
    const b = blockAt(18, 9), id = b.id;
    await click(19, 9);
    await drag(19, 9, 22, 9);
    const moved = root().blocks.find((x) => x.id === id);
    eq(moved.x, 21, 'x after drag');
    ok(!document.getElementById('btn-undo').disabled, 'undo button enabled');
    await key('z', { ctrl: true });
    eq(root().blocks.find((x) => x.id === id).x, 18, 'x after undo');
    await key('z', { ctrl: true, shift: true });
    eq(root().blocks.find((x) => x.id === id).x, 21, 'x after redo');
  });

  await test('dragging a block drags its traces along and the design still compiles the same', async () => {
    await fresh(0);
    const before = [app.compiled.nRegs, app.compiled.nNets, app.compiled.blocks].join();
    const id = blockAt(12, 9).id;
    await click(13, 9);
    await drag(13, 9, 13, 13);
    eq(root().blocks.find((b) => b.id === id).y, 13, 'moved down');
    await frames(3);
    ok(app.compiled.ok, 'compiles');
    eq([app.compiled.nRegs, app.compiled.nNets, app.compiled.blocks].join(), before, 'same registers, nets and blocks');
    for (const w of root().wires) ok(G.pathOk(root(), app.project.defs, w), 'every trace still meets its pins');
  });

  await test('a move into another block is refused', async () => {
    await fresh(0);
    const b = blockAt(12, 9);
    await click(13, 9);
    await drag(13, 9, 5, 3);            // onto the add
    const after = root().blocks.find((x) => x.id === b.id);
    ok(!(after.x <= 6 && after.x + 2 >= 4 && after.y >= 2 && after.y <= 4), 'it ended up on top of the add');
  });

  await test('Delete removes the selection and undo restores it', async () => {
    await fresh(0);
    const n = root().blocks.length;
    await click(5, 3);
    await key('Delete');
    eq(root().blocks.length, n - 1);
    eq(app.sel, null);
    await key('z', { ctrl: true });
    eq(root().blocks.length, n);
  });

  await test('select all, copy and paste duplicates the design, and it still compiles', async () => {
    await fresh(0, [-2, -2, 30, 34]);
    const n = root().blocks.length, regs = app.compiled.nRegs;
    await key('a', { ctrl: true });
    eq(app.sel.blocks.size, n, 'all blocks selected');
    await key('c', { ctrl: true });
    await key('v', { ctrl: true });
    ok(app.pasting, 'paste mode');
    await click(13, 24);
    eq(root().blocks.length, 2 * n, 'blocks after paste');
    ok(!app.pasting, 'paste mode ends');
    await frames(3);
    ok(app.compiled.ok, 'compiles: ' + JSON.stringify(app.compiled.errors));
    eq(app.compiled.nRegs, 2 * regs, 'registers');
    eq(app.sel.blocks.size, n, 'the pasted copy is selected');
  });

  await test('a paste that does not fit is refused', async () => {
    await fresh(0);
    const n = root().blocks.length;
    await click(5, 3);
    await key('c', { ctrl: true });
    await key('v', { ctrl: true });
    await click(11, 3);                 // on the flip-flop
    eq(root().blocks.length, n);
    ok(app.pasting, 'still in paste mode');
    await key('Escape');
    ok(!app.pasting, 'Esc cancels');
  });

  await test('cut removes and paste puts it back elsewhere', async () => {
    await fresh(0, [-2, -2, 30, 30]);
    const n = root().blocks.length;
    await click(19, 9);
    await key('x', { ctrl: true });
    eq(root().blocks.length, n - 1);
    await key('v', { ctrl: true });
    await click(19, 20);
    eq(root().blocks.length, n);
  });

  await test('Ctrl+D duplicates the selection next to itself', async () => {
    await fresh(0, [-2, -2, 30, 30]);
    const n = root().blocks.length;
    await click(19, 9);
    await key('d', { ctrl: true });
    eq(root().blocks.length, n + 1);
    eq(selTypes(), ['delay'], 'the copy is selected');
    ok(!app.sel.blocks.has(blockAt(18, 9).id), 'the copy, not the original');
  });

  await test('arrow keys nudge the selection (Shift: 5 cells)', async () => {
    await fresh(0);
    const id = blockAt(18, 9).id, x = () => root().blocks.find((b) => b.id === id).x;
    await click(19, 9);
    await key('ArrowRight');
    eq(x(), 19);
    await key('ArrowRight', { shift: true });
    eq(x(), 24);
    await key('z', { ctrl: true });
    eq(x(), 19);
  });

  await test('Escape deselects', async () => {
    await fresh(0);
    await click(5, 3);
    ok(app.sel);
    await key('Escape');
    eq(app.sel, null);
  });

  await test('clicking a trace selects its wire and shows the net; dragging it sideways reshapes it', async () => {
    await fresh(0);
    const routes = app.view.routes(root());
    let pick = null;
    for (const w of root().wires) {
      const r = routes.get(w.id);
      for (let i = 2; i < r.length - 2 && !pick; i++) {
        const [x, y] = r[i];
        if (!blockAt(x, y) && r[i - 1][1] === y && r[i + 1][1] === y && E.netAt(root(), routes, x, y).wire === w) pick = { w, x, y };
      }
      if (pick) break;
    }
    ok(pick, 'a horizontal run to click');
    await click(pick.x, pick.y);
    ok(app.sel && app.sel.wires.has(pick.w.id) && app.sel.net === pick.w.from, 'wire and net selected');
    ok(/Net/.test(document.getElementById('inspector').textContent), 'inspector shows the net');
    const code = app.compiled.code;
    await drag(pick.x, pick.y, pick.x, pick.y + 2);
    const now = root().wires.find((w) => w.id === pick.w.id);
    ok(now.path.some(([x, y]) => x === pick.x && y === pick.y + 2), 'the run moved down 2: ' + JSON.stringify(now.path));
    ok(G.pathOk(root(), app.project.defs, now), 'still meets its pins');
    await frames(2);
    eq(app.compiled.code, code, 'the design is unchanged');
    await key('z', { ctrl: true });
    ok(!root().wires.find((w) => w.id === pick.w.id).path.some(([x, y]) => x === pick.x && y === pick.y + 2), 'undo puts it back');
  });

  await test('turning a knob changes its value; undo restores it', async () => {
    await fresh(0);
    const k = root().blocks.find((b) => b.type === 'const' && b.knob), v0 = k.value, id = k.id;
    const c = at(k.x, k.y);
    ptr('pointermove', 0, 0, { client: c }); ptr('pointerdown', 0, 0, { client: c });
    ptr('pointermove', 0, 0, { client: { clientX: c.clientX, clientY: c.clientY - 60 } });
    ptr('pointerup', 0, 0, { client: { clientX: c.clientX, clientY: c.clientY - 60 } });
    await frames(2);
    const v1 = root().blocks.find((b) => b.id === id).value;
    ok(v1 > v0, `value ${v1} after turning up from ${v0}`);
    await key('z', { ctrl: true });
    eq(root().blocks.find((b) => b.id === id).value, v0, 'value after undo');
  });

  await test('dragging from an output pin to an input wires them, replacing what was there; undo restores it', async () => {
    await fresh(0, [-2, -2, 30, 16]);
    const out = G.ep(blockAt(18, 9).id, 'out', 0), d1In = G.ep(blockAt(12, 9).id, 'in', 0);
    const was = G.wiresInto(root(), d1In)[0].from;
    await drag(20, 9, 12, 9);                                   // the last flip-flop's output → the first one's input
    eq(G.wiresInto(root(), d1In).map((w) => w.from), [out], 'it now reads the last flip-flop');
    ok(G.pathOk(root(), app.project.defs, G.wiresInto(root(), d1In)[0]), 'with a routed trace');
    await key('z', { ctrl: true });
    eq(G.wiresInto(root(), d1In).map((w) => w.from), [was], 'undo');
  });

  await test('dragging a wire off an input removes it', async () => {
    await fresh(0, [-2, -2, 30, 16]);
    const d1In = G.ep(blockAt(12, 9).id, 'in', 0), n = root().wires.length;
    await drag(12, 9, 26, 13);                                  // pick it up at the input, drop it on empty board
    eq(G.wiresInto(root(), d1In).length, 0);
    eq(root().wires.length, n - 1);
  });

  await test('the Draw wire tool keeps exactly the trace you click out; undo removes it', async () => {
    await fresh(0, [-2, -2, 30, 16]);
    const out = G.ep(blockAt(18, 9).id, 'out', 0), d1In = G.ep(blockAt(12, 9).id, 'in', 0);
    await key('w');
    eq(app.tool, 'route');
    await click(20, 9);                                         // start on the output pin
    await click(24, 9);                                         // a corner
    await click(24, 13);                                        // another
    await click(11, 13);
    await click(11, 9);
    await click(12, 9);                                         // finish on the first flip-flop's input
    const w = G.wiresInto(root(), d1In)[0];
    eq(w.from, out);
    eq([w.path[0], w.path[4], w.path[8], w.path[w.path.length - 1]], [[20, 9], [24, 9], [24, 13], [12, 9]]);
    ok(w.path.some(([x, y]) => x === 11 && y === 13), 'through every corner');
    await key('z', { ctrl: true });
    ok(G.wiresInto(root(), d1In)[0].from !== out, 'undo');
    await key('v');
    eq(app.tool, 'select');
  });

  await test('right-drag pans without touching the selection', async () => {
    await fresh(0);
    await click(5, 3);
    const x0 = app.view.cam.x, sel = app.sel;
    await drag(20, 12, 10, 12, { button: 2 });
    ok(app.view.cam.x > x0 + 1, 'camera moved');
    ok(app.sel === sel, 'selection kept');
  });

  await test('palette search filters blocks; Enter starts placing the first match', async () => {
    await fresh(0);
    const input = document.getElementById('palette-search');
    input.focus(); input.value = 'werck'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...document.querySelectorAll('#palette-list [data-place]')].map((e) => e.textContent);
    eq(items, ['▣Tune Werckmeister'], 'items');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ok(app.placing && app.placing.def === 'Tune Werckmeister', 'placing ' + JSON.stringify(app.placing));
    ok(document.activeElement !== input, 'focus returns to the board');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    await key('Escape');
    ok(!app.placing);
  });

  await test('placing a block from the palette is one undo step', async () => {
    await fresh(0);
    const n = root().blocks.length;
    document.querySelector('#palette-list [data-place="atom:mul"]').click();
    await click(4, 13);
    eq(root().blocks.length, n + 1);
    await key('z', { ctrl: true });
    eq(root().blocks.length, n);
  });

  await test('loading an example can be undone', async () => {
    await fresh(0);
    const before = JSON.stringify(root());
    app.loadExample(1);
    await frames(3);
    ok(JSON.stringify(root()) !== before);
    await key('z', { ctrl: true });
    eq(JSON.stringify(root()), before);
  });

  await test('the inspector acts on a multiple selection', async () => {
    await fresh(0, [-2, -2, 30, 30]);
    await drag(1, 0, 13, 6);
    ok(/3 blocks/.test(document.getElementById('inspector').textContent), 'multi-selection panel');
    const n = root().blocks.length;
    document.querySelector('#inspector [data-act="dup"]').click();
    await frames(2);
    eq(root().blocks.length, n + 3);
  });

  // ---- three kinds of signal on one canvas ----------------------------------------------
  // Screen positions of exact board points (a jack's centre, a knob), in the root frame.
  function atPoint(x, y) { const r = canvas.getBoundingClientRect(), p = app.view.toScreen(x, y); return { clientX: r.left + p.x, clientY: r.top + p.y }; }
  async function dragPts(a, b, o) {
    ptr('pointermove', 0, 0, Object.assign({ client: a }, o)); ptr('pointerdown', 0, 0, Object.assign({ client: a }, o));
    for (let i = 1; i <= 6; i++) ptr('pointermove', 0, 0, Object.assign({ client: { clientX: a.clientX + (b.clientX - a.clientX) * i / 6, clientY: a.clientY + (b.clientY - a.clientY) * i / 6 } }, o));
    ptr('pointerup', 0, 0, Object.assign({ client: b }, o));
    await frames(2);
  }
  const blockOf = (type) => root().blocks.find((b) => b.type === type);
  const jack = (b, dir, i) => { const p = G.footprint(b, app.project.defs).pads.find((q) => q.dir === dir && q.idx === i); return atPoint(p.fx, p.fy); };
  const jackIdx = (b, dir, id) => (dir === 'in' ? G.MODULES[b.type].ins : G.MODULES[b.type].outs).findIndex((q) => q.id === id);

  await test('the palette has a section for each kind of signal, the converters and the sockets', async () => {
    await fresh(0);
    const heads = [...document.querySelectorAll('#palette-list h3')].map((h) => h.textContent);
    for (const h of ['Float', 'Fixed point', 'Analog', 'Converters', 'Sockets']) ok(heads.includes(h), h);
    for (const t of ['and', 'dff', 'split', 'bits', 'vco', 'volts', 'voltmeter', 'awg', 'word', 'value', 'exp2', 'log2', 'table', 'in', 'out']) ok(document.querySelector(`#palette-list [data-place="atom:${t}"]`), t);
    for (const n of ['ADC', 'DAC', 'DAC (one-sided)', 'Quantizer', 'Hz → V/OCT']) ok(document.querySelector(`#palette-list [data-place="def:${n}"]`), 'converter block ' + n);
    const items = [...document.querySelectorAll('#palette-list h3, #palette-list .pitem')].map((e) => e.textContent);
    ok(items.indexOf('⇄ADC') > items.indexOf('Converters') && items.indexOf('⇄ADC') < items.indexOf('Sockets'), 'the converter blocks are listed with the converters');
    ok(!document.querySelector('#palette-list [data-place="atom:scope"]'), 'no scope');
    ok(!document.getElementById('btn-rack') && !document.getElementById('rack'), 'no rack view');
  });

  await test('placing an analog module puts its panel on the board, knobs and all; undo removes it', async () => {
    await fresh(0, [-2, -2, 40, 30]);
    const n = root().blocks.length;
    document.querySelector('#palette-list [data-place="atom:noise"]').click();
    await click(30, 20);
    eq(root().blocks.length, n + 1);
    const m = root().blocks[n];
    eq(m.type, 'noise'); eq(m.params, G.MODULES.noise.defaults());
    const fp = G.footprint(m, app.project.defs);
    eq([fp.w, fp.h], [2, 13]);
    ok(app.compiled.ok, 'compiles');
    await key('z', { ctrl: true });
    eq(root().blocks.length, n);
  });

  await test('dragging jack → jack patches a cable: no route, a colour; dragging its plug off unplugs it', async () => {
    await app.loadDesignFile('analog-voice.json'); await frames(4);
    app.view.fitAll(); settle(); await frames(2);
    const lfo = blockOf('lfo'), vco = blockOf('vco'), n = root().wires.length;
    const into = G.ep(vco.id, 'in', jackIdx(vco, 'in', 'fm'));
    await dragPts(jack(lfo, 'out', jackIdx(lfo, 'out', 'tri')), jack(vco, 'in', jackIdx(vco, 'in', 'fm')));
    const w = G.wiresInto(root(), into)[0];
    ok(w, 'patched');
    eq(root().wires.length, n + 1);
    ok(!w.path && w.style && /^#/.test(w.style.color), 'a cable with a colour, never routed');
    ok(app.compiled.ok, 'compiles');
    await dragPts(jack(vco, 'in', jackIdx(vco, 'in', 'fm')), atPoint(60, 40));
    eq(G.wiresInto(root(), into).length, 0, 'unplugged');
    await key('z', { ctrl: true });
    eq(G.wiresInto(root(), into).length, 1, 'undo puts it back');
  });

  await test('a wire between two kinds of signal is refused, and says to use a converter', async () => {
    await app.loadDesignFile('analog-voice.json'); await frames(4);
    app.view.fitAll(); settle(); await frames(2);
    const vco = blockOf('vco'), out = blockOf('out'), n = root().wires.length;
    const op = G.footprint(out, app.project.defs).pads[0];
    await dragPts(jack(vco, 'out', jackIdx(vco, 'out', 'sin')), atPoint(op.x + 0.5, op.y + 0.5));
    eq(root().wires.length, n, 'no wire');
    ok(/converter/.test(document.getElementById('toast').textContent), document.getElementById('toast').textContent);
  });

  await test('dragging a knob on a panel turns it; double-click resets it; undo restores', async () => {
    await app.loadDesignFile('analog-voice.json'); await frames(4);
    const vcf = blockOf('vcf'), m = G.MODULES.vcf, kq = m.panel.lay.knobs.find((q) => q.id === 'freq'), sc = m.panel.scale;
    app.view.fitRect(vcf.x - 1, vcf.y - 1, vcf.x + 8, vcf.y + 14, 0); settle(); await frames(2);
    const c = atPoint(vcf.x + kq.x * sc, vcf.y + kq.y * sc), f0 = vcf.params.freq, code = app.compiled.code;
    await dragPts(c, { clientX: c.clientX, clientY: c.clientY - 40 });
    await frames(2);
    ok(root().blocks.find((b) => b.id === vcf.id).params.freq > f0 * 1.5, 'cutoff went up');
    eq(app.compiled.code, code, 'turning a knob does not recompile');
    ptr('pointermove', 0, 0, { client: c });
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: c.clientX, clientY: c.clientY }));
    await frames(2);
    eq(root().blocks.find((b) => b.id === vcf.id).params.freq, m.params.find((p) => p.id === 'freq').def, 'reset to its default');
    await key('z', { ctrl: true }); await key('z', { ctrl: true });
    eq(root().blocks.find((b) => b.id === vcf.id).params.freq, f0, 'undo');
  });

  await test('clicking a cable selects it; its colour and droop are set in the inspector', async () => {
    await app.loadDesignFile('analog-feedback-loops.json'); await frames(4);
    app.view.fitAll(); settle(); await frames(2);
    const w = root().wires.find((x) => G.isCable(root(), app.project.defs, x));
    const p = app.view.cablePath(app.view.jackPoint(root(), w.from), app.view.jackPoint(root(), w.to), w.style && w.style.droop), mid = app.view.bez(p, 0.5);
    await click(0, 0, { client: atPoint(mid[0], mid[1]) });
    ok(app.sel && app.sel.wires.has(w.id), 'selected');
    const droop = document.querySelector('#inspector [data-prop="style.droop"]');
    ok(droop, 'a droop slider');
    droop.value = '2.5'; droop.dispatchEvent(new Event('change', { bubbles: true }));
    await frames(2);
    eq(root().wires.find((x) => x.id === w.id).style.droop, 2.5);
    const col = document.querySelector('#inspector [data-prop="style.color"]');
    col.value = '#123456'; col.dispatchEvent(new Event('change', { bubbles: true }));
    eq(root().wires.find((x) => x.id === w.id).style.color, '#123456');
  });

  await test('double-clicking a trace puts a via there (the trace changes layer); again removes it', async () => {
    await fresh(0);
    const ff = blockAt(10, 3), d1 = blockAt(12, 9);
    const w = G.wiresInto(root(), G.ep(d1.id, 'in', 0))[0], r = app.view.routes(root()).get(w.id), i = Math.floor(r.length / 2), c = r[i];
    ptr('pointermove', c[0], c[1]);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ...at(c[0], c[1]) }));
    await frames(2);
    const w1 = root().wires.find((x) => x.id === w.id);
    ok(w1.style && w1.style.vias && w1.style.vias.length === 1, 'a via');
    const L = G.renderLayout(root(), app.project.defs);
    ok(L.top[c.join(',')] && L.bot[c.join(',')], 'on both layers at that cell');
    ok(app.compiled.ok);
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, ...at(c[0], c[1]) }));
    await frames(2);
    eq(root().wires.find((x) => x.id === w.id).style.vias.length, 0, 'removed');
    void ff;
  });

  await test('a fixed-point design: gates, a bus width, and the barcode\'s bits in the status line', async () => {
    await fresh(0, [-2, -2, 30, 16]);
    const p = app.project, r = G.makeSheet(), b = G.builder(r, p.defs);
    b.block('x', 'bits', 1, 1, { width: 6, value: 0b101100 }); b.block('n', 'not', 4, 1);
    b.net('x.out0', 'n.in0');
    p.root = r; app.version++; app.changed(); await frames(4);
    app.host.step(); await frames(3);                           // the counter's clock is slow: one tick
    ok(app.compiled.ok, 'compiles');
    const nb = r.blocks.find((q) => q.type === 'not');
    eq(app.compiled.widths[G.ep(nb.id, 'out', 0)], 6);
    eq(app.valueOf(G.ep(nb.id, 'out', 0)), 0b010011);
    ptr('pointermove', 6, 1); await frames(1);
    ok(/fixed\) = 010011/.test(document.getElementById('status').textContent), document.getElementById('status').textContent);
  });

  // ---- design files and curated examples ------------------------------------------------
  await test('the Examples menu lists the curated examples; opening one sets its clock, and is undoable', async () => {
    await fresh(0);
    await app.manifestReady;
    const opts = [...document.querySelectorAll('#examples option')].map((o) => o.value);
    ok(app.manifest && app.manifest.examples.length >= 1, 'manifest loaded');
    eq(opts.filter((v) => v.startsWith('c:')).length, app.manifest.examples.length, 'one menu entry per curated example');
    eq(opts.filter((v) => v.startsWith('b:')).length, app.libManifest.blocks.length, 'one menu entry per library block');
    const before = JSON.stringify(app.project.root);
    await app.loadDesignFile('analog-voice.json');
    await frames(3);
    eq(root().blocks.filter((b) => G.MODULES[b.type] && G.MODULES[b.type].panel).length, 9, 'nine module panels on the board');
    ok(app.compiled.ok, 'compiles');
    eq(app.compiled.outs.map((o) => o.name), ['out']);
    eq(app.curated.file, 'analog-voice.json');
    await key('z', { ctrl: true });
    eq(JSON.stringify(app.project.root), before, 'undo brings the previous design back');
  });

  await test('a saved design opens to the same design, at the saved opening view', async () => {
    await fresh(2, [0, 0, 30, 12]);
    const code = app.compiled.code;
    const shown = [app.view.toWorld(0, 0), app.view.toWorld(app.view.W, app.view.H)];
    const meta = { title: 'Round trip', rate: 1000, camera: { board: [shown[0].x, shown[0].y, shown[1].x, shown[1].y] } };
    const text = app.designText(meta);
    app.loadExample(0);
    await frames(3);
    app.openDesign(JSON.parse(text), 'open round trip', null);
    await frames(4);
    eq(app.compiled.code, code, 'same program');
    eq(Math.round(app.host.rate), 1000, 'clock');
    const a = app.view.toWorld(0, 0);
    ok(Math.abs(a.x - shown[0].x) < 0.5 && Math.abs(a.y - shown[0].y) < 0.5, `opening view ${a.x},${a.y} vs ${shown[0].x},${shown[0].y}`);
    eq(app.designText(meta), text, 'saving again gives the same text');
  });

  await test('the Save as example dialog fills in from the open design and names the file', async () => {
    await app.loadDesignFile('the-comma-pump.json');
    await frames(3);
    document.getElementById('btn-save-example').click();
    await frames(1);
    eq(document.getElementById('sv-title').value, 'The comma pump');
    ok(/examples\/the-comma-pump\.json \(replaces/.test(document.getElementById('sv-status').textContent), document.getElementById('sv-status').textContent);
    document.getElementById('sv-file').value = ''; document.getElementById('sv-title').value = 'My new one';
    document.getElementById('sv-title').dispatchEvent(new Event('input'));
    ok(/examples\/my-new-one\.json \(new/.test(document.getElementById('sv-status').textContent), 'new file name from the title');
    document.getElementById('save-dlg').close();
  });

  await test('opening a library block puts it on its workbench, zoomed into its insides', async () => {
    await app.loadDesignFile('phasor.json', false, 'library');
    await frames(4);
    eq(app.project.root.blocks.map((b) => b.def), ['Phasor']);
    eq([app.curated.kind, app.curated.name], ['block', 'Phasor']);
    const v = app.view, a = v.toWorld(0, 0), b = v.toWorld(v.W, v.H), d = app.project.defs.Phasor;
    ok(a.x >= 1.8 && b.x <= 2.2 + d.fw * 1.1 + 2 && (b.x - a.x) < d.fw * 2.5, `view ${a.x.toFixed(2)}..${b.x.toFixed(2)} frames the block`);
    ok(app.compiled.ok, 'compiles');
    eq(Object.keys(app.blockStatus()), [], 'nothing differs from the library');
  });

  await test('an edited block is marked in the palette, and Save offers it for the library', async () => {
    await app.loadDesignFile('vco.json', false, 'library');
    await frames(3);
    app.project.defs.Phasor.blocks.find((b) => b.type === 'const').value += 1;   // an edit inside the Phasor inside the VCO
    app.changed(); app.commit('edit');
    await frames(2);
    eq(app.blockStatus(), { Phasor: 'edited' });
    const pal = document.querySelector('#palette-list [data-place="def:Phasor"]');
    ok(pal && /•/.test(pal.textContent), 'palette marks it');
    document.getElementById('btn-save-example').click();
    await frames(1);
    const what = document.getElementById('sv-what');
    ok([...what.options].some((o) => o.value === 'block:Phasor' && /edited/.test(o.textContent)), 'Phasor offered');
    eq(what.value, 'block:VCO', 'the open block is the default');
    ok(/Also saves the blocks inside it that changed: Phasor/.test(document.getElementById('sv-status').textContent), document.getElementById('sv-status').textContent);
    what.value = 'example'; what.dispatchEvent(new Event('change'));
    ok(/keeps its own versions of Phasor/.test(document.getElementById('sv-status').textContent), 'example save explains the private copy');
    document.getElementById('save-dlg').close();
    const doc = JSON.parse(app.blockText('VCO'));
    eq(Object.keys(doc.defs), ['Phasor'], 'a downloaded VCO file carries the edited Phasor');
  });

  await test('a block saved to the library reaches the designs that use it', async () => {
    const saved = app.library;
    try {
      const lib = Object.assign({}, saved.defs, { Phasor: JSON.parse(JSON.stringify(saved.defs.Phasor)) });
      lib.Phasor.description = 'curated by hand';
      app.library = Object.assign({}, saved, { defs: lib, text: {} });
      await app.loadDesignFile('a-tone-zoom-into-the-vco.json');
      await frames(3);
      eq(app.project.defs.Phasor.description, 'curated by hand');
      ok(app.compiled.ok, 'compiles');
      eq(Object.keys(app.blockStatus()), []);
    } finally { app.library = saved; }
  });

  await test('a block is resized in the block editor, not where it sits in another design', async () => {
    await app.loadDesignFile('vco.json', false, 'library');
    await frames(3);
    const ph = app.project.defs.VCO.blocks.find((b) => b.def === 'Phasor');
    app.select(Object.assign(E.emptySelection(app.view.child(app.view.rootFrame(), app.project.root.blocks[0])), { blocks: new Set([ph.id]) }));
    await frames(2);
    ok(!document.querySelector('#inspector [data-prop^="size."]'), 'no size fields inside the VCO');
    ok(/block editor/.test(document.getElementById('inspector').textContent), 'says where to resize it');
    app.select(null); await frames(2);
    ok(document.querySelector('#inspector [data-prop="size.fw"]'), 'the VCO\'s own size, in its block editor');
  });

  await test('a block can be resized in the block editor; the inside is untouched; undo puts it back', async () => {
    await app.loadDesignFile('phasor.json', false, 'library');
    await frames(3);
    const d = () => app.project.defs.Phasor, inside = JSON.stringify([d().blocks, d().wires]), n0 = G.inner(d()), fw0 = d().fw;
    app.select(null);
    await frames(2);
    const fw = document.querySelector('#inspector [data-prop="size.fw"]');
    ok(fw, 'a size field');
    fw.value = '3'; fw.dispatchEvent(new Event('change', { bubbles: true }));
    await frames(3);
    eq([d().fw, d().fh, d().iw, d().ih], [3, 3, n0.w, n0.h]);
    eq(JSON.stringify([d().blocks, d().wires]), inside, 'inside unchanged');
    ok(app.compiled.ok, 'compiles');
    eq(app.blockStatus().Phasor, 'edited');
    eq(Object.keys(app.blockStatus()).sort(), ['Phasor', 'SineVCO', 'VCO'], 'the blocks with a Phasor inside re-attached their wires');
    const fh = document.querySelector('#inspector [data-prop="size.fh"]');
    fh.value = '2'; fh.dispatchEvent(new Event('change', { bubbles: true }));
    await frames(2);
    eq(d().fh, 3, 'refused: the wrap output is on row 2');
    app.undo(); await frames(2);
    eq(d().fw, fw0, 'undone');
  });

  await test('the block editor shows the block itself, nothing selected: description, size, ports, defaults; + input adds one', async () => {
    await app.loadDesignFile('scaled-awg.json', false, 'library'); await frames(4);
    app.select(null); await frames(2);
    const ins = document.getElementById('inspector');
    for (const q of ['def.description', 'size.fw', 'size.iw', 'port.0.name', 'port.0.domain', 'pdef.0.value']) ok(ins.querySelector(`[data-prop="${q}"]`), q);
    ok(!ins.querySelector('[data-prop$=".row"]'), 'no position boxes');
    const d = () => app.project.defs['Scaled AWG'], n = d().ports.length;
    eq(ins.querySelectorAll('table.portgrid tbody tr').length, d().fh, 'a row for every row of the block');
    const free = [...ins.querySelectorAll('[data-act="addport"][data-dir="in"]')][0], row = Number(free.dataset.row);
    free.click(); await frames(2);
    eq(d().ports.length, n + 1, 'a port more');
    ok(ins.querySelector(`[data-cell="in:${row}"] .port`), 'and the grid shows it at once (it used to wait for a click elsewhere)');
    eq(document.activeElement, ins.querySelector(`[data-cell="in:${row}"] input`), 'ready to be named');
    ok(G.innerPads(d()).some((p) => p.dir === 'in' && p.idx === 1), 'a pad inside for it');
    // drag it onto the port on row 0: they swap rows
    const other = d().ports.find((p) => p.dir === 'in' && p.row === 0), mine = d().ports.find((p) => p.dir === 'in' && p.row === row);
    const dt = new DataTransfer(), src = ins.querySelector(`[data-cell="in:${row}"] .port`), cell = ins.querySelector('[data-cell="in:0"]');
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await frames(2);
    eq([d().ports.find((p) => p.name === mine.name).row, d().ports.find((p) => p.name === other.name).row], [0, row], 'dragged onto row 0, the two swapped');
    ok(ins.querySelector('[data-cell="in:0"] input').value === mine.name, 'the grid follows');
    await key('z', { ctrl: true }); await key('z', { ctrl: true });
    eq(d().ports.length, n, 'undo');
    app.select(Object.assign(E.emptySelection(app.view.rootFrame()), { blocks: new Set(['b1']) })); await frames(2);
    ok(ins.querySelector('[data-prop="port.0.name"]'), 'selecting the block shows the same');
    ok(!ins.querySelector('[data-act="delete"]'), 'and it cannot be deleted from its own editor');
  });

  await test('a library block in a design: only its size here is editable; Edit block… opens the block editor', async () => {
    await app.loadDesignFile('sequenced-synth.json'); await frames(4);
    const b = root().blocks.find((x) => x.def === 'Phasor'), code = app.compiled.code;
    app.select(Object.assign(E.emptySelection(app.view.rootFrame()), { blocks: new Set([b.id]) })); await frames(2);
    const ins = document.getElementById('inspector');
    for (const q of ['def.description', 'port.0.name', 'pdef.0.value', 'size.fw', 'size.iw']) ok(!ins.querySelector(`[data-prop="${q}"]`), 'no ' + q);
    const w = ins.querySelector('[data-prop="isize.w"]');
    ok(w, 'its size here');
    w.value = '3'; w.dispatchEvent(new Event('change', { bubbles: true })); await frames(3);
    eq([b.w, G.footprint(b, app.project.defs).w], [3, 3]);
    eq(app.project.defs.Phasor.fw, 6, 'the block itself is unchanged');
    eq(app.compiled.code, code, 'it computes the same');
    ok(root().wires.every((x) => G.isCable(root(), app.project.defs, x) || G.pathOk(root(), app.project.defs, x)), 'wires still end on their pins');
    const text = app.designText(app.curated.meta);
    ok(/"w": 3/.test(text), 'the size is saved with the design');
    ins.querySelector('[data-act="isizereset"]').click(); await frames(2);
    ok(b.w === undefined, 'back to the block\'s own size');
    ins.querySelector('[data-act="editblock"]').click();
    for (let i = 0; i < 80 && !(app.curated && app.curated.kind === 'block'); i++) await new Promise((r) => setTimeout(r, 25));
    eq([app.curated.kind, app.curated.name], ['block', 'Phasor'], 'opened in the block editor');
  });

  await test('wiring between library blocks at a working zoom: pins stay on the board, and a drop near a pin snaps to it', async () => {
    await app.loadDesignFile('sequenced-synth.json'); await frames(4);
    const sp = root().blocks.find((b) => b.def === 'Phasor' && b.y === 2) || root().blocks.find((b) => b.def === 'Phasor');
    const env = root().blocks.find((b) => b.def === 'Decay');
    // zoomed so that 24 px is a cell: the Phasor's inside is big enough to enter, its pins must not be
    const cx = (sp.x + env.x) / 2 + 3, cy = (sp.y + env.y) / 2 + 2;
    app.view.cam.z = app.view.target.z = 24; app.view.cam.x = app.view.target.x = cx; app.view.cam.y = app.view.target.y = cy; settle(); await frames(2);
    const out = G.footprint(sp, app.project.defs).pads.find((p) => p.dir === 'out' && p.name === 'wrap');
    const inp = G.footprint(env, app.project.defs).pads.find((p) => p.dir === 'in');
    const r = canvas.getBoundingClientRect(), V = app.view;
    const h = V.locate(V.toScreen(out.x + 0.85, out.y + 0.5).x, V.toScreen(out.x + 0.85, out.y + 0.5).y);
    eq(h.F.path, '', 'the pin\'s tab is on the outer board, not inside the Phasor');
    eq(V.locate(V.toScreen(out.x + 0.3, out.y + 0.5).x, V.toScreen(out.x + 0.3, out.y + 0.5).y).F.path, sp.id + '/', 'the rest of its cell is the inside');
    G.removeWires(root(), new Set(G.wiresInto(root(), G.ep(env.id, 'in', inp.idx)).map((w) => w.id)));
    // drop a little off the input pin: it snaps
    const a = V.toScreen(out.x + 1.1, out.y + 0.5), b = V.toScreen(inp.x - 0.3, inp.y + 1.1);   // from the half of the tab outside the block
    ptr('pointermove', 0, 0, { client: { clientX: r.left + a.x, clientY: r.top + a.y } });
    ptr('pointerdown', 0, 0, { client: { clientX: r.left + a.x, clientY: r.top + a.y } });
    for (let i = 1; i <= 6; i++) ptr('pointermove', 0, 0, { client: { clientX: r.left + a.x + (b.x - a.x) * i / 6, clientY: r.top + a.y + (b.y - a.y) * i / 6 } });
    ok(app.drag && app.drag.cands && app.drag.cands.length > 3, 'the pins it can go to are offered');
    eq(app.drag.target, G.ep(env.id, 'in', inp.idx), 'snapped to the input');
    ptr('pointerup', 0, 0, { client: { clientX: r.left + b.x, clientY: r.top + b.y } }); await frames(2);
    eq(G.wiresInto(root(), G.ep(env.id, 'in', inp.idx)).map((w) => w.from), [G.ep(sp.id, 'out', out.idx)], 'wired');
    ok(app.compiled.ok, 'compiles');
  });

  await test('a new input above the others, saved: the files that use the block are updated, wires on the same ports', async () => {
    await app.loadDesignFile('scaled-voltmeter.json', false, 'library'); await frames(4);
    app.select(null); await frames(2);
    const ins = document.getElementById('inspector'), D = () => app.project.defs['Scaled Voltmeter'];
    const sig = D().ports.findIndex((p) => p.name === 'in');
    // move the signal input down a row, then add an input where it was (above it)
    ins.querySelector(`[data-act="portmove"][data-i="${sig}"][data-by="1"]`).click(); await frames(2);
    ins.querySelector('[data-act="addport"][data-dir="in"][data-row="1"]').click(); await frames(2);
    document.activeElement.blur();
    eq(G.portsOf(D(), 'in').map((p) => p.name), ['range', 'in1', 'in']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 200 && /•/.test(document.getElementById('curated').textContent); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300));
    const ex = await (await fetch('examples/analog-voice.json', { cache: 'no-store' })).json();
    ok(/in@0:range in@1:in1 in@2:in/.test(ex.uses['Scaled Voltmeter']), 'the example now has the new pins: ' + ex.uses['Scaled Voltmeter']);
    const vm = ex.board.blocks.find((b) => b.def === 'Scaled Voltmeter');
    ok(ex.board.wires.some((w) => w.to === vm.id + '.i2') && !ex.board.wires.some((w) => w.to === vm.id + '.i1'), 'its signal wire is on "in" (now input 2)');
    ok(Object.keys(ex.values).includes(vm.id + '/port.i0'), 'its range setting stayed on range');
    const r = GW.Format.decode(ex, app.library.defs);
    eq(r.warnings, [], 'it opens cleanly');
    ok(GW.compile(r.project).ok, 'and compiles');
  });

  await test('in the block editor, clicking inside the block selects what is inside, even under an outer pin', async () => {
    await app.loadDesignFile('phasor.json', false, 'library'); await frames(4);
    const V = app.view, bench = root().blocks[0], r = canvas.getBoundingClientRect();
    const pin = G.footprint(bench, app.project.defs).pads.find((p) => p.dir === 'in');
    const at = (wx, wy) => { const q = V.toScreen(wx, wy); return { clientX: r.left + q.x, clientY: r.top + q.y }; };
    // the middle of the outer input pin's cell is inside the block: no wire starts there
    const c = at(pin.x + 0.6, pin.y + 0.5), loc = V.locate(c.clientX - r.left, c.clientY - r.top);
    eq(loc.F.path, bench.id + '/', 'inside the block');
    ptr('pointermove', 0, 0, { client: c }); ptr('pointerdown', 0, 0, { client: c });
    ok(!(app.drag && app.drag.kind === 'wire'), 'no wire started');
    ptr('pointerup', 0, 0, { client: c }); await frames(2);
    // and the inside's blocks are selected by a click, wherever they are
    const F = V.child(V.rootFrame(), bench), mul = app.project.defs.Phasor.blocks.find((b) => b.type === 'mul');
    await click(0, 0, { client: at(F.ox + (mul.x + 1.5) * F.sc, F.oy + (mul.y + 1.5) * F.sc) });
    ok(app.sel && app.sel.F.path === bench.id + '/' && app.sel.blocks.has(mul.id), 'the inner block is selected');
  });

  await test('in the block editor, the inside\'s port pads wire like any pin (a block with its port wires lost is mended)', async () => {
    await app.loadDesignFile('onepole.json', false, 'library'); await frames(4);
    const V = app.view, bench = root().blocks[0], def = app.project.defs.OnePole, F = V.child(V.rootFrame(), bench), r = canvas.getBoundingClientRect();
    const at = (x, y) => { const q = V.toScreen(F.ox + x * F.sc, F.oy + y * F.sc); return { clientX: r.left + q.x, clientY: r.top + q.y }; };
    const drag2 = async (a, b) => { ptr('pointermove', 0, 0, { client: a }); ptr('pointerdown', 0, 0, { client: a }); for (let i = 1; i <= 6; i++) ptr('pointermove', 0, 0, { client: { clientX: a.clientX + (b.clientX - a.clientX) * i / 6, clientY: a.clientY + (b.clientY - a.clientY) * i / 6 } }); ptr('pointerup', 0, 0, { client: b }); await frames(2); };
    // take both port wires away (as in a layout that lost them), then draw them again
    def.wires = def.wires.filter((w) => !w.from.startsWith('port.') && !w.to.startsWith('port.')); app.version++; app.changed(); await frames(2);
    const pads = G.innerPads(def), pin = pads.find((p) => p.dir === 'in'), pout = pads.find((p) => p.dir === 'out');
    const mul = def.blocks.find((b) => b.type === 'mul' && G.footprint(b, app.project.defs).pads.some((q) => q.dir === 'in' && !def.wires.some((w) => w.to === G.ep(b.id, 'in', q.idx))));
    const mpad = G.footprint(mul, app.project.defs).pads.find((q) => q.dir === 'in' && !def.wires.some((w) => w.to === G.ep(mul.id, 'in', q.idx)));
    const ff = def.blocks.find((b) => b.type === 'delay'), fpad = G.footprint(ff, app.project.defs).pads.find((q) => q.dir === 'out');
    await drag2(at(pin.x + 0.5, pin.y + 0.5), at(mpad.x + 0.5, mpad.y + 0.5));
    ok(def.wires.some((w) => w.from === 'port.i0' && w.to === G.ep(mul.id, 'in', mpad.idx)), 'the input pad wired in: ' + JSON.stringify(def.wires.map((w) => w.from + '>' + w.to)));
    await drag2(at(fpad.x + 0.5, fpad.y + 0.5), at(pout.x + 0.5, pout.y + 0.5));
    ok(def.wires.some((w) => w.from === G.ep(ff.id, 'out', 0) && w.to === 'port.o0'), 'the output pad wired');
    ok(!root().wires.length, 'nothing wired to the block\'s own outer pins');
  });

  await test('zoomed into a block in a design: clicks act on the block, its knobs still turn, nothing inside changes', async () => {
    await app.loadDesignFile('sequenced-synth.json'); await frames(4);
    const V = app.view, sq = root().blocks.find((b) => b.def === 'Seq4'), def = app.project.defs.Seq4, before = JSON.stringify(def);
    const fp = G.footprint(sq, app.project.defs), x0 = sq.x;
    V.fitRect(sq.x, sq.y, sq.x + fp.w, sq.y + fp.h, 0); settle(); await frames(3);
    const F = V.child(V.rootFrame(), sq), r = canvas.getBoundingClientRect();
    const inner = def.blocks.find((b) => b.type === 'gt'), q = V.toScreen(F.ox + (inner.x + 1.5) * F.sc, F.oy + (inner.y + 1.5) * F.sc);
    const c = { clientX: r.left + q.x, clientY: r.top + q.y };
    eq(V.locate(q.x, q.y).F.path, sq.id + '/', 'the pointer is inside Seq4');
    await click(0, 0, { client: c });
    ok(app.sel && app.sel.F.path === '' && app.sel.blocks.has(sq.id) && app.sel.blocks.size === 1, 'the click selected Seq4 itself');
    ptr('pointermove', 0, 0, { client: c }); ptr('pointerdown', 0, 0, { client: c });
    ptr('pointermove', 0, 0, { client: { clientX: c.clientX + 200, clientY: c.clientY } }); ptr('pointerup', 0, 0, { client: { clientX: c.clientX + 200, clientY: c.clientY } }); await frames(2);
    eq(JSON.stringify(app.project.defs.Seq4), before, 'nothing inside Seq4 moved');
    const sq2 = root().blocks.find((b) => b.def === 'Seq4'), fp2 = G.footprint(sq2, app.project.defs);   // (a move replaces the block objects)
    V.fitRect(sq2.x, sq2.y, sq2.x + fp2.w, sq2.y + fp2.h, 0); settle(); await frames(3);
    const F2 = V.child(V.rootFrame(), sq2);
    const k = def.blocks.find((b) => b.type === 'const' && b.knob), kq = V.toScreen(F2.ox + (k.x + 0.5) * F2.sc, F2.oy + (k.y + 0.5) * F2.sc);
    const kc = { clientX: r.left + kq.x, clientY: r.top + kq.y };
    ptr('pointermove', 0, 0, { client: kc }); ptr('pointerdown', 0, 0, { client: kc });
    ptr('pointermove', 0, 0, { client: { clientX: kc.clientX, clientY: kc.clientY - 50 } }); ptr('pointerup', 0, 0, { client: { clientX: kc.clientX, clientY: kc.clientY - 50 } }); await frames(2);
    ok(app.project.values[sq.id + '/' + k.id] !== undefined, 'a knob inside turned, as this copy\'s setting');
    eq(JSON.stringify(app.project.defs.Seq4), before, 'and the block is unchanged');
  });

  await test('a Table is placed with a straight line, its points edited in the inspector, and it compiles to its curve', async () => {
    await fresh(0, [-2, -2, 30, 16]);
    document.querySelector('#palette-list [data-place="atom:table"]').click();
    await click(24, 12);
    const t = root().blocks.find((b) => b.type === 'table');
    ok(t && t.points.length === 2, 'placed');
    const ta = document.querySelector('#inspector [data-prop="table.points"]');
    ta.value = '0 0\n1 10\n2 5'; ta.dispatchEvent(new Event('change', { bubbles: true })); await frames(3);
    eq(t.points, [[0, 0], [1, 10], [2, 5]]);
    ok(app.compiled.ok && /lut\(/.test(app.compiled.code), 'compiled to a lookup');
  });

  // ---- the Files manager (served by the curator server, from a copy of the repository) --------
  const FL = () => app.files;
  const row = (file) => document.querySelector(`#fl-list tr[data-file="${file}"]`);
  const act = async (file, a) => {
    const r = row(file);
    if (!r) throw new Error(`no row for ${file} in the ${FL().tab} tab: ${[...document.querySelectorAll('#fl-list tr[data-file]')].map((x) => x.dataset.file).join(' ')}`);
    r.querySelector(`[data-act="${a}"]`).click(); await frames(2);
  };
  const commitEdit = async (value) => { const i = document.getElementById('fl-edit'); i.value = value; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await waitIdle(); };
  const waitIdle = async () => { for (let i = 0; i < 200 && FL().busy; i++) await new Promise((r) => setTimeout(r, 25)); await frames(3); };
  const getJson = async (path) => (await fetch(path, { cache: 'no-store' })).json();
  const closeFiles = () => { const d = document.getElementById('files-dlg'); if (d.open) d.close(); };

  await test('Files lists the examples and the library blocks, with what uses what; Ctrl+O opens it', async () => {
    ok(app.curator, 'served by the curator server');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true }));
    await waitIdle(); await FL().refresh();
    ok(document.getElementById('files-dlg').open, 'open');
    eq(document.querySelectorAll('#fl-list tr[data-file]').length, app.manifest.examples.length);
    document.querySelector('#files-dlg [data-tab="library"]').click(); await frames(2);
    eq(document.querySelectorAll('#fl-list tr[data-file]').length, app.libManifest.blocks.length);
    const about = row('phasor.json').querySelector('.small').textContent;
    ok(/inside .*VCO/.test(about), about);
    closeFiles();
  });

  await test('a new example is a file at once, opens empty, and Ctrl+S saves what is built in it', async () => {
    await FL().open('examples');
    document.getElementById('fl-new').click(); await frames(2);
    await commitEdit('My sketch');
    ok(app.manifest.examples.some((e) => e.file === 'my-sketch.json'), 'in the menu');
    eq(app.curated && app.curated.file, 'my-sketch.json');
    eq(root().blocks.length, 0, 'empty');
    G.addBlock(root(), app.project.defs, { type: 'add', x: 2, y: 2 }); app.changed(); app.commit('place');
    await frames(2);
    ok(/my-sketch\.json •/.test(document.getElementById('curated').textContent), 'marked unsaved: ' + document.getElementById('curated').textContent);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && /•/.test(document.getElementById('curated').textContent); i++) await new Promise((r) => setTimeout(r, 25));
    ok(!/•/.test(document.getElementById('curated').textContent), 'saved');
    eq((await getJson('examples/my-sketch.json')).board.blocks.map((b) => b.type), ['add']);
  });

  await test('rename an example (it keeps its place), duplicate it, delete the copy, and undo the delete', async () => {
    await FL().open('examples');
    const at = app.manifest.examples.findIndex((e) => e.file === 'my-sketch.json');
    await act('my-sketch.json', 'rename'); await commitEdit('Sketch one');
    eq(app.manifest.examples[at], { file: 'sketch-one.json', title: 'Sketch one' }, 'same place, new name');
    eq(app.curated.file, 'sketch-one.json', 'the open design follows');
    await act('sketch-one.json', 'dup'); await commitEdit('Sketch two');
    ok(app.manifest.examples.some((e) => e.file === 'sketch-two.json'));
    await act('sketch-two.json', 'delete'); await waitIdle();
    ok(!app.manifest.examples.some((e) => e.file === 'sketch-two.json'), 'gone from the menu');
    ok(app.trash.some((t) => t.file === 'sketch-two.json'), 'in the trash');
    document.querySelector('#fl-status [data-act="restore"]').click(); await waitIdle();
    ok(app.manifest.examples.some((e) => e.file === 'sketch-two.json'), 'restored by Undo');
    await act('sketch-two.json', 'delete'); await waitIdle();
    document.querySelector('#files-dlg [data-tab="trash"]').click(); await frames(2);
    ok(/Sketch two/.test(document.getElementById('fl-list').textContent), 'the trash tab lists it');
    closeFiles();
  });

  await test('reordering the examples changes the Open menu', async () => {
    await FL().open('examples');
    const first = app.manifest.examples[0].file, second = app.manifest.examples[1].file;
    await act(second, 'up'); await waitIdle();
    eq([app.manifest.examples[0].file, app.manifest.examples[1].file], [second, first]);
    ok(document.querySelector('#examples option[value^="c:"]').value === 'c:' + second, 'menu follows');
    await act(second, 'down'); await waitIdle();
    eq(app.manifest.examples[0].file, first);
    closeFiles();
  });

  await test('a new block opens on its workbench; renaming a block updates every file that uses it', async () => {
    await FL().open('library');
    document.getElementById('fl-new').click(); await frames(2);
    await commitEdit('Wobble');
    eq([app.curated.kind, app.curated.name], ['block', 'Wobble']);
    eq(root().blocks.map((b) => b.def), ['Wobble']);
    ok(app.library.defs.Wobble, 'in the library');
    await FL().open('library');
    await act('phasor.json', 'rename'); await commitEdit('Ramp');
    ok(!app.library.defs.Phasor && app.library.defs.Ramp, 'renamed in the library');
    const vco = await getJson('library/ramp.json'), vcoUser = await getJson('library/vco.json');
    eq(vco.block.name, 'Ramp');
    ok(vcoUser.uses.Ramp && !vcoUser.uses.Phasor && vcoUser.block.blocks.some((b) => b.def === 'Ramp'), 'VCO now contains Ramp');
    const ex = await (await fetch('examples/sequenced-synth.json', { cache: 'no-store' })).json();
    ok(ex.uses.Ramp && !ex.uses.Phasor, 'and the examples use Ramp');
    eq(app.library.warnings, [], 'the library still loads cleanly');
    closeFiles();
  });

  await test('a block inside others cannot be deleted; one only examples use leaves them a copy', async () => {
    await FL().open('library');
    await act('ramp.json', 'delete'); await waitIdle();
    ok(/contain/.test(document.getElementById('fl-status').textContent) && app.library.defs.Ramp, document.getElementById('fl-status').textContent);
    const users = FL().usersOf('Counter4').examples.map((e) => e.file);
    ok(users.length >= 1, 'Counter4 is used by an example');
    await act('counter4.json', 'delete'); await waitIdle();
    ok(!app.library.defs.Counter4, 'gone from the library');
    for (const f of users) {
      const d = await getJson('examples/' + f);
      ok(d.defs.Counter4 && !d.uses.Counter4, f + ' keeps its own copy');
      const r = GW.Format.decode(d, app.library.defs);
      eq(r.warnings, [], f + ' opens cleanly');
      ok(GW.compile(r.project).ok, f + ' compiles');
    }
    closeFiles();
  });

  // ---- report --------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok).length;
  const report = { passed: results.length - failed, failed: failed + errors.length, results, errors };
  const box = document.createElement('pre');
  box.id = 'ui-report';
  box.style.cssText = 'position:fixed;top:50px;left:200px;right:300px;max-height:80%;overflow:auto;background:#0b0c10ee;color:#d8dce6;z-index:99;font:12px monospace;padding:10px;border:1px solid #5ec8e5';
  box.textContent = results.map((r) => (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.error)).join('\n') +
    (errors.length ? '\n\npage errors:\n' + errors.join('\n') : '') + `\n\n${report.passed} passed, ${report.failed} failed`;
  document.body.appendChild(box);
  try { await fetch('/__ui_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }); } catch (e) { /* not under the runner */ }
})();
