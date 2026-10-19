import { TIMEFRAMES } from '../shared/series.ts';
import { parsePriceHistory, type PriceHistoryAnswer, type PriceTarget } from '../shared/price-history.ts';
import type { CandleRow } from './store.ts';

export interface PriceWindow { tf: string; tfMs: number; from: number; to: number }
type Window = { t0: number; t1: number };
export type PriceReader = (id: string, tf: string, from: number, to: number, signal: AbortSignal) => Promise<PriceHistoryAnswer>;
const MINUTE = 60_000, DAY = 86_400_000;
const priceKey = (target: PriceTarget, tfMs: number): string => `${target.id}|${target.listing.symbol}|${target.listing.unit}|${tfMs}`;

/** The overview is useful for compressed candles or any missing part of the visible price history. */
export function priceOverviewNeeded(candles: readonly CandleRow[], tfMs: number, view: Window, width: number, now: number): boolean {
  const to = Math.min(view.t1, now), from = Math.max(0, view.t0);
  if (!(width > 0 && to > from && tfMs > 0)) return false;
  if (width * tfMs / (view.t1 - view.t0) < 2) return true;
  let end = Math.floor(from / tfMs) * tfMs;
  for (const c of candles) {
    if (c[0] + tfMs <= end) continue;
    if (c[0] > end) return true;
    end = c[0] + tfMs;
    if (end >= to) return false;
  }
  return true;
}

/** At most a few hundred native bars: daily for month-scale context, never finer than the selected candles; retain a resolution near its changeover. */
export function priceWindow(view: Window, width: number, now: number, previousMs = 0, chartMs = 0): PriceWindow | null {
  const span = view.t1 - view.t0;
  if (!(span > 0 && width > 0 && Number.isFinite(span) && view.t0 < now)) return null;
  const budget = Math.max(100, Math.min(400, Math.floor(width / 4)));
  const minimum = Math.max(chartMs, span >= 30 * DAY ? DAY : 0);
  const intervals = Object.entries(TIMEFRAMES), previous = intervals.find(([, ms]) => ms === previousMs && ms >= minimum);
  let choice = intervals.find(([, ms]) => ms >= minimum && span / ms <= budget) ?? intervals[intervals.length - 1]!;
  if (previous && span / previousMs >= budget / 5 && span / previousMs <= budget * 1.15) choice = previous;
  const [tf, tfMs] = choice;
  // At the largest interval bound the request structurally too; the map's permitted span is normally shorter than this.
  const from = Math.max(0, Math.floor((view.t0 - span * 0.15) / tfMs) * tfMs - tfMs);
  const to = Math.ceil(Math.min(view.t1 + span * 0.15, now + 1) / tfMs) * tfMs;
  return to > from && to - from <= 2_000 * tfMs ? { tf, tfMs, from, to } : null;
}

/**
 * The chart's one active overview. A short gesture delay coalesces requests; the newest view is remembered while a read is out. Old
 * points stay drawn through range/resolution changes, carrying their own interval. Another instrument cancels and clears them.
 */
export class ChartPriceHistory {
  answer: PriceHistoryAnswer | null = null;
  status: 'idle' | 'loading' | PriceHistoryAnswer['status'] = 'idle';
  version = 0;
  readonly #cached = new Map<string, { answer: PriceHistoryAnswer; landedAt: number }>();
  #id = ''; #generation = 0; #pending = false; #retryAt = 0; #landedAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #wanted: { target: PriceTarget; window: PriceWindow; changed: () => void } | null = null;
  constructor(private read: PriceReader, private now: () => number = Date.now, private delayMs = 120) {}

  ensure(target: PriceTarget, window: PriceWindow, changed: () => void): void {
    if (priceKey(target, 0) !== this.#id) {
      this.stop(); this.#controller?.abort(); this.#controller = null; this.#generation++;
      this.#pending = false; this.#id = priceKey(target, 0); this.answer = null; this.status = 'idle'; this.#retryAt = 0; this.version++;
    }
    this.#wanted = { target, window, changed };
    // Eight recent instrument/resolution windows survive zooms and coin switches. Recheck live tails before reusing them.
    const key = priceKey(target, window.tfMs), cached = this.#cached.get(key);
    if (!this.#pending && !this.#covers(window) && cached && this.#covers(window, cached.answer, cached.landedAt)) {
      this.answer = cached.answer; this.status = cached.answer.status; this.#landedAt = cached.landedAt; this.#retryAt = 0; this.version++;
      this.#cached.delete(key); this.#cached.set(key, cached); changed();
    }
    if (this.#pending || this.#timer !== null || this.now() < this.#retryAt || this.#covers(window)) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#load(); }, this.delayMs);
  }

  /** A hidden chart or a disabled candle layer starts no further reads; a bounded read already out may finish. */
  stop(): void { if (this.#timer !== null) clearTimeout(this.#timer); this.#timer = null; this.#wanted = null; }

  #covers(w: PriceWindow, a = this.answer, landedAt = this.#landedAt): boolean {
    if (!a || a.tfMs !== w.tfMs || a.from > w.from || a.to < w.to || a.status === 'stale' || a.status === 'failed') return false;
    const last = a.candles[a.candles.length - 1], partialClosed = last && last[0] + a.tfMs > a.asOf && last[0] + a.tfMs <= this.now();
    return !partialClosed && (w.to <= this.now() || this.now() - landedAt < MINUTE);
  }

  async #load(): Promise<void> {
    const wanted = this.#wanted; if (!wanted || this.#pending || this.now() < this.#retryAt || this.#covers(wanted.window)) return;
    const { target, window: w, changed } = wanted, generation = this.#generation, controller = new AbortController();
    this.#controller = controller; this.#pending = true;
    if (!this.answer?.candles.length) this.status = 'loading';
    changed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Price history timed out')); }, 25_000); });
      const a = parsePriceHistory(await Promise.race([this.read(target.id, w.tf, w.from, w.to, controller.signal), deadline]), target.id, w.tfMs);
      if (generation !== this.#generation) return;
      if (a.from > w.from || a.to < w.to) throw new Error('Incomplete price history window');
      if ((a.status === 'failed' || a.status === 'stale') && this.answer?.candles.length && !a.candles.length) {
        this.status = 'stale'; this.#retryAt = this.now() + MINUTE;
      } else {
        this.answer = a; this.status = a.status; this.#landedAt = this.now();
        if (a.status === 'ok' || a.status === 'empty') {
          const key = priceKey(target, w.tfMs);
          this.#cached.delete(key); this.#cached.set(key, { answer: a, landedAt: this.#landedAt });
          while (this.#cached.size > 8) this.#cached.delete(this.#cached.keys().next().value!);
        }
        this.#retryAt = a.status === 'failed' || a.status === 'stale' ? this.now() + MINUTE : 0;
      }
      this.version++;
    } catch {
      if (generation !== this.#generation) return;
      this.status = this.answer?.candles.length ? 'stale' : 'failed'; this.#retryAt = this.now() + MINUTE; this.version++;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (generation === this.#generation) {
        this.#pending = false; this.#controller = null; changed();
        const next = this.#wanted; if (next) this.ensure(next.target, next.window, next.changed);
      }
    }
  }
}

export interface PricePoint { t: number; price: number; start: number }

/** A Go to fit waits for its whole visible range; retained overlap is useful for drawing but cannot set the new scale. */
export function priceBounds(answer: PriceHistoryAnswer | null, id: string, view: Window, at: number, replay: boolean): { lo: number; hi: number } | null {
  const from = Math.max(0, view.t0), to = Math.min(view.t1, at);
  if (!answer || answer.instrumentId !== id || answer.status !== 'ok' || !(to > from) || answer.from > from || answer.to < to) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of answer.candles) if (c[0] + answer.tfMs > from && c[0] < to && (!replay || c[0] + answer.tfMs <= at)) {
    lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]);
  }
  return hi > lo ? { lo, hi } : null;
}

/** Closes belong to the end of their interval. A partial close stays at its observation time; replay never sees its later final value. */
export function pricePoints(answer: PriceHistoryAnswer, at: number, replay: boolean): PricePoint[][] {
  const runs: PricePoint[][] = [];
  let run: PricePoint[] | null = null, previous = -Infinity;
  for (const c of answer.candles) {
    const end = c[0] + answer.tfMs;
    if (replay && end > at) break;
    const t = Math.min(end, answer.asOf);
    if (t > at) break;
    if (c[0] !== previous + answer.tfMs) { run = []; runs.push(run); }
    run!.push({ t, price: c[4], start: c[0] }); previous = c[0];
  }
  return runs;
}

/** The latest observed close at this time, with no carry over a missing interval. */
export function pricePointAt(runs: readonly (readonly PricePoint[])[], time: number, tfMs: number): PricePoint | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!; let lo = 0, hi = run.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (run[mid]!.t <= time) lo = mid + 1; else hi = mid; }
    const point = run[lo - 1]; if (point) return time - point.t <= tfMs ? point : null;
  }
  return null;
}
