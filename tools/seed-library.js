#!/usr/bin/env node
// Write the app's generated library (js/grid/library.js) into library/ as block
// files, one per definition, as a starting point for curation. Existing files are
// left alone unless --force is given; the manifest gains entries it doesn't have.
//   node tools/seed-library.js [--force]
'use strict';
const fs = require('fs'), path = require('path');
const F = require('../js/grid/format.js');
const L = require('../js/grid/library.js');
const dir = path.join(__dirname, '..', 'library'), force = process.argv.includes('--force');
fs.mkdirSync(dir, { recursive: true });
const manPath = path.join(dir, 'index.json');
const man = fs.existsSync(manPath) ? JSON.parse(fs.readFileSync(manPath, 'utf8')) : { blocks: [] };
const defs = L.starterDefs();
// blocks deleted in Files are in the trash: never bring them back
const trashed = new Set((fs.existsSync(path.join(dir, '.trash')) ? fs.readdirSync(path.join(dir, '.trash')) : []).filter((f) => f.includes('--') && f.endsWith('.json')).map((f) => f.split('--')[1]));
for (const name of Object.keys(defs)) {
  const file = F.slug(name) + '.json', fp = path.join(dir, file);
  if (trashed.has(file) && !force) continue;
  if (!fs.existsSync(fp) || force) { fs.writeFileSync(fp, F.stringify(F.encodeBlock(defs, name, {}, defs))); console.log('wrote', file); }
  if (!man.blocks.some((e) => e.file === file)) man.blocks.push({ file, title: name });
}
fs.writeFileSync(manPath, F.manifestText(man, 'blocks'));
