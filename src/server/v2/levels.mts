import { baseSizeUsdRate, usdBookLevels } from '../../core/book-valuation.mts';
import { hyperliquidBookStep, hyperliquidLevelBounds } from '../../analytics/hyperliquid-bounds.mts';
import { gridStepFor } from '../../shared/grid.ts';
import { mergeByDistance } from '../../shared/merge.ts';
import { splitTouch, type SideLevels, type ValuedBook } from '../../shared/levels.ts';
import { beyond, type FarBook } from '../../shared/far-book.ts';

export { MAX_CROSSED_BP, crossedByBp, type SideLevels, type ValuedBook } from '../../shared/levels.ts';

interface BookLike {
  bids?: readonly unknown[] | null;
  asks?: readonly unknown[] | null;
  nSigFigs?: unknown;
  mantissa?: unknown;
  sourceGrouping?: unknown;
  sourceTimestamp?: unknown;
  receivedAt?: unknown;
  complete?: unknown;
  gap?: unknown;
  [key: string]: unknown;
}
interface MarketLike { venue?: unknown; [key: string]: unknown }

const empty = (): SideLevels => ({ lo: new Float64Array(0), hi: new Float64Array(0), usd: new Float64Array(0) });

/**
 * Price band a level covers. A grouped level (Hyperliquid's significant figures, Deribit's grouping) names a bid group by its lower edge and
 * an ask group by its upper edge, so a bid holds [P, P + step) and an ask (P - step, P] (both measured against the ungrouped book 2026-10-11).
 */
function band(price: number, book: BookLike, side: 'bid' | 'ask', bestBid: number, bestAsk: number): { lo: number; hi: number; coarse: boolean } {
  const sigFigs = Number(book.nSigFigs);
  if (Number.isInteger(sigFigs) && sigFigs >= 2 && sigFigs <= 5) {
    try {
      // Hyperliquid groups the whole book at one step, its best bid's (`hyperliquidBookStep`).
      const mantissa = Number(book.mantissa), m = Number.isInteger(mantissa) ? mantissa : undefined;
      const bounds = hyperliquidLevelBounds(price, side, sigFigs, m, hyperliquidBookStep(bestBid, bestAsk, sigFigs, m));
      return { lo: bounds.lower, hi: bounds.upper, coarse: true };
    } catch { /* fall through to a point level */ }
  }
  const grouping = Number(book.sourceGrouping);
  if (Number.isFinite(grouping) && grouping > 0) return side === 'bid' ? { lo: price, hi: price + grouping, coarse: true } : { lo: price - grouping, hi: price, coarse: true };
  return { lo: price, hi: price, coarse: false };
}

/** True when an object has at least one own key (cheaper than building the key list). */
function hasKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const _ in value as Record<string, unknown>) return true;
  return false;
}

/**
 * One side of a plain book (tuples of price and base amount) as USD point levels, in one pass into typed arrays. Null when any row is not
 * a plain tuple (a supplied notional, an object row), so the caller falls back to the general path; rows that are not positive numbers are
 * skipped exactly as the general path skips them.
 */
function plainSide(rows: readonly unknown[] | null | undefined, rate: number): SideLevels | null {
  const list = rows ?? [];
  const lo = new Float64Array(list.length), usd = new Float64Array(list.length);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!Array.isArray(row) || (row.length > 2 && row[2] !== undefined && row[2] !== null)) return null;
    const price = +row[0]!, amount = +row[1]!;
    if (!(price > 0) || !Number.isFinite(price) || !(amount > 0) || !Number.isFinite(amount)) continue;
    const quote = price * amount, value = quote * rate;
    if (!(Number.isFinite(quote) && Number.isFinite(value) && value >= 0)) continue;
    lo[n] = price; usd[n] = value; n++;
  }
  return n === list.length ? { lo, hi: lo, usd } : { lo: lo.slice(0, n), hi: lo.slice(0, n), usd: usd.slice(0, n) };
}

/**
 * A book with its far levels (shared/far-book.ts) after its own on each side: only those strictly past its deepest level, so the WebSocket
 * book stays the authority wherever it reaches. Everything else (stamps, units, completeness) is the book's own. A side the book does
 * not hold, or a grouped book, takes none.
 */
export function withFar<B extends BookLike>(book: B, far: FarBook): B {
  const bids = book.bids ?? [], asks = book.asks ?? [];
  if (!bids.length || !asks.length || Number(book.nSigFigs) > 0 || Number(book.sourceGrouping) > 0) return book;
  let lowestBid = Infinity, highestAsk = -Infinity;
  for (const row of bids) { const p = Array.isArray(row) ? Number(row[0]) : NaN; if (p > 0 && p < lowestBid) lowestBid = p; }
  for (const row of asks) { const p = Array.isArray(row) ? Number(row[0]) : NaN; if (p > highestAsk) highestAsk = p; }
  const farBids = beyond(far.bids, lowestBid, 'bid'), farAsks = beyond(far.asks, highestAsk, 'ask');
  return farBids.length || farAsks.length ? { ...book, bids: [...bids, ...farBids], asks: [...asks, ...farAsks] } : book;
}

/** Convert a retained venue book to USD-valued levels. Returns null for gapped, incomplete or unvaluable books. */
/** `step` is the instrument's recorder grid step; merged buckets divide it so they never straddle a recorded bin. */
/** `touch` is the instrument's last trade price when fresh: where a grouped book's shared top group is split between bids and asks (`splitTouch`). */
export function valueBook(instrumentId: string, book: BookLike | null | undefined, market: MarketLike | null, now: number, step?: number, touch?: number): ValuedBook | null {
  if (!book || book.gap === true || book.complete === false) return null;
  // BitMEX's inverse contracts (XBTUSD) are worth exactly 1 USD each but the metadata carries no contract value.
  const sized = market && market.inverse === true && String(market.venue ?? '') === 'bitmex' && !(Number(market.contractValue) > 0) && book.contractValue === undefined
    ? { ...market, contractValue: 1 } : market;
  const plain = !(Number(book.nSigFigs) > 0) && !(Number(book.sourceGrouping) > 0) && !hasKeys((book.levelMetadata as { bids?: unknown } | undefined)?.bids) && !hasKeys((book.levelMetadata as { asks?: unknown } | undefined)?.asks);
  const rate = plain ? baseSizeUsdRate(book, sized) : null;
  if (rate !== null) {
    const fastBids = plainSide(book.bids, rate), fastAsks = plainSide(book.asks, rate);
    if (fastBids && fastAsks && (fastBids.usd.length || fastAsks.usd.length)) return finish(instrumentId, book, market, now, step, false, fastBids, fastAsks);
  }
  const rows = usdBookLevels(book, sized);
  if (rows.length === 0) return null;
  const sides = { bid: { lo: [] as number[], hi: [] as number[], usd: [] as number[] }, ask: { lo: [] as number[], hi: [] as number[], usd: [] as number[] } };
  let coarse = false, bestBid = -Infinity, bestAsk = Infinity;
  for (const row of rows) { if (row.side === 'bid') bestBid = Math.max(bestBid, row.price); else bestAsk = Math.min(bestAsk, row.price); }
  for (const row of rows) {
    const b = band(row.price, book, row.side, bestBid, bestAsk);
    coarse ||= b.coarse;
    const side = sides[row.side];
    side.lo.push(b.lo); side.hi.push(b.hi); side.usd.push(row.notionalUsd);
  }
  const pack = (side: { lo: number[]; hi: number[]; usd: number[] }): SideLevels =>
    side.usd.length === 0 ? empty() : { lo: Float64Array.from(side.lo), hi: Float64Array.from(side.hi), usd: Float64Array.from(side.usd) };
  return finish(instrumentId, book, market, now, step, coarse, pack(sides.bid), pack(sides.ask), touch);
}

/** Merge far levels (point books only), split a grouped book's shared top group (at `hint`, the last trade), and stamp the result. */
function finish(instrumentId: string, book: BookLike, market: MarketLike | null, now: number, step: number | undefined, coarse: boolean, bidSide: SideLevels, askSide: SideLevels, hint?: number): ValuedBook {
  const stamp = Number(book.sourceTimestamp);
  const received = Number(book.receivedAt);
  let bids = bidSide, asks = askSide, touch: ValuedBook['touch'], merged: number | undefined;
  if (coarse) ({ bids, asks, touch } = splitTouch(bids, asks, hint));
  else if (bids.usd.length && asks.usd.length) {
    const mid = (bids.hi[0]! + asks.lo[0]!) / 2;
    // The step the buckets were made on travels with the book (`ValuedBook.step`): a reader compares it over time on that grid.
    if (mid > 0) { const grid = step && step > 0 ? step : gridStepFor(mid); bids = mergeByDistance(bids, mid, grid, true); asks = mergeByDistance(asks, mid, grid, false); merged = grid; }
  }
  return {
    instrumentId, venue: String(market?.venue ?? instrumentId.split(':')[0]),
    timestamp: Number.isFinite(stamp) && stamp > 0 ? stamp : Number.isFinite(received) && received > 0 ? received : now,
    coarse, bids, asks, ...(touch ? { touch } : {}), ...(merged !== undefined ? { step: merged } : {}),
  };
}
