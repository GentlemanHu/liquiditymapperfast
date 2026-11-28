/**
 * The Depth band under the pointer, shaded on the map where its money lies (Karl, 2026-11-27: "if you hover over the depth chart, it highlights
 * that area on the main chart"). A Depth pane shares the band it lights (`state.depthHover`, as the order book shares its row: not saved, worked
 * out again after each of its drawings, let go of only by the pane that set it) and the map's pointer layer shades it (`HeatPane.#paintDepthZone`):
 * - the ring pointed at, from the band inside it to its own edge on its side of the price, strongest; the band whole, from the price, faintly;
 *   the same ring across the price at half, as the pane lights it (depth-look.ts `litWeights`);
 * - the order book: over the map's past, column by column on the price each pixel column's bands were centred on (`DepthBands.mid`), so the
 *   heat inside the ribbon is the money the band counts there, and the column read brighter;
 * - the liquidation levels: their history is not on the map, which holds the newest snapshot on the stripe right of the live edge, so the ring is
 *   shaded across the stripe from that snapshot's mark (its edges dashed while the table reads an older one, which most hovers do: the newest
 *   snapshot stands only in the last minutes), and the moment read as a slab at its own time and mark. The band is named, and its edge's price
 *   given on the axis, on the stripe's zone. Their edges are the history's bucket edges the figure was read from, not the bands asked.
 *
 * `?depthZone=off` draws none, for comparing.
 */

import { bandText } from './depth-settings.ts';

export type ZoneSide = 'up' | 'down';

export interface DepthZone {
  /** The Depth pane that shares it (its hover source): only that pane lets it go. */
  pane: string;
  source: 'book' | 'liq';
  side: ZoneSide;
  /** The ring's edges as fractions of the price: from the band inside it (0 for the first band) to its own. */
  inner: number; outer: number;
  /** The ring's ink (the palette's bid or ask colour, as the pane draws that side) and the side across the price's. */
  ink: 'bid' | 'ask'; across: 'bid' | 'ask';
  /** The moment read: its pixel column's start and end, and the price its bands were measured from. */
  moment: { t0: number; t1: number; centre: number };
  /** The order book: each pixel column's centre over [t0, t1] (0 or NaN: none), the first `cut` columns only (a replay's moment). */
  ribbon: { t0: number; t1: number; w: number; mid: ArrayLike<number>; cut: number } | null;
  /** The liquidation levels: the newest snapshot's mark, the ring shaded across the stripe from it; `strong` while the moment read is that snapshot. */
  now: { centre: number; strong: boolean } | null;
}

/**
 * Whether two zones draw the same: the pane works its zone out at every drawing and tells the page only when this says no. The ribbon is the
 * same while it is of the same answer (its centres' array) up to the same column.
 */
export function sameZone(a: DepthZone, b: DepthZone): boolean {
  const ra = a.ribbon, rb = b.ribbon, na = a.now, nb = b.now;
  return a.pane === b.pane && a.source === b.source && a.side === b.side && a.inner === b.inner && a.outer === b.outer && a.ink === b.ink && a.across === b.across
    && a.moment.t0 === b.moment.t0 && a.moment.t1 === b.moment.t1 && a.moment.centre === b.moment.centre
    && (ra === rb || (!!ra && !!rb && ra.mid === rb.mid && ra.t0 === rb.t0 && ra.t1 === rb.t1 && ra.w === rb.w && ra.cut === rb.cut))
    && (na === nb || (!!na && !!nb && na.centre === nb.centre && na.strong === nb.strong));
}

/** Whether the page draws the zone at all (`?depthZone=off` does not). */
export function depthZoneOn(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('depthZone') !== 'off';
}

/** A ring's prices: from `inner` to `outer` of `centre`, above it ('up') or below it ('down'), `lo` under `hi`; null without a price. */
export function ringPrices(centre: number, side: ZoneSide, inner: number, outer: number): { lo: number; hi: number } | null {
  if (!(centre > 0) || !(outer > inner) || !(inner >= 0)) return null;
  return side === 'up' ? { lo: centre * (1 + inner), hi: centre * (1 + outer) } : { lo: centre * Math.max(0, 1 - outer), hi: centre * (1 - inner) };
}

/**
 * A band's ring as fractions of the price, from the edge of the band inside it (0 for the first) to its own: the order book's from the bands
 * asked (`radii`); the liquidation levels' from the history's bucket edges (percentages) each band reads (`idx`, `bandIndex`), since a band
 * between two edges reads the narrower one. Null where the band reads no bucket, or reads the same one as the band inside it (no ring).
 */
export function ringOf(radii: readonly number[], j: number, buckets?: { edges: readonly number[]; idx: readonly number[] }): { inner: number; outer: number } | null {
  if (!buckets) {
    const outer = radii[j] ?? NaN, inner = j > 0 ? radii[j - 1] ?? NaN : 0;
    return outer > inner && inner >= 0 ? { inner, outer } : null;
  }
  const b = buckets.idx[j] ?? -1, inside = j > 0 ? buckets.idx[j - 1] ?? -1 : -1;
  const outer = b >= 0 ? (buckets.edges[b] ?? NaN) / 100 : NaN, inner = inside >= 0 ? (buckets.edges[inside] ?? NaN) / 100 : 0;
  return outer > inner && inner >= 0 ? { inner, outer } : null;
}

/** A column of the ribbon on the map: its x edges and the price its bands were centred on. */
export interface RibbonColumn { x0: number; x1: number; centre: number }

/**
 * The ribbon's runs on the map: the consecutive pixel columns that have a centre, each with its x edges (`xOf` maps a time to the map's x); a
 * column without one ends a run. Columns wholly left of `xMin` or right of `xMax` are left out, and the edges are held inside them.
 */
export function ribbonRuns(r: NonNullable<DepthZone['ribbon']>, xOf: (t: number) => number, xMin: number, xMax: number): RibbonColumn[][] {
  const runs: RibbonColumn[][] = [], n = Math.max(0, Math.min(r.w, r.cut, r.mid.length)), span = r.t1 - r.t0;
  if (!(span > 0) || !(r.w > 0)) return runs;
  let run: RibbonColumn[] | null = null;
  for (let c = 0; c < n; c++) {
    const centre = r.mid[c]!, a = xOf(r.t0 + c / r.w * span), b = xOf(r.t0 + (c + 1) / r.w * span);
    if (!(centre > 0) || b <= xMin || a >= xMax) { run = null; continue; }
    const col = { x0: Math.max(xMin, a), x1: Math.min(xMax, b), centre };
    if (run) run.push(col); else runs.push(run = [col]);
  }
  return runs;
}

/** The slab of the moment read on the map: at least `minW` wide, centred on its column where the column is narrower; null outside [xMin, xMax]. */
export function momentSlab(x0: number, x1: number, minW: number, xMin: number, xMax: number): { x0: number; x1: number } | null {
  const mid = (x0 + x1) / 2, half = Math.max(x1 - x0, minW) / 2, a = Math.max(xMin, mid - half), b = Math.min(xMax, mid + half);
  return b > a ? { x0: a, x1: b } : null;
}

/** The edge's label beside the moment: the band as the table names it (`bandText`), signed by its side (+2.5 % above the price, −2.5 % below). */
export function edgeLabel(side: ZoneSide, outer: number): string {
  return `${side === 'up' ? '+' : '−'}${bandText(outer)} %`;
}
