/**
 * When a venue read once a minute is read: at its minute's close (2026-11-23). A bar's change is its close against the bar before, so a
 * minute's row must hold a reading taken at the minute's end. Until 2026-11-23 a venue was read 60 s after its last read, at whatever
 * second the reader had started on, and the reading was filed in the minute it was taken: a reading 12 s into a minute was really the
 * minute before's close, and about 50 s of every minute's change showed in the next candle. An X user found Hyperliquid's rise of 09:19Z
 * (468 BTC by 8787's dense series) on the 09:20Z candle (422 of it, in the recorded history: hlm-history read every venue 5-13 s into
 * the minute that day; its minute changes matched 8787's of the minute before with correlation 0.89-0.91, the same minute's 0.21-0.26),
 * and on the 1m Range panel the rise in a rising candle was called new shorts on the next, falling one.
 *
 * Now each such read is asked at second `OI_CLOSE_AT_MS`. A reading with no clock of its own (Hyperliquid, Bitget, Deribit) is filed in
 * the minute it was asked for, even when its answer comes after that minute ended (`filedAt`); one its venue stamps (Binance, Bybit, OKX)
 * is filed at that stamp, which says when the figure was set. A close missed by the minute's end (a reader held up across it) is asked up to
 * `OI_LATE_MS` into the next minute and filed in the minute it closes; a reader with no close to ask for (at start, or after a longer gap)
 * reads at once, in its own minute, and asks for its close after. (Hyperliquid's open interest rose 468 BTC in 09:19Z by the server's
 * dense series; the recorded rows put 422 of it in 09:20Z.) The page's engine (Hyperliquid, Bitget, Deribit, and Bybit's and OKX's REST
 * fallback; Binance it polls every 5 s), the server's `OiSampler` (Bitget and Deribit) and hlm-history (`src/oi.rs`, the same rule in
 * Rust) keep it.
 */

const MINUTE_MS = 60_000;
/** The second of each minute at which its close is read (answers come back in well under a second, and a late one still closes it). */
export const OI_CLOSE_AT_MS = 57_000;
/** A close not asked for by the minute's end is still asked for this far into the next minute. */
export const OI_LATE_MS = 10_000;

/**
 * Whether a once-a-minute read is due at `now`, given the newest minute whose close was asked for (`closed`, undefined before the first
 * read): null when not, else the minute its reading is filed in (`files`, for `filedAt`), whether it is that minute's close, and the new
 * `closed` to keep. A first read in a minute's first seconds is of its own minute, not a late close of the minute before: nothing says that
 * close was missed (a restart may have written it, and a second reading at its last millisecond would outrank it; Sol 6.2, 2026-11-23).
 */
export function closeRead(now: number, closed: number | undefined): { files: number; close: boolean; closed: number } | null {
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS, into = now - minute, last = closed ?? -Infinity;
  if (last >= minute) return null;
  if (into >= OI_CLOSE_AT_MS) return { files: minute, close: true, closed: minute };
  if (last === minute - MINUTE_MS) return null;
  if (into < OI_LATE_MS && closed !== undefined) return { files: minute - MINUTE_MS, close: true, closed: minute - MINUTE_MS };
  // Not a close: this minute's close is still to be asked for at `OI_CLOSE_AT_MS`.
  return { files: minute, close: false, closed: minute - MINUTE_MS };
}

/**
 * Where a reading with no clock of its own, asked for in `minute`, is filed: at its arrival, never after that minute's end. A close takes
 * the minute's last millisecond and any other read (one at start) the one before, so the close outranks it in that minute whichever answers
 * first (a minute's newest reading is its row; two late answers at one millisecond kept the first, Sol 6.2).
 */
export const filedAt = (at: number, minute: number, close = true): number => Math.min(at, minute + MINUTE_MS - (close ? 1 : 2));
