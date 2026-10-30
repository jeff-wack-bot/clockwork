#!/usr/bin/env node
// Re-save every curated file (library/ and examples/) in the current format
// version, through the migrations. Prints what each migration reported.
//   node tools/upgrade-files.js [--check]   (--check: report only, write nothing)
'use strict';
const fs = require('fs'), path = require('path');
const F = require('../js/grid/format.js');
const { ROOT, readJson, readLibrary } = require('./library-node.js');
const check = process.argv.includes('--check');
const L = readLibrary();
if (L.warnings.length) { console.log('library warnings:\n  ' + L.warnings.join('\n  ')); process.exitCode = 1; }
let n = 0;
const write = (file, text) => {
  const old = fs.readFileSync(file, 'utf8');
  if (old === text) return;
  n++;
  console.log((check ? 'would rewrite ' : 'rewrote ') + path.relative(ROOT, file));
  if (!check) fs.writeFileSync(file, text);
};
for (const e of L.manifest.blocks) {
  const file = path.join(ROOT, 'library', e.file);
  write(file, F.stringify(F.encodeBlock(L.defs, e.title, readJson(file).meta, L.defs)));
}
const man = readJson(path.join(ROOT, 'examples', 'index.json'));
for (const e of man.examples) {
  const file = path.join(ROOT, 'examples', e.file), d = F.decode(readJson(file), L.defs);
  if (d.warnings.length) console.log(`${e.file}: ${d.warnings.join('; ')}`);
  write(file, F.stringify(F.encode(d.project, d.meta, L.defs)));
}
console.log(`${n} file(s) ${check ? 'to rewrite' : 'rewritten'}`);
