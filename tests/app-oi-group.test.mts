import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnStart, groupBars, groupCandles, groupChanges, groupParts, groupWho, priceSidedShare } from '../src/app/panes/oi-group.ts';
import { nlnsModel, type NlnsCandle, type NlnsMarket } from '../src/app/delta/nlns.ts';
import { chainedOi, oiChangeByTime, oiSumOf, type OiPart } from '../src/app/oi-change.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const H = 3_600_000, D4 = 4 * H, T = Date.UTC(2026, 9, 9, 0);
const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });

test('a level grouped into drawn candles keeps the first open, the extremes and the last close', () => {
  const bars: OiBar[] = [[T, 10, 12, 9, 11], [T + H, 11, 15, 11, 14], [T + 2 * H, 14, 14, 8, 9], [T + 4 * H, 9, 10, 9, 10]];
  assert.deepEqual(groupBars(bars, D4), [[T, 10, 15, 8, 9], [T + D4, 9, 10, 9, 10]]);
  assert.equal(drawnStart(T + 3 * H + 59 * 60_000, D4), T);
  assert.deepEqual(groupBars(bars, H), bars, 'at the chart\'s own length nothing changes');
});

test('grouped changes add up to the chart candles\' changes; a drawn candle with none known has none', () => {
  const oi: OiBar[] = [bar(T, 100), bar(T + H, 104), bar(T + 2 * H, 101), bar(T + 3 * H, 109), bar(T + 4 * H, 109), bar(T + 5 * H, 120)];
  const change = new Map([[T + H, 4], [T + 2 * H, -3], [T + 3 * H, 8], [T + 5 * H, 11]]);
  const g = groupChanges(oi, change, D4);
  assert.deepEqual([...g.change], [[T, 9], [T + D4, 11]]);
  assert.deepEqual(g.oi.map(b => b[4]), [109, 120], 'the level at each drawn candle\'s last chart candle');
  assert.deepEqual([...groupChanges([bar(T, 1)], new Map(), D4).change], [], 'the first reading has no change');
});

test('venues added together: the drawn candles\' changes are the sums of the venues\' own changes, a venue starting mid-way included', () => {
  // Venue b starts in the second hour: its first reading is no change (oiChangeByTime), and grouping keeps it so.
  const a: OiPart = { id: 'binance:BTCUSDT', bars: [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 105), bar(T + 3 * H, 112), bar(T + 4 * H, 120), bar(T + 5 * H, 118)] };
  const b: OiPart = { id: 'bybit:BTCUSDT', bars: [bar(T + H, 50), bar(T + 2 * H, 55), bar(T + 3 * H, 53), bar(T + 4 * H, 60), bar(T + 5 * H, 61)] };
  const parts = [a, b], oi = chainedOi(oiSumOf(parts, H)), fine = oiChangeByTime(oi, parts, H);
  const g = groupChanges(oi, fine, D4);
  const total = [...fine.values()].reduce((x, y) => x + y, 0), grouped = [...g.change.values()].reduce((x, y) => x + y, 0);
  assert.equal(grouped, total, 'the grouped changes add up to the hourly ones');
  assert.equal(g.change.get(T), 10 - 5 + 7 + 5 - 2, 'the first drawn candle: a\'s three changes and b\'s two (its first reading is none)');
  assert.deepEqual(groupParts(parts, D4).map(p => p.bars.map(x => x[4])), [[112, 118], [53, 61]]);
});

test('NL/NS grouped: every part, the change and what went to no side add up; the label is worked out again', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H, T + 4 * H, T + 5 * H];
  const market: NlnsMarket = { bars: [bar(T - H, 100), bar(T, 110), bar(T + H, 118), bar(T + 2 * H, 114), bar(T + 3 * H, 108), bar(T + 4 * H, 120), bar(T + 5 * H, 120)],
    flows: [flow(5e6), flow(-3e6), flow(-1e6), flow(2e6), flow(0), null] };
  const fine = nlnsModel(starts, [market], new Map(), starts.map(() => 0), H);
  const g = groupWho(fine, D4), first = g.get(T)!, sum = (k: keyof NlnsCandle) => fine.filter(c => c.t < T + D4).reduce((x, c) => x + (c[k] as number), 0);
  for (const k of ['dOi', 'longOpened', 'longClosed', 'shortOpened', 'shortClosed', 'unassigned', 'unknown', 'unsidedUp', 'unsidedDown', 'longs', 'shorts', 'v'] as const) assert.equal(first[k], sum(k), k);
  assert.equal(first.kind, 'mixed', 'new longs and new shorts in one drawn candle pull both ways');
  assert.equal(first.side, Math.sign(first.v));
  assert.equal(first.cum, fine[3]!.cum, 'the running sum at its last candle');
  assert.equal(g.get(T + D4)!.unassigned, 12, 'takers even: no side');
  // Grouped over every candle, the totals are the hourly totals.
  const all = groupWho(fine, 24 * H).get(T)!;
  assert.equal(all.dOi, fine.reduce((x, c) => x + c.dOi, 0));
});

test('the coins sided by the price are counted, add up when grouped, and say how much of a bar the price decided', () => {
  const starts = [T, T + H, T + 2 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 115)];
  const closes = new Map([[T, 50_000], [T + H, 49_000], [T + 2 * H, 49_500]]);
  const c = nlnsModel(starts, [{ bars, flows: [null, flow(3), null] }], closes, starts.map(() => 0), H);
  assert.deepEqual(c.map(x => [x.byPrice, x.byPriceOi]), [[false, 0], [false, 0], [true, 5]], 'the flow decided the second hour, the price the third');
  assert.equal(priceSidedShare(c[1]!), 0);
  assert.equal(priceSidedShare(c[2]!), 1);
  const g = groupWho(c, D4).get(T)!;
  assert.equal(g.byPriceOi, 5); assert.equal(priceSidedShare(g), 5 / 15, 'a third of the drawn candle\'s sided change came by the price');
});

test('the chart\'s candles grouped: open, extremes, close, and the volumes added where every candle has them', () => {
  const c: CandleRow[] = [[T, 1, 3, 0.5, 2, 10, 5, 6], [T + H, 2, 4, 1, 3, 20, 4, 9], [T + 2 * H, 3, 3, 2, 2.5, 5, 1]];
  assert.deepEqual(groupCandles(c, D4), [[T, 1, 4, 0.5, 2.5, 35, 10, undefined, undefined, undefined, undefined]]);
});
