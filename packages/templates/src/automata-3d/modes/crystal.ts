/**
 * Crystal growth: a small symmetric seed at the centre of an n³ cube grows under a 3D rule into a
 * gem, a snowflake or a coral. The whole run is simulated once up front (cheap), so the growth is
 * paced to land on the video's length and the camera knows how big it will get.
 */
import type { DramaScore } from '@sim/engine';
import { gaussFit } from '../../scoring';
import { THREE, sceneCache } from '../../three-layer';
import { CycleWatch, Grid3, type GenStats } from '../grid';
import { CRYSTAL_PRESETS, CRYSTAL_PRESET_IDS, describeRule3, parseRule3, type CrystalPresetId, type Rule3 } from '../rules';
import { symmetricSeed } from '../seeds';
import type { AutomataParams } from '../params';
import { Palette, Voxels, drawStage, fitDistance, makeStage, orbit, voxelMaterial } from '../view';
import { EXPLAIN_LIFT, clamp01, drawCounter, durationFit, drawExplainer, ev, evName, fmtInt, panOf, smooth, velOf, type ModeImpl } from '../shared';

const INTRO_S = 1.4;
const OUTRO_S = 4.5;
/** Most generations a run shows (and the fastest pace), so a rule that never settles still ends. */
const MAX_GENS = 220;
const MAX_RATE = 9;
/** Slowest pace: a run with few generations isn't stretched to fill the length, it ends early. */
const MIN_RATE = 2.5;

type EndKind = 'edge' | 'still' | 'cycle' | 'dead' | 'cap';

interface Plan {
  /** Generations shown. */
  gens: number;
  end: EndKind;
  /** Furthest live cell from the centre after each generation (index 0 = the seed). */
  radius: number[];
  alive: number[];
}

interface State {
  p: AutomataParams;
  preset: CrystalPresetId;
  rule: Rule3;
  n: number;
  symmetry: AutomataParams['symmetry'];
  grid: Grid3;
  /** The previous generation's states, for animating cells in and out (visual runs only). */
  prev: Uint8Array | null;
  plan: Plan;
  /** Largest radius so far, after each generation. */
  reach: number[];
  /** Sim time of each generation. */
  times: number[];
  growEnd: number;
  endT: number;
  ended: boolean;
  last: GenStats | null;
  t: number;
  visual: boolean;
}

function seedGrid(n: number, cells: [number, number, number][]): Grid3 {
  const g = new Grid3(n);
  for (const [x, y, z] of cells) g.set(x, y, z, 1);
  return g;
}

/** Run the rule to its end (the edge, a still life or cycle, nothing left, or the cap). */
function planRun(g: Grid3, rule: Rule3, cap: number): Plan {
  const radius = [initialRadius(g)];
  const alive = [countAlive(g)];
  const watch = new CycleWatch(4);
  for (let k = 1; k <= cap; k++) {
    const st = g.step(rule);
    // Growth clipped by the cube's walls looks wrong: stop the generation before it touches.
    if (st.atEdge) return { gens: k - 1, end: 'edge', radius, alive };
    radius.push(st.radius);
    alive.push(st.alive);
    if (g.empty) return { gens: k, end: 'dead', radius, alive };
    watch.push(g.hash());
    const period = watch.period();
    if (period) return { gens: Math.max(1, k - period * 2), end: period === 1 ? 'still' : 'cycle', radius, alive };
  }
  return { gens: cap, end: 'cap', radius, alive };
}

function countAlive(g: Grid3) {
  let a = 0;
  for (const v of g.state) if (v === 1) a++;
  return a;
}

function initialRadius(g: Grid3) {
  const c = (g.n - 1) / 2;
  let r2 = 0;
  for (let z = 0; z < g.n; z++) for (let y = 0; y < g.n; y++) for (let x = 0; x < g.n; x++) if (g.get(x, y, z) === 1) r2 = Math.max(r2, (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2);
  return Math.sqrt(r2);
}

const SYMMETRY_LABEL = { none: 'no symmetry', mirror: '8-fold', cubic: '48-fold' } as const;

export const crystalMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Guess what this grows into 👀', cta: '{result} What did you see?' }),
  searchBudget: 160,

  init({ params: p, rng, visual }) {
    const preset = p.preset === 'random' ? rng.pick(CRYSTAL_PRESET_IDS) : p.preset;
    const rule = parseRule3(CRYSTAL_PRESETS[preset].rule);
    const n = p.size - (p.size % 2);
    const def = CRYSTAL_PRESETS[preset];
    const cells = symmetricSeed(n, rng, { size: def.seedSize, density: def.density, symmetry: p.symmetry, ball: def.seed === 'ball' });
    const growS = p.durationS - INTRO_S - OUTRO_S;
    // The same seed twice: once to plan the run, once to play it.
    const plan = planRun(seedGrid(n, cells), rule, Math.min(MAX_GENS, Math.floor(MAX_RATE * growS)));
    const grid = seedGrid(n, cells);
    const span = Math.min(growS, plan.gens / MIN_RATE);
    const times = Array.from({ length: plan.gens + 1 }, (_, g) => INTRO_S + (plan.gens ? (g / plan.gens) * span : 0));
    const growEnd = INTRO_S + span;
    return {
      p,
      preset,
      rule,
      n,
      symmetry: p.symmetry,
      grid,
      prev: visual ? grid.state.slice() : null,
      plan,
      reach: plan.radius.map((_, g) => Math.max(...plan.radius.slice(0, g + 1))),
      times,
      growEnd,
      endT: growEnd + OUTRO_S,
      ended: false,
      last: null,
      t: 0,
      visual,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { grid, plan } = s;
    while (grid.gen < plan.gens && s.t >= s.times[grid.gen + 1]) {
      if (s.prev) s.prev.set(grid.state);
      const st = grid.step(s.rule);
      s.last = st;
      const half = s.n / 2;
      emit({ type: ev('crystal', 'gen'), gen: grid.gen, births: st.births, deaths: st.deaths, alive: st.alive, radius: st.radius / half, x: st.bx / half });
      // A chime each time the crystal grows past another quarter of the way to the walls.
      const before = Math.floor((plan.radius[grid.gen - 1] / half) * 4);
      const after = Math.floor((st.radius / half) * 4);
      if (after > before && after < 4) emit({ type: ev('crystal', 'ring'), ring: after });
    }
    if (!s.ended && s.t >= s.growEnd) {
      s.ended = true;
      const r = plan.radius[plan.gens] ?? 0;
      // How much of its bounding ball the crystal fills: lacy (low) or a solid lump (high).
      const fill = r > 0 ? (s.last?.alive ?? 0) / ((4 / 3) * Math.PI * r ** 3) : 1;
      emit({ type: ev('crystal', 'end'), gen: grid.gen, kind: plan.end, alive: s.last?.alive ?? 0, radius: r / (s.n / 2), fill, preset: s.preset });
    }
  },

  isDone: (s) => s.t >= s.endT,

  hud(s) {
    return { gen: s.grid.gen, cells: s.last?.alive ?? 0, result: s.ended ? resultLine(s) : '', outro: s.ended };
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    const { grid } = s;
    const prev = s.prev ?? grid.state;
    const genT = s.times[grid.gen] ?? 0;
    const nextT = s.times[grid.gen + 1] ?? genT + 1;
    // How far into the current generation's transition we are: cells grow in / shrink away over it.
    const u = grid.gen === 0 ? 1 : smooth(clamp01((s.t - genT) / Math.max(0.12, Math.min(0.6, (nextT - genT) * 0.9))));
    const { n, p: P } = { n: grid.n, p: grid.p };
    const c = (n - 1) / 2;
    const states = s.rule.states;
    const gens = Math.max(1, s.plan.gens);
    const col = v.rgb;
    const gf = Math.min(gens, grid.gen + u);
    const invR = 1 / Math.max(3, sizeAt(s, gf));
    v.voxels.begin();
    if (!grid.empty || s.prev) {
      // Union of this generation's box and the last one's (cells that just died still shrink away).
      const lo = [0, 0, 0];
      const hi = [n - 1, n - 1, n - 1];
      if (!grid.empty) for (let a = 0; a < 3; a++) [lo[a], hi[a]] = [Math.max(0, grid.lo[a] - 1), Math.min(n - 1, grid.hi[a] + 1)];
      const st = grid.state;
      const offs = [1, -1, P, -P, P * P, -P * P];
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++) {
          let i = grid.idx(lo[0], y, z);
          for (let x = lo[0]; x <= hi[0]; x++, i++) {
            const cur = st[i];
            const was = prev[i];
            if (!cur && !was) continue;
            if (cur && was) {
              // Buried: every face neighbour is filled now and was before.
              let buried = true;
              for (const o of offs)
                if (!st[i + o] || !prev[i + o]) {
                  buried = false;
                  break;
                }
              if (buried) continue;
            }
            let scale = 1;
            let glow = 0;
            let k = 1;
            if (cur === 1 && was !== 1) {
              scale = u;
              glow = 0.18 * (1 - u) * (1 - u);
            } else if (!cur) scale = 1 - u;
            const st0 = cur || was;
            if (st0 > 1) {
              // Decaying: shrinks and darkens through its states.
              const d = (st0 - 1) / (states - 1);
              scale *= 1 - 0.35 * d;
              k = 1 - 0.65 * d;
            }
            if (scale <= 0.02) continue;
            // Coloured by distance from the centre against the crystal's current size (spikes and
            // valleys differ), drifting with age so the core keeps its own colour.
            const d = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) * invR;
            v.palette.write(col, 0, 0.85 * clamp01((d - 0.35) / 0.65) + 0.15 * (grid.born[i] / gens), k);
            v.voxels.push(x - c, y - c, z - c, scale, col[0], col[1], col[2], glow);
          }
        }
    }
    v.voxels.end();

    // Camera: frames the size the crystal is about to reach, orbiting slowly.
    const r = Math.max(4, sizeAt(s, gf + 2));
    const dist = fitDistance(v.stage.camera, r, 0.86);
    const az = 0.6 + s.t * 0.28;
    const el = 0.42 + 0.08 * Math.sin(s.t * 0.4);
    orbit(v.stage, new THREE.Vector3(0, 0, 0), az, el, dist);
    // The whole crystal pulses once at the end.
    v.root.scale.setScalar(1 + (s.ended ? 0.03 * Math.exp(-(s.t - s.growEnd) * 3) * Math.sin((s.t - s.growEnd) * 18) : 0));
    drawStage(ctx, v.stage);
  },

  renderTop({ ctx, theme }, s) {
    const def = CRYSTAL_PRESETS[s.preset];
    const since = s.last ? s.t - s.times[s.grid.gen] : 1;
    const top = s.p.explain ? drawExplainer(ctx, crystalMode.explain(s), s.t) : null;
    drawCounter(ctx, theme, {
      t: s.t,
      title: `${def.label} · ${SYMMETRY_LABEL[s.symmetry]}`,
      gen: s.grid.gen,
      line: `${fmtInt(s.last?.alive ?? s.plan.alive[0] ?? 0)} cells`,
      flash: s.ended ? Math.exp(-(s.t - s.growEnd) * 4) : Math.exp(-since * 10) * 0.3,
      endAt: s.ended ? s.growEnd : undefined,
      y: top === null ? undefined : top - 130,
    });
  },

  explain(s) {
    const seed = { none: 'a handful of random cells', mirror: 'a handful of cells mirrored 8 ways', cubic: 'a handful of cells copied 48 ways (every mirror and turn of a cube)' }[s.symmetry];
    return `${describeRule3(s.rule)} It grew from ${seed}.`;
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = panOf(e.x);
    switch (evName(e)) {
      case 'gen': {
        const births = e.births as number;
        if (!births) return (e.deaths as number) ? [{ kind: 'sfx', name: 'tick', vel: 0.12, pitch: 0.6 }] : [];
        if (e.t - lastNoteT < 0.09) return [{ kind: 'sfx', name: 'clink', vel: 0.12, pitch: 0.5 + 0.4 * (e.radius as number), pan }];
        const vel = velOf(births);
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.5 : vel, voice: theme.voice, pan }));
      }
      case 'ring':
        return [{ kind: 'sfx', name: 'chime', vel: 0.35, pitch: 0.5 + 0.2 * (e.ring as number) }];
      case 'end':
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.4 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.6, voice: 'bell' as const, dur: 2.6 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.35, voice: 'bell' as const, dur: 2.6 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const end = events.find((e) => evName(e) === 'end');
    const gens = events.filter((e) => evName(e) === 'gen');
    const durFit = durationFit(durationS, targetS);
    if (!end || !gens.length) return { total: 0.01, parts: { durFit }, notes: ['nothing grew'] };
    if (end.kind === 'dead') return { total: 0.03 * durFit, parts: { durFit }, notes: ['died out'] };
    // Grew to fill the frame (not a speck), with a full run of generations to watch.
    const growth = clamp01(((end.radius as number) - 0.15) / 0.6);
    const lengthFit = clamp01(gens.length / 45);
    // Intricate beats solid: a lattice, not a lump.
    const lacy = gaussFit(end.fill as number, 0.22, 0.2);
    // Something new happening throughout: few generations with no births at all.
    const busy = gens.filter((e) => (e.births as number) > 0).length / gens.length;
    // Changing shape: births and deaths both, not just a solid blob filling in.
    const churn = clamp01(gens.reduce((a, e) => a + Math.min(e.births as number, e.deaths as number), 0) / Math.max(1, gens.reduce((a, e) => a + (e.births as number), 0)) / 0.6);
    const endFit = end.kind === 'edge' ? 1 : end.kind === 'cap' ? 0.8 : 0.6;
    const total = durFit * (0.1 + 0.2 * growth + 0.15 * lengthFit + 0.1 * busy + 0.15 * churn + 0.1 * endFit + 0.2 * lacy);
    return { total, parts: { durFit, growth, lengthFit, busy, churn, endFit, lacy }, notes: [`${end.preset}`, `${gens.length} generations`, `${end.kind}`, `fill ${((end.fill as number) * 100).toFixed(0)}%`] };
  },

  outcome(events) {
    const end = events.find((e) => evName(e) === 'end');
    return end ? `${end.preset}: ${end.kind}` : null;
  },
};

function resultLine(s: State): string {
  const { plan } = s;
  const g = fmtInt(plan.gens);
  switch (plan.end) {
    case 'dead':
      return `Gone after ${g} generations.`;
    case 'still':
      return `Frozen solid at ${g}.`;
    case 'cycle':
      return `Pulsing forever from ${g}.`;
    default:
      return `${g} generations.`;
  }
}

/** The crystal's radius (cells) at a fractional generation, never shrinking (so the camera only pulls back). */
function sizeAt(s: State, gf: number): number {
  const r = s.reach;
  const g = Math.max(0, Math.min(r.length - 1, gf));
  const i = Math.min(r.length - 2, Math.floor(g));
  return i < 0 ? r[0] : r[i] + (r[i + 1] - r[i]) * (g - i);
}

const view = sceneCache((s: State, theme) => {
  const stage = makeStage(theme, s.p.look);
  stage.lift = s.p.explain ? EXPLAIN_LIFT : 0;
  const root = new THREE.Group();
  stage.scene.add(root);
  const voxels = new Voxels(root, voxelMaterial(s.p.look), s.p.look, 16384);
  return { scene: stage.scene, stage, root, voxels, palette: new Palette(theme.palette), rgb: new Float32Array(3) };
});
