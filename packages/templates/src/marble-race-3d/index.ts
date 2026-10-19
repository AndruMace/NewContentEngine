import { z } from 'zod';
import { FONT_FAMILY, Rng, type AudioEventInput, type Ctx2D, type DramaScore, type LeaderboardRow, type SimEvent, type Template, type Theme, type VoiceId } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { clamp01, gaussFit, mean } from '../scoring';
import { COLOR_TEAMS, COUNTRY_TEAMS, pickTeams, type Team } from '../fx';
import { DT, STEPS_PER_FRAME, type BodyRec, type Piece, type TapeEvent } from '../rube-goldberg/sim';
import type { Course } from './course';
import { GATE_OPEN_S, OUTRO_S, runRace, type Mode } from './race';
import { cameraTrack, drawRace3D, type CameraTrack } from './view3d';
import { LOOKS, LOOK_GLOW, type LookId } from './looks';
import { buildTimeline, type Onset } from '../song';

export const SOUNDS = ['melody', 'background', 'effects'] as const;
export type Sound = (typeof SOUNDS)[number];

/** Background music: its own instrument per look. */
const MUSIC_VOICE: Record<LookId, VoiceId | null> = { classic: 'marimba', futuristic: 'pluck', arctic: 'glass', neon: null };
const MUSIC_LEAD_S = 0.6;

export const marbleRace3dSchema = z.object({
  marbleCount: z.number().int().min(3).max(16).default(8).meta({ title: 'Marbles' }),
  mode: z.enum(['elimination', 'race']).default('elimination').meta({ title: 'Mode' }),
  teams: z.enum(['countries', 'colors']).default('countries').meta({ title: 'Teams' }),
  raceSections: z.number().int().min(2).max(8).default(5).meta({ title: 'Sections (race mode)' }),
  maxEliminationSections: z.number().int().min(2).max(8).default(6).meta({ title: 'Max sections (elimination)' }),
  lanesPerSection: z.number().int().min(2).max(4).default(3).meta({ title: 'Lanes per section' }),
  obstacleDensity: z.number().min(0.5).max(1.5).default(1).meta({ title: 'Obstacle density', step: 0.05 }),
  spinnerSpeed: z.number().min(0.5).max(4).default(2.2).meta({ title: 'Spinner speed', step: 0.1 }),
  look: z.enum(LOOKS).default('classic').meta({ title: 'Look (classic wood and brass, futuristic, arctic ice, or neon)' }),
  sound: z
    .enum(SOUNDS)
    .default('melody')
    .meta({ title: 'Sound (melody: hits play the tune; background: real impact sounds with the tune as background music; effects: real impact sounds only)' }),
});

export type MarbleRace3dParams = z.infer<typeof marbleRace3dSchema>;

export interface State {
  p: MarbleRace3dParams;
  mode: Mode;
  teams: Team[];
  course: Course;
  statics: Piece[];
  bodies: BodyRec[];
  frames: Float32Array[];
  /** Body index of each marble. */
  marbles: number[];
  progress: Float32Array[];
  events: TapeEvent[];
  nextEvent: number;
  steps: number;
  winner: number;
  winStep: number;
  /** Per video frame, the furthest any marble had got so far (for the gaps on the leaderboard). */
  frontier: Float32Array;
  /** When the result is complete: the podium filled (race mode), or the win (elimination). */
  podiumStep: number;
  camera: CameraTrack;
  /** Race mode: the finishers so far, with when they crossed and how far behind the winner. */
  finishes: { who: number; t: number; gap: number }[];
  /** Background music (sound: background), and its cursor. */
  music: Onset[];
  nextNote: number;
  /** Replayed from the tape: who's out (and when), who has finished, the checkpoint in play. */
  outAt: number[];
  finishOrder: number[];
  nextCp: number;
  /** Gate openings (step), for drawing them lifting. */
  gateOpen: number[];
  k: number;
  t: number;
  theme: Theme;
  visual: boolean;
}

export const marbleRace3d: Template<MarbleRace3dParams, State> = {
  id: 'marble-race-3d',
  name: 'Marble Race 3D',
  family: 'race',
  description:
    'Marbles race down a 3D tower with real rolling physics: sloping lanes, drops, hairpin turns, helixes, coin funnels, peg fields and spinning bars, different for every seed. Four looks: classic (photoreal wood, brass and felt, like a handmade marble run), futuristic (carbon fibre, titanium and light strips in a dark hangar), arctic (a track carved from ice, with snow) and neon (stylised, in the video theme\'s colours). In elimination mode the last marble(s) past each checkpoint are knocked out (the rest wait at a gate) until one remains; in race mode first past the finish wins.',
  schema: marbleRace3dSchema,
  substeps: STEPS_PER_FRAME,
  // The race is simulated at init on Rapier: well under a second a seed.
  searchBudget: 40,
  // The photoreal looks want next to no 2D bloom; the futuristic light strips and neon a little.
  glowScale: (p) => LOOK_GLOW[p.look as LookId] ?? 0.35,
  defaultCopy: {
    hook: 'Pick a marble before the race starts!',
    cta: '{winner} wins! Did you call it?',
  },
  nudges: ['Pick your marble in the comments 👇', 'Who wins? Call it now 👇', 'Lock in a winner 👇', 'Comment your pick before the finish 👇', "Who's out first? Guess 👇", 'Who are you backing? 👇'],

  init({ params: p, rng, visual, theme, melody }) {
    const teams = pickTeams(p.teams === 'countries' ? COUNTRY_TEAMS : COLOR_TEAMS, p.marbleCount, rng);
    const mode = p.mode as Mode;
    const sections = mode === 'elimination' ? Math.min(p.marbleCount - 1, p.maxEliminationSections) : p.raceSections;
    const race = runRace(new Rng(rng.u32()), {
      mode,
      marbles: p.marbleCount,
      sections,
      lanesPerSection: p.lanesPerSection,
      density: p.obstacleDensity,
      spinnerSpeed: p.spinnerSpeed,
    });
    const { sim } = race;
    const steps = race.timedOut || race.lost ? Math.round(GATE_OPEN_S / DT) + 60 : race.steps;
    const state: State = {
      p,
      mode,
      teams,
      course: race.course,
      statics: sim.statics,
      bodies: sim.bodies,
      frames: sim.frames,
      marbles: race.marbles,
      progress: race.progress,
      events: race.timedOut || race.lost ? [] : race.events,
      nextEvent: 0,
      steps,
      winner: race.timedOut || race.lost ? -1 : race.winner,
      winStep: race.winStep,
      frontier: frontierOf(race.progress),
      podiumStep: race.podiumStep,
      camera: cameraTrack(race.focus, race.course),
      finishes: [],
      music: [],
      nextNote: 0,
      outAt: new Array(p.marbleCount).fill(-1),
      finishOrder: [],
      nextCp: 0,
      gateOpen: [],
      k: 0,
      t: 0,
      theme,
      visual,
    };
    // Background music: whole phrases at the tune's own pace, over the whole video.
    if (p.sound === 'background') state.music = buildTimeline(melody, MUSIC_LEAD_S, Math.max(4, steps * DT - MUSIC_LEAD_S - 0.8)).onsets;
    // The physics is done and on the tape: release the engine's memory.
    sim.free();
    return state;
  },

  step(s, { emit }) {
    s.k++;
    s.t = s.k * DT;
    const voice = MUSIC_VOICE[s.p.look as LookId] ?? s.theme.voice;
    while (s.nextNote < s.music.length && s.music[s.nextNote].t < s.t) {
      const o = s.music[s.nextNote++];
      emit({ type: 'music', midi: o.midi, bass: o.bass[0] ?? -1, dur: o.dur, voice });
    }
    // Real sounds only (or under background music): a quiet bed of room tone for the look's
    // setting, so the impacts sit in a place rather than in silence.
    if (s.p.sound !== 'melody' && s.k % (4 * 240) === 1) emit({ type: 'ambience', look: s.p.look });
    while (s.nextEvent < s.events.length && s.events[s.nextEvent].step <= s.k) {
      const { step: _, ...ev } = s.events[s.nextEvent++];
      // The sound setting and look ride along, so the audio knows what to play.
      if (ev.type === 'impact' || ev.type === 'win') Object.assign(ev, { snd: s.p.sound, look: s.p.look });
      switch (ev.type) {
        case 'eliminate':
          s.outAt[ev.who as number] = s.t;
          break;
        case 'finish':
          s.finishOrder.push(ev.who as number);
          s.finishes.push({ who: ev.who as number, t: s.t, gap: (ev.gap as number) ?? 0 });
          break;
        case 'checkpoint':
          s.nextCp = ev.cp as number;
          break;
        case 'roundGate':
          s.gateOpen[ev.cp as number] = s.k;
          s.nextCp = (ev.cp as number) + 1;
          break;
      }
      emit(ev as { type: string });
    }
  },

  isDone(s) {
    return s.k >= s.steps;
  },

  hud(s) {
    const f = frameAt(s);
    const prog = s.progress[f] ?? s.progress[s.progress.length - 1];
    const rows: LeaderboardRow[] = [];
    const row = (i: number, out = false): LeaderboardRow => ({ label: s.teams[i].label, color: s.teams[i].color, icon: s.teams[i].icon, ...(out ? { out } : {}) });
    for (const fin of s.finishes) rows.push({ ...row(fin.who), note: fin.gap > 0.005 ? `+${fin.gap.toFixed(2)}s` : undefined });
    const alive = s.teams.map((_, i) => i).filter((i) => s.outAt[i] < 0 && !s.finishOrder.includes(i));
    const ranked = (p: Float32Array | undefined) => (p ? [...alive].sort((a, b) => p[b] - p[a] || a - b) : alive);
    const now = ranked(prog);
    // Places gained or lost over the last second (arrows), and each marble's time behind the
    // leader: how long ago the front of the race was where it is now.
    const before = ranked(s.progress[Math.max(0, f - 60)]);
    for (const i of now) {
      const move = before.indexOf(i) - now.indexOf(i);
      // (No gap on the leader's own row.)
      const gap = prog && (s.finishes.length || now.indexOf(i) > 0) ? gapBehind(s, f, prog[i]) : 0;
      rows.push({ ...row(i), ...(move ? { move } : {}), ...(gap >= 0.05 ? { note: `+${gap.toFixed(1)}s` } : {}) });
    }
    const outs = s.teams
      .map((_, i) => i)
      .filter((i) => s.outAt[i] >= 0)
      .sort((a, b) => s.outAt[b] - s.outAt[a]);
    for (const i of outs) rows.push(row(i, true));
    const won = s.winner >= 0 && s.k >= s.winStep;
    const w = won ? s.teams[s.winner] : null;
    return {
      standings: rows,
      alive: s.teams.length - outs.length,
      winner: w ? `${w.icon ? w.icon + ' ' : ''}${w.label}` : '',
      // The CTA waits for the podium to fill in race mode.
      outro: won && s.k >= s.podiumStep,
    };
  },

  overlays(p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'leaderboard', key: 'standings', title: p.mode === 'elimination' ? 'STILL IN' : 'STANDINGS', max: 8, x: 28, y: 0.15 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.43 },
    ];
  },

  render({ ctx, theme, t }, s) {
    drawRace3D(ctx, theme, s, t);
  },

  // Race mode: the podium, filling in as 1st, 2nd and 3rd cross the line.
  renderTop({ ctx, t }, s) {
    if (s.mode === 'race' && s.finishes.length) drawPodium(ctx, s, t);
  },

  audio(e, { melody, theme, lastNoteT }) {
    const pan = typeof e.x === 'number' ? Math.max(-0.7, Math.min(0.7, (e.x as number) / 0.25)) : 0;
    switch (e.type) {
      case 'impact': {
        const tags = [e.tagA, e.tagB];
        if (!tags.includes('marble')) return [];
        if (e.snd === 'background' || e.snd === 'effects') return impactSound(e, pan);
        const v = clamp01((e.speed as number) / 0.9);
        const struck = tags.includes('peg') || tags.includes('spinner') || tags.includes('gate');
        const both = tags[0] === 'marble' && tags[1] === 'marble';
        // Pegs, spinners and marble-on-marble knocks carry the tune (thinned, so it stays a tune).
        if ((struck || both) && e.t - lastNoteT >= 0.11 && v > 0.12) {
          return melody.next().map((midi, i) => ({ kind: 'note' as const, midi, vel: (0.38 + 0.5 * v) * (i ? 0.45 : 1), voice: theme.voice, pan }));
        }
        if (both) return [{ kind: 'sfx', name: 'clink', vel: 0.04 + 0.16 * v, pitch: 0.3 + 0.2 * v, pan }];
        if (v > 0.2) return [{ kind: 'sfx', name: 'tick', vel: 0.06 + 0.2 * v, pan }];
        return [];
      }
      case 'gate':
      case 'roundGate':
        return [{ kind: 'sfx', name: 'whoosh', vel: 0.6 }];
      case 'ambience': {
        const look = e.look as LookId;
        return [{ kind: 'sfx', name: 'ambience', vel: look === 'futuristic' ? 0.55 : look === 'arctic' ? 0.5 : 0.4, pitch: look === 'futuristic' ? 0.5 : look === 'arctic' ? 1 : 0 }];
      }
      case 'music': {
        // The tune as background music: a lead line with a soft bass under it.
        const dur = Math.max(0.3, Math.min(2.4, (e.dur as number) * 1.5));
        const out: AudioEventInput[] = [{ kind: 'note', midi: e.midi as number, vel: 0.38, voice: e.voice as VoiceId, dur }];
        if ((e.bass as number) > 0) out.push({ kind: 'note', midi: (e.bass as number) >= 48 ? (e.bass as number) - 12 : (e.bass as number), vel: 0.22, voice: 'softsine', dur: dur * 1.2 });
        return out;
      }
      case 'eliminate':
        return [
          { kind: 'sfx', name: 'shatter', vel: 0.7, pan },
          { kind: 'sfx', name: 'boom', vel: 0.45 },
        ];
      case 'finish':
        return [{ kind: 'sfx', name: 'chime', vel: 0.5, pitch: 1 - (e.place as number) / 10, pan }];
      case 'win': {
        const out: AudioEventInput[] = [
          { kind: 'sfx', name: 'boom', vel: 1 },
          { kind: 'sfx', name: 'whoosh', vel: 0.7 },
        ];
        // With the tune on the hits, the win rings it out; otherwise no extra notes.
        if (e.snd === 'melody' || e.snd === undefined) for (const midi of melody.peek()) out.push({ kind: 'note', midi, vel: 0.8, voice: 'bell', dur: 2.5 }, { kind: 'note', midi: midi + 12, vel: 0.5, voice: 'bell', dur: 2.5 });
        return out;
      }
    }
    return [];
  },

  score(events, { durationS, targetS, timedOut }): DramaScore {
    const win = events.find((e) => e.type === 'win');
    const durFit = gaussFit(durationS, targetS, targetS * 0.2);
    if (timedOut || !win) return { total: 0.02 * durFit, parts: { durFit }, notes: ['no winner'] };
    const leadChanges = events.filter((e) => e.type === 'leadChange');
    const lcFit = clamp01(leadChanges.length / 6);
    const elims = events.filter((e) => e.type === 'eliminate');
    // Close calls: knocked out a hair short of the line (in metres of track).
    const closeFit = elims.length ? mean(elims.map((e) => dm.exp(-(e.margin as number) / 0.25))) : 0.6;
    const kicks = events.filter((e) => e.type === 'kick').length;
    const kickFit = dm.exp(-kicks / 6);
    // Comeback: whoever led at the halfway point did not win.
    const half = win.t / 2;
    const leaderAtHalf = [...leadChanges].reverse().find((e) => e.t <= half)?.to;
    const comeback = leaderAtHalf !== undefined && leaderAtHalf !== win.who ? 1 : 0.4;
    // Lulls: the longest stretch without a tuneful knock.
    const knocks = events
      .filter((e) => e.type === 'impact' && e.t > GATE_OPEN_S && e.t < win.t && (e.tagA === 'marble' || e.tagB === 'marble') && (e.speed as number) / 0.9 > 0.12 && [e.tagA, e.tagB].some((t) => t === 'peg' || t === 'spinner' || t === 'gate' || (e.tagA === 'marble' && e.tagB === 'marble')))
      .map((e) => e.t);
    let maxGap = 0;
    for (let i = 1; i < knocks.length; i++) maxGap = Math.max(maxGap, knocks[i] - knocks[i - 1]);
    const lullFit = dm.exp(-Math.max(0, maxGap - 1.2) / 0.8);
    const total = durFit * (0.45 + 0.55 * lcFit) * (0.5 + 0.5 * closeFit) * (0.4 + 0.6 * kickFit) * (0.75 + 0.25 * comeback) * (0.55 + 0.45 * lullFit);
    return {
      total,
      parts: { durFit, lcFit, closeFit, kickFit, comeback, lullFit },
      notes: [`${leadChanges.length} lead changes`, `${kicks} unstick nudges`, `longest quiet gap ${maxGap.toFixed(1)}s`, `winner decided at ${win.t.toFixed(1)}s`],
    };
  },
};

/**
 * A marble striking something, as it would sound: glass on glass clinks, metal pings, wood knocks,
 * ice knocks hard, felt thuds. What the track is made of depends on the look.
 */
function impactSound(e: SimEvent, pan: number): AudioEventInput[] {
  const v = clamp01((e.speed as number) / 0.9);
  if (v < 0.08) return [];
  const tags = [e.tagA, e.tagB];
  const look = e.look as LookId;
  if (tags[0] === 'marble' && tags[1] === 'marble') return [{ kind: 'sfx', name: 'clink', vel: 0.05 + 0.32 * v, pitch: 0.32 + 0.2 * v, pan }];
  if (tags.includes('pad')) return [{ kind: 'sfx', name: 'knock', vel: 0.03 + 0.15 * v, pitch: 0.12, pan }];
  if (tags.includes('peg')) return [{ kind: 'sfx', name: 'clink', vel: look === 'arctic' ? 0.04 + 0.2 * v : 0.05 + 0.3 * v, pitch: look === 'arctic' ? 0.3 : 0.5 + 0.1 * v, pan }];
  if (tags.includes('spinner') || tags.includes('gate')) {
    if (look === 'futuristic') return [{ kind: 'sfx', name: 'clang', vel: 0.05 + 0.25 * v, pitch: 0.8, pan }];
    if (look === 'arctic') return [{ kind: 'sfx', name: 'knock', vel: 0.05 + 0.3 * v, pitch: 0.65, pan }];
    return [{ kind: 'sfx', name: 'knock', vel: 0.06 + 0.35 * v, pitch: 0.5, pan }];
  }
  // The track itself: lanes, walls, turns and funnels.
  const metal = tags.includes('funnel') && look === 'classic';
  switch (look) {
    case 'classic':
      return metal ? [{ kind: 'sfx', name: 'clink', vel: 0.04 + 0.25 * v, pitch: 0.28, pan }] : [{ kind: 'sfx', name: 'knock', vel: 0.04 + 0.35 * v, pitch: 0.25 + 0.4 * v, pan }];
    case 'futuristic':
      return [{ kind: 'sfx', name: 'clang', vel: 0.03 + 0.2 * v, pitch: 0.6 + 0.2 * v, pan }];
    case 'arctic':
      // Hard ice: a sharp, high knock rather than a glassy ring.
      return [{ kind: 'sfx', name: 'knock', vel: 0.04 + 0.3 * v, pitch: 0.55 + 0.3 * v, pan }];
    default:
      return [{ kind: 'sfx', name: 'tick', vel: 0.06 + 0.2 * v, pan }];
  }
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** The podium card: each finisher pops in as they cross, with how far behind the winner they were. */
function drawPodium(ctx: Ctx2D, s: State, t: number) {
  const rows = s.finishes.slice(0, 3);
  const rowH = 92;
  const w = 720;
  const x0 = 540 - w / 2;
  const y0 = 1920 * 0.56;
  const h = 40 + rowH * rows.length;
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,0.72)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, 28);
  ctx.fill();
  ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    const u = Math.min(1, Math.max(0, (t - r.t) / 0.28));
    const pop = 1 + 0.25 * Math.sin(u * Math.PI) * (1 - u);
    const team = s.teams[r.who];
    const y = y0 + 20 + rowH * i + rowH / 2;
    ctx.globalAlpha = u;
    ctx.save();
    ctx.translate(540, y);
    ctx.scale(pop, pop);
    ctx.translate(-540, -y);
    ctx.font = `64px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(MEDALS[i], x0 + 28, y + 4);
    ctx.fillStyle = team.color;
    ctx.beginPath();
    ctx.arc(x0 + 140, y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `900 52px ${FONT_FAMILY}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${team.icon ? team.icon + ' ' : ''}${team.label}`, x0 + 186, y + 3);
    ctx.textAlign = 'right';
    ctx.font = `800 40px ${FONT_FAMILY}`;
    ctx.fillStyle = i === 0 ? '#ffd76a' : 'rgba(255,255,255,0.75)';
    ctx.fillText(i === 0 ? 'WINNER' : `+${r.gap.toFixed(2)}s`, x0 + w - 32, y + 3);
    ctx.restore();
  });
  ctx.restore();
}

/** The front of the race, frame by frame (never moving back). */
function frontierOf(progress: Float32Array[]): Float32Array {
  const out = new Float32Array(progress.length);
  let best = 0;
  progress.forEach((p, f) => {
    for (const v of p) best = Math.max(best, v);
    out[f] = best;
  });
  return out;
}

/** Seconds since the front of the race was at course distance p (as of frame f). */
function gapBehind(s: State, f: number, p: number): number {
  let lo = 0;
  let hi = Math.min(f, s.frontier.length - 1);
  if (s.frontier[hi] <= p) return 0;
  // The last frame the front was still at or behind p.
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.frontier[mid] <= p) lo = mid;
    else hi = mid - 1;
  }
  return (f - lo) / 60;
}

/** The video frame the tape is on. */
export const frameAt = (s: State) => Math.min(s.frames.length - 1, Math.floor(s.k / STEPS_PER_FRAME));

export { OUTRO_S };
