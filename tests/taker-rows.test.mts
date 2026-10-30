import test from 'node:test';
import assert from 'node:assert/strict';
import { TakerRows } from '../src/app/measures/taker-rows.ts';
import { initialState, type AppState, type CandleRow } from '../src/app/store.ts';
import type { Hub } from '../src/app/hub.ts';

const H = 3_600_000, T = 100 * H;

/** A hub whose exchange candles say who bought from `held` on, and that notes where it was asked to read from. */
function fakeHub(held: CandleRow[]) {
  const asked: number[] = [];
  const h = { id: 'binance:BTCUSDT', version: 1, bars: held, ensure: (_t: unknown, from: number) => { asked.push(from); } };
  return { hub: { candleTaker: () => h } as unknown as Hub, asked };
}
const taker = (t: number, buy: number): CandleRow => [t, 1, 1, 1, 1, 10, 3, buy, 3, 10, buy];

test('the chart\'s own candles that say who bought are taken as they are; the exchange is read only from the first that does not', () => {
  const candles: CandleRow[] = [taker(T, 4), taker(T + H, 6), [T + 2 * H, 1, 1, 1, 1, 10, 3]];
  const state: AppState = { ...initialState(), marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', timeframe: '1h', candlesTimeframe: '1h', candles };
  const { hub, asked } = fakeHub([taker(T + 2 * H, 7)]);
  const rows = new TakerRows().get(hub, state, H, T, () => {})!;
  assert.deepEqual(asked, [T + 2 * H], 'only the newest, which the live stream rebuilt without them');
  assert.deepEqual([...rows.keys()].sort((a, b) => a - b), [T, T + H, T + 2 * H], 'all three are there');
  assert.equal(rows.get(T + H)![7], 6, 'from the chart\'s own candle');
  assert.equal(rows.get(T + 2 * H)![7], 7, 'from the exchange');
});

test('candles from a server carry no taker figures: the exchange is read from the first candle asked for, as before', () => {
  const candles: CandleRow[] = [[T, 1, 1, 1, 1, 10, 3], [T + H, 1, 1, 1, 1, 10, 3]];
  const state: AppState = { ...initialState(), marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', timeframe: '1h', candlesTimeframe: '1h', candles };
  const { hub, asked } = fakeHub([]);
  new TakerRows().get(hub, state, H, T, () => {});
  assert.deepEqual(asked, [T]);
  // Before the chart's candles (the exchange's history drawn ahead of them): from there.
  const early = fakeHub([]);
  new TakerRows().get(early.hub, state, H, T - 5 * H, () => {});
  assert.deepEqual(early.asked, [T - 5 * H]);
  // The candles of the timeframe before, still on screen right after a switch: not taken.
  const before = fakeHub([]);
  new TakerRows().get(before.hub, { ...state, candles: [taker(T, 4)], candlesTimeframe: '5m' }, H, T, () => {});
  assert.deepEqual(before.asked, [T]);
  // Rows asked for at another timeframe than the chart's candles: those candles are not taken for them.
  const other = fakeHub([]);
  new TakerRows().get(other.hub, { ...state, candles: [taker(T, 4)] }, 5 * 60_000, T, () => {});
  assert.deepEqual(other.asked, [T]);
});
