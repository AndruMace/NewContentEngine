/**
 * Body layout for the simulation: where each part of a fighter is (in its own frame: x its left, y up,
 * z ahead, metres, at rest), what it strikes with for each move, and how far each striking part can reach
 * (the body leaning into the blow, the neck or the limb stretching). The sim lands a blow only when the
 * striking part can reach the spot it aims at; the view (contact.ts) then poses that part onto the same
 * spot, so what counts as a hit is what is drawn as one. Plain numbers from the species' skeletons (and the
 * head's shape, measured once): no rendering.
 */
import type { CreatureDef, MoveDef } from '../roster';
import { MeshBuilder, type V3 } from './builder';
import type { LegName, LegSpec, ProcSpec } from './rig';
import { SPECIES } from './species';

/** A spot on the body: the part, its side (1: the fighter's left), a place within it (0..1 each). */
export interface Spot3 {
  zone: 'head' | 'body' | 'fore' | 'hind' | 'wing';
  side: 1 | -1;
  u: number;
  v: number;
}

/** What lands a blow: the jaws, the brow (horns, antlers), limb ends, a blade. */
export type StrikePart = { kind: 'snout' } | { kind: 'brow' } | { kind: 'paw'; limb: LegName } | { kind: 'sword' };

/** The parts a move strikes with, for its hit `k` (none: a tail sweep, a breath, a roar). */
export function strikeParts(def: CreatureDef, m: MoveDef, k: number): StrikePart[] {
  const kind = def.proc.kind;
  switch (m.clip) {
    case 'bite':
    case 'lunge':
    case 'snap':
    case 'maul':
    case 'frenzy':
      return [{ kind: 'snout' }];
    case 'headbutt':
    case 'charge':
    case 'toss':
      return [{ kind: 'brow' }];
    case 'swat':
      // (The head swings, tusks and trunk with it.)
      return [{ kind: 'brow' }];
    case 'stomp':
      return def.feet === 'foot' ? [{ kind: 'paw', limb: 'RL' }] : [
        { kind: 'paw', limb: 'LF' },
        { kind: 'paw', limb: 'RF' },
      ];
    case 'chop':
    case 'club':
      return [{ kind: 'sword' }];
    case 'bash':
    case 'backhand':
      return [{ kind: 'paw', limb: 'LA' }];
    case 'pummel':
    case 'grapple':
      return [
        { kind: 'paw', limb: 'LA' },
        { kind: 'paw', limb: 'RA' },
      ];
    case 'dive':
      return [{ kind: 'paw', limb: 'LF' }, { kind: 'paw', limb: 'RF' }, { kind: 'snout' }];
    case 'swipe':
      return [{ kind: 'paw', limb: kind === 'bear' ? 'LF' : 'RF' }];
    case 'rear':
      return [{ kind: 'paw', limb: k === 0 ? 'LF' : 'RF' }];
    case 'buck':
      return [
        { kind: 'paw', limb: 'LH' },
        { kind: 'paw', limb: 'RH' },
      ];
    case 'combo':
      return k === 0
        ? [{ kind: 'brow' }]
        : [
            { kind: 'paw', limb: 'LH' },
            { kind: 'paw', limb: 'RH' },
          ];
    case 'slash':
      return [{ kind: 'sword' }];
    case 'kick':
      return [{ kind: 'paw', limb: 'RL' }];
    case 'punch_l':
      return [{ kind: 'paw', limb: 'LA' }];
    case 'punch_r':
      return [{ kind: 'paw', limb: 'RA' }];
    case 'pounce':
      return [{ kind: 'snout' }, { kind: 'paw', limb: 'LF' }, { kind: 'paw', limb: 'RF' }];
    case 'leap':
      return [{ kind: 'snout' }, { kind: 'paw', limb: 'L1' }, { kind: 'paw', limb: 'R1' }];
  }
  return [];
}

/** The limb a zone means on this body: arms are a person's fore limbs; the front or back pair otherwise. */
export function limbFor(spec: ProcSpec, zone: 'fore' | 'hind', side: 1 | -1): LegName | null {
  const own = spec.legs.filter((l) => Math.sign(l.hip[0]) === side);
  if (!own.length) return null;
  if (own.some((l) => l.arm)) return (own.find((l) => (zone === 'fore' ? !!l.arm : !l.arm)) ?? own[0]).name;
  const sorted = [...own].sort((a, b) => b.home[2] - a.home[2]);
  return (zone === 'fore' ? sorted[0] : sorted[sorted.length - 1]).name;
}

/** How far the body leans into a blow as the sim counts it (the view's reachFor allows a little more, to spare). */
export const LEAN = 0.45;

/** How far a limb reaches from its hip or shoulder (its last joint only partly: it points down, not out). */
export const limbReach = (l: LegSpec) => (l.lens[0] + l.lens[1]) * 0.95 + Math.hypot(l.end.up, l.end.back) * 0.5;

interface Box {
  min: V3;
  max: V3;
}
const boxOf = (pts: readonly number[], keep: (x: number) => boolean = () => true): Box => {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) {
    if (!keep(pts[i])) continue;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pts[i + k]);
      max[k] = Math.max(max[k], pts[i + k]);
    }
  }
  return { min, max };
};

export interface Anatomy {
  spec: ProcSpec;
  /** Snout tip and brow, model space at rest. */
  snout: V3;
  brow: V3;
  /** A held blade's length from the hand to its point. */
  blade: number;
  /** Where a spot is, model space at rest (close to where the view finds it on the mesh). */
  spot(a: Spot3): V3;
  /** Where a striking part reaches from (model space, at rest: a hip or shoulder, the base of the neck), how
   * far, and (a head) how high it can come up to. */
  striker(p: StrikePart): { at: V3; span: number; top?: number };
}

/** The body zone runs rump to throat: the neck is where predators go for. */
const SPINE = ['pelvis', 'spine', 'chest', 'neck1', 'neck2'] as const;
const cache = new Map<string, Anatomy>();

export function anatomyOf(def: CreatureDef): Anatomy {
  const k = def.scale ?? 1;
  if (k !== 1) {
    // Grown (pound for pound): its usual anatomy, k times the size.
    const key = `${def.id}@${k}`;
    let g = cache.get(key);
    if (g) return g;
    const base = anatomyOf({ ...def, scale: 1 });
    const s3 = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k];
    g = {
      ...base,
      snout: s3(base.snout),
      brow: s3(base.brow),
      blade: base.blade * k,
      spot: (a) => s3(base.spot(a)),
      striker: (p) => {
        const s = base.striker(p);
        return { at: s3(s.at), span: s.span * k, top: s.top === undefined ? undefined : s.top * k };
      },
    };
    cache.set(key, g);
    return g;
  }
  let a = cache.get(def.id);
  if (a) return a;
  const spec = SPECIES[def.proc.kind];
  const hb = new MeshBuilder();
  spec.head(hb);
  const hp = hb.points;
  const scale = spec.headScale ?? 1;
  const tilt = spec.headTilt ?? 0;
  const n2 = spec.bones.neck2;
  // Head space (on neck2, tilted and scaled) to model space.
  const fromHead = (p: V3): V3 => {
    const y = p[1] * scale;
    const z = p[2] * scale;
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    return [n2[0] + p[0] * scale, n2[1] + y * c - z * s, n2[2] + y * s + z * c];
  };
  // The same snout and brow the rig finds (rig.ts).
  let snout: V3 = [0, 0, -Infinity];
  let brow: V3 = [0, 0, -Infinity];
  let browScore = -Infinity;
  for (let i = 0; i < hp.length; i += 3) {
    const [x, y, z] = [hp[i], hp[i + 1], hp[i + 2]];
    if (Math.abs(x) > 0.12) continue;
    if (z > snout[2]) snout = [0, y, z];
    if (z + 0.6 * y > browScore) {
      browScore = z + 0.6 * y;
      brow = [0, y, z];
    }
  }
  const head = boxOf(hp);
  const blade = (() => {
    const pr = spec.props?.find((x) => x.limb === 'RA');
    if (!pr) return 0;
    const b = new MeshBuilder();
    pr.build(b);
    return boxOf(b.points).max[1];
  })();
  const wingBox = spec.wings
    ? (() => {
        const b = new MeshBuilder();
        spec.wings!.inner(b);
        return boxOf(b.points);
      })()
    : null;
  const pts = SPINE.map((n) => spec.bones[n]);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]));
  const total = lens.reduce((x, y) => x + y, 0);
  a = {
    spec,
    snout: fromHead(snout),
    brow: fromHead(brow),
    blade,
    spot(s) {
      if (s.zone === 'head') {
        const y = head.min[1] + (head.max[1] - head.min[1]) * (0.3 + 0.35 * s.v);
        const z = head.min[2] + (head.max[2] - head.min[2]) * (0.2 + 0.5 * s.u);
        return fromHead([s.side * head.max[0] * 0.75, y, z]);
      }
      if ((s.zone === 'fore' || s.zone === 'hind') && limbFor(spec, s.zone, s.side)) {
        const l = spec.legs.find((x) => x.name === limbFor(spec, s.zone as 'fore', s.side))!;
        const f = s.u < 0.55 ? ((0.25 + 0.5 * s.v) * l.lens[0]) / (l.lens[0] + l.lens[1]) : (l.lens[0] + (0.25 + 0.5 * s.v) * l.lens[1]) / (l.lens[0] + l.lens[1]);
        // Arms hang from the shoulder; legs run from the hip down to the foot.
        const end: V3 = l.arm ? [l.home[0], l.home[1], l.home[2]] : l.home;
        return [l.hip[0] + (end[0] - l.hip[0]) * f + s.side * l.radii[1], l.hip[1] + (end[1] - l.hip[1]) * f, l.hip[2] + (end[2] - l.hip[2]) * f];
      }
      if (s.zone === 'wing' && spec.wings && wingBox) {
        const x = wingBox.min[0] + (wingBox.max[0] - wingBox.min[0]) * (0.25 + 0.55 * s.u);
        const z = wingBox.max[2] - (wingBox.max[2] - wingBox.min[2]) * (0.2 + 0.45 * s.v);
        const bone = spec.bones[spec.wings.bone];
        const r = spec.wings.root;
        return [s.side * (r[0] + x), bone[1] + r[1] + 0.05, bone[2] + r[2] + z];
      }
      // The body: along the torso from the rump to the shoulders, round from the top (or the front) to the side.
      let d = (0.08 + 0.86 * s.u) * total;
      let i = 0;
      while (i < lens.length - 1 && d > lens[i]) d -= lens[i++];
      const t = lens[i] ? d / lens[i] : 0;
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const axis: V3 = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
      const upright = Math.abs(p1[1] - p0[1]) > 0.7 * (lens[i] || 1);
      const phi = 0.35 + 1.05 * s.v;
      const r = def.radius * 0.9;
      const out = Math.cos(phi) * r;
      return upright ? [s.side * Math.sin(phi) * r, axis[1], axis[2] + out] : [s.side * Math.sin(phi) * r, axis[1] + out, axis[2]];
    },
    striker(p) {
      // The head swings round the base of the neck: anywhere within its reach of there (and the body leaning in).
      if (p.kind === 'snout' || p.kind === 'brow') {
        const tip = p.kind === 'snout' ? this.snout : this.brow;
        const base = spec.bones.neck1;
        // (A spider has no neck: it rears up on its back legs to strike, fangs coming down from above.)
        const rear = def.proc.kind === 'spider' ? 0.45 : 0;
        return { at: [base[0], base[1] + rear, base[2]], span: Math.hypot(tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]) + LEAN + 0.12 + rear * 0.3, top: Math.max(tip[1], base[1]) + 0.45 + rear };
      }
      const l = spec.legs.find((x) => x.name === (p.kind === 'sword' ? 'RA' : p.limb));
      if (!l) return { at: this.snout, span: LEAN };
      return { at: l.hip, span: limbReach(l) + (p.kind === 'sword' ? blade * 0.85 : 0) + LEAN + 0.08 };
    },
  };
  cache.set(def.id, a);
  return a;
}
