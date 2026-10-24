import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DepthRecorder, COLUMN_MS, KEEP_ALWAYS, MIN_BIN_USD, RETENTION_MS, SAMPLE_MS, accumulateSide, gridStepFor, type Column, type ColumnStore } from '../src/server/v2/recorder.mts';
import { crossedByBp, valueBook, type ValuedBook, type SideLevels } from '../src/server/v2/levels.mts';
import { splitTouch } from '../src/shared/levels.ts';
import { encodeColumns, encodeLevels } from '../src/server/v2/wire.mts';
import { decodeColumns, decodeLevels } from '../src/app/wire.ts';
import { LT_LENGTH, addLtSample, ltIndex } from '../src/shared/lt-sample.ts';
import { packLt } from '../src/shared/columns.ts';
import { aggregateCandles, aggregateOi, withLiveOi } from '../src/server/v2/series.mts';
import { SqliteColumnStore } from '../src/server/v2/store.mts';
import { FootprintRecorder } from '../src/server/v2/footprint.mts';
import { DatabaseSync } from 'node:sqlite';

const side = (rows: [number, number, number][]): SideLevels => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
const book = (id: string, timestamp: number, bids: [number, number, number][], asks: [number, number, number][]): ValuedBook =>
  ({ instrumentId: id, venue: id.split(':')[0]!, timestamp, coarse: false, bids: side(bids), asks: side(asks) });
const T0 = Math.floor(Date.UTC(2026, 9, 4, 12, 0, 0) / COLUMN_MS) * COLUMN_MS;

test('gridStepFor picks a 1-2-5 step near 0.02% of price', () => {
  assert.equal(gridStepFor(85_000), 20);
  assert.equal(gridStepFor(3_000), 0.5);
  assert.equal(gridStepFor(0.5), 0.0001);
});

test('a point level lands wholly in its bin; a band spreads proportionally to overlap', () => {
  const into = new Map<number, number>();
  accumulateSide(side([[105, 105, 10]]), 10, into);
  assert.deepEqual([...into], [[10, 10]]);
  const spread = new Map<number, number>();
  accumulateSide(side([[100, 130, 30]]), 10, spread);
  assert.deepEqual([...spread].map(([bin, usd]) => [bin, Math.round(usd)]), [[10, 10], [11, 10], [12, 10]]);
  const partial = new Map<number, number>();
  accumulateSide(side([[105, 125, 20]]), 10, partial);
  assert.deepEqual([...partial].map(([bin, usd]) => [bin, usd]), [[10, 5], [11, 10], [12, 5]]);
  // 0.0000103 / 2e-9 is 5149.999...: no speck of the band lands in the bin below it (the Liquidity Tracker would take it for the touch).
  const small = new Map<number, number>();
  accumulateSide(side([[0.0000103, 0.0000104, 1_000_000]]), 2e-9, small);
  assert.deepEqual([Math.min(...small.keys()), Math.max(...small.keys()), small.size], [5150, 5199, 50]);
});

test('samples within a minute average over observed samples and commit on rollover', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  const step = 20;
  recorder.steps.set('x:BTC', step);
  recorder.sample([book('x:BTC', T0, [[85_000, 85_000, 100]], [[85_100, 85_100, 50]])], T0);
  recorder.sample([book('x:BTC', T0 + SAMPLE_MS, [[85_000, 85_000, 300]], [])], T0 + SAMPLE_MS);
  assert.equal(recorder.columns.get('x:BTC')?.length ?? 0, 0, 'open minute is not committed yet');
  const open = recorder.query('x:BTC', T0, T0 + COLUMN_MS);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.n, 2);
  const bidBin = Math.floor(85_000 / step);
  assert.equal(open[0]!.bid[open[0]!.bins.indexOf(bidBin)], 200);
  assert.equal(open[0]!.ask[open[0]!.bins.indexOf(Math.floor(85_100 / step))], 25);
  recorder.sample([book('x:BTC', T0 + COLUMN_MS, [[85_000, 85_000, 10]], [])], T0 + COLUMN_MS);
  assert.equal(recorder.columns.get('x:BTC')!.length, 1);
  assert.equal(recorder.columns.get('x:BTC')![0]!.t, T0);
});

test('the Liquidity Tracker is kept per minute, measured at each sample from that sample own touch, and windows average it by samples', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 20);
  // Two samples whose touch moved: measured at each sample the touch level counts in full both times; a minute average book would smear it.
  const first = book('x:BTC', T0, [[85_000, 85_000, 1_000_000]], [[85_020, 85_020, 1_000_000]]);
  const second = book('x:BTC', T0 + SAMPLE_MS, [[85_100, 85_100, 1_000_000]], [[85_120, 85_120, 1_000_000]]);
  recorder.sample([first], T0); recorder.sample([second], T0 + SAMPLE_MS);
  recorder.sample([book('x:BTC', T0 + COLUMN_MS, [[85_100, 85_100, 3_000_000]], [[85_120, 85_120, 3_000_000]])], T0 + COLUMN_MS);
  const column = recorder.columns.get('x:BTC')![0]!, at = ltIndex(10);
  assert.equal(column.ltN, 2);
  assert.ok(Math.abs(column.lt![at]! - 1_000_000) < 1 && Math.abs(column.lt![at + 1]! - 1_000_000) < 1, 'each sample put its whole touch level at weight 1');
  // The same by hand, from the shared evaluator.
  const expected = new Float64Array(LT_LENGTH);
  for (const b of [first, second]) { const bid = new Map<number, number>(), ask = new Map<number, number>(); accumulateSide(b.bids, 20, bid); accumulateSide(b.asks, 20, ask); addLtSample(bid, ask, 20, expected); }
  assert.ok([...column.lt!].every((v, i) => Math.abs(v - expected[i]! / 2) <= Math.abs(expected[i]! / 2) * 1e-6 + 1e-9));
  // A two-minute window: the minutes' means weighted by their samples (2 of them at 1M, 1 at 3M).
  const merged = recorder.query('x:BTC', T0, T0 + 2 * COLUMN_MS, 2 * COLUMN_MS)[0]!;
  assert.equal(merged.ltN, 3);
  assert.ok(Math.abs(merged.lt![at]! - (2 * 1_000_000 + 3_000_000) / 3) < 1);
  // A window with minutes from before the tracker was kept: its mean is of the newer minutes alone, so it is not sent as the window's.
  assert.equal(mergedWithout().lt, undefined);
  function mergedWithout(): Column { const r = new DepthRecorder({ now: () => T0 }); r.columns.set('y', [{ t: T0, n: 3, bins: Int32Array.of(1), bid: Float32Array.of(5), ask: Float32Array.of(0) }]); return r.query('y', T0, T0 + 2 * COLUMN_MS, 2 * COLUMN_MS)[0]!; }
  const mixed: Column[] = [
    { t: T0, n: 2, bins: Int32Array.of(1), bid: Float32Array.of(5), ask: Float32Array.of(0) },
    { t: T0 + COLUMN_MS, n: 2, bins: Int32Array.of(1), bid: Float32Array.of(5), ask: Float32Array.of(0), lt: new Float32Array(LT_LENGTH).fill(7), ltN: 2 }];
  const r = new DepthRecorder({ now: () => T0 + 5 * COLUMN_MS }); r.columns.set('z', mixed);
  const window = r.query('z', T0, T0 + 2 * COLUMN_MS, 2 * COLUMN_MS)[0]!;
  assert.deepEqual([window.n, window.ltN], [4, 2]);
  assert.equal(packLt([window]), undefined, 'covers half its samples: left to the page to estimate');
  assert.equal(packLt(mixed)![LT_LENGTH], 7, 'the newer minute on its own is whole');
});

test('the kept tracker survives SQLite, a minute reopened after a restart, and the wire; minutes without one stay without', () => {
  const store = new SqliteColumnStore(':memory:');
  const lt = Float32Array.from({ length: LT_LENGTH }, (_, i) => i + 0.5);
  store.save('x:BTC', { t: T0, n: 3, bins: Int32Array.of(4), bid: Float32Array.of(1.5), ask: Float32Array.of(0), lt, ltN: 3 }, 20);
  store.save('x:BTC', { t: T0 + COLUMN_MS, n: 2, bins: Int32Array.of(4), bid: Float32Array.of(2), ask: Float32Array.of(0) }, 20);
  const rows = [...store.load(0)];
  assert.deepEqual([rows[0]!.column.ltN, [...rows[0]!.column.lt!]], [3, [...lt]]);
  assert.equal(rows[1]!.column.lt, undefined);
  store.prune(T0 + 1);
  assert.equal([...store.load(0)].length, 1);
  store.close();
  // Reopened within its minute after a restart: the samples before and after average together, the tracker over its own count.
  const saved: { id: string; column: Column; step: number }[] = [{ id: 'x:BTC', column: { t: T0, n: 2, bins: Int32Array.of(4250), bid: Float32Array.of(1_000_000), ask: Float32Array.of(0), lt: new Float32Array(LT_LENGTH).fill(10), ltN: 2 }, step: 20 }];
  const again = new DepthRecorder({ store: { load: () => saved.map(r => ({ instrumentId: r.id, column: r.column, step: r.step })), save: () => {}, prune: () => {} }, now: () => T0 + 30_000 });
  again.sample([book('x:BTC', T0 + 30_000, [[85_000, 85_000, 1_000_000]], [])], T0 + 30_000);
  const open = again.query('x:BTC', T0, T0 + COLUMN_MS)[0]!;
  assert.deepEqual([open.n, open.ltN], [3, 3]);
  // The wire carries it after every instrument's three parts; a page reads it back by the index in the header.
  const frame = encodeColumns([{ instrumentId: 'x:BTC', step: 20, columns: [{ t: T0, n: 3, bins: Int32Array.of(4), bid: Float32Array.of(1), ask: Float32Array.of(0), lt, ltN: 3 }, { t: T0 + COLUMN_MS, n: 1, bins: Int32Array.of(4), bid: Float32Array.of(1), ask: Float32Array.of(0) }] },
    { instrumentId: 'y:BTC', step: 20, columns: [{ t: T0, n: 1, bins: Int32Array.of(4), bid: Float32Array.of(1), ask: Float32Array.of(0) }] }], T0, T0 + 2 * COLUMN_MS, COLUMN_MS);
  const decoded = decodeColumns(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
  const x = decoded.instruments[0]!.lt!;
  assert.deepEqual([[...x.subarray(0, LT_LENGTH)], x.subarray(LT_LENGTH).every(Number.isNaN), decoded.instruments[1]!.lt], [[...lt], true, undefined]);
  assert.deepEqual([...decoded.instruments[1]!.bid], [1], 'the depth parts are where they were');
});

test('stale books leave the minute unobserved instead of carrying forward', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.sample([book('x:BTC', T0 - 120_000, [[85_000, 85_000, 100]], [])], T0);
  assert.equal(recorder.query('x:BTC', 0, T0 + COLUMN_MS).length, 0);
});

test('query merges minutes into wider steps weighted by observed samples', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 10);
  recorder.sample([book('x:BTC', T0, [[100, 100, 100]], [])], T0);
  recorder.sample([book('x:BTC', T0 + COLUMN_MS, [[100, 100, 300]], [])], T0 + COLUMN_MS);
  recorder.sample([book('x:BTC', T0 + 2 * COLUMN_MS, [[100, 100, 0.001]], [])], T0 + 2 * COLUMN_MS);
  const merged = recorder.query('x:BTC', T0, T0 + 2 * COLUMN_MS, 5 * COLUMN_MS);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.n, 2);
  assert.equal(merged[0]!.bid[0], 200);
});

test('columns persist to and reload from SQLite', () => {
  const store = new SqliteColumnStore(':memory:');
  const column: Column = { t: T0, n: 3, bins: Int32Array.from([4, 5]), bid: Float32Array.from([1.5, 0]), ask: Float32Array.from([0, 2.5]) };
  store.save('x:BTC', column, 20);
  const rows = [...store.load(0)];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, 20);
  assert.deepEqual([...rows[0]!.column.bins], [4, 5]);
  assert.deepEqual([...rows[0]!.column.ask], [0, 2.5]);
  store.prune(T0 + 1);
  assert.equal([...store.load(0)].length, 0);
  store.close();
});

test('a recorder reloads recorded columns and keeps the original grid step', () => {
  const saved: { id: string; column: Column; step: number }[] = [];
  const store: ColumnStore = { load: () => saved.map(row => ({ instrumentId: row.id, column: row.column, step: row.step })), save: (id, column, step) => { saved.push({ id, column, step }); }, prune: () => {} };
  const first = new DepthRecorder({ store, now: () => T0 });
  first.sample([book('x:BTC', T0, [[85_000, 85_000, 100]], [])], T0);
  first.flush();
  const again = new DepthRecorder({ store, now: () => T0 + COLUMN_MS });
  assert.equal(again.columns.get('x:BTC')!.length, 1);
  assert.equal(again.steps.get('x:BTC'), 20);
});

test('valueBook converts contracts to USD and gives grouped levels their group: a bid from its price up, an ask from its price down', () => {
  const okx = valueBook('okx:BTC-USDT-SWAP', { bids: [[85_000, 100]], asks: [[85_010, 50]], units: 'contract', contractValue: 0.01, sourceTimestamp: T0 }, { venue: 'okx', quote: 'USDT', quantityUnit: 'contract', contractValue: 0.01 }, T0)!;
  assert.equal(okx.venue, 'okx');
  assert.equal(okx.bids.usd[0], 100 * 0.01 * 85_000);
  assert.equal(okx.coarse, false);
  // Hyperliquid at three significant figures, price 85,103: bids from 85,100 to 85,103 are named 85,100, asks from 85,104 to 85,200 are
  // named 85,200 (its finer groups add up to the coarser ones exactly this way), so the two touch groups share [85,100, 85,200]. Bids rest
  // below the price and asks above it: the shared group is split at the last trade, or without one at its middle.
  const hlBook = { bids: [[85_100, 2], [85_000, 3]], asks: [[85_200, 4], [85_300, 5]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 };
  const hl = valueBook('hyperliquid:BTC-PERP', hlBook, { venue: 'hyperliquid', quote: 'USD' }, T0)!;
  assert.equal(hl.coarse, true);
  assert.deepEqual([[...hl.bids.lo], [...hl.bids.hi]], [[85_100, 85_000], [85_150, 85_100]]);
  assert.deepEqual([[...hl.asks.lo], [...hl.asks.hi]], [[85_150, 85_200], [85_200, 85_300]]);
  const traded = valueBook('hyperliquid:BTC-PERP', hlBook, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, 85_140)!;
  assert.deepEqual([traded.bids.lo[0], traded.bids.hi[0], traded.asks.lo[0], traded.asks.hi[0]], [85_100, 85_140, 85_140, 85_200]);
  assert.deepEqual([traded.bids.lo[1], traded.bids.hi[1], traded.asks.lo[1], traded.asks.hi[1]], [85_000, 85_100, 85_200, 85_300], 'groups away from the touch are untouched');
  // The cut stays an eighth of the group from its edges (a trade on an edge would squeeze one side's group into a single price, a false
  // wall), and a trade outside the group (the book and the trade disagree) is not used.
  const near = valueBook('hyperliquid:BTC-PERP', hlBook, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, 85_103)!;
  assert.deepEqual([near.bids.lo[0], near.bids.hi[0], near.asks.lo[0], near.asks.hi[0]], [85_100, 85_112.5, 85_112.5, 85_200]);
  for (const hint of [85_100, 85_200, 85_250, 84_000]) {
    const v = valueBook('hyperliquid:BTC-PERP', hlBook, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, hint)!;
    assert.ok(v.bids.hi[0]! > v.bids.lo[0]! && v.asks.hi[0]! > v.asks.lo[0]!, `no group squeezed to a point at ${hint}`);
  }
  // A crossed grouped book (a bid group wholly above the ask group) has no shared group: nothing is moved.
  const crossed = valueBook('hyperliquid:BTC-PERP', { bids: [[85_300, 1]], asks: [[85_200, 1]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 }, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, 85_250)!;
  assert.deepEqual([crossed.bids.lo[0], crossed.bids.hi[0], crossed.asks.lo[0], crossed.asks.hi[0]], [85_300, 85_400, 85_100, 85_200]);
  // The top groups as reported travel with the book (and through the wire), for readers that compare the book over time.
  assert.deepEqual(near.touch, { lo: 85_100, hi: 85_200 });
  const wire = encodeLevels([near, okx], T0);
  assert.deepEqual(decodeLevels(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength) as ArrayBuffer).books.map(b => b.touch), [{ lo: 85_100, hi: 85_200 }, undefined]);
  assert.equal(crossed.touch, undefined, 'a crossed grouped book has no shared group');
  assert.ok(crossedByBp(crossed) > 11, 'and it is crossed, as a point book would be (the guard that keeps it off the map applies)');
  assert.equal(crossedByBp(near), 0, 'a split shared group meets at one price: not crossed');
  // An empty top level shares nothing: only levels holding something make the shared group.
  const empties = splitTouch(side([[100, 110, 0], [90, 100, 100]]), side([[100, 110, 100]]));
  assert.deepEqual([empties.asks.lo[0], empties.touch], [100, undefined]);
  const outside = valueBook('hyperliquid:BTC-PERP', hlBook, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, 85_250)!;
  assert.deepEqual([outside.bids.hi[0], outside.asks.lo[0], outside.asks.hi[0]], [85_150, 85_150, 85_200], 'a trade outside the shared group: split at its middle');
  // An ask named on a power of ten holds the prices just below it, a tenth of its own step wide.
  const decade = valueBook('hyperliquid:BTC-PERP', { bids: [[99_800, 1]], asks: [[100_000, 1]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 }, { venue: 'hyperliquid', quote: 'USD' }, T0)!;
  assert.deepEqual([decade.bids.lo[0], decade.bids.hi[0], decade.asks.lo[0], decade.asks.hi[0]], [99_800, 99_900, 99_900, 100_000]);
  // The whole book has one step, its best bid's: SOL's bids at three significant figures run 109 ... 100, 99 ... 90, a dollar apart.
  const sol = valueBook('hyperliquid:SOL-PERP', { bids: [[109, 1], [100, 1], [99, 1], [90, 1]], asks: [[110, 1], [111, 1]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 }, { venue: 'hyperliquid', quote: 'USD' }, T0, undefined, 109.4)!;
  assert.deepEqual([...sol.bids.lo].map((lo, i) => [lo, sol.bids.hi[i]]), [[109, 109.4], [100, 101], [99, 100], [90, 91]]);
  assert.deepEqual([...sol.asks.lo].map((lo, i) => [lo, sol.asks.hi[i]]), [[109.4, 110], [110, 111]]);
  // A book across a power of ten: the asks keep the best bid's step (0.999 / 1.0009 listed asks 1.001, 1.003, 1.004, measured).
  const straddle = valueBook('hyperliquid:X-PERP', { bids: [[0.999, 1000]], asks: [[1.001, 1000], [1.003, 1000]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 }, { venue: 'hyperliquid', quote: 'USD' }, T0)!;
  assert.deepEqual([straddle.asks.lo[1], straddle.asks.hi[1]], [1.002, 1.003]);
  // Deribit ETH grouped by 10 is spaced $0.10 (its labels are hundredths of a dollar).
  const eth = valueBook('deribit:ETH-PERPETUAL', { bids: [[2497.2, 1000]], asks: [[2497.3, 1000]], units: 'quote', sourceGrouping: 0.1, sourceTimestamp: T0 }, { venue: 'deribit', quote: 'USD', inverse: true, quantityUnit: 'quote' }, T0)!;
  assert.deepEqual([eth.bids.lo[0], eth.bids.hi[0], eth.asks.lo[0], eth.asks.hi[0]].map(x => +x!.toFixed(2)), [2497.2, 2497.25, 2497.25, 2497.3]);
  // Deribit's $10 grouping names its groups the same way.
  const deribit = valueBook('deribit:BTC-PERPETUAL', { bids: [[82_980, 1]], asks: [[82_990, 1]], units: 'base', sourceGrouping: 10, sourceTimestamp: T0 }, { venue: 'deribit', quote: 'USD' }, T0, undefined, 82_984)!;
  assert.deepEqual([deribit.bids.lo[0], deribit.bids.hi[0], deribit.asks.lo[0], deribit.asks.hi[0]], [82_980, 82_984, 82_984, 82_990]);
  assert.equal(valueBook('x:BTC', { bids: [[1, 1]], asks: [], gap: true }, null, T0), null);
});

test('wire frames are 8-byte aligned and decode to the same arrays', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 10);
  recorder.sample([book('x:BTC', T0, [[100, 100, 5]], [[110, 110, 7]])], T0);
  const frame = encodeColumns([{ instrumentId: 'x:BTC', step: 10, columns: recorder.query('x:BTC', 0, T0 + COLUMN_MS) }], 0, T0 + COLUMN_MS, COLUMN_MS);
  const headerLength = frame.readUInt32LE(0);
  const header = JSON.parse(frame.subarray(4, 4 + headerLength).toString());
  const payload = (4 + headerLength + 7) & ~7;
  assert.equal(header.type, 'columns');
  const [bins, bid, ask] = header.parts as { kind: string; offset: number; length: number }[];
  assert.equal(new Int32Array(frame.buffer.slice(frame.byteOffset + payload + bins!.offset, frame.byteOffset + payload + bins!.offset + 8))[0], 10);
  assert.equal(new Float32Array(frame.buffer.slice(frame.byteOffset + payload + bid!.offset, frame.byteOffset + payload + bid!.offset + 4))[0], 5);
  assert.equal(ask!.length, 2);
  const levels = encodeLevels([book('x:BTC', T0, [[100, 100, 5]], [])], T0);
  assert.equal(JSON.parse(levels.subarray(4, 4 + levels.readUInt32LE(0)).toString()).instruments[0].bids, 1);
});

test('candle and open-interest aggregation keep first open, last close and extremes', () => {
  const rows = [
    { start: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { start: 60_000, open: 11, high: 15, low: 10, close: 14, volume: 2 },
    { start: 3_600_000, open: 14, high: 14, low: 13, close: 13, volume: 4 },
  ];
  assert.deepEqual(aggregateCandles(rows, 3_600_000), [[0, 10, 15, 9, 14, 3, 2], [3_600_000, 14, 14, 13, 13, 4, 1]]);
  assert.deepEqual(aggregateOi([{ base: 5, observationTimestamp: 1 }, { base: 9, observationTimestamp: 2 }, { base: 7, observationTimestamp: 3 }], 3_600_000), [[0, 5, 9, 5, 7]]);
});

test('footprint dedupes by trade id, buckets by minute and merges rows at query time', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 5 * COLUMN_MS);
  const trade = (tradeId: string, side: string, price: number, usd: number, t: number) => ({ instrumentId: 'x:BTC', tradeId, side, price, notionalUsd: usd, sourceTimestamp: t });
  const rows = [trade('1', 'buy', 85_000, 100, T0 + 1_000), trade('2', 'sell', 85_003, 40, T0 + 2_000), trade('3', 'buy', 85_040, 10, T0 + COLUMN_MS + 5)];
  assert.equal(recorder.ingest(rows), 3);
  assert.equal(recorder.ingest(rows), 0, 'replayed trades are ignored');
  assert.equal(recorder.ingest([{ ...rows[0]!, tradeId: '4', side: 'hold' }]), 0, 'unknown side rejected');
  const fine = recorder.step('x:BTC')!;
  assert.equal(fine, 0.5, '1/40 of the 20 USD depth step at 85k');
  const merged = recorder.query('x:BTC', T0, T0 + 2 * COLUMN_MS, 3_600_000, 20);
  assert.equal(merged.step, 20);
  assert.equal(merged.bars.length, 1);
  assert.deepEqual(merged.bars[0]!.rows, [[85_000, 100, 40], [85_040, 10, 0]]);
  assert.equal(merged.bars[0]!.buyUsd, 110);
  assert.equal(merged.bars[0]!.sellUsd, 40);
  recorder.close();
});

test('an aggregated footprint is the row-by-row sum of its markets, its minutes those any of them recorded, its stats only where all have them', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 10 * COLUMN_MS);
  let id = 0;
  const trade = (inst: string, side: string, price: number, usd: number, t: number) => ({ instrumentId: inst, tradeId: String(++id), side, price, notionalUsd: usd, sourceTimestamp: t });
  recorder.ingest([trade('a:BTC', 'buy', 85_000, 100, T0 + 1_000), trade('a:BTC', 'sell', 85_013, 40, T0 + 2_000), trade('a:BTC', 'buy', 85_041, 7, T0 + 3 * COLUMN_MS)]);
  recorder.ingest([trade('b:BTC', 'sell', 85_001, 30, T0 + 1_500), trade('b:BTC', 'buy', 85_060, 9, T0 + COLUMN_MS + 5)]);
  const a = recorder.query('a:BTC', T0, T0 + 5 * COLUMN_MS, 3_600_000, 20), b = recorder.query('b:BTC', T0, T0 + 5 * COLUMN_MS, 3_600_000, 20);
  const both = recorder.queryMany(['a:BTC', 'b:BTC', 'unknown:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20);
  assert.equal(both.step, a.step);
  assert.equal(both.bars.length, 1);
  const sum = new Map<number, [number, number]>();
  for (const row of [...a.bars[0]!.rows, ...b.bars[0]!.rows]) { const cell = sum.get(row[0]) ?? [0, 0]; cell[0] += row[1]; cell[1] += row[2]; sum.set(row[0], cell); }
  assert.deepEqual(both.bars[0]!.rows, [...sum].sort((x, y) => x[0] - y[0]).map(([p, [buy, sell]]) => [p, buy, sell]));
  assert.equal(both.bars[0]!.buyUsd, a.bars[0]!.buyUsd + b.bars[0]!.buyUsd);
  assert.equal(both.bars[0]!.sellUsd, a.bars[0]!.sellUsd + b.bars[0]!.sellUsd);
  assert.equal(both.bars[0]!.minutes, 3, 'minutes 0, 1 and 3: the union of what each recorded, not their sum');
  assert.deepEqual(recorder.queryMany(['a:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20), { ...a, from: T0 }, 'one market is its own footprint');
  assert.deepEqual(recorder.queryMany(['a:BTC', 'b:BTC', 'a:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20), { ...both, from: T0 }, 'a market named twice counts once');
  assert.deepEqual(recorder.queryMany(['unknown:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20), { step: 0, fine: 0, bars: [], from: T0 });
  // A budget takes whole bars, newest first, and says where it starts: minutes 0, 1 (a and b) and 3 (a) cost four instrument-minutes.
  const sliced = recorder.queryMany(['a:BTC', 'b:BTC'], T0, T0 + 5 * COLUMN_MS, COLUMN_MS, 20, [], 1);
  assert.deepEqual([sliced.from, sliced.bars.map(bar => bar.t)], [T0 + 2 * COLUMN_MS, [T0 + 3 * COLUMN_MS]], 'at least one bar with data, the empty bars beside it free');
  const two = recorder.queryMany(['a:BTC', 'b:BTC'], T0, T0 + 5 * COLUMN_MS, COLUMN_MS, 20, [], 3);
  assert.deepEqual([two.from, two.bars.map(bar => bar.t)], [T0 + COLUMN_MS, [T0 + COLUMN_MS, T0 + 3 * COLUMN_MS]]);
  // By venue: each row's markets, which add up to the row, named by place in `venues` (the most volume first).
  const split = recorder.queryMany(['a:BTC', 'b:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20, [], Infinity, true);
  assert.deepEqual(split.venues, ['a:BTC', 'b:BTC']);
  split.bars[0]!.rows.forEach((row, i) => {
    const flat = split.bars[0]!.venueRows![i]!; let buy = 0, sell = 0;
    for (let j = 0; j < flat.length; j += 3) { buy += flat[j + 1]!; sell += flat[j + 2]!; }
    assert.deepEqual([buy, sell], [row[1], row[2]], `row ${row[0]}`);
  });
  assert.equal(recorder.queryMany(['a:BTC'], T0, T0 + 5 * COLUMN_MS, 3_600_000, 20, [], Infinity, true).bars[0]!.venueRows, undefined, 'one market: no venues');
  // A window reaching years either side costs what its retained part does.
  const started = performance.now(), wide = recorder.queryMany(['a:BTC', 'b:BTC'], 0, 1e15, COLUMN_MS, 20, [], 3);
  assert.ok(performance.now() - started < 1_000, 'bounded to the recording');
  assert.deepEqual(wide.bars.map(bar => bar.t), [T0 + COLUMN_MS, T0 + 3 * COLUMN_MS]);
  // Bars of whole hours too: the hours walked are those the retention can hold, whatever the window says.
  const hourly = performance.now(), wideHours = recorder.queryMany(['a:BTC', 'b:BTC'], 0, 1e14, 3_600_000, 20, [], 5_000);
  assert.ok(performance.now() - hourly < 1_000, 'hours bounded to the retention');
  assert.deepEqual(wideHours.bars.map(bar => bar.t), recorder.queryMany(['a:BTC', 'b:BTC'], T0 - 3_600_000, T0 + 3_600_000, 3_600_000, 20).bars.map(bar => bar.t));
  recorder.close();
});

test('footprint minutes persist to a file, flush only what changed, and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-fp-'));
  const file = path.join(dir, 'fp.sqlite');
  try {
    let now = T0 + 5 * COLUMN_MS;
    const first = new FootprintRecorder(file, () => now);
    const trade = (tradeId: string, price: number, usd: number, t: number) => ({ instrumentId: 'x:BTC', tradeId, side: 'buy', price, notionalUsd: usd, sourceTimestamp: t });
    first.ingest([trade('1', 85_000, 100, T0 + 1_000), trade('2', 85_000, 50, T0 + 2 * COLUMN_MS)]);
    first.flush();
    first.ingest([trade('3', 85_000, 25, T0 + 1_500)]);
    first.close();
    const again = new FootprintRecorder(file, () => now);
    const bars = again.query('x:BTC', T0, T0 + 3 * COLUMN_MS, COLUMN_MS, 20).bars;
    assert.deepEqual(bars.map(b => [b.t, b.buyUsd]), [[T0, 125], [T0 + 2 * COLUMN_MS, 50]]);
    assert.equal(again.step('x:BTC'), 0.5);
    now += 1; again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('BitMEX inverse contracts are valued at one USD per contract', () => {
  const book = valueBook('bitmex:XBTUSD', { bids: [[85_000, 5_000]], asks: [[85_001, 2_000]], units: 'contract', sourceTimestamp: T0 }, { venue: 'bitmex', quote: 'USD', quantityUnit: 'contract', inverse: true }, T0)!;
  assert.equal(book.bids.usd[0], 5_000);
  assert.equal(book.asks.usd[0], 2_000);
});

test('footprint records trade counts and size buckets, reports them for complete bars only, and survives a reload and an old database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-fp-stats-'));
  const file = path.join(dir, 'fp.sqlite');
  const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
  try {
    // A database written before trade stats existed: one minute, no stats column.
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE footprint_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, step REAL NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (inst, t))');
    old.prepare('INSERT INTO footprint_minutes (inst, t, step, rows) VALUES (?, ?, ?, ?)').run('x:BTC', hour, 0.5, JSON.stringify([[170_000, 10, 5]]));
    old.close();
    let now = hour + 5 * COLUMN_MS;
    const first = new FootprintRecorder(file, () => now);
    const trade = (tradeId: string, side: string, usd: number, t: number) => ({ instrumentId: 'x:BTC', tradeId, side, price: 85_000, notionalUsd: usd, sourceTimestamp: t });
    const fills = [trade('1', 'buy', 100, hour + COLUMN_MS + 1_000), trade('2', 'buy', 30_000, hour + COLUMN_MS + 2_000), trade('3', 'sell', 60_000, hour + COLUMN_MS + 3_000),
      trade('4', 'sell', 6_000_000, hour + COLUMN_MS + 4_000), trade('5', 'sell', 25_000, hour + 2 * COLUMN_MS + 1_000)];
    // Each fill is its own market order here (as a venue that reports orders whole would send them).
    first.ingest(fills); first.countOrders(fills.map(f => ({ instrumentId: f.instrumentId, side: f.side as 'buy' | 'sell', t: f.sourceTimestamp, usd: f.notionalUsd })));
    // Minute bars: the new minute has stats, the migrated one does not.
    const minutes = (r: FootprintRecorder) => r.query('x:BTC', hour, hour + 3 * COLUMN_MS, COLUMN_MS, 20).bars;
    assert.equal(minutes(first)[0]!.stats, undefined, 'a minute recorded before stats existed has none');
    const m1 = minutes(first)[1]!.stats!;
    assert.deepEqual([m1.buyN, m1.sellN], [2, 2]);
    assert.deepEqual(m1.buy, [100, 30_000, 0, 0, 0, 0, 0, 0], 'buys by size bucket');
    assert.deepEqual(m1.sell, [0, 0, 60_000, 0, 0, 0, 0, 6_000_000], 'sells by size bucket, 5M and above in the last');
    assert.deepEqual(minutes(first)[2]!.stats!.sell, [0, 25_000, 0, 0, 0, 0, 0, 0], 'a 25K trade falls in the second bucket');
    // An hourly bar spanning a minute without stats reports none rather than a partial sum.
    assert.equal(first.query('x:BTC', hour, hour + 3 * COLUMN_MS, 3_600_000, 20).bars[0]!.stats, undefined);
    first.close();
    const again = new FootprintRecorder(file, () => now);
    assert.deepEqual(minutes(again)[1]!.stats, m1, 'stats persist');
    assert.equal(minutes(again)[0]!.stats, undefined);
    // An hour of stats-carrying minutes sums.
    const sum = again.query('x:BTC', hour + COLUMN_MS, hour + 3 * COLUMN_MS, 3_600_000, 20).bars[0]!.stats!;
    assert.deepEqual([sum.buyN, sum.sellN], [2, 3]);
    now += 1; again.close();
    // Stored stats are validated on load: a damaged value is treated as "no stats" rather than trusted.
    const damaged = new DatabaseSync(file);
    damaged.prepare('UPDATE footprint_minutes SET stats = ? WHERE inst = ? AND t = ?').run('[1.5,2,[0,0],[0]]', 'x:BTC', hour + COLUMN_MS);
    damaged.prepare('UPDATE footprint_minutes SET stats = ? WHERE inst = ? AND t = ?').run('not json', 'x:BTC', hour + 2 * COLUMN_MS);
    // Statistics written before orders were rebuilt (four fields, every fill a trade) are a different quantity: read as none.
    damaged.prepare('UPDATE footprint_minutes SET stats = ? WHERE inst = ? AND t = ?').run(JSON.stringify([1, 0, [100, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]), 'x:BTC', hour);
    damaged.close();
    const reloaded = new FootprintRecorder(file, () => now);
    assert.equal(minutes(reloaded)[1]!.stats, undefined);
    assert.equal(minutes(reloaded)[2]!.stats, undefined);
    assert.equal(minutes(reloaded)[0]!.stats, undefined, 'per-fill statistics from before are not read');
    reloaded.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('live OI samples from the newest stored bar on are added, so a window reaching into history still ends at the present', () => {
  const MIN = 60_000, base = 1_000 * MIN;
  const stored = [{ start: base, open: 10, high: 11, low: 9, close: 10 }, { start: base + MIN, open: 10, high: 12, low: 10, close: 12 }];
  const live = [{ base: 12, observationTimestamp: base + MIN + 30_000 }, { base: 13, observationTimestamp: base + 2 * MIN + 5_000 }, { base: 14, observationTimestamp: base + 3 * MIN }];
  const rows = withLiveOi(stored, live);
  assert.equal(rows.length, 5, 'the sample inside the last stored bar comes too: that bar may hold only the first of its minute\'s samples');
  assert.deepEqual(aggregateOi(rows, MIN).map(b => b[0] - base), [0, MIN, 2 * MIN, 3 * MIN]);
  assert.deepEqual(aggregateOi(rows, MIN)[1], [base + MIN, 10, 12, 10, 12], 'and a sample the bar already holds changes nothing in it');
  assert.deepEqual(aggregateOi(rows, MIN).at(-1), [base + 3 * MIN, 14, 14, 14, 14]);
  assert.deepEqual(withLiveOi([], live), live, 'with nothing stored every live sample is used');
  assert.deepEqual(withLiveOi(stored, []), stored);
});

test('the plain-book fast path values a book exactly as the general path does, and defers to it for anything unusual', () => {
  let seed = 7; const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 3_000; i++) { bids.push([86_000 - i * 0.37, 0.001 + rand()]); asks.push([86_000.5 + i * 0.41, 0.001 + rand()]); }
  bids.push([85_000, 0], [NaN, 1], [84_000, -2]);   // rows the general path skips
  const market = { venue: 'x', quote: 'USDT' };
  const fast = valueBook('x:BTC', { bids, asks, units: 'base', sourceTimestamp: T0 }, market, T0, 20)!;
  // Metadata for a price that is not in the book switches the general path on without changing what it computes.
  const general = valueBook('x:BTC', { bids, asks, units: 'base', sourceTimestamp: T0, levelMetadata: { bids: { '-1': { note: 'unrelated' } }, asks: {} } }, market, T0, 20)!;
  assert.ok(fast.bids.usd.length > 100 && fast.asks.usd.length > 100);
  assert.deepEqual([...fast.bids.lo], [...general.bids.lo]); assert.deepEqual([...fast.bids.usd], [...general.bids.usd]);
  assert.deepEqual([...fast.asks.lo], [...general.asks.lo]); assert.deepEqual([...fast.asks.usd], [...general.asks.usd]);
  // A supplied notional, a quote-sized book and a contract book are not plain: they still go through the general path.
  const supplied = valueBook('x:BTC', { bids: [[100, 1, 777]], asks: [[101, 1, 555]], units: 'base', sourceTimestamp: T0 }, market, T0, 20)!;
  assert.deepEqual([supplied.bids.usd[0], supplied.asks.usd[0]], [777, 555]);
  const quoteSized = valueBook('x:BTC', { bids: [[100, 500]], asks: [[101, 505]], units: 'quote', sourceTimestamp: T0 }, market, T0, 20)!;
  assert.deepEqual([quoteSized.bids.usd[0], quoteSized.asks.usd[0]], [500, 505]);
  assert.equal(valueBook('x:BTC', { bids: [[100, 1]], asks: [[101, 1]], units: 'base', sourceTimestamp: T0 }, { venue: 'x', quote: 'EUR' }, T0, 20), null, 'no USD conversion, no valuation');
});

test('a column drops bins too small to see, but never goes below its 300 largest', () => {
  const bidsRows = (count: number, bigEvery: number): [number, number, number][] => Array.from({ length: count }, (_, i) => { const price = 90_000 - i * 10; const usd = i % bigEvery === 0 ? 20_000 : 100 + i; return [price, price, usd]; });
  // 2000 bins of which every 3rd is large: the 667 large ones are kept, the small ones go.
  const many = new DepthRecorder({ now: () => T0 }); many.steps.set('x:BTC', 10);
  many.sample([book('x:BTC', T0, bidsRows(2_000, 3), [[90_010, 90_010, 50]])], T0);
  const kept = many.query('x:BTC', T0, T0 + COLUMN_MS)[0]!;
  assert.equal(kept.bins.length, 667);
  assert.ok([...kept.bid].every(v => v >= 5_000), 'only large bins remain');
  // Only 100 large bins: the column keeps its 300 largest, which is the 100 large plus the 200 biggest small ones.
  const few = new DepthRecorder({ now: () => T0 }); few.steps.set('x:BTC', 10);
  few.sample([book('x:BTC', T0, bidsRows(1_000, 10), [[90_010, 90_010, 50]])], T0);
  const floor = few.query('x:BTC', T0, T0 + COLUMN_MS)[0]!;
  assert.equal(floor.bins.length, 300);
  assert.ok([...floor.bins].every((b, i, all) => i === 0 || b > all[i - 1]!), 'still sorted by price');
  assert.equal([...floor.bid].filter(v => v >= 5_000).length, 100);
  // Small columns are untouched however small their bins are.
  const small = new DepthRecorder({ now: () => T0 }); small.steps.set('x:BTC', 10);
  small.sample([book('x:BTC', T0, bidsRows(50, 1000), [[90_010, 90_010, 50]])], T0);
  assert.equal(small.query('x:BTC', T0, T0 + COLUMN_MS)[0]!.bins.length, 51);
});

/** The merge as it was written first (a map per window), with the smallest-bin rule it was meant to apply: what the flat merge must equal. */
function referenceQuery(columns: readonly Column[], from: number, to: number, stepMs: number, minBinUsd = MIN_BIN_USD): Column[] {
  const inRange = columns.filter(c => c.t >= from && c.t < to);
  const groups = new Map<number, { t: number; n: number; bid: Map<number, number>; ask: Map<number, number> }>();
  for (const column of inRange) {
    const t = Math.floor(column.t / stepMs) * stepMs;
    let group = groups.get(t); if (!group) { group = { t, n: 0, bid: new Map(), ask: new Map() }; groups.set(t, group); }
    group.n += column.n;
    for (let i = 0; i < column.bins.length; i++) { const bin = column.bins[i]!; group.bid.set(bin, (group.bid.get(bin) ?? 0) + column.bid[i]! * column.n); group.ask.set(bin, (group.ask.get(bin) ?? 0) + column.ask[i]! * column.n); }
  }
  return [...groups.values()].sort((a, b) => a.t - b.t).map(g => {
    let bins = Int32Array.from([...new Set([...g.bid.keys(), ...g.ask.keys()])].sort((a, b) => a - b));
    let bid = new Float32Array(bins.length), ask = new Float32Array(bins.length);
    bins.forEach((bin, i) => { bid[i] = (g.bid.get(bin) ?? 0) / g.n; ask[i] = (g.ask.get(bin) ?? 0) / g.n; });
    if (bins.length > KEEP_ALWAYS) {
      let keep: number[] = [];
      for (let i = 0; i < bins.length; i++) if (bid[i]! + ask[i]! >= minBinUsd) keep.push(i);
      if (keep.length < KEEP_ALWAYS) keep = Array.from(bins.keys()).sort((x, y) => (bid[y]! + ask[y]!) - (bid[x]! + ask[x]!)).slice(0, KEEP_ALWAYS).sort((x, y) => x - y);
      const b0 = bins, d0 = bid, a0 = ask; bins = Int32Array.from(keep, i => b0[i]!); bid = Float32Array.from(keep, i => d0[i]!); ask = Float32Array.from(keep, i => a0[i]!);
    }
    return { t: g.t, n: g.n, bins, bid, ask };
  });
}

/** Minutes of made-up columns: some empty, some past the 300 bins a column always keeps, USD from cents to tens of thousands. */
function randomColumns(minutes: number, seed: number): Column[] {
  let s = seed; const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Column[] = [];
  for (let m = 0; m < minutes; m++) {
    if (rnd() < 0.05) continue;   // a minute nothing was observed in
    const count = Math.floor(rnd() * 420), base = 4_000 + Math.floor(rnd() * 200);
    const bins = Int32Array.from([...new Set(Array.from({ length: count }, () => base + Math.floor(rnd() * 600)))].sort((a, b) => a - b));
    const usd = (): number => rnd() < 0.3 ? 0 : rnd() < 0.5 ? rnd() * 9_000 : rnd() * 60_000;
    out.push({ t: T0 + m * COLUMN_MS, n: 1 + Math.floor(rnd() * 12), bins, bid: Float32Array.from(bins, usd), ask: Float32Array.from(bins, usd) });
  }
  return out;
}

test('merged windows equal the map merge to the last bit, at every step and from any start', () => {
  const columns = randomColumns(240, 7), now = T0 + 300 * COLUMN_MS;
  const recorder = new DepthRecorder({ now: () => now }); recorder.columns.set('x:BTC', columns);
  for (const step of [2, 3, 5, 8, 15, 16, 60, 64]) {
    for (const [from, to] of [[T0, now], [T0 + 7.5 * COLUMN_MS, T0 + 201.3 * COLUMN_MS], [T0 - 3_600_000, T0 + 37 * COLUMN_MS]] as const) {
      const want = referenceQuery(columns, from, to, step * COLUMN_MS);
      assert.deepEqual(recorder.query('x:BTC', from, to, step * COLUMN_MS), want, `step ${step} min from ${(from - T0) / COLUMN_MS}`);
      assert.deepEqual(recorder.query('x:BTC', from, to, step * COLUMN_MS), want, `step ${step} min asked again`);
    }
  }
  assert.deepEqual(recorder.query('x:BTC', T0 + 10 * COLUMN_MS, T0 + 20 * COLUMN_MS), columns.filter(c => c.t >= T0 + 10 * COLUMN_MS && c.t < T0 + 20 * COLUMN_MS), 'whole minutes are the columns themselves');
});

test('a merged window drops the bins too small to see, as a minute does (it once kept them all)', () => {
  const bins = Int32Array.from({ length: 400 }, (_, i) => 1_000 + i), usd = Float32Array.from(bins, (_, i) => i < 350 ? 20_000 : 100);
  const recorder = new DepthRecorder({ now: () => T0 + 10 * COLUMN_MS });
  recorder.columns.set('x:BTC', [0, 1].map(m => ({ t: T0 + m * COLUMN_MS, n: 4, bins, bid: usd, ask: new Float32Array(400) })));
  const [merged] = recorder.query('x:BTC', T0, T0 + 5 * COLUMN_MS, 5 * COLUMN_MS);
  assert.equal(merged!.bins.length, 350);
  assert.ok([...merged!.bid].every(v => v === 20_000));
  // Fewer large bins than a column always keeps, with ties at the edge: the 300 largest, the lower price first among equals.
  const tied = Float32Array.from(bins, (_, i) => i % 7 === 0 ? 30_000 : i % 3 === 0 ? 500 : 200);
  const columns = [0, 1].map(m => ({ t: T0 + m * COLUMN_MS, n: 1 + m, bins, bid: tied, ask: new Float32Array(400) }));
  recorder.columns.set('x:ETH', columns);
  const ties = recorder.query('x:ETH', T0, T0 + 5 * COLUMN_MS, 5 * COLUMN_MS);
  assert.deepEqual(ties, referenceQuery(columns, T0, T0 + 5 * COLUMN_MS, 5 * COLUMN_MS));
  assert.equal(ties[0]!.bins.length, 300);
});

test('a window that has ended is merged once and kept; the window still open, and one cut by the question, are merged afresh', () => {
  let now = T0 + 20 * COLUMN_MS + 30_000;
  const columns = randomColumns(20, 11), recorder = new DepthRecorder({ now: () => now }); recorder.columns.set('x:BTC', [...columns]);
  const first = recorder.query('x:BTC', T0, now + COLUMN_MS, 5 * COLUMN_MS), again = recorder.query('x:BTC', T0, now + COLUMN_MS, 5 * COLUMN_MS);
  assert.equal(again[0], first[0], 'the first window is the one kept');
  const cut = recorder.query('x:BTC', T0 + 2 * COLUMN_MS, now + COLUMN_MS, 5 * COLUMN_MS);
  assert.deepEqual(cut[0], referenceQuery(columns, T0 + 2 * COLUMN_MS, now + COLUMN_MS, 5 * COLUMN_MS)[0], 'a window the question starts inside has only its minutes from the start on');
  assert.notEqual(cut[0], first[0]);
  // The minute that is being recorded belongs to a window that has not ended: a new column there shows at once.
  recorder.steps.set('x:BTC', 10);
  recorder.sample([book('x:BTC', now, [[50_000, 50_000, 30_000]], [])], now);
  const live = recorder.query('x:BTC', T0, now + COLUMN_MS, 5 * COLUMN_MS);
  assert.deepEqual(live.at(-1)!.bins.includes(5_000), true, 'the open minute is in its window');
  // A prune that cuts the second window: what was kept of it is gone with its minutes.
  recorder.prune(T0 + 7 * COLUMN_MS + RETENTION_MS);
  const rest = recorder.columns.get('x:BTC')!;
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + 20 * COLUMN_MS, 5 * COLUMN_MS), referenceQuery(rest, T0, T0 + 20 * COLUMN_MS, 5 * COLUMN_MS), 'after a prune a window is merged from the minutes left');
  // A recorder told to keep none (the cap is the browser's choice) merges every time, with the same result.
  const none = new DepthRecorder({ now: () => now, mergedCacheBins: 0 }); none.columns.set('x:BTC', [...columns]);
  const a = none.query('x:BTC', T0, now + COLUMN_MS, 5 * COLUMN_MS), b = none.query('x:BTC', T0, now + COLUMN_MS, 5 * COLUMN_MS);
  assert.notEqual(a[0], b[0]); assert.deepEqual(a, b); assert.deepEqual(a, first);
});

test('bins too far apart for the flat merge are merged the old way, with the same result', () => {
  const recorder = new DepthRecorder({ now: () => T0 + 10 * COLUMN_MS });
  const columns: Column[] = [
    { t: T0, n: 2, bins: Int32Array.from([5, 3_000_000]), bid: Float32Array.from([1_000, 2]), ask: Float32Array.from([0, 7]) },
    { t: T0 + COLUMN_MS, n: 3, bins: Int32Array.from([5, 9]), bid: Float32Array.from([10, 20]), ask: Float32Array.from([1, 1]) },
  ];
  recorder.columns.set('x:BTC', columns);
  assert.deepEqual(recorder.query('x:BTC', T0, T0 + 5 * COLUMN_MS, 5 * COLUMN_MS), referenceQuery(columns, T0, T0 + 5 * COLUMN_MS, 5 * COLUMN_MS));
});

test('the store prunes and reads the day back through the (inst, t) index, never a scan of the whole table', () => {
  // Karl's store was 1.4 GB of columns (2026-10-23): `DELETE ... WHERE t < ?` scanned all of it at every start and every hour, holding the loop.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-store-')), file = path.join(dir, 'depth-v2.sqlite');
  try {
    const store = new SqliteColumnStore(file);
    for (let i = 0; i < 6; i++) for (const id of ['a:BTC', 'b:BTC']) store.save(id, { t: T0 + i * COLUMN_MS, n: 1, bins: Int32Array.of(4), bid: Float32Array.of(1), ask: Float32Array.of(0), lt: new Float32Array(LT_LENGTH).fill(1), ltN: 1 }, 20);
    store.prune(T0 + 3 * COLUMN_MS);
    const rows = [...store.load(0)];
    assert.deepEqual(rows.map(r => `${r.instrumentId}@${(r.column.t - T0) / COLUMN_MS}:${r.column.ltN}`), ['a:BTC@3:1', 'a:BTC@4:1', 'a:BTC@5:1', 'b:BTC@3:1', 'b:BTC@4:1', 'b:BTC@5:1'], 'each instrument from the cut on, with its tracker');
    store.close();
    const db = new DatabaseSync(file);
    const plan = (sql: string): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0) as { detail: string }[]).map(r => r.detail).join(' | ');
    for (const table of ['depth_columns', 'depth_lt']) {
      assert.match(plan(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE t < ?)`), /COVERING INDEX/, `${table}: the prune walks the index`);
      assert.doesNotMatch(plan(`SELECT inst, t, n, data FROM ${table} WHERE t >= ? ORDER BY inst, t`), /^SCAN \w+$/, `${table}: the read-back is not a table scan`);
    }
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
