export const PHI = (1 + Math.sqrt(5)) / 2;
export type HeightMode = 'golden' | 'volume' | 'equal';
export const HEIGHT_MODES: readonly HeightMode[] = ['golden', 'volume', 'equal'];

export interface RowLayout {
  /** Height of the aggregate row at the top, of the price strip under it, and of each venue row in rank order. */
  agg: number; price: number; rows: number[];
  /** Everything stacked, which is more than the room when the rows would otherwise be too small to read (the column then scrolls). */
  content: number;
}
export interface LayoutOptions {
  /** Smallest height of a venue row and of the aggregate row, and the fixed height of the price strip. */
  minRow?: number; minAgg?: number; price?: number;
  /** In `volume` mode a row's weight never falls below this share, so a quiet venue stays readable. */
  floor?: number;
  /** The aggregate row's exact height (the phone's chart, which holds the price too): it takes this, and the venue rows share what is left. */
  agg?: number;
}

/**
 * Row heights for the column. The aggregate is always the tallest row. `golden` shrinks each rank to 1/φ of the one above it, `volume`
 * makes a row as tall as the venue's share of the volume, `equal` gives every venue the same. Rows never go below `minRow`: what does not
 * fit is scrolled, not squeezed.
 */
export function rowHeights(mode: HeightMode, total: number, shares: readonly number[], { minRow = 54, minAgg = 84, price = 44, floor = 0.06, agg: fixedAgg }: LayoutOptions = {}): RowLayout {
  const n = shares.length;
  const weights = shares.map((share, i) => mode === 'golden' ? PHI ** -i : mode === 'volume' ? Math.max(share, floor) : 1);
  const top = n ? Math.max(...weights) : 1;
  const aggWeight = mode === 'volume' ? top * 1.35 : top * PHI;
  // A fixed aggregate leaves the rest to the venue rows alone: they are weighed and raised to their minimum as before, and the aggregate is not.
  if (fixedAgg !== undefined) {
    const height = Math.max(0, Math.round(fixedAgg)), rows = wholePixels(fitRows(weights, Math.max(0, total - price - height), weights.map(() => minRow)));
    return { agg: height, price, rows, content: price + height + rows.reduce((a, b) => a + b, 0) };
  }
  const room = Math.max(0, total - price);
  const h = fitRows([aggWeight, ...weights], room, [minAgg, ...weights.map(() => minRow)]);
  let rows = h.slice(1), agg = h[0]!;
  // The aggregate stays the tallest even where the rows were raised to their minimum.
  const tallest = rows.length ? Math.max(...rows) : 0;
  if (agg < tallest * 1.2) agg = tallest * 1.2;
  // Whole pixels, the aggregate taking what rounding the rows gained or lost: rounding each row alone made rows that fit overflow the
  // room by up to a pixel a row, and the column then scrolled by that much behind a scroll bar the height of the rows.
  const exact = agg + rows.reduce((a, b) => a + b, 0);
  rows = rows.map(Math.round); agg = Math.round(exact) - rows.reduce((a, b) => a + b, 0);
  return { agg, price, rows, content: price + agg + rows.reduce((a, b) => a + b, 0) };
}

/**
 * Heights for rows of these weights sharing `room`. Water-filling: a row that would be below its minimum takes the minimum, and the rest
 * share what is left in proportion to their weights.
 */
function fitRows(weights: readonly number[], room: number, mins: readonly number[]): number[] {
  const fixed = new Array<boolean>(weights.length).fill(false), h = new Array<number>(weights.length).fill(0);
  for (let pass = 0; pass <= weights.length; pass++) {
    const free = weights.reduce((sum, w, i) => sum + (fixed[i] ? 0 : w), 0), left = room - weights.reduce((sum, _, i) => sum + (fixed[i] ? h[i]! : 0), 0);
    let changed = false;
    for (let i = 0; i < weights.length; i++) {
      if (fixed[i]) continue;
      h[i] = free > 0 ? left * weights[i]! / free : 0;
      if (h[i]! < mins[i]!) { h[i] = mins[i]!; fixed[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  return h;
}

/** Whole pixels that keep the total (to a pixel): eight rows of 67.5 px rounded one by one are 68 each, four more than the room. */
function wholePixels(heights: readonly number[]): number[] {
  let sum = 0, done = 0;
  return heights.map(h => { sum += h; const px = Math.round(sum) - done; done += px; return px; });
}

export type RowHit = { kind: 'agg' } | { kind: 'price' } | { kind: 'row'; index: number };

/**
 * Which row sits at height `y` of the column. The aggregate and the price strip stay at the top; the venue rows below them scroll by
 * `scroll` px and are clipped to the room under the strip (`room` is the column's height).
 */
export function locateRow(layout: RowLayout, scroll: number, room: number, y: number): RowHit | null {
  if (y < 0 || y >= room) return null;
  if (y < layout.agg) return { kind: 'agg' };
  if (y < layout.agg + layout.price) return { kind: 'price' };
  let top = layout.agg + layout.price - scroll;
  for (let i = 0; i < layout.rows.length; i++) { const bottom = top + layout.rows[i]!; if (y >= Math.max(top, layout.agg + layout.price) && y < bottom) return { kind: 'row', index: i }; top = bottom; }
  return null;
}

/** How far the venue rows can scroll: what they need beyond the room under the aggregate and the price strip. */
export const maxScroll = (layout: RowLayout, room: number): number => Math.max(0, layout.content - room);
