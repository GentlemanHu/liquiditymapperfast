import { LS_FORMAT, type LsBacking, type LsHeldRecord, type LsPoint } from '../../shared/long-short.ts';

/**
 * Long/short readings a page keeps across reloads, in a database of its own: never the recordings' (app/browser/idb.ts), whose versions and
 * hand-over between tabs it has no part in. Two stores:
 * - `series`: the browser engine's long/short cache (shared/long-short.ts `LsBacking`, `IdbLsStore`): a record a series, its readings and the
 *   stretch they cover, written whole after each read of it (a few thousand readings at most).
 * - `shown`: what the Long/Short pane drew from a server's answers (`IdbLsShown`): readings only, so the pane draws them the moment it is
 *   shown, before the server, whose answer can wait behind the page's other requests to it for twenty seconds and more while the page loads
 *   (six connections to one server; measured 2026-10-23), adds the hours since.
 * Past `LS_IDB_MAX_SERIES` a store's least recently written go. Each record carries `LS_FORMAT`; one of another is read as none. Nothing here is
 * waited for but a first read, and nothing that fails stops the pane: it reads from the venues or the server as without it.
 */
export const LS_IDB_NAME = 'hlm-long-short';
export const LS_IDB_MAX_SERIES = 96;
/** The most readings `shown` keeps of a series (the newest): the long/short cache's own bound. */
export const LS_SHOWN_MAX_POINTS = 10_000;
const SERIES = 'series', SHOWN = 'shown', OPEN_TIMEOUT_MS = 5_000;

/** A series as stored: its readings as two parallel arrays, its stretch (a `series` record), when it was last written and its format. */
export interface StoredSeries { key: string; t: Float64Array; long: Float64Array; from: number; to: number; checked: number; used: number; v: number }

export function toStored(key: string, record: LsHeldRecord, used: number): StoredSeries {
  const { t, long } = arrays(record.points);
  return { key, t, long, from: record.from, to: record.to, checked: record.checked, used, v: LS_FORMAT };
}
/** A stored series as a record, or null when it is not one (the cache checks the readings themselves: shared/long-short.ts `validRecord`). */
export function fromStored(value: unknown): LsHeldRecord | null {
  const s = value as Partial<StoredSeries> | null, points = pointsOf(s);
  if (!points || typeof s!.from !== 'number' || typeof s!.to !== 'number' || typeof s!.checked !== 'number') return null;
  return { points, from: s!.from, to: s!.to, checked: s!.checked };
}
/** Readings kept in `shown`: those held, with the new ones over them (a reading of the same time replaced), in order, the newest `max`. */
export function mergeShown(held: readonly LsPoint[] | null, added: readonly LsPoint[], max = LS_SHOWN_MAX_POINTS): LsPoint[] {
  const byT = new Map<number, LsPoint>();
  for (const p of held ?? []) byT.set(p.t, p);
  for (const p of added) if (Number.isFinite(p.t) && p.long > 0 && p.long < 1) byT.set(p.t, { t: p.t, long: p.long });
  return [...byT.values()].sort((a, b) => a.t - b.t).slice(-max);
}
/** The readings of a stored record (of this format, two arrays of one length, times in order), or null. */
export function pointsOf(value: unknown): LsPoint[] | null {
  const s = value as Partial<StoredSeries> | null;
  if (!s || s.v !== LS_FORMAT || !(s.t instanceof Float64Array) || !(s.long instanceof Float64Array) || s.t.length !== s.long.length) return null;
  const points: LsPoint[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i]!, long = s.long[i]!;
    if (!Number.isFinite(t) || !(long > 0 && long < 1) || (points.length && t <= points[points.length - 1]!.t)) return null;
    points.push({ t, long });
  }
  return points;
}
const arrays = (points: readonly LsPoint[]): { t: Float64Array; long: Float64Array } => ({ t: Float64Array.from(points, p => p.t), long: Float64Array.from(points, p => p.long) });

/**
 * Each database opened once a page; null where there is none (no IndexedDB, blocked, private mode). Version 2: `shown` came after `series`,
 * so a database of version 1 gains it. An open slower than `OPEN_TIMEOUT_MS` answers null to those waiting, and the database it opens later
 * serves the next uses; one that fails, or that the browser closes (cleared site data, a storage fault), is opened again at the next use.
 */
const opened = new Map<string, Promise<IDBDatabase | null>>();
function openLsDb(name: string, factory: IDBFactory | undefined): Promise<IDBDatabase | null> {
  const held = opened.get(name);
  if (held) return held;
  if (!factory) return Promise.resolve(null);
  let settled = false, failedNow = false;
  const db: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>(resolve => {
    const answer = (value: IDBDatabase | null): void => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => answer(null), OPEN_TIMEOUT_MS);
    try {
      const request = factory.open(name, 2);
      request.onupgradeneeded = () => {
        const d = request.result;
        for (const store of [SERIES, SHOWN]) if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath: 'key' }).createIndex('used', 'used');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const d = request.result;
        // A later page with another version of it asks this one to let go: it does, and keeps nothing more until reloaded.
        d.onversionchange = () => { d.close(); opened.set(name, Promise.resolve(null)); };
        d.onclose = () => { if (opened.get(name) === kept) opened.delete(name); };
        // Opened after those waiting were answered: it serves the next uses, unless another open has since taken its place (then it goes).
        const kept = settled ? Promise.resolve(d) : db;
        if (settled) { if (opened.get(name) !== db) { d.close(); return; } opened.set(name, kept); }
        answer(d);
      };
      request.onerror = () => { clearTimeout(timer); if (opened.get(name) === db) opened.delete(name); answer(null); };
    } catch { clearTimeout(timer); failedNow = true; answer(null); }
  });
  opened.set(name, db);
  // An open that failed at once is tried again at the next use (a slow one is not: its late success serves the next uses).
  if (failedNow) opened.delete(name);
  return db;
}

/** One record of `store`, or null (none, or the database is not there). */
async function getRecord(name: string, factory: IDBFactory | undefined, store: string, key: string): Promise<unknown> {
  const db = await openLsDb(name, factory);
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
/** Past `max` records, the least recently written of `store` go (within the transaction that wrote the newest). */
function evict(store: IDBObjectStore, max: number): void {
  const count = store.count();
  count.onsuccess = () => {
    let over = count.result - max;
    if (over <= 0) return;
    const cursor = store.index('used').openCursor();
    cursor.onsuccess = () => { const c = cursor.result; if (!c || over <= 0) return; over--; c.delete(); c.continue(); };
  };
}
/** `work` in a write transaction of `store`, when the database is there; a failure loses only the keeping. */
function write(name: string, factory: IDBFactory | undefined, store: string, work: (s: IDBObjectStore) => void): void {
  void openLsDb(name, factory).then(db => {
    if (!db) return;
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.onerror = event => event.preventDefault();
      work(tx.objectStore(store));
    } catch { /* not kept: read again next time */ }
  });
}

/** The browser engine's long/short cache, kept across reloads (`series`). */
export class IdbLsStore implements LsBacking {
  constructor(private name = LS_IDB_NAME, private maxSeries = LS_IDB_MAX_SERIES, private factory: IDBFactory | undefined = globalThis.indexedDB) {}
  async load(key: string): Promise<LsHeldRecord | null> { return fromStored(await getRecord(this.name, this.factory, SERIES, key)); }
  save(key: string, _change: unknown, full: () => LsHeldRecord): void {
    const record = toStored(key, full(), Date.now());
    write(this.name, this.factory, SERIES, store => { store.put(record); evict(store, this.maxSeries); });
  }
}

/** What the Long/Short pane drew from a server's answers, by the series' key (`shown`): drawn first the next time the pane is shown. */
export class IdbLsShown {
  constructor(private name = LS_IDB_NAME, private maxSeries = LS_IDB_MAX_SERIES, private maxPoints = LS_SHOWN_MAX_POINTS, private factory: IDBFactory | undefined = globalThis.indexedDB) {}
  async get(key: string): Promise<LsPoint[] | null> { return pointsOf(await getRecord(this.name, this.factory, SHOWN, key)); }
  /** Keep `points` with what is kept of the series (one read and one write, in one transaction). */
  add(key: string, points: readonly LsPoint[]): void {
    if (!points.length) return;
    write(this.name, this.factory, SHOWN, store => {
      const request = store.get(key);
      request.onsuccess = () => {
        const held = pointsOf(request.result), merged = mergeShown(held, points, this.maxPoints);
        // The same readings again (a minute's refresh that brought nothing new): nothing written.
        if (held && merged.length === held.length && merged.every((p, i) => p.t === held[i]!.t && p.long === held[i]!.long)) return;
        store.put({ key, ...arrays(merged), used: Date.now(), v: LS_FORMAT });
        evict(store, this.maxSeries);
      };
    });
  }
}
