#!/usr/bin/env node
// Write the app's generated examples (js/grid/library.js) into examples/ as design
// files, as a starting point for curation. Blocks are referred to in the curated
// library (library/, see seed-library.js) where they match it. Existing files are left alone unless
// --force is given; the manifest gains entries for files it doesn't list yet.
//   node tools/seed-examples.js [--force]
'use strict';
const fs = require('fs'), path = require('path');
const F = require('../js/grid/format.js');
const L = require('../js/grid/library.js');
const { readLibrary } = require('./library-node.js');
const library = readLibrary().defs;
const dir = path.join(__dirname, '..', 'examples'), force = process.argv.includes('--force');
fs.mkdirSync(dir, { recursive: true });
const manPath = path.join(dir, 'index.json');
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { examples: [] };
const trashed = new Set((fs.existsSync(path.join(dir, '.trash')) ? fs.readdirSync(path.join(dir, '.trash')) : []).filter((f) => f.includes('--') && f.endsWith('.json')).map((f) => f.split('--')[1]));
L.EXAMPLES.forEach((ex, i) => {
  const title = ex.title.replace(/^\d+\s*·\s*/, '');
  const file = F.slug(title) + '.json', fp = path.join(dir, file);
  if (trashed.has(file) && !force) return;   // deleted in Files: leave it deleted
  const meta = { title, note: ex.note, rate: ex.rate, view: ex.view || 'board' };
  if (!fs.existsSync(fp) || force) { fs.writeFileSync(fp, F.stringify(F.encode(L.exampleProject(i), meta, library))); console.log('wrote', file); }
  if (!man.examples.some((e) => e.file === file)) man.examples.push({ file, title });
});
fs.writeFileSync(manPath, F.manifestText(man, 'examples'));
