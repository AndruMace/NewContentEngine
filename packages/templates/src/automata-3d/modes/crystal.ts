/**
 * Crystal growth: a small symmetric seed grows under a 3D rule into a gem, a snowflake or a coral,
 * with no walls: it grows until it dies, settles, reaches the generation count, or gets too big to go
 * on (a memory budget).
 *
 * The run is simulated once up front, recording each generation's numbers: that's all the events
 * (and so headless runs and seed search) need, and it paces the growth to the video's length and
 * tells the camera how big it will get. The picture replays its own copy as it plays.
 */
import type { DramaScore } from '@sim/engine';
import { gaussFit } from '../../scoring';
import { THREE, sceneCache } from '../../three-layer';
import { CycleWatch, Grid3, IntList } from '../grid';
import { CRYSTAL_PRESETS, CRYSTAL_PRESET_IDS, describeRule3, parseRule3, type CrystalPresetId, type Rule3 } from '../rules';
import { symmetricSeed } from '../seeds';
import type { AutomataParams } from '../params';
import { Dots, Palette, Voxels, detailFor, drawStage, fitDistance, makeStage, orbit, voxelMaterial } from '../view';
import { CAPTION_GAP, EXPLAIN_LIFT, budgetFor, clamp01, drawCaption, placeCaptions, type Caption, drawCounter, durationFit, manualCap, drawExplainer, ev, evName, fmtInt, genSchedule, panOf, smooth, velOf, type ModeImpl } from '../shared';

const INTRO_S = 1.4;
const OUTRO_S = 4.5;
/** Seeds are made in a box this big and centred on the origin. */
const SEED_BOX = 64;
/** Most generations a run shows when the count isn't set by hand, and the fastest pace for it. */
const AUTO_GENS = 400;
const MAX_RATE = 20;
/** Generations per second at the start (later ones speed up to fit). */
const START_RATE = 3;
/** Slowest pace: a run with few generations isn't stretched to fill the length, it ends early. */
const MIN_RATE = 2.5;
/**
 * Past this radius (cells) a cell is a few pixels across: the crystal is drawn as dots from then on,
 * and cells no longer animate in and out one by one.
 */
const DOT_REACH = 90;
/** Or once this many cubes are showing. */
const MAX_CUBES = 200_000;
/** Most cells a run may make room for (about 6 bytes each, twice over in the preview). */
export const CELL_BUDGET = 16_000_000;
/**
 * Most cell changes an automatic run may take (about 3 s): rules that churn their whole volume get
 * costly fast as they grow (work ~ radius⁴). A generation count set by hand isn't held to it.
 */
const WORK_BUDGET = 30_000_000;

type EndKind = 'still' | 'cycle' | 'dead' | 'cap';

interface Plan {
  /** Generations shown. */
  gens: number;
  end: EndKind;
  /** Per generation (index 0 = the seed). */
  radius: number[];
  alive: number[];
  births: number[];
  deaths: number[];
  /** Mean x of the births (cells from the centre), for panning. */
  bx: number[];
}

interface State {
  p: AutomataParams;
  preset: CrystalPresetId;
  rule: Rule3;
  symmetry: AutomataParams['symmetry'];
  /** The seed's cells (world coordinates): the picture replays from these. */
  cells: [number, number, number][];
  plan: Plan;
  /** Largest radius so far, after each generation, and at the end. */
  reach: number[];
  finalReach: number;
  /** Current generation. */
  gen: number;
  captionList: Caption[];
  /** Sim time of each generation. */
  times: number[];
  growEnd: number;
  endT: number;
  ended: boolean;
  t: number;
}

function seedGrid(rule: Rule3, cells: [number, number, number][]): Grid3 {
  const g = new Grid3(rule.nb);
  for (const [x, y, z] of cells) g.set(x, y, z, 1);
  return g;
}

/** Run the rule to its end (a still life or cycle, nothing left, the generation cap, or the memory or work budget). */
function planRun(g: Grid3, rule: Rule3, cap: number, workBudget: number): Plan {
  const plan: Plan = { gens: 0, end: 'cap', radius: [g.radius], alive: [g.alive], births: [0], deaths: [0], bx: [0] };
  const done = (gens: number, end: EndKind) => Object.assign(plan, { gens, end });
  const watch = new CycleWatch(4);
  let work = 0;
  for (let k = 1; k <= cap; k++) {
    const st = g.step(rule);
    work += g.changed.n;
    plan.radius.push(st.radius);
    plan.alive.push(st.alive);
    plan.births.push(st.births);
    plan.deaths.push(st.deaths);
    plan.bx.push(st.bx);
    if (g.empty) return done(k, 'dead');
    watch.push(g.hash());
    const period = watch.period();
    if (period) return done(Math.max(1, k - period * 2), period === 1 ? 'still' : 'cycle');
    if (g.capacity > CELL_BUDGET || work > workBudget) return done(k, 'cap');
  }
  return done(cap, 'cap');
}

const SYMMETRY_LABEL = { none: 'no symmetry', mirror: '8-fold', cubic: '48-fold' } as const;

export const crystalMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Guess what this grows into 👀', cta: '{result} What did you see?' }),
  // Automatic runs take up to about 3 s each.
  searchBudget: (p) => (p.generations ? budgetFor(12, p.generations, 100, 2, 3) : 12),

  init({ params: p, rng }) {
    const preset = p.preset === 'random' ? rng.pick(CRYSTAL_PRESET_IDS) : p.preset;
    const def = CRYSTAL_PRESETS[preset];
    const rule = parseRule3(def.rule);
    const cells = symmetricSeed(SEED_BOX, rng, { size: def.seedSize, density: def.density, symmetry: p.symmetry, ball: def.seed === 'ball' }).map(
      ([x, y, z]) => [x - SEED_BOX / 2, y - SEED_BOX / 2, z - SEED_BOX / 2] as [number, number, number],
    );
    const growS = p.durationS - INTRO_S - OUTRO_S;
    // Generations and pace can be set by hand; otherwise the run is fitted to the length.
    const rate = p.genRate;
    let cap = p.generations || (rate ? AUTO_GENS : Math.min(AUTO_GENS, Math.floor(MAX_RATE * growS)));
    if (rate) cap = Math.min(cap, manualCap(rate, INTRO_S + OUTRO_S));
    const plan = planRun(seedGrid(rule, cells), rule, cap, p.generations ? Infinity : WORK_BUDGET);
    const span = rate ? plan.gens / rate : Math.min(growS, plan.gens / MIN_RATE);
    const schedule = rate ? (g: number) => g / rate : genSchedule(plan.gens, span, START_RATE);
    const times = Array.from({ length: plan.gens + 1 }, (_, g) => INTRO_S + schedule(g));
    const growEnd = INTRO_S + span;
    let most = 0;
    const reach = plan.radius.map((r) => (most = Math.max(most, r)));
    const s: State = {
      p,
      preset,
      rule,
      symmetry: p.symmetry,
      cells,
      plan,
      reach,
      finalReach: Math.max(3, reach[plan.gens] ?? most),
      gen: 0,
      times,
      growEnd,
      endT: growEnd + OUTRO_S,
      ended: false,
      t: 0,
      captionList: [],
    };
    s.captionList = crystalCaptions(s);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { plan } = s;
    while (s.gen < plan.gens && s.t >= s.times[s.gen + 1]) {
      const g = ++s.gen;
      const size = s.finalReach;
      emit({ type: ev('crystal', 'gen'), gen: g, births: plan.births[g], deaths: plan.deaths[g], alive: plan.alive[g], radius: plan.radius[g] / size, x: plan.bx[g] / size });
      // A chime each time the crystal grows past another quarter of its final size.
      const before = Math.floor((s.reach[g - 1] / size) * 4);
      const after = Math.floor((s.reach[g] / size) * 4);
      if (after > before && after < 4) emit({ type: ev('crystal', 'ring'), ring: after });
    }
    if (!s.ended && s.t >= s.growEnd) {
      s.ended = true;
      const r = plan.radius[plan.gens] ?? 0;
      const alive = plan.alive[plan.gens] ?? 0;
      // How much of its bounding ball the crystal fills: lacy (low) or a solid lump (high).
      const fill = r > 0 ? alive / ((4 / 3) * Math.PI * r ** 3) : 1;
      emit({ type: ev('crystal', 'end'), gen: plan.gens, kind: plan.end, alive, radius: r, fill, preset: s.preset });
    }
  },

  isDone: (s) => s.t >= s.endT,

  hud(s) {
    return { gen: s.gen, cells: s.plan.alive[s.gen], result: s.ended ? resultLine(s) : '', outro: s.ended };
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    const { grid } = v;
    // Replay up to now (the log of changed cells keeps the visible-cube list current).
    while (grid.gen < s.gen) grid.step(s.rule);
    const genT = s.times[grid.gen] ?? 0;
    const nextT = s.times[grid.gen + 1] ?? genT + 1;
    // How far into the current generation's transition we are: cells grow in / shrink away over it.
    const u = grid.gen === 0 ? 1 : smooth(clamp01((s.t - genT) / Math.max(0.12, Math.min(0.6, (nextT - genT) * 0.9))));

    // Camera: frames the size the crystal is about to reach, orbiting slowly.
    const gf = Math.min(s.plan.gens, grid.gen + u);
    const r = Math.max(4, sizeAt(s, gf + 2));
    const dist = fitDistance(v.stage.camera, r, 0.86);
    const az = 0.6 + s.t * 0.28;
    const el = 0.42 + 0.08 * Math.sin(s.t * 0.4);
    orbit(v.stage, new THREE.Vector3(0, 0, 0), az, el, dist);

    // Grown past cube size (or too many cubes to draw smoothly): switch to dots for good.
    if (!v.dots && (sizeAt(s, grid.gen) > DOT_REACH || v.list.n > MAX_CUBES)) toDots(v, s);
    syncExposed(v, s);
    if (v.dots) {
      // The key light's direction in view space, for the dots' shading.
      const light = v.stage.key.position.clone().sub(v.stage.key.target.position).normalize().transformDirection(v.stage.camera.matrixWorldInverse);
      v.dots.flush(v.stage.camera, light);
    } else {
      // Cells born this generation grow in; cells that just emptied shrink away. Only those at the
      // surface (picked once a generation: some rules change most of their volume every time).
      if (v.animGen !== grid.gen) {
        v.animGen = grid.gen;
        v.animIds.length = 0;
        const ch = grid.changed;
        for (let k = 0; grid.gen > 0 && k < ch.n; k++) {
          const id = ch.a[k];
          const now = grid.state(id);
          if (now === 1 && grid.wasAt(k) !== 1 && isExposed(v, id)) v.animIds.push(id, 0);
          else if (!now && grid.faceOpen(id)) v.animIds.push(id, grid.wasAt(k));
        }
      }
      v.anim.begin();
      for (let k = 0; k < v.animIds.length; k += 2) {
        const id = v.animIds[k];
        const was = v.animIds[k + 1];
        if (!was) cube(v, s, id, u, 1, 0.18 * (1 - u) * (1 - u), (...a) => v.anim.push(...a));
        else cube(v, s, id, 1 - u, was, 0, (...a) => v.anim.push(...a));
      }
      v.anim.end();
    }
    // The whole crystal pulses once at the end.
    v.root.scale.setScalar(1 + (s.ended ? 0.03 * Math.exp(-(s.t - s.growEnd) * 3) * Math.sin((s.t - s.growEnd) * 18) : 0));
    drawStage(ctx, v.stage);
  },

  renderTop({ ctx, theme }, s) {
    const def = CRYSTAL_PRESETS[s.preset];
    const since = s.gen ? s.t - s.times[s.gen] : 1;
    const top = s.p.explain ? drawExplainer(ctx, crystalMode.explain(s), s.t) : null;
    if (s.p.captions) drawCaption(ctx, s.captionList, s.t, 1920 * 0.165, s.ended ? s.growEnd : null);
    drawCounter(ctx, theme, {
      t: s.t,
      title: `${def.label} · ${SYMMETRY_LABEL[s.symmetry]}`,
      gen: s.gen,
      line: `${fmtInt(s.plan.alive[s.gen] ?? 0)} cells`,
      flash: s.ended ? Math.exp(-(s.t - s.growEnd) * 4) : Math.exp(-since * 10) * 0.3,
      endAt: s.ended ? s.growEnd : undefined,
      y: top === null ? undefined : top - 130,
    });
  },

  captions: (s) => s.captionList,

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
    // Grew big, with a long run of generations to watch.
    const growth = clamp01((end.radius as number) / 80);
    const lengthFit = clamp01(gens.length / 120);
    // Intricate beats solid: a lattice, not a lump.
    const lacy = gaussFit(end.fill as number, 0.22, 0.2);
    // Something new happening throughout: few generations with no births at all.
    const busy = gens.filter((e) => (e.births as number) > 0).length / gens.length;
    // Changing shape: births and deaths both, not just a solid blob filling in.
    const churn = clamp01(gens.reduce((a, e) => a + Math.min(e.births as number, e.deaths as number), 0) / Math.max(1, gens.reduce((a, e) => a + (e.births as number), 0)) / 0.6);
    // Still growing at the end is the open ending; settling down is fine too.
    const endFit = end.kind === 'cap' ? 1 : 0.7;
    const total = durFit * (0.1 + 0.2 * growth + 0.15 * lengthFit + 0.1 * busy + 0.15 * churn + 0.1 * endFit + 0.2 * lacy);
    return { total, parts: { durFit, growth, lengthFit, busy, churn, endFit, lacy }, notes: [`${end.preset}`, `${gens.length} generations`, `${end.kind}`, `fill ${((end.fill as number) * 100).toFixed(0)}%`] };
  },

  outcome(events) {
    const end = events.find((e) => evName(e) === 'end');
    return end ? `${end.preset}: ${end.kind}` : null;
  },
};

/**
 * What's happening, in plain words, from this run's own numbers: how it started, how fast it spreads,
 * how it fades, whether it churns or fills in, how big and how lacy it gets, and how it ends.
 */
function crystalCaptions(s: State): Caption[] {
  const { plan, times, reach, rule } = s;
  const G = plan.gens;
  // Placed by time (generations speed up, so they bunch late), each saying how things stand then.
  const span = s.growEnd - INTRO_S;
  const when = (frac: number) => INTRO_S + frac * span;
  const genAt = (t: number) => {
    let g = 0;
    while (g < G && times[g + 1] <= t) g++;
    return g;
  };
  const wanted: { at: number; text: string; priority: number }[] = [];
  const seed = { none: '', mirror: ', mirrored 8 ways', cubic: ', copied into all 48 mirror images and turns of a cube' }[s.symmetry];
  wanted.push({ at: 3, priority: 9, text: `It starts as ${fmtInt(plan.alive[0])} cells${seed}. Each step, every cell counts its neighbours, and that alone decides what's born and what dies.` });
  const g1 = genAt(when(0.2));
  if (g1 >= 8) {
    // How fast it's spreading so far (cells of radius per generation).
    const v = (reach[g1] - reach[0]) / g1;
    const speed =
      v > 0.85
        ? 'It spreads one cell per step: as fast as anything can here, since a cell only feels the cells touching it.'
        : v > 0.08
          ? `It creeps outward, about one cell every ${Math.round(1 / v)} steps.`
          : "It isn't spreading: it reshapes itself where it is.";
    wanted.push({ at: when(0.2), priority: 6, text: speed });
  }
  if (rule.states > 2) wanted.push({ at: when(0.36), priority: 4, text: `Dying cells don't vanish at once: they shrink and darken through ${rule.states - 2} ${rule.states === 3 ? 'stage' : 'stages'} first.` });
  const g3 = genAt(when(0.52));
  const births = plan.births.slice(1, g3 + 1).reduce((a, b) => a + b, 0);
  const deaths = plan.deaths.slice(1, g3 + 1).reduce((a, b) => a + b, 0);
  if (g3 >= 8 && births > 0)
    wanted.push({
      at: when(0.52),
      priority: 5,
      text: deaths / births > 0.5 ? 'Cells die almost as fast as new ones are born, so the inside keeps rearranging while the edge grows.' : 'New cells mostly stay put, so it fills in behind its growing edge.',
    });
  const g4 = genAt(when(0.68));
  if (g4 >= 12) {
    const r = reach[g4];
    const fill = r > 0 ? plan.alive[g4] / ((4 / 3) * Math.PI * r ** 3) : 1;
    const shape = fill < 0.3 ? 'Mostly empty space inside: a lattice, not a solid lump.' : fill > 0.6 ? "It's nearly solid all the way through." : 'About half of it is filled in.';
    wanted.push({ at: when(0.68), priority: 3, text: `${fmtInt(plan.alive[g4])} live cells now, ${fmtInt(2 * r)} cells across. ${shape}` });
  }
  const spreading = G >= 10 && reach[G] > reach[Math.max(0, G - 10)] + 1;
  const ending = {
    dead: 'Every cell is about to die out, and nothing can be born from nothing.',
    still: "It's freezing: soon not a single cell will change again.",
    cycle: "It's settling into a loop: the same few shapes, repeating forever.",
    cap: spreading ? "It's still growing as the video ends: nothing in it has stopped it yet." : "It's still changing, but no longer spreading.",
  }[plan.end];
  wanted.push({ at: s.growEnd - CAPTION_GAP, priority: 8, text: ending });
  return placeCaptions(wanted, 3, s.growEnd);
}

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
      return `Still growing after ${g} generations.`;
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
  const mat = voxelMaterial(s.p.look);
  const detail = detailFor(2 * s.finalReach);
  const grid = seedGrid(s.rule, s.cells);
  // Every changed cell is logged, so the visible-cube list is kept current around the changes.
  grid.log = new IntList();
  return {
    scene: stage.scene,
    stage,
    root,
    /** The picture's own copy of the run, replayed generation by generation. */
    grid,
    /**
     * Every visible cube (one per cell in `list`, same order), and the ones animating this
     * generation (rebuilt every frame).
     */
    stat: new Voxels(root, mat, s.p.look, 16384, detail),
    anim: new Voxels(root, mat, s.p.look, 4096, detail),
    /** This generation's animating cells, as (cell, its state before: 0 = just born) pairs. */
    animIds: [] as number[],
    animGen: -1,
    /** Once the crystal is big: every visible cell as a dot (replacing both of the above). */
    dots: null as Dots | null,
    normal: new Float32Array(3),
    /**
     * Non-empty cells with at least one open face, as a list, with each one's place in it per chunk
     * (-1 = not in it). Kept in step with `stat`.
     */
    list: new IntList(),
    pos: [] as Int32Array[],
    /** Cubes born last generation are drawn at full size from the next one on. */
    grownIn: [] as number[],
    synced: false,
    palette: new Palette(theme.palette),
    rgb: new Float32Array(3),
    xyz: new Int32Array(3),
  };
});

type View = ReturnType<typeof view>;

const isExposed = (v: View, id: number) => (v.pos[id >> 12]?.[id & 4095] ?? -1) >= 0;

/** A cell's cube, handed to `out` as (x, y, z, scale, r, g, b, glow). */
function cube(v: View, s: State, id: number, scale: number, st: number, glow: number, out: (x: number, y: number, z: number, s: number, r: number, g: number, b: number, glow: number) => void) {
  let k = 1;
  if (st > 1) {
    // Decaying: shrinks and darkens through its states.
    const d = (st - 1) / (s.rule.states - 1);
    scale *= 1 - 0.35 * d;
    k = 1 - 0.65 * d;
  }
  v.grid.xyz(id, v.xyz);
  // The centre is between cells, at -½.
  const x = v.xyz[0] + 0.5;
  const y = v.xyz[1] + 0.5;
  const z = v.xyz[2] + 0.5;
  // Coloured by distance from the centre against the crystal's final size, so a cube's colour holds
  // while it lives and the crystal works its way through the palette as it grows.
  const d = Math.sqrt(x * x + y * y + z * z) / s.finalReach;
  v.palette.write(v.rgb, 0, 0.85 * clamp01(d) ** 0.7 + 0.15 * (v.grid.born(id) / Math.max(1, s.plan.gens)), k);
  out(x, y, z, scale, v.rgb[0], v.rgb[1], v.rgb[2], glow);
}

/** Keep the visible-cube list and its buffer current: all of it the first time, then around each logged change. */
function syncExposed(v: View, s: State) {
  const { grid, list, pos } = v;
  while (pos.length < grid.chunks.length) pos.push(new Int32Array(4096).fill(-1));
  const put = (id: number) => putCell(v, s, id);
  const refresh = (id: number, own: boolean) => {
    const e = grid.state(id) !== 0 && grid.faceOpen(id);
    const p = pos[id >> 12];
    const was = p[id & 4095] >= 0;
    if (e && !was) {
      p[id & 4095] = list.n;
      list.push(id);
      put(id);
    } else if (!e && was) {
      // Swap-remove: the last cube takes this one's place.
      const k = p[id & 4095];
      const last = list.a[--list.n];
      list.a[k] = last;
      pos[last >> 12][last & 4095] = k;
      p[id & 4095] = -1;
      if (k !== list.n) (v.dots ?? v.stat).move(list.n, k);
    } else if (e && own) put(id);
  };
  const log = grid.log!;
  if (!v.synced) {
    v.synced = true;
    log.n = 0;
    grid.chunks.forEach((c, ci) => {
      for (let l = 0; l < 4096; l++) if (c.state[l]) refresh(ci * 4096 + l, true);
    });
  } else if (log.n) {
    // Last generation's newborns are full grown now.
    for (const id of v.grownIn.splice(0)) if (isExposed(v, id)) put(id);
    while (pos.length < grid.chunks.length) pos.push(new Int32Array(4096).fill(-1));
    for (let k = 0; k < log.n; k++) {
      const e = log.a[k];
      if (e < 0) {
        // Only its state moved on (still non-empty): its own cube changes, if it's showing.
        if (isExposed(v, ~e)) put(~e);
        continue;
      }
      refresh(e, true);
      for (const [dx, dy, dz] of FACES) {
        const n = grid.neighbour(e, dx, dy, dz, false);
        if (n >= 0) refresh(n, false);
      }
    }
    log.n = 0;
  }
  if (v.dots) v.dots.setCount(list.n);
  else {
    v.stat.setCount(list.n);
    v.stat.flush();
  }
}

/** Write a visible cell into its slot (as a cube, or a dot once the crystal is big). */
function putCell(v: View, s: State, id: number) {
  const { grid } = v;
  const slot = v.pos[id >> 12][id & 4095];
  if (v.dots) {
    const dots = v.dots;
    grid.openDirection(id, v.normal);
    const [nx, ny, nz] = v.normal;
    cube(v, s, id, 1, grid.state(id), 0, (x, y, z, sc, r, g, b, glow) => dots.put(slot, x, y, z, sc * 1.15, r, g, b, glow, nx, ny, nz));
    return;
  }
  // Born this generation: drawn by the animation until next generation.
  const newborn = grid.gen > 0 && grid.state(id) === 1 && grid.born(id) === grid.gen;
  cube(v, s, id, newborn ? 0 : 1, grid.state(id), 0, (...a) => v.stat.put(slot, ...a));
  if (newborn) v.grownIn.push(id);
}

/** Switch to dots: every visible cell moves over, the cubes are hidden (and ambient occlusion, which needs them, is off). */
function toDots(v: View, s: State) {
  v.dots = new Dots(v.root, s.p.look, Math.max(4096, v.list.n));
  for (let k = 0; k < v.list.n; k++) putCell(v, s, v.list.a[k]);
  v.dots.setCount(v.list.n);
  v.stat.mesh.visible = false;
  v.anim.mesh.visible = false;
  v.grownIn.length = 0;
  v.stage.noAo = true;
}

const FACES: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
