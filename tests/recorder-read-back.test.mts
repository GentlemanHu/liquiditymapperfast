import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthRecorder, COLUMN_MS, SAMPLE_MS, type Column, type ColumnStore } from '../src/server/v2/recorder.mts';
import type { ValuedBook, SideLevels } from '../src/server/v2/levels.mts';
import { FootprintRecorder, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';

/**
 * A server reads back what it does not hold in memory (`memoryMs`): the depth columns and the footprint rows older than that come from its
 * store when a question reaches them. These tests hold a recorder that keeps everything in memory beside one that reads back, over the same
 * store, and check that every answer is the same; and that what is written into a minute only the store holds keeps all of that minute.
 */

const MIN = COLUMN_MS, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Math.floor(Date.UTC(2026, 9, 1, 0, 0) / DAY) * DAY;

let seed = 7;
const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };

/** A column store in memory that reads back, and counts how often it was asked. */
class MemoryColumnStore implements ColumnStore {
  readonly rows = new Map<string, { id: string; column: Column; step: number }>();
  reads = 0; rowsRead = 0; failing = false; failingExtent = false;
  load(since: number) { return [...this.rows.values()].filter(r => r.column.t >= since).sort((a, b) => a.id.localeCompare(b.id) || a.column.t - b.column.t).map(r => ({ instrumentId: r.id, column: r.column, step: r.step })); }
  save(id: string, column: Column, step: number): void { if (this.failing) throw new Error('disk full'); this.rows.set(`${id}|${column.t}`, { id, column, step }); }
  prune(before: number): void { for (const [key, r] of this.rows) if (r.column.t < before) this.rows.delete(key); }
  range(id: string, from: number, to: number): Column[] {
    this.reads++;
    const out = [...this.rows.values()].filter(r => r.id === id && r.column.t >= from && r.column.t < to).map(r => r.column).sort((a, b) => a.t - b.t);
    this.rowsRead += out.length; return out;
  }
  extent(since: number) {
    if (this.failingExtent) throw new Error('read failed');
    const out = new Map<string, { first: number; last: number; step: number }>();
    for (const r of [...this.rows.values()].sort((a, b) => a.column.t - b.column.t)) {
      if (r.column.t < since) continue;
      const e = out.get(r.id); if (e) e.last = r.column.t; else out.set(r.id, { first: r.column.t, last: r.column.t, step: r.step });
    }
    return out;
  }
}
/** The same store without reading back: what the browser's is. */
const holdingOnly = (store: MemoryColumnStore): ColumnStore => ({ load: s => store.load(s), save: (i, c, s) => store.save(i, c, s), prune: b => store.prune(b) });

const columnAt = (t: number, base: number): Column => {
  // Bins ascending and distinct, as the recorder writes them.
  const count = 3 + Math.floor(rnd() * 40), bins = new Int32Array(count), bid = new Float32Array(count), ask = new Float32Array(count);
  for (let i = 0, bin = base + Math.floor(rnd() * 10); i < count; i++, bin += 1 + Math.floor(rnd() * 3)) { bins[i] = bin; bid[i] = Math.round(rnd() * 5e5); ask[i] = Math.round(rnd() * 5e5); }
  const column: Column = { t, n: 1 + Math.floor(rnd() * 12), bins, bid, ask };
  if (rnd() < 0.7) { column.lt = Float32Array.from({ length: LT_LENGTH }, () => Math.round(rnd() * 1e6)); column.ltN = column.n; }
  return column;
};

test('reading depth back gives every answer that holding the week gave, across the edge of what memory holds and with a minute open, and asked again all the questions together read back at most two hours of columns each', () => {
  seed = 7;
  const NOW = T0 + 3 * DAY + 17 * MIN, store = new MemoryColumnStore();
  // Two instruments over three days, the second sparse (a minute in five), and a gap of an hour in the first.
  for (let t = T0; t < NOW - MIN; t += MIN) {
    if (!(t >= T0 + 30 * HOUR && t < T0 + 31 * HOUR)) store.save('a:BTC', columnAt(t, 4_000), 20);
    if (Math.floor(t / MIN) % 5 === 0) store.save('b:BTC', columnAt(t, 4_100), 20);
  }
  const now = () => NOW;
  const all = new DepthRecorder({ store: holdingOnly(store), now, retentionMs: 7 * DAY });
  const back = new DepthRecorder({ store, now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  assert.ok((back.columns.get('a:BTC')?.length ?? 0) <= 6 * 60 + 1, 'memory holds six hours');
  assert.deepEqual(back.coverage(), all.coverage(), 'first and last minute, from the store');
  assert.deepEqual([...back.steps], [...all.steps]);
  // The minute under way, open in both.
  const levels = (usd: number): SideLevels => ({ lo: Float64Array.of(85_000), hi: Float64Array.of(85_000), usd: Float64Array.of(usd) });
  for (const recorder of [all, back]) recorder.sample([{ instrumentId: 'a:BTC', venue: 'a', timestamp: NOW, coarse: false, bids: levels(70_000), asks: levels(40_000) }], NOW);
  const windows: [number, number, number][] = [
    [NOW - 2 * HOUR, NOW + MIN, MIN], [NOW - 9 * HOUR, NOW - 3 * HOUR, MIN], [T0 + 29 * HOUR + 13 * MIN, T0 + 33 * HOUR, 2 * MIN],
    [T0, NOW + MIN, 16 * MIN], [T0 - DAY, NOW + 2 * DAY, 64 * MIN], [T0 + 5 * HOUR + 7 * MIN, NOW - 7 * MIN, 4 * MIN], [NOW + HOUR, NOW + 2 * HOUR, 8 * MIN],
  ];
  for (const round of [1, 2]) for (const [from, to, step] of windows) for (const id of ['a:BTC', 'b:BTC']) {
    assert.deepEqual(back.query(id, from, to, step), all.query(id, from, to, step), `round ${round}, ${id}, ${(from - T0) / MIN}..${(to - T0) / MIN} min at ${step / MIN}`);
  }
  // Asked again, the hours read back and the windows merged answer without the store: only the hour that reaches into what memory holds is
  // read again (it is not kept, since its minutes in memory leave for the store later), at most an hour's columns a question.
  const rows = store.rowsRead;
  for (const [from, to, step] of windows) for (const id of ['a:BTC', 'b:BTC']) back.query(id, from, to, step);
  assert.ok(store.rowsRead - rows <= windows.length * 2 * 60, `asked again, ${store.rowsRead - rows} columns read`);
  const reads = store.reads;
  for (const id of ['a:BTC', 'b:BTC']) back.query(id, T0, T0 + DAY, 4 * MIN);
  assert.equal(store.reads, reads, 'a day wholly before what memory holds is answered without the store');
});

test('the step an instrument was recorded on is that of its oldest minute in the retention, held in memory or not', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryColumnStore();
  store.save('x:ETH', columnAt(T0 + HOUR, 300), 0.5);
  store.save('x:ETH', columnAt(NOW - HOUR, 300), 1);
  const back = new DepthRecorder({ store, now: () => NOW, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => NOW, retentionMs: 7 * DAY });
  assert.equal(back.steps.get('x:ETH'), 0.5);
  assert.equal(all.steps.get('x:ETH'), 0.5);
});

const side = (rows: [number, number][]): SideLevels => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[0])), usd: Float64Array.from(rows.map(r => r[1])) });
const book = (t: number, usd: number): ValuedBook => ({ instrumentId: 'x:BTC', venue: 'x', timestamp: t, coarse: false, bids: side([[85_000, usd]]), asks: side([[85_100, usd / 2]]) });

test('a depth column leaves memory only once the store has it, and a minute reopened after a restart keeps its samples', () => {
  const store = new MemoryColumnStore();
  let now = T0;
  const recorder = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  recorder.steps.set('x:BTC', 20);
  // Twenty minutes recorded while the store refuses every column: they stay in memory past the ten held, and answer as ever.
  store.failing = true;
  for (let m = 0; m <= 20; m++) { now = T0 + m * MIN; recorder.sample([book(now, 1_000 + m)], now); }
  recorder.prune(now);
  assert.equal(recorder.columns.get('x:BTC')!.length, 20, 'none the store has not taken is let go');
  assert.equal(recorder.query('x:BTC', T0, T0 + 5 * MIN).length, 5);
  // The store takes them with the next column; then the older ones go, and the store answers for them.
  store.failing = false;
  now = T0 + 21 * MIN; recorder.sample([book(now, 9)], now);
  recorder.prune(now);
  assert.ok(recorder.columns.get('x:BTC')![0]!.t >= now - 10 * MIN, 'memory holds ten minutes again');
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + 5 * MIN).map(c => [c.t, c.n, c.bid[0]]), [0, 1, 2, 3, 4].map(m => [T0 + m * MIN, 1, 1_000 + m]));
  // A restart within a minute: the column written as the process went away is reopened and the minute goes on counting its samples.
  now = T0 + 22 * MIN + 10_000; recorder.sample([book(now, 50)], now); recorder.flush();
  const again = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  now += SAMPLE_MS; again.sample([book(now, 150)], now);
  const open = again.query('x:BTC', T0 + 22 * MIN, T0 + 23 * MIN);
  assert.deepEqual([open.length, open[0]!.n, open[0]!.bid[0]], [1, 2, 100], 'two samples, the mean of 50 and 150');
});

test('columns a failing store never took, let go of by its retry queue, stay in memory until the retention passes them', () => {
  const store = new MemoryColumnStore();
  let now = T0;
  const recorder = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  recorder.steps.set('x:BTC', 20);
  // 5,050 minutes refused: the queue keeps the newest 5,000 for another try and lets the first 50 go.
  store.failing = true;
  for (let m = 0; m <= 5_050; m++) { now = T0 + m * MIN; recorder.sample([book(now, 1_000 + m)], now); }
  store.failing = false;
  now = T0 + 5_051 * MIN; recorder.sample([book(now, 9)], now);
  assert.equal(store.rows.size, 5_001, 'the store took the queue and the new column, never the first 50');
  recorder.prune(now);
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + HOUR).map(c => [c.t, c.bid[0]]), Array.from({ length: 60 }, (_, m) => [T0 + m * MIN, 1_000 + m]), 'the first hour, the 50 only memory has included');
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + HOUR, 4 * MIN).length, 15);
  // Once the retention has passed them, memory holds what it holds otherwise and the store answers the rest.
  now = T0 + 50 * MIN + 7 * DAY; recorder.prune(now);
  assert.equal(recorder.columns.get('x:BTC')!.length, 0);
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + HOUR).map(c => c.t), Array.from({ length: 10 }, (_, m) => T0 + (50 + m) * MIN));
});

test('a minute reopened after a restart, the only one in memory, is not read from the store beside its open self', () => {
  // Older minutes only in the store, then nothing for hours, then a restart within a minute: the reopened minute is all memory holds.
  const store = new MemoryColumnStore();
  for (let t = T0; t < T0 + 2 * HOUR; t += MIN) store.save('x:BTC', columnAt(t, 4_200), 20);
  let now = T0 + 5 * HOUR + 10_000;
  const before = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  before.sample([book(now, 50)], now); before.flush();
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 10 * MIN });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => now, retentionMs: 7 * DAY });
  now += SAMPLE_MS; back.sample([book(now, 150)], now); all.sample([book(now, 150)], now);
  assert.equal(back.columns.get('x:BTC')?.length ?? 0, 0, 'the reopened minute is the only one, and it is open');
  for (const step of [MIN, 4 * MIN, 64 * MIN]) assert.deepEqual(back.query('x:BTC', T0, now + MIN, step), all.query('x:BTC', T0, now + MIN, step), `at ${step / MIN} min`);
  const open = back.query('x:BTC', T0 + 5 * HOUR, T0 + 5 * HOUR + MIN);
  assert.deepEqual([open.length, open[0]!.n, open[0]!.bid[0]], [1, 2, 100], 'one column: two samples, the mean of 50 and 150');
});

test('memory holds whole minutes: a restart within a minute reopens it even when memoryMs is shorter than a minute', () => {
  const store = new MemoryColumnStore(), M = T0 + 3 * HOUR;
  // A restart 45 s into the minute, with 30 s held: memory begins at the minute's start, so its column is loaded and reopened.
  let now = M + 10_000;
  const first = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 30_000 });
  first.sample([book(now, 50)], now); first.flush();
  now = M + 45_000;
  const again = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 30_000 });
  now = M + 50_000; again.sample([book(now, 150)], now);
  const open = again.query('x:BTC', M, M + MIN);
  assert.deepEqual([open.length, open[0]!.n, open[0]!.bid[0]], [1, 2, 100], 'two samples, the mean of 50 and 150');
  // Without a restart: a flush within the minute, then a prune 45 s into it, then the next sample.
  const store2 = new MemoryColumnStore(), M2 = M + HOUR;
  now = M2 + 10_000;
  const live = new DepthRecorder({ store: store2, now: () => now, retentionMs: 7 * DAY, memoryMs: 30_000 });
  live.sample([book(now, 50)], now); live.flush();
  now = M2 + 45_000; live.prune(now);
  now = M2 + 50_000; live.sample([book(now, 150)], now);
  const kept = live.query('x:BTC', M2, M2 + MIN);
  assert.deepEqual([kept.length, kept[0]!.n, kept[0]!.bid[0]], [1, 2, 100]);
});

test('memory begun at a whole minute never reaches before the retention', () => {
  // Memory within a minute of the retention: rounding its start down to the minute must not load a column the retention has passed.
  const store = new MemoryColumnStore();
  for (let t = T0; t < T0 + 10 * MIN; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  const now = T0 + 7 * DAY + 45_000;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 7 * DAY - 1_000 });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => now, retentionMs: 7 * DAY });
  assert.deepEqual(back.coverage(), all.coverage());
  assert.deepEqual(back.query('a:BTC', T0 - HOUR, T0 + HOUR, MIN), all.query('a:BTC', T0 - HOUR, T0 + HOUR, MIN));
  assert.equal(back.query('a:BTC', T0 - HOUR, T0 + HOUR, MIN)[0]!.t, T0 + MIN);
});

test('a prune whose store fails to say what it holds leaves the recorder as it was: coverage and answers agree', () => {
  const store = new MemoryColumnStore();
  for (let t = T0; t < T0 + DAY; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  let now = T0 + DAY;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 2 * DAY, memoryMs: 6 * HOUR });
  now = T0 + 2 * DAY + 3 * HOUR; store.failingExtent = true;
  assert.throws(() => back.prune(now), /read failed/);
  const first = back.query('a:BTC', T0, T0 + DAY, MIN)[0]?.t;
  assert.equal(back.coverage()['a:BTC']!.first, first, 'the first minute it covers is the first it answers');
  store.failingExtent = false; back.prune(now);
  assert.equal(back.coverage()['a:BTC']!.first, T0 + 3 * HOUR);
  assert.equal(back.query('a:BTC', T0, T0 + DAY, MIN)[0]!.t, T0 + 3 * HOUR);
});

test('only what the store holds is read back: nothing for an instrument it never recorded, nothing for a time far past the recording', () => {
  const store = new MemoryColumnStore();
  for (let t = T0; t < T0 + DAY; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  // b's last minute is long before what memory holds, so memory holds none of it.
  for (let t = T0; t < T0 + 6 * HOUR; t += MIN) store.save('b:BTC', columnAt(t, 4_000), 20);
  const now = T0 + DAY + HOUR, back = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const reads = store.reads;
  for (let i = 0; i < 50; i++) assert.deepEqual(back.query(`never:${i}`, T0, now, MIN), []);
  assert.equal(store.reads, reads, 'the store is not asked about instruments it never held');
  assert.equal(back.cacheStats().coldHours, 0, 'and no empty hour is kept for them');
  // Near 4e23 ms an hour added to a time leaves it as it was: this returns at once rather than never.
  for (const id of ['a:BTC', 'b:BTC', 'never:0']) assert.deepEqual(back.query(id, 3.999999999999993e23, 4e23, MIN), []);
  // The hours after an instrument's last minute are neither read nor kept.
  assert.equal(back.query('b:BTC', T0 + 5 * HOUR, now, MIN).length, 60);
  assert.equal(back.cacheStats().coldHours, 1, 'its last hour alone');
});

test('an hour read back is answered whole after memory has let go of more of it', () => {
  // The hour that reaches into what memory holds is read from the store only up to memory; were it kept so, the minutes memory lets go of
  // at the next prune would be missing from it.
  const NOW = T0 + 2 * DAY + 25 * MIN, store = new MemoryColumnStore();
  for (let t = T0; t < NOW; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  let now = NOW;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const all = new DepthRecorder({ store: holdingOnly(store), now: () => now, retentionMs: 7 * DAY });
  const window: [number, number] = [NOW - 9 * HOUR, NOW - 2 * HOUR];
  assert.deepEqual(back.query('a:BTC', ...window, MIN), all.query('a:BTC', ...window, MIN));
  now = NOW + 3 * HOUR; back.prune(now); all.prune(now);
  assert.deepEqual(back.query('a:BTC', ...window, MIN).map(c => c.t), all.query('a:BTC', ...window, MIN).map(c => c.t), 'every minute of the window, after memory let go of three more hours');
  assert.deepEqual(back.query('a:BTC', ...window, 4 * MIN), all.query('a:BTC', ...window, 4 * MIN));
});

test('prune moves the first minute on and lets go of the hours read back before it', () => {
  const NOW = T0 + 3 * DAY, store = new MemoryColumnStore();
  for (let t = T0; t < NOW; t += 10 * MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  let now = NOW;
  const back = new DepthRecorder({ store, now: () => now, retentionMs: 2 * DAY, memoryMs: 6 * HOUR });
  assert.equal(back.coverage()['a:BTC']!.first, T0 + DAY, 'the store from the retention on');
  assert.ok(back.query('a:BTC', T0, NOW, 16 * MIN).length > 0);
  now = NOW + 12 * HOUR; back.prune(now);
  assert.equal(back.coverage()['a:BTC']!.first, T0 + DAY + 12 * HOUR);
  assert.deepEqual(back.query('a:BTC', T0, T0 + DAY + 12 * HOUR, MIN), [], 'nothing before the retention, kept or stored');
});

/** A footprint store in memory that reads back; rows are kept as written (copied), and saving can be made to fail. */
class MemoryFootprintStore implements FootprintStore {
  readonly rows = new Map<string, FootprintMinuteRow>();
  failing = false; failingReads = false; reads = 0;
  load(since: number): FootprintMinuteRow[] { return [...this.rows.values()].filter(r => r.t >= since).sort((a, b) => a.inst.localeCompare(b.inst) || a.t - b.t).map(r => structuredClone(r)); }
  save(rows: FootprintMinuteRow[], expireBefore: number): void {
    if (this.failing) throw new Error('disk full');
    for (const row of rows) this.rows.set(`${row.inst}|${row.t}`, structuredClone(row));
    for (const [key, row] of this.rows) if (row.t < expireBefore) this.rows.delete(key);
  }
  close(): void {}
  range(inst: string, from: number, to: number): FootprintMinuteRow[] { if (this.failingReads) throw new Error('read failed'); this.reads++; return [...this.rows.values()].filter(r => r.inst === inst && r.t >= from && r.t < to).sort((a, b) => a.t - b.t).map(r => ({ ...structuredClone(r), stats: null })); }
}
const holdingRows = (store: MemoryFootprintStore): FootprintStore => ({ load: s => store.load(s), save: (r, e) => store.save(r, e), close: () => {} });

/** Two days of trades on two instruments, recorded by a recorder that writes them to `store` (orders counted by price from the start). */
function recordTrades(store: MemoryFootprintStore, end: number): void {
  seed = 11;
  let now = T0;
  const writer = new FootprintRecorder(store, () => now, 7 * DAY);
  let id = 0;
  for (let t = T0; t < end; t += 90_000) {
    now = t;
    for (const inst of ['a:BTC', 'b:BTC']) {
      const price = 84_000 + Math.round(rnd() * 400) / 2, usd = 1_000 + Math.round(rnd() * 400_000), side = rnd() < 0.5 ? 'buy' : 'sell';
      writer.ingest([{ instrumentId: inst, tradeId: `t${id}`, side, price, notionalUsd: usd, sourceTimestamp: t }]);
      writer.countOrders([{ instrumentId: inst, side: side as 'buy' | 'sell', t, usd, price }]);
      id++;
    }
    if (t % (20 * MIN) === 0) writer.flush();
  }
  now = end; writer.flush(true);
}

test('reading footprint rows back gives every answer that holding the week gave', () => {
  const NOW = T0 + 2 * DAY + 7 * MIN, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const now = () => NOW, ids = ['a:BTC', 'b:BTC'];
  const all = new FootprintRecorder(holdingRows(store), now, 7 * DAY), back = new FootprintRecorder(store, now, 7 * DAY, 1, 6 * HOUR);
  assert.deepEqual([...back.instruments].sort(), [...all.instruments].sort());
  for (const id of ids) assert.deepEqual([back.lastMinute(id), back.step(id)], [all.lastMinute(id), all.step(id)]);
  for (const round of [1, 2]) {
    for (const [from, to] of [[NOW - 3 * HOUR, NOW + MIN], [NOW - 9 * HOUR, NOW - 3 * HOUR], [T0 + 13 * MIN, NOW], [T0 - DAY, T0 + 30 * HOUR + 3 * MIN]]) {
      for (const id of ids) assert.deepEqual(back.query(id, from!, to!, 15 * MIN, 10, [50_000]), all.query(id, from!, to!, 15 * MIN, 10, [50_000]), `round ${round} bars ${id}`);
      assert.deepEqual(back.profile(ids, from!, to!, 10), all.profile(ids, from!, to!, 10), `round ${round} profile`);
      assert.deepEqual(back.range(ids, from!, to!, null, 20), all.range(ids, from!, to!, null, 20), `round ${round} range`);
      assert.deepEqual(back.range(ids, from!, to!, { p0: 84_050, p1: 84_120 }, 5), all.range(ids, from!, to!, { p0: 84_050, p1: 84_120 }, 5), `round ${round} box`);
    }
    const days = [{ from: T0, to: T0 + DAY }, { from: T0 + DAY, to: T0 + 2 * DAY }, { from: T0 + 2 * DAY, to: T0 + 3 * DAY }];
    assert.deepEqual(back.valueAreas(ids, days, 10, 0.7), all.valueAreas(ids, days, 10, 0.7), `round ${round} value areas`);
    assert.deepEqual(back.sizes(ids, [60, 1_440], [50_000]), all.sizes(ids, [60, 1_440], [50_000]), `round ${round} sizes`);
  }
});

test('a late trade or order into a minute only the store holds is written with all of that minute, and is not answered from a kept hour', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 10 * HOUR + 3 * MIN, before = structuredClone(store.rows.get(`a:BTC|${minute}`)!);
  assert.ok(before.bins.every(b => b.length === 5), 'a minute that counts orders by price');
  const sum = (row: FootprintMinuteRow, at: number) => row.bins.reduce((s, b) => s + (b[at] ?? 0), 0);
  const volume = (row: FootprintMinuteRow) => sum(row, 1) + sum(row, 2), orders = (row: FootprintMinuteRow) => sum(row, 3) + sum(row, 4);
  const traded = () => { const a = back.range(['a:BTC'], minute, minute + MIN, null, 20).instruments[0]!.band; return a.buy + a.sell; };
  assert.ok(volume(before) > 0 && orders(before) > 0);
  // The hour is read back (and kept) first, as a question would.
  assert.ok(Math.abs(traded() - volume(before)) < 1e-6);
  // A late trade of $123,456 bought at a new price, and an order begun there; then the minute is written and memory lets it go.
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'late', side: 'buy', price: 85_555, notionalUsd: 123_456, sourceTimestamp: minute + 30_000 }]);
  back.countOrders([{ instrumentId: 'a:BTC', side: 'buy', t: minute + 30_000, usd: 123_456, price: 85_555 }]);
  // Asked before it is written: answered from memory (the hour may be read back and kept again meanwhile, with the minute as it was).
  assert.ok(Math.abs(traded() - volume(before) - 123_456) < 1e-6, 'the old volume and the new, before it is written');
  back.range(['a:BTC'], minute - HOUR, minute + HOUR, null, 20);
  back.flush();
  const after = store.rows.get(`a:BTC|${minute}`)!;
  assert.ok(Math.abs(volume(after) - volume(before) - 123_456) < 1e-6, 'the old volume and the new, written');
  assert.ok(after.bins.every(b => b.length === 5), 'still counted by price');
  assert.equal(orders(after), orders(before) + 1, 'the orders counted before, and the new one');
  assert.equal(after.stats!.buyN, before.stats!.buyN + 1);
  // Asked again, the minute is answered as it is now, not as the kept hour had it.
  assert.ok(Math.abs(traded() - volume(after)) < 1e-6);
});

test('a Range box over prices no minute traded at reads no rows back, and answers as holding the week did', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const ids = ['a:BTC', 'b:BTC'], now = () => NOW;
  const back = new FootprintRecorder(store, now, 7 * DAY, 1, 6 * HOUR), all = new FootprintRecorder(holdingRows(store), now, 7 * DAY);
  const reads = store.reads, box = { p0: 90_000, p1: 90_500 };
  const answer = back.range(ids, T0 + 3 * HOUR, T0 + 30 * HOUR, box, 5);
  assert.equal(store.reads, reads, 'nothing read back');
  assert.deepEqual(answer, all.range(ids, T0 + 3 * HOUR, T0 + 30 * HOUR, box, 5));
  assert.ok(answer.instruments.every(i => i.minutes > 0 && i.band.buy === 0), 'minutes counted, nothing in the band');
});

test('an order alone into a minute only the store holds is written with all of that minute', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 11 * HOUR + 7 * MIN, before = structuredClone(store.rows.get(`b:BTC|${minute}`)!);
  const cells = (row: FootprintMinuteRow) => row.bins.map(b => [b[0], b[1], b[2]]), orders = (row: FootprintMinuteRow) => row.bins.reduce((s, b) => s + (b[3] ?? 0) + (b[4] ?? 0), 0);
  // An order begun at a price the minute traded at (its lowest row): no fill comes with it.
  const price = Math.min(...before.bins.map(b => b[0])) * (before.step);
  back.countOrders([{ instrumentId: 'b:BTC', side: 'buy', t: minute + 20_000, usd: 70_000, price }]);
  back.flush();
  const after = store.rows.get(`b:BTC|${minute}`)!;
  assert.deepEqual(cells(after), cells(before), 'every row of the minute, as it was');
  assert.equal(orders(after), orders(before) + 1, 'and the order counted in one of them');
  assert.equal(after.stats!.buyN, before.stats!.buyN + 1);
});

test('a store that fails to read a minute back keeps the fill and the order for the next time, each taken once, neither half counted', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 9 * HOUR + 40 * MIN, before = structuredClone(store.rows.get(`a:BTC|${minute}`)!);
  const volume = (row: FootprintMinuteRow) => row.bins.reduce((s, b) => s + b[1]! + b[2]!, 0);
  const trade = { instrumentId: 'a:BTC', tradeId: 'retry', side: 'sell', price: 84_100, notionalUsd: 30_000, sourceTimestamp: minute + 1_000 };
  const order = { instrumentId: 'a:BTC', side: 'sell' as const, t: minute + 1_000, usd: 30_000, price: 84_100 };
  // A connector's fill, which comes once, into another cold minute.
  const once = { ...trade, tradeId: 'once', sourceTimestamp: minute - 3 * MIN + 2_000 }, other = minute - 3 * MIN, otherBefore = structuredClone(store.rows.get(`a:BTC|${other}`)!);
  store.failingReads = true;
  assert.equal(back.ingest([trade, once]), 0, 'neither taken yet');
  assert.equal(back.ingest([trade]), 0, 'nor while the store still fails');
  back.countOrders([order]);
  store.failingReads = false;
  // The feed hands its recent trades over again on every pass: the fill kept is taken first and its copy is seen. The connector's comes
  // with the next ones. The order, which the server's builder gives once, was kept and is counted with the next orders.
  assert.equal(back.ingest([trade]), 2);
  assert.equal(back.ingest([trade, once]), 0);
  back.countOrders([]);
  back.flush();
  const after = store.rows.get(`a:BTC|${minute}`)!;
  assert.ok(Math.abs(volume(after) - volume(before) - 30_000) < 1e-6, 'the fill once');
  assert.ok(Math.abs(volume(store.rows.get(`a:BTC|${other}`)!) - volume(otherBefore) - 30_000) < 1e-6, "the connector's fill once");
  assert.equal(after.stats!.sellN, before.stats!.sellN + 1, 'the order once');
});

test('fills kept while the store cannot read are kept once each: the feed handing them over again does not crowd out a connector trade', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  const feedMinute = T0 + 9 * HOUR + 4 * MIN, oneMinute = T0 + 9 * HOUR + 10 * MIN;
  const volume = (t: number) => store.rows.get(`a:BTC|${t}`)!.bins.reduce((s, b) => s + b[1]! + b[2]!, 0);
  const feedBefore = volume(feedMinute), oneBefore = volume(oneMinute);
  const feed = Array.from({ length: 1_000 }, (_, i) => ({ instrumentId: 'a:BTC', tradeId: `feed-${i}`, side: 'buy', price: 84_100, notionalUsd: 1, sourceTimestamp: feedMinute + i }));
  const one = { instrumentId: 'a:BTC', tradeId: 'connector', side: 'sell', price: 84_100, notionalUsd: 30_000, sourceTimestamp: oneMinute + 1_000 };
  store.failingReads = true;
  // 51 passes of the same 1,000 recent trades: more copies than the 50,000 kept, were each copy kept.
  for (let pass = 0; pass < 51; pass++) back.ingest(feed);
  back.ingest([one]);
  store.failingReads = false;
  assert.equal(back.ingest(feed), 1_001, 'the 1,000 and the connector trade, once each');
  back.flush();
  assert.ok(Math.abs(volume(feedMinute) - feedBefore - 1_000) < 1e-6);
  assert.ok(Math.abs(volume(oneMinute) - oneBefore - 30_000) < 1e-6);
});

test('an order waits while a fill waits, so it is counted in the row of its own price', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 7 * HOUR + 4 * MIN, price = 86_000;
  const fill = { instrumentId: 'a:BTC', tradeId: 'new-price', side: 'buy', price, notionalUsd: 20_000, sourceTimestamp: minute + 1_000 };
  store.failingReads = true;
  assert.equal(back.ingest([fill]), 0);
  store.failingReads = false;
  // The order arrives before the fill is taken (the store has recovered, but no fill has come since): it waits.
  back.countOrders([{ instrumentId: 'a:BTC', side: 'buy', t: minute + 1_000, usd: 20_000, price }]);
  assert.equal(back.ingest([]), 1);
  back.countOrders([]);
  back.flush();
  const row = store.rows.get(`a:BTC|${minute}`)!, step = row.step;
  const at = row.bins.find(b => Math.abs(b[0]! * step - price) < step)!;
  assert.ok(at, 'the new price has its row');
  assert.equal(at[3], 1, 'and the order is counted in it');
});

test('what waits is taken at close when the store has recovered; a waiting fill whose minute the retention passed is let go', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 7 * HOUR + 10 * MIN, before = structuredClone(store.rows.get(`a:BTC|${minute}`)!);
  const volume = (row: FootprintMinuteRow) => row.bins.reduce((s, b) => s + b[1]! + b[2]!, 0);
  store.failingReads = true;
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'at-close', side: 'sell', price: 84_100, notionalUsd: 10_000, sourceTimestamp: minute + 1_000 }]);
  back.countOrders([{ instrumentId: 'a:BTC', side: 'sell', t: minute + 1_000, usd: 10_000, price: 84_100 }]);
  store.failingReads = false;
  back.close();
  const after = store.rows.get(`a:BTC|${minute}`)!;
  assert.ok(Math.abs(volume(after) - volume(before) - 10_000) < 1e-6, 'the fill');
  assert.equal(after.stats!.sellN, before.stats!.sellN + 1, 'and the order');
  // A fill that waits until the retention has passed its minute is let go with the minute.
  const old = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR), early = T0 + 3 * MIN;
  store.failingReads = true;
  assert.equal(old.ingest([{ instrumentId: 'b:BTC', tradeId: 'expired', side: 'buy', price: 84_100, notionalUsd: 5_000, sourceTimestamp: early + 1_000 }]), 0);
  store.failingReads = false;
  now = early + 7 * DAY + MIN; old.flush();
  assert.equal(old.ingest([]), 0);
  // Nor does a copy handed over again bring it back: it counts as seen, as it would had it been taken before the minute expired.
  assert.equal(old.ingest([{ instrumentId: 'b:BTC', tradeId: 'expired', side: 'buy', price: 84_100, notionalUsd: 5_000, sourceTimestamp: early + 1_000 }]), 0);
  assert.deepEqual(old.range(['b:BTC'], early, early + MIN, null, 20).instruments[0]!.minutes, 0, 'the expired minute stays gone');
});

test('a batch of orders whose cold minute cannot be read is kept whole and counted with the next orders, each once', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  // A: a minute in memory (the last hour); B: one only the store holds.
  const hot = NOW - HOUR + MIN, cold = T0 + 8 * HOUR + MIN, buys = (t: number) => back.sizes(['a:BTC'], [Math.ceil((NOW - t) / MIN) + 1]).windows[0]!.buyN;
  const statsOf = (t: number) => store.rows.get(`a:BTC|${t}`)!.stats!;
  const hotBefore = buys(hot), coldBefore = statsOf(cold).buyN;
  const batch = [{ instrumentId: 'a:BTC', side: 'buy' as const, t: hot + 1_000, usd: 40_000, price: 84_100 }, { instrumentId: 'a:BTC', side: 'buy' as const, t: cold + 1_000, usd: 40_000, price: 84_100 }];
  store.failingReads = true;
  back.countOrders(batch);
  assert.equal(buys(hot), hotBefore, 'A not counted yet either');
  back.countOrders([]);
  assert.equal(buys(hot), hotBefore, 'nor while the store still fails');
  store.failingReads = false;
  back.countOrders([]);
  back.flush(true);
  assert.equal(buys(hot), hotBefore + 1, 'A once');
  assert.equal(statsOf(cold).buyN, coldBefore + 1, 'B once');
});

test('minutes past the retention are not read back when the store fails to write and so keeps them', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const ids = ['a:BTC', 'b:BTC'];
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR), all = new FootprintRecorder(holdingRows(store), () => now, 7 * DAY);
  const ask = (recorder: FootprintRecorder) => [recorder.query('a:BTC', T0, T0 + 12 * HOUR, 15 * MIN, 10), recorder.profile(ids, T0, T0 + 12 * HOUR, 10), recorder.range(ids, T0, T0 + 12 * HOUR, null, 20), recorder.valueAreas(ids, [{ from: T0, to: T0 + DAY }], 10, 0.7)];
  assert.deepEqual(ask(back), ask(all), 'the hours read back (and kept) first');
  // The retention passes the first ten hours while the store refuses every write, so it still has them.
  now = T0 + 10 * HOUR + 7 * DAY; store.failing = true;
  assert.throws(() => back.flush(), /disk full/); assert.throws(() => all.flush(), /disk full/);
  assert.ok([...store.rows.values()].some(row => row.t < T0 + 10 * HOUR), 'the store kept the expired rows');
  assert.deepEqual(ask(back), ask(all), 'only the two hours inside the retention, kept or read');
});

test('a footprint minute the store has not taken stays in memory past the hours held', () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  let now = NOW;
  const back = new FootprintRecorder(store, () => now, 7 * DAY, 1, 6 * HOUR);
  const minute = T0 + 5 * HOUR;
  const bought = () => { const a = back.range(['a:BTC'], minute, minute + MIN, null, 20).instruments[0]!.band; return a.buy + a.sell; };
  const base = bought();
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'late-2', side: 'buy', price: 84_100, notionalUsd: 50_000, sourceTimestamp: minute + 5_000 }]);
  store.failing = true;
  assert.throws(() => back.flush(), /disk full/);
  now += HOUR; assert.throws(() => back.flush(), /disk full/);
  assert.ok(Math.abs(bought() - base - 50_000) < 1e-6, 'still answered with the late trade');
  store.failing = false; back.flush();
  assert.ok(Math.abs(bought() - base - 50_000) < 1e-6, 'and, once written, from the store');
});

test('bars of whole hours read each ended hour added together, and answer as the minutes added one by one do', async () => {
  const NOW = T0 + 2 * DAY + 7 * MIN, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const ids = ['a:BTC', 'b:BTC'], now = () => NOW;
  const back = new FootprintRecorder(store, now, 7 * DAY, 1, 6 * HOUR), all = new FootprintRecorder(holdingRows(store), now, 7 * DAY);
  for (const tf of [HOUR, 4 * HOUR, DAY]) {
    // The same answer read back or held, asked twice (the second time from the hours held), with the venues apart.
    for (const round of [1, 2]) assert.deepEqual(back.queryMany(ids, T0, NOW + MIN, tf, 10, [50_000], Infinity, true), all.queryMany(ids, T0, NOW + MIN, tf, 10, [50_000], Infinity, true), `${tf / HOUR} h, round ${round}`);
  }
  // Against half-hour bars (minutes added one by one), put together by the hour: the same rows, sums and statistics.
  const hourly = all.queryMany(ids, T0, NOW + MIN, HOUR, 10, [50_000]), halves = all.queryMany(ids, T0, NOW + MIN, 30 * MIN, 10, [50_000]);
  assert.equal(hourly.bars.length, 49);
  for (const bar of hourly.bars) {
    const parts = halves.bars.filter(b => Math.floor(b.t / HOUR) * HOUR === bar.t), rows = new Map<number, [number, number]>();
    for (const p of parts) for (const [price, buy, sell] of p.rows) { const r = rows.get(price) ?? [0, 0]; r[0] += buy; r[1] += sell; rows.set(price, r); }
    assert.deepEqual(bar.rows.map(r => r[0]), [...rows.keys()].sort((a, b) => a - b), 'the same rows');
    for (const [price, buy, sell] of bar.rows) { const r = rows.get(price)!; assert.ok(Math.abs(r[0] - buy) < 1e-6 && Math.abs(r[1] - sell) < 1e-6); }
    assert.equal(bar.minutes, parts.reduce((s, p) => s + (p.minutes ?? 0), 0));
    assert.equal(bar.stats?.buyN, parts.reduce((s, p) => s + (p.stats?.buyN ?? 0), 0));
  }
});

test('an hour held added together lets go when a late trade lands in it, and an hour held costs a question almost nothing', async () => {
  const NOW = T0 + 2 * DAY, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const ids = ['a:BTC', 'b:BTC'], back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  const hour = T0 + 10 * HOUR, volume = () => { const bar = back.queryMany(['a:BTC'], hour, hour + HOUR, HOUR, 10).bars[0]!; return bar.buyUsd + bar.sellUsd; };
  const before = volume();
  back.ingest([{ instrumentId: 'a:BTC', tradeId: 'late', side: 'buy', price: 85_555, notionalUsd: 123_456, sourceTimestamp: hour + 3 * MIN + 30_000 }]);
  assert.ok(Math.abs(volume() - before - 123_456) < 1e-6, 'the late trade is in the hour');
  // Two days of two markets read back cost four a minute: a budget of 5,000 reaches about fifteen hours. Prepared, the hours are held and
  // one question reaches across both days.
  const first = back.queryMany(ids, T0, NOW, HOUR, 10, [], 5_000).from;
  assert.ok(first > T0 + 20 * HOUR, `unprepared, the answer starts later: ${(first - T0) / HOUR} h`);
  await back.prepare(ids, T0, NOW, HOUR, Infinity);
  assert.equal(back.queryMany(ids, T0, NOW, HOUR, 10, [], 5_000).from, T0, 'prepared: one question for both days');
  // A prepare with a budget builds the newest bar whole, then stops at a bar's end.
  const fresh = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR);
  await fresh.prepare(ids, T0, NOW, DAY, 1);
  let reads = store.reads;
  fresh.queryMany(ids, T0 + DAY, NOW, DAY, 10);
  assert.equal(store.reads, reads, 'the newest day was prepared whole: nothing read back for it');
  reads = store.reads;
  fresh.queryMany(ids, T0, T0 + DAY, DAY, 10);
  assert.ok(store.reads > reads, 'and the day before it was not');
});

test('bars without rows (sumsOnly): the same minutes, statistics and size-line sums as with rows, nothing read back, a cold week in one answer', () => {
  const NOW = T0 + 2 * DAY + 7 * MIN, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const ids = ['a:BTC', 'b:BTC'], back = new FootprintRecorder(store, () => NOW, 7 * DAY, 1, 6 * HOUR), all = new FootprintRecorder(holdingRows(store), () => NOW, 7 * DAY);
  for (const tf of [30 * MIN, HOUR, 4 * HOUR]) {
    const reads = store.reads, sums = back.queryMany(ids, T0, NOW + MIN, tf, 10, [50_000], Infinity, true, true), full = all.queryMany(ids, T0, NOW + MIN, tf, 10, [50_000]);
    assert.equal(store.reads, reads, `${tf / MIN} min: nothing read back from the store`);
    assert.equal(sums.venues, undefined, 'no venues: there are no rows to split');
    assert.equal(sums.totals, true, 'the answer says its bars carry their dollars');
    assert.equal(full.totals, undefined, 'one with rows needs not say it');
    assert.deepEqual(sums.bars.map(b => b.t), full.bars.map(b => b.t), `${tf / MIN} min: the same bars`);
    for (const [i, bar] of sums.bars.entries()) {
      const twin = full.bars[i]!;
      assert.deepEqual(bar.rows, [], 'no rows');
      // The minutes' sums, the same additions as the rows' in another order: equal to the last few digits.
      for (const side of ['buyUsd', 'sellUsd'] as const) assert.ok(Math.abs(bar[side] - twin[side]) <= 1e-9 * Math.max(1, twin[side]), `${tf / MIN} min ${side}: ${bar[side]} against ${twin[side]}`);
      assert.ok(twin.buyUsd + twin.sellUsd > 0, 'bars that traded');
      assert.deepEqual([bar.minutes, bar.stats, bar.over], [twin.minutes, twin.stats, twin.over], 'the same minutes, statistics and size-line sums');
    }
  }
  // Two days of two markets cold cost four a minute with rows (about fifteen hours for 5,000); without rows a minute costs a fortieth of one
  // held, so the budget reaches across both days in one answer, and a smaller one slices on whole bars.
  assert.equal(back.queryMany(ids, T0, NOW, HOUR, 10, [], 5_000, false, true).from, T0, 'both days in one answer');
  const sliced = back.queryMany(ids, T0, NOW, HOUR, 10, [], 60, false, true);
  assert.ok(sliced.from > T0 && sliced.from % HOUR === 0, `a small budget slices on whole bars: ${(sliced.from - T0) / HOUR} h`);
  assert.equal(sliced.bars[0]!.t, sliced.from);
});

test('bars without rows count a minute stamped ahead of the recorder\'s clock as the rows do (a page\'s engine on a slow PC clock)', () => {
  const NOW = T0 + 2 * DAY + 7 * MIN, store = new MemoryFootprintStore();
  recordTrades(store, NOW);
  const rec = new FootprintRecorder(holdingRows(store), () => NOW, 7 * DAY);
  for (const [i, ahead] of [90_000, 5 * MIN, 70 * MIN].entries()) rec.ingest([{ instrumentId: 'a:BTC', tradeId: `ahead-${i}`, side: 'buy', price: 85_555, notionalUsd: 50_000, sourceTimestamp: NOW + ahead }]);
  for (const tf of [5 * MIN, HOUR]) {
    const sums = rec.queryMany(['a:BTC', 'b:BTC'], NOW - 3 * HOUR, NOW + 3 * HOUR, tf, 10, [], Infinity, false, true), rows = rec.queryMany(['a:BTC', 'b:BTC'], NOW - 3 * HOUR, NOW + 3 * HOUR, tf, 10);
    assert.deepEqual(sums.bars.map(b => [b.t, b.minutes]), rows.bars.map(b => [b.t, b.minutes]), `${tf / MIN} min: the same bars and minutes`);
    assert.ok(sums.bars.some(b => b.t + tf > NOW + 70 * MIN && b.t <= NOW + 70 * MIN), 'the minute 70 min ahead is in a bar');
    // Budgeted, the walk starts from the newest minute held, so the slice holds it too.
    assert.equal(rec.queryMany(['a:BTC', 'b:BTC'], NOW - 3 * HOUR, NOW + 3 * HOUR, tf, 10, [], 5_000, false, true).bars.at(-1)!.t, rows.bars.at(-1)!.t);
  }
});
