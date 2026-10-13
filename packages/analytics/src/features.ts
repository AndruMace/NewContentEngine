import { startsWithEmoji, type Arm, type SocialCopy } from '@sim/planner';

export type CtaStyle = 'guess' | 'pick' | 'rate' | 'opinion' | 'other';

export interface CopyFeatures {
  hookChars: number;
  hookQuestion: boolean;
  hookDigit: boolean;
  hookEmoji: boolean;
  ctaStyle: CtaStyle;
  /** Title leads with an emoji (planned for ~75% of videos; the rest are the comparison group). */
  titleEmoji?: boolean;
  /** Engagement cues on screen (comment prompt + like heart; ~75% of videos). */
  cues?: boolean;
}

/**
 * Everything the learner may use about one video, frozen when it is exported. Kept even after the
 * render itself is deleted, so the model can always be refit from scratch.
 */
export interface PostFeatures {
  version: 1;
  arm: Arm;
  melodyId: string;
  params: Record<string, unknown>;
  targetS: number;
  durationS: number;
  drama: { total: number; parts: Record<string, number> };
  copy: CopyFeatures;
  source: string;
  experiment: boolean;
  rankScore: number | null;
}

const EMOJI = /\p{Extended_Pictographic}/u;

export function ctaStyle(cta: string): CtaStyle {
  const s = cta.toLowerCase();
  if (/\b(rate|score|out of|\/10)\b/.test(s)) return 'rate';
  if (/\b(pick|choose|team|side|rooting)\b/.test(s)) return 'pick';
  if (/\b(guess|predict|bet|call it|called it|right|wrong)\b/.test(s)) return 'guess';
  if (/\b(favou?rite|name|tell me|which|best|worst)\b/.test(s)) return 'opinion';
  return 'other';
}

export function copyFeatures(copy: Pick<SocialCopy, 'hook' | 'cta'> & { title?: string; nudge?: string }): CopyFeatures {
  const hook = copy.hook.trim();
  return {
    titleEmoji: copy.title !== undefined ? startsWithEmoji(copy.title) : undefined,
    hookChars: hook.length,
    hookQuestion: hook.includes('?'),
    hookDigit: /\d/.test(hook),
    hookEmoji: EMOJI.test(hook),
    ctaStyle: ctaStyle(copy.cta),
    cues: Boolean(copy.nudge),
  };
}
