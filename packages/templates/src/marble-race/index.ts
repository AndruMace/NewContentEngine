import { z } from 'zod';
import { FONT_FAMILY, paletteAt, rgbToCss, type DramaScore, type LeaderboardRow, type Rng, type SimEvent, type Template } from '@sim/engine';
import { hypot, World, type Body, type Contact, type Disc, type Segment } from '@sim/physics';
import { clamp01, gaussFit, mean } from '../scoring';
import { COLOR_TEAMS, COUNTRY_TEAMS, burst, drawSparks, drawTeamBall, pickTeams, updateSparks, type Spark, type Team } from '../fx';
import * as dm from '@sim/physics/math';

export const marbleRaceSchema = z.object({
  marbleCount: z.number().int().min(3).max(16).default(8).meta({ title: 'Marbles' }),
  mode: z.enum(['elimination', 'race']).default('elimination').meta({ title: 'Mode' }),
  teams: z.enum(['countries', 'colors']).default('countries').meta({ title: 'Teams' }),
  raceSections: z.number().int().min(2).max(10).default(5).meta({ title: 'Sections (race mode)' }),
  maxEliminationSections: z.number().int().min(2).max(10).default(7).meta({ title: 'Max sections (elimination)' }),
  sectionHeight: z.number().min(700).max(1600).default(1050).meta({ title: 'Section height', step: 10 }),
  marbleRadius: z.number().min(14).max(40).default(32).meta({ title: 'Marble radius' }),
  gravity: z.number().min(600).max(2500).default(1300).meta({ title: 'Gravity', step: 50 }),
  bounciness: z.number().min(0.1).max(0.9).default(0.5).meta({ title: 'Bounciness', step: 0.05 }),
  spinnerSpeed: z.number().min(0.5).max(5).default(2.2).meta({ title: 'Spinner speed', step: 0.1 }),
  obstacleDensity: z.number().min(0.5).max(1.5).default(1).meta({ title: 'Obstacle density', step: 0.05 }),
});

export type MarbleRaceParams = z.infer<typeof marbleRaceSchema>;

type SectionKind = 'pegs' | 'spinners' | 'zigzag' | 'funnel' | 'bumpers';

interface Marble {
  body: Body;
  team: Team;
  passed: number;
  out: boolean;
  outAt: number;
  finishedAt: number;
  bestY: number;
  lastProgressT: number;
  lastHitT: number;
}

interface State {
  p: MarbleRaceParams;
  world: World;
  marbles: Marble[];
  sections: { kind: SectionKind; y0: number; y1: number }[];
  checkpoints: number[];
  /** Number of marbles to eliminate at each checkpoint (elimination mode). */
  cuts: number[];
  nextCheckpoint: number;
  gate: Segment;
  gateOpen: boolean;
  bumpers: (Disc & { flash: number })[];
  leader: number;
  leaderSince: number;
  finishOrder: number[];
  winner: number;
  endAt: number | null;
  t: number;
  camY: number;
  visual: boolean;
  rng: Rng;
  fxRng: Rng;
  sparks: Spark[];
  lastAnyHitT: number;
}

const L = 70;
const R = 1010;
const W = R - L;
const GATE_OPEN_S = 0.8;
const OUTRO_S = 2.6;

function buildSection(world: World, kind: SectionKind, y0: number, h: number, p: MarbleRaceParams, rng: Rng, bumpers: State['bumpers']) {
  const e = 0.5;
  const dens = p.obstacleDensity;
  switch (kind) {
    case 'pegs': {
      const dy = 92 / Math.sqrt(dens);
      const dx = Math.max(p.marbleRadius * 2 + 40, 104 / Math.sqrt(dens));
      let row = 0;
      for (let y = y0 + 150; y < y0 + h - 160; y += dy, row++) {
        const off = row % 2 ? dx / 2 : 0;
        for (let x = L + 50 + off; x < R - 40; x += dx) world.addDisc({ x, y, r: 9, restitution: e, tag: 'peg' });
      }
      break;
    }
    case 'spinners': {
      const rows = Math.max(2, Math.round((h - 300) / 300));
      for (let i = 0; i < rows; i++) {
        const y = y0 + 220 + (i * (h - 420)) / Math.max(1, rows - 1);
        const n = i % 2 ? 2 : 3;
        const spacing = W / n;
        for (let k = 0; k < n; k++) {
          const cx = L + spacing * (k + 0.5);
          const arm = spacing * 0.42;
          const dir = (i + k) % 2 ? -1 : 1;
          world.addSpinner(cx, y, -arm, arm, rng.range(0, Math.PI), dir * p.spinnerSpeed * rng.range(0.8, 1.2), { r: 8, tag: 'spinner', restitution: 0.6 });
          world.addDisc({ x: cx, y, r: 12, tag: 'hub' });
        }
      }
      break;
    }
    case 'zigzag': {
      const gap = 250;
      const count = Math.max(2, Math.floor((h - 250) / gap));
      const start = rng.chance(0.5) ? 0 : 1;
      for (let i = 0; i < count; i++) {
        const y = y0 + 160 + i * gap;
        const left = (i + start) % 2 === 0;
        const reach = W * 0.74;
        const drop = 110;
        if (left) world.addSegment({ ax: L, ay: y, bx: L + reach, by: y + drop, r: 7, restitution: 0.3, tag: 'ramp' });
        else world.addSegment({ ax: R, ay: y, bx: R - reach, by: y + drop, r: 7, restitution: 0.3, tag: 'ramp' });
      }
      break;
    }
    case 'funnel': {
      const gap = p.marbleRadius * 2 * 1.75;
      const top = y0 + 150;
      const neck = y0 + Math.min(560, h * 0.5);
      world.addSegment({ ax: L, ay: top, bx: 540 - gap / 2, by: neck, r: 8, restitution: 0.3, tag: 'ramp' });
      world.addSegment({ ax: R, ay: top, bx: 540 + gap / 2, by: neck, r: 8, restitution: 0.3, tag: 'ramp' });
      const by = neck + 180;
      for (const [x, y] of [
        [540, by],
        [540 - 170, by + 160],
        [540 + 170, by + 160],
      ]) {
        if (y < y0 + h - 140) bumpers.push(Object.assign(world.addDisc({ x, y, r: 44, restitution: 0.8, kick: 260, tag: 'bumper' }), { flash: 0 }));
      }
      break;
    }
    case 'bumpers': {
      const placed: [number, number, number][] = [];
      const target = Math.round(6 * dens);
      for (let tries = 0; placed.length < target && tries < 200; tries++) {
        const r = rng.range(36, 58);
        const x = rng.range(L + r + 50, R - r - 50);
        const y = rng.range(y0 + 180 + r, y0 + h - 180 - r);
        if (placed.every(([px, py, pr]) => hypot(px - x, py - y) > pr + r + p.marbleRadius * 2.6)) {
          placed.push([x, y, r]);
          bumpers.push(Object.assign(world.addDisc({ x, y, r, restitution: 0.8, kick: 240, tag: 'bumper' }), { flash: 0 }));
        }
      }
      break;
    }
  }
}

function sectionCuts(n: number, sections: number): number[] {
  const total = n - 1;
  return Array.from({ length: sections }, (_, j) => Math.floor((total * (j + 1)) / sections) - Math.floor((total * j) / sections));
}

function aliveSorted(s: State): number[] {
  return s.marbles
    .map((m, i) => i)
    .filter((i) => !s.marbles[i].out && s.marbles[i].finishedAt < 0)
    .sort((a, b) => s.marbles[b].body.y - s.marbles[a].body.y || a - b);
}

function eliminate(s: State, i: number, cp: number, t: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  const m = s.marbles[i];
  m.out = true;
  m.outAt = t;
  m.body.alive = false;
  emit({ type: 'eliminate', who: i, cp, margin: Math.max(0, s.checkpoints[cp] - m.body.y), x: m.body.x });
  if (s.visual) burst(s.sparks, s.fxRng, m.body.x, m.body.y, 50, 900, m.team.color, 9);
}

export const marbleRace: Template<MarbleRaceParams, State> = {
  id: 'marble-race',
  name: 'Marble Race',
  family: 'race',
  description:
    'Marbles race down a procedurally built course of pegs, spinners, ramps, funnels and bumpers. In elimination mode the last marble(s) past each checkpoint are knocked out until one remains.',
  schema: marbleRaceSchema,
  substeps: 4,
  defaultCopy: {
    hook: 'Pick a marble before the race starts!',
    cta: '{winner} wins! Did you call it?',
  },

  init({ params: p, rng, fxRng, visual }) {
    const world = new World();
    world.gravity = p.gravity;
    const teams = pickTeams(p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS, p.marbleCount, rng);
    const nSections = p.mode === 'elimination' ? Math.min(p.marbleCount - 1, p.maxEliminationSections) : p.raceSections;
    const kinds: SectionKind[] = ['pegs', 'spinners', 'zigzag', 'funnel', 'bumpers'];
    const sections: State['sections'] = [];
    const bumpers: State['bumpers'] = [];
    let prev: SectionKind | null = null;
    for (let i = 0; i < nSections; i++) {
      const options = kinds.filter((k) => k !== prev);
      const kind = rng.pick(options);
      const y0 = i * p.sectionHeight;
      buildSection(world, kind, y0, p.sectionHeight, p, rng, bumpers);
      sections.push({ kind, y0, y1: y0 + p.sectionHeight });
      prev = kind;
    }
    const end = nSections * p.sectionHeight;
    // Side walls, start gate, and a catch floor below the last section.
    world.addSegment({ ax: L, ay: -900, bx: L, by: end + 1200, r: 10, tag: 'wall', restitution: 0.4 });
    world.addSegment({ ax: R, ay: -900, bx: R, by: end + 1200, r: 10, tag: 'wall', restitution: 0.4 });
    world.addSegment({ ax: L, ay: end + 900, bx: R, by: end + 900, r: 10, tag: 'floor', restitution: 0.2 });
    const gate = world.addSegment({ ax: L, ay: -60, bx: R, by: -60, r: 8, tag: 'gate', restitution: 0.1 });

    const r = p.marbleRadius;
    const perRow = Math.floor((W - 40) / (r * 2.3));
    const marbles: Marble[] = teams.map((team, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const inRow = Math.min(perRow, teams.length - row * perRow);
      const x = 540 + (col - (inRow - 1) / 2) * r * 2.3 + rng.range(-4, 4);
      const body = world.addBody({ x, y: -60 - 8 - r - row * r * 2.2, vx: 0, vy: 0, r, restitution: p.bounciness, friction: 0.04 });
      return { body, team, passed: 0, out: false, outAt: -1, finishedAt: -1, bestY: body.y, lastProgressT: 0, lastHitT: -1 };
    });

    return {
      p,
      world,
      marbles,
      sections,
      checkpoints: sections.map((s) => s.y1),
      cuts: p.mode === 'elimination' ? sectionCuts(p.marbleCount, nSections) : [],
      nextCheckpoint: 0,
      gate,
      gateOpen: false,
      bumpers,
      leader: -1,
      leaderSince: 0,
      finishOrder: [],
      winner: -1,
      endAt: null,
      t: 0,
      camY: 300,
      visual,
      rng,
      fxRng,
      sparks: [],
      lastAnyHitT: -1,
    };
  },

  step(s, { dt, t, emit }) {
    const { p } = s;
    if (!s.gateOpen && t >= GATE_OPEN_S) {
      s.gateOpen = true;
      s.gate.active = false;
      emit({ type: 'gate' });
    }

    s.world.step(dt, (c: Contact) => {
      const m = s.marbles.find((mm) => mm.body === c.body);
      if (!m || c.impulse < 140) return;
      const tag = c.kind === 'body' ? 'marble' : (c.other as Segment | Disc).tag;
      if (tag === 'bumper') (c.other as State['bumpers'][number]).flash = 1;
      if (t - m.lastHitT < 0.07 || (tag !== 'bumper' && t - s.lastAnyHitT < 0.03)) return;
      m.lastHitT = t;
      s.lastAnyHitT = t;
      emit({ type: 'hit', tag, impulse: c.impulse, x: c.x, y: c.y });
      if (s.visual && tag === 'bumper') burst(s.sparks, s.fxRng, c.x, c.y, 8, 300, m.team.color, 5);
    });

    // Unstick: a marble that hasn't made progress for a while gets a nudge.
    s.marbles.forEach((m, i) => {
      if (m.out || m.finishedAt >= 0 || !s.gateOpen) return;
      if (m.body.y > m.bestY + 15) {
        m.bestY = m.body.y;
        m.lastProgressT = t;
      } else if (t - m.lastProgressT > 2.2) {
        m.body.vx = s.rng.range(-420, 420);
        m.body.vy = -s.rng.range(250, 450);
        m.lastProgressT = t;
        emit({ type: 'kick', who: i });
      }
    });

    if (s.winner < 0) {
      // Checkpoint progress.
      for (const m of s.marbles) {
        while (!m.out && m.passed < s.checkpoints.length && m.body.y - m.body.r > s.checkpoints[m.passed]) m.passed++;
      }
      if (p.mode === 'elimination') {
        const cp = s.nextCheckpoint;
        if (cp < s.checkpoints.length) {
          const alive = s.marbles.filter((m) => !m.out);
          const through = alive.filter((m) => m.passed > cp);
          if (through.length === 1 && cp === 0 && alive.length > 0) emit({ type: 'checkpoint', cp });
          if (through.length >= alive.length - s.cuts[cp]) {
            const losers = alive.map((m) => s.marbles.indexOf(m)).filter((i) => s.marbles[i].passed <= cp);
            losers.forEach((i) => eliminate(s, i, cp, t, emit));
            s.nextCheckpoint++;
            if (s.nextCheckpoint < s.checkpoints.length) emit({ type: 'checkpoint', cp: s.nextCheckpoint });
          }
        }
        const remaining = s.marbles.map((m, i) => i).filter((i) => !s.marbles[i].out);
        if (remaining.length === 1) {
          s.winner = remaining[0];
          s.endAt = t;
          emit({ type: 'win', who: s.winner, x: s.marbles[s.winner].body.x });
        }
      } else {
        const finishY = s.checkpoints[s.checkpoints.length - 1];
        s.marbles.forEach((m, i) => {
          if (m.finishedAt < 0 && m.body.y - m.body.r > finishY) {
            m.finishedAt = t;
            s.finishOrder.push(i);
            emit({ type: 'finish', who: i, place: s.finishOrder.length, x: m.body.x });
            if (s.finishOrder.length === 1) {
              s.winner = i;
              s.endAt = t;
              emit({ type: 'win', who: i, x: m.body.x });
            }
          }
        });
      }

      const order = aliveSorted(s);
      if (s.gateOpen && order.length && order[0] !== s.leader) {
        if (s.leader >= 0 && t - s.leaderSince > 0.4) emit({ type: 'leadChange', from: s.leader, to: order[0] });
        s.leader = order[0];
        s.leaderSince = t;
      }
    }
    s.t = t + dt;

    // Camera: frame the whole pack if it fits, otherwise watch the back (that's where eliminations happen).
    const live = s.marbles.filter((m) => !m.out);
    const focus = s.winner >= 0 ? [s.marbles[s.winner]] : live;
    const ys = focus.map((m) => m.body.y);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const target = s.winner >= 0 ? hi - 260 : hi - lo < 1300 ? (lo + hi) / 2 + 120 : lo + 500;
    s.camY += (target - s.camY) * (1 - dm.exp(-4 * dt));

    if (s.visual) {
      s.sparks = updateSparks(s.sparks, dt, 1200);
      for (const b of s.bumpers) b.flash *= dm.exp(-8 * dt);
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const rows: LeaderboardRow[] = [];
    const team = (i: number) => s.marbles[i].team;
    for (const i of s.finishOrder) rows.push({ label: team(i).label, color: team(i).color, icon: team(i).icon });
    for (const i of aliveSorted(s)) rows.push({ label: team(i).label, color: team(i).color, icon: team(i).icon });
    const outs = s.marbles
      .map((m, i) => i)
      .filter((i) => s.marbles[i].out)
      .sort((a, b) => s.marbles[b].outAt - s.marbles[a].outAt);
    for (const i of outs) rows.push({ label: team(i).label, color: team(i).color, icon: team(i).icon, out: true });
    const w = s.winner >= 0 ? team(s.winner) : null;
    return {
      standings: rows,
      alive: s.marbles.filter((m) => !m.out).length,
      winner: w ? `${w.icon ? w.icon + ' ' : ''}${w.label}` : '',
      outro: s.winner >= 0,
    };
  },

  overlays(p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'leaderboard', key: 'standings', title: p.mode === 'elimination' ? 'STILL IN' : 'STANDINGS', max: 8, x: 28, y: 0.15 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.43 },
    ];
  },

  render({ ctx, theme, height }, s) {
    const top = s.camY - height / 2;
    const bottom = s.camY + height / 2;
    ctx.save();
    ctx.translate(0, -top);

    // Section bands and checkpoint lines.
    s.sections.forEach((sec, i) => {
      if (sec.y1 < top || sec.y0 > bottom) return;
      ctx.fillStyle = rgbToCss(paletteAt(theme.palette, i / Math.max(1, s.sections.length - 1)), 0.05);
      ctx.fillRect(L, sec.y0, W, sec.y1 - sec.y0);
    });
    s.checkpoints.forEach((y, i) => {
      if (y < top - 50 || y > bottom + 50) return;
      const done = s.p.mode === 'elimination' ? i < s.nextCheckpoint : false;
      const isFinish = s.p.mode === 'race' && i === s.checkpoints.length - 1;
      ctx.strokeStyle = done ? 'rgba(255,255,255,0.25)' : isFinish ? '#ffffff' : theme.accent;
      ctx.lineWidth = 6;
      ctx.setLineDash([22, 16]);
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(R, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `900 30px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = done ? 'rgba(255,255,255,0.35)' : theme.accent;
      const label = isFinish ? 'FINISH' : s.p.mode === 'elimination' ? `ELIMINATION ${i + 1}/${s.checkpoints.length}` : `CHECKPOINT ${i + 1}`;
      ctx.fillText(label, 540, y + 36);
    });

    // Level geometry.
    ctx.lineCap = 'round';
    s.world.segments.forEach((seg, i) => {
      if (!seg.active || Math.max(seg.ay, seg.by) < top - 40 || Math.min(seg.ay, seg.by) > bottom + 40) return;
      const u = clamp01((seg.ay - s.sections[0].y0) / Math.max(1, s.checkpoints[s.checkpoints.length - 1]));
      ctx.strokeStyle = seg.tag === 'spinner' ? theme.accent : seg.tag === 'wall' ? rgbToCss(paletteAt(theme.palette, 0.85)) : rgbToCss(paletteAt(theme.palette, u));
      ctx.lineWidth = seg.r * 2;
      ctx.beginPath();
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
      ctx.stroke();
      void i;
    });
    for (const d of s.world.discs) {
      if (d.y < top - 80 || d.y > bottom + 80) continue;
      const u = clamp01(d.y / Math.max(1, s.checkpoints[s.checkpoints.length - 1]));
      const col = paletteAt(theme.palette, u);
      if (d.tag === 'bumper') {
        const flash = (d as State['bumpers'][number]).flash ?? 0;
        ctx.fillStyle = rgbToCss(col, 0.25 + flash * 0.5);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r * (1 + flash * 0.08), 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = rgbToCss(col);
        ctx.stroke();
      } else {
        ctx.fillStyle = d.tag === 'hub' ? theme.accent : rgbToCss(col);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawSparks(ctx, s.sparks);
    for (const m of s.marbles) {
      if (m.out) continue;
      const b = m.body;
      if (b.y < top - 60 || b.y > bottom + 60) continue;
      drawTeamBall(ctx, b.x, b.y, b.r, m.team, FONT_FAMILY);
    }
    if (s.winner >= 0) {
      const b = s.marbles[s.winner].body;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      const pulse = 1.4 + 0.25 * dm.sin(s.t * 10);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'hit': {
        const v = clamp01((e.impulse as number) / 900);
        if (e.tag === 'bumper') {
          const out: ReturnType<NonNullable<Template['audio']>> = [{ kind: 'sfx', name: 'pop', vel: 0.5 + 0.4 * v, pan }];
          if (e.t - lastNoteT >= 0.08) out.push(...melody.next().map((midi) => ({ kind: 'note' as const, midi, vel: 0.6, voice: theme.voice, pan })));
          return out;
        }
        if (e.t - lastNoteT >= 0.11 && v > 0.15) {
          return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: (0.4 + 0.5 * v) * (i ? 0.45 : 1), voice: theme.voice, pan }));
        }
        return [{ kind: 'sfx', name: 'tick', vel: 0.1 + 0.25 * v, pan }];
      }
      case 'gate':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6 }];
      case 'checkpoint':
        return [];
      case 'eliminate':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.7, pan },
          { kind: 'sfx', name: 'boom', vel: 0.45 },
        ];
      case 'finish':
        return [{ kind: 'sfx', name: 'chime', vel: 0.5, pitch: 1 - (e.place as number) / 10, pan }];
      case 'win':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          { kind: 'sfx', name: 'whoosh', vel: 0.7 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const win = events.find((e) => e.type === 'win');
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    const leadChanges = events.filter((e) => e.type === 'leadChange');
    const lcFit = clamp01(leadChanges.length / 8);
    const elims = events.filter((e) => e.type === 'eliminate');
    const closeFit = elims.length ? mean(elims.map((e) => dm.exp(-(e.margin as number) / 500))) : 0.6;
    const kicks = events.filter((e) => e.type === 'kick').length;
    const kickFit = dm.exp(-kicks / 5);
    // Comeback: whoever led at the halfway point did not win.
    const half = win.t / 2;
    const leaderAtHalf = [...leadChanges].reverse().find((e) => e.t <= half)?.to;
    const comeback = leaderAtHalf !== undefined && leaderAtHalf !== win.who ? 1 : 0.4;
    const total = durFit * (0.45 + 0.55 * lcFit) * (0.5 + 0.5 * closeFit) * (0.4 + 0.6 * kickFit) * (0.75 + 0.25 * comeback);
    return {
      total,
      parts: { durFit, lcFit, closeFit, kickFit, comeback },
      notes: [`${leadChanges.length} lead changes`, `${kicks} unstick nudges`, `winner decided at ${win.t.toFixed(1)}s`],
    };
  },
};
