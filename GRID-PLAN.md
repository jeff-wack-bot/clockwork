# Clockwork Grid — prototype plan

A second front-end (`grid.html`) exploring a spatial, Factorio / PCB / FPGA-
flavoured way of building the same kind of machines. The original patch editor
(`index.html`) is kept unchanged for comparison.

## The idea in one paragraph

The world is a grid. **Blocks** are chips that occupy cells and have **pads**.
A **region** is a connected set of cells, drawn by painting, and it *is* a
register: it holds one number, shown as a colour. A region that touches a
block's output pad is written by that block on every clock tick. A region that
nobody writes is a constant; it can carry a **handle** (knob) for changing it.
Regions may overlap blocks (only at pads) but never each other, so crossing
wires need the **second layer**, reached through a **via**. Composite blocks
are just smaller grids drawn inside their footprint: to see or edit what's
inside, zoom in.

## Decisions

1. **Every region is a register (Factorio semantics).** On each tick every
   block reads the current values of its input regions, and all output regions
   latch simultaneously. Consequences:
   * there are no combinational loops and no ordering problems;
   * the critical path is always one operation (maximally pipelined);
   * **every block costs one tick of latency**, so a feedback loop through k
     blocks takes k ticks to go round. A loop of latency k behaves like k
     interleaved copies of the circuit, each updated every k ticks. The
     inspector reports each loop's latency, and the library is designed with
     it in mind (e.g. the Phasor loop has latency 3, so it adds 3·Hz/fs per
     turn).
   * Pipeline balancing matters: if two paths into a block have different
     latencies, add Delay blocks (the Phasor shows this).
2. **Atoms on the grid:** Add, Multiply, Greater-than, Switch, Delay (identity:
   one more pipeline stage), plus the DAC and Scope sinks.
   * **Constant is gone:** an unwritten region *is* a constant.
   * **Copy is gone:** a region can touch any number of input pads (fan-out is
     painting a branch). Fan-*in* is the rule that remains: a region may have
     at most one writer.
3. **Footprints:** two-input atoms and Switch are 3×3 chips, with inputs on
   the left column and the output in the middle of the right column. Delay is
   3×1, DAC 3×3, Scope 10×5. Atoms can be rotated (R). Composites cannot, in
   this prototype.
4. **Two layers + vias (PCB-style), not tunnels.** The top layer holds blocks
   and connects to pads. The bottom layer is a routing layer that passes under
   everything. A via is simply a cell where the same region occupies both
   layers. Tab switches the active layer, and doing it mid-stroke drops a via.
5. **Painting into another region joins them** (that's how you connect to an
   existing net). Passing *next to* a region doesn't connect: connectivity is
   region identity, and region outlines show the boundaries. Erasing a cell that
   splits a region produces two regions.
6. **Handles instead of panels.** A knob can be placed on any cell of an
   unwritten region. A written region's knob is shown as dead. Handle values are
   **per instance** (each factory has its own knobs). They are stored by
   absolute path, while the definition's region value is the default.
7. **Nested constants.** If a composite's input port is left unconnected
   outside, the inner region is unwritten, so its own knob works as a default.
   When an outer knob or a writer is connected, the inner knob shows as
   overridden or dead. Of several knobs on one unwritten net, the outermost wins.
8. **Composites:** a definition has a footprint (fw×fh cells) and an inner
   grid that is `s` times finer (default s=8). Input port k sits on the left
   column at footprint row k, and output ports sit on the right column. Inside,
   each port's pad is at the same physical spot, so a wire visually continues
   across the boundary as you zoom in. Ports add no latency: the inner and outer
   regions are the same net.
9. **Smooth zoom is navigation.** Below ~3 px per inner cell a composite is a
   closed chip with a lid. The lid fades out as you zoom in, and above ~10 px per
   inner cell you are editing *inside* it. Edits change the shared definition
   (the status bar says how many instances are affected).
10. **One rate slider.** The model's clock runs anywhere from 0.5 Hz to 48 kHz
    (= real time, the maximum). "Start audio" just switches the DAC on. The audio
    device always runs at 48 kHz and holds the DAC register between ticks, so
    slow rates give clicks (or silence) and the sound becomes continuous as you
    approach real time. Pause/Step/Reset remain.
11. **Colormap:** values in [0, 1] map linearly onto the first half of a warm
    ramp, and larger magnitudes continue logarithmically up to 10⁴. Negative
    values use the mirrored cool ramp. Zero is near-black. A legend is shown.
12. **Not in this prototype:** group-selection-into-composite, composite
    rotation, undo, autorouting in the UI (the library is laid out with a small
    maze router, but users route by hand), fixed-point.

## Revision: board (trace design) interface

Feedback: the PCB reading works better than the Factorio one (nets ↔ registers,
blocks ↔ ICs); drop the visible grid and the lids; zooming was slow.

* **Traces instead of painted cells.** Nets are drawn as traces through the
  centres of an invisible snap grid (the netlist model and compiler are
  unchanged). Traces are Manhattan; there are no diagonals in this prototype.
* **Route tool (W)**, PCB-style. Click a pin, a trace or empty board to start.
  The trace follows the cursor as an L, and `/` flips the corner. Click to fix
  a corner. Finishing on a pin or another trace connects to it and ends the
  route. Esc or Enter ends it. A trace may not cross another net or run over a
  pin on the same layer; the blocked part of the preview turns red. **Tab**
  drops a via and continues on the other layer.
* **Tracks.** With Select, clicking a trace picks the *track*: the chain of
  cells between junctions, pins and vias. Delete removes the track (the net
  splits if it has to); Shift+Delete removes the whole net.
* **No lids.** Every composite IC always shows its own board. Below 4 px per
  inner unit it's drawn as a one-colour sketch (per-net colours can't be seen at
  that size). Above that the traces carry their value colours.
* **Widths are capped in pixels.** A trace is about 1/3 of a board unit wide,
  but never more than about 10 px on screen. Zoomed deep into an IC, the outer
  board's traces stay thin lines instead of swamping the view.
* **Performance.** Trace geometry is cached as one `Path2D` per net per layer,
  in board units, and shared by every instance of a definition. A frame costs
  roughly one stroke per visible net. Measured in headless Firefox on a Pi 5:
  5–12 ms per frame from overview to three levels deep (was 8–17 ms).

## Revision: flip-flops are the registers; style lab

Making every net a register made every IC a pipeline stage. That spread
feedback loops over several ticks and forced pipeline balancing everywhere. We
went back to the simpler design:

* **Logic ICs settle within the tick** (Add, Multiply, Greater-than, Switch), in
  dependency order, like gates on a real board.
* **The Delay is a flip-flop.** The net it drives is a register: it changes only
  at the clock edge, and it is the only state there is. Every feedback loop
  needs one; a loop without one is an error, and its ICs are outlined in red.
* The critical path (the longest chain of logic between flip-flops) is reported
  again.
* The library loops now hold one flip-flop each: the Phasor (exact frequency,
  no 3-tick staircase), Decay and OnePole. The synth went from 36 registers to 5.

**Style lab** (the Style menu, `styles.html`, or URL parameters
`ops`/`branch`/`dir`/`reg`):

| Dimension | Options |
|---|---|
| Operations | IC packages · signal-flow symbols (⊕ ⊗, comparator, mux, flip-flop) · special vias |
| Branch points | nothing · solder dot · copy via (spoke per branch, incoming spoke white) |
| Direction | nothing · chevrons · flowing dashes · taper (thick at the driver) |
| Registers | plain · copper pour (a region around the register net) · double outline |

**Chosen default (2026-10-08):** special vias, no branch marks, taper, plain
registers. The other options stay available in the Style menu and gallery.

Direction comes from a breadth-first walk of each net from the pin that drives
it, which orients every trace segment.

## Revision 4: Sample Factory (2026-10-11)

The app is renamed **Sample Factory**, and it gains a **Sample** source block: a
stack of a whole song's samples, emitted one per tick.

Decisions:

* **Same clock.** The block holds a read-position counter that advances at the
  clock edge along with the flip-flops. During a tick its output pin carries
  `song[position]`, so it behaves like a flip-flop's output (a value available at
  the start of the tick) and never forms part of a combinational loop. It has no inputs.
* **Mono at 48 kHz.** Files are decoded and resampled by the browser
  (`OfflineAudioContext.decodeAudioData` at 48 kHz) and channels are averaged.
  One tick is then one sample at real time, which keeps the
  "the slider is the clock" model intact.
* **Storage.** A song is far too big for localStorage (a 3-minute song is about
  35 MB as float32), so it lives in IndexedDB under a content hash. The project
  stores only the hash and a display name. A missing song is reported in the
  banner and the block, and the block emits 0 until it is loaded again.
* **Codegen.** The counter is stored with the registers (`regNames` entry
  `path#pos`), so it survives recompiles and the audio-thread handoff, and Reset
  rewinds it. The song is passed to the program as an extra argument `w[]`.
  The generated code does not depend on the song, so loading a new file never
  recompiles.
* **Audio thread.** Each song is posted to the worklet once, keyed by its id.
* **End of song.** It loops by default; "stop" holds the counter at the end and
  emits 0.
* **Built-in song.** Example 4's song is synthesized at load (eight bars of
  plucked chords and a kick), so the demo needs no file.
* The repository and Pages URL keep the name `clockwork`. The previous version
  is tagged `clockwork-board-v1`.

## Revision 5: tuning library (2026-10-12)

Oscillators and sequencers built for the tones of Benson, *Music: A Mathematical
Offering*, chapter 5 (Pythagorean, just, meantone, irregular and equal tunings).

Decisions:

* **No new atoms.** Everything is built from the original seven atoms.
  Division is the one operation that would have helped (a live "size of the
  fifth" knob needs 1/g). Instead, tunings are tables, and the constants for
  derived variants are computed when the library is built.
* **Tunings are ROM chips.** The ROM is one octave fold plus a priority chain of
  11 comparators and switches, so its critical path is 13 operations. It is
  laid out once and copied with different constants, giving six chips with
  identical footprints. A new inspector control swaps a chip for any other
  definition with the same footprint and pins, optionally every copy on the
  board at once. Knob settings made inside the old chip are dropped.
* **Tuning data as in the book.** `js/grid/tunings.js` stores each tuning in
  Eitz notation (line of fifths plus syntonic/Pythagorean commas) and derives
  the ratios. Tests check them against Benson's cent values.
* **Which historical tunings:** just = Marpurg's Monochord No. 1 (it keeps
  D⁰, so the ii triad is visibly wrong, as in §5.11). Meantone = Aaron 1523
  (E♭…C♯ plus A♭, wolf fifth C♯–A♭). Vallotti in Young's version. Pythagorean spans E♭…G♯.
* **Semitone input 0–23** (two octaves above the tonic). Negative numbers aren't
  supported; lower the tonic instead.
* **Pins on alternate rows** for multi-output blocks (scores, pump, Bank4). With
  outputs on adjacent rows the maze router can box one in, depending on routing order.
* **Registers that must start at "1"** (the pump's root ratio) store value − 1,
  because Reset clears every register to 0.
* **The comma pump** uses the root moves ×5/6, ×4/3, ×4/3, ×2/3 (I→vi→ii→V→I),
  whose product is 80/81. The meantone pump uses the same motion in ¼-comma,
  whose product is exactly 1.
* **Library cache.** Laying out 20 definitions takes about 1.8 s on the Pi. The
  result is cached in localStorage under a hash of the builder code.

Documentation for this round is in the notebook (`AI_work/sample-factory/`).

## Revision 6: editor architecture and GUI polish (2026-10-12)

* **No GUI framework.** The hard parts (the canvas board, routing, and editing
  semantics such as undo, selection and clipboard) are not what frameworks
  provide, and a framework would add a build step to a no-build project. The
  DOM side (toolbar, palette, inspector) is small enough for plain JS.
* **An editing core without a DOM** (`js/grid/editor.js`): selection model,
  box-select, track picking, copy/paste, delete, move, rubber-band move, undo
  history. Node tests drive it directly (`tests/editor.test.js`).
* **Undo = project snapshots, one per gesture.** Mutations happen in many
  places, so instead of a command per operation, `app.commit(label)` runs at the
  end of every gesture and records a JSON snapshot if the project changed
  (capped at 200). Knob drags and moves are one step each; loading an example or
  importing is undoable.
* **Selection** is a set of blocks plus a set of trace cells (either layer) on
  one board. Clicking a trace selects its track and shows its net.
* **Moves are all-or-nothing** and never land a pin on a foreign net. Blocks
  dragged without their traces cut their own traces under them and re-route
  each left-behind pin to its net (the maze router), computed from the board
  as it was at drag start, so dragging back restores it exactly. Pins that
  can't be reached are reported.
* **Paste** keeps the clip's nets separate from the board's: pasted traces may
  not touch existing traces, and pasted knobs, constants and per-instance values
  come along. The clipboard is stored in localStorage.
* **Pointer model:** drag on empty board = box-select (was: pan); right-,
  middle- or Space-drag = pan (right-drag used to erase; erasing is the Erase
  tool's job).
* **Toolbar** wraps onto two rows on narrow windows instead of scrolling; edit
  buttons are words, not glyphs that may be missing from the system font.
* **Interactivity tests** run in the real page (`?uitest=1`) with synthetic
  pointer and key events. `tests/run-ui.py` serves the repo, opens headless
  Firefox and collects the report over HTTP, with no dependencies besides
  Python and Firefox. CI runs them.


## Revision 7: the analog rack (2026-10-16)

Brief: an analog synth simulator in the spirit of VCV Rack, compatible with
Sample Factory, so mixed designs run and the global clock slider drives analog
and digital parts alike.

* **One program, one clock.** The rack is part of the project
  (`project.rack`) and compiles into the same generated function as the board.
  The engine didn't change. A tick is always 1/48 000 s of *simulated* time;
  the slider only sets ticks per real second. That is what makes the slider work
  for both: at a slow clock an envelope, an LFO or a VCO's waveform slows down
  exactly as the flip-flops do.
* **Analog modules are sampled circuits.** During tick n an analog module's
  outputs hold what it measured over the previous tick; at the clock edge it
  integrates its equations across the next 1/48 000 s with its inputs held
  (zero-order hold in, sample out). So every analog module is a clock boundary,
  like a flip-flop: feedback through analog modules is always legal, which is
  how patching works, and each adds one tick of latency (VCV Rack has one
  sample per cable). Inputs are all read before any module updates, so update
  order doesn't matter. The rejected alternative was zero-latency memoryless
  analog modules (mixers, VCAs). They would have made loops through a mixer
  "combinational" and therefore errors, which is unlike real patching.
* **Exact utilities** (V/OCT → Hz, Hz → V/OCT, Gain) are logic, not circuits:
  they settle within the tick, with no latency, and a loop of only them needs a
  flip-flop, as on the board.
* **Units: volts are numbers.** 1 V/oct with 0 V = C4, audio ±5 V, gates 0–10 V.
  Gate inputs are Schmitt triggers at 0.7/0.3 V, so the board's 0/1 logic gates
  envelopes directly. Rails are linear to ±10 V and bend into ±12 V, so ordinary
  voltages pass exactly. The first version used a soft tanh rail everywhere, which
  bent 1 V by 2.4 cents; the tests caught it.
* **Anti-aliasing by integration.** VCO outputs are the waveform's average over
  the tick, computed exactly from antiderivatives. That is an integrating ADC,
  and it is what makes sampling a "continuous" oscillator honest: alias energy
  is far below a naive sawtooth (tested).
* **Imperfection is a knob.** VCOs have DRIFT (an Ornstein–Uhlenbeck pitch
  wander, std in cents, τ = 2 s) and TRACK (1 V/oct scale error), both 0 by
  default. Noise comes from per-module seeded xorshift generators kept in the
  module's state, so Reset replays everything exactly.
* **The ladder filter** has four substeps per tick, a tanh-like input stage with
  the feedback, and a 10⁻⁶ "thermal noise" term so it starts self-oscillating
  without input, as the circuit does.
* **Rack ↔ board.** Three ways: any board definition can sit in the rack as a
  *chip* module (ports become jacks; knobs on its own board become panel knobs,
  stored per module by path); analog modules can be placed on the board as
  blocks; and the Board Bus module joins eight channels each way to the
  board's To rack / From rack blocks. All three are plain copper in the
  compiler: rack jacks are nodes in the same union-find as the board's regions,
  and a cable is a union.
* **Only patched jacks exist.** An unpatched input reads its default (normalled)
  value, such as a VCA's CV at 10 V or Audio R = L. An unpatched output is not computed at
  all, which saved about half the time of example 10. An unpatched input of a
  chip keeps the chip's own default inside.
* **Knobs are parameters.** Module knobs get slots in `p[]`, so turning one never
  recompiles. The sequencer reads its step knob by index (`p[base + step]`).
* **Rack UI:** a canvas view in the VCV style (panels, hex jacks, value arcs on
  knobs, an LED on every output, sagging translucent cables), auto-laid-out
  panels (a test checks every panel fits 3U without overlaps), and VCV gestures:
  drag jack to jack, pick up a plug from an input, double-click to reset a knob.
  The rack model (`js/grid/rack.js`) has no DOM and its own node tests; the UI
  (`rackview.js`, `rackui.js`) shares the toolbar, palette, inspector, status
  bar, clipboard keys and undo history with the board.
* **Examples 9–12** show a pure analog voice, a board chip driving analog VCOs
  (just chords that beat once DRIFT is up), the board's sample player filtered in
  the rack and sent back, and feedback loops that only analog modules can close.

## Revision 8: design files and curated examples (2026-10-16)

Brief: hand-design wire layouts for the example list and save them in a format
that keeps working as the app develops, functionally and graphically.

* **A separate, versioned file format** (`js/grid/format.js`, spec in
  FORMAT.md) instead of dumping the internal project. Nets are stored with
  their cells, cables name jacks by port id, and the format version has a
  migration chain. The internal representation can change; the format changes
  only through migrations.
* **Frozen chips.** A design file contains every definition it uses, and its
  copies win over the built-in library on load. That makes a curated example
  immune to library changes. The cost is that library improvements don't reach
  it until it is re-saved, which is the right default for hand-made layouts.
* **A compatibility lock** (`tests/compat.lock.json`): block footprints and
  pins, rack widths, jack and knob ids. Hand-routed traces depend on these, so a
  change to them fails CI unless it comes with a migration.
* **Canonical text** with small objects on one line and cells inline, so files
  diff well, and unchanged re-saves are byte-identical (tested on every curated
  example, and end to end through the browser).
* **Nothing graphical in the files**; camera views are stored as world
  rectangles and fitted to the window.
* **Curation workflow:** `tools/serve.py` (localhost only) serves the repo and
  accepts `PUT /api/examples/<name>.json`. It checks names and bodies and
  writes atomically. The app's **Save as example…** dialog writes the file and
  its entry in `examples/index.json` (the menu). Without that server the dialog
  downloads the file.
* **Seeded** with the twelve generated examples (`tools/seed-examples.js`). They
  are now ordinary curated files; the generated ones stay in the menu after
  them, under their own heading.

## Revision 9: one workflow for examples and library blocks (2026-10-16)

Brief: unify examples and library blocks, so that a block's wire layout (the
Phasor's, say) is curated the same way as an example's.

* **The library is files now**, like the examples: `library/<block>.json`, one
  definition each, listed in `library/index.json`, seeded from the generated
  library (`tools/seed-library.js`). The app loads it at startup. The builder
  code in `library.js` only generates the original examples and is the fallback
  when the page is opened from disk.
* **Format version 2** has two kinds of file, `example` and `block`. Both refer
  to library blocks by name, with each one's pin signature (`uses`). Revision 8
  froze a copy of every block into every example; that would have kept a curated
  Phasor out of every existing design, so it was dropped for references.
  Version-1 files migrate with their copies kept as private `defs`.
* **What is shared and what is guarded.** A block's insides propagate to every
  design that uses it. A block's pins can't silently change under a layout:
  the signature check warns, and CI fails on warnings in curated files.
* **Private copies only where a design differs**: a block the design changed
  without saving it to the library, or one that isn't in the library. Export
  makes a self-contained file (all copies), for sharing outside the repository.
* **Knowing what was edited.** A design records, per block, a hash of the library
  version it came from (`project.base`). A block is then:
  - *edited*, if it differs from that hash;
  - *its own version*, if it differs from the library without having come from it;
  - *new*, if it isn't in the library.

  Edited blocks are marked in the palette, offered by Save, and left alone when
  the library moves on. Unedited blocks with unchanged pins are refreshed from
  the library on load, so autosaved designs follow the curated library.
* **One Open menu, one Save dialog.** Open lists examples and library blocks; a
  block opens on a workbench (one instance on an empty board, zoomed into its
  insides). Save offers the whole design, or any block that differs from the
  library. Saving a block first saves the changed blocks inside it, innermost
  first, so library files never carry private copies.
* **A bug the tests caught:** designs shared the library's definition objects,
  so an edit in a design silently changed the in-memory library. Designs now
  get deep copies.
* **The curator server** writes `examples/` and `library/`, and checks that each
  file goes to the right folder.

## Revision 10: connections like a rack, traces as drawing (2026-10-16)

Brief: the two-layer model (paint copper, drop vias with Tab, choose a layer)
was hard to work with. Make the connection model like the rack's, keep PCB
traces as the way it is drawn, and keep the hand-drawn Phasor layout exactly.

* **Wires, pin to pin.** A connection is a wire from a source (a block's output,
  or a definition's input port seen from inside) to a sink (a block's input, or
  an output port). An input takes one wire; an output feeds any number. A net is
  a source and its wires; nets join across block boundaries at the ports, as
  before. Connectivity never comes from geometry, so two traces that happen to
  touch or cross can't join nets by accident.
* **Traces are drawing.** A wire may carry a path (its cells), which is what makes
  a layout curatable. Without a valid path the router draws one (deterministic,
  sharing copper with its own net, avoiding chips and other nets). The renderer
  (`G.renderLayout`) assigns layers: a trace takes the top layer unless another
  net is already there or a chip is in the way, and then dips to the bottom with
  vias. The existing renderer (taper, colours, glyphs, style lab) draws that
  derived layout unchanged.
* **Constants are blocks** (one cell, one output, an optional knob), as in the
  original patch editor and like an offset module in a rack. **Input ports have
  defaults** (value and optional knob), like normalled jacks. Both are weak
  drivers: a block's output or a wire from outside overrides them, the outermost
  wins, a knob wins among equals. These are the same rules the painted model had
  for unwritten nets, so every design computes what it did.
* **Editing:** drag pin → pin wires (pick a wire up by its input end to move or
  remove it); drag a block and its wires follow, keeping the traces near the end
  that stayed; drag a trace sideways to move that straight run (it stops at pins
  and branch points, and runs shared by a net's wires move together); Draw wire
  (W) clicks a trace out corner by corner. The Erase and Knob tools, the layer
  button and Tab-for-via are gone.
* **Format version 3** with a migration from version 2: each painted net becomes
  wires routed along the net's own cells (through its vias), a driverless net
  becomes a Constant at its knob or the free end of its stub (keeping the net's
  id, so per-instance knob settings stay valid), and a net driven by an input
  port becomes that port's default. Browser-saved projects convert the same way.
  The 20 library blocks and 12 examples were migrated with it and nothing was
  dropped. The curated Phasor kept every block and every drawn cell, and its
  crossing is now an automatic pair of vias.
* **Proof that nothing changed:** before the refactor, `tools/behaviour.js`
  recorded what every curated example (one second of output) and every library
  block (constants in, scopes out) computes. After the migration all 32 match
  exactly; the test stays in CI. The hand-drawn Phasor's v2 file is kept in
  `tests/fixtures/` and checked cell by cell against `library/phasor.json`.

## Revision 11: three kinds of signal on one canvas (2026-10-26)

Brief: add a fixed-point (integer) domain whose atoms are logic gates and whose
wires show their binary words; put float, fixed and analog blocks on the same
canvas, with converters between them (ADC, DAC, Quantizer, Dequantizer,
Voltmeter, AWG); no rack view; no scope; outputs as sockets other programs can
patch (PipeWire, Helvum-style); wire looks under the user's control (trace width
and vias, cable colour and droop, barcodes in black and white).

* **Domains are on pins.** Every pin is `float`, `fixed` or `analog`; a wire joins
  pins of one domain (the editor refuses others with a hint, the compiler reports
  them in hand-edited files). No type distinctions beyond the domain: a
  frequency and an amplitude are both floats, a pitch CV and audio both volts.
* **Fixed point** is bit-level: AND, OR, XOR, NOT, NAND, NOR, XNOR work on every
  bit of a bus; the D flip-flop is the register (Q̄ is ¬Q within the tick, so it
  starts consistent); Split and Join take buses apart and put them together; Bits
  is the fixed constant. Words are unsigned integers of their bus's width (1–32
  bits), inferred from the drivers (gates take their widest input); binary point
  and sign live only in the converters. Arithmetic is built from gates (library
  block Counter4).
* **Converters** are small chips, half in each domain's colours: ADC/DAC (±range
  volts ↔ two's-complement codes), Quantizer/Dequantizer (× 2^frac, rounded and
  saturated), Voltmeter/AWG (volts ÷ range, gain volts per unit), and the pitch
  converters. All exact and combinational; their BITS are structural (a change
  recompiles), the rest are knobs.
* **Analog modules are panels on the board** (2 HP to a cell, 13 cells tall),
  with their knobs (drag to turn, double-click to reset) and jacks as pins. Their
  wires are patch cables: never routed, drawn as hanging curves on top. The rack
  view, its chips, the Board Bus and To/From rack are gone.
* **Sockets.** In and Out blocks on the top board are the program's audio inputs
  and outputs, named; the engine runs `run(N, p, s, o[], I[], v, w)`. In the
  browser Out 1/2 are the speakers and the Ins the microphone. The scope is gone.
* **PipeWire** (`tools/pwbridge.py`, run as the user): a PipeWire *filter* node
  made through ctypes, because only a filter can name its ports (pw-cat's are
  output_1, output_2…); one port per socket, by name. Audio crosses a localhost
  WebSocket (origin-checked) in 1024-frame blocks; the bridge sends the graph
  (from pw-dump) and makes links (pw-link). The app draws the other nodes beside
  the design with their links, and links by dragging. With sound off the board's
  own clock feeds the node.
* **Looks.** Float nets: colour and width per net, vias by double-click (stored
  as indexes into the wire's path; without any, layers stay automatic). Fixed
  buses: barcodes, low bit on the left of the flow, square corners, live. Cables:
  colour and droop per cable. Gates in their ANSI shapes.
* **Format version 4** with `MIGRATIONS[3]`: rack modules onto the board, cables
  to wires (colours kept), chips to composite blocks, speaker DAC → Out, links →
  AWG / Voltmeter, Audio Out → Voltmeter + Out, scopes dropped, converters where
  a wire joins two domains, overlaps settled. Checked against recordings of the
  old engine (tests/fixtures/rack-v3-out.json); only the analog noise seeds
  differ. Every float example and library block computes exactly what it did.

## Revision 12: files, the block editor, and no WAV player (2026-10-26)

* **Files** manager: new, open, duplicate, rename (a block's rename rewrites every
  file that refers to it), delete into a restorable trash, reorder; Ctrl+S saves
  the open file, the toolbar marks unsaved changes.
* **A block is edited only as the open file** (the block editor): its
  description, size, inside size, ports (a column of inputs and one of outputs,
  a row per row of the block, drag to rearrange) and input defaults. In a
  design, a copy has only its own size; zoomed into a block you can look and
  turn its knobs. Port changes keep wires on their ports, by identity while
  editing and by name in files saved before; saving rewrites the users.
* **No WAV player**: the Sample block is gone (format 5: a Sample becomes an In
  socket). Sound from outside comes through In sockets: the microphone, or
  anything linked in PipeWire.
