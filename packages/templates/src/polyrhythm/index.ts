import { z } from 'zod';
import { lighten, paletteAt, rgbToCss, type DramaScore, type Template } from '@sim/engine';
import { gaussFit } from '../scoring';
import { SCALES, scaleNote, type ScaleName } from '../music';
import * as dm from '@sim/physics/math';

export const polyrhythmSchema = z.object({
  style: z.enum(['arcs', 'pendulum-wave']).default('arcs').meta({ title: 'Style' }),
  count: z.number().int().min(5).max(32).default(18).meta({ title: 'Dots / pendulums' }),
  loopSeconds: z.number().min(12).max(75).default(36).meta({ title: 'Loop length (s)' }),
  baseCycles: z.number().int().min(2).max(40).default(10).meta({ title: 'Cycles of slowest' }),
  cycleStep: z.number().int().min(1).max(3).default(1).meta({ title: 'Cycle step' }),
  scale: z.enum(['random', ...(Object.keys(SCALES) as ScaleName[])]).default('random').meta({ title: 'Scale' }),
  rootNote: z.number().int().min(36).max(72).default(55).meta({ title: 'Root note (MIDI)' }),
  hitVolume: z.number().min(0.1).max(1).default(0.45).meta({ title: 'Note volume', step: 0.05 }),
});

export type PolyrhythmParams = z.infer<typeof polyrhythmSchema>;

interface State {
  p: PolyrhythmParams;
  scale: ScaleName;
  /** Full back-and-forth cycles each element completes in one loop. Index 0 is the slowest. */
  cycles: number[];
  hits: number[];
  flash: number[];
  t: number;
  colorShift: number;
}

const CX = 540;
const BASE_Y = 1260;
const R_MIN = 70;
const R_MAX = 470;

/** 0 -> 1 -> 0 over one cycle. */
const tri = (phase: number) => {
  const f = phase - Math.floor(phase);
  return f < 0.5 ? 2 * f : 2 - 2 * f;
};

/** Smooth version (cosine) for pendulums: -1..1. */
function pendulumX(s: State, i: number, t: number) {
  return dm.cos((2 * Math.PI * s.cycles[i] * t) / s.p.loopSeconds);
}

export const polyrhythm: Template<PolyrhythmParams, State> = {
  id: 'polyrhythm',
  name: 'Polyrhythm Sync',
  family: 'kinetic',
  description:
    'Dots on concentric arcs (or a pendulum wave seen from above) each move at a slightly different whole-number rate. Every edge hit plays a note. They drift into patterns and all line up again exactly at the end, so the video loops seamlessly.',
  schema: polyrhythmSchema,
  substeps: 4,
  searchBudget: 12,
  ownMusic: true,
  seamlessLoop: true,
  defaultCopy: {
    hook: 'Wait for them to line up again…',
    cta: 'It loops perfectly. Watch again 🔁',
  },

  init({ params: p, rng }) {
    const scale = p.scale === 'random' ? rng.pick(Object.keys(SCALES) as ScaleName[]) : p.scale;
    const cycles = Array.from({ length: p.count }, (_, i) => p.baseCycles + i * p.cycleStep);
    return { p, scale, cycles, hits: cycles.map(() => -1), flash: cycles.map(() => 0), t: 0, colorShift: rng.range(0, 0.2) };
  },

  step(s, { dt, t, emit }) {
    const T = s.p.loopSeconds;
    const t1 = Math.min(T, t + dt);
    for (let i = 0; i < s.cycles.length; i++) {
      // Edge hits happen every half cycle: at k * T / (2 m).
      // hits starts at -1 so every element sounds at t=0 (the sync chord opens the video);
      // the hit at exactly t=T is the next loop's t=0, so it is not emitted.
      const k = Math.min(Math.floor((2 * s.cycles[i] * t1) / T + 1e-9), 2 * s.cycles[i] - 1);
      while (s.hits[i] < k) {
        s.hits[i]++;
        s.flash[i] = 1;
        // Slowest element = lowest note.
        emit({ type: 'hit', i, side: s.hits[i] % 2 ? 1 : -1, midi: scaleNote(s.scale, s.p.rootNote, i), vel: s.p.hitVolume });
      }
      s.flash[i] *= dm.exp(-6 * dt);
    }
    s.t = t + dt;
  },

  isDone(s) {
    return s.t >= s.p.loopSeconds - 1e-9;
  },

  hud(s) {
    const left = Math.max(0, s.p.loopSeconds - s.t);
    return { syncIn: `${left.toFixed(1)}s`, outro: false };
  },

  overlays(p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 3, y: 0.13 },
      { kind: 'counter', key: 'syncIn', label: 'NEXT SYNC IN', y: 0.24, size: 84 },
      { kind: 'cta', text: copy.cta, when: { from: p.loopSeconds - 3.2, to: p.loopSeconds + 1 }, y: 0.74 },
    ];
  },

  render({ ctx, theme, t }, s) {
    const n = s.cycles.length;
    const T = s.p.loopSeconds;
    const color = (i: number) => paletteAt(theme.palette, ((i / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    ctx.lineCap = 'round';

    if (s.p.style === 'arcs') {
      ctx.strokeStyle = rgbToCss(lighten(color(n - 1), 0.3), 0.8);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(CX - R_MAX - 40, BASE_Y);
      ctx.lineTo(CX + R_MAX + 40, BASE_Y);
      ctx.stroke();
      for (let k = 0; k < n; k++) {
        // Slowest on the outside.
        const i = k;
        const r = R_MAX - (k * (R_MAX - R_MIN)) / Math.max(1, n - 1);
        const col = color(i);
        const fl = s.flash[i];
        ctx.strokeStyle = rgbToCss(lighten(col, fl * 0.6), 0.35 + 0.65 * fl);
        ctx.lineWidth = 3 + fl * 4;
        ctx.beginPath();
        ctx.arc(CX, BASE_Y, r, Math.PI, 2 * Math.PI);
        ctx.stroke();
        // Endpoint impact glows.
        for (const side of [-1, 1]) {
          ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.25 + fl * 0.75);
          ctx.beginPath();
          ctx.arc(CX + side * r, BASE_Y, 6 + fl * 6, 0, Math.PI * 2);
          ctx.fill();
        }
        const a = Math.PI + Math.PI * tri((s.cycles[i] * t) / T);
        const x = CX + dm.cos(a) * r;
        const y = BASE_Y + dm.sin(a) * r;
        ctx.fillStyle = rgbToCss(lighten(col, 0.35));
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Pendulum wave seen from above: one bob per row, slowest at the top. Turnarounds ring.
      const y0 = 560;
      const y1 = 1330;
      const amp = 400;
      for (let i = 0; i < n; i++) {
        const y = y0 + (i * (y1 - y0)) / Math.max(1, n - 1);
        const col = color(i);
        const fl = s.flash[i];
        ctx.strokeStyle = rgbToCss(col, 0.18);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(CX - amp, y);
        ctx.lineTo(CX + amp, y);
        ctx.stroke();
        const side = s.hits[i] % 2 ? -1 : 1;
        ctx.fillStyle = rgbToCss(lighten(col, 0.5), 0.2 + fl * 0.8);
        ctx.beginPath();
        ctx.arc(CX + side * amp, y, 5 + fl * 8, 0, Math.PI * 2);
        ctx.fill();
        const x = CX + amp * pendulumX(s, i, t);
        ctx.fillStyle = rgbToCss(lighten(col, 0.3 + fl * 0.4));
        ctx.beginPath();
        ctx.arc(x, y, Math.min(20, ((y1 - y0) / n) * 0.42) + fl * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },

  audio(e, { theme }) {
    if (e.type !== 'hit') return [];
    return [{ kind: 'note', midi: e.midi as number, vel: e.vel as number, voice: theme.voice, pan: (e.side as number) * 0.35 }];
  },

  score(events, { durationS, targetS }): DramaScore {
    const hits = events.filter((e) => e.type === 'hit').length;
    const rate = hits / Math.max(1, durationS);
    const rateFit = rate < 4 ? rate / 4 : rate > 22 ? dm.exp(-(rate - 22) / 10) : 1;
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    return { total: durFit * (0.6 + 0.4 * rateFit), parts: { durFit, rateFit }, notes: [`${hits} notes (${rate.toFixed(1)}/s)`] };
  },
};

