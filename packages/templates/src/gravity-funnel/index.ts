import { z } from 'zod';
import { FONT_FAMILY, hexToRgb, lighten, paletteAt, rgbToCss, type DramaScore, type LeaderboardRow, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { COLOR_TEAMS, COUNTRY_TEAMS, pickDistinctTeams, type Team } from '../fx';
import { clamp01, gaussFit } from '../scoring';
import { THREE, canvasTexture, draw3D, environmentMap, sceneCache } from '../three-layer';

export const gravityFunnelSchema = z.object({
  marbles: z.number().int().min(3).max(8).default(6).meta({ title: 'Marbles' }),
  teams: z.enum(['colors', 'countries']).default('colors').meta({ title: 'Teams (colours or country flags)' }),
  decay: z.number().min(0.5).max(2).default(1).meta({ title: 'Rolling friction (how fast they spiral in)', step: 0.05 }),
  holeSize: z.number().min(0.1).max(0.22).default(0.14).meta({ title: 'Hole size', step: 0.01 }),
});

export type GravityFunnelParams = z.infer<typeof gravityFunnelSchema>;

interface Marble {
  team: Team;
  /** Horizontal position and velocity (the height follows from the funnel surface). */
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Rolling resistance (decel per second). */
  mu: number;
  alive: boolean;
  outAt: number;
  outR: number;
  outAng: number;
  outSpin: number;
  /** Orientation quaternion (x, y, z, w), visual only. */
  q: [number, number, number, number];
}

interface State {
  p: GravityFunnelParams;
  marbles: Marble[];
  hole: number;
  dropped: number[];
  winner: number;
  endAt: number | null;
  t: number;
  visual: boolean;
  /** Recent marble-marble hits and strip crossings (for sparks, flashes and the strip pulse). */
  hits: { t: number; x: number; z: number; speed: number; a: number; b: number }[];
  strips: { t: number; x: number; z: number }[];
}

/** Rim radius, funnel depth constant (height = -K / r), gravity, marble radius. */
const R = 1;
const K = 0.075;
const G = 80;
const RM = 0.068;
const START_R = 0.85;
/** Base rolling resistance: with decay 1 a match lasts about 30 s. */
const MU0 = 0.087;
const DRAG = 0.015;
/**
 * Fixed spread of rolling resistance between marbles (±e^0.66). Collisions randomise the order far
 * more than this, so it isn't a setting; it just stops marbles from dropping in one clump.
 */
const SPREAD = 0.66;
const RESTITUTION = 0.95;
/** The note strip runs from the hole to the rim on the side facing the camera. */
const STRIP_ANGLE = Math.PI / 2;
const STRIP_X = 0;
const STRIP_Z = 1;
const STRIP_WIDTH = 0.035;
const SPARKS = 10;
const OUTRO_S = 3.2;

const height = (r: number) => -K / r;
const slope = (r: number) => K / (r * r);
const circularSpeed = (r: number) => Math.sqrt((G * K) / r);
const teamName = (t: Team) => `${t.icon ? t.icon + ' ' : ''}${t.label}`;

export const gravityFunnel: Template<GravityFunnelParams, State> = {
  id: 'gravity-funnel',
  name: 'Gravity Funnel 3D',
  family: 'race',
  description:
    'Rendered in 3D: marbles (colours, or countries with their flags) roll around a spiral "wishing well" funnel like a charity coin funnel. They spin faster and faster as their orbits tighten, knock into each other with sparks, and drop through the hole in the middle one by one. A glowing strip runs across the funnel and every marble rolling over it plays a note, so the music speeds up as they spiral in. A live list shows who is still spinning; the last marble left wins.',
  schema: gravityFunnelSchema,
  substeps: 8,
  glowScale: 0.55,
  defaultCopy: {
    hook: 'Which marble stays up the longest?',
    cta: '{winner} outlasted them all! Who did you pick?',
  },
  nudges: ["Pick your marble 👇", "Who spins longest? Call it 👇", "Which one drops first? 👇", "Lock in a survivor 👇", "Comment your pick 👇", "Who's the last one spinning? 👇"],

  init({ params: p, rng, visual }) {
    const teams = pickDistinctTeams(p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS, p.marbles, rng, 90);
    // Each marble gets its own rolling resistance from an evenly spread (then shuffled) set, so drops
    // are spaced through the video rather than bunched; collisions shuffle the order further.
    const slots = Array.from({ length: p.marbles }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const a0 = rng.range(0, Math.PI * 2);
    const marbles: Marble[] = teams.map((team, i) => {
      const u = (slots[i] + rng.range(0.2, 0.8)) / p.marbles;
      const a = a0 + (i / p.marbles) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const r = START_R + rng.range(-0.03, 0.03);
      const v = circularSpeed(r) * rng.range(0.96, 1.04);
      return {
        team,
        x: r * dm.cos(a),
        z: r * dm.sin(a),
        vx: -dm.sin(a) * v,
        vz: dm.cos(a) * v,
        mu: MU0 * p.decay * dm.exp(SPREAD * (u - 0.5) * 2),
        alive: true,
        outAt: -1,
        outR: 0,
        outAng: 0,
        outSpin: 0,
        q: [0, 0, 0, 1],
      };
    });
    return { p, marbles, hole: p.holeSize, dropped: [], winner: -1, endAt: null, t: 0, visual, hits: [], strips: [] };
  },

  step(s, { dt, t, emit: emitRaw }) {
    s.t = t + dt;
    // The winner keeps spinning through the outro (same physics with or without visuals), silently.
    const emit: typeof emitRaw = (e) => {
      if (s.endAt === null) emitRaw(e);
    };
    const live = s.marbles.filter((m) => m.alive);
    for (const m of live) {
      // Polar state: radius, angle, radial speed and angular momentum (conserved but for friction).
      const r = Math.sqrt(m.x * m.x + m.z * m.z);
      const theta = dm.atan2(m.z, m.x);
      let rd = (m.vx * m.x + m.vz * m.z) / r;
      let L = -m.vx * m.z + m.vz * m.x;
      // Rolling resistance and a little drag slow it along its 3D path.
      const fp = slope(r);
      const sp = Math.sqrt(rd * rd * (1 + fp * fp) + (L * L) / (r * r));
      const k = Math.max(0, 1 - (m.mu / Math.max(sp, 1e-6) + DRAG) * dt);
      rd *= k;
      L *= k;
      // RK4 on the exact rolling equations for height = -K/r. Accurate enough that energy holds by
      // itself: no corrections, which (earlier) drained angular momentum and made outer marbles
      // stall and drop straight in instead of spiralling.
      const acc = (rr: number, v: number) => {
        const f1 = slope(rr);
        const f2 = (-2 * K) / (rr * rr * rr);
        return ((L * L) / (rr * rr * rr) - G * f1 - f1 * f2 * v * v) / (1 + f1 * f1);
      };
      const k1r = rd;
      const k1v = acc(r, rd);
      const r2 = r + 0.5 * dt * k1r;
      const k2r = rd + 0.5 * dt * k1v;
      const k2v = acc(r2, k2r);
      const r3 = r + 0.5 * dt * k2r;
      const k3r = rd + 0.5 * dt * k2v;
      const k3v = acc(r3, k3r);
      const r4 = r + dt * k3r;
      const k4r = rd + dt * k3v;
      const k4v = acc(r4, k4r);
      const r1 = r + (dt / 6) * (k1r + 2 * k2r + 2 * k3r + k4r);
      const rd1 = rd + (dt / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      const theta1 = theta + (dt / 6) * L * (1 / (r * r) + 2 / (r2 * r2) + 2 / (r3 * r3) + 1 / (r4 * r4));
      const ux = dm.cos(theta1);
      const uz = dm.sin(theta1);
      m.x = r1 * ux;
      m.z = r1 * uz;
      m.vx = rd1 * ux - (L / r1) * uz;
      m.vz = rd1 * uz + (L / r1) * ux;
      // Notes play only when a marble rolls over the strip, so they quicken as orbits tighten.
      const lap = (a: number) => Math.floor((a - STRIP_ANGLE) / (Math.PI * 2));
      if (lap(theta) !== lap(theta1)) {
        s.strips.push({ t, x: STRIP_X * r1, z: STRIP_Z * r1 });
        if (s.strips.length > 12) s.strips.shift();
        emit({ type: 'strip', r: r1, x: STRIP_X * r1 });
      }
      if (s.visual) roll(m, r1, dt);
    }

    // Rim wall.
    for (const m of live) {
      const r = Math.sqrt(m.x * m.x + m.z * m.z);
      if (r > R - RM) {
        const ux = m.x / r;
        const uz = m.z / r;
        m.x = ux * (R - RM);
        m.z = uz * (R - RM);
        const vr = m.vx * ux + m.vz * uz;
        if (vr > 0) {
          m.vx -= 1.5 * vr * ux;
          m.vz -= 1.5 * vr * uz;
          emit({ type: 'rim', x: m.x });
        }
      }
    }

    // Marble-marble collisions (resolved in the horizontal plane, detected in 3D).
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        const dy = height(Math.sqrt(a.x * a.x + a.z * a.z)) - height(Math.sqrt(b.x * b.x + b.z * b.z));
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= 4 * RM * RM) continue;
        const hd = Math.sqrt(dx * dx + dz * dz) || 1e-9;
        const nx = dx / hd;
        const nz = dz / hd;
        const over = 2 * RM - Math.sqrt(d2);
        a.x += nx * over * 0.5;
        a.z += nz * over * 0.5;
        b.x -= nx * over * 0.5;
        b.z -= nz * over * 0.5;
        const vn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (vn < 0) {
          const jimp = (-(1 + RESTITUTION) * vn) / 2;
          a.vx += jimp * nx;
          a.vz += jimp * nz;
          b.vx -= jimp * nx;
          b.vz -= jimp * nz;
          const cx = (a.x + b.x) / 2;
          const cz = (a.z + b.z) / 2;
          s.hits.push({ t, x: cx, z: cz, speed: -vn, a: s.marbles.indexOf(a), b: s.marbles.indexOf(b) });
          if (s.hits.length > 8) s.hits.shift();
          emit({ type: 'clack', speed: -vn, x: cx });
        }
      }

    // Drops through the hole.
    for (const m of live) {
      const r = Math.sqrt(m.x * m.x + m.z * m.z);
      if (r >= s.hole || !m.alive || s.endAt !== null) continue;
      m.alive = false;
      m.outAt = t;
      m.outR = r;
      m.outAng = dm.atan2(m.z, m.x);
      m.outSpin = (-m.vx * (m.z / r) + m.vz * (m.x / r)) / r;
      const idx = s.marbles.indexOf(m);
      s.dropped.push(idx);
      const left = s.marbles.filter((x) => x.alive);
      emit({ type: 'drop', who: idx, left: left.length, x: m.x });
      if (left.length <= 1) {
        s.winner = left.length ? s.marbles.indexOf(left[0]) : idx;
        const w = s.marbles[s.winner];
        emit({ type: 'win', who: s.winner, r: Math.sqrt(w.x * w.x + w.z * w.z), hole: s.hole });
        s.endAt = t;
      }
    }
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const rows: LeaderboardRow[] = [];
    const radius = (m: Marble) => Math.sqrt(m.x * m.x + m.z * m.z);
    const alive = s.marbles.filter((m) => m.alive).sort((a, b) => radius(b) - radius(a));
    for (const m of alive) rows.push({ label: m.team.label, color: m.team.color, icon: m.team.icon });
    for (const i of [...s.dropped].reverse()) {
      const m = s.marbles[i];
      if (i !== s.winner) rows.push({ label: m.team.label, color: m.team.color, icon: m.team.icon, out: true });
    }
    return {
      standings: rows,
      left: alive.length,
      winner: s.winner >= 0 ? teamName(s.marbles[s.winner].team) : '',
      outro: s.endAt !== null,
    };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.8, y: 0.12 },
      { kind: 'leaderboard', key: 'standings', title: 'STILL SPINNING', max: 8, x: 28, y: 0.16 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.115 },
    ];
  },

  render({ ctx, theme }, s) {
    const v = view(s, theme);
    s.marbles.forEach((m, i) => {
      const mesh = v.marbles[i];
      if (m.alive || (s.endAt !== null && i === s.winner)) {
        const r = Math.sqrt(m.x * m.x + m.z * m.z);
        const [nx, ny, nz] = normal(m.x, m.z, r);
        mesh.visible = true;
        mesh.position.set(m.x + nx * RM, height(r) + ny * RM, m.z + nz * RM);
        mesh.quaternion.set(m.q[0], m.q[1], m.q[2], m.q[3]);
        // Marbles glow briefly in their own colour on impact (a white flash blew the flags out).
        let flash = 0;
        for (const h of s.hits) if ((h.a === i || h.b === i) && s.t >= h.t) flash = Math.max(flash, clamp01(h.speed / 1.2) * Math.exp(-(s.t - h.t) * 9));
        const mat = mesh.material as THREE.MeshPhysicalMaterial;
        mat.emissiveIntensity = 0.3 * flash;
        mesh.scale.setScalar(1 + 0.06 * flash);
        return;
      }
      // Dropped: spin down the hole and vanish.
      const tau = s.t - m.outAt;
      mesh.visible = tau < 0.8;
      if (!mesh.visible) return;
      const a = m.outAng + m.outSpin * tau;
      const rr = m.outR * (1 - 0.55 * clamp01(tau / 0.5));
      mesh.position.set(rr * Math.cos(a), height(s.hole) - 2.2 * tau * tau - RM * 0.5, rr * Math.sin(a));
      mesh.scale.setScalar(1 - 0.4 * clamp01(tau / 0.8));
    });
    // Collisions: a spray of sparks at the contact point.
    let si = 0;
    for (const h of s.hits) {
      const tau = s.t - h.t;
      if (tau < 0 || tau > 0.5) continue;
      const hr = Math.sqrt(h.x * h.x + h.z * h.z);
      const [nx, ny, nz] = normal(h.x, h.z, hr);
      const base = new THREE.Vector3(h.x + nx * RM, height(hr) + ny * RM, h.z + nz * RM);
      const power = clamp01(h.speed / 1.2);
      for (let k = 0; k < SPARKS && si < v.sparks.length; k++) {
        const sp = v.sparks[si++];
        // Deterministic spray directions per hit (visual only).
        const a = k * 2.399 + h.t * 37;
        const up = 0.6 + 0.4 * Math.sin(k * 1.7 + h.t * 11);
        const speed = (0.8 + 1.6 * power) * (0.6 + 0.4 * Math.cos(k * 2.3));
        sp.visible = true;
        sp.position.set(base.x + Math.cos(a) * speed * tau, base.y + up * speed * tau - 2.5 * tau * tau, base.z + Math.sin(a) * speed * tau);
        sp.scale.setScalar(0.012 * (1 - tau / 0.5));
      }
    }
    for (; si < v.sparks.length; si++) v.sparks[si].visible = false;
    // The note strip pulses where a marble crosses it.
    let pulse = 0;
    let pi = 0;
    for (const c of s.strips) {
      const tau = s.t - c.t;
      if (tau < 0 || tau > 0.4) continue;
      pulse = Math.max(pulse, 1 - tau / 0.4);
      if (pi < v.stripPulses.length) {
        const m = v.stripPulses[pi++];
        const cr = Math.sqrt(c.x * c.x + c.z * c.z);
        const [nx, ny, nz] = normal(c.x, c.z, cr);
        m.visible = true;
        m.position.set(c.x + nx * 0.006, height(cr) + ny * 0.006, c.z + nz * 0.006);
        m.lookAt(m.position.x + nx, m.position.y + ny, m.position.z + nz);
        m.scale.setScalar(0.03 + 0.12 * (tau / 0.4));
        (m.material as THREE.MeshBasicMaterial).opacity = 1 - tau / 0.4;
      }
    }
    for (; pi < v.stripPulses.length; pi++) v.stripPulses[pi].visible = false;
    (v.strip.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * pulse;
    if (s.endAt !== null && s.winner >= 0) {
      const w = v.marbles[s.winner];
      const pulse = 1 + 0.08 * Math.sin((s.t - s.endAt) * 10);
      v.halo.visible = true;
      v.halo.position.copy(w.position);
      v.halo.scale.setScalar(RM * 1.7 * pulse);
      v.halo.lookAt(v.camera.position);
    }
    draw3D(ctx, v.scene, v.camera);
  },

  renderTop({ ctx, theme }, s) {
    if (s.endAt === null || s.winner < 0) return;
    // Crown over the winner, placed by projecting its 3D position to the screen.
    const v = view(s, theme);
    const p = v.marbles[s.winner].position.clone().project(v.camera);
    const x = (p.x * 0.5 + 0.5) * 1080;
    const y = (-p.y * 0.5 + 0.5) * 1920;
    const bob = Math.sin((s.t - s.endAt) * 6) * 6;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `64px ${FONT_FAMILY}`;
    ctx.fillText('👑', x, y - 80 + bob);
    ctx.restore();
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) * 0.7)) : 0;
    switch (e.type) {
      case 'strip': {
        const u = clamp01((START_R - (e.r as number)) / (START_R - 0.1));
        if (e.t - lastNoteT < 0.06) return [{ kind: 'sfx', name: 'tick', vel: 0.12, pitch: 0.4 + 0.6 * u, pan }];
        return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: (i ? 0.24 : 0.52) * (0.8 + 0.2 * u), voice: theme.voice, pan }));
      }
      case 'clack': {
        const v = clamp01((e.speed as number) / 1.6);
        return [{ kind: 'sfx', name: 'clack', vel: 0.45 + 0.55 * v, pitch: 0.3 + 0.6 * v, pan }];
      }
      case 'rim':
        return [{ kind: 'sfx', name: 'tick', vel: 0.15, pitch: 0.2, pan }];
      case 'drop': {
        const left = e.left as number;
        return [
          { kind: 'sfx', name: 'whoosh', vel: 0.5 },
          { kind: 'sfx', name: 'pop', vel: 0.45, pitch: 0.3 },
          { kind: 'note', midi: 60 + left * 2, vel: 0.4, voice: 'bell', dur: 1.2 },
        ];
      }
      case 'win':
        return [
          { kind: 'sfx', name: 'chime', vel: 0.85 },
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
    const win = events.find((e) => e.type === 'win');
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    const drops = events.filter((e) => e.type === 'drop').map((e) => e.t);
    const gaps = drops.map((d, i) => d - (i ? drops[i - 1] : 0));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    // Drops spread through the video, the first one coming early enough to set the stakes.
    const evenFit = 1 - clamp01(sd / mean / 0.8);
    const firstFit = clamp01((0.5 - drops[0] / win.t) / 0.25);
    const clacks = events.filter((e) => e.type === 'clack' && (e.speed as number) > 0.3).length;
    const clackFit = 1 - dm.exp(-clacks / 6);
    // The winner itself was close to falling in when the last rival dropped.
    const closeFit = 1 - clamp01(((win.r as number) - (win.hole as number)) / 0.45);
    return {
      total: durFit * (0.3 + 0.25 * evenFit + 0.15 * firstFit + 0.15 * clackFit + 0.15 * closeFit),
      parts: { durFit, evenFit, firstFit, clackFit, closeFit },
      notes: [`${clacks} hits`, `first drop ${drops[0].toFixed(1)}s`],
    };
  },
};

function normal(x: number, z: number, r: number): [number, number, number] {
  const s = slope(r);
  const nx = (-s * x) / r;
  const nz = (-s * z) / r;
  const l = Math.sqrt(nx * nx + 1 + nz * nz);
  return [nx / l, 1 / l, nz / l];
}

/** Visual only: rotate the marble as if rolling without slipping along the surface. */
function roll(m: Marble, r: number, dt: number) {
  const [nx, ny, nz] = normal(m.x, m.z, r);
  const vy = slope(r) * ((m.vx * m.x + m.vz * m.z) / r);
  // ω = n × v / radius
  const wx = (ny * m.vz - nz * vy) / RM;
  const wy = (nz * m.vx - nx * m.vz) / RM;
  const wz = (nx * vy - ny * m.vx) / RM;
  const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (w < 1e-9) return;
  const half = (w * dt) / 2;
  const sn = Math.sin(half) / w;
  const dq = [wx * sn, wy * sn, wz * sn, Math.cos(half)];
  const [x, y, z, ww] = m.q;
  const q: [number, number, number, number] = [
    dq[3] * x + dq[0] * ww + dq[1] * z - dq[2] * y,
    dq[3] * y - dq[0] * z + dq[1] * ww + dq[2] * x,
    dq[3] * z + dq[0] * y - dq[1] * x + dq[2] * ww,
    dq[3] * ww - dq[0] * x - dq[1] * y - dq[2] * z,
  ];
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  m.q = [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// ---- 3D scene ---------------------------------------------------------------------------------------

const view = sceneCache((s: State, theme) => {
  const scene = new THREE.Scene();
  scene.environment = environmentMap();
  // The studio environment's diffuse light washes the marbles' colours out at full strength.
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(40, 1080 / 1920, 0.05, 50);
  camera.position.set(0, 4.15, 3.3);
  camera.lookAt(0, 0.18, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1.4, 3.2, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -1.3, right: 1.3, top: 1.3, bottom: -1.3, near: 0.5, far: 8 });
  sun.shadow.bias = -0.0015;
  scene.add(sun);

  // Funnel surface: a lathe of height = -K/r, sampled densely near the hole.
  const N = 90;
  const pts: THREE.Vector2[] = [];
  for (let j = 0; j <= N; j++) {
    const r = s.hole + (R - s.hole) * (j / N) ** 1.6;
    pts.push(new THREE.Vector2(r, height(r)));
  }
  pts.push(new THREE.Vector2(R + 0.04, height(R) + 0.025), new THREE.Vector2(R + 0.09, height(R) + 0.02));
  const vOf = (r: number) => (((r - s.hole) / (R - s.hole)) ** (1 / 1.6) * N) / (pts.length - 1);
  const pal = theme.palette;
  const tex = canvasTexture(2048, 512, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 512);
    const deep = paletteAt(pal, 0.15);
    const edge = paletteAt(pal, 0.75);
    g.addColorStop(0, rgbToCss(deep.map((x) => x * 0.35) as [number, number, number]));
    g.addColorStop(1, rgbToCss(edge.map((x) => x * 0.55) as [number, number, number]));
    c.fillStyle = g;
    c.fillRect(0, 0, 2048, 512);
    // Radial lines and rings make the speed of the marbles readable.
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 3;
    for (let k = 0; k < 48; k++) {
      c.beginPath();
      c.moveTo((k / 48) * 2048, 0);
      c.lineTo((k / 48) * 2048, 512);
      c.stroke();
    }
    for (const rr of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
      const y = vOf(rr) * 512;
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(2048, y);
      c.stroke();
    }
  });
  const funnel = new THREE.Mesh(new THREE.LatheGeometry(pts, 160), new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.42, side: THREE.DoubleSide }));
  funnel.receiveShadow = true;
  scene.add(funnel);

  const accent = new THREE.Color(theme.accent);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.09, 0.03, 16, 160), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.25, emissive: accent, emissiveIntensity: 0.35 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height(R) + 0.02;
  scene.add(rim);
  // The hole: a dark tube with a glowing lip.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(s.hole, s.hole * 0.92, 1, 64, 1, true), new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 1, side: THREE.DoubleSide }));
  tube.position.y = height(s.hole) - 0.5;
  scene.add(tube);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(s.hole, 0.012, 10, 96), new THREE.MeshBasicMaterial({ color: accent }));
  lip.rotation.x = Math.PI / 2;
  lip.position.y = height(s.hole);
  scene.add(lip);

  const geo = new THREE.SphereGeometry(RM, 48, 32);
  const marbles = s.marbles.map((m) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshPhysicalMaterial({ map: marbleTexture(m.team), roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15, emissive: new THREE.Color(m.team.color), emissiveIntensity: 0 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  });
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  halo.visible = false;
  scene.add(halo);
  // Note strip: a glowing band from the hole to the rim on the side facing the camera.
  const stripGeo = new THREE.BufferGeometry();
  const verts: number[] = [];
  const idx: number[] = [];
  const SEG = 80;
  for (let j = 0; j <= SEG; j++) {
    const rr = s.hole + (R - s.hole) * (j / SEG) ** 1.4;
    const half = STRIP_WIDTH / 2 / rr;
    const [nx, ny, nz] = normal(Math.cos(STRIP_ANGLE) * rr, Math.sin(STRIP_ANGLE) * rr, rr);
    for (const side of [-1, 1]) {
      const a = STRIP_ANGLE + side * half;
      verts.push(Math.cos(a) * rr + nx * 0.004, height(rr) + ny * 0.004, Math.sin(a) * rr + nz * 0.004);
    }
    if (j < SEG) idx.push(2 * j, 2 * j + 1, 2 * j + 2, 2 * j + 1, 2 * j + 3, 2 * j + 2);
  }
  stripGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  stripGeo.setIndex(idx);
  const strip = new THREE.Mesh(stripGeo, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
  scene.add(strip);
  const pulseMat = () => new THREE.MeshBasicMaterial({ color: accent, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const stripPulses = Array.from({ length: 6 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 32), pulseMat());
    m.visible = false;
    scene.add(m);
    return m;
  });
  const sparkGeo = new THREE.SphereGeometry(1, 8, 6);
  const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfff1c0 });
  const sparks = Array.from({ length: 4 * SPARKS }, () => {
    const m = new THREE.Mesh(sparkGeo, sparkMat);
    m.visible = false;
    scene.add(m);
    return m;
  });
  return { scene, camera, marbles, halo, strip, stripPulses, sparks };
});

/** Flag (both sides of the sphere) or team colour with a white band, so rolling is visible. */
function marbleTexture(team: Team) {
  return canvasTexture(512, 256, (c) => {
    c.fillStyle = team.color;
    c.fillRect(0, 0, 512, 256);
    if (team.icon) {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `200px ${FONT_FAMILY}`;
      c.fillText(team.icon, 128, 140);
      c.fillText(team.icon, 384, 140);
    } else {
      const light = rgbToCss(lighten(hexToRgb(team.color), 0.85));
      c.fillStyle = light;
      c.fillRect(0, 112, 512, 32);
      c.beginPath();
      c.arc(128, 60, 26, 0, Math.PI * 2);
      c.arc(384, 196, 26, 0, Math.PI * 2);
      c.fill();
    }
  });
}
