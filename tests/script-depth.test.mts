import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthCache, reachOf, type DepthBook, type DepthMessage, type SideWindow } from '../src/app/script/depth.ts';
import { DepthFeed } from '../src/app/script/depth-feed.ts';
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

test('after a move within the candle, the walk of every dollar at each price reads the book where the walk of one side finds the side the price came from thin', () => {
  // A candle that fell from 1,050 to 1,000: the bins it went through held bids most of the candle ($9 of them, $1 of asks), the ones above
  // it asks all along ($10); below the close, bids all along.
  const bins = [98, 99, 100, 101, 102, 103, 104, 105, 106], bid = [10, 10, 9, 9, 9, 9, 9, 0, 0], ask = [0, 0, 1, 1, 1, 1, 1, 10, 10];
  const both = (usd: number[], also: number[]): SideWindow => ({ ...win(10, bins, usd), also: Float32Array.from(also) });
  // One side: $5 of asks to 1,050, then $10 a bin: $20 at 1,065. Both: $10 a bin from the close: $20 at 1,020.
  near(reachOf([win(10, bins, ask)], 'ask', 1000, 20).price, 1065);
  near(reachOf([both(ask, bid)], 'ask', 1000, 20).price, 1020);
  // Below the close only bids stood: both walks read the same there.
  near(reachOf([both(bid, ask)], 'bid', 1000, 15).price, reachOf([win(10, bins, bid)], 'bid', 1000, 15).price);
  // A second array that does not match the bins is no book.
  assert.ok(Number.isNaN(reachOf([{ ...win(10, bins, ask), also: new Float32Array(2) }], 'ask', 1000, 5).price));
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
  const run = createRunner('d', 'line(askdepth(10))\nline(biddepth(8))\nline(depthbooks())\nline(source(askdepth(10), exchange=BYBIT))\nline(depthabove(10))\nline(depthbelow(8))\n', {}).run(inputs);
  assert.ok(run.ok, JSON.stringify(run));
  if (!run.ok) return;
  const at = (p: number, i: number): number => run.plots[p]!.fields.value![i]!;
  assert.ok(Number.isNaN(at(0, 0)), 'no window at the first candle');
  near(at(0, 1), 1005); near(at(1, 1), 995); assert.equal(at(2, 1), 2); near(at(3, 1), 1010);
  // Each side of the close held one side only: every dollar at each price reads the same.
  near(at(4, 1), 1005); near(at(5, 1), 995);
  // A script's own name of one stays its own; a run without the book reads NaN.
  const own = createRunner('o', 'function askdepth(x) { return 7 }\nline(askdepth(1))\n', {}).run(inputs);
  assert.ok(own.ok && own.plots[0]!.fields.value![1] === 7);
  const none = createRunner('n', 'line(askdepth(10))\n', {}).run({ ...inputs, depth: undefined, depthEpochs: undefined });
  assert.ok(none.ok && Number.isNaN(none.plots[0]!.fields.value![1]!));
});

test('the page reads every candle\'s windows newest first, keeps them for a return, reads again what can change, and reads candles further back', async () => {
  const T = 5 * M, now = 1_000 * T + 2 * M, asks: { from: number; to: number; ids: string[]; step: number }[] = [];
  let hang = false;
  const source = {
    kind: 'server',
    columns: async (ids: string[], from: number, to: number, step: number) => {
      asks.push({ from, to, ids, step });
      if (hang) await new Promise<void>(() => {});
      const times: number[] = [];
      for (let t = from; t < to; t += step) times.push(t);
      return { from, to, stepMs: step, instruments: ids.map(id => ({ id, step: 10, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(100), bid: new Float32Array(times.length), ask: new Float32Array(times.length).fill(10) })) };
    },
  };
  let changes = 0;
  const feed = new DepthFeed({ source } as never, () => { changes++; });
  const state = (timeframe: string) => ({ timeframe, markets: [], levels: { books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } }) as never;
  const starts = Float64Array.from({ length: 500 }, (_, i) => (501 + i) * T);
  const flush = async () => { for (let k = 0; k < 20; k++) await new Promise(r => setTimeout(r, 0)); };
  const cache = new DepthCache(), port = { generation: 1, post: (m: DepthMessage) => cache.apply(m) };
  const heldAt = (times: ArrayLike<number>) => Array.from(times).filter(t => cache.reader.books(t, {}, '') === 2).length;
  feed.sync(state('5m'), starts, T, now);
  await flush();
  // Every book in one question; the newest windows first, a few, then more each time, back to the first candle.
  assert.ok(asks.every(x => x.ids.length === 2));
  assert.equal(asks[0]!.to, 1_001 * T);
  assert.ok(asks[0]!.to - asks[0]!.from < asks[1]!.to - asks[1]!.from, 'a few at first');
  assert.equal(Math.min(...asks.map(x => x.from)), starts[0]);
  let tag = feed.sync(state('5m'), starts, T, now)!;
  feed.deliver(port);
  assert.ok(cache.holds(tag));
  assert.equal(heldAt(starts), starts.length, 'every candle has both books');
  near(cache.reader.reach('ask', starts[100]!, 1000, 10, {}, ''), 1005);
  assert.ok(changes > 0);
  // Another timeframe, whose read hangs; back to the first: its depth is there at once, without a read and without waiting for the one that hangs.
  hang = true; asks.length = 0;
  feed.sync(state('1h'), starts, 60 * M, now);
  await flush();
  assert.equal(asks.length, 1);
  hang = false;
  tag = feed.sync(state('5m'), starts, T, now)!;
  feed.deliver(port);
  assert.ok(cache.holds(tag) && cache.key === '5m');
  assert.equal(heldAt(starts), starts.length);
  assert.equal(asks.length, 1, 'nothing read again');
  // 30 s on: the windows that had not settled are read again (the source settles a window two minutes after it ends).
  feed.sync(state('5m'), starts, T, now + 31_000);
  await flush();
  assert.deepEqual(asks.slice(1).map(x => [x.from, x.to]), [[1_000 * T, 1_001 * T]]);
  // A page asleep for ten minutes: the windows read again start where the last read's settled ones ended, not two minutes ago.
  asks.length = 0;
  feed.sync(state('5m'), starts, T, now + 2 * T);
  await flush();
  assert.deepEqual(asks.map(x => [x.from, x.to]), [[1_000 * T, 1_003 * T]]);
  // Candles loaded further back are read back from where the books were read to.
  asks.length = 0;
  const longer = Float64Array.from({ length: 600 }, (_, i) => (401 + i) * T);
  tag = feed.sync(state('5m'), longer, T, now + 2 * T)!;
  await flush();
  assert.equal(Math.min(...asks.map(x => x.from)), longer[0]);
  assert.equal(Math.max(...asks.map(x => x.to)), starts[0]);
  tag = feed.sync(state('5m'), longer, T, now + 2 * T)!;
  feed.deliver(port);
  assert.ok(cache.holds(tag));
  assert.equal(heldAt(longer), longer.length);
});
