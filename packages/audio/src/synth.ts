import type { AmbientBed, AudioEvent, VoiceId } from '@sim/engine';

/**
 * Procedural voices + SFX built from Web Audio nodes. The same code drives the realtime
 * preview (AudioContext) and the offline render (OfflineAudioContext), so they sound identical.
 */
export interface SynthBus {
  ctx: BaseAudioContext;
  input: GainNode;
  noise: AudioBuffer;
  /** Shared panners by pan position, so dense event lists don't pile up thousands of nodes. */
  panners: Map<number, StereoPannerNode>;
  /** Sim time at context time 0 (offline segments of a long render start later than 0). */
  t0: number;
  /** Long-form loop length: noise offsets repeat with it, so the loop's end flows into its start. 0 = none. */
  loopS: number;
  /** Decoded recordings for 'sample' events (by path in assets/ambient) and narration clips (by clip name). */
  samples: Map<string, AudioBuffer>;
  /** Everything but the narration passes through here, so it can dip under a voice. */
  music: GainNode;
  /** Narration: straight to the master, past the hard compressor (speech shouldn't be pumped). */
  voice: GainNode;
  /** Preview: a narration clip that failed to load is skipped (renders treat it as an error). */
  lenient: boolean;
}

/** How far the music dips under a narrated line (about −8 dB), and how quickly. */
const DUCK = { level: 0.4, fall: 0.08, rise: 0.25 };

/** Where in the shared noise buffer a sound starting at context time `when` reads from (same in every segment). */
function noiseOffset(bus: SynthBus, when: number) {
  return (((simTime(bus, when) * 0.37) % 1.5) + 1.5) % 1.5;
}

function simTime(bus: SynthBus, when: number) {
  const t = when + bus.t0;
  return bus.loopS ? ((t % bus.loopS) + bus.loopS) % bus.loopS : t;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function seededNoise(ctx: BaseAudioContext, seconds: number, channels: number, decay?: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  let s = 0x12345678;
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const env = decay ? Math.pow(1 - i / len, decay) : 1;
      data[i] = ((s / 4294967296) * 2 - 1) * env;
    }
  }
  return buf;
}

export function createBus(
  ctx: BaseAudioContext,
  opts: { reverb: number; destination?: AudioNode; t0?: number; loopS?: number; samples?: Map<string, AudioBuffer>; compress?: boolean; lenient?: boolean },
): SynthBus {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(opts.destination ?? ctx.destination);
  // The Shorts bus is squeezed hard (dense collisions); long-form ambience keeps its dynamics and is
  // only limited when mastered.
  let comp: AudioNode = master;
  if (opts.compress ?? true) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -16;
    c.knee.value = 10;
    c.ratio.value = 8;
    c.attack.value = 0.002;
    c.release.value = 0.2;
    c.connect(master);
    comp = c;
  }

  const music = ctx.createGain();
  music.connect(comp);
  const input = ctx.createGain();
  input.connect(music);
  if (opts.reverb > 0) {
    const verb = ctx.createConvolver();
    verb.buffer = seededNoise(ctx, 2.4, 2, 3.2);
    const wet = ctx.createGain();
    wet.gain.value = opts.reverb;
    input.connect(verb).connect(wet).connect(music);
  }
  const voice = ctx.createGain();
  voice.connect(master);
  return { ctx, input, noise: seededNoise(ctx, 2, 1), panners: new Map(), t0: opts.t0 ?? 0, loopS: opts.loopS ?? 0, samples: opts.samples ?? new Map(), music, voice, lenient: opts.lenient ?? false };
}

/** Play a narrated line at `when`, dipping the music under it (lines never overlap). */
function playLine(bus: SynthBus, clip: string, vel: number, when: number) {
  const buffer = bus.samples.get(clip);
  if (!buffer) {
    if (bus.lenient) return;
    throw new Error(`Narration clip not loaded: ${clip}`);
  }
  const src = bus.ctx.createBufferSource();
  src.buffer = buffer;
  const g = bus.ctx.createGain();
  g.gain.value = vel;
  src.connect(g).connect(bus.voice);
  src.start(when);
  const gain = bus.music.gain;
  const end = when + buffer.duration;
  gain.setValueAtTime(1, Math.max(0, when - DUCK.fall));
  gain.linearRampToValueAtTime(DUCK.level, when);
  gain.setValueAtTime(DUCK.level, end);
  gain.linearRampToValueAtTime(1, end + DUCK.rise);
}

function out(bus: SynthBus, pan = 0): AudioNode {
  const key = Math.round(Math.max(-1, Math.min(1, pan)) * 20);
  let p = bus.panners.get(key);
  if (!p) {
    p = bus.ctx.createStereoPanner();
    p.pan.value = key / 20;
    p.connect(bus.input);
    bus.panners.set(key, p);
  }
  return p;
}

function env(g: GainNode, when: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
}

function osc(bus: SynthBus, type: OscillatorType, freq: number, when: number, stop: number, dest: AudioNode, peak: number, attack: number, decay: number) {
  const o = bus.ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = bus.ctx.createGain();
  env(g, when, peak, attack, decay);
  o.connect(g).connect(dest);
  o.start(when);
  o.stop(stop);
  return o;
}

function noiseBurst(bus: SynthBus, when: number, dur: number, dest: AudioNode, peak: number, filter: BiquadFilterType, freq: number, q = 1, freqEnd?: number) {
  const src = bus.ctx.createBufferSource();
  src.buffer = bus.noise;
  const f = bus.ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, when);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, when + dur);
  f.Q.value = q;
  const g = bus.ctx.createGain();
  env(g, when, peak, Math.min(0.01, dur / 4), dur);
  src.connect(f).connect(g).connect(dest);
  src.start(when, noiseOffset(bus, when));
  src.stop(when + dur + 0.05);
}

/** `b` (brightness, 0–1) scales overtones and filter openings: 1 is each voice's full sound. */
function playVoice(bus: SynthBus, voice: VoiceId, midi: number, vel: number, when: number, dur: number, dest: AudioNode, b = 1) {
  const f = midiToHz(midi);
  const a = vel * 0.32;
  switch (voice) {
    case 'marimba': {
      const d = 0.7 * dur;
      osc(bus, 'sine', f, when, when + d + 0.1, dest, a, 0.002, d);
      osc(bus, 'sine', f * 3.93, when, when + 0.2, dest, a * 0.35 * b, 0.001, 0.12);
      osc(bus, 'sine', f * 9.2, when, when + 0.06, dest, a * 0.12 * b * b, 0.001, 0.04);
      break;
    }
    case 'bell': {
      const d = 2 * dur;
      const mod = bus.ctx.createOscillator();
      mod.frequency.value = f * 3.5;
      const modGain = bus.ctx.createGain();
      // The FM depth is the bell's brightness.
      modGain.gain.setValueAtTime(f * 2.2 * Math.max(0.05, b), when);
      modGain.gain.exponentialRampToValueAtTime(f * 0.05 * Math.max(0.05, b), when + d);
      mod.connect(modGain);
      const car = osc(bus, 'sine', f, when, when + d + 0.1, dest, a * 0.9, 0.002, d);
      modGain.connect(car.frequency);
      mod.start(when);
      mod.stop(when + d + 0.1);
      break;
    }
    case 'pluck': {
      const d = 0.55 * dur;
      const o = bus.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = bus.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(Math.min(16000, f * (1.5 + 8.5 * b)), when);
      lp.frequency.exponentialRampToValueAtTime(Math.max(80, f * 1.2), when + d);
      const g = bus.ctx.createGain();
      env(g, when, a * 0.7, 0.002, d);
      o.connect(lp).connect(g).connect(dest);
      o.start(when);
      o.stop(when + d + 0.1);
      break;
    }
    case 'glass': {
      const d = 1.3 * dur;
      osc(bus, 'sine', f, when, when + d + 0.1, dest, a * 0.8, 0.004, d);
      osc(bus, 'sine', f * 2.76, when, when + d * 0.6, dest, a * 0.3 * b, 0.003, d * 0.5);
      osc(bus, 'sine', f * 5.4, when, when + d * 0.3, dest, a * 0.12 * b * b, 0.002, d * 0.25);
      break;
    }
    case 'softsine': {
      const d = 0.9 * dur;
      osc(bus, 'triangle', f, when, when + d + 0.1, dest, a * 0.8, 0.012, d);
      break;
    }
    case 'kalimba': {
      // Plucked tine: warm fundamental, a bright inharmonic overtone that dies fast, a soft thumb click.
      const d = 1.1 * dur;
      osc(bus, 'sine', f, when, when + d + 0.1, dest, a * 0.9, 0.002, d);
      osc(bus, 'sine', f * 5.95, when, when + 0.12, dest, a * 0.22 * b * b, 0.001, 0.07);
      noiseBurst(bus, when, 0.015, dest, a * 0.12 * b, 'bandpass', Math.min(9000, f * 4), 2);
      break;
    }
    case 'musicbox': {
      // Comb tooth: near-harmonic partials, the upper ones short and glassy.
      const d = 1.6 * dur;
      osc(bus, 'sine', f, when, when + d + 0.1, dest, a * 0.7, 0.001, d);
      osc(bus, 'sine', f * 2, when, when + d * 0.5, dest, a * 0.28 * b, 0.001, d * 0.4);
      osc(bus, 'sine', f * 4.07, when, when + 0.25, dest, a * 0.14 * b * b, 0.001, 0.18);
      break;
    }
    case 'handpan': {
      // Steel tone field: fundamental tuned with its octave and compound fifth, soft mallet attack.
      const d = 2.2 * dur;
      osc(bus, 'sine', f, when, when + d + 0.1, dest, a * 0.85, 0.006, d);
      osc(bus, 'sine', f * 2, when, when + d * 0.7, dest, a * 0.3 * b, 0.005, d * 0.6);
      osc(bus, 'sine', f * 3, when, when + d * 0.4, dest, a * 0.12 * b * b, 0.004, d * 0.35);
      break;
    }
    case 'bass': {
      // Synth bass: a sawtooth and a sub sine through a low-pass that closes after the attack, held
      // for the note's length.
      const d = Math.max(0.12, dur);
      const lp = bus.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(f * (2.2 + 4.8 * b), when);
      lp.frequency.exponentialRampToValueAtTime(f * 2.2, when + 0.12);
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a * 0.75, when + 0.008);
      g.gain.setValueAtTime(a * 0.6, when + d * 0.85);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      lp.connect(g).connect(dest);
      for (const [type, mult, k] of [['sawtooth', 1, 0.6], ['sine', 0.5, 0.8]] as const) {
        const o = bus.ctx.createOscillator();
        o.type = type;
        o.frequency.value = f * mult;
        const og = bus.ctx.createGain();
        og.gain.value = k;
        o.connect(og).connect(lp);
        o.start(when);
        o.stop(when + d + 0.05);
      }
      break;
    }
    case 'brass': {
      // Synth brass: two slightly detuned sawtooths, the filter opening over the attack ("bwah").
      const d = Math.max(0.15, dur * 0.95);
      const lp = bus.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 1.2;
      lp.frequency.setValueAtTime(f * 1.2, when);
      lp.frequency.linearRampToValueAtTime(Math.min(9000, f * (1.5 + 3.5 * b)), when + 0.06);
      lp.frequency.exponentialRampToValueAtTime(Math.min(9000, f * (1.2 + 1.6 * b)), when + d);
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a * 0.55, when + 0.035);
      g.gain.setValueAtTime(a * 0.45, when + d * 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d + 0.08);
      lp.connect(g).connect(dest);
      for (const det of [-6, 6]) {
        const o = bus.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(when);
        o.stop(when + d + 0.12);
      }
      break;
    }
  }
}

/** A vocal: a buzzing source (sawtooth with vibrato) through formant band-passes that move over its length. */
function vocal(
  bus: SynthBus,
  when: number,
  dest: AudioNode,
  o: { f0: number; f1: number; dur: number; peak: number; formants: [number, number][]; formantsEnd?: [number, number][]; vibrato?: number; rattle?: number; breath?: number },
) {
  const src = bus.ctx.createOscillator();
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(o.f0, when);
  src.frequency.exponentialRampToValueAtTime(o.f1, when + o.dur);
  if (o.vibrato) {
    const lfo = bus.ctx.createOscillator();
    lfo.frequency.value = 6.5;
    const lg = bus.ctx.createGain();
    lg.gain.value = o.f0 * o.vibrato;
    lfo.connect(lg).connect(src.frequency);
    lfo.start(when);
    lfo.stop(when + o.dur + 0.05);
  }
  const g = bus.ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(o.peak, when + Math.min(0.08, o.dur * 0.2));
  g.gain.setValueAtTime(o.peak * 0.85, when + o.dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, when + o.dur);
  // A growl's rattle: the voice chopped by a fast tremolo.
  let into: AudioNode = g;
  if (o.rattle) {
    const trem = bus.ctx.createGain();
    trem.gain.value = 1 - o.rattle;
    const lfo = bus.ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 22;
    const depth = bus.ctx.createGain();
    depth.gain.value = o.rattle;
    lfo.connect(depth).connect(trem.gain);
    lfo.start(when);
    lfo.stop(when + o.dur + 0.05);
    trem.connect(g);
    into = trem;
  }
  g.connect(dest);
  o.formants.forEach(([freq, q], k) => {
    const bp = bus.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(freq, when);
    const end = o.formantsEnd?.[k]?.[0];
    if (end) bp.frequency.exponentialRampToValueAtTime(end, when + o.dur);
    const fg = bus.ctx.createGain();
    fg.gain.value = 1.6 / (k + 1);
    src.connect(bp).connect(fg).connect(into);
  });
  src.start(when);
  src.stop(when + o.dur + 0.05);
  if (o.breath) noiseBurst(bus, when, o.dur, dest, o.peak * o.breath, 'bandpass', o.formants[0][0] * 1.5, 0.8);
}

export function scheduleEvent(bus: SynthBus, ev: AudioEvent, when: number) {
  if (ev.kind === 'voice') {
    playLine(bus, ev.clip, ev.vel, when);
    return;
  }
  const dest = out(bus, ev.pan ?? 0);
  if (ev.kind === 'note') {
    playVoice(bus, ev.voice ?? 'marimba', ev.midi, ev.vel, when, ev.dur ?? 1, dest, ev.bright ?? 1);
    return;
  }
  if (ev.kind === 'sample') {
    const buffer = bus.samples.get(ev.name);
    if (!buffer) throw new Error(`Sound not loaded: ${ev.name}`);
    const src = bus.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = ev.rate ?? 1;
    const g = bus.ctx.createGain();
    g.gain.value = ev.vel;
    src.connect(g).connect(dest);
    src.start(when);
    return;
  }
  const v = ev.vel;
  switch (ev.name) {
    case 'tick':
      noiseBurst(bus, when, 0.025, dest, v * 0.5, 'highpass', 4000);
      break;
    case 'clack': {
      // Glass marbles knocking: a bright click, two inharmonic glassy pings and a little body knock.
      // pitch 0..1 shifts it (smaller/harder hits sound higher).
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.018, dest, v * 0.9, 'bandpass', 5200 + p * 2500, 1.4);
      osc(bus, 'sine', 2600 + p * 1400, when, when + 0.12, dest, v * 0.42, 0.0006, 0.07);
      osc(bus, 'sine', 4100 + p * 1900, when, when + 0.08, dest, v * 0.26, 0.0006, 0.045);
      osc(bus, 'triangle', 520 + p * 260, when, when + 0.08, dest, v * 0.3, 0.001, 0.04);
      break;
    }
    case 'clang': {
      // Metal contours slamming together: a bright strike and inharmonic ringing partials.
      // pitch 0..1: low = heavy, dull hits; high = light, bright ones.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.03, dest, v * 0.8, 'highpass', 3000 + p * 3000);
      const base = 700 + p * 900;
      [1, 2.76, 5.4, 8.93].forEach((ratio, k) => {
        osc(bus, 'sine', base * ratio, when, when + 0.5, dest, (v * 0.3) / (k + 1), 0.0008, 0.18 + 0.12 / (k + 1));
      });
      break;
    }
    case 'grind': {
      // Contours scraping: a short, rough band of noise.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.09, dest, v * 0.35, 'bandpass', 1800 + p * 2400, 3);
      noiseBurst(bus, when + 0.03, 0.06, dest, v * 0.2, 'bandpass', 3800 + p * 2000, 4);
      break;
    }
    case 'rip': {
      // A ripcord yanked out of a launcher: a ratchet of clicks speeding up, over a rising zip.
      const p = ev.pitch ?? 0.5;
      let at = when;
      for (let k = 0; k < 14; k++) {
        noiseBurst(bus, at, 0.008, dest, v * (0.35 + 0.03 * k), 'bandpass', 1800 + p * 1200 + k * 260, 6);
        at += 0.018 * (1 - k / 18);
      }
      noiseBurst(bus, when, 0.22, dest, v * 0.25, 'bandpass', 900 + p * 600, 1.5, 5200 + p * 2000);
      break;
    }
    case 'pop': {
      const o = osc(bus, 'sine', 600, when, when + 0.15, dest, v * 0.5, 0.001, 0.1);
      o.frequency.exponentialRampToValueAtTime(140, when + 0.09);
      break;
    }
    case 'shatter': {
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.35, dest, v * 0.45, 'bandpass', 2500 + p * 3500, 0.8, 9000);
      for (let k = 0; k < 4; k++) {
        const f = 2200 + ((k * 977 + p * 3100) % 3800);
        osc(bus, 'sine', f, when + k * 0.018, when + 0.5, dest, v * 0.06, 0.001, 0.25 + k * 0.05);
      }
      break;
    }
    case 'boom': {
      const o = osc(bus, 'sine', 130, when, when + 1.2, dest, v * 0.9, 0.003, 1.0);
      o.frequency.exponentialRampToValueAtTime(38, when + 0.7);
      noiseBurst(bus, when, 0.6, dest, v * 0.35, 'lowpass', 900, 0.7, 120);
      break;
    }
    case 'whoosh': {
      const src = bus.ctx.createBufferSource();
      src.buffer = bus.noise;
      const f = bus.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(400, when);
      f.frequency.exponentialRampToValueAtTime(4000, when + 0.9);
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(v * 0.35, when + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 1.0);
      src.connect(f).connect(g).connect(dest);
      src.start(when);
      src.stop(when + 1.05);
      break;
    }
    case 'sand': {
      // Granular hiss: a short band of noise whose centre wanders with `pitch`.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.07, dest, v * 0.3, 'bandpass', 2500 + p * 4000, 1.4);
      noiseBurst(bus, when + 0.02, 0.05, dest, v * 0.15, 'highpass', 7000);
      break;
    }
    case 'bubble': {
      // Liquid "bloop": a short sine sweeping upwards.
      const f0 = 300 + (ev.pitch ?? 0.5) * 500;
      const o = osc(bus, 'sine', f0, when, when + 0.12, dest, v * 0.35, 0.004, 0.08);
      o.frequency.exponentialRampToValueAtTime(f0 * 2.2, when + 0.06);
      break;
    }
    case 'chime':
      playVoice(bus, 'bell', 84 + Math.round((ev.pitch ?? 0) * 12), v, when, 1, dest);
      break;
    case 'knock': {
      // A marble striking wood: a dull, woody thump (two damped body modes) under a soft click.
      // pitch 0..1: thicker, lower boards to thinner, brighter ones.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.012, dest, v * 0.55, 'bandpass', 2200 + p * 1600, 1.2);
      osc(bus, 'sine', 210 + p * 190, when, when + 0.09, dest, v * 0.7, 0.0008, 0.035);
      osc(bus, 'triangle', 620 + p * 420, when, when + 0.05, dest, v * 0.28, 0.0006, 0.018);
      noiseBurst(bus, when, 0.05, dest, v * 0.18, 'lowpass', 900, 0.8);
      break;
    }
    case 'clink': {
      // Glass on glass or metal: a tiny bright tick and short inharmonic rings.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.006, dest, v * 0.6, 'highpass', 6000 + p * 3000);
      [1, 2.32, 4.25].forEach((ratio, k) => osc(bus, 'sine', (3100 + p * 1700) * ratio, when, when + 0.25, dest, (v * 0.22) / (k + 1), 0.0004, 0.06 + 0.05 / (k + 1)));
      break;
    }
    case 'ambience': {
      // A stretch of room tone (events every 4 s overlap into a seamless bed), its character set by
      // pitch: 0 a quiet studio, 0.5 an industrial hall (ventilation rumble and mains hum), 1 wind.
      const p = ev.pitch ?? 0;
      const dur = 4.6;
      const fade = 0.8;
      const shape = (g: GainNode, peak: number) => {
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(peak, when + fade);
        g.gain.setValueAtTime(peak, when + dur - fade);
        g.gain.linearRampToValueAtTime(0, when + dur);
      };
      const layer = (filter: BiquadFilterType, freq: number, q: number, peak: number, freqEnd?: number) => {
        const src = bus.ctx.createBufferSource();
        src.buffer = bus.noise;
        src.loop = true;
        const f = bus.ctx.createBiquadFilter();
        f.type = filter;
        f.frequency.setValueAtTime(freq, when);
        if (freqEnd) f.frequency.linearRampToValueAtTime(freqEnd, when + dur);
        f.Q.value = q;
        const g = bus.ctx.createGain();
        shape(g, peak);
        src.connect(f).connect(g).connect(dest);
        src.start(when, noiseOffset(bus, when));
        src.stop(when + dur + 0.05);
      };
      if (p < 0.25) {
        layer('lowpass', 520, 0.5, v * 0.5);
        layer('bandpass', 1800, 0.6, v * 0.06);
      } else if (p < 0.75) {
        layer('lowpass', 240, 0.7, v * 0.75);
        layer('bandpass', 950, 1.1, v * 0.1);
        for (const [hz, a] of [[50, 0.05], [100, 0.035], [150, 0.015]] as const) {
          const o = bus.ctx.createOscillator();
          o.frequency.value = hz;
          const g = bus.ctx.createGain();
          shape(g, v * a);
          o.connect(g).connect(dest);
          o.start(when);
          o.stop(when + dur + 0.05);
        }
      } else {
        // Gusts: a band of noise sweeping up or down, over a low roar.
        const up = Math.floor(simTime(bus, when) / 4) % 2 === 0;
        layer('bandpass', up ? 320 : 760, 1.4, v * 0.55, up ? 760 : 320);
        layer('lowpass', 180, 0.7, v * 0.4);
      }
      break;
    }
    case 'kick': {
      const o = osc(bus, 'sine', 140, when, when + 0.45, dest, v * 1.1, 0.001, 0.38);
      o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
      noiseBurst(bus, when, 0.012, dest, v * 0.35, 'highpass', 3000);
      break;
    }
    case 'snare': {
      noiseBurst(bus, when, 0.18, dest, v * 0.55, 'bandpass', 2600, 0.7);
      noiseBurst(bus, when, 0.1, dest, v * 0.3, 'highpass', 6000);
      const o = osc(bus, 'triangle', 220, when, when + 0.12, dest, v * 0.45, 0.001, 0.09);
      o.frequency.exponentialRampToValueAtTime(160, when + 0.08);
      break;
    }
    case 'hat': {
      // pitch > 0.5: open.
      const open = (ev.pitch ?? 0) > 0.5;
      noiseBurst(bus, when, open ? 0.22 : 0.035, dest, v * 0.32, 'highpass', 8000);
      break;
    }
    case 'tom': {
      // A big war drum: deep pitched thump with a skin slap.
      const p = ev.pitch ?? 0.5;
      const o = osc(bus, 'sine', 120 + p * 90, when, when + 0.7, dest, v * 1.0, 0.002, 0.55);
      o.frequency.exponentialRampToValueAtTime(55 + p * 40, when + 0.3);
      noiseBurst(bus, when, 0.08, dest, v * 0.3, 'bandpass', 900 + p * 500, 1);
      noiseBurst(bus, when, 0.35, dest, v * 0.25, 'lowpass', 400, 0.7, 90);
      break;
    }
    case 'impact': {
      // A heavy body blow: sub thump, a lowpassed punch of noise and a mid smack. pitch: lower = bigger.
      const p = ev.pitch ?? 0.5;
      const o = osc(bus, 'sine', 90 + p * 70, when, when + 0.4, dest, v * 1.0, 0.002, 0.28);
      o.frequency.exponentialRampToValueAtTime(34 + p * 20, when + 0.18);
      noiseBurst(bus, when, 0.12, dest, v * 0.6, 'lowpass', 700 + p * 900, 0.8, 150);
      noiseBurst(bus, when, 0.04, dest, v * 0.4, 'bandpass', 900 + p * 900, 1.2);
      break;
    }
    case 'smack': {
      // A slap of flesh and fur: bright short noise and a little tone.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.045, dest, v * 0.6, 'bandpass', 1300 + p * 1400, 1.1);
      osc(bus, 'triangle', 260 + p * 180, when, when + 0.08, dest, v * 0.35, 0.001, 0.05);
      break;
    }
    case 'crunch': {
      // A bite: jaws snapping shut (a hard click) then a crackle of short grinding bursts.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.015, dest, v * 0.8, 'bandpass', 3200 + p * 1500, 2);
      osc(bus, 'triangle', 300 + p * 200, when, when + 0.05, dest, v * 0.4, 0.0005, 0.03);
      let at = when + 0.02;
      for (let k = 0; k < 7; k++) {
        noiseBurst(bus, at, 0.012, dest, v * (0.5 - k * 0.05), 'bandpass', 1400 + ((k * 739) % 1900) + p * 800, 3);
        at += 0.014 + ((k * 13) % 5) * 0.004;
      }
      break;
    }
    case 'slash': {
      // Claws or a blade raking through: a very fast bright sweep and a tearing rasp.
      const p = ev.pitch ?? 0.5;
      noiseBurst(bus, when, 0.11, dest, v * 0.6, 'bandpass', 1800 + p * 1500, 2.2, 7500 + p * 2500);
      noiseBurst(bus, when + 0.03, 0.08, dest, v * 0.35, 'highpass', 5000);
      for (let k = 0; k < 3; k++) noiseBurst(bus, when + 0.02 + k * 0.025, 0.01, dest, v * 0.35, 'bandpass', 4200 + k * 900, 4);
      break;
    }
    case 'swish': {
      // A swing through the air: a band of noise rising and falling fast. pitch: higher = smaller, faster.
      const p = ev.pitch ?? 0.5;
      const d = 0.28 - p * 0.12;
      const src = bus.ctx.createBufferSource();
      src.buffer = bus.noise;
      const f = bus.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.6;
      f.frequency.setValueAtTime(500 + p * 800, when);
      f.frequency.exponentialRampToValueAtTime(2200 + p * 3500, when + d * 0.6);
      f.frequency.exponentialRampToValueAtTime(900 + p * 900, when + d);
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(v * 0.55, when + d * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, when + d);
      src.connect(f).connect(g).connect(dest);
      src.start(when, noiseOffset(bus, when));
      src.stop(when + d + 0.05);
      break;
    }
    case 'whip': {
      // A tail cracking round: a swish into a sharp crack.
      noiseBurst(bus, when, 0.18, dest, v * 0.35, 'bandpass', 700, 1.4, 3200);
      noiseBurst(bus, when + 0.17, 0.02, dest, v * 0.9, 'highpass', 2500);
      osc(bus, 'triangle', 1400, when + 0.17, when + 0.24, dest, v * 0.2, 0.0005, 0.04);
      break;
    }
    case 'hoof': {
      // A hoof clop (two, a beat apart): a hollow woody knock with a hard edge.
      const p = ev.pitch ?? 0.5;
      for (const [dt, k] of [[0, 1], [0.065, 0.7]] as const) {
        noiseBurst(bus, when + dt, 0.012, dest, v * 0.6 * k, 'bandpass', 2600 + p * 900, 1.5);
        osc(bus, 'sine', 420 + p * 180, when + dt, when + dt + 0.08, dest, v * 0.5 * k, 0.0006, 0.05);
        osc(bus, 'triangle', 980 + p * 300, when + dt, when + dt + 0.04, dest, v * 0.2 * k, 0.0005, 0.02);
      }
      break;
    }
    case 'step': {
      // A paw or foot landing on sand: a soft low thump and a scatter of grains.
      const p = ev.pitch ?? 0.5;
      osc(bus, 'sine', 80 + p * 70, when, when + 0.12, dest, v * 0.5, 0.002, 0.08);
      noiseBurst(bus, when, 0.06, dest, v * 0.25, 'bandpass', 1800 + p * 1500, 1.2);
      break;
    }
    case 'bodyfall': {
      // A body hitting the ground: a deep thud, a slump of low noise and sand spraying.
      const o = osc(bus, 'sine', 75, when, when + 0.6, dest, v * 1.0, 0.003, 0.45);
      o.frequency.exponentialRampToValueAtTime(32, when + 0.3);
      noiseBurst(bus, when, 0.35, dest, v * 0.5, 'lowpass', 500, 0.7, 120);
      noiseBurst(bus, when + 0.04, 0.4, dest, v * 0.2, 'bandpass', 3500, 0.9, 6000);
      break;
    }
    case 'flame': {
      // Fire breath: a roaring band of noise with crackles riding on it.
      noiseBurst(bus, when, 1.1, dest, v * 0.55, 'lowpass', 1400, 0.6, 600);
      noiseBurst(bus, when, 1.0, dest, v * 0.25, 'bandpass', 2500, 0.7, 1200);
      for (let k = 0; k < 10; k++) noiseBurst(bus, when + 0.05 + k * 0.09 + ((k * 37) % 7) * 0.008, 0.01, dest, v * 0.3, 'highpass', 4000 + ((k * 911) % 3000));
      break;
    }
    case 'roar': {
      // A big cat or bear roar (pitch: 0 huge, 1 smaller): an open, falling vowel with breath.
      const p = ev.pitch ?? 0.5;
      const f0 = 75 + p * 90;
      vocal(bus, when, dest, { f0: f0 * 1.15, f1: f0 * 0.7, dur: 1.1 - p * 0.3, peak: v * 0.6, formants: [[380 + p * 250, 3], [900 + p * 400, 5], [2300, 6]], formantsEnd: [[300 + p * 200, 3], [700 + p * 300, 5], [2000, 6]], vibrato: 0.04, rattle: 0.25, breath: 0.35 });
      break;
    }
    case 'growl': {
      // A low rumbling growl with a rattle.
      const p = ev.pitch ?? 0.5;
      const f0 = 60 + p * 60;
      vocal(bus, when, dest, { f0, f1: f0 * 0.92, dur: 0.6, peak: v * 0.5, formants: [[300 + p * 200, 3], [800, 5]], rattle: 0.55, breath: 0.2 });
      break;
    }
    case 'snarl': {
      // A dog's snarl: higher, harsher and short.
      const p = ev.pitch ?? 0.5;
      const f0 = 140 + p * 120;
      vocal(bus, when, dest, { f0, f1: f0 * 1.1, dur: 0.35, peak: v * 0.45, formants: [[700 + p * 300, 2.5], [1800 + p * 500, 4]], rattle: 0.4, breath: 0.45 });
      break;
    }
    case 'hiss': {
      // A reptile's hiss: breathy high noise swelling and fading.
      const src = bus.ctx.createBufferSource();
      src.buffer = bus.noise;
      const f = bus.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2600 + (ev.pitch ?? 0.5) * 1500;
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(v * 0.45, when + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.7);
      src.connect(f).connect(g).connect(dest);
      src.start(when, noiseOffset(bus, when));
      src.stop(when + 0.75);
      break;
    }
    case 'whinny': {
      // A horse's whinny: a high voice shaking down in pitch.
      const p = ev.pitch ?? 0.5;
      const f0 = 520 + p * 250;
      vocal(bus, when, dest, { f0: f0 * 1.25, f1: f0 * 0.6, dur: 0.85, peak: v * 0.4, formants: [[1100 + p * 300, 4], [2400, 6]], formantsEnd: [[800, 4], [2000, 6]], vibrato: 0.12, breath: 0.25 });
      break;
    }
    case 'bellow': {
      // A bull's or a donkey's bellow: a low, nasal, rising-then-falling call.
      const p = ev.pitch ?? 0.5;
      const f0 = 85 + p * 120;
      vocal(bus, when, dest, { f0, f1: f0 * 1.35, dur: 0.9, peak: v * 0.5, formants: [[520 + p * 300, 4], [1300 + p * 400, 6]], formantsEnd: [[420, 4], [1100, 6]], vibrato: 0.03, breath: 0.15 });
      break;
    }
    case 'screech': {
      // A shrill screech (dragon, spider): a high sawtooth bending upward with a shaking vibrato.
      const p = ev.pitch ?? 0.5;
      const f0 = 520 + p * 600;
      vocal(bus, when, dest, { f0, f1: f0 * 1.5, dur: 0.6, peak: v * 0.35, formants: [[1600 + p * 800, 3], [3200, 5]], vibrato: 0.08, rattle: 0.2, breath: 0.4 });
      break;
    }
    case 'trumpet': {
      // An elephant's trumpet: a brassy blare climbing and wavering, with a breathy edge.
      const p = ev.pitch ?? 0.5;
      const f0 = 320 + p * 160;
      vocal(bus, when, dest, { f0: f0 * 0.8, f1: f0 * 1.45, dur: 1.15, peak: v * 0.42, formants: [[1150 + p * 300, 1.6], [2500, 2.5], [3800, 3]], formantsEnd: [[1400, 1.6], [2900, 2.5], [4200, 3]], vibrato: 0.09, rattle: 0.15, breath: 0.3 });
      break;
    }
    case 'chestbeat': {
      // A gorilla drumming its chest: a quick run of hollow cupped-hand thumps.
      const p = ev.pitch ?? 0.5;
      for (let k = 0; k < 7; k++) {
        const at = when + k * 0.075 + (k % 2) * 0.01;
        const o = osc(bus, 'sine', 150 + p * 40 + (k % 2) * 18, at, at + 0.16, dest, v * (0.85 - k * 0.05), 0.001, 0.11);
        o.frequency.exponentialRampToValueAtTime(85 + p * 25, at + 0.1);
        noiseBurst(bus, at, 0.03, dest, v * 0.3, 'bandpass', 600 + (k % 2) * 150, 1.5);
      }
      break;
    }
    case 'shield': {
      // A blow on a round shield: a wooden thunk and the iron boss ringing.
      const p = ev.pitch ?? 0.5;
      const o = osc(bus, 'triangle', 170 + p * 60, when, when + 0.25, dest, v * 0.8, 0.001, 0.14);
      o.frequency.exponentialRampToValueAtTime(110 + p * 30, when + 0.12);
      noiseBurst(bus, when, 0.07, dest, v * 0.55, 'bandpass', 700 + p * 300, 1.4);
      osc(bus, 'square', 1450 + p * 200, when, when + 0.35, dest, v * 0.06, 0.001, 0.25);
      osc(bus, 'sine', 2310 + p * 300, when, when + 0.4, dest, v * 0.1, 0.001, 0.3);
      break;
    }
    case 'grunt': {
      // A fighter's effort grunt: a short, low "huh".
      const p = ev.pitch ?? 0.5;
      const f0 = 105 + p * 50;
      vocal(bus, when, dest, { f0, f1: f0 * 0.85, dur: 0.22, peak: v * 0.45, formants: [[650, 4], [1100, 6]], breath: 0.3 });
      break;
    }
    case 'cheer': {
      // The crowd roars: many voices (bands of noise) swelling with a ragged wobble.
      const d = 1.8;
      [[600, 1.5], [1100, 2], [1800, 2.5], [2800, 3]].forEach(([freq, q], k) => {
        const src = bus.ctx.createBufferSource();
        src.buffer = bus.noise;
        src.loop = true;
        const f = bus.ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = q;
        f.frequency.value = freq;
        const g = bus.ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(v * (0.55 - k * 0.08), when + 0.35);
        g.gain.exponentialRampToValueAtTime(0.0001, when + d);
        const wob = bus.ctx.createOscillator();
        wob.frequency.value = 5 + k * 1.7;
        const wg = bus.ctx.createGain();
        wg.gain.value = v * 0.08;
        wob.connect(wg).connect(g.gain);
        wob.start(when);
        wob.stop(when + d + 0.05);
        src.connect(f).connect(g).connect(dest);
        src.start(when, noiseOffset(bus, when + k));
        src.stop(when + d + 0.05);
      });
      break;
    }
    case 'gasp': {
      // The crowd's "ooh": a vowel of noise rising in pitch and swelling.
      const src = bus.ctx.createBufferSource();
      src.buffer = bus.noise;
      src.loop = true;
      const g = bus.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(v * 1.1, when + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 1.0);
      for (const [f0, f1, q] of [[420, 640, 4], [850, 1100, 5]] as const) {
        const bp = bus.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = q;
        bp.frequency.setValueAtTime(f0, when);
        bp.frequency.exponentialRampToValueAtTime(f1, when + 0.6);
        src.connect(bp).connect(g);
      }
      g.connect(dest);
      src.start(when, noiseOffset(bus, when));
      src.stop(when + 1.05);
      break;
    }
    case 'ding': {
      // A small brass bell struck: bright strike and long, beating inharmonic partials.
      const p = ev.pitch ?? 0.5;
      const base = 1250 + p * 500;
      noiseBurst(bus, when, 0.01, dest, v * 0.4, 'highpass', 5000);
      [1, 2.01, 2.76, 3.97, 5.4].forEach((ratio, k) => {
        osc(bus, 'sine', base * ratio, when, when + 2.6, dest, (v * 0.32) / (k + 1), 0.001, 1.6 / (1 + k * 0.6));
        osc(bus, 'sine', base * ratio * 1.003, when, when + 2.6, dest, (v * 0.12) / (k + 1), 0.001, 1.4 / (1 + k * 0.6));
      });
      break;
    }
  }
}

/** Render a full event list offline. Tail adds room for reverb/decays after the last frame. */
export async function renderAudio(
  events: AudioEvent[],
  durationS: number,
  opts: { reverb: number; sampleRate?: number; samples?: Map<string, AudioBuffer> },
): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(durationS * sr), sr);
  const bus = createBus(ctx, { reverb: opts.reverb, samples: opts.samples });
  for (const ev of events) if (ev.t < durationS) scheduleEvent(bus, ev, ev.t);
  return ctx.startRendering();
}

/**
 * Render sim time [from, to + postRoll) of a long event list offline, as interleaved stereo float32
 * samples, so a long-form loop can be rendered in segments. Each segment starts `preRoll` seconds
 * early so reverb, filters and sounds already ringing at `from` match the previous segment;
 * preRoll must be longer than the longest sound. The post-roll overlaps the next segment and is
 * crossfaded into it when they are joined: noise bursts can land a fraction of a sample apart in two
 * renders (inaudible, but not sample-identical), and a short crossfade hides that.
 *
 * With `loopS`, events also play at their times one loop earlier and later, so the pre-roll before
 * t = 0 hears the end of the loop and the post-roll after loopS hears its start.
 */
export async function renderAudioRange(
  events: AudioEvent[],
  from: number,
  to: number,
  opts: {
    reverb: number;
    sampleRate?: number;
    preRoll?: number;
    postRoll?: number;
    loopS?: number;
    samples?: Map<string, AudioBuffer>;
    beds?: AmbientBed[];
    compress?: boolean;
  },
): Promise<Float32Array> {
  const sr = opts.sampleRate ?? 48000;
  const pre = opts.preRoll ?? 12;
  const post = opts.postRoll ?? 0;
  const start = from - pre;
  const end = to + post;
  const skip = Math.round(pre * sr);
  const n = Math.round((end - from) * sr);
  const ctx = new OfflineAudioContext(2, skip + n, sr);
  const bus = createBus(ctx, { reverb: opts.reverb, t0: start, loopS: opts.loopS, samples: opts.samples, compress: opts.compress });
  const L = opts.loopS ?? 0;
  for (const bed of opts.beds ?? []) playBed(bus, bed, (skip + n) / sr);
  const due: { when: number; ev: AudioEvent }[] = [];
  for (const ev of events) {
    for (const shift of L ? [-L, 0, L] : [0]) {
      const t = ev.t + shift;
      if (t >= start && t < end) due.push({ when: t - start, ev });
    }
  }
  due.sort((a, b) => a.when - b.when);
  // Schedule just in time, a couple of seconds ahead: every connected node is processed on every
  // render quantum even before its sound starts, so scheduling minutes of events up front makes an
  // offline render slow down with the square of its length.
  const AHEAD = 2;
  let next = 0;
  const scheduleUntil = (t: number) => {
    for (; next < due.length && due[next].when < t; next++) scheduleEvent(bus, due[next].ev, due[next].when);
  };
  scheduleUntil(AHEAD);
  const lengthS = (skip + n) / sr;
  for (let k = 1; k * AHEAD < lengthS; k++) {
    void ctx.suspend(k * AHEAD).then(() => {
      scheduleUntil((k + 1) * AHEAD);
      return ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = l[skip + i];
    out[i * 2 + 1] = r[skip + i];
  }
  return out;
}

/**
 * A bed: its recording looped from the point matching the sim time at context time `at` (so every
 * segment, and every repeat of the loop, since the recording's length divides the loop, lines up). The
 * level swells slowly, as a function of time within the loop. Returns the source, to stop it.
 */
function playBed(bus: SynthBus, bed: AmbientBed, lengthS: number, at = 0): AudioBufferSourceNode {
  const buffer = bus.samples.get(bed.sound);
  if (!buffer) throw new Error(`Sound not loaded: ${bed.sound}`);
  const ctx = bus.ctx;
  const B = buffer.length / buffer.sampleRate;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const g = ctx.createGain();
  const L = bus.loopS;
  const cycles = bed.swell?.cycles ?? [];
  const level = (t: number) => {
    if (!bed.swell || !L || !cycles.length) return bed.gain;
    let s = 0;
    cycles.forEach((c, k) => (s += Math.sin((2 * Math.PI * c * t) / L + k * 1.7)));
    return bed.gain * (1 + (bed.swell.depth * s) / cycles.length);
  };
  const STEP = 0.5;
  const t0 = bus.t0 + at;
  g.gain.setValueAtTime(level(t0), at);
  for (let k = 1; k * STEP <= lengthS + STEP; k++) g.gain.linearRampToValueAtTime(level(t0 + k * STEP), at + k * STEP);
  src.connect(g).connect(out(bus, bed.pan ?? 0));
  src.start(at, ((t0 % B) + B) % B);
  return src;
}

/** Start beds live (the preview player): from context time `at` for `lengthS`. Call the result to stop them. */
export function playBeds(bus: SynthBus, beds: AmbientBed[], at: number, lengthS: number): () => void {
  const srcs = beds.map((b) => playBed(bus, b, lengthS, at));
  return () => {
    for (const s of srcs) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
  };
}

/** 32-bit float stereo WAV, so nothing clips before loudness normalisation. */
export function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const bytes = 44 + len * ch * 4;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, ch, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * ch * 4, true);
  view.setUint16(32, ch * 4, true);
  view.setUint16(34, 32, true);
  str(36, 'data');
  view.setUint32(40, len * ch * 4, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      view.setFloat32(o, chans[c][i], true);
      o += 4;
    }
  }
  return view.buffer;
}
