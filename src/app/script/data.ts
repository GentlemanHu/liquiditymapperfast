import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import type { AppState } from '../store.ts';
import { FlowCache } from '../delta/candles.ts';
import { deltaFlows, deltaIds, ensureDeltaFlow } from '../delta/flows.ts';
import { flowLoadIds } from '../cvd/ids.ts';
import { DAY_MS, liquidationBuckets, type LiquidationDay } from '../panes/bar-stats.ts';
import { LIQUIDATIONS_PER_ANSWER, LIQUIDATION_RETENTION_MS } from '../../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../../shared/recorder.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { candleArrays, filterKey, marketInfo, marketsMatching, sourceInputs, type BarInputs, type SourceFilter } from './inputs.ts';

/**
 * Gathers what the scripts read from what the page holds: the chart's candles, the taker flow of the flow column's ALL VENUES markets (the
 * Delta pane's, from the same flow book, so the two always count the same), and the liquidations, a UTC day per answer as the Bar stats
 * ask for them. It asks the hub for the flow the candles need and loads the liquidation days itself; `changed` is called when some landed.
 */
export class ScriptData {
  #caches = new Map<string, FlowCache>();
  #liqDays = new Map<number, LiquidationDay & { at: number }>();
  #liqLoading = new Set<number>();
  #liqRetry = new Map<number, number>();
  /** Counts what has landed, so a reader can tell new inputs from the same ones. */
  version = 0;
  /** Whether a day of liquidations the last inputs read held more than the source answers (the smallest are missing). */
  liquidationsCut = false;

  constructor(private hub: Hub, private changed: () => void) {}

  /** The markets each filter holds, out of the flow column's ALL VENUES markets. */
  markets(state: AppState, filters: ReadonlyMap<string, SourceFilter>): Map<string, string[]> {
    const all = deltaIds(state, this.hub.flow).map(id => marketInfo(state.markets, id));
    const out = new Map<string, string[]>();
    for (const [key, f] of filters) out.set(key, key === '' ? all.map(m => m.id) : marketsMatching(all, f));
    return out;
  }

  /** The inputs over the chart's candles for each filter; null while there are no candles. */
  inputs(state: AppState, filters: ReadonlyMap<string, SourceFilter>): BarInputs | null {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, now = pageNow();
    // In a replay a script reads only the candles that had closed by its moment: the candle under way then is not known yet, nor anything after.
    const rows = replaying() ? state.candles.filter(r => r[0] + tf <= now) : state.candles;
    const candles = candleArrays(rows, tf, now);
    const n = candles.time.length;
    if (!n) return null;
    const starts = Array.from(candles.time);
    ensureDeltaFlow(this.hub, flowLoadIds(state, this.hub.flow.ids), starts[0]!, Date.now());
    const markets = this.markets(state, filters);
    const liq = this.#liquidations(starts, tf, now);
    const sources: BarInputs['sources'] = {};
    this.liquidationsCut = false;
    for (const [key, ids] of markets) {
      sources[key] = sourceInputs(candles.time, ids, {
        flows: list => {
          const k = list.join(',');
          let cache = this.#caches.get(k);
          if (!cache) { cache = new FlowCache(); this.#caches.set(k, cache); if (this.#caches.size > 64) this.#caches.delete(this.#caches.keys().next().value!); }
          return deltaFlows(cache, this.hub.flow, list, starts, tf, now).flows;
        },
        liquidations: list => { if (!liq) return undefined; const b = liquidationBuckets(this.#liqDays, list, starts, tf, liq.cover, now); if (b.cut) this.liquidationsCut = true; return b; },
      });
    }
    return { tf, ...candles, sources };
  }

  /** A filter's key (the same `filterKey` the scripts' analysis gives). */
  static key(f: SourceFilter): string { return filterKey(f); }

  /**
   * Ask for the liquidation days the candles reach (not before what the source keeps, nor before the recording started), two at a time;
   * a day already held is asked again once what is held of it is half a minute old while it is not over. Null when the source has none.
   */
  #liquidations(starts: readonly number[], tf: number, now: number): { cover: number } | null {
    const source = this.hub.source;
    if (!source.liquidations) return null;
    const retention = source.kind === 'browser' ? BROWSER_RETENTION_MS : LIQUIDATION_RETENTION_MS;
    const cover = Math.max(Math.ceil((Date.now() - retention) / 60_000) * 60_000, this.hub.recordedSince > 0 ? this.hub.recordedSince : 0);
    const from = Math.max(starts[0]!, cover), to = Math.min(starts[starts.length - 1]! + tf, now);
    const wall = Date.now();
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS && this.#liqLoading.size < 2; day -= DAY_MS) {
      const held = this.#liqDays.get(day);
      if (this.#liqLoading.has(day) || wall < (this.#liqRetry.get(day) ?? 0) || (held && (held.to >= day + DAY_MS || wall - held.at < 30_000))) continue;
      this.#liqLoading.add(day);
      const asked = Date.now();
      source.liquidations(day, day + DAY_MS).then(rows => {
        this.#liqRetry.delete(day);
        this.#liqDays.set(day, { rows, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, to: Math.min(day + DAY_MS, asked), at: Date.now() });
        this.version++;
      }, () => { this.#liqRetry.set(day, Date.now() + 15_000); }).finally(() => { this.#liqLoading.delete(day); this.changed(); });
    }
    for (const day of [...this.#liqDays.keys()]) if (day + DAY_MS < from - DAY_MS || day > to + DAY_MS) this.#liqDays.delete(day);
    return { cover };
  }
}
