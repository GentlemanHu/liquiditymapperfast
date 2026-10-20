import type { Palette } from '../theme.ts';
import type { View } from '../view.ts';
import { t } from '../i18n.ts';
import { emphasisFloor, splitStyles } from '../traded/emphasis.ts';
import { bucketSpan, timeText, type TimeLevels, type TimeRows } from './model.ts';

/** What the painter needs of the map: its view, its plot size and the palette. */
export interface BandFrame { view: View; pw: number; ph: number; palette: Palette }

/** What the band draws besides its rows: the bars' style, the value area, the header's lines, the caption, the bucket under the pointer. */
export interface BandDraw {
  bars: 'split' | 'delta';
  /** Split bars draw the stronger side brighter and the weaker dimmer (traded/emphasis.ts), as the columns do. */
  emphasis: boolean;
  /** The point of control and the value area as buckets, when the value area is marked. */
  levels: TimeLevels | null;
  /** The header's total, the line under it (in amber when `warn`: the record is cut or reaches back before the recording), and the Δ line. */
  head: string; sub: string; warn: boolean;
  net: { text: string; sign: number } | null;
  /** The bucket length and what the measure cannot say, at the band's foot. */
  caption: string;
  /** The bucket under the pointer, or -1. */
  hovered: number;
  /** The page's clock, for the tags' dates. */
  now: number;
}

/** A plot narrower than this (a phone) gets the header in a smaller font, as the column's (NARROW_PLOT in heat-pane.ts). */
const NARROW_PLOT = 420;
/** The amber a cut record is said in, as the column's header says it. */
const WARN = '#e6a700';

/**
 * The volume profile along the top of the map: the column beside it laid on the time axis. On the column's panel background, each bucket's
 * bar grows down from the band's top edge as a row's grows right from the column's left edge: the first side (bid colour) then the second
 * (ask colour), as long as the bucket's total against the busiest, or with `bars: 'delta'` that length faintly and their difference over it,
 * on the same scale, in the bigger side's colour. Behind them the value area is shaded; across them the point of control is a solid line and the value area's start and end dashed
 * ones, each tagged with its time at the band's foot where the column tags its prices at its far edge. The header stands at the band's left
 * as the column's stands at its top, over the bars there, and the bucket under the pointer is framed. Returns the header's width (a click on
 * the header opens the profile's settings).
 */
export function paintBand(ctx: CanvasRenderingContext2D, rows: TimeRows, band: { top: number; height: number }, f: BandFrame, d: BandDraw): number {
  const { view: v, pw, palette: p } = f, { top, height: H } = band, xOf = (time: number): number => v.xOf(time, pw);
  ctx.save(); ctx.beginPath(); ctx.rect(0, top, pw, H); ctx.clip();
  ctx.fillStyle = p.panel; ctx.fillRect(0, top, pw, H);
  const lv = d.levels;
  if (lv) {
    const xa = xOf(bucketSpan(rows, lv.lo)[0]), xb = xOf(bucketSpan(rows, lv.hi)[1]);
    ctx.fillStyle = p.poc; ctx.globalAlpha = 0.12; ctx.fillRect(xa, top + 1, xb - xa, H - 1); ctx.globalAlpha = 1;
  }
  if (rows.max > 0) {
    const length = H - 6, floor = emphasisFloor();
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < rows.buy.length; i++) {
      const b = rows.buy[i]!, s = rows.sell[i]!, total = b + s; if (!(total > 0)) continue;
      const [a, e] = bucketSpan(rows, i), x0 = xOf(a), x1 = xOf(e);
      if (x1 < 0 || x0 > pw) continue;
      const w = Math.max(1, x1 - x0 - 0.5);
      const len = Math.max(1, total / rows.max * length), buyLen = len * b / total;
      if (d.bars === 'delta') {
        // The whole bucket faintly, and the difference over it on the same scale in the colour of the side that was the bigger, as the column
        // draws it: a busy bucket whose two sides were close still shows, as busy and balanced, never as empty.
        const net = b - s;
        ctx.globalAlpha = 0.25; ctx.fillStyle = p.muted; ctx.fillRect(x0, top + 1, w, len); ctx.globalAlpha = 0.85;
        if (Math.abs(net) > 0) { ctx.fillStyle = net > 0 ? p.bid : p.ask; ctx.fillRect(x0, top + 1, w, Math.max(1, Math.abs(net) / rows.max * length)); }
        continue;
      }
      // The stronger side brighter, the weaker dimmer, against the busiest bucket of the whole window, as the column shades its rows.
      const [first, second] = splitStyles(b, s, rows.max, floor, p, d.emphasis);
      if (b > 0) { ctx.globalAlpha = first.alpha; ctx.fillStyle = first.color; ctx.fillRect(x0, top + 1, w, Math.max(0.5, buyLen)); }
      if (s > 0) { ctx.globalAlpha = second.alpha; ctx.fillStyle = second.color; ctx.fillRect(x0, top + 1 + buyLen, w, Math.max(0.5, len - buyLen)); }
      ctx.globalAlpha = 0.85;
    }
    ctx.globalAlpha = 1;
  }
  // A stretch with no data is not a zero: a faint dotted line along the top edge where its bars would hang, so four missing minutes between
  // readings never look like four readings that did not move (those have no bar and no line).
  ctx.save(); ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath();
  for (let i = 0; i < rows.gaps.length;) {
    if (!rows.gaps[i]) { i++; continue; }
    let j = i; while (j + 1 < rows.gaps.length && rows.gaps[j + 1]) j++;
    const x0 = Math.max(0, xOf(bucketSpan(rows, i)[0])), x1 = Math.min(pw, xOf(bucketSpan(rows, j)[1]));
    if (x1 > x0) { ctx.moveTo(x0, top + 2.5); ctx.lineTo(x1, top + 2.5); }
    i = j + 1;
  }
  ctx.stroke(); ctx.restore();
  // The header's width, measured before the marks so their tags keep clear of it.
  const font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`;
  ctx.font = font;
  const headW = Math.min(pw / 3, Math.ceil(Math.max(ctx.measureText(d.head).width, ctx.measureText(d.sub).width, d.net ? ctx.measureText(d.net.text).width : 0)) + 10);
  const captionW = d.caption ? ctx.measureText(d.caption).width + 8 : 0;
  // The point of control through the middle of its bucket, the value area's start and end at its edges: the levels the shade is read from.
  if (lv) {
    const mark = (x: number, width: number, dash: number[]): void => { const at = Math.round(x) + 0.5; if (at < 0 || at > pw) return; ctx.setLineDash(dash); ctx.strokeStyle = p.poc; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(at, top + 1); ctx.lineTo(at, top + H); ctx.stroke(); };
    const [pa, pb] = bucketSpan(rows, lv.poc), start = bucketSpan(rows, lv.lo)[0], end = bucketSpan(rows, lv.hi)[1];
    mark(xOf(start), 1, [3, 2]); mark(xOf(end), 1, [3, 2]); mark(xOf((pa + pb) / 2), 2, []); ctx.setLineDash([]); ctx.lineWidth = 1;
    // Their times at the band's foot, the point of control's first: one that would cover another, the header or the caption is left out.
    ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const y = top + H - 8, placed: [number, number][] = [[0, headW], [pw - captionW - 6, pw]];
    const tags: [string, number, number, 'center' | 'left' | 'right'][] = [[t('POC'), pa, xOf((pa + pb) / 2), 'center'], [t('VA start'), start, xOf(start), 'right'], [t('VA end'), end, xOf(end), 'left']];
    for (const [code, at, x, side] of tags) {
      const text = `${code} ${timeText(at, rows.step, d.now)}`, w = ctx.measureText(text).width + 6;
      const x0 = side === 'center' ? x - w / 2 : side === 'right' ? x - w - 2 : x + 2;
      if (x0 < 0 || x0 + w > pw || placed.some(([a, b]) => x0 < b + 2 && x0 + w > a - 2)) continue;
      placed.push([x0, x0 + w]);
      ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(x0, y - 6, w, 12);
      ctx.globalAlpha = 1; ctx.fillStyle = p.poc; ctx.fillText(text, x0 + 3, y);
    }
  }
  // The bucket under the pointer, framed; over the header, none.
  if (d.hovered >= 0) {
    const [a, e] = bucketSpan(rows, d.hovered), x0 = xOf(a), x1 = xOf(e);
    if (x1 > headW) { ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.max(1, Math.round(x1 - x0)), H - 1); ctx.globalAlpha = 1; }
  }
  // The header: the total, the line under it, and the difference of the two sides.
  ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(0, top, headW, H); ctx.globalAlpha = 1;
  ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = p.muted;
  ctx.fillText(d.head, 4, top + 4, headW - 8);
  if (d.sub) { if (d.warn) ctx.fillStyle = WARN; ctx.fillText(d.sub, 4, top + 16, headW - 8); }
  if (d.net) { ctx.fillStyle = d.net.sign > 0 ? p.bid : d.net.sign < 0 ? p.ask : p.muted; ctx.fillText(d.net.text, 4, top + 28, headW - 8); }
  if (d.caption && captionW + headW + 12 < pw) {
    ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(pw - captionW - 4, top + H - 15, captionW, 13); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted; ctx.fillText(d.caption, pw - captionW, top + H - 13.5);
  }
  ctx.restore();
  // The edges where the bars start and end, as the column has a line where its rows start.
  ctx.save(); ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(0, top + 0.5); ctx.lineTo(pw, top + 0.5); ctx.moveTo(0, top + H - 0.5); ctx.lineTo(pw, top + H - 0.5);
  ctx.stroke(); ctx.restore();
  return headW;
}
