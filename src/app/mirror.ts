import type { Palette } from './theme.ts';
import { price as fmtPrice, usd } from './format.ts';
import { t } from './i18n.ts';
import { measureInfoBox, paintInfoBox, wrapWithin, type InfoColor, type InfoLine, type InfoRect } from './infobox.ts';

/**
 * Mirror hover: pointing at a price highlights the band from the mid to that price and the equally wide band on the other
 * side, dims everything outside, and compares the liquidity inside the two bands, so moving the pointer outward shows how
 * the balance changes with distance (the same comparison as the cumulative curves of a liquidation chart).
 */
export interface MirrorStats {
  mid: number;
  /** The hovered price and its mirror image about the mid. */
  price: number;
  mirror: number;
  /** Distance of the hovered price from the mid. */
  distance: number;
  distanceBp: number;
  hoveredSide: 'above' | 'below';
  /** USD inside the band on the hovered side and on the opposite side. */
  hovered: number;
  opposite: number;
  aboveUsd: number;
  belowUsd: number;
  /** Larger over smaller (Infinity when one side is empty). */
  ratio: number;
  dominant: 'this' | 'opposite' | 'balanced' | 'none';
  /** True when part of a band lay outside the data that was available. */
  clipped: boolean;
}

/** Under this, the larger side over the smaller, two sides are called even (every Mirror box's "about even", the phone's Liq tab's Balanced). */
export const BALANCED_RATIO = 1.02;

export function mirrorStats(mid: number, price: number, aboveUsd: number, belowUsd: number, clipped = false): MirrorStats | null {
  const distance = Math.abs(price - mid);
  if (!(mid > 0) || !(distance > 0) || !Number.isFinite(price)) return null;
  const hoveredSide = price >= mid ? 'above' : 'below';
  const hovered = hoveredSide === 'above' ? aboveUsd : belowUsd, opposite = hoveredSide === 'above' ? belowUsd : aboveUsd;
  const big = Math.max(hovered, opposite), small = Math.min(hovered, opposite);
  const ratio = big === 0 ? 1 : small === 0 ? Infinity : big / small;
  const dominant = big === 0 ? 'none' : ratio < BALANCED_RATIO ? 'balanced' : hovered > opposite ? 'this' : 'opposite';
  return { mid, price, mirror: 2 * mid - price, distance, distanceBp: distance / mid * 1e4, hoveredSide, hovered, opposite, aboveUsd, belowUsd, ratio, dominant, clipped };
}

export function ratioText(ratio: number): string {
  if (!Number.isFinite(ratio)) return t('all of it');
  return `${ratio >= 10 ? ratio.toFixed(1) : ratio.toFixed(2)}x`;
}

/**
 * A ratio as the boxes print it, two decimals below ten and one up to a thousand ("1.04×", "13.0×"), and no more digits past that ("≥1000×":
 * a side all but empty against a full one printed sixteen of them and widened the box); a dash where the side divided by holds nothing.
 */
export function ratioWords(top: number, bottom: number): string {
  if (!(bottom > 0)) return '–';
  const r = top / bottom;
  return r >= 1000 ? '≥1000×' : `${r >= 10 ? r.toFixed(1) : r.toFixed(2)}×`;
}

export type MirrorLine = InfoLine;

/** A side's amount as the verdicts weigh it: a finite amount above zero, else nothing. */
const known = (x: number): number => Number.isFinite(x) && x > 0 ? x : 0;

/**
 * Which band holds more, as a line of its own: the heavier side named by its price side, in its colour, with how many times the other it is
 * ("Bids 1.13× the asks"); about even under the Mirror's balance; only one side where the other holds nothing. The test and the words of the
 * profile box's `depthBandVerdict` (hover-rows.ts), without its "Within ≈±…:" lead-in, which the order book's box says on its first line, and
 * the words of the guide's picture of it. Every case wraps, as there, so no language runs past a narrow box (the book's is 250 px at least,
 * where today's longest, about 170 px, still fits on one line).
 */
export function bandVerdict(bid: number, ask: number): MirrorLine {
  const b = known(bid), a = known(ask);
  if (!b && !a) return { text: t('No bids or asks'), color: 'muted', wrap: true };
  if (!a) return { text: t('Only bids'), color: 'below', bold: true, wrap: true };
  if (!b) return { text: t('Only asks'), color: 'above', bold: true, wrap: true };
  if (Math.max(b, a) / Math.min(b, a) < BALANCED_RATIO) return { text: t('Bids and asks about even'), bold: true, wrap: true };
  return b > a ? { text: t('Bids {ratio} the asks', { ratio: ratioWords(b, a) }), color: 'below', bold: true, wrap: true }
    : { text: t('Asks {ratio} the bids', { ratio: ratioWords(a, b) }), color: 'above', bold: true, wrap: true };
}

/**
 * The order book's Mirror box: how far from the mid, what each band holds by its price side (asks above, bids below: nothing turns over as
 * the pointer crosses the price), then which holds more (`bandVerdict`), as the profile's box and the guide's picture say it. It said
 * "Asks (this side)" and "Opposite side has 1.13x more" until 2026-11-22 (Karl: the order book's hover needed the same words).
 */
export function mirrorLines(stats: MirrorStats, title?: string): MirrorLine[] {
  const lines: MirrorLine[] = [];
  if (title) lines.push({ text: title, bold: true });
  lines.push({ text: t('±{distance} ({bp} bp) from {mid}', { distance: fmtPrice(stats.distance), bp: stats.distanceBp < 10 ? stats.distanceBp.toFixed(1) : Math.round(stats.distanceBp), mid: fmtPrice(stats.mid) }), color: 'muted' });
  lines.push({ text: `${t('Asks')}  $${usd(stats.aboveUsd)}`, color: 'above' }, { text: `${t('Bids')}  $${usd(stats.belowUsd)}`, color: 'below' });
  lines.push(bandVerdict(stats.belowUsd, stats.aboveUsd));
  // Wrapped too: in German it is the box's widest line, near the edge of the narrowest book (review, 2026-11-22).
  if (stats.clipped) lines.push({ text: t('part of the range is outside the data'), color: 'muted', wrap: true });
  return lines;
}

/**
 * Draw `lines` in a box beside (x, y), kept inside `bounds`, and say where it was drawn. `placement` extends the box down or up from y (toward
 * the inside of a band, clear of its edge labels) instead of centring it. A line told to wrap wraps to the room between the bounds' sides
 * (`wrapWithin`), so a long sentence on a phone's narrow map stays inside the box and the box inside the map.
 */
export function paintMirrorBox(ctx: CanvasRenderingContext2D, lines: MirrorLine[], x: number, y: number, bounds: { x0: number; y0: number; x1: number; y1: number }, p: Palette,
  pick: (color: InfoColor) => string, placement: 'center' | 'down' | 'up' = 'center'): InfoRect | null {
  return paintInfoBox(ctx, lines, x, y, bounds, p, { pick, placement, wrapAt: wrapWithin(bounds.x0, bounds.x1) });
}

/**
 * The frame `place(boxH)` gives a box of `lines`, with the box measured as `paintMirrorBox` will draw it there: wrapped to the frame's room,
 * which does not depend on the height asked about, so the frame's sides come first and the height measured inside them second.
 */
export function mirrorFrame<F extends { bounds: { x0: number; x1: number } }>(ctx: CanvasRenderingContext2D, lines: readonly MirrorLine[], place: (boxH: number) => F): F {
  const room = place(0).bounds;
  return place(measureInfoBox(ctx, lines, wrapWithin(room.x0, room.x1)).h);
}

/** Shade everything in [y0, y1) outside the highlighted band [bandTop, bandBottom] so the inner layers stand out. */
export function dimOutside(ctx: CanvasRenderingContext2D, x: number, w: number, y0: number, y1: number, bandTop: number, bandBottom: number, bg: string, alpha = 0.6): void {
  ctx.save(); ctx.fillStyle = bg; ctx.globalAlpha = alpha;
  const top = Math.max(y0, Math.min(y1, bandTop)), bottom = Math.max(y0, Math.min(y1, bandBottom));
  if (top > y0) ctx.fillRect(x, y0, w, top - y0);
  if (bottom < y1) ctx.fillRect(x, bottom, w, y1 - bottom);
  ctx.restore();
}

/** Distance of the hovered price from the mid as printed on the band labels: 5.8%, 0.35%. */
export function percentText(stats: MirrorStats): string {
  const pct = stats.distance / stats.mid * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export interface BandEdge { y: number; color: string; label: string }

/**
 * Frame the selected band: a tint over the band, side borders, a solid border line at each
 * edge in that side's colour, and a pill at the right end of each line giving the cumulative size and the distance.
 * `top` must have the smaller y. Labels sit just outside the band and move inside when there is no room.
 */
export function paintBand(ctx: CanvasRenderingContext2D, p: Palette, x: number, w: number, top: BandEdge, bottom: BandEdge, clip: { y0: number; y1: number }): void {
  ctx.save();
  const yTop = Math.round(top.y) + 0.5, yBottom = Math.round(bottom.y) + 0.5;
  ctx.globalAlpha = p.dark ? 0.07 : 0.05; ctx.fillStyle = p.text; ctx.fillRect(x, yTop, w, yBottom - yTop);
  ctx.globalAlpha = 0.4; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(x + 0.5, yTop); ctx.lineTo(x + 0.5, yBottom); ctx.moveTo(x + w - 0.5, yTop); ctx.lineTo(x + w - 0.5, yBottom); ctx.stroke();
  ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
  for (const edge of [top, bottom]) { ctx.strokeStyle = edge.color; ctx.beginPath(); const y = Math.round(edge.y) + 0.5; ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke(); }
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  const pill = (edge: BandEdge, above: boolean) => {
    if (!edge.label) return; // a column too narrow for one (a compact map's book strip) passes none
    const text = edge.label, tw = ctx.measureText(text).width + 10, h = 15, y = Math.round(edge.y) + 0.5;
    let by = above ? y - h - 1 : y + 2;
    if (above ? by < clip.y0 : by + h > clip.y1) by = above ? y + 2 : y - h - 1;
    const bx = Math.max(x + 2, x + w - tw - 3);
    ctx.globalAlpha = 0.97; ctx.fillStyle = p.panel; ctx.fillRect(bx, by, tw, h);
    ctx.globalAlpha = 1; ctx.strokeStyle = edge.color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, h - 1);
    ctx.fillStyle = p.text; ctx.fillText(text, bx + tw - 5, by + h / 2 + 0.5);
  };
  pill(top, true); pill(bottom, false);
  ctx.restore();
}
