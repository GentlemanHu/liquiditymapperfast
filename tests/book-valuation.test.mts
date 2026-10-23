import test from 'node:test';
import assert from 'node:assert/strict';
import { usdBookLevels } from '../src/core/book-valuation.mts';
import { valueBook } from '../src/server/v2/levels.mts';
import { gridStepFor } from '../src/shared/grid.ts';
import { mergeByDistance } from '../src/shared/merge.ts';

test('contract book without a documented face value stays out of USD ladders', () => {
  const book = { units: 'contract', bids: [{ price: 100, amount: 2 }], asks: [{ price: 101, amount: 3 }] };
  assert.deepEqual(usdBookLevels(book, { quantityUnit: 'contract', lotSize: 0.0001 }), []);
});

test('contract book with verified face value produces USD rows', () => {
  const book = { units: 'contract', bids: [{ price: 100, amount: 2 }], asks: [{ price: 101, amount: 3 }] };
  const rows = usdBookLevels(book, { quantityUnit: 'contract', contractValue: 0.01, quote: 'USDT' });
  assert.deepEqual(rows.map(({ price, amount, contractAmount, side }) => ({ price, amount, contractAmount, side })), [
    { price: 100, amount: 0.02, contractAmount: 2, side: 'bid' },
    { price: 101, amount: 0.03, contractAmount: 3, side: 'ask' },
  ]);
  assert.ok(Math.abs(rows[0].notionalUsd - 2) < 1e-12);
  assert.ok(Math.abs(rows[1].notionalUsd - 3.03) < 1e-12);
  assert.equal(rows[0].notionalEstimated, true);
  assert.equal(rows[0].valuation.quoteToUsd, 1);
});

test('quote-denominated rows normalize to base and use an explicit stable conversion', () => {
  const rows = usdBookLevels({ units: 'quote', bids: [{ price: 77_000, amount: 125_000 }], asks: [{ price: 77_001, amount: 80_000 }] }, { quantityUnit: 'quote', quote: 'USDT' });
  assert.deepEqual(rows.map(({ price, amount, quoteAmount, notionalUsd }) => ({ price, amount, quoteAmount, notionalUsd })), [
    { price: 77_000, amount: 125_000 / 77_000, quoteAmount: 125_000, notionalUsd: 125_000 },
    { price: 77_001, amount: 80_000 / 77_001, quoteAmount: 80_000, notionalUsd: 80_000 },
  ]);
});

test('non-stable quote fails closed unless a USD conversion is supplied', () => {
  assert.deepEqual(usdBookLevels({ units: 'base', bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'base', quote: 'BTC' }), []);
  const rows = usdBookLevels({ units: 'base', quote: 'BTC', bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'base', quote: 'BTC', quoteToUsd: 60_000 });
  assert.equal(rows[0].notionalUsd, 12_000_000);
  assert.equal(rows[0].notionalEstimated, true);
});

test('null and empty source notionals are missing, not authoritative zero', () => {
  const options = { quantityUnit: 'base', quote: 'USDT' };
  const objectRows = usdBookLevels({ units: 'base', bids: [
    { price: 100, amount: 2, notionalUsd: null },
    { price: 100, amount: 2, notionalUsd: '' },
  ] }, options);
  const tupleRows = usdBookLevels({ units: 'base', bids: [[100, 2, null], [100, 2, '']] }, options);
  for (const rows of [objectRows, tupleRows]) {
    assert.deepEqual(rows.map((row) => row.notionalUsd), [200, 200]);
    assert.ok(rows.every((row) => row.notionalEstimated));
  }
});

test('mixed base, linear-contract, inverse-contract, and source-notional rows retain units', () => {
  const rows = usdBookLevels({
    units: 'base', quote: 'USDT', bids: [{ price: 100, amount: 2 }],
  }, { quantityUnit: 'base', quote: 'USDT' });
  const linear = usdBookLevels({ units: 'contract', quote: 'USDT', contractValue: 0.01, bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'contract', quote: 'USDT', contractValue: 0.01 });
  const inverse = usdBookLevels({ units: 'contract', contractType: 'inverse', quote: 'USD', contractValue: 10, bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'contract', quote: 'USD', contractValue: 10, contractType: 'inverse' });
  const supplied = usdBookLevels({ units: 'base', bids: [{ price: 100, amount: 2, notionalUsd: 123 }] }, { quantityUnit: 'base' });
  assert.equal(rows[0].amount, 2);
  assert.equal(linear[0].amount, 0.02);
  assert.equal(linear[0].contractAmount, 2);
  assert.equal(inverse[0].amount, 0.2);
  assert.equal(inverse[0].notionalUsd, 20);
  assert.equal(supplied[0].notionalUsd, 123);
  assert.equal(supplied[0].notionalEstimated, false);
});

// ---- the step a valued book was merged on (`ValuedBook.step`) --------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 22, 12);
const venue = { venue: 'x', quote: 'USDT' };
/** A deep BTC book around 81,280 (a mid of exactly that): bids 0.37 apart going down, asks 0.41 apart going up, 1,500 levels a side, the sizes in base. */
function deepBook(extra: Record<string, unknown> = {}) {
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 1_500; i++) { bids.push([81_279.95 - i * 0.37, 0.01 + (i % 7) * 0.02]); asks.push([81_280.05 + i * 0.41, 0.01 + (i % 5) * 0.02]); }
  return { bids, asks, units: 'base', sourceTimestamp: T0, ...extra };
}

test('a book merged by distance carries the step its buckets were made on: the recorder\'s, or the grid for its mid', () => {
  const book = deepBook();
  assert.equal(valueBook('x:BTC', book, venue, T0, 10)!.step, 10, 'the recorder\'s step');
  assert.equal(valueBook('x:BTC', book, venue, T0, 20)!.step, 20);
  assert.equal(gridStepFor(81_280), 20);
  for (const unusable of [undefined, 0, -5, NaN]) assert.equal(valueBook('x:BTC', book, venue, T0, unusable)!.step, 20, `no usable recorder step (${unusable}): the grid for the mid`);
  // The general path (anything unusual about the book switches it on) merges too, and says the same.
  const general = deepBook({ levelMetadata: { bids: { '-1': { note: 'unrelated' } }, asks: {} } });
  assert.equal(valueBook('x:BTC', general, venue, T0, 10)!.step, 10);
});

test('a book nothing merged carries no step: grouped books keep the venue\'s bands, a one-sided book has no mid', () => {
  const hl = valueBook('hyperliquid:BTC-PERP', { bids: [[85_100, 2], [85_000, 3]], asks: [[85_200, 4], [85_300, 5]], units: 'base', nSigFigs: 3, sourceTimestamp: T0 }, { venue: 'hyperliquid', quote: 'USD' }, T0, 20)!;
  assert.equal(hl.coarse, true);
  assert.ok(!('step' in hl), 'Hyperliquid\'s bands are never merged');
  const deribit = valueBook('deribit:BTC-PERPETUAL', { bids: [[82_980, 1]], asks: [[82_990, 1]], units: 'base', sourceGrouping: 10, sourceTimestamp: T0 }, { venue: 'deribit', quote: 'USD' }, T0, 20)!;
  assert.ok(deribit.coarse && !('step' in deribit));
  const oneSided = valueBook('x:BTC', { bids: [[100, 1], [99, 1]], asks: [], units: 'base', sourceTimestamp: T0 }, venue, T0, 20)!;
  assert.deepEqual([oneSided.bids.usd.length, oneSided.asks.usd.length], [2, 0]);
  assert.ok(!('step' in oneSided), 'with one side there is no mid to merge about');
});

test('the step on a book is the number its merge used: the book is what mergeByDistance makes of the raw levels at that step, and keeps USD per bin of that grid', () => {
  const raw = deepBook();
  const side = (rows: [number, number][]) => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[0])), usd: Float64Array.from(rows.map(r => r[0] * r[1])) });
  const rawBids = side(raw.bids as [number, number][]), rawAsks = side(raw.asks as [number, number][]);
  const mid = (rawBids.lo[0]! + rawAsks.lo[0]!) / 2;
  assert.equal(mid, 81_280);
  const levels = new Map<number, number>();
  for (const step of [10, 20]) {
    const book = valueBook('x:BTC', raw, venue, T0, step)!;
    assert.equal(book.step, step);
    const bids = mergeByDistance(rawBids, mid, book.step!, true), asks = mergeByDistance(rawAsks, mid, book.step!, false);
    assert.deepEqual([...book.bids.lo], [...bids.lo]); assert.deepEqual([...book.bids.usd], [...bids.usd]);
    assert.deepEqual([...book.asks.lo], [...asks.lo]); assert.deepEqual([...book.asks.usd], [...asks.usd]);
    levels.set(step, book.bids.lo.length);
  }
  assert.ok(levels.get(10)! > levels.get(20)!, 'a finer step is a finer merge: the number says which merge this is');
  // What the number is for: on its grid (or a multiple of it) a bin holds the same USD before and after the merge, within 250 steps of the mid;
  // on a grid the buckets straddle (a ladder row of 25 on a step of 20) the merge moves USD across a row's edge with nothing changed at the venue.
  const book = valueBook('x:BTC', raw, venue, T0, 20)!;
  const perBin = (rows: { lo: Float64Array; usd: Float64Array }, grid: number): Map<number, number> => {
    const out = new Map<number, number>();
    for (let i = 0; i < rows.usd.length; i++) { const bin = Math.floor(rows.lo[i]! / grid); out.set(bin, (out.get(bin) ?? 0) + rows.usd[i]!); }
    return out;
  };
  const differing = (grid: number): number => {
    let n = 0;
    for (const [rawSide, merged] of [[rawBids, book.bids], [rawAsks, book.asks]] as const) {
      const a = perBin(rawSide, grid), b = perBin(merged, grid);
      for (const [bin, usd] of a) {
        if (Math.abs((bin + 0.5) * grid - mid) > 250 * 20 - 2 * grid) continue;
        if (Math.abs((b.get(bin) ?? 0) - usd) > 1e-9 * Math.max(1, usd)) n++;
      }
    }
    return n;
  };
  assert.equal(differing(20), 0, 'on the book\'s own step nothing moves between bins');
  assert.equal(differing(40), 0, 'nor on a multiple of it');
  assert.ok(differing(25) > 0, 'but on a ladder step of 25 some bins differ from what the venue holds');
});
