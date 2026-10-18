import { z } from 'zod';
import { FONT_FAMILY, hexToRgb, lighten, rgbToCss, type DramaScore, type Rng, type StepCtx, type Template } from '@sim/engine';
import { World, clampSpeed, collideInsideCircle, reflect, type Body } from '@sim/physics';
import * as dm from '@sim/physics/math';
import { COUNTRY_TEAMS, burst, drawSparks, drawTeamBall, pickDistinctTeams, updateSparks, type Spark, type Team } from '../fx';
import { drawClock, drawShareBar } from '../hud';
import { clamp01, gaussFit } from '../scoring';

export const RPS_IDENTITIES = ['classic', 'elements', 'countries'] as const;

export const rpsBattleSchema = z.object({
  identity: z.enum(RPS_IDENTITIES).default('classic').meta({ title: 'Sides (rock-paper-scissors, elements or country flags)' }),
  perSide: z.number().int().min(8).max(40).default(20).meta({ title: 'Per side' }),
  speed: z.number().min(120).max(420).default(240).meta({ title: 'Speed', step: 5 }),
  chase: z.number().min(0).max(1).default(0.5).meta({ title: 'Hunting (0 = wander, 1 = chase prey, flee predators)', step: 0.05 }),
  arena: z.enum(['circle', 'square']).default('circle').meta({ title: 'Arena' }),
  maxSeconds: z.number().min(20).max(60).default(32).meta({ title: 'Time limit (s)', step: 0.5 }),
  finalRush: z.boolean().default(true).meta({ title: 'Final rush (faster hunting, shrinking arena)' }),
});

export type RpsBattleParams = z.infer<typeof rpsBattleSchema>;

/**
 * Side k beats side (k + 2) % 3, and loses to side (k + 1) % 3. Each identity lists its sides in
 * that cyclic order: rock beats scissors, paper beats rock, scissors beat paper.
 */
const SIDES: Record<Exclude<RpsBattleParams['identity'], 'countries'>, Team[]> = {
  classic: [
    // Halo colours, not the emoji's own: grey rock and white paper would be hard to tell apart.
    { label: 'Rock', icon: '🪨', color: '#f59e0b' },
    { label: 'Paper', icon: '📄', color: '#3b82f6' },
    { label: 'Scissors', icon: '✂️', color: '#ef4444' },
  ],
  // Fire burns leaf, water douses fire, leaf drinks water.
  elements: [
    { label: 'Fire', icon: '🔥', color: '#f97316' },
    { label: 'Water', icon: '💧', color: '#3b82f6' },
    { label: 'Leaf', icon: '🌿', color: '#22c55e' },
  ],
};
export const preyOf = (k: number) => (k + 2) % 3;

interface Unit {
  body: Body;
  side: number;
  /** Wander heading (radians). */
  heading: number;
  /** Nearest prey / predator (unit index, -1 for none), refreshed every few steps. */
  prey: number;
  predator: number;
  convertedAt: number;
}

interface State {
  p: RpsBattleParams;
  sides: Team[];
  world: World;
  units: Unit[];
  counts: number[];
  r: number;
  /** Current arena half-size: circle radius, or half the square's side. Shrinks in the final rush. */
  size: number;
  leader: number;
  leadChanges: number;
  /** The side with the fewest units left (for the comeback score). */
  smallest: number;
  lastTick: number;
  rushOn: boolean;
  endAt: number | null;
  winner: number;
  steps: number;
  t: number;
  visual: boolean;
  rng: Rng;
  fxRng: Rng;
  sparks: Spark[];
}

const CX = 540;
const CY = 1080;
const SIZE = 460;
/** The arena's half-size at the end of the final rush. */
const RUSH_SIZE = 0.72;
const RUSH_S = 6;
const OUTRO_S = 2.8;
/** A unit that just switched sides can't switch again this soon (stops pile-ups flipping back and forth). */
const IMMUNE_S = 0.25;
/** Nearest prey / predator are refreshed every this many steps. */
const SCAN_EVERY = 2;
/** Predators further than this are ignored. */
const FLEE_RANGE = 320;
/** How fast velocity turns toward the steering direction (1/s). */
const STEER = 3.5;
const WANDER = 2.6;

export const rpsBattle: Template<RpsBattleParams, State> = {
  id: 'rps-battle',
  name: 'Rock Paper Scissors Battle',
  family: 'race',
  description:
    'Three swarms (rock, paper, scissors; or fire, water, leaf; or three country flags in a rock-paper-scissors cycle) roam a round or square arena. Whenever two different sides touch, the loser switches to the winner\'s side, so swarms grow and collapse in waves. Units hunt their prey and flee their predator; a live bar shows each side\'s share, the last survivor of a side is ringed, and a final rush shrinks the arena. The match ends when one side has taken everyone, or the biggest side wins when time runs out.',
  schema: rpsBattleSchema,
  lengthParam: { param: 'maxSeconds', offsetS: OUTRO_S },
  substeps: 2,
  searchBudget: 200,
  glowScale: 0.35,
  defaultCopy: {
    hook: 'Pick a side. Who takes over?',
    cta: '{winner} wins! Did you call it?',
  },
  nudges: ['Pick a side in the comments 👇', 'Who are you backing? 👇', 'Call the winner now 👇', 'Which side are you? 👇', 'Who gets wiped out first? 👇', 'Lock in your pick 👇'],

  init({ params: p, rng, fxRng, visual }) {
    const sides = p.identity === 'countries' ? pickDistinctTeams(COUNTRY_TEAMS, 3, rng) : SIDES[p.identity];
    const r = Math.max(18, Math.min(32, 30 * Math.sqrt(20 / p.perSide)));
    const world = new World();
    world.gravity = 0;
    const units: Unit[] = [];
    const placed: { x: number; y: number }[] = [];
    for (let k = 0; k < 3; k++) {
      // Each side starts clustered in its own third of the arena, centred on its bisector.
      const mid = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      for (let j = 0; j < p.perSide; j++) {
        let x = CX;
        let y = CY;
        for (let tries = 0; tries < 60; tries++) {
          const a = mid + rng.range(-0.75, 0.75);
          const d = SIZE * rng.range(0.28, 0.86);
          x = CX + dm.cos(a) * d;
          y = CY + dm.sin(a) * d;
          if (placed.every((q) => (q.x - x) ** 2 + (q.y - y) ** 2 > (2.3 * r) ** 2)) break;
        }
        placed.push({ x, y });
        const heading = rng.range(0, Math.PI * 2);
        const body = world.addBody({ x, y, vx: dm.cos(heading) * p.speed, vy: dm.sin(heading) * p.speed, r, restitution: 0.9, friction: 0 });
        units.push({ body, side: k, heading, prey: -1, predator: -1, convertedAt: -10 });
      }
    }
    return {
      p,
      sides,
      world,
      units,
      counts: [p.perSide, p.perSide, p.perSide],
      r,
      size: SIZE,
      leader: -1,
      leadChanges: 0,
      smallest: -1,
      lastTick: -1,
      rushOn: false,
      endAt: null,
      winner: -1,
      steps: 0,
      t: 0,
      visual,
      rng,
      fxRng,
      sparks: [],
    };
  },

  step(s, { dt, t, emit }) {
    const { p, units, counts } = s;
    s.t = t + dt;
    s.steps++;
    const ended = s.endAt !== null;
    if (s.visual) s.sparks = updateSparks(s.sparks, dt, ended ? 900 : 0);

    const rush = !ended && p.finalRush && t >= p.maxSeconds - RUSH_S;
    if (rush && !s.rushOn) {
      s.rushOn = true;
      emit({ type: 'rush' });
    }
    if (rush) s.size = SIZE * (1 - (1 - RUSH_SIZE) * clamp01((t - (p.maxSeconds - RUSH_S)) / RUSH_S));
    const chase = ended ? 0 : rush ? Math.max(p.chase, 0.85) : p.chase;

    if (!ended && s.steps % SCAN_EVERY === 1) scanTargets(s);

    for (const u of units) {
      const b = u.body;
      u.heading += s.rng.range(-1, 1) * WANDER * Math.sqrt(dt) * 2;
      let dx = dm.cos(u.heading) * (1 - chase);
      let dy = dm.sin(u.heading) * (1 - chase);
      if (chase > 0) {
        if (u.prey >= 0) {
          const q = units[u.prey].body;
          const d = Math.sqrt((q.x - b.x) ** 2 + (q.y - b.y) ** 2) || 1;
          dx += (chase * (q.x - b.x)) / d;
          dy += (chase * (q.y - b.y)) / d;
        }
        if (u.predator >= 0) {
          const q = units[u.predator].body;
          const d = Math.sqrt((q.x - b.x) ** 2 + (q.y - b.y) ** 2) || 1;
          // Fleeing gets more urgent the closer the predator is.
          const w = chase * 1.3 * clamp01(1 - d / FLEE_RANGE);
          dx -= (w * (q.x - b.x)) / d;
          dy -= (w * (q.y - b.y)) / d;
        }
      }
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // A side down to its last few gets a little extra pace, so the end isn't a foregone mop-up.
      const boost = (counts[u.side] <= 3 && !ended ? 1.25 : 1) * (rush ? 1.3 : 1) * (ended ? 0.5 : 1);
      const v = p.speed * boost;
      const k = 1 - dm.exp(-STEER * dt);
      b.vx += ((dx / len) * v - b.vx) * k;
      b.vy += ((dy / len) * v - b.vy) * k;
      clampSpeed(b, v * 1.6);
    }

    s.world.step(dt, (c) => {
      if (ended || c.kind !== 'body') return;
      const a = units[c.body.id];
      const o = units[(c.other as Body).id];
      if (a.side === o.side || a.convertedAt > t - IMMUNE_S || o.convertedAt > t - IMMUNE_S) return;
      const [win, lose] = preyOf(a.side) === o.side ? [a, o] : [o, a];
      convert(s, lose, win.side, t, emit);
    });

    // Arena walls.
    for (const u of units) {
      const b = u.body;
      if (p.arena === 'circle') collideInsideCircle(b, CX, CY, s.size, 0.9);
      else {
        const lo = { x: CX - s.size + b.r, y: CY - s.size + b.r };
        const hi = { x: CX + s.size - b.r, y: CY + s.size - b.r };
        if (b.x < lo.x || b.x > hi.x) {
          const nx = b.x < lo.x ? 1 : -1;
          b.x = nx > 0 ? lo.x : hi.x;
          reflect(b, nx, 0, 0.9);
        }
        if (b.y < lo.y || b.y > hi.y) {
          const ny = b.y < lo.y ? 1 : -1;
          b.y = ny > 0 ? lo.y : hi.y;
          reflect(b, 0, ny, 0.9);
        }
      }
    }

    if (ended) {
      // Confetti in the winner's colour over the swarm.
      const since = t - s.endAt!;
      if (s.visual && since < 1.6 && Math.floor(since / 0.12) !== Math.floor((since - dt) / 0.12)) {
        const u = units[s.fxRng.int(0, units.length - 1)];
        const col = rgbToCss(lighten(hexToRgb(s.sides[s.winner].color), 0.35));
        burst(s.sparks, s.fxRng, u.body.x, u.body.y, 14, 620, () => (s.fxRng.chance(0.5) ? '#ffffff' : col), 9);
      }
      return;
    }

    let lead = 0;
    for (let k = 1; k < 3; k++) if (counts[k] > counts[lead]) lead = k;
    if (lead !== s.leader && (s.leader < 0 || counts[lead] > counts[s.leader])) {
      if (s.leader >= 0 && t > 1) {
        s.leadChanges++;
        emit({ type: 'lead', side: lead });
      }
      s.leader = lead;
    }

    const alive = counts.filter((c) => c > 0).length;
    const left = p.maxSeconds - t;
    if (alive > 1 && left <= 5 && left > 0 && Math.ceil(left) !== s.lastTick) {
      s.lastTick = Math.ceil(left);
      emit({ type: 'tick', left: s.lastTick });
    }
    if (alive === 1 || t >= p.maxSeconds) {
      s.endAt = t;
      s.winner = lead;
      const total = units.length;
      const sorted = [...counts].sort((a, b) => b - a);
      emit({ type: 'end', winner: lead, share: counts[lead] / total, margin: (sorted[0] - sorted[1]) / total, byExtinction: alive === 1 });
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const w = s.winner >= 0 ? s.sides[s.winner] : null;
    return { winner: w ? `${w.icon ? w.icon + ' ' : ''}${w.label}` : '', outro: s.endAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.13 },
    ];
  },

  render({ ctx }, s) {
    // Arena.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeStyle = s.rushOn ? 'rgba(255,214,10,0.9)' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (s.p.arena === 'circle') ctx.arc(CX, CY, s.size + 6, 0, Math.PI * 2);
    else ctx.roundRect(CX - s.size - 6, CY - s.size - 6, (s.size + 6) * 2, (s.size + 6) * 2, 28);
    ctx.fill();
    ctx.stroke();

    const flags = s.p.identity === 'countries';
    const grow = s.endAt !== null ? 1 + 0.15 * clamp01((s.t - s.endAt) / 0.5) : 1;
    for (const u of s.units) {
      const b = u.body;
      const side = s.sides[u.side];
      const r = s.r * (s.endAt !== null && u.side === s.winner ? grow : 1);
      const age = s.t - u.convertedAt;
      if (age < 0.4) {
        // Switching sides: a ring in the new side's colour bursts outward.
        const k = age / 0.4;
        ctx.strokeStyle = side.color;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 6 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * (1 + k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (s.counts[u.side] === 1 && s.endAt === null) {
        // The last of its side: a pulsing ring so viewers can follow the holdout.
        const pulse = 0.5 + 0.5 * Math.sin(s.t * 10);
        ctx.strokeStyle = `rgba(255,214,10,${0.5 + 0.5 * pulse})`;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * (1.45 + 0.15 * pulse), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (flags) {
        drawTeamBall(ctx, b.x, b.y, r, side, FONT_FAMILY);
        continue;
      }
      ctx.fillStyle = rgbToCss(hexToRgb(side.color), 0.5);
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 1.12, 0, Math.PI * 2);
      ctx.fill();
      // Squash a little on a fresh switch, so the change reads as a hit.
      const pop = age < 0.25 ? 1 + 0.35 * (1 - age / 0.25) : 1;
      ctx.font = `${Math.round(r * 1.75 * pop)}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(side.icon!, b.x, b.y + r * 0.08);
    }
    drawSparks(ctx, s.sparks);
  },

  renderTop({ ctx, theme }, s) {
    const precise = s.endAt !== null || s.p.maxSeconds - s.t <= 5;
    const top = CY - SIZE - 6;
    drawShareBar(ctx, { x: CX - SIZE, y: top - 130, w: SIZE * 2, h: 70, teams: s.sides, counts: s.counts, leader: s.endAt !== null ? s.winner : s.leader, precise });
    drawClock(ctx, { left: s.p.maxSeconds - s.t, rush: s.rushOn, ended: s.endAt !== null, labelY: CY + SIZE + 70, bigY: CY, text: theme.text, stroke: theme.textStroke });
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'convert':
        if (e.t - lastNoteT < 0.12) return [{ kind: 'sfx', name: 'pop', vel: 0.22, pitch: 0.4 + 0.25 * (e.to as number), pan }];
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.22 : 0.5, voice: theme.voice, pan }));
      case 'lastOne':
        return [{ kind: 'sfx', name: 'tick', vel: 0.6, pitch: 1.2 }];
      case 'extinct':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.6, pan },
          { kind: 'sfx', name: 'boom', vel: 0.55 },
        ];
      case 'lead':
        return [{ kind: 'sfx', name: 'chime', vel: 0.4, pitch: 0.6 }];
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
    const end = events.find((e) => e.type === 'end');
    const durFit = gaussFit(durationS, targetS, targetS * 0.22);
    if (timedOut || !end) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no finish'] };
    const matchS = end.t;
    const leads = events.filter((e) => e.type === 'lead');
    const swingFit = 1 - dm.exp(-leads.length / 3);
    // Comeback: the winner was at one point the smallest side, well into the match.
    const comeback = events.some((e) => e.type === 'smallest' && e.side === end.winner && e.t > matchS * 0.3) ? 1 : 0;
    const holdouts = events.filter((e) => e.type === 'lastOne').length;
    const holdoutFit = 1 - dm.exp(-holdouts / 1.5);
    // The last extinction (or the buzzer) landing late keeps the result open to the end.
    const extinctions = events.filter((e) => e.type === 'extinct');
    const decisive = extinctions.length ? extinctions[extinctions.length - 1].t : matchS;
    const lateFit = clamp01((decisive / matchS - 0.55) / 0.4);
    // A wipe-out is the satisfying ending; a buzzer finish only reads when it is close but clear.
    const endFit = end.byExtinction ? 1 : 0.4 + 0.3 * gaussFit(end.margin as number, 0.05, 0.05);
    const total = durFit * (0.2 + 0.2 * swingFit + 0.2 * comeback + 0.1 * holdoutFit + 0.1 * lateFit + 0.2 * endFit);
    return {
      total,
      parts: { durFit, swingFit, comeback, holdoutFit, lateFit, endFit },
      notes: [`${leads.length} lead changes`, end.byExtinction ? 'wipe-out' : `buzzer, margin ${((end.margin as number) * 100).toFixed(0)}%`, comeback ? 'comeback' : 'no comeback'],
    };
  },
};

/** Switch a unit to another side, with the count, holdout and extinction events that follow. */
function convert(s: State, u: Unit, to: number, t: number, emit: StepCtx['emit']) {
  const from = u.side;
  u.side = to;
  u.convertedAt = t;
  s.counts[from]--;
  s.counts[to]++;
  emit({ type: 'convert', from, to, x: u.body.x });
  if (s.counts[from] === 1) emit({ type: 'lastOne', side: from });
  if (s.counts[from] === 0) emit({ type: 'extinct', side: from, x: u.body.x });
  // Which surviving side is smallest now (ties keep the previous one), for the comeback score.
  let smallest = s.smallest;
  for (let k = 0; k < 3; k++) if (s.counts[k] > 0 && (smallest < 0 || s.counts[smallest] === 0 || s.counts[k] < s.counts[smallest])) smallest = k;
  if (smallest !== s.smallest) {
    s.smallest = smallest;
    emit({ type: 'smallest', side: smallest });
  }
  if (s.visual) burst(s.sparks, s.fxRng, u.body.x, u.body.y, 10, 380, s.sides[to].color, 6);
}

/** Refresh every unit's nearest prey and nearest predator (squared distances, in index order). */
function scanTargets(s: State) {
  const { units } = s;
  for (const u of units) {
    u.prey = -1;
    u.predator = -1;
  }
  const bestPrey = new Float64Array(units.length).fill(Infinity);
  const bestPred = new Float64Array(units.length).fill(Infinity);
  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      if (a.side === b.side) continue;
      const d = (a.body.x - b.body.x) ** 2 + (a.body.y - b.body.y) ** 2;
      // a hunts b (b is a's prey, so a is b's predator), or the other way round.
      const [hunter, hi, prey, pi] = preyOf(a.side) === b.side ? [a, i, b, j] : [b, j, a, i];
      if (d < bestPrey[hi]) {
        bestPrey[hi] = d;
        hunter.prey = pi;
      }
      if (d < bestPred[pi]) {
        bestPred[pi] = d;
        prey.predator = hi;
      }
    }
  }
}
