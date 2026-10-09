import type { Ctx2D } from './types';
import type { Theme } from './themes';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Bloom, vignette and scanlines, applied on top of the rendered scene. */
export class PostFx {
  private near: AnyCanvas;
  private far: AnyCanvas;
  private scan: AnyCanvas | null = null;

  constructor(readonly width: number, readonly height: number) {
    this.near = makeCanvas(Math.round(width / 3), Math.round(height / 3));
    this.far = makeCanvas(Math.round(width / 8), Math.round(height / 8));
  }

  apply(ctx: Ctx2D, source: AnyCanvas, theme: Theme) {
    const { width: W, height: H } = this;
    if (theme.glow > 0) {
      for (const [layer, blur, alpha] of [
        [this.near, 4, 0.55],
        [this.far, 5, 0.75],
      ] as const) {
        const lctx = layer.getContext('2d') as Ctx2D;
        lctx.clearRect(0, 0, layer.width, layer.height);
        lctx.filter = `blur(${blur}px)`;
        lctx.drawImage(source, 0, 0, layer.width, layer.height);
        lctx.filter = 'none';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, theme.glow * alpha);
        ctx.drawImage(layer, 0, 0, W, H);
        ctx.restore();
      }
    }
    if (theme.scanlines) {
      if (!this.scan) {
        this.scan = makeCanvas(W, H);
        const s = this.scan.getContext('2d') as Ctx2D;
        s.fillStyle = 'rgba(0,0,0,0.22)';
        for (let y = 0; y < H; y += 4) s.fillRect(0, y, W, 2);
      }
      ctx.drawImage(this.scan, 0, 0);
    }
    if (theme.vignette) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${theme.vignette})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
}

export function fillBackground(ctx: Ctx2D, W: number, H: number, theme: Theme) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, theme.bg[0]);
  g.addColorStop(1, theme.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
