import type { OiBar } from '../store.ts';
import type { OiPart } from '../oi-change.ts';
import { stripTimeframe } from '../measures/volume-strip.ts';

/**
 * The OI pane's long view (pure, tested in tests/app-oi-long.test.mts). The readings the page holds are the chart's last 500 candles (21 days
 * at 1h), and of the venues a page can read history from Binance keeps 30 days of it; Bybit's reaches back years (its daily readings from 2023
 * and before, checked 2026-10-30). Zoomed out two years, the pane drew three weeks at the right edge while the Long/Short pane drew the whole
 * view (Karl, 2026-10-30). Further back than the readings held, the line now goes on from Bybit's own history, each reading times the total
 * over Bybit's at the seam (`oiLongSeam`), so it meets the line where that starts and moves as Bybit does: an estimate of the total, drawn as
 * one. Read by the pane straight from Bybit (the server's store holds days of it) and kept by the pane alone: the bar statistics, NL/NS and the
 * scripts count the readings held, never these.
 */

const MINUTE = 60_000, DAY = 86_400_000;
/** Bybit's shortest open-interest period: a one-minute chart's long view is read in five-minute readings. */
const BYBIT_MIN_PERIOD_MS = 300_000;
/** How long a read that failed (or never answered) waits before the window is asked again. */
export const OI_LONG_RETRY_MS = MINUTE;
/** How long a read may take, all its pages together (each is 15 s at most): one that has not answered by then is given up. */
export const OI_LONG_DEADLINE_MS = 60_000;

/**
 * The period of the readings read for a view: the chart's own while its readings would be at least 2 px apart, else the shortest longer
 * timeframe that is (as the Volume strip's bars, `stripTimeframe`), never under Bybit's five minutes. A view is then read in at most a reading
 * for every 2 px, a few of Bybit's 200-reading pages, well inside the twelve its reader asks at most.
 */
export const oiLongPeriod = (tfMs: number, span: number, pw: number): number => Math.max(BYBIT_MIN_PERIOD_MS, stripTimeframe(tfMs, span, pw).ms);

/** Where the readings held give way to Bybit's history: the bar (`index` in the line, `t` its time) and the scale it is put at. */
export interface OiLongSeam { index: number; t: number; k: number }

/**
 * The seam for venues added together (`parts`, the line `chained` drawn from them, oi-change.ts `chainedOi`): Bybit's first bar from where
 * another venue's readings begin, and the line's level there over Bybit's (`k`). Before it the line is Bybit's readings alone (Binance's 30
 * days end before Bybit's 500 bars of a 4h chart do), which the history replaces, scaled as the rest of it is. Null where Bybit's perpetual
 * (`bybitId`) is not among the parts or no other venue has readings: one market's line is that market's, and Bybit's history is not put in
 * its place.
 */
export function oiLongSeam(parts: readonly OiPart[], bybitId: string, chained: readonly OiBar[]): OiLongSeam | null {
  const bybit = parts.find(part => part.id === bybitId);
  if (parts.length < 2 || !bybit?.bars.length) return null;
  let start = Infinity;
  for (const part of parts) if (part !== bybit && part.bars.length) start = Math.min(start, part.bars[0]![0]);
  const at = bybit.bars.find(bar => bar[0] >= start);
  if (!at || !(at[4] > 0)) return null;
  const index = chained.findIndex(bar => bar[0] === at[0]), level = chained[index]?.[4] ?? NaN, k = level / at[4];
  return index >= 0 && Number.isFinite(k) && k > 0 ? { index, t: at[0], k } : null;
}

/**
 * Bybit's readings drawn before the seam: those whose period ends by it (a daily reading drawn at its day's middle would otherwise stand
 * right of the line's first point), each times `k`.
 */
export function oiLongBars(rows: readonly OiBar[], periodMs: number, seam: Pick<OiLongSeam, 't' | 'k'>): OiBar[] {
  const out: OiBar[] = [];
  for (const r of rows) if (r[0] + periodMs <= seam.t) out.push([r[0], r[1] * seam.k, r[2] * seam.k, r[3] * seam.k, r[4] * seam.k]);
  return out;
}

/** A window of Bybit's readings held: its period, the window asked for (not the readings' reach: a history that starts later is not asked again) and the readings. */
export interface OiLongHeld { ident: string; period: number; from: number; to: number; bars: readonly OiBar[] }

/**
 * The window to ask for, or null when what is held covers the view: a reading before the view's start up to the seam. Asked: a view before the
 * view's start (so zooming out a step or panning back asks nothing), up to a day past the seam (the line's first bars move on with the
 * clock), never past now. Bybit's reader goes back from the window's end, so a window longer than its twelve pages loses its oldest readings,
 * never those at the seam, and is not asked again for them.
 */
export function oiLongWindow(held: OiLongHeld | null, view: { t0: number; t1: number }, periodMs: number, seamT: number, now: number): { from: number; to: number } | null {
  const needFrom = view.t0 - periodMs;
  if (held && held.period === periodMs && held.from <= needFrom && held.to >= seamT) return null;
  const span = Math.max(periodMs, view.t1 - view.t0);
  return { from: Math.floor((view.t0 - span) / periodMs) * periodMs, to: Math.min(now, Math.ceil((seamT + Math.max(periodMs, DAY)) / periodMs) * periodMs) };
}

/**
 * Bybit's readings for the long view, per period (at most one window each, of one market: another market drops them). One read at a time;
 * a read that fails, or does not answer within `OI_LONG_DEADLINE_MS`, is asked again after `OI_LONG_RETRY_MS`. `read` asks Bybit, `landed`
 * says a read has answered (the pane draws again).
 */
export class OiLongHistory {
  readonly #held = new Map<number, OiLongHeld>();
  #ident = '';
  #reading: { ident: string; period: number } | null = null;
  #failedAt = -Infinity;
  constructor(
    private readonly read: (ident: string, periodMs: number, from: number, to: number) => Promise<OiBar[]>,
    private readonly landed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a read is under way. */
  get loading(): boolean { return this.#reading !== null; }

  /**
   * The readings to draw for the view, asking for the window where it is not held: those of `periodMs` where held, else (while they are read)
   * those of the nearest period held, else null.
   */
  rows(ident: string, periodMs: number, view: { t0: number; t1: number }, seamT: number): OiLongHeld | null {
    // Another market: what is held and a read under way are its own (that read's answer is dropped when it comes).
    if (ident !== this.#ident) { this.#held.clear(); this.#ident = ident; this.#reading = null; this.#failedAt = -Infinity; }
    const now = this.now(), own = this.#held.get(periodMs) ?? null;
    const ask = this.#reading || now - this.#failedAt < OI_LONG_RETRY_MS ? null : oiLongWindow(own, view, periodMs, seamT, now);
    if (ask) this.#ask(ident, periodMs, ask);
    if (own) return own;
    let best: OiLongHeld | null = null;
    for (const held of this.#held.values()) if (!best || Math.abs(Math.log(held.period / periodMs)) < Math.abs(Math.log(best.period / periodMs))) best = held;
    return best;
  }

  #ask(ident: string, period: number, window: { from: number; to: number }): void {
    const reading = { ident, period };
    this.#reading = reading;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Bybit open-interest history: no answer')), OI_LONG_DEADLINE_MS); (timer as { unref?: () => void }).unref?.(); });
    void Promise.race([this.read(ident, period, window.from, window.to), deadline]).then(bars => {
      if (this.#reading !== reading || ident !== this.#ident) return;
      this.#held.set(period, { ident, period, ...window, bars: [...bars].sort((a, b) => a[0] - b[0]) });
    }, () => { if (this.#reading === reading) this.#failedAt = this.now(); }).finally(() => {
      clearTimeout(timer);
      if (this.#reading === reading) { this.#reading = null; this.landed(); }
    });
  }
}
