import { z } from 'zod';
import { FONT_FAMILY, hexToRgb, mixRgb, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type Rng, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { burst, drawSparks, updateSparks, type Spark } from '../fx';
import { clamp01, gaussFit } from '../scoring';
import { playSnake, type SnakeGame } from './game';

export const snakeAiSchema = z.object({
  grid: z.number().int().min(8).max(16).default(10).meta({ title: 'Board size (cells per side)' }),
  startFill: z.number().min(0).max(0.6).default(0.2).meta({ title: 'Starting length (share of the board)', step: 0.05 }),
  speed: z.number().min(4).max(80).default(20).meta({ title: 'Snake speed at the start (moves per second)', step: 1 }),
  speedUp: z.number().min(0).max(1.5).default(0.9).meta({ title: 'Speed-up as it grows', step: 0.05 }),
  ending: z.enum(['any', 'filled', 'trapped']).default('any').meta({ title: 'Ending the seed search looks for' }),
});

export type SnakeAiParams = z.infer<typeof snakeAiSchema>;

interface State {
  p: SnakeAiParams;
  g: SnakeGame;
  /** Time each entry of the game happens (starting body entries at 0). */
  times: Float64Array;
  k: number;
  endAt: number | null;
  milestone: number;
  lastMoveT: number;
  gambleAt: number;
  t: number;
  visual: boolean;
  fxRng: Rng;
  sparks: Spark[];
}

const BOARD = 900;
const X0 = (1080 - BOARD) / 2;
const Y0 = 560;
const INTRO_S = 0.6;
const OUTRO_S = 3.4;
/** Runs never go past this (the renderer gives up at 90 s): longer games are sped up to fit. */
const MAX_GAME_S = 82;
const MILESTONES = [0.25, 0.5, 0.75, 0.9];

const cellXY = (s: State, c: number) => {
  const cs = BOARD / s.g.n;
  return [X0 + ((c % s.g.n) + 0.5) * cs, Y0 + (Math.floor(c / s.g.n) + 0.5) * cs] as const;
};
const fillOf = (s: State, k: number) => s.g.lens[k] / (s.g.n * s.g.n);

export const snakeAi: Template<SnakeAiParams, State> = {
  id: 'snake-ai',
  name: 'Snake AI',
  family: 'kinetic',
  description:
    'A snake played by an AI eats apples on a grid and grows until it either fills the whole board or traps itself, and the video runs until that happens. It plays it safe (only going for an apple when it can still reach its own tail), so most games come down to the last few cells. It can start already long (startFill) to skip the slow early game; speed and speedUp set how fast it moves and so how long the video is. Bigger boards take far more moves (the late game is long), so pair them with more speed: typical runtimes are 8×8 at speed 12 ≈ 30 s, 10×10 at speed 20 ≈ 36 s, 12×12 at speed 30 with speedUp 1 ≈ 43 s. A big counter shows how much of the board is filled. The ending (filled or trapped) is decided by the seed and must never be given away in the copy.',
  schema: snakeAiSchema,
  substeps: 1,
  searchBudget: 60,
  glowScale: 0.6,
  defaultCopy: {
    hook: 'Will the snake fill the whole board?',
    cta: '{result}! Did you think it would make it?',
  },

  init({ params: p, rng, fxRng, visual }) {
    const g = playSnake(p.grid, rng);
    // Skip the early game: the video picks up the moment the snake reaches the starting length (a
    // real position from the same game, so the AI's play stays consistent).
    const want = Math.max(g.startLength, Math.round(p.startFill * p.grid * p.grid));
    let skip = g.startLength - 1;
    while (skip < g.last - 1 && g.lens[skip] < want) skip++;
    const times = new Float64Array(g.last + 1);
    // Then it plays to its natural end: each move takes 1/speed seconds, quickening as the snake grows
    // (speedUp, relative to its length when the video starts), with the last few moves before the
    // ending slowed down for suspense.
    const w = new Float64Array(g.last + 1);
    let sum = 0;
    const len0 = Math.max(10, g.lens[skip]);
    for (let i = skip + 1; i <= g.last; i++) {
      let wi = 1 / (p.speed * dm.pow(g.lens[i] / len0, p.speedUp));
      const fromEnd = g.last - i;
      const slow = g.result === 'trapped' ? 6 : 3;
      if (fromEnd < slow) wi = Math.max(wi, 0.08) * (1 + (g.result === 'trapped' ? 4 : 2.5) * (1 - fromEnd / slow));
      w[i] = wi;
      sum += wi;
    }
    const fit = sum > MAX_GAME_S ? MAX_GAME_S / sum : 1;
    let acc = INTRO_S;
    for (let i = skip + 1; i <= g.last; i++) {
      acc += w[i] * fit;
      times[i] = acc;
    }
    const startFill = g.lens[skip] / (p.grid * p.grid);
    return {
      p,
      g,
      times,
      k: skip,
      endAt: null,
      milestone: MILESTONES.filter((m) => startFill >= m).length,
      lastMoveT: -1,
      gambleAt: -10,
      t: 0,
      visual,
      fxRng,
      sparks: [],
    };
  },

  step(s, { dt, t, emit }) {
    const { g } = s;
    s.t = t + dt;
    if (s.visual) s.sparks = updateSparks(s.sparks, dt, 500);
    while (s.k < g.last && s.times[s.k + 1] <= t) {
      s.k++;
      const k = s.k;
      const [x, y] = cellXY(s, g.heads[k]);
      if (g.gamble[k - 1]) {
        s.gambleAt = t;
        emit({ type: 'gamble', fill: fillOf(s, k) });
      }
      if (g.ate[k]) {
        const fill = fillOf(s, k);
        emit({ type: 'eat', len: g.lens[k], fill, x, y });
        if (s.visual) burst(s.sparks, s.fxRng, x, y, 10, 320, '#ff4d4d', 7);
        while (s.milestone < MILESTONES.length && fill >= MILESTONES[s.milestone]) {
          emit({ type: 'milestone', at: MILESTONES[s.milestone] });
          s.milestone++;
        }
      } else if (t - s.lastMoveT >= 0.09) {
        s.lastMoveT = t;
        emit({ type: 'move', fill: fillOf(s, k), x });
      }
    }
    if (s.endAt === null && s.k === g.last) {
      s.endAt = t;
      // Carries the wanted ending so the score (which only sees events) can judge the seed.
      emit({ type: g.result, fill: fillOf(s, g.last), ending: s.p.ending });
    }
    if (s.endAt === null) return;
    // A full board gets confetti (a trapped snake's ending is drawn in render).
    const since = t - s.endAt;
    if (g.result === 'filled' && s.visual && since < 1.6 && Math.floor(since / 0.12) !== Math.floor((since - dt) / 0.12)) {
      burst(s.sparks, s.fxRng, X0 + s.fxRng.range(0.1, 0.9) * BOARD, Y0 + s.fxRng.range(0.1, 0.6) * BOARD, 18, 520, () => rgbToCss(paletteAt(['#ff4d6d', '#ffd60a', '#4ade80', '#38bdf8', '#c084fc'], s.fxRng.next())), 8);
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const pct = Math.floor(fillOf(s, s.k) * 100);
    return {
      filled: `${pct}%`,
      result: s.g.result === 'filled' ? 'It filled the whole board' : `Trapped at ${Math.floor(fillOf(s, s.g.last) * 100)}%`,
      outro: s.endAt !== null,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'counter', key: 'filled', label: 'BOARD FILLED', y: 0.235, size: 104 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.15 },
    ];
  },

  render({ ctx, theme }, s) {
    const { g } = s;
    const n = g.n;
    const cs = BOARD / n;
    const light = luminance(theme.bg[0]) > 0.5;
    // Board: soft checkerboard.
    ctx.fillStyle = light ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.roundRect(X0 - 14, Y0 - 14, BOARD + 28, BOARD + 28, 26);
    ctx.fill();
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = (x + y) % 2 ? (light ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.045)') : light ? 'rgba(0,0,0,0.075)' : 'rgba(255,255,255,0.09)';
        ctx.fillRect(X0 + x * cs, Y0 + y * cs, cs, cs);
      }

    // Apple.
    const apple = g.apples[s.k];
    if (apple >= 0 && s.endAt === null) {
      const [ax, ay] = cellXY(s, apple);
      const pulse = 1 + 0.08 * dm.sin(s.t * 9);
      ctx.fillStyle = 'rgba(255,60,60,0.25)';
      ctx.beginPath();
      ctx.arc(ax, ay, cs * 0.55 * pulse, 0, Math.PI * 2);
      ctx.fill();
      drawApple(ctx, ax, ay, cs * 0.36 * pulse);
    }

    drawSnake(ctx, s, theme.palette);
    if (s.endAt !== null && g.result === 'trapped') drawEmptyCells(ctx, s);
    drawSparks(ctx, s.sparks);
  },

  renderTop({ ctx, theme }, s) {
    const { g } = s;
    const total = g.n * g.n;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = `900 42px ${FONT_FAMILY}`;
    const left = total - g.lens[s.k];
    const label = s.endAt !== null && g.result === 'trapped' ? `😵 So close! ${left} cell${left === 1 ? '' : 's'} left` : `🐍 Length ${g.lens[s.k]} / ${total}`;
    ctx.lineWidth = 9;
    ctx.strokeStyle = theme.textStroke;
    ctx.strokeText(label, 540, Y0 + BOARD + 62);
    ctx.fillStyle = theme.text;
    ctx.fillText(label, 540, Y0 + BOARD + 62);
    // A risky move flashes a warning above the head.
    const since = s.t - s.gambleAt;
    if (since < 1.1 && s.endAt === null) {
      const [hx, hy] = cellXY(s, g.heads[s.k]);
      ctx.globalAlpha = clamp01((1.1 - since) / 0.3);
      ctx.font = `900 40px ${FONT_FAMILY}`;
      ctx.lineWidth = 8;
      ctx.strokeText('😬 risky!', hx, hy - BOARD / g.n - 18 - since * 30);
      ctx.fillText('😬 risky!', hx, hy - BOARD / g.n - 18 - since * 30);
    }
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.6, Math.min(0.6, ((e.x as number) - 540) / 540)) : 0;
    switch (e.type) {
      case 'eat':
        if (e.t - lastNoteT < 0.06) return [{ kind: 'sfx', name: 'pop', vel: 0.25, pan }];
        return [
          { kind: 'sfx', name: 'pop', vel: 0.3, pitch: e.fill as number, pan },
          ...melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.22 : 0.5, voice: theme.voice, pan })),
        ];
      case 'move':
        return [{ kind: 'sfx', name: 'tick', vel: 0.06, pitch: 0.3 + 0.6 * (e.fill as number), pan }];
      case 'milestone':
        return [{ kind: 'sfx', name: 'chime', vel: 0.4, pitch: e.at as number }];
      case 'gamble':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.35 }];
      case 'trapped':
        return [
          { kind: 'sfx', name: 'boom', vel: 0.8 },
          { kind: 'note', midi: 45, vel: 0.5, voice: 'softsine', dur: 1.6 },
          { kind: 'note', midi: 48, vel: 0.4, voice: 'softsine', dur: 1.6 },
        ];
      case 'filled':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.85 },
          { kind: 'sfx', name: 'whoosh', vel: 0.5 },
          ...melody.peek().flatMap((midi) => [
            { kind: 'note' as const, midi, vel: 0.75, voice: 'bell' as const, dur: 2.6 },
            { kind: 'note' as const, midi: midi + 12, vel: 0.5, voice: 'bell' as const, dur: 2.6 },
          ]),
        ];
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    const end = events.find((e) => e.type === 'filled' || e.type === 'trapped');
    if (timedOut || !end) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no ending'] };
    return scoreEnding(end.type === 'filled', end.fill as number, durFit, (end.ending as SnakeAiParams['ending']) ?? 'any');
  },
};

function scoreEnding(filled: boolean, fill: number, durFit: number, ending: SnakeAiParams['ending']): DramaScore {
  // A trapped snake is most dramatic when it gets agonisingly close.
  const nearMiss = gaussFit(fill, 0.97, 0.07);
  const resultFit = ending === 'filled' ? (filled ? 1 : 0.1 * fill) : ending === 'trapped' ? (filled ? 0.1 : nearMiss) : filled ? 0.95 : nearMiss;
  return {
    total: durFit * (0.3 + 0.7 * resultFit),
    parts: { durFit, resultFit },
    notes: [filled ? 'filled the board' : `trapped at ${Math.floor(fill * 100)}%`],
  };
}

/** A glossy vector apple (drawn rather than an emoji so it looks the same everywhere). */
function drawApple(ctx: Ctx2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.fillStyle = '#e8262d';
  ctx.beginPath();
  ctx.arc(x - r * 0.42, y + r * 0.08, r * 0.78, 0, Math.PI * 2);
  ctx.arc(x + r * 0.42, y + r * 0.08, r * 0.78, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(x - r * 0.5, y - r * 0.2, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#6b3f1d';
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.55);
  ctx.quadraticCurveTo(x + r * 0.05, y - r * 0.95, x + r * 0.2, y - r * 1.1);
  ctx.stroke();
  ctx.fillStyle = '#3fbf4f';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.5, y - r * 0.92, r * 0.36, r * 0.17, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Trapped ending: the cells it never reached pulse red, so "so close" is obvious. */
function drawEmptyCells(ctx: Ctx2D, s: State) {
  const { g } = s;
  const cs = BOARD / g.n;
  const body = new Set<number>();
  for (let j = 0; j < g.lens[g.last]; j++) body.add(g.heads[g.last - j]);
  const since = s.t - s.endAt!;
  const pulse = 0.5 + 0.5 * dm.sin(since * 7);
  const a = clamp01((since - 0.5) / 0.4);
  for (let c = 0; c < g.n * g.n; c++) {
    if (body.has(c)) continue;
    const x = X0 + (c % g.n) * cs;
    const y = Y0 + Math.floor(c / g.n) * cs;
    ctx.fillStyle = `rgba(255,70,70,${(0.5 + 0.4 * pulse) * a})`;
    ctx.fillRect(x + 3, y + 3, cs - 6, cs - 6);
    ctx.strokeStyle = `rgba(255,120,120,${a})`;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 4, y + 4, cs - 8, cs - 8);
  }
}

function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The snake as a gradient tube from head to tail, moving smoothly between cells. */
function drawSnake(ctx: Ctx2D, s: State, palette: string[]) {
  const { g } = s;
  const k = s.k;
  const len = g.lens[k];
  const cs = BOARD / g.n;
  const next = k < g.last ? k + 1 : -1;
  const f = next >= 0 ? clamp01((s.t - s.times[k]) / Math.max(1e-6, s.times[next] - s.times[k])) : 0;
  const lerp = (a: number, b: number, u: number): [number, number] => {
    const [ax, ay] = cellXY(s, a);
    const [bx, by] = cellXY(s, b);
    return [ax + (bx - ax) * u, ay + (by - ay) * u];
  };
  // Points from head to tail.
  const pts: [number, number][] = [];
  pts.push(next >= 0 && s.endAt === null ? lerp(g.heads[k], g.heads[next], f) : cellXY(s, g.heads[k]) as [number, number]);
  for (let j = 0; j < len; j++) pts.push(cellXY(s, g.heads[k - j]) as [number, number]);
  if (next >= 0 && !g.ate[next] && len > 1 && s.endAt === null) pts[pts.length - 1] = lerp(g.heads[k - len + 1], g.heads[k - len + 2], f);
  const filledWave = s.endAt !== null && g.result === 'filled';
  // Trapped: flash, then fade the body toward grey so the empty cells stand out.
  const since = s.endAt !== null ? s.t - s.endAt : -1;
  const trappedLook = since >= 0 && g.result === 'trapped';
  const flashOn = trappedLook && since < 0.9 && Math.floor(since * 7) % 2 === 0;
  const grey = trappedLook ? clamp01((since - 0.9) / 0.6) * 0.6 : 0;
  const width = cs * 0.74;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Dark outline under the whole body for definition.
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = width + 8;
  ctx.beginPath();
  for (let j = 0; j < pts.length; j++) (j === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, pts[j][0], pts[j][1]);
  ctx.stroke();
  ctx.lineWidth = width;
  for (let j = 1; j < pts.length; j++) {
    let u = (j - 1) / Math.max(1, pts.length - 2);
    if (filledWave) u = (u + (s.t - s.endAt!) * 0.8) % 1;
    ctx.strokeStyle = flashOn ? '#ffffff' : rgbToCss(mixRgb(paletteAt(palette, u), [110, 110, 120], grey));
    ctx.beginPath();
    ctx.moveTo(pts[j - 1][0], pts[j - 1][1]);
    ctx.lineTo(pts[j][0], pts[j][1]);
    ctx.stroke();
  }
  // Head with eyes looking where it's going (crosses when trapped).
  const [hx, hy] = pts[0];
  const [px, py] = pts[1];
  let dx = hx - px;
  let dy = hy - py;
  if (Math.abs(dx) + Math.abs(dy) < 1e-3 && len > 1) {
    const [qx, qy] = cellXY(s, g.heads[k - 1]);
    dx = hx - qx;
    dy = hy - qy;
  }
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= d;
  dy /= d;
  ctx.fillStyle = flashOn ? '#ffffff' : rgbToCss(mixRgb(paletteAt(palette, 0), [110, 110, 120], grey));
  ctx.beginPath();
  ctx.arc(hx, hy, cs * 0.46, 0, Math.PI * 2);
  ctx.fill();
  const trapped = s.endAt !== null && g.result === 'trapped';
  for (const side of [-1, 1]) {
    const ex = hx + dx * cs * 0.14 - dy * side * cs * 0.2;
    const ey = hy + dy * cs * 0.14 + dx * side * cs * 0.2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex, ey, cs * 0.13, 0, Math.PI * 2);
    ctx.fill();
    if (trapped) {
      ctx.strokeStyle = '#111';
      ctx.lineWidth = Math.max(2, cs * 0.05);
      const r = cs * 0.08;
      ctx.beginPath();
      ctx.moveTo(ex - r, ey - r);
      ctx.lineTo(ex + r, ey + r);
      ctx.moveTo(ex + r, ey - r);
      ctx.lineTo(ex - r, ey + r);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(ex + dx * cs * 0.05, ey + dy * cs * 0.05, cs * 0.065, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
