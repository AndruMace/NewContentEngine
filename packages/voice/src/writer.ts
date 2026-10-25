import { hashString, type NarrationBeat } from '@sim/engine';
import { numberForScreen, numberToWords } from './numbers';
import { spokenText } from './speech';

/** A beat's line, still with its {placeholders}. */
export type Lines = Record<string, string>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Words a fact takes to say ("250504" is seven). */
const spokenWords = (v: string | number) => (typeof v === 'number' ? numberToWords(v) : String(v)).split(/\s+/).length;

/** Words in a line as spoken: placeholders count as the words their values take to say. */
export const wordCount = (line: string, facts: Record<string, string | number> = {}) =>
  line
    .replace(PLACEHOLDER, (_, k: string) => ' X'.repeat(k in facts ? spokenWords(facts[k]) : 1))
    .split(/\s+/)
    .filter(Boolean).length;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Separates the sentences of a beat written in parts. */
export const PART_BREAK = '|';

/** A line's sentences, for a beat in parts (one per part, in order). */
export const splitParts = (line: string) => line.split(PART_BREAK).map((p) => p.trim());

/** Why a written line can't be used, or null when it's fine. */
export function checkLine(beat: NarrationBeat, line: string): string | null {
  if (beat.parts) {
    const parts = splitParts(line);
    if (parts.length !== beat.parts.length) return `beat "${beat.id}": write ${beat.parts.length} sentences separated by "${PART_BREAK}", got ${parts.length}`;
    for (let k = 0; k < parts.length; k++) {
      if (!parts[k]) return `beat "${beat.id}": sentence ${k + 1} is empty`;
      const n = wordCount(parts[k], beat.facts);
      if (n > beat.parts[k].maxWords) return `beat "${beat.id}": sentence ${k + 1} has ${n} words spoken, the limit is ${beat.parts[k].maxWords}`;
    }
  } else if (line.includes(PART_BREAK)) return `beat "${beat.id}": one sentence only, no "${PART_BREAK}"`;
  const used = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const unknown = used.filter((u) => !(u in beat.facts));
  if (unknown.length) return `beat "${beat.id}": unknown placeholder ${unknown.map((u) => `{${u}}`).join(', ')}`;
  const missing = beat.required.filter((r) => !used.includes(r));
  if (missing.length) return `beat "${beat.id}": must use ${missing.map((m) => `{${m}}`).join(', ')}`;
  if (/\d/.test(line.replace(PLACEHOLDER, ''))) return `beat "${beat.id}": write numbers only as placeholders`;
  if (/[×÷=+*/^]/.test(line)) return `beat "${beat.id}": no maths symbols, write the words`;
  const n = wordCount(line, beat.facts);
  if (n > beat.maxWords) return `beat "${beat.id}": ${n} words spoken, the limit is ${beat.maxWords}`;
  if (!line.trim()) return `beat "${beat.id}": empty line`;
  return null;
}

/**
 * Fill a line's placeholders: words for the voice, digits for the screen. A beat in parts also gets
 * each sentence filled on its own (`text`/`caption` are then the sentences joined).
 */
export function fillLine(beat: NarrationBeat, line: string): { text: string; caption: string; parts?: { text: string; caption: string }[] } {
  // A sentence that starts with a placeholder ("{winner} takes over") still starts with a capital.
  // The voice gets units spelled out ("miles per hour"); the caption keeps them short ("mph").
  const fill = (src: string, spoken: boolean) => {
    const filled = capitalise(
      src.replace(PLACEHOLDER, (_, key: string) => {
        const v = beat.facts[key];
        return typeof v === 'number' ? (spoken ? numberToWords(v) : numberForScreen(v)) : String(v);
      }),
    );
    return spoken ? spokenText(filled) : filled;
  };
  if (!beat.parts) return { text: fill(line, true), caption: fill(line, false) };
  const parts = splitParts(line).map((p) => ({ text: fill(p, true), caption: fill(p, false) }));
  return { text: parts.map((p) => p.text).join(' '), caption: parts.map((p) => p.caption).join(' '), parts };
}

/**
 * The lines for every beat, all hand-written in the templates: one picked per beat from the seed
 * (same video, same words) among those that fit the budget with this run's numbers; the shortest if
 * none does.
 */
export function fallbackLines(beats: NarrationBeat[], seed: number): Lines {
  return Object.fromEntries(
    beats.map((b) => {
      const fits = b.fallback.filter((l) => !checkLine(b, l));
      const pool = fits.length ? fits : [...b.fallback].sort((x, y) => wordCount(x, b.facts) - wordCount(y, b.facts)).slice(0, 1);
      return [b.id, pool[parseInt(hashString(`${seed}:${b.id}`), 16) % pool.length]];
    }),
  );
}
