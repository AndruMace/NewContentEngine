import { z } from 'zod';
import { lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type Template } from '@sim/engine';
import { TAU, collideInsideCircle, speed, type Ball } from '@sim/physics';
import { clamp01, gaussFit } from '../scoring';
import * as dm from '@sim/physics/math';

export const growUntilFullSchema = z.object({
  arenaRadius: z.number().min(250).max(470).default(440).meta({ title: 'Circle radius' }),
  startRadius: z.number().min(6).max(80).default(18).meta({ title: 'Starting ball radius' }),
  growth: z.number().min(0.5).max(20).default(4).meta({ title: 'Growth per bounce (px)', step: 0.5 }),
  fullAt: z.number().min(0.7).max(0.99).default(0.95).meta({ title: 'Full at (fraction of circle)', step: 0.01 }),
  gravity: z.number().min(0).max(3000).default(1500).meta({ title: 'Gravity', step: 50 }),
  launchSpeed: z.number().min(200).max(1500).default(800).meta({ title: 'Launch speed', step: 10 }),
  minBounceSpeed: z.number().min(200).max(1500).default(750).meta({ title: 'Min bounce speed', step: 10 }),
  style: z.enum(['paint', 'clean']).default('paint').meta({ title: 'Style' }),
  paintEvery: z.number().int().min(1).max(10).default(2).meta({ title: 'Paint every N frames' }),
});

export type GrowUntilFullParams = z.infer<typeof growUntilFullSchema>;

interface State {
  p: GrowUntilFullParams;
  cx: number;
  cy: number;
  ball: Ball;
  bounces: number;
  fullAt: number | null;
  flash: number;
  ringFlash: number;
  t: number;
}

const OUTRO_S = 1.8;
const paintLayers = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; lastFrame: number }>();

export const growUntilFull: Template<GrowUntilFullParams, State> = {
  id: 'grow-until-full',
  name: 'Grow Until Full',
  family: 'bounce',
  description:
    'A ball bounces inside a circle and grows a little on every bounce until it fills the circle. As it grows the bounces get faster and faster. Paint style leaves a colourful outline trail.',
  schema: growUntilFullSchema,
  substeps: 4,
  defaultCopy: {
    hook: 'Every bounce makes it bigger…',
    cta: 'How many bounces did you guess?',
  },

  init({ params: p, rng, width, height }) {
    const a = rng.range(0, TAU);
    const cx = width / 2;
    const cy = height * 0.53;
    return {
      p,
      cx,
      cy,
      ball: { x: cx + rng.range(-40, 40), y: cy - p.arenaRadius * 0.3, vx: dm.cos(a) * p.launchSpeed, vy: dm.sin(a) * p.launchSpeed, r: p.startRadius },
      bounces: 0,
      fullAt: null,
      flash: 0,
      ringFlash: 0,
      t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    const { p, ball } = s;
    if (s.fullAt === null) {
      const n = Math.max(1, Math.ceil((speed(ball) * dt) / Math.max(2, (p.arenaRadius - ball.r) * 0.25)));
      const h = dt / n;
      for (let k = 0; k < n && s.fullAt === null; k++) {
        ball.vy += p.gravity * h;
        ball.x += ball.vx * h;
        ball.y += ball.vy * h;
        const impact = collideInsideCircle(ball, s.cx, s.cy, p.arenaRadius, 1, p.minBounceSpeed);
        if (impact > 0) {
          s.bounces++;
          s.ringFlash = 1;
          ball.r = Math.min(p.arenaRadius * p.fullAt, ball.r + p.growth);
          emit({ type: 'bounce', speed: impact, size: ball.r / p.arenaRadius, x: ball.x });
          if (ball.r >= p.arenaRadius * p.fullAt - 1e-6) {
            s.fullAt = t + k * h;
            s.flash = 1;
            ball.vx = 0;
            ball.vy = 0;
            emit({ type: 'full', bounces: s.bounces });
          }
        }
      }
    } else {
      // Settle into the centre.
      const k = 1 - dm.exp(-6 * dt);
      ball.x += (s.cx - ball.x) * k;
      ball.y += (s.cy - ball.y) * k;
    }
    s.flash *= dm.exp(-4 * dt);
    s.ringFlash *= dm.exp(-10 * dt);
    s.t = t + dt;
  },

  isDone(s) {
    return s.fullAt !== null && s.t >= s.fullAt + OUTRO_S;
  },

  hud(s) {
    return {
      size: `${Math.round((s.ball.r / (s.p.arenaRadius * s.p.fullAt)) * 100)}%`,
      bounces: s.bounces,
      outro: s.fullAt !== null,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'counter', key: 'bounces', label: 'BOUNCES', y: 0.205, size: 100 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.17 },
    ];
  },

  render({ ctx, theme, frame, width, height }, s) {
    const { p, ball } = s;
    const u = clamp01((ball.r - p.startRadius) / Math.max(1, p.arenaRadius * p.fullAt - p.startRadius));
    const col = paletteAt(theme.palette, (s.t * 0.08) % 1);

    if (p.style === 'paint') {
      let layer = paintLayers.get(s);
      if (!layer) {
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        layer = { canvas, lastFrame: -1 };
        paintLayers.set(s, layer);
      }
      if (frame !== layer.lastFrame && frame % p.paintEvery === 0 && s.fullAt === null) {
        const pc = layer.canvas.getContext('2d') as Ctx2D;
        pc.strokeStyle = rgbToCss(col, 0.55);
        pc.lineWidth = 2.5;
        pc.beginPath();
        pc.arc(ball.x, ball.y, ball.r, 0, TAU);
        pc.stroke();
      }
      layer.lastFrame = frame;
      ctx.drawImage(layer.canvas, 0, 0);
    }

    ctx.strokeStyle = rgbToCss(lighten(paletteAt(theme.palette, 0.9), s.ringFlash * 0.6));
    ctx.lineWidth = 10 + s.ringFlash * 6;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, p.arenaRadius + 5, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = p.style === 'paint' ? rgbToCss(col, 0.85) : rgbToCss(paletteAt(theme.palette, u));
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = Math.max(3, ball.r * 0.05);
    ctx.strokeStyle = theme.ball;
    ctx.stroke();

    if (s.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${(s.flash * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
    }
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'bounce': {
        if (e.t - lastNoteT < 0.06) return [{ kind: 'sfx', name: 'tick', vel: 0.2, pan }];
        const vel = 0.55 + 0.4 * clamp01((e.speed as number) / 1500);
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? vel * 0.45 : vel, voice: theme.voice, pan }));
      }
      case 'full':
        return [
          { kind: 'sfx', name: 'boom', vel: 1 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.8, voice: 'bell' as const, dur: 2.5 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.5 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const full = events.find((e) => e.type === 'full');
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    if (timedOut || !full) return { total: 0.02 * durFit, parts: { durFit }, notes: ['never filled'] };
    const bounces = events.filter((e) => e.type === 'bounce');
    // Escalation: bounce rate in the last quarter vs the first quarter.
    const q = full.t / 4;
    const early = bounces.filter((b) => b.t < q).length / q;
    const late = bounces.filter((b) => b.t > full.t - q).length / q;
    const escalation = clamp01(dm.log(Math.max(1, late / Math.max(0.5, early))) / dm.log(6));
    return {
      total: durFit * (0.6 + 0.4 * escalation),
      parts: { durFit, escalation },
      notes: [`${bounces.length} bounces, full at ${full.t.toFixed(1)}s`, `bounce rate ${early.toFixed(1)}/s → ${late.toFixed(1)}/s`],
    };
  },
};
