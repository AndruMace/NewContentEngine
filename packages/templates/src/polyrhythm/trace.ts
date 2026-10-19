import type { Ctx2D } from '@sim/engine';

type Canvas = OffscreenCanvas | HTMLCanvasElement;

const layers = new WeakMap<object, { canvas: Canvas; lastFrame: number; lastT: number }>();

/**
 * A 1080×1920 layer that accumulates a trace over the loop (rendering only). Each frame
 * `paint(lc, t0, t1)` adds the part drawn between the previous frame and this one; when the
 * playhead jumps back (a new run, a seek) the layer is cleared and repainted from 0, so a seek
 * forward or back always shows the whole trace so far.
 */
export function traceLayer(owner: object, frame: number, t: number, paint: (lc: Ctx2D, t0: number, t1: number) => void): Canvas {
  let layer = layers.get(owner);
  if (!layer || frame < layer.lastFrame) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1080, 1920) : Object.assign(document.createElement('canvas'), { width: 1080, height: 1920 });
    layer = { canvas, lastFrame: -1, lastT: 0 };
    layers.set(owner, layer);
  }
  if (frame !== layer.lastFrame) {
    if (t > layer.lastT) paint(layer.canvas.getContext('2d') as Ctx2D, layer.lastT, t);
    layer.lastFrame = frame;
    layer.lastT = t;
  }
  return layer.canvas;
}
