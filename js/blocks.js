// Block definitions: the complete vocabulary of the machine.
(function (root) {
  'use strict';

  const FS = 48000; // the single system clock, in ticks per second

  // The seven atoms. `expr` builds the right-hand side of the generated code
  // line from the expressions feeding each input.
  const ATOMS = {
    const: {
      title: 'Constant', symbol: 'c', ins: [], outs: ['y'], eq: 'y = c',
      doc: 'Outputs the same number every tick. Expose it on a panel to turn it into a knob, toggle or button.',
    },
    copy: {
      title: 'Copy', symbol: '⇉', ins: ['x'], outs: ['y₀', 'y₁'], eq: 'y₀ = x,  y₁ = x',
      doc: 'Duplicates a signal. Every output can drive only one input, so fan-out is always explicit.',
      expr: (a) => a[0],
    },
    add: {
      title: 'Add', symbol: '+', ins: ['a', 'b'], outs: ['y'], eq: 'y = a + b',
      doc: 'Sum of two signals. To subtract, multiply by a Constant −1 first.',
      expr: (a) => `${a[0]} + ${a[1]}`, cost: 'adder',
    },
    mul: {
      title: 'Multiply', symbol: '×', ins: ['a', 'b'], outs: ['y'], eq: 'y = a × b',
      doc: 'Product of two signals. Used for gain (VCA), scaling, mixing coefficients.',
      expr: (a) => `${a[0]} * ${a[1]}`, cost: 'multiplier',
    },
    delay: {
      title: 'Unit delay', symbol: 'z⁻¹', ins: ['x'], outs: ['y'], eq: 'y[n] = x[n−1]',
      doc: 'A register. Outputs the value its input had on the previous tick (starts at 0). The only block with memory, and the only way to close a feedback loop.',
      cost: 'register',
    },
    switch: {
      title: 'Switch', symbol: '?:', ins: ['if', 'then', 'else'], outs: ['y'], eq: 'y = (if > 0) ? then : else',
      doc: 'A multiplexer. Both branches are always computed, like in hardware.',
      expr: (a) => `(${a[0]} > 0 ? ${a[1]} : ${a[2]})`, cost: 'mux',
    },
    gt: {
      title: 'Greater than', symbol: '>', ins: ['a', 'b'], outs: ['y'], eq: 'y = (a > b) ? 1 : 0',
      doc: 'Comparator. Outputs 1 or 0.',
      expr: (a) => `(${a[0]} > ${a[1]} ? 1 : 0)`, cost: 'comparator',
    },
  };

  const STRUCT = {
    inlet: {
      title: 'Inlet', symbol: '▷', ins: [], outs: [''], eq: 'y = value arriving at this input of the composite',
      doc: 'An input port of the composite block being edited. Ports are ordered top to bottom.',
    },
    outlet: {
      title: 'Outlet', symbol: '▷', ins: [''], outs: [], eq: 'composite output = x',
      doc: 'An output port of the composite block being edited. Ports are ordered top to bottom.',
    },
    dac: {
      title: 'DAC', symbol: '🔊', ins: ['x'], outs: [], eq: 'speaker = clip(x, −1, 1)',
      doc: 'Sends its input to the speakers, clipped to [−1, 1]. Several DACs are summed.',
    },
    scope: {
      title: 'Scope', symbol: '∿', ins: ['x'], outs: [], eq: '(display only)',
      doc: 'Draws its input. Has no effect on the computation.',
    },
  };

  const ATOM_ORDER = ['const', 'copy', 'add', 'mul', 'delay', 'switch', 'gt'];
  const STRUCT_ORDER = ['inlet', 'outlet', 'dac', 'scope'];

  function byPosition(a, b) { return (a.y - b.y) || (a.x - b.x); }

  // Inlets or outlets of a definition, in port order.
  function boundary(def, type) {
    return def.blocks.filter((b) => b.type === type).sort(byPosition);
  }

  // Constants of a definition that appear on its control panel, in panel order.
  function panelControls(def) {
    return def.blocks
      .filter((b) => b.type === 'const' && b.panel)
      .sort((a, b) => ((a.panel.order || 0) - (b.panel.order || 0)) || byPosition(a, b));
  }

  function info(type) { return ATOMS[type] || STRUCT[type] || null; }

  // Port names of any block (composites need the library to answer).
  function ports(block, defs) {
    if (block.type === 'comp') {
      const def = defs && defs[block.def];
      if (!def) return { ins: [], outs: [] };
      return {
        ins: boundary(def, 'inlet').map((b) => b.name || ''),
        outs: boundary(def, 'outlet').map((b) => b.name || ''),
      };
    }
    const i = info(block.type);
    return i ? { ins: i.ins, outs: i.outs } : { ins: [], outs: [] };
  }

  // Current value of a panel control, as seen on a given composite instance.
  function controlValue(inst, constBlock) {
    if (inst && inst.params && Object.prototype.hasOwnProperty.call(inst.params, constBlock.id)) {
      return inst.params[constBlock.id];
    }
    return constBlock.value;
  }

  const api = { FS, ATOMS, STRUCT, ATOM_ORDER, STRUCT_ORDER, info, ports, boundary, panelControls, controlValue, byPosition };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CW = Object.assign(root.CW || {}, api);
})(typeof self !== 'undefined' ? self : this);
