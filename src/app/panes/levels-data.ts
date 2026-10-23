import type { Kernels } from '../kernels.ts';
import type { LevelsFrame, SideArrays } from '../wire.ts';

export interface Grouped {
  ids: string[];
  step: number;
  /** Index of the first bin; bin i covers [(bin0 + i) * step, (bin0 + i + 1) * step). */
  bin0: number;
  nBins: number;
  bid: Float32Array[];
  ask: Float32Array[];
  totalBid: Float32Array;
  totalAsk: Float32Array;
}

/** The most bins one grouping holds (more is cut off at the top). */
export const MAX_BINS = 6000;

function concat(sides: SideArrays[]): { lo: Float64Array; hi: Float64Array; usd: Float64Array; inst: Uint32Array } {
  const total = sides.reduce((s, side) => s + side.usd.length, 0);
  const lo = new Float64Array(total), hi = new Float64Array(total), usd = new Float64Array(total), inst = new Uint32Array(total);
  let at = 0;
  sides.forEach((side, k) => { lo.set(side.lo, at); hi.set(side.hi, at); usd.set(side.usd, at); inst.fill(k, at, at + side.usd.length); at += side.usd.length; });
  return { lo, hi, usd, inst };
}

/**
 * What `groupLevels` made for a frame, by what was asked (the venues, the step and the bins). A frame's levels never change, but a pane draws
 * again for a pointer move, a palette or a cue's decay, each time grouping the same frame the same way: a pointer-only draw spent 8 to 44 % of
 * its time on regrouping (study 2026-10-22, `Research_Findings.md`). The answers are shared, so callers read them and never write. At most
 * `GROUP_MEMO` are kept for one frame (a pane asks for one or two, the Tape and pull/stack for one each), and they go with the frame.
 */
const grouped = new WeakMap<LevelsFrame, Map<string, Grouped>>();
const GROUP_MEMO = 8;

/** Group the selected instruments' live levels onto a display grid covering [p0, p1]. */
export function groupLevels(kernels: Kernels, frame: LevelsFrame, ids: string[], step: number, p0: number, p1: number): Grouped {
  const bin0 = Math.floor(p0 / step);
  const nBins = Math.max(1, Math.min(MAX_BINS, Math.ceil(p1 / step) - bin0 + 1));
  const key = `${ids.join('\u0001')}\u0002${step}\u0002${bin0}\u0002${nBins}`;
  let memo = grouped.get(frame);
  const hit = memo?.get(key);
  if (hit) return hit;
  const made = groupFresh(kernels, frame, ids, step, bin0, nBins);
  if (!memo) { memo = new Map(); grouped.set(frame, memo); }
  if (memo.size >= GROUP_MEMO) memo.delete(memo.keys().next().value!);
  memo.set(key, made);
  return made;
}

function groupFresh(kernels: Kernels, frame: LevelsFrame, ids: string[], step: number, bin0: number, nBins: number): Grouped {
  const books = ids.map(id => frame.books.find(book => book.id === id)).filter((book): book is NonNullable<typeof book> => !!book);
  const totalBid = new Float32Array(nBins), totalAsk = new Float32Array(nBins);
  const run = (pick: (book: (typeof books)[number]) => SideArrays, total: Float32Array): Float32Array[] => {
    const c = concat(books.map(pick));
    const grid = kernels.spreadLevels(c.lo, c.hi, c.usd, c.inst, books.length, step, bin0, nBins);
    const rows = books.map((_, k) => grid.subarray(k * nBins, (k + 1) * nBins));
    for (const row of rows) for (let i = 0; i < nBins; i++) total[i]! += row[i]!;
    return rows;
  };
  const bid = run(book => book.bids, totalBid), ask = run(book => book.asks, totalAsk);
  return { ids: books.map(book => book.id), step, bin0, nBins, bid, ask, totalBid, totalAsk };
}

/**
 * The prices the order book groups for a view [p0, p1): the view, the mark's row and as far on the mark's other side as the view is on its
 * own, so a running total from the mark and a comparison of the two sides at one distance both have their rows when the view is scrolled
 * away. Null when that is more than one grouping holds (the view alone is grouped then, and has no running totals).
 */
export function groupSpan(p0: number, p1: number, mark: number, step: number): { lo: number; hi: number } | null {
  const markP = Math.floor(mark / step) * step, lo = Math.min(p0, markP, 2 * markP - p1), hi = Math.max(p1, markP + step, 2 * markP - p0 + step);
  return Math.ceil(hi / step) - Math.floor(lo / step) + 1 <= MAX_BINS ? { lo, hi } : null;
}

/** What a venue's book reaches: its lowest and highest price, and whether the highest is a single price (`hiPoint`) or the end of a band. */
export interface Cover { lo: number; hi: number; hiPoint?: boolean }

/** A book's reach by its own prices (Infinity and -Infinity for a side without levels), found once a book: `coverage` finishes it against the mark. */
interface Reach { lo: number; hi: number; hiPoint: boolean }
const reaches = new WeakMap<LevelsFrame['books'][number], Reach>();
function reachOf(book: LevelsFrame['books'][number]): Reach {
  let reach = reaches.get(book);
  if (reach) return reach;
  let lo = Infinity, hi = -Infinity;
  for (const v of book.bids.lo) if (v < lo) lo = v;
  for (const v of book.asks.hi) if (v > hi) hi = v;
  // A level that is one price (lo = hi) sits at its price; a band (several prices merged) stops short of its upper edge.
  let hiPoint = false;
  for (let i = 0; i < book.asks.hi.length; i++) if (book.asks.hi[i] === hi && book.asks.lo[i]! >= hi) { hiPoint = true; break; }
  reach = { lo, hi, hiPoint }; reaches.set(book, reach);
  return reach;
}

/** The price range a venue's book actually reaches, so a feed limit reads as "no data" rather than an empty book. */
export function coverage(book: LevelsFrame['books'][number] | undefined, mark: number): (Cover & { bp: number; levels: number }) | null {
  if (!book || !(mark > 0) || book.bids.usd.length + book.asks.usd.length === 0) return null;
  const reach = reachOf(book), lo = Number.isFinite(reach.lo) ? reach.lo : mark, hi = Number.isFinite(reach.hi) ? reach.hi : mark;
  return { lo, hi, hiPoint: reach.hiPoint, bp: Math.round((hi - lo) / mark * 1e4), levels: book.bids.usd.length + book.asks.usd.length };
}

/**
 * Whether the row [rowLo, rowLo + step) of the ladder lies beyond what a venue's book reaches. A row ends before the lowest price when it
 * stops at or below it; the highest price is inside the row that starts at or below it when it is a single price (a level of the book at
 * exactly that price), and outside the row that starts at it when it is the end of a band.
 */
export function beyondCover(cover: Cover, rowLo: number, step: number): boolean {
  return rowLo + step <= cover.lo || (cover.hiPoint ? rowLo > cover.hi : rowLo >= cover.hi);
}

/**
 * Whether the row [rowLo, rowLo + step) lies past a book's reach on the far side from the mark: an ask row above its highest price (by the
 * rule of `beyondCover`), a bid row below its lowest. A running total from the mark is the same on every such row as at the reach.
 */
export function pastReach(cover: Cover, rowLo: number, step: number, ask: boolean): boolean {
  return ask ? (cover.hiPoint ? rowLo > cover.hi : rowLo >= cover.hi) : rowLo + step <= cover.lo;
}

/** The running totals made for a grouping, by the mark's bin: the mark moves a little at a time, so a grouping seldom meets more than a few. */
const cumulated = new WeakMap<Grouped, Map<number, Cumulative>>();
const CUMULATIVE_MEMO = 4;

/** Cumulative USD walking away from the mark: bids downward, asks upward; the mark's own bin counts for both sides. Shared like a grouping: read, never written. */
export function cumulative(grouped: Grouped, mark: number): { bid: Float32Array; ask: Float32Array; maxBid: number; maxAsk: number } {
  const { nBins, bin0, step } = grouped;
  const markBin = Math.floor(mark / step) - bin0;
  let memo = cumulated.get(grouped);
  const hit = memo?.get(markBin);
  if (hit) return hit;
  const bid = new Float32Array(nBins), ask = new Float32Array(nBins);
  let run = 0;
  for (let i = Math.min(nBins - 1, markBin); i >= 0; i--) { run += grouped.totalBid[i]!; bid[i] = run; }
  const maxBid = run; run = 0;
  for (let i = Math.max(0, markBin); i < nBins; i++) { run += grouped.totalAsk[i]!; ask[i] = run; }
  const made = { bid, ask, maxBid, maxAsk: run };
  if (!memo) { memo = new Map(); cumulated.set(grouped, memo); }
  if (memo.size >= CUMULATIVE_MEMO) memo.delete(memo.keys().next().value!);
  memo.set(markBin, made);
  return made;
}

export type Cumulative = ReturnType<typeof cumulative>;

const imbalances = new WeakMap<Cumulative, Map<string, Float32Array>>();

/**
 * Which side holds more liquidity at each distance from the mark, as (bid - ask) / (bid + ask) of the cumulative liquidity within that
 * distance on each side (positive: bids dominate). Rows the same distance apart share a value. A row within `minRows` of the mark takes
 * the value at `minRows`, since the ratio of the very top of the book is mostly noise. All zeros when the mark is outside the grid.
 */
export function imbalanceByDistance(grouped: Pick<Grouped, 'nBins'>, cum: Cumulative, markBin: number, minRows = 4): Float32Array {
  const { nBins } = grouped;
  // Shared like the totals it is made from (a draw for a pointer move asks the same thing again): read, never written.
  const key = `${nBins}\u0002${markBin}\u0002${minRows}`;
  let memo = imbalances.get(cum);
  const hit = memo?.get(key);
  if (hit) return hit;
  const out = new Float32Array(nBins);
  if (markBin >= 0 && markBin < nBins) {
    for (let i = 0; i < nBins; i++) {
      const d = Math.max(Math.abs(i - markBin), minRows);
      const b = cum.bid[Math.max(0, markBin - d)]!, a = cum.ask[Math.min(nBins - 1, markBin + d)]!, total = b + a;
      out[i] = total > 0 ? (b - a) / total : 0;
    }
  }
  if (!memo) { memo = new Map(); imbalances.set(cum, memo); }
  if (memo.size >= CUMULATIVE_MEMO) memo.delete(memo.keys().next().value!);
  memo.set(key, out);
  return out;
}

/**
 * Bid and ask liquidity in the bins from `loBin` to `hiBin` (both included, kept to the grid): the bids at and below the mark's bin, the asks
 * at and above it, the mark's own bin counting for both. This is what is on screen when the ladder is scrolled away from the mark.
 */
export function liquidityInView(grouped: Pick<Grouped, 'nBins' | 'totalBid' | 'totalAsk'>, markBin: number, loBin: number, hiBin: number): { bid: number; ask: number } {
  let bid = 0, ask = 0;
  for (let bin = Math.max(0, loBin); bin <= Math.min(grouped.nBins - 1, hiBin); bin++) {
    if (bin <= markBin) bid += grouped.totalBid[bin]!;
    if (bin >= markBin) ask += grouped.totalAsk[bin]!;
  }
  return { bid, ask };
}

/** Cumulative bid and ask liquidity within `rows` rows of the mark (what the balance bar shows). */
export function liquidityWithin(grouped: Pick<Grouped, 'nBins'>, cum: Cumulative, markBin: number, rows: number): { bid: number; ask: number } {
  const { nBins } = grouped;
  if (!(markBin >= 0 && markBin < nBins) || !(rows >= 0)) return { bid: 0, ask: 0 };
  return { bid: cum.bid[Math.max(0, markBin - rows)]!, ask: cum.ask[Math.min(nBins - 1, markBin + rows)]! };
}

/**
 * How bright a row's bars should be: the side that dominates at that distance is saturated, the weaker one fades, in proportion to the
 * imbalance (full effect at an imbalance of `full`). 1 means unchanged, so a balanced book looks exactly as it did.
 */
export function dominanceWeight(imbalance: number, isBidSide: boolean, full = 0.3): number {
  const strength = Math.min(1, Math.abs(imbalance) / full);
  return (imbalance > 0) === isBidSide ? 1 + 0.25 * strength : 1 - 0.5 * strength;
}
