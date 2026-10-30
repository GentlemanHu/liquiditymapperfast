import type { Hub } from '../hub.ts';
import type { AppState } from '../store.ts';
import type { ColumnSet } from '../../shared/columns.ts';
import { BROWSER_RETENTION_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { settledBefore } from '../column-holds.ts';
import { marketInfo, type MarketInfo } from './inputs.ts';
import type { DepthBook, DepthMessage, DepthTag } from './depth.ts';

/**
 * The page's side of the scripts' order book (`depth.ts`): the recorded windows at the chart's timeframe of every book the heat map adds up
 * (the live books, `state.levels`), over the candles' span as far back as the source keeps them (at most the newest `MAX_WINDOWS`), read
 * from the source (its columns at a step of the timeframe: one window a candle, averaged over it) and kept up to date: a book that appears
 * is read whole, one gone for a few seconds is dropped, candles loaded further back are read when they come, and the windows that can still
 * change (from the source's settle mark at the last read on: the candle under way, and the last ones until they settle) are read again every
 * 30 s and as each candle starts. One read at a time for the timeframe on screen; a read for one left behind stops at its next answer, and
 * the new one does not wait for it. What was held for the last few timeframes is kept for a return, so a switch back has its depth at once.
 *
 * Every change is a message (`DepthMessage`) with the next revision; `deliver` posts a host what it lacks: the messages since the one it
 * has when they are all still kept, else everything (a worker started since, one far behind, or another timeframe).
 */

/** How often the windows that can still change are read again, and how long a book may be gone before it is dropped (venues reconnect). */
const REFRESH_MS = 30_000, DROP_AFTER_MS = 5_000;
/** How long a failed read waits before it is tried again (a server that errors is not asked on every run). */
const RETRY_MS = 5_000;
/** How many messages are kept for a host a few behind. */
const LOG = 32;
/**
 * Windows a read asks for at once, the newest first so the bands start at the chart's right edge and fill in back in time: a few at first,
 * so the first answer comes at once, then four times as many each time (a quiet server merges a hundred windows of a dozen books in about
 * 0.1 s; 2026-10-29).
 */
const FIRST_CHUNK = 24, MAX_CHUNK = 384;
/** How many of the newest candles have their depth read: a window holds about 200 bins a book (2026-10-29), so 24 books take some 58 MB. */
export const MAX_WINDOWS = 1_000;
/**
 * How many other timeframes' depth is kept for a return, and how many bins all of them may hold together: about 48 MB on a server's source,
 * 12 MB in a browser's, which may be a phone's (its own recording, a day of a dozen books or so, also holds much less).
 */
const KEPT_ERAS = 3, KEPT_BINS = 4_000_000, KEPT_BINS_BROWSER = 1_000_000;

interface Window { bins: Int32Array; bid: Float32Array; ask: Float32Array }
/** One book: its windows, its grid (0 while it has answered nothing), and how far back it has been read (windows from there on are held). */
interface Held { info: MarketInfo; step: number; windows: Map<number, Window>; readFrom: number }
/** What is held for one timeframe. */
interface Era {
  books: Map<string, Held>;
  /** Where the windows kept begin: older ones are let go, in the worker too (`keepFrom`). */
  keepFrom: number;
  /** The windows from here on may still have changed (they had not settled when last read); when they were last read, and the candle then. */
  settledTo: number; tailAt: number; forming: number;
}
const newEra = (): Era => ({ books: new Map(), keepFrom: -Infinity, settledTo: Infinity, tailAt: 0, forming: 0 });
const binsOf = (era: Era): number => { let n = 0; for (const h of era.books.values()) for (const w of h.windows.values()) n += w.bins.length; return n; };
/** What a host was last sent: the worker it went to and the revision. */
interface Sent { generation: number; revision: number }
/** What `deliver` posts to: a script host (`host.ts ScriptHost`). */
export interface DepthPort { readonly generation: number; post(message: DepthMessage): void }

export class DepthFeed {
  #key = '';
  #revision = 0;
  #era = newEra();
  /** Other timeframes' eras, the one left longest ago first. */
  readonly #kept = new Map<string, Era>();
  /** Books held that the page no longer lists, since when. */
  readonly #gone = new Map<string, number>();
  #log: DepthMessage[] = [];
  readonly #sent = new WeakMap<DepthPort, Sent>();
  /** The read under way, and when a failed one may be tried again. */
  #reading: { key: string } | null = null;
  #retryAt = 0;

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
    if (key !== this.#key) this.#switch(key);
    const era = this.#era, ids = state.levels?.books.map(b => b.id) ?? [];
    const listed = new Set(ids), drop: string[] = [];
    for (const id of era.books.keys()) {
      if (listed.has(id)) { this.#gone.delete(id); continue; }
      const since = this.#gone.get(id);
      if (since === undefined) this.#gone.set(id, now); else if (now - since >= DROP_AFTER_MS) drop.push(id);
    }
    const retention = this.hub.source.kind === 'browser' ? BROWSER_RETENTION_MS : RETENTION_MS;
    const forming = Math.floor(now / tf) * tf, from = Math.max(starts[0]!, Math.floor((now - retention) / tf) * tf, forming - (MAX_WINDOWS - 1) * tf);
    // Windows older than the candles (as the series moves on) are let go, here and in the worker; candles loaded further back are kept.
    const keepFrom = from - tf;
    if (keepFrom < era.keepFrom) era.keepFrom = keepFrom;
    if (drop.length || keepFrom > era.keepFrom + tf * 8) {
      for (const id of drop) { era.books.delete(id); this.#gone.delete(id); }
      if (keepFrom > era.keepFrom) {
        era.keepFrom = keepFrom;
        for (const h of era.books.values()) { for (const t of [...h.windows.keys()]) if (t < keepFrom) h.windows.delete(t); h.readFrom = Math.max(h.readFrom, keepFrom); }
      }
      this.#push({ t: 'depth', key, revision: ++this.#revision, reset: false, books: [], drop, keepFrom: era.keepFrom });
    }
    if (this.#reading?.key === key || now < this.#retryAt) return this.tag;
    // The books not read as far back as the candles (new ones: not at all), those read least far first; then the windows that can still change.
    let top = -Infinity;
    for (const id of ids) { const r = era.books.get(id)?.readFrom ?? Infinity; if (r > from && r > top) top = r; }
    if (top > -Infinity) {
      const group = ids.filter(id => (era.books.get(id)?.readFrom ?? Infinity) === top);
      if (!era.books.size) { era.settledTo = Math.min(settledBefore(now, tf), forming); era.tailAt = now; era.forming = forming; }
      void this.#read(key, era, state, group, from, Math.min(top, forming + tf), tf, true);
    } else if (era.books.size && (now - era.tailAt >= REFRESH_MS || forming !== era.forming)) {
      const since = Math.max(from, era.settledTo);
      era.settledTo = Math.min(settledBefore(now, tf), forming); era.tailAt = now; era.forming = forming;
      void this.#read(key, era, state, [...era.books.keys()], since, forming + tf, tf, false).then(ok => { if (!ok) era.settledTo = Math.min(era.settledTo, since); });
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

  /**
   * Another timeframe: what was held for this one is kept for a return (the few left most recently, as far as `KEPT_BINS` allows), and the
   * new one's, when kept, comes back. The log starts again, so every host is sent everything with its next delivery.
   */
  #switch(key: string): void {
    if (this.#key && this.#era.books.size) this.#kept.set(this.#key, this.#era);
    this.#era = this.#kept.get(key) ?? newEra();
    this.#kept.delete(key);
    let bins = 0;
    for (const era of this.#kept.values()) bins += binsOf(era);
    for (const [k, era] of this.#kept) {
      if (this.#kept.size <= KEPT_ERAS && bins <= (this.hub.source.kind === 'browser' ? KEPT_BINS_BROWSER : KEPT_BINS)) break;
      bins -= binsOf(era); this.#kept.delete(k);
    }
    this.#key = key; this.#gone.clear(); this.#log = []; this.#revision++;
  }

  #push(msg: DepthMessage): void {
    this.#log.push(msg);
    if (this.#log.length > LOG) this.#log.splice(0, this.#log.length - LOG);
  }

  /** Everything held, as one message that starts the worker's depth again. */
  #whole(): DepthMessage {
    const books: DepthBook[] = [];
    for (const [id, h] of this.#era.books) {
      if (!(h.step > 0)) continue;
      const times = [...h.windows.keys()].sort((a, b) => a - b), counts = times.map(t => h.windows.get(t)!.bins.length);
      const total = counts.reduce((s, n) => s + n, 0), bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
      let at = 0;
      for (const t of times) { const w = h.windows.get(t)!; bins.set(w.bins, at); bid.set(w.bid, at); ask.set(w.ask, at); at += w.bins.length; }
      books.push({ id, info: h.info, step: h.step, from: -Infinity, to: Infinity, times, counts, bins, bid, ask });
    }
    return { t: 'depth', key: this.#key, revision: this.#revision, reset: true, books, drop: [], keepFrom: this.#era.keepFrom };
  }

  /**
   * Read `ids`' windows over [from, to) at step `tf`, the newest first: `FIRST_CHUNK` windows, then four times as many each time up to
   * `MAX_CHUNK`, every book in one question (a source splits it into requests of a dozen and asks them at once). Each answer is a message of
   * its own, which replaces exactly the windows it was asked for; a book asked for is held from then on, answered or not (one with nothing
   * recorded is not asked for again on every run). A read `back` (books not read as far back as the candles) moves each book's `readFrom`
   * back with every answer, so one that stops (another timeframe, a failure) goes on from there the next time. Whether every answer came.
   */
  async #read(key: string, era: Era, state: AppState, ids: string[], from: number, to: number, tf: number, back: boolean): Promise<boolean> {
    if (!(to > from)) return true;
    const mine = { key }, asked = new Set(ids);
    this.#reading = mine;
    let ok = false;
    try {
      for (let end = to, chunk = FIRST_CHUNK; end > from; end -= chunk * tf, chunk = Math.min(MAX_CHUNK, chunk * 4)) {
        const start = Math.max(from, end - chunk * tf);
        let sets: ColumnSet[];
        try { sets = (await this.hub.source.columns(ids, start, end, tf)).instruments; } catch { this.#retryAt = Date.now() + RETRY_MS; return false; }
        // A read started since (for another timeframe, or this one again after it), or another timeframe on screen: this one stops here.
        if (this.#reading !== mine || key !== this.#key) return false;
        const books: DepthBook[] = [], answered = new Set<string>(), regridded = new Set<string>();
        for (const set of sets) {
          if (!asked.has(set.id) || !(set.step > 0) || answered.has(set.id)) continue;
          answered.add(set.id);
          let held = era.books.get(set.id);
          // A book recorded on another grid than the one held (a source started again): what was held of it is of the old grid, and goes, and
          // it is read again whole, on the new one. One that had answered nothing has no grid yet: its first answer is not another grid.
          const regrid = !!held && held.step !== set.step, anew = regrid && held!.step > 0;
          if (!held || regrid) { held = { info: held?.info ?? marketInfo(state.markets, set.id), step: set.step, windows: new Map(), readFrom: anew ? Infinity : held?.readFrom ?? Infinity }; era.books.set(set.id, held); }
          if (anew) regridded.add(set.id);
          const [a, b] = regrid ? [-Infinity, Infinity] : [start, end];
          for (const t of [...held.windows.keys()]) if (t >= a && t < b) held.windows.delete(t);
          let at = 0;
          for (let c = 0; c < set.times.length; c++) {
            const n = set.counts[c]!, t = set.times[c]!;
            if (t >= start && t < end && t >= era.keepFrom) held.windows.set(t, { bins: set.bins.subarray(at, at + n), bid: set.bid.subarray(at, at + n), ask: set.ask.subarray(at, at + n) });
            at += n;
          }
          books.push({ id: set.id, info: held.info, step: set.step, from: a, to: b, times: set.times, counts: set.counts, bins: set.bins, bid: set.bid, ask: set.ask });
        }
        for (const id of ids) {
          let held = era.books.get(id);
          if (!held) { held = { info: marketInfo(state.markets, id), step: 0, windows: new Map(), readFrom: Infinity }; era.books.set(id, held); }
          if (back && !regridded.has(id)) held.readFrom = Math.min(held.readFrom, start);
          // A book held and asked for that answered nothing has no windows over [start, end) any more.
          if (answered.has(id) || !held.windows.size) continue;
          for (const t of [...held.windows.keys()]) if (t >= start && t < end) held.windows.delete(t);
          books.push({ id, info: held.info, step: held.step, from: start, to: end, times: [], counts: [], bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) });
        }
        if (books.length) { this.#push({ t: 'depth', key, revision: ++this.#revision, reset: false, books, drop: [], keepFrom: era.keepFrom }); this.changed(); }
      }
      ok = true;
      return true;
    } finally {
      // What is left to read (another group of books, candles loaded meanwhile) is looked for at the next run, now rather than at the pane's refresh.
      if (this.#reading === mine) { this.#reading = null; if (ok) this.changed(); }
    }
  }
}
