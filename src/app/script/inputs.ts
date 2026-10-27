import type { CandleRow, Market } from '../store.ts';
import type { CandleFlow } from '../delta/candles.ts';
import { familyKey } from '../cvd/families.ts';

/**
 * What a script reads, candle by candle, as flat arrays the page hands the script worker in one message: the chart's candles, and for each set
 * of markets a script asks for (`source(...)`, the flow column's ALL VENUES markets when it asks for none) the taker buys and sells and the
 * liquidations of each candle, in USD. A candle nothing was recorded in is NaN, never 0: a quiet candle and an unknown one must not look alike.
 */

/**
 * Which markets a set holds: by kind, exchange or quote currency (each absent: any). An exchange is its family (`binance` holds Binance's
 * spot and perpetual markets), or a family and a kind (`binance/perp`).
 */
export interface SourceFilter { kinds?: readonly ('spot' | 'perp')[]; venues?: readonly string[]; quotes?: readonly string[] }
/** A market as a filter sees it. */
export interface MarketInfo { id: string; venue: string; kind: 'spot' | 'perp'; quote: string }

/** The one key of a filter, whatever order its lists are in (the set the script worker asks for and the page answers). */
export function filterKey(f: SourceFilter): string {
  const part = (name: string, list: readonly string[] | undefined): string => list?.length ? `${name}=${[...new Set(list.map(s => s.toLowerCase()))].sort().join('+')}` : '';
  return [part('kind', f.kinds), part('venue', f.venues), part('quote', f.quotes)].filter(Boolean).join(';');
}

/** The markets of `all` a filter keeps. */
export function marketsMatching(all: readonly MarketInfo[], f: SourceFilter): string[] {
  const kinds = f.kinds?.length ? new Set(f.kinds) : null, quotes = f.quotes?.length ? new Set(f.quotes.map(q => q.toLowerCase())) : null;
  const venues = f.venues?.length ? f.venues.map(v => { const [family, kind] = v.toLowerCase().split('/'); return { family: family!, kind }; }) : null;
  return all.filter(m => {
    if (kinds && !kinds.has(m.kind)) return false;
    if (quotes && !quotes.has(m.quote.toLowerCase())) return false;
    const family = familyKey(m.venue.toLowerCase());
    return !venues || venues.some(v => v.family === family && (!v.kind || v.kind === m.kind));
  }).map(m => m.id);
}

/** A market's exchange, kind and quote from the market list (a market it does not list counts as a perpetual, as the flow column takes it). */
export function marketInfo(markets: readonly Market[], id: string): MarketInfo {
  const m = markets.find(x => (x.instrumentId ?? x.id) === id);
  const venue = m?.venue ?? id.split(':')[0] ?? id;
  return { id, venue, kind: m?.marketType === 'spot' ? 'spot' : 'perp', quote: (m?.quote ?? '').toUpperCase() };
}

/** One set of markets, candle by candle (USD; NaN where not recorded). */
export interface SourceInputs { vbuy: Float64Array; vsell: Float64Array; lbuy: Float64Array; lsell: Float64Array; markets: number }

export interface BarInputs {
  /** The chart's timeframe (ms). */
  tf: number;
  /** Each candle's start (ms), oldest first. */
  time: Float64Array;
  open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array;
  /** The chart market's traded volume, in coins. */
  volume: Float64Array;
  /** By `filterKey` ('' for the flow column's markets). */
  sources: Record<string, SourceInputs>;
  /** Whether the newest candle is still under way. */
  forming: boolean;
}

/**
 * A candle's taker buys and sells from its flow (the running delta over it and its gross volume): buys are half the gross plus half the
 * delta, sells the rest. NaN for both where the candle was not recorded.
 */
export function buysAndSells(flow: CandleFlow | null): [number, number] {
  if (!flow || !Number.isFinite(flow.gross) || !Number.isFinite(flow.delta)) return [NaN, NaN];
  const buy = Math.max(0, (flow.gross + flow.delta) / 2), sell = Math.max(0, (flow.gross - flow.delta) / 2);
  return [buy, sell];
}

/**
 * Liquidations by the side of the forced order: a short position liquidated is bought back (a forced buy, `lbuy`), a long one is sold
 * (`lsell`). The page records the side of the position liquidated, so this is the one place the two are matched.
 */
export function liquidationOrderSide(positionSide: 'long' | 'short'): 'buy' | 'sell' { return positionSide === 'short' ? 'buy' : 'sell'; }

/** The candles of a timeframe as arrays (oldest first; rows out of order or repeated are left out), and whether the newest is under way at `now`. */
export function candleArrays(rows: readonly CandleRow[], tf: number, now: number): Pick<BarInputs, 'time' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'forming'> {
  const kept: CandleRow[] = [];
  for (const r of rows) if (Number.isFinite(r[0]) && (!kept.length || r[0] > kept[kept.length - 1]![0])) kept.push(r);
  const n = kept.length, f = (i: number): Float64Array => Float64Array.from(kept, r => Number.isFinite(r[i]) ? r[i]! : NaN);
  return { time: f(0), open: f(1), high: f(2), low: f(3), close: f(4), volume: f(5), forming: n > 0 && kept[n - 1]![0] + tf > now };
}

/** What `sourceInputs` reads: each candle's flow over a set of markets (`delta/flows.ts deltaFlows`) and the liquidations by candle start. */
export interface SourceReader {
  flows(ids: readonly string[]): readonly (CandleFlow | null)[];
  /** Forced buys and sells by candle start over `ids`; a candle missing from the maps was not answered (NaN), one present with 0 had none. */
  liquidations(ids: readonly string[]): { buy: ReadonlyMap<number, number>; sell: ReadonlyMap<number, number> } | undefined;
}

/**
 * One set of markets' inputs over `time`. A set no market on the page belongs to (an exchange the page does not read) is 0 throughout, as the
 * scripts written for it expect: a sum over many exchanges must not turn unknown because one of them is missing.
 */
export function sourceInputs(time: Float64Array, ids: readonly string[], read: SourceReader): SourceInputs {
  const n = time.length;
  if (!ids.length) return { vbuy: new Float64Array(n), vsell: new Float64Array(n), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 0 };
  const vbuy = new Float64Array(n).fill(NaN), vsell = new Float64Array(n).fill(NaN), lbuy = new Float64Array(n).fill(NaN), lsell = new Float64Array(n).fill(NaN);
  {
    const flows = read.flows(ids);
    for (let i = 0; i < n; i++) { const [b, s] = buysAndSells(flows[i] ?? null); vbuy[i] = b; vsell[i] = s; }
    const liq = read.liquidations(ids);
    if (liq) for (let i = 0; i < n; i++) { const t = time[i]!, b = liq.buy.get(t), s = liq.sell.get(t); if (b !== undefined) lbuy[i] = b; if (s !== undefined) lsell[i] = s; }
  }
  return { vbuy, vsell, lbuy, lsell, markets: ids.length };
}

/** Every array of the inputs, each once (a buffer named twice cannot be handed over), for handing them to the worker without a copy. */
export function transferables(inputs: BarInputs): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [inputs.time, inputs.open, inputs.high, inputs.low, inputs.close, inputs.volume]) out.add(a.buffer as ArrayBuffer);
  for (const s of Object.values(inputs.sources)) for (const a of [s.vbuy, s.vsell, s.lbuy, s.lsell]) out.add(a.buffer as ArrayBuffer);
  return [...out];
}
