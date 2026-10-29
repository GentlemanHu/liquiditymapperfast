import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthCache, reachOf, type DepthBook, type DepthMessage, type SideWindow } from '../src/app/script/depth.ts';
import { createRunner } from '../src/app/script/lang/engine.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

const win = (step: number, bins: number[], usd: number[]): SideWindow => ({ step, bins: Int32Array.from(bins), usd: Float32Array.from(usd) });
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

test('a size is reached walking out from the close, each bin\'s dollars spread evenly over its range', () => {
  // Asks of $10, 20, 30, 40, 50 in the bins from 1,000 to 1,050; the close at 1,015, inside the second.
  const asks = [win(10, [100, 101, 102, 103, 104], [10, 20, 30, 40, 50])];
  near(reachOf(asks, 'ask', 1015, 5).price, 1017.5);
  near(reachOf(asks, 'ask', 1015, 10).price, 1020);
  near(reachOf(asks, 'ask', 1015, 40).price, 1030);
  assert.ok(Number.isNaN(reachOf(asks, 'ask', 1015, 131).price), 'more than the asks above the close hold');
  near(reachOf(asks, 'ask', 1015, 130).price, 1050);
  assert.equal(reachOf(asks, 'ask', 1015, 0).price, 1015, 'no size: the close');
  assert.ok(Number.isNaN(reachOf(asks, 'ask', 1015, -1).price));
  assert.ok(Number.isNaN(reachOf(asks, 'ask', 1015, NaN).price));
  assert.ok(Number.isNaN(reachOf([], 'ask', 1015, 5).price), 'no book: unknown, not empty');
  // Bids of $5 and $10 in the bins from 980 to 1,000; the close at 995.
  const bids = [win(10, [98, 99], [5, 10])];
  near(reachOf(bids, 'bid', 995, 5).price, 990);
  near(reachOf(bids, 'bid', 995, 10).price, 980);
  assert.ok(Number.isNaN(reachOf(bids, 'bid', 995, 10.5).price));
});

test('books on grids of different steps are added up by price, and a gap in the book holds nothing', () => {
  // $10 over 1,000-1,010 in one book, $20 over 1,000-1,020 in another: $2 a dollar of price to 1,010, then $1.
  const both = [win(10, [100], [10]), win(20, [50], [20])];
  near(reachOf(both, 'ask', 1000, 15).price, 1007.5);
  near(reachOf(both, 'ask', 1000, 25).price, 1015);
  // Nothing between 1,010 and 1,050: the walk passes it.
  const gap = [win(10, [100, 105], [10, 10])];
  near(reachOf(gap, 'ask', 1000, 15).price, 1055);
  // Empty bins count for nothing; bins on the other side of the close are not counted.
  const sides = [win(10, [99, 100, 101], [100, 0, 4])];
  near(reachOf(sides, 'ask', 1000, 2).price, 1015);
});

const book = (id: string, venue: string, from: number, to: number, times: number[], perWindow: (t: number) => { bins: number[]; bid: number[]; ask: number[] }): DepthBook => {
  const rows = times.map(perWindow);
  return {
    id, info: { id, venue, kind: 'perp', quote: 'USDT' }, step: 10, from, to, times, counts: rows.map(r => r.bins.length),
    bins: Int32Array.from(rows.flatMap(r => r.bins)), bid: Float32Array.from(rows.flatMap(r => r.bid)), ask: Float32Array.from(rows.flatMap(r => r.ask)),
  };
};
const M = 60_000;

test('the worker keeps what the page sends: windows replaced over their range, books dropped, old windows let go, a bad book left out', () => {
  const cache = new DepthCache(), w = () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] });
  const msg = (revision: number, over: Partial<DepthMessage>): DepthMessage => ({ t: 'depth', key: '1m', revision, reset: false, books: [], drop: [], ...over });
  cache.apply(msg(1, { reset: true, books: [book('a:BTC', 'binance', -Infinity, Infinity, [0, M, 2 * M], w), book('b:BTC', 'bybit', -Infinity, Infinity, [0, M], w)] }));
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  assert.equal(cache.reader.books(M, {}, ''), 2);
  near(cache.reader.reach('ask', M, 1000, 10, {}, ''), 1005, );
  assert.equal(cache.reader.reach('ask', M, 1000, 10, { venues: ['bybit'] }, 'venue=bybit'), 1010, 'one book: half the depth');
  // The window of the minute under way replaced by a new answer.
  const before = cache.epochs(Float64Array.from([0, M, 2 * M]));
  cache.apply(msg(2, { books: [book('a:BTC', 'binance', 2 * M, 3 * M, [2 * M], () => ({ bins: [100], bid: [0], ask: [40] }))] }));
  const after = cache.epochs(Float64Array.from([0, M, 2 * M]));
  assert.deepEqual([after[0] === before[0], after[1] === before[1], after[2] === before[2]], [true, true, false], 'only that candle changed');
  near(cache.reader.reach('ask', 2 * M, 1000, 40, { venues: ['binance'] }, 'venue=binance'), 1010);
  // A book gone: every candle's depth changed. Old windows let go.
  cache.apply(msg(3, { drop: ['b:BTC'], keepFrom: M }));
  assert.equal(cache.reader.books(M, {}, ''), 1);
  assert.equal(cache.reader.books(0, {}, ''), 0);
  assert.ok(Number.isNaN(cache.reader.reach('ask', 0, 1000, 1, {}, '')), 'a window let go reads NaN');
  // A malformed book is left out, never read past its end.
  const bad = book('c:BTC', 'okx', -Infinity, Infinity, [M], w); bad.counts = [5];
  cache.apply(msg(4, { books: [bad] }));
  assert.equal(cache.reader.books(M, {}, ''), 1);
  // Another timeframe starts again.
  cache.apply(msg(5, { key: '5m' }));
  assert.equal(cache.reader.books(M, {}, ''), 0);
  assert.ok(!cache.holds({ key: '1m', revision: 5 }));
});

test('a script reads the book with askdepth, biddepth and depthbooks, over the books of its source(...) set, NaN where nothing is known', () => {
  const cache = new DepthCache();
  cache.apply({ t: 'depth', key: '1m', revision: 1, reset: true, drop: [], books: [
    book('a:BTC', 'binance', -Infinity, Infinity, [M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })),
    book('b:BTC', 'bybit', -Infinity, Infinity, [M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })),
  ] });
  const inputs: BarInputs = { tf: M, time: Float64Array.from([0, M]), open: Float64Array.from([1000, 1000]), high: Float64Array.from([1000, 1000]), low: Float64Array.from([1000, 1000]), close: Float64Array.from([1000, 1000]), volume: Float64Array.from([1, 1]), sources: {}, forming: true, depth: cache.reader, depthEpochs: cache.epochs(Float64Array.from([0, M])) };
  const run = createRunner('d', 'line(askdepth(10))\nline(biddepth(8))\nline(depthbooks())\nline(source(askdepth(10), exchange=BYBIT))\n', {}).run(inputs);
  assert.ok(run.ok, JSON.stringify(run));
  if (!run.ok) return;
  const at = (p: number, i: number): number => run.plots[p]!.fields.value![i]!;
  assert.ok(Number.isNaN(at(0, 0)), 'no window at the first candle');
  near(at(0, 1), 1005); near(at(1, 1), 995); assert.equal(at(2, 1), 2); near(at(3, 1), 1010);
  // A script's own name of one stays its own; a run without the book reads NaN.
  const own = createRunner('o', 'function askdepth(x) { return 7 }\nline(askdepth(1))\n', {}).run(inputs);
  assert.ok(own.ok && own.plots[0]!.fields.value![1] === 7);
  const none = createRunner('n', 'line(askdepth(10))\n', {}).run({ ...inputs, depth: undefined, depthEpochs: undefined });
  assert.ok(none.ok && Number.isNaN(none.plots[0]!.fields.value![1]!));
});
