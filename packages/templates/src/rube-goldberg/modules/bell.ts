import * as dm from '@sim/physics/math';
import { channel, funnel, rail } from '../parts';
import { ID_Q, quatAxis, v3, type Shape, type Sim, type V3 } from '../sim';
import { Z, across, catchFunnel, state, type ModuleDef } from './common';

// ——— Finale: a brass bell hanging just past the last lip; the marble flies off and rings it ———

export const BELL: ModuleDef = {
  kind: 'bell',
  showpiece: true,
  finale: true,
  build(ctx, e) {
    const { sim, rng } = ctx;
    const dir = across(e.at.x);
    const hole = catchFunnel(ctx, e, rng.range(0.05, 0.08));
    const start = v3(hole.x - dir * 0.012, hole.y - 0.03, hole.z);
    const length = rng.range(0.22, 0.3);
    const slope = rng.range(0.1, 0.14);
    const end = v3(start.x + dir * length, start.y - length * dm.sin(slope), start.z);
    channel(sim, start, end, { closedStart: true, finish: 'walnut' });
    // The bell hangs from a bracket, its mouth level with where the marble leaves the lip.
    const pivot = v3(end.x + dir * 0.055, end.y + 0.075, end.z);
    const bellR = 0.026;
    const profile = bellProfile(bellR, 0.05);
    const hang = 0.055;
    const crownY = 0.05 * 0.62;
    const bell = sim.addBody(
      v3(pivot.x, pivot.y - hang, pivot.z),
      ID_Q,
      [
        { piece: { shape: { kind: 'cylinder', r: bellR, hh: 0.025 }, draw: profile, finish: 'bell', pos: v3(0, 0, 0), rot: ID_Q }, material: 'brass', tag: 'bell', density: 1400 },
        // The bell's crown loop and the rod up to its pivot ring (they swing with it).
        { piece: { shape: { kind: 'torus', R: 0.0045, r: 0.0014 }, finish: 'bell', pos: v3(0, crownY + 0.004, 0), rot: quatAxis(v3(1, 0, 0), Math.PI / 2) }, material: 'brass', drawOnly: true },
        { piece: { shape: { kind: 'cylinder', r: 0.0016, hh: (hang - crownY - 0.008) / 2 }, finish: 'brass', pos: v3(0, (hang + crownY + 0.008) / 2, 0), rot: ID_Q }, material: 'brass', drawOnly: true },
      ],
      { angularDamping: 0.15 },
    );
    sim.hinge(null, bell, pivot, v3(0, hang, 0), Z);
    bracket(sim, pivot, dir);
    // A felt-lined cup underneath catches the marble for good.
    funnel(sim, v3(end.x + dir * 0.06, end.y - 0.12, end.z), 0.07, 0.02, 0.05, 'felt');
    let rung = false;
    return {
      kind: 'bell',
      check(s, events) {
        for (const ev of events) if ((ev.tagA === 'bell' || ev.tagB === 'bell') && (ev.tagA === 'marble' || ev.tagB === 'marble')) rung = true;
        if (rung) {
          s.emit('ding', { x: pivot.x });
          return state(s, e.marble);
        }
        const st = state(s, e.marble);
        return st.at.y < end.y - 0.3 ? 'fail' : null;
      },
      timeout: 6,
    };
  },
};

/**
 * The bell's bracket (drawing only): a walnut block on the board with a brass rosette, a turned
 * brass post standing behind the run, and a swan-neck arm curving out over the bell to a hanger ring.
 */
function bracket(sim: Sim, pivot: V3, dir: number) {
  const back = -0.035;
  const px = pivot.x + dir * 0.075;
  const baseY = pivot.y - 0.115;
  const topY = pivot.y + 0.01;
  const piece = (shape: Shape, finish: 'brass' | 'walnut', pos: V3, rot = ID_Q) => sim.addStatic({ shape, finish, pos, rot }, finish === 'brass' ? 'brass' : 'wood', 'bracket', false);
  piece({ kind: 'box', hx: 0.018, hy: 0.012, hz: 0.014, round: 0.004 }, 'walnut', v3(px, baseY, back - 0.004));
  piece({ kind: 'cylinder', r: 0.008, hh: 0.0015 }, 'brass', v3(px, baseY + 0.0135, back));
  // A turned post: a slim shaft with collars at the foot and the neck.
  piece({ kind: 'cylinder', r: 0.0035, hh: (topY - baseY - 0.015) / 2 }, 'brass', v3(px, (topY + baseY + 0.015) / 2, back));
  piece({ kind: 'cylinder', r: 0.0055, hh: 0.003 }, 'brass', v3(px, baseY + 0.018, back));
  piece({ kind: 'cylinder', r: 0.005, hh: 0.0025 }, 'brass', v3(px, topY - 0.004, back));
  piece({ kind: 'sphere', r: 0.0055 }, 'brass', v3(px, topY + 0.004, back));
  // The swan-neck arm: up from the post's head, curving forward and over to sit above the pivot.
  const p0 = v3(px, topY, back);
  const p1 = v3(px - dir * 0.01, pivot.y + 0.05, back * 0.3);
  const p2 = v3(pivot.x, pivot.y + 0.02, pivot.z);
  const bez = (u: number) => v3(
    (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x,
    (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y,
    (1 - u) * (1 - u) * p0.z + 2 * (1 - u) * u * p1.z + u * u * p2.z,
  );
  for (let k = 0; k < 14; k++) rail(sim, bez(k / 14), bez((k + 1) / 14), 0.0027, 'brass', 'bracket', false);
  piece({ kind: 'sphere', r: 0.0042 }, 'brass', p2);
  // The hanger: a short rod down to the ring the bell swings from.
  piece({ kind: 'cylinder', r: 0.0017, hh: 0.008 }, 'brass', v3(pivot.x, pivot.y + 0.011, pivot.z));
  piece({ kind: 'torus', R: 0.004, r: 0.0013 }, 'brass', v3(pivot.x, pivot.y, pivot.z), quatAxis(v3(1, 0, 0), Math.PI / 2));
}

/** A hand-bell's outline (a mesh drawn over the bell's simple cylinder collider). */
function bellProfile(r: number, h: number): { kind: 'mesh'; positions: Float32Array; indices: Uint32Array } {
  const prof: [number, number][] = [
    [0.0, h * 0.62],
    [r * 0.45, h * 0.6],
    [r * 0.62, h * 0.4],
    [r * 0.7, h * 0.1],
    [r * 0.85, -h * 0.25],
    [r * 1.08, -h * 0.45],
    [r * 1.0, -h * 0.5],
  ];
  const segs = 36;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [pr, py] of prof) for (let k = 0; k < segs; k++) positions.push(pr * Math.cos((k / segs) * Math.PI * 2), py, pr * Math.sin((k / segs) * Math.PI * 2));
  for (let j = 0; j < prof.length - 1; j++)
    for (let k = 0; k < segs; k++) {
      const a = j * segs + k;
      const b = j * segs + ((k + 1) % segs);
      indices.push(a, b, a + segs, b, b + segs, a + segs);
    }
  return { kind: 'mesh', positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

