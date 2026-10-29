import type { Hub } from '../hub.ts';
import type { AppState } from '../store.ts';
import { COLUMNS_PER_REQUEST, type ColumnSet } from '../../shared/columns.ts';
import { BROWSER_RETENTION_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { settledBefore } from '../column-holds.ts';
import { marketInfo, type MarketInfo } from './inputs.ts';
import type { DepthBook, DepthMessage, DepthTag } from './depth.ts';

/**
 * The page's side of the scripts' order book (`depth.ts`): the recorded windows at the chart's timeframe of every book the heat map adds up
 * (the live books, `state.levels`), over the candles' span as far back as the source keeps them, read from the source (its columns at a step
 * of the timeframe: one window a candle, averaged over it) and kept up to date: a book that appears is read whole, one gone for a few
 * seconds is dropped, and the windows that can still change (the candle under way, and the last ones until they settle) are read again
 * every 30 s and as each candle starts. One read at a time.
 *
 * Every change is a message (`DepthMessage`) with the next revision; `deliver` posts a host what it lacks: the messages since the one it
 * has when they are all still kept, else everything (a worker started since, or one far behind).
 */

/** How often the windows that can still change are read again, and how long a book may be gone before it is dropped (venues reconnect). */
const REFRESH_MS = 30_000, DROP_AFTER_MS = 5_000;
/** How many messages are kept for a host a few behind. */
const LOG = 32;
/** Windows a read asks for at once: the newest first, so the bands start at the chart's right edge and fill in back in time. */
const CHUNK = 96;

interface Window { bins: Int32Array; bid: Float32Array; ask: Float32Array }
interface Held { info: MarketInfo; step: number; windows: Map<number, Window> }
/** What a host was last sent: the worker it went to and the revision. */
interface Sent { generation: number; revision: number }
/** What `deliver` posts to: a script host (`host.ts ScriptHost`). */
export interface DepthPort { readonly generation: number; post(message: DepthMessage): void }

export class DepthFeed {
  #key = '';
  #revision = 0;
  readonly #books = new Map<string, Held>();
  /** Books held that the page no longer lists, since when. */
  readonly #gone = new Map<string, number>();
  #log: DepthMessage[] = [];
  readonly #sent = new WeakMap<DepthPort, Sent>();
  #loading = false;
  /** When the changing windows were last read, and the candle that was under way then. */
  #tailAt = 0; #forming = 0;
  /** Where the windows kept begin (older ones are let go, in the worker too: `keepFrom`). */
  #keepFrom = -Infinity;

  constructor(private hub: Hub, private changed: () => void) {}

  /** The revision a run reads, for the timeframe it is for; null while nothing has been asked. */
  get tag(): DepthTag | null { return this.#key ? { key: this.#key, revision: this.#revision } : null; }

  /**
   * Keep the order book of the candles starting at `starts` (oldest first) for the timeframe on screen, starting what is due to be read; the
   * tag a run reads now.
   */
  sync(state: AppState, starts: Float64Array, tf: number, now = Date.now()): DepthTag | null {
    if (!starts.length) return this.tag;
    const key = state.timeframe;
    if (key !== this.#key) {
      // Another timeframe: what was held is of other windows. The hosts get the start again with the next message.
      this.#key = key; this.#books.clear(); this.#gone.clear(); this.#tailAt = 0; this.#forming = 0; this.#keepFrom = -Infinity;
      this.#push({ t: 'depth', key, revision: ++this.#revision, reset: true, books: [], drop: [] }, false);
    }
    const ids = state.levels?.books.map(b => b.id) ?? [];
    const listed = new Set(ids), drop: string[] = [];
    for (const id of this.#books.keys()) {
      if (listed.has(id)) { this.#gone.delete(id); continue; }
      const since = this.#gone.get(id);
      if (since === undefined) this.#gone.set(id, now); else if (now - since >= DROP_AFTER_MS) drop.push(id);
    }
    // Windows older than the candles (as the series moves on) are let go, here and in the worker.
    const retention = this.hub.source.kind === 'browser' ? BROWSER_RETENTION_MS : RETENTION_MS;
    const from = Math.max(starts[0]!, Math.floor((now - retention) / tf) * tf), forming = Math.floor(now / tf) * tf;
    const keepFrom = from - tf;
    if (drop.length || keepFrom > this.#keepFrom + tf * 8) {
      for (const id of drop) { this.#books.delete(id); this.#gone.delete(id); }
      if (keepFrom > this.#keepFrom) { this.#keepFrom = keepFrom; for (const h of this.#books.values()) for (const t of [...h.windows.keys()]) if (t < keepFrom) h.windows.delete(t); }
      this.#push({ t: 'depth', key, revision: ++this.#revision, reset: false, books: [], drop, keepFrom: this.#keepFrom }, false);
    }
    if (!this.#loading) {
      const fresh = ids.filter(id => !this.#books.has(id));
      const due = this.#books.size > 0 && (now - this.#tailAt >= REFRESH_MS || forming !== this.#forming);
      if (fresh.length) void this.#read(key, state, fresh, from, forming + tf, tf);
      else if (due) {
        this.#tailAt = now; this.#forming = forming;
        // Windows that ended before the source's settle mark stay as they are; the rest is read again, the candle under way included.
        void this.#read(key, state, [...this.#books.keys()], Math.max(from, Math.min(settledBefore(now, tf), forming)), forming + tf, tf);
      }
    }
    return this.tag;
  }

  /** Post `port` what it lacks: the messages since its revision, or everything (a worker started since it was sent, or one far behind). */
  deliver(port: DepthPort): void {
    if (!this.#key) return;
    const seen = this.#sent.get(port);
    if (seen && seen.generation === port.generation && seen.revision === this.#revision) return;
    const since = seen && seen.generation === port.generation ? this.#log.filter(m => m.revision > seen.revision) : null;
    if (since && since.length === this.#revision - seen!.revision && since.length > 0) for (const m of since) port.post(m);
    else port.post(this.#whole());
    this.#sent.set(port, { generation: port.generation, revision: this.#revision });
  }

  /** The next delivery to `port` sends everything (its worker said it did not hold what a run was told of). */
  forget(port: DepthPort): void { this.#sent.delete(port); }

  #push(msg: DepthMessage, notify = true): void {
    this.#log.push(msg);
    if (this.#log.length > LOG) this.#log.splice(0, this.#log.length - LOG);
    if (notify) this.changed();
  }

  /** Everything held, as one message that starts the worker's depth again. */
  #whole(): DepthMessage {
    const books: DepthBook[] = [];
    for (const [id, h] of this.#books) {
      const times = [...h.windows.keys()].sort((a, b) => a - b), counts = times.map(t => h.windows.get(t)!.bins.length);
      const total = counts.reduce((s, n) => s + n, 0), bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
      let at = 0;
      for (const t of times) { const w = h.windows.get(t)!; bins.set(w.bins, at); bid.set(w.bid, at); ask.set(w.ask, at); at += w.bins.length; }
      books.push({ id, info: h.info, step: h.step, from: -Infinity, to: Infinity, times, counts, bins, bid, ask });
    }
    return { t: 'depth', key: this.#key, revision: this.#revision, reset: true, books, drop: [], keepFrom: this.#keepFrom };
  }

  /**
   * Read `ids`' windows over [from, to) at step `tf`: the newest `CHUNK` windows first, then the ones before them, each in requests of a dozen
   * books, each answer a message of its own (it replaces exactly the windows it was asked for).
   */
  async #read(key: string, state: AppState, ids: string[], from: number, to: number, tf: number): Promise<void> {
    if (!(to > from)) return;
    this.#loading = true;
    try {
      for (let end = to; end > from; end -= CHUNK * tf) {
        const start = Math.max(from, end - CHUNK * tf);
        for (let k = 0; k < ids.length; k += COLUMNS_PER_REQUEST) {
          const part = ids.slice(k, k + COLUMNS_PER_REQUEST);
          let sets: ColumnSet[];
          try { sets = (await this.hub.source.columns(part, start, end, tf)).instruments; } catch { continue; }
          if (key !== this.#key) return;
          const books: DepthBook[] = [], answered = new Set<string>();
          for (const set of sets) {
            if (!part.includes(set.id) || !(set.step > 0)) continue;
            answered.add(set.id);
            let held = this.#books.get(set.id);
            // A book recorded on another grid than the one held (a source started again): what was held of it is of the old grid, and goes.
            const regrid = !!held && held.step !== set.step;
            if (!held || regrid) { held = { info: marketInfo(state.markets, set.id), step: set.step, windows: new Map() }; this.#books.set(set.id, held); }
            const [a, b] = regrid ? [-Infinity, Infinity] : [start, end];
            for (const t of [...held.windows.keys()]) if (t >= a && t < b) held.windows.delete(t);
            let at = 0;
            for (let c = 0; c < set.times.length; c++) {
              const n = set.counts[c]!, t = set.times[c]!;
              if (t >= start && t < end && t >= this.#keepFrom) held.windows.set(t, { bins: set.bins.subarray(at, at + n), bid: set.bid.subarray(at, at + n), ask: set.ask.subarray(at, at + n) });
              at += n;
            }
            books.push({ id: set.id, info: held.info, step: set.step, from: a, to: b, times: set.times, counts: set.counts, bins: set.bins, bid: set.bid, ask: set.ask });
          }
          // A book held and asked for that answered nothing has no windows over [start, end) any more.
          for (const id of part) {
            const held = this.#books.get(id);
            if (answered.has(id) || !held) continue;
            for (const t of [...held.windows.keys()]) if (t >= start && t < end) held.windows.delete(t);
            books.push({ id, info: held.info, step: held.step, from: start, to: end, times: [], counts: [], bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) });
          }
          if (books.length) this.#push({ t: 'depth', key, revision: ++this.#revision, reset: false, books, drop: [], keepFrom: this.#keepFrom });
        }
      }
    } finally { this.#loading = false; }
  }
}
