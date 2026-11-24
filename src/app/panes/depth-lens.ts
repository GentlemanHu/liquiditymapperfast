/**
 * The Depth pane's lens (Karl, 2026-11-23): the bands near the price drawn larger than the ones far from it, so a thin inner band has room on the
 * plot. Each band holds every one inside it, so a column's bands are rings: the money between one band's edge and the next. The lens gives each
 * ring a weight and draws its thickness as its money times its weight; the rings stack as before, each still in proportion to its own money
 * from one moment to the next and between the bids and the asks, and the table, header and cards keep the money itself.
 *
 * The kinds (`LENS_KINDS`, depth-settings.ts; Karl picked Log curve at 0.1 as the default, 2026-11-23):
 * - `log`: no weights; heights on a logarithmic curve of the money, `ln(1 + c·v/max) / ln(1 + c)`, `c = logBend(strength)`: the scale stays
 *   the money.
 * - `width`: a ring's weight is its width in price to the power `-strength` (strength 1: the money per 1 % of price, so the outer rings, each
 *   twice as wide as the one inside, are halved and quartered).
 * - `even`: a ring's weight is its own largest thickness in view to the power `-strength` (strength 1: every ring as tall at its busiest).
 *   It follows the view, so the shape changes a little as the view moves.
 * With `width` and `even` the outer edge is no longer the total, so the pane's scale keeps only its zero and the crosshair reads the column.
 */
import type { LensKind } from '../depth-settings.ts';

export interface LensSpec { kind: LensKind; strength: number }

/** Each ring's width in price (fractions): the first from the price to the first band, each next from the band inside it to its own edge. */
export function ringWidths(radii: readonly number[], top: number): number[] {
  const out: number[] = [];
  for (let j = 0; j <= top && j < radii.length; j++) out.push(radii[j]! - (j > 0 ? radii[j - 1]! : 0));
  return out;
}

/** The money in ring `j` of column `x` (never below zero: a band with nothing, or past the history's reach, adds no ring). */
function ring(src: ArrayLike<number>, x: number, k: number, j: number): number {
  const v = src[x * k + j]!, inner = j > 0 ? src[x * k + j - 1]! : 0;
  if (!(v > 0)) return 0;
  return Math.max(0, v - (inner > 0 ? inner : 0));
}

/** The rings' weights for bands 0..top, the innermost 1. `even` reads the rings' largest thickness over the first `cols` columns of both sides. */
export function lensWeights(spec: LensSpec, radii: readonly number[], top: number, sides?: { bid: ArrayLike<number>; ask: ArrayLike<number>; k: number; cols: number }): Float64Array {
  const n = top + 1, out = new Float64Array(n).fill(1), p = Math.max(0, spec.strength);
  if (spec.kind === 'width') {
    const widths = ringWidths(radii, top);
    for (let j = 0; j < n; j++) out[j] = widths[j]! > 0 && widths[0]! > 0 ? Math.pow(widths[0]! / widths[j]!, p) : 1;
  } else if (spec.kind === 'even' && sides) {
    const peak = new Float64Array(n);
    for (let x = 0; x < sides.cols; x++) for (let j = 0; j < n; j++) peak[j] = Math.max(peak[j]!, ring(sides.bid, x, sides.k, j), ring(sides.ask, x, sides.k, j));
    const ref = peak[0]! > 0 ? peak[0]! : Math.max(...peak);
    for (let j = 0; j < n; j++) out[j] = peak[j]! > 0 && ref > 0 ? Math.pow(ref / peak[j]!, p) : 1;
  }
  return out;
}

/** A side's columns as drawn through the lens: band `j` of column `x` the weighted rings 0..j, for bands 0..top (0 where the band holds nothing). */
export function warpColumns(src: ArrayLike<number>, w: number, k: number, top: number, weights: ArrayLike<number>): Float32Array {
  const out = new Float32Array(w * k);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let j = 0; j <= top && j < k; j++) {
      sum += weights[j]! * ring(src, x, k, j);
      out[x * k + j] = src[x * k + j]! > 0 ? sum : 0;
    }
  }
  return out;
}

/**
 * The money at a drawn height `u` (in the warped units) in column `x`: inside ring `j`, the money of the bands inside it plus the ring's share
 * under `u`. Null past the column's widest band drawn (nothing is there to read) or where the column is empty.
 */
export function moneyAt(raw: ArrayLike<number>, warped: ArrayLike<number>, x: number, k: number, top: number, weights: ArrayLike<number>, u: number): number | null {
  if (!(u >= 0)) return null;
  let prevU = 0, prevV = 0;
  for (let j = 0; j <= top && j < k; j++) {
    const wu = warped[x * k + j]!, v = raw[x * k + j]!;
    if (!(v > 0)) continue;
    if (u <= wu + 1e-9) return weights[j]! > 0 ? prevV + (u - prevU) / weights[j]! : prevV;
    prevU = wu; prevV = Math.max(prevV, v);
  }
  return null;
}

/** The curve's bend for a strength: `10^(1.5·strength)` from 0.1, and below it falling in a straight line to 0 (no bend: heights in proportion). */
export const logBend = (strength: number): number => strength >= 0.1 ? Math.pow(10, 1.5 * strength) : strength > 0 ? Math.pow(10, 0.15) * strength / 0.1 : 0;
/** A height's share of the half plot (0..1) for a value under the logarithmic curve, and back. */
export const logShare = (value: number, max: number, c: number): number => !(value > 0 && max > 0) ? 0 : c > 1e-9 ? Math.log1p(c * value / max) / Math.log1p(c) : value / max;
export const logValue = (share: number, max: number, c: number): number => c > 1e-9 ? max * Math.expm1(share * Math.log1p(c)) / c : share * max;
