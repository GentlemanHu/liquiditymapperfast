import { marketsMatching, type MarketInfo, type SourceFilter } from './inputs.ts';

/**
 * The order book as scripts read it (`askdepth`, `biddepth`, `depthbooks`): each candle's recorded depth of every book the heat map adds up,
 * as the recorder averaged it over the candle (its window at the chart's timeframe), measured from the candle's close outward. The page
 * reads the windows from its source and hands them to the script worker once; the worker keeps them for the timeframe on screen
 * (`DepthCache`) and the page sends only what changed (new books, the windows still under way).
 *
 * Each recorded bin holds its dollars spread evenly over its price range (the recorder's grid, about 0.02 % of price, chosen per book, so
 * books are added up by price, not by bin). A size is found by walking out from the close across every book's bins at once, in price order,
 * until the dollars passed reach it (`reachOf`): exact under that even spread, and as quick as the size is small (a few bins of each book
 * for most), with nothing worked out ahead or kept. Never better than the recording, which averages a minute of samples and leaves out a
 * large column's smallest bins.
 */

/** One book's windows at the chart's timeframe as the page sends them: they replace those held over [from, to) (-Infinity to Infinity: all). */
export interface DepthBook {
  id: string; info: MarketInfo; step: number; from: number; to: number;
  times: number[]; counts: number[]; bins: Int32Array; bid: Float32Array; ask: Float32Array;
}
/**
 * What the page sends the script worker of the depth: for the timeframe `key`, at `revision` (each message the next), either everything
 * (`reset`) or what changed: books whose windows over their [from, to) are replaced, and books no longer read (`drop`); windows before
 * `keepFrom` are let go (the series moved on past them).
 */
export interface DepthMessage { t: 'depth'; key: string; revision: number; reset: boolean; books: DepthBook[]; drop: string[]; keepFrom?: number }
/** Which depth a run reads: the timeframe and the revision the page had sent before it. */
export interface DepthTag { key: string; revision: number }

/** One book's window as a walk reads it: its bins (ascending), their step, and one side's dollars per bin. */
export interface SideWindow { step: number; bins: Int32Array; usd: Float32Array }

/** The most bins one walk may pass, all books together (a size past the whole book stops there). */
const MAX_WALK = 1_000_000;

/** The first index of `a` (ascending) whose value is at least `x`. */
function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * The price at which `usd` dollars of the side are reached from `close` outward over these windows: above the close on the asks, below it
 * on the bids (the window's dollars on the other side of the close, there because the price moved within the candle, are not counted).
 * `close` for 0; NaN for a size that is not a number or below 0, for no window, and for a size the windows do not hold. `cost` is the work it
 * took, for the step budget.
 */
export function reachOf(windows: readonly SideWindow[], side: 'ask' | 'bid', close: number, usd: number): { price: number; cost: number } {
  if (!(usd >= 0) || !Number.isFinite(usd) || !(close > 0) || !Number.isFinite(close) || !windows.length) return { price: NaN, cost: 1 };
  if (usd === 0) return { price: close, cost: 1 };
  const up = side === 'ask', count = windows.length, at = new Int32Array(count);
  let cost = count;
  // Each book's first bin past the close on the side walked (asks: the bin holding the close and those above; bids: those below).
  for (let b = 0; b < count; b++) {
    const w = windows[b]!, step = w.step;
    at[b] = up ? lowerBound(w.bins, Math.floor(close / step)) : lowerBound(w.bins, Math.ceil(close / step)) - 1;
    cost += 8;
  }
  let x = close, passed = 0;
  for (let walked = 0; walked < MAX_WALK; walked++) {
    // The nearest edge ahead of any book's, and the dollars per unit of price of every bin the walk is inside of.
    let edge = up ? Infinity : -Infinity, density = 0;
    for (let b = 0; b < count; b++) {
      const w = windows[b]!, step = w.step, bins = w.bins, usdOf = w.usd;
      let k = at[b]!;
      // A bin with nothing in it is no bin.
      while (k >= 0 && k < bins.length && !(usdOf[k]! > 0)) k += up ? 1 : -1;
      at[b] = k;
      if (k < 0 || k >= bins.length) continue;
      const lo = bins[k]! * step, hi = lo + step;
      if (up) {
        if (x < lo) { if (lo < edge) edge = lo; }
        else { if (hi < edge) edge = hi; density += usdOf[k]! / step; }
      } else if (x > hi) { if (hi > edge) edge = hi; }
      else { if (lo > edge) edge = lo; density += usdOf[k]! / step; }
    }
    cost += count;
    if (!Number.isFinite(edge)) return { price: NaN, cost };
    const span = up ? edge - x : x - edge, here = density * span;
    if (density > 0 && passed + here >= usd) { const d = (usd - passed) / density; return { price: up ? x + d : x - d, cost }; }
    passed += here; x = edge;
    // The books whose bin ends here go on to their next one; one whose bin starts here is now inside it.
    for (let b = 0; b < count; b++) {
      const w = windows[b]!, k = at[b]!;
      if (k < 0 || k >= w.bins.length) continue;
      const lo = w.bins[k]! * w.step, hi = lo + w.step;
      if (up ? hi <= x : lo >= x) at[b] = k + (up ? 1 : -1);
    }
  }
  return { price: NaN, cost };
}

/** What a run reads depth through: for the candle starting at `t` with close `close`, over the books a filter keeps. */
export interface DepthReader {
  reach(side: 'ask' | 'bid', t: number, close: number, usd: number, filter: SourceFilter, key: string): number;
  books(t: number, filter: SourceFilter, key: string): number;
  /** The work done since the last call (bins walked), for the step budget; it starts again from 0. */
  spent(): number;
}

interface Window { bins: Int32Array; bid: Float32Array; ask: Float32Array }
interface Book { info: MarketInfo; step: number; windows: Map<number, Window> }

/** Whether a message's book is shaped as one (lengths that agree, finite numbers): one that is not is left out, never read past its end. */
function wellFormed(b: DepthBook): boolean {
  if (!b || typeof b.id !== 'string' || !b.info || !(b.step > 0) || !Number.isFinite(b.step) || !Array.isArray(b.times) || !Array.isArray(b.counts) || b.times.length !== b.counts.length) return false;
  if (typeof b.from !== 'number' || typeof b.to !== 'number' || Number.isNaN(b.from) || Number.isNaN(b.to) || !(b.to > b.from)) return false;
  if (!(b.bins instanceof Int32Array) || !(b.bid instanceof Float32Array) || !(b.ask instanceof Float32Array) || b.bid.length !== b.bins.length || b.ask.length !== b.bins.length) return false;
  let total = 0;
  for (let c = 0; c < b.counts.length; c++) { const n = b.counts[c]!, t = b.times[c]!; if (!Number.isInteger(n) || n < 0 || !Number.isFinite(t)) return false; total += n; }
  return total === b.bins.length;
}

/**
 * The script worker's depth: the windows of the books of one timeframe, as the page's messages left them. A message for another timeframe,
 * or a reset, starts again; each candle remembers the revision its depth last changed at, so a run can tell that a closed candle's depth
 * changed (`epochs`) and run that candle again.
 */
export class DepthCache {
  key = '';
  revision = -1;
  readonly #books = new Map<string, Book>();
  /** The revision each candle's depth last changed at (a window replaced or let go), by candle start; books added or dropped: `#booksAt`. */
  readonly #changed = new Map<number, number>();
  #booksAt = 0;
  readonly #filters = new Map<string, string[]>();
  /** The windows a candle's walks read, for the calls of one candle (a script often asks both sides, or several sizes). */
  #last: { key: string; ask: SideWindow[]; bid: SideWindow[] } | null = null;
  #spent = 0;

  apply(msg: DepthMessage): void {
    if (!msg || typeof msg.key !== 'string' || !Number.isFinite(msg.revision) || !Array.isArray(msg.books) || !Array.isArray(msg.drop)) return;
    if (msg.reset || msg.key !== this.key) { this.#books.clear(); this.#changed.clear(); this.#filters.clear(); this.key = msg.key; }
    this.#last = null;
    let books = msg.reset;
    for (const id of msg.drop) if (this.#books.delete(id)) books = true;
    if (msg.keepFrom !== undefined && Number.isFinite(msg.keepFrom)) {
      for (const book of this.#books.values()) for (const t of [...book.windows.keys()]) if (t < msg.keepFrom) book.windows.delete(t);
      for (const t of [...this.#changed.keys()]) if (t < msg.keepFrom) this.#changed.delete(t);
    }
    for (const b of msg.books) {
      if (!wellFormed(b)) continue;
      let book = this.#books.get(b.id);
      // A book recorded on another grid (a source started again and chose another step): its bins mean other prices, so it starts again.
      if (book && book.step !== b.step) { for (const t of book.windows.keys()) this.#changed.set(t, msg.revision); this.#books.delete(b.id); book = undefined; }
      if (!book) { book = { info: b.info, step: b.step, windows: new Map() }; this.#books.set(b.id, book); books = true; }
      for (const t of [...book.windows.keys()]) if (t >= b.from && t < b.to) { book.windows.delete(t); this.#changed.set(t, msg.revision); }
      let at = 0;
      for (let c = 0; c < b.times.length; c++) {
        const n = b.counts[c]!, t = b.times[c]!;
        if (t >= b.from && t < b.to && (msg.keepFrom === undefined || t >= msg.keepFrom)) book.windows.set(t, { bins: b.bins.subarray(at, at + n), bid: b.bid.subarray(at, at + n), ask: b.ask.subarray(at, at + n) });
        this.#changed.set(t, msg.revision);
        at += n;
      }
    }
    if (books) { this.#booksAt = msg.revision; this.#filters.clear(); }
    this.revision = msg.revision;
  }

  /** Whether the cache holds what a run was told it would read. */
  holds(tag: DepthTag): boolean { return !!tag && tag.key === this.key && tag.revision === this.revision; }

  /** Each candle's depth revision (the books' when they changed later), for a run to tell whether a closed candle's depth changed. */
  epochs(time: Float64Array): Float64Array { return Float64Array.from(time, t => Math.max(this.#changed.get(t) ?? -1, this.#booksAt)); }

  #ids(filter: SourceFilter, key: string): string[] {
    let ids = this.#filters.get(key);
    if (!ids) {
      const infos = [...this.#books.values()].map(b => b.info);
      ids = key === '' ? infos.map(i => i.id) : marketsMatching(infos, filter);
      this.#filters.set(key, ids);
    }
    return ids;
  }

  #windows(t: number, filter: SourceFilter, key: string): { key: string; ask: SideWindow[]; bid: SideWindow[] } {
    const k = `${key}\u0001${t}`;
    if (this.#last?.key === k) return this.#last;
    const ask: SideWindow[] = [], bid: SideWindow[] = [];
    for (const id of this.#ids(filter, key)) {
      const book = this.#books.get(id), w = book?.windows.get(t);
      if (!book || !w || !w.bins.length) continue;
      ask.push({ step: book.step, bins: w.bins, usd: w.ask }); bid.push({ step: book.step, bins: w.bins, usd: w.bid });
    }
    return this.#last = { key: k, ask, bid };
  }

  readonly reader: DepthReader = {
    reach: (side, t, close, usd, filter, key) => { const w = this.#windows(t, filter, key); const r = reachOf(side === 'ask' ? w.ask : w.bid, side, close, usd); this.#spent += r.cost; return r.price; },
    books: (t, filter, key) => { let n = 0; for (const id of this.#ids(filter, key)) if (this.#books.get(id)?.windows.has(t)) n++; this.#spent += 1; return n; },
    spent: () => { const s = this.#spent; this.#spent = 0; return s; },
  };
}
