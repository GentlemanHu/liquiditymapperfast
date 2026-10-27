import test from 'node:test';
import assert from 'node:assert/strict';
import { buysAndSells, candleArrays, filterKey, liquidationOrderSide, marketInfo, marketsMatching, sourceInputs, transferables, type BarInputs } from '../src/app/script/inputs.ts';
import { liquidationBuckets } from '../src/app/panes/bar-stats.ts';
import type { CandleRow } from '../src/app/store.ts';

test('a candle\'s buys and sells come from its delta and gross volume, and an unrecorded one is unknown, not zero', () => {
  assert.deepEqual(buysAndSells({ delta: 20, gross: 100, low: 0, high: 0 }), [60, 40]);
  assert.deepEqual(buysAndSells({ delta: -100, gross: 100, low: 0, high: 0 }), [0, 100]);
  const [b, s] = buysAndSells(null);
  assert.ok(Number.isNaN(b) && Number.isNaN(s));
});

test('a liquidated short is a forced buy and a liquidated long a forced sell, as the Bar stats count them', () => {
  assert.equal(liquidationOrderSide('short'), 'buy');
  assert.equal(liquidationOrderSide('long'), 'sell');
  const day = Date.UTC(2026, 9, 26), tf = 60_000;
  const rows = [{ t: day + 5_000, id: 'binance:BTCUSDT', side: 'short' as const, price: 1, usd: 1_000, reported: 1, kind: 'fill' as const }, { t: day + 65_000, id: 'binance:BTCUSDT', side: 'long' as const, price: 1, usd: 300, reported: 1, kind: 'fill' as const }];
  const b = liquidationBuckets(new Map([[day, { rows, cut: false, to: day + 86_400_000 }]]), ['binance:BTCUSDT'], [day, day + tf], tf, 0, day + 86_400_000);
  assert.equal(b.buy.get(day), 1_000, liquidationOrderSide('short'));
  assert.equal(b.sell.get(day + tf), 300, liquidationOrderSide('long'));
});

test('a filter keeps markets by kind, exchange and quote, and has one key whatever its order', () => {
  const all = [
    { id: 'binance:BTCUSDT', venue: 'binance', kind: 'perp' as const, quote: 'USDT' },
    { id: 'binancespot:BTCUSDT', venue: 'binancespot', kind: 'spot' as const, quote: 'USDT' },
    { id: 'coinbase:BTC-USD', venue: 'coinbase', kind: 'spot' as const, quote: 'USD' },
  ];
  assert.deepEqual(marketsMatching(all, {}), all.map(m => m.id));
  assert.deepEqual(marketsMatching(all, { kinds: ['spot'] }), ['binancespot:BTCUSDT', 'coinbase:BTC-USD']);
  assert.deepEqual(marketsMatching(all, { kinds: ['spot'], quotes: ['usd'] }), ['coinbase:BTC-USD']);
  assert.deepEqual(marketsMatching(all, { venues: ['BINANCE'] }), ['binance:BTCUSDT', 'binancespot:BTCUSDT'], 'an exchange is its family, spot and perpetual');
  assert.deepEqual(marketsMatching(all, { venues: ['binance/perp'] }), ['binance:BTCUSDT']);
  assert.deepEqual(marketsMatching(all, { venues: ['binance/spot', 'coinbase'] }), ['binancespot:BTCUSDT', 'coinbase:BTC-USD']);
  assert.equal(filterKey({ venues: ['b', 'a'], kinds: ['spot'] }), filterKey({ kinds: ['spot'], venues: ['A', 'B', 'a'] }));
  assert.equal(filterKey({}), '');
  assert.deepEqual(marketInfo([{ instrumentId: 'coinbase:BTC-USD', venue: 'coinbase', marketType: 'spot', quote: 'usd' }], 'coinbase:BTC-USD'), { id: 'coinbase:BTC-USD', venue: 'coinbase', kind: 'spot', quote: 'USD' });
  assert.equal(marketInfo([], 'okx:BTC-USDT-SWAP').kind, 'perp', 'a market the list does not hold counts as a perpetual');
});

test('candles become arrays, oldest first, and the newest is under way until its timeframe has passed', () => {
  const rows: CandleRow[] = [[0, 1, 2, 0.5, 1.5, 10], [60_000, 1.5, 3, 1, 2, 20], [60_000, 9, 9, 9, 9, 9], [120_000, 2, 2, 2, 2, 0]];
  const c = candleArrays(rows, 60_000, 150_000);
  assert.deepEqual([...c.time], [0, 60_000, 120_000]);
  assert.deepEqual([...c.close], [1.5, 2, 2]);
  assert.equal(c.forming, true);
  assert.equal(candleArrays(rows, 60_000, 180_000).forming, false);
});

test('one set of markets\' inputs: flows by candle, liquidations where answered, NaN elsewhere', () => {
  const time = Float64Array.from([0, 60_000, 120_000]);
  const s = sourceInputs(time, ['a', 'b'], {
    flows: () => [{ delta: 10, gross: 30, low: 0, high: 0 }, null, { delta: 0, gross: 0, low: 0, high: 0 }],
    liquidations: () => ({ buy: new Map([[0, 5], [60_000, 0]]), sell: new Map([[0, 0]]) }),
  });
  assert.deepEqual([...s.vbuy].map(v => Number.isNaN(v) ? 'na' : v), [20, 'na', 0]);
  assert.deepEqual([...s.lbuy].map(v => Number.isNaN(v) ? 'na' : v), [5, 0, 'na']);
  assert.deepEqual([...s.lsell].map(v => Number.isNaN(v) ? 'na' : v), [0, 'na', 'na']);
  assert.equal(s.markets, 2);
  const none = sourceInputs(time, [], { flows: () => assert.fail('no markets, nothing read'), liquidations: () => undefined });
  assert.ok([...none.vbuy, ...none.lsell].every(v => v === 0), 'a set with no market on the page reads 0, as scripts for it expect');
  assert.equal(none.markets, 0);
  const inputs: BarInputs = { tf: 60_000, time, open: time, high: time, low: time, close: time, volume: time, sources: { '': s }, forming: false };
  assert.equal(transferables(inputs).length, 5, 'the candles share one buffer here; each buffer is named once');
});
