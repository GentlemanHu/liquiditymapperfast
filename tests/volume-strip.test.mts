import test from 'node:test';
import assert from 'node:assert/strict';
import { candleUsd, joinRows, stripBars, stripHighlights, stripLevels, stripLines, type StripBar } from '../src/app/measures/volume-strip.ts';
import type { TimeRows } from '../src/app/measures/model.ts';
import type { CandleRow } from '../src/app/store.ts';

const H = 3_600_000, T = Math.floor(1_800_000_000_000 / H) * H;
/** Hourly candles: volume 10 coins at a typical price of 100, so $1,000 each. */
const candles: CandleRow[] = Array.from({ length: 8 }, (_, i) => [T + i * H, 100, 110, 90, 100, 10, 1]);
const place = (start: number): { x: number; w: number } => ({ x: (start - T) / H * 10 + 5, w: 8 });
/** Recorded rows from hour 4: buys 600 and sells 200 an hour, hour 6 not recorded. */
function rows(): TimeRows {
  const n = 8, buy = new Float64Array(n), sell = new Float64Array(n), gaps = new Array<null | 'notRecorded'>(n).fill('notRecorded');
  for (let i = 4; i < 8; i++) if (i !== 6) { buy[i] = 600; sell[i] = 200; gaps[i] = null; }
  return { step: H, bin0: T / H, from: T, to: T + 8 * H, buy, sell, gaps, buyN: null, sellN: null, counted: 0, minutes: 0, total: 2400, max: 800, poc: 4, recordedSince: T + 4 * H, partial: true };
}

test('the strip: the recording where it reaches, the market\'s own candles before it, one source a bar', () => {
  assert.equal(candleUsd(candles[0]!), 1000, 'a candle\'s dollars: its volume at its typical price');
  const r = rows(), bars = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.deepEqual(bars.map(b => b.source), ['candle', 'candle', 'candle', 'candle', 'recorded', 'recorded', 'gap', 'recorded']);
  assert.deepEqual([bars[0]!.buy, bars[0]!.sell, bars[0]!.split], [1000, 0, false], 'a candle that does not say who bought: all of it, unsplit');
  assert.deepEqual([bars[4]!.buy, bars[4]!.sell, bars[4]!.split], [600, 200, true], 'a recorded bar: the venues\' two sides');
  // Taker buys (Binance's): the candle split by its share bought at market.
  const split = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, () => 0.25, false);
  assert.deepEqual([split[0]!.buy, split[0]!.sell, split[0]!.split], [250, 750, true]);
  // The recording starting inside a candle: that bar is the recording's, partial.
  const half = rows(); half.buy[3] = 300; half.gaps[3] = null;   // the half hour after 3:30 recorded
  const inside = stripBars(candles, H, half, T + 4 * H - 1_800_000, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.equal(inside[3]!.source, 'partial'); assert.equal(inside[3]!.buy, 300, 'the recorded part only, never the candle added to it');
  // Nothing recorded: every bar a candle. In a replay, a candle not closed by then is left out.
  assert.ok(stripBars(candles, H, null, null, T + 8 * H, T, T + 8 * H, place, () => undefined, false).every(b => b.source === 'candle'));
  assert.equal(stripBars(candles, H, null, null, T + 5.5 * H, T, T + 8 * H, place, () => undefined, true).length, 5, 'replayed at 5:30: the five closed candles');
});

test('the strip\'s Highlights are worked out within each run of one source, and its value area from the recorded bars only', () => {
  const bar = (source: StripBar['source'], v: number): StripBar => ({ t: 0, x: 0, w: 1, source, buy: v, sell: 0, split: true, i: 0, gap: null });
  // Fifteen quiet candles, then recorded bars where 1,000 is ordinary: the first recorded bar is not flagged for being bigger than the candles.
  const bars = [...Array.from({ length: 15 }, () => bar('candle', 100)), ...Array.from({ length: 15 }, (_, i) => bar('recorded', 1000 + (i % 3)))];
  const found = stripHighlights(bars, { length: 20, mult: 2 });
  assert.equal(found.flag[15], 0, 'no baseline across the seam');
  assert.ok(Number.isNaN(found.threshold[15]!), 'a new run warms up again');
  const spike = [...bars, bar('recorded', 50_000)];
  assert.equal(stripHighlights(spike, { length: 20, mult: 2 }).flag[30], 1, 'a spike within its own run stands out');
  const levels = stripLevels([bar('candle', 9_999), bar('recorded', 10), bar('recorded', 50), bar('partial', 999), bar('recorded', 40)], 0.7);
  assert.equal(levels!.poc, 2, 'the busiest recorded bar, never the candle\'s'); assert.ok(levels!.lo >= 1 && levels!.hi <= 4);
});

test('a strip bar\'s box: the recorded bucket\'s figures, or the candle\'s with where it comes from', () => {
  const r = rows(), bars = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, i => (i === T ? 0.75 : undefined), false);
  const c = { rows: r, tf: H, now: T + 8 * H, levels: null, levelsIn: (i: number) => bars[i]!.i, market: 'Binance', tfName: '1h', reports: false, total: 2400 };
  const candle = stripLines(bars[0]!, c);
  assert.ok(candle.some(l => l.color === 'buy' && l.text === '$750') && candle.some(l => l.color === 'sell' && l.text === '$250'), 'its taker split');
  assert.ok(candle.at(-1)!.text.includes('Binance') && candle.at(-1)!.color === 'muted', 'where it comes from, last');
  const grey = stripLines(bars[1]!, c);
  assert.ok(grey.some(l => l.text === '$1,000' || l.text === '$1K' || l.text.startsWith('$1')), 'its whole volume');
  assert.ok(!grey.some(l => l.color === 'buy' || l.color === 'sell'), 'no sides where the candle does not say');
  const recorded = stripLines(bars[4]!, c);
  assert.ok(recorded.some(l => l.color === 'buy') && recorded.some(l => l.color === 'sell'), 'the venues\' two sides');
});

test('the strip never borrows another bar: before the rows asked for, a bar is its candle; a bar the recording begins inside without its rows, too', () => {
  const r = rows(), late = { ...r, from: T + 5 * H, bin0: (T + 5 * H) / H, buy: r.buy.slice(5), sell: r.sell.slice(5), gaps: r.gaps.slice(5) };
  const bars = stripBars(candles, H, late, T + 2 * H, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.deepEqual(bars.slice(0, 5).map(b => [b.source, b.buy]), [['candle', 1000], ['candle', 1000], ['candle', 1000], ['candle', 1000], ['candle', 1000]], 'each its own candle, none reading the first bucket of the rows');
  const gapInside = stripBars(candles, H, r, T + 3 * H + 1_800_000, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.equal(gapInside[3]!.source, 'candle', 'the recording began inside it and its rows hold nothing: the candle');
  const joined = joinRows({ ...r, to: T + 4 * H, buy: r.buy.slice(0, 4), sell: r.sell.slice(0, 4), gaps: r.gaps.slice(0, 4) }, { ...r, from: T + 4 * H, bin0: (T + 4 * H) / H, buy: r.buy.slice(4), sell: r.sell.slice(4), gaps: r.gaps.slice(4) });
  assert.deepEqual([joined.buy.length, joined.total, joined.to, joined.gaps[6]], [8, 2400, T + 8 * H, 'notRecorded'], 'the closed buckets and the one under way, as one');
  const c = { rows: r, tf: H, now: T + 8 * H, levels: null, levelsIn: () => -1, market: 'Binance', tfName: '1h', reports: true, total: 2400 };
  assert.ok(stripLines({ t: T, x: 0, w: 1, source: 'candle', buy: 1000, sell: 0, split: false, i: -1, gap: null }, c).some(l => l.text.includes('not loaded yet')), 'Binance: not loaded yet, never does not say');
});
