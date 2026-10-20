/** Intro timing and the VS card's layout, shared by the template (text) and the view (models). */

/** VS card length, and when VS slams down. */
export const VS_S = 3;
export const VS_SLAM = 0.45;
/** At the start of the countdown the card's halves split apart over this long. */
export const VS_EXIT_S = 0.3;
/** Countdown beat (3, 2, 1, then FIGHT!). */
export const BEAT_S = 0.45;

export interface VsStrip {
  /** Top and bottom edges at the left and right of the frame (the halves split on a slant). */
  topL: number;
  topR: number;
  bottomL: number;
  bottomR: number;
  /** Where the fighter's model stands (its middle), and how tall it is drawn (pixels). */
  model: { x: number; y: number; h: number };
  /** Text column: anchor x and alignment, title line y. */
  textX: number;
  align: 'left' | 'right';
  titleY: number;
  color: string;
}

export const VS_STRIPS: VsStrip[] = [
  { topL: -40, topR: -40, bottomL: 1010, bottomR: 920, model: { x: 300, y: 600, h: 520 }, textX: 560, align: 'left', titleY: 470, color: '#4fc3ff' },
  { topL: 1010, topR: 920, bottomL: 1960, bottomR: 1960, model: { x: 780, y: 1360, h: 520 }, textX: 520, align: 'right', titleY: 1190, color: '#ffb03b' },
];

export const VS_SLAM_Y = 965;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeIn = (x: number) => x * x * x;

/** Pixel offsets of the two halves (sliding in from the sides, then splitting up and down). */
export function vsSlide(phase: string, since: number): { o: { x: number; y: number }[]; exit: number; slam: number; showing: boolean } {
  const inT = phase === 'vs' ? since : VS_S;
  const exit = phase === 'vs' ? 0 : phase === 'count' ? easeIn(clamp01(since / VS_EXIT_S)) : 1;
  const o = [0, 1].map((k) => {
    const side = k === 0 ? -1 : 1;
    const e = easeOut(clamp01((inT - k * 0.1) / 0.28));
    return { x: side * (1 - e) * 1100, y: side * exit * 1150 };
  });
  return { o, exit, slam: inT - VS_SLAM, showing: exit < 1 };
}
