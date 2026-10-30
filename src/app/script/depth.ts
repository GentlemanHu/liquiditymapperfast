import { marketsMatching, type MarketInfo, type SourceFilter } from './inputs.ts';

/**
 * The order book as scripts read it (`askdepth`, `biddepth`, `depthabove`, `depthbelow`, `depthbooks`): each candle's recorded depth of every
 * book the heat map adds up, as the recorder averaged it over the candle (its window at the chart's timeframe), measured from the candle's
 * close outward. The page
 * reads the windows from its source and hands them to the script worker once; the worker keeps them for the timeframe on screen
 * (`DepthCache`) and the page sends only what changed (new books, the windows still under way).
 *
 * Each recorded bin holds its dollars spread evenly over its price range (the recorder's grid, about 0.02 % of price, chosen per book, so
 * books are added up by price, not by bin). A size is found by walking out from the close across every book's bins at once, in price order,
 * until the dollars passed reach it (`reachOf`): exact under that even spread, and as quick as the size is small (a few bins of each book
 * for most), with nothing worked out ahead or kept. Never better than the recording, which averages a minute of samples and leaves out a
 * large column's smallest bins.
 *
 * A window averaged over a candle with a move in it holds, at a price the candle went through, bids for the part of the candle the price was
 * above it and asks for the rest, and cannot say which stood there at the close. So a walk of one side from the close (`askdepth`,
 * `biddepth`) finds the side the price came from thin, by as much as the price spent past those levels (a 1h candle after a fall,
 * 2026-10-29: $100M of asks 650 dollars above the close, of bids 140 below). A walk of every dollar recorded at each price (`depthabove`,
 * `depthbelow`) reads a book of the usual depth there instead; on a candle without a move the two are nearly the same.
 */

/** One book's windows at the chart's timeframe as the page sends them: they replace those held over [from, to) (-Infinity to Infinity: all). */
export interface DepthBook {
  id: string; info: MarketInfo; step: number; from: number; to: number;
  times: number[]; counts: number[]; bins: Int32Array; bid: Float32Array; ask: Float32Array;
}
/**
 * What the page sends the script worker of the depth: for the timeframe `key`, at `revision`, either everything (`reset`) or what changed
 * since revision `prev`: books whose windows over their [from, to) are replaced, and books no longer read (`drop`); windows before `keepFrom`
 * are let go (the series moved on past them). `keys` are the timeframes the page keeps the depth of: the worker lets go of the others.
 */
export interface DepthMessage { t: 'depth'; key: string; revision: number; prev: number; reset: boolean; books: DepthBook[]; drop: string[]; keepFrom?: number; keys?: string[] }
/** Which depth a run reads: the timeframe and the revision the page had sent before it. */
export interface DepthTag { key: string; revision: number }

/** One book's window as a walk reads it: its bins (ascending), their step, and the dollars per bin it counts (one side's, or with `also` both). */
export interface SideWindow { step: number; bins: Int32Array; usd: Float32Array; also?: Float32Array }

/** The most work one walk may do, bins passed and empty bins skipped, all books together (a size past the whole book stops there). */
const MAX_COST = 2_000_000;
/**
 * A book's answer of at most this many windows (a read of the last few) is kept a copy a window, so that a window read again does not keep
 * its neighbours' buffer alive; a larger one is kept as views of one copy (what it costs: windows read again or let go stay in that copy
 * until all of its windows have gone, at most about as much again as is held).
 */
export const SMALL_ANSWER = 16;

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
    if (w.also && w.also.length !== w.usd.length) return { price: NaN, cost };
    cost += 8;
  }
  let x = close, passed = 0;
  while (cost < MAX_COST) {
    // The nearest edge ahead of any book's, and the dollars per unit of price of every bin the walk is inside of.
    let edge = up ? Infinity : -Infinity, density = 0;
    for (let b = 0; b < count; b++) {
      const w = windows[b]!, step = w.step, bins = w.bins, usdOf = w.usd, also = w.also;
      let k = at[b]!;
      // A bin with nothing in it is no bin.
      while (k >= 0 && k < bins.length && !(usdOf[k]! + (also ? also[k]! : 0) > 0) && cost < MAX_COST) { k += up ? 1 : -1; cost++; }
      at[b] = k;
      if (cost >= MAX_COST) return { price: NaN, cost };
      if (k < 0 || k >= bins.length) continue;
      const lo = bins[k]! * step, hi = lo + step, usd = usdOf[k]! + (also ? also[k]! : 0);
      if (up) {
        if (x < lo) { if (lo < edge) edge = lo; }
        else { if (hi < edge) edge = hi; density += usd / step; }
      } else if (x > hi) { if (hi > edge) edge = hi; }
      else { if (lo > edge) edge = lo; density += usd / step; }
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

/** Which walk: one side from the close (the asks up, the bids down), or every dollar recorded at each price, up or down. */
export type DepthWalk = 'ask' | 'bid' | 'above' | 'below';
/** What a run reads depth through: for the candle starting at `t` with close `close`, over the books a filter keeps. */
export interface DepthReader {
  reach(walk: DepthWalk, t: number, close: number, usd: number, filter: SourceFilter, key: string): number;
  books(t: number, filter: SourceFilter, key: string): number;
  /** The work done since the last call (bins walked), for the step budget; it starts again from 0. */
  spent(): number;
}

interface Window { bins: Int32Array; bid: Float32Array; ask: Float32Array }
interface Book { info: MarketInfo; step: number; windows: Map<number, Window> }

/**
 * Whether a message's book is shaped as one: lengths that agree, a market's description, dollars that are finite and not below 0, and each
 * window's bins rising. One that is not is left out, never read past its end.
 */
function wellFormed(b: DepthBook): boolean {
  if (!b || typeof b.id !== 'string' || !b.info || !(b.step > 0) || !Number.isFinite(b.step) || !Array.isArray(b.times) || !Array.isArray(b.counts) || b.times.length !== b.counts.length) return false;
  const info = b.info;
  if (typeof info.id !== 'string' || typeof info.venue !== 'string' || typeof info.kind !== 'string' || typeof info.quote !== 'string') return false;
  if (typeof b.from !== 'number' || typeof b.to !== 'number' || Number.isNaN(b.from) || Number.isNaN(b.to) || !(b.to > b.from)) return false;
  if (!(b.bins instanceof Int32Array) || !(b.bid instanceof Float32Array) || !(b.ask instanceof Float32Array) || b.bid.length !== b.bins.length || b.ask.length !== b.bins.length) return false;
  let total = 0;
  for (let c = 0; c < b.counts.length; c++) { const n = b.counts[c]!, t = b.times[c]!; if (!Number.isInteger(n) || n < 0 || !Number.isFinite(t)) return false; total += n; }
  if (total !== b.bins.length) return false;
  for (let i = 0; i < total; i++) { const x = b.bid[i]!, y = b.ask[i]!; if (!(x >= 0 && x < Infinity) || !(y >= 0 && y < Infinity)) return false; }
  for (let c = 0, at = 0; c < b.counts.length; at += b.counts[c]!, c++) for (let i = at + 1; i < at + b.counts[c]!; i++) if (!(b.bins[i]! > b.bins[i - 1]!)) return false;
  return true;
}

/** Whether two windows hold the same bins and dollars. */
function sameWindow(a: Window, b: Window): boolean {
  const n = a.bins.length;
  if (b.bins.length !== n) return false;
  for (let i = 0; i < n; i++) if (a.bins[i] !== b.bins[i] || a.bid[i] !== b.bid[i] || a.ask[i] !== b.ask[i]) return false;
  return true;
}

/** One timeframe's depth in the worker. */
interface Era {
  /** Whether what is held follows from a start with every change since, and the revision it is at. */
  sound: boolean; revision: number;
  books: Map<string, Book>;
  /** The revision each candle's depth last changed at (a window that came, changed or went), by candle start: none (-1) where none is held. */
  changed: Map<number, number>;
}
const freshEra = (): Era => ({ sound: false, revision: -1, books: new Map(), changed: new Map() });

/**
 * The script worker's depth: the windows of the books of each timeframe the page keeps, as its messages left them. A start (`reset`) replaces
 * a timeframe's; a change is taken only on top of the revision it says it builds on (`prev`): a worker that missed one (started since the page
 * last sent it everything, or sent one out of turn) holds nothing of that timeframe a run may read until the page sends everything again.
 * Each candle remembers the revision its depth last changed at, so a run can tell that a closed candle's depth changed (`epochs`) and run that
 * candle again; a window read again as it was keeps its revision. A run reads the timeframe of the tag `holds` last said yes to.
 */
export class DepthCache {
  readonly #eras = new Map<string, Era>();
  #era: Era = freshEra();
  readonly #filters = new Map<string, string[]>();
  /** The windows a candle's walks read, for the calls of one candle (a script often asks both sides, or several sizes). */
  #last: { key: string; ask: SideWindow[]; bid: SideWindow[]; above: SideWindow[]; below: SideWindow[] } | null = null;
  #spent = 0;

  apply(msg: DepthMessage): void {
    if (!msg || typeof msg.key !== 'string' || !Number.isFinite(msg.revision) || !Array.isArray(msg.books) || !Array.isArray(msg.drop)) return;
    let era = this.#eras.get(msg.key);
    if (!era) { era = freshEra(); this.#eras.set(msg.key, era); }
    if (Array.isArray(msg.keys)) for (const k of [...this.#eras.keys()]) if (k !== msg.key && !msg.keys.includes(k)) this.#eras.delete(k);
    if (msg.reset) { era.books.clear(); era.changed.clear(); era.sound = true; }
    else if (!era.sound || msg.prev !== era.revision) { era.sound = false; return; }
    if (era === this.#era) { this.#last = null; this.#filters.clear(); }
    const revision = msg.revision, mark = (t: number): void => { era.changed.set(t, revision); };
    for (const id of msg.drop) {
      const book = era.books.get(id);
      if (!book) continue;
      for (const t of book.windows.keys()) mark(t);
      era.books.delete(id);
    }
    const keepFrom = msg.keepFrom !== undefined && Number.isFinite(msg.keepFrom) ? msg.keepFrom : -Infinity;
    if (keepFrom > -Infinity) {
      // A window let go reads NaN from then on; its candle's revision goes with it, which differs from any it had.
      for (const book of era.books.values()) for (const t of [...book.windows.keys()]) if (t < keepFrom) book.windows.delete(t);
      for (const t of [...era.changed.keys()]) if (t < keepFrom) era.changed.delete(t);
    }
    for (const b of msg.books) {
      if (!wellFormed(b)) continue;
      let book = era.books.get(b.id);
      // A book recorded on another grid (a source started again and chose another step): its bins mean other prices, so it starts again.
      if (book && book.step !== b.step) { for (const t of book.windows.keys()) mark(t); era.books.delete(b.id); book = undefined; }
      if (!book) { book = { info: b.info, step: b.step, windows: new Map() }; era.books.set(b.id, book); }
      const incoming = new Map<number, Window>();
      for (let c = 0, at = 0; c < b.times.length; at += b.counts[c]!, c++) {
        const n = b.counts[c]!, t = b.times[c]!;
        if (t >= b.from && t < b.to && t >= keepFrom) incoming.set(t, { bins: b.bins.subarray(at, at + n), bid: b.bid.subarray(at, at + n), ask: b.ask.subarray(at, at + n) });
      }
      for (const t of [...book.windows.keys()]) if (t >= b.from && t < b.to && !incoming.has(t)) { book.windows.delete(t); mark(t); }
      // The message's arrays are the worker's own (a copy made in passing): a large answer's windows are kept as views of them, a small one's
      // as copies of their own (`SMALL_ANSWER`); a window read again as it was keeps the one held.
      const small = b.times.length <= SMALL_ANSWER;
      for (const [t, w] of incoming) {
        const old = book.windows.get(t);
        if (old && sameWindow(old, w)) continue;
        book.windows.set(t, small ? { bins: w.bins.slice(), bid: w.bid.slice(), ask: w.ask.slice() } : w); mark(t);
      }
    }
    era.revision = revision;
  }

  /** Whether the worker holds what a run was told it would read; when it does, that timeframe is the one read from then on. */
  holds(tag: DepthTag): boolean {
    const era = tag ? this.#eras.get(tag.key) : undefined;
    if (!era || !era.sound || era.revision !== tag.revision) return false;
    if (era !== this.#era) { this.#era = era; this.#last = null; this.#filters.clear(); }
    return true;
  }

  /** Each candle's depth revision (-1 where none is held), for a run to tell whether a closed candle's depth changed. */
  epochs(time: Float64Array): Float64Array { const changed = this.#era.changed; return Float64Array.from(time, t => changed.get(t) ?? -1); }

  #ids(filter: SourceFilter, key: string): string[] {
    let ids = this.#filters.get(key);
    if (!ids) {
      const infos = [...this.#era.books.values()].map(b => b.info);
      ids = key === '' ? infos.map(i => i.id) : marketsMatching(infos, filter);
      this.#filters.set(key, ids);
    }
    return ids;
  }

  #windows(t: number, filter: SourceFilter, key: string): { key: string; ask: SideWindow[]; bid: SideWindow[]; above: SideWindow[]; below: SideWindow[] } {
    const k = `${key}\u0001${t}`;
    if (this.#last?.key === k) return this.#last;
    const ask: SideWindow[] = [], bid: SideWindow[] = [], above: SideWindow[] = [], below: SideWindow[] = [];
    for (const id of this.#ids(filter, key)) {
      const book = this.#era.books.get(id), w = book?.windows.get(t);
      if (!book || !w || !w.bins.length) continue;
      ask.push({ step: book.step, bins: w.bins, usd: w.ask }); bid.push({ step: book.step, bins: w.bins, usd: w.bid });
      above.push({ step: book.step, bins: w.bins, usd: w.ask, also: w.bid }); below.push({ step: book.step, bins: w.bins, usd: w.bid, also: w.ask });
    }
    return this.#last = { key: k, ask, bid, above, below };
  }

  readonly reader: DepthReader = {
    reach: (walk, t, close, usd, filter, key) => {
      const w = this.#windows(t, filter, key), r = reachOf(w[walk], walk === 'ask' || walk === 'above' ? 'ask' : 'bid', close, usd);
      this.#spent += r.cost;
      return r.price;
    },
    books: (t, filter, key) => { let n = 0; for (const id of this.#ids(filter, key)) if (this.#era.books.get(id)?.windows.has(t)) n++; this.#spent += 1; return n; },
    spent: () => { const s = this.#spent; this.#spent = 0; return s; },
  };
}
