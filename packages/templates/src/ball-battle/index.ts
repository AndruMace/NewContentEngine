import { z } from 'zod';
import { FONT_FAMILY, lighten, hexToRgb, rgbToCss, paletteAt, type DramaScore, type Rng, type SimEvent, type Template } from '@sim/engine';
import { hypot, World, collideInsideCircle, type Body } from '@sim/physics';
import { clamp01, gaussFit } from '../scoring';
import { COLOR_TEAMS, COUNTRY_TEAMS, burst, drawSparks, pickTeams, updateSparks, type Spark, type Team } from '../fx';
import * as dm from '@sim/physics/math';

export const ballBattleSchema = z.object({
  fighters: z.number().int().min(2).max(6).default(4).meta({ title: 'Fighters' }),
  teams: z.enum(['colors', 'countries']).default('colors').meta({ title: 'Teams' }),
  arenaRadius: z.number().min(320).max(480).default(450).meta({ title: 'Arena radius' }),
  ballRadius: z.number().min(28).max(80).default(52).meta({ title: 'Ball radius' }),
  speed: z.number().min(250).max(1400).default(620).meta({ title: 'Ball speed', step: 10 }),
  bladeStart: z.number().min(30).max(220).default(70).meta({ title: 'Starting blade length' }),
  bladeGrowth: z.number().min(0).max(50).default(16).meta({ title: 'Blade growth per hit' }),
  spinSpeed: z.number().min(1).max(9).default(3.6).meta({ title: 'Blade spin (rad/s)', step: 0.1 }),
  hp: z.number().int().min(20).max(300).default(100).meta({ title: 'Starting HP' }),
  damage: z.number().min(2).max(50).default(10).meta({ title: 'Damage per hit' }),
  gravity: z.number().min(0).max(1500).default(0).meta({ title: 'Gravity', step: 50 }),
});

export type BallBattleParams = z.infer<typeof ballBattleSchema>;

interface Fighter {
  body: Body;
  team: Team;
  hp: number;
  angle: number;
  spin: number;
  blade: number;
  alive: boolean;
  koAt: number;
  flash: number;
  /** Blade tip history for the swoosh trail (visual only). */
  tips: { x: number; y: number }[];
}

interface State {
  p: BallBattleParams;
  world: World;
  cx: number;
  cy: number;
  fighters: Fighter[];
  /** Pair cooldowns: key `${a}-${b}` -> time when the pair may interact again. */
  cooldown: Map<string, number>;
  winner: number;
  endAt: number | null;
  t: number;
  hpLeader: number;
  visual: boolean;
  fxRng: Rng;
  sparks: Spark[];
  shake: number;
  lastWallT: number;
}

const OUTRO_S = 2.6;
const COOLDOWN_S = 0.3;

function bladeEnds(f: Fighter) {
  const c = dm.cos(f.angle);
  const s = dm.sin(f.angle);
  const r0 = f.body.r * 0.6;
  const r1 = f.body.r + f.blade;
  return { ax: f.body.x + c * r0, ay: f.body.y + s * r0, bx: f.body.x + c * r1, by: f.body.y + s * r1 };
}

function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const u = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return { d: hypot(px - (ax + dx * u), py - (ay + dy * u)), x: ax + dx * u, y: ay + dy * u };
}

function segSegDist(a: ReturnType<typeof bladeEnds>, b: ReturnType<typeof bladeEnds>) {
  return Math.min(
    pointSegDist(a.ax, a.ay, b.ax, b.ay, b.bx, b.by).d,
    pointSegDist(a.bx, a.by, b.ax, b.ay, b.bx, b.by).d,
    pointSegDist(b.ax, b.ay, a.ax, a.ay, a.bx, a.by).d,
    pointSegDist(b.bx, b.by, a.ax, a.ay, a.bx, a.by).d,
  );
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function hpRanking(s: State) {
  return s.fighters
    .map((f, i) => i)
    .filter((i) => s.fighters[i].alive)
    .sort((a, b) => s.fighters[b].hp - s.fighters[a].hp || a - b);
}

export const ballBattle: Template<BallBattleParams, State> = {
  id: 'ball-battle',
  name: 'Ball Battle',
  family: 'race',
  description:
    'Balls bounce around an arena, each with a spinning blade. Blade hits deal damage and make the attacker’s blade longer. Blades that clash reverse direction. Last ball standing wins.',
  schema: ballBattleSchema,
  substeps: 4,
  defaultCopy: {
    hook: 'Every hit makes the sword longer. Who wins?',
    cta: '{winner} wins! Who did you pick?',
  },

  init({ params: p, rng, fxRng, visual, width, height }) {
    const world = new World();
    world.gravity = p.gravity;
    const cx = width / 2;
    const cy = height * 0.56;
    const teams = pickTeams(p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS, p.fighters, rng);
    const fighters: Fighter[] = teams.map((team, i) => {
      const a = (i / p.fighters) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const dist = (p.arenaRadius - p.ballRadius) * 0.55;
      const dir = rng.range(0, Math.PI * 2);
      const body = world.addBody({
        x: cx + dm.cos(a) * dist,
        y: cy + dm.sin(a) * dist,
        vx: dm.cos(dir) * p.speed,
        vy: dm.sin(dir) * p.speed,
        r: p.ballRadius,
        restitution: 1,
        friction: 0,
      });
      return {
        body,
        team,
        hp: p.hp,
        angle: rng.range(0, Math.PI * 2),
        spin: (rng.chance(0.5) ? 1 : -1) * p.spinSpeed * rng.range(0.85, 1.15),
        blade: p.bladeStart,
        alive: true,
        koAt: -1,
        flash: 0,
        tips: [],
      };
    });
    return {
      p,
      world,
      cx,
      cy,
      fighters,
      cooldown: new Map(),
      winner: -1,
      endAt: null,
      t: 0,
      hpLeader: -1,
      visual,
      fxRng,
      sparks: [],
      shake: 0,
      lastWallT: -1,
    };
  },

  step(s, { dt, t, emit }) {
    const { p } = s;
    s.world.step(dt, (c) => {
      if (c.kind === 'body' && c.impulse > 50) emit({ type: 'bump', x: c.x });
    });
    const R = p.arenaRadius;
    for (const f of s.fighters) {
      if (!f.alive) continue;
      const impact = collideInsideCircle(f.body, s.cx, s.cy, R, 1);
      if (impact > 0) {
        emit({ type: 'wall', speed: impact, x: f.body.x });
        if (s.visual) burst(s.sparks, s.fxRng, f.body.x, f.body.y, 4, 200, f.team.color, 4);
      }
      // Keep the fight energetic: hold speed constant (or above a floor with gravity).
      const sp = hypot(f.body.vx, f.body.vy) || 1;
      const want = p.gravity > 0 ? Math.max(sp, p.speed * 0.6) : p.speed;
      f.body.vx *= want / sp;
      f.body.vy *= want / sp;
      f.angle += f.spin * dt;
    }

    if (s.winner < 0) {
      const alive = s.fighters.map((f, i) => i).filter((i) => s.fighters[i].alive);
      for (const i of alive) {
        const att = s.fighters[i];
        if (!att.alive) continue;
        const blade = bladeEnds(att);
        for (const j of alive) {
          if (i === j || !s.fighters[j].alive) continue;
          const def = s.fighters[j];
          const key = pairKey(i, j);
          if ((s.cooldown.get(key) ?? -1) > t) continue;
          // Blade vs blade: clash.
          if (i < j && segSegDist(blade, bladeEnds(def)) < 10) {
            att.spin = -att.spin;
            def.spin = -def.spin;
            s.cooldown.set(key, t + COOLDOWN_S);
            const mx = (blade.bx + bladeEnds(def).bx) / 2;
            const my = (blade.by + bladeEnds(def).by) / 2;
            emit({ type: 'clash', x: mx, y: my });
            if (s.visual) burst(s.sparks, s.fxRng, mx, my, 14, 500, '#ffffff', 5);
            continue;
          }
          // Blade vs ball: hit.
          const hit = pointSegDist(def.body.x, def.body.y, blade.ax, blade.ay, blade.bx, blade.by);
          if (hit.d < def.body.r) {
            s.cooldown.set(key, t + COOLDOWN_S);
            def.hp = Math.max(0, def.hp - p.damage);
            def.flash = 1;
            att.blade += p.bladeGrowth;
            const nx = (def.body.x - hit.x) / (hit.d || 1);
            const ny = (def.body.y - hit.y) / (hit.d || 1);
            def.body.vx = nx * p.speed;
            def.body.vy = ny * p.speed;
            s.shake = Math.min(24, s.shake + 8);
            emit({ type: 'hit', attacker: i, target: j, hp: def.hp, x: hit.x, y: hit.y });
            if (s.visual) burst(s.sparks, s.fxRng, hit.x, hit.y, 18, 650, def.team.color, 7);
            if (def.hp <= 0) {
              def.alive = false;
              def.koAt = t;
              def.body.alive = false;
              emit({ type: 'ko', who: j, by: i, x: def.body.x });
              if (s.visual) burst(s.sparks, s.fxRng, def.body.x, def.body.y, 70, 1100, def.team.color, 10);
              s.shake = 30;
            }
          }
        }
      }
      const stillIn = s.fighters.map((f, i) => i).filter((i) => s.fighters[i].alive);
      if (stillIn.length <= 1) {
        s.winner = stillIn[0] ?? 0;
        s.endAt = t;
        emit({ type: 'win', who: s.winner, hp: s.fighters[s.winner].hp });
      } else {
        const lead = hpRanking(s)[0];
        const second = hpRanking(s)[1];
        if (lead !== s.hpLeader && s.fighters[lead].hp > s.fighters[second].hp) {
          if (s.hpLeader >= 0) emit({ type: 'leadChange', to: lead });
          s.hpLeader = lead;
        }
      }
    }
    s.t = t + dt;

    for (const f of s.fighters) f.flash *= dm.exp(-8 * dt);
    s.shake *= dm.exp(-10 * dt);
    if (s.visual) {
      for (const f of s.fighters) {
        if (!f.alive) continue;
        const e = bladeEnds(f);
        f.tips.push({ x: e.bx, y: e.by });
        if (f.tips.length > 14) f.tips.shift();
      }
      s.sparks = updateSparks(s.sparks, dt, 600);
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const w = s.winner >= 0 ? s.fighters[s.winner].team : null;
    return {
      winner: w ? `${w.icon ? w.icon + ' ' : ''}${w.label}` : '',
      alive: s.fighters.filter((f) => f.alive).length,
      outro: s.winner >= 0,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.2 },
    ];
  },

  render({ ctx, theme }, s) {
    const { p } = s;
    ctx.save();
    if (s.shake > 0.3) ctx.translate(dm.sin(s.t * 97) * s.shake, dm.cos(s.t * 71) * s.shake);

    // Arena.
    ctx.lineWidth = 10;
    ctx.strokeStyle = rgbToCss(paletteAt(theme.palette, 0.8));
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, p.arenaRadius + 5, 0, Math.PI * 2);
    ctx.stroke();

    // HP bars, top of screen under the hook.
    const barTop = 1920 * 0.155;
    const rows = s.fighters.length;
    const rowH = Math.min(52, 230 / rows);
    const barsAlpha = s.endAt === null ? 1 : Math.max(0, 1 - (s.t - s.endAt) / 0.3);
    s.fighters.forEach((f, i) => {
      if (barsAlpha <= 0) return;
      const y = barTop + i * rowH;
      const w = 600;
      const x = 540 - w / 2 + 70;
      ctx.globalAlpha = (f.alive ? 1 : 0.35) * barsAlpha;
      ctx.font = `900 ${Math.round(rowH * 0.55)}px ${FONT_FAMILY}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.text;
      ctx.fillText(`${f.team.icon ? f.team.icon + ' ' : ''}${f.team.label}`, x - 16, y + rowH / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.roundRect(x, y + rowH * 0.2, w, rowH * 0.6, rowH * 0.3);
      ctx.fill();
      ctx.fillStyle = f.flash > 0.2 ? '#ffffff' : f.team.color;
      ctx.beginPath();
      ctx.roundRect(x, y + rowH * 0.2, Math.max(0.001, (w * f.hp) / p.hp), rowH * 0.6, rowH * 0.3);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    drawSparks(ctx, s.sparks);

    ctx.lineCap = 'round';
    for (const f of s.fighters) {
      if (!f.alive) continue;
      const col = hexToRgb(f.team.color);
      // Swoosh trail of the blade tip.
      for (let k = 1; k < f.tips.length; k++) {
        ctx.strokeStyle = rgbToCss(lighten(col, 0.4), (k / f.tips.length) * 0.35);
        ctx.lineWidth = 10 * (k / f.tips.length);
        ctx.beginPath();
        ctx.moveTo(f.tips[k - 1].x, f.tips[k - 1].y);
        ctx.lineTo(f.tips[k].x, f.tips[k].y);
        ctx.stroke();
      }
      const e = bladeEnds(f);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(e.ax, e.ay);
      ctx.lineTo(e.bx, e.by);
      ctx.stroke();
      ctx.strokeStyle = rgbToCss(lighten(col, 0.2));
      ctx.lineWidth = 8;
      ctx.stroke();

      const b = f.body;
      ctx.fillStyle = rgbToCss(lighten(col, f.flash * 0.8));
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (f.team.icon) {
        ctx.font = `${Math.round(b.r * 0.7)}px ${FONT_FAMILY}`;
        ctx.fillText(f.team.icon, b.x, b.y - b.r * 0.32);
      }
      ctx.font = `900 ${Math.round(b.r * (f.team.icon ? 0.62 : 0.8))}px ${FONT_FAMILY}`;
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const label = String(Math.ceil(f.hp));
      const ty = b.y + (f.team.icon ? b.r * 0.3 : 0);
      ctx.strokeText(label, b.x, ty);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, b.x, ty);
    }
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    const note = (vel: number) => melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
    switch (e.type) {
      case 'wall':
      case 'bump':
        return e.t - lastNoteT >= 0.09 ? note(0.55) : [{ kind: 'sfx', name: 'tick', vel: 0.15, pan }];
      case 'hit':
        return [{ kind: 'sfx', name: 'pop', vel: 0.8, pan }, ...(e.t - lastNoteT >= 0.05 ? note(0.85) : [])];
      case 'clash':
        return [{ kind: 'sfx', name: 'chime', vel: 0.5, pitch: 0.8, pan }, { kind: 'sfx', name: 'tick', vel: 0.6, pan }];
      case 'ko':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.8, pan },
          { kind: 'sfx', name: 'boom', vel: 0.6 },
        ];
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
    const hits = events.filter((e) => e.type === 'hit').length;
    const clashes = events.filter((e) => e.type === 'clash').length;
    const lc = events.filter((e) => e.type === 'leadChange').length;
    const winnerHp = win.hp as number;
    const startHp = Math.max(...events.filter((e) => e.type === 'hit').map((e) => (e.hp as number) + 1), winnerHp, 1);
    const closeFit = clamp01(1 - winnerHp / startHp);
    const lcFit = clamp01(lc / 5);
    const clashFit = clamp01(clashes / 4);
    const total = durFit * (0.4 + 0.6 * closeFit) * (0.55 + 0.45 * lcFit) * (0.85 + 0.15 * clashFit);
    return {
      total,
      parts: { durFit, closeFit, lcFit, clashFit },
      notes: [`${hits} hits, ${clashes} clashes`, `winner finished on ${winnerHp} HP`, `${lc} lead changes`],
    };
  },
};
