import { parseProfile, type FootprintRecorder, type ProfileAnswer, type ProfileInstrument } from './footprint.ts';
import type { OiBar } from './series.ts';
import { OI_SAMPLE_VENUES, venueOf } from './history.ts';

/**
 * The change in open interest by price: where the market was trading while the open interest of each perpetual went up or down.
 *
 * Open interest is a level read about once a minute (the venues' five-minute history further back), and a change in it says nothing of
 * which trades made it: a trade can open contracts, close them, or hand them from one side to another, and every contract has a long and a
 * short. So a change between two readings is spread over the prices that traded on that market between them, by each price's share of the
 * volume (`FootprintRecorder.spread`): an estimate of where exposure grew or shrank, never of where the holders who are left came in, and
 * never "new longs". Each venue is spread on its own, so an increase on one and a decrease on another both show, and a venue that joins or
 * leaves makes no change. Linear perpetuals are counted in coins (a price move alone changes nothing), each part valued at its row's price;
 * inverse ones (Deribit's coin-margined, Bybit's ...USD) in their own USD. Increases and decreases are kept apart; a change that cannot be
 * placed (no trades recorded between its readings, readings more than `OI_GAP_MS` apart, or an interval reaching past the window) is
 * `unplaced`, signed, never spread over other prices.
 */

const MINUTE = 60_000;
/** Readings further apart than this are a gap, not one change: nothing is spread across it. */
export const OI_GAP_MS = 60 * MINUTE;

/** An inverse perpetual, whose open interest is counted in USD (the rule of app/oi-change.ts `inverseOi`). */
export const inverseOiId = (id: string): boolean => /^deribit:[A-Z]+-PERPETUAL$/.test(id) || /^bybit:[A-Z0-9]+USD$/.test(id);
/** A perpetual whose open interest is read: a venue that has it, and an id that names one perpetual (no `:spot` suffix). */
export const oiInstrument = (id: string): boolean => id.split(':').length === 2 && OI_SAMPLE_VENUES.includes(venueOf(id));

/** The change by price: per instrument, rows of [price, increase, decrease] in USD; `unplaced`, the change that could not be placed (USD, signed). */
export interface OiProfileAnswer extends ProfileAnswer { unplaced: number }

/**
 * The changes between consecutive readings (bars of one minute, oldest first; a reading's bar holds the reading at its end, so the change
 * from one to the next came about in the minutes after the first, up to the end of the second) that lie wholly inside [from, to) and span
 * no gap; `skipped` is what the others add up to.
 */
export function oiIntervals(bars: readonly OiBar[], from: number, to: number, gapMs = OI_GAP_MS): { intervals: { from: number; to: number; amount: number }[]; skipped: number } {
  const intervals: { from: number; to: number; amount: number }[] = [];
  let skipped = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]!, b = bars[i]!, amount = b[4] - a[4];
    if (!Number.isFinite(amount) || amount === 0) continue;
    const start = a[0] + MINUTE, end = b[0] + MINUTE;
    if (b[0] - a[0] > gapMs || start < from || end > to) { if (end > from && start < to) skipped += amount; continue; }
    intervals.push({ from: start, to: end, amount });
  }
  return { intervals, skipped };
}

/** One perpetual's readings: its one-minute bars (USD for an inverse one, else coins) and the price coins not placed are valued at. */
export interface OiSeries { id: string; bars: readonly OiBar[]; coins: boolean; price: number }

/** The change in open interest of each series over [from, to), spread over the footprint's minutes on rows of `rowStep`. */
export function oiProfileOf(footprint: FootprintRecorder, series: readonly OiSeries[], from: number, to: number, rowStep: number): OiProfileAnswer {
  const instruments: ProfileInstrument[] = [];
  let unplaced = 0;
  for (const s of series) {
    const { intervals, skipped } = oiIntervals(s.bars, from, to);
    const spread = footprint.spread(s.id, rowStep, intervals, s.coins, s.price);
    unplaced += spread.unplaced + skipped * (s.coins ? s.price : 1);
    instruments.push({ id: s.id, step: spread.step, rows: spread.rows, minutes: intervals.length, first: null, earliest: null });
  }
  return { from, to, instruments, unplaced };
}

/** An answer checked field by field against the instruments asked for, or null when it is anything else. */
export function parseOiProfile(value: unknown, ids: readonly string[]): OiProfileAnswer | null {
  const base = parseProfile(value, ids), unplaced = (value as { unplaced?: unknown } | null)?.unplaced;
  return base && typeof unplaced === 'number' && Number.isFinite(unplaced) ? { ...base, unplaced } : null;
}
