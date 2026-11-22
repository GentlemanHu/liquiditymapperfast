/**
 * How unusual a Depth band's reading is (Karl, 2026-11-22: "in what percentile it is historically from the saved history ... how extreme is
 * the reading in that particular level and in all levels"): the books as they stood at the close of every 16-minute window over the days the
 * source keeps (one recorded minute each, not the window's mean), and a reading ranked among those before it: an empirical distribution,
 * nothing assumed about its shape.
 *
 * Why the close and not the mean (measured on the local server's recording, 2026-11-22, 24 books): a window's mean book is spread over every
 * price the touch visited, so its inner bands shrink when the price moves. The tallest ±0.31 % ask column of a 24 h view ($404M, 2-minute
 * columns) had a 16-minute mean of $209M, which ranked under 98 % of the week's means: the line would have called the spike thin. Against the
 * closing minutes it ranked above 85 %. A 24 h view's 2-minute columns and the closing minutes of the same hours have the same spread (medians
 * within 5 % in every band), so a reading read finely is ranked as it is shown; a coarser column (a mean of more minutes) is not, and there the
 * newest closing minute at or before the moment is ranked instead, and said with its time.
 *
 * Each window adds up every book present, as the pane does. Only the books the history usually has decide whether a window counts (each
 * present in at least `USUAL_SHARE` of the windows held): a window missing one of them, or in which they hold less than `USUAL_HOLD` of the
 * band, is a gap (a venue gone from the recording takes its whole book with it), neither ranked nor part of the history (the depth sound's
 * rule, sound/depth-watch.ts).
 */
import type { ColumnsFrame } from '../shared/columns.ts';
import { depthBandsByStore } from './depth-series.ts';

/** The history's step: a closing minute every 16 minutes (a week of the local server's recording is about 40 MB at it). */
export const RANK_STEP_MS = 16 * 60_000;
/** How far back a reading is compared: the days the local server keeps. */
export const RANK_SPAN_MS = 7 * 86_400_000;
/** The least history a rank stands on: valid windows covering this much (not their first-to-last span: a day-long gap does not count). */
export const RANK_MIN_COVER_MS = 48 * 3_600_000;
/** What is asked for first, so that the newest moments can be ranked within seconds: the hours the minimum cover needs, and two more. */
export const RANK_RECENT_MS = RANK_MIN_COVER_MS + 2 * 3_600_000;
/** A book is one the history usually has when it is present in at least this share of the windows held. */
export const USUAL_SHARE = 0.9;
/** A window counts only where the usual books hold at least this share of the band (the rest come and go). */
export const USUAL_HOLD = 0.8;
/** A reading taken as shown is not ranked where any of this many windows held just before it failed the hold rule with every usual book there (`rankValue`). */
export const RANK_RECENT_CHECK = 8;
/** The finest a column may be read and still be ranked as shown: a mean of up to this many milliseconds of minutes. */
export const RANK_FINE_MS = 2 * 60_000;

/** A side of a band in the units shown: USD, or coins (each bin's USD over its own price). */
export type RankSide = 'bid' | 'ask' | 'bidCoin' | 'askCoin';
const SIDES: readonly RankSide[] = ['bid', 'ask', 'bidCoin', 'askCoin'];

/** Each book's band totals on a grid of windows: window `n` is [n * step, (n + 1) * step), held for n0 <= n < n0 + count. Books can be added. */
export class BandHistory {
  n0 = 0; count = 0;
  readonly ids: string[] = [];
  /** Per side, per book: `count * k` totals (window-major). */
  readonly values: Record<RankSide, Float32Array[]> = { bid: [], ask: [], bidCoin: [], askCoin: [] };
  readonly present: Uint8Array[] = [];
  readonly #index = new Map<string, number>();
  #cap = 0; #usual: { key: string; books: number[] } | null = null; #among: { key: string; books: number[] } | null = null; #usualIn: { key: string; books: number[] } | null = null;
  #totals: { key: string; all: Record<RankSide, Float64Array>; ok: Record<RankSide, Uint8Array> }[] = [];
  /** Counts every change of what is held (a put, a trim, new books), for what is worked out from it to know when to work it out again. */
  version = 0;
  constructor(readonly key: string, ids: readonly string[], readonly radii: readonly number[], readonly step = RANK_STEP_MS) { this.addBooks(ids); }
  get k(): number { return this.radii.length; }
  /** The first and last moments held (ms), or null while nothing is. */
  get span(): { from: number; to: number } | null { return this.count ? { from: this.n0 * this.step, to: (this.n0 + this.count) * this.step } : null; }
  has(id: string): boolean { return this.#index.has(id); }
  #held = { at: -1, n: 0 };
  /** How many windows hold any book at all: the grid spans whatever was asked for, held or not, so this is what the source really had. */
  held(): number {
    if (this.#held.at !== this.version) {
      let n = 0;
      for (let g = 0; g < this.count; g++) if (this.present.some(p => p[g] === 1)) n++;
      this.#held = { at: this.version, n };
    }
    return this.#held.n;
  }
  /** Make room for books not held yet (absent from every window until a frame of theirs is put). */
  addBooks(ids: readonly string[]): void {
    const k = this.k;
    for (const id of ids) {
      if (this.#index.has(id)) continue;
      this.#index.set(id, this.ids.length); this.ids.push(id);
      this.present.push(new Uint8Array(this.#cap));
      for (const side of SIDES) this.values[side].push(new Float32Array(this.#cap * k));
    }
    this.#usual = null; this.#among = null; this.version++;
  }

  /**
   * Write the windows of `frame` (asked at this step for [from, to), both on the grid) into the grid for the books `only` (by default every book
   * held), replacing what was held for them; a book asked for and absent from a window is absent from it.
   */
  put(frame: ColumnsFrame, from: number, to: number, only: ReadonlySet<string> | null = null): void {
    const step = this.step, k = this.k, w = (to - from) / step, n1 = from / step;
    // Only whole windows on the grid (a split between two windows would put one window's books into another).
    if (!(w > 0) || !Number.isInteger(w) || !Number.isInteger(n1)) return;
    const by = depthBandsByStore(frame.instruments, step, from, to, w, this.radii, true);
    this.#grow(n1, n1 + w);
    const index = new Map(frame.instruments.map((s, i) => [s.id, i]));
    const source: Record<RankSide, Float32Array[]> = { bid: by.bid, ask: by.ask, bidCoin: by.bidCoin!, askCoin: by.askCoin! };
    this.ids.forEach((id, b) => {
      if (only && !only.has(id)) return;
      const i = index.get(id), present = this.present[b]!;
      for (let x = 0; x < w; x++) {
        // No price the books agree on (a one-sided or empty answer): the window is not held, rather than nothing on one side.
        const g = n1 + x - this.n0, here = i !== undefined && by.column[i]![x]! > 0 && by.mid[x]! > 0;
        present[g] = here ? 1 : 0;
        for (const side of SIDES) { const into = this.values[side][b]!, got = here ? source[side][i!]! : null; for (let j = 0; j < k; j++) into[g * k + j] = got ? got[x * k + j]! : 0; }
      }
    });
    this.#usual = null; this.version++;
  }
  /** Forget the windows that began before `t`. */
  trim(t: number): void {
    const n = Math.floor(t / this.step), drop = Math.min(this.count, n - this.n0); if (drop <= 0) return;
    const k = this.k;
    this.ids.forEach((_, b) => {
      this.present[b]!.copyWithin(0, drop, this.count);
      for (const side of SIDES) this.values[side][b]!.copyWithin(0, drop * k, this.count * k);
    });
    this.n0 += drop; this.count -= drop; this.#usual = null; this.version++;
  }
  /** The books among `among` (by default every book held) present in at least USUAL_SHARE of the windows held, as indexes into `ids`. */
  usual(among: readonly string[] | null = null): number[] {
    const key = among ? among.join('\u0001') : '*';
    if (this.#usual?.key === key) return this.#usual.books;
    const books = this.#usualOver(this.books(among), 0, this.count);
    this.#usual = { key, books };
    return books;
  }
  /**
   * The books among `among` present in at least USUAL_SHARE of the windows [nLo, nHi) (those a rank compares with: never a window after the
   * moment ranked, so that later outages cannot change an earlier rank), as indexes into `ids`.
   */
  usualIn(among: readonly string[] | null, nLo: number, nHi: number): number[] {
    const key = `${among ? among.join('') : '*'}|${nLo}|${nHi}|${this.version}`;
    if (this.#usualIn?.key === key) return this.#usualIn.books;
    const books = nHi > nLo ? this.#usualOver(this.books(among), Math.max(0, nLo - this.n0), Math.min(this.count, nHi - this.n0)) : [];
    this.#usualIn = { key, books };
    return books;
  }
  /**
   * The candidates present in at least USUAL_SHARE of the windows [g0, g1) that some candidate holds. A window none of them holds is the source's
   * gap (the page closed, the server or the PC off), not every book's, so it never makes a book unusual: counted over the grid, a source holding
   * four days, or an outage of every book for 20 hours, left no usual book and so no rank for a week (review 2026-11-22).
   */
  #usualOver(candidates: readonly number[], g0: number, g1: number): number[] {
    let held = 0;
    for (let g = g0; g < g1; g++) if (candidates.some(b => this.present[b]![g])) held++;
    const books: number[] = [];
    if (held) for (const b of candidates) { let c = 0; const p = this.present[b]!; for (let g = g0; g < g1; g++) c += p[g]!; if (c >= USUAL_SHARE * held) books.push(b); }
    return books.sort((a, b) => a - b);
  }
  /** The books of `among` held (by default every book), as indexes into `ids`. */
  books(among: readonly string[] | null = null): number[] {
    const key = among ? among.join('') : '*';
    if (this.#among?.key === key) return this.#among.books;
    const books = among ? among.map(id => this.#index.get(id)).filter((b): b is number => b !== undefined) : this.ids.map((_, b) => b);
    this.#among = { key, books };
    return books;
  }
  /**
   * Every window's band totals over the books of `among` present in it (as the pane adds them up), each side and band, and whether the window
   * counts there: every one of `usual` present, and holding at least USUAL_HOLD of the band. Worked out once per change of what is held, of the
   * books asked for and of the usual ones (the last few kept), so that a rank is one pass of reads, not a pass over every book of every window.
   */
  totals(among: readonly string[] | null, usual: readonly number[]): { all: Record<RankSide, Float64Array>; ok: Record<RankSide, Uint8Array> } {
    const key = `${this.version}|${among ? among.join('') : '*'}|${usual.join(',')}`;
    const held = this.#totals.find(t => t.key === key); if (held) return held;
    const k = this.k, n = this.count, books = this.books(among);
    const all = { bid: new Float64Array(n * k), ask: new Float64Array(n * k), bidCoin: new Float64Array(n * k), askCoin: new Float64Array(n * k) };
    const ok = { bid: new Uint8Array(n * k), ask: new Uint8Array(n * k), bidCoin: new Uint8Array(n * k), askCoin: new Uint8Array(n * k) };
    for (let g = 0; g < n; g++) {
      if (!usual.length || usual.some(b => !this.present[b]![g])) continue;
      for (const side of SIDES) {
        const values = this.values[side];
        for (let j = 0; j < k; j++) {
          let sum = 0, sumUsual = 0;
          for (const b of books) if (this.present[b]![g]) sum += values[b]![g * k + j]!;
          for (const b of usual) sumUsual += values[b]![g * k + j]!;
          all[side][g * k + j] = sum; ok[side][g * k + j] = sum > 0 && sumUsual < USUAL_HOLD * sum ? 0 : 1;
        }
      }
    }
    const made = { key, all, ok };
    this.#totals = [made, ...this.#totals].slice(0, 4);
    return made;
  }
  /**
   * Band `j`'s total on one side in window `n` over every book of `among` present in it, or NaN where the window is not held, misses one of the
   * usual books, or they hold less than USUAL_HOLD of the band.
   */
  total(side: RankSide, j: number, n: number, among: readonly string[] | null = null, usual: readonly number[] = this.usual(among)): number {
    const g = n - this.n0; if (g < 0 || g >= this.count || !usual.length) return NaN;
    const t = this.totals(among, usual), i = g * this.k + j;
    return t.ok[side][i] ? t.all[side][i]! : NaN;
  }
  #grow(nFrom: number, nTo: number): void {
    if (!this.count) { this.n0 = nFrom; }
    const lo = Math.min(this.n0, nFrom), hi = Math.max(this.n0 + this.count, nTo), need = hi - lo, k = this.k, shift = this.n0 - lo, old = this.count;
    if (need > this.#cap || shift > 0) {
      const cap = Math.max(need, Math.ceil(this.#cap * 1.25), 64);
      this.ids.forEach((_, b) => {
        const p = new Uint8Array(cap); p.set(this.present[b]!.subarray(0, old), shift); this.present[b] = p;
        for (const side of SIDES) { const v = new Float32Array(cap * k); v.set(this.values[side][b]!.subarray(0, old * k), shift * k); this.values[side][b] = v; }
      });
      this.#cap = cap;
    } else if (need > old) {
      // What the grid newly reaches is cleared: a trim leaves older windows' values past its end, and a gap must read as not held.
      this.ids.forEach((_, b) => { this.present[b]!.fill(0, old, need); for (const side of SIDES) this.values[side][b]!.fill(0, old * k, need * k); });
    }
    this.n0 = lo; this.count = need;
  }
}

/** Where a reading stands among the closing minutes before it: how many were strictly lower, equal and higher, and the hours they cover. */
export interface BandRank { p: number; n: number; below: number; equal: number; above: number; coverMs: number; value: number; /** The closing minute ranked (a snapshot), or null where a value read was. */ at: number | null }

/**
 * `value` among band `j`'s closing minutes on one side that closed by `t` (at most RANK_SPAN_MS before it), counting the books those windows
 * usually had; null below the minimum cover, or where the reading counted fewer books (`present`) than those.
 */
export function rankValue(h: BandHistory, side: RankSide, j: number, t: number, value: number, among: readonly string[] | null = null, at: number | null = null, present: number | null = null): BandRank | null {
  if (!Number.isFinite(value)) return null;
  const step = h.step, nT = Math.floor(t / step), nLo = Math.max(h.n0, nT - Math.round(RANK_SPAN_MS / step)), usual = h.usualIn(among, nLo, nT);
  if (!usual.length || (present !== null && present < usual.length)) return null;
  const totals = h.totals(among, usual), all = totals.all[side], ok = totals.ok[side], k = h.k;
  // A reading taken as shown (`at` null) counts the books present now. A large book that is not usual (back after a long outage, or new) makes the
  // hold rule void every window that holds it, so the windows left are the ones without it and the reading would read as the highest of them
  // (review round 2). Such a book shows in the windows just before the moment as every usual book present yet holding under USUAL_HOLD: where any
  // of the last few windows held is like that, the reading is not like those that count. A usual book merely missing there says nothing of it.
  if (at === null) {
    const books = h.books(among);
    for (let m = nT - 1, held = 0; m >= nLo && held < RANK_RECENT_CHECK; m--) {
      const g = m - h.n0; if (g < 0 || g >= h.count || !books.some(b => h.present[b]![g])) continue;
      held++;
      if (!ok[g * k + j] && usual.every(b => h.present[b]![g])) return null;
    }
  }
  let below = 0, equal = 0, n = 0, first = -1;
  for (let m = nLo; m < nT; m++) {
    const g = m - h.n0; if (g < 0 || g >= h.count) continue;
    const i = g * k + j; if (!ok[i]) continue;
    const y = all[i]!;
    if (first < 0) first = m;
    n++; if (y < value) below++; else if (y === value) equal++;
  }
  if (!n || n * step < RANK_MIN_COVER_MS) return null;
  return { p: (below + 0.5 * equal) / n, n, below, equal, above: n - below - equal, coverMs: (nT - first) * step, value, at };
}
/** The newest closing minute at or before `t` (the window that closed last by then), ranked among those before it. */
export function rankAt(h: BandHistory, side: RankSide, j: number, t: number, among: readonly string[] | null = null): BandRank | null {
  const step = h.step, n = Math.floor(t / step) - 1, nLo = Math.max(h.n0, n - Math.round(RANK_SPAN_MS / step));
  const value = h.total(side, j, n, among, h.usualIn(among, nLo, n));
  return value === value ? rankValue(h, side, j, (n + 1) * step - 1, value, among, (n + 1) * step) : null;
}

/**
 * Whether the history cannot rank at all: a source whose own minutes began less than RANK_MIN_COVER_MS before `now` (`since`, from
 * `DataSource.depthSince`: the public site's browser engine keeps about a day of them), known from its first frame, so the pane's layout does not
 * change once its history is read; or a history read whole that holds fewer windows than that (its grid spans whatever was asked for, held or
 * not). The pane then says the band's rank in view, as before the history.
 */
export function cannotRank(h: BandHistory | null, whole: boolean, since: number | null, now: number): boolean {
  return (since !== null && now - since < RANK_MIN_COVER_MS) || (whole && !!h && h.held() * h.step < RANK_MIN_COVER_MS);
}

/**
 * What a rank says, from the readings strictly lower or strictly higher (so a tie never makes a reading look rarer than it is): above every
 * reading held ('highest'), under every one ('lowest'), above or below the share that was strictly lower or higher (rounded down), or in the
 * middle where ties leave neither side at half.
 */
export type RankKind = 'highest' | 'lowest' | 'above' | 'below' | 'middle';
export function rankKind(r: BandRank): { kind: RankKind; pct: number; extreme: boolean } {
  if (r.above === 0 && r.equal === 0) return { kind: 'highest', pct: 100, extreme: true };
  if (r.below === 0 && r.equal === 0) return { kind: 'lowest', pct: 100, extreme: true };
  const lower = r.below / r.n, higher = r.above / r.n;
  if (Math.max(lower, higher) < 0.5) return { kind: 'middle', pct: 50, extreme: false };
  const up = lower >= higher, share = up ? lower : higher;
  return { kind: up ? 'above' : 'below', pct: Math.min(99, Math.floor(share * 100)), extreme: share >= 0.95 };
}

/** How long the list of books must stand before the history is first asked for. */
export const SETTLE_MS = 4_000;
/** How a source answers for recorded columns at each window's close (`DataSource.columns` with `close`). */
export type ColumnsAsk = (ids: string[], from: number, to: number, stepMs: number) => Promise<ColumnsFrame>;

/**
 * The Depth pane's history. A book not held yet is asked for in two steps: its last RANK_RECENT_MS first (the newest moments can then be ranked
 * within seconds), then the rest of the days the source keeps. Then only the tail, once a window has closed (with a minute's grace for the
 * recording of its last minute). Another set of bands starts afresh; another set of books keeps the books held and asks only for the new ones.
 * One question at a time; a failed one waits a minute before the next.
 */
export class DepthHistory {
  #h: BandHistory | null = null;
  readonly #recent = new Set<string>(); readonly #whole = new Set<string>();
  #busy = false; #tailTo = 0; #failedAt = -Infinity; #idsKey = ''; #idsSince = 0;
  /** How long the last question for older days took (ms), and its answer's size in bins, for the pane's measurements. */
  lastMs = 0; lastBins = 0;
  constructor(private readonly ask: ColumnsAsk, private readonly changed: () => void, private readonly clock: () => number = Date.now) {}
  /** Whether every one of `ids` has had its older days read too (until then a moment with no rank may still get one: "…", not "–"). */
  wholeFor(ids: readonly string[]): boolean { return ids.every(id => this.#whole.has(id)); }
  /** The history as held now, once every one of `ids` has at least its recent hours (else null), asking for what is missing. */
  get(ids: readonly string[], radii: readonly number[]): BandHistory | null {
    const key = radii.join(',');
    if (!this.#h || this.#h.key !== key) { this.#h = new BandHistory(key, [], radii); this.#recent.clear(); this.#whole.clear(); this.#tailTo = 0; }
    // The list of books settles first (the venues connect one by one as the page opens): a book asked for alone is centred on its own price,
    // not on the price the others agree on, so the first questions wait until the list has stood for SETTLE_MS.
    const idsKey = [...ids].sort().join(',');
    if (idsKey !== this.#idsKey) { this.#idsKey = idsKey; this.#idsSince = this.clock(); }
    const h = this.#h, step = h.step, now = this.clock(), closed = Math.floor((now - 60_000) / step) * step, split = closed - Math.ceil(RANK_RECENT_MS / step) * step;
    const settled = h.count > 0 || now - this.#idsSince >= SETTLE_MS;
    if (!this.#busy && settled && ids.length && now - this.#failedAt > 60_000) {
      const fresh = ids.filter(id => !this.#recent.has(id)), older = ids.filter(id => this.#recent.has(id) && !this.#whole.has(id));
      if (fresh.length) void this.#fetch(fresh, split, closed, 'recent');
      else if (older.length) void this.#fetch(older, closed - RANK_SPAN_MS, split, 'whole');
      else if (closed > this.#tailTo) void this.#fetch([...this.#recent], Math.max(h.n0 * step, this.#tailTo - step), closed, 'tail');
    }
    return ids.length && h.count && ids.every(id => this.#recent.has(id)) ? h : null;
  }
  async #fetch(books: string[], from: number, to: number, kind: 'recent' | 'whole' | 'tail'): Promise<void> {
    const h = this.#h!; this.#busy = true;
    const t0 = this.clock();
    try {
      const frame = await this.ask(books, from, to, h.step);
      if (this.#h !== h) return;
      h.addBooks(books);
      h.put(frame, from, to, new Set(books));
      h.trim(this.clock() - RANK_SPAN_MS - h.step);
      if (kind === 'recent') for (const id of books) this.#recent.add(id);
      if (kind === 'whole') { for (const id of books) this.#whole.add(id); this.lastMs = this.clock() - t0; this.lastBins = frame.instruments.reduce((s, i) => s + i.bins.length, 0); }
      if (kind !== 'whole') this.#tailTo = Math.max(this.#tailTo, to);
      this.changed();
    } catch { this.#failedAt = this.clock(); }
    finally { this.#busy = false; }
  }
}
