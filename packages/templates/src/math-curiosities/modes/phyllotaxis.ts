import { lighten, paletteAt, rgbToCss, type Ctx2D, type Theme } from '@sim/engine';
import { scaleNote } from '../../music';
import { gaussFit } from '../../scoring';
import type { MathParams } from '../params';
import { OUTRO_DELAY_S, REVEAL_S, caption, clamp01, drawModeTitle, ev, evName, outlined, popIn, smooth, type ModeImpl } from '../shared';

/**
 * A sunflower: seed k sits at radius √k and angle k·α. Any simple fraction of a turn lines the seeds
 * up in straight spokes (p/q turn → q spokes); the closer α gets to the golden angle (1/φ² of a turn,
 * 137.5°) the finer the spokes, and at the golden angle they vanish into 21 and 34 interleaved
 * spirals, packing the disc evenly. The sweep between angles is arithmetic only.
 */

export const GOLDEN = (3 - Math.sqrt(5)) / 2;

interface Stop {
  /** Fraction of a turn. */
  a: number;
  label: string;
  /** Spokes for a fraction p/q (q), 0 for an irrational. */
  spokes: number;
}

interface Segment {
  t0: number;
  t1: number;
  a0: number;
  a1: number;
}

interface State {
  p: MathParams;
  stops: Stop[];
  segs: Segment[];
  seg: number;
  a: number;
  reached: number;
  reachedAt: number;
  lastDeg: number;
  lastTickT: number;
  growNext: number;
  revealAt: number;
  /** The two spiral families highlighted at the end (Fibonacci numbers). */
  families: [number, number];
  spiral: number;
  spiralAt: number;
  started: boolean;
  revealed: boolean;
  hue: number;
  t: number;
}

const M = 'phyllotaxis';
const DISC = { x: 540, y: 1010, r: 450 };
const GROW_S = 2.4;
/** Share of the seeds already planted on the first frame (it doubles as the thumbnail). */
const GROW_FIRST = 0.3;
const HOLD_S = 0.9;
const GROW_NOTES = 16;

const frac = (p: number, q: number): Stop => ({ a: p / q, label: `${p}/${q} turn`, spokes: q });
const STARTS: Stop[] = [frac(1, 2), frac(1, 4), frac(2, 7), frac(3, 10), frac(1, 3)];
const CONVERGENTS: Stop[] = [frac(2, 5), frac(3, 8), frac(5, 13), frac(8, 21), frac(13, 34)];
const DISTRACTORS: Stop[] = [
  { a: Math.SQRT2 - 1, label: '√2 − 1 turn', spokes: 0 },
  { a: 1 / Math.PI, label: '1/π turn', spokes: 0 },
];

export const phyllotaxisMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Which angle makes a perfect sunflower?', cta: 'The golden angle, {result} 🌻 Did you count the spirals?' }),
  searchBudget: 12,
  glowScale: 0.55,

  init({ params: p, rng }) {
    const maxStops = Math.max(4, Math.round(p.durationS / 4.5));
    const start = STARTS[rng.int(0, STARTS.length - 1)];
    const extras = p.durationS >= 32 ? [DISTRACTORS[rng.int(0, DISTRACTORS.length - 1)]] : [];
    const room = Math.max(1, maxStops - 2 - extras.length);
    const conv = CONVERGENTS.filter((c) => c.spokes !== start.spokes).slice(-room);
    // On long videos, a near miss just past the golden angle before it lands.
    const almost: Stop[] = p.durationS >= 45 ? [{ a: GOLDEN + 0.0012, label: 'so close…', spokes: 0 }] : [];
    const golden: Stop = { a: GOLDEN, label: 'the golden angle', spokes: 0 };
    const stops = [start, ...extras, ...conv, ...almost, golden];

    const revealAt = p.durationS - REVEAL_S;
    const first = GROW_S + HOLD_S;
    const sweepTotal = Math.max(1, revealAt - first - HOLD_S * (stops.length - 1));
    const segs: Segment[] = [{ t0: 0, t1: 0, a0: start.a, a1: start.a }];
    let at = first;
    for (let i = 1; i < stops.length; i++) {
      const d = sweepTotal / (stops.length - 1);
      segs.push({ t0: at, t1: at + d, a0: stops[i - 1].a, a1: stops[i].a });
      at += d + HOLD_S;
    }
    const families: [number, number] = p.seeds >= 700 ? [21, 34] : [13, 21];
    return {
      p, stops, segs, seg: 0, a: start.a, reached: -1, reachedAt: -9, lastDeg: Math.floor(start.a * 360), lastTickT: -9, growNext: 0,
      revealAt, families, spiral: -1, spiralAt: -9, started: false, revealed: false, hue: rng.next(), t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (!s.started) {
      s.started = true;
      emit({ type: ev(M, 'start'), seeds: s.p.seeds });
    }
    // Planting: a note per sixteenth of the seeds.
    while (s.growNext < GROW_NOTES && t >= (GROW_S * s.growNext) / GROW_NOTES) emit({ type: ev(M, 'grow'), i: s.growNext++ });

    while (s.seg + 1 < s.segs.length && s.segs[s.seg + 1].t0 <= t) s.seg++;
    const g = s.segs[s.seg];
    const u = g.t1 > g.t0 ? clamp01((t - g.t0) / (g.t1 - g.t0)) : 1;
    s.a = g.a0 + (g.a1 - g.a0) * smooth(u);
    if (u >= 1 && s.reached < s.seg && t >= GROW_S) {
      s.reached = s.seg;
      s.reachedAt = t;
      s.a = g.a1;
      const stop = s.stops[s.seg];
      emit({ type: ev(M, 'stop'), i: s.seg, spokes: stop.spokes, golden: s.seg === s.stops.length - 1 });
    } else if (u < 1) {
      const deg = Math.floor(s.a * 360);
      if (deg !== s.lastDeg && t - s.lastTickT >= 1 / 30 - 1e-9) {
        s.lastTickT = t;
        emit({ type: ev(M, 'tick'), deg });
      }
      s.lastDeg = deg;
    }
    if (!s.revealed && t >= s.revealAt) {
      s.revealed = true;
      emit({ type: ev(M, 'reveal') });
    }
    // In the reveal, light up one spiral family and then the other.
    const want: number = !s.revealed ? -1 : t >= s.revealAt + 2.1 ? 1 : t >= s.revealAt + 0.5 ? 0 : -1;
    if (want >= 0 && want > s.spiral) {
      s.spiral = want;
      s.spiralAt = t;
      emit({ type: ev(M, 'spirals'), i: want, count: s.families[want as 0 | 1] });
    }
  },

  isDone: (s) => s.t >= s.p.durationS,

  hud: (s) => ({ result: '137.5°', angle: Math.round(s.a * 3600) / 10, outro: s.revealed && s.t >= s.revealAt + OUTRO_DELAY_S }),

  render({ ctx, theme }, s) {
    const t = s.t;
    drawModeTitle(ctx, 'The sunflower angle');
    drawSeeds(ctx, theme, s);

    const holding = s.reached === s.seg;
    const stop = s.stops[s.seg];
    const pop = holding ? popIn((t - s.reachedAt) / 0.35) : 1;
    const deg = Math.round(s.a * 3600) / 10;
    outlined(ctx, theme, `${Number.isInteger(deg) ? deg : deg.toFixed(1)}°`, 540, 450, {
      size: s.revealed ? 130 : 112,
      fill: holding ? theme.accent : theme.text,
      scale: s.revealed ? popIn((t - s.revealAt) / 0.4) : pop,
    });
    if (s.revealed) {
      outlined(ctx, theme, 'The golden angle', 540, 548, { size: 46 });
      if (s.spiral >= 0) {
        const n = s.families[s.spiral];
        outlined(ctx, theme, `${n} spirals ${s.spiral ? '↺' : '↻'}`, 540, 1530, { size: 52, fill: theme.accent, scale: popIn((t - s.spiralAt) / 0.35) });
      }
    } else if (holding) {
      const text = stop.spokes ? `${stop.label}  →  ${stop.spokes} spokes` : stop.label;
      outlined(ctx, theme, text, 540, 548, { size: 42, alpha: clamp01((t - s.reachedAt) / 0.25), scale: pop });
    }
    if (!s.revealed) caption(ctx, 'each new seed turns by the same angle', 540, 1530, 30, 'rgba(255,255,255,0.5)');
  },

  audio(e) {
    switch (evName(e)) {
      case 'start':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.14 }];
      case 'grow':
        return [{ kind: 'note', midi: scaleNote('pentatonic', 60, e.i as number), vel: 0.26, voice: 'pluck', dur: 0.4 }];
      case 'tick':
        return [{ kind: 'note', midi: scaleNote('pentatonic', 76, (e.deg as number) % 7), vel: 0.1, voice: 'glass', dur: 0.25 }];
      case 'stop': {
        if (e.golden) return [{ kind: 'sfx', name: 'chime', vel: 0.34 }, ...[52, 59, 64, 68, 71].map((midi) => ({ kind: 'note' as const, midi, vel: 0.22, voice: 'bell' as const, dur: 2.4 }))];
        const d = (e.i as number) % 7;
        return [0, 2, 4].map((k) => ({ kind: 'note' as const, midi: scaleNote('major', 57, d + k), vel: 0.2, voice: 'glass' as const, dur: 1.4 }));
      }
      case 'spirals':
        return [{ kind: 'note', midi: e.i ? 76 : 71, vel: 0.24, voice: 'bell', dur: 1.2 }, { kind: 'sfx', name: 'whoosh', vel: 0.12 }];
      case 'reveal':
        return [40, 52, 59, 64].map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.2 + i * 0.02, voice: 'softsine' as const, dur: 3.4 }));
    }
    return [];
  },

  score(events, { durationS, targetS }) {
    const durFit = gaussFit(durationS, targetS, targetS * 0.3);
    const stops = events.filter((e) => e.type === ev(M, 'stop')).length;
    const variety = clamp01(stops / 7);
    return { total: 0.8 * durFit + 0.2 * variety, parts: { durFit, variety } };
  },
};

const BUCKETS = 12;

function drawSeeds(ctx: Ctx2D, theme: Theme, s: State) {
  const { x: cx, y: cy, r: R } = DISC;
  const n = s.p.seeds;
  const shown = Math.round(n * (GROW_FIRST + (1 - GROW_FIRST) * smooth(s.t / GROW_S)));
  const size = (R / Math.sqrt(n)) * 0.5;
  const turn = 2 * Math.PI * s.a;
  const family = s.spiral >= 0 ? s.families[s.spiral] : 0;
  const fam = family ? clamp01((s.t - s.spiralAt) / 0.4) : 0;
  const paths: Path2D[] = Array.from({ length: BUCKETS }, () => new Path2D());
  const lit = new Path2D();
  for (let k = 0; k < shown; k++) {
    const rr = R * Math.sqrt((k + 0.5) / n);
    const th = turn * k;
    const x = cx + rr * Math.cos(th);
    const y = cy + rr * Math.sin(th);
    const sz = size * (0.6 + 0.4 * Math.sqrt((k + 1) / n));
    if (family) {
      // One spiral of the family in every other colour: the arms stand out.
      const j = k % family;
      const b = Math.min(BUCKETS - 1, Math.floor((j / family) * BUCKETS));
      paths[b].moveTo(x + sz, y);
      paths[b].arc(x, y, sz, 0, Math.PI * 2);
      if (j % 2 === 0) {
        lit.moveTo(x + sz * 0.45, y);
        lit.arc(x, y, sz * 0.45, 0, Math.PI * 2);
      }
    } else {
      const b = Math.min(BUCKETS - 1, Math.floor(((k + 0.5) / n) * BUCKETS));
      paths[b].moveTo(x + sz, y);
      paths[b].arc(x, y, sz, 0, Math.PI * 2);
    }
  }
  paths.forEach((path, b) => {
    const base = paletteAt(theme.palette, (s.hue + b / BUCKETS) % 1);
    ctx.fillStyle = rgbToCss(family ? lighten(base, 0.1 * fam) : base, 0.92);
    ctx.fill(path);
  });
  if (family) {
    ctx.fillStyle = `rgba(255,255,255,${0.75 * fam})`;
    ctx.fill(lit);
  }
}
