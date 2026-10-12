// Interactivity tests: run inside the real page (index.html?uitest=1), driving it
// with synthetic pointer and keyboard events and checking the resulting project.
// tests/run-ui.py serves the page, opens it in headless Firefox and collects the
// report, which is POSTed to /__ui_result (and shown on the page).
(async () => {
  'use strict';
  const app = window.gapp, G = window.GW, E = G.Editor;
  const canvas = document.getElementById('grid');
  const results = [], errors = [];
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

  // The counter example: add (4,2), flip-flop (10,3), flip-flops (12,9) and (18,9), scope (16,0), step knob at (2,2).
  await test('dragging on empty board box-selects the blocks inside', async () => {
    await fresh(0);
    await drag(1, 0, 13, 6);
    eq(selTypes(), ['add', 'delay'], 'selected blocks');
    ok(app.sel.cells.size > 3, 'trace cells selected too');
  });

  await test('click selects, Shift-click adds and removes, clicking empty board deselects', async () => {
    await fresh(0);
    await click(5, 3);
    eq(selTypes(), ['add']);
    await click(18, 9, { shift: true });
    eq(selTypes(), ['add', 'delay']);
    await click(18, 9, { shift: true });
    eq(selTypes(), ['add']);
    await click(1, 14);
    eq(app.sel, null, 'selection after clicking empty board');
  });

  await test('dragging a block moves it; undo and redo walk the move', async () => {
    await fresh(0);
    const b = blockAt(18, 9), id = b.id;
    await click(18, 9);
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
    await click(12, 9);
    await drag(13, 9, 13, 13);
    eq(root().blocks.find((b) => b.id === id).y, 13, 'moved down');
    await frames(3);
    ok(app.compiled.ok, 'compiles');
    eq([app.compiled.nRegs, app.compiled.nNets, app.compiled.blocks].join(), before, 'same registers, nets and blocks');
  });

  await test('a move into another block is refused', async () => {
    await fresh(0);
    const b = blockAt(12, 9);
    await click(12, 9);
    await drag(12, 9, 5, 3);            // onto the add
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
    await click(18, 9);
    await key('x', { ctrl: true });
    eq(root().blocks.length, n - 1);
    await key('v', { ctrl: true });
    await click(19, 20);
    eq(root().blocks.length, n);
  });

  await test('Ctrl+D duplicates the selection next to itself', async () => {
    await fresh(0, [-2, -2, 30, 30]);
    const n = root().blocks.length;
    await click(18, 9);
    await key('d', { ctrl: true });
    eq(root().blocks.length, n + 1);
    eq(selTypes(), ['delay'], 'the copy is selected');
    ok(!app.sel.blocks.has(blockAt(18, 9).id), 'the copy, not the original');
  });

  await test('arrow keys nudge the selection (Shift: 5 cells)', async () => {
    await fresh(0);
    const id = blockAt(18, 9).id, x = () => root().blocks.find((b) => b.id === id).x;
    await click(18, 9);
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

  await test('clicking a trace selects its track and shows the net', async () => {
    await fresh(0);
    const k = Object.keys(root().top).find((key) => { const [x, y] = G.unkey(key); return !blockAt(x, y) && E.trackAt(root(), app.project.defs, G.TOP, x, y).length >= 4; });
    const [x, y] = G.unkey(k);
    await click(x, y);
    ok(app.sel && app.sel.region === root().top[k], 'net selected');
    ok(app.sel.cells.size >= 4, 'track cells selected');
    ok(/Net /.test(document.getElementById('inspector').textContent), 'inspector shows the net');
  });

  await test('turning a knob changes its value; undo restores it', async () => {
    await fresh(0);
    const rid = Object.keys(root().regions).find((r) => root().regions[r].knob);
    const kb = root().regions[rid].knob, v0 = root().regions[rid].value;
    const c = at(kb.x, kb.y);
    ptr('pointermove', 0, 0, { client: c }); ptr('pointerdown', 0, 0, { client: c });
    ptr('pointermove', 0, 0, { client: { clientX: c.clientX, clientY: c.clientY - 60 } });
    ptr('pointerup', 0, 0, { client: { clientX: c.clientX, clientY: c.clientY - 60 } });
    await frames(2);
    ok(root().regions[rid].value > v0, `value ${root().regions[rid].value} after turning up from ${v0}`);
    await key('z', { ctrl: true });
    eq(root().regions[rid].value, v0, 'value after undo');
  });

  await test('the route tool draws a trace and undo removes it', async () => {
    await fresh(0);
    const nets = () => Object.keys(root().regions).length, n = nets();
    await key('w');
    eq(app.tool, 'route');
    await click(2, 13);
    await click(8, 13);
    await key('Escape');
    eq(nets(), n + 1, 'nets after routing');
    ok(root().top[G.key(5, 13)], 'trace cell painted');
    await key('z', { ctrl: true });
    eq(nets(), n, 'nets after undo');
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
    ok(/2 blocks/.test(document.getElementById('inspector').textContent), 'multi-selection panel');
    const n = root().blocks.length;
    document.querySelector('#inspector [data-act="dup"]').click();
    await frames(2);
    eq(root().blocks.length, n + 2);
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
