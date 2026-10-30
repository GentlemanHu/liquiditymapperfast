import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { OI_LONG_DEADLINE_MS, OI_LONG_MAX_ROWS, OI_LONG_RETRY_MS, OiLongHistory, oiLongBars, oiLongPeriod, oiLongSeam, oiLongWindow, type OiLongHeld } from '../src/app/panes/oi-long.ts';
import { chainedOi, oiSumOf, type OiPart } from '../src/app/oi-change.ts';
import type { OiBar } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, NOW = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const bars = (from: number, n: number, tf: number, level: (i: number) => number): OiBar[] => Array.from({ length: n }, (_, i) => { const v = level(i); return [from + i * tf, v, v, v, v]; });

test('the long view is read in the chart\'s own readings while they are 2 px apart, else in longer ones, never under five minutes', () => {
  assert.equal(oiLongPeriod(HOUR, 3 * DAY, 1500), HOUR);
  assert.equal(oiLongPeriod(HOUR, 60 * DAY, 1500), 4 * HOUR, 'an hour is a pixel apart in 60 days; four hours are four');
  assert.equal(oiLongPeriod(HOUR, 730 * DAY, 1500), DAY, 'two years: daily readings, the longest');
  assert.equal(oiLongPeriod(MIN, HOUR, 1500), 5 * MIN, 'Bybit reads nothing shorter than five minutes');
  assert.equal(oiLongPeriod(4 * HOUR, 730 * DAY, 1500), DAY);
});

// A 1h chart: Bybit's 500 bars, Binance's from 100 bars later (its 30 days end first at 4h; here the shape is what counts), and OKX with none.
const TF = HOUR, START = NOW - 500 * TF;
const bybit: OiPart = { id: 'bybit:BTCUSDT', bars: bars(START, 500, TF, i => 30_000 + i) };
const binance: OiPart = { id: 'binance:BTCUSDT', bars: bars(START + 100 * TF, 400, TF, i => 80_000 + 2 * i) };
const parts = [bybit, binance, { id: 'okx:BTC-USDT-SWAP', bars: [] }];
const chained = chainedOi(oiSumOf(parts, TF));

test('the seam is Bybit\'s first bar from where another venue\'s readings begin, at the line\'s level over Bybit\'s', () => {
  const seam = oiLongSeam(parts, 'bybit:BTCUSDT', chained)!;
  assert.equal(seam.t, START + 100 * TF);
  assert.equal(chained[seam.index]![0], seam.t);
  assert.ok(Math.abs(seam.k * bybit.bars[100]![4] - chained[seam.index]![4]) < 1e-6, 'Bybit times k meets the line there');
  assert.ok(seam.k > 3 && seam.k < 4, 'the total is Binance and Bybit together, chained back from now');
});

test('no seam where Bybit is not counted, is the only venue, or no other venue has readings', () => {
  assert.equal(oiLongSeam([binance, { id: 'okx:BTC-USDT-SWAP', bars: [] }], 'bybit:BTCUSDT', chained), null);
  assert.equal(oiLongSeam([bybit], 'bybit:BTCUSDT', bybit.bars), null);
  assert.equal(oiLongSeam([bybit, { id: 'okx:BTC-USDT-SWAP', bars: [] }], 'bybit:BTCUSDT', bybit.bars), null);
});

test('Bybit\'s readings before the seam are scaled by k, and one whose period ends after the seam is left out', () => {
  const seam = { t: START + 100 * TF + 6 * HOUR, k: 3 };
  const daily = bars(START - 10 * DAY, 15, DAY, i => 20_000 + 100 * i);
  const out = oiLongBars(daily, DAY, seam);
  assert.ok(out.every(b => b[0] + DAY <= seam.t), 'every one drawn ends by the seam');
  assert.equal(out.length, daily.filter(b => b[0] + DAY <= seam.t).length);
  assert.deepEqual(out[0], [daily[0]![0], 60_000, 60_000, 60_000, 60_000]);
});

test('the window is a view before the view up to a day past the seam, never past now, and is not asked again while it covers', () => {
  const view = { t0: NOW - 200 * DAY, t1: NOW }, seamT = NOW - 21 * DAY;
  const ask = oiLongWindow(null, view, DAY, seamT, NOW)!;
  assert.equal(ask.from, NOW - 400 * DAY);
  assert.equal(ask.to, seamT + DAY);
  assert.equal(oiLongWindow(null, view, DAY, NOW - 3 * HOUR, NOW)!.to, NOW, 'never past now');
  const held: OiLongHeld = { ident: 'bybit:BTCUSDT', period: DAY, ...ask, bars: [] };
  assert.equal(oiLongWindow(held, view, DAY, seamT, NOW), null);
  assert.equal(oiLongWindow(held, { t0: NOW - 300 * DAY, t1: NOW }, DAY, seamT + 12 * HOUR, NOW), null, 'a step out, and the seam a few hours on');
  assert.notEqual(oiLongWindow(held, { t0: NOW - 500 * DAY, t1: NOW }, DAY, seamT, NOW), null, 'further back than held');
  assert.notEqual(oiLongWindow(held, view, 4 * HOUR, seamT, NOW), null, 'another period');
  assert.notEqual(oiLongWindow(held, view, DAY, seamT + 2 * DAY, NOW), null, 'the seam past what is held');
});

test('a view far back is asked around itself, not up to the seam, and a window never holds more than the reader keeps', () => {
  // Ten days 150 days back in hourly readings: asked up to the seam, 3,400 readings, of which Bybit's reader kept the newest 2,400, none in view.
  const seamT = NOW - 21 * DAY, back = { t0: NOW - 160 * DAY, t1: NOW - 150 * DAY };
  const ask = oiLongWindow(null, back, HOUR, seamT, NOW)!;
  assert.ok(ask.from <= back.t0 - HOUR && ask.to >= back.t1 + HOUR, 'the view and a reading either side');
  assert.ok(ask.to < seamT, 'not up to the seam');
  assert.ok((ask.to - ask.from) / HOUR <= OI_LONG_MAX_ROWS);
  const held: OiLongHeld = { ident: 'bybit:BTCUSDT', period: HOUR, ...ask, bars: [] };
  assert.equal(oiLongWindow(held, back, HOUR, seamT, NOW), null);
  assert.notEqual(oiLongWindow(held, { t0: NOW - 140 * DAY, t1: NOW - 125 * DAY }, HOUR, seamT, NOW), null, 'panned on past what is held');
  // A view longer than one window can hold keeps the readings at the seam, and is not asked again for those it cannot hold.
  const wide = { t0: NOW - 400 * DAY, t1: NOW }, cut = oiLongWindow(null, wide, HOUR, seamT, NOW)!;
  assert.equal((cut.to - cut.from) / HOUR, OI_LONG_MAX_ROWS);
  assert.ok(cut.to >= seamT);
  assert.equal(oiLongWindow({ ident: 'bybit:BTCUSDT', period: HOUR, ...cut, bars: [] }, wide, HOUR, seamT, NOW), null, 'no question every frame');
});

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('one read at a time, whose answer is held for its period; while another period is read the nearest held is drawn', async () => {
  const asked: { period: number; from: number; to: number }[] = [];
  let release: (() => void) | null = null, landed = 0;
  const history = new OiLongHistory((_id, period, from, to) => { asked.push({ period, from, to }); return new Promise(resolve => { release = () => resolve(bars(from, 3, period, i => 100 + i).reverse()); }); }, () => { landed++; }, () => NOW);
  const view = { t0: NOW - 200 * DAY, t1: NOW }, seamT = NOW - 21 * DAY;
  assert.equal(history.rows('bybit:BTCUSDT', DAY, view, seamT), null);
  assert.equal(history.rows('bybit:BTCUSDT', DAY, view, seamT), null);
  assert.equal(asked.length, 1, 'asked once while it is read');
  assert.ok(history.loading);
  release!(); await settle();
  assert.equal(landed, 1);
  const held = history.rows('bybit:BTCUSDT', DAY, view, seamT)!;
  assert.equal(held.period, DAY);
  assert.ok(held.bars[0]![0] < held.bars[1]![0], 'in time order');
  assert.equal(asked.length, 1, 'covered: nothing asked');
  // Zoomed in: four-hour readings are asked for, and the daily ones drawn until they come.
  const nearer = { t0: NOW - 50 * DAY, t1: NOW };
  assert.equal(history.rows('bybit:BTCUSDT', 4 * HOUR, nearer, seamT)?.period, DAY);
  assert.equal(asked.length, 2);
  release!(); await settle();
  assert.equal(history.rows('bybit:BTCUSDT', 4 * HOUR, nearer, seamT)?.period, 4 * HOUR);
});

test('a read that fails is asked again after a minute; another market drops what is held and the answer of a read under way', async () => {
  let now = NOW, fail = true;
  const asked: string[] = [], releases: (() => void)[] = [];
  const history = new OiLongHistory((id, period, from) => { asked.push(id); if (fail) return Promise.reject(new Error('HTTP 503')); return new Promise(resolve => { releases.push(() => resolve(bars(from, 2, period, () => 1))); }); }, () => undefined, () => now);
  const view = { t0: NOW - 200 * DAY, t1: NOW }, seamT = NOW - 21 * DAY;
  history.rows('bybit:BTCUSDT', DAY, view, seamT); await settle();
  assert.equal(history.loading, false);
  history.rows('bybit:BTCUSDT', DAY, view, seamT);
  assert.equal(asked.length, 1, 'not asked again at once');
  now += OI_LONG_RETRY_MS; fail = false;
  history.rows('bybit:BTCUSDT', DAY, view, seamT);
  assert.equal(asked.length, 2);
  // The coin changed while BTC's read was out: ETH is asked at once, and BTC's answer is not held for it.
  history.rows('bybit:ETHUSDT', DAY, view, seamT);
  assert.deepEqual(asked, ['bybit:BTCUSDT', 'bybit:BTCUSDT', 'bybit:ETHUSDT']);
  releases[0]!(); await settle();
  assert.equal(history.rows('bybit:ETHUSDT', DAY, view, seamT), null, 'BTC\'s answer is dropped');
  assert.ok(history.loading, 'ETH\'s read is still the one under way');
  releases[1]!(); await settle();
  assert.ok(history.rows('bybit:ETHUSDT', DAY, view, seamT), 'ETH\'s own answer is held');
  assert.equal(asked.length, 3);
});

test('a read that never answers is given up at the deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let landed = 0;
    const history = new OiLongHistory(() => new Promise<OiBar[]>(() => undefined), () => { landed++; }, () => NOW);
    history.rows('bybit:BTCUSDT', DAY, { t0: NOW - 200 * DAY, t1: NOW }, NOW - 21 * DAY);
    assert.ok(history.loading);
    mock.timers.tick(OI_LONG_DEADLINE_MS);
    await settle();
    assert.equal(history.loading, false);
    assert.equal(landed, 1);
  } finally { mock.timers.reset(); }
});
