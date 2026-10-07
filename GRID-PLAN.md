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
