import test from 'node:test';
import assert from 'node:assert/strict';
import { absorptionAnswer, liquidationAnswer } from '../src/app/traded/metrics.ts';
import { readTraded } from '../src/app/traded/settings.ts';
import type { AbsorptionGroup } from '../src/shared/absorption.ts';
import type { Liquidation } from '../src/shared/liquidations.ts';

const T0 = 1_800_000_000_000, MIN = 60_000;
const liq = (id: string, t: number, side: 'long' | 'short', price: number, usd: number): Liquidation => ({ t, id, side, price, usd, reported: price, kind: 'fill' });

test('liquidations by price: shorts liquidated in the first side, longs in the second, only the instruments and the window asked for', () => {
  const answer = liquidationAnswer([
    liq('binance:BTCUSDT', T0 + MIN, 'short', 80_010, 1_000), liq('binance:BTCUSDT', T0 + 2 * MIN, 'long', 80_040, 5_000),
    liq('bybit:BTCUSDT', T0 + 3 * MIN, 'long', 79_990, 2_000),
    liq('okx:BTC-USDT-SWAP', T0 + MIN, 'long', 80_000, 9_000), // not asked for
    liq('binance:BTCUSDT', T0 + 10 * MIN, 'long', 80_000, 9_000), // after the window
  ], ['binance:BTCUSDT', 'bybit:BTCUSDT'], T0, T0 + 5 * MIN, 50);
  const rows = Object.fromEntries(answer.instruments.map(i => [i.id, i.rows]));
  assert.deepEqual(rows['binance:BTCUSDT'], [[80_000, 1_000, 5_000]], 'both fall in the row from 80,000 on rows of 50');
  assert.deepEqual(rows['bybit:BTCUSDT'], [[79_950, 0, 2_000]]);
  assert.equal(answer.instruments.length, 2);
});

test('absorption by price: the marked part of each group at its threshold, sells absorbed by resting buyers first, counted once', () => {
  // Steps: [credit, USD, fills, first, last], credits falling: at 400K the first two fills (300K), at 200K all three (450K).
  const g = (id: string, side: 'buy' | 'sell', price: number, t0: number): AbsorptionGroup => ({ id, side, price, t0, steps: [[500_000, 300_000, 2, t0, t0 + 5], [250_000, 450_000, 3, t0, t0 + 8]] });
  const thresholds = new Map<string, number | null>([['a', 400_000], ['b', 200_000], ['c', null]]);
  const answer = absorptionAnswer([g('a', 'sell', 80_010, T0), g('b', 'buy', 80_020, T0 + MIN), g('c', 'sell', 80_000, T0), g('b', 'buy', 80_000, T0 + 9 * MIN)], thresholds, T0, T0 + 5 * MIN, 50);
  const rows = Object.fromEntries(answer.instruments.map(i => [i.id, i.rows]));
  assert.deepEqual(rows.a, [[80_000, 300_000, 0]], 'market sells absorbed: resting buyers, the first side; the part at 400K');
  assert.deepEqual(rows.b, [[80_000, 0, 450_000]], 'market buys absorbed: resting sellers; all of it at 200K; the one after the window left out');
  assert.equal(rows.c, undefined, 'an instrument with no threshold yet has nothing marked');
});

test('the measure is stored with the volume profile settings; one this page does not know is traded volume', () => {
  assert.equal(readTraded({}).metric, 'volume');
  assert.equal(readTraded({ metric: 'liquidations' }).metric, 'liquidations');
  assert.equal(readTraded({ metric: 'absorption' }).metric, 'absorption');
  assert.equal(readTraded({ metric: 'tea leaves' }).metric, 'volume');
});
