/**
 * The Flow history's warm-up (Karl, 2026-11-22: "make it instantly pop up the data"). While no pane shows the footprint's bars, the map
 * (`HeatPane.#warmStep`) asks for what the Flow history reads first, once per market list and timeframe, so that switching it on draws at
 * once from what is held. Measured before it, on the page's own server at 1h: opened cold, the pane waited 0.5 to 0.7 s for its bars and
 * 2.8 s for its liquidation row (eight UTC days, two at a time), and 28 s while the page's own start was still loading; reopened, it drew
 * in 32 ms. The page's own engine took 0.4 s. So the warm-up asks only once the page's own requests have drained (quiet.ts) and the map's
 * own first load is in (`Hub.mapFirst`), one question at a time, and nothing on the clock (footprint.ts `ensure(..., warm)`, liq-days.ts
 * `warm`): the first pane to show the bars asks for what changed since, while drawing what is held. Each piece waits for a second of quiet
 * after the one before, so it takes about 15 to 25 s after a start or a switch has settled (more slices on candles under the hour).
 */

/** The page's own requests drained this long before the warm-up asks for its next piece. */
export const WARM_QUIET_MS = 1_000;
/** A market list and timeframe drawn this long before it is warmed: a switch's own loads come first. */
export const WARM_SETTLE_MS = 3_000;
/** How often the warm-up looks (not every frame). */
export const WARM_LOOK_MS = 250;
/**
 * A warm-up that has asked this many times without being done gives up: a source that keeps failing is not asked forever. A question is
 * counted at every look that would ask one (one that is retried after a failure's pause counts at each look of the pause), so time spent
 * waiting (a hidden page, a pane shown, a busy page) costs nothing. A start asks some 3 to 25 times (more slices on candles under the hour).
 */
export const WARM_MAX_TRIES = 80;

/** The warm-up's own state: the market list and timeframe it is for (`markets|tf`), since when, the questions it has asked, its last look, done. */
export interface WarmState { key: string; since: number; tries: number; at: number; done: boolean }
export const WARM_IDLE: WarmState = Object.freeze({ key: '', since: 0, tries: 0, at: -Infinity, done: false });

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
}

export type WarmAct = 'none' | 'bars' | 'days';

/** The warm-up's next step from a look: its state after it, and what to ask for (`days`: the caller sets `done` once every day is held). */
export function warmNext(state: WarmState, look: WarmLook): { state: WarmState; act: WarmAct } {
  if (look.now - state.at < WARM_LOOK_MS) return { state, act: 'none' };
  let s: WarmState = { ...state, at: look.now };
  if (!look.key) return { state: s, act: 'none' };
  if (look.key !== s.key) s = { key: look.key, since: look.now, tries: 0, at: look.now, done: false };
  if (s.done) return { state: s, act: 'none' };
  if (look.hidden || look.mapFirst || look.quietMs < WARM_QUIET_MS || look.now - s.since < WARM_SETTLE_MS || look.barsBusy) return { state: s, act: 'none' };
  if (look.barsCovered && !look.days) return { state: { ...s, done: true }, act: 'none' };
  if (s.tries >= WARM_MAX_TRIES) return { state: { ...s, done: true }, act: 'none' };
  return { state: { ...s, tries: s.tries + 1 }, act: look.barsCovered ? 'days' : 'bars' };
}

/**
 * The stretch of liquidations the Flow history asks for first (size-history-pane.ts): from the first candle of the warm stretch, or where the
 * record begins (`cover`), to the end of the candle after the view's last, and never past `now`. Null when that is empty.
 */
export function warmLiquidationSpan(from: number, viewEnd: number, tfMs: number, now: number, cover: number): { from: number; to: number } | null {
  const start = Math.max(Math.floor(from / tfMs) * tfMs, cover), end = Math.min(Math.ceil(viewEnd / tfMs) * tfMs + tfMs, now);
  return end > start ? { from: start, to: end } : null;
}
