import { z } from 'zod';
import { FONT_FAMILY, hexToRgb, lighten, rgbToCss, type Ctx2D, type DramaScore, type Rng, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COLOR_TEAMS, COUNTRY_TEAMS, burst, drawSparks, drawTeamBall, pickDistinctTeams, updateSparks, type Spark, type Team } from '../fx';
import { clamp01, gaussFit } from '../scoring';

export const territoryWarSchema = z.object({
  sides: z.number().int().min(2).max(4).default(2).meta({ title: 'Teams' }),
  teams: z.enum(['colors', 'countries']).default('colors').meta({ title: 'Teams (colours or country flags)' }),
  ballsPerTeam: z.number().int().min(1).max(3).default(2).meta({ title: 'Balls per team' }),
  grid: z.number().int().min(14).max(40).default(24).meta({ title: 'Tiles per side' }),
  speed: z.number().min(400).max(1400).default(950).meta({ title: 'Ball speed', step: 10 }),
  matchSeconds: z.number().min(12).max(60).default(28).meta({ title: 'Match length (s)', step: 0.5 }),
  catchUp: z.number().min(0).max(1).default(0.45).meta({ title: 'Comeback boost (trailing teams move faster)', step: 0.05 }),
  finalRush: z.boolean().default(true).meta({ title: 'Final rush (speed up in the last seconds)' }),
});

export type TerritoryWarParams = z.infer<typeof territoryWarSchema>;

interface Ball {
  team: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  trail: { x: number; y: number }[];
}

interface State {
  p: TerritoryWarParams;
  teams: Team[];
  n: number;
  cell: number;
  owner: Uint8Array;
  /** Time each tile last flipped (visual only). */
  flippedAt: Float32Array;
  counts: number[];
  balls: Ball[];
  r: number;
  leader: number;
  leadChanges: number;
  lastTick: number;
  rushOn: boolean;
  endAt: number | null;
  winner: number;
  t: number;
  visual: boolean;
  /** Physics randomness (bounce jitter). */
  rng: Rng;
  fxRng: Rng;
  sparks: Spark[];
}

const BOARD = 900;
const X0 = (1080 - BOARD) / 2;
const Y0 = 560;
const OUTRO_S = 2.8;
const RUSH_S = 6;
const RUSH_SPEED = 1.35;
const JITTER = 0.09;
/** Keep headings away from the axes so balls never settle into a straight back-and-forth. */
const MIN_AXIS = 0.22;

/**
 * Starting territory: wedges around the centre (halves, thirds or quadrants), sized by tile count
 * rather than angle so every team starts with exactly the same share of a square board.
 */
function startingOwners(n: number, sides: number): Uint8Array {
  const c = (n - 1) / 2;
  const angle = (i: number) => {
    // Counter-clockwise from the top, so team order matches the share bar (team 0 on the left).
    const a = dm.atan2(Math.floor(i / n) - c, c - (i % n)) + Math.PI / 2;
    return (a + Math.PI * 2) % (Math.PI * 2);
  };
  const order = Array.from({ length: n * n }, (_, i) => i).sort((a, b) => angle(a) - angle(b) || a - b);
  const owner = new Uint8Array(n * n);
  order.forEach((i, rank) => (owner[i] = Math.min(sides - 1, Math.floor((rank * sides) / (n * n)))));
  return owner;
}

/** Rotate (vx, vy) by a small seeded angle and push it away from the axes, keeping speed 1. */
function nudge(b: Ball, rng: Rng) {
  const a = rng.range(-JITTER, JITTER);
  const c = dm.cos(a);
  const s = dm.sin(a);
  let vx = b.vx * c - b.vy * s;
  let vy = b.vx * s + b.vy * c;
  if (Math.abs(vx) < MIN_AXIS) vx = (vx < 0 ? -1 : 1) * MIN_AXIS;
  if (Math.abs(vy) < MIN_AXIS) vy = (vy < 0 ? -1 : 1) * MIN_AXIS;
  const d = Math.sqrt(vx * vx + vy * vy);
  b.vx = vx / d;
  b.vy = vy / d;
}

const teamName = (t: Team) => `${t.icon ? t.icon + ' ' : ''}${t.label}`;

export const territoryWar: Template<TerritoryWarParams, State> = {
  id: 'territory-war',
  name: 'Territory War',
  family: 'race',
  description:
    'Two to four teams (colours, or countries with their flags) each own part of a tiled board. Each team\'s ball bounces around inside its own territory, and every enemy tile it hits flips to its colour and bounces it back, so borders push back and forth. A live bar shows each team\'s share of the board; trailing teams get a small speed boost, and balls speed up in a final rush. When the match timer runs out, the biggest territory wins.',
  schema: territoryWarSchema,
  lengthParam: { param: 'matchSeconds', offsetS: 2.8 },
  substeps: 4,
  glowScale: 0.3,
  defaultCopy: {
    hook: 'Pick a side. Biggest territory wins!',
    cta: '{winner} wins! Who did you pick?',
  },

  init({ params: p, rng, fxRng, visual }) {
    const n = p.grid;
    const cell = BOARD / n;
    const teams = pickDistinctTeams(p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS, p.sides, rng);
    const owner = startingOwners(n, p.sides);
    const counts = new Array<number>(p.sides).fill(0);
    for (const k of owner) counts[k]++;
    const r = Math.max(9, cell * 0.42);
    const balls: Ball[] = [];
    for (let k = 0; k < p.sides; k++) {
      // Start on the bisector of the team's wedge, spread out if there are several balls.
      const mid = -Math.PI / 2 - ((k + 0.5) * Math.PI * 2) / p.sides;
      for (let j = 0; j < p.ballsPerTeam; j++) {
        const dist = BOARD * (p.sides === 2 ? 0.25 : 0.3) * (0.75 + (0.5 * (j + 1)) / (p.ballsPerTeam + 1));
        const off = (j - (p.ballsPerTeam - 1) / 2) * 0.35;
        const a = rng.range(0, Math.PI * 2);
        const b: Ball = {
          team: k,
          x: X0 + BOARD / 2 + dm.cos(mid + off) * dist,
          y: Y0 + BOARD / 2 + dm.sin(mid + off) * dist,
          vx: dm.cos(a),
          vy: dm.sin(a),
          trail: [],
        };
        nudge(b, rng);
        balls.push(b);
      }
    }
    return {
      p,
      teams,
      n,
      cell,
      owner,
      flippedAt: new Float32Array(n * n).fill(-10),
      counts,
      balls,
      r,
      leader: -1,
      leadChanges: 0,
      lastTick: -1,
      rushOn: false,
      endAt: null,
      winner: -1,
      t: 0,
      visual,
      rng,
      fxRng,
      sparks: [],
    };
  },

  step(s, { dt, t, emit }) {
    const { p, n, cell, owner, counts, r } = s;
    s.t = t + dt;
    if (s.visual) s.sparks = updateSparks(s.sparks, dt, s.endAt !== null ? 900 : 0);
    if (s.endAt !== null) {
      // Winner celebration: confetti in the winning colour over its territory.
      const since = t - s.endAt;
      if (s.visual && since < 1.5 && Math.floor(since / 0.1) !== Math.floor((since - dt) / 0.1)) {
        const tiles: number[] = [];
        for (let i = 0; i < n * n; i += 7) if (owner[i] === s.winner) tiles.push(i);
        const i = tiles.length ? tiles[s.fxRng.int(0, tiles.length - 1)] : 0;
        const col = lighten(hexToRgb(s.teams[s.winner].color), 0.35);
        burst(s.sparks, s.fxRng, X0 + ((i % n) + 0.5) * cell, Y0 + (Math.floor(i / n) + 0.5) * cell, 16, 620, () => (s.fxRng.chance(0.5) ? '#ffffff' : rgbToCss(col)), 9);
      }
      return;
    }

    const total = n * n;
    const fair = 1 / p.sides;
    const rush = p.finalRush && t >= p.matchSeconds - RUSH_S;
    if (rush && !s.rushOn) {
      s.rushOn = true;
      emit({ type: 'rush' });
    }
    for (const b of s.balls) {
      const share = counts[b.team] / total;
      const boost = Math.max(0.75, Math.min(1.6, 1 + (p.catchUp * (fair - share)) / fair));
      const v = p.speed * boost * (rush ? RUSH_SPEED : 1);
      b.x += b.vx * v * dt;
      b.y += b.vy * v * dt;
      // Board edges.
      if (b.x < X0 + r) {
        b.x = X0 + r;
        b.vx = Math.abs(b.vx);
      } else if (b.x > X0 + BOARD - r) {
        b.x = X0 + BOARD - r;
        b.vx = -Math.abs(b.vx);
      }
      if (b.y < Y0 + r) {
        b.y = Y0 + r;
        b.vy = Math.abs(b.vy);
      } else if (b.y > Y0 + BOARD - r) {
        b.y = Y0 + BOARD - r;
        b.vy = -Math.abs(b.vy);
      }
      // Probe the four points of the ball facing each axis direction; an enemy tile there flips
      // to this team and bounces the ball back along that axis.
      let bounced = false;
      for (let d = 0; d < 4; d++) {
        const cx = d === 0 ? 1 : d === 1 ? -1 : 0;
        const cy = d === 2 ? 1 : d === 3 ? -1 : 0;
        if ((cx !== 0 && Math.sign(b.vx) !== cx) || (cy !== 0 && Math.sign(b.vy) !== cy)) continue;
        const gx = Math.floor((b.x + cx * r - X0) / cell);
        const gy = Math.floor((b.y + cy * r - Y0) / cell);
        if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
        const i = gy * n + gx;
        const prev = owner[i];
        if (prev === b.team) continue;
        owner[i] = b.team;
        counts[prev]--;
        counts[b.team]++;
        s.flippedAt[i] = t;
        if (cx) b.vx = -b.vx;
        else b.vy = -b.vy;
        bounced = true;
        emit({ type: 'flip', team: b.team, from: prev, x: X0 + (gx + 0.5) * cell, y: Y0 + (gy + 0.5) * cell });
        if (s.visual) burst(s.sparks, s.fxRng, X0 + (gx + 0.5) * cell, Y0 + (gy + 0.5) * cell, 4, 260, s.teams[b.team].color, 5);
      }
      if (bounced) nudge(b, s.rng);
    }

    // Lead changes (ignoring the first second while the board is still even).
    let lead = 0;
    for (let k = 1; k < p.sides; k++) if (counts[k] > counts[lead]) lead = k;
    if (lead !== s.leader && (s.leader < 0 || counts[lead] > counts[s.leader])) {
      if (s.leader >= 0 && t > 1) {
        s.leadChanges++;
        emit({ type: 'lead', team: lead });
      }
      s.leader = lead;
    }

    const left = p.matchSeconds - t;
    if (left <= 5 && left > 0 && Math.ceil(left) !== s.lastTick) {
      s.lastTick = Math.ceil(left);
      emit({ type: 'tick', left: s.lastTick });
    }
    if (t >= p.matchSeconds) {
      s.endAt = t;
      s.winner = lead;
      const sorted = [...counts].sort((a, b) => b - a);
      emit({ type: 'end', winner: lead, share: counts[lead] / total, margin: (sorted[0] - sorted[1]) / total });
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    return { winner: s.winner >= 0 ? teamName(s.teams[s.winner]) : '', outro: s.endAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.13 },
    ];
  },

  render({ ctx }, s) {
    const { n, cell, owner, teams } = s;
    const fills = teams.map((tm) => tm.color);
    const flashes = teams.map((tm) => rgbToCss(lighten(hexToRgb(tm.color), 0.6)));
    // Board.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.roundRect(X0 - 14, Y0 - 14, BOARD + 28, BOARD + 28, 26);
    ctx.fill();
    for (let gy = 0; gy < n; gy++) {
      for (let gx = 0; gx < n; gx++) {
        const i = gy * n + gx;
        const age = s.t - s.flippedAt[i];
        const x = X0 + gx * cell;
        const y = Y0 + gy * cell;
        if (age < 0.35) {
          // Fresh flip: flash bright and pop in from slightly smaller.
          const k = age / 0.35;
          const inset = (1 - k) * cell * 0.18;
          ctx.fillStyle = k < 0.5 ? flashes[owner[i]] : fills[owner[i]];
          ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
        } else {
          ctx.fillStyle = fills[owner[i]];
          ctx.fillRect(x, y, cell + 0.5, cell + 0.5);
        }
      }
    }
    if (s.p.teams === 'countries') drawFlagWash(ctx, s);
    if (s.endAt !== null) {
      // Losing territory dims so the winner's area pops.
      const a = clamp01((s.t - s.endAt) / 0.5) * 0.5;
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      for (let i = 0; i < n * n; i++) if (owner[i] !== s.winner) ctx.fillRect(X0 + (i % n) * cell, Y0 + Math.floor(i / n) * cell, cell + 0.5, cell + 0.5);
    }
    // Faint tile grid.
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 1; k < n; k++) {
      ctx.moveTo(X0 + k * cell, Y0);
      ctx.lineTo(X0 + k * cell, Y0 + BOARD);
      ctx.moveTo(X0, Y0 + k * cell);
      ctx.lineTo(X0 + BOARD, Y0 + k * cell);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 4;
    ctx.strokeRect(X0 - 2, Y0 - 2, BOARD + 4, BOARD + 4);

    // Trails.
    for (const b of s.balls) {
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 10) b.trail.shift();
      b.trail.forEach((pt, k) => {
        ctx.fillStyle = `rgba(255,255,255,${(0.28 * (k + 1)) / b.trail.length})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, s.r * (0.4 + (0.5 * (k + 1)) / b.trail.length), 0, Math.PI * 2);
        ctx.fill();
      });
    }
    drawSparks(ctx, s.sparks);
  },

  renderTop({ ctx, theme }, s) {
    // Drawn larger than the collision probe so balls read at phone size.
    const vr = Math.max(18, Math.min(s.cell * 0.66, s.r * 1.45));
    for (const b of s.balls) {
      const tm = s.teams[b.team];
      // The ball is its territory's colour, so a dark halo keeps it visible.
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, vr * 1.3, 0, Math.PI * 2);
      ctx.fill();
      drawTeamBall(ctx, b.x, b.y, vr, tm, FONT_FAMILY, { initial: vr > 20 });
    }
    drawShareBar(ctx, s);
    drawClock(ctx, s, theme.text, theme.textStroke);
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'flip':
        if (e.t - lastNoteT < 0.11) return [{ kind: 'sfx', name: 'tick', vel: 0.14, pitch: 0.3 + 0.2 * (e.team as number), pan }];
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.22 : 0.48, voice: theme.voice, pan }));
      case 'lead':
        return [{ kind: 'sfx', name: 'chime', vel: 0.45, pitch: 0.6 }];
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
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    if (timedOut || !end) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no finish'] };
    const matchS = end.t;
    const leads = events.filter((e) => e.type === 'lead');
    // A close finish that is still visibly decided (a 1–4% margin reads as "so close!").
    const margin = end.margin as number;
    const closeFit = margin < 0.004 ? 0.6 : gaussFit(margin, 0.025, 0.035);
    // Lead changes keep people watching; diminishing returns past ~5.
    const swingFit = 1 - dm.exp(-leads.length / 2.5);
    // The last lead change landing late keeps the result open to the end.
    const lastLead = leads.length ? leads[leads.length - 1].t / matchS : 0;
    const lateFit = clamp01((lastLead - 0.3) / 0.55);
    const flips = events.filter((e) => e.type === 'flip').length;
    const busyFit = clamp01(flips / (matchS * 6));
    const total = durFit * (0.25 + 0.3 * closeFit + 0.2 * swingFit + 0.15 * lateFit + 0.1 * busyFit);
    return {
      total,
      parts: { durFit, closeFit, swingFit, lateFit, busyFit },
      notes: [`margin ${(margin * 100).toFixed(1)}%`, `${leads.length} lead changes`, `last at ${(lastLead * 100).toFixed(0)}%`],
    };
  },
};

/** Country mode: each territory carries a faint, board-sized flag so the map reads as nations. */
function drawFlagWash(ctx: Ctx2D, s: State) {
  const { n, cell, owner } = s;
  s.teams.forEach((tm, k) => {
    if (!tm.icon || s.counts[k] === 0) return;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < n * n; i++) if (owner[i] === k) ctx.rect(X0 + (i % n) * cell, Y0 + Math.floor(i / n) * cell, cell + 0.5, cell + 0.5);
    ctx.clip();
    ctx.globalAlpha = 0.42;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(BOARD * 1.25)}px ${FONT_FAMILY}`;
    ctx.fillText(tm.icon, X0 + BOARD / 2, Y0 + BOARD / 2 + BOARD * 0.08);
    ctx.restore();
  });
}

/** Live share of the board per team, with the leader crowned. */
function drawShareBar(ctx: Ctx2D, s: State) {
  const total = s.n * s.n;
  const y = Y0 - 120;
  const h = 70;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(X0 - 8, y - 8, BOARD + 16, h + 16, 22);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(X0, y, BOARD, h, 16);
  ctx.clip();
  let x = X0;
  const lead = s.endAt !== null ? s.winner : s.leader;
  s.teams.forEach((tm, k) => {
    const w = (s.counts[k] / total) * BOARD;
    ctx.fillStyle = tm.color;
    ctx.fillRect(x, y, w + 0.5, h);
    if (w > 90) {
      // One decimal in the final seconds and at the end, so a close finish reads as a real result.
      const precise = s.endAt !== null || s.p.matchSeconds - s.t <= 5;
      const pct = `${((s.counts[k] / total) * 100).toFixed(precise ? 1 : 0)}%`;
      const label = `${k === lead ? '👑 ' : ''}${tm.icon ?? ''} ${pct}`.trim();
      ctx.font = `900 ${w > 200 ? 36 : 28}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(label, x + w / 2, y + h / 2 + 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + w / 2, y + h / 2 + 2);
    }
    x += w;
  });
  ctx.restore();
}

/** Time left under the board, and a big countdown over it in the last five seconds. */
function drawClock(ctx: Ctx2D, s: State, text: string, stroke: string) {
  const left = Math.max(0, s.p.matchSeconds - s.t);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (s.endAt === null) {
    const label = s.rushOn ? `⚡ FINAL RUSH · ${left.toFixed(1)}s` : `${Math.ceil(left)}s left`;
    ctx.font = `900 44px ${FONT_FAMILY}`;
    ctx.lineWidth = 9;
    ctx.strokeStyle = stroke;
    ctx.strokeText(label, 540, Y0 + BOARD + 62);
    ctx.fillStyle = text;
    ctx.fillText(label, 540, Y0 + BOARD + 62);
  }
  if (s.endAt === null && left <= 5 && left > 0) {
    const frac = left - Math.floor(left);
    ctx.globalAlpha = 0.55 + 0.4 * frac;
    ctx.font = `900 ${Math.round(260 + 120 * frac)}px ${FONT_FAMILY}`;
    ctx.lineWidth = 16;
    ctx.strokeStyle = stroke;
    ctx.strokeText(String(Math.ceil(left)), 540, Y0 + BOARD / 2);
    ctx.fillStyle = text;
    ctx.fillText(String(Math.ceil(left)), 540, Y0 + BOARD / 2);
  }
  ctx.restore();
}
