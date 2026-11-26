import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSizeModel, lineAt, rasterise, sizeTf, type SizeBars, type SizeInput } from '../src/app/cvd/sizes.ts';
import { BANDS } from '../src/app/size-history/model.ts';
import type { Bar } from '../src/app/panes/footprint.ts';

const M = 60_000;
/** A bar of one minute whose orders fill the boxes as given: `buy[k]`, `sell[k]` USD in box k (eight boxes). */
const bar = (t: number, buy: number[], sell: number[]): Bar => ({ t, rows: [], buyUsd: buy.reduce((a, b) => a + b, 0), sellUsd: sell.reduce((a, b) => a + b, 0), minutes: 1, stats: { buyN: 1, sellN: 1, buy, sell } });
const box = (k: number, usd: number): number[] => { const out = new Array<number>(8).fill(0); out[k] = usd; return out; };
const held = (bars: Bar[], from: number, to: number): SizeBars => ({ bars: new Map(bars.map(b => [b.t, b] as const)), answered: { from, to } });
const input = (spot: SizeBars | null, perp: SizeBars | null, over: Partial<SizeInput> = {}): SizeInput => ({ spot, perp, tfMs: M, t0: 0, t1: 10 * M, columns: 10, now: 10 * M, rankMs: 10 * M, replay: false, ...over });

test('the bars\x27 timeframe gives at most two bars a pixel column, and holds within a band so a window that changes a little asks nothing new', () => {
  assert.equal(sizeTf(5 * M, 300), '1m', 'a short span: every minute');
  assert.equal(sizeTf(24 * 60 * M, 300), '5m', 'a day across 300 columns: 1,440 minutes are too many, 288 five-minute bars are not');
  assert.equal(sizeTf(7 * 24 * 60 * M, 300), '30m');
  // Kept finer until half again too many; kept coarser while its own bars are a quarter of the most or more.
  assert.equal(sizeTf(24 * 60 * M, 500, '1m'), '1m', '1,440 bars against a most of 1,000: kept');
  assert.equal(sizeTf(24 * 60 * M, 400, '1m'), '5m', 'against a most of 800: more than half again, let go');
  assert.equal(sizeTf(4 * 60 * M, 300, '5m'), '1m', 'four hours: 48 five-minute bars are under a quarter of 600, so the minutes come back (review 2026-11-25)');
  assert.equal(sizeTf(24 * 60 * M, 212, '4h'), '5m', 'a day held on 4h bars after zooming in: six bars, let go');
  assert.equal(sizeTf(100 * 60 * M, 300, '30m'), '30m', '100 hours: 200 half hours are a quarter of 600 or more, kept though 15m would fit');
  assert.equal(sizeTf(60 * 60 * M, 300, '30m'), '15m', '60 hours: 120 half hours are not, and 240 quarter hours fit');
  // No flip at the band's edge: the finer timeframe chosen there is kept on the way back up.
  assert.equal(sizeTf(60 * 60 * M, 300, '15m'), '15m');
  assert.equal(sizeTf(5 * M, 300, 'nonsense'), '1m', 'an unknown one is not kept');
});

test('a line runs through the points, breaks across a NaN point, and is nothing outside them', () => {
  const t = [0, 10, 10, 20, 30], v = [0, 4, NaN, 4, 10];
  assert.equal(lineAt(t, v, 5), 2, 'halfway along');
  assert.ok(Number.isNaN(lineAt(t, v, 10)), 'at a shared time the later point (the break) counts');
  assert.ok(Number.isNaN(lineAt(t, v, 15)), 'across the break');
  assert.equal(lineAt(t, v, 25), 7);
  assert.ok(Number.isNaN(lineAt(t, v, -1)) && Number.isNaN(lineAt(t, v, 31)), 'outside');
  const r = rasterise({ t, v }, { columns: 4, t0: 0, t1: 40 });
  assert.deepEqual([...r.last], [4, NaN, 10, NaN], 'the column holding the break ends where the line stood before it; the one after the last point has nothing');
  assert.deepEqual([r.min, r.max], [0, 10]);
});

test('each band\x27s line is its running delta from zero, spot and perpetual apart, and the six together make the bars\x27 own delta', () => {
  // Spot: a $10K buy (box 0) each minute; perpetual: a $300K sell (box 4, the third band) each minute and a $6M buy (box 7) at minute 4.
  const spot = held(Array.from({ length: 10 }, (_, i) => bar(i * M, box(0, 10_000), box(0, 0))), 0, 10 * M);
  const perp = held(Array.from({ length: 10 }, (_, i) => bar(i * M, box(7, i === 4 ? 6_000_000 : 0), box(4, 300_000))), 0, 10 * M);
  const model = buildSizeModel(input(spot, perp));
  assert.equal(model.rows.length, BANDS.length);
  assert.deepEqual(model.rows.map(r => r.key), ['size0', 'size1', 'size2', 'size3', 'size4', 'size5'], 'smallest first, as the dot rows and the Flow history');
  const lane = (band: number, kind: 'spot' | 'perp') => model.rows[band]!.lanes.find(l => l.kind === kind)!;
  assert.deepEqual([...lane(0, 'spot').last], [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000], 'a column a minute: the running sum at each end');
  assert.deepEqual([...lane(2, 'perp').last].map(v => v / 1000), [-300, -600, -900, -1200, -1500, -1800, -2100, -2400, -2700, -3000]);
  assert.deepEqual([...lane(5, 'perp').last].map(v => v / 1e6), [0, 0, 0, 0, 6, 6, 6, 6, 6, 6]);
  assert.equal(lane(0, 'spot').delta, 100_000, 'net over the ranking window');
  // Every bar's own delta is the six bands' together.
  const all = (kind: 'spot' | 'perp') => model.rows.reduce((s, r) => s + (r.lanes.find(l => l.kind === kind)?.delta ?? 0), 0);
  assert.equal(all('spot'), 100_000); assert.equal(all('perp'), 6_000_000 - 3_000_000);
  assert.ok(Math.abs(model.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-12, 'the shares of all six make the whole');
  assert.equal(model.rows[1]!.lanes.length, 2, 'a band nobody traded still has its two lines, flat at zero');
  assert.deepEqual([...model.rows[1]!.lanes[0]!.last], new Array(10).fill(0));
});

test('a bar without sizes breaks the line and it goes on from where it stood; a minute without a bar traded nothing: flat', () => {
  const bars = [bar(0, box(0, 5), box(0, 0)), bar(M, box(0, 5), box(0, 0)), { t: 2 * M, rows: [], buyUsd: 9, sellUsd: 0, minutes: 1 } as Bar, bar(3 * M, box(0, 5), box(0, 0)), bar(5 * M, box(0, 5), box(0, 0))];
  const model = buildSizeModel(input(held(bars, 0, 6 * M), null, { t1: 6 * M, columns: 6, now: 6 * M }));
  const last = [...model.rows[0]!.lanes[0]!.last];
  assert.deepEqual(last.slice(0, 2), [5, 10]);
  assert.ok(Number.isNaN(last[2]!), 'the minute without sizes: not known');
  assert.deepEqual(last.slice(3), [15, 15, 20], 'after it from where it stood; minute four had no bar: flat');
  assert.equal(model.rows[0]!.unknown, 1, 'one bar without sizes in the window, said on every row');
  assert.equal(model.rows[4]!.unknown, 1);
});

test('only what was answered is drawn; the bar under way ends now; a replay leaves out the bar still under way at its moment', () => {
  const bars = Array.from({ length: 6 }, (_, i) => bar(i * M, box(1, 1_000), box(1, 0)));
  // Answered from minute 2 on: the older minutes are not known yet.
  const part = buildSizeModel(input(held(bars, 2 * M, 6 * M), null, { t1: 6 * M, columns: 6, now: 5.5 * M }));
  const last = [...part.rows[1]!.lanes[0]!.last];
  assert.ok(last.slice(0, 2).every(Number.isNaN), 'before the answer: nothing');
  assert.deepEqual(last.slice(2, 5), [1_000, 2_000, 3_000], 'from zero where the answer starts');
  assert.equal(last[5], 4_000, 'the bar under way reaches the newest moment');
  assert.equal(part.through, 5.5 * M);
  const replay = buildSizeModel(input(held(bars, 0, 6 * M), null, { t1: 6 * M, columns: 6, now: 5.5 * M, replay: true }));
  assert.equal(replay.rows[1]!.lanes[0]!.last[4], 5_000);
  assert.ok(Number.isNaN(replay.rows[1]!.lanes[0]!.last[5]!), 'in a replay the bar under way at its moment is left out');
  assert.equal(replay.rows[1]!.lanes[0]!.delta, 5_000);
});

test('the figures are over the ranking window ending now, whatever the window drawn; no bars, no lines', () => {
  const bars = Array.from({ length: 120 }, (_, i) => bar(i * M, box(0, 100), box(0, 0)));
  const model = buildSizeModel(input(held(bars, 0, 120 * M), null, { t0: 0, t1: 30 * M, columns: 30, now: 120 * M, rankMs: 60 * M }));
  assert.equal(model.rows[0]!.lanes[0]!.delta, 60 * 100, 'the last hour, not the half hour drawn');
  assert.equal(model.rows[0]!.lanes[0]!.last[29], 30 * 100, 'the line is the window drawn');
  assert.deepEqual(buildSizeModel(input(null, held([], 0, 0))).rows.map(r => r.lanes.length), [0, 0, 0, 0, 0, 0]);
});

test('the figures are read from minutes of their own, the minute the window starts in for its part, whatever the bars drawn', () => {
  // Drawn on half-hour bars of $1M bought each (box 0); the minutes apart, $100 bought each.
  const drawn = held(Array.from({ length: 8 }, (_, i) => ({ ...bar(i * 30 * M, box(0, 1_000_000), box(0, 0)) })), 0, 240 * M);
  const minutes = held(Array.from({ length: 240 }, (_, i) => bar(i * M, box(0, 100), box(0, 0))), 0, 240 * M);
  const at = 200.5 * M; // inside a half hour and a minute
  const base = input(drawn, null, { tfMs: 30 * M, t0: 0, t1: 240 * M, columns: 8, now: at, rankMs: 60 * M });
  // Without minutes of their own the bars drawn are the ruler: the half hour the window starts in for its part, [140.5, 150) of [120, 150),
  // then the two from 150 and 180 (the one under way counted as it stands).
  const fromDrawn = buildSizeModel(base).rows[0]!.lanes[0]!;
  assert.ok(Math.abs(fromDrawn.delta - 1_000_000 * ((150 - 140.5) / 30 + 2)) < 1e-6, String(fromDrawn.delta));
  const fromMinutes = buildSizeModel({ ...base, figures: { spot: minutes, perp: null, tfMs: M } }).rows[0]!.lanes[0]!;
  // [140.5, 200.5) min: minute 140 for half of it, 141..199 whole, and minute 200 still under way is counted (before now).
  assert.ok(Math.abs(fromMinutes.delta - 100 * (0.5 + 59 + 1)) < 1e-6, String(fromMinutes.delta));
  assert.equal(fromMinutes.buy, fromMinutes.delta);
  // Lines still from the bars drawn.
  assert.deepEqual([...fromMinutes.last].slice(0, 2), [1_000_000, 2_000_000]);
});

test('a window that starts before the first bar held draws nothing there: the lines start at it', () => {
  // Answered from minute 0, but bars only from minute 3 (the recording began then).
  const bars = Array.from({ length: 3 }, (_, i) => bar((3 + i) * M, box(2, 500), box(2, 0)));
  const model = buildSizeModel(input(held(bars, 0, 6 * M), null, { t1: 6 * M, columns: 6, now: 6 * M }));
  const last = [...model.rows[1]!.lanes[0]!.last];
  assert.ok(last.slice(0, 3).every(Number.isNaN), 'nothing before the first bar: ' + last.join(','));
  assert.deepEqual(last.slice(3), [500, 1_000, 1_500]);
  assert.match(model.rows[1]!.label, /^\$25K–100K$/, 'each row carries the name of its sizes (BTC: the second band)');
});
