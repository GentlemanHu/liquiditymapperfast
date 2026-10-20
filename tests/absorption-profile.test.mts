import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AbsorptionProfile, AbsorptionRecorder, GROUPS_PER_MINUTE, hoursOf, markedPart, parseAbsorptionProfile, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionProfileAnswer, type AbsorptionStep, type AbsorptionStore } from '../src/shared/absorption.ts';
import { binOf } from '../src/shared/footprint.ts';
import { AbsorptionRecorder as SqliteAbsorptionRecorder } from '../src/server/v2/absorption.mts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { getAbsorptionProfile } from '../src/app/net.ts';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000, T0 = 1_800_000_000_000;
type Side = 'buy' | 'sell';
type Rows = Map<string, Map<number, [number, number]>>;

/** A seeded generator. */
const seeded = (seed: number): (() => number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32; };

/** `n` groups of `ids` over [from, from + span), each with one to four steps (credits falling, USD and fills growing), every key once. */
function groupsOf(seed: number, n: number, ids: readonly string[], from: number, span: number): AbsorptionGroup[] {
  const rnd = seeded(seed), out: AbsorptionGroup[] = [], keys = new Set<string>();
  while (out.length < n) {
    const id = ids[Math.floor(rnd() * ids.length)]!, side: Side = rnd() < 0.5 ? 'buy' : 'sell', t0 = from + Math.floor(rnd() * span);
    // Some prices on a row's edge exactly, some just under it.
    const price = rnd() < 0.2 ? 80_000 + Math.floor(rnd() * 40) * 50 : rnd() < 0.1 ? 80_000 + Math.floor(rnd() * 40) * 50 - 0.01 : 80_000 + Math.round(rnd() * 200_000) / 100;
    const key = `${id}|${side}|${price}|${t0}`; if (keys.has(key)) continue; keys.add(key);
    let credit = 25_000 + Math.floor(rnd() * 600_000), usd = 0, fills = 0;
    const steps: AbsorptionStep[] = [];
    for (let k = 1 + Math.floor(rnd() * 4); k > 0 && credit >= 25_000; k--) {
      usd += 1_000 + Math.floor(rnd() * credit); fills += 1 + Math.floor(rnd() * 4);
      steps.push([credit, usd, fills, t0, t0 + Math.floor(rnd() * 9)]);
      credit = Math.floor(credit * (0.3 + rnd() * 0.6));
    }
    out.push({ id, side, price, t0, steps });
  }
  return out;
}

/** The column worked out the slow way: every group's marked part (`markedPart`) on the row of its price, each group once. */
function referenceRows(groups: readonly AbsorptionGroup[], thresholds: ReadonlyMap<string, number | null>, from: number, to: number, step: number): Rows {
  const out: Rows = new Map(), seen = new Set<string>();
  for (const g of groups) {
    const threshold = thresholds.get(g.id), key = `${g.id}|${g.side}|${g.price}|${g.t0}`;
    if (threshold === null || threshold === undefined || g.t0 < from || g.t0 >= to || seen.has(key)) continue;
    seen.add(key);
    const part = markedPart(g, threshold); if (!part) continue;
    let rows = out.get(g.id); if (!rows) { rows = new Map(); out.set(g.id, rows); }
    const price = binOf(g.price, step) * step, cell = rows.get(price) ?? [0, 0];
    cell[g.side === 'sell' ? 0 : 1] += part.usd; rows.set(price, cell);
  }
  return out;
}

/** An answer's rows equal the reference's (sums compared to a part in a billion: they are added in another order). */
function assertRows(answer: AbsorptionProfileAnswer, want: Rows, label: string): void {
  assert.deepEqual(answer.instruments.map(i => i.id).sort(), [...want.keys()].sort(), `${label}: the instruments`);
  for (const i of answer.instruments) {
    const rows = want.get(i.id)!;
    assert.deepEqual(i.rows.map(r => r[0]), [...rows.keys()].sort((a, b) => a - b), `${label}: ${i.id}'s rows`);
    for (const [price, a, b] of i.rows) {
      const [wa, wb] = rows.get(price)!;
      assert.ok(Math.abs(a - wa) <= 1e-9 * Math.max(1, wa) && Math.abs(b - wb) <= 1e-9 * Math.max(1, wb), `${label}: ${i.id} at ${price}: ${a}/${b}, wanted ${wa}/${wb}`);
    }
  }
}

/** A store holding what it is given, recording each hour it hands over; the column must not ask it anything else. */
class MemoryStore implements AbsorptionStore {
  readonly asked: [number, number][] = [];
  failAt: number | null = null;
  constructor(readonly groups: AbsorptionGroup[], readonly stored: AbsorptionMinute[]) {}
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } { return { groups: this.groups.filter(g => g.t0 >= since), minutes: this.stored.filter(m => m.t >= since) }; }
  save(): void {}
  query(): AbsorptionGroup[] { throw new Error('the column asked for capped groups'); }
  minutes(): AbsorptionMinute[] { throw new Error('the column asked for minutes outside its hours'); }
  async eachHour(ids: readonly string[] | null, mins: readonly number[], from: number, to: number, take: (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) => void): Promise<void> {
    const min = ids ? new Map(ids.map((id, i) => [id, mins[i]!])) : null, passes = (id: string, v: number): boolean => !min || v >= (min.get(id) ?? Infinity);
    for (const hour of hoursOf(from, to)) {
      if (this.failAt !== null && hour.from >= this.failAt) throw new Error('the store failed');
      this.asked.push([hour.from, hour.to]);
      take(this.groups.filter(g => g.t0 >= hour.from && g.t0 < hour.to && passes(g.id, peakOf(g))), this.stored.filter(m => m.t >= hour.from && m.t < hour.to && passes(m.id, m.floor)));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  close(): void {}
}

test('the column adds up exactly what judging every group gives, more than 4,000 an instrument, store and memory together', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], end = T0 + 24 * HOUR;
  for (const seed of [1, 5, 9]) {
    const groups = groupsOf(seed, 15_000, ids, T0, 24 * HOUR);
    // The recorder's memory answers the last two hours (it loads them from the store), the store the rest.
    const store = new MemoryStore(groups, []), recorder = new AbsorptionRecorder(store, () => end);
    for (const [thresholds, step] of [[[40_000, 120_000, null], 50], [[25_000, 25_000, 25_000], 0.5], [[300_000, 0, 1e12], 1_000]] as const) {
      const map = new Map<string, number | null>(ids.map((id, i) => [id, thresholds[i]!]));
      for (const [from, to] of [[T0, end], [T0 + 90 * MIN + 17, end - 45 * MIN - 3], [end - 90 * MIN, end], [T0 + 3 * HOUR, T0 + 3 * HOUR + 1]]) {
        store.asked.length = 0;
        const answer = await recorder.profile(ids, [...thresholds], from!, to!, step);
        assertRows(answer, referenceRows(groups, map, from!, to!, step), `seed ${seed}, ${thresholds.join('/')} on ${step}, ${from! - T0}..${to! - T0}`);
        assert.deepEqual(answer.cut, []);
        assert.deepEqual([answer.from, answer.to], [from, to]);
        // The store is asked for what memory does not hold, a whole hour at most at a time, and for the instruments with a threshold only.
        const split = Math.min(to!, Math.max(from!, end - 2 * HOUR));
        if (from! < split) assert.deepEqual([store.asked[0]![0], store.asked[store.asked.length - 1]![1]], [from, split]);
        else assert.equal(store.asked.length, 0, 'memory alone');
        assert.ok(store.asked.every(([a, b]) => b - a <= HOUR && Math.floor(a / HOUR) === Math.floor((b - 1) / HOUR)));
      }
    }
    const many = await recorder.profile(['a:BTC'], [25_000], T0, end, 50);
    const counted = many.instruments[0]!.rows.reduce((n, r) => n + r[1] + r[2], 0), all = groups.filter(g => g.id === 'a:BTC');
    assert.ok(all.length > 4_000, `${all.length} groups of one instrument`);
    assert.ok(Math.abs(counted - all.reduce((n, g) => n + markedPart(g, 25_000)!.usd, 0)) < 1e-3 * counted, 'every one counted, none cut');
  }
});

test('a group found again is counted once, whether memory was given it twice or the page has it twice', async () => {
  const end = T0 + 3 * HOUR, g: AbsorptionGroup = { id: 'a:BTC', side: 'sell', price: 100, t0: end - 30 * MIN, steps: [[60_000, 60_000, 2, end - 30 * MIN, end - 30 * MIN]] };
  const older: AbsorptionGroup = { ...g, t0: end - 150 * MIN, steps: [[70_000, 70_000, 1, end - 150 * MIN, end - 150 * MIN]] };
  // The store reads `g` back twice when the recorder starts (a store keeps a row once, so it hands `older` over once).
  const store = new MemoryStore([g, { ...g, steps: [[60_000, 60_000, 2, g.t0, g.t0]] }, older], []);
  const answer = await new AbsorptionRecorder(store, () => end).profile(['a:BTC'], [25_000], T0, end, 10);
  assert.deepEqual(answer.instruments[0]!.rows, [[100, 130_000, 0]]);
  const profile = new AbsorptionProfile(new Map([['a:BTC', 25_000]]), T0, end, 10);
  profile.add(g); profile.add({ ...g }); profile.add(older);
  assert.deepEqual(profile.answer().instruments[0]!.rows, [[100, 130_000, 0]]);
});

test('rows are cut at multiples of the step, a window is half open, and the sides are resting buyers then resting sellers', () => {
  const g = (side: Side, price: number, t0: number, usd = 50_000): AbsorptionGroup => ({ id: 'a:BTC', side, price, t0, steps: [[usd, usd, 1, t0, t0]] });
  const profile = new AbsorptionProfile(new Map([['a:BTC', 30_000]]), T0, T0 + MIN, 50);
  for (const group of [g('sell', 100, T0), g('sell', 149.99, T0 + 1), g('buy', 150, T0 + 2), g('buy', 199.999, T0 + 3), g('sell', 100, T0 + MIN), g('buy', 100, T0 - 1), g('buy', 100, T0 + 4, 29_999)]) profile.add(group);
  assert.deepEqual(profile.answer().instruments, [{ id: 'a:BTC', step: 50, minutes: 0, first: null, earliest: null, rows: [[100, 100_000, 0], [150, 0, 100_000]] }]);
});

test('a minute that kept only its largest says the column may be short there, ties included', async () => {
  // Two groups a minute are kept here (the recorder keeps ten): of 30K, 40K and 50K in one minute, 30K is left out and the floor rises to it.
  let now = T0;
  const recorder = new AbsorptionRecorder(null, () => now, { perMinute: 2 });
  [30_000, 40_000, 50_000].forEach((usd, i) => { now = T0 + i * 1_000 + 300; recorder.add('a:BTC', T0 + i * 1_000, 100 + i, usd, 'buy'); });
  now = T0 + MIN + 300; recorder.add('b:BTC', T0 + MIN, 200, 25_000, 'buy');
  // Both quiet a moment: every group is closed, and neither minute is settled yet.
  now += 1_000; recorder.step();
  const ask = async (thresholds: number[]): Promise<AbsorptionProfileAnswer> => recorder.profile(['a:BTC', 'b:BTC'], thresholds, T0, T0 + 2 * MIN, 1);
  for (const settled of [false, true]) {
    if (settled) { now = T0 + 10 * MIN; recorder.step(true); }
    const label = settled ? 'settled' : 'still open';
    assert.deepEqual((await ask([29_999, 25_000])).incomplete, ['a:BTC'], `${label}: under the floor, a group left out would be marked`);
    assert.deepEqual((await ask([30_000, 25_000])).incomplete, ['a:BTC'], `${label}: at the floor, the one left out (30K) would be marked too`);
    assert.deepEqual((await ask([30_001, 25_000])).incomplete, [], `${label}: over it, nothing left out would be`);
    assert.deepEqual((await ask([30_000, 25_000])).instruments.find(i => i.id === 'a:BTC')!.rows, [[101, 0, 40_000], [102, 0, 50_000]], `${label}: the one left out is not counted`);
    // b:BTC's minute kept its one group and left none out: its floor is the base floor, equal to the threshold, and it is complete.
    assert.deepEqual((await ask([50_000, 25_000])).incomplete, [], `${label}: a threshold at the base floor of a minute that left nothing out`);
  }
  // Without the minutes' place (an older server gives each instrument's highest floor only), a tie is short if any minute kept its fill.
  const older = new AbsorptionProfile(new Map([['a:BTC', 30_000]]), T0, T0 + MIN, 1, 2);
  older.add({ id: 'a:BTC', side: 'buy', price: 1, t0: T0, steps: [[40_000, 40_000, 1, T0, T0]] }); older.floor('a:BTC', null, 30_000);
  assert.deepEqual(older.answer().incomplete, [], 'one group kept: none was left out at 30K');
  older.add({ id: 'a:BTC', side: 'buy', price: 2, t0: T0 + 1, steps: [[50_000, 50_000, 1, T0 + 1, T0 + 1]] });
  assert.deepEqual(older.answer(['a:BTC']), { from: T0, to: T0 + MIN, instruments: older.answer().instruments, incomplete: ['a:BTC'], cut: ['a:BTC'] });
  assert.equal(GROUPS_PER_MINUTE, 10);
});

test('floors from the store count as memory\'s do, the column reads no minute outside its hours, and a store that fails fails the answer', async () => {
  const end = T0 + 6 * HOUR;
  const minutes: AbsorptionMinute[] = [{ id: 'a:BTC', t: T0 + HOUR, n: 1, mean: 1, m2: 0, floor: 90_000 }, { id: 'a:BTC', t: end - HOUR, n: 1, mean: 1, m2: 0, floor: 90_000 }];
  const store = new MemoryStore([], minutes), recorder = new AbsorptionRecorder(store, () => end);
  assert.deepEqual((await recorder.profile(['a:BTC'], [80_000], T0, T0 + 2 * HOUR, 1)).incomplete, ['a:BTC'], 'from the store');
  assert.deepEqual((await recorder.profile(['a:BTC'], [80_000], end - 90 * MIN, end, 1)).incomplete, ['a:BTC'], 'from memory');
  assert.deepEqual((await recorder.profile(['a:BTC'], [80_000], T0 + 2 * HOUR, end - 2 * HOUR, 1)).incomplete, [], 'none in the window');
  assert.deepEqual((await recorder.profile(['a:BTC'], [95_000], T0, end, 1)).incomplete, [], 'none over the threshold');
  store.failAt = T0 + 2 * HOUR;
  await assert.rejects(recorder.profile(['a:BTC'], [80_000], T0, end, 1), /the store failed/);
});

test('the server store hands the column every group of a stored day an hour at a time, and memory the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-profile-')), db = path.join(dir, 'depth.sqlite');
  const rnd = seeded(3), fills: { id: string; t: number; price: number; usd: number; side: Side }[] = [];
  for (let i = 0; i < 3_000; i++) fills.push({ id: rnd() < 0.5 ? 'x:BTC' : 'y:BTC', t: T0 + i * 20_000 + Math.floor(rnd() * 1_000), price: 100 + Math.floor(rnd() * 30), usd: 20_000 + Math.floor(rnd() * 200_000), side: rnd() < 0.5 ? 'buy' : 'sell' });
  let now = T0;
  const first = new SqliteAbsorptionRecorder(db, () => now);
  const found: AbsorptionGroup[] = [];
  // Seventeen hours of fills recorded, then a restart: memory answers its last two hours, the store the rest.
  for (const f of fills.slice(0, 2_000)) { now = f.t + 300; first.add(f.id, f.t, f.price, f.usd, f.side); if (now % 7 === 0) first.step(); }
  now += 10 * MIN; first.step(true); found.push(...first.takeFresh().groups); first.close();
  const second = new SqliteAbsorptionRecorder(db, () => now);
  try {
    for (const f of fills.slice(2_000)) { now = f.t + 300; second.add(f.id, f.t, f.price, f.usd, f.side); }
    now += 10 * MIN; second.step(true); found.push(...second.takeFresh().groups); second.flush();
    const end = fills[fills.length - 1]!.t + MIN;
    for (const threshold of [25_000, 100_000]) {
      const answer = await second.profile(['x:BTC', 'y:BTC'], [threshold, threshold], T0, end, 5);
      assertRows(answer, referenceRows(found, new Map([['x:BTC', threshold], ['y:BTC', threshold]]), T0, end, 5), `threshold ${threshold}`);
      assert.ok(answer.instruments.every(i => i.rows.length > 5));
    }
  } finally { second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/api/v2/absorption-profile adds up each instrument at its own threshold and refuses what it cannot answer', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, t = Date.now() - 5_000;
    v2.absorption.add('x:BTC', t, 100, 40_000, 'buy');
    v2.absorption.add('x:BTC', t + 100, 101, 90_000, 'sell');
    v2.absorption.add('y:BTC', t, 100, 60_000, 'sell');
    const get = async (query: string) => { const r = await fetch(`${base}/api/v2/absorption-profile?${query}`); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
    const from = Math.floor(t / MIN) * MIN - MIN, to = from + 3 * MIN, ask = `inst=x:BTC,y:BTC&from=${from}&to=${to}&min=50000,25000.5&step=1`;
    let reply = await get(ask);
    for (let i = 0; i < 60 && (reply.body.instruments as unknown[]).length < 2; i++) { await new Promise(resolve => setTimeout(resolve, 50)); reply = await get(ask); }
    assert.equal(reply.status, 200);
    const answer = parseAbsorptionProfile(reply.body, ['x:BTC', 'y:BTC']);
    assert.ok(answer, 'the shape the page checks for');
    assert.deepEqual(answer!.instruments.map(i => [i.id, i.rows]).sort(), [['x:BTC', [[101, 90_000, 0]]], ['y:BTC', [[100, 60_000, 0]]]], 'x from 50K: its 40K group is not marked');
    assert.deepEqual([answer!.incomplete, answer!.cut], [[], []]);
    const many = Array.from({ length: 201 }, (_, i) => `i${i}:BTC`).join(',');
    for (const query of ['', `inst=${many}&min=1&step=1`, 'inst=x:BTC&step=1', 'inst=x:BTC,y:BTC&min=1,2,3&step=1', 'inst=x:BTC&min=-1&step=1', 'inst=x:BTC&min=abc&step=1', 'inst=x:BTC&min=1', 'inst=x:BTC&min=1&step=0',
      `inst=x:BTC&min=1&step=1&from=${to}&to=${from}`, `inst=x:BTC&min=1&step=1&from=${to - 9 * 24 * HOUR}&to=${to}`]) {
      assert.equal((await get(query)).status, 400, query);
    }
  } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('only a well-formed column answer is taken', () => {
  const good = { from: T0, to: T0 + MIN, instruments: [{ id: 'a:BTC', step: 1, minutes: 0, first: null, earliest: null, rows: [[100, 5, 0]] }], incomplete: ['a:BTC'], cut: [] };
  assert.deepEqual(parseAbsorptionProfile(good, ['a:BTC']), good);
  for (const bad of [{ ...good, incomplete: ['z:BTC'] }, { ...good, cut: 'a:BTC' }, { ...good, incomplete: undefined }, { ...good, instruments: [{ ...good.instruments[0]!, rows: [[100, -5, 0]] }] }, { ...good, instruments: [{ ...good.instruments[0]!, id: 'z:BTC' }] }, null]) {
    assert.equal(parseAbsorptionProfile(bad, ['a:BTC']), null, JSON.stringify(bad));
  }
});

test('a server from before the route is asked for the largest groups and they are added up in the page', async () => {
  const realFetch = globalThis.fetch, asked: string[] = [];
  const g = (price: number, usd: number): AbsorptionGroup => ({ id: 'a:BTC', side: 'buy', price, t0: T0 + 1, steps: [[usd, usd, 1, T0 + 1, T0 + 1]] });
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    if (url.startsWith('/api/v2/absorption-profile')) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify({ groups: [g(100, 90_000), g(101, 70_000)], floors: { 'a:BTC': 25_000 }, minutes: [], capped: ['a:BTC'] }), { status: 200 });
  }) as typeof fetch;
  try {
    const answer = await getAbsorptionProfile(['a:BTC'], [60_000.5], T0, T0 + MIN, 1);
    assert.deepEqual(answer.instruments.map(i => i.rows), [[[100, 0, 90_000], [101, 0, 70_000]]]);
    assert.deepEqual([answer.cut, answer.incomplete], [['a:BTC'], []]);
    assert.match(asked[0]!, /min=60000\.5&from=/, 'the threshold as it is');
    assert.match(asked[1]!, /^\/api\/v2\/absorption\?inst=a%3ABTC&min=60000&.*&limit=4000&since=\d+$/);
    const since = Number(/since=(\d+)/.exec(asked[1]!)![1]);
    assert.ok(since >= Date.now() - 2 * MIN, 'the minutes of the last minute, not of everything after the window');
  } finally { globalThis.fetch = realFetch; }
});

test('the hub asks the column of the source, every group of the window, and only the minutes when the marks are off', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const profiles: { ids: string[]; thresholds: number[]; from: number; to: number; step: number; settle: (a: AbsorptionProfileAnswer) => void }[] = [];
  const histories: { ids: string[]; mins: number[]; from: number; to: number; limit: number; since: number; settle: () => void }[] = [];
  const source = {
    absorptionProfile: (ids: string[], thresholds: number[], from: number, to: number, step: number) => new Promise<AbsorptionProfileAnswer>(resolve => { profiles.push({ ids, thresholds, from, to, step, settle: resolve }); }),
    absorption: (ids: string[], mins: number[], from: number, to: number, limit: number, since: number) => new Promise(resolve => { histories.push({ ids, mins, from, to, limit, since, settle: () => resolve({ groups: [], floors: {}, minutes: [], capped: [] }) }); }),
  };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; let clock = T0 + 30 * MIN + 30_000; Date.now = () => clock;
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    hub.ensureMetricProfile('absorption', ['a:BTC', 'b:BTC', 'c:BTC'], T0, T0 + 30 * MIN, 5, false, { tag: '', settled: true }, new Map([['a:BTC', 123_456.7], ['b:BTC', null], ['c:BTC', 40_000]]));
    assert.equal(profiles.length, 1);
    assert.deepEqual([profiles[0]!.ids, profiles[0]!.thresholds, profiles[0]!.step], [['a:BTC', 'c:BTC'], [123_456.7, 40_000], 5], 'the instruments with a threshold, at it exactly');
    profiles[0]!.settle({ from: T0, to: T0 + 30 * MIN, instruments: [{ id: 'a:BTC', step: 5, minutes: 0, first: null, earliest: null, rows: [[100, 1, 2]] }], incomplete: ['c:BTC'], cut: [] });
    await turn();
    const held = hub.metricProfile('absorption')!;
    assert.deepEqual([held.answer.instruments[0]!.rows, held.flags], [[[100, 1, 2]], { cut: false, incomplete: true }]);
    // The marks off: only the minutes of the threshold's span are asked for, once, and no group.
    hub.ensureAbsorption(['a:BTC'], [null], { t0: clock - 3 * HOUR, t1: clock, p0: 0, p1: 1 } as never, 30, true);
    assert.equal(histories.length, 1);
    const stats = histories[0]!;
    assert.deepEqual([stats.mins, stats.to - stats.from, stats.since], [[Number.MAX_SAFE_INTEGER], MIN, Math.floor(clock / MIN) * MIN - 31 * MIN]);
    stats.settle(); await turn();
    hub.ensureAbsorption(['a:BTC'], [null], { t0: clock - 3 * HOUR, t1: clock, p0: 0, p1: 1 } as never, 30, true);
    clock += 5 * MIN; hub.ensureAbsorption(['a:BTC'], [null], { t0: clock - 3 * HOUR, t1: clock, p0: 0, p1: 1 } as never, 30, true);
    assert.equal(histories.length, 1, 'the stream brings the minutes from there on');
    hub.ensureAbsorption(['a:BTC'], [null], { t0: clock - 3 * HOUR, t1: clock, p0: 0, p1: 1 } as never, 120, true);
    assert.equal(histories.length, 2, 'a longer span asks again');
    assert.equal(histories[1]!.since, Math.floor(clock / MIN) * MIN - 121 * MIN);
  } finally { Date.now = realNow; }
});
