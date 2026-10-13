import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type DramaScore, type Rng, type Template } from '@sim/engine';
import { gaussFit } from '../scoring';
import { ALGORITHMS, CMP, SET, SWAP, recordSort, type AlgorithmId } from './algorithms';
import * as dm from '@sim/physics/math';

const LINEUPS: Record<string, AlgorithmId[]> = {
  'quick-merge-heap': ['quick', 'merge', 'heap'],
  'bubble-insertion-selection': ['bubble', 'insertion', 'selection'],
  'quick-bubble': ['quick', 'bubble'],
  'merge-shell-radix': ['merge', 'shell', 'radix'],
  'cocktail-gnome-comb': ['cocktail', 'gnome', 'comb'],
  'quick-merge-heap-shell': ['quick', 'merge', 'heap', 'shell'],
};

export const sortingRaceSchema = z.object({
  lineup: z.enum(['random', ...Object.keys(LINEUPS)] as [string, ...string[]]).default('random').meta({ title: 'Lineup' }),
  bars: z.number().int().min(12).max(128).default(48).meta({ title: 'Bars' }),
  durationS: z.number().min(12).max(60).default(30).meta({ title: 'Time for the slowest (s)' }),
  data: z.enum(['shuffled', 'reversed', 'nearly-sorted', 'few-unique']).default('shuffled').meta({ title: 'Input data' }),
  notesPerSecond: z.number().min(5).max(60).default(26).meta({ title: 'Max notes/s per panel' }),
});

export type SortingRaceParams = z.infer<typeof sortingRaceSchema>;

interface Panel {
  algo: AlgorithmId;
  ops: Int32Array;
  arr: number[];
  pos: number;
  cmps: number;
  writes: number;
  hiA: number;
  hiB: number;
  hiKind: number;
  finishedAt: number;
  place: number;
  lastNoteT: number;
}

interface State {
  p: SortingRaceParams;
  panels: Panel[];
  opsPerSec: number;
  t: number;
  places: number;
  endAt: number | null;
}

const SWEEP_S = 0.7;
const OUTRO_S = 2.2;
const TOP = 1920 * 0.2;
const BOTTOM = 1920 * 0.79;

function makeData(p: SortingRaceParams, rng: Rng): number[] {
  const n = p.bars;
  let a = Array.from({ length: n }, (_, i) => i + 1);
  if (p.data === 'few-unique') a = a.map((v) => Math.ceil((v / n) * 5) * Math.ceil(n / 5));
  if (p.data === 'reversed') return a.reverse();
  if (p.data === 'nearly-sorted') {
    for (let k = 0; k < Math.max(2, n / 8); k++) {
      const i = rng.int(0, n - 2);
      [a[i], a[i + 1]] = [a[i + 1], a[i]];
    }
    return a;
  }
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ordinal = (n: number) => ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`;

export const sortingRace: Template<SortingRaceParams, State> = {
  id: 'sorting-race',
  name: 'Sorting Race',
  family: 'kinetic',
  description:
    'Two to four sorting algorithms sort the same shuffled bars side by side at the same speed. Every comparison plays a tone pitched by the bar’s height. First to finish wins.',
  schema: sortingRaceSchema,
  lengthParam: { param: 'durationS', offsetS: 2.2 },
  substeps: 1,
  searchBudget: 60,
  ownMusic: true,
  defaultCopy: {
    hook: 'Which sorting algorithm finishes first?',
    cta: '{winner} sort wins! Did you guess it?',
  },

  init({ params: p, rng }) {
    const lineup = p.lineup === 'random' ? LINEUPS[rng.pick(Object.keys(LINEUPS))] : LINEUPS[p.lineup];
    const data = makeData(p, rng);
    const panels: Panel[] = lineup.map((algo) => ({
      algo,
      ops: recordSort(algo, data),
      arr: data.slice(),
      pos: 0,
      cmps: 0,
      writes: 0,
      hiA: -1,
      hiB: -1,
      hiKind: -1,
      finishedAt: -1,
      place: 0,
      lastNoteT: -1,
    }));
    const maxOps = Math.max(...panels.map((pp) => pp.ops.length / 3));
    return { p, panels, opsPerSec: maxOps / p.durationS, t: 0, places: 0, endAt: null };
  },

  step(s, { dt, t, emit }) {
    const target = Math.floor((t + dt) * s.opsPerSec);
    const n = s.p.bars;
    s.panels.forEach((pn, k) => {
      const total = pn.ops.length / 3;
      while (pn.pos < Math.min(target, total)) {
        const o = pn.pos * 3;
        const kind = pn.ops[o];
        const a = pn.ops[o + 1];
        const b = pn.ops[o + 2];
        if (kind === CMP) pn.cmps++;
        else if (kind === SWAP) {
          [pn.arr[a], pn.arr[b]] = [pn.arr[b], pn.arr[a]];
          pn.writes++;
        } else if (kind === SET) {
          pn.arr[a] = b;
          pn.writes++;
        }
        pn.hiA = a;
        pn.hiB = kind === SET ? a : b;
        pn.hiKind = kind;
        pn.pos++;
        if (t - pn.lastNoteT >= 1 / s.p.notesPerSecond) {
          pn.lastNoteT = t;
          emit({ type: 'tone', panel: k, value: pn.arr[a] / n, kind });
        }
      }
      if (pn.pos >= total && pn.finishedAt < 0) {
        pn.finishedAt = t;
        pn.place = ++s.places;
        pn.hiA = pn.hiB = -1;
        emit({ type: 'finish', panel: k, place: pn.place, algo: pn.algo });
        if (s.places === s.panels.length) s.endAt = t;
      }
    });
    s.t = t + dt;
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const win = s.panels.find((pn) => pn.place === 1);
    return { winner: win ? ALGORITHMS[win.algo].name : '', outro: s.endAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme }, s) {
    const n = s.p.bars;
    const panelH = (BOTTOM - TOP) / s.panels.length;
    const x0 = 60;
    const x1 = 1020;
    const bw = (x1 - x0) / n;
    s.panels.forEach((pn, k) => {
      const top = TOP + k * panelH;
      const base = top + panelH - 18;
      const maxH = panelH - 90;
      const sweep = pn.finishedAt >= 0 ? Math.min(1, (s.t - pn.finishedAt) / SWEEP_S) : 0;

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `900 40px ${FONT_FAMILY}`;
      ctx.fillStyle = theme.text;
      ctx.fillText(`${ALGORITHMS[pn.algo].name} sort`, x0, top + 30);
      ctx.textAlign = 'right';
      ctx.font = `900 28px ${FONT_FAMILY}`;
      ctx.fillStyle = pn.place ? theme.accent : 'rgba(255,255,255,0.6)';
      const label = pn.place ? `${pn.place === 1 ? '🏆 ' : ''}${ordinal(pn.place)} · ${pn.finishedAt.toFixed(1)}s` : `${pn.cmps} comparisons · ${pn.writes} writes`;
      ctx.fillText(label, x1, top + 32);

      for (let i = 0; i < n; i++) {
        const v = pn.arr[i] / n;
        const h = Math.max(4, v * maxH);
        let col = paletteAt(theme.palette, v);
        if (i < sweep * n) col = lighten(col, 0.25);
        if (i === pn.hiA || i === pn.hiB) col = pn.hiKind === CMP ? [255, 255, 255] : lighten(col, 0.8);
        ctx.fillStyle = rgbToCss(col);
        ctx.fillRect(x0 + i * bw + 1, base - h, Math.max(1, bw - 2), h);
      }
    });
  },

  audio(e) {
    switch (e.type) {
      case 'tone': {
        const pan = [-0.45, 0.45, 0, -0.2][e.panel as number] ?? 0;
        return [{ kind: 'note', midi: 50 + (e.value as number) * 36, vel: 0.28, voice: 'softsine', dur: 0.22, pan }];
      }
      case 'finish': {
        const place = e.place as number;
        const notes = place === 1 ? [72, 76, 79, 84] : [67, 72];
        // The bell stays in C major with the fanfare (lower for later places).
        return [
          { kind: 'note', midi: [84, 79, 76, 72][place - 1] ?? 72, vel: place === 1 ? 0.6 : 0.36, voice: 'bell', dur: 1.2 },
          ...notes.map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.35, voice: 'bell' as const, dur: 1.5 + i * 0.1 })),
        ];
      }
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const finishes = events.filter((e) => e.type === 'finish').map((e) => e.t);
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    const gap = finishes.length > 1 ? finishes[1] - finishes[0] : durationS;
    const closeFit = dm.exp(-gap / (0.15 * durationS));
    return { total: durFit * (0.5 + 0.5 * closeFit), parts: { durFit, closeFit }, notes: [`winner margin ${gap.toFixed(1)}s`] };
  },
};
