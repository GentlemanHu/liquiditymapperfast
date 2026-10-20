import { rgb, type Palette } from '../theme.ts';
import type { View } from '../view.ts';
import { barGeometry, type StripSeries } from './model.ts';

/** What the painter needs of the map: its view and plot size, the palette and the footprint's narrowing of the candles. */
export interface StripFrame { view: View; pw: number; ph: number; palette: Palette; narrowing: number }

/** The words the band carries: the caption at its left, the scale at its right, or a message where nothing in view has a value. */
export interface StripText { caption: string; scale: string; empty: string | null }

/**
 * The measure strip: a shallow band under the legend with one signed bar per candle about a zero line, above it in the bid colour and below
 * it in the ask colour, every bar on one scale (`max`, the largest size in view). A candle with no value has no bar and the zero line is
 * dotted under it, so a gap never reads as a zero. With Highlights on, what stands out is drawn at full strength and the rest dimmed, as
 * the volume bars are.
 */
export function paintStrip(ctx: CanvasRenderingContext2D, series: StripSeries, band: { top: number; height: number }, f: StripFrame, max: number, emphasise: boolean, text: StripText): void {
  const { view: v, pw, palette: p } = f, { top, height } = band, tf = series.tfMs, mid = Math.round(top + height / 2) + 0.5, half = height / 2 - 2;
  ctx.save(); ctx.beginPath(); ctx.rect(0, top - 6, pw, height + 12); ctx.clip();
  // A soft backdrop, strongest in the middle and gone at both edges, keeps the bars readable over bright heat without a hard box.
  const [br, bg, bb] = rgb(p.bg).map(c => Math.round(c * 255)) as [number, number, number], a = p.dark ? 0.55 : 0.5;
  const backdrop = ctx.createLinearGradient(0, top - 6, 0, top + height + 6);
  backdrop.addColorStop(0, `rgba(${br},${bg},${bb},0)`); backdrop.addColorStop(0.25, `rgba(${br},${bg},${bb},${a})`);
  backdrop.addColorStop(0.75, `rgba(${br},${bg},${bb},${a})`); backdrop.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
  ctx.fillStyle = backdrop; ctx.fillRect(0, top - 6, pw, height + 12);
  const slot = Math.max(1, pw * tf / (v.t1 - v.t0)), xOf = (t: number): number => v.xOf(t, pw);
  // The zero line: solid under candles with a value, dotted and faint under those without.
  const held = new Path2D(), missing = new Path2D();
  for (let i = 0; i < series.starts.length; i++) {
    const t = series.starts[i]!; if (t + tf < v.t0 || t > v.t1) continue;
    const path = Number.isFinite(series.values[i]!) ? held : missing;
    path.moveTo(xOf(t), mid); path.lineTo(xOf(t + tf), mid);
  }
  ctx.lineWidth = 1; ctx.strokeStyle = p.line; ctx.globalAlpha = 0.9; ctx.stroke(held);
  ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.5; ctx.setLineDash([1, 3]); ctx.stroke(missing); ctx.setLineDash([]);
  if (max > 0) for (let i = 0; i < series.starts.length; i++) {
    const t = series.starts[i]!, value = series.values[i]!;
    if (t + tf < v.t0 || t > v.t1 || !Number.isFinite(value)) continue;
    const { x, body } = barGeometry(t, tf, xOf, slot, f.narrowing), h = Math.max(1, Math.abs(value) / max * half), up = value >= 0;
    const hot = emphasise && series.flag[i] === 1, y = up ? mid - h : mid;
    ctx.globalAlpha = !emphasise ? 0.75 : hot ? 1 : 0.45; ctx.fillStyle = up ? p.bid : p.ask;
    ctx.fillRect(x - body / 2, y, body, h);
    // A cap beyond the bar says "this one stands out", as on the volume bars.
    if (hot) { ctx.globalAlpha = 0.9; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c'; ctx.fillRect(x - body / 2, up ? y - 1.5 : y + h, body, 1.5); }
  }
  ctx.globalAlpha = 1;
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'top';
  const plate = (label: string, x: number, align: 'left' | 'right'): void => {
    const w = ctx.measureText(label).width + 8, x0 = align === 'left' ? x : x - w;
    ctx.globalAlpha = 0.72; ctx.fillStyle = p.panel; ctx.fillRect(x0, top, w, 13); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(label, x0 + 4, top + 1.5);
  };
  const caption = text.empty ? `${text.caption} · ${text.empty}` : text.caption;
  plate(caption, 6, 'left');
  if (!text.empty && text.scale && ctx.measureText(caption).width + ctx.measureText(text.scale).width + 40 < pw) plate(text.scale, pw - 6, 'right');
  ctx.restore();
}
