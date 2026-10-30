// Read the curated library (library/*.json) and examples (examples/*.json) from
// disk, for node scripts and tests. The browser does the same with fetch (app.js).
'use strict';
const fs = require('fs'), path = require('path');
const F = require('../js/grid/format.js');
const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
function manifest(dir, key) {
  const p = path.join(ROOT, dir, 'index.json');
  return fs.existsSync(p) ? readJson(p) : { [key]: [] };
}
function readLibrary() {
  const man = manifest('library', 'blocks');
  const files = man.blocks.map((e) => ({ file: e.file, doc: readJson(path.join(ROOT, 'library', e.file)) }));
  return Object.assign(F.loadLibrary(files), { manifest: man });
}
module.exports = { ROOT, readJson, manifest, readLibrary };
