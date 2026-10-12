import { z } from 'zod';
import { FONT_FAMILY, lighten, paletteAt, rgbToCss, type Ctx2D, type DramaScore, type Template } from '@sim/engine';
import * as dm from '@sim/physics/math';
import { gaussFit } from '../scoring';
import { scaleNote } from '../music';
import { MAP_KINDS, MUD, WALL, makeMap, type GridMap, type MapKind } from './maps';
import { ALGOS, EXPAND, FOUND, optimalCost, recordSearch, type AlgoId, type SearchRecord } from './search';

const LINEUPS: Record<string, AlgoId[]> = {
  'bfs-dfs-astar': ['bfs', 'dfs', 'astar'],
  'dijkstra-astar-greedy': ['dijkstra', 'astar', 'greedy'],
  'astar-greedy': ['astar', 'greedy'],
  'bfs-bidir': ['bfs', 'bidir'],
  'wall-dfs-astar': ['wall', 'dfs', 'astar'],
  'bfs-dfs-astar-greedy': ['bfs', 'dfs', 'astar', 'greedy'],
};

export const pathfindingRaceSchema = z.object({
  lineup: z.enum(['random', ...Object.keys(LINEUPS)] as [string, ...string[]]).default('random').meta({ title: 'Lineup' }),
  map: z.enum(['random', ...MAP_KINDS]).default('random').meta({ title: 'Map' }),
  cellsAcross: z.number().int().min(15).max(61).default(31).meta({ title: 'Cells across' }),
  durationS: z.number().min(12).max(60).default(28).meta({ title: 'Time for the slowest (s)' }),
  notesPerSecond: z.number().min(5).max(40).default(18).meta({ title: 'Max notes/s per panel' }),
  intro: z.boolean().default(true).meta({ title: 'Build the map first' }),
});

export type PathfindingRaceParams = z.infer<typeof pathfindingRaceSchema>;

interface Panel {
  rec: SearchRecord;
  pos: number;
  exp: number;
  /** Per cell: 0 unseen, 1 found (queued), 2 expanded. */
  seen: Uint8Array;
  side: Uint8Array;
  /** Expansion index per cell (for the colour gradient). */
  order: Int32Array;
  cur: number;
  finishedAt: number;
  place: number;
  lastNoteT: number;
  lastPathNote: number;
  optimal: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface State {
  p: PathfindingRaceParams;
  map: GridMap;
  panels: Panel[];
  rects: Rect[];
  cell: number;
  rate: number;
  startAt: number;
  best: number;
  hMax: number;
  places: number;
  endAt: number | null;
  lastBuildNoteT: number;
  t: number;
}

const TOP = 1920 * 0.17;
const BOTTOM = 1920 * 0.79;
const HEADER = 58;
const INTRO_S = 2.4;
const PATH_S = 1.1;
const OUTRO_S = 2.4;

const ordinal = (n: number) => ['1st', '2nd', '3rd', '4th'][n - 1] ?? `${n}th`;
const odd = (n: number) => (n % 2 ? n : n - 1);

function layout(n: number): Rect[] {
  if (n === 4) {
    const h = (BOTTOM - TOP) / 2;
    return [0, 1, 2, 3].map((k) => ({ x: k % 2 ? 550 : 40, y: TOP + Math.floor(k / 2) * h, w: 490, h }));
  }
  const h = (BOTTOM - TOP) / n;
  return Array.from({ length: n }, (_, k) => ({ x: 40, y: TOP + k * h, w: 1000, h }));
}

export const pathfindingRace: Template<PathfindingRaceParams, State> = {
  id: 'pathfinding-race',
  name: 'Pathfinding Race',
  family: 'kinetic',
  description:
    'Search algorithms (BFS, DFS, Dijkstra, A*, Greedy, Bidirectional, Wall follower) race through the same maze at the same speed. Explored cells flood outward with a note each; finishers trace their route, and badges show who found the shortest path.',
  schema: pathfindingRaceSchema,
  substeps: 1,
  searchBudget: 60,
  glowScale: 0.45,
  ownMusic: true,
  defaultCopy: {
    hook: 'Which algorithm finds the exit first?',
    cta: '{winner} won — but was it the shortest?',
  },

  init({ params: p, rng }) {
    let lineupKey = p.lineup;
    let kind = p.map as MapKind | 'random';
    if (kind === 'random') kind = lineupKey !== 'random' && LINEUPS[lineupKey].includes('wall') ? 'maze' : rng.pick([...MAP_KINDS]);
    if (lineupKey === 'random') lineupKey = rng.pick(Object.keys(LINEUPS).filter((k) => kind === 'maze' || !LINEUPS[k].includes('wall')));
    const lineup = LINEUPS[lineupKey];
    if (lineup.includes('wall')) kind = 'maze';

    const rects = layout(lineup.length);
    const gw = rects[0].w;
    const gh = rects[0].h - HEADER - 14;
    const cols = odd(lineup.length === 4 ? Math.round(p.cellsAcross * 0.55) : p.cellsAcross);
    const rows = odd(Math.floor(gh / (gw / cols)));
    const map = makeMap(kind, cols, rows, rng);
    const cell = Math.min(gw / map.w, gh / map.h);
    const N = map.w * map.h;
    const best = optimalCost(map);
    const panels: Panel[] = lineup.map((algo) => {
      const rec = recordSearch(algo, map);
      return {
        rec,
        pos: 0,
        exp: 0,
        seen: new Uint8Array(N),
        side: new Uint8Array(N),
        order: new Int32Array(N),
        cur: -1,
        finishedAt: -1,
        place: 0,
        lastNoteT: -1,
        lastPathNote: -1,
        optimal: rec.cost === best,
      };
    });
    const slowest = Math.max(...panels.map((pn) => pn.rec.expansions));
    const hMax = map.w + map.h;
    return {
      p,
      map,
      panels,
      rects,
      cell,
      rate: slowest / p.durationS,
      startAt: p.intro ? INTRO_S : 0.4,
      best,
      hMax,
      places: 0,
      endAt: null,
      lastBuildNoteT: -1,
      t: 0,
    };
  },

  step(s, { dt, t, emit }) {
    s.t = t + dt;
    const m = s.map;
    if (t < s.startAt) {
      if (s.p.intro && t - s.lastBuildNoteT >= 1 / 16) {
        s.lastBuildNoteT = t;
        emit({ type: 'build', value: t / s.startAt });
      }
      return;
    }
    const target = Math.floor((t + dt - s.startAt) * s.rate);
    const gx = m.goal % m.w;
    const gy = (m.goal / m.w) | 0;
    s.panels.forEach((pn, k) => {
      const ops = pn.rec.ops;
      while (pn.pos < ops.length && pn.exp < target) {
        const kind = ops[pn.pos];
        const c = ops[pn.pos + 1];
        const side = ops[pn.pos + 2];
        pn.pos += 3;
        if (kind === FOUND) {
          if (pn.seen[c] < 1) pn.seen[c] = 1;
          pn.side[c] = side;
        } else if (kind === EXPAND) {
          pn.seen[c] = 2;
          pn.side[c] = side;
          pn.order[c] = pn.exp++;
          pn.cur = c;
          if (t - pn.lastNoteT >= 1 / s.p.notesPerSecond) {
            pn.lastNoteT = t;
            // Pitch rises as the search gets closer to the goal (or, from the goal side, the start).
            const tx = side ? m.start % m.w : gx;
            const ty = side ? (m.start / m.w) | 0 : gy;
            const d = Math.abs((c % m.w) - tx) + Math.abs(((c / m.w) | 0) - ty);
            emit({ type: 'tone', panel: k, value: 1 - d / s.hMax });
          }
        }
      }
      if (pn.pos >= ops.length && pn.finishedAt < 0) {
        pn.finishedAt = t;
        pn.place = ++s.places;
        pn.cur = -1;
        emit({ type: 'finish', panel: k, place: pn.place, algo: pn.rec.algo, cost: pn.rec.cost, optimal: pn.optimal, explored: pn.exp });
        if (s.places === s.panels.length) s.endAt = t + PATH_S;
      }
      if (pn.finishedAt >= 0) {
        const prog = (t - pn.finishedAt) / PATH_S;
        if (prog < 1 && t - pn.lastPathNote >= 1 / 14) {
          pn.lastPathNote = t;
          emit({ type: 'path', panel: k, value: prog });
        }
      }
    });
  },

  isDone(s) {
    return s.endAt !== null && s.t >= s.endAt + OUTRO_S;
  },

  hud(s) {
    const win = s.panels.find((pn) => pn.place === 1);
    return { winner: win ? ALGOS[win.rec.algo].name : '', outro: s.endAt !== null && s.t >= s.endAt };
  },

  overlays(_p, copy) {
    return [
      { kind: 'hook', text: copy.hook, from: 0, to: 2.6, y: 0.12 },
      { kind: 'cta', text: copy.cta, when: 'outro', y: 0.12 },
    ];
  },

  render({ ctx, theme }, s) {
    const m = s.map;
    const weighted = m.kind === 'weighted';
    const compact = s.panels.length === 4;
    const build = s.t < s.startAt && s.p.intro ? Math.min(1, s.t / (s.startAt * 0.92)) : 1;
    const built = new Uint8Array(m.w * m.h);
    const shown = Math.floor(m.build.length * build);
    for (let i = 0; i < shown; i++) built[m.build[i]] = 1;

    s.panels.forEach((pn, k) => {
      const r = s.rects[k];
      const gw = m.w * s.cell;
      const gh = m.h * s.cell;
      const ox = r.x + (r.w - gw) / 2;
      const oy = r.y + HEADER + (r.h - HEADER - 14 - gh) / 2;
      const cs = s.cell;

      // Header.
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `900 ${compact ? 30 : 40}px ${FONT_FAMILY}`;
      ctx.fillStyle = theme.text;
      ctx.fillText(ALGOS[pn.rec.algo].name, ox, r.y + 28);
      ctx.textAlign = 'right';
      ctx.font = `800 ${compact ? 20 : 26}px ${FONT_FAMILY}`;
      const traced = pn.finishedAt >= 0 && s.t >= pn.finishedAt + PATH_S;
      let label = `${pn.exp} explored`;
      let color = 'rgba(255,255,255,0.6)';
      if (pn.place) {
        const measure = weighted ? `cost ${pn.rec.cost}` : `path ${pn.rec.path.length - 1}`;
        const verdict = !traced ? '' : pn.optimal ? ' ✓' : ` (+${pn.rec.cost - s.best})`;
        label = `${pn.place === 1 ? '🏆 ' : ''}${ordinal(pn.place)} · ${measure}${verdict}`;
        color = traced && !pn.optimal ? '#ff8a8a' : theme.accent;
      }
      ctx.fillStyle = color;
      ctx.fillText(label, ox + gw, r.y + 30);

      // Grid.
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(ox, oy, gw, gh);
      const inset = Math.max(0.5, cs * 0.06);
      const total = Math.max(1, pn.rec.expansions);
      for (let c = 0; c < m.w * m.h; c++) {
        const x = ox + (c % m.w) * cs;
        const y = oy + ((c / m.w) | 0) * cs;
        let v = m.cells[c];
        if (build < 1) v = m.buildCarves ? (built[c] ? v : WALL) : built[c] ? v : 0;
        if (v === WALL) {
          ctx.fillStyle = 'rgba(190,200,255,0.2)';
          ctx.fillRect(x, y, cs, cs);
          continue;
        }
        if (v === MUD) {
          // Dark, speckled mud: clearly not an explored cell.
          ctx.fillStyle = 'rgb(74,50,30)';
          ctx.fillRect(x, y, cs, cs);
          ctx.fillStyle = 'rgba(160,115,70,0.55)';
          const d = Math.max(1.5, cs * 0.12);
          ctx.fillRect(x + cs * 0.22, y + cs * 0.3, d, d);
          ctx.fillRect(x + cs * 0.62, y + cs * 0.62, d, d);
        }
        const st = pn.seen[c];
        if (st === 2) {
          const u = pn.order[c] / total;
          const col = paletteAt(theme.palette, pn.side[c] ? 0.98 - 0.3 * u : 0.35 + 0.45 * u);
          ctx.fillStyle = rgbToCss(col, v === MUD ? 0.4 : 0.5);
          ctx.fillRect(x + inset, y + inset, cs - 2 * inset, cs - 2 * inset);
        } else if (st === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.fillRect(x + cs * 0.25, y + cs * 0.25, cs * 0.5, cs * 0.5);
        }
      }
      if (pn.cur >= 0) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(ox + (pn.cur % m.w) * cs, oy + ((pn.cur / m.w) | 0) * cs, cs, cs);
      }

      // Route.
      if (pn.finishedAt >= 0 && pn.rec.path.length > 1) {
        const prog = Math.min(1, (s.t - pn.finishedAt) / PATH_S);
        const upto = prog * (pn.rec.path.length - 1);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = Math.max(5, cs * 0.5);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        tracePath(ctx, pn, m, ox, oy, cs, upto);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(3, cs * 0.3);
        const [hx, hy] = tracePath(ctx, pn, m, ox, oy, cs, upto);
        ctx.stroke();
        if (prog < 1) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(hx, hy, Math.max(4, cs * 0.4), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      drawEnds(ctx, m, ox, oy, cs, theme.accent);
    });
  },

  audio(e) {
    switch (e.type) {
      case 'build':
        return [{ kind: 'sfx', name: 'tick', vel: 0.35, pitch: e.value as number }];
      case 'tone': {
        const pan = [-0.45, 0.45, 0, -0.2][e.panel as number] ?? 0;
        const degree = Math.round((e.value as number) * 14);
        return [{ kind: 'note', midi: scaleNote('pentatonic', 50, degree), vel: 0.36, voice: 'softsine', dur: 0.24, pan }];
      }
      case 'path': {
        const pan = [-0.45, 0.45, 0, -0.2][e.panel as number] ?? 0;
        return [{ kind: 'note', midi: scaleNote('pentatonic', 62, Math.round((e.value as number) * 9)), vel: 0.3, voice: 'pluck', dur: 0.4, pan }];
      }
      case 'finish': {
        const place = e.place as number;
        // D major, to match the D pentatonic search notes still sounding from the other panels.
        const notes = place === 1 ? [74, 78, 81, 86] : [69, 74];
        return [
          { kind: 'note', midi: [86, 81, 78, 74][place - 1] ?? 74, vel: place === 1 ? 0.6 : 0.36, voice: 'bell', dur: 1.2 },
          ...notes.map((midi, i) => ({ kind: 'note' as const, midi, vel: 0.33, voice: 'bell' as const, dur: 1.5 + i * 0.1 })),
        ];
      }
    }
    return [];
  },

  score(events, { durationS, targetS }): DramaScore {
    const finishes = events.filter((e) => e.type === 'finish');
    const durFit = gaussFit(durationS, targetS, targetS * 0.25);
    const gap = finishes.length > 1 ? finishes[1].t - finishes[0].t : durationS;
    const closeFit = dm.exp(-gap / (0.15 * durationS));
    // The twist: the first to arrive took a longer route than someone else found.
    const twist = finishes.length && finishes[0].optimal === false ? 1 : 0;
    const total = durFit * (0.5 + 0.3 * closeFit + 0.2 * twist);
    return { total, parts: { durFit, closeFit, twist }, notes: [`winner margin ${gap.toFixed(1)}s`, twist ? 'winner took a longer route' : 'winner found the shortest route'] };
  },
};

/** Build the route polyline up to `upto` (fractional index); returns the head position. */
function tracePath(ctx: Ctx2D, pn: Panel, m: GridMap, ox: number, oy: number, cs: number, upto: number): [number, number] {
  const pt = (i: number) => [ox + ((pn.rec.path[i] % m.w) + 0.5) * cs, oy + (((pn.rec.path[i] / m.w) | 0) + 0.5) * cs];
  ctx.beginPath();
  const [x0, y0] = pt(0);
  ctx.moveTo(x0, y0);
  const i0 = Math.floor(upto);
  for (let i = 1; i <= i0; i++) {
    const [x, y] = pt(i);
    ctx.lineTo(x, y);
  }
  let [hx, hy] = pt(i0);
  if (i0 < pn.rec.path.length - 1) {
    const [bx, by] = pt(i0 + 1);
    const f = upto - i0;
    hx += (bx - hx) * f;
    hy += (by - hy) * f;
    ctx.lineTo(hx, hy);
  }
  return [hx, hy];
}

function drawEnds(ctx: Ctx2D, m: GridMap, ox: number, oy: number, cs: number, accent: string) {
  const at = (c: number) => [ox + ((c % m.w) + 0.5) * cs, oy + (((c / m.w) | 0) + 0.5) * cs];
  const [sx, sy] = at(m.start);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(5, cs * 0.42), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(2, cs * 0.12);
  ctx.stroke();
  const [gx, gy] = at(m.goal);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(14, Math.round(cs * 1.15))}px ${FONT_FAMILY}`;
  ctx.fillText('🏁', gx, gy);
}
