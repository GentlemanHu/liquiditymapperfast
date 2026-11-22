/**
 * The Flow history's warm-up (Karl, 2026-11-22: "make it instantly pop up the data"). While no pane shows the footprint's bars, the map
 * (`HeatPane.#warmStep`) asks for what the Flow history reads first, once per market list and timeframe, so that switching it on draws at
 * once from what is held. Measured before it, on the page's own server at 1h: opened cold, the pane waited 0.5 to 0.7 s for its bars and
 * 2.8 s for its liquidation row (eight UTC days, two at a time), and 28 s while the page's own start was still loading; reopened, it drew
 * in 32 ms. The page's own engine took 0.4 s. So the warm-up asks only once the page's own requests have drained (quiet.ts), one question
 * at a time, and nothing on the clock (footprint.ts `ensure(..., warm)`, liq-days.ts `warm`): the first pane to show the bars asks for
 * what changed since, while drawing what is held.
 */

/** The page's own requests drained this long before the warm-up asks for its next piece. */
export const WARM_QUIET_MS = 1_000;
/** A market list and timeframe drawn this long before it is warmed: a switch's own loads come first. */
export const WARM_SETTLE_MS = 3_000;

export interface WarmGate {
  /** The page is hidden. */
  hidden: boolean;
  /** A pane shows the bars already (it loads them itself). */
  shown: boolean;
  /** This market list and timeframe is warmed already. */
  done: boolean;
  /** Since the page's own last request settled (quiet.ts `quietMs`). */
  quietMs: number;
  /** Since the market list and timeframe became the ones drawn. */
  settledMs: number;
}

/** Whether the warm-up may ask for its next piece now. */
export function warmMayAsk(g: WarmGate): boolean {
  return !g.hidden && !g.shown && !g.done && g.quietMs >= WARM_QUIET_MS && g.settledMs >= WARM_SETTLE_MS;
}

/**
 * The stretch of liquidations the Flow history asks for first (size-history-pane.ts): from the first candle of the warm stretch, or where the
 * record begins (`cover`), to the end of the candle after the view's last, and never past `now`. Null when that is empty.
 */
export function warmLiquidationSpan(from: number, viewEnd: number, tfMs: number, now: number, cover: number): { from: number; to: number } | null {
  const start = Math.max(Math.floor(from / tfMs) * tfMs, cover), end = Math.min(Math.ceil(viewEnd / tfMs) * tfMs + tfMs, now);
  return end > start ? { from: start, to: end } : null;
}
