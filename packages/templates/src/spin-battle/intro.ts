/** Intro timing and layout shared by the sim (index.ts) and the 3D view. */

/** Countdown beat (3, 2, 1, then GO). */
export const BEAT_S = 0.42;
/**
 * VS card (round 1): contenders slide in, VS slams down at VS_SLAM, then the strips split apart
 * over the first VS_EXIT_S of the countdown to reveal the stadium.
 */
export const VS_S = 1.6;
export const VS_SLAM = 0.35;
export const VS_EXIT_S = 0.3;
/** Tops fall from the launchers for this long; the fight starts on landing. */
export const DROP_S = 0.3;

/** One contender's strip on the VS card (video pixels). */
export interface VsStrip {
  /** Top and bottom edges at the left and right of the screen (strips are split on a slant). */
  topL: number;
  topR: number;
  bottomL: number;
  bottomR: number;
  /** Where the 3D top sits, and the showcase camera distance that sizes it. */
  top: { x: number; y: number };
  camD: number;
  /** Text column: anchor x, alignment, size multiplier. */
  textX: number;
  align: 'left' | 'right';
  scale: number;
}

export interface VsLayout {
  strips: VsStrip[];
  /** Where the slam text lands (on a split between strips). */
  slamY: number;
}

/** Showcase camera distance for a top `px` pixels across. */
const camFor = (px: number) => 870 / px;

/**
 * Two contenders: the two halves with a diagonal split. Three or four (free-for-all): stacked
 * strips between the hook and the bottom of the frame, tops alternating left and right.
 */
export function vsLayout(n: number): VsLayout {
  if (n <= 2) {
    return {
      strips: [
        { topL: -40, topR: -40, bottomL: 1010, bottomR: 920, top: { x: 320, y: 640 }, camD: 2.4, textX: 545, align: 'left', scale: 1 },
        { topL: 1010, topR: 920, bottomL: 1960, bottomR: 1960, top: { x: 760, y: 1290 }, camD: 2.4, textX: 535, align: 'right', scale: 1 },
      ],
      slamY: 965,
    };
  }
  const y0 = 300;
  const h = 1400 / n;
  const slant = 45;
  const split = (k: number) => y0 + k * h;
  const strips: VsStrip[] = Array.from({ length: n }, (_, k) => {
    const left = k % 2 === 0;
    return {
      topL: k === 0 ? -40 : split(k) + slant,
      topR: k === 0 ? -40 : split(k) - slant,
      bottomL: k === n - 1 ? 1960 : split(k + 1) + slant,
      bottomR: k === n - 1 ? 1960 : split(k + 1) - slant,
      top: { x: left ? 300 : 780, y: y0 + (k + 0.5) * h },
      camD: camFor(h * 0.74),
      textX: left ? 525 : 555,
      align: left ? 'left' : 'right',
      scale: n === 3 ? 0.85 : 0.72,
    };
  });
  // Slam on the split nearest the middle of the screen.
  let slamY = split(1);
  for (let k = 1; k < n; k++) if (Math.abs(split(k) - 960) < Math.abs(slamY - 960)) slamY = split(k);
  return { strips, slamY };
}
