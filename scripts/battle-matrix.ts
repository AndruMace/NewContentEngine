/**
 * Balance check for Who Would Win: runs every curated duel and horde headless over many seeds and
 * prints who wins how often (and how long fights last), and for hordes how many it took.
 *
 *   npx tsx scripts/battle-matrix.ts [seeds=200] [fightLength=22]
 */
import { Rng } from '@sim/engine';
import { DUELS, HORDES, creatureById } from '../packages/templates/src/who-would-win/roster';
import { hpScaleFor, MAX_SWARM_DEFAULT } from '../packages/templates/src/who-would-win/balance';
import { makeWorld, stepWorld } from '../packages/templates/src/who-would-win/sim';

const SEEDS = Number(process.argv[2] ?? 200);
const LENGTH = Number(process.argv[3] ?? 22);
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

console.log(`Duels (${SEEDS} seeds, fightLength ${LENGTH}s)`);
for (const [a, b] of DUELS) {
  const rs = Array.from({ length: SEEDS }, (_, i) => run('duel', a, b, i + 1));
  const aw = rs.filter((r) => r.winner === 0).length / SEEDS;
  const ts = rs.map((r) => r.t);
  const close = rs.map((r) => r.hpLeft);
  console.log(`  ${`${a} vs ${b}`.padEnd(24)} ${a} ${pct(aw)}  time p10/50/90 ${q(ts, 0.1).toFixed(0)}/${q(ts, 0.5).toFixed(0)}/${q(ts, 0.9).toFixed(0)}s  winner hp p50 ${pct(q(close, 0.5))}  timeouts ${rs.filter((r) => r.winner < 0).length}`);
}
console.log(`\nHordes (${SEEDS} seeds, up to ${MAX_SWARM_DEFAULT})`);
for (const [a, b] of HORDES) {
  const rs = Array.from({ length: SEEDS }, (_, i) => run('horde', a, b, i + 1));
  const bigWins = rs.filter((r) => r.winner === 0).length / SEEDS;
  const took = rs.filter((r) => r.winner === 1).map((r) => r.sent);
  const ts = rs.map((r) => r.t);
  console.log(`  ${`${a} vs ${creatureById(b).plural.toLowerCase()}`.padEnd(24)} ${a} survives ${pct(bigWins)}  took p10/50/90 ${took.length ? `${q(took, 0.1)}/${q(took, 0.5)}/${q(took, 0.9)}` : '-'}  time p50 ${q(ts, 0.5).toFixed(0)}s  downed p50 ${q(rs.map((r) => r.kos), 0.5)}`);
}
