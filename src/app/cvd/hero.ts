import { niceStep } from '../view.ts';
import type { CvdModel, LaneLine } from './model.ts';
import type { PriceColumns } from './price.ts';
import { CVD_SPANS, type CvdSpan } from './settings.ts';

/**
 * The Flow view's chart (Karl, 2026-10-26): on a phone the aggregate row is the whole chart, the price drawn over the taker flow of every
 * exchange, spot and perpetual, with an axis for each (the dollars of the flow at the left, the price at the right). Everything it needs that
 * is not a drawing is here, with no canvas and no DOM, so a test reads it.
 */

/** A value range on one axis. */
export interface Range { lo: number; hi: number }

/**
 * The range a line is drawn over: its extent, with zero kept in view when the line starts from zero at the left edge (`rebase`), a floor so a
 * flat line is not blown up into noise, and a tenth of the height of air above and below. Null when the line holds nothing yet. This is the
 * rule every row of the column has always used.
 */
export function laneRange(lane: Pick<LaneLine, 'min' | 'max'>, rebase: boolean): Range | null {
  let lo = lane.min, hi = lane.max;
  if (!(lo <= hi)) return null;
  if (rebase) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  return { lo: lo - pad, hi: hi + pad };
}

/** One range for several lines, so they stand on one axis in dollars: the extent of all of them, by the rule of `laneRange`. */
export function sharedRange(lanes: readonly (Pick<LaneLine, 'min' | 'max'> | null)[], rebase: boolean): Range | null {
  let min = Infinity, max = -Infinity;
  for (const lane of lanes) if (lane && lane.min <= lane.max) { min = Math.min(min, lane.min); max = Math.max(max, lane.max); }
  return laneRange({ min, max }, rebase);
}

/** The prices' range: their extent and an eighth of it above and below (a flat stretch takes a twentieth of a percent), or null with no price. */
export function priceRange(min: number, max: number): Range | null {
  if (!(min <= max)) return null;
  const pad = (max - min) * 0.12 || max * 0.0005;
  return { lo: min - pad, hi: max + pad };
}

/** Round values inside [lo, hi], about `target` of them, one, two or five apart in some power of ten; `step` is what is between them (0 with no range). */
export function niceTicks(lo: number, hi: number, target: number): { step: number; values: number[] } {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return { step: 0, values: [] };
  const step = niceStep(hi - lo, target), values: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9), last = Math.floor(hi / step + 1e-9); k <= last && values.length < 24; k++) values.push(k === 0 ? 0 : k * step);
  return { step, values };
}

/** The tallest and the shortest the chart is, and the share of the pane it takes (a pane held sideways is short: the chart takes about half of it). */
export const HERO = Object.freeze({ min: 150, max: 260, share: 0.34, shareSideways: 0.5, minSideways: 110 });

/** The height of the chart in a pane `room` px tall. */
export function heroHeight(room: number, sideways: boolean): number {
  const share = sideways ? HERO.shareSideways : HERO.share, min = sideways ? HERO.minSideways : HERO.min;
  return Math.round(Math.max(min, Math.min(HERO.max, room * share)));
}

/** Where a line ends: the running delta of its newest column, or null when it holds nothing. */
export function laneEnd(lane: Pick<LaneLine, 'last'> | null): number | null {
  if (!lane) return null;
  for (let c = lane.last.length - 1; c >= 0; c--) { const v = lane.last[c]!; if (v === v) return v; }
  return null;
}

/**
 * What a line made over the whole window: where it ends, less where the window began when it did not start from zero (`rebase` off, the
 * running total since the history began: `before`, so the trades of the first column count; a line without it is taken from its first
 * column). The chart's legend and the readout say this, so they agree with the line they sit beside.
 */
export function laneNet(lane: Pick<LaneLine, 'last' | 'before'> | null, rebase: boolean): number | null {
  const end = laneEnd(lane);
  if (end === null || !lane) return null;
  if (rebase) return end;
  if (lane.before !== undefined) return end - lane.before;
  for (const v of lane.last) if (v === v) return end - v;
  return end;
}

/** The room the price axis takes at the right of the plot (the venue rows keep it too, so every row's time sits above the same pixel). */
export const PRICE_AXIS_W = 52;

/** What the chart says at one column: the price and the running delta of each kind (null where it holds nothing), and the two together. */
export interface HeroPoint { price: number | null; spot: number | null; perp: number | null; total: number | null }

const finite = (v: number | undefined): number | null => v !== undefined && Number.isFinite(v) ? v : null;

/** The chart's values at pixel column `column`. */
export function heroPoint(model: Pick<CvdModel, 'spot' | 'perp'>, price: Pick<PriceColumns, 'last'> | null, column: number): HeroPoint {
  const spot = finite(model.spot?.last[column]), perp = finite(model.perp?.last[column]);
  return { price: finite(price?.last[column]), spot, perp, total: spot === null && perp === null ? null : (spot ?? 0) + (perp ?? 0) };
}

/**
 * The column a time falls in (held inside the window), or -1 when the window is empty. The same slices as the lines' own columns, so a
 * scrubbed time and the lines under it agree.
 */
export function columnAt(t0: number, t1: number, columns: number, time: number): number {
  if (!(t1 > t0) || columns < 1) return -1;
  return Math.max(0, Math.min(columns - 1, Math.floor((time - t0) / (t1 - t0) * columns)));
}

/**
 * The span a pinch moves to: the spans in order from the shortest, one step per gesture longer (the fingers closing) or shorter (opening),
 * held at the ends. The map's own span is not one of them: the Flow view has no map to follow.
 */
export const PINCH_SPANS: readonly Exclude<CvdSpan, 'map'>[] = CVD_SPANS.filter((s): s is Exclude<CvdSpan, 'map'> => s !== 'map');
export function pinchSpan(current: CvdSpan, ratio: number, threshold = 1.3): Exclude<CvdSpan, 'map'> {
  const at = Math.max(0, PINCH_SPANS.indexOf(current === 'map' ? PHONE_SPAN : current));
  if (ratio >= threshold) return PINCH_SPANS[Math.max(0, at - 1)]!;
  if (ratio <= 1 / threshold) return PINCH_SPANS[Math.min(PINCH_SPANS.length - 1, at + 1)]!;
  return PINCH_SPANS[at]!;
}

/** The span a phone's Flow view draws when the setting is the map's: it fills the area, so there is no map window to follow, and an hour is the one the column has always ranked over. */
export const PHONE_SPAN: Exclude<CvdSpan, 'map'> = '1h';
export const spanOnPhone = (span: CvdSpan): Exclude<CvdSpan, 'map'> => span === 'map' ? PHONE_SPAN : span;
