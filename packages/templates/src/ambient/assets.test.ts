import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../assets/ambient');

interface Asset {
  id: string;
  kind: string;
  files: string[];
  source: string;
  authors: string[];
  license: string;
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as { assets: Asset[] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(ROOT, p)];
  });
}

describe('ambient asset manifest', () => {
  const listed = manifest.assets.flatMap((a) => a.files);

  it('lists every file in assets/ambient exactly once', () => {
    const onDisk = walk(ROOT).filter((f) => f !== 'manifest.json' && !f.endsWith('.DS_Store'));
    expect([...onDisk].sort()).toEqual([...listed].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('has only files that exist', () => {
    for (const f of listed) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it('is all CC0, each with its source and authors', () => {
    for (const a of manifest.assets) {
      expect(a.license, a.id).toBe('CC0-1.0');
      expect(a.source, a.id).toMatch(/^https:\/\/(polyhaven\.com|freesound\.org)\//);
      expect(a.authors.length, a.id).toBeGreaterThan(0);
    }
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('ambient beds loop seamlessly', () => {
  const beds = manifest.assets.filter((a) => a.kind === 'sound' && !a.id.startsWith('thunder'));

  it.each(beds.map((b) => [b.id, b.files[0]] as const))('%s joins end to start like any other step', (_id, file) => {
    // Every bed repeats many times in a long video (a 2-minute one wraps 30 times an hour), so its
    // last sample must flow into its first: compare that step with every step near the ends.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', join(ROOT, file), '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 1 << 30 });
    const b = r.stdout;
    const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const n = x.length / 2;
    const W = 48000 * 10;
    const steps: number[] = [];
    for (const [a, z] of [[1, W], [n - W, n]]) for (let i = a; i < z; i++) steps.push(Math.max(Math.abs(x[i * 2] - x[(i - 1) * 2]), Math.abs(x[i * 2 + 1] - x[(i - 1) * 2 + 1])));
    const seam = Math.max(Math.abs(x[0] - x[(n - 1) * 2]), Math.abs(x[1] - x[(n - 1) * 2 + 1]));
    const below = steps.filter((s) => s < seam).length / steps.length;
    expect(below).toBeLessThan(0.995);
  });
});
