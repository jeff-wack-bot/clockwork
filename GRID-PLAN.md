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

