/**
 * Builds packages/templates/src/fourier-drawing/shapes.json: closed outlines for the Fourier
 * Drawing template. Run once (or after editing the lists):
 *
 *   npx tsx scripts/build-fourier-shapes.ts [silhouette-svg-dir]
 *
 * - Countries: Natural Earth 1:50m (public domain) via world-atlas, largest polygon in Mercator.
 * - US states: US Census (public domain) via us-atlas, already in an Albers projection.
 * - Silhouettes (dinosaurs, animals, fantasy creatures): public-domain / CC0 SVGs listed with
 *   their sources and credits in scripts/fourier-silhouettes.json. They are rasterised in Chrome,
 *   holes filled and hairline gaps closed, and the outer edge traced. Without the SVG directory
 *   the silhouettes already in shapes.json are kept as they are.
 *
 * Every outline is simplified, then resampled evenly by arc length.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const POINTS = 400;
const OUT = new URL('../packages/templates/src/fourier-drawing/shapes.json', import.meta.url);

type Pt = [number, number];

const COUNTRIES: [atlasName: string, name: string, icon: string][] = [
  ['Italy', 'Italy', '🇮🇹'],
  ['United States of America', 'the USA', '🇺🇸'],
  ['Brazil', 'Brazil', '🇧🇷'],
  ['Australia', 'Australia', '🇦🇺'],
  ['India', 'India', '🇮🇳'],
  ['France', 'France', '🇫🇷'],
  ['Spain', 'Spain', '🇪🇸'],
  ['Germany', 'Germany', '🇩🇪'],
  ['Mexico', 'Mexico', '🇲🇽'],
  ['Chile', 'Chile', '🇨🇱'],
  ['Argentina', 'Argentina', '🇦🇷'],
  ['United Kingdom', 'Great Britain', '🇬🇧'],
  ['Ireland', 'Ireland', '🇮🇪'],
  ['Iceland', 'Iceland', '🇮🇸'],
  ['Norway', 'Norway', '🇳🇴'],
  ['Sweden', 'Sweden', '🇸🇪'],
  ['Finland', 'Finland', '🇫🇮'],
  ['Turkey', 'Turkey', '🇹🇷'],
  ['South Africa', 'South Africa', '🇿🇦'],
  ['Madagascar', 'Madagascar', '🇲🇬'],
  ['China', 'China', '🇨🇳'],
  ['Thailand', 'Thailand', '🇹🇭'],
  ['Vietnam', 'Vietnam', '🇻🇳'],
  ['South Korea', 'South Korea', '🇰🇷'],
  ['Ukraine', 'Ukraine', '🇺🇦'],
  ['Poland', 'Poland', '🇵🇱'],
  ['Peru', 'Peru', '🇵🇪'],
  ['Cuba', 'Cuba', '🇨🇺'],
  ['Sri Lanka', 'Sri Lanka', '🇱🇰'],
  ['Portugal', 'Portugal', '🇵🇹'],
  ['Greenland', 'Greenland', '🇬🇱'],
  ['Egypt', 'Egypt', '🇪🇬'],
  ['Colombia', 'Colombia', '🇨🇴'],
];

/** Detailed, recognisable states (boxy ones like Colorado would just repeat themselves). */
const STATES = [
  'Texas', 'Florida', 'California', 'Michigan', 'Louisiana', 'Maine', 'Oklahoma', 'Idaho', 'New York',
  'Alaska', 'Massachusetts', 'Kentucky', 'West Virginia', 'Minnesota', 'Virginia', 'New Jersey', 'Illinois', 'Washington', 'North Carolina',
];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Douglas–Peucker on an open polyline. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bi = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed ring: split at the point farthest from the first, simplify each half. */
function simplifyClosed(ring: Pt[], tol: number): Pt[] {
  const pts = dist(ring[0], ring[ring.length - 1]) < 1e-9 ? ring.slice(0, -1) : ring;
  let far = 0;
  pts.forEach((p, i) => dist(p, pts[0]) > dist(pts[far], pts[0]) && (far = i));
  return [...simplify(pts.slice(0, far + 1), tol).slice(0, -1), ...simplify([...pts.slice(far), pts[0]], tol).slice(0, -1)];
}

/** Evenly spaced points along a closed outline. */
function resample(ring: Pt[], n: number): Pt[] {
  const pts = dist(ring[0], ring[ring.length - 1]) < 1e-9 ? ring.slice(0, -1) : ring.slice();
  const segs = pts.map((p, i) => dist(p, pts[(i + 1) % pts.length]));
  const total = segs.reduce((a, b) => a + b, 0);
  const out: Pt[] = [];
  let seg = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (acc + segs[seg] < target) acc += segs[seg++];
    const f = segs[seg] ? (target - acc) / segs[seg] : 0;
    const a = pts[seg];
    const b = pts[(seg + 1) % pts.length];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

const area = (r: Pt[]) => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2;

/** Centre on the bounding box and scale the longer side to 1; clockwise on screen. */
function normalise(pts: Pt[]): number[] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.max(x1 - x0, y1 - y0);
  let out = pts.map(([x, y]) => [(x - (x0 + x1) / 2) / s, (y - (y0 + y1) / 2) / s] as Pt);
  if (area(out) < 0) out = out.reverse();
  // Start at the topmost point, so every drawing begins in the same place.
  let top = 0;
  out.forEach((p, i) => p[1] < out[top][1] && (top = i));
  out = [...out.slice(top), ...out.slice(0, top)];
  return out.flatMap(([x, y]) => [Math.round(x * 1000), Math.round(y * 1000)]);
}

type Category = 'country' | 'state' | 'dinosaur' | 'animal' | 'fantasy';
const shapes: { id: string; name: string; category: Category; icon: string; points: number[] }[] = [];

/** Largest outer ring of a (multi)polygon, simplified and resampled. */
function fromGeometry(geom: { type: string; coordinates: number[][][] | number[][][][] }, project: (p: number[]) => Pt): number[] {
  const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates) as number[][][][];
  const rings = polys.map((poly) => poly[0].map(project));
  const ring = rings.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a));
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return normalise(resample(simplifyClosed(ring, size * 0.003), POINTS));
}

type Geo = { features: { properties: { name: string }; geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] };
const world = require('world-atlas/countries-50m.json');
const countries = feature(world, world.objects.countries) as unknown as Geo;
const merc = ([lon, lat]: number[]): Pt => [lon, -(Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360)) * 180) / Math.PI];
for (const [atlas, name, icon] of COUNTRIES) {
  const f = countries.features.find((g) => g.properties.name === atlas);
  if (!f) throw new Error(`missing ${atlas}`);
  shapes.push({ id: atlas.toLowerCase().replace(/[^a-z]+/g, '-'), name, category: 'country', icon, points: fromGeometry(f.geometry, merc) });
}

const us = require('us-atlas/states-albers-10m.json');
const states = feature(us, us.objects.states) as unknown as Geo;
for (const name of STATES) {
  const f = states.features.find((g) => g.properties.name === name);
  if (!f) throw new Error(`missing ${name}`);
  shapes.push({ id: `us-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, name, category: 'state', icon: '🇺🇸', points: fromGeometry(f.geometry, ([x, y]) => [x, y]) });
}

// --- Silhouettes -------------------------------------------------------------------------------

const RASTER = 1100;

/** Rasterise SVGs in headless Chrome; 1 = ink (opaque and not near-white). */
async function rasterise(files: string[]): Promise<Uint8Array[]> {
  const pw = require('playwright-core');
  const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const out: Uint8Array[] = [];
  for (const file of files) {
    const svg = readFileSync(file).toString('base64');
    const b64: string = await page.evaluate(
      async ({ svg, size }: { svg: string; size: number }) => {
        const img = new Image();
        img.src = `data:image/svg+xml;base64,${svg}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d')!;
        const w = img.naturalWidth || 1000;
        const h = img.naturalHeight || 1000;
        const k = (size * 0.9) / Math.max(w, h);
        ctx.drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
        const d = ctx.getImageData(0, 0, size, size).data;
        const m = new Uint8Array(size * size);
        for (let i = 0; i < m.length; i++) m[i] = d[4 * i + 3] > 110 && !(d[4 * i] > 235 && d[4 * i + 1] > 235 && d[4 * i + 2] > 235) ? 1 : 0;
        let s = '';
        for (let i = 0; i < m.length; i += 8192) s += String.fromCharCode(...m.subarray(i, i + 8192));
        return btoa(s);
      },
      { svg, size: RASTER },
    );
    out.push(Uint8Array.from(Buffer.from(b64, 'base64')));
  }
  await browser.close();
  return out;
}

/** Square-kernel dilate (grow) or erode (shrink) by r pixels. */
function morph(m: Uint8Array, n: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  const want = grow ? 1 : 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let v = 1 - want;
      for (let d = -r; d <= r && v !== want; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < n && m[y * n + xx] === want) v = want;
      }
      tmp[y * n + x] = v;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let v = 1 - want;
      for (let d = -r; d <= r && v !== want; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < n && tmp[yy * n + x] === want) v = want;
      }
      out[y * n + x] = v;
    }
  return out;
}

/** The largest blob with its holes filled, traced clockwise along its outer edge (Moore neighbours). */
function outline(mask: Uint8Array, n: number, close = 3): Pt[] {
  const m = morph(morph(mask, n, close, true), n, close, false); // close hairline gaps
  // Fill holes: anything the outside can't reach is inside.
  const outside = new Uint8Array(n * n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) stack.push(i, (n - 1) * n + i, i * n, i * n + n - 1);
  while (stack.length) {
    const c = stack.pop()!;
    if (outside[c] || m[c]) continue;
    outside[c] = 1;
    const x = c % n;
    const y = (c / n) | 0;
    if (x > 0) stack.push(c - 1);
    if (x < n - 1) stack.push(c + 1);
    if (y > 0) stack.push(c - n);
    if (y < n - 1) stack.push(c + n);
  }
  // Largest 8-connected solid component.
  const label = new Int32Array(n * n);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  for (let i = 0; i < n * n; i++) {
    if (outside[i] || label[i]) continue;
    let size = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % n;
      const y = (c / n) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          const d = yy * n + xx;
          if (!outside[d] && !label[d]) {
            label[d] = next;
            stack.push(d);
          }
        }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
    next++;
  }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && label[y * n + x] === best;
  let start = -1;
  for (let i = 0; i < n * n && start < 0; i++) if (label[i] === best) start = i;
  // Moore-neighbour tracing, starting from the topmost-leftmost pixel.
  const dirs: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let cx = start % n;
  let cy = (start / n) | 0;
  let back = 4; // came from the left
  const pts: Pt[] = [[cx, cy]];
  for (let guard = 0; guard < n * n; guard++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (inside(nx, ny)) {
        cx = nx;
        cy = ny;
        back = (d + 4) % 8;
        found = true;
        break;
      }
    }
    if (!found || (cx === start % n && cy === ((start / n) | 0))) break;
    pts.push([cx, cy]);
  }
  return pts;
}

interface Silhouette { id: string; name: string; icon: string; category: Category; file: string; source: string; credit: string; license: string; /** Gap-closing radius in px (line art with gaps needs more). */ close?: number }
const manifest: { silhouettes: Silhouette[] } = JSON.parse(readFileSync(new URL('./fourier-silhouettes.json', import.meta.url), 'utf8'));
const svgDir = process.argv[2];
const previous: typeof shapes = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).shapes : [];
if (svgDir) {
  const masks = await rasterise(manifest.silhouettes.map((s) => join(svgDir, s.file)));
  manifest.silhouettes.forEach((s, i) => {
    const ring = outline(masks[i], RASTER, s.close);
    shapes.push({ id: s.id, name: s.name, category: s.category, icon: s.icon, points: normalise(resample(simplifyClosed(ring, 0.7), POINTS)) });
  });
} else {
  for (const s of manifest.silhouettes) {
    const old = previous.find((p) => p.id === s.id);
    if (!old) throw new Error(`no SVG directory given and ${s.id} is not in shapes.json yet`);
    shapes.push(old);
  }
}

writeFileSync(
  OUT,
  JSON.stringify({
    source:
      'Countries: Natural Earth 1:50m (public domain) via world-atlas. US states: US Census (public domain) via us-atlas. Silhouettes: public domain / CC0, credits in scripts/fourier-silhouettes.json.',
    points: POINTS,
    shapes,
  }) + '\n',
);
console.log(`${shapes.length} shapes → ${OUT.pathname}`);
