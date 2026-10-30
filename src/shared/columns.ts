import { LT_LENGTH } from './lt-sample.ts';
import type { Column } from './recorder.ts';

/**
 * Recorded or live columns of one instrument as the page reads them: column `c` holds `counts[c]` bins starting where the previous one ended.
 * `lt`: the Liquidity Tracker kept with each column (`Column.lt`), LT_LENGTH values per column, NaN for a column that has none; absent when
 * no column has one (an older source).
 */
export interface ColumnSet {
  id: string; step: number;
  times: number[]; counts: number[]; samples: number[];
  bins: Int32Array; bid: Float32Array; ask: Float32Array;
  lt?: Float32Array;
  /**
   * In an answer to a question for each window's close: the minute each window's book is of (the latest recorded inside it). Absent where
   * the windows are averages (a question for those, or a source from before).
   */
  at?: number[];
}

/**
 * The trackers of `columns` side by side (NaN where a column has none), or undefined when none has one. Only a tracker over every sample of
 * its column counts (`ltN` = `n`): a window that joins minutes recorded before the tracker was kept with newer ones holds a mean of the newer
 * alone, which is not the window's, so the page works that window out from its book instead (and says it is an estimate).
 */
export function packLt(columns: readonly Column[]): Float32Array | undefined {
  const whole = (c: Column): boolean => c.lt !== undefined && c.lt.length === LT_LENGTH && c.ltN === c.n;
  if (!columns.some(whole)) return undefined;
  const out = new Float32Array(columns.length * LT_LENGTH).fill(NaN);
  columns.forEach((c, k) => { if (whole(c)) out.set(c.lt!, k * LT_LENGTH); });
  return out;
}
export interface ColumnsFrame { from: number; to: number; stepMs: number; instruments: ColumnSet[] }

/** Most instruments one /api/v2/columns request serves; the client splits a longer list into requests of this size. */
export const COLUMNS_PER_REQUEST = 12;
