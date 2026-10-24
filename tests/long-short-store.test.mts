import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LS_FORMAT, LongShortCache, validRecord, type LsBacking, type LsChange, type LsHeldRecord } from '../src/shared/long-short.ts';
import { SqliteLsStore } from '../src/server/v2/ls-store.mts';
import { IdbLsShown, fromStored, mergeShown, pointsOf, toStored } from '../src/app/browser/ls-store.ts';
import type { Fetcher } from '../src/shared/history.ts';

const M = 60_000, H = 3_600_000, NOW = Date.UTC(2026, 9, 23, 18, 50);

/** A backing in memory, as the file or IndexedDB would keep it: the whole record a key, rebuilt from each change. */
function memoryBacking(): LsBacking & { records: Map<string, LsHeldRecord>; loads: number; saves: LsChange[] } {
  const records = new Map<string, LsHeldRecord>(), saves: LsChange[] = [];
  return {
    records, saves, loads: 0,
    async load(key) { this.loads++; const r = records.get(key); return r ? { ...r, points: r.points.map(p => ({ ...p })) } : null; },
    save(key, change) {
      saves.push(change);
      const old = change.cleared ? [] : records.get(key)?.points ?? [];
      const byT = new Map(old.map(p => [p.t, p]));
      for (const p of change.added) byT.set(p.t, p);
      let points = [...byT.values()].sort((a, b) => a.t - b.t);
      if (change.keep) points = points.filter(p => p.t >= change.keep!.first && p.t <= change.keep!.last);
      records.set(key, { points, from: change.from, to: change.to, checked: change.checked });
    },
  };
}
/** Bybit's hourly readings at `times`, newest first as Bybit gives them, for whatever window is asked (the URL's endTime bounds them). */
function bybit(times: () => number[]): Fetcher & { asked: URL[] } {
  const asked: URL[] = [];
  const get = (async (raw: string) => {
    const url = new URL(raw); asked.push(url);
    const end = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
    const list = times().filter(t => t <= end).sort((a, b) => b - a).slice(0, limit).map(t => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(t) }));
    return { retCode: 0, result: { list } };
  }) as Fetcher & { asked: URL[] };
  get.asked = asked;
  return get;
}
/** A save's whole record where none is expected: a test that wrote a series whole by mistake fails. */
const notWhole = (): never => { throw new Error('written whole'); };
const hourly = (from: number, to: number): number[] => { const out: number[] = []; for (let t = Math.ceil(from / H) * H; t < to; t += H) out.push(t); return out; };

test('a series kept by the backing is read after a restart only from where it ended: the hours since, not the whole window again', async () => {
  // Karl, 2026-10-23: "Why didn't it cache some data already in a database and then just fetch the missing, the new hours".
  let now = NOW;
  const backing = memoryBacking(), get = bybit(() => hourly(NOW - 400 * H, now - H + 1));
  const first = new LongShortCache(get, false, () => now, 48, 10_000, 20_000, {}, backing);
  const a = await first.series('bybit:BTCUSDT', 'accounts', H, NOW - 240 * H, NOW + H);
  assert.equal(a.points.length, 240);
  assert.equal(backing.records.size, 1, 'kept');
  const before = get.asked.length;
  // Three hours later a new cache (the server restarted) on the same backing.
  now = NOW + 3 * H;
  const second = new LongShortCache(get, false, () => now, 48, 10_000, 20_000, {}, backing);
  const b = await second.series('bybit:BTCUSDT', 'accounts', H, NOW - 237 * H, now + H);
  assert.equal(get.asked.length - before, 1, 'one request');
  const limit = Number(get.asked.at(-1)!.searchParams.get('limit'));
  assert.ok(limit <= 12, `only the newest hours asked (limit ${limit}), not the ten days`);
  assert.deepEqual([b.status, b.points[0]!.t, b.points.at(-1)!.t], ['ok', Math.ceil((NOW - 238 * H) / H) * H, Math.floor((now - H) / H) * H],
    'from the kept readings up to the newest published hour');
});

test('every question for a series not yet restored waits for one load of it', async () => {
  const backing = memoryBacking(), get = bybit(() => hourly(NOW - 48 * H, NOW - H + 1));
  await new LongShortCache(get, false, () => NOW, 48, 10_000, 20_000, {}, backing).series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  const asked = get.asked.length, cache = new LongShortCache(get, false, () => NOW, 48, 10_000, 20_000, {}, backing);
  backing.loads = 0;
  const all = await Promise.all([1, 2, 3].map(() => cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 1_000)));
  assert.equal(backing.loads, 1, 'one load');
  assert.equal(get.asked.length, asked, 'restored and covered: the venue is not asked');
  assert.deepEqual(all.map(s => [s.status, s.points.length, s.pending]), [['ok', 24, undefined], ['ok', 24, undefined], ['ok', 24, undefined]]);
});

test('a backing that cannot load or save, or keeps a record that does not hold together, costs only the keeping', async () => {
  const get = bybit(() => hourly(NOW - 48 * H, NOW - H + 1));
  const broken: LsBacking = { load: async () => { throw new Error('disk'); }, save: () => { throw new Error('full'); } };
  const s = await new LongShortCache(get, false, () => NOW, 48, 10_000, 20_000, {}, broken).series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  assert.deepEqual([s.status, s.points.length], ['ok', 24], 'read from the venue as if there were no backing');
  const garbled = memoryBacking();
  garbled.records.set(`bybit:BTCUSDT|accounts|${H}`, { points: [{ t: NOW - H, long: 0.6 }, { t: NOW - 2 * H, long: 0.6 }], from: NOW - 24 * H, to: NOW, checked: NOW });
  const asked = get.asked.length;
  const g = await new LongShortCache(get, false, () => NOW, 48, 10_000, 20_000, {}, garbled).series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  assert.deepEqual([g.points.length, get.asked.length - asked], [24, 1], 'out of order: not trusted, read anew');
  assert.equal(validRecord({ points: [], from: NaN, to: 0, checked: 0 }), false);
  assert.equal(validRecord({ points: [{ t: 1, long: 1.2 }], from: 0, to: 2, checked: 0 }), false, 'a share out of range');
  assert.equal(validRecord({ points: [{ t: 1, long: 0.5 }], from: 0, to: 2, checked: 0 }), true);
});

test('what a read changed is what is saved: the bound keeps the newest stretch, a series started again drops the old one', async () => {
  let now = NOW;
  const backing = memoryBacking(), get = bybit(() => hourly(NOW - 8000 * H, now - H + 1));
  const cache = new LongShortCache(get, false, () => now, 48, 100, 20_000, {}, backing);
  await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 90 * H, NOW + H);
  now += 30 * H;
  await cache.series('bybit:BTCUSDT', 'accounts', H, now - 90 * H, now + H);
  const kept = backing.records.get(`bybit:BTCUSDT|accounts|${H}`)!;
  assert.ok(kept.points.length <= 100 && backing.saves.some(c => c.keep), `over the bound the oldest went (${kept.points.length} kept)`);
  assert.equal(kept.points.at(-1)!.t, Math.floor((now - H) / H) * H, 'the newest stays');
  // A window further back than one question reaches from what is held: the series starts again there, and so does what is kept.
  // (One question reaches 12 pages of 500 hourly readings back: 7,000 hours is past it.)
  await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 7000 * H, NOW - 6920 * H);
  const again = backing.records.get(`bybit:BTCUSDT|accounts|${H}`)!;
  assert.ok(again.points.length > 0 && again.points.every(p => p.t < NOW - 6800 * H), 'only the new stretch');
  assert.equal(backing.saves.at(-1)!.cleared, true);
});

test('the server keeps the series in a file of its own: a change is a few rows, the bound and the least recently used are kept to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-store-')), file = path.join(dir, 'long-short.sqlite');
  let clock = 1_000;
  try {
    const store = new SqliteLsStore(file, 2, () => clock);
    const pts = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + i * H, long: 0.5 + i / 1000 }));
    store.save('a', { cleared: true, added: pts(NOW, 5), keep: null, from: NOW, to: NOW + 5 * H, checked: NOW }, notWhole);
    store.save('a', { cleared: false, added: pts(NOW + 4 * H, 3), keep: { first: NOW + H, last: NOW + 6 * H }, from: NOW + H, to: NOW + 7 * H, checked: NOW + H }, notWhole);
    const a = (await store.load('a'))!;
    assert.deepEqual(a.points.map(p => (p.t - NOW) / H), [1, 2, 3, 4, 5, 6], 'added, the same reading again replaced, trimmed to the bound');
    assert.deepEqual([a.from, a.to, a.checked], [NOW + H, NOW + 7 * H, NOW + H]);
    store.save('a', { cleared: true, added: pts(NOW + 100 * H, 1), keep: null, from: NOW + 100 * H, to: NOW + 101 * H, checked: NOW }, notWhole);
    assert.deepEqual((await store.load('a'))!.points.length, 1, 'cleared: only what that read gave');
    clock = 2_000; store.save('b', { cleared: true, added: pts(NOW, 1), keep: null, from: NOW, to: NOW + H, checked: NOW }, notWhole);
    clock = 3_000; await store.load('a');
    clock = 4_000; store.save('c', { cleared: true, added: pts(NOW, 1), keep: null, from: NOW, to: NOW + H, checked: NOW }, notWhole);
    assert.equal(await store.load('b'), null, 'past two series the least recently used went');
    assert.ok(await store.load('a') && await store.load('c'));
    store.close();
    const reopened = new SqliteLsStore(file, 2, () => clock);
    assert.equal((await reopened.load('c'))!.points.length, 1, 'kept across a restart');
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page keeps a series as two arrays and reads it back as it was; anything else stored is not a series', () => {
  const record: LsHeldRecord = { points: [{ t: NOW, long: 0.61 }, { t: NOW + H, long: 0.6234 }], from: NOW - H, to: NOW + 2 * H, checked: NOW + M };
  const stored = toStored('bybit:BTCUSDT|accounts|3600000', record, 5);
  assert.deepEqual([stored.key, stored.used, stored.t.length], ['bybit:BTCUSDT|accounts|3600000', 5, 2]);
  assert.deepEqual(fromStored(stored), record);
  assert.equal(fromStored(null), null);
  assert.equal(fromStored({ ...stored, t: [NOW] }), null, 'not the arrays it writes');
  assert.equal(fromStored({ ...stored, long: new Float64Array(1) }), null, 'arrays of different lengths');
  assert.equal(fromStored({ ...stored, from: 'x' }), null);
});

test('what the pane drew is kept as the newest readings of the series: the new over the held, in order, within the bound', () => {
  const held = [{ t: NOW, long: 0.6 }, { t: NOW + H, long: 0.61 }];
  assert.deepEqual(mergeShown(held, [{ t: NOW + H, long: 0.62 }, { t: NOW + 2 * H, long: 0.63 }]).map(p => [(p.t - NOW) / H, p.long]), [[0, 0.6], [1, 0.62], [2, 0.63]], 'the same time again: the newer answer');
  assert.deepEqual(mergeShown(null, [{ t: NOW + H, long: 0.5 }, { t: NOW, long: 0.5 }, { t: NOW + 2 * H, long: 1.2 }], 1).map(p => (p.t - NOW) / H), [1], 'a share out of range is not kept; past the bound the oldest go');
  assert.equal(pointsOf({ key: 'k', t: Float64Array.of(NOW + H, NOW), long: Float64Array.of(0.5, 0.5), used: 0, v: LS_FORMAT }), null, 'out of order: not readings');
  assert.deepEqual(pointsOf({ key: 'k', t: Float64Array.of(NOW), long: Float64Array.of(0.5), used: 0, v: LS_FORMAT }), [{ t: NOW, long: 0.5 }]);
  assert.equal(pointsOf({ key: 'k', t: Float64Array.of(NOW), long: Float64Array.of(0.5), used: 0, v: LS_FORMAT + 1 }), null, 'another format: none');
});

test('the server file is written whole where it may not hold what the cache did: its row dropped by the bound, or its last write failed', async () => {
  // Found in review: a change applied to a file that lost the series' rows claimed a stretch with no readings in it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-store-')), file = path.join(dir, 'long-short.sqlite');
  try {
    const store = new SqliteLsStore(file, 1, () => 1);
    const pts = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + i * H, long: 0.5 }));
    const full = (points: { t: number; long: number }[], from: number, to: number) => () => ({ points, from, to, checked: NOW });
    store.save('a', { cleared: true, added: pts(NOW, 10), keep: null, from: NOW, to: NOW + 10 * H, checked: NOW }, notWhole);
    store.save('b', { cleared: true, added: pts(NOW, 1), keep: null, from: NOW, to: NOW + H, checked: NOW }, notWhole);
    assert.equal(await store.load('a'), null, 'a dropped by the bound of one series');
    // The cache still held a's ten readings: its next read adds one; the file is written whole from the cache.
    store.save('a', { cleared: false, added: pts(NOW + 10 * H, 1), keep: null, from: NOW, to: NOW + 11 * H, checked: NOW }, full(pts(NOW, 11), NOW, NOW + 11 * H));
    assert.equal((await store.load('a'))!.points.length, 11, 'whole: every reading the stretch claims');
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a series evicted from the cache while its read was under way saves nothing over the one restored since', async () => {
  const backing = memoryBacking(), get = bybit(() => hourly(NOW - 48 * H, NOW - H + 1));
  let release!: () => void;
  const slow: Fetcher = async (url, init) => { await new Promise<void>(r => { release = r; }); return get(url, init); };
  const cache = new LongShortCache(slow, false, () => NOW, 1, 10_000, 20_000, {}, backing);
  const a = cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  await new Promise(r => setTimeout(r, 5));
  // Another series pushes it out of a cache of one (its read still under way): its read lands, and is not saved.
  await cache.series('binance:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 0);
  release(); await a;
  assert.equal(backing.records.has(`bybit:BTCUSDT|accounts|${H}`), false);
});

test('a file of another format is emptied when opened; a record read under a clock ahead, or over the bound, is not trusted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-store-')), file = path.join(dir, 'long-short.sqlite');
  try {
    const store = new SqliteLsStore(file);
    store.save('a', { cleared: true, added: [{ t: NOW, long: 0.5 }], keep: null, from: NOW, to: NOW + H, checked: NOW }, notWhole);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file); db.exec(`PRAGMA user_version = ${LS_FORMAT + 7}`); db.close();
    const again = new SqliteLsStore(file);
    assert.equal(await again.load('a'), null);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const record = { points: [{ t: NOW, long: 0.5 }, { t: NOW + H, long: 0.5 }], from: NOW, to: NOW + 2 * H, checked: NOW + 2 * H };
  assert.equal(validRecord(record, NOW), false, 'read two hours from now');
  assert.equal(validRecord(record, NOW + 2 * H), true);
  assert.equal(validRecord(record, NOW + 2 * H, 1), false, 'more readings than the cache keeps');
});

test('questions for more series than the cache holds, all waiting on their loads, end: a load landing for an evicted series starts nothing', async () => {
  // Found in review: each landing load kicked a read that evicted another waiting series, whose load kicked another, without end.
  let loads = 0;
  const backing: LsBacking = { load: async () => { loads++; return null; }, save: () => {} };
  const cache = new LongShortCache(bybit(() => hourly(NOW - 48 * H, NOW - H + 1)), false, () => NOW, 2, 10_000, 20_000, {}, backing);
  const ids = ['bybit:BTCUSDT', 'bybit:ETHUSDT', 'bybit:SOLUSDT'];
  await Promise.all(ids.map(id => cache.series(id, 'accounts', H, NOW - 24 * H, NOW + H, 0)));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(loads < 20, `a handful of loads, not an endless chain (${loads})`);
});

/** An IndexedDB stand-in: each open answers after `delayMs` (or throws), with a database whose reads find nothing. */
function fakeFactory(delayMs: number | 'throw'): IDBFactory & { opens: number; closed: number } {
  const f = {
    opens: 0, closed: 0,
    open() {
      f.opens++;
      if (delayMs === 'throw') throw new Error('blocked');
      const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
      const db = {
        objectStoreNames: { contains: () => true }, close: () => { f.closed++; },
        transaction: () => ({ objectStore: () => ({ get: () => { const r: { result?: unknown; onsuccess?: () => void } = {}; setTimeout(() => { r.result = undefined; r.onsuccess?.(); }, 0); return r; } }) }),
      };
      setTimeout(() => { request.result = db; request.onsuccess?.(); }, delayMs);
      return request;
    },
  };
  return f as unknown as IDBFactory & { opens: number; closed: number };
}

test('a page database slow to open is opened once, and serves the next uses when it does; one that cannot be opened is tried again', async t => {
  // Found in review: a slow open was retried every 5 s, and each late success left a connection open.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = fakeFactory(7_000), shown = new IdbLsShown('slow-db', 96, 10_000, slow);
  const first = shown.get('k');
  t.mock.timers.tick(5_000);
  assert.equal(await first, null, 'past the open timeout: nothing kept, for now');
  const second = shown.get('k');
  t.mock.timers.tick(2_000); t.mock.timers.tick(1);
  assert.equal(await second, null);
  assert.deepEqual([slow.opens, slow.closed], [1, 0], 'one open; its late connection serves the next use');
  const blocked = fakeFactory('throw'), refused = new IdbLsShown('blocked-db', 96, 10_000, blocked);
  assert.equal(await refused.get('k'), null);
  assert.equal(await refused.get('k'), null);
  assert.equal(blocked.opens, 2, 'an open that failed at once is tried again');
});
