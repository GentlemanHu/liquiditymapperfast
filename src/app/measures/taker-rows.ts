import type { Hub } from '../hub.ts';
import type { AppState, CandleRow } from '../store.ts';
import { currentCoin } from '../coin.ts';
import { historyTarget } from '../keylevels/history.ts';

/** Whether a candle says who bought (its taker buys at index 7): a candle with nothing traded is one too (its trades and quote volume 0). */
const says = (b: CandleRow): boolean => (b as readonly (number | undefined)[])[7] !== undefined && b[5] >= 0;

/**
 * The exchange's own candles of the series the chart reads, by start, with their taker buys (index 7) and, where it reports them, their
 * trades and quote volumes (8 to 10): Binance's, perpetual or spot; null for a market that does not say who bought. The volume strip's candle
 * bars, the Bar stats table and the scripts' flow where the page recorded none read them. Each reader keeps its own (one map a version).
 *
 * Where the page reads the exchange itself (the browser), the chart's own candles carry these already (`shared/engine.ts candles`): they are
 * taken as they are, and only the candles that do not carry them (the newest, rebuilt by the live stream, which keeps no taker figures;
 * every candle from a server) are read from the exchange, from the first of them on, not the whole series again.
 */
export class TakerRows {
  #held: { key: string; candles: readonly CandleRow[]; rows: Map<number, CandleRow> } | null = null;

  /** The rows from `from` on, loading what is missing (`onLoad` when some land, for the reader that asked first while one load runs). */
  get(hub: Hub, state: AppState, tf: number, from: number, onLoad: () => void): Map<number, CandleRow> | null {
    const series = state.seriesInstrument || state.marketId, target = historyTarget(series, currentCoin()), venue = target?.id.slice(0, target.id.indexOf(':')) ?? '';
    if (!target || !target.own || (venue !== 'binance' && venue !== 'binancespot')) return null;
    // The chart's candles are of this series and timeframe only once loaded for them (right after a switch they are the last one's).
    const candles = state.candlesTimeframe === undefined || state.candlesTimeframe === state.timeframe ? state.candles : [];
    let missing = !candles.length || candles[0]![0] > from ? from : Infinity;
    if (missing === Infinity) for (const c of candles) if (c[0] >= from && !says(c)) { missing = c[0]; break; }
    const h = hub.candleTaker(tf);
    if (missing < Infinity) h.ensure(target, missing, tf, onLoad);
    const key = `${tf}|${h.id}|${h.version}`;
    if (this.#held?.key !== key || this.#held.candles !== candles) {
      const rows = new Map<number, CandleRow>();
      for (const b of h.bars) if (says(b)) rows.set(b[0], b);
      // The chart's own carry the same figures from the same read of the exchange: where both have a candle, the chart's is the newer read.
      for (const c of candles) if (says(c)) rows.set(c[0], c);
      this.#held = { key, candles, rows };
    }
    return this.#held.rows;
  }
}
