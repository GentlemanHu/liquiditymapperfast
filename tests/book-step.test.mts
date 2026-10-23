import test from 'node:test';
import assert from 'node:assert/strict';
import { BinancePerpConnector, HyperliquidConnector } from '../src/shared/venues.ts';
import { usableStep, type ValuedBook } from '../src/shared/levels.ts';
import { gridStepFor } from '../src/shared/grid.ts';
import { mergeByDistance } from '../src/shared/merge.ts';
import { frameOf } from '../src/app/browser/levels-frame.ts';

// The step a valued book was merged on (`ValuedBook.step`) in the browser engine: the connector's valuation, and the frame the feeds worker posts.

/** A deep book around 81,280, best level first: bids 0.37 apart going down, asks 0.41 up, the sizes in base. */
function levels(): { bids: [number, number][]; asks: [number, number][] } {
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 1_200; i++) { bids.push([81_279.95 - i * 0.37, 0.01 + (i % 7) * 0.02]); asks.push([81_280.05 + i * 0.41, 0.01 + (i % 5) * 0.02]); }
  return { bids, asks };
}
/** A Binance perpetual (the browser engine's own connector) holding that book. */
function seeded(): BinancePerpConnector {
  const book = new BinancePerpConnector(), { bids, asks } = levels();
  book.state = 'connecting';
  book.seed(10, bids, asks);
  return book;
}

test('the browser engine\'s valuation carries the step it merged on: the recorder\'s when it is given one, else the grid for the mid', () => {
  const now = Date.now();
  assert.equal(seeded().valued(now, 10)!.step, 10, 'the step the engine passes from its recorder');
  assert.equal(seeded().valued(now, 0.5)!.step, 0.5);
  assert.equal(seeded().valued(now)!.step, gridStepFor(81_280), 'none given: the grid for the mid');
  for (const unusable of [0, -1, NaN]) assert.equal(seeded().valued(now, unusable)!.step, gridStepFor(81_280), `an unusable step (${unusable}) is the grid for the mid`);
  // The valuation is cached with its step: the same object comes back until the book changes.
  const book = seeded(), first = book.valued(now, 10)!;
  assert.equal(book.valued(now, 10), first);
  assert.equal(first.step, 10);
});

test('the step on a browser book is the number its merge used: the book is mergeByDistance of the raw levels at that step', () => {
  const book = seeded().valued(Date.now(), 10)!;
  // The levels as the venue holds them, in USD (price times size, the unit 1), as the merge is given them.
  const rows = (list: [number, number][]) => { const lo = Float64Array.from(list, r => r[0]); return { lo, hi: lo, usd: Float64Array.from(list, r => r[0] * r[1]) }; };
  const raw = levels(), bids = rows(raw.bids), asks = rows(raw.asks), mid = (bids.lo[0]! + asks.lo[0]!) / 2;
  const merged = { bids: mergeByDistance(bids, mid, book.step!, true), asks: mergeByDistance(asks, mid, book.step!, false) };
  assert.deepEqual([...book.bids.lo], [...merged.bids.lo]); assert.deepEqual([...book.bids.usd], [...merged.bids.usd]);
  assert.deepEqual([...book.asks.lo], [...merged.asks.lo]); assert.deepEqual([...book.asks.usd], [...merged.asks.usd]);
});

test('a grouped book in the browser engine carries no step: Hyperliquid\'s bands are never merged', () => {
  const now = Date.now();
  const hl = new HyperliquidConnector({ coin: 'ETH', symbol: 'ETH', unit: 1 });
  hl.state = 'connecting';
  hl.onMessage(JSON.stringify({ channel: 'l2Book', data: { coin: 'ETH', time: now, levels: [[{ px: '2500', sz: '4', n: 3 }, { px: '2490', sz: '9', n: 5 }], [{ px: '2510', sz: '2', n: 1 }, { px: '2520', sz: '7', n: 4 }]] } }));
  const book = hl.valued(now, 0.5)!;
  assert.equal(book.coarse, true);
  assert.ok(!('step' in book));
});

test('the frame the feeds worker posts carries a book\'s step as the server\'s wire does: only a usable one, and every other field as before', () => {
  const merged = seeded().valued(Date.now(), 10)!;
  const grouped: ValuedBook = { instrumentId: 'hyperliquid:ETH', venue: 'hyperliquid', timestamp: 5, coarse: true, bids: { lo: Float64Array.of(2500), hi: Float64Array.of(2505), usd: Float64Array.of(10_000) }, asks: { lo: Float64Array.of(2505), hi: Float64Array.of(2510), usd: Float64Array.of(2_000) }, touch: { lo: 2500, hi: 2510 } };
  const frame = frameOf([merged, grouped, { ...merged, instrumentId: 'bad:one', step: NaN }, { ...merged, instrumentId: 'zero:one', step: 0 }], 123);
  assert.equal(frame.asOf, 123);
  assert.deepEqual(frame.books.map(b => [b.id, b.step]), [['binance:BTCUSDT', 10], ['hyperliquid:ETH', undefined], ['bad:one', undefined], ['zero:one', undefined]]);
  assert.deepEqual(frame.books.map(b => 'step' in b), [true, false, false, false], 'a book without a usable step has no such key');
  assert.deepEqual(frame.books[1]!.touch, { lo: 2500, hi: 2510 }, 'the touch still rides along');
  assert.deepEqual([...frame.books[0]!.bids.usd], [...merged.bids.usd]);
  assert.equal(frame.books[0]!.bids.hi, frame.books[0]!.bids.lo, 'point levels still share one array for both edges');
});

test('a usable step is a finite number above zero', () => {
  for (const good of [0.02, 20, 1e-9, 1e9]) assert.ok(usableStep(good), String(good));
  for (const bad of [0, -1, NaN, Infinity, -Infinity, '20', null, undefined, {}, [20], true]) assert.ok(!usableStep(bad), String(bad));
});
