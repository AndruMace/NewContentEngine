/**
 * Colony war: 2–4 colonies start as small balls in a spherical (or cubic) arena of cells, spread into
 * the empty space and then fight cell by cell at their borders. Each generation an empty cell joins
 * the colony with most neighbours, and a border cell can be taken by the enemy around it (majority:
 * whoever outnumbers it; cyclic: only its predator, rock-paper-scissors style). Colonies surge and
 * tire in slow waves, so fronts move. A final rush shrinks the arena; one colony taking everything,
 * or the biggest at the buzzer, wins.
 */
import { hexToRgb, lighten, rgbToCss, type DramaScore, type Rng, type StepCtx } from '@sim/engine';
import { COUNTRY_TEAMS, pickDistinctTeams, type Team } from '../../fx';
import { drawClock, drawShareBar } from '../../hud';
import { gaussFit } from '../../scoring';
import { THREE, sceneCache } from '../../three-layer';
import type { AutomataParams } from '../params';
import { IntList } from '../grid';
import { Voxels, detailFor, drawStage, fitDistance, linear, makeStage, orbit, voxelMaterial } from '../view';
import { CAPTION_GAP, EXPLAIN_LIFT, MANUAL_MAX_S, budgetFor, clamp01, drawCaption, listOf, type Caption, drawExplainer, ev, evName, outlined, smooth, velOf, type ModeImpl } from '../shared';

const GEN_RATE = 10;
const OUTRO_S = 3;
const RUSH_S = 6;
/** The arena's radius at the end of the final rush (fraction of the full one). */
const RUSH_R = 0.6;
/** Chance an empty cell next to a colony joins it this generation (scaled by how surrounded it is). */
const GROW = 0.3;
/** Chance scale for a border cell being taken. */
const FIGHT = 0.5;
/** How strongly a colony's size feeds its strength by the end of the match (0 at the start). */
const GREED = 1.4;

/** Half-angle of the cut-away wedge (radians). */
const CUT_HALF = 0.75;

const COLOR_TEAMS: Team[] = [
  { label: 'Red', icon: '🔴', color: '#ef4444' },
  { label: 'Blue', icon: '🔵', color: '#3b82f6' },
  { label: 'Gold', icon: '🟡', color: '#f5b50b' },
  { label: 'Green', icon: '🟢', color: '#22c55e' },
];

/** Face and edge and corner neighbours (offsets set per grid). */
const DIRS: [number, number, number][] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) DIRS.push([dx, dy, dz]);

interface Colony {
  /** Surges and tires: strength multiplier = 1 + amp·sin(phase + ω·t). */
  phase: number;
  omega: number;
  amp: number;
}

interface State {
  p: AutomataParams;
  k: number;
  cyclic: boolean;
  teams: Team[];
  colonies: Colony[];
  n: number;
  /** Padded side. */
  pd: number;
  /** Arena cells (padded indices), in index order, and each one's distance from the centre (cells). */
  cells: Int32Array;
  dist: Float32Array;
  owner: Uint8Array;
  /** The generation each cell last changed hands (for the flash). */
  changed: Uint16Array;
  /** Owners before the last generation, for animating (visual runs only). */
  prev: Uint8Array | null;
  counts: Int32Array;
  offs: Int32Array;
  /** Each padded cell's place in `cells` (-1 outside the arena). */
  jOf: Int32Array;
  /**
   * Cells on a front: a neighbour belongs to another colony (or, for an empty cell, to any). Only
   * these can change, so only these are looked at; in the same order as all of them would be, so
   * the random draws (and the run) are the same.
   */
  front: Uint32Array;
  /** Arena cells from the outside in (by distance, in steps of an eighth of a cell), for the rush. */
  outward: Int32Array;
  /** Where each eighth-of-a-cell distance step starts in `outward`, and how far the rush has got. */
  outStart: Int32Array;
  rushStep: number;
  /** Neighbours each cell has in each colony, kept up to date as cells change hands. */
  nb: Uint8Array[];
  r: number;
  /** Generations per second, and when the match ends (the buzzer). */
  rate: number;
  matchS: number;
  /** Current arena radius (shrinks in the final rush). */
  radius: number;
  gen: number;
  lastGenT: number;
  leader: number;
  leadChanges: number;
  smallest: number;
  lastTick: number;
  rushOn: boolean;
  /** Captions written as the match plays out (when `captions` is on), the next one waiting its turn, and what's been said. */
  captionList: Caption[];
  /** Captions waiting their turn (a lead change replaces an older one still waiting). */
  pending: { text: string; replaceable: boolean }[];
  saidFull: boolean;
  saidSnowball: boolean;
  /** Colonies whose wipe-out has been announced. */
  outSaid: boolean[];
  endAt: number | null;
  winner: number;
  out: boolean[];
  flips: number;
  t: number;
  rng: Rng;
}

const strength = (c: Colony, t: number) => 1 + c.amp * Math.sin(c.phase + c.omega * t);

/** Colony starting spots: spread round the centre (a line, triangle or tetrahedron), at this radius. */
function spots(k: number, r: number, rng: Rng): [number, number, number][] {
  const base: [number, number, number][] =
    k === 2
      ? [
          [1, 0, 0],
          [-1, 0, 0],
        ]
      : k === 3
        ? [0, 1, 2].map((i) => [Math.cos((i * Math.PI * 2) / 3), 0, Math.sin((i * Math.PI * 2) / 3)] as [number, number, number])
        : [
            [1, 1, 1],
            [1, -1, -1],
            [-1, 1, -1],
            [-1, -1, 1],
          ].map(([x, y, z]) => [x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)] as [number, number, number]);
  // A random turn of the whole arrangement, so the fronts don't always line up with the cutaway.
  const a = rng.range(0, Math.PI * 2);
  const b = rng.range(-0.5, 0.5);
  return base.map(([x, y, z]) => {
    const x1 = x * Math.cos(a) - z * Math.sin(a);
    const z1 = x * Math.sin(a) + z * Math.cos(a);
    const y2 = y * Math.cos(b) - z1 * Math.sin(b);
    const z2 = y * Math.sin(b) + z1 * Math.cos(b);
    return [x1 * r, y2 * r, z2 * r];
  });
}

export const warMode: ModeImpl<State> = {
  copy: (p) => ({ hook: `Pick a ${p.sides === 'countries' ? 'side' : 'colour'}. Who takes over? 👀`, cta: '{result} Did you call it?' }),
  searchBudget: (p) => budgetFor(80, p.warSize, 40, 2.5, 8),

  init({ params: p, rng }) {
    const cyclic = p.warRule === 'cyclic';
    const k = cyclic ? 3 : p.colonies;
    const teams = p.sides === 'countries' ? pickDistinctTeams(COUNTRY_TEAMS, k, rng) : COLOR_TEAMS.slice(0, k);
    const n = p.warSize - (p.warSize % 2);
    const pd = n + 2;
    const c = (n - 1) / 2;
    const r = n / 2;
    const idx = (x: number, y: number, z: number) => x + 1 + pd * (y + 1 + pd * (z + 1));
    const list: number[] = [];
    const dist: number[] = [];
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const d = Math.sqrt((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2);
          // Cube arenas measure the rush by the largest coordinate instead.
          const m = p.arena === 'sphere' ? d : Math.max(Math.abs(x - c), Math.abs(y - c), Math.abs(z - c)) + 0.5;
          if (p.arena === 'sphere' && d > r - 0.5) continue;
          list.push(idx(x, y, z));
          dist.push(m);
        }
    const owner = new Uint8Array(pd ** 3);
    const counts = new Int32Array(k);
    spots(k, r * 0.55, rng).forEach(([sx, sy, sz], i) => {
      for (let z = -3; z <= 3; z++)
        for (let y = -3; y <= 3; y++)
          for (let x = -3; x <= 3; x++) {
            if (x * x + y * y + z * z > 6.5) continue;
            const j = idx(Math.round(c + sx + x), Math.round(c + sy + y), Math.round(c + sz + z));
            if (!owner[j]) {
              owner[j] = i + 1;
              counts[i]++;
            }
          }
    });
    const rate = p.genRate || GEN_RATE;
    const offs = Int32Array.from(DIRS.map(([dx, dy, dz]) => dx + pd * (dy + pd * dz)));
    const jOf = new Int32Array(pd ** 3).fill(-1);
    list.forEach((i, j) => (jOf[i] = j));
    const nb = teams.map(() => new Uint8Array(pd ** 3));
    for (const i of list) if (owner[i]) for (let q = 0; q < offs.length; q++) nb[owner[i] - 1][i + offs[q]]++;
    const front = new Uint32Array(Math.ceil(list.length / 32));
    list.forEach((i, j) => setFront(front, j, onFront(nb, owner[i], i)));
    // Cells grouped by distance step, outermost first (a counting sort: there are millions).
    let far = 0;
    for (const d of dist) far = Math.max(far, d);
    const steps = Math.ceil(far * 8) + 1;
    const outStart = new Int32Array(steps + 1);
    for (const d of dist) outStart[steps - 1 - Math.floor(d * 8) + 1]++;
    for (let b = 0; b < steps; b++) outStart[b + 1] += outStart[b];
    const fill = outStart.slice(0, steps);
    const outward = new Int32Array(list.length);
    dist.forEach((d, j) => (outward[fill[steps - 1 - Math.floor(d * 8)]++] = j));
    const colonies = teams.map(() => ({ phase: rng.range(0, Math.PI * 2), omega: rng.range(0.25, 0.6), amp: rng.range(0.2, 0.4) }));
    return {
      p,
      k,
      cyclic,
      teams,
      colonies,
      n,
      pd,
      cells: Int32Array.from(list),
      dist: Float32Array.from(dist),
      owner,
      changed: new Uint16Array(pd ** 3),
      prev: null,
      counts,
      offs,
      jOf,
      front,
      outward,
      outStart,
      rushStep: 0,
      nb,
      r,
      rate,
      // A hand-set generation count sets the match length at this pace (instead of the video length).
      matchS: p.generations ? Math.min(p.generations / rate, MANUAL_MAX_S - OUTRO_S) : p.durationS - OUTRO_S,
      radius: r + 1,
      gen: 0,
      lastGenT: 0,
      leader: -1,
      leadChanges: 0,
      smallest: -1,
      lastTick: -1,
      rushOn: false,
      captionList: [],
      pending: [],
      saidFull: false,
      saidSnowball: false,
      outSaid: teams.map(() => false),
      endAt: null,
      winner: -1,
      out: teams.map(() => false),
      flips: 0,
      t: 0,
      rng,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    if (s.endAt !== null) return;
    const { matchS } = s;
    const rush = s.p.finalRush && t >= matchS - RUSH_S;
    if (rush && !s.rushOn) {
      s.rushOn = true;
      emit({ type: ev('war', 'rush') });
      if (s.p.captions) say(s, t, 'Final rush: the arena shrinks, and every cell outside it is lost.', true);
    }
    if (rush) s.radius = s.r * (1 - (1 - RUSH_R) * smooth((t - (matchS - RUSH_S)) / RUSH_S)) + 0.5;
    if (s.t >= (s.gen + 1) / s.rate && (!s.p.generations || s.gen < s.p.generations)) {
      generation(s, s.t, emit);
      s.lastGenT = s.t;
    }

    // Lead, ticks, the end.
    const { counts } = s;
    let lead = 0;
    for (let i = 1; i < s.k; i++) if (counts[i] > counts[lead]) lead = i;
    if (lead !== s.leader && (s.leader < 0 || counts[lead] > counts[s.leader])) {
      if (s.leader >= 0 && t > 3) {
        s.leadChanges++;
        emit({ type: ev('war', 'lead'), side: lead });
        if (s.p.captions) say(s, t, `${s.teams[lead].label} takes the lead.`, false, true);
      }
      s.leader = lead;
    }
    if (s.p.captions) commentate(s, t);
    const alive = s.out.filter((o) => !o).length;
    const left = matchS - t;
    if (alive > 1 && left <= 5 && left > 0 && Math.ceil(left) !== s.lastTick) {
      s.lastTick = Math.ceil(left);
      emit({ type: ev('war', 'tick'), left: s.lastTick });
    }
    if (alive === 1 || t >= matchS || (s.p.generations > 0 && s.gen >= s.p.generations)) {
      s.endAt = t;
      s.winner = lead;
      const total = counts.reduce((a, b) => a + b, 0) || 1;
      const sorted = [...counts].sort((a, b) => b - a);
      emit({ type: ev('war', 'end'), winner: lead, team: s.teams[lead].label, share: counts[lead] / total, margin: (sorted[0] - (sorted[1] ?? 0)) / total, byExtinction: alive === 1 });
    }
  },

  isDone: (s) => s.endAt !== null && s.t >= s.endAt + OUTRO_S,

  hud(s) {
    const w = s.winner >= 0 ? s.teams[s.winner] : null;
    return { winner: w ? `${w.icon ? w.icon + ' ' : ''}${w.label}` : '', result: w ? `${w.icon ? w.icon + ' ' : ''}${w.label} wins!` : '', gen: s.gen, outro: s.endAt !== null };
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    const { n, pd, owner } = s;
    const prev = s.prev ?? owner;
    const c = (n - 1) / 2;
    const u = smooth(clamp01((s.t - s.lastGenT) * Math.max(s.rate, 2.5) * 1.4));
    // A wedge of the upper half facing the camera is cut away (it turns with the camera), so the
    // fronts inside show.
    const az = 0.6 + s.t * 0.2;
    const cut = s.p.cutaway;
    const { upper, azimuth } = v;
    const cutAt = (i: number) => {
      if (!upper[i]) return false;
      let d = azimuth[i] - az;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      return d < CUT_HALF && d > -CUT_HALF;
    };
    if (v.shellGen !== s.gen) buildShell(v, s);
    const ended = s.endAt !== null;
    const winGlow = ended ? 0.25 * Math.exp(-(s.t - s.endAt!) * 1.5) : 0;
    const draw = (i: number) => {
      const o = owner[i];
      const was = prev[i];
      let scale = 1;
      let rgb = v.colors[(o || was) - 1];
      let glow = 0;
      if (!was) scale = u;
      else if (!o) scale = 1 - u;
      else if (o !== was) {
        // Changing hands: the new colour washes in with a flash.
        const a = v.colors[was - 1];
        const b = v.colors[o - 1];
        rgb = v.mix;
        for (let q = 0; q < 3; q++) rgb[q] = a[q] + (b[q] - a[q]) * u;
        glow = 0.5 * (1 - u);
      }
      if (ended && o - 1 === s.winner) glow += winGlow;
      if (scale <= 0.02) return;
      v.voxels.push((i % pd) - 1 - c, (Math.floor(i / pd) % pd) - 1 - c, Math.floor(i / (pd * pd)) - 1 - c, scale, rgb[0], rgb[1], rgb[2], glow);
    };
    v.voxels.begin();
    // The outer skin (and every front with a gap in it), less the cut.
    const sh = v.shellList;
    for (let k = 0; k < sh.n; k++) if (!cut || !cutAt(sh.a[k])) draw(sh.a[k]);
    if (cut) {
      // The cut's faces: buried cells next to a cut-away one. Only cells near the wedge's two walls,
      // under its floor or by the axis can be, and those are found by bearing.
      const p2 = pd * pd;
      const inner = (i: number) => {
        if (v.shellFlag[i] || !(owner[i] || prev[i]) || cutAt(i)) return;
        if (cutAt(i + 1) || cutAt(i - 1) || cutAt(i + pd) || cutAt(i - pd) || cutAt(i + p2) || cutAt(i - p2)) draw(i);
      };
      visitBearings(v.walls, az - CUT_HALF - WALL_MARGIN, az - CUT_HALF + WALL_MARGIN, inner);
      visitBearings(v.walls, az + CUT_HALF - WALL_MARGIN, az + CUT_HALF + WALL_MARGIN, inner);
      visitBearings(v.floor, az - CUT_HALF - WALL_MARGIN, az + CUT_HALF + WALL_MARGIN, inner);
      for (let k = 0; k < v.axis.length; k++) inner(v.axis[k]);
    }
    v.voxels.end();
    // The arena's outline shrinks with the rush.
    const k = s.radius / (s.r + 1);
    v.shell.scale.setScalar(Math.min(1, k) * (s.p.arena === 'sphere' ? s.r : 1));
    (v.shell.material as THREE.LineBasicMaterial).color.set(s.rushOn && !ended ? '#ffd60a' : theme.text);
    // The camera circles the arena, looking down into the cut.
    const el = 0.5 + 0.08 * Math.sin(s.t * 0.33);
    orbit(v.stage, new THREE.Vector3(0, -s.r * 0.06, 0), az, el, fitDistance(v.stage.camera, s.r * (s.p.arena === 'cube' ? 1.5 : 1.15), 0.9));
    drawStage(ctx, v.stage);
  },

  renderTop({ ctx, theme }, s) {
    const ended = s.endAt !== null;
    const precise = ended || s.matchS - s.t <= 5;
    drawShareBar(ctx, { x: 70, y: 1920 * 0.2, w: 940, h: 68, teams: s.teams, counts: Array.from(s.counts), leader: ended ? s.winner : s.leader, precise });
    const top = s.p.explain ? drawExplainer(ctx, warMode.explain(s), s.t) : null;
    if (s.p.captions) drawCaption(ctx, s.captionList, s.t, 1920 * 0.255, s.endAt);
    drawClock(ctx, { left: s.matchS - s.t, rush: s.rushOn, ended, labelY: top === null ? 1920 * 0.8 : top - 60, bigY: 1920 * 0.5 - (top === null ? 0 : EXPLAIN_LIFT), text: theme.text, stroke: theme.textStroke });
    // The one-line reminder of the rule, unless the explainer already says it.
    if (!ended && s.t > 2.9 && top === null) {
      const label = s.cyclic ? 'Each colour beats the next' : 'Outnumber to take a cell';
      outlined(ctx, theme, label, 540, 1920 * 0.8 + 70, { size: 36, weight: 800, alpha: clamp01((s.t - 2.9) / 0.5) * 0.85 });
    }
  },

  captions: (s) => s.captionList,

  explain(s) {
    const rush = s.p.finalRush ? ' In the final seconds the arena shrinks.' : '';
    if (s.cyclic) {
      const [a, b, c] = s.teams.map((tm) => tm.label);
      return `Rock-paper-scissors: ${b} takes ${a}, ${c} takes ${b}, ${a} takes ${c}. A cube can only fall to the side that beats it, once enough of them surround it.${rush}`;
    }
    return `Empty cubes join whichever colony surrounds them most; a cube on a border flips when it's outnumbered. Colonies surge and tire in waves, and late on bigger ones grow stronger.${rush}`;
  },

  audio(e, { melody, theme, lastNoteT }) {
    switch (evName(e)) {
      case 'gen': {
        const flips = e.flips as number;
        if (flips < 4) return [];
        if (e.t - lastNoteT < 0.18) return [{ kind: 'sfx', name: 'pop', vel: 0.12, pitch: 0.5 + 0.1 * (e.leader as number) }];
        const vel = velOf(flips);
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.5 : vel, voice: theme.voice }));
      }
      case 'lead':
        return [{ kind: 'sfx', name: 'chime', vel: 0.4, pitch: 0.6 }];
      case 'lastFew':
        return [{ kind: 'sfx', name: 'tick', vel: 0.6, pitch: 1.2 }];
      case 'extinct':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.55 },
          { kind: 'sfx', name: 'boom', vel: 0.5 },
        ];
      case 'rush':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6 }];
      case 'tick':
        return [{ kind: 'sfx', name: 'tick', vel: 0.7, pitch: 1 - (e.left as number) / 6 }];
      case 'end':
        return [
          { kind: 'sfx', name: 'boom', vel: 0.9 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.7, voice: 'bell' as const, dur: 2.4 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.45, voice: 'bell' as const, dur: 2.4 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const end = events.find((e) => evName(e) === 'end');
    const durFit = gaussFit(durationS, targetS, targetS * 0.22);
    if (timedOut || !end) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no finish'] };
    const matchS = end.t;
    const leads = events.filter((e) => evName(e) === 'lead');
    const swingFit = 1 - Math.exp(-leads.length / 3);
    // Comeback: the winner was at one point the smallest colony, well into the match.
    const comeback = events.some((e) => evName(e) === 'smallest' && e.side === end.winner && e.t > matchS * 0.3) ? 1 : 0;
    const extinctions = events.filter((e) => evName(e) === 'extinct');
    const decisive = extinctions.length ? extinctions[extinctions.length - 1].t : matchS;
    const lateFit = clamp01((decisive / matchS - 0.55) / 0.4);
    // A wipe-out is the satisfying ending; a buzzer finish only reads when it's close but clear.
    const endFit = end.byExtinction ? 1 : 0.4 + 0.3 * gaussFit(end.margin as number, 0.06, 0.06);
    const total = durFit * (0.2 + 0.2 * swingFit + 0.2 * comeback + 0.1 * clamp01(extinctions.length / 2) + 0.1 * lateFit + 0.2 * endFit);
    return {
      total,
      parts: { durFit, swingFit, comeback, lateFit, endFit },
      notes: [`${end.team} wins`, `${leads.length} lead changes`, end.byExtinction ? 'wipe-out' : `buzzer, margin ${((end.margin as number) * 100).toFixed(0)}%`],
    };
  },

  outcome(events) {
    const end = events.find((e) => evName(e) === 'end');
    return end ? `${end.team} ${end.byExtinction ? 'wipe-out' : 'on time'}` : null;
  },
};

/** One generation: spread into empty cells, fight at the borders, lose cells outside a shrinking arena. */
function setFront(front: Uint32Array, j: number, on: boolean) {
  if (on) front[j >>> 5] |= 1 << (j & 31);
  else front[j >>> 5] &= ~(1 << (j & 31));
}

/**
 * Queue a caption: urgent ones (a wipe-out, the rush) go up at once; others wait their turn until the
 * last one has been up long enough to read. A replaceable one (who leads) replaces an older one still
 * waiting, so it's never stale.
 */
function say(s: State, t: number, text: string, urgent: boolean, replaceable = false) {
  if (urgent) {
    const last = s.captionList[s.captionList.length - 1];
    s.captionList.push({ at: Math.max(t, last ? last.at + 0.8 : 0), text });
    s.pending = s.pending.filter((p) => !p.replaceable);
    return;
  }
  if (replaceable) s.pending = s.pending.filter((p) => !p.replaceable);
  s.pending.push({ text, replaceable });
}

/** Captions from how the match stands: the start, the arena filling up, wipe-outs, snowballing leads. */
function commentate(s: State, t: number) {
  const names = s.teams.map((tm) => tm.label);
  if (!s.captionList.length && !s.pending.length && t >= 3) {
    say(s, t, `${s.k} colonies start as small balls and spread into the empty space.`, false);
    // Rock-paper-scissors: who beats whom, next.
    if (s.cyclic) say(s, t, `Each colour can only take the one it beats: ${names[1]} takes ${names[0]}, ${names[2]} takes ${names[1]}, ${names[0]} takes ${names[2]}.`, false);
  }
  const occupied = s.counts.reduce((a, b) => a + b, 0);
  if (!s.saidFull && occupied >= s.cells.length) {
    s.saidFull = true;
    say(s, t, s.cyclic ? 'The arena is full. Now each colour eats into the one it beats, and is eaten by the one that beats it.' : 'The arena is full. Now a cell changes sides when the colony around it outnumbers its own.', false);
  }
  if (!s.cyclic && !s.saidSnowball && t >= s.matchS * 0.55 && s.out.filter((o) => !o).length > 1) {
    s.saidSnowball = true;
    say(s, t, 'From here on, bigger colonies get stronger, so a lead starts to snowball.', false);
  }
  const gone = names.filter((_, q) => s.out[q] && !s.outSaid[q]);
  if (gone.length) {
    s.out.forEach((o, q) => (s.outSaid[q] ||= o));
    const left = s.out.filter((o) => !o).length;
    say(s, t, `${listOf(gone)} ${gone.length > 1 ? 'have' : 'has'} been wiped out.${left > 1 ? ` ${left} colonies left.` : ''}`, true);
  }
  const last = s.captionList[s.captionList.length - 1];
  if (s.pending.length && (!last || t - last.at >= CAPTION_GAP)) s.captionList.push({ at: t, text: s.pending.shift()!.text });
}

/** Whether a cell (owned by o, 0 = empty) has a neighbour of another colony. */
function onFront(nb: Uint8Array[], o: number, i: number): boolean {
  for (let q = 0; q < nb.length; q++) if (q !== o - 1 && nb[q][i]) return true;
  return false;
}

/** One generation: spread into empty cells, fight at the borders, lose cells outside a shrinking arena. */
function generation(s: State, t: number, emit: StepCtx['emit']) {
  const { owner, cells, offs, k, rng, counts, front, nb, jOf } = s;
  const gen = ++s.gen;
  if (s.prev) s.prev.set(owner);
  // Rich get richer, more and more as the match goes on: early surges swing it, late ones settle it.
  const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, s.out.filter((o) => !o).length);
  const greed = s.cyclic ? 0 : GREED * clamp01(t / s.matchS) ** 2;
  const str = s.colonies.map((c, q) => strength(c, t) * (counts[q] > 0 && mean > 0 ? (counts[q] / mean) ** greed : 1));
  // Work out every change first (from this generation's owners), then apply them.
  const moves: number[] = [];
  // Front cells in index order, 32 at a time (most words are empty).
  for (let w = 0; w < front.length; w++) {
    let bits = front[w];
    while (bits) {
      const low = bits & -bits;
      bits ^= low;
      const j = w * 32 + 31 - Math.clz32(low);
      if (s.dist[j] > s.radius) continue;
      const i = cells[j];
      const o = owner[i];
      // The strongest neighbouring colony other than this cell's own (ties broken at random).
      let best = -1;
      let bestN = 0;
      for (let q = 0; q < k; q++) {
        if (q === o - 1) continue;
        // Cyclic: only a cell's predator can take it (anyone, once its predator is gone).
        if (s.cyclic && o && q !== o % 3 && !s.out[o % 3]) continue;
        const m = nb[q][i];
        if (m > bestN || (m === bestN && m > 0 && rng.chance(0.5))) {
          best = q;
          bestN = m;
        }
      }
      if (best < 0) continue;
      if (!o) {
        if (rng.chance(GROW * str[best] * Math.min(1, bestN / 3))) moves.push(j, best + 1);
        continue;
      }
      const own = nb[o - 1][i];
      const ratio = str[best] / str[o - 1];
      const p = s.cyclic && !s.out[o % 3] ? 0.3 * FIGHT * clamp01((bestN - 3) / 10) * ratio : FIGHT * clamp01((bestN - own + 5) / 16) * ratio ** 2;
      if (rng.chance(p)) moves.push(j, best + 1);
    }
  }
  // The final rush: cells outside the shrinking arena are lost (from the outside in; nothing is
  // won back out there, so each step is cleared once, the one the edge is in each generation).
  const { outward, outStart } = s;
  for (let b = s.rushStep; b < outStart.length - 1; b++) {
    let passed = true;
    for (let q = outStart[b]; q < outStart[b + 1]; q++) {
      const j = outward[q];
      if (s.dist[j] <= s.radius) passed = false;
      else if (owner[cells[j]]) moves.push(j, 0);
    }
    if (!passed) break;
    s.rushStep = b + 1;
  }
  let flips = 0;
  for (let m = 0; m < moves.length; m += 2) {
    const j0 = moves[m];
    const i = cells[j0];
    const was = owner[i];
    const now = moves[m + 1];
    if (was && now) flips++;
    if (was) counts[was - 1]--;
    if (now) counts[now - 1]++;
    owner[i] = now;
    s.changed[i] = gen;
    setFront(front, j0, onFront(nb, now, i));
    // Its neighbours' counts move, and with them whether they're on a front.
    const from = was ? nb[was - 1] : null;
    const to = now ? nb[now - 1] : null;
    for (let q = 0; q < offs.length; q++) {
      const n = i + offs[q];
      if (from) from[n]--;
      if (to) to[n]++;
      const jn = jOf[n];
      if (jn >= 0) setFront(front, jn, onFront(nb, owner[n], n));
    }
  }
  s.flips = flips;
  emit({ type: ev('war', 'gen'), gen, flips, leader: s.leader, counts: Array.from(counts) });
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  for (let q = 0; q < k; q++) {
    if (s.out[q] || counts[q] > 0) continue;
    s.out[q] = true;
    emit({ type: ev('war', 'extinct'), side: q });
  }
  // Which surviving colony is smallest now (for the comeback score), and a ring of holdouts.
  let smallest = s.smallest;
  for (let q = 0; q < k; q++) if (counts[q] > 0 && (smallest < 0 || counts[smallest] === 0 || counts[q] < counts[smallest])) smallest = q;
  if (smallest !== s.smallest) {
    s.smallest = smallest;
    emit({ type: ev('war', 'smallest'), side: smallest });
  }
  if (counts[smallest] > 0 && counts[smallest] / total < 0.03 && gen % 5 === 0) emit({ type: ev('war', 'lastFew'), side: smallest });
}

const view = sceneCache((s: State, theme) => {
  const stage = makeStage(theme, s.p.look);
  stage.lift = s.p.explain ? EXPLAIN_LIFT : 0;
  const voxels = new Voxels(stage.scene, voxelMaterial(s.p.look), s.p.look, 16384, detailFor(s.n));
  s.prev = s.owner.slice();
  // Each cell's bearing round the vertical axis, and whether it's in the upper half (for the cut).
  const c = (s.n - 1) / 2;
  const azimuth = new Float32Array(s.pd ** 3);
  const upper = new Uint8Array(s.pd ** 3);
  for (let i = 0; i < azimuth.length; i++) {
    const x = (i % s.pd) - 1 - c;
    const y = (Math.floor(i / s.pd) % s.pd) - 1 - c;
    const z = Math.floor(i / (s.pd * s.pd)) - 1 - c;
    azimuth[i] = Math.atan2(x, z);
    upper[i] = y > -1 ? 1 : 0;
  }
  // Arena cells that can border the cut, sorted by bearing: the upper half (for its two walls), the
  // layer just under it (for its floor), and those too close to the axis for bearings to mean much.
  const walls: number[] = [];
  const floor: number[] = [];
  const axis: number[] = [];
  for (const i of s.cells) {
    const x = (i % s.pd) - 1 - c;
    const z = Math.floor(i / (s.pd * s.pd)) - 1 - c;
    const underCut = !upper[i] && upper[i + s.pd];
    if (!upper[i] && !underCut) continue;
    if (x * x + z * z < AXIS_R * AXIS_R) axis.push(i);
    else (upper[i] ? walls : floor).push(i);
  }
  // Arena outline: three great circles for a sphere, the edges of a box for a cube.
  let shell: THREE.LineSegments | THREE.Group;
  const mat = new THREE.LineBasicMaterial({ color: theme.text, transparent: true, opacity: 0.25 });
  if (s.p.arena === 'sphere') {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a < 3; a++)
      for (let q = 0; q < 96; q++) {
        const t0 = (q / 96) * Math.PI * 2;
        const t1 = ((q + 1) / 96) * Math.PI * 2;
        const at = (t: number) => (a === 0 ? new THREE.Vector3(Math.cos(t), Math.sin(t), 0) : a === 1 ? new THREE.Vector3(Math.cos(t), 0, Math.sin(t)) : new THREE.Vector3(0, Math.cos(t), Math.sin(t)));
        pts.push(at(t0), at(t1));
      }
    shell = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
  } else {
    shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s.n, s.n, s.n)), mat);
  }
  stage.scene.add(shell);
  const colors = s.teams.map((tm) => linear(rgbToCss(lighten(hexToRgb(tm.color), 0.08))));
  return {
    scene: stage.scene,
    stage,
    voxels,
    shell: shell as THREE.LineSegments,
    colors,
    mix: [0, 0, 0] as [number, number, number],
    azimuth,
    upper,
    walls: byBearing(walls, azimuth),
    floor: byBearing(floor, azimuth),
    axis: Int32Array.from(axis),
    /** Occupied cells with a face open (now or last generation), rebuilt each generation. */
    shellFlag: new Uint8Array(s.pd ** 3),
    shellList: new IntList(),
    shellGen: -1,
  };
});

type View = ReturnType<typeof view>;

const BEARING_BINS = 256;
/** Cells closer than this to the vertical axis are always checked against the cut. */
const AXIS_R = 3;
/** Beyond AXIS_R, a cell and its face neighbour differ in bearing by less than this. */
const WALL_MARGIN = 0.55;

interface Bearings {
  /** Cells grouped by bearing bin: bin b holds cells[start[b] .. start[b + 1]). */
  start: Int32Array;
  cells: Int32Array;
}

function byBearing(list: number[], azimuth: Float32Array): Bearings {
  const bin = (i: number) => Math.min(BEARING_BINS - 1, Math.floor(((azimuth[i] + Math.PI) / (Math.PI * 2)) * BEARING_BINS));
  const start = new Int32Array(BEARING_BINS + 1);
  for (const i of list) start[bin(i) + 1]++;
  for (let b = 0; b < BEARING_BINS; b++) start[b + 1] += start[b];
  const fill = start.slice(0, BEARING_BINS);
  const cells = new Int32Array(list.length);
  for (const i of list) cells[fill[bin(i)]++] = i;
  return { start, cells };
}

/** Every cell with a bearing between a0 and a1 (radians, any range that's under a full turn). */
function visitBearings(b: Bearings, a0: number, a1: number, fn: (i: number) => void) {
  const toBin = (a: number) => Math.floor(((a + Math.PI) / (Math.PI * 2)) * BEARING_BINS);
  const b0 = toBin(a0);
  const b1 = toBin(a1);
  for (let k = b0; k <= b1; k++) {
    const bb = ((k % BEARING_BINS) + BEARING_BINS) % BEARING_BINS;
    for (let q = b.start[bb]; q < b.start[bb + 1]; q++) fn(b.cells[q]);
  }
}

/** The occupied cells (now or last generation) with an open face: the ones drawn even without the cut. */
function buildShell(v: View, s: State) {
  const { owner, pd, cells } = s;
  const prev = s.prev ?? owner;
  const p2 = pd * pd;
  const full = (i: number) => owner[i] !== 0 && prev[i] !== 0;
  v.shellList.n = 0;
  for (let j = 0; j < cells.length; j++) {
    const i = cells[j];
    if (!owner[i] && !prev[i]) {
      v.shellFlag[i] = 0;
      continue;
    }
    const buried = full(i) && full(i + 1) && full(i - 1) && full(i + pd) && full(i - pd) && full(i + p2) && full(i - p2);
    v.shellFlag[i] = buried ? 0 : 1;
    if (!buried) v.shellList.push(i);
  }
  v.shellGen = s.gen;
}
