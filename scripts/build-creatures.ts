/**
 * Build the Who Would Win creature models (assets/ambient/models/creatures) from Quaternius's CC0
 * models on Poly Pizza, and record them in assets/ambient/manifest.json. The downloads are cached in
 * data/creature-sources/ (gitignored); run
 *
 *   npx tsx scripts/build-creatures.ts
 *
 * Each model's page is checked for its CC0 licence before the file is used. Animal models hold every
 * animation twice (a bare name and an "AnimalArmature|" copy, not always identical): the first of each
 * name is kept and names lose their armature prefixes ("EnemyArmature|EnemyArmature|Attack" → "Attack").
 * Redundant keyframes and unused data are removed. Prints each model's clips and lengths (for the roster table).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, resample } from '@gltf-transform/functions';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'data/creature-sources');
const OUT_DIR = 'models/creatures';
const MANIFEST = join(ROOT, 'assets/ambient/manifest.json');

interface Source {
  /** Output file name (assets/ambient/models/creatures/<name>.glb). */
  name: string;
  /** Poly Pizza model id (https://poly.pizza/m/<id>). */
  id: string;
  title: string;
  use: string;
}

const SOURCES: Source[] = [
  { name: 'bull', id: 'a8PIIYwF7r', title: 'Bull', use: 'Who Would Win: Bull' },
  { name: 'horse', id: 'qvTrSG9pZF', title: 'Horse', use: 'Who Would Win: Horse' },
  { name: 'white-horse', id: 'bEdE4rmZy9', title: 'White Horse', use: 'Who Would Win: Unicorn (horn added in code)' },
  { name: 'stag', id: 'tQdzbZ1Cmw', title: 'Stag', use: 'Who Would Win: Stag' },
  { name: 'deer', id: 'T6Cs7tmMHJ', title: 'Deer', use: 'Who Would Win: Deer' },
  { name: 'donkey', id: 'qmX6nhnvp7', title: 'Donkey', use: 'Who Would Win: Donkey' },
  { name: 'alpaca', id: 'bCVFD48i2l', title: 'Alpaca', use: 'Who Would Win: Alpaca' },
  { name: 'wolf', id: 'P1gU3Qkr9r', title: 'Wolf', use: 'Who Would Win: Wolf' },
  { name: 'husky', id: 'wcWiuEqwzq', title: 'Husky', use: 'Who Would Win: Husky' },
  { name: 'fox', id: 'Bc97C66HKi', title: 'Fox', use: 'Who Would Win: Fox' },
  { name: 'hooded-adventurer', id: 'y9KWOVG21R', title: 'Hooded Adventurer', use: 'Who Would Win: Swordsman' },
  { name: 'king', id: 'I1gTjmuK2m', title: 'King', use: 'Who Would Win: King' },
  { name: 'adventurer', id: '5EGWBMpuXq', title: 'Adventurer', use: 'Who Would Win: Brawler' },
  { name: 'dragon', id: 'VBvzjFIYws', title: 'Dragon', use: 'Who Would Win: Dragon' },
  { name: 'spider', id: 'yRYJiAJyiM', title: 'Spider', use: 'Who Would Win: Giant Spider' },
  { name: 'gold-sword', id: '5fJinXD1mc', title: 'Gold Sword', use: "Who Would Win: the King's sword" },
];

async function download(s: Source): Promise<string> {
  const file = join(SRC, `${s.id}.glb`);
  if (existsSync(file)) return file;
  const html = await (await fetch(`https://poly.pizza/m/${s.id}`)).text();
  const licence = html.match(/"[Ll]icence":"([^"]+)"/)?.[1];
  if (licence !== 'CC0 1.0') throw new Error(`${s.name}: licence is ${licence ?? 'unknown'}, not CC0 1.0`);
  const url = html.match(/https:\/\/static\.poly\.pizza\/[0-9a-f-]+\.glb/)?.[0];
  if (!url) throw new Error(`${s.name}: no GLB link on https://poly.pizza/m/${s.id}`);
  writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  return file;
}

async function main() {
  mkdirSync(SRC, { recursive: true });
  mkdirSync(join(ROOT, 'assets/ambient', OUT_DIR), { recursive: true });
  const io = new NodeIO();
  const entries = [];
  for (const s of SOURCES) {
    const doc = await io.read(await download(s));
    const seen = new Set<string>();
    for (const anim of doc.getRoot().listAnimations()) {
      const short = anim.getName().split('|').pop()!;
      if (seen.has(short)) anim.dispose();
      else {
        seen.add(short);
        anim.setName(short);
      }
    }
    await doc.transform(resample(), prune(), dedup());
    const rel = `${OUT_DIR}/${s.name}.glb`;
    await io.write(join(ROOT, 'assets/ambient', rel), doc);
    const clips = doc
      .getRoot()
      .listAnimations()
      .map((a) => `${a.getName()} ${Math.max(0, ...a.listSamplers().map((sm) => sm.getInput()?.getMax([])[0] ?? 0)).toFixed(3)}`);
    console.log(`${rel}\n  ${clips.join('\n  ') || '(no animations)'}`);
    entries.push({
      id: `creature-${s.name}`,
      kind: 'creature',
      use: s.use,
      files: [rel],
      derived: 'duplicate animation clips removed, clip names shortened, redundant keyframes and unused data removed',
      source: `https://poly.pizza/m/${s.id}`,
      site: 'Poly Pizza',
      title: s.title,
      authors: ['Quaternius'],
      license: 'CC0-1.0',
    });
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.assets = [...manifest.assets.filter((a: { kind: string }) => a.kind !== 'creature'), ...entries];
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

await main();
