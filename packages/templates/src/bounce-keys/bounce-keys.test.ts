import { describe, expect, it } from 'vitest';
import { Runner, getTheme } from '@sim/engine';
import { MELODIES, getMelody } from '@sim/audio';
import { bounceKeys } from './index';
import { BOUNCE_KEYS_STYLES } from './index';
import { arcAt, bounceNormal, buildTimeline, solveArc, tonicOf } from './timeline';
import { FAST_TILT, GRAVITY_RATE, RESTITUTION } from './hops';

const theme = getTheme('neon-dark');
const run = (melodyId: string, params: Record<string, unknown> = {}, seed = 1) =>
  new Runner(bounceKeys, { seed, theme, melody: getMelody(melodyId), params, visual: false }).runToEnd();

describe('timeline', () => {
  it('ends on a phrase that comes home to the tonic, close to the asked length', () => {
    for (const m of MELODIES) {
      const tl = buildTimeline(m, 0, 27);
      const last = tl.onsets.at(-1)!;
      const lastStep = [last.midi, ...last.bass];
      // Canon in D is a ground bass that never cadences; anything else must end at home.
      if (m.id !== 'canon-in-d') expect(lastStep.some((n) => n % 12 === tonicOf(m)), m.id).toBe(true);
      expect(last.t, m.id).toBeGreaterThan(27 * 0.7);
      expect(last.t, m.id).toBeLessThan(27 * 1.3);
    }
  });

  it('solves hops that land exactly on target and peak above both ends', () => {
    const a = solveArc({ x: 100, y: 900, z: -50 }, { x: 400, y: 1000, z: 70 }, 2, 0.4, 700);
    const end = arcAt(a, 2.4);
    expect(end.x).toBeCloseTo(400, 6);
    expect(end.y).toBeCloseTo(1000, 6);
    expect(end.z).toBeCloseTo(70, 6);
    const apexT = -a.vy / a.g;
    expect(a.y0 + a.vy * apexT + 0.5 * a.g * apexT * apexT).toBeCloseTo(700, 6);
  });
});

describe('bar tilt', () => {
  const reflect = (d: { x: number; y: number; z: number }, n: { x: number; y: number; z: number }) => {
    const k = 2 * (d.x * n.x + d.y * n.y + d.z * n.z);
    return { x: d.x - k * n.x, y: d.y - k * n.y, z: d.z - k * n.z };
  };
  const unit = (d: { x: number; y: number; z: number }) => {
    const l = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };

  it('mirrors the incoming direction onto the outgoing one', () => {
    const vin = { x: 300, y: 900, z: 120 };
    const vout = { x: 250, y: -700, z: -40 };
    const out = unit(reflect(unit(vin), bounceNormal(vin, vout, 1.2)));
    const want = unit(vout);
    expect(out.x).toBeCloseTo(want.x, 9);
    expect(out.y).toBeCloseTo(want.y, 9);
    expect(out.z).toBeCloseTo(want.z, 9);
  });

  it('stays flat for a straight down-and-up bounce and never leans past the limit', () => {
    expect(bounceNormal({ x: 0, y: 800, z: 0 }, { x: 0, y: -800, z: 0 }, 0.6)).toEqual({ x: 0, y: -1, z: 0 });
    const steep = bounceNormal({ x: 900, y: 100, z: 0 }, { x: -900, y: -100, z: 0 }, 0.6);
    expect(Math.acos(-steep.y)).toBeCloseTo(0.6, 9);
  });
});

describe('bounce keys', () => {
  it.each([...BOUNCE_KEYS_STYLES])('lands every note on its beat (%s)', (style) => {
    for (const m of MELODIES) {
      const r = run(m.id, { style });
      const onsets = r.state.onsets;
      const lands = r.events.filter((e) => e.type === 'land');
      expect(lands, m.id).toHaveLength(onsets.length);
      lands.forEach((e, i) => {
        // Events are stamped at the start of the 1/240 s substep the landing falls in.
        expect(onsets[i].t - e.t, m.id).toBeGreaterThanOrEqual(0);
        expect(onsets[i].t - e.t, m.id).toBeLessThan(1 / 240 + 1e-9);
        expect(e.midi).toBe(onsets[i].midi);
      });
    }
  });

  it.each([...BOUNCE_KEYS_STYLES])('hops end on the landing points and rise above them (%s)', (style) => {
    for (const id of ['fur-elise', 'toccata', 'saints']) {
      const s = run(id, { style }).state;
      s.arcs.forEach((a, i) => {
        const end = arcAt(a, a.t0 + a.dt);
        expect(end.x).toBeCloseTo(s.lands[i].x, 6);
        expect(end.y).toBeCloseTo(s.lands[i].y, 6);
        expect(end.z).toBeCloseTo(s.lands[i].z, 6);
        const apexT = Math.max(0, -a.vy / a.g);
        const apexY = a.y0 + a.vy * apexT + 0.5 * a.g * apexT * apexT;
        expect(apexY).toBeLessThanOrEqual(Math.min(a.y0, s.lands[i].y) + 1e-6);
      });
    }
  });

  it('makes a video close to the asked length for every song', () => {
    for (const m of MELODIES) {
      const r = run(m.id);
      expect(r.timedOut, m.id).toBe(false);
      // Phrases are whole and the tempo only stretches so far, so some songs land further off.
      expect(r.durationS, m.id).toBeGreaterThan(32 * 0.75);
      expect(r.durationS, m.id).toBeLessThan(32 * 1.25);
    }
  });

  it('reveals the song after the last note and names it in the hud', () => {
    const r = run('jingle-bells');
    const lastLand = r.events.filter((e) => e.type === 'land').at(-1)!;
    const reveal = r.events.find((e) => e.type === 'reveal')!;
    expect(reveal.t).toBeGreaterThan(lastLand.t);
    const hud = bounceKeys.hud(r.state);
    expect(hud.answer).toBe('Jingle Bells');
    expect(hud.outro).toBe(true);
  });

  it('brings in the bass ball partway through, and leaves it out when off', () => {
    const r = run('ode-to-joy');
    const bass = r.events.filter((e) => e.type === 'bassLand');
    expect(bass.length).toBeGreaterThan(3);
    expect(bass[0].t).toBeGreaterThan(r.durationS * 0.3);
    expect(run('ode-to-joy', { bassBall: false }).events.some((e) => e.type === 'bassLand')).toBe(false);
  });

  it('can bring the bass ball in a quarter of the way through', () => {
    for (const id of ['ode-to-joy', 'jingle-bells', 'twinkle']) {
      const half = run(id).events.find((e) => e.type === 'bassLand')!;
      const quarter = run(id, { bassEntry: 'quarter' }).events.find((e) => e.type === 'bassLand')!;
      expect(quarter.t, id).toBeLessThan(half.t);
      expect(quarter.t, id).toBeLessThan(32 * 0.35);
    }
  });

  it.each([...BOUNCE_KEYS_STYLES])('hops under one slowly drifting gravity, landing on top of gently tilted bars (%s)', (style) => {
    const speedChanges: number[] = [];
    const tilts: number[] = [];
    for (const m of MELODIES) {
      const s = run(m.id, { style }).state;
      for (let i = 1; i < s.gravity.length; i++) expect(Math.abs(Math.log(s.gravity[i] / s.gravity[i - 1])), m.id).toBeLessThanOrEqual(GRAVITY_RATE + 1e-9);
      // Bars lean gently; only in fast runs may they lean steeply to send the ball back and forth.
      for (const n of s.normals) tilts.push(Math.acos(Math.min(1, -n.y)));
      for (const n of s.normals) expect(Math.acos(Math.min(1, -n.y)), m.id).toBeLessThanOrEqual(FAST_TILT + 1e-6);
      const ends = s.arcs.slice(1).map((a) => arcAt(a, Infinity));
      // Every landing comes down onto its bar, never up into it.
      for (const e of ends) expect(e.vy, m.id).toBeGreaterThan(0);
      const sp = ends.map((e) => Math.hypot(e.vx, e.vy, e.vz));
      for (let i = 1; i < sp.length; i++) speedChanges.push(Math.max(sp[i] / sp[i - 1], sp[i - 1] / sp[i]));
      if (style === 'spiral') for (const l of s.lands) expect(Math.hypot(l.x - 540, l.z), m.id).toBeLessThanOrEqual(400 + 1e-6);
      if (style === 'cascade') for (const l of s.lands) expect(l.x, m.id).toBeGreaterThanOrEqual(120 - 1e-6), expect(l.x, m.id).toBeLessThanOrEqual(960 + 1e-6);
    }
    // Speed follows the rhythm (that's physics), but a typical hop stays close to the last one.
    speedChanges.sort((a, b) => a - b);
    expect(speedChanges[speedChanges.length >> 1]).toBeLessThan(1.35);
    // Most bars lean gently. (Falling is seen from straight above, where only sideways spacing keeps
    // bars apart, so most of its hops use the steep fast-run bars.)
    tilts.sort((a, b) => a - b);
    if (style !== 'falling') expect(tilts[tilts.length >> 1]).toBeLessThanOrEqual(0.35 + 1e-6);
  });

  it.each(['cascade', 'cascade-3d', 'spiral', 'falling'])('keeps nearby bars from piling up, even in fast runs (%s)', (style) => {
    // Bars overlap on screen when close sideways and (except seen from above) at about the same height.
    let stacked = 0;
    let pairs = 0;
    for (const m of MELODIES) {
      const s = run(m.id, { style }).state;
      const ahead = style === 'falling' ? 3 : 6;
      const before = stacked;
      for (let i = 0; i < s.lands.length; i++) {
        for (let j = i + 1; j <= Math.min(s.lands.length - 1, i + ahead); j++) {
          const a = s.lands[i];
          const b = s.lands[j];
          const w = (118 * (s.sizes[i] + s.sizes[j])) / 2;
          const [du, dv] = style === 'falling' ? [a.x - b.x, a.z - b.z] : [Math.hypot(a.x - b.x, a.z - b.z), a.y - b.y];
          pairs++;
          if (Math.abs(du) < w && Math.abs(dv) < 36) stacked++;
        }
      }
      if ((style === 'cascade' || style === 'cascade-3d') && (m.id === 'turkish-march' || m.id === 'fur-elise')) expect(stacked - before, m.id).toBe(0);
    }
    expect(stacked / pairs).toBeLessThan(style === 'falling' ? 0.08 : 0.01);
  });

  it.each(['cascade', 'cascade-3d', 'spiral'])('zigzags fast runs back and forth between facing bars (%s)', (style) => {
    for (const id of ['turkish-march', 'entertainer', 'toccata']) {
      const s = run(id, { style }).state;
      const steep = s.normals.map((n) => Math.acos(Math.min(1, -n.y)) > 0.36);
      let pairs = 0;
      let reversed = 0;
      for (let i = 2; i < s.arcs.length; i++) {
        if (!steep[i - 1] || !steep[i - 2]) continue;
        // Each hop in a run heads back the opposite way to the one before.
        const a = s.arcs[i - 1];
        const b = s.arcs[i];
        pairs++;
        if (a.vx * b.vx + a.vz * b.vz < 0) reversed++;
      }
      if (id === 'turkish-march') expect(pairs).toBeGreaterThan(50);
      // Rondo's runs always zigzag. The Entertainer's and Toccata's sit beside held notes, where
      // gravity is low and a hard turn would need a bar on end, so some hops carry on instead: a
      // few in the flat cascades, more on the spiral, where they circle on round the column.
      if (!pairs) continue;
      if (id === 'turkish-march') expect(reversed / pairs, id).toBe(1);
      else if (style !== 'spiral') expect(reversed / pairs, id).toBeGreaterThanOrEqual(0.9);
    }
  });

  it.each(['cascade', 'cascade-3d', 'spiral', 'falling'])('constant gravity: one gravity, no bounce above its drop, still on the beat (%s)', (style) => {
    for (const m of MELODIES) {
      const r = run(m.id, { style, physics: 'constant' });
      const s = r.state;
      expect(new Set(s.gravity).size, m.id).toBe(1);
      for (const a of s.arcs.slice(1)) expect(a.g, m.id).toBe(s.gravity[0]);
      for (let i = 1; i < s.arcs.length; i++) {
        const into = arcAt(s.arcs[i - 1], Infinity).vy;
        // Rising speed off a bar is at most RESTITUTION of the falling speed onto it, so the bounce
        // tops out below the height the ball fell from.
        if (s.arcs[i].vy < 0) expect(-s.arcs[i].vy, `${m.id} hop ${i}`).toBeLessThanOrEqual(RESTITUTION * into + 1e-6);
      }
      const lands = r.events.filter((e) => e.type === 'land');
      lands.forEach((e, i) => expect(s.onsets[i].t - e.t, m.id).toBeLessThan(1 / 240 + 1e-9));
    }
    // Rondo still zigzags.
    const s = run('turkish-march', { style, physics: 'constant' }).state;
    const steep = s.normals.map((n) => Math.acos(Math.min(1, -n.y)) > 0.36);
    for (let i = 2; i < s.arcs.length; i++) if (steep[i - 1] && steep[i - 2] && style !== 'falling') expect(s.arcs[i - 1].vx * s.arcs[i].vx + s.arcs[i - 1].vz * s.arcs[i].vz).toBeLessThan(0);
  });

  it('keeps the keyboard eased whatever the physics setting', () => {
    expect(run('fur-elise', { style: 'keys', physics: 'constant' }).state.gravity).toEqual(run('fur-elise', { style: 'keys' }).state.gravity);
  });

  it('gives short notes shorter bars', () => {
    const s = run('toccata', { style: 'cascade' }).state;
    const short = s.onsets.map((o, i) => ({ o, size: s.sizes[i] })).filter(({ o }) => o.dur < 0.15);
    expect(short.length).toBeGreaterThan(3);
    for (const { size } of short) expect(size).toBeLessThan(1);
    expect(Math.min(...s.sizes)).toBeGreaterThanOrEqual(0.55);
  });

  it('puts short notes on bars close by and long notes further away', () => {
    const s = run('fur-elise', { style: 'cascade' }).state;
    const hops = s.arcs.slice(1).map((a, i) => ({ dt: a.dt, dist: Math.hypot(s.lands[i + 1].x - s.lands[i].x, s.lands[i + 1].y - s.lands[i].y) }));
    const short = hops.filter((h) => h.dt < 0.3);
    const long = hops.filter((h) => h.dt > 0.6);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(long.map((h) => h.dist))).toBeGreaterThan(2 * mean(short.map((h) => h.dist)));
  });

  it('tilts cascade bars but keeps the keyboard flat', () => {
    const tilted = run('fur-elise', { style: 'cascade' }).state.normals.filter((n) => Math.abs(n.x) > 0.05).length;
    expect(tilted).toBeGreaterThan(10);
    expect(run('fur-elise', { style: 'keys' }).state.normals.every((n) => n.x === 0 && n.y === -1)).toBe(true);
  });

  it('spreads the 3D layouts into depth', () => {
    for (const style of ['cascade-3d', 'spiral', 'falling']) {
      const zs = run('ode-to-joy', { style }).state.lands.map((l) => l.z);
      expect(Math.max(...zs) - Math.min(...zs), style).toBeGreaterThan(150);
    }
  });

  it('plays the chosen voice, or the theme\'s', () => {
    const notes = (params: Record<string, unknown>) => run('twinkle', params).audio.filter((a) => a.kind === 'note' && a.voice !== 'softsine' && a.voice !== 'pluck');
    expect(new Set(notes({ voice: 'bell' }).map((a) => a.kind === 'note' && a.voice))).toEqual(new Set(['bell']));
    expect(new Set(notes({}).map((a) => a.kind === 'note' && a.voice))).toEqual(new Set([theme.voice]));
  });

  it('builds its run from the melody, so a new song is a new run', () => {
    expect(bounceKeys.melodyDriven).toBe(true);
    expect(run('twinkle').durationS).not.toBe(run('fur-elise').durationS);
  });
});
