/**
 * The numbers on screen (drawn crisp over the 3D picture): live altitude, speed, heat and g-force,
 * the clock and how fast it runs, an altitude ladder through the atmosphere's layers with landmarks,
 * toasts as things happen (Mach 1, melting, breakup), and the impact card. In Versus, a header and
 * live readout per column, landing order, and an energy comparison at the end.
 */
import { FONT_FAMILY, type Ctx2D, type RenderCtx } from '@sim/engine';
import { drawStoryCaption, markAt, timeOf } from '../story';
import { LAYER_NAMES } from './atmosphere';
import { comparison, energyLabel, round2, seismicMagnitude, timesLabel, tntLabel } from './impact';
import { massLabel } from './objects';
import { sampleAt, type Sample } from './physics';
import { endTime, type Run } from './script';
import { altReadout, lengthText, speedReadout, speedText, tempReadout, type Units } from './units';
import { blackbody, impactClock } from './view3d';
import type { SpaceDropState } from './index';

const CAPTION_Y = 1390;
const MONO = '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/** Render-side memory per run state: when (video time) each event first showed, and the clock rate. */
interface Memo {
  seen: Map<string, number>;
  lastT: number;
  lastSim: number;
  rate: number;
}
const memos = new WeakMap<object, Memo>();
function memo(s: SpaceDropState): Memo {
  let m = memos.get(s);
  if (!m) {
    m = { seen: new Map(), lastT: -1, lastSim: 0, rate: 1 };
    memos.set(s, m);
  }
  return m;
}

/** Video time an event first appeared (null if not yet), noting it now if it just happened. */
function seenAt(m: Memo, key: string, happened: boolean, t: number): number | null {
  if (!happened) {
    m.seen.delete(key);
    return null;
  }
  let at = m.seen.get(key);
  if (at === undefined || at > t) {
    at = t;
    m.seen.set(key, at);
  }
  return at;
}

function panel(ctx: Ctx2D, x: number, y: number, w: number, h: number, r = 26, alpha = 0.42) {
  ctx.save();
  ctx.fillStyle = `rgba(6,10,18,${alpha})`;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function text(ctx: Ctx2D, s: string, x: number, y: number, o: { size: number; weight?: number; color?: string; align?: CanvasTextAlign; font?: string; stroke?: number; alpha?: number }) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.font = `${o.weight ?? 800} ${o.size}px ${o.font ?? FONT_FAMILY}`;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = 'middle';
  if (o.stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = o.stroke;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = o.color ?? '#ffffff';
  ctx.fillText(s, x, y);
  ctx.restore();
}

/** A readout's colour for a temperature: white when cool, glowing toward its blackbody colour. */
function heatColour(K: number): string {
  if (K < 700) return '#ffffff';
  const c = blackbody(K);
  const u = clamp01((K - 700) / 900);
  const mix = (a: number, b: number) => Math.round((a + (b - a) * u) * 255);
  return `rgb(${mix(1, c.r)},${mix(1, c.g)},${mix(1, c.b)})`;
}

/** "T+ 12:34". */
function clock(s: number): string {
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return h ? `T+ ${h}:${(m % 60).toString().padStart(2, '0')}:${ss}` : `T+ ${m}:${ss}`;
}

function warpLabel(rate: number, slowmo: boolean): string {
  if (slowmo) return '◀ SLOW MOTION';
  if (rate < 0.02) return '❚❚ PAUSED';
  if (rate < 0.85) return `SLOW MOTION ${rate.toFixed(2)}×`;
  if (rate < 1.4) return '● REAL TIME';
  return `▶▶ ${rate < 10 ? rate.toFixed(1) : Math.round(rate).toLocaleString('en-US')}× SPEED`;
}

function drawStats(ctx: Ctx2D, smp: Sample, run: Run, u: Units, x: number, y: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const w = 440;
  const rows = 4;
  const rowH = 118;
  panel(ctx, x, y, w, rows * rowH + 24);
  const [alt, altU] = altReadout(smp.h, u);
  const [spd, spdU] = speedReadout(smp.v, u);
  const [ts, tsU] = tempReadout(smp.Ts, u);
  const [ta, taU] = tempReadout(smp.Tshock, u);
  const mach = smp.mach;
  const rowsData: { label: string; value: string; unit: string; sub?: string; color?: string }[] = [
    { label: 'ALTITUDE', value: alt, unit: altU },
    { label: 'SPEED', value: spd, unit: spdU, sub: `${speedText(smp.v, u)}${mach > 0.3 ? ` · MACH ${mach < 10 ? mach.toFixed(1) : Math.round(mach)}` : ''}` },
    { label: 'SURFACE TEMP', value: ts, unit: tsU, sub: smp.v > 300 && smp.rho > 1e-7 ? `AIR IN FRONT ${ta} ${taU}` : undefined, color: heatColour(smp.Ts) },
    { label: 'G-FORCE', value: smp.phase === 2 ? '—' : smp.g < 10 ? smp.g.toFixed(1) : Math.round(smp.g).toLocaleString('en-US'), unit: 'g', sub: smp.phase === 2 ? 'CRUSHED, SPREADING' : run.tr.breakup && smp.phase === 1 ? `ONLY THE ${run.tr.breakup.core?.name.toUpperCase()} LEFT` : undefined },
  ];
  rowsData.forEach((r, k) => {
    const cy = y + 22 + k * rowH;
    text(ctx, r.label, x + 28, cy + 18, { size: 24, weight: 700, color: 'rgba(200,215,235,0.8)' });
    text(ctx, r.unit, x + w - 26, cy + 62, { size: 30, weight: 700, color: 'rgba(220,230,245,0.85)', align: 'right' });
    ctx.save();
    ctx.font = `700 30px ${FONT_FAMILY}`;
    const uw = ctx.measureText(r.unit).width;
    ctx.restore();
    text(ctx, r.value, x + w - 40 - uw, cy + 60, { size: 62, weight: 800, font: MONO, color: r.color ?? '#ffffff', align: 'right' });
    if (r.sub) text(ctx, r.sub, x + 28, cy + 102, { size: 22, weight: 700, color: 'rgba(255,214,150,0.9)' });
  });
  ctx.restore();
}

const LANDMARKS: { km: number; name: string }[] = [
  { km: 408, name: 'Space station' },
  { km: 100, name: 'Edge of space' },
  { km: 80, name: 'Meteors glow' },
  { km: 39, name: 'Highest skydive' },
  { km: 11, name: 'Airliners' },
  { km: 8.85, name: 'Everest' },
];

/** The altitude ladder: log scale from the release height down to 10 m. */
function drawLadder(ctx: Ctx2D, h: number, topKm: number, x: number, y0: number, y1: number, alpha: number) {
  if (alpha <= 0) return;
  const lo = Math.log10(0.01);
  const hi = Math.log10(Math.max(120, topKm * 1.05));
  const Y = (km: number) => y1 - ((Math.log10(Math.max(0.01, km)) - lo) / (hi - lo)) * (y1 - y0);
  ctx.save();
  ctx.globalAlpha = alpha;
  panel(ctx, x - 26, y0 - 26, 52, y1 - y0 + 52, 26, 0.32);
  // Layers as bands of colour (deep blue low down, black in space).
  const cols = ['#5f9be0', '#3b6fb4', '#23427a', '#121f3d', '#070b16'];
  let prev = 0.01;
  LAYER_NAMES.forEach((L, k) => {
    const top = Math.min(L.top, 10 ** hi);
    if (prev >= 10 ** hi) return;
    ctx.fillStyle = cols[k];
    ctx.fillRect(x - 10, Y(top), 20, Y(prev) - Y(top));
    prev = top;
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 10, y0, 20, y1 - y0);
  let lastY = -Infinity;
  for (const m of LANDMARKS) {
    if (m.km > 10 ** hi) continue;
    const yy = Y(m.km);
    // Skip a label that would overlap the one above it.
    if (yy - lastY < 30) continue;
    lastY = yy;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(x - 18, yy - 1, 36, 2);
    text(ctx, `${m.name} ${m.km >= 20 ? Math.round(m.km) : m.km} km`, x - 36, yy, { size: 20, weight: 700, color: 'rgba(230,238,250,0.8)', align: 'right', stroke: 5 });
  }
  // The object.
  const yy = Y(Math.max(0.01, h / 1000));
  ctx.fillStyle = '#ffcf5a';
  ctx.shadowColor = '#ffb020';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(x + 14, yy);
  ctx.lineTo(x + 38, yy - 13);
  ctx.lineTo(x + 38, yy + 13);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, yy, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Toasts for what's happening now: Mach 1, melting, breakup, burst, burned up. */
function toasts(ctx: Ctx2D, m: Memo, run: Run, simT: number, t: number, units: Units, y: number, k = 0) {
  const out: { at: number; text: string; color: string }[] = [];
  for (const e of run.tr.events) {
    let label: string | null = null;
    let color = '#ffd27a';
    if (e.kind === 'entry') label = 'EDGE OF SPACE · 100 KM';
    else if (e.kind === 'melt') {
      label = 'SURFACE MELTING';
      color = '#ff9a4a';
    } else if (e.kind === 'breakup') {
      label = run.tr.breakup?.core ? `BREAKUP · ${altReadout(e.alt, units).join(' ')}` : `CRUSHED · ${altReadout(e.alt, units).join(' ')}`;
      color = '#ff6a4a';
    } else if (e.kind === 'airburst') {
      label = `AIRBURST · ${altReadout(e.alt, units).join(' ')}`;
      color = '#ff5a3a';
    } else if (e.kind === 'subsonic') label = 'SLOWER THAN SOUND · SONIC BOOM';
    else if (e.kind === 'peakHeat' && run.tr.maxTs > 900 && e.alt > 8000) {
      label = 'PEAK HEATING';
      color = '#ffb35a';
    } else if (e.kind === 'burnup') {
      label = 'BURNED UP';
      color = '#ff6a4a';
    }
    if (!label) continue;
    const at = seenAt(m, `${k}:${e.kind}`, simT >= e.t, t);
    if (at !== null && t - at < 2.6) out.push({ at, text: label, color });
  }
  out.sort((a, b) => a.at - b.at);
  out.slice(-2).forEach((o, i, arr) => {
    const age = t - o.at;
    const a = clamp01(age / 0.15) * clamp01((2.6 - age) / 0.4);
    const yy = y + (i - (arr.length - 1)) * 70 - (1 - ease(age / 0.25)) * 20;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `900 34px ${FONT_FAMILY}`;
    const w = ctx.measureText(o.text).width + 56;
    panel(ctx, 540 - w / 2, yy - 30, w, 60, 30, 0.55);
    text(ctx, o.text, 540, yy + 1, { size: 34, weight: 900, color: o.color, align: 'center' });
    ctx.restore();
  });
}

function drawImpactCard(ctx: Ctx2D, run: Run, u: Units, tau: number, y: number) {
  const im = run.tr.impact;
  if (!im || tau < 0.35) return;
  const a = clamp01((tau - 0.35) / 0.35);
  const E = run.energy;
  const shown = E * ease((tau - 0.35) / 1.3);
  const cmp = comparison(E);
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, 90, y, 900, 400, 34, 0.5);
  text(ctx, 'IMPACT', 540, y + 50, { size: 30, weight: 800, color: 'rgba(255,190,120,0.95)', align: 'center' });
  text(ctx, speedText(im.v, u).toUpperCase(), 540, y + 96, { size: 34, weight: 800, color: '#ffffff', align: 'center' });
  text(ctx, energyLabel(shown), 540, y + 180, { size: 96, weight: 900, font: MONO, color: '#ffd166', align: 'center' });
  text(ctx, tntLabel(E).toUpperCase(), 540, y + 256, { size: 38, weight: 900, color: '#ffffff', align: 'center' });
  text(ctx, `${timesLabel(cmp.times)} ${cmp.ref.name}`, 540, y + 304, { size: 28, weight: 700, color: 'rgba(225,232,245,0.9)', align: 'center' });
  const cr = run.crater;
  const mag = seismicMagnitude(E);
  const bits = [cr ? `${cr.diameter >= 1.5 ? 'CRATER' : 'DENT'} ${lengthText(cr.diameter, u).toUpperCase()} WIDE` : '', mag >= 1 ? `QUAKE M${mag.toFixed(1)}` : ''].filter(Boolean);
  if (bits.length && tau > 1.4) text(ctx, bits.join('  ·  '), 540, y + 352, { size: 30, weight: 800, color: '#9fe3ff', align: 'center', alpha: clamp01((tau - 1.4) / 0.4) });
  ctx.restore();
}

function drawBurstCard(ctx: Ctx2D, run: Run, u: Units, tau: number, y: number) {
  const ab = run.tr.airburst;
  if (!ab || tau < 0.2 || tau > 6) return;
  const a = clamp01((tau - 0.2) / 0.3) * clamp01((6 - tau) / 0.6);
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, 140, y, 800, 230, 30, 0.5);
  text(ctx, `AIRBURST · ${altReadout(ab.alt, u).join(' ').toUpperCase()} UP`, 540, y + 48, { size: 30, weight: 800, color: 'rgba(255,170,110,0.95)', align: 'center' });
  text(ctx, tntLabel(ab.energy).toUpperCase(), 540, y + 122, { size: 60, weight: 900, color: '#ffd166', align: 'center' });
  const cmp = comparison(ab.energy);
  text(ctx, `${timesLabel(cmp.times)} ${cmp.ref.name}`, 540, y + 184, { size: 28, weight: 700, color: 'rgba(225,232,245,0.9)', align: 'center' });
  ctx.restore();
}

function drawClockChip(ctx: Ctx2D, simT: number, rate: number, slowmo: boolean, x: number, y: number, align: 'right' | 'center') {
  const a = clock(simT);
  const b = warpLabel(rate, slowmo);
  ctx.save();
  ctx.font = `800 30px ${MONO}`;
  const w = Math.max(ctx.measureText(a).width, 0) + 40;
  ctx.font = `800 24px ${FONT_FAMILY}`;
  const w2 = Math.max(w, ctx.measureText(b).width + 40);
  const x0 = align === 'right' ? x - w2 : x - w2 / 2;
  panel(ctx, x0, y, w2, 96, 22);
  text(ctx, a, x0 + w2 / 2, y + 32, { size: 30, weight: 800, font: MONO, align: 'center' });
  text(ctx, b, x0 + w2 / 2, y + 70, { size: 24, weight: 800, color: rate > 1.4 ? '#8fd3ff' : '#ffd27a', align: 'center' });
  ctx.restore();
}

export function drawSpaceDropTop(rc: RenderCtx, s: SpaceDropState) {
  const { ctx, theme, t } = rc;
  const m = memo(s);
  const simT = s.sim.simT;
  // How fast the clock runs (sim seconds per video second), smoothed.
  if (m.lastT >= 0 && t > m.lastT) {
    const r = (simT - m.lastSim) / (t - m.lastT);
    m.rate += (r - m.rate) * 0.25;
  } else if (t < m.lastT) m.rate = 1;
  m.lastT = t;
  m.lastSim = simT;
  const u = s.p.units;
  const runs = s.sim.runs;
  if (runs.length === 1) drawSolo(ctx, s, m, runs[0], simT, t, u);
  else drawVersus(ctx, s, m, simT, t, u);
  if (s.p.captions) drawStoryCaption(ctx, theme, s.dir, timeOf(s.dir), { y: CAPTION_Y });
}

function drawSolo(ctx: Ctx2D, s: SpaceDropState, m: Memo, run: Run, simT: number, t: number, u: Units) {
  const smp = sampleAt(run.tr, Math.min(simT, endTime(run.tr)));
  const ti = markAt(s.dir, 'impact');
  const tau = t - ti;
  const after = Number.isFinite(ti) ? clamp01((tau - 0.2) / 0.4) : 0;
  const intro = clamp01((t - 0.3) / 0.5);
  drawStats(ctx, smp, run, u, 40, 300, intro * (1 - after));
  const slowmo = Number.isFinite(ti) && tau < 5 && impactClock(tau) < tau * 0.8;
  drawClockChip(ctx, simT, m.rate, slowmo, 1040, 300, 'right');
  if (s.p.ladder) drawLadder(ctx, smp.h, run.start.mode === 'meteor' ? 200 : run.start.altitude / 1000, 1000, 450, 1240, intro * (1 - after));
  toasts(ctx, m, run, simT, t, u, 1220);
  const tb = markAt(s.dir, 'burst');
  if (Number.isFinite(tb)) drawBurstCard(ctx, run, u, t - tb, 1010);
  if (Number.isFinite(ti)) drawImpactCard(ctx, run, u, tau, 290);
  const tg = markAt(s.dir, 'gone');
  if (Number.isFinite(tg) && t - tg > 0.4) {
    ctx.save();
    ctx.globalAlpha = clamp01((t - tg - 0.4) / 0.4);
    panel(ctx, 140, 520, 800, 170, 30, 0.5);
    text(ctx, 'BURNED UP', 540, 575, { size: 64, weight: 900, color: '#ff8a5a', align: 'center' });
    text(ctx, `NOTHING REACHES THE GROUND · ${Math.round(run.tr.massLost * 100)}% GONE`, 540, 640, { size: 26, weight: 800, color: '#ffffff', align: 'center' });
    ctx.restore();
  }
}

const COL_COLORS = ['#ffcf5a', '#7fd6ff', '#ff8fb1'];

function drawVersus(ctx: Ctx2D, s: SpaceDropState, m: Memo, simT: number, t: number, u: Units) {
  const runs = s.sim.runs;
  const n = runs.length;
  const colW = 1080 / n;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  for (let k = 1; k < n; k++) ctx.fillRect(k * colW - 2, 0, 4, 1920);
  ctx.restore();
  const order = runs
    .map((r, k) => ({ k, at: r.tr.impact?.t ?? Infinity }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.k);
  const intro = clamp01((t - 0.3) / 0.5);
  runs.forEach((run, k) => {
    const cx = colW * (k + 0.5);
    const smp = sampleAt(run.tr, Math.min(simT, endTime(run.tr)));
    const ti = markAt(s.dir, `impact${k}`);
    const landed = Number.isFinite(ti);
    ctx.save();
    ctx.globalAlpha = intro;
    panel(ctx, k * colW + 14, 300, colW - 28, 100, 22);
    text(ctx, run.obj.name.toUpperCase(), cx, 334, { size: n === 2 ? 34 : 27, weight: 900, color: COL_COLORS[k], align: 'center' });
    text(ctx, massLabel(run.body.mass), cx, 372, { size: 24, weight: 700, color: 'rgba(225,232,245,0.85)', align: 'center' });
    const gone = run.tr.end === 'burnup' && simT >= endTime(run.tr);
    if (!landed && !gone) {
      panel(ctx, k * colW + 14, 412, colW - 28, 196, 22, 0.38);
      const [alt, altU] = altReadout(smp.h, u);
      const [spd, spdU] = speedReadout(smp.v, u);
      const [ts, tsU] = tempReadout(smp.Ts, u);
      const fs = n === 2 ? 44 : 36;
      text(ctx, `${alt} ${altU}`, cx, 452, { size: fs, weight: 800, font: MONO, align: 'center' });
      text(ctx, `${spd} ${spdU}`, cx, 512, { size: fs, weight: 800, font: MONO, align: 'center' });
      text(ctx, `${ts} ${tsU}`, cx, 572, { size: fs, weight: 800, font: MONO, align: 'center', color: heatColour(smp.Ts) });
    } else if (landed) {
      const place = order.indexOf(k);
      const tau = t - ti;
      const a = clamp01((tau - 0.3) / 0.4);
      ctx.globalAlpha = intro * a;
      panel(ctx, k * colW + 14, 412, colW - 28, 250, 22, 0.5);
      text(ctx, ['1ST DOWN', '2ND DOWN', '3RD DOWN'][place] ?? 'DOWN', cx, 448, { size: 26, weight: 800, color: 'rgba(255,190,120,0.95)', align: 'center' });
      text(ctx, speedText(run.tr.impact!.v, u).toUpperCase(), cx, 492, { size: n === 2 ? 34 : 28, weight: 800, align: 'center' });
      text(ctx, energyLabel(run.energy * ease((tau - 0.3) / 1.2)), cx, 556, { size: n === 2 ? 58 : 46, weight: 900, font: MONO, color: '#ffd166', align: 'center' });
      text(ctx, tntLabel(run.energy), cx, 618, { size: n === 2 ? 26 : 21, weight: 800, align: 'center' });
    } else {
      panel(ctx, k * colW + 14, 412, colW - 28, 120, 22, 0.5);
      text(ctx, 'BURNED UP', cx, 472, { size: n === 2 ? 44 : 34, weight: 900, color: '#ff8a5a', align: 'center' });
    }
    ctx.restore();
    // Mini altitude bar on the column's edge.
    const topKm = run.start.mode === 'meteor' ? 200 : run.start.altitude / 1000;
    const lo = Math.log10(0.01);
    const hi = Math.log10(Math.max(120, topKm * 1.05));
    const y0 = 700;
    const y1 = 1240;
    const yy = y1 - ((Math.log10(Math.max(0.01, smp.h / 1000)) - lo) / (hi - lo)) * (y1 - y0);
    const bx = (k + 1) * colW - 26;
    ctx.save();
    ctx.globalAlpha = intro * 0.9;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(bx - 3, y0, 6, y1 - y0);
    ctx.fillStyle = COL_COLORS[k];
    ctx.beginPath();
    ctx.arc(bx, landed ? y1 : yy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    toastsCol(ctx, s, m, run, simT, t, u, k, cx, 680, colW);
  });
  drawClockChip(ctx, simT, m.rate, false, 540, 196 + 0, 'center');
  // The result: energies side by side on a log scale.
  const tr_ = markAt(s.dir, 'reveal');
  if (Number.isFinite(tr_)) drawEnergyBars(ctx, runs, t - tr_);
}

function toastsCol(ctx: Ctx2D, s: SpaceDropState, m: Memo, run: Run, simT: number, t: number, u: Units, k: number, cx: number, y: number, colW: number) {
  void s;
  let best: { at: number; label: string; color: string } | null = null;
  for (const e of run.tr.events) {
    const label = e.kind === 'breakup' ? 'BREAKUP' : e.kind === 'airburst' ? 'AIRBURST' : e.kind === 'melt' ? 'MELTING' : e.kind === 'subsonic' ? 'SONIC BOOM' : e.kind === 'burnup' ? 'BURNED UP' : null;
    if (!label) continue;
    const at = seenAt(m, `${k}:${e.kind}`, simT >= e.t, t);
    if (at !== null && t - at < 2.4 && (!best || at > best.at)) best = { at, label, color: e.kind === 'melt' || e.kind === 'subsonic' ? '#ffd27a' : '#ff7a5a' };
  }
  if (!best) return;
  const age = t - best.at;
  ctx.save();
  ctx.globalAlpha = clamp01(age / 0.15) * clamp01((2.4 - age) / 0.4);
  panel(ctx, cx - colW * 0.42, y - 26, colW * 0.84, 52, 26, 0.55);
  text(ctx, best.label, cx, y + 1, { size: 26, weight: 900, color: best.color, align: 'center' });
  ctx.restore();
  void u;
}

function drawEnergyBars(ctx: Ctx2D, runs: Run[], tau: number) {
  const a = clamp01(tau / 0.4);
  const Es = runs.map((r) => r.energy);
  const maxE = Math.max(...Es, 1);
  const minE = Math.max(1e-3, Math.min(...Es.filter((e) => e > 0), maxE));
  const lo = Math.floor(Math.log10(minE)) - 1;
  const hi = Math.ceil(Math.log10(maxE));
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, 70, 760, 940, 120 + runs.length * 110, 32, 0.6);
  text(ctx, 'IMPACT ENERGY', 540, 808, { size: 32, weight: 900, color: 'rgba(255,190,120,0.95)', align: 'center' });
  const ranked = runs.map((r, k) => ({ r, k })).sort((x, y) => y.r.energy - x.r.energy);
  ranked.forEach(({ r, k }, i) => {
    const y = 860 + i * 110;
    const frac = r.energy > 0 ? (Math.log10(r.energy) - lo) / (hi - lo) : 0;
    const w = 760 * clamp01(frac) * ease((tau - 0.2 - i * 0.15) / 0.8);
    text(ctx, `${i === 0 ? '👑 ' : ''}${r.obj.name}`, 120, y + 8, { size: 30, weight: 800, color: COL_COLORS[k] });
    ctx.fillStyle = COL_COLORS[k];
    ctx.beginPath();
    ctx.roundRect(120, y + 30, Math.max(6, w), 30, 15);
    ctx.fill();
    text(ctx, r.energy > 0 ? energyLabel(r.energy) : 'burned up', 960, y + 8, { size: 28, weight: 800, font: MONO, align: 'right' });
  });
  text(ctx, 'log scale: each step is 10× more', 540, 860 + runs.length * 110 - 8, { size: 20, weight: 700, color: 'rgba(200,210,230,0.7)', align: 'center' });
  ctx.restore();
  void round2;
}
