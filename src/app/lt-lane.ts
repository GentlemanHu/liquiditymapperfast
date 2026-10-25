/**
 * The Liquidity Tracker's own way to its data. The pane used to read the recorded columns the map is drawn from: every market's book bins
 * for the whole view, 20 to 27 MB and 40 s on a busy server at ten days, behind which the tracker waited (and again whenever a venue came
 * or went, or the zoom changed the step; measured 2026-10-24), to use 128 bytes a minute of them. The lane asks the server for the tracker
 * alone, over the live socket (a page's HTTP requests to its server queue behind the history ones), at a step of its own from the pane's
 * width: four numbers a window and market, a few hundred kilobytes, the newest day first.
 *
 * It holds what it was told per market (a venue that goes and comes back is not asked again), asks only for what is missing and, while
 * the view reaches the present, for the newest windows again every `LT_REFRESH_MS`, one question at a time. Only the unfiltered tracker
 * is kept this way (a size filter needs the books: the pane reads the columns then, as before), and a window the tracker does not cover
 * whole is a gap here, never an estimate (`shared/lt-windows.ts`).
 */
import { LT_FIELDS, LT_HALF_LIVES } from '../shared/lt-sample.ts';
import type { LtFrame } from './wire.ts';

const MINUTE = 60_000;
/** How often the newest windows are asked again while the view reaches the present. */
export const LT_REFRESH_MS = 15_000;
/** How long after a failed question the next is asked (the pane reads the columns meanwhile, unless the lane has data). */
export const LT_RETRY_MS = 10_000;
/** How long after the server refused a question for its limit (a burst of questions given up and asked again) the next is asked. */
export const LT_BUSY_MS = 2_000;
/** A market the pane has not asked about for this long is let go. */
export const LT_FORGET_MS = 10 * 60_000;
/** The windows of a market: their starts, and LT_FIELDS numbers each. */
interface Windows { times: number[]; values: number[] }
/** What the lane holds of a market: the span it was asked for, how far its windows are final, and when it was last asked. */
interface Cover { from: number; to: number; settled: number; at: number }
export interface LaneInstrument { id: string; times: Float64Array; values: Float32Array }
export type LaneAsk = (ids: string[], from: number, to: number, stepMs: number, half: number, onFrame: (frame: LtFrame) => void, signal?: AbortSignal) => Promise<void>;

/** The step of the lane's windows for a view `span` ms wide on `widthPx` pixels: about two pixels a window, in minutes that double from one level to the next. */
export const laneStepMs = (span: number, widthPx: number): number => MINUTE * 2 ** Math.max(0, Math.round(Math.log2(span / Math.max(1, widthPx) * 2 / MINUTE)));

/** `old` with its windows in [from, to) replaced by `times`/`values` (those in the order of time, as a frame has them). */
export function mergeWindows(old: Windows | undefined, from: number, to: number, times: ArrayLike<number>, values: ArrayLike<number>): Windows {
  const out: Windows = { times: [], values: [] };
  const keep = (i: number): void => { out.times.push(old!.times[i]!); for (let k = 0; k < LT_FIELDS; k++) out.values.push(old!.values[i * LT_FIELDS + k]!); };
  let i = 0;
  if (old) while (i < old.times.length && old.times[i]! < from) keep(i++);
  for (let j = 0; j < times.length; j++) { out.times.push(times[j]!); for (let k = 0; k < LT_FIELDS; k++) out.values.push(values[j * LT_FIELDS + k]!); }
  if (old) { while (i < old.times.length && old.times[i]! < to) i++; while (i < old.times.length) keep(i++); }
  return out;
}

export class LtLane {
  /** The step and half-life (an index into LT_HALF_LIVES) of what is held; bumped on every change, so a pane can tell when to read again. */
  stepMs = MINUTE; half = -1; version = 0;
  readonly #series = new Map<string, Windows>();
  readonly #cover = new Map<string, Cover>();
  /** When the pane last asked about each market: one it has not asked about for `LT_FORGET_MS` is let go (another coin's markets would pile up). */
  readonly #seen = new Map<string, number>();
  #key = '';
  #loading: AbortController | null = null;
  #retryAt = 0; #failures = 0;

  /**
   * `ask`: where the answers come from (a source whose socket answers them; none, and the lane is not there). `publish`: hands the series held to
   * whoever computes with them. `now`: the source's clock. `changed`: something new was held, or a wait for another try has ended.
   */
  constructor(private readonly ask: LaneAsk | undefined, private readonly publish: (stepMs: number, half: number, instruments: LaneInstrument[]) => void,
    private readonly now: () => number, private readonly changed: () => void) {}

  /** Whether this source has a lane at all. */
  get available(): boolean { return this.ask !== undefined; }
  /** Whether the pane can draw from it: it holds something for what is on screen, or has not yet failed to. */
  get usable(): boolean { return this.ask !== undefined && (this.#series.size > 0 || this.#failures === 0); }
  /** Whether it holds anything for the step and half-life on screen. */
  get holds(): boolean { return this.#series.size > 0; }

  /**
   * What the pane does at every frame: see that the lane holds what the view needs (`ensure`), and say where the pane reads from, the lane (true)
   * or the recorded columns (false). The columns where there is no lane, where a size filter is set (the lane has the unfiltered tracker only),
   * where the half-life is not one the tracker is kept for, and while the lane has failed and holds nothing. The lane is asked at every frame in
   * every case it can be, so a failure is tried again when its wait is over: it must not depend on being read.
   */
  serve(ids: readonly string[], view: { t0: number; t1: number }, widthPx: number, halfLifeBp: number, filtered: boolean): boolean {
    if (!this.ask || filtered || !(LT_HALF_LIVES as readonly number[]).includes(halfLifeBp)) return false;
    this.ensure(ids, view, widthPx, halfLifeBp);
    return this.usable;
  }

  /**
   * Make sure the lane holds the tracker of `ids` over `view` (with a view of margin on the left, half a one on the right) at the step the
   * pane's width gives, for the half-life `halfLifeBp`. Safe to call at every frame: it does nothing while a question runs or its wait after a
   * failure lasts, or when everything asked for is held.
   */
  ensure(ids: readonly string[], view: { t0: number; t1: number }, widthPx: number, halfLifeBp: number): void {
    const half = (LT_HALF_LIVES as readonly number[]).indexOf(halfLifeBp), span = view.t1 - view.t0;
    if (!this.ask || half < 0 || !(span > 0)) return;
    const stepMs = laneStepMs(span, widthPx), key = `${half}|${stepMs}`, now = this.now();
    if (key !== this.#key) {
      // Another step or half-life: what is held means something else. The question under way is given up (the server is told). A failure stays
      // known (a server that cannot answer would otherwise show an empty lane at every step of a zoom before failing again), but is tried at once.
      this.#loading?.abort(); this.#loading = null;
      this.#key = key; this.stepMs = stepMs; this.half = half; this.#series.clear(); this.#cover.clear(); this.#retryAt = 0;
      this.version++; this.publish(stepMs, half, []);
    }
    this.#forget(ids, now);
    if (this.#loading || now < this.#retryAt || !ids.length) return;
    // A view of margin on the left (a pan or a zoom out is mostly held already), half a one on the right, which never reaches past the open minute.
    const reachFrom = Math.floor((view.t0 - span) / stepMs) * stepMs;
    const wantTo = Math.min(Math.ceil((view.t1 + span * 0.5) / stepMs) * stepMs, now), reachTo = Math.min(wantTo, now + MINUTE);
    const live = view.t1 >= now - 2 * Math.max(stepMs, MINUTE);
    let from = Infinity, to = -Infinity;
    const asked: string[] = [];
    for (const id of ids) {
      const c = this.#cover.get(id);
      const left = !c || c.from > reachFrom, right = !c || c.to < wantTo - stepMs || (live && now - c.at >= LT_REFRESH_MS);
      if (!left && !right) continue;
      // Only the gap: to the held part's start (a pan left), from where its windows are final (the newest again), or all of it.
      const f = left || !c ? reachFrom : Math.min(c.settled, c.to), t = right || !c ? reachTo : c.from;
      if (!(t > f)) continue;
      asked.push(id); from = Math.min(from, f); to = Math.max(to, t);
    }
    if (!asked.length) return;
    const controller = this.#loading = new AbortController();
    const asking = { key, from, to };
    void this.ask(asked, from, to, stepMs, half, frame => this.#take(asking, frame), controller.signal).then(() => {
      if (this.#loading !== controller) return;
      this.#loading = null; this.#failures = 0;
      const at = this.now(), settledNow = Math.floor((at - 2 * MINUTE) / stepMs) * stepMs;
      for (const id of asked) {
        const c = this.#cover.get(id);
        // A question that did not reach the right end of what is held (a pan left) says nothing new of its newest windows: they are as final, and as
        // fresh, as they were, or the next refresh would ask for everything held again.
        const right = !c || to >= c.to;
        this.#cover.set(id, { from: Math.min(c?.from ?? from, from), to: Math.max(c?.to ?? to, to),
          settled: right ? Math.min(Math.max(settledNow, c?.settled ?? -Infinity), to) : c.settled, at: right ? at : c.at });
      }
      this.changed();
    }, (error: unknown) => {
      if (this.#loading !== controller) return;
      this.#loading = null;
      if (error instanceof Error && error.message === 'cancelled') return;
      // The server's own limit (a burst of questions given up and asked again) is a short wait and no failure; anything else is one.
      const busy = error instanceof Error && error.message.includes('too many');
      if (!busy) this.#failures++;
      this.#retryAt = this.now() + (busy ? LT_BUSY_MS : LT_RETRY_MS);
      this.#wake();
      this.changed();
    });
  }

  /** The pane draws when something happens to it, and a view that stands still would never try again: say when the wait is over. */
  #wake(): void {
    const timer = setTimeout(() => this.changed(), Math.max(0, this.#retryAt - this.now()) + 20);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Note the markets asked about now, and let go of those not asked about for a long while. */
  #forget(ids: readonly string[], now: number): void {
    for (const id of ids) this.#seen.set(id, now);
    if (this.#seen.size === ids.length) return;
    for (const [id, at] of this.#seen) {
      if (now - at <= LT_FORGET_MS) continue;
      this.#seen.delete(id); this.#series.delete(id); this.#cover.delete(id);
    }
  }

  /** A part of an answer: its windows replace the ones held over its span, and are handed on. */
  #take(asking: { key: string; from: number; to: number }, frame: LtFrame): void {
    if (asking.key !== this.#key || frame.stepMs !== this.stepMs || frame.half !== this.half) return;
    for (const item of frame.instruments) this.#series.set(item.id, mergeWindows(this.#series.get(item.id), frame.from, frame.to, item.times, item.values));
    this.version++;
    this.publish(this.stepMs, this.half, [...this.#series].map(([id, w]) => ({ id, times: Float64Array.from(w.times), values: Float32Array.from(w.values) })));
    this.changed();
  }
}
