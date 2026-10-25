/**
 * The Liquidity Tracker's windows read from the minutes' trackers alone, without their books: what the tracker lane asks for. A window of
 * minutes is the mean of their trackers weighted by the samples behind each (`recorder.ts` `mergedLt`), which is all the pane draws when
 * no size filter is set (`lt.ts`), so the lane sends those four numbers a window instead of the books' bins (the columns of a week are
 * some 25 MB, the trackers of the same week at the pane's step some 0.3 MB).
 */
import { LT_FIELDS, LT_HALF_LIVES } from './lt-sample.ts';

/** One minute of one instrument as the lane reads it: its samples, and the tracker over `ltN` of them where one was kept (a recorder `Column` is one). */
export interface LtMinute { t: number; n: number; ltN?: number; lt?: Float32Array }

/**
 * The windows with at least one minute, oldest first: `times` their starts, `values` LT_FIELDS numbers each (bid USD x weight, ask USD x
 * weight, the bid weights, the ask weights, as the kept tracker has them for one half-life). A window whose tracker does not cover every
 * sample of its minutes (a minute recorded before the tracker was kept, or one reopened after a restart that kept none) is NaN, as
 * `packLt` leaves it: the pane then has nothing honest to draw there, and says nothing rather than work it out from the books.
 */
export interface LtWindows { times: number[]; values: Float32Array }

/**
 * `minutes` (oldest first, all in [from, to)) cut into windows of `stepMs` from the epoch, the tracker of half-life `half` (an index into
 * LT_HALF_LIVES) of each. The same sums in the same order as the columns' merge, so a window is the number the columns path would hold.
 */
export function ltWindows(minutes: readonly LtMinute[], stepMs: number, half: number): LtWindows {
  const times: number[] = [], rows: number[] = [];
  const at = half * LT_FIELDS;
  let start = NaN, ltN = 0, n = 0;
  const sums = [0, 0, 0, 0];
  const flush = (): void => {
    if (Number.isNaN(start)) return;
    times.push(start);
    const whole = ltN > 0 && ltN === n;
    for (let k = 0; k < LT_FIELDS; k++) rows.push(whole ? sums[k]! / ltN : NaN);
  };
  for (const minute of minutes) {
    const window = Math.floor(minute.t / stepMs) * stepMs;
    if (window !== start) { flush(); start = window; ltN = 0; n = 0; sums.fill(0); }
    n += minute.n;
    const lt = minute.lt, w = minute.ltN ?? 0;
    if (!lt || !(w > 0)) continue;
    for (let k = 0; k < LT_FIELDS; k++) sums[k]! += lt[at + k]! * w;
    ltN += w;
  }
  flush();
  return { times, values: Float32Array.from(rows) };
}

/** Whether `half` names one of the half-lives the tracker is kept for. */
export const validHalf = (half: unknown): half is number => typeof half === 'number' && Number.isInteger(half) && half >= 0 && half < LT_HALF_LIVES.length;
