// Application glue: project state, navigation, palette, inspector, persistence.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'clockwork.project.v1';
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const app = {
    project: null,
    nav: [{ def: null, inst: null }],   // root, then one frame per composite entered
    sel: new Set(),
    selWire: null,
    compiled: null,  // latest compile result (may contain errors)
    running: null,   // program currently running (last one without errors)
    snap: null,
    host: null,
    editor: null,
  };
  window.app = app;

  // ---- model access ----------------------------------------------------------
  app.frame = () => app.nav[app.nav.length - 1];
  app.patch = () => (app.frame().def ? app.project.defs[app.frame().def] : app.project.root);
  app.navKey = () => app.nav.map((f) => (f.def || 'root') + '@' + (f.inst || '')).join('/');
  // Hierarchical path prefix of what is on screen, or null if it has no live instance.
  app.viewPath = () => {
    let p = '';
    for (const f of app.nav.slice(1)) { if (!f.inst) return null; p += f.inst + '/'; }
    return p;
  };
  app.problemIds = () => {
    const ids = new Set(), path = app.viewPath();
    if (!app.compiled || path === null) return ids;
    for (const pp of app.compiled.problemPaths) {
      if (pp && pp.startsWith(path)) ids.add(pp.slice(path.length).split('/')[0]);
    }
    return ids;
  };
  function uses(defName, target, seen) {
    const def = app.project.defs[defName];
    if (!def) return false;
    seen = seen || new Set();
    if (seen.has(defName)) return false;
    seen.add(defName);
    return def.blocks.some((b) => b.type === 'comp' && (b.def === target || uses(b.def, target, seen)));
  }
  function canPlace(defName) {
    const cur = app.frame().def;
    return !cur || (defName !== cur && !uses(defName, cur));
  }
  function newId(patch) { return 'b' + (patch.nextId++); }
  function blockAtPath(path) {
    let patch = app.project.root, b = null;
    for (const id of path.split('/')) {
      if (!patch) return null;
      b = patch.blocks.find((x) => x.id === id);
      if (!b) return null;
      patch = b.type === 'comp' ? app.project.defs[b.def] : null;
    }
    return b;
  }
  function instancesOf(defName) {
    let n = 0;
    for (const p of [app.project.root, ...Object.values(app.project.defs)]) n += p.blocks.filter((b) => b.type === 'comp' && b.def === defName).length;
    return n;
  }
  function firstInstancePath(defName, patch, trail) {
    patch = patch || app.project.root; trail = trail || [];
    for (const b of patch.blocks) {
      if (b.type !== 'comp' || !app.project.defs[b.def] || trail.some((f) => f.def === b.def)) continue;
      const here = trail.concat([{ def: b.def, inst: b.id }]);
      if (b.def === defName) return here;
      const deeper = firstInstancePath(defName, app.project.defs[b.def], here);
      if (deeper) return deeper;
    }
    return null;
  }

  // ---- change propagation ----------------------------------------------------
  let saveTimer = null;
  app.changed = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem(STORE, JSON.stringify(app.project)), 400);
    recompile();
    app.editor.requestRender();
    renderInspector();
    renderPalette();
  };
  app.selectionChanged = function () { renderInspector(true); app.editor.requestRender(); };

  function scopeWins(prog) {
    return prog.scopePaths.map((p) => { const b = blockAtPath(p); return (b && b.window) || 1024; });
  }
  function recompile() {
    const c = CW.compile(app.project);
    app.compiled = c;
    if (c.ok) { app.running = c; app.host.load(c, scopeWins(c)); }
    updateBanner();
  }

  // ---- edits -----------------------------------------------------------------
  app.addBlock = function (type, x, y, defName) {
    const patch = app.patch();
    if (type === 'comp' && !canPlace(defName)) { toast(`"${defName}" can't be placed inside itself.`); return; }
    if (x === undefined) {
      const c = app.editor.center();
      x = c.x; y = c.y;
      while (patch.blocks.some((b) => b.x === x && b.y === y)) { x += 20; y += 20; }
    }
    const b = { id: newId(patch), type, x, y };
    if (type === 'const') b.value = 1;
    if (type === 'scope') b.window = 1024;
    if (type === 'comp') b.def = defName;
    if (type === 'inlet' || type === 'outlet') {
      const n = patch.blocks.filter((q) => q.type === type).length + 1;
      b.name = (type === 'inlet' ? 'in' : 'out') + n;
    }
    patch.blocks.push(b);
    app.sel = new Set([b.id]); app.selWire = null;
    app.changed();
    renderInspector(true);
  };

  app.connect = function (fromId, fromPort, toId, toPort) {
    const patch = app.patch();
    const existing = patch.wires.find((w) => w.from[0] === fromId && w.from[1] === fromPort);
    if (existing) {
      if (existing.to[0] === toId && existing.to[1] === toPort) return;
      toast('Each output can drive only one input. Insert a Copy block to send a signal to two places.');
      return;
    }
    patch.wires = patch.wires.filter((w) => !(w.to[0] === toId && w.to[1] === toPort));
    patch.wires.push({ from: [fromId, fromPort], to: [toId, toPort] });
    app.changed();
  };

  function deleteSelection() {
    const patch = app.patch();
    if (app.selWire !== null) { patch.wires.splice(app.selWire, 1); app.selWire = null; }
    if (app.sel.size) {
      patch.blocks = patch.blocks.filter((b) => !app.sel.has(b.id));
      patch.wires = patch.wires.filter((w) => !app.sel.has(w.from[0]) && !app.sel.has(w.to[0]));
      app.sel.clear();
    }
    app.changed();
    renderInspector(true);
  }

  function duplicateSelection() {
    const patch = app.patch();
    if (!app.sel.size) return;
    const map = new Map();
    for (const b of patch.blocks.filter((q) => app.sel.has(q.id))) {
      if (b.type === 'comp' && !canPlace(b.def)) continue;
      const c = clone(b); c.id = newId(patch); c.x += 30; c.y += 30;
      map.set(b.id, c.id); patch.blocks.push(c);
    }
    for (const w of patch.wires.slice()) {
      if (map.has(w.from[0]) && map.has(w.to[0])) patch.wires.push({ from: [map.get(w.from[0]), w.from[1]], to: [map.get(w.to[0]), w.to[1]] });
    }
    app.sel = new Set(map.values());
    app.changed();
    renderInspector(true);
  }

  // Turn the selected blocks into a new composite definition. Wires that cross
  // the selection boundary become inlets and outlets.
  function groupSelection() {
    const patch = app.patch();
    const chosen = patch.blocks.filter((b) => app.sel.has(b.id));
    if (!chosen.length) { toast('Select some blocks first (shift-click or shift-drag).'); return; }
    if (chosen.some((b) => b.type === 'inlet' || b.type === 'outlet')) { toast('Inlets and outlets cannot be grouped.'); return; }
    const name = prompt('Name for the new block', 'MyBlock');
    if (!name) return;
    if (app.project.defs[name]) { toast(`A block called "${name}" already exists.`); return; }
    const inSel = (id) => app.sel.has(id);
    const x0 = Math.min(...chosen.map((b) => b.x)), y0 = Math.min(...chosen.map((b) => b.y));
    const x1 = Math.max(...chosen.map((b) => b.x));
    const def = { name, description: '', blocks: chosen.map((b) => Object.assign(clone(b), { x: b.x - x0 + 140, y: b.y - y0 + 20 })), wires: [], nextId: patch.nextId };
    const incoming = patch.wires.filter((w) => !inSel(w.from[0]) && inSel(w.to[0]));
    const outgoing = patch.wires.filter((w) => inSel(w.from[0]) && !inSel(w.to[0]));
    for (const w of patch.wires) if (inSel(w.from[0]) && inSel(w.to[0])) def.wires.push(clone(w));
    const inst = { id: newId(patch), type: 'comp', def: name, x: Math.round((x0 + x1) / 20) * 10, y: y0 };
    const keep = patch.wires.filter((w) => !inSel(w.from[0]) && !inSel(w.to[0]));
    incoming.forEach((w, k) => {
      const id = 'b' + def.nextId++;
      def.blocks.push({ id, type: 'inlet', name: 'in' + (k + 1), x: 0, y: 20 + k * 60 });
      def.wires.push({ from: [id, 0], to: clone(w.to) });
      keep.push({ from: clone(w.from), to: [inst.id, k] });
    });
    const right = (x1 - x0) + 300;
    outgoing.forEach((w, k) => {
      const id = 'b' + def.nextId++;
      def.blocks.push({ id, type: 'outlet', name: 'out' + (k + 1), x: right, y: 20 + k * 60 });
      def.wires.push({ from: clone(w.from), to: [id, 0] });
      keep.push({ from: [inst.id, k], to: clone(w.to) });
    });
    app.project.defs[name] = def;
    patch.blocks = patch.blocks.filter((b) => !inSel(b.id)).concat([inst]);
    patch.wires = keep;
    app.sel = new Set([inst.id]);
    app.changed();
    renderInspector(true);
    toast(`Created "${name}". Double-click it to look inside.`);
  }

  function newDefinition() {
    const name = prompt('Name for the new block', 'MyBlock');
    if (!name) return;
    if (app.project.defs[name]) { toast(`A block called "${name}" already exists.`); return; }
    app.project.defs[name] = {
      name, description: '', nextId: 3, wires: [],
      blocks: [{ id: 'b1', type: 'inlet', name: 'in', x: 20, y: 40 }, { id: 'b2', type: 'outlet', name: 'out', x: 400, y: 40 }],
    };
    openDefinition(name);
    app.changed();
  }

  function openDefinition(name) {
    const trail = firstInstancePath(name);
    app.nav = [{ def: null, inst: null }].concat(trail || [{ def: name, inst: null }]);
    app.sel.clear(); app.selWire = null;
    navChanged();
  }

  function renameDefinition(oldName, newName) {
    newName = newName.trim();
    if (!newName || newName === oldName) return;
    if (app.project.defs[newName]) { toast(`A block called "${newName}" already exists.`); return; }
    const d = app.project.defs[oldName];
    delete app.project.defs[oldName];
    d.name = newName;
    app.project.defs[newName] = d;
    for (const p of [app.project.root, ...Object.values(app.project.defs)]) for (const b of p.blocks) if (b.type === 'comp' && b.def === oldName) b.def = newName;
    for (const f of app.nav) if (f.def === oldName) f.def = newName;
    app.changed();
    renderCrumbs();
  }

  function deleteDefinition(name) {
    const n = instancesOf(name);
    if (n) { toast(`"${name}" is used ${n} time(s); delete those instances first.`); return; }
    if (!confirm(`Delete the block definition "${name}"?`)) return;
    delete app.project.defs[name];
    if (app.nav.some((f) => f.def === name)) { app.nav = [app.nav[0]]; navChanged(); }
    app.changed();
  }

  // ---- navigation ------------------------------------------------------------
  app.enter = function (instId) {
    const b = app.patch().blocks.find((x) => x.id === instId);
    if (!b || !app.project.defs[b.def]) return;
    app.nav.push({ def: b.def, inst: b.id });
    app.sel.clear(); app.selWire = null;
    navChanged();
  };
  function goTo(depth) {
    app.nav = app.nav.slice(0, depth + 1);
    app.sel.clear(); app.selWire = null;
    navChanged();
  }
  function navChanged() {
    renderCrumbs(); renderPalette(); renderInspector(true);
    app.editor.render();
  }
  function renderCrumbs() {
    const parts = app.nav.map((f, i) => {
      const label = i === 0 ? 'Root patch' : f.def + (f.inst ? ` <span class="dim">(${f.inst})</span>` : ' <span class="dim">(definition)</span>');
      return i === app.nav.length - 1 ? `<span class="crumb cur">${label}</span>` : `<a class="crumb" data-depth="${i}">${label}</a>`;
    });
    $('#crumbs').innerHTML = parts.join(' <span class="sep">▸</span> ') +
      (app.nav.length > 1 ? ' <span class="dim hint">— editing a definition changes every instance of it</span>' : '');
  }

  // ---- palette ---------------------------------------------------------------
  function renderPalette() {
    const inDef = !!app.frame().def;
    const btn = (kind, type, sym, title, tip, disabled) =>
      `<div class="pitem${disabled ? ' disabled' : ''}" draggable="${!disabled}" data-add="${kind}:${esc(type)}" title="${esc(tip)}">
        <span class="psym">${esc(sym)}</span><span class="pname">${esc(title)}</span></div>`;
    let s = '<h3>Atoms</h3>';
    for (const t of CW.ATOM_ORDER) { const i = CW.ATOMS[t]; s += btn('atom', t, i.symbol, i.title, `${i.eq}\n\n${i.doc}`); }
    s += '<h3>Ports &amp; outputs</h3>';
    for (const t of CW.STRUCT_ORDER) {
      const i = CW.STRUCT[t], off = (t === 'inlet' || t === 'outlet') && !inDef;
      s += btn('atom', t, i.symbol, i.title, off ? 'Only meaningful inside a composite block definition.' : i.doc, off);
    }
    s += '<h3>Library</h3><div class="lib">';
    for (const name of Object.keys(app.project.defs).sort()) {
      const d = app.project.defs[name], ok = canPlace(name);
      s += `<div class="libitem${ok ? '' : ' disabled'}">${btn('def', name, '▣', name, d.description || '', !ok)}
        <button class="mini" data-edit="${esc(name)}" title="Open the definition">✎</button>
        <button class="mini" data-del="${esc(name)}" title="Delete definition">×</button></div>`;
    }
    s += `</div><div class="pbuttons">
      <button id="btn-newdef" title="Create an empty composite block and open it">+ New block</button>
      <button id="btn-group" title="Turn the selected blocks into a composite block (Ctrl+G)">Group selection</button>
      <button id="btn-exportlib" title="Download the library as JSON">Export library</button></div>`;
    $('#palette').innerHTML = s;
  }

  $('#palette').addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-edit]')) return openDefinition(t.closest('[data-edit]').dataset.edit);
    if (t.closest('[data-del]')) return deleteDefinition(t.closest('[data-del]').dataset.del);
    if (t.id === 'btn-newdef') return newDefinition();
    if (t.id === 'btn-group') return groupSelection();
    if (t.id === 'btn-exportlib') return download('clockwork-library.json', { version: 1, defs: app.project.defs });
    const item = t.closest('[data-add]');
    if (item && !item.classList.contains('disabled')) {
      const [kind, name] = item.dataset.add.split(':');
      app.addBlock(kind === 'def' ? 'comp' : name, undefined, undefined, kind === 'def' ? name : null);
    }
  });
  $('#palette').addEventListener('dragstart', (e) => {
    const item = e.target.closest && e.target.closest('[data-add]');
    if (item) e.dataTransfer.setData('text/plain', item.dataset.add);
  });

  // ---- inspector -------------------------------------------------------------
  function renderInspector(force) {
    const el = $('#inspector');
    if (!force && el.contains(document.activeElement) && document.activeElement !== document.body) return;
    const patch = app.patch();
    const blocks = patch.blocks.filter((b) => app.sel.has(b.id));
    if (blocks.length === 1) el.innerHTML = blockInspector(blocks[0]);
    else if (blocks.length > 1) {
      el.innerHTML = `<h2>${blocks.length} blocks selected</h2>
        <p><button data-act="group">Group into composite block</button></p>
        <p><button data-act="dup">Duplicate</button> <button data-act="delete" class="danger">Delete</button></p>`;
    } else if (app.selWire !== null && patch.wires[app.selWire]) {
      const w = patch.wires[app.selWire];
      el.innerHTML = `<h2>Wire</h2><p class="mono">${w.from[0]}:${w.from[1]} → ${w.to[0]}:${w.to[1]}</p>
        <p>Carries one number per tick from an output to an input.</p>
        <p><button data-act="delete" class="danger">Delete wire</button></p>`;
    } else el.innerHTML = patchInspector();
  }
  setInterval(() => {
    const el = $('#inspector');
    if (!el.contains(document.activeElement)) {
      // keep the compile report fresh without fighting the user's typing
      const live = el.querySelector('[data-live]');
      if (live && app.compiled) live.innerHTML = reportHtml();
    }
  }, 500);
  $('#inspector').addEventListener('focusout', () => setTimeout(() => {
    if (!$('#inspector').contains(document.activeElement)) renderInspector();
  }, 0));

  function field(label, prop, value, type, extra) {
    return `<label class="field"><span>${label}</span><input data-prop="${prop}" type="${type || 'text'}" value="${esc(value === undefined ? '' : value)}" ${extra || ''}></label>`;
  }

  function blockInspector(b) {
    const info = CW.info(b.type);
    const path = app.viewPath();
    const code = app.compiled && path !== null ? app.compiled.nodeCode[path + b.id] : null;
    let s;
    if (b.type === 'comp') {
      const def = app.project.defs[b.def];
      s = `<h2>${esc(b.def)} <span class="dim">${b.id}</span></h2>`;
      s += `<p>${esc(def ? def.description || 'Composite block.' : 'Missing definition!')}</p>`;
      s += `<p><button data-act="enter">Open inside ⤵</button></p>`;
      if (def) {
        const ctls = CW.panelControls(def);
        if (ctls.length) {
          s += '<h3>Panel (this instance)</h3>';
          for (const c of ctls) s += field(esc(c.panel.label || c.id), 'param:' + c.id, CW.controlValue(b, c), 'number', 'step="any"');
          s += '<p><button data-act="resetparams">Reset panel to defaults</button></p>';
        }
        const pr = CW.ports(b, app.project.defs);
        s += `<h3>Ports</h3><p class="mono">in: ${pr.ins.map(esc).join(', ') || '—'}<br>out: ${pr.outs.map(esc).join(', ') || '—'}</p>`;
      }
    } else {
      s = `<h2>${info.title} <span class="dim">${b.id}</span></h2>`;
      s += `<div class="eq">${esc(info.eq)}</div><p>${esc(info.doc)}</p>`;
      if (b.type === 'const') {
        s += field('Value', 'value', b.value, 'number', 'step="any"');
        s += field('Label', 'label', b.label || '');
        s += `<label class="field check"><input type="checkbox" data-prop="haspanel" ${b.panel ? 'checked' : ''}><span>Show as a control${app.frame().def ? ' on the panel of this block' : ''}</span></label>`;
        if (b.panel) {
          const p = b.panel;
          s += `<label class="field"><span>Control</span><select data-prop="panel.kind">
            ${['knob', 'toggle', 'button'].map((k) => `<option ${p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>`;
          s += field('Panel label', 'panel.label', p.label);
          s += field('Min', 'panel.min', p.min, 'number', 'step="any"');
          s += field('Max', 'panel.max', p.max, 'number', 'step="any"');
          if (p.kind === 'knob') {
            s += `<label class="field"><span>Scale</span><select data-prop="panel.scale">
              ${['lin', 'log'].map((k) => `<option ${p.scale === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>`;
          }
          s += field('Panel order', 'panel.order', p.order || 0, 'number');
          s += `<p class="dim small">A ${p.kind} is still just a Constant: ${p.kind === 'toggle' ? 'clicking flips it between min and max' : p.kind === 'button' ? 'it outputs max while held, min otherwise' : 'turning it changes the number'}.</p>`;
        }
      } else if (b.type === 'inlet' || b.type === 'outlet') {
        s += field('Port name', 'name', b.name || '');
      } else if (b.type === 'scope') {
        s += `<label class="field"><span>Ticks per screen</span><select data-prop="window">
          ${[64, 256, 1024, 2048, 4800, 16384, 48000].map((n) => `<option ${b.window === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
        s += '<p class="dim small">In audio mode the trace is triggered on a rising edge. In slow mode the last 64 ticks are shown, one dot per tick.</p>';
      } else {
        s += field('Note', 'label', b.label || '');
      }
    }
    if (code) s += `<h3>Compiled as</h3><pre class="code small">${esc(code)}</pre>`;
    else if (path === null) s += '<p class="dim small">Open this definition through an instance to see its compiled code and live values.</p>';
    s += `<p><button data-act="dup">Duplicate</button> <button data-act="delete" class="danger">Delete</button></p>`;
    return s;
  }

  function patchInspector() {
    const f = app.frame();
    let s = '';
    if (f.def) {
      const d = app.project.defs[f.def];
      s += `<h2>Definition: ${esc(f.def)}</h2>`;
      s += field('Name', 'def.name', d.name);
      s += `<label class="field col"><span>Description</span><textarea data-prop="def.description" rows="4">${esc(d.description || '')}</textarea></label>`;
      s += `<p class="dim small">Used ${instancesOf(f.def)} time(s). Inlets/outlets become ports, ordered top to bottom. Constants marked "show as control" appear on every instance's panel.</p>`;
    } else {
      s += '<h2>Root patch</h2><p class="dim small">Select a block to inspect it. Double-click a composite to open it.</p>';
    }
    return s + `<div data-live>${reportHtml()}</div>`;
  }

  function reportHtml() {
    const c = app.compiled;
    if (!c) return '';
    let s = '';
    if (c.errors.length) {
      s += '<h3 class="err">Errors</h3><ul class="err">' + c.errors.map((e) => `<li>${esc(e.msg)}</li>`).join('') + '</ul>';
      s += '<p class="dim small">The last error-free program keeps running.</p>';
    }
    const r = c.resources;
    s += `<h3>Hardware (whole design)</h3><table class="res">
      <tr><td>Adders</td><td>${r.adder}</td></tr><tr><td>Multipliers</td><td>${r.multiplier}</td></tr>
      <tr><td>Comparators</td><td>${r.comparator}</td></tr><tr><td>Muxes (switches)</td><td>${r.mux}</td></tr>
      <tr><td>Registers (delays)</td><td>${r.register}</td></tr><tr><td>Constants</td><td>${r.constant}</td></tr>
      <tr><td>Copies (free wiring)</td><td>${r.copy}</td></tr>
      <tr class="sum"><td>Operations / tick</td><td>${c.opsPerTick}</td></tr>
      <tr class="sum"><td>Operations / second</td><td>${(c.opsPerTick * CW.FS / 1e6).toFixed(2)} M</td></tr></table>`;
    s += `<h3>Critical path: ${c.critDepth} operations</h3>
      <p class="dim small">The longest chain of arithmetic between registers. In an FPGA, all of it must settle within one clock period (${(1e6 / CW.FS).toFixed(1)} µs here). Inserting a Unit delay in the chain ("pipelining") shortens it, at the cost of one tick of latency.</p>`;
    if (c.critical.length) s += `<ol class="crit small">${c.critical.map((x) => `<li>${esc(x.name)} <span class="dim">${esc(x.path)}</span></li>`).join('')}</ol>`;
    if (c.warnings.length) {
      s += `<details><summary>${c.warnings.length} warning(s)</summary><ul>${c.warnings.map((w) => `<li>${esc(w.path)}: ${esc(w.msg)}</li>`).join('')}</ul></details>`;
    }
    return s;
  }

  $('#inspector').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    const patch = app.patch();
    const b = patch.blocks.find((x) => app.sel.has(x.id));
    if (act === 'delete') deleteSelection();
    else if (act === 'dup') duplicateSelection();
    else if (act === 'group') groupSelection();
    else if (act === 'enter' && b) app.enter(b.id);
    else if (act === 'resetparams' && b) { b.params = {}; app.changed(); renderInspector(true); }
  });

  $('#inspector').addEventListener('change', (e) => {
    const prop = e.target.dataset && e.target.dataset.prop;
    if (!prop) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const num = Number(v);
    if (prop === 'def.name') return renameDefinition(app.frame().def, v);
    if (prop === 'def.description') { app.project.defs[app.frame().def].description = v; app.changed(); return; }
    const b = app.patch().blocks.find((x) => app.sel.has(x.id));
    if (!b) return;
    if (prop.startsWith('param:')) { if (Number.isFinite(num)) { b.params = b.params || {}; b.params[prop.slice(6)] = num; } }
    else if (prop === 'value') { if (Number.isFinite(num)) b.value = num; }
    else if (prop === 'window') b.window = num;
    else if (prop === 'haspanel') {
      if (v) {
        const order = app.patch().blocks.filter((q) => q.panel).length + 1;
        // start the knob at mid-travel: range 0 … 2·value (or 0 … 1 for zero)
        const v0 = Number(b.value) || 0;
        const lo = v0 < 0 ? 2 * v0 : 0, hi = v0 > 0 ? 2 * v0 : (v0 < 0 ? 0 : 1);
        b.panel = { label: b.label || 'value', kind: 'knob', min: lo, max: hi, order, scale: 'lin' };
      } else delete b.panel;
      app.changed(); renderInspector(true); return;
    } else if (prop.startsWith('panel.')) {
      const k = prop.slice(6);
      b.panel[k] = ['min', 'max', 'order'].includes(k) ? (Number.isFinite(num) ? num : b.panel[k]) : v;
      if (k === 'kind') { app.changed(); renderInspector(true); return; }
    } else b[prop] = v;
    app.changed();
  });

  // ---- clock / transport -----------------------------------------------------
  const rateFromSlider = (x) => Math.round(0.5 * Math.pow(4000, x) * 100) / 100; // 0.5 Hz … 2 kHz
  const sliderFromRate = (r) => Math.log(r / 0.5) / Math.log(4000);

  function updateTransport() {
    const h = app.host;
    $('#btn-audio').textContent = h.audioOn ? '■ Stop audio' : '▶ Start audio';
    $('#btn-audio').classList.toggle('on', h.audioOn);
    document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === h.mode; });
    $('#slow-controls').classList.toggle('off', h.mode !== 'slow');
    $('#slow-rate-label').textContent = h.slowRate + ' Hz';
    $('#btn-pause').textContent = h.slowRunning ? 'Pause' : 'Run';
    updateBanner();
  }
  function updateBanner() {
    const msgs = [];
    const h = app.host;
    if (app.compiled && !app.compiled.ok) msgs.push(['err', '⚠ ' + app.compiled.errors[0].msg + (app.compiled.errors.length > 1 ? ` (+${app.compiled.errors.length - 1} more)` : '')]);
    if (app.snap && app.snap.bad) msgs.push(['err', 'The output became NaN or ∞ — press Reset to clear the registers.']);
    if (h && h.mode === 'audio' && !h.audioOn) msgs.push(['info', 'The clock is stopped. Press ▶ Start audio, or switch to the slow clock to watch it tick.']);
    $('#banner').innerHTML = msgs.map(([k, m]) => `<div class="${k}">${esc(m)}</div>`).join('');
  }

  $('#btn-audio').addEventListener('click', async () => {
    try { app.host.audioOn ? await app.host.stopAudio() : await app.host.startAudio(); }
    catch (err) { toast('Could not start audio: ' + err.message); }
    updateTransport();
  });
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', async () => {
    await app.host.setMode(r.value); updateTransport();
  }));
  $('#slow-rate').addEventListener('input', (e) => { app.host.slowRate = rateFromSlider(Number(e.target.value)); updateTransport(); });
  $('#btn-pause').addEventListener('click', () => { app.host.slowRunning = !app.host.slowRunning; updateTransport(); });
  $('#btn-step').addEventListener('click', async () => {
    if (app.host.mode !== 'slow') await app.host.setMode('slow');
    app.host.slowRunning = false; app.host.step(); updateTransport();
  });
  $('#btn-reset').addEventListener('click', () => { app.host.reset(); app.snap && (app.snap.bad = false); updateBanner(); });

  // ---- files, examples, dialogs ----------------------------------------------
  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('#btn-export').addEventListener('click', () => download('clockwork-project.json', app.project));
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.root) {
        if (!confirm('Replace the current project with this file?')) return;
        loadProject(data);
      } else if (data.defs) {
        const clash = Object.keys(data.defs).filter((n) => app.project.defs[n]);
        if (clash.length && !confirm(`Overwrite existing blocks: ${clash.join(', ')}?`)) return;
        Object.assign(app.project.defs, data.defs);
        app.changed();
        toast(`Imported ${Object.keys(data.defs).length} block definition(s).`);
      } else throw new Error('not a Clockwork file');
    } catch (err) { toast('Import failed: ' + err.message); }
  });

  $('#examples').innerHTML = '<option value="">Examples…</option>' + CW.EXAMPLES.map((ex, i) => `<option value="${i}">${esc(ex.title)}</option>`).join('');
  $('#examples').addEventListener('change', async (e) => {
    const ex = CW.EXAMPLES[Number(e.target.value)];
    e.target.value = '';
    if (!ex || !confirm(`Load "${ex.title}"? This replaces the root patch (your library is kept).`)) return;
    await loadExample(ex);
  });
  async function loadExample(ex) {
    loadProject(CW.exampleProject(ex, app.project ? app.project.defs : null));
    app.host.reset();
    await app.host.setMode(ex.mode);
    updateTransport();
    toast(ex.note, 7000);
  }

  function loadProject(p) {
    p.defs = p.defs || {};
    p.root.nextId = p.root.nextId || 1;
    app.project = p;
    app.nav = [{ def: null, inst: null }];
    app.sel.clear(); app.selWire = null;
    app.editor.views = {};
    app.changed();
    navChanged();
  }

  $('#btn-code').addEventListener('click', () => {
    $('#code-dlg pre').textContent = app.compiled ? app.compiled.code : '';
    $('#code-dlg').showModal();
  });
  $('#btn-help').addEventListener('click', () => $('#help-dlg').showModal());
  document.querySelectorAll('dialog .close').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 4000);
  }

  $('#crumbs').addEventListener('click', (e) => {
    const a = e.target.closest('[data-depth]');
    if (a) goTo(Number(a.dataset.depth));
  });

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    else if (e.key === 'Escape') { if (app.nav.length > 1) goTo(app.nav.length - 2); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); groupSelection(); }
    else if (e.key === ' ' && app.host.mode === 'slow') { e.preventDefault(); app.host.slowRunning = false; app.host.step(); updateTransport(); }
    else if (e.key === 'f') { app.editor.fit(); app.editor.render(); }
  });

  // ---- start -----------------------------------------------------------------
  app.host = new CW.Host((snap) => {
    const wasBad = app.snap && app.snap.bad;
    app.snap = snap;
    if (!app.liveQueued) {
      app.liveQueued = true;
      requestAnimationFrame(() => {
        app.liveQueued = false;
        app.editor.updateLive();
        $('#ticks').textContent = 'tick ' + app.snap.ticks.toLocaleString('en-US');
      });
    }
    if (!!snap.bad !== !!wasBad) updateBanner();
  }, (msg) => { if (msg) toast(msg); updateTransport(); });
  app.editor = new CW.Editor(app, $('#canvas'));
  $('#slow-rate').value = sliderFromRate(app.host.slowRate);
  $('#fs').textContent = (CW.FS / 1000) + ' kHz';

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) { saved = null; }
  if (saved && saved.root) { loadProject(saved); updateTransport(); }
  else loadExample(CW.EXAMPLES[2]);
  window.addEventListener('resize', () => app.editor.render());
})();
