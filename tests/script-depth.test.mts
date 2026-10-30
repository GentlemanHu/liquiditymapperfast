import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthCache, SLAB, SMALL_ANSWER, keptWindows, reachOf, type DepthBook, type DepthMessage, type SideWindow } from '../src/app/script/depth.ts';
import { DepthFeed, closeMode } from '../src/app/script/depth-feed.ts';
import { analyze, createRunner } from '../src/app/script/lang/engine.ts';
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
    id, info: { id, venue, kind: 'perp', quote: 'USDT' }, step: 10, close: true, from, to, times, counts: rows.map(r => r.bins.length),
    bins: Int32Array.from(rows.flatMap(r => r.bins)), bid: Float32Array.from(rows.flatMap(r => r.bid)), ask: Float32Array.from(rows.flatMap(r => r.ask)),
  };
};
const M = 60_000;

test('the worker keeps what the page sends: windows replaced over their range, books dropped, old windows let go, a bad book left out', () => {
  const cache = new DepthCache(), w = () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] });
  const msg = (revision: number, over: Partial<DepthMessage>): DepthMessage => ({ t: 'depth', key: '1m', revision, prev: revision - 1, reset: false, books: [], drop: [], ...over });
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
  // A change for a timeframe never started is not taken, and leaves the others as they were.
  cache.apply(msg(5, { key: '5m' }));
  assert.ok(!cache.holds({ key: '5m', revision: 5 }) && cache.holds({ key: '1m', revision: 4 }));
  // Another timeframe, started: a run reads it once its tag is held; going back to 1m reads 1m's as it was.
  cache.apply(msg(6, { reset: true, key: '5m' }));
  assert.ok(cache.holds({ key: '5m', revision: 6 }));
  assert.equal(cache.reader.books(M, {}, ''), 0);
  assert.ok(cache.holds({ key: '1m', revision: 4 }));
  assert.equal(cache.reader.books(M, {}, ''), 1);
  // A change that builds on a revision the worker does not have: nothing of that timeframe is held for a run until it is sent whole again.
  cache.apply({ ...msg(9, {}), prev: 7 });
  assert.ok(!cache.holds({ key: '1m', revision: 4 }) && !cache.holds({ key: '1m', revision: 9 }), 'a change skipped');
  cache.apply(msg(10, { reset: true }));
  assert.ok(cache.holds({ key: '1m', revision: 10 }));
  // The page keeps 1m only: the worker lets 5m go.
  cache.apply(msg(11, { keys: ['1m'] }));
  assert.ok(!cache.holds({ key: '5m', revision: 6 }) && cache.holds({ key: '1m', revision: 11 }));
});

test('a script reads the book with askdepth, biddepth and depthbooks, over the books of its source(...) set, NaN where nothing is known', () => {
  const cache = new DepthCache();
  cache.apply({ t: 'depth', key: '1m', revision: 1, prev: -1, reset: true, drop: [], books: [
    book('a:BTC', 'binance', -Infinity, Infinity, [M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })),
    book('b:BTC', 'bybit', -Infinity, Infinity, [M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })),
  ] });
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  const inputs: BarInputs = { tf: M, time: Float64Array.from([0, M]), open: Float64Array.from([1000, 1000]), high: Float64Array.from([1000, 1000]), low: Float64Array.from([1000, 1000]), close: Float64Array.from([1000, 1000]), volume: Float64Array.from([1, 1]), sources: {}, forming: true, depth: cache.reader, depthEpochs: cache.epochs(Float64Array.from([0, M])) };
  const run = createRunner('d', 'line(askdepth(10))\nline(biddepth(8))\nline(depthbooks())\nline(source(askdepth(10), exchange=BYBIT))\nline(depthabove(10))\nline(depthbelow(8))\nvar fs = [depthabove]\nvar o = { reach: depthbelow }\nline(fs[0](10))\nline(o.reach(8))\n', {}).run(inputs);
  assert.ok(run.ok, JSON.stringify(run));
  if (!run.ok) return;
  const at = (p: number, i: number): number => run.plots[p]!.fields.value![i]!;
  assert.ok(Number.isNaN(at(0, 0)), 'no window at the first candle');
  near(at(0, 1), 1005); near(at(1, 1), 995); assert.equal(at(2, 1), 2); near(at(3, 1), 1010);
  // Each side of the close held one side only: every dollar at each price reads the same.
  near(at(4, 1), 1005); near(at(5, 1), 995);
  // Reached through an array or an object, the same.
  near(at(6, 1), 1005); near(at(7, 1), 995);
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
  const feed = new DepthFeed({ source } as never, () => { changes++; }, 50);
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
  assert.ok(cache.holds(tag));
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

const MIN = 60_000;
/** A source of columns for the feed's tests: every window holds one bin of $10 a side, on the grid `step(asked)`; `hold` keeps an answer back. */
function columnsSource(step: (n: number) => number = () => 10, holdFrom = Infinity) {
  const asks: { from: number; to: number; ids: string[] }[] = [], waiting: (() => void)[] = [];
  let hold = false;
  const source = {
    kind: 'server',
    columns: async (ids: string[], from: number, to: number, stepMs: number) => {
      const n = asks.push({ from, to, ids });
      if (hold || n >= holdFrom) await new Promise<void>(resolve => waiting.push(resolve));
      const times: number[] = [];
      for (let t = from; t < to; t += stepMs) times.push(t);
      const s = step(n);
      return { from, to, stepMs, instruments: ids.map(id => ({ id, step: s, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(Math.floor(1000 / s)), bid: new Float32Array(times.length).fill(10), ask: new Float32Array(times.length).fill(10) })) };
    },
  };
  return { source, asks, waiting, setHold: (h: boolean) => { hold = h; }, release: () => { holdFrom = Infinity; hold = false; } };
}
const twoBooks = (timeframe: string) => ({ timeframe, markets: [], levels: { books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } }) as never;
const settle = async () => { for (let k = 0; k < 30; k++) await new Promise(r => setTimeout(r, 0)); };
const candlesFrom = (first: number, last: number, tf: number) => Float64Array.from({ length: last - first + 1 }, (_, i) => (first + i) * tf);
function held(feed: DepthFeed, state: never, starts: Float64Array, tf: number, now: number): number {
  const cache = new DepthCache(), tag = feed.sync(state, starts, tf, now)!;
  feed.deliver({ generation: 1, post: m => cache.apply(m) });
  assert.ok(cache.holds(tag));
  return Array.from(starts).filter(t => cache.reader.books(t, {}, '') === 2).length;
}

test('a book found on another grid partway through a read is read again whole: no newer window is lost', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(501, 1_000, T);
  // The first answer on a grid of 10, every later one on a grid of 20 (the source started again between them).
  const { source } = columnsSource(n => n === 1 ? 10 : 20);
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('5m'), starts, T, now);
  await settle();
  feed.sync(twoBooks('5m'), starts, T, now);
  await settle();
  assert.equal(held(feed, twoBooks('5m'), starts, T, now), starts.length);
});

test('a read under way when old windows are let go does not count them as read: candles loaded back later are read again', async () => {
  const T = MIN, now = 1_000 * T + 5_000, all = candlesFrom(1, 1_000, T), later = candlesFrom(600, 1_000, T);
  // Two answers come; the third and later are held back.
  const { source, asks, waiting, release } = columnsSource(() => 10, 3);
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('1m'), all, T, now);
  await settle();
  assert.equal(asks.length, 3);
  // The series starts later (old windows let go); the third answer comes; the series reaches back again before the others come.
  feed.sync(twoBooks('1m'), later, T, now);
  waiting.shift()!(); await settle();
  feed.sync(twoBooks('1m'), all, T, now);
  release();
  while (waiting.length) { waiting.shift()!(); await settle(); }
  await settle();
  // What was let go is read again.
  feed.sync(twoBooks('1m'), all, T, now);
  await settle();
  feed.sync(twoBooks('1m'), all, T, now);
  await settle();
  assert.equal(held(feed, twoBooks('1m'), all, T, now), all.length);
});

test('a request that never answers lets go of the timeframe after a while, and it is read again', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T);
  const { source, asks, setHold } = columnsSource();
  setHold(true);
  const feed = new DepthFeed({ source } as never, () => {}, 300);
  feed.sync(twoBooks('5m'), starts, T, now);
  await settle();
  assert.equal(asks.length, 1);
  await new Promise(r => setTimeout(r, 360));
  feed.sync(twoBooks('5m'), starts, T, now + 1_000);
  assert.equal(asks.length, 1, 'not again at once');
  // The wait counts from the failure, 300 ms after the read began: not yet 5 s after it.
  feed.sync(twoBooks('5m'), starts, T, now + 5_150);
  assert.equal(asks.length, 1, 'not 5 s after the read began');
  feed.sync(twoBooks('5m'), starts, T, now + 6_000);
  assert.equal(asks.length, 2, 'again after the wait');
});

test('a candle runs again only when its depth changed: a window read again as it was keeps its revision, one let go or dropped does not', () => {
  const cache = new DepthCache(), times = Float64Array.from([0, M, 2 * M]);
  const msg = (revision: number, over: Partial<DepthMessage>): DepthMessage => ({ t: 'depth', key: '1m', revision, prev: revision - 1, reset: false, books: [], drop: [], ...over });
  const w = () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] });
  cache.apply(msg(1, { reset: true, books: [book('a:BTC', 'binance', -Infinity, Infinity, [0, M, 2 * M], w), book('b:BTC', 'bybit', -Infinity, Infinity, [2 * M], w)] }));
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  const first = cache.epochs(times);
  cache.apply(msg(2, { books: [book('a:BTC', 'binance', M, 3 * M, [M, 2 * M], w)] }));
  assert.deepEqual([...cache.epochs(times)], [...first], 'read again as they were');
  cache.apply(msg(3, { keepFrom: M }));
  const trimmed = cache.epochs(times);
  assert.ok(trimmed[0] !== first[0] && trimmed[1] === first[1], 'the window let go changed its candle only');
  cache.apply(msg(4, { drop: ['b:BTC'] }));
  const dropped = cache.epochs(times);
  assert.ok(dropped[2] !== trimmed[2] && dropped[1] === trimmed[1], 'a book dropped changed the candles it had');
});

test('the worker takes no book whose dollars are not finite and above 0 or whose bins do not rise; a walk over empty bins pays for them', () => {
  const cache = new DepthCache();
  const bad = (bid: number[], ask: number[], bins: number[]) => book('a:BTC', 'binance', -Infinity, Infinity, [M], () => ({ bins, bid, ask }));
  cache.apply({ t: 'depth', key: '1m', revision: 1, prev: -1, reset: true, drop: [], books: [bad([0, 1], [Infinity, 1], [99, 100]), { ...bad([0, 1], [1, 1], [100, 99]), id: 'b:BTC' }, { ...bad([-1, 1], [1, 1], [99, 100]), id: 'c:BTC' }] });
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  assert.equal(cache.reader.books(M, {}, ''), 0);
  const empty = 200_000, bins = Array.from({ length: empty + 1 }, (_, i) => 100 + i), usd = Array.from({ length: empty + 1 }, (_, i) => i === empty ? 10 : 0);
  const r = reachOf([win(10, bins, usd)], 'ask', 1000, 5);
  assert.ok(r.cost >= empty, `cost ${r.cost}`);
  // More empty bins than a walk may pass: no answer, though another book holds the size at the close.
  const huge = 3_000_000, emptyBook = win(10, Array.from({ length: huge }, (_, i) => 100 + i), new Array(huge).fill(0));
  assert.ok(Number.isNaN(reachOf([emptyBook, win(10, [100], [1000])], 'ask', 1000, 5).price));
});

test('a depth function only named (kept under another name, handed on) still has the page read the book', () => {
  assert.ok(analyze('var reach = askdepth\nline(reach(5))\n').inputs.has('depth'));
  assert.ok(analyze('function f(g) { return g(5) }\nline(f(depthabove))\n').inputs.has('depth'));
  assert.ok(!analyze('line(close)\n').inputs.has('depth'));
  // A parameter of that name in another function does not make the call elsewhere the script's own.
  assert.ok(analyze('function unused(depthabove) { return depthabove }\nline(depthabove(5))\n').inputs.has('depth'));
});

test('a book dropped while a read still answers for it is not brought back', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T);
  const { source, waiting, setHold } = columnsSource();
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('5m'), starts, T, now);
  await settle();
  // The tail read 30 s on is held back; meanwhile b goes away and is dropped.
  setHold(true);
  feed.sync(twoBooks('5m'), starts, T, now + 31_000);
  await settle();
  const one = { timeframe: '5m', markets: [], levels: { books: [{ id: 'a:BTC' }] } } as never;
  feed.sync(one, starts, T, now + 32_000);
  feed.sync(one, starts, T, now + 38_000);
  setHold(false);
  while (waiting.length) { waiting.shift()!(); await settle(); }
  const cache = new DepthCache(), tag = feed.sync(one, starts, T, now + 38_000)!;
  feed.deliver({ generation: 1, post: m => cache.apply(m) });
  assert.ok(cache.holds(tag));
  assert.equal(cache.reader.books(starts[starts.length - 1]!, {}, ''), 1);
});

test('a switch back to a timeframe the worker holds sends nothing; one it does not hold is sent whole', async () => {
  const T = 5 * MIN, H = 60 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T);
  const { source } = columnsSource();
  const feed = new DepthFeed({ source } as never, () => {});
  const cache = new DepthCache(), posted: DepthMessage[] = [], port = { generation: 1, post: (m: DepthMessage) => { posted.push(m); cache.apply(m); } };
  feed.sync(twoBooks('5m'), starts, T, now); await settle();
  let tag = feed.sync(twoBooks('5m'), starts, T, now)!; feed.deliver(port);
  assert.ok(cache.holds(tag));
  feed.sync(twoBooks('1h'), candlesFrom(1, 100, H), H, now); await settle();
  tag = feed.sync(twoBooks('1h'), candlesFrom(1, 100, H), H, now)!; feed.deliver(port);
  assert.ok(cache.holds(tag));
  posted.splice(0);
  tag = feed.sync(twoBooks('5m'), starts, T, now)!; feed.deliver(port);
  const sentOnReturn = posted.length;
  assert.equal(sentOnReturn, 0, 'nothing sent');
  assert.ok(cache.holds(tag));
  assert.equal(cache.reader.books(starts[50]!, {}, ''), 2);
  // A worker started since holds nothing: everything.
  const fresh = new DepthCache(), again = { generation: 2, post: (m: DepthMessage) => { posted.push(m); fresh.apply(m); } };
  feed.deliver(again);
  assert.ok(posted.length === 1 && posted[0]!.reset && fresh.holds(tag));
});

test('what the worker keeps alive stays near what it holds: windows let go or read again free their copies', () => {
  const W = 1_000, BINS = 1_000, times = Array.from({ length: W }, (_, i) => i * M);
  const big = (revision: number, prev: number, reset: boolean, from: number, to: number, value: number): DepthMessage => ({
    t: 'depth', key: '1m', revision, prev, reset, drop: [], books: [{ id: 'a:BTC', info: { id: 'a:BTC', venue: 'binance', kind: 'perp', quote: 'USDT' }, step: 10, close: true, from, to, times,
      counts: times.map(() => BINS), bins: Int32Array.from({ length: W * BINS }, (_, i) => 1_000 + (i % BINS)), bid: new Float32Array(W * BINS).fill(value), ask: new Float32Array(W * BINS).fill(value) }] });
  const cache = new DepthCache();
  cache.apply(big(1, -1, true, -Infinity, Infinity, 1));
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  assert.equal(cache.binsKept, W * BINS);
  // The series moves on to its last two candles: what stays alive is at most a slab, not the whole answer.
  cache.apply({ t: 'depth', key: '1m', revision: 2, prev: 1, reset: false, books: [], drop: [], keepFrom: (W - 2) * M });
  assert.ok(cache.binsKept <= SLAB * BINS, `${cache.binsKept} kept for ${2 * BINS} held`);
  // Everything read again, as it was: the new copies are kept, the old ones go, and no candle's revision changes.
  const again = new DepthCache();
  again.apply(big(1, -1, true, -Infinity, Infinity, 1));
  assert.ok(again.holds({ key: '1m', revision: 1 }));
  const before = again.epochs(Float64Array.from(times));
  again.apply(big(2, 1, false, -Infinity, Infinity, 1));
  assert.ok(again.holds({ key: '1m', revision: 2 }));
  assert.equal(again.binsKept, W * BINS);
  assert.deepEqual([...again.epochs(Float64Array.from(times))], [...before]);
});

test('an answer is kept in slabs of at most 16 windows, a few windows each a copy of its own, never as views of what was sent', () => {
  const answer = (n: number, zero: (c: number) => boolean = () => false) => {
    const times = Array.from({ length: n }, (_, c) => c * M), counts = times.map((_, c): number => zero(c) ? 0 : 3), total = counts.reduce((s, k) => s + k, 0);
    return { times, counts, bins: Int32Array.from({ length: total }, (_, i) => i), bid: Float32Array.from({ length: total }, (_, i) => i + 0.5), ask: Float32Array.from({ length: total }, (_, i) => i + 0.25) };
  };
  for (const n of [0, 1, 15, 16, 17, 33, 100]) {
    for (const hole of [false, true]) {
      const a = answer(n, c => c % 7 === 3), keep = (t: number) => !(hole && t >= 10 * M && t < 12 * M);
      const kept = keptWindows(a.times, a.counts, a.bins, a.bid, a.ask, keep);
      const slabs = new Map<ArrayBufferLike, number>();
      for (let c = 0, at = 0; c < n; at += a.counts[c]!, c++) {
        const t = a.times[c]!, w = kept.get(t);
        if (!keep(t)) { assert.equal(w, undefined); continue; }
        assert.ok(w, `window ${c} of ${n}`);
        assert.deepEqual([...w.bins], [...a.bins.subarray(at, at + a.counts[c]!)]);
        assert.deepEqual([...w.bid], [...a.bid.subarray(at, at + a.counts[c]!)]);
        assert.ok(w.bins.buffer !== a.bins.buffer && w.ask.buffer !== a.ask.buffer, 'a copy, not a view of the answer');
        slabs.set(w.bins.buffer, (slabs.get(w.bins.buffer) ?? 0) + 1);
      }
      for (const windows of slabs.values()) assert.ok(n <= SMALL_ANSWER ? windows === 1 : windows <= SLAB, `${windows} windows in a slab of an answer of ${n}`);
    }
  }
});

test('the page keeps alive about what it holds: the series moving on lets the copies go', async () => {
  const T = MIN, now = 1_000 * T + 5_000, all = candlesFrom(1, 1_000, T);
  const { source } = columnsSource();
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('1m'), all, T, now);
  await settle();
  assert.equal(feed.binsKept, 2 * all.length);
  // The series moves on to its last ten candles: at most a slab a book stays beyond them.
  feed.sync(twoBooks('1m'), candlesFrom(991, 1_000, T), T, now);
  assert.ok(feed.binsKept <= 2 * (11 + SLAB), `${feed.binsKept}`);
});

test('books that answered nothing at first are asked again within seconds, for the first minutes only', async () => {
  const T = MIN, now = 1_000 * T + 5_000, starts = candlesFrom(901, 1_000, T);
  let recording = false;
  const asks: number[] = [], askedIds: string[][] = [];
  const source = { kind: 'browser', columns: async (ids: string[], from: number, to: number, stepMs: number) => {
    asks.push(from); askedIds.push(ids);
    const times: number[] = [];
    if (recording) for (let t = Math.max(from, 999 * T); t < to; t += stepMs) times.push(t);
    return { from, to, stepMs, instruments: recording ? ids.map(id => ({ id, step: 10, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(100), bid: new Float32Array(times.length).fill(10), ask: new Float32Array(times.length).fill(10) })) : [] };
  } };
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('1m'), starts, T, now); await settle();
  const first = asks.length;
  recording = true;
  feed.sync(twoBooks('1m'), starts, T, now + 1_000); await settle();
  assert.equal(asks.length, first, 'not on every run');
  feed.sync(twoBooks('1m'), starts, T, now + 3_500); await settle();
  assert.ok(asks.length > first, 'again after 3 s');
  assert.ok(askedIds.slice(first).every(x => x.length <= 2), 'only the books that answered nothing');
  assert.equal(held(feed, twoBooks('1m'), candlesFrom(999, 1_000, T), T, now + 3_500), 2);
});

test('the re-ask covers only books that answered nothing; a book that answers is not asked again before the refresh', async () => {
  const T = MIN, now = 1_000 * T + 5_000, starts = candlesFrom(901, 1_000, T), asked: string[][] = [];
  const source = { kind: 'server', columns: async (ids: string[], from: number, to: number, stepMs: number) => {
    asked.push(ids);
    const times: number[] = [];
    for (let t = from; t < to; t += stepMs) times.push(t);
    // b is never recorded by this source.
    return { from, to, stepMs, instruments: ids.filter(id => id !== 'b:BTC').map(id => ({ id, step: 10, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(100), bid: new Float32Array(times.length).fill(10), ask: new Float32Array(times.length).fill(10) })) };
  } };
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('1m'), starts, T, now); await settle();
  const first = asked.length;
  feed.sync(twoBooks('1m'), starts, T, now + 3_500); await settle();
  assert.deepEqual(asked.slice(first), [['b:BTC']]);
  // Past the first two minutes: only the refresh, for both.
  asked.length = 0;
  feed.sync(twoBooks('1m'), starts, T, now + 125_000); await settle();
  assert.ok(asked.every(x => x.length === 2));
});

test('a book is re-asked at most every 3 s and only in its first two minutes; a change of its market description reruns its candles', async () => {
  const T = MIN, now = 1_000 * T + 5_000, starts = candlesFrom(901, 1_000, T), asked: string[][] = [];
  const source = { kind: 'server', columns: async (ids: string[], from: number, to: number, stepMs: number) => {
    asked.push(ids);
    const times: number[] = [];
    for (let t = from; t < to; t += stepMs) times.push(t);
    return { from, to, stepMs, instruments: ids.filter(id => id !== 'b:BTC').map(id => ({ id, step: 10, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(100), bid: new Float32Array(times.length).fill(10), ask: new Float32Array(times.length).fill(10) })) };
  } };
  const feed = new DepthFeed({ source } as never, () => {});
  for (const at of [0, 3_500]) { feed.sync(twoBooks('1m'), starts, T, now + at); await settle(); }
  const n = asked.length;
  feed.sync(twoBooks('1m'), starts, T, now + 4_000); await settle();
  assert.equal(asked.length, n, 'not again within 3 s');
  for (const at of [31_000, 62_000, 93_000, 124_000]) { feed.sync(twoBooks('1m'), starts, T, now + at); await settle(); }
  asked.length = 0;
  feed.sync(twoBooks('1m'), starts, T, now + 127_500); await settle();
  assert.deepEqual(asked, [], 'b is past its first two minutes');
  // The worker: the same windows with another market description read again change the candles' revisions.
  const cache = new DepthCache(), times = Float64Array.from([0, M]);
  const msg = (revision: number, kind: 'perp' | 'spot', reset: boolean): DepthMessage => ({ t: 'depth', key: '1m', revision, prev: revision - 1, reset, drop: [],
    books: [{ ...book('a:BTC', 'binance', -Infinity, Infinity, [0, M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })), info: { id: 'a:BTC', venue: 'binance', kind, quote: 'USDT' } }] });
  cache.apply(msg(1, 'perp', true));
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  const before = cache.epochs(times);
  cache.apply(msg(2, 'spot', false));
  assert.ok(cache.holds({ key: '1m', revision: 2 }));
  const after = cache.epochs(times);
  assert.ok(after[0] !== before[0] && after[1] !== before[1]);
  assert.equal(cache.reader.books(M, { kinds: ['spot'] }, 'type=spot'), 1);
  // The page: a market listed after the book's first answer is described as listed in what it sends.
  const late = new DepthFeed({ source: { kind: 'server', columns: source.columns } } as never, () => {});
  late.sync({ timeframe: '1m', markets: [], levels: { books: [{ id: 'a:BTC' }] } } as never, starts, T, now); await settle();
  const listed = { timeframe: '1m', markets: [{ id: 'a:BTC', instrumentId: 'a:BTC', venue: 'binance', marketType: 'spot', quote: 'USDT' }], levels: { books: [{ id: 'a:BTC' }] } } as never;
  late.sync(listed, starts, T, now + 31_000); await settle();
  const sent: DepthMessage[] = [];
  late.sync(listed, starts, T, now + 31_000);
  late.deliver({ generation: 1, post: m => sent.push(m) });
  assert.equal(sent[0]!.books.find(b => b.id === 'a:BTC')!.info.kind, 'spot');
});

test('closeMode: an answer with the minute each window is of is closes, one without is averages, one whose minutes are not its windows\' is neither', () => {
  const T = 15 * MIN, set = (times: number[], at?: unknown) => ({ id: 'a:BTC', step: 10, times, counts: times.map(() => 0), samples: times.map(() => 1), bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0), ...(at !== undefined ? { at } : {}) }) as never;
  assert.equal(closeMode(set([0, T]), T), false);
  assert.equal(closeMode(set([0, T], [T - MIN, 2 * T - MIN]), T), true);
  assert.equal(closeMode(set([0, T], [3 * MIN, T]), T), true, 'an earlier minute of the window (its last was not recorded)');
  assert.equal(closeMode(set([], []), T), true, 'an answer with no windows says closes too');
  assert.equal(closeMode(set([0, T], [T - MIN]), T), null, 'one minute short');
  assert.equal(closeMode(set([0, T], [T, 2 * T - MIN]), T), null, 'a minute of the next window');
  assert.equal(closeMode(set([0, T], [T - MIN, 2 * T - 30_000]), T), null, 'not a minute');
  assert.equal(closeMode(set([0], [0]), MIN), true, 'at 1m the window is its minute');
});

/** A source whose windows are averages (no `at`) until `closes` says, then each window's last minute; what each question asked for. */
function modeSource() {
  const asked: boolean[] = [], state = { closes: false, malformed: false };
  const source = {
    kind: 'server',
    columns: async (ids: string[], from: number, to: number, stepMs: number, close?: boolean) => {
      asked.push(close === true);
      const times: number[] = [];
      for (let t = from; t < to; t += stepMs) times.push(t);
      const usd = state.closes ? 20 : 10;
      const at = state.malformed ? { at: times.slice(1) } : state.closes ? { at: times.map(t => t + stepMs - MIN) } : {};
      return { from, to, stepMs, instruments: ids.map(id => ({ id, step: 10, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(100), bid: new Float32Array(times.length).fill(usd), ask: new Float32Array(times.length).fill(usd), ...at })) };
    },
  };
  return { source, asked, state };
}

test('the feed asks for each candle\'s close; a book whose answers change from averages to closes is read again whole, never held as a mix', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T), { source, asked, state } = modeSource();
  const feed = new DepthFeed({ source } as never, () => {});
  for (let k = 0; k < 4; k++) { feed.sync(twoBooks('5m'), starts, T, now); await settle(); }
  const read = (at: number) => {
    const cache = new DepthCache(), tag = feed.sync(twoBooks('5m'), starts, T, at)!;
    feed.deliver({ generation: 1, post: m => cache.apply(m) });
    assert.ok(cache.holds(tag));
    return Array.from(starts, t => [cache.reader.atClose(t, {}, ''), cache.reader.books(t, {}, '')]);
  };
  assert.ok(asked.length && asked.every(Boolean), 'every question asks for closes');
  assert.ok(read(now).every(([c, n]) => c === 0 && n === 2), 'an older server\'s averages, said as such');
  // The server is updated under the page: the next refresh of the last windows answers closes, and each book is read again whole.
  state.closes = true;
  for (let k = 0; k < 6; k++) { feed.sync(twoBooks('5m'), starts, T, now + 31_000); await settle(); }
  assert.ok(read(now + 31_000).every(([c, n]) => c === 1 && n === 2), 'every candle\'s book its close, none an average kept from before');
});

test('an answer whose minutes are not its windows\' fails the read: the windows held are kept and the read is tried again', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T), { source, asked, state } = modeSource();
  state.closes = true;
  const feed = new DepthFeed({ source } as never, () => {});
  for (let k = 0; k < 4; k++) { feed.sync(twoBooks('5m'), starts, T, now); await settle(); }
  const n = asked.length;
  state.malformed = true;
  feed.sync(twoBooks('5m'), starts, T, now + 31_000); await settle();
  assert.equal(asked.length, n + 1, 'the refresh asked');
  const cache = new DepthCache(), tag = feed.sync(twoBooks('5m'), starts, T, now + 31_500)!;
  feed.deliver({ generation: 1, post: m => cache.apply(m) });
  assert.ok(cache.holds(tag));
  assert.ok(Array.from(starts).every(t => cache.reader.books(t, {}, '') === 2 && cache.reader.atClose(t, {}, '') === 1), 'nothing taken back, nothing taken as averages');
  assert.equal(asked.length, n + 1, 'not asked again at once');
  state.malformed = false;
  feed.sync(twoBooks('5m'), starts, T, now + 62_000); await settle();
  assert.ok(asked.length > n + 1, 'tried again at the next refresh');
});

test('the worker: a book whose windows change from averages to closes starts again (its candles run again), and atClose says which it holds', () => {
  const cache = new DepthCache(), times = Float64Array.from([0, M]);
  const msg = (revision: number, close: boolean, reset: boolean): DepthMessage => ({ t: 'depth', key: '1m', revision, prev: revision - 1, reset, drop: [],
    books: [{ ...book('a:BTC', 'binance', -Infinity, Infinity, [0, M], () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] })), close }] });
  cache.apply(msg(1, false, true));
  assert.ok(cache.holds({ key: '1m', revision: 1 }));
  assert.equal(cache.reader.atClose(0, {}, ''), 0);
  assert.ok(Number.isNaN(cache.reader.atClose(2 * M, {}, '')), 'no book: NaN');
  const before = cache.epochs(times);
  // The same bins and dollars (at 1m a window is its minute either way), now said to be closes.
  cache.apply(msg(2, true, false));
  assert.ok(cache.holds({ key: '1m', revision: 2 }));
  const after = cache.epochs(times);
  assert.ok(after[0] !== before[0] && after[1] !== before[1], 'every candle of the book runs again');
  assert.equal(cache.reader.atClose(0, {}, ''), 1);
  // A message without the mode is not a book's: left out.
  const bare = msg(3, true, false); delete (bare.books[0] as Partial<DepthBook>).close;
  cache.apply(bare);
  assert.ok(cache.holds({ key: '1m', revision: 3 }));
  assert.equal(cache.reader.atClose(0, {}, ''), 1, 'the held book is as it was');
});
