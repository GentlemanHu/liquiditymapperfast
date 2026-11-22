/**
 * Binance's open interest from its daily data archive (Karl, 2026-11-22: "load multiple venues, the history that they have when zooming
 * out"): `data.binance.vision/data/futures/um/daily/metrics/<SYMBOL>/<SYMBOL>-metrics-<YYYY-MM-DD>.zip`, the same files the Long/Short pane
 * reads for its Binance history before the API's 30 days (long-short.ts). Each holds a reading every five minutes of the UTC day; its
 * `sum_open_interest` is the open interest in coins, one side, and a row stamped T is the API's reading at T + 5 minutes (`ARCHIVE_SHIFT_MS`,
 * measured for the Long/Short columns; against the 8787 server's own Binance readings at nine moments, 2026-10-24..11-20, the column agreed
 * within 0.1 %). CORS `*`, about 11 KB a day, published the next morning (a day not yet out is a 404). USD-M only: the COIN-M files are per
 * contract.
 *
 * The OI pane's long view reads it for the days before the readings held (oi-long.ts): with Bybit's history, Binance's is about 70 % of the
 * open interest the pane adds up (Binance ~52 %, Bybit ~19 %, 2026-11).
 */
import { ARCHIVE_SHIFT_MS, zipText } from './long-short.ts';
import { oiReading, type Fetcher } from './history.ts';
import type { OiRow } from './series.ts';

const DAY = 86_400_000;
/** The most days one read fetches (newest first: the days nearest the readings held), and how many at once. */
export const OI_ARCHIVE_DAYS = 120;
const IN_FLIGHT = 16;
/** Days kept parsed, as numbers (a reading every five minutes: about 4.6 KB a day), so 800 days keep under 4 MB. */
const KEPT_DAYS = 800;

/** A day's readings as numbers: `t` (the API's reading time) and `coins`, oldest first. */
interface ArchiveOiDay { t: Float64Array; coins: Float64Array }

/** One day's readings, oldest first, at the API's times; null where Binance published no file for the day (not yet, or before the market). */
export async function binanceOiArchiveDay(symbol: string, day: number, get: Fetcher): Promise<OiRow[] | null> {
  const read = await archiveDay(symbol, day, get);
  return read && rowsOf(read);
}

async function archiveDay(symbol: string, day: number, get: Fetcher): Promise<ArchiveOiDay | null> {
  const date = new Date(day).toISOString().slice(0, 10);
  let bytes: unknown;
  try { bytes = await get(`https://data.binance.vision/data/futures/um/daily/metrics/${encodeURIComponent(symbol)}/${encodeURIComponent(symbol)}-metrics-${date}.zip`); }
  catch (error) { if ((error as { status?: unknown } | null)?.status === 404) return null; throw error; }
  if (!(bytes instanceof Uint8Array)) throw new Error('binance archive: not a file');
  const lines = (await zipText(bytes)).split(/\r?\n/), head = lines[0]!.split(','), timeAt = head.indexOf('create_time'), oiAt = head.indexOf('sum_open_interest');
  if (timeAt < 0 || oiAt < 0) throw new Error('binance archive: readings of an unknown shape');
  const out = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(','), m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(cells[timeAt] ?? '');
    if (!m) continue;
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + ARCHIVE_SHIFT_MS, coins = Number(cells[oiAt]);
    if (Number.isFinite(coins) && coins > 0) out.set(t, coins);
  }
  const times = [...out.keys()].sort((a, b) => a - b);
  return { t: Float64Array.from(times), coins: Float64Array.from(times, t => out.get(t)!) };
}

const rowsOf = (day: ArchiveOiDay, from = -Infinity, to = Infinity): OiRow[] => {
  const rows: OiRow[] = [];
  for (let i = 0; i < day.t.length; i++) { const t = day.t[i]!; if (t >= from && t <= to) rows.push(oiReading('binance', t, day.coins[i]!)); }
  return rows;
};

/** Parsed days, by symbol and day; a day being read is its promise (two reads of one day share it). */
const kept = new Map<string, Promise<ArchiveOiDay | null>>();

/**
 * Binance's readings over [from, to] from its archive: the days that hold them, the newest `OI_ARCHIVE_DAYS` of them at most (a longer window
 * gets its newest days: the long view chains back from the readings held, so Binance stops where its days do and Bybit goes on). Readings, each
 * the close of the bar that ends at it (as `fetchOiHistory`'s), so `aggregateOi` files them at any period. A day that fails is left out (the
 * chain counts the venues read at both ends of each step) and asked again next time; a first batch that fails whole stops the read (an
 * outage would otherwise cost every day of the window each minute the long view asks again) and throws, as does every day failing.
 */
export async function binanceOiArchive(symbol: string, from: number, to: number, get: Fetcher, maxDays = OI_ARCHIVE_DAYS): Promise<OiRow[]> {
  const days: number[] = [];
  // A reading at a day's first moment is in the day before's file (its 23:55 row).
  for (let d = Math.floor((to - ARCHIVE_SHIFT_MS) / DAY) * DAY; d >= Math.floor((from - ARCHIVE_SHIFT_MS) / DAY) * DAY && days.length < maxDays; d -= DAY) days.push(d);
  const rows: OiRow[] = [];
  let failed = 0, error: unknown = null;
  for (let i = 0; i < days.length; i += IN_FLIGHT) {
    const batch = days.slice(i, i + IN_FLIGHT);
    const settled = await Promise.allSettled(batch.map(day => {
      const k = `${symbol}|${day}`;
      let read = kept.get(k);
      if (!read) {
        read = archiveDay(symbol, day, get);
        kept.set(k, read);
        // A failure is not kept (asked again next time), nor a recent day with no file yet (published the next morning); an older missing day is.
        read.then(value => { if (value === null && day > Date.now() - 2 * DAY && kept.get(k) === read) kept.delete(k); }, () => { if (kept.get(k) === read) kept.delete(k); });
        while (kept.size > KEPT_DAYS) kept.delete(kept.keys().next().value!);
      }
      return read;
    }));
    let batchFailed = 0;
    for (const r of settled) { if (r.status === 'fulfilled') { if (r.value) rows.push(...rowsOf(r.value, from, to)); } else { failed++; batchFailed++; error = r.reason; } }
    if (i === 0 && batchFailed === batch.length) break;
  }
  if (failed && !rows.length) throw error instanceof Error ? error : new Error('binance archive: no day could be read');
  return rows.sort((a, b) => Number(a.sourceTimestamp) - Number(b.sourceTimestamp));
}

/** Forget every kept day (tests). */
export function forgetOiArchive(): void { kept.clear(); }
