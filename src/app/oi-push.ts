import type { OiBar } from './store.ts';

/**
 * Open-interest pushes: the source (a server's socket or the browser engine) says the moment a venue has a new reading, and the hub
 * applies it to the bars on screen at once, so the OI pane follows the exchanges instead of waiting for the next clock. The pushes come
 * no faster than the exchanges change open interest (Bybit's ticker carries it only when it changed, Binance is polled), so nothing is
 * throttled here; a source that did push many times a second would just move the same newest bar a few times.
 */

/** One pushed reading, checked field by field (the wire is untrusted). */
export interface OiPush { instrumentId: string; t: number; base: number; quote?: number }

/** Keep only readings that are whole and positive, so a malformed frame never touches the bars. */
export function takeOiPushes(items: unknown): OiPush[] {
  const out: OiPush[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const instrumentId = typeof row.instrumentId === 'string' ? row.instrumentId : '';
    const t = Number(row.t), base = Number(row.base);
    if (!instrumentId || !Number.isFinite(t) || !(t > 0) || !Number.isFinite(base) || !(base > 0)) continue;
    const quote = row.quote === undefined || row.quote === null ? undefined : Number(row.quote);
    out.push({ instrumentId, t, base, ...(quote !== undefined && Number.isFinite(quote) && quote > 0 ? { quote } : {}) });
  }
  return out;
}

/**
 * One reading into the display bars: the bucket its own time falls in keeps its close as the newest reading and its extremes honest. A
 * reading that changes nothing (the newest close already says it, or it is older than the newest bar: a restart, an out-of-order frame)
 * returns null, so a source that repeats the same reading (Hyperliquid pushes its contexts about once a second) never forces a redraw.
 */
export function applyOiReading(bars: readonly OiBar[], t: number, base: number, tfMs: number): OiBar[] | null {
  if (!(base > 0) || !Number.isFinite(base)) return null;
  const bucket = Math.floor(t / tfMs) * tfMs;
  const last = bars[bars.length - 1];
  if (!last || last[0] < bucket) return [...bars, [bucket, base, base, base, base]];
  if (last[0] === bucket) {
    if (base === last[4]) return null;
    const next = [...bars];
    next[next.length - 1] = [bucket, last[1], Math.max(last[2], base), Math.min(last[3], base), base];
    return next;
  }
  return null;
}

/**
 * A reading in the units of the bars it goes into. An inverse market's bars are its own USD put in coins at one price (`usdAt`, Hub.oiSeries):
 * its reading goes in as its USD at that same price, never as its coins at the reading's own mark, which a price move alone would change.
 * Without its USD such a reading is left for the next load (null).
 */
export function oiPushValue(reading: OiPush, usdAt?: number): number | null {
  if (!(usdAt !== undefined && usdAt > 0)) return reading.base;
  return reading.quote !== undefined && reading.quote > 0 ? reading.quote / usdAt : null;
}

/** `readings` (of the bars' one market, oldest first) into its bars; null when none changed them. */
export function withOiPushes(bars: readonly OiBar[], readings: readonly OiPush[], tfMs: number, usdAt?: number): OiBar[] | null {
  let out: OiBar[] | null = null;
  for (const reading of readings) {
    const value = oiPushValue(reading, usdAt); if (value === null) continue;
    const next = applyOiReading(out ?? bars, reading.t, value, tfMs); if (next) out = next;
  }
  return out;
}
