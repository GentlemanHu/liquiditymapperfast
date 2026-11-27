import { volText, type Bar } from './footprint.ts';
import type { CandleRow, OiBar } from '../store.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { SIZE_EDGES } from '../../shared/footprint.ts';
import { scaledUsd, sizeScale } from '../coin.ts';
import { overFromBoxes } from '../sizes.ts';
import type { StatOptions } from '../stat-options.ts';
import { t } from '../i18n.ts';
import type { InfoLine } from '../infobox.ts';
import { oiDeltaByTime } from '../oi-change.ts';
import { windowsOf } from '../keylevels/levels.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import { coinText, inCoins, unitName } from '../units.ts';

/**
 * Per-candle statistics, the Bar stats table under the map. Each definition computes one number per candle from the executions recorded
 * for it (buy and sell USD by price row, trade counts and size buckets), the candle itself and the open-interest bar of the same period.
 * The table shows the stats the user enabled, in the order chosen; adding a statistic means adding one entry here.
 *
 * In coins (`StatInput.coins`, the page's units: units.ts, issue 9) a size is each part's dollars over the price that part traded at, added up
 * after converting: vol, delta, cvd, buy and sell vol from the bar's price rows where it has them, each row at its middle (`low + step / 2`,
 * so to within half a row of where it traded), and from a bar without rows (the table's usual bar since 2026-11-25, `reads`) its dollars at
 * its candle's typical price; max buy and max sell the largest row in coins, each at its own price; candle delta, vol / bp and avg fill read the
 * exchange's candle natively (its volume and taker buys are in the coin); liq and liq Δ each liquidation's dollars over its reported price;
 * oi chg is the open interest's own change, in the coin whatever the OI change option. The size boxes keep only dollars, so avg order, avg buy,
 * avg sell and the retail and whale deltas (and cvds) are converted at the bar's volume-weighted price from its rows (where a bar has no rows,
 * its candle's typical price): an approximation, as close as the bar's orders are to its average price. delta % is the share of the coin amounts
 * it is written beside (so the two agree in sign); other shares, ratios, counts and prices stay as they are, and what decides (the imbalance
 * minimum, the retail and whale sizes, the order of the rows) keeps reading dollars. Nothing in coins is worked out in dollars mode. A bar
 * without rows whose candle the chart's market lacks takes the close of the one before (within two hours of its end, `barPrice`); one older than the
 * chart's candles (it holds its newest 500) has no figure in coins: a running sum from the view starts after such bars and is not known from
 * a later one, and with CVD from each day's start the running sums read rows in coins, as their bars reach back past the candles.
 */
export type { StatOptions } from '../stat-options.ts';
export { DEFAULT_STAT_OPTIONS } from '../stat-options.ts';

/** The size buckets' names, from their notional USD edges ("< $25K", "$25K-50K" … "$5M+" for BTC; a coin with smaller floors has smaller edges). */
export function sizeBucketLabels(): string[] {
  const edge = (i: number): string => usd(scaledUsd(SIZE_EDGES[i]!)), last = SIZE_EDGES.length - 1;
  return SIZE_EDGES.map((_, i) => i === 0 ? `< $${edge(1)}` : i === last ? `$${edge(i)}+` : `$${edge(i)}-${edge(i + 1)}`);
}

export interface StatInput {
  /**
   * One slot per candle, oldest first: its executions' bar, or null where none was recorded (before the recording, or a gap). Stats that
   * accumulate (cvd) sum over exactly these.
   */
  bars: readonly (Bar | null)[];
  /** Each slot's candle start, where a slot has no bar; the bar's own start when absent. */
  times?: readonly number[];
  /** The candle length and the page's clock (a candle under way is measured against what of it has passed); coverage needs both. */
  tfMs?: number;
  now?: number;
  /** The exchange's own candles with their taker buys (index 7), by start (Binance reports them); absent elsewhere. */
  taker?: ReadonlyMap<number, CandleRow>;
  /**
   * Liquidations reported on the markets counted, by candle start: shorts liquidated (forced buys) and longs liquidated (forced sells), USD, 0 in
   * a candle the loaded window covers with none; `cut` when the source answered only its largest. Absent where the source has none. `buyCoin`
   * and `sellCoin`: the same in coins, each liquidation's dollars over its reported price (`liquidationBuckets` gives both).
   */
  liquidations?: { buy: ReadonlyMap<number, number>; sell: ReadonlyMap<number, number>; buyCoin?: ReadonlyMap<number, number>; sellCoin?: ReadonlyMap<number, number>; cut: boolean; cutStarts?: ReadonlySet<number> };
  /** The sizes in coins (the page's units, units.ts), each part at its own price; dollars when absent or false. */
  coins?: boolean;
  /** Where the running sums start again: a key per slot (the start of its day), a new key a new start. Absent: they run from the first slot. */
  restart?: readonly number[];
  /** Price step of the loaded rows. */
  step: number;
  candles: ReadonlyMap<number, CandleRow>;
  oi: ReadonlyMap<number, OiBar>;
  /** Each bar's change of open interest by time, as the OI pane counts it (oi-change.ts `oiChangeByTime`); from `oi` when absent. */
  oiChange?: ReadonlyMap<number, number>;
  /** The same in USD (oi-change.ts `oiUsdChangeByTime`: an inverse market's in its own USD); from the change times the close when absent. */
  oiUsd?: ReadonlyMap<number, number>;
  /** Whether the executions counted include a perpetual's (false: spot markets alone, which have no open interest); unknown when absent. */
  perps?: boolean;
  options: StatOptions;
  /** The size lines the bars were loaded with (the coin's USD, see `FootprintData.cuts`): a bar's `over` holds their sums. */
  cuts?: readonly number[];
}
export type StatScale = 'sequential' | 'diverging' | 'plain' | 'category';
export type StatGroup = 'volume' | 'footprint' | 'trades' | 'market';
export type StatTone = 'buy' | 'sell' | 'text';
/** A figure of the View column: the statistic over the candles in view, and how it was taken from them. */
export interface ViewCell { value: string; tone: StatTone; how: string }
export interface StatDef {
  id: string;
  label: string;
  group: StatGroup;
  /** One line shown as a tooltip and in the configuration list (`statTitle` says it in the page's units). */
  title: string;
  /** The line in coins where `title` names dollars (asked where it is shown: the units are the page's at that moment). */
  coinTitle?: () => string;
  /**
   * sequential: pale to strong by magnitude; diverging: the theme's falling / rising candle colours by sign around `center`; plain: no colour scale; category: a mark per
   * candle (`format` says it, `tone` colours it), empty where the value is 0.
   */
  scale: StatScale;
  /** Value the diverging scale is centred on (0 unless the stat is a share around 50 %). */
  center?: number;
  format: (value: number) => string;
  /** A category's colour: the side its mark stands for, or null for none. */
  tone?: (value: number) => StatTone | null;
  /** One value per slot, in the order of `input.bars`; null when it cannot be computed for that candle. */
  compute: (input: StatInput) => (number | null)[];
  /** Whether some bar's value was taken at the nearest box edge rather than at the size set (the row then says ≈). */
  approx?: (input: StatInput) => boolean;
  /** What ≈ means for this row, where it is not the size boxes. */
  approxNote?: () => string;
  /** What it is read from: the executions recorded (absent before the recording, faded where a candle was recorded in part), or the candles and open interest. */
  source: 'executions' | 'market';
  /**
   * What of a bar it reads beyond its order statistics, minutes and size-line sums (2026-11-25): `rows`, its price rows; `parts`, each row's
   * markets; `totals`, its bought and sold dollars. The table reads the bars without rows (a week of many markets in one quick answer, as the
   * Flow history does) and the footprint's rows only for a statistic that reads rows or parts, and for `totals` from a source that sends no
   * dollars without rows (an older server), so one such statistic never holds up the others. In coins a bar without rows is priced by its
   * candle (`barPrice`), so a running sum from each day's start reads rows there (`readsRows`).
   */
  reads?: 'rows' | 'parts' | 'totals';
  /** A running sum (cvd and its retail and whale kinds): with CVD from each day's start, its bars are read from the start of the day the view begins in. */
  running?: true;
  /** The View column's figure for the visible slots `at`, from the row's `values`; none when absent or null. */
  view?: (input: StatInput, at: readonly number[], values: readonly (number | null)[]) => ViewCell | null;
  /** Its column in Export CSV when the number as computed is not what it means (a logarithm): the column's name and its cell. */
  csv?: { head: string; cell: (value: number) => string };
}

/** A statistic's cell in Export CSV: a category's mark, else its number as computed (or as its `csv` says), empty where it has none. */
export function csvCell(def: StatDef, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return def.csv ? def.csv.cell(value) : def.scale === 'category' ? def.format(value) : String(value);
}

/** What a statistic is, in the page's units: its coin line in coins where it has one. */
export const statTitle = (def: StatDef): string => inCoins() && def.coinTitle ? def.coinTitle() : def.title;
/** The statistics whose figures are sizes: dollars, or in coins the coin (the open interest's change is the coin's in coins whatever its option). */
export const SIZE_STATS: ReadonlySet<string> = new Set(['vol', 'delta', 'cvd', 'buyVol', 'sellVol', 'takerDelta', 'maxBuy', 'maxSell', 'avgTrade', 'avgBuy', 'avgSell', 'avgFill', 'deltaRetail', 'deltaWhales', 'cvdRetail', 'cvdWhales', 'effort', 'liq', 'liqNet', 'oiChange']);
/** A statistic's column head in Export CSV: as it always was in dollars; in coins a size's head names the coin ("vol_BTC"). */
export const csvHead = (def: StatDef): string => { const head = def.csv?.head ?? def.id; return inCoins() && SIZE_STATS.has(def.id) ? `${head}_${unitName()}` : head; };

/** The kinds' names on the table's headers (the panel's are longer). */
export const GROUP_SHORT: Readonly<Record<StatGroup, string>> = { volume: t('Volume'), footprint: t('Footprint rows'), trades: t('Trades'), market: t('Candle, OI and liquidations') };
/** The start of the day `t` falls in, in `zone` (where the running sums start again, from each day's start). */
export const dayStartOf = (t: number, zone: string): number => windowsOf('day', zone, t, t + 1)[0]?.from ?? t;

export const GROUP_TITLES: Readonly<Record<StatGroup, string>> = {
  volume: t('Volume'), footprint: t('Footprint rows'), trades: t('Trades (recorded since the server started recording them)'), market: t('Candle, open interest and liquidations'),
};

/** A size as the cells write it: the footprint's figures in dollars (`volText`), three significant figures in coins (units.ts `coinText`). */
export const vol = (value: number): string => inCoins() ? coinText(value) : volText(value);
export const signedVol = (value: number): string => (value < 0 ? '-' : '') + vol(Math.abs(value));
const signedPct = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const pctText = (value: number): string => `${Math.round(value)}%`;
const signedPrice = (value: number): string => `${value > 0 ? '+' : value < 0 ? '-' : ''}${fmtPrice(Math.abs(value))}`;
const total = (bar: Bar): number => bar.buyUsd + bar.sellUsd;
const count = (value: number): string => String(Math.round(value));
const clampPct = (value: number): number => Math.min(100, Math.max(0, value));
/** A candle's dollars: its volume at its typical price, as the volume strip and the candle-based profiles value it. */
const candleUsd = (c: CandleRow): number => c[5] > 0 && c[3] > 0 ? c[5] * (c[2] + c[3] + c[4]) / 3 : 0;

/**
 * A bar's market orders in coins from its price rows (each row's dollars over the price in its middle, then added up) and the dollars they
 * hold, with its largest buy and sell rows in coins (max buy and max sell in coins are the largest in coins). Kept per bar and row step: a bar
 * is never changed in place.
 */
interface BarCoins { step: number; buy: number; sell: number; usd: number; maxBuy: number; maxSell: number }
const coinsHeld = new WeakMap<Bar, BarCoins>();
function barCoins(bar: Bar, step: number): BarCoins {
  const held = coinsHeld.get(bar);
  if (held && held.step === step) return held;
  let buy = 0, sell = 0, usd = 0, maxBuy = 0, maxSell = 0;
  for (const [low, b, s] of bar.rows) {
    const mid = low + step / 2; if (!(mid > 0)) continue;
    buy += b / mid; sell += s / mid; usd += b + s;
    maxBuy = Math.max(maxBuy, b / mid); maxSell = Math.max(maxSell, s / mid);
  }
  const made = { step, buy, sell, usd, maxBuy, maxSell };
  coinsHeld.set(bar, made);
  return made;
}
/** How long after the candle before ends a bar without its candle still takes that close (the flow's coins carry a price as far, units.ts). */
export const PRICE_CARRY_MS = 2 * 3_600_000;
/** Each candle map's starts, oldest first, worked out once a map (a table builds its map once). */
const startsHeld = new WeakMap<ReadonlyMap<number, CandleRow>, number[]>();
/**
 * The close of the last candle that started before `t`, where it ended (its start and `tfMs`) no more than `PRICE_CARRY_MS` before `t`;
 * NaN with none (review round 5: counted from its start, a 4h or daily chart never carried a close to the next slot).
 */
function closeBefore(candles: ReadonlyMap<number, CandleRow>, t: number, tfMs: number): number {
  let starts = startsHeld.get(candles);
  if (!starts) { starts = [...candles.keys()].sort((a, b) => a - b); startsHeld.set(candles, starts); }
  let lo = 0, hi = starts.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid]! < t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  if (at < 0 || t - (starts[at]! + tfMs) > PRICE_CARRY_MS) return Number.NaN;
  const close = candles.get(starts[at]!)![4];
  return close > 0 ? close : Number.NaN;
}
/**
 * The price a bar's orders are valued at where only their dollars are known (the size boxes): the bar's volume-weighted price from its rows,
 * else its candle's typical price, else, where the chart's market has no candle for it (it traded nothing there: some venues send no empty
 * candles), the close of the candle before it, as the price stood, within `PRICE_CARRY_MS` (review 2026-11-27); NaN where none is known
 * (a bar older than the chart's candles: it holds its newest 500).
 */
export function barPrice(input: Pick<StatInput, 'step' | 'candles' | 'tfMs'>, bar: Bar): number {
  const c = barCoins(bar, input.step);
  if (c.buy + c.sell > 0) return c.usd / (c.buy + c.sell);
  const k = input.candles.get(bar.t);
  return k && k[3] > 0 ? (k[2] + k[3] + k[4]) / 3 : closeBefore(input.candles, bar.t, input.tfMs ?? 0);
}
/** A bar's dollar figure in the input's units: as it is in dollars; in coins at the bar's price (`barPrice`), null where that is not known. */
function inBarUnits(input: StatInput, bar: Bar, usd: number): number | null {
  if (!input.coins || usd === 0) return usd;
  const p = barPrice(input, bar);
  return p > 0 ? usd / p : null;
}
/** A bar's market buys and sells in the input's units: its dollars, or in coins each price row at its middle (a bar without rows: at its candle's typical price). */
function sidesOf(input: StatInput, bar: Bar): { buy: number; sell: number } | null {
  if (!input.coins) return { buy: bar.buyUsd, sell: bar.sellUsd };
  if (bar.rows.length) { const c = barCoins(bar, input.step); return { buy: c.buy, sell: c.sell }; }
  if (!(total(bar) > 0)) return { buy: 0, sell: 0 };
  const p = barPrice(input, bar);
  return p > 0 ? { buy: bar.buyUsd / p, sell: bar.sellUsd / p } : null;
}
const volumeOf = (input: StatInput, bar: Bar): number | null => { const s = sidesOf(input, bar); return s ? s.buy + s.sell : null; };
/** A bar's delta (buys less sells) in the input's units. */
export const barDelta = (input: StatInput, bar: Bar): number | null => { const s = sidesOf(input, bar); return s ? s.buy - s.sell : null; };

/** A slot's candle start. */
export const slotTime = (input: Pick<StatInput, 'bars' | 'times'>, i: number): number => input.times?.[i] ?? input.bars[i]?.t ?? NaN;
/** Each slot's value from its bar, null where none was recorded. */
const perBar = (input: StatInput, value: (bar: Bar, i: number) => number | null): (number | null)[] => input.bars.map((bar, i) => bar ? value(bar, i) : null);
/** Each slot's value from its candle, null where the chart has none. */
const perCandle = (input: StatInput, value: (c: CandleRow, i: number) => number | null): (number | null)[] =>
  input.bars.map((_, i) => { const c = input.candles.get(slotTime(input, i)); return c ? value(c, i) : null; });

/** The price of a bar's busiest row (its middle), null for a bar without rows. */
export function pocOf(rows: Bar['rows'], step: number): number | null {
  let best = -1, price: number | null = null;
  for (const [low, buy, sell] of rows) if (buy + sell > best) { best = buy + sell; price = low + step / 2; }
  return price;
}

/**
 * The share of a candle the recording holds, 0 to 1: its minutes with trades recorded (on any of the markets counted) over its length, or
 * over what of it has passed while it is under way; null where the source does not say.
 */
export function coverageOf(bar: Bar, start: number, tfMs: number, now: number): number | null {
  if (bar.minutes === undefined || !(tfMs > 0)) return null;
  const minutes = Math.max(1, Math.ceil((Math.min(now, start + tfMs) - start) / 60_000));
  return Math.min(1, bar.minutes / minutes);
}

/** A row's values at the visible slots, those there are. */
const seen = (at: readonly number[], values: readonly (number | null)[]): number[] => at.flatMap(i => { const v = values[i]; return v === null || v === undefined ? [] : [v]; });
/** A signed figure's tone: zero leans to neither side (it was the buy colour). */
const signTone = (value: number): StatTone => value > 0 ? 'buy' : value < 0 ? 'sell' : 'text';
const sumView = (format: (v: number) => string, signed: boolean) => (_input: StatInput, at: readonly number[], values: readonly (number | null)[]): ViewCell | null => {
  const found = seen(at, values); if (!found.length) return null;
  const sum = found.reduce((a, b) => a + b, 0);
  return { value: format(sum), tone: signed ? signTone(sum) : 'text', how: t('The sum of the candles in view.') };
};
const maxView = (format: (v: number) => string) => (_input: StatInput, at: readonly number[], values: readonly (number | null)[]): ViewCell | null => {
  const found = seen(at, values); return found.length ? { value: format(Math.max(...found)), tone: 'text', how: t('The largest of the candles in view.') } : null;
};
/** A running sum's figure is its newest: it already adds up every candle loaded (or those of its day). */
const lastView = (format: (v: number) => string) => (input: StatInput, at: readonly number[], values: readonly (number | null)[]): ViewCell | null => {
  const found = seen(at, values); if (!found.length) return null;
  const last = found[found.length - 1]!;
  return { value: format(last), tone: signTone(last), how: input.restart ? t('The newest candle in view: the running sum from the start of its day.') : t('The newest candle in view: the running sum already adds up the candles loaded.') };
};
/** Two sums over the visible bars put against each other, as the statistic puts them for one bar. */
const ratioView = (format: (v: number) => string, tone: (v: number) => StatTone, ratio: (bars: Bar[], input: StatInput) => number | null) => (input: StatInput, at: readonly number[]): ViewCell | null => {
  const value = ratio(at.flatMap(i => { const bar = input.bars[i]; return bar ? [bar] : []; }), input);
  return value === null || !Number.isFinite(value) ? null : { value: format(value), tone: tone(value), how: t('Worked out from the candles in view added together.') };
};
/** A category's figure: the mark seen most among the candles in view, and on how many. */
const markView = (def: () => StatDef) => (_input: StatInput, at: readonly number[], values: readonly (number | null)[]): ViewCell | null => {
  const counts = new Map<number, number>();
  for (const v of seen(at, values)) if (def().format(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let top: number | null = null, most = 0;
  for (const [v, n] of counts) if (n > most) { most = n; top = v; }
  return top === null ? null : { value: `${def().format(top)} ${most}`, tone: def().tone?.(top) ?? 'text', how: t('The mark seen most among the candles in view, and on how many of them.') };
};
/** The visible candles' range: their highest high and lowest low, with the first open and the last close; their dollars and their volume (the coin's). */
function viewCandle(input: StatInput, at: readonly number[]): { open: number; high: number; low: number; close: number; usd: number; vol: number } | null {
  let open = NaN, high = -Infinity, low = Infinity, close = NaN, usd = 0, vol = 0;
  for (const i of at) {
    const c = input.candles.get(slotTime(input, i)); if (!c) continue;
    if (Number.isNaN(open)) open = c[1];
    high = Math.max(high, c[2]); low = Math.min(low, c[3]); close = c[4]; usd += candleUsd(c);
    if (input.coins && candleUsd(c) > 0) vol += c[5];
  }
  return Number.isNaN(open) ? null : { open, high, low, close, usd, vol };
}
/** The point of control of the visible bars' rows added together. */
function viewPoc(input: StatInput, at: readonly number[]): number | null {
  const rows = new Map<number, [number, number, number]>();
  for (const i of at) for (const [low, buy, sell] of input.bars[i]?.rows ?? []) {
    const k = Math.round(low / input.step), row = rows.get(k);
    if (row) { row[1] += buy; row[2] += sell; } else rows.set(k, [low, buy, sell]);
  }
  return rows.size ? pocOf([...rows.values()], input.step) : null;
}
const orderUsd = (stats: NonNullable<Bar['stats']>): number => sumBuckets(stats.buy, 0, 7) + sumBuckets(stats.sell, 0, 7);
/** The market orders of some bars added together: the dollars of their size buckets and their counts, buys and sells (bars without trade statistics left out). */
export function orderPool(bars: readonly Bar[]): { buyUsd: number; sellUsd: number; buyN: number; sellN: number } {
  let buyUsd = 0, sellUsd = 0, buyN = 0, sellN = 0;
  for (const b of bars) if (b.stats) { buyUsd += sumBuckets(b.stats.buy, 0, 7); sellUsd += sumBuckets(b.stats.sell, 0, 7); buyN += b.stats.buyN; sellN += b.stats.sellN; }
  return { buyUsd, sellUsd, buyN, sellN };
}
/** `orderPool` in the input's units: in coins each bar's dollars at its price (`barPrice`), a bar whose price is not known left out (its orders too). */
export function orderPoolIn(bars: readonly Bar[], input: StatInput): { buyUsd: number; sellUsd: number; buyN: number; sellN: number } {
  if (!input.coins) return orderPool(bars);
  let buyUsd = 0, sellUsd = 0, buyN = 0, sellN = 0;
  for (const b of bars) {
    const p = b.stats ? barPrice(input, b) : NaN;
    if (!b.stats || !(p > 0)) continue;
    buyUsd += sumBuckets(b.stats.buy, 0, 7) / p; sellUsd += sumBuckets(b.stats.sell, 0, 7) / p; buyN += b.stats.buyN; sellN += b.stats.sellN;
  }
  return { buyUsd, sellUsd, buyN, sellN };
}

/** A bar's buys and sells by market, from its rows' parts; null for a bar without them (one market, or a source that does not say). */
function venueSums(bar: Bar, into = new Map<string, [number, number]>()): Map<string, [number, number]> | null {
  if (!bar.parts) return null;
  for (const row of bar.parts) for (const [id, buy, sell] of row) { const sums = into.get(id); if (sums) { sums[0] += buy; sums[1] += sell; } else into.set(id, [buy, sell]); }
  return into;
}
/** The share (%) of the volume on markets whose own delta has the sign of the total; null with fewer than two markets or no delta at all. */
export function agreement(by: ReadonlyMap<string, readonly [number, number]>): number | null {
  let delta = 0, all = 0, same = 0;
  for (const [buy, sell] of by.values()) { delta += buy - sell; all += buy + sell; }
  if (by.size < 2 || !(all > 0) || delta === 0) return null;
  for (const [buy, sell] of by.values()) if (Math.sign(buy - sell) === Math.sign(delta)) same += buy + sell;
  return same / all * 100;
}
/** A slot's liquidations, shorts liquidated and longs liquidated, in the input's units; null where the loaded window does not cover it. */
const liquidated = (input: StatInput, i: number): [number, number] | null => {
  const start = slotTime(input, i), l = input.liquidations, buy = (input.coins ? l?.buyCoin : l?.buy)?.get(start), sell = (input.coins ? l?.sellCoin : l?.sell)?.get(start);
  return buy === undefined || sell === undefined ? null : [buy, sell];
};
const liquidationNote = (): string => t('≈ A day of these candles held more than 5,000 liquidations: only its largest 5,000 are counted.');

/** One UTC day of liquidations as the source answered it: every one it keeps up to `to` (the day's end, or the moment it was asked while the day ran), or its largest 5,000 (`cut`). */
export interface LiquidationDay { rows: readonly Liquidation[]; cut: boolean; to: number }
export const DAY_MS = 86_400_000;

/**
 * Liquidations of `ids` by candle start: shorts liquidated (forced buys) and longs liquidated (forced sells), USD, and with `coins` the same in
 * coins (`buyCoin`, `sellCoin`: each liquidation's dollars over the price it was reported at, then added up; units.ts). A candle counts (0 where
 * none) where its UTC day is answered over all of it (the candle under way at `now`: over its start, and as far as the answer reaches) and
 * the record reaches back to it (`coverFrom`: the source's retention, and only since the recording started); `cut` where one of those days
 * held more than the source answers.
 */
export function liquidationBuckets(days: ReadonlyMap<number, LiquidationDay>, ids: readonly string[], times: readonly number[], tfMs: number, coverFrom: number, now: number, coins = false): NonNullable<StatInput['liquidations']> & { buyCoin?: Map<number, number>; sellCoin?: Map<number, number> } {
  const buy = new Map<number, number>(), sell = new Map<number, number>(), wanted = new Set(ids), used = new Set<number>(), cutStarts = new Set<number>();
  const buyCoin = coins ? new Map<number, number>() : null, sellCoin = coins ? new Map<number, number>() : null;
  let cut = false;
  for (const start of times) {
    const day = Math.floor(start / DAY_MS) * DAY_MS, held = days.get(day);
    if (!held || start < coverFrom || !(start + tfMs <= held.to || (start < held.to && start + tfMs > now))) continue;
    buy.set(start, 0); sell.set(start, 0); buyCoin?.set(start, 0); sellCoin?.set(start, 0); used.add(day); if (held.cut) { cut = true; cutStarts.add(start); }
  }
  for (const day of used) for (const l of days.get(day)!.rows) {
    if (!wanted.has(l.id)) continue;
    const start = Math.floor(l.t / tfMs) * tfMs, side = l.side === 'short' ? buy : sell, sum = side.get(start);
    if (sum !== undefined) side.set(start, sum + l.usd);
    if (buyCoin && sellCoin && l.reported > 0) { const into = l.side === 'short' ? buyCoin : sellCoin, held = into.get(start); if (held !== undefined) into.set(start, held + l.usd / l.reported); }
  }
  return { buy, sell, cut, cutStarts, ...(buyCoin && sellCoin ? { buyCoin, sellCoin } : {}) };
}

/** A row flagged by `diagonalImbalances`: its low price, the heavier side, and how many times the opposite volume it is (Infinity against an empty row). */
export interface Imbalance { low: number; side: 'buy' | 'sell'; ratio: number }

/**
 * Diagonal imbalances, as footprint charts compute them: sell volume at a level against buy volume one row higher, and buy
 * volume at a level against sell volume one row lower. (Not the same-row 1.15x rule that tints the footprint cells.) A row one away
 * with nothing traded, inside the candle's range, counts as zero and flags only with `imbZeros`; past the candle's top or bottom there
 * is nothing to compare with.
 */
export function diagonalImbalances(rows: Bar['rows'], step: number, options: Pick<StatOptions, 'imbRatio' | 'imbMinUsd'> & { imbZeros?: boolean }): Imbalance[] {
  const at = new Map<number, [number, number]>();
  let lowest = Infinity, highest = -Infinity;
  for (const [low, buy, sell] of rows) { const index = Math.round(low / step); at.set(index, [buy, sell]); lowest = Math.min(lowest, index); highest = Math.max(highest, index); }
  const found: Imbalance[] = [], min = scaledUsd(options.imbMinUsd);
  /** The volume of `side` one row away at `index`: 0 for an empty row inside the candle, null past its range. */
  const opposite = (index: number, side: 0 | 1): number | null => index < lowest || index > highest ? null : at.get(index)?.[side] ?? 0;
  const flag = (own: number, other: number | null): number | null => {
    if (other === null || !(own > 0) || own < min) return null;
    if (other > 0) return own >= options.imbRatio * other ? own / other : null;
    return options.imbZeros ? Infinity : null;
  };
  for (const [low, buy, sell] of rows) {
    const index = Math.round(low / step);
    const sellRatio = flag(sell, opposite(index + 1, 0)), buyRatio = flag(buy, opposite(index - 1, 1));
    if (sellRatio !== null) found.push({ low, side: 'sell', ratio: sellRatio });
    if (buyRatio !== null) found.push({ low, side: 'buy', ratio: buyRatio });
  }
  return found;
}

/** A stacked imbalance: `n` or more adjacent rows flagged on one side, from the bottom of the lowest to the top of the highest. */
export interface StackedZone { side: 'buy' | 'sell'; low: number; high: number }

/** The runs of at least `n` adjacent rows flagged on the same side, as price spans. */
export function stackedZones(found: readonly Imbalance[], step: number, n: number): StackedZone[] {
  const zones: StackedZone[] = [];
  for (const side of ['buy', 'sell'] as const) {
    const indices = [...new Set(found.filter(f => f.side === side).map(f => Math.round(f.low / step)))].sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && indices[i] === indices[i - 1]! + 1) continue;
      if (i - start >= n) zones.push({ side, low: indices[start]! * step, high: (indices[i - 1]! + 1) * step });
      start = i;
    }
  }
  return zones;
}

/** Number of runs of at least `n` adjacent rows flagged on the same side. */
export const stackedRuns = (found: readonly Imbalance[], step: number, n: number): number => stackedZones(found, step, n).length;

const tradeStat = (id: string, label: string, title: string, scale: StatScale, format: (v: number) => string, pick: (stats: NonNullable<Bar['stats']>, input: StatInput, bar: Bar) => number | null, view?: StatDef['view']): StatDef =>
  ({ id, label, group: 'trades', title, scale, format, source: 'executions', compute: input => input.bars.map(bar => bar?.stats ? pick(bar.stats, input, bar) : null), ...(view ? { view } : {}) });
const sumBuckets = (values: readonly number[], from: number, to: number): number => values.slice(from, to + 1).reduce((a, b) => a + b, 0);
/**
 * A running sum over the slots, starting again where `restart` changes (a new day). A slot without a value (null: no bar, or one without
 * statistics) adds nothing; a bar whose value is not known (NaN: in coins, one that traded with no price) leaves the sum not known until the
 * next restart, rather than left out of it (review 2026-11-27: a cvd in coins skipped every bar the chart's candles did not reach). Without
 * restarts (from the view, whose left edge is where the sum starts anyway) the sum starts at the first bar it can value: the bars older than
 * the chart's candles, which a view zoomed out past them holds, say nothing rather than leave the whole row unknown (review round 4).
 */
const running = (values: (number | null)[], restart?: readonly number[]): (number | null)[] => {
  let run = 0, key = NaN, started = restart !== undefined;
  return values.map((v, i) => {
    if (restart && restart[i] !== key) { key = restart[i]!; run = 0; }
    if (v === null || (!started && Number.isNaN(v))) return null;
    started = true; run += v;
    return Number.isNaN(run) ? null : run;
  });
};
/**
 * Whether a bar can be written in the input's units: always in dollars; in coins where it has a price (`barPrice`). A running sum treats a
 * bar without one as not known even where its figure is 0 (no whale order that minute): counted as 0 it would start the sum from the view
 * among the bars older than the chart's candles, and the next of them would leave it unknown (review round 5).
 */
const priced = (input: StatInput, bar: Bar): boolean => !input.coins || barPrice(input, bar) > 0;
/** A bar's delta for a running sum: NaN in coins where it has no price (the sum is then not known). */
const runDelta = (input: StatInput, bar: Bar): number => priced(input, bar) ? barDelta(input, bar) ?? Number.NaN : Number.NaN;
/** `sizeDeltaIn` for a running sum: null without statistics (adds nothing), NaN in coins where the bar has no price. */
const runSizeDelta = (bar: Bar, input: StatInput, line: 'retail' | 'whale'): number | null => {
  const d = sizeDelta(bar, input, line);
  return d === null ? null : priced(input, bar) ? inBarUnits(input, bar, d) ?? Number.NaN : Number.NaN;
};

/**
 * A bar's market orders from the retail or the whale size: the line's own sums when the bar was loaded with them, else its size boxes (at the
 * nearest edge when the size lies between two: `exact` false). Null for a bar without trade statistics.
 */
export function lineOf(bar: Bar, input: Pick<StatInput, 'options' | 'cuts'>, line: 'retail' | 'whale'): { buy: number; sell: number; exact: boolean } | null {
  const stats = bar.stats; if (!stats) return null;
  const size = scaledUsd(line === 'retail' ? input.options.retailUsd : input.options.whaleUsd);
  const k = input.cuts ? input.cuts.findIndex(c => Math.abs(c - size) <= 1e-6 * size) : -1;
  if (k >= 0 && bar.over && bar.over.length >= 2 * k + 2) return { buy: bar.over[2 * k]!, sell: bar.over[2 * k + 1]!, exact: true };
  return overFromBoxes(stats.buy, stats.sell, size, sizeScale());
}
/** The delta of a bar's retail orders (under the retail size) or of its whales (from the whale size up). */
export function sizeDelta(bar: Bar, input: Pick<StatInput, 'options' | 'cuts'>, line: 'retail' | 'whale'): number | null {
  const sums = lineOf(bar, input, line), stats = bar.stats;
  if (!sums || !stats) return null;
  return line === 'whale' ? sums.buy - sums.sell : (sumBuckets(stats.buy, 0, 7) - sums.buy) - (sumBuckets(stats.sell, 0, 7) - sums.sell);
}
/** `sizeDelta` in the input's units: in coins at the bar's price (`barPrice`: the size boxes keep only dollars). */
export function sizeDeltaIn(bar: Bar, input: StatInput, line: 'retail' | 'whale'): number | null {
  const d = sizeDelta(bar, input, line);
  return d === null ? null : inBarUnits(input, bar, d);
}
/** The average market buy against the average market sell of pooled orders, as log2 of their ratio; null without both sides. */
export function pooledSkew(o: { buyUsd: number; sellUsd: number; buyN: number; sellN: number }): number | null {
  return o.buyN > 0 && o.sellN > 0 && o.buyUsd > 0 && o.sellUsd > 0 ? Math.log2((o.buyUsd / o.buyN) / (o.sellUsd / o.sellN)) : null;
}
const approxLine = (line: 'retail' | 'whale') => (input: StatInput): boolean => input.bars.some(bar => bar && lineOf(bar, input, line)?.exact === false);
/** The marks of the open interest against delta, by value (0 none). */
const QUADRANTS = ['', '+▲', '+▼', '−▲', '−▼'] as const;
const markTone = (up: boolean | null): StatTone | null => up === null ? null : up ? 'buy' : 'sell';

export const BAR_STATS: readonly StatDef[] = [
  { id: 'vol', label: 'vol', group: 'volume', source: 'executions', reads: 'totals', title: t('Executed volume of the bar (USD, buy + sell)'), coinTitle: () => t('Executed volume of the bar ({unit}, buy + sell)', { unit: unitName() }), scale: 'sequential', format: vol, compute: input => perBar(input, input.coins ? bar => volumeOf(input, bar) : total), view: sumView(vol, false) },
  { id: 'delta', label: 'delta', group: 'volume', source: 'executions', reads: 'totals', title: t('Buy minus sell volume of the bar (USD)'), coinTitle: () => t('Buy minus sell volume of the bar ({unit})', { unit: unitName() }), scale: 'diverging', format: signedVol, compute: input => perBar(input, input.coins ? bar => barDelta(input, bar) : bar => bar.buyUsd - bar.sellUsd), view: sumView(signedVol, true) },
  { id: 'cvd', label: 'cvd', group: 'volume', source: 'executions', reads: 'totals', running: true, title: t('Cumulative delta: running sum of delta over the bars loaded for the view'), scale: 'diverging', format: signedVol,
    compute: input => running(perBar(input, input.coins ? bar => runDelta(input, bar) : bar => bar.buyUsd - bar.sellUsd), input.restart), view: lastView(signedVol) },
  { id: 'deltaPct', label: t('delta %'), group: 'volume', source: 'executions', reads: 'totals', title: t('Delta as a share of the bar\'s volume (+100 % all buying, -100 % all selling)'), scale: 'diverging', format: signedPct,
    // In coins the share of the coin amounts written beside it (delta and vol), so the two always agree in sign; in dollars as it always was.
    compute: input => perBar(input, input.coins ? bar => { const s = sidesOf(input, bar); return s && s.buy + s.sell > 0 ? (s.buy - s.sell) / (s.buy + s.sell) * 100 : null; }
      : bar => total(bar) > 0 ? (bar.buyUsd - bar.sellUsd) / total(bar) * 100 : null),
    view: ratioView(signedPct, signTone, (bars, input) => {
      if (input.coins) { let all = 0, net = 0; for (const b of bars) { const s = sidesOf(input, b); if (s) { all += s.buy + s.sell; net += s.buy - s.sell; } } return all > 0 ? net / all * 100 : null; }
      const all = bars.reduce((s, b) => s + total(b), 0); return all > 0 ? bars.reduce((s, b) => s + b.buyUsd - b.sellUsd, 0) / all * 100 : null;
    }) },
  { id: 'buyVol', label: t('buy vol'), group: 'volume', source: 'executions', reads: 'totals', title: t('Volume bought at the ask (market buys, USD)'), coinTitle: () => t('Volume bought at the ask (market buys, {unit})', { unit: unitName() }), scale: 'sequential', format: vol, compute: input => perBar(input, input.coins ? bar => sidesOf(input, bar)?.buy ?? null : bar => bar.buyUsd), view: sumView(vol, false) },
  { id: 'sellVol', label: t('sell vol'), group: 'volume', source: 'executions', reads: 'totals', title: t('Volume sold at the bid (market sells, USD)'), coinTitle: () => t('Volume sold at the bid (market sells, {unit})', { unit: unitName() }), scale: 'sequential', format: vol, compute: input => perBar(input, input.coins ? bar => sidesOf(input, bar)?.sell ?? null : bar => bar.sellUsd), view: sumView(vol, false) },
  { id: 'takerDelta', label: t('candle delta'), group: 'volume', source: 'market', scale: 'diverging', format: signedVol,
    title: t('Delta from the exchange\'s own candles: taker buys minus the rest of the candle\'s volume, in USD at its typical price. Binance reports taker buys, so the row fills for a Binance chart market, before the recording too, and stays empty for others. One market, where delta counts the markets chosen.'),
    coinTitle: () => t('Delta from the exchange\'s own candles: taker buys minus the rest of the candle\'s volume, in {unit}. Binance reports taker buys, so the row fills for a Binance chart market, before the recording too, and stays empty for others. One market, where delta counts the markets chosen.', { unit: unitName() }),
    // Buys, volume and price of one snapshot, the exchange's own candle: the chart's candle under way moves on between the minutes it is read.
    // In coins the candle's own volume and taker buys, which the exchange counts in the coin.
    compute: input => input.bars.map((_, i) => {
      const c = input.taker?.get(slotTime(input, i)), bought = c?.[7], usd = c ? candleUsd(c) : 0;
      if (input.coins) return c && bought !== undefined && c[5] > 0 ? (2 * Math.min(1, Math.max(0, bought / c[5])) - 1) * c[5] : null;
      return c && bought !== undefined && c[5] > 0 && usd > 0 ? (2 * Math.min(1, Math.max(0, bought / c[5])) - 1) * usd : null;
    }),
    view: sumView(signedVol, true) },
  { id: 'cover', label: t('rec %'), group: 'volume', source: 'executions', scale: 'category', format: v => v >= 99.5 ? '' : pctText(v), tone: v => v < 95 ? 'sell' : null,
    title: t('How much of the candle the recording holds: its minutes with trades recorded on any of the markets counted, against its length (against what has passed, for the candle under way). Rows read from executions are drawn faint where it is under 95 %; at 100 % the cell is empty.'),
    compute: input => perBar(input, (bar, i) => { const share = input.tfMs && input.now !== undefined ? coverageOf(bar, slotTime(input, i), input.tfMs, input.now) : null; return share === null ? null : share * 100; }),
    view: (input, at) => {
      let held = 0, length = 0;
      for (const i of at) { const bar = input.bars[i], start = slotTime(input, i); if (!bar || bar.minutes === undefined || !input.tfMs || input.now === undefined) continue; held += Math.min(bar.minutes, Math.max(1, Math.ceil((Math.min(input.now, start + input.tfMs) - start) / 60_000))); length += Math.max(1, Math.ceil((Math.min(input.now, start + input.tfMs) - start) / 60_000)); }
      return length > 0 ? { value: pctText(held / length * 100), tone: held / length < 0.95 ? 'sell' : 'text', how: t('The minutes recorded over the minutes of the recorded candles in view.') } : null;
    } },
  { id: 'venueAgree', label: t('venues agree %'), group: 'volume', source: 'executions', reads: 'parts', scale: 'sequential', format: pctText,
    title: t("How much of the candle's volume traded on markets whose own delta had the sign of the total: 100 % every market pressed the same way, low where they pulled against each other. Needs several markets added together."),
    compute: input => perBar(input, bar => { const by = venueSums(bar); return by ? agreement(by) : null; }),
    view: (input, at) => {
      const by = new Map<string, [number, number]>();
      // A candle that traded without saying its markets would leave its delta out of the total's sign: then there is no figure.
      for (const i of at) { const bar = input.bars[i]; if (!bar) continue; if (!bar.parts && total(bar) > 0) return null; venueSums(bar, by); }
      const share = agreement(by);
      return share === null ? null : { value: pctText(share), tone: 'text', how: t('Worked out from the candles in view added together.') };
    } },
  { id: 'maxBuy', label: t('max buy'), group: 'footprint', source: 'executions', reads: 'rows', title: t('Largest single price row of market buys in the bar (USD)'), coinTitle: () => t('Largest single price row of market buys in the bar ({unit})', { unit: unitName() }), scale: 'sequential', format: vol,
    compute: input => perBar(input, bar => input.coins ? barCoins(bar, input.step).maxBuy : bar.rows.reduce((m, r) => Math.max(m, r[1]), 0)), view: maxView(vol) },
  { id: 'maxSell', label: t('max sell'), group: 'footprint', source: 'executions', reads: 'rows', title: t('Largest single price row of market sells in the bar (USD)'), coinTitle: () => t('Largest single price row of market sells in the bar ({unit})', { unit: unitName() }), scale: 'sequential', format: vol,
    compute: input => perBar(input, bar => input.coins ? barCoins(bar, input.step).maxSell : bar.rows.reduce((m, r) => Math.max(m, r[2]), 0)), view: maxView(vol) },
  { id: 'poc', label: 'poc', group: 'footprint', source: 'executions', reads: 'rows', title: t('Point of control: the price row with the most executed volume in the bar'), scale: 'plain', format: value => fmtPrice(value),
    compute: input => perBar(input, bar => pocOf(bar.rows, input.step)),
    view: (input, at) => { const poc = viewPoc(input, at); return poc === null ? null : { value: fmtPrice(poc), tone: 'text', how: t('The busiest row of the candles in view added together.') }; } },
  { id: 'pocMove', label: t('poc move'), group: 'footprint', source: 'executions', reads: 'rows', title: t('How far the point of control moved from the candle before: up +, down −'), scale: 'diverging', format: signedPrice,
    compute: input => { const pocs = perBar(input, bar => pocOf(bar.rows, input.step)); return pocs.map((p, i) => p === null || i === 0 || pocs[i - 1] === null || pocs[i - 1] === undefined ? null : p - pocs[i - 1]!); },
    view: sumView(signedPrice, true) },
  { id: 'pocPos', label: t('poc in range'), group: 'footprint', source: 'executions', reads: 'rows', title: t('Where the point of control sits in the candle: 0 % at its low, 100 % at its high'), scale: 'diverging', center: 50, format: pctText,
    compute: input => perBar(input, (bar, i) => { const c = input.candles.get(slotTime(input, i)), poc = pocOf(bar.rows, input.step); return c && poc !== null && c[2] > c[3] ? clampPct((poc - c[3]) / (c[2] - c[3]) * 100) : null; }),
    // The candles and the rows of the same candles: one without the other would set a busiest row in a range it was not traded in.
    view: (input, at) => { const both = at.filter(i => input.bars[i] && input.candles.has(slotTime(input, i))), c = viewCandle(input, both), poc = viewPoc(input, both); return c && poc !== null && c.high > c.low ? { value: pctText(clampPct((poc - c.low) / (c.high - c.low) * 100)), tone: (poc - c.low) / (c.high - c.low) >= 0.5 ? 'buy' : 'sell', how: t('The busiest row of the candles in view added together, in their whole range.') } : null; } },
  { id: 'imbalances', label: t('imb #'), group: 'footprint', source: 'executions', reads: 'rows', title: t('Diagonal imbalances: levels where sells (or buys) are at least the configured ratio times the opposite volume one row away'), scale: 'sequential', format: count,
    compute: input => perBar(input, bar => diagonalImbalances(bar.rows, input.step, input.options).length), view: sumView(count, false) },
  { id: 'stacked', label: 'stacked', group: 'footprint', source: 'executions', reads: 'rows', title: t('Stacked imbalances: runs of the configured number of adjacent imbalanced rows on one side'), scale: 'sequential', format: count,
    compute: input => perBar(input, bar => stackedRuns(diagonalImbalances(bar.rows, input.step, input.options), input.step, input.options.stackedN)), view: sumView(count, false) },
  tradeStat('trades', 'orders', t('Number of market orders in the bar (all the fills of one order count once)'), 'sequential', count, stats => stats.buyN + stats.sellN, sumView(count, false)),
  tradeStat('buys', 'buys', t('Number of market buys in the bar'), 'sequential', count, stats => stats.buyN, sumView(count, false)),
  tradeStat('sells', 'sells', t('Number of market sells in the bar'), 'sequential', count, stats => stats.sellN, sumView(count, false)),
  // The size boxes keep dollars only: in coins at the bar's volume-weighted price (`barPrice`, an approximation: see the header).
  { ...tradeStat('avgTrade', t('avg order'), t('Average market order size: volume divided by the number of market orders (USD)'), 'sequential', vol, (stats, input, bar) => stats.buyN + stats.sellN > 0 ? inBarUnits(input, bar, orderUsd(stats) / (stats.buyN + stats.sellN)) : null,
    ratioView(vol, () => 'text', (bars, input) => { const o = orderPoolIn(bars, input), n = o.buyN + o.sellN; return n > 0 ? (o.buyUsd + o.sellUsd) / n : null; })),
    coinTitle: () => t('Average market order size: volume divided by the number of market orders ({unit})', { unit: unitName() }) },
  { ...tradeStat('avgBuy', t('avg buy'), t('Average market buy: the dollars of the market buys divided by their number (USD)'), 'sequential', vol, (stats, input, bar) => stats.buyN > 0 ? inBarUnits(input, bar, sumBuckets(stats.buy, 0, 7) / stats.buyN) : null,
    ratioView(vol, () => 'text', (bars, input) => { const o = orderPoolIn(bars, input); return o.buyN > 0 ? o.buyUsd / o.buyN : null; })),
    coinTitle: () => t('Average market buy: the volume of the market buys divided by their number ({unit})', { unit: unitName() }) },
  { ...tradeStat('avgSell', t('avg sell'), t('Average market sell: the dollars of the market sells divided by their number (USD)'), 'sequential', vol, (stats, input, bar) => stats.sellN > 0 ? inBarUnits(input, bar, sumBuckets(stats.sell, 0, 7) / stats.sellN) : null,
    ratioView(vol, () => 'text', (bars, input) => { const o = orderPoolIn(bars, input); return o.sellN > 0 ? o.sellUsd / o.sellN : null; })),
    coinTitle: () => t('Average market sell: the volume of the market sells divided by their number ({unit})', { unit: unitName() }) },
  // The exchange's own candle (Binance's) counts trades, not orders: a fill each, so one market order is often several. One market, the chart's.
  { id: 'fills', label: t('fills'), group: 'trades', source: 'market', scale: 'sequential', format: count,
    title: t('Trades in the chart market\'s own candle as the exchange counts them: every fill counts, so one market order filled against several resting orders counts several times. Binance reports them, so the row fills for a Binance chart market, before the recording too, and stays empty for others.'),
    compute: input => input.bars.map((_, i) => input.taker?.get(slotTime(input, i))?.[8] ?? null), view: sumView(count, false) },
  { id: 'avgFill', label: t('avg fill'), group: 'trades', source: 'market', scale: 'sequential', format: vol,
    title: t('Average fill in the chart market\'s own candle: its quote volume divided by its trades (USDT for a USDT market). A fill, not an order: on one market an order is often several fills, so a fill averages less than an order there; avg order may count other markets too.'),
    coinTitle: () => t('Average fill in the chart market\'s own candle: its volume divided by its trades ({unit}). A fill, not an order: on one market an order is often several fills, so a fill averages less than an order there; avg order may count other markets too.', { unit: unitName() }),
    // In coins the candle's own volume, which the exchange counts in the coin, over the same trades.
    compute: input => input.bars.map((_, i) => { const c = input.taker?.get(slotTime(input, i)), q = input.coins ? c?.[5] : c?.[9], n = c?.[8]; return q !== undefined && n !== undefined && n > 0 ? q / n : null; }),
    view: (input, at) => {
      let q = 0, n = 0;
      for (const i of at) { const c = input.taker?.get(slotTime(input, i)), v = input.coins ? c?.[5] : c?.[9]; if (c && v !== undefined && c[8] !== undefined) { q += v; n += c[8]; } }
      return n > 0 ? { value: vol(q / n), tone: 'text', how: t('Worked out from the candles in view added together.') } : null;
    } },
  { ...tradeStat('sizeSkew', t('size skew'), t('The average market buy against the average market sell: ×2 in the rising colour, buy orders were twice the size of sell orders; in the falling colour, sell orders were'), 'diverging', v => `×${(2 ** Math.abs(v)).toFixed(1)}`,
    stats => { const buy = sumBuckets(stats.buy, 0, 7), sell = sumBuckets(stats.sell, 0, 7); return stats.buyN > 0 && stats.sellN > 0 && buy > 0 && sell > 0 ? Math.log2((buy / stats.buyN) / (sell / stats.sellN)) : null; },
    ratioView(v => `×${(2 ** Math.abs(v)).toFixed(1)}`, signTone, bars => pooledSkew(orderPool(bars)))),
    // The table keeps the logarithm, so a skew either way is shaded alike; the file gives the ratio itself.
    csv: { head: 'sizeSkew_buy_over_sell', cell: v => String(2 ** v) } },
  { ...tradeStat('whaleShare', t('whale %'), t('Share of the market-order volume in orders from the whale size up (set in the options)'), 'sequential', pctText, (stats, input, bar) => { const whale = lineOf(bar, input, 'whale'), all = orderUsd(stats); return whale && all > 0 ? (whale.buy + whale.sell) / all * 100 : null; }),
    approx: approxLine('whale'), view: (input, at) => { let whale = 0, all = 0; for (const i of at) { const bar = input.bars[i], line = bar ? lineOf(bar, input, 'whale') : null; if (!bar?.stats || !line) continue; whale += line.buy + line.sell; all += orderUsd(bar.stats); } return all > 0 ? { value: pctText(whale / all * 100), tone: 'text', how: t('Worked out from the candles in view added together.') } : null; } },
  { ...tradeStat('deltaRetail', t('delta retail'), t('Delta of market orders under the retail size (set in the options)'), 'diverging', signedVol, (_stats, input, bar) => sizeDeltaIn(bar, input, 'retail'), sumView(signedVol, true)), approx: approxLine('retail') },
  { ...tradeStat('deltaWhales', t('delta whales'), t('Delta of market orders from the whale size up (set in the options)'), 'diverging', signedVol, (_stats, input, bar) => sizeDeltaIn(bar, input, 'whale'), sumView(signedVol, true)), approx: approxLine('whale') },
  { id: 'cvdRetail', label: t('cvd retail'), group: 'trades', source: 'executions', running: true, title: t('Cumulative delta of retail-size market orders over the bars loaded'), scale: 'diverging', format: signedVol,
    compute: input => running(input.bars.map(bar => bar ? runSizeDelta(bar, input, 'retail') : null), input.restart), approx: approxLine('retail'), view: lastView(signedVol) },
  { id: 'cvdWhales', label: t('cvd whales'), group: 'trades', source: 'executions', running: true, title: t('Cumulative delta of whale-size market orders over the bars loaded'), scale: 'diverging', format: signedVol,
    compute: input => running(input.bars.map(bar => bar ? runSizeDelta(bar, input, 'whale') : null), input.restart), approx: approxLine('whale'), view: lastView(signedVol) },
  { id: 'range', label: 'range', group: 'market', source: 'market', title: t('High minus low of the candle'), scale: 'sequential', format: value => fmtPrice(value),
    compute: input => perCandle(input, c => c[2] - c[3]),
    view: (input, at) => { const c = viewCandle(input, at); return c ? { value: fmtPrice(c.high - c.low), tone: 'text', how: t('The highest high less the lowest low of the candles in view.') } : null; } },
  { id: 'closePos', label: t('close in range'), group: 'market', source: 'market', title: t('Where the candle closed in its range: 0 % at the low, 100 % at the high'), scale: 'diverging', center: 50, format: pctText,
    compute: input => perCandle(input, c => c[2] > c[3] ? clampPct((c[4] - c[3]) / (c[2] - c[3]) * 100) : null),
    view: (input, at) => { const c = viewCandle(input, at); return c && c.high > c.low ? { value: pctText(clampPct((c.close - c.low) / (c.high - c.low) * 100)), tone: (c.close - c.low) / (c.high - c.low) >= 0.5 ? 'buy' : 'sell', how: t('The newest close in the whole range of the candles in view.') } : null; } },
  { id: 'effort', label: t('vol / bp'), group: 'market', source: 'market', scale: 'sequential', format: vol,
    title: t('Effort against result: the candle\'s volume (USD, at its typical price) per basis point of its range. High: much traded for little movement, as where a ceiling or a floor holds; low: price moved easily. The chart\'s candle, one market.'),
    coinTitle: () => t('Effort against result: the candle\'s volume ({unit}) per basis point of its range. High: much traded for little movement, as where a ceiling or a floor holds; low: price moved easily. The chart\'s candle, one market.', { unit: unitName() }),
    // In coins the candle's own volume (the coin's), not valued at any price.
    compute: input => perCandle(input, c => { const bp = c[1] > 0 ? (c[2] - c[3]) / c[1] * 10_000 : 0, usd = candleUsd(c), size = input.coins ? (usd > 0 ? c[5] : 0) : usd; return bp > 0 && size > 0 ? size / bp : null; }),
    view: (input, at) => { const c = viewCandle(input, at), bp = c && c.open > 0 ? (c.high - c.low) / c.open * 10_000 : 0, size = c ? (input.coins ? c.vol : c.usd) : 0; return c && bp > 0 && size > 0 ? { value: vol(size / bp), tone: 'text', how: t('The volume of the candles in view over the basis points of their whole range.') } : null; } },
  { id: 'divergence', label: t('delta vs candle'), group: 'market', source: 'executions', reads: 'totals', scale: 'category',
    title: t('A candle that fell on net market buying (▲) or rose on net market selling (▼), with delta at least 5 % of its volume: taker flow against the price, which does not by itself show who absorbed it'),
    format: v => v > 0 ? '▲' : v < 0 ? '▼' : '', tone: v => markTone(v === 0 ? null : v > 0),
    compute: input => perBar(input, (bar, i) => {
      const c = input.candles.get(slotTime(input, i)), volume = total(bar); if (!c || !(volume > 0)) return null;
      const share = (bar.buyUsd - bar.sellUsd) / volume;
      return Math.abs(share) < 0.05 ? 0 : share > 0 && c[4] < c[1] ? 1 : share < 0 && c[4] > c[1] ? -1 : 0;
    }), view: markView(() => statDef('divergence')!) },
  { id: 'oiChange', label: t('oi chg'), group: 'market', source: 'market', title: t('Open-interest change over the bar (its close minus the close of the bar before); USD or base coin in the options'), scale: 'diverging', format: signedVol,
    coinTitle: () => t('Open-interest change over the bar (its close minus the close of the bar before), in {unit}', { unit: unitName() }),
    // In coins the open interest's own change (it is kept in the coin), whatever the option, which is the dollars mode's.
    compute: input => { const { oi, oiChange, oiUsd, candles, options } = input, delta = oiChange ?? oiDeltaByTime(oi.values()); return input.bars.map((_, i) => { const start = slotTime(input, i), change = delta.get(start); if (change === undefined) return null; if (options.oiUnits === 'base' || input.coins) return change; if (oiUsd) return oiUsd.get(start) ?? null; const c = candles.get(start); return c ? change * c[4] : null; }); },
    view: sumView(signedVol, true) },
  { id: 'oiQuad', label: t('oi × delta'), group: 'market', source: 'executions', reads: 'totals', scale: 'category',
    title: t('Open interest against delta: + OI rose, − OI fell; ▲ net market buying, ▼ net market selling. +▲ is often read as buyers opening positions and −▲ as sellers closing theirs (shorts covering): a reading, not proof. The OI is the OI pane\'s markets.'),
    format: v => QUADRANTS[v] ?? '', tone: v => markTone(v === 1 || v === 3 ? true : v === 2 || v === 4 ? false : null),
    // Executions of spot markets alone (the Spot filter, spot picks) say nothing of who opened positions on the perpetuals whose open
    // interest moved: blank, never their buying read against the perpetuals' change.
    compute: input => { if (input.perps === false) return input.bars.map(() => null); const delta = input.oiChange ?? oiDeltaByTime(input.oi.values()); return perBar(input, (bar, i) => { const change = delta.get(slotTime(input, i)), d = bar.buyUsd - bar.sellUsd; if (change === undefined) return null; return change === 0 || d === 0 ? 0 : change > 0 ? (d > 0 ? 1 : 2) : (d > 0 ? 3 : 4); }); },
    view: markView(() => statDef('oiQuad')!) },
  { id: 'liq', label: t('liq'), group: 'market', source: 'market', scale: 'sequential', format: vol,
    title: t('Liquidations reported in the candle on the perpetuals counted (USD; the Spot filter does not hide them): shorts liquidated and longs liquidated together. Only the venues that publish them count, so it is what was reported, not all there was.'),
    coinTitle: () => t('Liquidations reported in the candle on the perpetuals counted ({unit}; the Spot filter does not hide them): shorts liquidated and longs liquidated together. Only the venues that publish them count, so it is what was reported, not all there was.', { unit: unitName() }),
    compute: input => input.bars.map((_, i) => { const l = liquidated(input, i); return l ? l[0] + l[1] : null; }),
    approx: input => !!input.liquidations?.cut, approxNote: liquidationNote, view: sumView(vol, false) },
  { id: 'liqNet', label: t('liq Δ'), group: 'market', source: 'market', scale: 'diverging', format: signedVol,
    title: t('Shorts liquidated less longs liquidated in the candle (USD): above 0 the forced buying of a squeeze, below 0 the forced selling of a flush.'),
    coinTitle: () => t('Shorts liquidated less longs liquidated in the candle ({unit}): above 0 the forced buying of a squeeze, below 0 the forced selling of a flush.', { unit: unitName() }),
    compute: input => input.bars.map((_, i) => { const l = liquidated(input, i); return l ? l[0] - l[1] : null; }),
    approx: input => !!input.liquidations?.cut, approxNote: liquidationNote, view: sumView(signedVol, true) },
];

/** Starting selections offered by the presets. */
export const PRESETS: Readonly<Record<'default' | 'flow' | 'all' | 'none', readonly string[]>> = {
  default: ['vol', 'delta', 'cvd'],
  /** What an order-flow reading looks at: who pressed, against what result, and whether the candle was recorded whole. */
  flow: ['delta', 'cvd', 'divergence', 'effort', 'closePos', 'whaleShare', 'sizeSkew', 'oiQuad', 'cover'],
  all: BAR_STATS.map(def => def.id),
  none: [],
};

const byId = new Map(BAR_STATS.map(def => [def.id, def]));

/**
 * Whether a statistic is read from the footprint's bars with rows rather than from the bars without (`StatDef.reads`): its rows or their
 * markets always; its bought and sold dollars only where the bars without rows do not carry them (`totals` false: an older source); and a
 * running sum in coins with CVD from each day's start (`coinRun`): its bars from the start of the day reach back past the chart's candles,
 * which price a bar without rows, where rows price each part where it traded (review 2026-11-27).
 */
export const readsRows = (def: Pick<StatDef, 'reads' | 'running'>, totals: boolean | null, coinRun = false): boolean =>
  def.reads === 'rows' || def.reads === 'parts' || (def.reads === 'totals' && totals === false) || (coinRun && def.running === true);
/** Whether running sums read rows to be priced (`readsRows`): coins, with CVD from each day's start. */
export const coinRunOf = (coins: boolean, options: { cvdFrom: string }): boolean => coins && options.cvdFrom === 'day';
export const statDef = (id: string): StatDef | undefined => byId.get(id);

/** The enabled definitions in the configured order, ignoring unknown ids and duplicates. */
export function enabledStats(ids: readonly string[]): StatDef[] {
  const seen = new Set<string>(), out: StatDef[] = [];
  for (const id of ids) { const def = byId.get(id); if (def && !seen.has(id)) { seen.add(id); out.push(def); } }
  return out;
}

/** One band of the table: a statistic's row, or (rows grouped by kind) a kind's header, folded or not. */
export type TableBand = { kind: 'row'; def: StatDef; index: number } | { kind: 'head'; group: StatGroup; folded: boolean; count: number };
/** The heights the page gives a header and a row when it sizes the pane (the rows stretch to fill what it has). */
export const HEAD_H = 14, ROW_H = 24;

/**
 * The table's bands top to bottom: the rows in the order chosen, or gathered under a header per kind (in the kinds' order, the order chosen
 * within each), a folded kind's rows left out.
 */
export function tableBands(defs: readonly StatDef[], options: Pick<StatOptions, 'grouped' | 'folded'>): TableBand[] {
  if (!options.grouped) return defs.map((def, index) => ({ kind: 'row', def, index }));
  const out: TableBand[] = [];
  for (const group of Object.keys(GROUP_TITLES) as StatGroup[]) {
    const rows = defs.flatMap((def, index) => def.group === group ? [{ def, index }] : []);
    if (!rows.length) continue;
    const folded = options.folded.includes(group);
    out.push({ kind: 'head', group, folded, count: rows.length });
    if (!folded) for (const row of rows) out.push({ kind: 'row', ...row });
  }
  return out;
}

/** The pane's height for these statistics: what the page gives it when they, the grouping or the folding change. */
export function tableHeight(ids: readonly string[], options: Pick<StatOptions, 'grouped' | 'folded'>): number {
  const bands = tableBands(enabledStats(ids), options), rows = bands.filter(b => b.kind === 'row').length;
  return 12 + Math.max(1, rows) * ROW_H + (bands.length - rows) * HEAD_H;
}

/** The most candles pinned at once (each has a card of every statistic: more would cover the strip and the chart). */
export const MAX_PINS = 5;
/**
 * The pinned candles after a click on candle `start`: a plain click pins that one alone, or lets it go when it is pinned; with `add` (Shift) it adds
 * the candle to the pinned ones, or takes it from them, the oldest pin giving way past `MAX_PINS`.
 */
export function pinsAfterClick(pins: readonly number[], start: number, add: boolean): number[] {
  const held = pins.includes(start);
  if (held) return pins.filter(t => t !== start);
  return add ? [...pins, start].slice(-MAX_PINS) : [start];
}

/** The card of a pinned candle: every statistic shown, for that one candle. */
export function pinnedLines(time: string, rows: readonly { label: string; value: string; tone: StatTone }[]): InfoLine[] {
  return [
    { text: t('Pinned'), bold: true },
    { label: t('Candle'), text: time },
    ...rows.map((row, i): InfoLine => ({ label: row.label, text: row.value, color: row.tone, ...(i === 0 ? { rule: true } : {}) })),
    { text: t('Click the candle again or press Esc to let it go.'), color: 'muted', wrap: true, rule: true },
  ];
}

/**
 * Colour scale of one row: deviations from the stat's centre mapped on a log scale between the visible 2nd and 99th percentile,
 * so one outlier bar does not flatten the row. Returns null when there is nothing to scale.
 */
export function rowScale(def: StatDef, values: readonly (number | null | undefined)[]): { lo: number; hi: number } | null {
  if (def.scale === 'plain') return null;
  const deviations: number[] = [];
  for (const value of values) if (value !== null && value !== undefined) { const d = Math.abs(value - (def.center ?? 0)); if (d > 0) deviations.push(d); }
  if (!deviations.length) return null;
  deviations.sort((a, b) => a - b);
  const at = (q: number) => deviations[Math.min(deviations.length - 1, Math.floor(q * deviations.length))]!;
  const hi = at(0.99), lo = Math.max(at(0.02), hi / 4096);
  return { lo, hi };
}

/** How far a value stands out on its row, for the Highlights and the rank: its size, or its distance from the centre of a share around one. */
export const deviation = (def: StatDef, value: number): number => Math.abs(value - (def.center ?? 0));

/** Strength 0..1 of a value on its row's scale: 0 at or below the 2nd percentile, 1 at or above the 99th. */
export function strength(def: StatDef, value: number, scale: { lo: number; hi: number } | null): number {
  if (def.scale === 'plain' || !scale) return 0;
  const d = Math.abs(value - (def.center ?? 0));
  if (d <= scale.lo) return 0;
  if (d >= scale.hi || !(scale.hi > scale.lo)) return 1;
  return (Math.log(d) - Math.log(scale.lo)) / (Math.log(scale.hi) - Math.log(scale.lo));
}

/** What the pointer is on in the strip: one statistic of one candle, with what is needed to say how it compares. */
export interface StatCell {
  label: string;
  /** What the statistic means (the definition's own sentence). */
  title: string;
  value: string;
  /** The colour of the value: a signed statistic is green or red by its sign. */
  tone: 'buy' | 'sell' | 'text';
  time: string;
  /** The same statistic on the candle before, when that candle is the one just before. */
  previous: string | null;
  /** Where this value stands among the candles in view (1 is the largest), and how many there are. */
  rank: number | null;
  of: number;
  /** How far above its recent norm the value is, when the highlighter flagged it. */
  sigma: number | null;
  /** For a row read from executions, the share (%) of the candle the recording holds, where it holds only part of it; else null. */
  partial: number | null;
}

/** The popup for a cell of the strip. */
export function statCellLines(cell: StatCell): InfoLine[] {
  const lines: InfoLine[] = [
    { text: cell.label, bold: true },
    { label: t('Candle'), text: cell.time },
    { label: t('Value'), text: cell.value, color: cell.tone, bold: true },
  ];
  if (cell.previous !== null) lines.push({ label: t('Candle before'), text: cell.previous });
  if (cell.rank !== null && cell.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: cell.rank, total: cell.of }) });
  if (cell.sigma !== null && Number.isFinite(cell.sigma)) lines.push({ label: t('Unusual'), text: t('{z}σ above its baseline', { z: cell.sigma.toFixed(1) }), bold: true });
  if (cell.partial !== null) lines.push({ label: t('Recorded'), text: t('{share} % of the candle: the figure counts only that part', { share: cell.partial }), color: 'sell', wrap: true });
  lines.push({ text: cell.title, color: 'muted', wrap: true, rule: true });
  return lines;
}

/** The popup for a cell of the View column: the statistic over the candles in view, how that figure was taken, and what the statistic is. */
export function viewCellLines(label: string, cell: ViewCell | null, title: string, candles: number): InfoLine[] {
  return [
    { text: label, bold: true },
    { label: t('In view'), text: t('{n} candles', { n: candles }) },
    { label: t('Value'), text: cell?.value ?? '–', color: cell?.tone ?? 'text', bold: true },
    ...(cell ? [{ text: cell.how, wrap: true }] : [{ text: t('Nothing to sum or compare for these candles.'), wrap: true }]),
    { text: title, color: 'muted' as const, wrap: true, rule: true },
  ];
}
