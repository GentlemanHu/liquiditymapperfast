import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnStart, groupBars, groupCandles, groupChanges, groupParts, groupUsd, groupVenues, groupWho, takerSidedShare } from '../src/app/panes/oi-group.ts';
import { nlnsModel, type NlnsCandle, type NlnsMarket } from '../src/app/delta/nlns.ts';
import { chainedOi, oiChangeByTime, oiSumOf, oiUsdChangeByTime, type OiPart } from '../src/app/oi-change.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const H = 3_600_000, D4 = 4 * H, T = Date.UTC(2026, 9, 9, 0);
const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });
const sum = (m: ReadonlyMap<number, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

test('a level grouped into drawn candles keeps the first open, the extremes and the last close', () => {
  const bars: OiBar[] = [[T, 10, 12, 9, 11], [T + H, 11, 15, 11, 14], [T + 2 * H, 14, 14, 8, 9], [T + 4 * H, 9, 10, 9, 10]];
  assert.deepEqual(groupBars(bars, D4), [[T, 10, 15, 8, 9], [T + D4, 9, 10, 9, 10]]);
  assert.equal(drawnStart(T + 3 * H + 59 * 60_000, D4), T);
  assert.deepEqual(groupBars(bars, H), bars, 'at the chart\'s own length nothing changes');
});

test('grouped changes add up to the chart candles\' changes; the first drawn candle, and one with none known, have none', () => {
  // The bars start mid-way through a drawn candle (T - 2h): that first candle holds only part of its time and the pane draws no bar for it.
  const oi: OiBar[] = [bar(T - 2 * H, 95), bar(T - H, 100), bar(T, 100), bar(T + H, 104), bar(T + 2 * H, 101), bar(T + 3 * H, 109), bar(T + 4 * H, 109), bar(T + 5 * H, 120)];
  const change = new Map([[T - H, 5], [T + H, 4], [T + 2 * H, -3], [T + 3 * H, 8], [T + 5 * H, 11]]);
  const g = groupChanges(oi, change, D4);
  assert.deepEqual([...g.change], [[T, 9], [T + D4, 11]], 'the first drawn candle (T - 4h) has no change; the others add up their candles\'');
  assert.deepEqual(g.oi.map(b => b[4]), [100, 109, 120], 'the level at each drawn candle\'s last chart candle');
  assert.deepEqual([...groupChanges([bar(T, 1)], new Map(), D4).change], [], 'one reading: no change');
});

test('venues added together: the drawn candles\' changes and each venue\'s own part add up to the chart candles\', a venue starting mid-way included', () => {
  // Venue b starts in the second hour of the second drawn candle: its first reading is no change, its next ones are (oiChangeByTime). Worked
  // out again from its grouped bars, the drawn candle it starts in would have counted none of them.
  const a: OiPart = { id: 'binance:BTCUSDT', bars: [bar(T - H, 98), bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 105), bar(T + 3 * H, 112), bar(T + 4 * H, 120), bar(T + 5 * H, 118)] };
  const b: OiPart = { id: 'bybit:BTCUSDT', bars: [bar(T + H, 50), bar(T + 2 * H, 55), bar(T + 3 * H, 53), bar(T + 4 * H, 60), bar(T + 5 * H, 61)] };
  const parts = [a, b], oi = chainedOi(oiSumOf(parts, H)), fine = oiChangeByTime(oi, parts, H);
  const g = groupChanges(oi, fine, D4), v = groupVenues(oi, parts, H, D4);
  assert.equal(g.change.get(T), (2 + 10 - 5 + 7) + (5 - 2), 'the second drawn candle: a\'s changes at T..T+3h and b\'s two (its first reading is none)');
  for (const [s, total] of g.change) {
    const venues = [...v.change.values()].reduce((x, m) => x + (m.get(s) ?? 0), 0);
    assert.equal(venues, total, `each venue's part adds up to the drawn candle's change at ${s}`);
  }
  assert.equal(v.change.get('bybit:BTCUSDT')!.get(T), 5 - 2, 'b\'s own part in the candle it starts in');
  assert.deepEqual([v.counted.get(T), v.cohorts.get(T)], [2, 'binance:BTCUSDT,bybit:BTCUSDT']);
  assert.equal(v.counted.get(T - D4), undefined, 'the first drawn candle has none');
  assert.deepEqual(groupParts(parts, D4).map(p => p.bars.map(x => x[4])), [[98, 112, 118], [53, 61]]);
});

test('a venue\'s gap longer than two chart candles is no change, grouped or not', () => {
  // b is missing for three hours (past the two-hour hold): the chart candles count no change across the gap, so neither does its part.
  const a: OiPart = { id: 'binance:BTCUSDT', bars: Array.from({ length: 12 }, (_, i) => bar(T - D4 + i * H, 100 + i)) };
  const b: OiPart = { id: 'bybit:BTCUSDT', bars: [bar(T - D4, 50), bar(T, 52), bar(T + 4 * H, 60), bar(T + 5 * H, 61), bar(T + 6 * H, 62), bar(T + 7 * H, 63)] };
  const parts = [a, b], oi = chainedOi(oiSumOf(parts, H)), fine = oiChangeByTime(oi, parts, H), v = groupVenues(oi, parts, H, D4);
  const g = groupChanges(oi, fine, D4);
  assert.equal(v.change.get('bybit:BTCUSDT')!.get(T) ?? 0, 0, 'b\'s step across its gap (51 at T-3h to 52 at T) is counted nowhere');
  assert.equal(sum(g.change), [...v.change.values()].reduce((x, m) => x + sum(m), 0));
});

test("the venues a drawn candle's level is made of are those read at its last chart candle, held as the chart candles hold them", () => {
  // b stops at T + 1h (a sampler that hung): the chart candles hold its reading two hours, to T + 3h. Held for two drawn candles of four
  // hours, it would still be counted eight hours on; read at each drawn candle's last chart candle, it is not.
  const a: OiPart = { id: 'binance:BTCUSDT', bars: Array.from({ length: 16 }, (_, i) => bar(T - D4 + i * H, 100 + i)) };
  const b: OiPart = { id: 'bitget:BTCUSDT', bars: Array.from({ length: 6 }, (_, i) => bar(T - D4 + i * H, 50 + i)) };
  const parts = [a, b], oi = chainedOi(oiSumOf(parts, H)), v = groupVenues(oi, parts, H, D4), fine = oiSumOf(parts, H);
  assert.deepEqual([...v.closeAt], [[T - D4, T - H], [T, T + 3 * H], [T + D4, T + 7 * H], [T + 2 * D4, T + 11 * H]], "each drawn candle's last chart candle");
  assert.deepEqual([...v.read], [[T - D4, 2], [T, 2], [T + D4, 1], [T + 2 * D4, 1]], 'b held to T + 3h, then gone; the first drawn candle has its level too');
  for (const [s, t] of v.closeAt) assert.equal(v.read.get(s), fine.venues[fine.bars.findIndex(x => x[0] === t)], `as sumOi counts the chart candle at ${t}`);
  assert.equal(v.counted.get(T), 2, "b's changes in T..T+1h still count in the bar");
  // The drawn-candle hold the pane used before: b's last grouped bar (T) held to T + 2 drawn candles.
  assert.equal(oiSumOf(groupParts(parts, D4), D4).venues[2], 2, 'held for two drawn candles, b was counted at T + 4h');
});

test('the USD changes grouped add up per drawn candle, the first one without', () => {
  const a: OiPart = { id: 'binance:BTCUSDT', bars: Array.from({ length: 9 }, (_, i) => bar(T - H + i * H, 100 + 2 * i)) };
  const b: OiPart = { id: 'bybit:BTCUSDT', bars: Array.from({ length: 9 }, (_, i) => bar(T - H + i * H, 50 + i)) };
  const parts = [a, b], oi = chainedOi(oiSumOf(parts, H)), close = (t: number) => 60_000 + (t - T) / H;
  const usd = oiUsdChangeByTime(oi, parts, H, close), g = groupUsd(usd, oi, D4);
  assert.equal(g.get(T - D4), undefined);
  assert.equal(g.get(T), [T, T + H, T + 2 * H, T + 3 * H].reduce((x, t) => x + (usd.get(t) ?? 0), 0));
});

test('NL/NS grouped: every part, the change and what went to no side add up; the label is worked out again', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H, T + 4 * H, T + 5 * H];
  const market: NlnsMarket = { bars: [bar(T - H, 100), bar(T, 110), bar(T + H, 118), bar(T + 2 * H, 114), bar(T + 3 * H, 108), bar(T + 4 * H, 120), bar(T + 5 * H, 120)],
    flows: [flow(5e6), flow(-3e6), flow(-1e6), flow(2e6), flow(0), null] };
  const fine = nlnsModel(starts, [market], new Map(), starts.map(() => 0), H);
  const g = groupWho(fine, D4), first = g.get(T)!, total = (k: keyof NlnsCandle) => fine.filter(c => c.t < T + D4).reduce((x, c) => x + (c[k] as number), 0);
  for (const k of ['dOi', 'longOpened', 'longClosed', 'shortOpened', 'shortClosed', 'unassigned', 'unknown', 'unsidedUp', 'unsidedDown', 'longs', 'shorts', 'v'] as const) assert.equal(first[k], total(k), k);
  assert.equal(first.kind, 'mixed', 'new longs and new shorts in one drawn candle pull both ways');
  assert.equal(first.side, Math.sign(first.v));
  assert.equal(first.cum, fine[3]!.cum, 'the running sum at its last candle');
  assert.equal(g.get(T + D4)!.unassigned, 12, 'takers even: no side');
  assert.equal(groupWho(fine, 24 * H).get(T)!.dOi, fine.reduce((x, c) => x + c.dOi, 0));
});

test('the share the takers sided: the flow\'s, not the price\'s, and none where nothing said which way', () => {
  const starts = [T, T + H, T + 2 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 115)];
  const closes = new Map([[T, 50_000], [T + H, 49_000], [T + 2 * H, 49_500]]);
  const c = nlnsModel(starts, [{ bars, flows: [null, flow(3), null] }], closes, starts.map(() => 0), H);
  assert.deepEqual(c.map(x => [x.byPrice, x.byPriceOi]), [[false, 0], [false, 0], [true, 5]], 'the flow decided the second hour, the price the third');
  assert.equal(takerSidedShare(c[1]!), 1);
  assert.equal(takerSidedShare(c[2]!), 0);
  assert.equal(takerSidedShare(groupWho(c, D4).get(T)!), 10 / 15, 'two thirds of the drawn candle\'s sided change came from its takers');
  // No flow and no closes (older than the chart's candles): nothing said which way, and the takers sided none of it.
  const blind = nlnsModel(starts, [{ bars, flows: [null, null, null] }], new Map(), starts.map(() => 0), H);
  assert.equal(blind[1]!.unknown, 10);
  assert.equal(takerSidedShare(blind[1]!), 0, 'drawn as a rise, not grey');
  assert.equal(takerSidedShare(c[0]!), 1, 'nothing to side: as the takers left it');
});

test('the chart\'s candles grouped: open, extremes, close, and the volumes added where every candle has them', () => {
  const c: CandleRow[] = [[T, 1, 3, 0.5, 2, 10, 5, 6], [T + H, 2, 4, 1, 3, 20, 4, 9], [T + 2 * H, 3, 3, 2, 2.5, 5, 1]];
  assert.deepEqual(groupCandles(c, D4), [[T, 1, 4, 0.5, 2.5, 35, 10, undefined, undefined, undefined, undefined]]);
});
