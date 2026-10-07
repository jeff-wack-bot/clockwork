# ⚙ Clockwork

A transparent, FPGA-flavoured dataflow synthesizer for the browser. Oscillators,
sequencers, envelopes and filters are built from **seven atomic blocks** that run
on **one global 48 kHz clock**, and nothing happens under the hood: you can see
the compiled program, the live value on every wire, the "hardware" your design
uses, and its critical path.

There are two front-ends:

* `index.html` is the **patch editor** (blocks and wires).
* `grid.html` is the **grid prototype**: registers are painted regions, crossings use a second
  layer, constants have handles instead of panels, zooming in is how you enter a block, and a
  single slider sets the clock from 0.5 Hz up to real time. See [GRID-PLAN.md](GRID-PLAN.md).

See [PLAN.md](PLAN.md) for the design, and for the decisions made where the
brief left room for interpretation.

## Running it

No build step and no dependencies. Either:

* open `index.html` directly in a recent Chrome/Edge/Firefox, or
* serve the folder: `python3 -m http.server` → http://localhost:8000

Then press **▶ Start audio**. The default patch is a sequenced synth. To watch
it tick instead, choose the **slow** clock and press **Step** (or Space).

Tests: `node tests/test.js` (patch editor) and `node tests/grid.test.js` (grid prototype)

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

## Grid prototype in two minutes

1. Open `grid.html`. The sequenced synth is loaded and running at real time.
   Press **▶ Start audio** to hear it.
2. Drag the **Clock** slider left: the sound turns into steps, then clicks, and
   you can watch each register change colour tick by tick.
3. Scroll into **Seq4** until its insides are big. The four knobs are the
   melody. Drag one up or down.
4. Keep scrolling into the **VCO** and then its **Phasor**: the feedback loop
   drops to the bottom layer (the darker, thinner track) through vias (the circles).
5. Make something: pick **Add** from the palette and click to place it. Switch
   to **Draw** (W) and paint from a pad. Press **Tab** mid-stroke to dive under
   another region. Use **Knob** (K) on an unwritten region to give it a handle.
