import type { TapeRing, TapeSegment } from './ring.ts';

/**
 * The price lines drawn through the trade dust: for each market, the orders of each pixel column of the view reduced to the first and last
 * price and the lowest and highest any order reached there (so a spike survives any zoom). The columns are fixed slices of time
 * (`floor(t / ms)`), kept for a window wider than the view, so a view sliding with the live edge only adds the orders that arrive; the
 * columns are worked out again only when the zoom changes, the view leaves the window, or the ring is cleared or rebased.
 */
export interface Column { open: number; high: number; low: number; close: number; tOpen: number; tClose: number }

/**
 * The same line from a market's prices a second (the flow recording's volume-weighted price of each second, `priceOf`, 0 where nothing
 * traded), for the time before the page held its orders: columns of `ms` over whole seconds [s0, s1], breaking where `gap` seconds in a row
 * have no price. Never carried forward across an empty second: a quiet stretch is a break, not a flat line.
 */
export function secondsPath(priceOf: (sec: number) => number, s0: number, s1: number, ms: number, gap: number): number[][] {
  const out: number[][] = [];
  let run: number[] | null = null, empty = 0, col = NaN, open = 0, high = 0, low = 0, close = 0;
  const flush = (): void => {
    if (!run || col !== col) return;
    run.push(col, open);
    if (high > low) run.push(col, open >= close ? high : low, col, open >= close ? low : high);
    run.push(col, close);
  };
  for (let s = s0; s <= s1; s++) {
    const p = priceOf(s);
    if (!(p > 0)) { if (++empty >= gap && run) { flush(); run = null; col = NaN; } continue; }
    empty = 0;
    const c = Math.floor((s * 1000 + 500) / ms);
    if (!run) { run = []; out.push(run); col = c; open = high = low = close = p; continue; }
    if (c !== col) { flush(); col = c; open = high = low = close = p; continue; }
    if (p > high) high = p; if (p < low) low = p; close = p;
  }
  flush();
  return out;
}

/** The price line breaks where its market traded nothing for this long (and never for fewer than three columns). */
export const TRACE_GAP_MS = 10_000;
/** How many empty columns in a row break the price line, with columns of `ms` milliseconds (`TraceIndex.path`'s `gap`). */
export const traceGapColumns = (ms: number): number => Math.max(3, Math.ceil(TRACE_GAP_MS / ms));

/**
 * Where the map marks a gap in the dust, after `from`: the start of each stretch of time that no segment covers for as long as it takes to
 * break the price line with columns of `ms` milliseconds, so a mark never stands where the line runs on. Segments follow batches as they
 * arrive, and the orders in them are stamped by their exchanges, so they can overlap or come out of order: their ranges are merged first.
 * A source that skips a slow page's 250 ms batch starts a segment too: a gap in the record, but no hole anyone can see, and a full-height
 * dotted line for each one buried the map in them. (A hole the line breaks at can go unmarked when the orders either side fall at
 * unlucky places in their columns: marks are the sure ones.)
 */
export function gapMarks(segments: readonly TapeSegment[], from: number, ms: number): number[] {
  if (!(ms > 0) || !Number.isFinite(ms) || segments.length < 2) return [];
  // Orders `gap + 1` columns apart leave `gap` empty columns between them: the least that breaks the line whatever the alignment.
  const least = (traceGapColumns(ms) + 1) * ms, out: number[] = [], byStart = [...segments].sort((a, b) => a.from - b.from);
  let reach = byStart[0]!.to;
  for (let i = 1; i < byStart.length; i++) {
    const s = byStart[i]!;
    if (s.from > from && s.from - reach >= least) out.push(s.from);
    if (s.to > reach) reach = s.to;
  }
  return out;
}

/** How far before and after the view the columns are kept, as shares of its span. */
const BEFORE = 0.05, AFTER = 0.35;

export class TraceIndex {
  /** Per market (the ring's index): column number -> column. */
  readonly markets = new Map<number, Map<number, Column>>();
  ms = 0;
  #from = 0; #to = 0; #upTo = 0; #epoch = -1;

  /** Make the columns of `ms` milliseconds cover [t0, t1] (absolute ms) with every order the ring holds there. */
  update(ring: TapeRing, t0: number, t1: number, ms: number): void {
    const near = Math.abs(ms - this.ms) <= this.ms * 1e-9;
    if (!near || ring.epoch !== this.#epoch || t0 < this.#from || t1 > this.#to) {
      const span = t1 - t0;
      this.ms = ms; this.#epoch = ring.epoch; this.#from = t0 - BEFORE * span; this.#to = t1 + AFTER * span; this.markets.clear();
      for (const [a, b] of ring.runs(this.#from, this.#to)) for (let k = a; k < b; k++) this.#take(ring, k);
      this.#upTo = ring.written;
      return;
    }
    for (let k = Math.max(this.#upTo, ring.first); k < ring.written; k++) this.#take(ring, k);
    this.#upTo = ring.written;
  }

  #take(ring: TapeRing, k: number): void {
    const at = (k % ring.capacity) * 6, d = ring.data, t = ring.t0 + d[at]!;
    if (t < this.#from || t > this.#to) return;
    const market = d[at + 3]!, price = ring.p0 + d[at + 1]!, lo = ring.p0 + d[at + 4]!, hi = ring.p0 + d[at + 5]!, n = Math.floor(t / this.ms);
    let columns = this.markets.get(market); if (!columns) { columns = new Map(); this.markets.set(market, columns); }
    const c = columns.get(n);
    if (!c) { columns.set(n, { open: price, high: hi, low: lo, close: price, tOpen: t, tClose: t }); return; }
    if (hi > c.high) c.high = hi; if (lo < c.low) c.low = lo;
    // Orders of different venues arrive out of order: the column's ends are its earliest and latest orders by exchange time.
    if (t < c.tOpen) { c.tOpen = t; c.open = price; }
    if (t >= c.tClose) { c.tClose = t; c.close = price; }
  }

  /**
   * One market's line over columns [c0, c1] as segments of points [x-index, price] in order: each column gives its open, its extremes and
   * its close; the line breaks where `gap` or more columns in a row hold no order (nothing traded there, or nothing was received).
   */
  path(market: number, c0: number, c1: number, gap: number): number[][] {
    const columns = this.markets.get(market), out: number[][] = [];
    if (!columns) return out;
    let run: number[] | null = null, empty = 0;
    for (let n = c0; n <= c1; n++) {
      const c = columns.get(n);
      if (!c) { if (++empty >= gap) run = null; continue; }
      empty = 0;
      if (!run) { run = []; out.push(run); }
      run.push(n, c.open);
      if (c.high > c.low) run.push(n, c.open >= c.close ? c.high : c.low, n, c.open >= c.close ? c.low : c.high);
      run.push(n, c.close);
    }
    return out;
  }
}
