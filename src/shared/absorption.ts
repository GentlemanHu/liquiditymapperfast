/**
 * Absorption: a lot of market volume on one side, at one price, inside a short window. Every one of those fills met a resting order at that
 * price, so the passive side there took all of it (passive buyers took the sells, passive sellers took the buys). The rule is the one the
 * order-flow tools use, and it marks what traded; it does not say what price did afterwards.
 *
 * The rule, per instrument and aggressor side:
 *  - Each fill, when it arrives, looks back over the fills of its side at its price whose time is at or after its own minus the window,
 *    itself included, and adds up their USD. Every fill in that set is credited the larger of what it had and that sum, so a fill keeps the
 *    largest window it ever belonged to (a fill early in a burst is credited when the later fills arrive).
 *  - A fill is marked when its credit reaches the threshold. The threshold is a fixed USD amount, or the mean plus k standard deviations of
 *    the window sums of the recent past: per price and side, a window opens at a fill and takes the fills up to its opening time plus the
 *    window, and the next fill after that opens the next one.
 *
 * Times are the exchange's, and fills are taken in their order: each instrument holds its fills for `LATE_MS` behind the newest one seen
 * (feeds deliver some a few milliseconds out of order; measured, at most 25 ms) and takes them sorted by time, at their own times. A fill
 * stamped earlier than what was already taken, inside a minute already settled, or more than two hours old (`ACCEPT_MS`), is left out: it is
 * history arriving late (some venues send their recent trades again when a feed connects, newest first), and counting it at another time
 * would sum trades that never met in one window. Fills arrive here after duplicates are removed (a replayed fill would otherwise add to
 * every sum). A sum does not depend on how a venue splits an order into fills, unlike a size floor on single prints.
 *
 * What is kept: the threshold is the page's to choose, and changing it re-judges the whole history, so the recorder keeps candidates rather
 * than marks. A candidate group is a run of fills at one price and side with gaps no longer than the window, with its largest credit at
 * least `GROUP_FLOOR_USD`; it carries, for each credit level its fills reached, the USD, the fill count and the time span of the fills
 * credited at least that much, so any threshold gives the marked part exactly. Each instrument keeps at most `GROUPS_PER_MINUTE` groups a
 * minute (the largest); when one is left out, that minute's floor rises to its credit, and a threshold under the floor is told it is not
 * complete there. Per minute, the window sums' count, mean and squared deviations are kept for the automatic threshold.
 */

import { binOf, parseProfile, type FootprintRow, type ProfileAnswer } from './footprint.ts';
import { AbsorptionArchive } from './absorption-archive.ts';
import { AbsorptionHour } from './absorption-hours.ts';
import { KeptCache } from './kept-cache.ts';

/** The window, in ms (the usual default of absorption indicators). */
export const ABSORPTION_WINDOW_MS = 10;
/** The smallest credit a group must reach to be kept. */
export const GROUP_FLOOR_USD = 25_000;
/** The most groups kept per instrument per minute: the largest. */
export const GROUPS_PER_MINUTE = 10;
/** How long, behind the newest fill an instrument has had, its fills are held so that ones delivered out of order are taken in order. Live feeds measured: at most 25 ms out of order. */
export const LATE_MS = 250;
/** The most instruments one history question may name (the page asks about every market it knows). */
export const MAX_ABSORPTION_INSTRUMENTS = 200;
const MINUTE = 60_000, HOUR = 3_600_000;
/** An instrument with nothing new for this long (by the receiving clock) has its runs and windows closed. */
const QUIET_MS = 500;
/** A minute is settled (written, and its floor final) once its instrument's clock, or the receiving clock for a quiet one, is this far past its end. */
const MINUTE_SETTLE_MS = 3_000;
/** Groups and minutes this recent are held in memory to answer the page, unless the recorder is told to hold more; older ones are asked of the store. */
const MEMORY_MS = 2 * 3_600_000;
/** What a store's `load` gives a recorder that starts (a page's database reads two hours when it opens): the rest of a longer memory is read back after (`hydrate`). */
const LOADED_MS = 2 * 3_600_000;
/** A fill stamped this far behind the receiving clock is history arriving late (see the module comment), however much memory holds. */
const ACCEPT_MS = 2 * 3_600_000;
/** How much is read back at a time: at the per-minute cap on 27 venues, about 4,000 groups (one read of them holds the worker some 70 ms). */
const HYDRATE_STEP_MS = 15 * 60_000;
/** How long the recorder keeps groups and minutes: nothing older can be asked for. */
export const ABSORPTION_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * The most room the packed stored hours take (shared/absorption-hours.ts), the least recently asked let go first: a week of BTC's fourteen
 * venues, 630,000 groups, packs into 24 MB (2026-10-20); the per-minute cap on 27 venues would need several times that.
 */
export const ABSORPTION_HOUR_BYTES = 64 * 1_048_576;
/** How long packing stored hours, or answering from them, holds the thread before it lets other work run (ms). */
const TURN_MS = 8;
/** How often packing ahead looks again whether the questions it waits for are answered (ms). */
const ASKING_WAIT_MS = 20;
/**
 * Let other work run: on a server right after what is waiting (a zero timer waits for the clock's next tick, a millisecond or, on Windows,
 * up to 15, which a cold week of a few hundred turns paid for in seconds).
 */
const immediate = (globalThis as { setImmediate?: (run: () => void) => unknown }).setImmediate;
const nextTurn = (): Promise<void> => new Promise<void>(resolve => { if (immediate) immediate(resolve); else setTimeout(resolve, 0); });

/** [credit, USD, fills, first time, last time]: the fills credited at least `credit`, credits falling from row to row (USD and fills add up). */
export type AbsorptionStep = [number, number, number, number, number];
/** A candidate group: instrument, aggressor side, price, its first fill's time, and its steps (the first holds its largest credit). */
export interface AbsorptionGroup { id: string; side: 'buy' | 'sell'; price: number; t0: number; steps: AbsorptionStep[] }
/** One minute of an instrument: the window sums opened in it (count, mean, squared deviations) and the credit under which groups may be missing. */
export interface AbsorptionMinute { id: string; t: number; n: number; mean: number; m2: number; floor: number }
/**
 * The page's question answered: groups (per instrument the largest first), each instrument's highest floor over the window, settled minutes,
 * and the instruments whose groups were cut at the limit (the smallest of them are left out).
 */
export interface AbsorptionAnswer { groups: AbsorptionGroup[]; floors: Record<string, number>; minutes: AbsorptionMinute[]; capped: string[] }

export interface AbsorptionStore {
  /** Groups and minutes since `since`, for what the recorder holds in memory. */
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] };
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void;
  /** Per instrument of `ids`: its groups whose first time is in [from, to) with a largest credit of at least its `mins` entry, the largest first, at most `limit` (the browser's store answers later). */
  query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number): AbsorptionGroup[] | Promise<AbsorptionGroup[]>;
  /** Minutes of `ids` in [from, to). */
  minutes(ids: readonly string[], from: number, to: number): AbsorptionMinute[] | Promise<AbsorptionMinute[]>;
  /**
   * [from, to) handed to `take` an hour of the store at a time (the per-minute cap bounds an hour), other work let run between hours: every
   * group of `ids` that began in the hour with a largest credit of at least its `mins` entry, none left out and in no order, and the minutes
   * whose floor is at least that, read together (`ids` null: every group and minute of every instrument, for a recorder reading its day
   * back). Nothing after `to` is read, and nothing is kept.
   */
  eachHour(ids: readonly string[] | null, mins: readonly number[], from: number, to: number, take: (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) => void): Promise<void>;
  /**
   * A store that reads back at once (the server's): every group and minute of `id` whose time is in the hour from `hour`, whatever its
   * credit, so the hour is packed once (shared/absorption-hours.ts) and every later threshold answered from it.
   */
  readHour?(id: string, hour: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] };
  /** The instruments it holds groups of (a server packs their recent hours after it starts). */
  instruments?(): string[];
  close(): void;
}

/** The hours of [from, to), cut at whole hours: how a store hands over a long window a part at a time. */
export function* hoursOf(from: number, to: number): Generator<{ from: number; to: number }> {
  for (let at = from; at < to;) { const end = Math.min(to, (Math.floor(at / HOUR) + 1) * HOUR); yield { from: at, to: end }; at = end; }
}

/** The largest credit of a group. */
export const peakOf = (g: AbsorptionGroup): number => g.steps[0]?.[0] ?? 0;
/**
 * The order a minute's groups are kept in, the largest first: by peak, and between equal peaks the earlier first fill, the lower price, then
 * the buy side. A total order, so the recorder and a page that received the same groups in another order keep the same ones.
 */
export const largerFirst = (a: AbsorptionGroup, b: AbsorptionGroup): number =>
  peakOf(b) - peakOf(a) || a.t0 - b.t0 || a.price - b.price || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1);

/** Chan's merge of two (count, mean, squared deviations) summaries. */
export function mergeMoments(a: { n: number; mean: number; m2: number }, b: { n: number; mean: number; m2: number }): { n: number; mean: number; m2: number } {
  if (!a.n) return { n: b.n, mean: b.mean, m2: b.m2 };
  if (!b.n) return { n: a.n, mean: a.mean, m2: a.m2 };
  const n = a.n + b.n, d = b.mean - a.mean;
  return { n, mean: a.mean + d * b.n / n, m2: a.m2 + b.m2 + d * d * a.n * b.n / n };
}

/** The automatic threshold from minutes (any order): mean + k standard deviations of every window sum in them; null when there are none. */
export function autoThreshold(minutes: Iterable<{ n: number; mean: number; m2: number }>, k: number): number | null {
  let acc = { n: 0, mean: 0, m2: 0 };
  for (const m of minutes) acc = mergeMoments(acc, m);
  if (!acc.n) return null;
  return acc.mean + k * Math.sqrt(acc.m2 / acc.n);
}

/** The steps of a set of fills (credit, USD, time), counting only credits of at least `floor`. */
export function stepsOf(fills: readonly { credit: number; usd: number; t: number }[], floor: number): AbsorptionStep[] {
  const kept = fills.filter(f => f.credit >= floor).sort((a, b) => b.credit - a.credit);
  const steps: AbsorptionStep[] = [];
  let usd = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < kept.length; i++) {
    const f = kept[i]!;
    usd += f.usd; n++; lo = Math.min(lo, f.t); hi = Math.max(hi, f.t);
    if (i === kept.length - 1 || kept[i + 1]!.credit !== f.credit) steps.push([f.credit, usd, n, lo, hi]);
  }
  return steps;
}

/** The marked part of a group at `threshold`: its USD, fills and time span, or null when none of it reaches the threshold. */
export function markedPart(g: AbsorptionGroup, threshold: number): { usd: number; fills: number; t0: number; t1: number; peak: number } | null {
  let found: AbsorptionStep | null = null;
  for (const step of g.steps) { if (step[0] >= threshold) found = step; else break; }
  return found ? { usd: found[1], fills: found[2], t0: found[3], t1: found[4], peak: peakOf(g) } : null;
}

/**
 * The absorption column's answer (measures/defs/absorption.ts): per instrument, rows of the step ([row price, market sells resting buyers took, market
 * buys resting sellers took], USD), each group's marked part counted once on the row of its price; and the instruments whose rows may be
 * short: `incomplete`, where a minute kept only its largest groups and one left out would have been marked; `cut`, where the source answered
 * only the largest groups (an older server).
 */
export interface AbsorptionProfileAnswer extends ProfileAnswer { incomplete: string[]; cut: string[] }

/**
 * Adds groups up into the absorption column's rows at each instrument's threshold (none: nothing of it is marked), the groups that began in
 * [from, to) only, each once, and takes the minutes' floors to say where the rows may be short.
 *
 * A minute's floor is the base floor, or raised to the peak of a group it left out. A floor over the threshold left out a group that was
 * marked. A floor equal to it may have (`markedPart` marks a peak equal to the threshold), but then every group the minute kept reached it
 * too, so the minute is called short only when it kept `perMinute` groups at or over the threshold. Only a minute that kept exactly that many
 * and left nothing out, at a threshold equal to the base floor, is called short when it is not.
 */
export class AbsorptionProfile {
  readonly #by = new Map<string, Map<number, [number, number]>>();
  readonly #seen = new Set<string>();
  /** Groups at or over the threshold, per instrument and minute number. */
  readonly #kept = new Map<string, Map<number, number>>();
  /** Per instrument, the minutes whose floor equals the threshold (null: one of them, which is not known). */
  readonly #ties = new Map<string, Set<number> | null>();
  readonly #short = new Set<string>();
  readonly #thresholds: ReadonlyMap<string, number | null>;

  constructor(thresholds: ReadonlyMap<string, number | null>, readonly from: number, readonly to: number, readonly step: number, readonly perMinute = GROUPS_PER_MINUTE) {
    this.#thresholds = thresholds;
  }

  /**
   * A group, its marked part counted. `unique`: it cannot be another's copy (a store keeps a group once, and answers apart from memory), so it
   * is not looked up; otherwise a group found again (trades sent again after a restart) is counted once.
   */
  add(g: AbsorptionGroup, unique = false): void {
    const threshold = this.#thresholds.get(g.id);
    if (threshold === null || threshold === undefined || g.t0 < this.from || g.t0 >= this.to) return;
    const part = markedPart(g, threshold);
    if (!part) return;
    if (!unique) {
      const key = `${g.id}|${g.side}|${g.price}|${g.t0}`;
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
    }
    this.marked(g.id, g.side, g.price, g.t0, part.usd);
  }

  /** A group judged already, by its marked USD (the archive's, which holds each group once). */
  marked(id: string, side: 'buy' | 'sell', price: number, t0: number, usd: number): void {
    let bins = this.#by.get(id); if (!bins) { bins = new Map(); this.#by.set(id, bins); }
    const bin = binOf(price, this.step), cell = bins.get(bin);
    if (cell) cell[side === 'sell' ? 0 : 1] += usd; else bins.set(bin, side === 'sell' ? [usd, 0] : [0, usd]);
    let kept = this.#kept.get(id); if (!kept) { kept = new Map(); this.#kept.set(id, kept); }
    const minute = Math.floor(t0 / MINUTE);
    kept.set(minute, (kept.get(minute) ?? 0) + 1);
  }

  /**
   * One whole hour of `id` inside the window, from its packed groups (shared/absorption-hours.ts): each cell's marked USD on the row of its
   * price, and the hour's floors judged as `floor` judges them, a minute at the threshold with the number of its groups that reach it.
   */
  hour(id: string, h: AbsorptionHour): void {
    const threshold = this.#thresholds.get(id);
    if (threshold === null || threshold === undefined) return;
    if (h.topFloor > threshold) this.#short.add(id);
    else if (h.topFloor === threshold) {
      for (let m = 0; m < h.floors.length; m++) {
        if (h.floors[m] !== threshold) continue;
        const t = h.hour + m * MINUTE, n = h.reaching(m, threshold);
        this.floor(id, t, threshold);
        if (!n) continue;
        let kept = this.#kept.get(id); if (!kept) { kept = new Map(); this.#kept.set(id, kept); }
        kept.set(Math.floor(t / MINUTE), (kept.get(Math.floor(t / MINUTE)) ?? 0) + n);
      }
    }
    const { price, side, first, credit, sum } = h, step = this.step;
    let bins = this.#by.get(id), bin = Number.NaN, sell = 0, buy = 0;
    const put = (): void => {
      if (!bins) { bins = new Map(); this.#by.set(id, bins); }
      const cell = bins.get(bin);
      if (cell) { cell[0] += sell; cell[1] += buy; } else bins.set(bin, [sell, buy]);
    };
    // Cells come by price, so neighbours on one row are added up here and the row is looked up once.
    for (let c = 0; c < price.length; c++) {
      let lo = first[c]!, hi = first[c + 1]!;
      if (!(credit[lo]! >= threshold)) continue;
      // The increments that reach the threshold come first: find where they end.
      for (lo++; lo < hi;) { const mid = (lo + hi) >>> 1; if (credit[mid]! >= threshold) lo = mid + 1; else hi = mid; }
      const row = binOf(price[c]!, step);
      if (row !== bin) { if (!Number.isNaN(bin)) put(); bin = row; sell = 0; buy = 0; }
      if (side[c]) sell += sum[lo - 1]!; else buy += sum[lo - 1]!;
    }
    if (!Number.isNaN(bin)) put();
  }

  /** The floor of `id`'s minute starting at `t` (null: the highest of the window's, its minute not known). */
  floor(id: string, t: number | null, floor: number): void {
    const threshold = this.#thresholds.get(id);
    if (threshold === null || threshold === undefined) return;
    if (floor > threshold) { this.#short.add(id); return; }
    if (floor < threshold) return;
    const ties = this.#ties.get(id);
    if (t === null || ties === null) { this.#ties.set(id, null); return; }
    if (ties) ties.add(Math.floor(t / MINUTE)); else this.#ties.set(id, new Set([Math.floor(t / MINUTE)]));
  }

  answer(cut: readonly string[] = []): AbsorptionProfileAnswer {
    const short = new Set(this.#short);
    for (const [id, minutes] of this.#ties) {
      const kept = this.#kept.get(id);
      if (short.has(id) || !kept) continue;
      for (const [minute, n] of kept) if (n >= this.perMinute && (!minutes || minutes.has(minute))) { short.add(id); break; }
    }
    const instruments = [];
    for (const id of this.#thresholds.keys()) {
      const bins = this.#by.get(id);
      if (!bins) continue;
      const rows = [...bins].sort((a, b) => a[0] - b[0]).map(([bin, [a, b]]): FootprintRow => [bin * this.step, a, b]);
      instruments.push({ id, step: this.step, minutes: 0, first: null, earliest: null, rows });
    }
    return { from: this.from, to: this.to, instruments, incomplete: [...short], cut: [...cut] };
  }
}

interface Fill { t: number; usd: number; credit: number }
interface Run { side: 'buy' | 'sell'; price: number; fills: Fill[]; last: number }
interface Window { start: number; sum: number }
interface MinuteState { n: number; mean: number; m2: number; floor: number; groups: AbsorptionGroup[] }

interface Held { t: number; price: number; usd: number; side: 'buy' | 'sell' }

class InstrumentState {
  /** The newest time of a fill seen. */
  clock = -Infinity;
  /** The time of the last fill taken: everything is taken in time order, so a fill earlier than this can no longer be. */
  done = -Infinity;
  lastSeenAt = 0;
  /** Fills not taken yet, in time order (ties in the order they came). */
  readonly held: Held[] = [];
  /** The end of the last minute settled: a fill stamped before it is left out (its row is written and final). */
  settledUntil = -Infinity;
  /** Fills left out for being stamped before what was taken, inside a settled minute, or more than two hours old. */
  late = 0;
  /** The fills of the last window, per side and price ("buy|83000.5"): only these can still be in a window. */
  readonly recent = new Map<string, Fill[]>();
  /** The open runs and windows, per side and price. */
  readonly runs = new Map<string, Run>();
  readonly windows = new Map<string, Window>();
  /** Minutes not settled yet. */
  readonly minutes = new Map<number, MinuteState>();
}

/** Detects absorption candidates on every fill and keeps them with the per-minute window statistics (see the module comment). */
export class AbsorptionRecorder {
  readonly #instruments = new Map<string, InstrumentState>();
  #freshGroups: AbsorptionGroup[] = [];
  #freshMinutes: AbsorptionMinute[] = [];
  /**
   * The settled groups and minutes from `#memoryFrom` on, packed (the store holds everything settled; memory answers the recent part). The
   * groups of a minute not settled yet are in its instrument's `minutes`.
   */
  readonly #archive = new AbsorptionArchive();
  #memoryFrom: number;
  /** A fill stamped before this is history arriving late (`ACCEPT_MS`): memory reaching further back admits none of it. */
  #acceptFrom: number;
  #unsavedGroups: AbsorptionGroup[] = [];
  #unsavedMinutes: AbsorptionMinute[] = [];
  readonly #store: AbsorptionStore | null;
  #hydrating = false;
  #warming = false;
  /** Questions reading the store now (`profile`): packing ahead waits for them. */
  #asking = 0;
  #closed = false;
  /**
   * The stored hours packed for the absorption column, per instrument and hour (`${id}|${hour}`), when the store reads an hour back and holds
   * more than memory (the server's; the page's memory holds all it keeps). Only whole hours before memory and inside the retention: see `profile`.
   */
  readonly #hours: KeptCache<AbsorptionHour> | null;
  /** No hour before this is packed: the store lets go of older groups as it saves, so an hour across this line is read as it is. */
  #packFrom: number;

  readonly windowMs: number;
  readonly #retentionMs: number;
  readonly #memoryMs: number;
  readonly #perMinute: number;
  readonly #floor: number;
  readonly #hourBytes: number;

  /**
   * `memoryMs`: how much memory holds to answer the page; a page holds its whole day (the store's `load` gives the last two hours at start, and
   * `hydrate` reads the rest back), a server two hours. `hourBytes`: the room for the packed stored hours.
   */
  constructor(store: AbsorptionStore | null = null, private now: () => number = Date.now, { retentionMs = ABSORPTION_RETENTION_MS, windowMs = ABSORPTION_WINDOW_MS, perMinute = GROUPS_PER_MINUTE, floorUsd = GROUP_FLOOR_USD, memoryMs = MEMORY_MS, hourBytes = ABSORPTION_HOUR_BYTES }: { retentionMs?: number; windowMs?: number; perMinute?: number; floorUsd?: number; memoryMs?: number; hourBytes?: number } = {}) {
    this.#store = store; this.windowMs = windowMs; this.#retentionMs = retentionMs; this.#memoryMs = memoryMs; this.#perMinute = perMinute; this.#floor = floorUsd; this.#hourBytes = hourBytes;
    this.#memoryFrom = store ? now() - Math.min(memoryMs, LOADED_MS) : -Infinity;
    this.#acceptFrom = store ? now() - ACCEPT_MS : -Infinity;
    this.#hours = store && typeof store.readHour === 'function' && memoryMs < retentionMs ? new KeptCache(hourBytes, now) : null;
    this.#packFrom = now() - retentionMs;
    if (store) {
      const { groups, minutes } = store.load(this.#memoryFrom), loaded = new Set<string>();
      // Each group once (memory holds a group once from here on: a fill in a minute already written is left out, so nothing found live repeats it).
      for (const g of groups) {
        const key = `${g.id}|${g.side}|${g.price}|${g.t0}`;
        if (g.t0 >= this.#memoryFrom && !loaded.has(key)) { loaded.add(key); this.#archive.addGroup(g); }
      }
      // Where settling had got to: a fill a venue sends again for a settled minute must not start a group a second time there.
      for (const m of minutes) { if (m.t >= this.#memoryFrom) this.#archive.addMinute(m); const s = this.#state(m.id); s.settledUntil = Math.max(s.settledUntil, m.t + MINUTE); }
    }
  }

  /** Where memory answers from (earlier is asked of the store). */
  get memoryFrom(): number { return this.#memoryFrom; }
  /** The settled groups memory holds, and the bytes they and the minutes take. */
  get held(): { groups: number; bytes: number } { return { groups: this.#archive.size, bytes: this.#archive.bytes }; }
  /** The stored hours held packed (one per instrument and hour), and the room they take as the cache counts it. */
  get packed(): { hours: number; bytes: number } { return { hours: this.#hours?.size ?? 0, bytes: this.#hours?.weight ?? 0 }; }

  #state(id: string): InstrumentState { let s = this.#instruments.get(id); if (!s) { s = new InstrumentState(); this.#instruments.set(id, s); } return s; }

  /** One fill, after duplicates were removed. It is held until nothing earlier can still come, then taken in time order. */
  add(id: string, t: number, price: number, usd: number, side: 'buy' | 'sell'): void {
    if (!id || !(price > 0) || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) return;
    const s = this.#state(id);
    // Also hours old: the store holds that time, and a venue sending hours-old trades again must not add to it.
    if (t < s.done || t < s.settledUntil || t < this.#acceptFrom) { s.late++; return; }
    s.lastSeenAt = this.now(); s.clock = Math.max(s.clock, t);
    let at = s.held.length; while (at > 0 && s.held[at - 1]!.t > t) at--;
    s.held.splice(at, 0, { t, price, usd, side });
    this.#release(id, s, s.clock - LATE_MS);
  }

  /** Take the held fills stamped up to `limit`, in time order. */
  #release(id: string, s: InstrumentState, limit: number): void {
    let n = 0; while (n < s.held.length && s.held[n]!.t <= limit) n++;
    if (!n) return;
    for (const f of s.held.splice(0, n)) this.#take(id, s, f.t, f.price, f.usd, f.side);
  }

  /** One fill, in time order: its window, its run and the window sums. */
  #take(id: string, s: InstrumentState, at: number, price: number, usd: number, side: 'buy' | 'sell'): void {
    s.done = at;
    const W = this.windowMs, key = `${side}|${price}`;
    // Runs and windows this fill's time has left behind are complete.
    this.#closePast(id, s, at);
    // The window ending at this fill: same side and price, time at or after its own minus the window, itself included.
    let recent = s.recent.get(key); if (!recent) { recent = []; s.recent.set(key, recent); }
    const fill: Fill = { t: at, usd, credit: 0 };
    recent.push(fill);
    let sum = 0, from = recent.length;
    for (let i = recent.length - 1; i >= 0; i--) { if (recent[i]!.t < at - W) break; sum += recent[i]!.usd; from = i; }
    for (let i = from; i < recent.length; i++) if (recent[i]!.credit < sum) recent[i]!.credit = sum;
    if (from > 0) recent.splice(0, from);   // the clock only moves on: older fills can never be in a window again
    // The run of fills at this price and side (a gap longer than the window has already closed the one before).
    let run = s.runs.get(key);
    if (!run) { run = { side, price, fills: [], last: at }; s.runs.set(key, run); }
    run.fills.push(fill); run.last = at;
    // The window sums for the automatic threshold: start-anchored, the next fill after the window opens the next one.
    const win = s.windows.get(key);
    if (win && at <= win.start + W) win.sum += usd;
    else { if (win) this.#closeWindow(s, win); s.windows.set(key, { start: at, sum: usd }); }
  }

  /**
   * Take what can be taken, close what is complete everywhere and settle finished minutes; call it now and then (the engine does, every
   * pass). With `final` (the process or the page is going away) everything is taken and closed and every minute settles, the one still
   * open too, so what was found in it is saved; a restart then leaves that minute as it was written.
   */
  step(final = false): void {
    const now = this.now();
    for (const [id, s] of this.#instruments) {
      const quiet = final || now - s.lastSeenAt >= QUIET_MS;
      // A quiet instrument has nothing earlier still to come: all it holds is taken.
      this.#release(id, s, quiet ? Infinity : s.clock - LATE_MS);
      this.#closePast(id, s, quiet ? Infinity : s.done);
      // Price levels nobody has traded at for longer than the window hold nothing that can be in a window again.
      for (const [key, recent] of s.recent) if (!recent.length || recent[recent.length - 1]!.t < s.done - this.windowMs) s.recent.delete(key);
      // A quiet instrument's clock goes on from its last fill by the time that has passed here: the exchange's clock, not this computer's,
      // which may be seconds off (settling on it could close a minute the exchange is still in).
      this.#settleMinutes(id, s, final ? Infinity : quiet ? s.done + (now - s.lastSeenAt) : s.done);
    }
  }

  /** Close the runs and windows that no fill at or after `clock` can join. */
  #closePast(id: string, s: InstrumentState, clock: number): void {
    const W = this.windowMs;
    for (const [key, run] of s.runs) if (run.last < clock - W) { this.#closeRun(id, s, run); s.runs.delete(key); }
    for (const [key, win] of s.windows) if (win.start + W < clock) { this.#closeWindow(s, win); s.windows.delete(key); }
  }

  /** Settle the minutes that ended a while before `clock` and in which no open run or window began: their floor and groups are final. */
  #settleMinutes(id: string, s: InstrumentState, clock: number): void {
    let openFrom = Infinity;
    for (const run of s.runs.values()) openFrom = Math.min(openFrom, run.fills[0]!.t);
    for (const win of s.windows.values()) openFrom = Math.min(openFrom, win.start);
    for (const [t, m] of s.minutes) {
      if (t + MINUTE > clock - MINUTE_SETTLE_MS || t + MINUTE > openFrom) continue;
      const row: AbsorptionMinute = { id, t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor };
      // The first row of a minute stands: after a restart, trades a venue sends again would otherwise replace a whole minute with a part.
      if (this.#archive.addMinute(row)) { this.#freshMinutes.push(row); this.#unsavedMinutes.push(row); }
      // Its groups are final now: packed into memory, and written.
      for (const g of m.groups) this.#archive.addGroup(g);
      this.#unsavedGroups.push(...m.groups);
      s.minutes.delete(t); s.settledUntil = Math.max(s.settledUntil, t + MINUTE);
    }
  }

  #minute(s: InstrumentState, t: number): MinuteState {
    const key = Math.floor(t / MINUTE) * MINUTE;
    let m = s.minutes.get(key);
    if (!m) { m = { n: 0, mean: 0, m2: 0, floor: this.#floor, groups: [] }; s.minutes.set(key, m); }
    return m;
  }

  #closeWindow(s: InstrumentState, win: Window): void {
    const m = this.#minute(s, win.start), merged = mergeMoments(m, { n: 1, mean: win.sum, m2: 0 });
    m.n = merged.n; m.mean = merged.mean; m.m2 = merged.m2;
  }

  #closeRun(id: string, s: InstrumentState, run: Run): void {
    let peak = 0; for (const f of run.fills) if (f.credit > peak) peak = f.credit;
    if (peak < this.#floor) return;
    const t0 = run.fills[0]!.t, m = this.#minute(s, t0);
    const group: AbsorptionGroup = { id, side: run.side, price: run.price, t0, steps: stepsOf(run.fills, this.#floor) };
    m.groups.push(group);
    if (m.groups.length > this.#perMinute) {
      // Only the largest are kept; the credit of the one left out is the floor under which this minute may be missing groups.
      m.groups.sort(largerFirst);
      const left = m.groups.pop()!;
      m.floor = Math.max(m.floor, peakOf(left));
      if (left === group) return;
    }
    this.#freshGroups.push(group);
  }

  /** Fills of `id` left out as history arriving late (see the module comment). */
  lateFills(id: string): number { return this.#instruments.get(id)?.late ?? 0; }

  /** Groups found and minutes settled since the last call (for the live stream). */
  takeFresh(): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    const out = { groups: this.#freshGroups, minutes: this.#freshMinutes };
    this.#freshGroups = []; this.#freshMinutes = [];
    return out;
  }

  /** Write what is settled, and let go of memory older than what memory answers for. */
  flush(): void {
    const now = this.now();
    if (this.#store) {
      this.#acceptFrom = Math.max(this.#acceptFrom, now - ACCEPT_MS);
      const memoryFrom = now - this.#memoryMs;
      if (memoryFrom > this.#memoryFrom) { this.#memoryFrom = memoryFrom; this.#archive.expire(memoryFrom); }
    } else this.#archive.expire(now - this.#retentionMs);   // without a store, memory is everything: keep the retention
    // Hours some minutes past their end take no more groups (a quiet venue's last minute settles within seconds).
    this.#archive.compact(now - 10 * MINUTE);
    if (this.#hours) {
      // A packed hour a group is written to now is packed again when next asked: a minute that settles late (a venue sending trades again
      // after a restart can start a group two hours back) may write to an hour memory no longer answers for.
      for (const g of this.#unsavedGroups) this.#hours.delete(`${g.id}|${Math.floor(g.t0 / HOUR) * HOUR}`);
      // The store lets go of older groups as it saves: no packed hour may still hold them.
      this.#packFrom = Math.max(this.#packFrom, now - this.#retentionMs);
      const packFrom = this.#packFrom;
      this.#hours.deleteWhere((_, h) => h.hour < packFrom);
    }
    if (this.#store && (this.#unsavedGroups.length || this.#unsavedMinutes.length)) this.#store.save(this.#unsavedGroups, this.#unsavedMinutes, now - this.#retentionMs);
    this.#unsavedGroups = []; this.#unsavedMinutes = [];
  }
  close(): void { this.#closed = true; this.step(true); this.flush(); this.#store?.close(); }

  /**
   * Read back, newest first, what memory is to hold and only the store has (a page opens with two hours and holds its day): a quarter of an
   * hour of groups and minutes at a time, each installed whole before memory answers for it, so a question asked meanwhile is answered by
   * memory and the store together as before. It stops when the store fails (a later call goes on from where it got to) or the recorder
   * closes, and admits no fill: what is history arriving late stays so (`#acceptFrom`).
   */
  async hydrate(): Promise<void> {
    const store = this.#store;
    if (!store || this.#hydrating || this.#closed) return;
    this.#hydrating = true;
    const started = performance.now(), before = this.#memoryFrom;
    try {
      for (;;) {
        const end = this.#memoryFrom, cutoff = this.now() - this.#memoryMs;
        if (this.#closed || !(end > cutoff)) break;
        const start = Math.max(cutoff, Math.ceil(end / HYDRATE_STEP_MS) * HYDRATE_STEP_MS - HYDRATE_STEP_MS);
        const groups: AbsorptionGroup[] = [], minutes: AbsorptionMinute[] = [];
        await store.eachHour(null, [], start, end, (g, m) => { for (const x of g) groups.push(x); for (const x of m) minutes.push(x); });
        // Closed meanwhile, or memory moved (it let go of its oldest part): nothing of this read is installed.
        if (this.#closed || this.#memoryFrom !== end) continue;
        const from = Math.max(start, this.now() - this.#memoryMs);
        for (const g of groups) if (g.t0 >= from && g.t0 < end) this.#archive.addGroup(g);
        for (const m of minutes) if (m.t >= from && m.t < end) { this.#archive.addMinute(m); const s = this.#state(m.id); s.settledUntil = Math.max(s.settledUntil, m.t + MINUTE); }
        this.#memoryFrom = from;
      }
      if (this.#memoryFrom < before) {
        this.#archive.compact(this.now() - 10 * MINUTE);
        const { groups, bytes } = this.held;
        console.info(`absorption: ${groups} groups held in memory (${(bytes / 1_048_576).toFixed(1)} MB) from ${new Date(this.#memoryFrom).toISOString()}, read back in ${Math.round(performance.now() - started)} ms`);
      }
    } catch (error) {
      console.warn('absorption: reading the day back stopped; the recordings answer the rest:', error);
    } finally { this.#hydrating = false; }
  }

  /**
   * The page's question for a window [from, to): per instrument, the groups that started in it with a largest credit of at least its
   * `mins` entry (its threshold), the largest first and at most `limit` of them; each instrument's highest floor over the window; and the
   * settled minutes of [since, now] for the automatic threshold. Memory answers from `#memoryFrom` on, the store before that.
   */
  async query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> {
    const min = new Map(ids.map((id, i) => [id, mins[i] ?? Infinity])), memoryFrom = this.#memoryFrom, split = Math.max(from, memoryFrom);
    // Memory's part is taken before anything is awaited: memory may let go of its oldest part while the store reads, and the store is asked
    // only up to where memory answered from.
    const recent: AbsorptionGroup[] = [], open: [string, number][] = [];
    this.#archive.eachGroup(split, to, min, g => recent.push(g));
    for (const [id, s] of this.#instruments) {
      if (!min.has(id)) continue;
      for (const [t, m] of s.minutes) {
        if (t >= from && t < to) open.push([id, m.floor]);
        for (const g of m.groups) if (g.t0 >= split && g.t0 < to && peakOf(g) >= min.get(id)!) recent.push(g);
      }
    }
    const recentFloors = this.#memoryMinutesOf(ids, from, to, memoryFrom), recentMinutes = this.#memoryMinutesOf(ids, since, Infinity, memoryFrom);
    const found: AbsorptionGroup[] = [];
    // One more than the limit, so an instrument with exactly `limit` groups is not reported as cut.
    if (this.#store && from < memoryFrom) for (const g of await this.#store.query(ids, mins, from, Math.min(to, memoryFrom), limit + 1)) found.push(g);
    for (const g of recent) found.push(g);
    // A group found again (trades sent again after a restart) is one group: the store keeps one row, and memory may hold both.
    const byId = new Map<string, AbsorptionGroup[]>(), keys = new Set<string>();
    for (const g of found) {
      const key = `${g.id}|${g.side}|${g.price}|${g.t0}`; if (keys.has(key)) continue; keys.add(key);
      let list = byId.get(g.id); if (!list) { list = []; byId.set(g.id, list); } list.push(g);
    }
    const groups: AbsorptionGroup[] = [], capped: string[] = [];
    for (const [id, list] of byId) { list.sort((a, b) => peakOf(b) - peakOf(a)); if (list.length > limit) capped.push(id); groups.push(...list.slice(0, limit)); }
    const floors: Record<string, number> = {};
    const raise = (id: string, floor: number): void => { floors[id] = Math.max(floors[id] ?? 0, floor); };
    for (const m of await this.#storedMinutesOf(ids, from, to, memoryFrom)) raise(m.id, m.floor);
    for (const m of recentFloors) raise(m.id, m.floor);
    for (const [id, floor] of open) raise(id, floor);
    // Pushed one by one: a week of stored minutes over many instruments spread into one call overflowed the stack (the first questions
    // after a restart, when memory holds nothing yet; Karl, 2026-10-15).
    const minutes: AbsorptionMinute[] = [];
    for (const m of await this.#storedMinutesOf(ids, since, Infinity, memoryFrom)) minutes.push(m);
    for (const m of recentMinutes) minutes.push(m);
    return { groups, floors, minutes: minutes.sort((a, b) => a.t - b.t), capped };
  }

  /**
   * The absorption column's question (`AbsorptionProfile`): the marked part of every group of `ids` that began in [from, to), at its
   * instrument's `thresholds` entry, by price on rows of `step`, none left out; and where a minute's floor may have left marked groups out.
   * Nothing after the window is read: the column wants no statistics. The store hands its part over an hour at a time and keeps nothing.
   */
  async profile(ids: readonly string[], thresholds: readonly (number | null)[], from: number, to: number, step: number): Promise<AbsorptionProfileAnswer> {
    const judged = new Map(ids.map((id, i) => [id, thresholds[i] ?? null])), memoryFrom = this.#memoryFrom, split = Math.min(to, Math.max(from, memoryFrom));
    const out = new AbsorptionProfile(judged, from, to, step, this.#perMinute);
    // Memory's part first, before anything is awaited (as in `query`): the settled groups judged where they are packed, each held once, then
    // the groups of the minutes still open.
    this.#archive.eachMarked(split, to, judged, (id, side, price, t0, usd) => out.marked(id, side, price, t0, usd));
    for (const m of this.#memoryMinutesOf(ids, from, to, memoryFrom)) out.floor(m.id, m.t, m.floor);
    for (const [id, s] of this.#instruments) {
      if (!judged.has(id)) continue;
      for (const [t, m] of s.minutes) { if (t >= from && t < to) out.floor(id, t, m.floor); for (const g of m.groups) if (g.t0 >= split) out.add(g); }
    }
    // Each instrument once: the store's part is not looked up group by group.
    const asked = [...new Set(ids.filter(id => typeof judged.get(id) === 'number'))];
    if (this.#store && from < split && asked.length) {
      // A store keeps a group once, and answers only before where memory answered from.
      const store = this.#store, mins = asked.map(id => judged.get(id)!);
      const take = (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]): void => {
        for (const g of groups) out.add(g, true);
        for (const m of minutes) out.floor(m.id, m.t, m.floor);
      };
      if (!this.#hours) await store.eachHour(asked, mins, from, split, take);
      else {
        // Packing ahead (`warm`) waits while a question reads.
        this.#asking++;
        try {
          // Whole stored hours from their packed groups; the part hours at either end, and an hour the retention cuts, read as they are.
          const whole: number[] = [];
          for (const part of hoursOf(from, split)) {
            if (part.to - part.from === HOUR && part.from >= this.#packFrom) whole.push(part.from);
            else await store.eachHour(asked, mins, part.from, part.to, take);
          }
          let turn = performance.now();
          for (const hour of whole) for (const id of asked) {
            out.hour(id, this.#packed(id, hour));
            if (performance.now() - turn > TURN_MS) { await nextTurn(); turn = performance.now(); }
          }
        } finally { this.#asking--; }
      }
    }
    return out.answer();
  }

  /**
   * `id`'s stored hour from `hour`, packed: the one held, or read and packed now and held when there is room (a question larger than the room
   * is answered all the same, from what it packed). Only an hour before memory and inside the retention is held, so nothing held changes but
   * by a group written to it (`flush`).
   */
  #packed(id: string, hour: number): AbsorptionHour {
    const key = `${id}|${hour}`, held = this.#hours!.get(key);
    if (held) return held;
    const { groups, minutes } = this.#store!.readHour!(id, hour), packed = new AbsorptionHour(hour, groups, minutes);
    if (hour >= this.#packFrom && hour + HOUR <= this.#memoryFrom) this.#hours!.set(key, packed, packed.bytes);
    return packed;
  }

  /**
   * Pack the stored hours before the page asks (a server, a few seconds after it starts), so the first question is answered from them: newest
   * first, every instrument the store has groups of, the last day and on back through the retention while they take less than half their
   * room (the rest is the questions'). A few at a time with other work let run between, stopping when the recorder closes.
   */
  async warm(): Promise<void> {
    const store = this.#store, hours = this.#hours;
    if (!store?.instruments || !hours || this.#warming || this.#closed) return;
    this.#warming = true;
    const started = performance.now();
    let count = 0, turn = started;
    try {
      const ids = store.instruments();
      for (let hour = Math.floor(this.#memoryFrom / HOUR) * HOUR - HOUR; hour >= this.#packFrom; hour -= HOUR) {
        for (const id of ids) {
          // A question reading meanwhile goes first: it packs what it needs itself.
          while (this.#asking && !this.#closed) { await new Promise<void>(resolve => setTimeout(resolve, ASKING_WAIT_MS)); turn = performance.now(); }
          if (this.#closed || hours.weight >= this.#hourBytes / 2) return;
          if (hours.has(`${id}|${hour}`) || hour + HOUR > this.#memoryFrom) continue;
          this.#packed(id, hour); count++;
          if (performance.now() - turn > TURN_MS) { await nextTurn(); turn = performance.now(); }
        }
      }
    } catch (error) {
      console.warn('absorption: packing the stored hours stopped; questions pack what they need:', error);
    } finally {
      this.#warming = false;
      if (count) console.info(`absorption: ${count} stored hours packed (${(hours.weight / 1_048_576).toFixed(1)} MB) in ${Math.round(performance.now() - started)} ms`);
    }
  }

  /** The settled minutes memory holds of `ids` in [from, to), from `memoryFrom` on. */
  #memoryMinutesOf(ids: readonly string[], from: number, to: number, memoryFrom: number): AbsorptionMinute[] {
    const out: AbsorptionMinute[] = [];
    this.#archive.eachMinute(ids, Math.max(from, memoryFrom), to, m => out.push(m));
    return out;
  }

  /** The stored minutes of `ids` in [from, to) before `memoryFrom` (memory answers from there on). */
  async #storedMinutesOf(ids: readonly string[], from: number, to: number, memoryFrom: number): Promise<AbsorptionMinute[]> {
    return this.#store && from < memoryFrom ? await this.#store.minutes(ids, from, Math.min(to, memoryFrom)) : [];
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One group as it comes over the wire or out of storage, checked field by field: the group, or null when it is anything else. */
export function parseGroup(value: unknown): AbsorptionGroup | null {
  const g = value as Partial<AbsorptionGroup> | null;
  if (!g || typeof g.id !== 'string' || !g.id || (g.side !== 'buy' && g.side !== 'sell') || !finite(g.price) || !(g.price > 0) || !finite(g.t0) || !Array.isArray(g.steps) || !g.steps.length) return null;
  let last = Infinity;
  for (const s of g.steps as unknown[]) {
    if (!Array.isArray(s) || s.length !== 5 || !s.every(finite)) return null;
    const [credit, usd, fills, t0, t1] = s as number[];
    if (!(credit! > 0) || credit! > last || !(usd! > 0) || !Number.isInteger(fills) || fills! < 1 || t1! < t0!) return null;
    last = credit!;
  }
  return { id: g.id, side: g.side, price: g.price, t0: g.t0, steps: (g.steps as number[][]).map(s => [s[0]!, s[1]!, s[2]!, s[3]!, s[4]!] as AbsorptionStep) };
}

/** One minute, checked field by field: the minute, or null. */
export function parseMinute(value: unknown): AbsorptionMinute | null {
  const m = value as Partial<AbsorptionMinute> | null;
  if (!m || typeof m.id !== 'string' || !m.id || !finite(m.t) || !finite(m.n) || !Number.isInteger(m.n) || m.n < 0 || !finite(m.mean) || !finite(m.m2) || m.m2 < 0 || !finite(m.floor) || m.floor < 0) return null;
  return { id: m.id, t: m.t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor };
}

/** A history answer checked against the instruments asked for: groups and minutes of other instruments, or broken ones, are refused whole. */
export function parseAbsorptionAnswer(value: unknown, ids: readonly string[]): AbsorptionAnswer | null {
  const body = value as { groups?: unknown; floors?: unknown; minutes?: unknown } | null;
  if (!body || !Array.isArray(body.groups) || !Array.isArray(body.minutes) || !body.floors || typeof body.floors !== 'object') return null;
  const asked = new Set(ids), groups: AbsorptionGroup[] = [], minutes: AbsorptionMinute[] = [], floors: Record<string, number> = {};
  const listed = (body as { capped?: unknown }).capped;
  const capped = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && asked.has(id)) : [];
  for (const item of body.groups as unknown[]) { const g = parseGroup(item); if (!g || !asked.has(g.id)) return null; groups.push(g); }
  for (const item of body.minutes as unknown[]) { const m = parseMinute(item); if (!m || !asked.has(m.id)) return null; minutes.push(m); }
  for (const [id, floor] of Object.entries(body.floors as Record<string, unknown>)) { if (!asked.has(id) || !finite(floor) || floor < 0) return null; floors[id] = floor; }
  return { groups, floors, minutes, capped };
}

/** An absorption column answer checked against the instruments asked for: the answer, or null when it is anything else. */
export function parseAbsorptionProfile(value: unknown, ids: readonly string[]): AbsorptionProfileAnswer | null {
  const answer = parseProfile(value, ids), body = value as { incomplete?: unknown; cut?: unknown } | null;
  const idList = (list: unknown): string[] | null => Array.isArray(list) && list.every(id => typeof id === 'string' && ids.includes(id)) ? list as string[] : null;
  const incomplete = idList(body?.incomplete), cut = idList(body?.cut);
  if (!answer || !incomplete || !cut) return null;
  return { ...answer, incomplete, cut };
}

/** What the live stream says (groups found, minutes settled), each item checked; broken items are dropped, never drawn. */
export function parseAbsorptionLive(value: unknown): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
  const body = value as { groups?: unknown; minutes?: unknown } | null;
  const groups = Array.isArray(body?.groups) ? (body.groups as unknown[]).flatMap(item => parseGroup(item) ?? []) : [];
  const minutes = Array.isArray(body?.minutes) ? (body.minutes as unknown[]).flatMap(item => parseMinute(item) ?? []) : [];
  return { groups, minutes };
}
