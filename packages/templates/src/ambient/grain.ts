/**
 * Film grain for long-form scenes: dark gradients (night skies, space) band badly in 8-bit H.264 and
 * YouTube's re-encode; a faint, ever-changing grain dithers them. Drawn after the 3D render.
 */
import type { Ctx2D } from '@sim/engine';

const TILE = 256;
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

let tiles: (HTMLCanvasElement | OffscreenCanvas)[] | null = null;
const patterns = new WeakMap<object, CanvasPattern[]>();

function makeTiles() {
  return Array.from({ length: 4 }, (_, k) => {
    const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: TILE, height: TILE }) : new OffscreenCanvas(TILE, TILE);
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const img = g.createImageData(TILE, TILE);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.floor(hash(i * 0.013 + k * 91.7) * 255);
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  });
}

/** Overlay grain (a different tile and offset every frame). `amount` ≈ 0.04–0.08 is subtle. */
export function drawGrain(ctx: Ctx2D, frame: number, width: number, height: number, amount = 0.055) {
  tiles ??= makeTiles();
  let ps = patterns.get(ctx);
  if (!ps) {
    ps = tiles.map((t) => ctx.createPattern(t as CanvasImageSource, 'repeat')!);
    patterns.set(ctx, ps);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = amount;
  ctx.translate(-((frame * 37) % TILE), -((frame * 91) % TILE));
  ctx.fillStyle = ps[frame % 4];
  ctx.fillRect(0, 0, width + TILE, height + TILE);
  ctx.restore();
}
