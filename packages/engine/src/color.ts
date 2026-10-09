export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToCss([r, g, b]: RGB, a = 1): string {
  return a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a.toFixed(3)})`;
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Sample a palette as a continuous gradient, u in [0,1]. */
export function paletteAt(palette: string[], u: number): RGB {
  if (palette.length === 1) return hexToRgb(palette[0]);
  const x = Math.max(0, Math.min(1, u)) * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(x));
  return mixRgb(hexToRgb(palette[i]), hexToRgb(palette[i + 1]), x - i);
}

export function lighten(c: RGB, amt: number): RGB {
  return mixRgb(c, [255, 255, 255], amt);
}
