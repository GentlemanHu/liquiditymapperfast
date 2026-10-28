/**
 * The magnet: where a drawing's point goes when it is placed or dragged near something worth landing on (pure, tests/draw-magnet.test.mts).
 *
 * Its targets are the open, high, low and close of the candle under the pointer only (never a search across candles, so a chart zoomed out
 * cannot pull a point onto a neighbour), and, where the map has them, the walls of resting liquidity in the heat map's column under the
 * pointer: the rows that hold far more than their column does around them (Karl, 2026-10-28: "making use of the real liquidity walls").
 * Weak catches within a few pixels of a target, Strong from further, and both let go only past one and a half times that, so a point held
 * near two targets does not flicker between them. A committed point never moves when the candle under it does: it is a time and a price.
 */

export type MagnetMode = 'off' | 'weak' | 'strong';
export const MAGNET_MODES: readonly MagnetMode[] = ['off', 'weak', 'strong'];
/** How near a target the pointer must be (CSS px, vertically), with a mouse or a pen and with a finger. */
export const MAGNET_PX: Readonly<Record<Exclude<MagnetMode, 'off'>, { mouse: number; touch: number }>> = { weak: { mouse: 8, touch: 14 }, strong: { mouse: 20, touch: 28 } };
/** A target caught stays caught until the pointer is this many times its radius away. */
export const RELEASE = 1.5;

export type SnapField = 'open' | 'high' | 'low' | 'close' | 'wall';
/** A place a point can land: its time and price, where that is on the plot, what it is, and a wall's resting USD. */
export interface SnapTarget { t: number; p: number; x: number; y: number; field: SnapField; usd?: number }

/** The candle under the pointer as the map draws it: its centre's time and x, and its prices with their y. */
export interface CandleUnder { t: number; x: number; open: number; high: number; low: number; close: number; y: (p: number) => number }

/** The candle's targets: its four prices at its centre, or its close alone where the chart draws closes only (a line). */
export function candleTargets(c: CandleUnder, closesOnly: boolean): SnapTarget[] {
  const fields: [SnapField, number][] = closesOnly ? [['close', c.close]] : [['open', c.open], ['high', c.high], ['low', c.low], ['close', c.close]];
  return fields.map(([field, p]) => ({ t: c.t, p, x: c.x, y: c.y(p), field }));
}

/** How much more than its column a row must hold to be a wall, and how many rows a column needs before any of them can be one. */
export const WALL_K = 3, WALL_MIN_ROWS = 8;

/**
 * The walls in one column of the heat map: the rows (index `i` from the bottom, at `price(i)`) holding at least `WALL_K` times the median of
 * the column's rows with any liquidity, and more than both neighbours (a wall several rows thick is caught at its busiest row). `rows` are the
 * resting USD of the column's rows inside the view; a column with too few rows holding anything has no walls (its median says nothing).
 */
export function wallRows(rows: ArrayLike<number>, price: (i: number) => number): { p: number; usd: number }[] {
  const held: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i]! > 0) held.push(rows[i]!);
  if (held.length < WALL_MIN_ROWS) return [];
  held.sort((a, b) => a - b);
  const median = held[Math.floor(held.length / 2)]!, floor = median * WALL_K, out: { p: number; usd: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]!;
    if (!(v >= floor) || !(v > 0)) continue;
    if ((i > 0 && rows[i - 1]! > v) || (i + 1 < rows.length && rows[i + 1]! >= v)) continue;
    out.push({ p: price(i), usd: v });
  }
  return out;
}

/** The walls of a column as targets at the pointer's time (a wall is a price; the point keeps the time it is placed at). */
export function wallTargets(walls: readonly { p: number; usd: number }[], t: number, x: number, y: (p: number) => number): SnapTarget[] {
  return walls.map(w => ({ t, p: w.p, x, y: y(w.p), field: 'wall', usd: w.usd }));
}

/**
 * Where the point goes: the target nearest the pointer's height within the mode's radius, or the one already caught while the pointer is
 * still within `RELEASE` times the radius of it (and it is still a target); null where none catches it (the point goes where the pointer is).
 * A tie goes to the candle's own price over a wall.
 */
export function snapPoint(pointerY: number, targets: readonly SnapTarget[], mode: MagnetMode, touch: boolean, held: SnapTarget | null): SnapTarget | null {
  if (mode === 'off' || !targets.length) return null;
  const radius = MAGNET_PX[mode][touch ? 'touch' : 'mouse'];
  if (held) {
    const still = targets.find(q => q.field === held.field && q.p === held.p && (q.field === 'wall' || q.t === held.t));
    if (still && Math.abs(still.y - pointerY) <= radius * RELEASE) return still;
  }
  let best: SnapTarget | null = null, bestD = Infinity;
  for (const q of targets) {
    const d = Math.abs(q.y - pointerY);
    if (d > radius) continue;
    if (d < bestD || (d === bestD && best?.field === 'wall' && q.field !== 'wall')) { best = q; bestD = d; }
  }
  return best;
}

/** A vertical line's time: the centre of the candle under the pointer when it is within the radius of it (x), else the pointer's own. */
export function snapTime(pointerX: number, candle: Pick<CandleUnder, 't' | 'x'> | null, mode: MagnetMode, touch: boolean): number | null {
  if (mode === 'off' || !candle) return null;
  return Math.abs(candle.x - pointerX) <= MAGNET_PX[mode][touch ? 'touch' : 'mouse'] ? candle.t : null;
}
