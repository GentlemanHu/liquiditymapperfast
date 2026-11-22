import type { OiBar } from '../store.ts';
import type { OiPart } from '../oi-change.ts';
import { stripTimeframe } from '../measures/volume-strip.ts';

/**
 * The OI pane's long view (pure, tested in tests/app-oi-long.test.mts). The readings held are the chart's last 500 candles and the older ones
 * read once as the view reaches back (Hub.oiReach): a server's month, a page's Binance 30 days and Bybit 2,400 readings. Zoomed out further
 * (Karl, 2026-10-30: two years drew three weeks at the right edge), the line goes on from the venues' own history: until 2026-11-22 Bybit's
 * alone, each reading times the total over Bybit's at the seam, which drifted as Bybit's share grew (14 % to 19 % in three months: mean error
 * 9.0 %); now chained back over Binance (its daily archive, src/shared/oi-archive.ts) and Bybit (`oiLongChain`), about 70 % of the open interest
 * added up (mean error 2.4 % on the same 83 days). Read by the pane straight from the venues on a server too, and kept by the pane alone:
 * the bar statistics, NL/NS and the scripts count the readings held, never these.
 */

const MINUTE = 60_000, DAY = 86_400_000;
/** The venues' shortest open-interest period (Bybit's API, Binance's archive): a one-minute chart's long view is read in five-minute readings. */
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

/**
 * Where the readings held give way to the venues' own history (2026-11-22): the first bar of the line from where a second venue's readings
 * begin (before it the held line is one venue's readings alone), its level, and each long-history venue's reading there (`at`, by market id),
 * the anchor the history is chained from. Null where no venue in `longIds` is among the parts, fewer than two venues have readings, or a
 * long-history venue has no reading at the seam.
 */
export interface OiLongAnchor { index: number; t: number; level: number; at: ReadonlyMap<string, number> }
export function oiLongSeamOf(parts: readonly OiPart[], longIds: readonly string[], chained: readonly OiBar[]): OiLongAnchor | null {
  const starts = parts.filter(part => part.bars.length).map(part => part.bars[0]![0]).sort((a, b) => a - b);
  if (starts.length < 2) return null;
  const index = chained.findIndex(bar => bar[0] >= starts[1]!);
  if (index < 0) return null;
  const t = chained[index]![0], level = chained[index]![4], at = new Map<string, number>();
  for (const id of longIds) {
    const part = parts.find(p => p.id === id), bar = part?.bars.find(b => b[0] === t);
    if (bar && bar[4] > 0) at.set(id, bar[4]);
  }
  return at.size && level > 0 ? { index, t, level, at } : null;
}

/**
 * The long view chained back from the seam over the venues with history (Karl, 2026-11-22: "load multiple venues, the history that they have
 * when zooming out"). Each step back moves the line by the venues read at both its ends: level(t) = level(t + P) x the sum of their readings at
 * t over the sum at t + P. With one venue that is its readings times the line over its own at the seam (the Bybit-only line shipped on 2026-10-30); with
 * Binance and Bybit, about 70 % of the open interest added up, the rest taken to move with them. Measured on 83 days of four venues (Binance,
 * Bybit, OKX, Hyperliquid at 16:00 UTC, every day as the seam): mean error 2.4 % against 9.0 % for Bybit alone (16 % against 4 % 41-88 days
 * back; Bybit's share went from 14 % to 19 %). `rows`: each venue's bars of `periodMs` (oldest first); only those whose period ends by the seam.
 * Each bar's open, high and low are the sum's at the same scale as its close. `venues` names the venues each bar was chained over and `sums`
 * their summed reading there (the bar's level over it is the scale the venues' readings were put at).
 */
export function oiLongChain(rows: ReadonlyMap<string, readonly OiBar[]>, periodMs: number, anchor: Pick<OiLongAnchor, 't' | 'level' | 'at'>): { bars: OiBar[]; venues: string[][]; sums: number[] } {
  const byTime = new Map<number, Map<string, OiBar>>();
  for (const [id, bars] of rows) for (const b of bars) if (b[0] + periodMs <= anchor.t && b[4] > 0) {
    let m = byTime.get(b[0]); if (!m) byTime.set(b[0], m = new Map()); m.set(id, b);
  }
  const bars: OiBar[] = [], venues: string[][] = [], sums: number[] = [];
  let level = anchor.level, then: ReadonlyMap<string, number> = anchor.at;
  for (const t of [...byTime.keys()].sort((a, b) => b - a)) {
    // A venue missing at one end (a day its archive has no file for) is left out of that step; with none at both ends the step waits for
    // the next reading back, measured from the last one chained.
    const here = byTime.get(t)!, both = [...here.keys()].filter(id => then.has(id)).sort();
    if (!both.length) continue;
    let now = 0, before = 0;
    for (const id of both) { now += here.get(id)![4]; before += then.get(id)!; }
    level = level * now / before;
    // The bar's shape: the venues' summed open, high and low at the scale that puts their summed close at the level.
    let o = 0, h = 0, l = 0;
    for (const id of both) { const b = here.get(id)!; o += b[1]; h += b[2]; l += b[3]; }
    const k = level / now;
    bars.push([t, o * k, h * k, l * k, level]); venues.push(both); sums.push(now);
    then = new Map([...here].map(([id, b]) => [id, b[4]] as const));
  }
  bars.reverse(); venues.reverse(); sums.reverse();
  return { bars, venues, sums };
}

/** A window of one venue's readings held: its period, the window asked for (not the readings' reach: a history that starts later is not asked again) and the readings. */
export interface OiLongHeld { ident: string; period: number; from: number; to: number; bars: readonly OiBar[] }

/**
 * The most readings one window asks for: ten of Bybit's 200-reading pages, inside the twelve its reader asks at most (it goes back from the
 * window's end, so a longer window would lose the readings at its start, the view's own where the view is far back).
 */
export const OI_LONG_MAX_ROWS = 2_000;

/**
 * The window to ask for, or null when what is held covers the view: a reading before the view's start up to its end or the seam, whichever
 * comes first. Asked: a view before the view's start (so zooming out a step or panning back asks nothing) up to a view after its end or a day
 * past the seam (the line's first bars move on with the clock), never past now, and `OI_LONG_MAX_ROWS` readings at most: a window always ran
 * to the seam, and a ten-day view 150 days back in hourly readings was asked 3,400 of them, of which the reader kept the newest 2,400, none in
 * view (review, 2026-10-30). Over the cap the margin after the view goes first, then the one before it (a view of more than the cap keeps its
 * end), so a wide plot's long view far back keeps its start. What one window cannot hold is not asked for again.
 */
export function oiLongWindow(held: OiLongHeld | null, view: { t0: number; t1: number }, periodMs: number, seamT: number, now: number): { from: number; to: number } | null {
  const span = Math.max(periodMs, view.t1 - view.t0), cap = OI_LONG_MAX_ROWS * periodMs, start = Math.floor((view.t0 - periodMs) / periodMs) * periodMs;
  const after = Math.min(now, Math.ceil(Math.min(seamT + Math.max(periodMs, DAY), view.t1 + span) / periodMs) * periodMs);
  const to = Math.min(after, Math.max(Math.ceil((view.t1 + periodMs) / periodMs) * periodMs, start + cap));
  const ask = { from: Math.max(Math.floor((view.t0 - span) / periodMs) * periodMs, to - cap), to };
  const needFrom = Math.max(view.t0 - periodMs, ask.from), needTo = Math.min(seamT, view.t1 + periodMs);
  return held && held.period === periodMs && held.from <= needFrom && held.to >= needTo ? null : ask;
}

/**
 * One venue's readings for the long view (the pane keeps one for Bybit and one for Binance), per period (at most one window each, of one
 * market: another market drops them). One read at a time; a read that fails, or does not answer within `OI_LONG_DEADLINE_MS`, is asked again
 * after `OI_LONG_RETRY_MS`. `read` asks the venue, `landed` says a read has answered (the pane draws again).
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
