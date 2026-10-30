# ▤ Sample Factory

A transparent, FPGA-flavoured dataflow synthesizer for the browser, laid out like
a circuit board. Oscillators, sequencers, envelopes and filters are built from a
handful of atomic ICs that run on **one global 48 kHz clock**, and nothing
happens under the hood: you can see the compiled program, the live value on
every trace, the "hardware" your design uses, and its critical path.

Sample Factory is the second version of Clockwork Board. The board carries three
kinds of signal side by side: float numbers on copper traces, fixed-point words
on barcode buses through logic gates, and voltages on patch cables between
simulated analog modules (VCOs, a ladder filter, envelopes, VCAs…). Converters
cross between them, it is all one program on one clock, and the design's In and
Out sockets are its audio: ports in PipeWire, so sound comes in from (and goes
out to) any other program.

**Live demo:** https://jeff-wack-bot.github.io/clockwork/ (style lab: https://jeff-wack-bot.github.io/clockwork/styles.html)

There are two front-ends:

* `index.html` is **Sample Factory**, the board. Blocks are joined by wires, pin to pin as in a
  rack; each kind of signal has its own look (traces, barcodes, cables). Constants are blocks
  with knobs, zooming in is how you enter an IC, and a single slider sets the clock from 0.5 Hz
  up to real time.
  See [GRID-PLAN.md](GRID-PLAN.md).
* `index_old.html` is the original **patch editor** (blocks and wires).

See [PLAN.md](PLAN.md) for the design, and for the decisions made where the
brief left room for interpretation.

## Running it

No build step and no dependencies. Either:

* open `index.html` directly in a recent Chrome/Edge/Firefox, or
* serve the folder: `python3 tools/serve.py` → http://127.0.0.1:8000/ (any static server works; this one can also save examples)

Then press **▶ Start audio**. The default patch is a sequenced synth. To watch
it tick instead, choose the **slow** clock and press **Step** (or Space).

Tests: `node tests/test.js` (patch editor), `node tests/grid.test.js` (board),
`node tests/editor.test.js` (editing core), `node tests/analog.test.js` (the analog
modules' circuits and panels), `node tests/domains.test.js` (the
three kinds of signal, gates, converters, sockets, the move from the rack),
`python3 tests/pwbridge_test.py` (the PipeWire bridge, on a private PipeWire),
`node tests/format.test.js` (design
files, the curated library and examples, compatibility lock), `python3 tests/serve_test.py`
(the curator server) and `python3 tests/run-ui.py`
(interactivity tests in headless Firefox; also runnable by opening
`index.html?uitest=1`).

## Editing

- **Wire (like patching a rack):** drag from a pin to a pin. An output feeds any
  number of inputs; an input takes one wire, and a new one replaces it. Drag a
  wire's end off an input to move it, or drop it on empty board to remove it.
- **Shape a trace:** drag it sideways (the straight run moves, its ends stretch,
  branches sharing it move too), or draw a wire corner by corner with **Draw
  wire** (W). Re-route in the inspector lets the router draw it again. Layers
  and vias are chosen by the renderer; you never pick a layer.
- **Select (V):** drag on empty board to box-select. Click selects a block or a
  wire; Shift-click adds or removes. Drag a block to move the selection, wires
  following. Arrow keys nudge (Shift: 5 cells).
- **Constants:** a Constant block is a number, optionally with a knob; wire it to
  any inputs. Inside a block it is a default that a wire from outside overrides,
  and so are input ports' defaults (set in the block's inspector).
- **The block editor:** open a library block (Files…, or the Open menu) and the
  inspector shows the block itself: description, size, inside size, ports (+
  input, + output, rows, kinds of signal) and input defaults. That is the only
  place a block is defined.
- **Only the open file is edited.** Zoomed into a block inside a design you can
  look and turn its knobs (this design's settings for that copy); clicks and
  drags act on the block as a whole.
- **A block in a design:** selecting it shows what it is, **Edit block…** (opens
  the block editor) and its **size here**: a size for this copy only, its inside
  drawn to fit and its pins spread over its height.
- **Undo / redo:** every gesture (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), including
  loading an example or importing a file.
- **Copy, cut, paste, duplicate:** Ctrl+C / X / V / D. Blocks and the wires
  between them, keeping traces, knobs and per-instance values. The clipboard
  survives reloads and works across tabs.
- **Pan and zoom:** right-, middle- or Space-drag pans; the wheel zooms. F zooms
  to the selection, H shows everything, Esc deselects or backs out.
- **Palette search:** type to filter, Enter to place the first match.

The editing core (`js/grid/editor.js`) has no DOM: selection, clipboard, moves,
deletion and the undo history are plain functions over the project, which the
page wires to pointer and key events.

## Sound from outside

There is no WAV player: sound comes in through **In** sockets. In the browser an
In hears the microphone; with the PipeWire bridge, it is a port of the design's
node, so anything can be linked to it, a file playing (`pw-play song.wav`), a
synth, another design. Example **An input through a ladder filter** shows one.

## Tuning library (Benson, *Music: A Mathematical Offering*, chapter 5)

In a digital oscillator the frequency is linear in the phase increment, so an
interval is a multiplication and a tuning is a table of ratios. You don't need
the analog 1 V/octave exponential. The library builds on that:

| Block | What it is |
|---|---|
| **Tune Pythagorean / Just / Meantone / Werckmeister / Vallotti / Equal** | Tuning ROMs. Input: semitones above the tonic (0–23). Output: frequency ratio. All six share one footprint, so a chip swaps for another (inspector → *Swap chip*, optionally every copy on the board). The ratios come from the Eitz-notation tables in `js/grid/tunings.js`. |
| **Chords** | Chord score: three voices × four steps of semitone numbers (default I–vi–ii–V). |
| **Harmonics** | Otonal score: four voices × four steps of harmonic numbers, times one fundamental f0. |
| **Periods** | Utonal score: periods in ticks, for Dividers. |
| **Comma Pump / Meantone Pump** | A flip-flop holds the chord root as a ratio of the tonic, and each chord change multiplies it by an interval. With just intervals I–vi–ii–V–I lands 81/80 flat each time round; with meantone intervals it closes. |
| **Divider** | Counter oscillator, f = 48000/N: the integer-period (FPGA) way to make a tone. |
| **SineVCO** | Phasor plus a parabolic sine, for nearly pure tones. |
| **Bank4**, **Mux4** | Four mixed VCOs; a phase-addressed 4:1 selector (the building block of the scores). |

Examples 5–8 put these together: *Six temperaments*, *Chords as harmonics*,
*The comma pump* and *Dividers*. The library is laid out by the router the
first time and then cached in localStorage.

## Curating examples and library blocks (design files)

Examples and library blocks are both design files in the repository:
`examples/` holds whole designs, and `library/` holds one block each (the
Phasor, the VCO, the Tune chips…). The format is versioned and canonical, and is
meant to outlive changes to the app. Designs refer to library blocks by name,
with a check on their pins, so curating a block's insides reaches every design
that uses it. The format and its compatibility rules are in
[FORMAT.md](FORMAT.md).

To curate, serve the repository with `python3 tools/serve.py` and open
http://127.0.0.1:8000/.
- **Files…** (Ctrl+O) manages both: new examples and new blocks, open,
  duplicate, rename, delete (to a trash you can restore from), and the order of
  the Open menu. Renaming a block updates every file that uses it; deleting one
  that examples use leaves them their own copy.
- **Open…** an example, or a library block: a block opens on a workbench,
  zoomed into its insides.
- **Ctrl+S** saves the open example or block to its file; the toolbar shows
  which file is open, with • while it has unsaved changes.
- **Save…** writes the whole design into `examples/` (under any title), or a
  block (and any changed blocks inside it) into `library/`. Blocks with unsaved
  edits are marked ▣• in the palette.
- **Elsewhere**, the same dialog downloads the file.
- **Export** makes a self-contained file; **Import** opens any design file.

## Three kinds of signal on one canvas

Every pin carries one kind of signal, and each kind looks different:

| Kind | Values | Blocks | Wires look like |
|---|---|---|---|
| **Float** | numbers | Add, Multiply, Greater than, Switch, Delay, Constant | circuit-board traces, coloured by value |
| **Fixed point** | words of 1–32 bits | AND, OR, XOR, NOT, NAND, NOR, XNOR, D flip-flop, Split, Join, Bits | barcodes: one stripe per bit, white 1, black 0, live |
| **Analog** | voltages | VCO, LFO, Ladder VCF, VCA, ADSR, Mixer, Noise, Glide, Attenuverter, Analog Sequencer, Clock, Gain, Voltage | patch cables hanging between jacks |

A wire only joins pins of the same kind; dragging one between kinds is refused
with a hint. Four **crossings** do nothing but cross: **Voltmeter** and **AWG**
(volts ↔ numbers), **Word** (a number into a word of bits: an integer or a
fraction of full scale, wrapping or clipping) and **Value** (a word read as an
integer or fraction, signed or not). Every **converter** with a law in it is a
library block built from those and float arithmetic, so you can make your own:
ADC, DAC (bipolar), DAC (one-sided), Quantizer, Dequantizer, V/OCT → Hz, Hz →
V/OCT, Scaled Voltmeter, Scaled AWG. Their settings (range, gain, binary point)
are input pins with knob defaults; blocks with the same pins swap like chips.
For laws that aren't arithmetic there are **2^x**, **log₂** and **Table** (a
curve through points, a ROM).

* **Fixed point.** Gates act on every bit of a bus at once; a bus is as wide as
  what drives it (a gate: its widest input). Split takes a bus apart into fields
  and Join puts fields together. The binary point and the sign are not on the
  bus: the converters decide. Library block **Counter4** is a 4-bit counter made
  of gates; zoom in to see it.
* **Analog modules** sit on the board as their panels, knobs and jacks and all
  (2 HP to a cell). They are circuits sampled by the board's clock: during a tick
  a module's outputs hold what it measured over the previous tick, and at the
  clock edge it integrates its equations across the next one. So each module is
  a clock boundary (one tick, 20.8 µs, of latency) and feedback through analog
  modules is always legal (example 12). A tick is always 1/48 000 s of simulated
  time; at a slow clock the circuits run in slow motion. Volts are numbers: 1 V/oct
  with 0 V = C4, audio ±5 V, gates 0–10 V.
* **How wires look is yours.** Select a wire to give it a colour, a trace its
  width, a cable its droop. Double-click a trace to put a via there (it changes
  layer); until you place vias, the renderer draws them where traces cross.
* **Sockets.** **In** and **Out** blocks are the design's audio ports. In the
  browser, Out 1 is the left speaker and Out 2 the right (one Out plays on both),
  and the Ins hear the microphone.

### PipeWire

Run the bridge as yourself on the machine whose audio you want, then press
**PipeWire** in the app:

```
python3 tools/pwbridge.py
```

The design becomes a PipeWire node, *Sample Factory*, with a port for every
socket, named as the sockets are, so it can be patched in Helvum like any other
program. The other programs' audio nodes appear on the board beside the design,
Helvum-style, with their links: drag from a port to a port, or onto a socket, to
link them; select a link and press Delete to unlink it. An Out socket's
inspector lists and makes its links too. The bridge uses only Python and
PipeWire's own library and tools, listens on 127.0.0.1, and accepts pages served
from this machine only. With sound off, the board's own clock still feeds the
node.

Examples 9–14: *Analog voice*, *Just chords on analog VCOs*, *Song through a
ladder filter*, *Analog feedback loops*, *Three domains: gates play a VCO* and
*Bit crusher*.

## The atoms

| Block | Computes |
|---|---|
| Constant | `y = c` (it can be shown as a knob, toggle or button) |
| Copy | `y₀ = y₁ = x` (the only way to fan out) |
| Add | `y = a + b` |
| Multiply | `y = a × b` |
| Unit delay | `y[n] = x[n−1]` (a register, the only memory) |
| Switch | `y = if > 0 ? then : else` |
| Greater than | `y = a > b ? 1 : 0` |

Plus structural blocks: Inlet/Outlet (composite ports), DAC (speaker) and
Scope (display).

## A short tour

1. **Examples → 1 · Counter.** One adder and one register. Step the slow clock
   and watch the numbers. Then delete the Unit delay and wire the Copy straight
   back into the Add: the compiler rejects the *combinational loop* and
   highlights it.
2. **Examples → 2 · A tone from scratch.** The phase accumulator (Phasor)
   drawn out with atoms. Turn the Hz knob.
3. **Examples → 3 · Sequenced synth.** Double-click any module to look inside.
   The Seq4 panel knobs are constants inside the definition, exposed as controls.
4. Click **Code** to read the exact JavaScript the patch compiled to. Select
   any block to see its own line.
5. With nothing selected, the right-hand panel lists the resources (adders,
   multipliers, registers…) and the **critical path**: the longest chain of
   arithmetic between registers.

## Building your own blocks

* **+ New block** creates an empty definition with one inlet and one outlet.
* Alternatively, shift-drag to select part of a patch and press **Ctrl+G** to
  group it. Wires that cross the boundary become ports.
* Inside a definition, select a Constant and tick **Show as a control**. It
  then appears on the panel of every instance, and each instance keeps its own
  value.
* Editing a definition changes every instance of it, like an HDL module.
* **Export library** / **Import** move block libraries between projects. The
  project autosaves in the browser.

## Layout

```
index.html        UI shell
css/style.css
js/blocks.js      atom definitions (ports, equations, docs)
js/compiler.js    flatten → schedule → loop check → codegen → analysis
js/library.js     starter library + examples (built from atoms)
js/engine.js      AudioWorklet runner and slow main-thread clock
js/editor.js      SVG patch editor
js/app.js         palette, inspector, navigation, persistence
tests/test.js     node tests
```

## Board prototype in two minutes

1. Open `index.html`. The sequenced synth is loaded and running at real time.
   Press **▶ Start audio** to hear it.
2. Drag the **Clock** slider left: the sound turns into steps, then clicks, and
   you can watch each register change colour tick by tick.
3. Scroll into **Seq4** until its insides are big. The four knobs are the
   melody. Drag one up or down.
4. Keep scrolling into the **VCO** and then its **Phasor**: where a trace crosses
   another it dips to the bottom layer (the darker, thinner track) through vias
   (the circles). That is only drawing; the connections are the wires.
5. Make something: pick **Add** from the palette and click to place it, then
   drag from one of its pins to another block's pin. Place a **Constant** (under
   Float) and wire it to an input to give it a value with a knob.
6. Open **Three domains: gates play a VCO**: a float Phasor ticks a counter of
   gates (watch its barcode count up), and a DAC turns the count into a pitch for
   an analog VCO, patched with cables.