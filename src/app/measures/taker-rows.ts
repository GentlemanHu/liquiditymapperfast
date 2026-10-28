import type { Hub } from '../hub.ts';
import type { AppState, CandleRow } from '../store.ts';
import { currentCoin } from '../coin.ts';
import { historyTarget } from '../keylevels/history.ts';

/**
 * The exchange's own candles of the series the chart reads, by start, with their taker buys (index 7) and, where it reports them, their
 * trades and quote volumes (8 to 10): Binance's, perpetual or spot; null for a market that does not say who bought. The volume strip's candle
 * bars, the Bar stats table and the scripts' flow where the page recorded none read them. Each reader keeps its own (one map a version).
 */
export class TakerRows {
  #held: { key: string; rows: Map<number, CandleRow> } | null = null;

  /** The rows from `from` on, loading what is missing (`onLoad` when some land, for the reader that asked first while one load runs). */
  get(hub: Hub, state: AppState, tf: number, from: number, onLoad: () => void): Map<number, CandleRow> | null {
    const series = state.seriesInstrument || state.marketId, target = historyTarget(series, currentCoin()), venue = target?.id.slice(0, target.id.indexOf(':')) ?? '';
    if (!target || !target.own || (venue !== 'binance' && venue !== 'binancespot')) return null;
    const h = hub.candleTaker(tf);
    h.ensure(target, from, tf, onLoad);
    const key = `${tf}|${h.id}|${h.version}`;
    if (this.#held?.key !== key) {
      const rows = new Map<number, CandleRow>();
      // A candle with nothing traded is one too (its trades and quote volume 0): its readers guard their own division by its volume.
      for (const b of h.bars) { const tb = (b as readonly (number | undefined)[])[7]; if (tb !== undefined && b[5] >= 0) rows.set(b[0], b); }
      this.#held = { key, rows };
    }
    return this.#held.rows;
  }
}
