/**
 * Procedural planet surfaces for the orrery (rendering only): equirectangular textures painted from
 * 3D noise sampled on the sphere, so they wrap without a seam. Each planet type has its own look,
 * tinted by the planet's palette colour so every video's system matches its theme.
 */
import { lighten, mixRgb, type RGB } from '@sim/engine';
import { THREE, canvasTexture } from '../three-layer';

export const PLANET_TYPES = ['gas', 'ice', 'earth', 'rocky', 'lava', 'desert'] as const;
export type PlanetType = (typeof PLANET_TYPES)[number];

const W = 256;
const H = 128;

/** A repeatable 0..1 from a number (visual only). */
export const hash01 = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

function hash3(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in 0..1. */
function noise(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const fx = s(x - xi);
  const fy = s(y - yi);
  const fz = s(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}

/** Fractal noise in about 0..1. */
function fbm(x: number, y: number, z: number, seed: number, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, y, z, seed + o * 31);
    norm += amp;
    x = x * 2.03 + 1.7;
    y = y * 2.03 - 3.1;
    z = z * 2.03 + 5.3;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Sharp ridges where the noise crosses its middle: cracks, lava channels, canyons. */
const ridge = (n: number, width: number) => Math.max(0, 1 - Math.abs(n - 0.5) / width);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Paint a W×H equirect image: `px(dir)` gives the colour (0..255) and alpha (0..1) at a direction. */
function paint(px: (x: number, y: number, z: number, lat: number) => [number, number, number, number]): THREE.Texture {
  return canvasTexture(W, H, (ctx) => {
    const img = ctx.createImageData(W, H);
    for (let j = 0; j < H; j++) {
      const lat = Math.PI / 2 - ((j + 0.5) / H) * Math.PI;
      const cl = Math.cos(lat);
      const y = Math.sin(lat);
      for (let i = 0; i < W; i++) {
        // three.js spheres wrap u from -z round through +x.
        const lon = ((i + 0.5) / W) * Math.PI * 2;
        const [r, g, b, a] = px(-Math.cos(lon) * cl, y, Math.sin(lon) * cl, lat);
        const k = 4 * (j * W + i);
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = Math.round(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Crater field: centres scattered over the sphere; returns depth (−) / rim (+) at a direction. */
function craters(seed: number, count: number, maxR: number) {
  const cs = Array.from({ length: count }, (_, k) => {
    const u = hash01(seed + k * 1.31) * 2 - 1;
    const a = hash01(seed + k * 2.77) * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    return { x: r * Math.cos(a), y: u, z: r * Math.sin(a), size: maxR * (0.25 + 0.75 * hash01(seed + k * 3.9) ** 2) };
  });
  return (x: number, y: number, z: number) => {
    let h = 0;
    for (const c of cs) {
      const d = Math.hypot(x - c.x, y - c.y, z - c.z) / c.size;
      if (d < 1.25) h += d < 1 ? -0.5 * (1 - d * d) : 0.35 * (1 - (d - 1) / 0.25);
    }
    return h;
  };
}

export interface PlanetSurface {
  map: THREE.Texture;
  /** Bumps (rocky worlds). */
  bump?: THREE.Texture;
  /** Glowing parts (lava). */
  emissive?: THREE.Texture;
  /** Cloud layer with alpha (earth-like). */
  clouds?: THREE.Texture;
  /** Atmosphere glow colour, if it has one. */
  atmosphere?: RGB;
  roughness: number;
}

export function planetSurface(type: PlanetType, col: RGB, col2: RGB, seed: number): PlanetSurface {
  const sd = Math.floor(seed * 1000);
  switch (type) {
    case 'gas': {
      // Banded giant: wavy belts in two colours, fine streaks, one big storm.
      const bands = 7 + Math.floor(hash01(seed) * 8);
      const sLat = (hash01(seed + 1) - 0.5) * 1.2;
      const sLon = hash01(seed + 2) * Math.PI * 2;
      const storm = { x: -Math.cos(sLon) * Math.cos(sLat), y: Math.sin(sLat), z: Math.sin(sLon) * Math.cos(sLat) };
      const light = lighten(col, 0.35);
      const dark = shade(col, 0.55);
      const accent = mixRgb(col2, col, 0.4);
      return {
        map: paint((x, y, z) => {
          const turb = fbm(x * 3, y * 3, z * 3, sd) - 0.5;
          const v = y + turb * 0.22 + 0.05 * Math.sin(x * 9 + z * 7);
          const b = 0.5 + 0.5 * Math.sin(v * bands * Math.PI + seed * 10);
          const streak = fbm(x * 14, y * 2.5, z * 14, sd + 7);
          let c = mixRgb(dark, light, b);
          c = mixRgb(c, accent, smooth(0.62, 0.8, fbm(x * 2, y * 6, z * 2, sd + 3)) * 0.7);
          c = shade(c, 0.85 + 0.3 * streak);
          const d = Math.hypot((x - storm.x) * 0.8, (y - storm.y) * 1.6, (z - storm.z) * 0.8);
          const st = smooth(0.24, 0.1, d);
          c = mixRgb(c, mixRgb(lighten(accent, 0.25), shade(accent, 0.7), 0.5 + 0.5 * Math.sin(d * 60)), st);
          return [c[0], c[1], c[2], 1];
        }),
        atmosphere: lighten(col, 0.3),
        roughness: 0.9,
      };
    }
    case 'ice': {
      // Pale, frosted world crossed by long dark cracks.
      const base = mixRgb([235, 245, 255], col, 0.22);
      return {
        map: paint((x, y, z) => {
          const n = fbm(x * 3, y * 3, z * 3, sd);
          const cr = Math.max(ridge(fbm(x * 4, y * 4, z * 4, sd + 5), 0.025), 0.7 * ridge(fbm(x * 9, y * 9, z * 9, sd + 9), 0.02));
          let c = shade(base, 0.82 + 0.25 * n);
          c = mixRgb(c, shade(mixRgb(col, [40, 70, 120], 0.5), 0.6), cr * 0.8);
          return [c[0], c[1], c[2], 1];
        }),
        atmosphere: mixRgb([200, 230, 255], col, 0.3),
        roughness: 0.45,
      };
    }
    case 'earth': {
      // Oceans, continents with forest, desert and snow, ice caps, and a cloud layer.
      const ocean = mixRgb([20, 60, 130], col, 0.3);
      const shallow = mixRgb([40, 130, 170], col, 0.3);
      const sea = 0.5 + 0.06 * (hash01(seed + 4) - 0.5);
      const height = (x: number, y: number, z: number) => fbm(x * 2.2, y * 2.2, z * 2.2, sd, 6);
      return {
        map: paint((x, y, z, lat) => {
          const h = height(x, y, z);
          const polar = Math.abs(lat) / (Math.PI / 2) + 0.15 * (fbm(x * 5, y * 5, z * 5, sd + 2) - 0.5);
          let c: RGB;
          if (h < sea) c = mixRgb(ocean, shallow, smooth(sea - 0.12, sea, h));
          else {
            const dry = fbm(x * 4, y * 4, z * 4, sd + 6);
            const land = mixRgb(mixRgb([60, 120, 50], col, 0.15), [170, 140, 90], smooth(0.45, 0.65, dry));
            c = mixRgb(land, [235, 235, 240], smooth(sea + 0.2, sea + 0.3, h));
          }
          c = mixRgb(c, [240, 245, 255], smooth(0.78, 0.86, polar));
          return [c[0], c[1], c[2], 1];
        }),
        clouds: paint((x, y, z) => {
          const n = fbm(x * 3 + fbm(x * 2, y * 2, z * 2, sd + 11) * 1.5, y * 4, z * 3, sd + 12);
          return [255, 255, 255, smooth(0.5, 0.72, n) * 0.9];
        }),
        atmosphere: mixRgb([110, 170, 255], col, 0.25),
        roughness: 0.7,
      };
    }
    case 'rocky': {
      // Grey-tinted, cratered, bumpy.
      const crater = craters(seed, 60, 0.32);
      const base = mixRgb([150, 145, 140], col, 0.25);
      const h = (x: number, y: number, z: number) => fbm(x * 4, y * 4, z * 4, sd) + 0.35 * crater(x, y, z);
      return {
        map: paint((x, y, z) => {
          const v = h(x, y, z);
          const c = shade(base, 0.45 + 0.8 * clamp01(v));
          return [c[0], c[1], c[2], 1];
        }),
        bump: paint((x, y, z) => {
          const v = 255 * clamp01(h(x, y, z));
          return [v, v, v, 1];
        }),
        roughness: 0.95,
      };
    }
    case 'lava': {
      // Black crust split by glowing channels.
      const crust = mixRgb([35, 25, 22], col, 0.12);
      const glow = mixRgb([255, 140, 40], col, 0.25);
      const channel = (x: number, y: number, z: number) => Math.max(ridge(fbm(x * 3, y * 3, z * 3, sd), 0.045), 0.6 * ridge(fbm(x * 7, y * 7, z * 7, sd + 4), 0.03));
      return {
        map: paint((x, y, z) => {
          const n = fbm(x * 6, y * 6, z * 6, sd + 2);
          const c = mixRgb(shade(crust, 0.7 + 0.6 * n), glow, channel(x, y, z));
          return [c[0], c[1], c[2], 1];
        }),
        emissive: paint((x, y, z) => {
          const g = channel(x, y, z);
          const c = shade(lighten(glow, 0.2), g);
          return [c[0], c[1], c[2], 1];
        }),
        atmosphere: mixRgb([255, 120, 60], col, 0.3),
        roughness: 0.85,
      };
    }
    case 'desert': {
      // Warm dunes and canyons, a few craters, small polar caps.
      const sand = mixRgb([215, 150, 90], col, 0.3);
      const crater = craters(seed + 3, 18, 0.22);
      return {
        map: paint((x, y, z, lat) => {
          const n = fbm(x * 3, y * 3, z * 3, sd);
          const dunes = 0.5 + 0.5 * Math.sin((x * 30 + n * 6) * 1.3);
          const canyon = ridge(fbm(x * 2.5, y * 2.5, z * 2.5, sd + 8), 0.03);
          let c = shade(sand, 0.7 + 0.35 * n + 0.08 * dunes + 0.3 * crater(x, y, z));
          c = mixRgb(c, shade(sand, 0.45), canyon);
          c = mixRgb(c, [245, 240, 235], smooth(0.86, 0.92, Math.abs(lat) / (Math.PI / 2)));
          return [c[0], c[1], c[2], 1];
        }),
        atmosphere: mixRgb([255, 200, 150], col, 0.3),
        roughness: 0.9,
      };
    }
  }
}

/** Ring texture: concentric bands with gaps, alpha in the image (for a RingGeometry's planar UVs). */
export function ringTexture(col: RGB, seed: number): THREE.Texture {
  return canvasTexture(256, 256, (ctx) => {
    for (let r = 128; r > 0; r--) {
      const f = r / 128; // 0 centre .. 1 edge
      if (f < 0.56) break;
      const band = hash01(seed + Math.floor(f * 40) * 0.37);
      const gap = band < 0.18 ? 0.1 : 1;
      const c = mixRgb(lighten(col, 0.3), shade(col, 0.7), hash01(seed + Math.floor(f * 70) * 0.91));
      ctx.strokeStyle = `rgba(${c.map((v) => Math.round(Math.min(255, v))).join(',')},${(0.35 + 0.55 * band) * gap * smooth(0.56, 0.62, f) * smooth(1, 0.94, f)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(128, 128, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

/** The sun's surface: bright granulation with darker lanes and a few spots. */
export function sunTexture(): THREE.Texture {
  return paint((x, y, z) => {
    const n = fbm(x * 8, y * 8, z * 8, 77);
    const big = fbm(x * 2.5, y * 2.5, z * 2.5, 91);
    const c = mixRgb([255, 150, 40], [255, 245, 200], clamp01(0.25 + 0.9 * n + 0.3 * (big - 0.5)));
    return [c[0], c[1], c[2], 1];
  });
}

/** A soft nebula cloud for the backdrop, tinted by a palette colour (alpha in the image). */
export function nebulaTexture(col: RGB, seed: number): THREE.Texture {
  return canvasTexture(256, 256, (ctx) => {
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const x = i / 256 - 0.5;
        const y = j / 256 - 0.5;
        const fall = smooth(0.5, 0.15, Math.hypot(x, y));
        const n = fbm(x * 4, y * 4, seed, Math.floor(seed * 100), 6);
        const a = fall * smooth(0.42, 0.75, n);
        const c = mixRgb(col, lighten(col, 0.4), n);
        const k = 4 * (j * 256 + i);
        img.data[k] = c[0];
        img.data[k + 1] = c[1];
        img.data[k + 2] = c[2];
        img.data[k + 3] = Math.round(255 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}
