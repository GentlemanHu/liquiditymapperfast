import { fetchOiHistory, fetchOiReading, venueOf, webGet, type Fetcher, type HistoryListing } from '../../shared/history.ts';
import { unitOf, type CoinVenue } from '../../shared/coins.ts';

/**
 * Open interest of the perpetuals the feed manager does not read (it reads Binance's and Hyperliquid's): Bybit, OKX, Bitget and Deribit,
 * in coins, for the aggregated open interest. Each is read once a minute while its book is live; Bybit's and OKX's history is read first
 * and written straight to the history store (two days at 5 minutes, hourly before that to eight days), so their bars reach back at once;
 * a history read that fails is tried again later (backing off to an hour). Bitget's and Deribit's build up from when sampling starts. A
 * live reading goes through the server's own reducer as Binance's does, so the OI route answers it with the stored bars.
 *
 * Bybit and OKX open interest normally arrives on their WebSocket feeds (live-feeds.mts); this sampler is their fallback. While a venue's
 * feed is not live (`setFast`), that venue is read every five seconds instead of once a minute, and back to the minute once the feed
 * returns; that read is of the live value only, never the history, and never beside another read of the same instrument (a read under way
 * is left to finish, the fast round tries again five seconds later). Every venue's failures (an answer without a reading included) are
 * counted, said in `status()` (the diagnostics route, with when each venue was last asked and since when a read of it is under way) and
 * logged at most once every ten minutes, so a dead endpoint is never silent. A read that has not settled is given up after
 * `OI_READ_DEADLINE_MS` (its live reading) or let go after `OI_STALL_MS` (a read or a round): one read let go may still finish beside the one
 * that replaced it (its history rows are turned away by the store where it holds them; its live reading goes through like any other).
 */
export const SAMPLED_OI_VENUES: readonly string[] = ['bybit', 'okx', 'bitget', 'deribit'];
export const OI_SAMPLE_MS = 60_000;
/** A sampled venue whose WebSocket OI feed is down is read this often until the feed returns. */
export const OI_FALLBACK_MS = 5_000;
/** History read at start: five-minute bars this far back, hourly ones before them to `HISTORY_HOURLY_MS`. */
const HISTORY_FINE_MS = 2 * 86_400_000, HISTORY_HOURLY_MS = 8 * 86_400_000;
/** History rows written to the store per turn of the event loop. */
const ROWS_PER_TURN = 200;
/** A failed history read is tried again after a minute, doubling to at most an hour. */
const RETRY_MS = 60_000, RETRY_MAX_MS = 3_600_000;
/** Failures of one venue are logged at most this often. */
const OI_LOG_EVERY_MS = 10 * 60_000;
/**
 * A live reading that has not settled by then is a failure, so a venue that never answers holds the round up this long at most. On
 * 2026-11-19 20:22Z a Bitget read neither answered nor failed for three days and the round, which reads every instrument in turn and waits for
 * each, stopped for every venue with nothing in the diagnostics (failures 0, no error): Bitget's and Deribit's parts went missing from the
 * summed open interest.
 */
export const OI_READ_DEADLINE_MS = 30_000;
/**
 * A round, or a read of one instrument, still under way after this long is taken as stuck: it is logged and no longer waited for (the next
 * round starts beside it; a read of the same instrument starts again). Longer than the slowest history read (two reads of at most `OI_PAGES`
 * pages, each given up after `webGet`'s 15 s).
 */
export const OI_STALL_MS = 10 * 60_000;

export interface OiSampleMessage { kind: 'openInterest'; instrumentId: string; sourceTimestamp: number | null; observationTimestamp?: number; receivedAt: number; base: number; quality: 'native' | 'sampled'; source?: string;
  /** Set on a venue's history reading: the store puts it only in a minute no live sample is in (`HistoryStore.recordOi`). */
  historySource?: string }

/** One sampled venue's outcome, for the diagnostics route. */
export interface OiVenueStatus { lastSuccess: number | null; failures: number; lastError: string | null; nextHistoryAt: number | null; fast: boolean;
  /** When the venue was last asked, and since when a read of it has been under way (null: none): a stuck read shows here. */
  lastAttempt?: number | null; pendingSince?: number | null }

/**
 * How a perpetual lists its coin, from its own instrument id (`venue:SYMBOL`): its symbol, its unit as the coin list reads it (1000PEPEUSDT and
 * Bybit's SHIB1000USDT count thousands), and Deribit's coin-margined perpetuals (BTC-PERPETUAL, ETH-PERPETUAL; the X_USDC-PERPETUAL ones are linear). Null for an
 * id that names no single perpetual (a spot market's `:spot` suffix).
 */
export function oiListingOf(id: string): HistoryListing | null {
  const parts = id.split(':'); if (parts.length !== 2 || !parts[1]) return null;
  const [venue, symbol] = parts as [string, string];
  // The market's name for the base, then its unit as the coin list reads it (1000PEPE, Bybit's SHIB1000).
  // Bybit's coin-margined perpetuals (BTCUSD, a server's BYBIT_CATEGORY=inverse) count open interest in USD, as Deribit's do.
  const bybitInverse = venue === 'bybit' && /^[A-Z0-9]+USD$/.test(symbol);
  const base = venue === 'okx' ? symbol.split('-')[0]! : venue === 'deribit' ? symbol.replace(/-PERPETUAL$/, '').replace(/_USDC$/, '') : symbol.replace(/(USDT|USDC|USD)$/, '');
  return { symbol, unit: unitOf(base, venue as CoinVenue)[1], ...((venue === 'deribit' && /^[A-Z]+-PERPETUAL$/.test(symbol)) || bybitInverse ? { inverse: true } : {}) };
}

/** `work`, or an error saying `late` once `ms` have passed without it settling; the timer is let go either way. */
function within<T>(work: Promise<T>, ms: number, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(late)), ms); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The sampler's `record` for a history store: false only while the store has stopped writing (over its budget), so the history is read again
 * later. A row the store already holds is turned away too (a restart reads the history again over what it wrote before), and that is no
 * refusal: taking it as one stopped the read at its oldest row, so the stretch the server was down was never filled in.
 */
export function oiHistoryWriter(history: { persistenceSuspended: boolean; recordOi(message: Record<string, unknown>): unknown }): (message: OiSampleMessage) => boolean {
  return message => { if (history.persistenceSuspended) return false; history.recordOi({ ...message }); return !history.persistenceSuspended; };
}

export class OiSampler {
  #ids: string[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #fastTimer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null; #fastRunning: Promise<void> | null = null; #closed = false;
  /** When the round under way started (`OI_STALL_MS`). */
  #roundSince = 0;
  /** The timers of the waits on a read under way (`#waitHeld`), let go by `close()`. */
  readonly #waits = new Set<ReturnType<typeof setTimeout>>();
  /** Each instrument's history: read, or when to try again and how many times it failed. */
  readonly #history = new Map<string, { done: boolean; tries: number; nextAt: number }>();
  /** Per venue: the last outcome, for the diagnostics route and the ten-minute failure log. */
  readonly #status = new Map<string, OiVenueStatus>();
  readonly #logged = new Map<string, number>();
  /** Venues whose WebSocket OI feed is not live: read every five seconds until it returns. */
  #fast = new Set<string>();
  /** When each instrument was last asked (the fast rounds gate on it). */
  readonly #lastAsked = new Map<string, number>();
  readonly #log: (message: string) => void;

  /**
   * `apply` hands a live reading to the server's reducer; `record` writes a history row to the store (false: refused). `get` and `now` are the network and
   * the clock (tests pass fakes). `log` receives the ten-minute failure lines. `readDeadlineMs` and `stallMs` are `OI_READ_DEADLINE_MS` and
   * `OI_STALL_MS` (tests pass short ones).
   */
  constructor(private apply: (message: OiSampleMessage, venue: string) => void, private record: (message: OiSampleMessage) => unknown,
    private get: Fetcher = webGet, private now: () => number = Date.now, private everyMs = OI_SAMPLE_MS, log: (message: string) => void = message => console.warn(message),
    private readDeadlineMs = OI_READ_DEADLINE_MS, private stallMs = OI_STALL_MS) {
    this.#log = log;
  }

  /** What each sampled venue did last, for the diagnostics route: with when it was last asked and since when a read of it is under way. */
  status(): Record<string, OiVenueStatus> {
    const out: Record<string, OiVenueStatus> = {};
    for (const venue of SAMPLED_OI_VENUES) {
      const held = this.#status.get(venue) ?? { lastSuccess: null, failures: 0, lastError: null, nextHistoryAt: null, fast: false };
      let lastAttempt: number | null = null, pendingSince: number | null = null;
      for (const [id, at] of this.#lastAsked) if (venueOf(id) === venue && (lastAttempt === null || at > lastAttempt)) lastAttempt = at;
      for (const [id, read] of this.#inflight) if (venueOf(id) === venue && (pendingSince === null || read.since < pendingSince)) pendingSince = read.since;
      out[venue] = { ...held, fast: this.#fast.has(venue), lastAttempt, pendingSince };
    }
    return out;
  }

  /** Venues read every five seconds while their WebSocket OI feed is not live (only Bybit's and OKX's have one). */
  setFast(venues: readonly string[]): void {
    this.#fast = new Set(venues.filter(venue => venue === 'bybit' || venue === 'okx'));
  }

  /** The perpetuals whose book is live: those of the sampled venues are read from now on, the others are let go. */
  sync(ids: readonly string[]): void {
    if (this.#closed) return;
    this.#ids = [...new Set(ids.filter(id => SAMPLED_OI_VENUES.includes(venueOf(id)) && oiListingOf(id) !== null))].sort();
    if (this.#ids.length && !this.#timer) {
      this.#timer = setInterval(() => { void this.round(); }, this.everyMs);
      this.#timer.unref?.();
      this.#fastTimer = setInterval(() => { void this.roundFast(); }, OI_FALLBACK_MS);
      this.#fastTimer.unref?.();
      void this.round();
    } else if (!this.#ids.length && this.#timer) { clearInterval(this.#timer); this.#timer = null; clearInterval(this.#fastTimer!); this.#fastTimer = null; }
  }

  /** One reading of every instrument (after its history, when due); a round under way is the one returned. The timer calls it. */
  round(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    // A round still under way past the stall limit is no longer waited for (logged): the next one starts beside it, and the reads it waits
    // on are let go by the same limit (`#held`), so one stuck answer cannot stop the sampling of every venue again.
    if (this.#running && this.now() - this.#roundSince > this.stallMs) {
      this.#log(`open interest sampling: a round has been under way for ${Math.round((this.now() - this.#roundSince) / 60_000)} min; starting another`);
      this.#running = null;
    }
    if (!this.#running) {
      this.#roundSince = this.now();
      const run: Promise<void> = this.#round().finally(() => { if (this.#running === run) this.#running = null; });
      this.#running = run;
    }
    return this.#running;
  }

  /** One reading of each fast (WebSocket-down) venue; a round under way is the one returned. The fast timer calls it. */
  roundFast(): Promise<void> {
    if (this.#closed || !this.#fast.size) return Promise.resolve();
    this.#fastRunning ??= this.#roundFast().finally(() => { this.#fastRunning = null; });
    return this.#fastRunning;
  }

  async #round(): Promise<void> {
    for (const id of this.#ids) await this.#once(id, true);
  }

  async #roundFast(): Promise<void> {
    for (const id of this.#ids) {
      const venue = venueOf(id);
      if (!this.#fast.has(venue)) continue;
      if (this.now() - (this.#lastAsked.get(id) ?? 0) < OI_FALLBACK_MS) continue;
      // A read under way (the minute round's, its history at start) is left to finish: the next fast round, five seconds on, asks again. Waiting
      // for it, the fast round stayed pinned on a read that never settled while the minute round had let it go (review, 2026-11-22).
      if (this.#held(id)) continue;
      await this.#once(id, false);
    }
  }

  /**
   * One read of an instrument at a time, whichever round asks: a slow history read at start once ran twice side by side, the fast round
   * starting it again while the minute's round was still paging (the fast round now leaves an instrument whose read is under way, so at start
   * the fast fallback brings nothing until the history is in, as before it existed; the socket's first frame comes within a second anyway).
   * The minute's round that finds a read under way waits for it and reads the history after it, when due: joining it alone would lose the
   * history each time the two met, and a failed history read would never be tried again. It waits no longer than until that read's stall
   * limit; a read still under way then is let go (`#held`) and this one reads in its place, so a read stuck mid-round costs the next round
   * the rest of its limit, not a whole limit more. The one exception to one read at a time: a read let go may still finish beside its
   * replacement.
   */
  #once(id: string, withHistory: boolean): Promise<void> {
    const held = this.#held(id);
    if (held) return this.#waitHeld(held).then(stalled => stalled ? this.#once(id, withHistory) : withHistory ? this.#readHistoryDue(id) : undefined);
    return this.#start(id, () => this.#read(id, withHistory));
  }
  /** Each instrument's read under way and when it started. */
  readonly #inflight = new Map<string, { read: Promise<void>; since: number }>();

  /** The read of `id` under way, unless it has been under way past the stall limit: then it is counted as a failure and no longer waited for. */
  #held(id: string): { read: Promise<void>; since: number } | null {
    const held = this.#inflight.get(id);
    if (!held) return null;
    if (this.now() - held.since <= this.stallMs) return held;
    this.#inflight.delete(id);
    const venue = venueOf(id);
    this.#failure(venue, `${venue} open interest read under way for ${Math.round((this.now() - held.since) / 60_000)} min; no longer waited for`);
    return null;
  }

  /** Starts a read of `id`, held until it settles (a later read in its place is not let go by this one's end). */
  #start(id: string, work: () => Promise<void>): Promise<void> {
    const entry = { read: Promise.resolve(), since: this.now() };
    const read = work().finally(() => { if (this.#inflight.get(id) === entry) this.#inflight.delete(id); });
    entry.read = read;
    this.#inflight.set(id, entry);
    return read;
  }

  /** The history alone, when due, as one read of the instrument: after a read under way (waited for until its stall limit), never beside it. */
  #readHistoryDue(id: string): Promise<void> {
    const held = this.#held(id); if (held) return this.#waitHeld(held).then(() => this.#readHistoryDue(id));
    return this.#start(id, () => this.#historyStep(id));
  }

  /** Waits for a read under way until it settles (false) or reaches its stall limit (true: `#held` lets it go when next asked). */
  #waitHeld(held: { read: Promise<void>; since: number }): Promise<boolean> {
    const left = held.since + this.stallMs - this.now();
    if (left < 0) return Promise.resolve(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Unref'd: a wait never keeps a process alive by itself (the server's own sockets and timers do).
    const stalled = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), left + 1); timer.unref?.(); this.#waits.add(timer); });
    return Promise.race([held.read.then(() => false, () => false), stalled]).finally(() => { clearTimeout(timer); if (timer) this.#waits.delete(timer); });
  }

  /** One instrument's history, when it is due. */
  async #historyStep(id: string): Promise<void> {
    if (this.#closed) return;
    const venue = venueOf(id), listing = oiListingOf(id)!;
    const history = this.#history.get(id) ?? { done: false, tries: 0, nextAt: 0 };
    this.#history.set(id, history);
    if (history.done || this.now() < history.nextAt) return;
    const status = this.#statusOf(venue);
    try { await this.#readHistory(id, venue, listing); history.done = true; status.nextHistoryAt = null; }
    catch (error) {
      history.tries++; history.nextAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (history.tries - 1));
      status.nextHistoryAt = history.nextAt;
      this.#failure(venue, `${venue} open interest history read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** One instrument's history (when due and asked for) and its live reading. */
  async #read(id: string, withHistory: boolean): Promise<void> {
    if (this.#closed) return;
    if (withHistory) await this.#historyStep(id);
    if (this.#closed) return;
    const venue = venueOf(id), listing = oiListingOf(id)!, status = this.#statusOf(venue);
    // An inverse market's reading keeps its own USD too (`quote`): the coins alone move with the price. The venue's own clock, where the
    // answer carries one, is kept as the sample's source time, so the reading lands in the minute the exchange stamped, not the one it
    // arrived in.
    this.#lastAsked.set(id, this.now());
    try {
      const reading = await within(fetchOiReading(venue, this.get, listing), this.readDeadlineMs, `no answer in ${Math.round(this.readDeadlineMs / 1000)} s`);
      if (this.#closed) return;
      // An answer with no reading in it (an error body sent with 200, a field gone) is a failure as much as one that did not come.
      if (reading === null) { this.#failure(venue, `${venue} open interest sample had no reading`); return; }
      this.apply({ kind: 'openInterest', instrumentId: id, sourceTimestamp: reading.sourceTimestamp ?? null, receivedAt: this.now(), base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}), quality: 'sampled', source: `${venue}-openInterest` }, venue);
      status.lastSuccess = this.now(); status.failures = 0; status.lastError = null;
    } catch (error) { this.#failure(venue, `${venue} open interest sample failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  #statusOf(venue: string): OiVenueStatus {
    let status = this.#status.get(venue);
    if (!status) { status = { lastSuccess: null, failures: 0, lastError: null, nextHistoryAt: null, fast: false }; this.#status.set(venue, status); }
    return status;
  }

  /** Count a failure and log it at most every ten minutes, so a dead endpoint is visible without noise. */
  #failure(venue: string, message: string): void {
    const status = this.#statusOf(venue);
    status.failures++;
    status.lastError = message;
    if (this.now() - (this.#logged.get(venue) ?? -Infinity) >= OI_LOG_EVERY_MS) { this.#logged.set(venue, this.now()); this.#log(message + ` (${status.failures} in a row)`); }
  }

  /** The venue's history, oldest first, written to the store a few hundred rows a turn; throws when the venue could not be read. */
  async #readHistory(id: string, venue: string, listing: HistoryListing): Promise<void> {
    const now = this.now();
    const hourly = await fetchOiHistory(id, 3_600_000, now - HISTORY_HOURLY_MS, now - HISTORY_FINE_MS, this.get, listing);
    const fine = await fetchOiHistory(id, 300_000, now - HISTORY_FINE_MS, now, this.get, listing);
    const firstFine = fine.length ? Number(fine[0]!.observationTimestamp) : Infinity;
    const rows = [...hourly.filter(r => Number(r.observationTimestamp) < firstFine), ...fine];
    for (let i = 0; i < rows.length; i += ROWS_PER_TURN) {
      if (this.#closed) return;
      for (const r of rows.slice(i, i + ROWS_PER_TURN)) {
        // Each row a reading, stored a millisecond before its moment (`fetchOiHistory`), so it closes the minute that ends at it, as a live
        // reading does; stored at the moment itself it opened the next minute, and every bar built from it showed its start.
        // A store that refuses writes (over its budget: `recordOi` answers false) leaves the history to be read again later, not done.
        if (this.record({ kind: 'openInterest', instrumentId: id, sourceTimestamp: Number(r.sourceTimestamp), observationTimestamp: Number(r.observationTimestamp), receivedAt: now, base: Number(r.base), quality: 'sampled', source: `${venue}-openInterestHistory`, historySource: `${venue}-openInterestHistory` }) === false) throw new Error('the history store refused the rows');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  close(): void {
    this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; if (this.#fastTimer) clearInterval(this.#fastTimer); this.#fastTimer = null;
    for (const timer of this.#waits) clearTimeout(timer);
    this.#waits.clear();
  }
}
