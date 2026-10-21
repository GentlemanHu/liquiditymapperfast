import type { Fetcher } from './history.ts';

/**
 * Long/short ratios as the exchanges publish them: the share of a population that is net long, per period. They count accounts (or, for
 * Binance's top traders, their positions) as each exchange classifies them, never coins: every contract has a long and a short holder, so in
 * coins the two sides are always equal. Nothing here is derived from trades or open interest, and a missing reading is never filled in with
 * 50 %. Hyperliquid publishes none.
 *
 * Measured 2026-10-13 (BTC):
 * - Binance `futures/data/{globalLongShortAccountRatio | topLongShortAccountRatio | topLongShortPositionRatio}`: `longAccount`,
 *   `shortAccount`, `longShortRatio`; 500 a page back from `endTime`, the last 30 days only (an older `endTime` is an error); CORS.
 * - Bybit `v5/market/account-ratio`: `buyRatio`, `sellRatio`, newest first, 500 a page back from `endTime`, years of it; CORS.
 * - OKX `rubik/stat/contracts/long-short-account-ratio-contract`: `[ts, ratio]` newest first, 100 a page back from `end` (five-minute
 *   periods for about a day, hourly for weeks); no CORS header, so a page cannot read it. Its top traders (2026-10-21):
 *   `long-short-account-ratio-contract-top-trader` (by accounts) and `long-short-position-ratio-contract-top-trader` (by positions), the
 *   same shape and paging, hourly for about 30 days.
 * - Gate `futures/usdt/contract_stats` (2026-10-21): every series in one answer, oldest first, 500 a page forward from `from` (seconds),
 *   90 days and more; CORS. Users holding long and short positions (`long_users`, `short_users`, `lsr_account`) and its top traders, "large
 *   holders" in Gate's words, by accounts (`top_long_account`, `top_short_account`, `top_lsr_account`) and by position size (`top_long_size`,
 *   `top_short_size`, `top_lsr_size`); a coin it does not list answers `CONTRACT_NOT_FOUND`.
 * - Bitget (2026-10-21) `v2/mix/market/long-short` (all users: `longRatio`, `shortRatio`, `longShortRatio`), `account-long-short` (its big
 *   traders by accounts: `longAccountRatio`, `shortAccountRatio`, `longShortAccountRatio`) and `position-long-short` (by position:
 *   `longPositionRatio`, `shortPositionRatio`, `longShortPositionRatio`); the English documentation calls the last two "active", the Chinese
 *   大户 (big traders). The newest 30 periods only (24 for `12h`), no paging (`startTime` and `endTime` are ignored); a day is `1Dutc` (`1d` is
 *   refused); CORS; one request a second (`VENUE_GAP_MS`).
 */

/** Which population a series counts: every account, top traders' accounts or their positions; `activeAccounts` only from a server built before Bitget published all three (2026-10-21). */
export type LsPopulation = 'accounts' | 'topAccounts' | 'topPositions' | 'activeAccounts';
/** The series a person can choose: Binance, OKX, Bitget and Gate publish each of them; Bybit one. */
export type LsMetric = 'accounts' | 'topAccounts' | 'topPositions';
export const LS_METRICS: readonly LsMetric[] = ['accounts', 'topAccounts', 'topPositions'];
/** One reading: the period's start (ms) and the share net long (0..1). */
export interface LsPoint { t: number; long: number }
/**
 * `ok` with points; `empty` the venue answered with none for the window; `unsupported` the venue publishes no such series (or none for this
 * market); `serverOnly` a page cannot read it (no CORS header) but a server can; `failed` the request or its answer was not good; `stale`
 * the points held from before, the last request for more having failed.
 */
export type LsStatus = 'ok' | 'empty' | 'unsupported' | 'serverOnly' | 'failed' | 'stale';
export interface LsSeries { id: string; population: LsPopulation | null; periodMs: number; points: LsPoint[]; status: LsStatus }

export const LS_VENUES: readonly string[] = ['binance', 'bybit', 'okx', 'bitget', 'gateio'];
/** The venues whose series follows the one chosen (the others publish one each). */
export const LS_CHOSEN_VENUES: readonly string[] = ['binance', 'okx', 'bitget', 'gateio'];
/** A venue that does not list the market (Gate's `CONTRACT_NOT_FOUND`): it publishes no series for it, which is not a failure to read one. */
export class LsNoMarket extends Error {}
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Each venue's periods (ms) to its name for them. */
const PERIODS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  binance: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [2 * HOUR]: '2h', [4 * HOUR]: '4h', [6 * HOUR]: '6h', [12 * HOUR]: '12h', [DAY]: '1d' },
  bybit: { [5 * MINUTE]: '5min', [15 * MINUTE]: '15min', [30 * MINUTE]: '30min', [HOUR]: '1h', [4 * HOUR]: '4h', [DAY]: '1d' },
  okx: { [5 * MINUTE]: '5m', [HOUR]: '1H', [DAY]: '1D' },
  bitget: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [2 * HOUR]: '2h', [4 * HOUR]: '4h', [6 * HOUR]: '6h', [12 * HOUR]: '12h', [DAY]: '1Dutc' },
  gateio: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [4 * HOUR]: '4h', [DAY]: '1d' },
};
const BINANCE_PATHS: Readonly<Record<LsMetric, string>> = { accounts: 'globalLongShortAccountRatio', topAccounts: 'topLongShortAccountRatio', topPositions: 'topLongShortPositionRatio' };
/** OKX's endpoint for each series (its top traders, ranked as OKX ranks them). */
const OKX_PATHS: Readonly<Record<LsMetric, string>> = { accounts: 'long-short-account-ratio-contract', topAccounts: 'long-short-account-ratio-contract-top-trader', topPositions: 'long-short-position-ratio-contract-top-trader' };
/** Gate's fields for each series: the long side, the short side and their ratio. */
const GATE_FIELDS: Readonly<Record<LsMetric, readonly [string, string, string]>> = { accounts: ['long_users', 'short_users', 'lsr_account'], topAccounts: ['top_long_account', 'top_short_account', 'top_lsr_account'], topPositions: ['top_long_size', 'top_short_size', 'top_lsr_size'] };
/** Bitget's endpoint for each series, and its fields: the long share, the short share and their ratio. */
const BITGET_SERIES: Readonly<Record<LsMetric, readonly [string, string, string, string]>> = {
  accounts: ['long-short', 'longRatio', 'shortRatio', 'longShortRatio'],
  topAccounts: ['account-long-short', 'longAccountRatio', 'shortAccountRatio', 'longShortAccountRatio'],
  topPositions: ['position-long-short', 'longPositionRatio', 'shortPositionRatio', 'longShortPositionRatio'],
};
/**
 * The least time between two requests to a venue, the cache's whole (ms): Bitget allows one a second, and a round reads the series shown and
 * then the other two at once (the pane's warming), which it once answered "Too Many Requests" (2026-10-21).
 */
export const VENUE_GAP_MS: Readonly<Record<string, number>> = { bitget: 1_100 };
/**
 * The most requests that wait for a paced venue's turn: one more fails at once (read again with the minute's retry), so no request goes out
 * long after the round that asked for it gave up, and a burst of questions for other windows cannot queue without end.
 */
export const VENUE_WAITING_MAX = 8;
/** Binance answers only for the last 30 days. */
const BINANCE_SPAN_MS = 30 * DAY;
const PAGES = 12;
/** Readings a page, per venue (Bitget has one page of 30). */
const PAGE_ROWS: Readonly<Record<string, number>> = { binance: 500, bybit: 500, okx: 100, bitget: 30, gateio: 500 };
/** The most readings one window takes from a venue: well inside what one question's pages reach, and far below what a series keeps. */
const windowReadings = (venue: string): number => Math.min(2_000, Math.floor(PAGES * (PAGE_ROWS[venue] ?? 30) * 0.8));
/**
 * The longest the cache waits for one page. `webGet` gives up at 15 s, but a request on the live server once never settled at all: the series'
 * one request never ended, and every later question for it (Bybit's and OKX's hourly BTC readings) waited for good (2026-10-15).
 */
export const LS_PAGE_DEADLINE_MS = 20_000;

/** `promise`, or an error once `ms` have passed without it settling. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The venue's longest period no longer than the chart's candle (five minutes at the least): readings at least as fine as the candles where it can. */
export function lsPeriodOf(venue: string, tfMs: number): number | null {
  const periods = PERIODS[venue]; if (!periods) return null;
  const all = Object.keys(periods).map(Number).sort((a, b) => a - b), want = Math.max(tfMs, 5 * MINUTE);
  return all.filter(p => p <= want).pop() ?? all[0]!;
}

/** The venue's shortest period at least `ms` long (its longest where none is): a window's readings kept to a number. */
export function lsPeriodAtLeast(venue: string, ms: number): number | null {
  const periods = PERIODS[venue]; if (!periods) return null;
  const all = Object.keys(periods).map(Number).sort((a, b) => a - b);
  return all.find(p => p >= ms) ?? all[all.length - 1]!;
}

/**
 * The period a venue's readings of a window [from, to) are taken in: the chart's own where that fits the window, else the shortest that does
 * (a window keeps to `windowReadings`; from 30 days on, daily readings for month-scale context). 0 for a venue that publishes none. The pane
 * reads it to know which of the cache's series a window lands on.
 */
export function lsWindowPeriod(venue: string, tfMs: number, from: number, to: number): number {
  const span = to - from, need = Math.max(span / windowReadings(venue), span >= 30 * DAY ? DAY : 0), fine = LS_VENUES.includes(venue) ? lsPeriodOf(venue, tfMs) : null;
  return fine === null ? 0 : fine >= need ? fine : lsPeriodAtLeast(venue, need) ?? 0;
}

/** The population a venue's series counts, given the series chosen; null for a venue that publishes none. */
export function lsPopulationOf(venue: string, metric: LsMetric): LsPopulation | null {
  return LS_CHOSEN_VENUES.includes(venue) ? metric : venue === 'bybit' ? 'accounts' : null;
}

const num = (value: unknown): number => typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
/**
 * A venue's list of readings, checked for its shape: not a list, or rows none of which carries every field the venue sends and the reading is
 * checked with (`fields`: its time, its share and the short share or ratio it is checked against), fail the answer as a changed API: a
 * renamed cross-check field would otherwise leave every reading out and read as no readings. A reading that is there but does not add up is
 * left out later, one at a time.
 */
function rows(value: unknown, what: string, ...fields: (string | number)[]): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: not a list`);
  if (value.length && !value.some(r => fields.every(field => at(r, field) !== undefined))) throw new Error(`${what}: readings of an unknown shape`);
  return value;
}

/**
 * One reading from what a venue gave: the long share, checked against the short share (they add up to 1, within the rounding of four
 * decimals) and the ratio (long over short, within half a percent) where the venue gives them. A reading that fails is null, never guessed.
 */
export function lsReading(t: number, long: number, short?: number, ratio?: number): LsPoint | null {
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(long) || long <= 0 || long >= 1) return null;
  if (short !== undefined && (!Number.isFinite(short) || Math.abs(long + short - 1) > 0.002)) return null;
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - long / (1 - long)) > 0.005 * ratio + 0.002)) return null;
  return { t, long };
}
/**
 * Where the next page back ends: before the oldest reading time of a full page, from its valid times only (a row with no time, or a time of
 * 0, once ended the paging there and the window read as held to its start). A full page with no valid time cannot be paged on: it fails.
 */
function nextEnd(what: string, oldest: number): number {
  if (!Number.isFinite(oldest)) throw new Error(`${what}: a full page with no reading time`);
  return oldest - 1;
}
/** The long share from a ratio of long to short accounts (OKX gives only that): 1.25 is 1.25 long accounts for each short one, 55.6 % long. */
export const shareOfRatio = (ratio: number): number => ratio / (1 + ratio);

/**
 * A venue's readings of `metric` for the market `symbol` over [from, to), oldest first, and how far back the answer reaches: `from`, or where
 * its pages ran out (at most `PAGES` a question) when the venue had more. Throws when an answer is not what the venue sends (a changed API
 * reads as failed, not as empty); a reading that does not add up is left out.
 */
export async function fetchLongShort(venue: string, symbol: string, metric: LsMetric, periodMs: number, from: number, to: number, get: Fetcher, now = Date.now()): Promise<{ points: LsPoint[]; from: number }> {
  const name = PERIODS[venue]?.[periodMs];
  if (!name || lsPopulationOf(venue, metric) === null || (!LS_CHOSEN_VENUES.includes(venue) && metric !== 'accounts')) throw new Error(`${venue} publishes no such series`);
  const out = new Map<number, LsPoint>(), take = (p: LsPoint | null): void => { if (p && p.t >= from - periodMs && p.t < to) out.set(p.t, p); };
  const s = encodeURIComponent(symbol);
  let end = to, page = 0;
  // Include the reading just before the window, without fetching a full page for a tiny refresh.
  const limitFor = (floor: number): number => Math.max(2, Math.min(PAGE_ROWS[venue] ?? 30, Math.ceil((end - floor) / periodMs) + 2));
  if (venue === 'binance') {
    const floor = Math.max(from, now - BINANCE_SPAN_MS + periodMs);
    // A COIN-M perpetual (BTCUSD_PERP) is read from the COIN-M statistics, by its pair.
    const coinM = /^([A-Z0-9]+)_PERP$/.exec(symbol), market = coinM ? `https://dapi.binance.com/futures/data/${BINANCE_PATHS[metric]}?pair=${encodeURIComponent(coinM[1]!)}` : `https://fapi.binance.com/futures/data/${BINANCE_PATHS[metric]}?symbol=${s}`;
    for (end = Math.min(to, now); page < PAGES && end > floor; page++) {
      // COIN-M names its top traders' position shares longPosition and shortPosition (USD-M calls them longAccount and shortAccount).
      const [longKey, shortKey] = coinM && metric === 'topPositions' ? ['longPosition', 'shortPosition'] : ['longAccount', 'shortAccount'];
      const limit = limitFor(floor);
      const got = rows(await get(`${market}&period=${name}&limit=${limit}&endTime=${Math.floor(end)}`), 'binance', 'timestamp', longKey, shortKey, 'longShortRatio');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'timestamp')); take(lsReading(t, num(at(r, longKey)), num(at(r, shortKey)), num(at(r, 'longShortRatio')))); if (t > 0 && t < oldest) oldest = t; }
      if (got.length < limit) break;
      end = nextEnd('binance', oldest);
    }
  } else if (venue === 'bybit') {
    for (; page < PAGES && end >= from; page++) {
      const limit = limitFor(from);
      // A coin-margined perpetual (BTCUSD) is in Bybit's inverse category.
      const answer = await get(`https://api.bybit.com/v5/market/account-ratio?category=${/^[A-Z0-9]+USD$/.test(symbol) ? 'inverse' : 'linear'}&symbol=${s}&period=${name}&limit=${limit}&endTime=${Math.floor(end)}`);
      if (num(at(answer, 'retCode')) !== 0) throw new Error(`bybit: ${String(at(answer, 'retMsg'))}`);
      const got = rows(at(answer, 'result', 'list'), 'bybit', 'timestamp', 'buyRatio', 'sellRatio');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'timestamp')); take(lsReading(t, num(at(r, 'buyRatio')), num(at(r, 'sellRatio')))); if (t > 0 && t < oldest) oldest = t; }
      if (got.length < limit) break;
      end = nextEnd('bybit', oldest);
    }
  } else if (venue === 'okx') {
    for (; page < PAGES && end >= from; page++) {
      const limit = limitFor(from);
      const answer = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/${OKX_PATHS[metric]}?instId=${s}&period=${name}&limit=${limit}&end=${Math.floor(end)}`);
      if (String(at(answer, 'code')) !== '0') throw new Error(`okx: ${String(at(answer, 'msg'))}`);
      const got = rows(at(answer, 'data'), 'okx', 0, 1);
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 0)), ratio = num(at(r, 1)); take(Number.isFinite(ratio) && ratio > 0 ? lsReading(t, shareOfRatio(ratio)) : null); if (t > 0 && t < oldest) oldest = t; }
      if (got.length < limit) break;
      end = nextEnd('okx', oldest);
    }
  } else if (venue === 'gateio') {
    // USDT-settled perpetuals only (BTC_USDT); read forward from where the window starts, or from where `PAGES` pages back from its end reach.
    const settle = /_USDT$/.test(symbol) ? 'usdt' : null; if (!settle) throw new LsNoMarket(`gateio: ${symbol}`);
    const [longKey, shortKey, ratioKey] = GATE_FIELDS[metric], rowsMax = PAGE_ROWS.gateio!;
    let start = Math.max(from - periodMs, to - PAGES * rowsMax * periodMs);
    const reached = start > from - periodMs ? start : from;
    const unlisted = (answer: unknown): boolean => at(answer, 'label') === 'CONTRACT_NOT_FOUND' || String(at(answer, 'body') ?? '').includes('CONTRACT_NOT_FOUND');
    for (; page < PAGES && start < to; page++) {
      // Gate says so with a 400 (`webGet` keeps its body on the error); a fetcher that hands the body back gives it as the answer.
      const answer = await get(`https://api.gateio.ws/api/v4/futures/${settle}/contract_stats?contract=${s}&interval=${name}&from=${Math.floor(start / 1000)}&limit=${rowsMax}`)
        .catch((error: unknown) => { throw unlisted(error) ? new LsNoMarket(`gateio: ${symbol}`) : error; });
      if (!Array.isArray(answer) && unlisted(answer)) throw new LsNoMarket(`gateio: ${symbol}`);
      const got = rows(answer, 'gateio', 'time', longKey, shortKey, ratioKey);
      let newest = -Infinity;
      for (const r of got) {
        const t = num(at(r, 'time')) * 1000, long = num(at(r, longKey)), short = num(at(r, shortKey));
        // Counts (or sizes) of each side, checked against Gate's own ratio.
        take(long > 0 && short > 0 ? lsReading(t, long / (long + short), short / (long + short), num(at(r, ratioKey))) : null);
        // The cursor moves on from valid times only: an overflowing time ("1e400" is Infinity) or one past the live edge would end the paging
        // with the rest of the window unread.
        if (Number.isFinite(t) && t <= Math.max(to, now) + periodMs && t > newest) newest = t;
      }
      if (got.length < rowsMax) break;
      // A full page must move on: one that repeats (or has no valid time) would spend every page and leave the window's end unread, held as
      // read all the same (the cache holds a window up to its end).
      if (!Number.isFinite(newest) || newest < start) throw new Error('gateio: a full page that does not move on');
      start = newest + periodMs;
    }
    if (start < to && page >= PAGES) throw new Error('gateio: the pages ran out before the window\'s end');
    return { points: [...out.values()].sort((a, b) => a.t - b.t), from: reached };
  } else if (venue === 'bitget') {
    const [path, longKey, shortKey, ratioKey] = BITGET_SERIES[metric];
    const answer = await get(`https://api.bitget.com/api/v2/mix/market/${path}?symbol=${s}&period=${name}`);
    if (String(at(answer, 'code')) !== '00000') throw new Error(`bitget: ${String(at(answer, 'msg'))}`);
    for (const r of rows(at(answer, 'data'), 'bitget', 'ts', longKey, shortKey, ratioKey)) take(lsReading(num(at(r, 'ts')), num(at(r, longKey)), num(at(r, shortKey)), num(at(r, ratioKey))));
  }
  // Every page full: the venue may hold more before where the last one ended.
  return { points: [...out.values()].sort((a, b) => a.t - b.t), from: page >= PAGES && end > from ? end : from };
}

/**
 * The readings asked for, kept: at most `maxSeries` series (the least recently asked for goes first), each one unbroken stretch of at most
 * `maxPoints` readings, and nothing on disk. A series holds [from, to): a window older than that is read back to it, one reaching past it
 * (the newest, at most once a period and never more than once a minute) from where it ends, so a pane hidden for an hour gets the hour; a
 * window further from what is held than one question reaches starts the series again there. Past `maxPoints` the readings furthest from the
 * window asked go. One request at a time per series: a question that waited for another's looks again once it is answered, and a page that
 * has not come in `pageDeadlineMs` fails that request, so no series waits for good. Bitget publishes only its newest 30 periods, so its series
 * grows only while it is asked for.
 */
export class LongShortCache {
  #series = new Map<string, { points: Map<number, LsPoint>; from: number; to: number; checked: number; failed: number; busy: Promise<void> | null; noMarket?: boolean }>();
  /** Each paced venue's lane: when its last request went out (wall-clock ms, once it has), and how many wait behind it. */
  #lanes = new Map<string, { last: Promise<number>; waiting: number }>();
  constructor(private get: Fetcher, private browser: boolean, private now: () => number = Date.now, private maxSeries = 48, private maxPoints = 10_000, private pageDeadlineMs = LS_PAGE_DEADLINE_MS,
    private gapMs: Readonly<Record<string, number>> = VENUE_GAP_MS) {}

  /**
   * `ask`, once the venue's least time has passed since its previous request actually went out: one lane a venue, first come first served, the
   * gap checked again after every wait (timers that fire late, after the page was asleep or busy, then still go out a gap apart).
   */
  async #paced<T>(venue: string, ask: () => Promise<T>): Promise<T> {
    const gap = this.gapMs[venue];
    if (!gap) return ask();
    const lane = this.#lanes.get(venue) ?? { last: Promise.resolve(-Infinity), waiting: 0 };
    this.#lanes.set(venue, lane);
    if (lane.waiting >= VENUE_WAITING_MAX) throw new Error(`${venue}: too many requests waiting for their turn`);
    const before = lane.last;
    let sent!: (at: number) => void;
    lane.last = new Promise<number>(resolve => { sent = resolve; });
    lane.waiting++;
    try {
      const last = await before;
      for (let wait = last + gap - Date.now(); wait > 0; wait = last + gap - Date.now()) await new Promise<void>(resolve => setTimeout(resolve, wait));
    } finally { lane.waiting--; }
    sent(Date.now());
    return ask();
  }

  async series(id: string, metric: LsMetric, tfMs: number, from: number, to: number): Promise<LsSeries> {
    const colon = id.indexOf(':'), venue = id.slice(0, colon), symbol = id.slice(colon + 1);
    // A window needs at most `windowReadings` readings: a long one on a fine chart takes a coarser period, so one question always reaches
    // across it and the series never holds more than it keeps. Month-scale context uses daily readings, independent of the candle setting.
    const population = colon > 0 && LS_VENUES.includes(venue) ? lsPopulationOf(venue, metric) : null;
    // The chart's own period where that fits the window, else the shortest that does (OKX steps from five minutes straight to an hour).
    const periodMs = population ? lsWindowPeriod(venue, tfMs, from, to) : 0;
    const answer = (points: LsPoint[], status: LsStatus): LsSeries => ({ id, population, periodMs, points, status });
    if (!population || !periodMs) return answer([], 'unsupported');
    if (this.browser && venue === 'okx') return answer([], 'serverOnly');
    const key = `${id}|${population}|${periodMs}`;
    let held = this.#series.get(key);
    if (held) this.#series.delete(key);
    held ??= { points: new Map(), from: Infinity, to: -Infinity, checked: 0, failed: 0, busy: null };
    this.#series.set(key, held);
    while (this.#series.size > this.maxSeries) this.#series.delete(this.#series.keys().next().value!);
    const reach = PAGES * PAGE_ROWS[venue]! * periodMs * 0.9;
    // The page's deadline counts from when the request goes out, not from a wait for the venue's turn.
    const get: Fetcher = (url, init) => this.#paced(venue, () => withDeadline(this.get(url, init), this.pageDeadlineMs));
    // At most four requests of its own; waiting for a request (another question's or its own) is not one of them, or five questions at once for
    // different windows left the last answered from what the others read, empty, without its window ever read. Waiting is bounded too (each
    // request is at most `PAGES` pages, each page at most `pageDeadlineMs`); a question that runs out of either before its window is read says
    // it could not be read (`covered`), never that there are no readings.
    let covered = false;
    for (let reads = 0, waits = 0; ;) {
      if (held.busy) { if (waits++ >= 64) break; await held.busy; continue; }
      const h = held, now = this.now(), want = Math.min(to, now + periodMs);
      if (now - h.failed < MINUTE) break;
      let start: number, end: number, kind: 'whole' | 'older' | 'newer';
      // Never read (or started again); a stretch that ends before it starts is held all the same (see below).
      if (h.from === Infinity) { start = from; end = want; kind = 'whole'; }
      else if (from < h.from) { start = from; end = h.from; kind = 'older'; }
      // Past what is held: at once where that ends before the live edge (now's, or the one at the last read: a window that ended a little
      // before it was not held up to it, and its newest readings were not read), at the live edge at most once a period (and once a minute).
      else if (want > h.to && (h.to < now - 2 * periodMs || h.to < h.checked - periodMs || now - h.checked >= Math.max(periodMs, MINUTE))) { start = h.to - 2 * periodMs; end = want; kind = 'newer'; }
      else { covered = true; break; }
      if (reads++ >= 4) break;
      // Too far from what is held for one question to join them without a hole: the series starts again at this window.
      if (kind !== 'whole' && end - start > reach) { h.points.clear(); h.from = Infinity; h.to = -Infinity; start = from; end = want; kind = 'whole'; }
      // The Binance series chosen is Binance's: every other venue publishes its accounts alone.
      h.busy = fetchLongShort(venue, symbol, LS_CHOSEN_VENUES.includes(venue) ? metric : 'accounts', periodMs, start, end, get, now).then(({ points, from: reached }) => {
        // A market the venue did not list before (asked again once a minute) is published again once it answers.
        h.failed = 0; h.noMarket = false;
        for (const p of points) h.points.set(p.t, p);
        // Held from where the answer reached (a long window's pages may stop short of it: the next question reads on from there), up to a
        // period before now: the reading of the period under way comes later. A window that starts inside that period (or after it) is held
        // as a stretch that ends before it starts: nothing is claimed between the edge and the window, so a window there reads it, and the
        // refresh reads on from the edge. (Read as nothing held, it had every question ask the venue again; an empty stretch claimed at the
        // edge skipped the readings between the edge and the window; one claimed at the window's start was past the edge, never refreshed.)
        const until = Math.min(end, now - periodMs);
        if (kind === 'whole') { h.from = reached; h.to = until; h.checked = now; }
        else if (kind === 'older') h.from = Math.min(h.from, reached);
        else {
          // Pages that ran out before reaching what was held leave a hole: only the newer stretch is unbroken (a window in the hole reads it).
          if (reached > h.to) h.from = reached;
          h.to = Math.max(h.to, until); h.checked = now;
        }
        if (h.points.size > this.maxPoints) {
          // The readings furthest from the window asked go, so what it asked for is kept and the rest stays one unbroken stretch.
          const times = [...h.points.keys()].sort((a, b) => a - b), first = times.findIndex(t => t >= from - periodMs);
          const at = Math.max(0, Math.min(first < 0 ? times.length : first, times.length - this.maxPoints)), keep = times.slice(at, at + this.maxPoints);
          h.points = new Map(keep.map(t => [t, h.points.get(t)!]));
          h.from = Math.max(h.from, keep[0]!); h.to = Math.min(h.to, keep[keep.length - 1]! + periodMs);
        }
      }, error => {
        // When it failed, not when it began: a slow request of many pages would otherwise leave no minute's pause behind it.
        h.failed = this.now();
        if (error instanceof LsNoMarket) h.noMarket = true;
      }).finally(() => { h.busy = null; });
    }
    if (held.noMarket) return answer([], 'unsupported');
    const points = [...held.points.values()].filter(p => p.t >= from - periodMs && p.t < to).sort((a, b) => a.t - b.t);
    // The last request failing after the last success says so, with what is held from before; so does a window not read in its turns.
    const failing = !covered || (held.failed > 0 && held.failed >= held.checked);
    if (points.length) return answer(points, failing ? 'stale' : 'ok');
    return answer([], failing ? 'failed' : 'empty');
  }
}

const STATUSES: readonly LsStatus[] = ['ok', 'empty', 'unsupported', 'serverOnly', 'failed', 'stale'];
const POPULATIONS: readonly LsPopulation[] = ['accounts', 'topAccounts', 'topPositions', 'activeAccounts'];
/** A series as it came over the wire, checked: anything not of its shape is an error; a reading out of range or out of order is left out. */
export function parseLsSeries(value: unknown): LsSeries {
  const id = at(value, 'id'), population = at(value, 'population'), periodMs = num(at(value, 'periodMs')), status = at(value, 'status'), points = at(value, 'points');
  if (typeof id !== 'string' || !(population === null || POPULATIONS.includes(population as LsPopulation)) || !(periodMs >= 0) || !STATUSES.includes(status as LsStatus) || !Array.isArray(points))
    throw new Error('not a long/short series');
  const kept: LsPoint[] = [];
  for (const p of points) { const r = lsReading(num(at(p, 't')), num(at(p, 'long'))); if (r && (!kept.length || r.t > kept[kept.length - 1]!.t)) kept.push(r); }
  return { id, population: population as LsPopulation | null, periodMs, points: kept, status: status as LsStatus };
}
