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
