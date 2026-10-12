// Twelve-note tunings from Benson, "Music: A Mathematical Offering", chapter 5,
// written the way the book writes them: Eitz's notation. Every note is a
// position on the line of fifths (C = 0, G = 1, F = −1, ...) giving its
// Pythagorean value, adjusted by a number of syntonic commas (81:80) and/or
// Pythagorean commas (531441:524288). The library turns each into a tuning ROM.
(function (root) {
  'use strict';

  const SYNTONIC = 81 / 80, PYTHAGOREAN = 531441 / 524288;
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  const fold = (r) => { while (r >= 2) r /= 2; while (r < 1) r *= 2; return r; };
  const cents = (r) => 1200 * Math.log2(r);
  // Eitz note: [semitone, fifths, syntonic commas, Pythagorean commas, name].
  const ratioOf = ([, n, k = 0, p = 0]) => fold(Math.pow(1.5, n) * Math.pow(SYNTONIC, k) * Math.pow(PYTHAGOREAN, p));

  // Semitone -> [fifths, commas, p-commas, spelling]. Spellings follow the book.
  const T = {
    pythagorean: {
      title: 'Pythagorean', section: '§5.2–5.3',
      note: 'Pure 3:2 fifths from E♭ to G♯. The wolf is G♯–E♭, a Pythagorean comma narrow.',
      notes: { 0: [0], 1: [7, 0, 0, 'C♯'], 2: [2], 3: [-3, 0, 0, 'E♭'], 4: [4], 5: [-1], 6: [6, 0, 0, 'F♯'], 7: [1], 8: [8, 0, 0, 'G♯'], 9: [3], 10: [-2, 0, 0, 'B♭'], 11: [5] },
    },
    just: {
      title: 'Just (Marpurg 1776)', section: '§5.5, 5.10',
      note: 'Marpurg\'s Monochord No. 1: C♯⁻² G♯⁻² / A⁻¹ E⁻¹ B⁻¹ F♯⁻¹ / F⁰ C⁰ G⁰ D⁰ / E♭⁺¹ B♭⁺¹. I, IV and V are pure 4:5:6, but D⁰–F⁰–A⁻¹ (ii) is not a just minor triad.',
      notes: { 0: [0], 1: [7, -2, 0, 'C♯'], 2: [2], 3: [-3, 1, 0, 'E♭'], 4: [4, -1], 5: [-1], 6: [6, -1, 0, 'F♯'], 7: [1], 8: [8, -2, 0, 'G♯'], 9: [3, -1], 10: [-2, 1, 0, 'B♭'], 11: [5, -1] },
    },
    meantone: {
      title: '¼-comma meantone (Aaron 1523)', section: '§5.12',
      note: 'Every fifth narrowed by a quarter of a syntonic comma, so the major thirds are pure 5:4. Notes from E♭ to C♯ plus A♭, as on Aaron\'s keyboard: there is no G♯, the fifth C♯–A♭ is the wolf (737.6 cents), and A♭ stands 41 cents (a great diesis) away from the G♯ an E major chord wants.',
      notes: { 0: [0], 1: [7, -7 / 4, 0, 'C♯'], 2: [2, -1 / 2], 3: [-3, 3 / 4, 0, 'E♭'], 4: [4, -1], 5: [-1, 1 / 4], 6: [6, -3 / 2, 0, 'F♯'], 7: [1, -1 / 4], 8: [-4, 1, 0, 'A♭'], 9: [3, -3 / 4], 10: [-2, 1 / 2, 0, 'B♭'], 11: [5, -5 / 4] },
    },
    werckmeister: {
      title: 'Werckmeister III (1691)', section: '§5.13',
      note: 'The Pythagorean comma shared between C–G–D–A and B–F♯, so the circle closes. Keys near C are almost meantone; remote keys have sharp thirds.',
      notes: { 0: [0], 1: [7, 0, -1, 'C♯'], 2: [2, 0, -1 / 2], 3: [-3, 0, 0, 'E♭'], 4: [4, 0, -3 / 4], 5: [-1], 6: [6, 0, -1, 'F♯'], 7: [1, 0, -1 / 4], 8: [8, 0, -1, 'G♯'], 9: [3, 0, -3 / 4], 10: [-2, 0, 0, 'B♭'], 11: [5, 0, -3 / 4] },
    },
    vallotti: {
      title: 'Vallotti–Young (1780/1800)', section: '§5.13',
      note: 'Six fifths narrowed by ⅙ Pythagorean comma (Young\'s version), six pure. Probably close to what Bach intended for the Well-Tempered Clavier.',
      notes: { 0: [0], 1: [7, 0, -1, 'C♯'], 2: [2, 0, -1 / 3], 3: [-3, 0, 0, 'E♭'], 4: [4, 0, -2 / 3], 5: [-1], 6: [6, 0, -1, 'F♯'], 7: [1, 0, -1 / 6], 8: [8, 0, -1, 'G♯'], 9: [3, 0, -1 / 2], 10: [-2, 0, 0, 'B♭'], 11: [5, 0, -5 / 6] },
    },
    equal: {
      title: 'Equal temperament', section: '§5.14',
      note: 'Every semitone 2^(1/12). Almost exactly 1/11-comma meantone. Every key alike; major thirds 13.7 cents sharp.',
      equal: true,
    },
  };

  // The twelve ratios (C = 1) of a tuning, in semitone order.
  function ratios(id) {
    const t = T[id];
    if (t.equal) return Array.from({ length: 12 }, (_, i) => Math.pow(2, i / 12));
    return Array.from({ length: 12 }, (_, i) => ratioOf([i, ...t.notes[i]]));
  }
  // Eitz label like "E⁻¹" or "G⁻¼p" for docs and knob labels.
  const SUP = { '-': '⁻', '+': '⁺', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const FRAC = { 0.25: '¼', 0.5: '½', 0.75: '¾', [1 / 3]: '⅓', [2 / 3]: '⅔', [1 / 6]: '⅙', [5 / 6]: '⅚', 1.75: '⁷⁄₄', 1.25: '⁵⁄₄', 1.5: '³⁄₂' };
  function sup(x, unit) {
    if (!x) return '';
    const s = x < 0 ? '⁻' : '⁺', a = Math.abs(x);
    const body = Number.isInteger(a) ? String(a).split('').map((c) => SUP[c]).join('') : (FRAC[a] || a.toFixed(3));
    return s + body + unit;
  }
  function label(id, i) {
    const t = T[id];
    if (t.equal) return NAMES[i];
    const [, k = 0, p = 0, name] = t.notes[i];
    return (name || NAMES[i]) + (k || p ? sup(k, '') + sup(p, 'p') : '⁰');
  }

  const api = { TUNINGS: T, NAMES, ratios, label, cents, fold, SYNTONIC, PYTHAGOREAN, ORDER: ['pythagorean', 'just', 'meantone', 'werckmeister', 'vallotti', 'equal'] };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GW = Object.assign(root.GW || {}, { Tunings: api });
})(typeof self !== 'undefined' ? self : this);
