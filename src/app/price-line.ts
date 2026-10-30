import type { CandleRow } from './store.ts';

/**
 * The price line and its tag on the price axis, the countdown under the tag, and the date the Go to box reads. Candles open and close on
 * whole multiples of the timeframe in UTC (a day at 00:00 UTC), as the exchanges do.
 */

/**
 * The narrowest a candle is drawn as one: narrower, the chart's candles are the line through their closes (heat-pane `#paintCandles`). At
 * a pixel or two a candle is a few overlapping strokes per pixel, and each is drawn on every pointer move.
 */
export const CANDLE_LINE_PX = 2;

/** A point of the line through the closes: where it is drawn, its candle's start, and whether the line breaks before it (a candle missing). */
export interface LinePoint { x: number; y: number; t: number; i: number; brk: boolean }

/**
 * How far apart the points of the thinned line are, in pixels: a line 1.8 px wide over its 4 px halo shows nothing finer, and a canvas
 * strokes a wide line at a cost that grows with its points (a 45-day view of hourly closes, 1,100 points across the map, held the page
 * at 17 frames a second, 2026-10-30).
 */
export const LINE_POINT_PX = 3;

/**
 * The line's points with one a column `px` wide (the last close in it), the breaks kept: a point left out that the line broke before passes
 * its break on to the next one kept. The last point is always kept, and the last before every break.
 */
export function thinLine<P extends LinePoint>(points: readonly P[], px = 1): P[] {
  const out: P[] = [], column = (x: number): number => Math.floor(x / px);
  let carried = false;
  for (let k = 0; k < points.length; k++) {
    const q = points[k]!, next = points[k + 1];
    carried ||= q.brk;
    if (next && !next.brk && column(next.x) === column(q.x)) continue;
    out.push(carried === q.brk ? q : { ...q, brk: carried });
    carried = false;
  }
  return out;
}

/** The time left in the candle under way, as the axis shows it: "mm:ss", or "h:mm:ss" from an hour. */
export function countdown(now: number, tfMs: number): string {
  const left = Math.max(0, Math.ceil(((Math.floor(now / tfMs) + 1) * tfMs - now) / 1000));
  const h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60, two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * Which way the price line is coloured: the candle under way rising or falling (close against open). None without a candle, or while the
 * chart shows another market's candles (the direction would be that market's).
 */
export function lineSide(candles: readonly CandleRow[], seriesInstrument: string, marketId: string): 'up' | 'down' | null {
  const last = candles[candles.length - 1];
  if (!last || (seriesInstrument && seriesInstrument !== marketId)) return null;
  return last[4] >= last[1] ? 'up' : 'down';
}

/** A `datetime-local` value ("2026-10-09T14:30") on the page's clock (UTC or this computer's), as ms; null when it is not one. */
export function parseDateTime(value: string, zone: 'utc' | 'local'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const t = zone === 'utc' ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

/** A moment as a `datetime-local` value on the page's clock, to the minute. */
export function formatDateTime(t: number, zone: 'utc' | 'local'): string {
  const d = new Date(t), two = (n: number): string => String(n).padStart(2, '0');
  const [y, mo, day, h, mi] = zone === 'utc' ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()] : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  return `${y}-${two(mo)}-${two(day)}T${two(h)}:${two(mi)}`;
}

/** Where Go to goes: the moment asked for, the start of what is held when it is earlier (`before`), or the live edge when it is to come (`live`). */
export function clampGoTo(t: number, earliest: number | null, now: number): { t: number; clamped: 'before' | 'live' | null } {
  if (t >= now) return { t: now, clamped: 'live' };
  if (earliest !== null && t < earliest) return { t: earliest, clamped: 'before' };
  return { t, clamped: null };
}
