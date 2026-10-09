import { z } from 'zod';
import { lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type RGB, type Template } from '@sim/engine';
import { hypot } from '@sim/physics';
import { gaussFit } from '../scoring';
import * as dm from '@sim/physics/math';

export const liquidMixSchema = z.object({
  particles: z.number().int().min(300).max(2400).default(1500).meta({ title: 'Particles', step: 50 }),
  colors: z.number().int().min(2).max(3).default(2).meta({ title: 'Colours' }),
  pourSeconds: z.number().min(6).max(40).default(16).meta({ title: 'Pour time (s)' }),
  settleSeconds: z.number().min(2).max(20).default(7).meta({ title: 'Mixing time after pour (s)' }),
  mixRate: z.number().min(0).max(0.2).default(0.012).meta({ title: 'Colour mixing rate', step: 0.005 }),
  stiffness: z.number().min(0.1).max(1).default(0.4).meta({ title: 'Pressure stiffness', step: 0.05 }),
  viscosity: z.number().min(0).max(0.5).default(0.12).meta({ title: 'Viscosity', step: 0.01 }),
  container: z.enum(['glass', 'bowl']).default('glass').meta({ title: 'Container' }),
});

export type LiquidMixParams = z.infer<typeof liquidMixSchema>;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface State {
  p: LiquidMixParams;
  n: number;
  x: Float64Array;
  y: Float64Array;
  px: Float64Array;
  py: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  col: Float32Array;
  sources: { x: number; y: number; vx: number; vy: number; color: RGB; perRow: number; acc: number }[];
  walls: Seg[];
  emitAcc: number;
  pourEndAt: number | null;
  t: number;
  lastBubbleT: number;
  lastNoteBeat: number;
}

const H = 28; // interaction radius (px)
const REST = 2; // rest density (kernel units) ~ particles spaced 0.45 H apart
const NEAR_K = 1.5;
const K_SCALE = 1; // stiffness param -> pressure constant
const MAX_D = H * 0.1; // per-pair displacement clamp (stability)
const MAX_V = 2600;
const GRAVITY = 1400;
const PR = 3; // particle collision radius against walls
const SPACING = H * 0.45;

function containerWalls(kind: LiquidMixParams['container']): Seg[] {
  const segs: Seg[] = [];
  const poly = (pts: [number, number][]) => {
    for (let i = 0; i < pts.length - 1; i++) segs.push({ ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1] });
  };
  switch (kind) {
    case 'glass':
      poly([
        [250, 760],
        [290, 1520],
        [790, 1520],
        [830, 760],
      ]);
      break;
    case 'bowl': {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 24; k++) {
        const a = Math.PI * (k / 24);
        pts.push([540 - dm.cos(a) * 400, 960 + dm.sin(a) * 560]);
      }
      poly(pts);
      break;
    }
  }
  return segs;
}

export const liquidMix: Template<LiquidMixParams, State> = {
  id: 'liquid-mix',
  name: 'Liquid Mix',
  family: 'particles',
  description:
    'Two or three coloured liquids pour into a glass or bowl and swirl together, blending colours as they settle. Particle-based fluid with soft rendered surfaces.',
  schema: liquidMixSchema,
  substeps: 2,
  searchBudget: 4,
  glowScale: 0.35,
  defaultCopy: {
    hook: 'Wait for the colors to mix…',
    cta: 'What color did it make? 👇',
  },

  init({ params: p, rng, theme }) {
    const n = p.particles;
    const u0 = rng.range(0, 1);
    // Neighbouring hues mix into a vivid in-between colour (opposites average to grey).
    const pick = (k: number) => (u0 + k * 0.28) % 1;
    // Jets aimed into the container mouth. Speed is set so consecutive particles leave the
    // nozzle ~SPACING apart; spawning closer than that makes the pressure solve spray them.
    const mouthY = 700;
    const aims = [
      { x: 360, y: 520, tx: 470, ty: mouthY + 300 },
      { x: 720, y: 520, tx: 610, ty: mouthY + 300 },
      { x: 540, y: 470, tx: 540, ty: mouthY + 300 },
    ];
    const perSource = p.particles / p.pourSeconds / p.colors;
    const perRow = Math.max(1, Math.ceil((perSource * SPACING) / 700));
    const speed0 = (perSource * SPACING) / perRow;
    const sources = aims.slice(0, p.colors).map((aim, k) => {
      const dx = aim.tx - aim.x;
      const dy = aim.ty - aim.y;
      const d = hypot(dx, dy);
      return { x: aim.x, y: aim.y, vx: (dx / d) * speed0, vy: (dy / d) * speed0, color: paletteAt(theme.palette, pick(k)), perRow, acc: 0 };
    });
    return {
      p,
      n: 0,
      x: new Float64Array(n),
      y: new Float64Array(n),
      px: new Float64Array(n),
      py: new Float64Array(n),
      vx: new Float64Array(n),
      vy: new Float64Array(n),
      col: new Float32Array(n * 3),
      sources,
      walls: containerWalls(p.container),
      emitAcc: 0,
      pourEndAt: null,
      t: 0,
      lastBubbleT: -1,
      lastNoteBeat: -1,
    };
  },

  step(s, { dt, t, emit }) {
    const { p } = s;
    if (s.n < p.particles) {
      const perSource = p.particles / p.pourSeconds / s.sources.length;
      for (const src of s.sources) {
        src.acc += (perSource / src.perRow) * dt;
        while (src.acc >= 1 && s.n < p.particles) {
          src.acc -= 1;
          // One row of particles across the jet, perpendicular to its direction.
          const sp = hypot(src.vx, src.vy);
          const nx = -src.vy / sp;
          const ny = src.vx / sp;
          for (let r = 0; r < src.perRow && s.n < p.particles; r++) {
            const off = (r - (src.perRow - 1) / 2) * SPACING;
            const i = s.n++;
            s.x[i] = src.x + nx * off;
            s.y[i] = src.y + ny * off;
            s.vx[i] = src.vx;
            s.vy[i] = src.vy;
            s.col[i * 3] = src.color[0];
            s.col[i * 3 + 1] = src.color[1];
            s.col[i * 3 + 2] = src.color[2];
          }
        }
      }
      if (t - s.lastBubbleT >= 0.09) {
        s.lastBubbleT = t;
        emit({ type: 'pour', pitch: ((t * 1.7) % 1) });
      }
      if (s.n >= p.particles) {
        s.pourEndAt = t;
        emit({ type: 'poured' });
      }
    }
    const beat = Math.floor(t / 1.2);
    if (beat !== s.lastNoteBeat) {
      s.lastNoteBeat = beat;
      emit({ type: 'beat' });
    }

    const n = s.n;
    const { x, y, px, py, vx, vy } = s;
    for (let i = 0; i < n; i++) {
      vy[i] += GRAVITY * dt;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }

    // Neighbour grid.
    const grid = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 4096 + cy;
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(x[i] / H), Math.floor(y[i] / H));
      const cell = grid.get(k);
      if (cell) cell.push(i);
      else grid.set(k, [i]);
    }
    const pi: number[] = [];
    const pj: number[] = [];
    const pq: number[] = [];
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / H);
      const cy = Math.floor(y[i] / H);
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          const cell = grid.get(key(gx, gy));
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue;
            const r = hypot(x[j] - x[i], y[j] - y[i]);
            if (r < H && r > 1e-6) {
              pi.push(i);
              pj.push(j);
              pq.push(r / H);
            }
          }
        }
      }
    }

    // Viscosity impulses (on velocity), then double density relaxation (on position).
    if (p.viscosity > 0) {
      for (let k = 0; k < pi.length; k++) {
        const i = pi[k];
        const j = pj[k];
        const q = pq[k];
        const nx = (x[j] - x[i]) / (q * H);
        const ny = (y[j] - y[i]) / (q * H);
        const u = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
        if (u > 0) {
          // Clavet et al. viscosity impulse, normalised to a 60 Hz step and capped.
          const I = Math.min(u * 0.25, (1 - q) * p.viscosity * u * dt * 60 * 0.5);
          vx[i] -= I * nx;
          vy[i] -= I * ny;
          vx[j] += I * nx;
          vy[j] += I * ny;
        }
      }
    }
    // Neighbour lists (CSR) from the pair list.
    const deg = new Int32Array(n + 1);
    for (let k = 0; k < pi.length; k++) {
      deg[pi[k] + 1]++;
      deg[pj[k] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const fillPos = deg.slice(0, n);
    const nb = new Int32Array(pi.length * 2);
    for (let k = 0; k < pi.length; k++) {
      nb[fillPos[pi[k]]++] = pj[k];
      nb[fillPos[pj[k]]++] = pi[k];
    }

    // Double density relaxation (Clavet et al.), Gauss-Seidel over particles, repulsive only:
    // pressure never pulls particles together, which keeps the solver stable at any step size.
    const k0 = p.stiffness * K_SCALE;
    const scale = H * 0.5 * (dt * 60) ** 2;
    for (let i = 0; i < n; i++) {
      let rho = 0;
      let rhoN = 0;
      for (let e = deg[i]; e < deg[i + 1]; e++) {
        const j = nb[e];
        const q = hypot(x[j] - x[i], y[j] - y[i]) / H;
        if (q < 1) {
          const a = 1 - q;
          rho += a * a;
          rhoN += a * a * a;
        }
      }
      const P = k0 * Math.max(0, rho - REST);
      const PN = k0 * NEAR_K * rhoN;
      let dxi = 0;
      let dyi = 0;
      for (let e = deg[i]; e < deg[i + 1]; e++) {
        const j = nb[e];
        const rx = x[j] - x[i];
        const ry = y[j] - y[i];
        const r = hypot(rx, ry);
        const q = r / H;
        if (q >= 1 || r < 1e-9) continue;
        const a = 1 - q;
        const D = Math.min(MAX_D, (P * a + PN * a * a) * scale);
        const ux = (rx / r) * D * 0.5;
        const uy = (ry / r) * D * 0.5;
        x[j] += ux;
        y[j] += uy;
        dxi -= ux;
        dyi -= uy;
        // Colour diffusion between neighbours.
        if (p.mixRate > 0) {
          const m = p.mixRate * a * 0.5;
          for (let c = 0; c < 3; c++) {
            const d = (s.col[j * 3 + c] - s.col[i * 3 + c]) * m;
            s.col[i * 3 + c] += d;
            s.col[j * 3 + c] -= d;
          }
        }
      }
      x[i] += dxi;
      y[i] += dyi;
    }

    // Walls: continuous test against each segment (no tunnelling), then a thickness push-out.
    const WALL_R = PR + 4;
    for (let i = 0; i < n; i++) {
      for (const w of s.walls) {
        const dx = w.bx - w.ax;
        const dy = w.by - w.ay;
        const len = hypot(dx, dy);
        const nx = -dy / len;
        const ny = dx / len;
        const s0 = (px[i] - w.ax) * nx + (py[i] - w.ay) * ny;
        let s1 = (x[i] - w.ax) * nx + (y[i] - w.ay) * ny;
        const side = s0 >= 0 ? 1 : -1;
        if (s0 * s1 < 0) {
          // Crossed the wall's line this step: did it cross within the segment?
          const f = s0 / (s0 - s1);
          const ix = px[i] + (x[i] - px[i]) * f;
          const iy = py[i] + (y[i] - py[i]) * f;
          const u = ((ix - w.ax) * dx + (iy - w.ay) * dy) / (len * len);
          // Small overlap past the ends so particles can't slip through joints between segments.
          const eps = (WALL_R * 2) / len;
          if (u >= -eps && u <= 1 + eps) {
            x[i] += nx * (side * WALL_R - s1);
            y[i] += ny * (side * WALL_R - s1);
            s1 = side * WALL_R;
          }
        }
        const u = Math.max(0, Math.min(1, ((x[i] - w.ax) * dx + (y[i] - w.ay) * dy) / (len * len)));
        const cx = w.ax + dx * u;
        const cy = w.ay + dy * u;
        const ox = x[i] - cx;
        const oy = y[i] - cy;
        const d = hypot(ox, oy);
        if (d < WALL_R) {
          // Push out on the side the particle came from.
          const sx = d > 1e-9 && Math.sign(ox * nx + oy * ny) === side ? ox / d : nx * side;
          const sy = d > 1e-9 && Math.sign(ox * nx + oy * ny) === side ? oy / d : ny * side;
          x[i] = cx + sx * WALL_R;
          y[i] = cy + sy * WALL_R;
        }
      }
      if (x[i] < 8) x[i] = 8;
      if (x[i] > 1072) x[i] = 1072;
      if (y[i] > 1900) y[i] = 1900;
      if (y[i] < -200) y[i] = -200;
    }
    for (let i = 0; i < n; i++) {
      vx[i] = (x[i] - px[i]) / dt;
      vy[i] = (y[i] - py[i]) / dt;
      const sp = hypot(vx[i], vy[i]);
      // Light damping keeps the surface calm once poured; cap keeps rare collisions sane.
      const k = sp > MAX_V ? (MAX_V / sp) * 0.999 : 0.999;
      vx[i] *= k;
      vy[i] *= k;
    }
    s.t = t + dt;
  },

  isDone(s) {
    return s.pourEndAt !== null && s.t >= s.pourEndAt + s.p.settleSeconds;
  },

  hud(s) {
    return { poured: `${Math.round((s.n / s.p.particles) * 100)}%`, outro: s.pourEndAt !== null && s.t >= s.pourEndAt + s.p.settleSeconds - 2.5 };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.17 },
    ];
  },

  render({ ctx, theme }, s) {
    // Splat particles into a low-res density/colour field, then threshold into a soft surface.
    const SC = 4;
    const gw = 1080 / SC;
    const gh = 1920 / SC;
    let f = fields.get(s);
    if (!f) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(gw, gh) : Object.assign(document.createElement('canvas'), { width: gw, height: gh });
      f = { canvas, w: new Float32Array(gw * gh), c: new Float32Array(gw * gh * 3), img: (canvas.getContext('2d') as Ctx2D).createImageData(gw, gh) };
      fields.set(s, f);
    }
    f.w.fill(0);
    f.c.fill(0);
    const R = 4;
    for (let i = 0; i < s.n; i++) {
      const gx = s.x[i] / SC;
      const gy = s.y[i] / SC;
      for (let yy = Math.max(0, Math.floor(gy - R)); yy <= Math.min(gh - 1, Math.ceil(gy + R)); yy++) {
        for (let xx = Math.max(0, Math.floor(gx - R)); xx <= Math.min(gw - 1, Math.ceil(gx + R)); xx++) {
          const d = hypot(xx + 0.5 - gx, yy + 0.5 - gy) / R;
          if (d >= 1) continue;
          const w = (1 - d) * (1 - d);
          const o = yy * gw + xx;
          f.w[o] += w;
          f.c[o * 3] += s.col[i * 3] * w;
          f.c[o * 3 + 1] += s.col[i * 3 + 1] * w;
          f.c[o * 3 + 2] += s.col[i * 3 + 2] * w;
        }
      }
    }
    const data = f.img.data;
    for (let o = 0; o < gw * gh; o++) {
      const w = f.w[o];
      const a = Math.max(0, Math.min(1, (w - 0.35) / 0.35));
      data[o * 4 + 3] = a * 255;
      if (a > 0) {
        data[o * 4] = f.c[o * 3] / w;
        data[o * 4 + 1] = f.c[o * 3 + 1] / w;
        data[o * 4 + 2] = f.c[o * 3 + 2] / w;
      }
    }
    (f.canvas.getContext('2d') as Ctx2D).putImageData(f.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(f.canvas, 0, 0, 1080, 1920);

    // Container.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgbToCss(lighten(paletteAt(theme.palette, 0.5), 0.6), 0.85);
    ctx.lineWidth = 10;
    ctx.beginPath();
    s.walls.forEach((w, k) => {
      if (k === 0) ctx.moveTo(w.ax, w.ay);
      ctx.lineTo(w.bx, w.by);
    });
    ctx.stroke();
    // Pipes.
    for (const src of s.sources) {
      ctx.fillStyle = rgbToCss(lighten(src.color, 0.1));
      ctx.beginPath();
      ctx.arc(src.x, src.y, 22, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  audio(e, { melody, theme }) {
    switch (e.type) {
      case 'pour':
        return [{ kind: 'sfx', name: 'bubble', vel: 0.5, pitch: e.pitch as number }];
      case 'beat':
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: i ? 0.2 : 0.38, voice: theme.voice, dur: 1.8 }));
      case 'poured':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.4 }];
    }
    return [];
  },

  score(_events, { durationS, targetS }): DramaScore {
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    return { total: durFit, parts: { durFit } };
  },
};

const fields = new WeakMap<State, { canvas: OffscreenCanvas | HTMLCanvasElement; w: Float32Array; c: Float32Array; img: ImageData }>();
