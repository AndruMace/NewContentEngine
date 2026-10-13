/** Why a candidate was turned down in Review. Kept tiny so the web app can import it directly. */
export const REJECT_REASONS = [
  { id: 'sound', label: 'Sounds off' },
  { id: 'boring', label: 'Boring / lull' },
  { id: 'ending', label: 'Weak ending' },
  { id: 'looks', label: 'Looks bad' },
  { id: 'too-long', label: 'Drags / too long' },
  { id: 'hook', label: 'Weak hook / copy' },
  { id: 'repetitive', label: 'Seen it before' },
  { id: 'glitch', label: 'Glitch / bug' },
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number]['id'];

/** About the copy, not the simulation: says nothing about the settings or template. */
export const COPY_ONLY_REASONS = new Set<string>(['hook']);
/** A bug to fix, not a matter of taste. */
export const NOT_TASTE_REASONS = new Set<string>(['glitch']);
