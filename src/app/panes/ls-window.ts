import { lsWindowPeriod, type LsSeries } from '../../shared/long-short.ts';

/**
 * When the Long/Short pane asks for readings, over which window, and what a round leaves drawn (pure, tested in tests/app-ls-window.test.mts).
 *
 * The view needs itself and half a view before it (the first step drawn begins before the view). Nothing is asked while what is held (the
 * same markets, series and timeframe) covers that, is in readings as fine as a window around this view would be, and was answered less than a
 * minute ago, nor while a round is under way (a round ends when every venue has answered or after `LS_ROUND_MS`, whichever comes first).
 * Otherwise the window asked is a view wider on each side than the view needs, so zooming and panning a little ask nothing. A live view's end
 * moving on is the minute refresh's to follow, not a new question. Asking anew on every view change had a zoom send three requests a step, each
 * up to a second and a half on the server, with the pane blank until the last (2026-10-15). Asking only for what is not covered had a zoom back
 * in from a month-long view keep its daily readings, every line in steps a day wide, until the minute refresh (2026-10-23).
 */
export interface LsHeld { ident: string; from: number; to: number; at: number }

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/**
 * The longest window the venues are read in readings as fine as the candles: from 30 days on the long/short cache takes daily readings, for
 * month-scale context (shared/long-short.ts). A view shorter than that asks less around it so the window stays under it: asking a view and a
 * half before a 12-day view had every venue's lines turn to steps a day wide once the chart showed a little more history (2026-10-21). Up to
 * 29 days in view the window, its tail of a candle (four hours at most where the readings are finer than daily) and its rounding to the hour
 * fit; a view longer than that is month-scale and may be read daily.
 */
const FINE_SPAN_MS = 30 * DAY - 2 * HOUR;
/**
 * How long a round waits for the venues. Each venue's answer is drawn as it comes; one still missing then is given up and reads as failed, or
 * stale over the readings held before. A server's request is cancelled then, so it does not hold one of the browser's six connections to the
 * server; the browser engine's read is its cache's, shared with every question for the series, and goes on (bounded by the cache) for the
 * next one. A round once waited for every venue together with no end: two venues' requests that never came back left the pane on "Reading
 * the long/short ratios…" for good, and each re-ask added two more that never came back (2026-10-15).
 */
export const LS_ROUND_MS = 45_000;

/**
 * What the pane says when it draws no step in view, for the series of the markets shown: `reading` while a round waits for a venue, `failed`
 * once it is over and a venue's last update could not be read (failed, or stale: readings held for another time; asked again with the minute
 * refresh), else `none` (the venues answered: nothing for this time).
 */
export function lsMessage(series: readonly LsSeries[], loading: boolean): 'reading' | 'failed' | 'none' {
  return loading ? 'reading' : series.some(s => s.status === 'failed' || s.status === 'stale') ? 'failed' : 'none';
}

/**
 * The window to ask for now, or null when nothing need be asked. `venues` are those of the markets shown: the period each one's readings of a
 * window are taken in (`lsWindowPeriod`) follows the window's length, so a window held from a wider view can cover this one in coarser readings.
 */
export function lsWindow(held: LsHeld | null, loading: boolean, ident: string, view: { t0: number; t1: number }, tfMs: number, now: number, venues: readonly string[] = []): { from: number; to: number } | null {
  // Around the view: a view and a half before it and half a view after, as far as a window under FINE_SPAN_MS allows (a month-long view
  // and more is read as it is, in daily readings); what must be held before it is never more than what is asked.
  const span = view.t1 - view.t0, after = Math.min(span / 2 + tfMs, Math.max(tfMs, (FINE_SPAN_MS - span) / 3)), before = Math.min(1.5 * span, Math.max(0, FINE_SPAN_MS - span - after));
  const needFrom = view.t0 - Math.min(span / 2, before), needTo = Math.min(view.t1 + tfMs, now + tfMs);
  const ask = { from: Math.floor((view.t0 - before) / HOUR) * HOUR, to: Math.ceil(Math.min(view.t1 + after, now + tfMs) / MINUTE) * MINUTE };
  if (held && held.ident === ident) {
    if (loading) return null;
    // Only finer: a coarser period than what is held is never a reason to ask (a live window lengthens as its end moves on, a minute at a time).
    const finer = venues.some(venue => lsWindowPeriod(venue, tfMs, ask.from, ask.to) < lsWindowPeriod(venue, tfMs, held.from, held.to));
    if (!finer && held.from <= needFrom && held.to >= needTo - MINUTE && now - held.at < MINUTE) return null;
  }
  return ask;
}

/**
 * The series drawn while a round lands, in the order of `ids`: a venue's answer as soon as it comes; until then what it had before (`before`).
 * Once the round is over (`final`) a venue with no answer, or with a failure where readings were held before, keeps those readings marked
 * stale, or is failed when it had none: never left out, so the popup says it could not be read.
 */
export function lsLanded(ids: readonly string[], before: readonly LsSeries[], answers: ReadonlyMap<string, LsSeries>, final: boolean): LsSeries[] {
  const out: LsSeries[] = [];
  for (const id of ids) {
    const answer = answers.get(id), prev = before.find(s => s.id === id), held = prev?.points.length ? prev : null;
    if (answer && !(answer.status === 'failed' && held)) out.push(answer);
    else if (answer || final) out.push(held ? { ...held, status: 'stale' } : answer ?? { id, population: prev?.population ?? null, periodMs: prev?.periodMs ?? 0, points: [], status: 'failed' });
    else if (prev) out.push(prev);
  }
  return out;
}
