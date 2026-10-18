import * as dm from '@sim/physics/math';
import type { Pt } from '../song';

export { TEMPO_RANGE, arcAt, buildTimeline, solveArc, tonicOf, type Arc, type Onset, type Pt, type Timeline } from '../song';

/**
 * The surface normal (pointing out toward the ball) that bounces a ball arriving along `vin` off
 * along `vout`: mirror reflection means the normal bisects the reversed incoming and the outgoing
 * directions. Tilted no further than maxTilt from straight up, so bars never stand on end.
 */
export function bounceNormal(vin: Pt, vout: Pt, maxTilt: number): Pt {
  // Only sqrt and arithmetic here, plus the deterministic trig: the layout must match in every engine.
  const li = Math.sqrt(vin.x * vin.x + vin.y * vin.y + vin.z * vin.z) || 1;
  const lo = Math.sqrt(vout.x * vout.x + vout.y * vout.y + vout.z * vout.z) || 1;
  let n = { x: vout.x / lo - vin.x / li, y: vout.y / lo - vin.y / li, z: vout.z / lo - vin.z / li };
  const ln = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
  if (ln < 1e-9 || n.y >= 0) return { x: 0, y: -1, z: 0 };
  n = { x: n.x / ln, y: n.y / ln, z: n.z / ln };
  // Up is -y. Past maxTilt, keep the lean's direction but limit how far it leans.
  if (-n.y >= dm.cos(maxTilt)) return n;
  const h = Math.sqrt(n.x * n.x + n.z * n.z);
  const k = dm.sin(maxTilt) / h;
  return { x: n.x * k, y: -dm.cos(maxTilt), z: n.z * k };
}

/**
 * How high a hop of length dt rises: longer notes fly higher, but less than real physics would
 * (rise ~ dt^0.75, not dt^2) so held notes stay on screen. `clamped` when the cap cut it.
 */
export function riseFor(dt: number, refDt: number, base: number, min: number, max: number): { rise: number; clamped: boolean } {
  const raw = base * dm.pow(dt / refDt, 0.75);
  return { rise: Math.min(max, Math.max(min, raw)), clamped: raw > max * 1.15 };
}
