import type { AudioEventInput, SimEvent, Template } from '@sim/engine';
import { lengthFit, markAt, runDirector, storyDirector, storyAudio, storyNarration, weighted, type Director } from '../story';
import { GRID } from './modes';
import { chladniSchema, type ChladniParams } from './params';
import { buildChladni, buildPatterns, lcg, scatterSand, toneAt, type PlateSim } from './script';
import { newVis, renderChladni, renderChladniTop, type ChladniVis } from './render';

export { chladniSchema, CHLADNI_MODES, type ChladniParams } from './params';

interface State {
  p: ChladniParams;
  sim: PlateSim;
  dir: Director<PlateSim>;
  vis: ChladniVis;
  visual: boolean;
  /** How hard the plate is shaking (builds up and dies down over a few ticks). */
  drive: number;
  t: number;
}

const DEFAULT_HOOK = 'What does sound look like?';
const DEFAULT_CTA = 'Sound, drawn in sand 🔊';
const COPY: Record<ChladniParams['mode'], { hook: string; cta: string }> = {
  'rising-pitch': { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  'guess-the-pattern': { hook: 'Which pattern will this note make?', cta: 'It was {answer}. How many did you get? 👇' },
  'plate-shapes': { hook: 'Same note. Different plate. Same pattern?', cta: 'Shape changes everything 🎻' },
};

/** One tick of sand: grains are pushed off the moving parts toward the still lines, and jostled where it shakes. */
function moveSand(s: State) {
  const { sim } = s;
  const tone = toneAt(sim.keys, sim.tick);
  s.drive += ((tone.on ? 1 : 0) - s.drive) * 0.08;
  if (s.drive < 0.01) return;
  // The plate's modes near the tone, weighted by how close to resonance it is.
  const near: { amp: Float32Array; gx: Float32Array; gy: Float32Array; w: number }[] = [];
  // Simple patterns have far to travel and gentle slopes: they get a harder shake to settle as fast.
  let boost = 1;
  sim.modes.forEach((m, i) => {
    const pat = sim.patterns[i];
    if (!pat || m.plate !== sim.plate) return;
    const off = (tone.hz - m.hz) / (0.03 * m.hz);
    const w = s.drive / (1 + off * off);
    if (w > 0.02) {
      near.push({ amp: pat.amp, gx: pat.gx, gy: pat.gy, w });
      // How many waves fit across the plate (λ ~ wavenumber²; a round plate's λ is per radius).
      const waves = Math.sqrt(m.lambda) * (m.plate === 'circle' ? 2 : 1);
      if (w > 0.5) boost = Math.max(1, Math.min(3.4, 12 / waves));
    }
  });
  if (!near.length) return;
  const N = GRID;
  // Grains hop where the plate moves (and less and less near a still line) and slide down the slope of |A|²:
  // together they settle on the lines within a couple of seconds.
  const K = 1.6e-4 * boost;
  const shake = 0.028 * boost;
  let r = sim.noise;
  const round = sim.plate === 'circle';
  for (let i = 0; i < sim.sx.length; i++) {
    let x = sim.sx[i];
    let y = sim.sy[i];
    const c = Math.min(N - 1, Math.floor(y * N)) * N + Math.min(N - 1, Math.floor(x * N));
    let f = 0;
    let gx = 0;
    let gy = 0;
    for (const m of near) {
      f += m.w * m.amp[c];
      gx += m.w * m.gx[c];
      gy += m.w * m.gy[c];
    }
    const a = Math.abs(f);
    r = lcg(r);
    const nx = r / 4294967296 - 0.5;
    r = lcg(r);
    const ny = r / 4294967296 - 0.5;
    x += -2 * f * gx * K + nx * shake * (a + 0.004);
    y += -2 * f * gy * K + ny * shake * (a + 0.004);
    if (round) {
      const dx = x - 0.5;
      const dy = y - 0.5;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.2475) {
        const k = 0.4975 / Math.sqrt(d2);
        x = 0.5 + dx * k;
        y = 0.5 + dy * k;
      }
    } else {
      x = Math.max(0.002, Math.min(0.998, x));
      y = Math.max(0.002, Math.min(0.998, y));
    }
    sim.sx[i] = x;
    sim.sy[i] = y;
  }
  sim.noise = r;
}

export const chladniPlates: Template<ChladniParams, State> = {
  id: 'chladni-plates',
  name: 'Chladni Plates',
  family: 'particles',
  category: 'brainy',
  description:
    'Narrated physics: sand on a metal plate shaken by a tone gathers on the lines that stay still, drawing a pattern for each note (Chladni figures, 1787). Modes: rising pitch (patterns get more complex as the note climbs), guess the pattern (lettered options, then the note plays), and the same note on a square vs a round plate. Physically accurate: the figures are a real free-edge plate’s vibration modes (solved for square and round plates), at the real frequencies of a plate of the chosen metal, size and thickness; a speaker under the centre drives only the figures in which the centre moves, and a violin bow on the edge (Chladni’s way) plays the rest. Steel, brass, aluminium or glass; sand, salt, gold dust or glowing powder. CTAs may use {answer}.',
  schema: chladniSchema,
  substeps: 1,
  maxSeconds: 120,
  searchBudget: 8,
  glowScale: (p) => (p.sand === 'neon' ? 0.6 : 0.25),
  ownMusic: true,
  lengthParam: { param: 'targetS', offsetS: 0 },
  defaultCopy: { hook: DEFAULT_HOOK, cta: DEFAULT_CTA },
  nudges: ['Guess the pattern 👇', 'Which one? 👇', 'Comment your guess 👇', 'Sound on 🔊'],
  nudgeY: 0.77,
  narration: storyNarration(
    'A warm, curious physics explainer talking to someone scrolling Shorts: clear and vivid, a little amazed by what sound can do, never condescending. Short sentences spoken over the moment they describe.',
  ),

  init(ctx) {
    const p = ctx.params;
    const { sim, script } = buildChladni(p, ctx.rng);
    const dir = storyDirector(script, ctx, 1);
    const s: State = { p, sim, dir, vis: newVis(), visual: ctx.visual, drive: 0, t: 0 };
    sim.grains = ctx.visual ? p.grains : 0;
    if (ctx.visual) {
      buildPatterns(sim);
      scatterSand(sim);
    }
    // One held tone per stretch of the script, gliding exactly as the sim does.
    dir.onSpan = (sim, emit, span) => {
      const a = toneAt(sim.keys, span.from);
      if (!a.on || span.seconds <= 0) return;
      const b = toneAt(sim.keys, span.to);
      // A speaker gives a pure tone; a bow a string-like one.
      emit({ type: 'chladni:tone', hz: a.hz, hzEnd: b.on ? b.hz : a.hz, dur: span.seconds + 0.03, wave: a.bow ? 'bowed' : 'sine' });
    };
    return s;
  },

  step(s, { t, emit }) {
    s.t = t;
    runDirector(s.dir, s.sim, emit, (sim, emit) => {
      sim.tick++;
      if (s.visual) moveSand(s);
      const now = toneAt(sim.keys, sim.tick);
      const was = toneAt(sim.keys, sim.tick - 1);
      if (now.on && !was.on) emit({ type: 'chladni:on', hz: now.hz });
    });
  },

  isDone: (s) => s.dir.done,

  hud: (s) => ({ answer: s.sim.answer, outro: s.t >= markAt(s.dir, 'outro') + 0.4 }),

  overlays(p, copy) {
    const own = COPY[p.mode];
    return [
      { kind: 'hook', text: copy.hook === DEFAULT_HOOK ? own.hook : copy.hook, from: 0, to: 3.2, y: 0.1 },
      { kind: 'cta', text: copy.cta === DEFAULT_CTA ? own.cta : copy.cta, when: 'outro', y: 0.1 },
    ];
  },

  render: ({ ctx, theme, t }, s) => renderChladni(ctx, theme, s, t),
  renderTop: ({ ctx, theme, t }, s) => renderChladniTop(ctx, theme, s, t),

  audio(e): AudioEventInput[] {
    const voice = storyAudio(e);
    if (voice) return voice;
    switch (e.type) {
      case 'chladni:tone':
        return [{ kind: 'tone', hz: e.hz as number, hzEnd: e.hzEnd as number, dur: e.dur as number, vel: 0.55, wave: (e.wave as 'sine') ?? 'sine' }];
      case 'chladni:scatter':
        return [
          { kind: 'sfx', name: 'knock', vel: 0.6 },
          { kind: 'sfx', name: 'sand', vel: 0.5 },
        ];
      default:
        return [];
    }
  },

  score(events, { durationS, targetS }) {
    const notes = events.filter((e) => e.type === 'chladni:on').length;
    return weighted({ length: [lengthFit(durationS, targetS), 2], notes: [Math.min(1, notes / 2), 1] });
  },

  outcome(events) {
    const n = new Set(events.filter((e) => e.type === 'chladni:tone').map((e) => Math.round(e.hz as number))).size;
    return n ? `${n} notes` : null;
  },
};
