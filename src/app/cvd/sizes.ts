import type { Bar } from '../panes/footprint.ts';
import type { Kind } from '../scope.ts';
import { BANDS, bandLabel } from '../size-history/model.ts';
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
 * - A line is drawn through the bars' ends, from zero where the window begins (or at the first bar held, where that is later: before the
 *   recording a line has nothing to say), and ends at the newest moment the bars hold. Where a bar holds
 *   no order statistics (a minute recorded before they were kept) the band's share is not known: the line breaks there and goes on after it
 *   from where it stood. A candle without a bar traded nothing that was recorded: the line holds flat there, as the Flow view's does.
 * - The figures beside a row are over the ranking window (ending now), as the Flow view's are: each kind's net, buys and sells, and the
 *   band's share of the volume of all six, read from minutes of their own (`SizeInput.figures`) whatever the timeframe drawn, the minute the
 *   window starts in counted for its part (review 2026-11-25: counted by whole bars of the timeframe drawn, an hour's figures on half-hour
 *   bars covered 31 to 60 minutes, and on bars as long as the window none).
 * - In coins (the page's units, units.ts) the lines and the figures are the coin's, as the top row's are: each bar's dollars of a band over
 *   the price at the middle of the stretch it traded over (`SizeInput.coins`, the price strip's own price), added up after that. The bars keep
 *   no price of their own (their trades only by size), so a long bar's coins are as close as its trades were to that price; the figures,
 *   read from minutes, are close to exact. A bar whose price is not known is not known in coins either: the line breaks there, as at a bar
 *   without sizes, and a figure it traded in is not known (a dash, never a sum short of it). The share and the band names ($25K–100K, the
 *   boxes' edges) stay the dollars'.
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
  // Finer than the target: kept until it gives half again too many. Coarser: kept while its own bars are a quarter of the most or more (a
  // finer target is there as soon as it fits, so going back up waits for half again too many: no timeframe flips at the edge of the band).
  if (held.ms < target.ms) return bars(held.ms) <= 1.5 * most ? held.tf : target.tf;
  return bars(held.ms) >= most / 4 ? held.tf : target.tf;
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
  /** The bars the figures are read from (minutes over the ranking window, `tfMs` theirs); absent, or a kind's null (not answered yet): the bars drawn. */
  figures?: { spot: SizeBars | null; perp: SizeBars | null; tfMs: number };
  /** In a replay only the bars that ended by its moment count (the one under way would hold trades from after it). */
  replay: boolean;
  /**
   * The page writes sizes in coins: the lines are drawn in the coin, and each lane carries its figures in coins (`LaneLine.coins`) beside its
   * dollars, each bar valued at `priceAt` (ms; NaN where no price is known) the middle of the stretch it traded over. Absent: dollars.
   */
  coins?: { priceAt: (t: number) => number };
}

/**
 * A band's row: its sizes' name, its lines (spot first), its volume over the ranking window and its share of all six bands' (dollars), and the
 * bars without sizes in the window. `coins`: what it traded in coins, on a model built with `SizeInput.coins` (what its label writes then).
 */
export interface SizeRow { band: number; key: string; label: string; lanes: LaneLine[]; gross: number; share: number; unknown: number; coins?: { gross: number } }
export interface SizeModel {
  t0: number; t1: number; columns: number; tfMs: number;
  rows: SizeRow[];
  /** All six bands' volume over the ranking window. */
  gross: number;
  /** The newest bar's end the lines reach, or null with none. */
  through: number | null;
}

const sumBox = (values: readonly number[], lo: number, hi: number): number => { let s = 0; for (let i = lo; i <= hi; i++) s += values[i]!; return s; };

/** A bar's price in coins (`SizeInput.coins`): at the middle of the stretch it traded over (the bar under way: up to now). */
type PriceOf = (start: number, tfMs: number) => number;
/** Each bar's price, looked up once a model for all six bands (null in dollars). */
function pricer(input: SizeInput): PriceOf | null {
  const at = input.coins?.priceAt;
  if (!at) return null;
  const byTf = new Map<number, Map<number, number>>();
  return (start, tfMs) => {
    let held = byTf.get(tfMs);
    if (!held) { held = new Map(); byTf.set(tfMs, held); }
    let price = held.get(start);
    if (price === undefined) { price = at((start + Math.min(start + tfMs, input.now)) / 2); held.set(start, price); }
    return price;
  };
}

/**
 * The points of a band's line for one kind: time, running delta (NaN: not known there, the line breaks), from zero at the first slot, which is
 * the first bar held (`firstBar`) where the window starts before it: before the recording, or before anything traded, the line has nothing to
 * say, as the top row starts where the flow does (review 2026-11-25: every line was drawn flat from the left edge there). With `priceOf`, in
 * coins: a bar's delta over its price, a bar without one not known.
 */
function bandPoints(held: SizeBars, band: number, input: SizeInput, from: number, to: number, firstBar: number, priceOf: PriceOf | null): { t: number[]; v: number[] } {
  const { tfMs } = input, [lo, hi] = BANDS[band]!, t: number[] = [], v: number[] = [], answered = held.answered;
  if (!answered || !Number.isFinite(firstBar)) return { t, v };
  const first = Math.max(Math.floor(from / tfMs) * tfMs, Math.ceil(answered.from / tfMs) * tfMs, firstBar), last = Math.min(to, answered.to);
  let run = 0, open = false;
  for (let s = first; s < last; s += tfMs) {
    const end = s + tfMs;
    if (input.replay && end > input.now) break;
    const bar = held.bars.get(s), stats = bar?.stats, price = stats && priceOf ? priceOf(s, tfMs) : 1;
    if (bar && (!stats || !(price > 0))) { if (open) { t.push(s); v.push(NaN); open = false; } continue; }
    if (!open) { t.push(Math.max(s, input.t0)); v.push(run); open = true; }
    if (stats) run += (sumBox(stats.buy, lo, hi) - sumBox(stats.sell, lo, hi)) / price;
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

/**
 * One kind's figures for a band over the ranking window [now - rankMs, now): bought and sold dollars of the bars (`tfMs` long) inside it, the
 * bar the window starts in for its part of it (its trades taken as spread evenly over it), none after now (in a replay, none still under way).
 * With `priceOf`, the same in coins beside them (each bar over its price), NaN where a bar that traded in the band has no price (review
 * 2026-11-27: left out, a lane priced nowhere read "0 BTC").
 */
function bandFigures(held: SizeBars, band: number, input: SizeInput, tfMs: number, priceOf: PriceOf | null): { buy: number; sell: number; coins: { buy: number; sell: number } | null } {
  const [lo, hi] = BANDS[band]!, from = input.now - input.rankMs;
  let buy = 0, sell = 0, coinBuy = 0, coinSell = 0;
  for (const [s, bar] of held.bars) {
    if (s + tfMs <= from || s >= input.now || !bar.stats || (input.replay && s + tfMs > input.now)) continue;
    const part = s < from ? (s + tfMs - from) / tfMs : 1, b = part * sumBox(bar.stats.buy, lo, hi), sl = part * sumBox(bar.stats.sell, lo, hi);
    buy += b; sell += sl;
    if (priceOf && b + sl > 0) { const price = priceOf(s, tfMs); coinBuy += price > 0 ? b / price : Number.NaN; coinSell += price > 0 ? sl / price : Number.NaN; }
  }
  return { buy, sell, coins: priceOf ? { buy: coinBuy, sell: coinSell } : null };
}

/** The first bar held from `from` on (Infinity: none). */
function firstHeld(held: SizeBars, from: number): number {
  let first = Infinity;
  for (const s of held.bars.keys()) if (s >= from && s < first) first = s;
  return first;
}

/** Everything the Sizes view draws besides the top row and the price strip: a row per band, each kind's line and figures. */
export function buildSizeModel(input: SizeInput): SizeModel {
  const { t0, t1, columns, tfMs } = input, through: number[] = [];
  // Each kind's bars drawn, the bars its figures are read from (its minutes, else the bars drawn) and their length.
  const kinds: [Kind, SizeBars | null, SizeBars | null, number][] = (['spot', 'perp'] as const).map(kind => {
    const counted = input.figures?.[kind] ?? null;
    return [kind, input[kind], counted ?? input[kind], counted ? input.figures!.tfMs : tfMs];
  });
  // Where each kind's lines start: its first bar held in the window (the slot the window starts in, or later).
  const starts = kinds.map(([, held]) => held ? firstHeld(held, Math.floor(t0 / tfMs) * tfMs) : Infinity);
  const priceOf = pricer(input);
  const rows: SizeRow[] = BANDS.map((_, band) => {
    let gross = 0, unknown = 0, coinGross = 0;
    const lanes = kinds.flatMap(([kind, held, counted, countedMs], k): LaneLine[] => {
      if (!held || !held.bars.size) return [];
      const points = bandPoints(held, band, input, t0, t1, starts[k]!, priceOf), line = rasterise(points, input);
      const { buy, sell, coins } = counted ? bandFigures(counted, band, input, countedMs, priceOf) : { buy: 0, sell: 0, coins: priceOf ? { buy: 0, sell: 0 } : null };
      // A bar without sizes, counted once (on the first band); a bar whose price is not known breaks the line in coins too, but has its sizes.
      if (band === 0) { const end = points.t[points.t.length - 1]; if (end !== undefined) through.push(end); for (const [s, bar] of held.bars) if (!bar.stats && s + tfMs > t0 && s < t1) unknown++; }
      gross += buy + sell;
      const lane: LaneLine = { id: `size${band}`, kind, series: null, ...line, before: 0, delta: buy - sell, gross: buy + sell, buy, sell, quiet: false };
      if (coins) { lane.coins = { delta: coins.buy - coins.sell, gross: coins.buy + coins.sell, buy: coins.buy, sell: coins.sell }; coinGross += coins.buy + coins.sell; }
      return [lane];
    });
    return { band, key: `size${band}`, label: bandLabel(band), lanes, gross, share: 0, unknown, ...(priceOf ? { coins: { gross: coinGross } } : {}) };
  });
  // Bars without sizes are the same for every band (the bar has no statistics at all): counted once, on the first band, said on each.
  const unknown = rows[0]?.unknown ?? 0, gross = rows.reduce((s, r) => s + r.gross, 0);
  for (const row of rows) { row.unknown = unknown; row.share = gross > 0 ? row.gross / gross : 0; }
  return { t0, t1, columns, tfMs, rows, gross, through: through.length ? Math.max(...through) : null };
}
