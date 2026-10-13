import { z } from 'zod';
import { lighten, paletteAt, rgbToCss, type RGB, type DramaScore, type Rng, type SimEvent, type Template } from '@sim/engine';
import { hypot, TAU, clampSpeed, collideWithDisc, decay, reflect, scaleSpeed, speed, wrapAngle, type Ball } from '@sim/physics';
import { clamp01, gaussFit, mean } from '../scoring';
import * as dm from '@sim/physics/math';

export const ringEscapeSchema = z.object({
  ringCount: z.number().int().min(3).max(60).default(18).meta({ title: 'Ring count' }),
  innerRadius: z.number().min(60).max(250).default(110).meta({ title: 'Inner radius' }),
  outerRadius: z.number().min(250).max(470).default(450).meta({ title: 'Outer radius' }),
  ringThickness: z.number().min(2).max(24).default(8).meta({ title: 'Ring thickness' }),
  gapDegrees: z.number().min(15).max(120).default(48).meta({ title: 'Gap size (deg)' }),
  rotationSpeed: z.number().min(0).max(4).default(0.9).meta({ title: 'Rotation speed (rad/s)', step: 0.05 }),
  rotationSpread: z.number().min(0).max(0.15).default(0.03).meta({ title: 'Rotation spread per ring', step: 0.005 }),
  alternateDirection: z.boolean().default(true).meta({ title: 'Alternate direction' }),
  gapPattern: z.enum(['spiral', 'aligned', 'random']).default('spiral').meta({ title: 'Gap pattern' }),
  ballRadius: z.number().min(6).max(40).default(16).meta({ title: 'Ball radius' }),
  ballGrowth: z.number().min(0).max(3).default(0).meta({ title: 'Ball growth per bounce', step: 0.1 }),
  gravity: z.number().min(0).max(3000).default(1400).meta({ title: 'Gravity', step: 50 }),
  restitution: z.number().min(0.9).max(1.05).default(1).meta({ title: 'Restitution', step: 0.005 }),
  launchSpeed: z.number().min(200).max(1500).default(700).meta({ title: 'Launch speed', step: 10 }),
  minBounceSpeed: z.number().min(200).max(1400).default(700).meta({ title: 'Min bounce speed', step: 10 }),
  speedBoostPerBreak: z.number().min(1).max(1.15).default(1.02).meta({ title: 'Speed boost per break', step: 0.005 }),
  maxSpeed: z.number().min(800).max(3500).default(2400).meta({ title: 'Max speed', step: 50 }),
});

export type RingEscapeParams = z.infer<typeof ringEscapeSchema>;

interface Ring {
  r: number;
  th: number;
  phase: number;
  omega: number;
  gapHalf: number;
  alive: boolean;
  flash: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  len: number;
  w: number;
  life: number;
  maxLife: number;
  /** Colour source: a ring index, or (when -1) a palette position `u`. */
  ring: number;
  u: number;
}

interface State {
  p: RingEscapeParams;
  cx: number;
  cy: number;
  ball: Ball;
  rings: Ring[];
  current: number;
  t: number;
  bounces: number;
  escapedAt: number | null;
  visual: boolean;
  fxRng: Rng;
  particles: Particle[];
  trail: { x: number; y: number }[];
  shake: number;
  flash: number;
}

const OUTRO_S = 1.8;
const TRAIL_LEN = 48;

function ringColor(s: State, i: number, palette: string[]): RGB {
  return paletteAt(palette, s.rings.length > 1 ? i / (s.rings.length - 1) : 0);
}

function spawnRingShards(s: State, ring: Ring, idx: number, t: number) {
  if (!s.visual) return;
  const gapCenter = ring.phase + ring.omega * t;
  const arcLen = (TAU - 2 * ring.gapHalf) * (ring.r + ring.th / 2);
  const count = Math.max(16, Math.min(70, Math.round(arcLen / 22)));
  for (let k = 0; k < count; k++) {
    const a = gapCenter + ring.gapHalf + ((k + 0.5) / count) * (TAU - 2 * ring.gapHalf);
    const rr = ring.r + ring.th / 2;
    const out = s.fxRng.range(150, 650);
    const tangential = ring.omega * rr;
    const life = s.fxRng.range(0.9, 1.7);
    s.particles.push({
      x: s.cx + dm.cos(a) * rr,
      y: s.cy + dm.sin(a) * rr,
      vx: dm.cos(a) * out - dm.sin(a) * tangential + s.fxRng.range(-80, 80),
      vy: dm.sin(a) * out + dm.cos(a) * tangential + s.fxRng.range(-80, 80),
      rot: a + Math.PI / 2,
      vrot: s.fxRng.range(-12, 12),
      len: (arcLen / count) * 0.8,
      w: ring.th,
      life,
      maxLife: life,
      ring: idx,
      u: 0,
    });
  }
}

function spawnBurst(s: State, x: number, y: number, n: number, power: number) {
  if (!s.visual) return;
  for (let k = 0; k < n; k++) {
    const a = s.fxRng.range(0, TAU);
    const v = s.fxRng.range(0.2, 1) * power;
    const life = s.fxRng.range(0.4, 1.4);
    s.particles.push({
      x,
      y,
      vx: dm.cos(a) * v,
      vy: dm.sin(a) * v,
      rot: a,
      vrot: 0,
      len: s.fxRng.range(6, 18),
      w: s.fxRng.range(3, 7),
      life,
      maxLife: life,
      ring: -1,
      u: s.fxRng.next(),
    });
  }
}

function onBounce(s: State, ring: Ring, impact: number, emit: (e: Omit<SimEvent, 't'>) => void) {
  s.bounces++;
  ring.flash = 1;
  if (s.p.ballGrowth > 0) s.ball.r = Math.min(s.ball.r + s.p.ballGrowth, s.rings[s.current].r * 0.6);
  emit({ type: 'bounce', ring: s.current, speed: impact, x: s.ball.x, y: s.ball.y });
  spawnBurst(s, s.ball.x, s.ball.y, 5, 260);
}

export const ringEscape: Template<RingEscapeParams, State> = {
  id: 'ring-escape',
  name: 'Ring Escape',
  family: 'bounce',
  description:
    'A ball bounces inside concentric rotating rings, each with a gap. Passing a gap shatters that ring. Every bounce plays the next note of the melody.',
  schema: ringEscapeSchema,
  substeps: 4,
  defaultCopy: {
    hook: 'Can the ball escape all {ringCount} rings?',
    cta: 'Rate this escape 1-10',
  },
  nudges: ['Guess the bounce count 👇', 'How many bounces? Lock it in 👇', 'Comment your guess before it escapes 👇', 'Which ring holds it longest? 👇', 'Drop your number in the comments 👇', 'Call it: fast escape or slow? 👇'],

  init({ params: p, rng, fxRng, visual, width, height }) {
    const cx = width / 2;
    const cy = height * 0.51;
    const n = p.ringCount;
    const inner = Math.max(p.innerRadius, p.ballRadius * 2.2);
    const outer = Math.max(p.outerRadius, inner + 20);
    const basePhase = rng.range(0, TAU);
    const rings: Ring[] = [];
    for (let i = 0; i < n; i++) {
      const r = n === 1 ? inner : inner + (i * (outer - inner)) / (n - 1);
      const minHalf = dm.asin(Math.min(1, (p.ballRadius * 1.3) / r));
      const phase =
        p.gapPattern === 'aligned' ? basePhase : p.gapPattern === 'spiral' ? basePhase + i * 0.42 : rng.range(0, TAU);
      const dir = p.alternateDirection && i % 2 === 1 ? -1 : 1;
      rings.push({
        r,
        th: p.ringThickness,
        phase,
        omega: p.rotationSpeed * (1 + i * p.rotationSpread) * dir,
        gapHalf: Math.max((p.gapDegrees * Math.PI) / 360, minHalf),
        alive: true,
        flash: 0,
      });
    }
    const a = rng.range(0, TAU);
    return {
      p,
      cx,
      cy,
      ball: { x: cx, y: cy, vx: dm.cos(a) * p.launchSpeed, vy: dm.sin(a) * p.launchSpeed, r: p.ballRadius },
      rings,
      current: 0,
      t: 0,
      bounces: 0,
      escapedAt: null,
      visual,
      fxRng,
      particles: [],
      trail: [],
      shake: 0,
      flash: 0,
    };
  },

  step(s, { dt, t, emit }) {
    const { p, ball } = s;
    const n = Math.max(1, Math.ceil((speed(ball) * dt) / (ball.r * 0.5)));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      const tt = t + k * h;
      ball.vy += p.gravity * h;
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      if (s.escapedAt !== null) continue;

      const ring = s.rings[s.current];
      const dx = ball.x - s.cx;
      const dy = ball.y - s.cy;
      const d = hypot(dx, dy);
      const gapCenter = ring.phase + ring.omega * tt;
      const inGap = Math.abs(wrapAngle(dm.atan2(dy, dx) - gapCenter)) < ring.gapHalf;

      if (!inGap && d + ball.r > ring.r) {
        // Inner wall of the current ring.
        const nx = -dx / d;
        const ny = -dy / d;
        ball.x = s.cx - nx * (ring.r - ball.r);
        ball.y = s.cy - ny * (ring.r - ball.r);
        const impact = reflect(ball, nx, ny, p.restitution, p.minBounceSpeed);
        if (impact > 0) onBounce(s, ring, impact, emit);
      } else if (inGap) {
        // Rounded ends of the ring either side of the gap.
        const mid = ring.r + ring.th / 2;
        for (const side of [-1, 1]) {
          const ea = gapCenter + side * ring.gapHalf;
          const impact = collideWithDisc(
            ball,
            s.cx + dm.cos(ea) * mid,
            s.cy + dm.sin(ea) * mid,
            ring.th / 2,
            p.restitution,
            p.minBounceSpeed * 0.5,
          );
          if (impact > 0) onBounce(s, ring, impact, emit);
        }
        if (hypot(ball.x - s.cx, ball.y - s.cy) > mid) {
          ring.alive = false;
          emit({ type: 'break', ring: s.current, x: ball.x, y: ball.y, of: s.rings.length });
          spawnRingShards(s, ring, s.current, tt);
          s.shake = Math.min(28, s.shake + 12);
          scaleSpeed(ball, p.speedBoostPerBreak);
          clampSpeed(ball, p.maxSpeed);
          s.current++;
          if (s.current >= s.rings.length) {
            s.escapedAt = tt;
            s.flash = 1;
            emit({ type: 'escape', x: ball.x, y: ball.y });
            spawnBurst(s, ball.x, ball.y, 120, 1400);
          }
        }
      }
    }
    s.t = t + dt;

    // Visual-only state (does not feed back into physics).
    for (const ring of s.rings) ring.flash *= decay(9, dt);
    s.shake *= decay(10, dt);
    s.flash *= decay(5, dt);
    if (s.visual) {
      s.trail.push({ x: ball.x, y: ball.y });
      if (s.trail.length > TRAIL_LEN) s.trail.shift();
      const g = p.gravity * 0.6;
      for (const q of s.particles) {
        q.vy += g * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.rot += q.vrot * dt;
        q.life -= dt;
      }
      if (s.particles.length && s.particles[0].life <= 0) s.particles = s.particles.filter((q) => q.life > 0);
    }
  },

  isDone(s) {
    return s.escapedAt !== null && s.t >= s.escapedAt + OUTRO_S;
  },

  hud(s) {
    return { ringsLeft: s.rings.length - s.current, bounces: s.bounces, outro: s.escapedAt !== null };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.4, y: 0.165 },
      { kind: 'counter', key: 'ringsLeft', label: 'RINGS LEFT', y: 0.235, size: 104 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.8 },
    ];
  },

  render({ ctx, theme, t }, s) {
    const palette = theme.palette;
    ctx.save();
    if (s.shake > 0.3) ctx.translate(dm.sin(t * 91) * s.shake, dm.cos(t * 73) * s.shake);
    ctx.lineCap = 'round';

    s.rings.forEach((ring, i) => {
      if (!ring.alive) return;
      const col = ringColor(s, i, palette);
      const gapCenter = ring.phase + ring.omega * t;
      ctx.strokeStyle = rgbToCss(lighten(col, ring.flash * 0.7));
      ctx.lineWidth = ring.th * (1 + ring.flash * 0.5);
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, ring.r + ring.th / 2, gapCenter + ring.gapHalf, gapCenter + TAU - ring.gapHalf);
      ctx.stroke();
    });

    for (const q of s.particles) {
      const col = q.ring >= 0 ? ringColor(s, q.ring, palette) : paletteAt(palette, q.u);
      ctx.strokeStyle = rgbToCss(col, Math.min(1, (q.life / q.maxLife) * 1.4));
      ctx.lineWidth = q.w;
      const hx = (dm.cos(q.rot) * q.len) / 2;
      const hy = (dm.sin(q.rot) * q.len) / 2;
      ctx.beginPath();
      ctx.moveTo(q.x - hx, q.y - hy);
      ctx.lineTo(q.x + hx, q.y + hy);
      ctx.stroke();
    }

    const target = s.rings[Math.min(s.current, s.rings.length - 1)];
    const ballCol = ringColor(s, Math.min(s.current, s.rings.length - 1), palette);
    const trailN = Math.min(s.trail.length, Math.round(TRAIL_LEN * Math.min(1, theme.trail)));
    for (let i = s.trail.length - trailN; i < s.trail.length; i++) {
      const u = (i - (s.trail.length - trailN)) / Math.max(1, trailN);
      const pt = s.trail[i];
      ctx.fillStyle = rgbToCss(ballCol, u * 0.35);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, s.ball.r * (0.35 + 0.65 * u), 0, TAU);
      ctx.fill();
    }

    ctx.fillStyle = theme.ball;
    ctx.strokeStyle = rgbToCss(lighten(ballCol, target.flash * 0.5));
    ctx.lineWidth = Math.max(3, s.ball.r * 0.28);
    ctx.beginPath();
    ctx.arc(s.ball.x, s.ball.y, s.ball.r, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (s.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${(s.flash * 0.55).toFixed(3)})`;
      ctx.fillRect(0, 0, 1080, 1920);
    }
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'bounce': {
        const v = clamp01((e.speed as number) / 1500);
        if (e.t - lastNoteT < 0.07) return [{ kind: 'sfx', name: 'tick', vel: 0.15 + 0.2 * v, pan }];
        const vel = 0.5 + 0.5 * v;
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
      }
      case 'break': {
        // Passing a gap plays the next melody step, accented, with a soft halo an octave above the
        // melody note. Only the song's own pitches are used, so it always fits whatever key it's in.
        const step = melody.next();
        const glow = 0.3 + 0.2 * ((e.ring as number) / Math.max(1, (e.of as number) - 1));
        return [
          ...step.map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.4 : 0.85, voice: theme.voice, pan })),
          { kind: 'note', midi: step[0] + 12, vel: glow, voice: 'softsine', dur: 1.6, pan },
        ];
      }
      case 'escape':
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
    const breaks = events.filter((e) => e.type === 'break').map((e) => e.t);
    const escape = events.find((e) => e.type === 'escape');
    const bounces = events.filter((e) => e.type === 'bounce').length;
    const durFit = gaussFit(durationS, targetS, targetS * 0.18);
    if (timedOut || !escape || breaks.length === 0) {
      return { total: 0.02 * durFit, parts: { durFit, escaped: 0 }, notes: ['ball did not escape'] };
    }
    const gaps = breaks.map((b, i) => b - (i ? breaks[i - 1] : 0));
    const meanGap = mean(gaps);
    const stallRatio = Math.max(...gaps) / meanGap;
    const stallFit = dm.exp(-Math.max(0, stallRatio - 2.5) / 2);
    const half = Math.floor(gaps.length / 2);
    const accel = half > 0 ? mean(gaps.slice(0, half)) / Math.max(1e-3, mean(gaps.slice(half))) : 1;
    const accelFit = clamp01(0.5 + 0.35 * dm.log(accel));
    const rate = bounces / escape.t;
    const rateFit = rate < 1.5 ? rate / 1.5 : rate > 7 ? dm.exp(-(rate - 7) / 4) : 1;
    // Last-ring suspense: a long final wait before the escape is good drama, a stall early is not.
    const finalWait = gaps[gaps.length - 1] / meanGap;
    const finaleFit = clamp01(0.6 + 0.2 * Math.min(2, finalWait));
    const total = durFit * (0.35 + 0.65 * stallFit) * (0.6 + 0.4 * accelFit) * (0.7 + 0.3 * rateFit) * (0.8 + 0.2 * finaleFit);
    return {
      total,
      parts: { durFit, stallFit, accelFit, rateFit, finaleFit },
      notes: [`${breaks.length} rings in ${escape.t.toFixed(1)}s`, `${bounces} bounces (${rate.toFixed(1)}/s)`],
    };
  },
};
