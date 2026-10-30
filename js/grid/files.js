// Files: managing the curated examples (examples/) and library blocks (library/).
//
// One dialog lists both, with what each uses or is used by, and does the
// housekeeping of curation: new, open, duplicate, rename, delete, reorder, and a
// trash to undo a delete from. Writing needs the curator server (tools/serve.py);
// a delete moves the file into the folder's .trash/, so nothing is lost.
//
// Renaming a block renames it everywhere: in the library blocks that contain it
// and the examples that use it. Deleting a block that examples use gives each of
// them its own copy first, so they still open; a block that other library blocks
// contain can't be deleted until they no longer do.
(function (root) {
  'use strict';
  const G = root.GW;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = (s) => document.querySelector(s);

  class Files {
    constructor(app, h) {
      this.app = app; this.h = h;
      this.tab = 'examples'; this.filter = ''; this.edit = null; this.docs = {}; this.busy = false;
      this.dlg = $('#files-dlg');
      this.dlg.addEventListener('click', (e) => this.click(e));
      this.dlg.addEventListener('keydown', (e) => this.key(e));
      $('#fl-filter').addEventListener('input', (e) => { this.filter = e.target.value; this.render(); });
    }
    get F() { return G.Format; }
    lib() { return this.h.libraryDefs(); }
    list(folder) { const a = this.app; return folder === 'examples' ? ((a.manifest && a.manifest.examples) || []) : ((a.libManifest && a.libManifest.blocks) || []); }

    async open(tab) {
      if (tab) this.tab = tab;
      this.edit = null; this.status('');
      if (!this.dlg.open) this.dlg.showModal();
      await this.refresh();
      $('#fl-filter').focus();
    }
    // Every file's document, for what uses what (small files; read each time the dialog opens or changes).
    async refresh() {
      const docs = {};
      const get = async (folder, file) => { try { const r = await fetch(`${folder}/${encodeURIComponent(file)}`, { cache: 'no-store' }); if (r.ok) docs[folder + '/' + file] = await r.json(); } catch (e) { /* missing */ } };
      await Promise.all(this.list('examples').map((e) => get('examples', e.file)).concat(this.list('library').map((e) => get('library', e.file))));
      this.docs = docs;
      this.render();
    }
    doc(folder, file) { return this.docs[folder + '/' + file]; }
    // A block's users: library blocks that contain it (at any depth), and examples.
    usersOf(name) {
      const lib = this.lib(), blocks = Object.keys(lib).filter((n) => n !== name && this.F.depsOf(lib, [n]).includes(name)).sort();
      const examples = this.list('examples').filter((e) => { const d = this.doc('examples', e.file); return d && this.F.docUses(d, name); });
      return { blocks, examples };
    }
    status(msg, act) {
      const el = $('#fl-status');
      el.innerHTML = msg ? esc(msg) + (act ? ` <button class="mini" data-act="${act.act}" data-arg="${esc(act.arg)}">${esc(act.label)}</button>` : '') : '';
    }

    // ---- drawing ---------------------------------------------------------------------
    render() {
      const a = this.app, ex = this.list('examples'), bl = this.list('library'), tr = a.trash || [];
      for (const b of this.dlg.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab);
      $('#fl-n-examples').textContent = ex.length; $('#fl-n-library').textContent = bl.length; $('#fl-n-trash').textContent = tr.length;
      const canWrite = a.curator;
      $('#fl-new').hidden = this.tab === 'trash';
      $('#fl-new').textContent = this.tab === 'library' ? '+ New block' : '+ New example';
      $('#fl-new').disabled = !canWrite;
      $('#fl-readonly').hidden = canWrite;
      const q = this.filter.trim().toLowerCase(), match = (...s) => !q || s.join(' ').toLowerCase().includes(q);
      const c = a.curated, isOpen = (folder, file) => c && c.file === file && (c.folder || (c.kind === 'block' ? 'library' : 'examples')) === folder;
      const dirty = c && a.project && c.saved !== this.h.stateHash();
      let h = '';
      const editRow = (label, value, cols) => `<tr class="editing"><td colspan="${cols}"><label class="field"><span>${esc(label)}</span><input id="fl-edit" value="${esc(value)}" autocomplete="off"></label>
        <span class="dim small">Enter to ${esc(this.edit.verb)}, Esc to cancel</span> <button class="mini" data-act="commit">${esc(this.edit.verb)}</button> <button class="mini" data-act="cancel">Cancel</button></td></tr>`;
      if (this.edit && this.edit.op === 'new' && this.edit.folder === this.tab) h += editRow(this.tab === 'library' ? 'Name of the new block' : 'Title of the new example', this.edit.value, 4);
      if (this.tab === 'trash') {
        h += tr.length ? '' : '<tr><td class="dim">The trash is empty.</td></tr>';
        for (const t of tr) {
          if (!match(t.title, t.file)) continue;
          const when = t.when.replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3 $4:$5');
          h += `<tr><td><b>${esc(t.title || t.file)}</b><div class="dim small">${esc(t.folder)}/${esc(t.file)}</div></td><td class="small dim">deleted ${esc(when)}</td>
            <td></td><td class="acts"><button class="mini" data-act="restore" data-arg="${esc(t.folder)}|${esc(t.trashed)}" ${canWrite ? '' : 'disabled'}>Restore</button></td></tr>`;
        }
      } else {
        const folder = this.tab, items = this.list(folder);
        items.forEach((e, i) => {
          const d = this.doc(folder, e.file);
          let about = '';
          if (folder === 'library') {
            const u = this.usersOf(e.title), inner = d ? Object.keys(d.uses || {}) : [];
            about = [inner.length ? 'contains ' + inner.join(', ') : '', u.blocks.length ? 'inside ' + u.blocks.join(', ') : '',
              u.examples.length ? `used by ${u.examples.length} example${u.examples.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'not used';
          } else about = d ? (Object.keys(d.uses || {}).join(', ') || 'no library blocks') + (d.defs && Object.keys(d.defs).length ? ` · own copies of ${Object.keys(d.defs).join(', ')}` : '') : '';
          if (!match(e.title, e.file, about)) return;
          if (this.edit && this.edit.file === e.file && this.edit.folder === folder) {
            h += editRow(this.edit.op === 'rename' ? (folder === 'library' ? 'New name' : 'New title') : (folder === 'library' ? 'Name of the copy' : 'Title of the copy'), this.edit.value, 4);
            return;
          }
          const open = isOpen(folder, e.file);
          h += `<tr class="${open ? 'current' : ''}" data-file="${esc(e.file)}">
            <td class="move"><button class="mini" data-act="up" data-arg="${esc(e.file)}" ${i && canWrite && !q ? '' : 'disabled'} title="Earlier in the menu">↑</button><button class="mini" data-act="down" data-arg="${esc(e.file)}" ${i < items.length - 1 && canWrite && !q ? '' : 'disabled'} title="Later in the menu">↓</button></td>
            <td><b>${esc(e.title)}</b>${open ? ` <span class="badge">${dirty ? 'open, changed' : 'open'}</span>` : ''}<div class="dim small">${esc(folder)}/${esc(e.file)} · ${esc(about)}</div></td>
            <td></td>
            <td class="acts"><button class="mini" data-act="open" data-arg="${esc(e.file)}">Open</button>
              <button class="mini" data-act="dup" data-arg="${esc(e.file)}" ${canWrite ? '' : 'disabled'}>Duplicate</button>
              <button class="mini" data-act="rename" data-arg="${esc(e.file)}" ${canWrite ? '' : 'disabled'}>Rename</button>
              <button class="mini danger" data-act="delete" data-arg="${esc(e.file)}" ${canWrite ? '' : 'disabled'}>Delete</button></td></tr>`;
        });
      }
      $('#fl-list').innerHTML = h;
      const inp = $('#fl-edit');
      if (inp) { inp.focus(); inp.select(); }
    }

    // ---- events ------------------------------------------------------------------------
    click(e) {
      const t = e.target.closest('[data-tab],[data-act],#fl-new');
      if (!t || this.busy) return;
      if (t.dataset.tab) { this.tab = t.dataset.tab; this.edit = null; this.render(); return; }
      if (t.id === 'fl-new') { this.startEdit('new', this.tab, null, this.tab === 'library' ? 'NewBlock' : 'New example'); return; }
      const act = t.dataset.act, arg = t.dataset.arg, folder = this.tab;
      if (act === 'commit') return this.commitEdit();
      if (act === 'cancel') { this.edit = null; this.render(); return; }
      if (act === 'open') return this.openFile(folder, arg);
      if (act === 'up' || act === 'down') return this.run(() => this.move(folder, arg, act === 'up' ? -1 : 1));
      if (act === 'dup') { const e2 = this.entry(folder, arg); this.startEdit('dup', folder, arg, folder === 'library' ? e2.title + 'Copy' : e2.title + ' (copy)'); return; }
      if (act === 'rename') { this.startEdit('rename', folder, arg, this.entry(folder, arg).title); return; }
      if (act === 'delete') return this.run(() => this.remove(folder, arg));
      if (act === 'restore') { const [f, name] = arg.split('|'); return this.run(() => this.restore(f, name)); }
    }
    key(e) {
      if (e.target.id !== 'fl-edit') return;
      if (e.key === 'Enter') { e.preventDefault(); this.edit.value = e.target.value; this.commitEdit(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.edit = null; this.render(); }
    }
    entry(folder, file) { return this.list(folder).find((x) => x.file === file); }
    startEdit(op, folder, file, value) {
      this.edit = { op, folder, file, value, verb: { new: 'Create', dup: 'Duplicate', rename: 'Rename' }[op] };
      this.status(''); this.render();
    }
    commitEdit() {
      const inp = $('#fl-edit'), ed = this.edit;
      if (!ed) return;
      const value = (inp ? inp.value : ed.value).trim();
      if (!value) { this.status('A name is needed.'); return; }
      this.run(async () => {
        if (ed.op === 'new') await (ed.folder === 'library' ? this.newBlock(value) : this.newExample(value));
        else if (ed.op === 'dup') await this.duplicate(ed.folder, ed.file, value);
        else await (ed.folder === 'library' ? this.renameBlock(ed.file, value) : this.renameExample(ed.file, value));
        this.edit = null;
      });
    }
    // One operation at a time; then everything is read again.
    async run(fn) {
      if (this.busy) return;
      this.busy = true; this.dlg.classList.add('busy');
      try { await fn(); } catch (err) { this.status('Could not do that: ' + err.message); }
      try {
        await this.app.reloadCatalogue();
        this.h.renderOpenMenu();
        await this.refresh();
      } finally { this.busy = false; this.dlg.classList.remove('busy'); }
    }
    // A file name for a title that no other file in the folder has.
    freeFile(folder, title, except) {
      const base = this.F.slug(title), taken = new Set(this.list(folder).map((x) => x.file).filter((f) => f !== except));
      for (const t of this.app.trash || []) if (t.folder === folder) taken.add(t.file);
      let f = base + '.json';
      for (let n = 2; taken.has(f); n++) f = `${base}-${n}.json`;
      return f;
    }
    blockExists(name) { return !!(this.lib()[name] || this.list('library').some((x) => x.title === name)); }
    // Something unsaved in the open design? Then ask before replacing it (undo still brings it back).
    okToReplace(what) {
      const a = this.app, c = a.curated, st = a.blockStatus();
      const unsaved = (c && a.project && c.saved !== this.h.stateHash()) || Object.values(st).some((s) => s === 'edited' || s === 'new');
      return !unsaved || this.h.confirmReplace(what);
    }

    // ---- the operations --------------------------------------------------------------------
    async openFile(folder, file) {
      const e = this.entry(folder, file);
      if (!this.okToReplace(folder === 'library' ? `the block "${e.title}"` : `"${e.title}"`)) return;
      this.dlg.close();
      await this.h.loadDesignFile(file, false, folder);
    }
    async newExample(title) {
      const file = this.freeFile('examples', title), lib = this.lib();
      const project = { version: 5, root: G.makeSheet(), defs: this.h.clone(lib), values: {} };
      await this.h.put('examples', file, this.F.stringify(this.F.encode(project, { title, rate: G.FS }, lib)));
      await this.app.reloadCatalogue();
      if (this.okToReplace(`the new example "${title}"`)) { this.dlg.close(); await this.h.loadDesignFile(file, false, 'examples'); this.h.toast(`Made examples/${file}. Build it, then Ctrl+S saves it.`, 5000); }
    }
    async newBlock(name) {
      if (this.blockExists(name)) throw new Error(`there is already a block called "${name}"`);
      const lib = this.lib(), file = this.freeFile('library', name);
      const def = G.makeDef(name, 4, 3, 8, [{ dir: 'in', row: 1, name: 'in' }, { dir: 'out', row: 1, name: 'out' }], '');
      await this.h.put('library', file, this.F.stringify(this.F.encodeBlock(Object.assign({}, lib, { [name]: def }), name, {}, lib)));
      await this.app.reloadCatalogue();
      if (this.okToReplace(`the new block "${name}"`)) { this.dlg.close(); await this.h.loadDesignFile(file, false, 'library'); this.h.toast(`Made library/${file}: build its insides here, set its ports and size in the inspector, then Ctrl+S.`, 6000); }
    }
    async duplicate(folder, file, name) {
      const d = this.doc(folder, file);
      if (!d) throw new Error('could not read ' + file);
      if (folder === 'library') {
        if (this.blockExists(name)) throw new Error(`there is already a block called "${name}"`);
        const nf = this.freeFile('library', name);
        await this.h.put('library', nf, this.F.stringify(this.F.renameBlockInDoc(d, this.entry(folder, file).title, name)));
        this.status(`Made library/${nf}, a copy of ${this.entry(folder, file).title}.`);
      } else {
        const nf = this.freeFile('examples', name), copy = JSON.parse(JSON.stringify(d));
        copy.meta = Object.assign({}, copy.meta, { title: name });
        await this.h.put('examples', nf, this.F.stringify(copy));
        this.status(`Made examples/${nf}.`);
      }
    }
    async renameExample(file, title) {
      const d = this.doc('examples', file);
      if (!d) throw new Error('could not read ' + file);
      const nf = this.freeFile('examples', title, file), doc = JSON.parse(JSON.stringify(d));
      doc.meta = Object.assign({}, doc.meta, { title });
      await this.h.api('POST', 'examples/rename', { from: file, to: nf, text: this.F.stringify(doc) });
      const c = this.app.curated;
      if (c && c.kind === 'example' && c.file === file) this.h.setCurated(Object.assign({}, c, { file: nf, meta: Object.assign({}, c.meta, { title }) }));
      this.status(`Renamed to "${title}" (examples/${nf}).`);
    }
    // A block's name is how files refer to it, so renaming it rewrites them all.
    async renameBlock(file, name) {
      const old = this.entry('library', file).title;
      if (name === old) return;
      if (this.blockExists(name)) throw new Error(`there is already a block called "${name}"`);
      const u = this.usersOf(old);
      const files = u.blocks.map((n) => ['library', this.app.library.fileOf[n]]).filter(([, f]) => f).concat(u.examples.map((e) => ['examples', e.file]));
      if (files.length && !confirm(`Rename "${old}" to "${name}"? These files refer to it and will be updated:\n\n${files.map(([f, x]) => f + '/' + x).join('\n')}`)) return;
      for (const [f, x] of files) await this.h.put(f, x, this.F.stringify(this.F.renameBlockInDoc(this.doc(f, x), old, name)));
      const nf = this.freeFile('library', name, file);
      await this.h.api('POST', 'library/rename', { from: file, to: nf, text: this.F.stringify(this.F.renameBlockInDoc(this.doc('library', file), old, name)) });
      this.renameInProject(old, name);
      const c = this.app.curated;
      if (c && c.kind === 'block' && c.file === file) this.h.setCurated(Object.assign({}, c, { file: nf, name, saved: this.h.stateHash() }));
      this.status(`Renamed "${old}" to "${name}"${files.length ? ` in ${files.length + 1} files` : ''}.`);
    }
    // The open design follows a rename, so it keeps matching the library.
    renameInProject(old, name) {
      const p = this.app.project;
      if (!p || !p.defs[old]) return;
      p.defs[name] = p.defs[old]; p.defs[name].name = name; delete p.defs[old];
      if (p.base && p.base[old] !== undefined) { p.base[name] = p.base[old]; delete p.base[old]; }
      for (const sh of [p.root, ...Object.values(p.defs)]) for (const b of sh.blocks) if (b.type === 'comp' && b.def === old) b.def = name;
      this.app.version++; this.app.changed(); this.app.commit('rename block ' + old);
    }
    async remove(folder, file) {
      const e = this.entry(folder, file);
      if (folder === 'library') {
        const u = this.usersOf(e.title);
        if (u.blocks.length) throw new Error(`${u.blocks.join(', ')} contain${u.blocks.length === 1 ? 's' : ''} "${e.title}"; change or delete ${u.blocks.length === 1 ? 'it' : 'them'} first`);
        if (u.examples.length) {
          if (!confirm(`${u.examples.length} example${u.examples.length === 1 ? ' uses' : 's use'} "${e.title}": ${u.examples.map((x) => x.title).join(', ')}.\n\nThey will keep their own copy of it, so they still open. Delete "${e.title}" from the library?`)) return;
          for (const x of u.examples) await this.h.put('examples', x.file, this.F.stringify(this.F.keepPrivate(this.doc('examples', x.file), e.title, this.lib())));
        }
      }
      const j = await this.h.api('DELETE', `${folder}/${file}`);
      const c = this.app.curated;
      if (c && c.file === file && (c.folder || (c.kind === 'block' ? 'library' : 'examples')) === folder) this.h.setCurated(null);
      this.status(`Moved ${folder}/${file} to the trash.`, { act: 'restore', arg: `${folder}|${j.trashed}`, label: 'Undo' });
    }
    async restore(folder, trashed) {
      const j = await this.h.api('POST', `${folder}/restore`, { trashed });
      const name = trashed.split('--')[1];
      this.status(`Restored ${folder}/${name}${folder === 'examples' ? ', at the end of the menu' : ''}.`);
      return j;
    }
    // Blocks whose pins changed: rewrite every file that uses them, through the
    // loader (which moves their wires to the ports of the same name).
    async updateUsers(names) {
      if (!this.app.curator) return [];
      await this.refresh();
      const lib = this.lib(), done = [], files = new Map();
      for (const name of names) {
        const u = this.usersOf(name);
        for (const n of u.blocks) if (this.app.library.fileOf[n] && !names.includes(n)) files.set('library/' + this.app.library.fileOf[n], ['library', this.app.library.fileOf[n]]);
        for (const e of u.examples) files.set('examples/' + e.file, ['examples', e.file]);
      }
      for (const [key, [folder, file]] of files) {
        const doc = this.doc(folder, file);
        if (!doc) continue;
        const r = this.F.decode(doc, lib);
        const text = this.F.stringify(r.kind === 'block' ? this.F.encodeBlock(r.project.defs, r.name, r.meta, lib) : this.F.encode(r.project, r.meta, lib));
        await this.h.put(folder, file, text);
        done.push(key);
      }
      if (done.length) await this.app.reloadCatalogue();
      return done;
    }
    async move(folder, file, by) {
      const files = this.list(folder).map((x) => x.file), i = files.indexOf(file), k = i + by;
      if (i < 0 || k < 0 || k >= files.length) return;
      [files[i], files[k]] = [files[k], files[i]];
      await this.h.api('POST', `${folder}/order`, { files });
    }
  }

  root.GW = Object.assign(root.GW || {}, { Files });
})(typeof self !== 'undefined' ? self : this);
