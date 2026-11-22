/**
 * The Flow history's warm-up (Karl, 2026-11-22: "make it instantly pop up the data"). While no pane shows the footprint's bars, the map
 * (`HeatPane.#warmStep`) asks for what the Flow history reads first, once per market list and timeframe, so that switching it on draws at
 * once from what is held. Measured before it, on the page's own server at 1h: opened cold, the pane waited 0.5 to 0.7 s for its bars and
 * 2.8 s for its liquidation row (eight UTC days, two at a time), and 28 s while the page's own start was still loading; reopened, it drew
 * in 32 ms. The page's own engine took 0.4 s. So the warm-up asks only once the page's own requests have drained (quiet.ts) and the map's
 * own first load is in (`Hub.mapFirst`), one question at a time, and nothing on the clock (footprint.ts `ensure(..., warm)`, liq-days.ts
 * `warm`): the first pane to show the bars asks for what changed since, while drawing what is held. Each piece waits for a second of quiet
 * after the one before. Measured on that server (2026-11-22): at 1h, 11 questions (the markets' step, two slices of bars, as hourly candles
 * read the hours added together, and eight liquidation days) in about 30 s; at 30 minutes, whose candles are read minute by minute in slices
 * of a few candles, 47 slices and then four days, about two and a half minutes. Fifteen-minute candles take about 30 slices, one- and
 * five-minute ones some 5 to 12 (from the slicing rules).
 */

/** The page's own requests drained this long before the warm-up asks for its next piece. */
export const WARM_QUIET_MS = 1_000;
/** A market list and timeframe drawn this long before it is warmed: a switch's own loads come first. */
export const WARM_SETTLE_MS = 3_000;
/** How often the warm-up looks (not every frame). */
export const WARM_LOOK_MS = 250;
/**
 * A warm-up whose questions failed this many times in a row gives up: a source that is down is let go some half a minute after the warm-up
 * began asking it for the bars (each asked again after the loader's 5 s pause), a minute and a half for a day (15 s). Counted from the
 * loaders' answers and failures (`tally`): an answer starts the count again, and another market list or timeframe starts it from none, so
 * failures counted under another one (its warm-up, a pane during an outage) do not count. A pane's on the same list do: one put away
 * during an outage leaves the warm-up let go when it resumes (rare, and the pane asks for itself when it shows again).
 */
export const WARM_MAX_FAILURES = 6;
/**
 * A warm-up that has sent this many questions without being done gives up, the backstop for a source that fails now and then without six
 * in a row. Only a question that went out counts (`warmAfter` gives back a look that sent none: a pause, a day still loading), so time
 * spent waiting costs nothing. A start sent 11 at 1h and 52 at 30 minutes; a much wider view of short candles than the default is left
 * partly warm.
 */
export const WARM_MAX_TRIES = 150;

/**
 * The warm-up's own state: the market list and timeframe it is for (`markets|tf`), since when, the questions it has asked, its last look,
 * done; its failures in a row (`streak`), and the loaders' answers and failures at its last look, to see what came since.
 */
export interface WarmState { key: string; since: number; tries: number; at: number; done: boolean; streak: number; answers: number; failures: number }
export const WARM_IDLE: WarmState = Object.freeze({ key: '', since: 0, tries: 0, at: -Infinity, done: false, streak: 0, answers: 0, failures: 0 });

/** What the map sees at a look. */
export interface WarmLook {
  now: number;
  /** `markets|tf`, '' with no market counted. */
  key: string;
  hidden: boolean;
  /** The map's own first load is still under way (`Hub.mapFirst`). */
  mapFirst: boolean;
  /** Since the page's own last request settled (quiet.ts `quietMs`). */
  quietMs: number;
  /** A footprint question is out (the warm-up's own or not). */
  barsBusy: boolean;
  /** The bars held cover what the Flow history asks for first. */
  barsCovered: boolean;
  /** The Flow history's liquidation row has days to warm (a perpetual counted, and a source that has liquidations). */
  days: boolean;
  /** Questions the bars' and the days' loaders have had answered, and that failed, so far (their `tally`, added together). */
  answers: number;
  failures: number;
}

export type WarmAct = 'none' | 'bars' | 'days';

/** The warm-up's next step from a look: its state after it, and what to ask for (`days`: the caller sets `done` once every day is held). */
export function warmNext(state: WarmState, look: WarmLook): { state: WarmState; act: WarmAct } {
  if (look.now - state.at < WARM_LOOK_MS) return { state, act: 'none' };
  let s: WarmState = { ...state, at: look.now };
  if (!look.key) return { state: s, act: 'none' };
  if (look.key !== s.key) s = { key: look.key, since: look.now, tries: 0, at: look.now, done: false, streak: 0, answers: look.answers, failures: look.failures };
  // An answer since the last look ends a run of failures; failures since then lengthen it (one question at a time: rarely both at a look).
  else s = { ...s, streak: look.answers > s.answers ? 0 : s.streak + look.failures - s.failures, answers: look.answers, failures: look.failures };
  if (s.done) return { state: s, act: 'none' };
  if (look.hidden || look.mapFirst || look.quietMs < WARM_QUIET_MS || look.now - s.since < WARM_SETTLE_MS || look.barsBusy) return { state: s, act: 'none' };
  if (look.barsCovered && !look.days) return { state: { ...s, done: true }, act: 'none' };
  if (s.streak >= WARM_MAX_FAILURES || s.tries >= WARM_MAX_TRIES) return { state: { ...s, done: true }, act: 'none' };
  return { state: { ...s, tries: s.tries + 1 }, act: look.barsCovered ? 'days' : 'bars' };
}

/**
 * The warm-up's state once its act ran, from what the loader said (the bars' `ensure`: whether a question went out; the days' `warm`):
 * every day held is done, and a look whose act sent no question (a loader in its pause after a failure, a day still loading) gives back
 * the question it counted.
 */
export function warmAfter(state: WarmState, sent: boolean | 'done' | 'asked' | 'waiting'): WarmState {
  if (sent === 'done') return { ...state, done: true };
  return sent === false || sent === 'waiting' ? { ...state, tries: Math.max(0, state.tries - 1) } : state;
}

/**
 * The stretch of liquidations the Flow history asks for first (size-history-pane.ts): from the first candle of the warm stretch, or where the
 * record begins (`cover`), to the end of the candle after the view's last, and never past `now`. Null when that is empty.
 */
export function warmLiquidationSpan(from: number, viewEnd: number, tfMs: number, now: number, cover: number): { from: number; to: number } | null {
  const start = Math.max(Math.floor(from / tfMs) * tfMs, cover), end = Math.min(Math.ceil(viewEnd / tfMs) * tfMs + tfMs, now);
  return end > start ? { from: start, to: end } : null;
}
