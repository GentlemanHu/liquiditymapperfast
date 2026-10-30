import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthCache, reachOf, type DepthBook, type DepthMessage, type SideWindow } from '../src/app/script/depth.ts';
import { DepthFeed } from '../src/app/script/depth-feed.ts';
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
  // A change for another timeframe, or out of turn, is not taken: nothing is held for a run until everything is sent again.
  cache.apply(msg(5, { key: '5m' }));
  assert.ok(!cache.holds({ key: '1m', revision: 4 }) && !cache.holds({ key: '5m', revision: 5 }));
  cache.apply(msg(6, { reset: true, key: '5m' }));
  assert.ok(cache.holds({ key: '5m', revision: 6 }));
  assert.equal(cache.reader.books(M, {}, ''), 0);
  cache.apply(msg(8, {}));
  assert.ok(!cache.holds({ key: '5m', revision: 8 }) && !cache.holds({ key: '5m', revision: 6 }), 'a revision skipped');
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

const MIN = 60_000;
/** A source of columns for the feed's tests: every window holds one bin of $10 a side, on the grid `step(asked)`; `hold` keeps an answer back. */
function columnsSource(step: (n: number) => number = () => 10) {
  const asks: { from: number; to: number; ids: string[] }[] = [], waiting: (() => void)[] = [];
  let hold = false;
  const source = {
    kind: 'server',
    columns: async (ids: string[], from: number, to: number, stepMs: number) => {
      const n = asks.push({ from, to, ids });
      if (hold) await new Promise<void>(resolve => waiting.push(resolve));
      const times: number[] = [];
      for (let t = from; t < to; t += stepMs) times.push(t);
      const s = step(n);
      return { from, to, stepMs, instruments: ids.map(id => ({ id, step: s, times, counts: times.map(() => 1), samples: times.map(() => 1), bins: new Int32Array(times.length).fill(Math.floor(1000 / s)), bid: new Float32Array(times.length).fill(10), ask: new Float32Array(times.length).fill(10) })) };
    },
  };
  return { source, asks, waiting, setHold: (h: boolean) => { hold = h; } };
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
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, all = candlesFrom(501, 1_000, T), later = candlesFrom(599, 1_000, T);
  const { source, waiting, setHold } = columnsSource();
  const feed = new DepthFeed({ source } as never, () => {});
  feed.sync(twoBooks('5m'), all, T, now);
  await settle();
  // The second answer held back; meanwhile the series starts later and the older windows are let go.
  setHold(true);
  await settle();
  feed.sync(twoBooks('5m'), later, T, now);
  setHold(false);
  while (waiting.length) { waiting.shift()!(); await settle(); }
  await settle();
  // The series reaches back again: what was let go is read again.
  feed.sync(twoBooks('5m'), all, T, now);
  await settle();
  feed.sync(twoBooks('5m'), all, T, now);
  await settle();
  assert.equal(held(feed, twoBooks('5m'), all, T, now), all.length);
});

test('a request that never answers lets go of the timeframe after a while, and it is read again', async () => {
  const T = 5 * MIN, now = 1_000 * T + 2 * MIN, starts = candlesFrom(901, 1_000, T);
  const { source, asks, setHold } = columnsSource();
  setHold(true);
  const feed = new DepthFeed({ source } as never, () => {}, 20);
  feed.sync(twoBooks('5m'), starts, T, now);
  await settle();
  assert.equal(asks.length, 1);
  await new Promise(r => setTimeout(r, 40));
  feed.sync(twoBooks('5m'), starts, T, now + 1_000);
  assert.equal(asks.length, 1, 'not again at once');
  feed.sync(twoBooks('5m'), starts, T, now + 6_000);
  assert.equal(asks.length, 2, 'again after the wait');
});

test('a candle runs again only when its depth changed: a window read again as it was keeps its revision, one let go or dropped does not', () => {
  const cache = new DepthCache(), times = Float64Array.from([0, M, 2 * M]);
  const msg = (revision: number, over: Partial<DepthMessage>): DepthMessage => ({ t: 'depth', key: '1m', revision, reset: false, books: [], drop: [], ...over });
  const w = () => ({ bins: [99, 100], bid: [8, 0], ask: [0, 10] });
  cache.apply(msg(1, { reset: true, books: [book('a:BTC', 'binance', -Infinity, Infinity, [0, M, 2 * M], w), book('b:BTC', 'bybit', -Infinity, Infinity, [2 * M], w)] }));
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
  cache.apply({ t: 'depth', key: '1m', revision: 1, reset: true, drop: [], books: [bad([0, 1], [Infinity, 1], [99, 100]), { ...bad([0, 1], [1, 1], [100, 99]), id: 'b:BTC' }, { ...bad([-1, 1], [1, 1], [99, 100]), id: 'c:BTC' }] });
  assert.equal(cache.reader.books(M, {}, ''), 0);
  const empty = 200_000, bins = Array.from({ length: empty + 1 }, (_, i) => 100 + i), usd = Array.from({ length: empty + 1 }, (_, i) => i === empty ? 10 : 0);
  const r = reachOf([win(10, bins, usd)], 'ask', 1000, 5);
  assert.ok(r.cost >= empty, `cost ${r.cost}`);
});

test('a depth function only named (kept under another name, handed on) still has the page read the book', () => {
  assert.ok(analyze('var reach = askdepth\nline(reach(5))\n').inputs.has('depth'));
  assert.ok(analyze('function f(g) { return g(5) }\nline(f(depthabove))\n').inputs.has('depth'));
  assert.ok(!analyze('line(close)\n').inputs.has('depth'));
});
