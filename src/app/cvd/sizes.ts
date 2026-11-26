import type { Bar } from '../panes/footprint.ts';
import type { Kind } from '../scope.ts';
import { BANDS } from '../size-history/model.ts';
import type { LaneLine } from './model.ts';

/**
 * The flow column's Sizes view (Karl, 2026-11-25: "replace the venues with different categories of trade sizes ... plot the CVD for each
 * category ... keep splitting it by spot and perps"): under the same top row and price strip as the Flow view, a row for each of the Flow
 * history's six size bands (`BANDS`, runs of the footprint's size boxes, so every edge is exact), smallest first, each with a spot and a
 * perpetual line: the running delta of the market orders of that size. Pure (tests/app-cvd-sizes.test.mts); `panes/cvd-pane.ts` loads the
 * bars and draws it.
 *
 * - The sizes are kept only as each minute's order statistics (`TradeStats`, by the footprint recorder), so the lines are drawn from bars
 *   without rows of the instruments of the ALL VENUES lines, one question per kind, on the shortest timeframe that gives at most about two
 *   bars a pixel column (`sizeTf`). The six bands of a bar add up to its bought and sold dollars (measured on 24 hours of the local recording,
 *   to the dollar), so the rows together are the top row, at the bars' resolution.
 * - A line is drawn through the bars' ends, from zero where the window begins, and ends at the newest moment the bars hold. Where a bar holds
 *   no order statistics (a minute recorded before they were kept) the band's share is not known: the line breaks there and goes on after it
 *   from where it stood. A candle without a bar traded nothing that was recorded: the line holds flat there, as the Flow view's does.
 * - The figures beside a row are over the ranking window (ending now), as the Flow view's are: each kind's net, buys and sells, and the
 *   band's share of the volume of all six.
 */

/** The timeframes the bars may be asked on, shortest first (the footprint's). */
export const SIZE_TFS: readonly { tf: string; ms: number }[] = [
  { tf: '1m', ms: 60_000 }, { tf: '5m', ms: 300_000 }, { tf: '15m', ms: 900_000 }, { tf: '30m', ms: 1_800_000 }, { tf: '1h', ms: 3_600_000 }, { tf: '4h', ms: 14_400_000 },
];
/** The most bars a window is drawn from, per pixel column (the fewest the window gives is a bar a minute). */
export const BARS_PER_COLUMN = 2;

/**
 * The timeframe of the bars a window of `spanMs` across `columns` pixel columns is drawn from: the shortest giving at most `BARS_PER_COLUMN`
 * bars a column. Kept (`current`) while its bars stay between a quarter and one and a half times that, so a window that grows or shrinks by
 * a little (the map's span followed) does not ask for every bar again on another timeframe at every step.
 */
export function sizeTf(spanMs: number, columns: number, current: string | null = null): string {
  const most = Math.max(60, columns) * BARS_PER_COLUMN, bars = (ms: number): number => spanMs / ms;
  const target = SIZE_TFS.find(t => bars(t.ms) <= most) ?? SIZE_TFS[SIZE_TFS.length - 1]!;
  const held = current === null ? undefined : SIZE_TFS.find(t => t.tf === current);
  if (!held || held.tf === target.tf) return target.tf;
  // Finer than the target: kept until it gives half again too many. Coarser: kept until the target's bars are under a quarter of the most.
  if (held.ms < target.ms) return bars(held.ms) <= 1.5 * most ? held.tf : target.tf;
  return bars(target.ms) >= most / 4 ? held.tf : target.tf;
}

/** One kind's bars as the loader holds them: by start, and the span they were answered for ([from, to): a bar missing inside it traded nothing). */
export interface SizeBars { bars: ReadonlyMap<number, Bar>; answered: { from: number; to: number } | null }

export interface SizeInput {
  spot: SizeBars | null; perp: SizeBars | null;
  /** The bars' length. */
  tfMs: number;
  /** The window drawn, the pixel columns across it, and the page's clock (the newest moment a line can reach). */
  t0: number; t1: number; columns: number; now: number;
  /** The ranking window's length (ms, ending at `now`): the figures beside the rows are over it. */
  rankMs: number;
  /** In a replay only the bars that ended by its moment count (the one under way would hold trades from after it). */
  replay: boolean;
}

/** A band's row: its lines (spot first), its volume over the ranking window and its share of all six bands', and the bars without sizes in the window. */
export interface SizeRow { band: number; key: string; lanes: LaneLine[]; gross: number; share: number; unknown: number }
export interface SizeModel {
  t0: number; t1: number; columns: number; tfMs: number;
  rows: SizeRow[];
  /** All six bands' volume over the ranking window. */
  gross: number;
  /** The newest bar's end the lines reach, or null with none. */
  through: number | null;
}

const sumBox = (values: readonly number[], lo: number, hi: number): number => { let s = 0; for (let i = lo; i <= hi; i++) s += values[i]!; return s; };

/** The points of a band's line for one kind: time, running delta (NaN: not known there, the line breaks), from zero at the first slot. */
function bandPoints(held: SizeBars, band: number, input: SizeInput, from: number, to: number): { t: number[]; v: number[] } {
  const { tfMs } = input, [lo, hi] = BANDS[band]!, t: number[] = [], v: number[] = [], answered = held.answered;
  if (!answered) return { t, v };
  const first = Math.max(Math.floor(from / tfMs) * tfMs, Math.ceil(answered.from / tfMs) * tfMs), last = Math.min(to, answered.to);
  let run = 0, open = false;
  for (let s = first; s < last; s += tfMs) {
    const end = s + tfMs;
    if (input.replay && end > input.now) break;
    const bar = held.bars.get(s), stats = bar?.stats;
    if (bar && !stats) { if (open) { t.push(s); v.push(NaN); open = false; } continue; }
    if (!open) { t.push(Math.max(s, input.t0)); v.push(run); open = true; }
    if (stats) run += sumBox(stats.buy, lo, hi) - sumBox(stats.sell, lo, hi);
    // The bar under way ends now: its line reaches the newest moment, not the bar's end ahead of it.
    t.push(Math.min(end, input.now)); v.push(run);
    if (end > input.now) break;
  }
  return { t, v };
}

/**
 * The line's value at `time`: along the straight line between the two points around it, the point's own exactly at one, NaN outside the
 * points or across a break (a NaN point). Where two points share a time (a bar's end and the break after it), the later one counts.
 */
export function lineAt(t: readonly number[], v: readonly number[], time: number): number {
  const n = t.length;
  if (!n || !(time >= t[0]!) || time > t[n - 1]!) return NaN;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid]! <= time) lo = mid; else hi = mid - 1; }
  const a = t[lo]!, va = v[lo]!;
  if (lo === n - 1 || time === a) return va;
  const b = t[lo + 1]!, vb = v[lo + 1]!;
  if (va !== va || vb !== vb) return NaN;
  return b > a ? va + (vb - va) * (time - a) / (b - a) : vb;
}

/**
 * The line's value just before `time` (approached from the left): along the segment that reaches `time`, where two points share a time the
 * earlier one ending it (a bar's end, before the break that follows). NaN before the first point, past the last, or across a break.
 */
export function lineBefore(t: readonly number[], v: readonly number[], time: number): number {
  const n = t.length;
  if (!n || !(time >= t[0]!)) return NaN;
  if (time === t[0]!) return v[0]!;
  // The last point strictly before `time`, and the one after it.
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid]! < time) lo = mid; else hi = mid - 1; }
  if (lo === n - 1) return NaN;
  const a = t[lo]!, b = t[lo + 1]!, va = v[lo]!, vb = v[lo + 1]!;
  if (va !== va || vb !== vb) return NaN;
  return b > a ? va + (vb - va) * (time - a) / (b - a) : vb;
}

/**
 * The line of a band through `points`, sampled per pixel column as the Flow view's lanes are: the lowest, highest and last value of the line
 * over each column's stretch (the last: where it stands as the column ends, or, where it breaks or ends inside the column, its last point
 * there). NaN where the line has nothing: before its first point, from its last on, across a break.
 */
export function rasterise(points: { t: readonly number[]; v: readonly number[] }, input: Pick<SizeInput, 'columns' | 't0' | 't1'>): { lo: Float64Array; hi: Float64Array; last: Float64Array; min: number; max: number } {
  const { columns, t0, t1 } = input, span = t1 - t0, lo = new Float64Array(columns).fill(NaN), hi = new Float64Array(columns).fill(NaN), last = new Float64Array(columns).fill(NaN);
  const { t, v } = points, n = t.length;
  let min = Infinity, max = -Infinity, p = 0;
  if (!n) return { lo, hi, last, min: NaN, max: NaN };
  const first = t[0]!, end = t[n - 1]!;
  for (let c = 0; c < columns; c++) {
    const a = t0 + span * c / columns, b = t0 + span * (c + 1) / columns;
    if (b <= first || a >= end) continue;
    let l = Infinity, h = -Infinity, tail = NaN;
    const take = (x: number): void => { if (x === x) { if (x < l) l = x; if (x > h) h = x; } };
    // Where the line stands as the column starts, the points strictly inside it, and where it stands as the column ends.
    take(lineAt(t, v, a));
    while (p < n && t[p]! <= a) p++;
    for (let q = p; q < n && t[q]! < b; q++) { const x = v[q]!; take(x); if (x === x) tail = x; }
    const at = lineBefore(t, v, Math.min(b, end));
    take(at);
    const value = at === at ? at : tail;
    if (value === value && l <= h) { last[c] = value; lo[c] = l; hi[c] = h; if (l < min) min = l; if (h > max) max = h; }
  }
  return min <= max ? { lo, hi, last, min, max } : { lo, hi, last, min: NaN, max: NaN };
}

/** One kind's figures for a band over the ranking window: bought and sold dollars of the bars inside it. */
function bandFigures(held: SizeBars, band: number, input: SizeInput): { buy: number; sell: number } {
  const [lo, hi] = BANDS[band]!, from = input.now - input.rankMs;
  let buy = 0, sell = 0;
  for (const [s, bar] of held.bars) {
    if (s < from || s >= input.now || !bar.stats || (input.replay && s + input.tfMs > input.now)) continue;
    buy += sumBox(bar.stats.buy, lo, hi); sell += sumBox(bar.stats.sell, lo, hi);
  }
  return { buy, sell };
}

/** Everything the Sizes view draws besides the top row and the price strip: a row per band, each kind's line and figures. */
export function buildSizeModel(input: SizeInput): SizeModel {
  const { t0, t1, columns, tfMs } = input, through: number[] = [];
  const kinds: [Kind, SizeBars | null][] = [['spot', input.spot], ['perp', input.perp]];
  const rows: SizeRow[] = BANDS.map((_, band) => {
    let gross = 0, unknown = 0;
    const lanes = kinds.flatMap(([kind, held]): LaneLine[] => {
      if (!held || !held.bars.size) return [];
      const points = bandPoints(held, band, input, t0, t1), line = rasterise(points, input), { buy, sell } = bandFigures(held, band, input);
      if (band === 0) { const end = points.t[points.t.length - 1]; if (end !== undefined) through.push(end); for (const [s, bar] of held.bars) if (!bar.stats && s + tfMs > t0 && s < t1) unknown++; }
      gross += buy + sell;
      return [{ id: `size${band}`, kind, series: null, ...line, before: 0, delta: buy - sell, gross: buy + sell, buy, sell, quiet: false }];
    });
    return { band, key: `size${band}`, lanes, gross, share: 0, unknown };
  });
  // Bars without sizes are the same for every band (the bar has no statistics at all): counted once, on the first band, said on each.
  const unknown = rows[0]?.unknown ?? 0, gross = rows.reduce((s, r) => s + r.gross, 0);
  for (const row of rows) { row.unknown = unknown; row.share = gross > 0 ? row.gross / gross : 0; }
  return { t0, t1, columns, tfMs, rows, gross, through: through.length ? Math.max(...through) : null };
}

/** The bars' timeframe in words for the hover ("1-minute bars"). */
export const tfMinutes = (tfMs: number): number => Math.round(tfMs / 60_000);
