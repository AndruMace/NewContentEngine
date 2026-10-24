import { describe, expect, it } from 'vitest';
import { Rng, Runner, getTheme, paramsJsonSchema, parseParams } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { PATTERNS, patternRates, polygonSides } from './patterns';
import { FIGURES, buildEpicycles } from './epicycles';
import { ADDENDUM, HUB, Z_MAX, Z_MIN, buildGearTrain, reachableRates, trainExtent } from './gears';
import { POLYRHYTHM_STYLES, chordSteps, noteName, pitchDegrees, polyrhythm } from './index';
import { beamAngle, coastNoteU, groupGapU, shipAngle, shipLanes, shipLaps } from './lighthouse';

const run = (params: Record<string, unknown>, seed = 1) =>
  new Runner(polyrhythm, { seed, theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), params: { loopSeconds: 12, ...params }, visual: false }).runToEnd();

describe('polyrhythm', () => {
  it('spells key labels the way each scale is written', () => {
    const names = (scale: Parameters<typeof noteName>[0], root: number, n = 8) => Array.from({ length: n }, (_, i) => noteName(scale, root, i)).join(' ');
    expect(names('mixolydian', 60)).toBe('C4 D4 E4 F4 G4 A4 B♭4 C5');
    expect(names('mixolydian', 55)).toBe('G3 A3 B3 C4 D4 E4 F4 G4');
    expect(names('mixolydian', 58)).toBe('B♭3 C4 D4 E♭4 F4 G4 A♭4 B♭4');
    expect(names('major', 66, 7)).toBe('F♯4 G♯4 A♯4 B4 C♯5 D♯5 E♯5');
    expect(names('lydian', 64, 4)).toBe('E4 F♯4 G♯4 A♯4');
    expect(names('minor', 62, 7)).toBe('D4 E4 F4 G4 A4 B♭4 C5');
    expect(names('pentatonic', 61, 3)).toBe('C♯4 D♯4 F4');
  });

  it.each(POLYRHYTHM_STYLES.flatMap((style) => PATTERNS.map((pattern) => [style, pattern] as const)))('%s / %s loops exactly', (style, pattern) => {
    const r = run({ style, pattern, count: 12 });
    expect(r.timedOut).toBe(false);
    const s = r.state;
    // Fourier ends on its finished drawing and holds the sync chord. Ripples shift the sync a moment
    // into the loop (it opens with every drop in the air) and stay seamless.
    expect(r.durationS).toBeCloseTo(12 + s.holdS, 1);
    expect(s.holdS).toBe(style === 'fourier' ? 2 : 0);
    if (style === 'ripples') expect(s.syncS).toBeGreaterThan(0.1);
    else expect(s.syncS).toBe(0);
    const hits = r.events.filter((e) => e.type === 'hit');
    // Every element plays exactly its whole number of notes, evenly spaced, starting together (at the
    // sync), plus the closing note at the end when the finish is held.
    s.notesPerLoop.forEach((m, i) => {
      const mine = hits.filter((e) => e.i === i);
      expect(Number.isInteger(m)).toBe(true);
      expect(mine).toHaveLength(s.holdS ? m + 1 : m);
      expect(mine[0].t).toBeCloseTo(s.syncS, 1);
      if (s.holdS) expect(mine[mine.length - 1].t).toBeCloseTo(12, 1);
      if (m > 1) expect(mine[1].t - mine[0].t).toBeCloseTo(12 / m, 1);
    });
  });

  it.each(POLYRHYTHM_STYLES)('%s works with the slowest element at a single cycle per loop', (style) => {
    const r = run({ style, baseCycles: 1, count: 12 });
    expect(r.timedOut).toBe(false);
    const s = r.state;
    const hits = r.events.filter((e) => e.type === 'hit');
    expect(Math.min(...s.cycles)).toBeGreaterThanOrEqual(1);
    s.notesPerLoop.forEach((m, i) => {
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(hits.filter((e) => e.i === i)).toHaveLength(s.holdS ? m + 1 : m);
    });
  });

  it('scattered orrery: planets start apart and all ring together only at the end', () => {
    const r = run({ style: 'orrery', orreryStart: 'scattered', count: 8 });
    const s = r.state;
    expect(s.holdS).toBe(2);
    expect(r.durationS).toBeCloseTo(14, 1);
    const hits = r.events.filter((e) => e.type === 'hit');
    // Nothing rings at the start (no planet is on the beam), every planet rings exactly at the end.
    expect(hits.filter((e) => e.t === 0)).toHaveLength(0);
    s.cycles.forEach((c, i) => {
      const mine = hits.filter((e) => e.i === i);
      expect(mine).toHaveLength(c + 1);
      expect(mine[mine.length - 1].t).toBeCloseTo(12, 1);
      expect(mine[1].t - mine[0].t).toBeCloseTo(12 / s.beatRate[i], 1);
    });
    // Starting positions really are spread out: no two planets within 5% of a lap.
    const starts = s.beatOffset.map((o) => o % 1).sort((a, b) => a - b);
    for (let k = 1; k < starts.length; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThan(0.05);
  });

  it('keeps the layout when only the scale changes', () => {
    const init = (style: string, scale: string) =>
      polyrhythm.init({ params: parseParams(polyrhythm, { style, scale, pattern: 'random' }), rng: new Rng(590062) } as never);
    for (const style of POLYRHYTHM_STYLES) {
      const a = init(style, 'random');
      const b = init(style, 'hirajoshi');
      expect(b.cycles).toEqual(a.cycles);
      expect(b.arbors).toEqual(a.arbors);
      expect(b.colorShift).toBe(a.colorShift);
    }
  });

  it('builds the speed patterns', () => {
    const rng = new Rng(1);
    expect(patternRates('linear', 5, 10, 1, rng)).toEqual([10, 11, 12, 13, 14]);
    expect(patternRates('harmonic', 4, 10, 1, rng)).toEqual([3, 6, 9, 12]);
    expect(patternRates('primes', 4, 10, 1, rng)).toEqual([3, 5, 7, 11]);
    expect(patternRates('mirror', 5, 10, 1, rng)).toEqual([12, 11, 10, 11, 12]);
    const rand = patternRates('random', 8, 10, 1, rng);
    expect(new Set(rand).size).toBe(8);
    expect([...rand].sort((a, b) => a - b)).toEqual(rand);
    expect(polygonSides('linear', 4, 1, rng)).toEqual([3, 4, 5, 6]);
    expect(polygonSides('primes', 4, 1, rng)).toEqual([3, 5, 7, 11]);
  });

  it('caps polygons and lanes to what reads on screen', () => {
    expect(run({ style: 'polygons', count: 30 }).state.sides).toHaveLength(10);
    expect(run({ style: 'piano', count: 30 }).state.cycles).toHaveLength(24);
    expect(run({ style: 'orrery', count: 30 }).state.cycles).toHaveLength(8);
    expect(run({ style: 'gears', count: 32 }).state.cycles).toHaveLength(32);
    // The ring has room for every drop the slider allows.
    expect(run({ style: 'ripples', count: 32 }).state.cycles).toHaveLength(32);
    // The count is shared between columns and rows, up to ten each.
    expect(run({ style: 'lissajous', count: 30 }).state.cycles).toHaveLength(20);
    expect(run({ style: 'lissajous', count: 12 }).state.cycles).toHaveLength(12);
    expect(run({ style: 'lissajous', count: 5 }).state.cycles).toHaveLength(6);
  });

  it.each(FIGURES)('fourier %s: circles turn whole numbers of times, so the drawing closes at the end', (figure) => {
    const e = buildEpicycles(figure, 32, (k) => Array.from({ length: k }, (_, i) => 10 + i));
    expect(e.arms.length).toBeGreaterThanOrEqual(3);
    expect(e.ticks).toHaveLength(e.arms.length);
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
    for (const a of e.arms) {
      expect(Number.isInteger(a.freq)).toBe(true);
      expect(a.freq).not.toBe(0);
    }
    expect(e.arms.map((a) => a.freq).reduce(gcd, 0)).toBe(1);
    // Biggest circle first.
    expect(e.arms.map((a) => a.amp)).toEqual([...e.arms.map((a) => a.amp)].sort((a, b) => b - a));
  });

  it('fits any number of elements into the pitch range, slowest lowest', () => {
    const ranks = (n: number) => Array.from({ length: n }, (_, i) => i);
    // Up to the range, one step each, as before.
    expect(pitchDegrees(ranks(18), 'pentatonic', 3.5, 'scale')).toEqual(ranks(18));
    expect(pitchDegrees(ranks(25), 'major', 3.5, 'scale')).toEqual(ranks(25));
    // Beyond it, spread across the range, never going down.
    const wide = pitchDegrees(ranks(32), 'pentatonic', 3.5, 'scale');
    expect(Math.max(...wide)).toBe(17);
    wide.forEach((d, i) => i && expect(d).toBeGreaterThanOrEqual(wide[i - 1]));
    expect(pitchDegrees(ranks(32), 'major', 2, 'scale').at(-1)).toBe(14);
    // Every note of a 32-dot video stays within the range above the root.
    const r = run({ style: 'ripples', count: 32, scale: 'pentatonic', rootNote: 55, pitchRange: 2.5 });
    const midis = r.events.filter((e) => e.type === 'hit').map((e) => e.midi as number);
    expect(Math.max(...midis)).toBeLessThanOrEqual(55 + 30);
  });

  it.each(PATTERNS.flatMap((pattern) => [1, 2, 7, 10, 23].flatMap((base) => [3, 1].flatMap((step) => [12, 32].map((n) => [pattern, base, step, n] as const)))))(
    'compound gear train (%s, base %i, step %i, %i gears) meshes, keeps every speed and loops',
    (pattern, base, step, n) => {
      const rates = reachableRates(patternRates(pattern, n, base, step, new Rng(3)));
      const { arbors, dropped } = buildGearTrain(rates, new Rng(4));
      expect(dropped).toEqual([]);
      const frac = (x: number) => x - Math.floor(x);
      const turns = (a: (typeof arbors)[number]) => a.num / a.den;
      // Every element rings on exactly one arbor, turning exactly its rate.
      for (let e = 0; e < n; e++) {
        const mine = arbors.filter((a) => a.element === e);
        expect(mine).toHaveLength(1);
        expect(mine[0].den).toBe(1);
        expect(mine[0].num).toBe(rates[e]);
        // Its front wheel carries the hand.
        expect(mine[0].wheels.some((w) => w.layer === 0)).toBe(true);
      }
      arbors.forEach((a, i) => {
        // At most one wheel per layer, every size in range.
        expect(new Set(a.wheels.map((w) => w.layer)).size).toBe(a.wheels.length);
        for (const w of a.wheels) {
          expect(w.z).toBeGreaterThanOrEqual(Z_MIN);
          expect(w.z).toBeLessThanOrEqual(Z_MAX);
          // Every wheel passes a whole number of teeth per loop, so the whole train looks the same at
          // the end as at the start.
          expect(Number.isInteger((a.num * w.z) / a.den)).toBe(true);
        }
        if (a.parent >= 0) {
          const p = arbors[a.parent];
          const pw = p.wheels.find((w) => w.layer === a.meshLayer)!;
          const cw = a.wheels.find((w) => w.layer === a.meshLayer)!;
          // Meshing wheels touch at their pitch circles, turn opposite ways at the tooth ratio…
          expect(Math.hypot(a.x - p.x, a.y - p.y)).toBeCloseTo((pw.z + cw.z) / 2, 6);
          expect(a.dir).toBe(-p.dir);
          expect(turns(a)).toBeCloseTo((turns(p) * pw.z) / cw.z, 9);
          // …and where they touch, a tooth of one faces a gap of the other.
          const phi = Math.atan2(a.y - p.y, a.x - p.x);
          const fp = frac((phi - pw.theta0) / ((2 * Math.PI) / pw.z));
          const fc = frac((phi + Math.PI - cw.theta0) / ((2 * Math.PI) / cw.z));
          expect(Math.min(frac(fp + fc - 0.5), 1 - frac(fp + fc - 0.5))).toBeLessThan(1e-6);
        }
        arbors.forEach((o, j) => {
          if (j === i) return;
          const d = Math.hypot(a.x - o.x, a.y - o.y);
          const meshed = (a.parent === j || o.parent === i) && (a.parent === j ? a.meshLayer : o.meshLayer);
          for (const w of a.wheels) {
            // No wheel covers another arbor (except the one it meshes with, which it can't reach anyway).
            if (!(meshed !== false && w.layer === meshed)) expect(d).toBeGreaterThanOrEqual(w.z / 2 + ADDENDUM + HUB - 1e-9);
            // Wheels in the same layer that don't mesh stay clear of each other.
            const ow = o.wheels.find((x) => x.layer === w.layer);
            if (ow && !(meshed !== false && w.layer === meshed)) expect(d).toBeGreaterThan((w.z + ow.z) / 2 + 2 * ADDENDUM);
          }
        });
      });
    },
  );

  it('nudges speeds no clock train can reach to the nearest that can', () => {
    // 79, 83 and 139 are primes above the largest wheel; 80, 84 and 140 aren't.
    expect(reachableRates([10, 79, 83, 139])).toEqual([10, 80, 84, 140]);
    // It never collides with a speed already in use: 97 → 98 is taken, so 96.
    expect(reachableRates([98, 97])).toEqual([98, 96]);
    expect(reachableRates([1, 2, 3, 71, 72])).toEqual([1, 2, 3, 71, 72]);
  });

  it('lighthouse ships: the beam finds each ship exactly at its notes, its rate times per loop', () => {
    for (const pattern of PATTERNS)
      for (const base of [1, 2, 10]) {
        const rates = patternRates(pattern, 16, base, 1, new Rng(5));
        const { beamTurns, laps } = shipLaps(rates);
        expect(beamTurns).toBeGreaterThanOrEqual(1);
        laps.forEach((k, i) => {
          expect(k).toBeGreaterThanOrEqual(0);
          // Opposite ways round, they meet beamTurns + laps times per loop: the ship's rate.
          expect(beamTurns + k).toBe(rates[i]);
          for (let j = 0; j < rates[i]; j++) {
            const u = j / rates[i];
            const gap = (((shipAngle(k, u) - beamAngle(beamTurns, u)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            expect(Math.min(gap, 2 * Math.PI - gap)).toBeLessThan(1e-9);
          }
        });
        // Faster ships sail the inner lanes, every lane its own.
        const lanes = shipLanes(laps);
        expect(new Set(lanes).size).toBe(lanes.length);
        laps.forEach((a, i) => laps.forEach((b, j) => a > b && expect(lanes[i]).toBeLessThan(lanes[j])));
      }
    // A bigger ship circle: the outer lane grows by the full amount, the inner (round the island) less,
    // so the lanes spread further apart; the order is unchanged and the notes don't move.
    const { laps } = shipLaps(patternRates('linear', 12, 10, 1, new Rng(1)));
    const small = shipLanes(laps);
    const big = shipLanes(laps, 2);
    expect(Math.max(...big)).toBeCloseTo(2 * Math.max(...small), 9);
    expect(Math.min(...big)).toBeCloseTo(Math.SQRT2 * Math.min(...small), 9);
    big.forEach((r, i) => expect(r).toBeGreaterThan(small[i]));
    const a = run({ style: 'lighthouse', count: 12 }).events.filter((e) => e.type === 'hit');
    const b = run({ style: 'lighthouse', count: 12, shipSpread: 2 }).events.filter((e) => e.type === 'hit');
    expect(b.map((e) => [e.t, e.i, e.midi])).toEqual(a.map((e) => [e.t, e.i, e.midi]));
    b.forEach((e) => expect(Math.abs(e.side as number)).toBeLessThanOrEqual(0.8 + 1e-9));
  });

  it('lighthouse coast: each light flashes its code at the ship, every flash a note, all together at the start', () => {
    for (const pattern of PATTERNS) {
      const r = run({ style: 'lighthouse', lighthouseScene: 'coast', pattern, count: 30 });
      const s = r.state;
      expect(r.durationS).toBeCloseTo(12, 1);
      expect(s.cycles.length).toBe(6);
      expect([...s.codes].sort()).toEqual([1, 1, 2, 2, 3, 3]);
      const hits = r.events.filter((e) => e.type === 'hit');
      s.cycles.forEach((turns, i) => {
        const mine = hits.filter((e) => e.i === i);
        const us = coastNoteU(turns, s.codes[i], 12);
        expect(mine).toHaveLength(turns * s.codes[i]);
        expect(s.notesPerLoop[i]).toBe(turns * s.codes[i]);
        expect(mine[0].t).toBe(0);
        // Each note at its flash (events land on the step that crosses it).
        mine.forEach((e, k) => expect(e.t).toBeCloseTo(12 * us[k], 1));
        // The flashes of a group are evenly spaced and well inside a turn.
        const gap = groupGapU(turns, s.codes[i], 12);
        for (let k = 1; k < s.codes[i]; k++) expect(us[k] - us[k - 1]).toBeCloseTo(gap, 9);
        expect(s.codes[i] * gap).toBeLessThan(1 / turns);
      });
    }
    expect(run({ style: 'lighthouse', lighthouseScene: 'coast', count: 5 }).state.cycles.length).toBe(3);
  });

  it('shapes big gear trains to the tall frame, using its width and height', () => {
    for (const pattern of PATTERNS)
      for (let seed = 1; seed <= 6; seed++) {
        const { arbors } = buildGearTrain(reachableRates(patternRates(pattern, 32, 10, 1, new Rng(seed))), new Rng(seed));
        const { w, h } = trainExtent(arbors);
        // Width : height within a quarter of the frame's 3.74 : 4.94 (most within a tenth), so neither side
        // is left mostly empty.
        const shape = w / h / (3.74 / 4.94);
        expect(shape).toBeGreaterThan(0.75);
        expect(shape).toBeLessThan(1 / 0.75);
      }
  });

  it('tells the sidebar which settings belong to which styles', () => {
    const props = paramsJsonSchema(polyrhythm as never).properties as Record<string, { showWhen?: { style: string[] } }>;
    expect(props.gearFlash.showWhen).toEqual({ style: ['gears'] });
    expect(props.gearLinks.showWhen).toEqual({ style: ['gears'] });
    expect(props.stringLife.showWhen).toEqual({ style: ['string-art'] });
    expect(props.figure.showWhen).toEqual({ style: ['fourier'] });
    // Settings every style uses carry no rule.
    for (const k of ['style', 'count', 'pattern', 'cycleStep', 'voice', 'pitchRange', 'soften']) expect(props[k].showWhen).toBeUndefined();
    // Every rule names real styles.
    for (const p of Object.values(props)) for (const st of p.showWhen?.style ?? []) expect(POLYRHYTHM_STYLES).toContain(st);
  });

  it('can play chord tones only', () => {
    expect(chordSteps('major', false)).toEqual([0, 2, 4]);
    expect(chordSteps('minor', true)).toEqual([0, 2, 4, 6]);
    // Pentatonic has no 7th: its chord stays a triad (root, major 3rd, 5th).
    expect(chordSteps('pentatonic', true)).toEqual([0, 2, 3]);
    // C major chord tones, climbing: C E G C E G.
    const names = pitchDegrees([0, 1, 2, 3, 4, 5], 'major', 3, 'chord').map((d) => noteName('major', 60, d));
    expect(names).toEqual(['C4', 'E4', 'G4', 'C5', 'E5', 'G5']);
    const r = run({ style: 'arcs', count: 20, scale: 'dorian', rootNote: 50, notes: 'chord7' });
    // D dorian's chord tones: D F A C.
    const classes = new Set(r.events.filter((e) => e.type === 'hit').map((e) => ((e.midi as number) - 50 + 120) % 12));
    expect([...classes].sort((a, b) => a - b)).toEqual([0, 3, 7, 10]);
  });

  it('softens high notes by the setting, leaving low ones alone', () => {
    const hits = (soften: number) => run({ style: 'arcs', count: 24, scale: 'major', rootNote: 55, pitchRange: 4, soften }).events.filter((e) => e.type === 'hit' && e.k === 0);
    const hard = hits(0);
    const soft = hits(1);
    const low = (es: typeof hard) => es.find((e) => (e.midi as number) < 64)!;
    const high = (es: typeof hard) => es.reduce((a, e) => ((e.midi as number) > (a.midi as number) ? e : a));
    expect(low(soft).vel).toBe(low(hard).vel);
    expect(low(soft).bright).toBeUndefined();
    expect(high(soft).vel as number).toBeLessThan(high(hard).vel as number);
    expect(high(soft).bright as number).toBeLessThan(1);
    expect(high(hard).bright).toBeUndefined();
  });

  it('uses the chosen instrument, or the theme\'s by default', () => {
    const voices = (params: Record<string, unknown>) => new Set(run({ style: 'arcs', count: 6, ...params }).audio.map((a) => (a.kind === 'note' ? a.voice : null)));
    expect(voices({})).toEqual(new Set([getTheme('neon-dark').voice]));
    expect(voices({ voice: 'kalimba' })).toEqual(new Set(['kalimba']));
  });
});
