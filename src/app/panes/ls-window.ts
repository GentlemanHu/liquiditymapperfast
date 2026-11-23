import { LS_WINDOW_READINGS, lsViewPeriod, type LsPopulation, type LsSeries } from '../../shared/long-short.ts';
import { t } from '../i18n.ts';

/** A reading stands until the next one, or for this many of its periods after it when none follows (a gap past that breaks the line). */
export const HOLD_PERIODS = 3;

/** Where the step of a series' reading `i` ends: at the next reading where it comes within the hold, else a period after it. */
export function stepEnd(s: Pick<LsSeries, 'points' | 'periodMs'>, i: number): number {
  const q = s.points[i]!, next = s.points[i + 1];
  return next && next.t - q.t <= HOLD_PERIODS * s.periodMs ? next.t : q.t + s.periodMs;
}

/** The words for who a series counts. */
export function populationText(population: LsPopulation): string {
  return population === 'accounts' ? t('all accounts') : population === 'topAccounts' ? t('top traders, by accounts') : population === 'topPositions' ? t('top traders, by positions') : t('active accounts');
}

/**
 * When the Long/Short pane asks for readings, over which window, and what a round leaves drawn (pure, tested in tests/app-ls-window.test.mts).
 *
 * Each venue's line is read in the period its view asks (`lsViewPeriod`: the zoom, the candle and the venue, never the window), named in every
 * question. The view needs itself and half a view before it. Nothing is asked while what is held (the same markets, series and timeframe)
 * covers that, was asked in the periods this view asks, and was answered less than a minute ago, nor while a round is under way (a round ends
 * when every venue has answered or after `LS_ROUND_MS`, whichever comes first). Otherwise the window asked is three quarters of a view before
 * the view and a quarter after, so zooming and panning a little ask nothing. A live view's end moving on is the minute refresh's to follow,
 * not a new question. Asking anew on every view change had a zoom send three requests a step, each up to a second and a half on the server,
 * with the pane blank until the last (2026-10-15). Asking only for what is not covered had a zoom back in from a month-long view keep its
 * daily readings, every line in steps a day wide, until the minute refresh (2026-10-23). The period once followed the window's length (daily
 * from 30 days): a zoom or a pan of a few pixels turned every line daily (2026-11-23).
 */
export interface LsHeld { ident: string; from: number; to: number; at: number; soon?: number; /** Each market's period asked (by id). */ periods?: ReadonlyMap<string, number> }

const MINUTE = 60_000, HOUR = 3_600_000;
/**
 * How long a round waits for the venues. Each venue's answer is drawn as it comes; one still missing then is given up and reads as failed, or
 * stale over the readings held before. A server's request is cancelled then, so it does not hold one of the browser's six connections to the
 * server; the browser engine's read is its cache's, shared with every question for the series, and goes on (bounded by the cache) for the
 * next one. A round once waited for every venue together with no end: two venues' requests that never came back left the pane on "Reading
 * the long/short ratios…" for good, and each re-ask added two more that never came back (2026-10-15).
 */
export const LS_ROUND_MS = 45_000;
/**
 * How long a question waits for the venue before the source answers with what it holds, `pending` (shared/long-short.ts `series`): the lines
 * held are drawn at once instead of after the slowest page. A question waited for its whole read: a venue that took longer than the round
 * (45 s, a busy server on a saturated PC, 2026-10-23) was given up as failed, and drawn only after the next minute's refresh, 106 s after the
 * pane was switched on, from what the server had read meanwhile.
 */
export const LS_BUDGET_MS = 1_500;
/** How long after a `pending` answer its venue is asked again within the round (the read goes on in the source; each question is answered from it). */
export const LS_FOLLOW_MS = 2_000;
/**
 * The wait before a venue's `attempt`-th question again (0 the first): doubling from `LS_FOLLOW_MS` to 8 s, so a slow read is asked about a
 * handful of times a round, each answer the whole window's readings, rather than every few seconds on a server already busy.
 */
export const lsFollowDelay = (attempt: number): number => Math.min(8_000, LS_FOLLOW_MS * 2 ** Math.max(0, attempt));
/** A round that ended with a venue still pending is asked again this long after, not a minute after. */
export const LS_SOON_MS = 5_000;

/**
 * What the pane says when it draws no step in view, for the series of the markets shown: `reading` while a round waits for a venue or a venue
 * is still being read (`pending`: what it holds is for another time, or nothing), `failed` once it is over and a venue's last update could not
 * be read (failed, or stale: readings held for another time; asked again with the minute refresh), else `none` (the venues answered: nothing
 * for this time).
 */
export function lsMessage(series: readonly LsSeries[], loading: boolean): 'reading' | 'failed' | 'none' {
  return loading || series.some(s => s.pending) ? 'reading' : series.some(s => s.status === 'failed' || s.status === 'stale') ? 'failed' : 'none';
}

/**
 * Each market's period for this view (`lsViewPeriod`, by id; 0 for a venue that publishes none): what every question for it names, and what
 * the line held is judged by. The view's length is taken to the minute: a pan moves both ends by the same amount, yet in floating point the
 * difference can come out a fraction of a millisecond off, enough to cross a period's edge (review 2026-11-23).
 */
export function lsPeriods(ids: readonly string[], tfMs: number, view: { t0: number; t1: number }): Map<string, number> {
  const span = Math.round((view.t1 - view.t0) / MINUTE) * MINUTE;
  return new Map(ids.map(id => [id, lsViewPeriod(id.slice(0, id.indexOf(':')), tfMs, span)]));
}

/**
 * The window to ask for now, or null when nothing need be asked. `periods` are those of the markets shown for this view (`lsPeriods`): where
 * a venue's differs from the one last asked (a zoom across a period's edge, either way) it is asked at once, so the line changes period with
 * the zoom and never later with a pan (asked only when finer, a zoom out kept the finer line until a pan left what it held, and the pan turned
 * it coarser: review 2026-11-23). The window is never longer than `LS_WINDOW_READINGS` readings at the finest period asked (only a view of
 * years in daily readings comes near).
 */
export function lsWindow(held: LsHeld | null, loading: boolean, ident: string, view: { t0: number; t1: number }, tfMs: number, now: number, periods: ReadonlyMap<string, number> = new Map()): { from: number; to: number } | null {
  // Around the view: three quarters of a view before it and a quarter after (two views at most, so `LS_VIEW_READINGS` readings in view keep
  // the window within `LS_WINDOW_READINGS`); what must be held before it is never more than what is asked.
  const span = view.t1 - view.t0, to = Math.ceil(Math.min(view.t1 + span / 4 + tfMs, now + tfMs) / MINUTE) * MINUTE;
  const finest = Math.min(...[...periods.values()].filter(p => p > 0));
  const floor = Number.isFinite(finest) ? Math.ceil((to - LS_WINDOW_READINGS * finest) / HOUR) * HOUR : -Infinity;
  const ask = { from: Math.max(floor, Math.floor((view.t0 - 0.75 * span) / HOUR) * HOUR), to };
  const needFrom = Math.max(ask.from, view.t0 - span / 2), needTo = Math.min(view.t1 + tfMs, now + tfMs);
  if (held && held.ident === ident) {
    if (loading) return null;
    // Another period than the one asked, finer or coarser.
    const changed = [...periods].some(([id, period]) => period > 0 && period !== (held.periods?.get(id) ?? period));
    // `soon`: the round ended with a venue still being read; its readings are asked for again then, not at the minute.
    const due = now - held.at >= MINUTE || (held.soon !== undefined && now >= held.soon);
    if (!changed && held.from <= needFrom && held.to >= needTo - MINUTE && !due) return null;
  }
  return ask;
}

/**
 * Where a series' line ends: its newest reading's step, a period after it (a daily reading stands for its whole day, an hourly one for its
 * hour), so lines of different periods compare by how far they are drawn. -Infinity with no readings.
 */
export const lsReach = (s: Pick<LsSeries, 'points' | 'periodMs'>): number => s.points.reduce((latest, p) => Math.max(latest, p.t), -Infinity) + s.periodMs;
/**
 * Whether a series has a step drawn in `view` (any reading at all with none given): one that covers some of it, among the readings published
 * by `cut` (a replay draws only what had been published by the moment shown: a reading once its period is over), each step ending where the
 * paint ends it (at the next of those readings, not at one still to come).
 */
export function lsDrawnIn(s: Pick<LsSeries, 'points' | 'periodMs'>, view?: { t0: number; t1: number }, cut = Infinity): boolean {
  const shown = { points: cut === Infinity ? s.points : s.points.filter(q => q.t + s.periodMs <= cut), periodMs: s.periodMs };
  return shown.points.some((q, i) => !view || (stepEnd(shown, i) > view.t0 && q.t < view.t1));
}
/** `s` with `status`, no longer pending. */
function settledAs(s: LsSeries, status: LsSeries['status']): LsSeries { const out: LsSeries = { ...s, status }; delete out.pending; return out; }

/**
 * What a landing is judged by: the view shown, each market's period for it now (`want`, `lsPeriods`), the period the round asked each in
 * (`asked`: a failure or a question never answered is of that period) and a replay's moment (`cut`, `lsDrawnIn`).
 */
export interface LsLandAt { view?: { t0: number; t1: number }; want?: ReadonlyMap<string, number>; asked?: ReadonlyMap<string, number>; cut?: number }

/**
 * The series drawn while a round lands, in the order of `ids`: a venue's answer as soon as it comes; until then what it had before (`before`).
 * Once the round is over (`final`) a venue with no answer, or with a failure where readings were held before, keeps those readings marked
 * stale, or is failed when it had none: never left out, so the popup says it could not be read. A `pending` answer that reaches less far
 * than the line drawn (the source holds none for this window yet, or an older stretch while it reads the rest) keeps the line, still
 * pending, so it never blanks or loses its newest hours while its venue is read. One in a finer period than the line (a zoom back in) takes
 * its place as soon as it has a step in the view: a coarser line's step reaches a whole period past its reading, and kept the daily line
 * drawn over the hourly answer, and stale over it when its round failed (2026-11-23). A question in a period the view no longer asks (the
 * zoom moved on while it was read), answered, failed or never answered, leaves a line in the period it asks as it is (the next round asks
 * that period). A line with no step in view gives way to an answer that has one (a pan into history at the same zoom).
 */
export function lsLanded(ids: readonly string[], before: readonly LsSeries[], answers: ReadonlyMap<string, LsSeries>, final: boolean, at: LsLandAt = {}): LsSeries[] {
  const out: LsSeries[] = [];
  const cut = at.cut ?? Infinity, shows = (s: LsSeries): boolean => lsDrawnIn(s, at.view, cut);
  // How far a line is drawn, of the readings a replay has published (one still to come reaches nothing yet: review round 3).
  const reach = (s: LsSeries): number => lsReach(cut === Infinity ? s : { ...s, points: s.points.filter(q => q.t + s.periodMs <= cut) });
  for (const id of ids) {
    const answer = answers.get(id), prev = before.find(s => s.id === id), held = prev?.points.length ? prev : null, wanted = at.want?.get(id);
    // The period of the question, and of what came back: an answer's own (a server from before reads the window's), a failure's the question's.
    const asked = at.asked?.get(id) ?? answer?.periodMs, answered = answer && answer.status !== 'failed' ? answer.periodMs : asked;
    const other = wanted !== undefined && ((asked !== undefined && asked !== wanted) || (answered !== undefined && answered !== wanted));
    // A question or an answer of another period than this zoom's (a zoom since left; a server from before, daily past its 30 days): the line
    // in this zoom's period stays as it is, unless it has nothing in view and the answer has (pending lines are asked again soon by the pane).
    if (held && other && held.periodMs === wanted && !(at.view && !shows(held) && answer && shows(answer))) { out.push(held); continue; }
    // Reaching less far than the line, or (the same period) as far with fewer readings: an older stretch while the rest is read. Finer than
    // the line: only with no step in view. Never over a line with no step in view when the answer has one.
    const shorter = answer?.pending && held && !(at.view && !shows(held) && shows(answer)) && (answer.periodMs < held.periodMs ? !shows(answer)
      : reach(answer) < reach(held) || (answer.periodMs === held.periodMs && reach(answer) === reach(held) && answer.points.length < held.points.length));
    // A stale answer (its update failed) with nothing to draw in view does not take the place of a line that has: that line goes stale.
    const failed = answer && (answer.status === 'failed' || (answer.status === 'stale' && !answer.pending && held && at.view && shows(held) && !shows(answer)));
    if (shorter && held) out.push({ ...held, pending: true });
    else if (answer && !(failed && held)) out.push(answer);
    // Stale: nothing is being read for it any more (a line kept while its venue was read says so no longer).
    else if (answer || final) out.push(held ? settledAs(held, 'stale') : answer ?? { id, population: prev?.population ?? null, periodMs: prev?.periodMs ?? 0, points: [], status: 'failed' });
    else if (prev) out.push(prev);
  }
  return out;
}
