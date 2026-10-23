/**
 * Life tower: a 2D Life-like board where every generation is frozen into a layer of cubes and the
 * live board rises on top, so the pattern's whole history becomes a sculpture (gliders leave diagonal
 * tubes, oscillators pillars). The run is simulated once up front to find how long the pattern lasts;
 * generations then speed up so even a long-lived one ends on time, and the camera pulls back at the
 * end to show the whole tower.
 */
import type { DramaScore } from '@sim/engine';
import { THREE, sceneCache } from '../../three-layer';
import { CycleWatch, Life2, type LifeStats } from '../grid';
import { LIFE_RULES, describeRule2, parseRule2, type LifeRuleId, type Rule2 } from '../rules';
import { LIFE_PATTERNS, LIFE_PATTERN_IDS, lifeStart, type LifePatternId } from '../seeds';
import type { AutomataParams } from '../params';
import { Palette, Voxels, drawStage, fitDistance, makeStage, orbit, voxelMaterial } from '../view';
import { EXPLAIN_LIFT, clamp01, drawCounter, durationFit, drawExplainer, ev, evName, fmtInt, genSchedule, lerp, smooth, velOf, type ModeImpl } from '../shared';

const INTRO_S = 1.4;
const OUTRO_S = 5;
/** Generations per second at the start (later ones speed up to fit). */
const START_RATE = 7;
/** Slowest pace (generations per second) for a pattern that ends early. */
const MIN_RATE = 10;
const MAX_GENS = 2400;
/** At most this many layers stacked per second (faster runs stack every few generations). */
const LAYER_RATE = 14;
/** Longest oscillator period recognised as settled (the pentadecathlon is 15). */
const MAX_PERIOD = 15;

type EndKind = 'dead' | 'still' | 'cycle' | 'cap';

interface Layer {
  gen: number;
  /** Live cells (x + y·w). */
  cells: Uint16Array;
}

interface State {
  p: AutomataParams;
  pattern: LifePatternId;
  ruleId: LifeRuleId;
  rule: Rule2;
  w: number;
  board: Life2;
  gens: number;
  end: EndKind;
  period: number;
  start: number;
  peak: number;
  times: (gen: number) => number;
  growEnd: number;
  endT: number;
  layers: Layer[];
  lastLayerT: number;
  /** Births and deaths since the last layer. */
  births: number;
  deaths: number;
  alive: number;
  ended: boolean;
  t: number;
}

function startBoard(w: number, wrap: boolean, cells: [number, number][]): Life2 {
  const b = new Life2(w, wrap);
  for (const [x, y] of cells) b.set(x, y, 1);
  return b;
}

/** How long the pattern lasts on this board: until it dies, settles (still or oscillating), or the cap. */
function planRun(b: Life2, rule: Rule2): { gens: number; end: EndKind; period: number; peak: number } {
  const watch = new CycleWatch(MAX_PERIOD);
  let peak = 0;
  for (let k = 1; k <= MAX_GENS; k++) {
    const st = b.step(rule);
    peak = Math.max(peak, st.alive);
    if (!st.alive) return { gens: k, end: 'dead', period: 0, peak };
    watch.push(b.hash());
    const period = watch.period();
    if (period) return { gens: k - 2 * period, end: period === 1 ? 'still' : 'cycle', period, peak };
  }
  return { gens: MAX_GENS, end: 'cap', period: 0, peak };
}

const cellsOf = (b: Life2): Uint16Array => {
  const out: number[] = [];
  for (let i = 0; i < b.cells.length; i++) if (b.cells[i]) out.push(i);
  return Uint16Array.from(out);
};

export const towerMode: ModeImpl<State> = {
  copy: () => ({ hook: 'Will this pattern survive? 👀', cta: '{result}' }),
  searchBudget: 150,

  init({ params: p, rng }) {
    const pattern = p.pattern === 'random' ? rng.pick(LIFE_PATTERN_IDS) : p.pattern;
    const ruleId = p.lifeRule;
    const rule = parseRule2(LIFE_RULES[ruleId].rule);
    const w = p.board - (p.board % 2);
    const cells = lifeStart(pattern, w, rng);
    const plan = planRun(startBoard(w, p.wrap, cells), rule);
    const board = startBoard(w, p.wrap, cells);
    const span = Math.max(4, p.durationS - INTRO_S - OUTRO_S);
    // A short-lived pattern isn't stretched out to fill the length: it plays at least this fast and
    // the video is shorter.
    const used = Math.min(span, Math.max(plan.gens / MIN_RATE, 2));
    const schedule = genSchedule(plan.gens, used, START_RATE);
    const start = cells.length;
    return {
      p,
      pattern,
      ruleId,
      rule,
      w,
      board,
      gens: plan.gens,
      end: plan.end,
      period: plan.period,
      start,
      peak: Math.max(plan.peak, start),
      times: (g) => INTRO_S + schedule(g),
      growEnd: INTRO_S + used,
      endT: INTRO_S + used + OUTRO_S,
      layers: [{ gen: 0, cells: cellsOf(board) }],
      lastLayerT: INTRO_S,
      births: 0,
      deaths: 0,
      alive: start,
      ended: false,
      t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const { board } = s;
    let last: LifeStats | null = null;
    while (board.gen < s.gens && s.t >= s.times(board.gen + 1)) {
      last = board.step(s.rule);
      s.births += last.births;
      s.deaths += last.deaths;
      s.alive = last.alive;
    }
    if (last && (s.t - s.lastLayerT >= 1 / LAYER_RATE || board.gen === s.gens)) {
      s.layers.push({ gen: board.gen, cells: cellsOf(board) });
      s.lastLayerT = s.t;
      emit({ type: ev('tower', 'gen'), gen: board.gen, births: s.births, deaths: s.deaths, alive: s.alive, layer: s.layers.length });
      s.births = 0;
      s.deaths = 0;
    }
    if (!s.ended && s.t >= s.growEnd) {
      s.ended = true;
      emit({ type: ev('tower', 'end'), gen: s.gens, kind: s.end, period: s.period, alive: s.alive, start: s.start, peak: s.peak, pattern: s.pattern });
    }
  },

  isDone: (s) => s.t >= s.endT,

  hud(s) {
    return { gen: s.board.gen, cells: s.alive, result: s.ended ? resultLine(s) : '', outro: s.ended };
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    const { w } = s;
    const half = (w - 1) / 2;
    const col = v.rgb;
    // History: append the layers stacked since the last frame.
    v.history.keep(v.drawnCells);
    for (let j = v.drawnLayers; j < s.layers.length; j++) {
      const layer = s.layers[j];
      historyColor(v.palette, col, layer.gen, s.gens);
      for (const i of layer.cells) v.history.push((i % w) - half, j + 0.5, Math.floor(i / w) - half, 1, col[0], col[1], col[2], 0);
    }
    v.history.end();
    v.drawnLayers = s.layers.length;
    v.drawnCells = v.history.count;

    // The live board, glowing, on top of the stack.
    const top = s.layers.length;
    if (v.liveGen !== s.board.gen || v.liveTop !== top) {
      v.live.begin();
      v.palette.write(col, 0, s.board.gen / Math.max(1, s.gens), 1.25);
      const cells = s.board.cells;
      for (let i = 0; i < cells.length; i++) if (cells[i]) v.live.push((i % w) - half, top + 0.5, Math.floor(i / w) - half, 1, col[0], col[1], col[2], 0.6);
      v.live.end();
      v.liveGen = s.board.gen;
      v.liveTop = top;
    }

    // Camera: looks down on the live board while it runs, then pulls back to show the whole tower.
    const cam = v.stage.camera;
    const runDist = fitDistance(cam, w * 0.62, 0.95);
    const runTarget = new THREE.Vector3(0, top - w * 0.12, 0);
    const k = smooth((s.t - s.growEnd) / 2.6);
    const height = top + 1;
    const vfov = THREE.MathUtils.degToRad(cam.fov / 2);
    const outDist = Math.max(runDist, (height * 0.62) / Math.tan(vfov), fitDistance(cam, w * 0.75, 0.9));
    const target = runTarget.clone().lerp(new THREE.Vector3(0, height * 0.5, 0), k);
    const az = 0.7 + s.t * 0.22;
    const el = lerp(0.62, 0.16, k);
    orbit(v.stage, target, az, el, lerp(runDist, outDist, k));
    drawStage(ctx, v.stage);
  },

  renderTop({ ctx, theme }, s) {
    const label = `${LIFE_PATTERNS[s.pattern].label} · ${LIFE_RULES[s.ruleId].label}`;
    const top = s.p.explain ? drawExplainer(ctx, towerMode.explain(s), s.t) : null;
    drawCounter(ctx, theme, {
      t: s.t,
      title: label,
      gen: s.board.gen,
      line: `${fmtInt(s.alive)} cells`,
      flash: s.ended ? Math.exp(-(s.t - s.growEnd) * 4) : 0,
      y: top === null ? 1920 * 0.83 : top - 130,
      endAt: s.ended ? s.growEnd : undefined,
    });
  },

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

function resultLine(s: State): string {
  const g = fmtInt(s.gens);
  switch (s.end) {
    case 'dead':
      return `Gone after ${g} generations 💀`;
    case 'still':
      return `Frozen after ${g} generations`;
    case 'cycle':
      return `Settled after ${g} generations`;
    default:
      return `Still going after ${g}…`;
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

const view = sceneCache((s: State, theme) => {
  const stage = makeStage(theme, s.p.look);
  stage.lift = s.p.explain ? EXPLAIN_LIFT : 0;
  const history = new Voxels(stage.scene, voxelMaterial(s.p.look), s.p.look, 32768, true, 0.16);
  // Lit from the side, so a cube's top and sides differ and the shapes read.
  stage.keyTurn = 1.4;
  const live = new Voxels(stage.scene, voxelMaterial(s.p.look), s.p.look, 2048);
  // A dark plate under the board.
  const plate = new THREE.Mesh(new THREE.BoxGeometry(s.w + 2, 0.4, s.w + 2), new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.bg[1]).multiplyScalar(1.6), roughness: 0.7 }));
  plate.position.y = -0.3;
  stage.scene.add(plate);
  return { scene: stage.scene, stage, history, live, plate, palette: new Palette(theme.palette), rgb: new Float32Array(3), drawnLayers: 0, drawnCells: 0, liveGen: -1, liveTop: -1 };
});
