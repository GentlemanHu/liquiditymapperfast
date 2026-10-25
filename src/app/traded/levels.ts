import type { ProfileAnswer } from '../../shared/footprint.ts';
import { levelsOf, rowOf, type ValueLevels } from '../../shared/profile.ts';
import type { CandleRow } from '../store.ts';
import { dayWindows, lastWindows, minutesOf, monthWindows, sessionWindows, weekWindows, type ProfileWindow } from './sessions.ts';
import { resolveZone, type KindSettings, type LineKind, type TradedSettings } from './settings.ts';

/**
 * The step the traded column asks its rows on: one that both its display rows and the point of control's rows are whole multiples of (and
 * of the recorder's own step, `fine`), so the bars and the levels are each read exactly from the same answer.
 */
export function requestStep(display: number, poc: number, fine: number): number {
  const a = Math.max(1, Math.round(display / fine)), b = Math.max(1, Math.round(poc / fine));
  let x = a, y = b; while (y) [x, y] = [y, x % y];
  return x * fine;
}

/** The point of control and the value area of a traded-volume answer: every instrument's rows on rows of `step`, every price that traded. */
export function answerLevels(answer: ProfileAnswer, step: number, share: number): ValueLevels | null {
  const rows = new Map<number, number>();
  for (const inst of answer.instruments) for (const [low, buy, sell] of inst.rows) {
    // A recorded row lies inside one level row (its step divides the level's): its middle says which.
    const key = rowOf(low + inst.step / 2, step);
    rows.set(key, (rows.get(key) ?? 0) + buy + sell);
  }
  return levelsOf(rows, step, share);
}

/**
 * When a past point of control was first traded through after its window ended: the first candle from `after` whose range reaches it,
 * `tolerance` either side (half a row: the levels are read from every venue, the candles are one market's, a little apart). Null when no
 * candle held reaches it: the level is still naked as far as the candles go.
 */
export function touchedAt(price: number, after: number, candles: readonly CandleRow[], tolerance: number): number | null {
  for (const c of candles) {
    if (c[0] < after) continue;
    if (c[3] - tolerance <= price && price <= c[2] + tolerance) return c[0];
  }
  return null;
}

/**
 * The windows of one kind drawn on the chart (days, weeks, months or sessions): the last `count` of each that have begun, of those that touch
 * [t0, t1]. Days and weeks start in the settings' zone (`page`: the page's clock).
 */
export function linesWindows(s: KindSettings, pageZone: 'local' | 'utc', t0: number, t1: number, now: number, count = s.count): ProfileWindow[] {
  if (count < 1) return [];
  const zone = resolveZone(s.zone, pageZone), end = Math.min(t1, now);
  const all = s.period === 'day' ? dayWindows(zone, t0, end) : s.period === 'week' ? weekWindows(zone, t0, end) : s.period === 'month' ? monthWindows(zone, t0, end)
    : sessionWindows(s.sessions, t0, end, z => resolveZone(z, pageZone));
  return lastWindows(all, count, now);
}

/** A window's kind, from its key (`day|…`, `week|…`, `month|…`, `session|…`). */
export function windowKind(w: Pick<ProfileWindow, 'key'>): LineKind {
  const kind = w.key.slice(0, w.key.indexOf('|'));
  return kind === 'session' ? 'sessions' : kind === 'week' || kind === 'month' ? kind : 'day';
}

/** The windows the recording can still work out: those that began inside what it keeps (`retentionMs` back from the real clock `now`). */
export function recordedWindows<W extends { from: number }>(windows: readonly W[], now: number, retentionMs: number): W[] {
  return windows.filter(w => w.from >= now - retentionMs);
}

/** A day, week or session is drawn only when it was seen for at least this share of it (its minutes, weighted by each venue's volume). */
export const DRAWN_SHARE = 0.9;
/**
 * How much of a window up to `asOf` the recording holds, as a share: the source's own estimate where it gives one (each venue's minutes
 * weighted by its volume, `ValueAreaWindow.covered`), else the minutes of the best-recorded venue (an older source).
 */
export function recordedShare(w: { from: number; to: number; minutes: number; covered?: number }, asOf: number): number {
  if (w.covered !== undefined) return w.covered;
  const span = (Math.min(w.to, asOf) - w.from) / 60_000;
  return span > 0 ? w.minutes / span : 0;
}

/**
 * The candle size days, weeks and sessions are worked out on, from the settings alone (so the page and its panel always agree): five
 * minutes, on which every day and week starts (no zone is off the hour by other than quarters), unless a session switched on starts or
 * ends off the five (09:17), then a minute.
 */
export function candleBarMs(s: Pick<KindSettings, 'period' | 'sessions'>): number {
  const off = (time: string): boolean => (minutesOf(time) ?? 0) % 5 !== 0;
  return s.period === 'sessions' && s.sessions.some(x => x.on && (off(x.start) || off(x.end))) ? 60_000 : 5 * 60_000;
}

/**
 * The point of control and the value area of [from, to) from candles of `barMs` (start, open, high, low, close, volume in coins), each bar's
 * volume in USD (its coins at the bar's typical price) spread evenly over its low to high, on rows of `step`: an estimate, since a candle
 * does not say where inside its range it traded. Only bars that lie wholly inside the window count; `heldTo` is how far the candles are
 * known, so a window under way is worked out up to there. Null levels when nothing traded. `covered` is the share of the window's bars, up
 * to `heldTo`, that are there (a venue that sends no bar for a minute nobody traded has one missing). `rows` is the estimate itself: USD by
 * row (the row's index on `step`), what a past window's profile on the chart draws; `buys` the part of it bought at market, each bar's taker
 * buys spread as its volume is, or null where a bar with volume did not say (a venue that does not report them).
 */
export interface CandleProfile { levels: ValueLevels | null; covered: number; rows: Map<number, number>; buys: Map<number, number> | null }
export function candleLevels(bars: readonly CandleRow[], from: number, to: number, barMs: number, step: number, share: number, heldTo: number): CandleProfile {
  const rows = new Map<number, number>(), buys = new Map<number, number>(), end = Math.min(to, Math.floor(heldTo / barMs) * barMs);
  let n = 0, split = true, any = false;
  for (const b of bars) {
    const [t, , high, low, close, volume] = b;
    if (t < from || t + barMs > end) continue;
    n++;
    if (!(volume > 0) || !(high >= low) || !(low > 0)) continue;
    const usd = volume * (high + low + close) / 3, taker = (b as readonly (number | undefined)[])[7];
    any = true;
    if (taker === undefined || !Number.isFinite(taker)) split = false;
    const bought = split ? usd * Math.min(1, Math.max(0, taker! / volume)) : 0;
    const a = rowOf(low, step), z = rowOf(high, step);
    if (a === z) { rows.set(a, (rows.get(a) ?? 0) + usd); if (split) buys.set(a, (buys.get(a) ?? 0) + bought); continue; }
    for (let k = a; k <= z; k++) {
      const part = (Math.min(high, (k + 1) * step) - Math.max(low, k * step)) / (high - low);
      if (part > 0) { rows.set(k, (rows.get(k) ?? 0) + usd * part); if (split) buys.set(k, (buys.get(k) ?? 0) + bought * part); }
    }
  }
  const expected = Math.max(0, Math.floor((end - from) / barMs));
  return { levels: levelsOf(rows, step, share), covered: expected > 0 ? Math.min(1, n / expected) : 0, rows, buys: split && any ? buys : null };
}

/**
 * Two markets' candle profiles of one window as one (the perpetual's and the spot market's): their rows and buys added up, the levels read
 * from the sum, as covered as the less covered; buys only where both have them.
 */
export function mergeCandleProfiles(a: CandleProfile, b: CandleProfile, step: number, share: number): CandleProfile {
  const rows = new Map(a.rows), buys = a.buys && b.buys ? new Map(a.buys) : null;
  for (const [k, v] of b.rows) rows.set(k, (rows.get(k) ?? 0) + v);
  if (buys) for (const [k, v] of b.buys!) buys.set(k, (buys.get(k) ?? 0) + v);
  return { levels: levelsOf(rows, step, share), covered: Math.min(a.covered, b.covered), rows, buys };
}

/**
 * Whether a column should show the candles' estimate of its window in place of the recording: when the recording holds less than
 * `DRAWN_SHARE` of the window (`since` is where it begins, the later of the start it was asked from and every venue's first minute: null
 * when it holds all of it). One source for the whole column, never the two added: the recording counts every venue, a candle one market, so
 * a sum would be a mixture of two scales, and its point of control and value area a reading of neither (AGENTS.md: no setting may claim to
 * work out what can no longer be worked out). Karl, 2026-10-24: zoomed out to months, the column showed only the last days.
 */
export function loadedColumnWanted(since: number | null, from: number, to: number): boolean {
  if (since === null || !(to > from)) return false;
  return (to - Math.max(from, Math.min(since, to))) / (to - from) < DRAWN_SHARE;
}

/**
 * Where the recording behind the traded-volume column begins inside `window` (null: it holds all of it, or nothing is known yet): the later of
 * the start it can be asked from (`asked`, `askedSpan`) and the first minute of each venue it counts (`earliest` is the first minute recorded
 * at all, so the answer of another window says the same), or, while no answer is held, where the hub knows the recording began. An answer
 * whose venues never recorded anything leaves `since` at the window's end: the recording holds none of it (a page that has only just started,
 * a scope the server does not record), so the candles' estimate is wanted wherever they hold the window. Only the instruments of `ids` (those
 * the column counts now) are read from the held answer. It does not depend on the window
 * the held answer was asked for: a zoom out that has not been answered yet does not flash the estimate on for a window the recording holds.
 */
export function recordingStart(window: { from: number; to: number }, asked: number, held: readonly { id: string; earliest: number | null }[] | null, hubSince: number, ids?: readonly string[]): number | null {
  // An answer for other instruments (a scope or a chip changed, and the answer for the new ones has not come) says nothing about these: none of
  // its instruments counted, it is as if none were held.
  const mine = held && ids ? held.filter(inst => ids.includes(inst.id)) : held;
  let since = asked;
  if (mine && mine.length) {
    let any = false;
    for (const inst of mine) if (inst.earliest !== null) { any = true; if (inst.earliest > since) since = inst.earliest; }
    if (!any) since = window.to;
  } else if (hubSince > since) since = hubSince;
  return since > window.from + 60_000 ? since : null;
}

/**
 * A candle estimate (`candleLevels`) as the answer a column reads, so its bars, levels, header and boxes are drawn by the same code as the
 * recording's: one instrument whose rows are on `step`, each `[low price, bought, sold]`. Where the candles do not say what was bought
 * (`buys` null) a row's whole volume is in `bought` and `split` is false: the column draws it unsplit, in grey. The instrument says it
 * was there for the whole window (`earliest` = `from`), so nothing reads it as a recording that began late.
 */
export function candleAnswer(rows: ReadonlyMap<number, number>, buys: ReadonlyMap<number, number> | null, step: number, from: number, to: number): { answer: ProfileAnswer; split: boolean } {
  const out: [number, number, number][] = [];
  for (const [row, usd] of [...rows].sort((a, b) => a[0] - b[0])) {
    if (!(usd > 0)) continue;
    const bought = buys ? Math.min(usd, Math.max(0, buys.get(row) ?? 0)) : usd;
    out.push([row * step, bought, usd - bought]);
  }
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  return { answer: { from, to, instruments: [{ id: 'candles', step, rows: out, minutes, first: from, earliest: from }] }, split: buys !== null };
}

/** The zone a window's dates are read in: a session's own (its start is a date there), else the zone days and weeks start in. */
export function windowZone(w: ProfileWindow, s: TradedSettings, pageZone: 'local' | 'utc'): string {
  if (w.key.startsWith('session|')) {
    const def = s.sessions.find(x => x.id === w.key.split('|')[1]);
    if (def) return resolveZone(def.zone, pageZone);
  }
  return resolveZone(s.zone, pageZone);
}

/**
 * What the column's header calls its window: a session by its name and date, a week by "Week" and the date of its first day, a month by its
 * month and year, a day by its date. `date` writes a time as a date in the window's zone, `month` as a month and year (absent: `date`);
 * `week` is the word for a week.
 */
export function windowLabel(w: ProfileWindow, date: (t: number) => string, week: string, month: (t: number) => string = date): string {
  const kind = w.key.slice(0, w.key.indexOf('|'));
  if (kind === 'session') return w.name ? `${w.name} ${date(w.from)}` : date(w.from);
  if (kind === 'month') return month(w.from);
  return kind === 'week' ? `${week} ${date(w.from)}` : date(w.from);
}
