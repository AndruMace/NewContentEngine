/**
 * Life tower: a 2D Life-like board where every generation is frozen into a layer of cubes and the
 * live board rises on top, so the pattern's whole history becomes a sculpture (gliders leave diagonal
 * tubes, oscillators pillars). The board has no walls (it grows as needed), so famous patterns run as
 * they would on an infinite plane; or it can be a torus of a set size.
 *
 * The run is simulated once up front, recording each generation's counts: that's all the events
 * (and so headless runs and seed search) need. The picture replays its own copy of the board as it
 * plays, stacking a layer every so often. Generations speed up so even a long-lived pattern ends on
 * time, and the camera pulls back at the end to show the whole tower.
 */
import type { DramaScore } from '@sim/engine';
import { THREE, sceneCache } from '../../three-layer';
import { CycleWatch, Life2 } from '../grid';
import { LIFE_RULES, describeRule2, parseRule2, type LifeRuleId, type Rule2 } from '../rules';
import { LIFE_PATTERNS, LIFE_PATTERN_IDS, lifeStart, type LifePatternId } from '../seeds';
import type { AutomataParams } from '../params';
import { Palette, Voxels, drawStage, fitDistance, makeStage, orbit, voxelMaterial } from '../view';
import { CAPTION_GAP, EXPLAIN_LIFT, budgetFor, clamp01, drawCaption, placeCaptions, type Caption, drawCounter, durationFit, manualCap, drawExplainer, ev, evName, fmtInt, genSchedule, lerp, smooth, velOf, type ModeImpl } from '../shared';

const INTRO_S = 1.4;
const OUTRO_S = 5;
/** Generations per second at the start (later ones speed up to fit). */
const START_RATE = 7;
/** Slowest pace (generations per second) for a pattern that ends early. */
const MIN_RATE = 10;
export const MAX_TOWER_GENS = 10000;
/** At most this many layers stacked per second, and in all (long runs stack every few generations). */
const LAYER_RATE = 14;
const MAX_LAYERS = 600;
/** An unbounded board starts this big (cells per side) and grows as the pattern spreads. */
const START_BOARD = 256;
/** Longest oscillator period recognised as settled (the pentadecathlon is 15). */
const MAX_PERIOD = 15;
/**
 * Longest repeat in the counts recognised as settled with gliders flying off: what's left oscillates
 * (period up to 15) while gliders (period 4) leave, so the counts repeat though the board doesn't.
 */
const MAX_ESCAPE_PERIOD = 60;
/**
 * How long the counts must repeat before that counts as settled: gliders still on their way to a
 * collision repeat too, so a short repeat isn't enough.
 */
const ESCAPE_WINDOW = 240;
/** A run ends ("still growing") once this many cells are alive: rules that fill space never settle. */
const MAX_POP = 20000;
/** Most cubes the stacked layers may hold in all: layers are thinned out to stay under it. */
const HISTORY_BUDGET = 3_000_000;

type EndKind = 'dead' | 'still' | 'cycle' | 'escape' | 'cap';

interface Plan {
  gens: number;
  end: EndKind;
  period: number;
  /** Per generation (index 0 = the start). */
  alive: Int32Array;
  births: Int32Array;
  deaths: Int32Array;
  /** Furthest live cell from where the pattern started (cells), every EXTENT_EVERY generations. */
  extent: number[];
}

const EXTENT_EVERY = 8;

interface State {
  p: AutomataParams;
  pattern: LifePatternId;
  ruleId: LifeRuleId;
  rule: Rule2;
  w: number;
  /** The starting cells (the picture replays from these). */
  cells: [number, number][];
  plan: Plan;
  /** Generations that become layers (the first is 0, the last the final generation). */
  layerGens: number[];
  /** Current generation, and how many layers are stacked by now. */
  gen: number;
  captionList: Caption[];
  layer: number;
  start: number;
  peak: number;
  times: (gen: number) => number;
  growEnd: number;
  endT: number;
  ended: boolean;
  t: number;
}

function startBoard(w: number, wrap: boolean, cells: [number, number][]): Life2 {
  const b = new Life2(w, wrap);
  for (const [x, y] of cells) b.set(x, y, 1);
  return b;
}

/** Whether the last `span` entries of each list (up to k) repeat with period p. */
function repeats(lists: Int32Array[], k: number, p: number, span: number): boolean {
  if (k - span - p < 0) return false;
  for (let i = 0; i < span; i++) for (const a of lists) if (a[k - i] !== a[k - i - p]) return false;
  return true;
}

/** How long the pattern lasts: until it dies, settles (still, oscillating, or just gliders leaving), or the cap. */
function planRun(b: Life2, rule: Rule2, cap: number): Plan {
  const alive = new Int32Array(cap + 1);
  const births = new Int32Array(cap + 1);
  const deaths = new Int32Array(cap + 1);
  alive[0] = b.population;
  const watch = new CycleWatch(MAX_PERIOD);
  const extent: number[] = [];
  // Where the pattern started (its middle), to measure how far it has spread.
  const start = b.liveCells();
  let sx = 0;
  let sy = 0;
  for (let q = 0; q < start.length; q += 2) {
    sx += start[q];
    sy += start[q + 1];
  }
  sx /= Math.max(1, start.length / 2);
  sy /= Math.max(1, start.length / 2);
  const measure = () => {
    const c = b.liveCells();
    let far = 0;
    for (let q = 0; q < c.length; q += 2) far = Math.max(far, Math.abs(c[q] - sx), Math.abs(c[q + 1] - sy));
    extent.push(far);
  };
  measure();
  const done = (gens: number, end: EndKind, period: number): Plan => ({ gens, end, period, alive, births, deaths, extent });
  for (let k = 1; k <= cap; k++) {
    const st = b.step(rule);
    if (k % EXTENT_EVERY === 0) measure();
    alive[k] = st.alive;
    births[k] = st.births;
    deaths[k] = st.deaths;
    if (!st.alive) return done(k, 'dead', 0);
    if (st.alive > MAX_POP) return done(k, 'cap', 0);
    watch.push(b.hash());
    const period = watch.period();
    if (period) return done(k - 2 * period, period === 1 ? 'still' : 'cycle', period);
    // Dated back to when the repeat began.
    for (let p = 1; p <= MAX_ESCAPE_PERIOD; p++) if (repeats([alive, births, deaths], k, p, ESCAPE_WINDOW)) return done(k - ESCAPE_WINDOW, 'escape', p);
  }
  return done(cap, 'cap', 0);
}

/**
 * Which generations become layers: no more than LAYER_RATE a second, MAX_LAYERS in all and
 * HISTORY_BUDGET cubes in all, so a slow start stacks every generation and a long or crowded run
 * every so many.
 */
function pickLayers(plan: Plan, times: (g: number) => number): number[] {
  const { gens, alive } = plan;
  for (let minGap = Math.ceil(gens / MAX_LAYERS); ; minGap *= 2) {
    const out = [0];
    let cubes = alive[0];
    for (let g = 1; g <= gens; g++) {
      const last = out[out.length - 1];
      if (g === gens || (g - last >= minGap && times(g) - times(last) >= 1 / LAYER_RATE)) {
        out.push(g);
        cubes += alive[g];
      }
    }
    if (cubes <= HISTORY_BUDGET || minGap >= gens) return out;
  }
}

export const towerMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Will this pattern survive? 👀', cta: '{result}' }),
  searchBudget: (p) => budgetFor(80, p.generations || 2400, 2400, 1, 20),

  init({ params: p, rng }) {
    const pattern = p.pattern === 'random' ? rng.pick(LIFE_PATTERN_IDS) : p.pattern;
    const ruleId = p.lifeRule;
    const rule = parseRule2(LIFE_RULES[ruleId].rule);
    // A torus has a set size; otherwise the board starts small and grows.
    const w = p.wrap ? p.board - (p.board % 2) : START_BOARD;
    const cells = lifeStart(pattern, w, rng);
    // Generations and pace can be set by hand; otherwise the run is fitted to the length.
    const rate = p.genRate;
    let cap = p.generations || MAX_TOWER_GENS;
    if (rate) cap = Math.min(cap, manualCap(rate, INTRO_S + OUTRO_S));
    const plan = planRun(startBoard(w, p.wrap, cells), rule, cap);
    const span = Math.max(4, p.durationS - INTRO_S - OUTRO_S);
    // A short-lived pattern isn't stretched out to fill the length: it plays at least this fast and
    // the video is shorter.
    const used = rate ? plan.gens / rate : Math.min(span, Math.max(plan.gens / MIN_RATE, 2));
    const schedule = rate ? (g: number) => g / rate : genSchedule(plan.gens, used, START_RATE);
    const times = (g: number) => INTRO_S + schedule(g);
    let peak = 0;
    for (let g = 0; g <= plan.gens; g++) peak = Math.max(peak, plan.alive[g]);
    const s: State = {
      p,
      pattern,
      ruleId,
      rule,
      w,
      cells,
      plan,
      layerGens: pickLayers(plan, times),
      gen: 0,
      layer: 1,
      start: cells.length,
      peak,
      times,
      growEnd: INTRO_S + used,
      endT: INTRO_S + used + OUTRO_S,
      ended: false,
      t: 0,
      captionList: [],
    };
    s.captionList = towerCaptions(s, !rate && plan.gens > START_RATE * used * 1.15);
    return s;
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { plan } = s;
    while (s.gen < plan.gens && s.t >= s.times(s.gen + 1)) s.gen++;
    // A layer for every layer generation passed (with the births and deaths since the last one).
    while (s.layer < s.layerGens.length && s.layerGens[s.layer] <= s.gen) {
      let births = 0;
      let deaths = 0;
      for (let g = s.layerGens[s.layer - 1] + 1; g <= s.layerGens[s.layer]; g++) {
        births += plan.births[g];
        deaths += plan.deaths[g];
      }
      const gen = s.layerGens[s.layer++];
      emit({ type: ev('tower', 'gen'), gen, births, deaths, alive: plan.alive[gen], layer: s.layer });
    }
    if (!s.ended && s.t >= s.growEnd) {
      s.ended = true;
      emit({ type: ev('tower', 'end'), gen: plan.gens, kind: plan.end, period: plan.period, alive: plan.alive[plan.gens], start: s.start, peak: s.peak, pattern: s.pattern });
    }
  },

  isDone: (s) => s.t >= s.endT,

  hud(s) {
    return { gen: s.gen, cells: s.plan.alive[s.gen], result: s.ended ? resultLine(s) : '', outro: s.ended };
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    const half = (s.w - 1) / 2;
    // Replay the board up to now, stacking each layer as its generation comes round.
    while (v.board.gen < s.gen) {
      v.board.step(s.rule);
      if (v.board.gen === s.layerGens[v.nextLayer]) addLayer(v, s, v.nextLayer++);
    }

    // The live board, glowing, on top of the stack.
    const top = v.nextLayer;
    const col = v.rgb;
    if (v.liveGen !== v.board.gen) {
      v.live.begin();
      v.palette.write(col, 0, v.board.gen / Math.max(1, s.plan.gens), 1.25);
      const live = v.board.liveCells();
      for (let q = 0; q < live.length; q += 2) v.live.push(live[q] - half, top + 0.5, live[q + 1] - half, 1, col[0], col[1], col[2], 0.6);
      v.live.end();
      v.liveSpan = spanAround(live, half, v.origin);
      v.liveGen = v.board.gen;
    }

    // Camera: centred where the pattern started, looking down on the live cells around it (gliders
    // flying off leave the frame rather than shrinking it), then pulls back to show the whole tower.
    const cam = v.stage.camera;
    const dtS = Math.max(0, Math.min(0.5, s.t - v.lastT));
    v.lastT = s.t;
    v.span = lerp(v.span, v.liveSpan, 1 - Math.exp(-dtS * 2));
    v.widest = Math.max(v.widest, v.span);
    const runDist = fitDistance(cam, v.span * 0.62, 0.95);
    const [ox, oz] = v.origin;
    const runTarget = new THREE.Vector3(ox, top - v.span * 0.12, oz);
    const k = smooth((s.t - s.growEnd) / 2.6);
    const height = top + 1;
    // A portrait frame: the tower's height sets the shot, its width at most as wide as it is tall.
    const width = Math.min(v.widest, Math.max(40, height));
    const vfov = THREE.MathUtils.degToRad(cam.fov / 2);
    const outDist = Math.max((height * 0.62) / Math.tan(vfov), fitDistance(cam, width * 0.62, 0.9));
    const target = runTarget.clone().lerp(new THREE.Vector3(ox, height * 0.5, oz), k);
    v.plate.scale.set(v.widest + 6, 1, v.widest + 6);
    const az = 0.7 + s.t * 0.22;
    const el = lerp(0.62, 0.16, k);
    orbit(v.stage, target, az, el, lerp(runDist, outDist, k));
    drawStage(ctx, v.stage);
  },

  renderTop({ ctx, theme }, s) {
    const label = `${LIFE_PATTERNS[s.pattern].label} · ${LIFE_RULES[s.ruleId].label}`;
    const top = s.p.explain ? drawExplainer(ctx, towerMode.explain(s), s.t) : null;
    if (s.p.captions) drawCaption(ctx, s.captionList, s.t, 1920 * 0.165, s.ended ? s.growEnd : null);
    drawCounter(ctx, theme, {
      t: s.t,
      title: label,
      gen: s.gen,
      line: `${fmtInt(s.plan.alive[s.gen])} cells`,
      flash: s.ended ? Math.exp(-(s.t - s.growEnd) * 4) : 0,
      y: top === null ? 1920 * 0.83 : top - 130,
      endAt: s.ended ? s.growEnd : undefined,
    });
  },

  captions: (s) => s.captionList,

  explain(s) {
    return `${LIFE_RULES[s.ruleId].label}: ${describeRule2(s.rule)} Each generation is stacked on the last, so the tower is the pattern's whole history.`;
  },

  audio(e, { melody, theme, lastNoteT }) {
    switch (evName(e)) {
      case 'gen': {
        const changes = (e.births as number) + (e.deaths as number);
        if (!changes) return [];
        if (e.t - lastNoteT < 0.1) return [{ kind: 'sfx', name: 'tick', vel: 0.1, pitch: 0.5 + 0.5 * clamp01((e.layer as number) / 300) }];
        const vel = velOf(changes);
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.5 : vel, voice: theme.voice }));
      }
      case 'end':
        if (e.kind === 'dead') return [{ kind: 'sfx', name: 'boom', vel: 0.6 }, { kind: 'sfx', name: 'shatter', vel: 0.35 }];
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.45 },
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
    const durFit = durationFit(durationS, targetS);
    if (!end) return { total: 0.01, parts: { durFit }, notes: ['no end'] };
    const gens = end.gen as number;
    // Long enough to build a tower worth seeing.
    const lifeFit = clamp01((gens - 40) / 250);
    // A boom: the pattern grows well past its start before it settles.
    const boom = clamp01(Math.log2((end.peak as number) / Math.max(1, end.start as number)) / 4);
    // Vanishing completely is the best ending; settling is good; still churning at the cap is fine.
    const endFit = end.kind === 'dead' ? 1 : end.kind === 'cap' ? 0.55 : 0.85;
    const total = durFit * (0.2 + 0.3 * lifeFit + 0.25 * boom + 0.25 * endFit);
    return { total, parts: { durFit, lifeFit, boom, endFit }, notes: [`${end.pattern}`, `${gens} generations`, `${end.kind}`] };
  },

  outcome(events) {
    const end = events.find((e) => evName(e) === 'end');
    return end ? `${end.pattern}: ${end.kind}` : null;
  },
};

/**
 * What's happening, in plain words, from this run's own numbers: how it starts, what the tower is,
 * the board it's on, when it explodes, whether it's sped up, and how it ends (dying, freezing,
 * blinking, or settling while pieces fly off for good).
 */
function towerCaptions(s: State, speedsUp: boolean): Caption[] {
  const { plan, times } = s;
  const G = plan.gens;
  // Placed by time (generations speed up, so they bunch late), each saying how things stand then.
  const span = s.growEnd - INTRO_S;
  const when = (frac: number) => INTRO_S + frac * span;
  const genAt = (t: number) => {
    let lo = 0;
    let hi = G;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times(mid) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const wanted: { at: number; text: string; priority: number }[] = [];
  wanted.push({ at: 3, priority: 9, text: `It starts with just ${fmtInt(s.start)} live cells. Each step, every square counts its 8 neighbours, and that decides whether it lives.` });
  wanted.push({ at: 6.8, priority: 7, text: 'Each step is frozen as a new layer, so the tower is its whole history: oldest at the bottom, newest on top.' });
  if (s.p.wrap) wanted.push({ at: when(0.3), priority: 4, text: 'The board wraps around like a donut: anything leaving one edge comes back on the other.' });
  // Busy: lots changing at once, the stretch where nothing short of running it says what comes next.
  const gm = genAt(when(0.42));
  const busy = gm > 0 && plan.births[gm] + plan.deaths[gm] > 0.15 * Math.max(1, plan.alive[gm]);
  if (busy && G > 60) wanted.push({ at: when(0.42), priority: 3, text: "There's no shortcut to what it does next: the only way to find out is to run it, one step at a time." });
  let peakGen = 0;
  for (let g = 1; g <= G; g++) if (plan.alive[g] > plan.alive[peakGen]) peakGen = g;
  const exploded = s.peak >= 3 * s.start && peakGen > G * 0.05;
  if (exploded && times(peakGen) < s.growEnd - 2 * CAPTION_GAP) wanted.push({ at: times(peakGen), priority: 5, text: `It has exploded from ${fmtInt(s.start)} cells to ${fmtInt(s.peak)}.` });
  if (speedsUp) {
    // Once it runs at twice its starting pace.
    let g = 1;
    while (g < G && times(g + 1) - times(g) > 1 / (2 * START_RATE)) g++;
    // (After the tower itself has been explained.)
    wanted.push({ at: Math.max(times(g), 7), priority: 2, text: 'Its life is long, so the steps speed up to fit it all in.' });
  }
  // Pieces flying off for good: the furthest live cell keeps getting further away towards the end.
  // (Not on a torus: there nothing leaves, it comes back round.)
  const ext = (g: number) => plan.extent[Math.min(plan.extent.length - 1, Math.floor(g / EXTENT_EVERY))] ?? 0;
  const flying = !s.p.wrap && G >= 80 && ext(G) > ext(Math.round(G * 0.6)) + 20;
  const life = s.ruleId === 'life';
  const pieces = life ? 'gliders' : 'pieces';
  if (flying && life) {
    // When the first one is clear of the rest: the pattern's reach passes 40 cells.
    let g = 0;
    while (g < G && ext(g) <= 40) g += EXTENT_EVERY;
    if (g < G) wanted.push({ at: times(g), priority: 6, text: 'Those diagonal streaks are gliders: little 5-cell shapes that crawl away forever.' });
  }
  const grew = exploded && !(times(peakGen) < s.growEnd - 2 * CAPTION_GAP) ? `It grew from ${fmtInt(s.start)} cells to as many as ${fmtInt(s.peak)}. ` : '';
  const ending = {
    dead: "And now it's about to vanish completely.",
    still: "It's about to freeze into shapes that never change again.",
    cycle: "It's settling down: what's left will blink on and off forever.",
    escape: flying ? `It's about to settle down; only the ${pieces} keep going.` : "It's about to settle into a steady rhythm.",
    cap: plan.alive[G] > MAX_POP ? 'It keeps filling space without end, so the video stops here.' : flying ? `It never settles: it keeps sending out ${pieces} that fly away forever.` : 'Still churning, with no sign of settling.',
  }[plan.end];
  wanted.push({ at: s.growEnd - CAPTION_GAP, priority: 8, text: grew + ending });
  return placeCaptions(wanted, 3, s.growEnd);
}

function resultLine(s: State): string {
  const g = fmtInt(s.plan.gens);
  switch (s.plan.end) {
    case 'dead':
      return `Gone after ${g} generations 💀`;
    case 'still':
      return `Frozen after ${g} generations`;
    case 'cycle':
      return `Settled after ${g} generations`;
    case 'escape':
      return `Settled after ${g} generations, gliders still flying`;
    default:
      return `Still growing after ${g}…`;
  }
}

/** Generations per colour band in the tower: a round number giving about 15 bands. */
function bandOf(gens: number): number {
  const raw = Math.max(1, gens / 15);
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((b) => b >= raw) ?? raw;
}

/**
 * A history layer's colour: the palette along the run, toned down (darker, less saturated) so the
 * shapes read rather than glare, with every other band of generations a shade darker to mark time.
 */
function historyColor(palette: Palette, out: Float32Array, gen: number, gens: number) {
  palette.write(out, 0, gen / Math.max(1, gens));
  const k = Math.floor(gen / bandOf(gens)) % 2 ? 0.26 : 0.36;
  const luma = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  for (let q = 0; q < 3; q++) out[q] = (luma + (out[q] - luma) * 0.55) * k;
}

type View = ReturnType<typeof view>;

/** Closest and furthest a camera frame (cells across) gets while following the live cells. */
const MIN_SPAN = 40;
const MAX_SPAN = 220;

/**
 * How wide a frame round the origin holds most of some cells (x, y pairs): twice the distance within
 * which 85% of them lie, so a few stragglers (gliders flying off) don't pull the camera back.
 */
function spanAround(cells: Int32Array, half: number, origin: [number, number]): number {
  const n = cells.length / 2;
  if (!n) return MIN_SPAN;
  const d = new Float64Array(n);
  for (let q = 0; q < n; q++) d[q] = Math.max(Math.abs(cells[2 * q] - half - origin[0]), Math.abs(cells[2 * q + 1] - half - origin[1]));
  d.sort();
  return Math.max(MIN_SPAN, Math.min(MAX_SPAN, 2 * d[Math.floor(n * 0.85)] + 10));
}

/** A cell's key in the layer sets (world coordinates, which can go negative as the board grows). */
const cellKey = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);

/**
 * Stack layer j from the replayed board. A cube enclosed on all six sides isn't drawn; a layer's top
 * isn't known until the next one is on, so the previous layer is drawn again (culled) now.
 */
function addLayer(v: View, s: State, j: number) {
  const half = centreOf(s);
  const cells = v.board.liveCells();
  v.layers[j] = cells;
  const set = new Set<number>();
  for (let q = 0; q < cells.length; q += 2) set.add(cellKey(cells[q], cells[q + 1]));
  v.sets[j] = set;
  const has = (layer: number, x: number, y: number) => layer >= 0 && layer <= j && v.sets[layer].has(cellKey(x, y));
  const from = Math.max(0, j - 1);
  v.history.keep(v.layerStart[from] ?? 0);
  for (let q = from; q <= j; q++) {
    v.layerStart[q] = v.history.count;
    historyColor(v.palette, v.rgb, s.layerGens[q], s.plan.gens);
    const [r, g, b] = v.rgb;
    const lc = v.layers[q];
    for (let k = 0; k < lc.length; k += 2) {
      const x = lc[k];
      const y = lc[k + 1];
      if (has(q - 1, x, y) && has(q + 1, x, y) && has(q, x - 1, y) && has(q, x + 1, y) && has(q, x, y - 1) && has(q, x, y + 1)) continue;
      v.history.push(x - half, q + 0.5, y - half, 1, r, g, b, 0);
    }
  }
  v.history.end();
  // Only the last two layers are needed for the cover test.
  if (j >= 2) {
    v.layers[j - 2] = new Int32Array(0);
    v.sets[j - 2] = new Set();
  }
}

/** Where the picture's origin sits in world cell coordinates: the starting board's middle. */
function centreOf(s: State): number {
  return (s.w - 1) / 2;
}

const view = sceneCache((s: State, theme) => {
  const stage = makeStage(theme, s.p.look);
  stage.lift = s.p.explain ? EXPLAIN_LIFT : 0;
  const history = new Voxels(stage.scene, voxelMaterial(s.p.look), s.p.look, 32768, 0, 0.16);
  // Lit from the side, so a cube's top and sides differ and the shapes read.
  stage.keyTurn = 1.4;
  const live = new Voxels(stage.scene, voxelMaterial(s.p.look), s.p.look, 2048);
  // A dark plate under the tower (a unit box, scaled to fit).
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.bg[1]).multiplyScalar(1.6), roughness: 0.7 }));
  stage.scene.add(plate);
  const v = {
    scene: stage.scene,
    stage,
    history,
    live,
    plate,
    palette: new Palette(theme.palette),
    rgb: new Float32Array(3),
    /** The picture's own copy of the board, replayed generation by generation. */
    board: startBoard(s.w, s.p.wrap, s.cells),
    nextLayer: 1,
    layers: [] as Int32Array[],
    sets: [] as Set<number>[],
    /** Where each layer's cubes start in the history. */
    layerStart: [] as number[],
    liveGen: -1,
    /** Where the pattern started (the middle of its starting cells), which the camera stays on. */
    origin: [0, 0] as [number, number],
    /** Frame width round the origin for the live cells now, smoothed, and the widest so far. */
    liveSpan: MIN_SPAN,
    span: MIN_SPAN,
    widest: MIN_SPAN,
    lastT: 0,
  };
  const half = centreOf(s);
  v.origin = [s.cells.reduce((a, [x]) => a + x, 0) / Math.max(1, s.cells.length) - half, s.cells.reduce((a, [, y]) => a + y, 0) / Math.max(1, s.cells.length) - half];
  v.plate.position.set(v.origin[0], -0.3, v.origin[1]);
  addLayer(v, s, 0);
  return v;
});
