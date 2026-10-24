import { Runner, getTheme, parseParams, type NarrationLine, type Template, type VoiceTrack } from '@sim/engine';
import { getMelody } from '@sim/audio';
import { PART_GAP_S, estimateS } from './director';
import { sayEvents } from './narration';

/** Run a template headless with narration on (estimated, or with a voice track, if given). */
export function runStory(template: Template, params: Record<string, unknown>, seed = 1, voice?: VoiceTrack) {
  return new Runner(template, { seed, params: parseParams(template, { narration: 'on', ...params }), theme: getTheme('neon-dark'), melody: getMelody('ode-to-joy'), visual: false, voice, maxSeconds: 200 }).runToEnd();
}

/**
 * A stand-in voice track for a run: every beat "voiced" at `scale` × its estimated length (so tests
 * can check that long and short voicings play the same sim).
 */
export function fakeVoice(template: Template, params: Record<string, unknown>, seed: number, scale: number): VoiceTrack {
  const beats = sayEvents(runStory(template, params, seed).events);
  const lines: NarrationLine[] = beats.map((b) => {
    if (!b.parts) return { beat: b.id, text: b.id, caption: b.id, clip: `${b.id}.wav`, durationS: estimateS(b.maxWords) * scale };
    let at = 0;
    const parts = b.parts.map((p, k) => {
      const len = estimateS(p.maxWords) * scale;
      const part = { text: `${b.id}.${k}`, caption: `${b.id}.${k}`, at, durationS: len };
      at += len + PART_GAP_S;
      return part;
    });
    return { beat: b.id, text: b.id, caption: b.id, clip: `${b.id}.wav`, durationS: at - PART_GAP_S, parts };
  });
  return { provider: 'fake', voiceId: 'v', factsHash: 'x', writer: 'fallback', lines };
}
