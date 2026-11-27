import type { LiquidatedSide, Liquidation, ReportedKind } from '../../shared/liquidations.ts';
import { LIQ_GROUP_MS } from './settings.ts';

/**
 * Pure liquidation-tape arithmetic (no DOM): filtering, fixed-slice cascade grouping, dedicated bar scales (liquidations are 1-2 orders of
 * magnitude smaller than aggregate trade flow) and time-window summaries for both standalone liquidation blocks and trade-block annotations.
 *
 * Coins (units.ts, issue 9): a liquidation's coins are its dollars over its `reported` price, the venue's own price that valued it (never the
 * market price it is drawn at, `price`), and a row's or a window's coins are those added up (`liqCoins`).
 */

/** A liquidation's coins: its dollars over the price the venue reported it at (`reported`), 0 without one. */
export const liqCoins = (l: Pick<Liquidation, 'usd' | 'reported'>): number => l.reported > 0 ? l.usd / l.reported : 0;

/** One row of the liquidation tape (a single forced close, or a fixed-slice cascade burst of one market and side). */
export interface LiqRow {
  /** Stable key for retained-row signatures and pinning. */
  key: string;
  /** Newest liquidation time in this row (ms). */
  t: number;
  id: string;
  /** Which positions were liquidated: 'long' (forced sell) or 'short' (forced buy). */
  side: LiquidatedSide;
  /** Signed USD for shared buy/sell helpers: positive for short liquidations (forced buys), negative for long liquidations (forced sells). */
  signedUsd: number;
  usd: number;
  /** The row's coins (unsigned): each liquidation's dollars over its reported price, added up (`liqCoins`); 0 for rows built without `coins`. */
  coins: number;
  /** Volume-weighted market price across the row. */
  price: number;
  lo: number; hi: number;
  /** Representative liquidation (the largest in a grouped burst, or the liquidation itself) for the hover infobox. */
  rep: Liquidation;
  reported: number;
  kind: ReportedKind;
  count: number;
}

export interface LiqFilter { minUsd: number; side: 'both' | 'buy' | 'sell'; shown: (id: string) => boolean }

/** Whether a liquidated position side matches a tape side filter ('buy' = shorts liquidated / forced buys; 'sell' = longs liquidated / forced sells). */
export function liqSideMatches(side: LiquidatedSide, filter: 'both' | 'buy' | 'sell'): boolean {
  return filter === 'both' || (filter === 'buy' ? side === 'short' : side === 'long');
}

/**
 * Filter `items` (oldest first, as `LiquidationBook.items` holds them) and group fixed `windowMs` slices of one market and side when `group`
 * is on. Returns rows newest-first (descending `t`), ready for the tape list and the pinned strip. With `coins` (units.ts) each row adds up
 * its coins too; without, none of their work is done.
 */
export function buildLiqRows(items: readonly Liquidation[], filter: LiqFilter, group: boolean, windowMs = LIQ_GROUP_MS, coins = false): LiqRow[] {
  const out: LiqRow[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const l = items[i]!;
    if (l.usd < filter.minUsd || !liqSideMatches(l.side, filter.side) || !filter.shown(l.id)) continue;
    const prev = out.length ? out[out.length - 1]! : null;
    if (group && prev && prev.id === l.id && prev.side === l.side && Math.floor(prev.t / windowMs) === Math.floor(l.t / windowMs)) {
      const prevQty = prev.usd / prev.price, addQty = l.usd / l.price;
      prev.usd += l.usd; if (coins) prev.coins += liqCoins(l);
      prev.signedUsd = prev.side === 'short' ? prev.usd : -prev.usd;
      prev.price = prev.usd / (prevQty + addQty);
      prev.lo = Math.min(prev.lo, l.price); prev.hi = Math.max(prev.hi, l.price);
      prev.count++;
      if (l.usd > prev.rep.usd) { prev.rep = l; prev.reported = l.reported; prev.kind = l.kind; }
      continue;
    }
    const signedUsd = l.side === 'short' ? l.usd : -l.usd;
    out.push({
      key: `${l.id}|${l.t}|${l.side}|${Math.round(l.usd * 100)}`,
      t: l.t, id: l.id, side: l.side, signedUsd, usd: l.usd, coins: coins ? liqCoins(l) : 0, price: l.price, lo: l.price, hi: l.price,
      rep: l, reported: l.reported, kind: l.kind, count: 1,
    });
  }
  return out;
}

/**
 * The tint share for liquidation rows: stronger than `ORDER_TINT` (0.07) so liquidations pop out unmistakably in Both mode, while staying
 * well within the 22 % contrast ceiling checked across all 23 palettes.
 */
export const LIQ_TINT = 0.14;

/** Full bar dollars for a single liquidation row (BTC store dollars, coin-scaled by caller). */
export function liqBarFull(minUsd: number): number {
  return minUsd < 1_000 ? 10_000 : minUsd < 5_000 ? 25_000 : minUsd < 10_000 ? 50_000 : minUsd < 25_000 ? 100_000 : minUsd < 100_000 ? 250_000 : Math.max(500_000, minUsd * 5);
}

/** Full bar dollars for one side of a time-grouped liquidation block of `B` seconds (BTC store dollars, coin-scaled by caller). */
const LIQ_SCALE_ANCHORS: readonly (readonly [number, number])[] = [[1, 100e3], [60, 2e6], [300, 6e6], [900, 15e6]];
export function liqBlockFullScale(B: number): number {
  const a = LIQ_SCALE_ANCHORS;
  if (B <= a[0]![0]) return a[0]![1] * B;
  for (let i = 1; i < a.length; i++) {
    const [x1, y1] = a[i]!, [x0, y0] = a[i - 1]!;
    if (B <= x1) return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * (Math.log(B / x0) / Math.log(x1 / x0)));
  }
  const [xl, yl] = a[a.length - 1]!;
  return yl * B / xl;
}

/** First index in ascending `items` with `t >= target`. */
export function lowerBoundLiq(items: readonly Liquidation[], target: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid]!.t < target) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Summary of liquidations in [t0, t1) matching `filter`: forced buys (shorts liquidated), forced sells (longs liquidated) and count; with
 * `coins`, the same sides in coins too (`liqCoins`).
 */
export function summarizeLiqsIn(items: readonly Liquidation[], t0: number, t1: number, filter: LiqFilter, coins = false): { buy: number; sell: number; n: number; coins?: { buy: number; sell: number } } {
  let buy = 0, sell = 0, n = 0, cBuy = 0, cSell = 0;
  for (let i = lowerBoundLiq(items, t0); i < items.length; i++) {
    const l = items[i]!;
    if (l.t >= t1) break;
    if (l.usd < filter.minUsd || !liqSideMatches(l.side, filter.side) || !filter.shown(l.id)) continue;
    if (l.side === 'short') { buy += l.usd; if (coins) cBuy += liqCoins(l); } else { sell += l.usd; if (coins) cSell += liqCoins(l); }
    n++;
  }
  return coins ? { buy, sell, n, coins: { buy: cBuy, sell: cSell } } : { buy, sell, n };
}

/** Rows in descending `rows` whose `t` falls inside `[tMin, tMax]` (inclusive). */
export function liqRowsInRange(rows: readonly LiqRow[], tMin: number, tMax: number): LiqRow[] {
  if (!rows.length || tMax < rows[rows.length - 1]!.t || tMin > rows[0]!.t) return [];
  // Binary search first row with t <= tMax (rows are descending by t).
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid]!.t > tMax) lo = mid + 1; else hi = mid; }
  const out: LiqRow[] = [];
  for (let i = lo; i < rows.length && rows[i]!.t >= tMin; i++) out.push(rows[i]!);
  return out;
}
