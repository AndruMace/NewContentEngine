/**
 * Balance check for Who Would Win: runs every curated duel and horde headless over many seeds and
 * prints who wins how often (and how long fights last), and for hordes how many it took. Each curated
 * duel shows who ought to win (DUEL_FAVOURITES), flagged with ! when the result disagrees.
 *
 *   npx tsx scripts/battle-matrix.ts [seeds=200] [fightLength=22]
 *
 * Or any two fighters (curated or not), duel and horde:
 *
 *   npx tsx scripts/battle-matrix.ts lion bear [seeds=200] [fightLength=22]
 *   npx tsx scripts/battle-matrix.ts horde elephant lion [seeds=200]
 */
import { Rng } from '@sim/engine';
import { CREATURE_IDS, DUELS, DUEL_FAVOURITES, HORDES, creatureById, matchupId } from '../packages/templates/src/who-would-win/roster';
import { hpScaleFor, MAX_SWARM_DEFAULT } from '../packages/templates/src/who-would-win/balance';
import { makeWorld, stepWorld } from '../packages/templates/src/who-would-win/sim';

const args = process.argv.slice(2);
const horde = args[0] === 'horde';
if (horde) args.shift();
const pair = CREATURE_IDS.includes(args[0]) && CREATURE_IDS.includes(args[1]) ? ([args.shift()!, args.shift()!] as const) : null;
if (horde && !pair) throw new Error(`Name two fighters: ${CREATURE_IDS.join(', ')}`);
const SEEDS = Number(args[0] ?? 200);
const LENGTH = Number(args[1] ?? 22);
const DT = 1 / 120;

function run(mode: 'duel' | 'horde', a: string, b: string, seed: number) {
  const rng = new Rng(seed);
  const w = makeWorld({ mode, a: creatureById(a), b: creatureById(b), hpScale: hpScaleFor(LENGTH), capS: LENGTH * 2, maxSwarm: MAX_SWARM_DEFAULT, rng });
  let hits = 0;
  let kos = 0;
  const emit = (e: { type: string; side?: unknown }) => {
    if (e.type === 'hit') hits++;
    if (e.type === 'ko' && e.side === 1) kos++;
  };
  while (w.winner < 0 && w.fightT < 180) stepWorld(w, DT, emit);
  const hpLeft = w.winner >= 0 ? Math.max(...w.fighters.filter((f) => f.side === w.winner && f.alive).map((f) => f.hp / f.maxHp)) : 0;
  return { winner: w.winner, t: w.fightT, sent: w.swarm?.sent ?? 0, hits, kos, hpLeft };
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];

const duels = pair ? (horde ? [] : [pair]) : DUELS;
const hordes = pair ? (horde ? [pair] : []) : HORDES;
if (duels.length) console.log(`Duels (${SEEDS} seeds, fightLength ${LENGTH}s)`);
for (const [a, b] of duels) {
  const rs = Array.from({ length: SEEDS }, (_, i) => run('duel', a, b, i + 1));
  const aw = rs.filter((r) => r.winner === 0).length / SEEDS;
  const ts = rs.map((r) => r.t);
  const close = rs.map((r) => r.hpLeft);
  // Who ought to win, and whether it does (a favourite 60-97%, a toss-up 30-70%).
  const fav = DUEL_FAVOURITES[matchupId(a, b)];
  const [lo, hi] = fav === undefined ? [0, 1] : fav === null ? [0.3, 0.7] : fav === a ? [0.6, 0.97] : [0.03, 0.4];
  const expect = fav === undefined ? '' : `${aw < lo || aw > hi ? '!' : ' '} ${fav ?? 'toss-up'}`.padEnd(12);
  console.log(`  ${`${a} vs ${b}`.padEnd(24)} ${a} ${pct(aw)} ${expect} time p10/50/90 ${q(ts, 0.1).toFixed(0)}/${q(ts, 0.5).toFixed(0)}/${q(ts, 0.9).toFixed(0)}s  winner hp p50 ${pct(q(close, 0.5))}  timeouts ${rs.filter((r) => r.winner < 0).length}`);
}
if (hordes.length) console.log(`\nHordes (${SEEDS} seeds, up to ${MAX_SWARM_DEFAULT})`);
for (const [a, b] of hordes) {
  const rs = Array.from({ length: SEEDS }, (_, i) => run('horde', a, b, i + 1));
  const bigWins = rs.filter((r) => r.winner === 0).length / SEEDS;
  const took = rs.filter((r) => r.winner === 1).map((r) => r.sent);
  const ts = rs.map((r) => r.t);
  console.log(`  ${`${a} vs ${creatureById(b).plural.toLowerCase()}`.padEnd(24)} ${a} survives ${pct(bigWins)}  took p10/50/90 ${took.length ? `${q(took, 0.1)}/${q(took, 0.5)}/${q(took, 0.9)}` : '-'}  time p50 ${q(ts, 0.5).toFixed(0)}s  downed p50 ${q(rs.map((r) => r.kos), 0.5)}`);
}
