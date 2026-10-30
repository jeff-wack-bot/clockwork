# Sample Factory design files

A **design file** is one JSON document of one of two kinds:
- an **example**: a whole design (the board and the knob settings), in
  `examples/`, or exported;
- a **block**: one definition for the library, in `library/`.

The library is where every design's blocks come from. Examples and blocks
refer to library blocks **by name**, so curating a block (re-routing the
Phasor, say) reaches everything that uses it. This file is the specification and
the compatibility promise. The code is `js/grid/format.js`.

## The promise

A design file saved today opens later and means the same thing: the same
blocks at the same cells, the same traces, the same cables and the same knob
settings, and the same look for the wires you styled. Its library blocks are the library's current versions, which is the
point of curating them; their pins are checked. Specifically:

1. **Files carry a format version.** A newer app reads every older version by
   upgrading it step by step (`MIGRATIONS` in `format.js`). A file from a newer
   app than the one reading it is refused with a message, never misread.
2. **Library blocks are referred to by name, with their pins.** For each
   library block a file uses, at any depth, it records the block's *pin
   signature* (footprint and ports, e.g. `5x3 in@0:Hz out@0:phase out@2:wrap`).
   On load, a missing block or one whose pins have changed is a warning, and CI
   fails on any warning in a curated file. So a block's insides can be curated
   freely, while a change to its pins can't silently break the layouts around
   it.
3. **Anything that differs from the library travels with the file.** A
   definition that isn't in the library, or that the design changed without
   saving it to the library, is stored in the file as a private copy. Private
   copies win over the library on load, so the design opens exactly as it was
   saved. **Export** makes a self-contained file: every block is a private copy,
   so it opens anywhere, whatever that app's library says.
4. **Footprints, pin domains and knob ids are locked.** Hand-routed traces
   depend on where each block type's pins are, wires on what kind of signal each
   pin carries, and knob settings on knob ids. All of this is recorded in
   `tests/compat.lock.json`. CI fails if a change alters any of it. Such a
   change ships only with a migration that rewrites old designs, or as a new
   block type next to the old one.
5. **Only the look you chose is stored.** Positions are logical, in board cells.
   A wire's `style` (its colour, a trace's width and hand-placed vias, a cable's
   droop) is stored because you set it. Everything else (panel artwork, default
   colours, sizes, fonts) comes from the app, so it can change freely without
   touching any file.
6. **Saving is canonical.** Fixed key order, sorted cells, one net per entry.
   Opening a file and saving it unchanged gives byte-identical text, so a git
   diff shows only what was really edited. CI checks this for every example and
   every library block.

What is *not* promised:
- **Sound inside analog modules.** Their circuit models may be refined (a more
  accurate ladder filter, say), which changes the sound but not the design.
  The board's atoms (Add, Multiply, Greater than, Switch, Delay), the gates
  and the converters have fixed definitions.
- **Sound from outside.** Designs don't hold recordings; In sockets hear whatever is
  linked to them.

## Documents

An example:

```json
{
  "format": "sample-factory-design",
  "version": 4,
  "kind": "example",
  "meta":  { "title": "…", "note": "…", "rate": 48000, "camera": { "board": [x0, y0, x1, y1] } },
  "uses":  { "<library block>": "<pin signature>", … },
  "board": <sheet>,
  "defs":  { "<name>": <definition>, … },
  "values": { "<path>": <number>, … }
}
```

A library block:

```json
{
  "format": "sample-factory-design",
  "version": 4,
  "kind": "block",
  "meta":  { "title": "<the block's name>" },
  "uses":  { "<library block it contains>": "<pin signature>", … },
  "block": <definition>,
  "defs":  {}
}
```

- **`uses`** lists the library blocks the file needs, at any depth, each with the
  pin signature it had when saved: `"<fw>x<fh> <dir>@<row>:<name> …"`, inputs
  first, then outputs, each by row. If the library block's signature has
  changed since, the file still opens, with a warning. Wires name a block's pins
  by position, so they are moved to the ports of the same name (a renamed port
  is found by its row); a wire to a port that is gone is dropped. A trace that no
  longer ends on its pin keeps its shape from the other end and is re-routed only
  for the last stretch. Saving a block whose pins changed from the app rewrites
  the files that use it this way, so they open cleanly.
- **`defs`** holds private copies, which win over library blocks of the same
  name. Library block files keep `defs` empty: when a block is saved to the
  library, the app first saves any changed blocks inside it.
- **Name resolution:** a design's blocks are the library's, overridden by the
  file's `defs`. A library block refers to the blocks inside it by name, so it
  uses a design's private copy where the design has one, just as it did when the
  design was saved.
- **A block opens on a workbench:** an otherwise empty board with one instance at
  cell (2, 2), zoomed into its insides. Editing it there and saving puts it back
  in the library.

### meta

| Key | Meaning |
|---|---|
| `title` | Shown in the Examples menu (the manifest repeats it). |
| `note` | Shown when the design opens. |
| `rate` | Clock rate in ticks per second when it opens (48000 = real time). |
| `camera` | Optional opening view, `{"board": [x0, y0, x1, y1]}`: the visible rectangle in root-board cells. Fitted to the window, so it works at any screen size. |
| `author`, `tags` | Optional. Other keys are kept as they are. |

### sheet (the board, and the inside of every definition)

```json
{ "nextId": 76,
  "blocks": [ {"id": "b1", "type": "mul", "x": 5, "y": 3},
              {"id": "r7", "type": "const", "x": 5, "y": 7, "value": 0.0000208}, … ],
  "wires":  [ {"id": "w64", "from": "r7.o0", "to": "b1.i1", "path": [[5,7],[5,6],[5,5]]},
              {"id": "w80", "from": "b9.o2", "to": "b12.i0", "style": {"color": "#e5603d", "droop": 1.4}}, … ] }
```

- **Coordinates** are cells: x to the right, y down, integers. A definition's
  inside spans `0 … iw − 1` by `0 … ih − 1` (see definitions).
- **Blocks**: `id`, `type`, `x`, `y` (top-left cell), optional `rot` (quarter turns
  clockwise; atoms and gates only), and per type:
  - `def` for `comp` (a composite block: the name of a definition), and
    optional `w`, `h`: this copy's size in this design, when it isn't the
    definition's `fw` × `fh` (its inside is drawn scaled to fit; a port on row r
    sits at ⌊r · h / fh⌋);
  - `value` and optional `knob` (`label`, `min`, `max`, `scale` `"lin"`/`"log"`) for
    the constants: `const` (a number), `volts` (a voltage); `value` and `width`
    (1–32 bits) for `bits` (a fixed-point word, as an unsigned integer);
  - `points` for `table`: `[[x, y], …]`, in order of x;
  - `parts` for `split` and `join`: the widths of the fields, low bits first
    (`[1, 1, 1, 1]` is four single bits);
  - `params` for analog modules and converters (knob id → value);
  - `name` for the sockets `in` and `out`;

  Block types and their footprints are listed in `tests/compat.lock.json`.
  Unknown keys are kept.
- **Wires** are the connections: `from` a source, `to` a sink, like a patch
  cable. An endpoint is `"<block id>.o<n>"` (the block's n-th output) or
  `"<block id>.i<n>"` (its n-th input), counting pins in footprint order. Inside a
  definition, `"port.i<n>"` is its n-th input port (a source there) and
  `"port.o<n>"` its n-th output port (a sink), counting ports by row. An input
  takes at most one wire; an output feeds any number. A wire to a pin that doesn't
  exist is dropped on load, with a warning.
- **`path`** (optional) is the trace of a float or fixed-point wire: the cells
  from the source's pin to the sink's, each a step up, down, left or right from
  the last. It is drawing only. When a path is missing, or no longer ends on its
  pins (a block moved in a hand edit), the app routes one. Analog wires are
  patch cables: they hang between their jacks and have no path.
- **`style`** (optional) is how the wire looks, as you set it: `color` (a CSS
  colour), and for a trace `width` (a factor, 1 = normal) and `vias` (indexes
  into `path` where the trace changes layer: it starts on top), for a cable
  `droop` (0 = taut, 1 = normal). A float net's colour and width are its wires'
  (the first one that has them). Without `vias`, layers are the renderer's: where
  traces cross or pass under a chip, one dips to the bottom layer.
- **Ids** (`b…` blocks, `w…` wires; Constants keep the ids they were given) are
  kept exactly, because `values` refers to them. `nextId` is where the app
  continues numbering; it is raised past any id in use on load.

### kinds of signal

Every pin carries one of three kinds of signal, and a wire joins two pins of the
same kind (a wire between kinds is a compile error, not a conversion):

| Domain | Values | Drawn as |
|---|---|---|
| `float` | numbers (the board's atoms, Constants) | circuit-board traces |
| `fixed` | words of 1–32 bits, as unsigned integers; a bus is as wide as what drives it | barcodes, one stripe per bit |
| `analog` | voltages (1 V = 1.0; analog modules) | patch cables |

Where the binary point is, and whether a word is signed, is not stored on a bus.
Four blocks cross between domains and do nothing else: `voltmeter` (analog →
float, volts as a number), `awg` (float → analog), `word` (float → fixed:
`bits`, `signed`, `mode` 0 wrap / 1 clip, `scale` 0 an integer / 1 a fraction of
full scale) and `value` (fixed → float: `signed`, `scale`). Every map between
domains (ADC, DAC, Quantizer, the pitch converters, a range) is a composite
block built from them and float arithmetic; the library has the usual ones,
with their settings as input pins whose defaults are knobs. Float maps also have
the atoms `exp2` (2^x), `log2` and `table` (a piecewise-linear lookup through
its `points`, `[[x, y], …]`). Each block type's pin domains are in
`tests/compat.lock.json`.

### definitions (`block`, and each entry of `defs`)

A sheet plus `name`, `description`, footprint `fw` × `fh` cells (its size on the
boards it sits on), scale `s`, optional inside size `iw` × `ih` (its own board, in
fine cells; when absent, `fw·s` × `fh·s`), and `ports`:
`{"dir": "in"|"out", "row": n, "name": "…", "domain": "fixed", "width": w, "value": v, "knob": {…}}`
(`domain` is `"float"` when absent; `width` is the bit width of a fixed input's
default, 8 when absent). Inputs sit
on the left column of the footprint, outputs on the right, at their row. Inside,
each port is a pad on the board's left or right edge (x = 0, or `iw − 1`) at
y = `⌊(row + ½) · ih / fh⌋`, which is `row · s + ⌊s/2⌋` when `ih = fh·s`. The
inside is drawn into the footprint at one scale, centred, so a footprint and an
inside of different shapes leave a margin. `iw`/`ih` are written only when they
differ from `fw·s`/`fh·s`, and readers that predate them never see them in the
curated files unless a block has been resized. An
input port's optional `value` (default 0) is what it reads when nothing outside
is wired to it, like a normalled jack, and its optional `knob` shows that value
on the block's own board.

**Constants are defaults.** A net driven by a block's output (or by a wire from
outside a block) ignores Constants and port defaults. Otherwise the outermost
one sets it, and among equally deep ones a knob wins. So a wire into a block's
input overrides the block's default inside.

### values

Per-instance knob settings, by path. A path is the chain of block ids from the
root board, each followed by `/`, then a Constant's id or an input port
(`port.i<n>`): `"b3/b2/r8"` is Constant `r8` inside block `b2` inside block
`b3`, and `"b3/port.i0"` is the default of `b3`'s first input. Modules and
converters inside composite blocks use `path#knob` (`"b3/b5#freq"`). At the
root, values live on the blocks themselves.

### modules, panels and sockets

- **Analog modules** sit on the board as their panels, 2 HP to a cell and 13
  cells tall; their jacks are their pins, in the order of the module's inputs
  and outputs (so `"b9.o2"` is a VCO's SAW). `params` holds every knob by id;
  unknown knobs are dropped on load with a warning, missing ones get their
  defaults.
- **Sockets**: `in` and `out` blocks on the top board are the design's audio
  inputs and outputs, named by `name`, counted from the top of the board down
  (then left to right). With the PipeWire bridge they are the ports of the
  design's node, under those names. A socket inside a definition is an error:
  a block's way in and out is its ports.

## Curated examples and the library

`examples/index.json` lists the examples in the Open menu, in order;
`library/index.json` lists the library's blocks (title = block name):

```json
{
  "examples": [
    {"file": "counter-and-pipeline.json", "title": "Counter and pipeline"},
    …
  ]
}
```

```json
{
  "blocks": [
    {"file": "phasor.json", "title": "Phasor"},
    …
  ]
}
```

File names are lower-case letters, digits and dashes. Edit the order by moving
lines. `tools/seed-library.js` and `tools/seed-examples.js` wrote the starting
set from the app's old generated library and examples (they leave existing files
alone unless given `--force`).

**Keeping designs current.** A design open in the browser (or autosaved there)
remembers which library version each of its blocks came from. When the app
starts, it replaces blocks the library has improved since, unless you edited
them or their pins changed. The palette marks blocks with unsaved edits (▣•).

### Curating

1. Serve the repository with `python3 tools/serve.py` (port 8000; only reachable
   from this machine) and open http://127.0.0.1:8000/.
2. **Files…** (toolbar, or Ctrl+O) lists the examples and the library blocks,
   with what each block contains, what it sits inside and how many examples use
   it. From there:
   - **+ New example** makes an empty design file and opens it; **+ New block**
     makes a block (one input, one output, 4×3) and opens it on its workbench.
   - **Open**, **Duplicate** (a copy under a new title or name), **Rename**, and
     **↑ ↓** to move it in the Open menu.
   - **Delete** moves the file to `<folder>/.trash/` (not committed); the
     **Trash** tab restores it, and so does **Undo** right after.
   - **Renaming a block** renames it in every file that refers to it (the
     library blocks that contain it, the examples that use it), since its name
     is how they refer to it. **Deleting a block** that examples use first gives
     each of them its own copy, so they still open; a block that other library
     blocks contain can't be deleted until they no longer do.
3. Edit the design. A block can also be edited in place by zooming into it
   inside any design: all its instances share the definition.
4. **Ctrl+S** saves the open example or block back to its file (the toolbar
   shows which file is open, with • while it has unsaved changes; clicking it
   saves too). **Save…** does more:
   - **The whole design, as an example:** title, note, clock rate, and whether
     the current zoom is its opening view. Writes
     `examples/<file>.json` and adds it to the menu, or replaces it.
   - **Block "…" into the library:** its description, and the file
     (`library/<file>.json`). The blocks inside it that you changed are saved
     first. Every design that uses the block uses the new version from then on.

   **Download** gives you the file instead, from any page.
5. Commit `examples/` and `library/`. CI checks every file:
   - it loads without warnings (including the pin checks) and compiles;
   - saving it again gives the same text.

Served any other way (GitHub Pages, a plain static server), the page can still
open examples and blocks and download design files, but it can't write to the
repository. Opened straight from disk (`file://`), it can't read the library
folder and uses the blocks built into the app.

## Changing the format

- **Version history.**
  - **Version 1** stored a frozen copy of every block in every example.
    `MIGRATIONS[1]` turns such a file into version 2, with those copies as
    private `defs`, so it opens exactly as before.
  - **Version 2** drew connections as painted copper: `nets` with cells on a
    `top` and a `bot` layer, joined by vias. `MIGRATIONS[2]` (`js/grid/migrate.js`)
    turns each net into wires from its source to each pin it reaches, routed
    through the net's own cells, so a hand-drawn layout keeps its shape. A net
    nobody drove becomes a Constant block, at its knob or the free end of its
    stub. A net driven by an input port gives the port its default (and knob). Old
    projects saved in a browser are converted the same way when they load.
    `tests/fixtures/` keeps a version-1 and a version-2 file, and a recording of
    what every curated design computed before the change. The tests check that
    the migrated files still compute exactly that.
  - **Version 3** was wires on a board, plus a separate rack of analog modules
    and cables. It gained the optional `iw`/`ih` (a definition's inside size, so
    a block can be resized without touching what is drawn inside it).
  - **Version 4** is one canvas for three kinds of signal (float, fixed point,
    analog). `MIGRATIONS[3]` (`js/grid/migrate.js`) moves the rack's modules onto
    the board below the rest (2 HP to a cell, a rack row every 14 cells), turns
    its cables into wires (keeping their colours) and its chips into composite
    blocks (their knob settings follow). The board's speaker block (the old
    `dac`) becomes an `out` socket; To rack and From rack become an `awg` and a
    `voltmeter`; the rack's Audio Out becomes a Voltmeter scaled as it scaled,
    into an Out (two, L and R, if both were patched); scopes are dropped. Where a
    wire now joins two kinds of signal (an analog jack straight to a float pin,
    which the rack allowed), a converter goes in between. Blocks that now
    overlap move down until they don't. Old projects saved in a browser are
    converted the same way. `tests/fixtures/` keeps three version-3 files with
    racks and a recording of what they played; the tests check that the
    migrated designs still play it (the analog noise seeds, named after rack
    positions, are the only difference).
  - **Version 5** has no Sample (WAV player) blocks: sound from outside comes in
    through In sockets. `MIGRATIONS[4]` turns a Sample on the top board into an
    In socket whose output pin is where the Sample's was (so its wires stay); one
    inside a block becomes a Constant 0.
  - **Version 6** has converters as library blocks. `MIGRATIONS[5]` turns each old
    converter block (`adc`, `dac`, `quant`, `dequant`, `v2hz`, `hz2v`, and a
    `voltmeter` or `awg` with a range or gain) into a copy of the library block
    of its kind, in the same place, its signal wire moved to the block's `in`
    pin; its settings become this copy's values at the top board (or a private
    variant's defaults inside a block). A width or signedness the library's block
    doesn't have (a 12-bit ADC) becomes a private variant in the file. Tested
    against the old formulas, tick by tick.
- **To add an optional field**, write it, read it with a default, and leave the
  version alone.
- **Anything else** (renaming, moving pins, changing a footprint or a pin's
  domain, removing a jack or knob) needs all of the following:
  1. raise `VERSION`;
  2. add `MIGRATIONS[old]`, which turns an old document into the new form;
  3. run the tests (the curated examples must still load cleanly);
  4. refresh the lock with `UPDATE_LOCK=1 node tests/format.test.js`.
