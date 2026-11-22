import { LIQUIDATIONS_PER_ANSWER, LIQUIDATION_RETENTION_MS } from '../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../shared/recorder.ts';
import type { Hub } from './hub.ts';
import { DAY_MS, type LiquidationDay } from './panes/bar-stats.ts';

/**
 * Where the liquidations the Bar stats and the Flow history count begin: what the record keeps (a week on a server, a day in a page's own
 * engine), and only since the recording started, to the next whole minute (a candle half expired is not known either, and the edge does
 * not change on every frame). Both panes and the Flow history's warm-up read the same days.
 */
export function liquidationCover(kind: 'server' | 'browser', recordedSince: number, now: number): number {
  const retention = kind === 'browser' ? BROWSER_RETENTION_MS : LIQUIDATION_RETENTION_MS;
  return Math.max(Math.ceil((now - retention) / 60_000) * 60_000, recordedSince > 0 ? recordedSince : 0);
}

/** How long a pane's stretch is kept without the pane asking again (it asks on every drawing): a pane put away stops holding days. */
const WANT_MS = 120_000;
/**
 * How long the warm-up's stretch counts as needed: days held before any pane asks, for the Flow history to open on at once. They go at the
 * first look after it (a pane's `ensure`, or another warm-up), not on a clock of their own.
 */
export const WARM_MS = 30 * 60_000;

/**
 * Liquidations of the markets counted, every size the record keeps, by UTC day: each day asked on its own, so an answer holds a whole day
 * (BTC: 900 to 3,500) rather than the largest 5,000 of a week; the day under way asked again every half minute; two at a time, the newest
 * first; a day whose question failed asked again after its own pause, the others meanwhile. One loader for the Bar stats and the Flow
 * history, which count the same markets (`HeatPane.liquidationMarkets`: the perpetuals whatever the Spot / Perp filter), so a day is asked
 * once however many of them show: each says the stretch it needs (`ensure`), and a day is kept while any of them needs it. Before either
 * shows, the Flow history's warm-up (`warm`, size-history/warm.ts) holds the days its row will read first.
 */
export class LiquidationDays {
  #days = new Map<number, LiquidationDay & { at: number }>();
  #ids = '';
  #loading = new Set<number>();
  #version = 0;
  #retry = new Map<number, number>();
  /** The stretch each pane needs, [from, to), and when it last said so. */
  #wants = new Map<string, { from: number; to: number; at: number }>();
  /** The warm-up's stretch (`warm`), kept WARM_MS from when it was last set. */
  #warm: { from: number; to: number; at: number } | null = null;
  #listeners = new Set<() => void>();
  /**
   * Days answered and failed so far, those of the markets asked only (an answer for others is dropped uncounted): the Flow history's
   * warm-up lets a source go after six failures in a row (size-history/warm.ts).
   */
  readonly tally = { answers: 0, failures: 0 };

  constructor(private readonly hub: Pick<Hub, 'source'>) {}

  /** Bumped whenever a day lands or the markets change, for what is worked out from the days. */
  get version(): number { return this.#version; }
  /** The markets the days held are of (comma list, as `ensure` was given it). */
  get ids(): string { return this.#ids; }
  get days(): ReadonlyMap<number, LiquidationDay> { return this.#days; }
  /** Called whenever an answer comes back (a day landed, or its slot is free for the next): the panes draw again. */
  listen(fn: () => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  /**
   * `caller` needs the days of [from, to) of the markets `ids`: ask for those not held, and again a day not answered to its end (the day under
   * way, or one asked before its midnight) once what is held of it is half a minute old.
   */
  ensure(caller: string, ids: string, from: number, to: number): void {
    const source = this.hub.source; if (!source.liquidations) return;
    this.#markets(ids);
    const now = Date.now();
    this.#wants.set(caller, { from, to, at: now });
    for (const [key, want] of this.#wants) if (now - want.at > WANT_MS) this.#wants.delete(key);
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS && this.#loading.size < 2; day -= DAY_MS) {
      const held = this.#days.get(day);
      if (this.#loading.has(day) || now < (this.#retry.get(day) ?? 0) || (held && (held.to >= day + DAY_MS || now - held.at < 30_000))) continue;
      this.#load(day, ids);
    }
    // Only the days around a stretch some pane still needs, or the warm-up holds, are kept.
    const wants = [...this.#wants.values(), ...(this.#warm && now - this.#warm.at <= WARM_MS ? [this.#warm] : [])];
    for (const day of [...this.#days.keys()]) if (!wants.some(w => day + DAY_MS >= w.from - DAY_MS && day <= w.to + DAY_MS)) this.#days.delete(day);
  }

  /**
   * The warm-up (HeatPane `#warmStep`, before any pane shows the days): ask for the days of [from, to) of `ids` not held at all, one at a
   * time, the newest first, and keep them WARM_MS. Nothing on the clock: a day held is not asked again here (the first pane to show it asks
   * for what changed since, the day under way included); a day whose question failed is asked again after its pause. `done` once every
   * day of the stretch is held, `asked` when a question went out now, `waiting` while one is out or every day missing is in its pause.
   */
  warm(ids: string, from: number, to: number): 'done' | 'asked' | 'waiting' {
    const source = this.hub.source; if (!source.liquidations) return 'done';
    this.#markets(ids);
    const now = Date.now();
    this.#warm = { from, to, at: now };
    let missing = false, asked = false;
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS; day -= DAY_MS) {
      if (this.#days.has(day)) continue;
      missing = true;
      if (!this.#loading.size && now >= (this.#retry.get(day) ?? 0)) { this.#load(day, ids); asked = true; }
    }
    // A warm-up of another stretch (another timeframe) lets the last one's days go, unless a pane still needs them.
    const wants = [...[...this.#wants.values()].filter(w => now - w.at <= WANT_MS), this.#warm];
    for (const day of [...this.#days.keys()]) if (!wants.some(w => day + DAY_MS >= w.from - DAY_MS && day <= w.to + DAY_MS)) this.#days.delete(day);
    return !missing ? 'done' : asked ? 'asked' : 'waiting';
  }

  /** Other markets counted: what is held is not theirs, and an answer still out for the old ones is dropped when it comes. */
  #markets(ids: string): void {
    if (ids !== this.#ids) { this.#ids = ids; this.#days = new Map(); this.#retry = new Map(); this.#version++; }
  }

  #load(day: number, ids: string): void {
    const source = this.hub.source; if (!source.liquidations) return;
    this.#loading.add(day);
    const asked = Date.now();
    source.liquidations(day, day + DAY_MS).then(rows => {
      if (ids !== this.#ids) return;
      this.tally.answers++; this.#retry.delete(day);
      this.#days.set(day, { rows, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, to: Math.min(day + DAY_MS, asked), at: Date.now() }); this.#version++;
    }, () => { if (ids === this.#ids) { this.tally.failures++; this.#retry.set(day, Date.now() + 15_000); } })
      // Drawn again whatever came back: the slot it held is free for the next day, an answer dropped for other markets included.
      .finally(() => { this.#loading.delete(day); for (const fn of this.#listeners) fn(); });
  }
}
