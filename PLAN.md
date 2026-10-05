# Clockwork — plan for a minimal viable demo

A browser-based synthesizer in which **everything is a synchronous dataflow
graph clocked by one global sample clock**, in the spirit of Pure Data, VCV Rack
and FPGA firmware. Nothing is hidden: oscillators, sequencers, envelopes and
filters are all built from seven atomic blocks, and the user can see the
compiled per-tick program, the "hardware" resources it uses, and the live value
on every wire.

## Goals of the MVP

1. A patch editor (blocks + wires) with the seven atomic blocks.
2. Composite blocks ("modules") with inlets/outlets, stored in a reusable library.
3. Control panels: constants inside a composite can be exposed as knobs,
   toggles or buttons, and appear on the face of every instance.
4. Real-time audio at a fixed 48 kHz clock.
5. A *slow clock* / single-step mode for watching values propagate tick by tick.
6. Full transparency: generated code viewer, per-block compiled line, resource
   report, critical-path report, live values on every output port, scopes.
7. A starter library and examples showing how to build a phasor, VCO,
   sequencer, decay envelope and resonant filter from atoms.

Explicit non-goals for the MVP: MIDI, polyphony, file-based audio, undo/redo,
fixed-point arithmetic, multiple clock domains, mobile/touch polish.

## Architecture

Plain HTML + JavaScript, no build step, no dependencies. Opens directly from
`index.html` (the AudioWorklet is loaded from a Blob URL so `file://` works).

| File | Role |
|---|---|
| `js/blocks.js` | Atomic block definitions: ports, equation, docs, code template |
| `js/compiler.js` | Flattens the hierarchy, schedules, detects loops, generates JS, analyses resources & critical path |
| `js/library.js` | Starter library + example patches, written with a tiny builder DSL |
| `js/engine.js` | Runs the compiled program: AudioWorklet (audio clock) or main thread (slow clock / step) |
| `js/editor.js` | SVG patch editor |
| `js/app.js` | Glue: toolbar, palette, library, inspector, persistence |
| `tests/test.js` | Node tests of the compiler and library modules (`node tests/test.js`) |

### Execution model

* One clock. Every tick (1/48000 s) every block computes exactly once.
* Wires carry one 64-bit float per tick.
* **Unit delay = register.** Its output is the value latched on the previous
  clock edge. All registers latch simultaneously at the end of the tick
  (the generated code makes this explicit with two-phase assignment).
* Every other block is **combinational**. A cycle that does not pass through a
  unit delay is a *combinational loop* and is a compile error (exactly as in
  FPGA synthesis), and the offending blocks are highlighted.
* The compiler flattens composites into a netlist of atoms, topologically
  sorts the combinational logic, and emits straight-line JavaScript
  (`n7 = n3 + n5; // b12 Add`). That code is shown verbatim in the UI and is
  exactly what runs in the audio thread.

### Atomic blocks (the user's list, with precise semantics)

| Block | Ports | Semantics |
|---|---|---|
| Constant | → y | `y = c` (c editable; can be shown as knob/toggle/button) |
| Copy | x → y₀, y₁ | `y₀ = y₁ = x` |
| Add | a, b → y | `y = a + b` |
| Multiply | a, b → y | `y = a × b` |
| Unit delay | x → y | `y[n] = x[n−1]`, initial value 0 |
| Switch | if, then, else → y | `y = if > 0 ? then : else` |
| Greater than | a, b → y | `y = a > b ? 1 : 0` |

Structural (non-computing) blocks: **Inlet / Outlet** (composite boundary),
**DAC** (to the speaker) and **Scope** (display only).

### Transparency features

* Live value printed next to every output port (snapshot ~20×/s in audio
  mode, every tick in slow mode).
* Inspector shows each block's equation and **the exact line of generated code**
  it compiled to.
* "Code" button shows the whole compiled program.
* Resource report: number of adders, multipliers, comparators, muxes,
  registers; operations per tick and per second.
* Critical path: longest chain of combinational operations between registers
  — the thing that limits clock speed on an FPGA. Inserting a unit delay
  (pipelining) visibly shortens it.
* Clock panel: audio-rate (48 kHz) or slow clock (0.5 Hz–2 kHz) with pause /
  single step / reset, and a tick counter.

## Decisions made on unclear points

1. **Fan-out must be explicit.** An output may drive only one input; use Copy
   to split a signal. This makes Copy meaningful, mirrors dataflow token
   semantics, and makes group-into-composite unambiguous. The editor refuses
   a second connection and explains why; the compiler also rejects it.
2. **Unconnected inputs read 0.** Reported as warnings, not errors.
3. **Switch condition is `if > 0`**, matching Greater-than's 1/0 output.
   Both branches are always computed (like a hardware mux).
4. **No subtract, divide, or modulo atoms.** Subtract = multiply by −1 and add.
   Wrapping uses Greater-than + Switch. Division is avoided by precomputing
   reciprocals (e.g. 1/fs) — just like DSP hardware.
5. **Fixed sample rate of 48 000 Hz** ("the board's oscillator"), requested
   from the AudioContext. Modules that need Hz use a Constant `1/fs`.
6. **Numbers are float64 in the MVP.** Fixed-point/bit-width simulation is the
   most important follow-up for the FPGA flavour but would double the scope.
7. **Decimation / clock enables are built, not built-in.** There is a single
   clock domain; slower processes use *clock-enable* patterns (a Switch in
   front of a register = sample-and-hold), which is how FPGA designs actually
   run slow logic. The library's Counter, Seq4 and Sample&Hold show this.
8. **Composite definitions are shared** (like HDL modules): editing a
   definition changes every instance. Each instance owns its panel values.
9. **Port order** of a composite = vertical position (then horizontal) of its
   Inlet/Outlet blocks inside the definition. Users reorder by moving them.
10. **Panel controls are Constants.** A knob is literally a Constant you can
    turn; a toggle switches between min/max; a button outputs max while held.
    Knobs can be linear or logarithmic. Panel order is set by an "order"
    number. Constants can show their control at any level, including the root.
11. **No re-exposure of nested panels.** To control an inner module from
    outside, give it an Inlet and drive it from an outer knob — the dataflow
    way.
12. **DAC clips to [−1, 1]**; several DACs sum. NaN/∞ produce silence and a
    warning; Reset clears all registers (like a hardware reset).
13. **Changing a constant never recompiles** — constants live in a parameter
    array, so turning knobs is glitch-free and register state is kept. Structural
    edits recompile, and register state is carried over by register name.
14. **Persistence**: autosave to localStorage, plus project export/import as
    JSON. The library is part of the project; library JSON can be imported
    into another project (merge).
15. **Compile errors keep the last good program running**, with a clear banner.

## Build steps (executed)

1. Plan + decisions (this file).
2. `blocks.js`, `compiler.js`, `library.js` and node tests (phasor frequency,
   counter, loop detection, fan-out check, state migration).
3. `engine.js`: AudioWorklet host and main-thread slow clock with state handoff.
4. `editor.js` + `app.js` + UI: palette, wiring, selection, pan/zoom,
   composite navigation, group-into-composite, inspector, panels, scopes.
5. Smoke test in headless Firefox (screenshot) and write README.

## Possible next steps after the MVP

* Fixed-point mode (per-wire bit width, overflow/wrap visualised).
* Explicit clock-enable domains and "resource cost" of decimation.
* Undo/redo, copy/paste between patches, panel layout editor.
* MIDI / computer-keyboard input as an Inlet at the root.
* Export the netlist to Verilog/VHDL — the natural end-point of the idea.
