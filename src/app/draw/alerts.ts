import type { DrawKind, Drawing } from './model.ts';

/**
 * Which drawings with their bell on the price has just reached (pure, tests/draw-alerts.test.mts): a level crossed or touched, a zone entered,
 * a trend line crossed. The page judges each price as it comes (`DrawController.markMoved`), against the price before it on the same market,
 * so an alert is the price moving through the drawing, never a drawing put where the price already is. Karl, 2026-11-26: an alarm for "a
 * area or price target", run by the browser itself.
 *
 * Two readings are compared only when they are of the same market and close in time: the chart moved to another market (a perpetual is
 * not its spot), or the feed or the tab was away for longer than `LOOK_GAP_MS`, and the next reading starts afresh instead of calling a jump
 * between two places a crossing. A message on a phone makes a false alarm costly, so the rule leans to silence.
 */

/** The kinds that can carry a bell: what has one price at each moment (a level, a trend line) or a band of prices (a zone). */
export type AlertDrawKind = 'level' | 'zone' | 'trend';
export const canAlert = (kind: DrawKind): kind is AlertDrawKind => kind === 'level' || kind === 'zone' || kind === 'trend';

/**
 * The candle under way as a price was read, when the chart's candles are of the market the price is of: which candle it is (`key`: market,
 * timeframe and open time), its high and low, and the candle before it (`before`: its open time and prices), which a reload of the history
 * changes and a live update does not.
 */
export interface LiveCandle { key: string; high: number; low: number; before: string }
/** One reading of the price: the market it is of, the price, when it was read (the page's clock) and the candle under way, if it can be used. */
export interface PriceLook { market: string; price: number; at: number; candle: LiveCandle | null }

/** Readings further apart than this are not compared: the feed was gone, the tab asleep, or the page busy elsewhere. */
export const LOOK_GAP_MS = 60_000;
/**
 * A high or low of the candle under way that grew between two readings this close together counts as a price traded between them: a wick that
 * went through a level and came back before the next price was read still reaches it. Further apart, or when the candle or the one before it
 * is not the same (another timeframe, a reloaded history whose candle holds trades from before the bell), the growth is not counted.
 */
export const CANDLE_GROWTH_MS = 5_000;

/**
 * What a bell watches, as one text: its kind, its points, how it runs and whether it is hidden. A bell is judged only while this stays the same
 * from one reading to the next (draw/controller.ts `#steady`), so one put, dragged or brought back onto the price does not go off at once.
 */
export const bellShape = (d: Drawing): string => `${d.kind}|${d.points.map(q => `${q.t}:${q.p}`).join(',')}|${d.extendLeft ? 1 : 0}${d.extendRight ? 1 : 0}${d.hidden ? 1 : 0}`;

/** A drawing the price reached: which, its kind, and the price the alert names (the level, the zone's edge entered, the line's price now). */
export interface Reached { id: string; kind: AlertDrawKind; price: number }

/** A trend line's two points in time order (a line placed right to left reads the same). */
function ends(d: Drawing): [{ t: number; p: number }, { t: number; p: number }] {
  const [a, b] = d.points as [{ t: number; p: number }, { t: number; p: number }];
  return a.t <= b.t ? [a, b] : [b, a];
}

/** A trend line's price at a moment, on the chart's linear price scale; NaN for a line with no length in time (it has no price at a moment). */
export function linePrice(d: Drawing, t: number): number {
  const [a, b] = ends(d);
  return b.t > a.t ? a.p + (b.p - a.p) * (t - a.t) / (b.t - a.t) : Number.NaN;
}

/**
 * Whether the drawing exists at a moment, so its bell can go off then: a level across the map always, a ray from its point on; a zone from its
 * left edge to its right one, or on to the right edge of the map; a trend line between its points or on past them where it is set to run on.
 */
export function alertLive(d: Drawing, t: number): boolean {
  if (d.kind === 'level') return d.extendLeft || t >= d.points[0]!.t;
  if (d.kind === 'zone') {
    const t0 = Math.min(d.points[0]!.t, d.points[1]!.t), t1 = Math.max(d.points[0]!.t, d.points[1]!.t);
    return t >= t0 && (d.extendRight || t <= t1);
  }
  if (d.kind === 'trend') {
    const [a, b] = ends(d);
    return b.t > a.t && (d.extendLeft || t >= a.t) && (d.extendRight || t <= b.t);
  }
  return false;
}

/** Whether a bell can never go off again: a zone or a trend line that ended before `now` and does not run on to the right. */
export function alertEnded(d: Drawing, now: number): boolean {
  if (!canAlert(d.kind) || d.kind === 'level' || d.extendRight) return false;
  return now > Math.max(d.points[0]!.t, d.points[1]!.t);
}

/**
 * The drawings the price reached between two readings. `drawings` are one coin's; hidden ones and those without a bell are left out, and so
 * is any drawing that did not exist at both readings (a zone that began or ended between them).
 *
 * The prices between the readings are taken as everything from one to the other, widened by the candle's high or low where it grew in
 * between (`CANDLE_GROWTH_MS`). A level is reached when the price before was on one side of it and the prices since touched it; a zone is
 * entered when the price before was outside it and the prices since touched its near edge; a trend line is reached when the price before was
 * on one side of the line's price then and the prices since touched its price now (a flat price can cross a sloped line). A price exactly at
 * the drawing before is on neither side: nothing goes off until it has left and come back.
 */
export function reached(prev: PriceLook | null, look: PriceLook, drawings: readonly Drawing[]): Reached[] {
  if (!prev || prev.market !== look.market || !(look.at >= prev.at) || look.at - prev.at > LOOK_GAP_MS) return [];
  const was = prev.price;
  if (!(was > 0) || !(look.price > 0) || !Number.isFinite(was) || !Number.isFinite(look.price)) return [];
  let lo = Math.min(was, look.price), hi = Math.max(was, look.price);
  const a = prev.candle, b = look.candle;
  if (a && b && a.key === b.key && a.before === b.before && look.at - prev.at <= CANDLE_GROWTH_MS) {
    if (b.high > a.high && Number.isFinite(b.high)) hi = Math.max(hi, b.high);
    if (b.low < a.low && b.low > 0) lo = Math.min(lo, b.low);
  }
  const out: Reached[] = [];
  for (const d of drawings) {
    if (!d.alert || d.hidden || !canAlert(d.kind) || !alertLive(d, prev.at) || !alertLive(d, look.at)) continue;
    if (d.kind === 'level') {
      const p = d.points[0]!.p;
      if ((was < p && hi >= p) || (was > p && lo <= p)) out.push({ id: d.id, kind: 'level', price: p });
    } else if (d.kind === 'zone') {
      const z0 = Math.min(d.points[0]!.p, d.points[1]!.p), z1 = Math.max(d.points[0]!.p, d.points[1]!.p);
      if (was < z0 && hi >= z0) out.push({ id: d.id, kind: 'zone', price: z0 });
      else if (was > z1 && lo <= z1) out.push({ id: d.id, kind: 'zone', price: z1 });
    } else {
      const then = linePrice(d, prev.at), now = linePrice(d, look.at);
      if (!(then > 0) || !(now > 0)) continue;
      if ((was < then && hi >= now) || (was > then && lo <= now)) out.push({ id: d.id, kind: 'trend', price: now });
    }
  }
  return out;
}
