import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { OI_LONG_DEADLINE_MS, OI_LONG_MAX_ROWS, OI_LONG_RETRY_MS, OiLongHistory, oiLongChain, oiLongPeriod, oiLongSeamOf, oiLongWindow, type OiLongHeld } from '../src/app/panes/oi-long.ts';
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
  // A wide plot (2,400 px) draws 45 days in hourly readings 2.2 px apart: three views are 3,240 readings, and the margin after the view gives
  // way so that its start is kept (review round 2: cut at the start, its first 6.7 days were never read).
  const long = { t0: NOW - 195 * DAY, t1: NOW - 150 * DAY }, kept = oiLongWindow(null, long, HOUR, seamT, NOW)!;
  assert.ok(kept.from <= long.t0 - HOUR && kept.to >= long.t1 + HOUR, 'the whole view and a reading either side');
  assert.ok((kept.to - kept.from) / HOUR <= OI_LONG_MAX_ROWS);
  assert.equal(oiLongWindow({ ident: 'bybit:BTCUSDT', period: HOUR, ...kept, bars: [] }, long, HOUR, seamT, NOW), null);
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

test('the seam with venues that keep history: where a second venue\'s readings begin, with each long-history venue\'s reading there', () => {
  // Bybit's readings go back furthest, Binance's begin later, a third venue later still: the held line is two venues from Binance's start.
  const bybit: OiPart = { id: 'bybit:BTCUSDT', bars: bars(NOW - 40 * HOUR, 40, HOUR, () => 30) };
  const binance: OiPart = { id: 'binance:BTCUSDT', bars: bars(NOW - 20 * HOUR, 20, HOUR, () => 90) };
  const okx: OiPart = { id: 'okx:BTC-USDT-SWAP', bars: bars(NOW - 5 * HOUR, 5, HOUR, () => 20) };
  const parts = [bybit, binance, okx], chained = chainedOi(oiSumOf(parts, HOUR));
  const seam = oiLongSeamOf(parts, ['binance:BTCUSDT', 'bybit:BTCUSDT'], chained)!;
  assert.equal(seam.t, NOW - 20 * HOUR, 'from Binance\'s first reading');
  assert.equal(seam.level, chained[seam.index]![4]);
  assert.deepEqual([...seam.at], [['binance:BTCUSDT', 90], ['bybit:BTCUSDT', 30]]);
  assert.equal(oiLongSeamOf([bybit], ['bybit:BTCUSDT'], chainedOi(oiSumOf([bybit], HOUR))), null, 'one venue: its own line, no seam');
  assert.equal(oiLongSeamOf([okx, binance], ['bybit:BTCUSDT'], chainedOi(oiSumOf([okx, binance], HOUR))), null, 'no long-history venue counted');
});

test('the long view is chained over the venues read at both ends of each step; with one venue it is that venue scaled to meet the line', () => {
  const P = DAY, seamT = NOW, at = new Map([['binance:BTCUSDT', 100], ['bybit:BTCUSDT', 50]]);
  // Two days back: Binance 90 and Bybit 45 (sum 135 against 150 at the seam), then 80 and 40.
  const rows = new Map<string, OiBar[]>([['binance:BTCUSDT', bars(NOW - 2 * P, 2, P, i => [80, 90][i]!)], ['bybit:BTCUSDT', bars(NOW - 2 * P, 2, P, i => [40, 45][i]!)]]);
  const both = oiLongChain(rows, P, { t: seamT, level: 300, at });
  assert.deepEqual(both.bars.map(b => b[4]), [300 * 135 / 150 * 120 / 135, 300 * 135 / 150]);
  assert.deepEqual(both.venues, [['binance:BTCUSDT', 'bybit:BTCUSDT'], ['binance:BTCUSDT', 'bybit:BTCUSDT']]);
  // Bybit alone: its readings times the line over its own at the seam (the long view as shipped on 2026-10-30), shapes and sums too.
  const one = oiLongChain(new Map([['bybit:BTCUSDT', rows.get('bybit:BTCUSDT')!]]), P, { t: seamT, level: 300, at: new Map([['bybit:BTCUSDT', 50]]) });
  assert.deepEqual(one.bars.map(b => b[4]), [40 * 6, 45 * 6]);
  assert.deepEqual(one.sums, [40, 45]);
  // A bar whose period ends after the seam is not drawn before it.
  assert.equal(oiLongChain(new Map([['bybit:BTCUSDT', [[seamT - P / 2, 1, 1, 1, 1]]]]), P, { t: seamT, level: 300, at: new Map([['bybit:BTCUSDT', 50]]) }).bars.length, 0);
});

test('a venue missing at one end is left out of that step, and the chain goes on with the others', () => {
  const P = DAY, at = new Map([['binance:BTCUSDT', 100], ['bybit:BTCUSDT', 50]]);
  // Binance has no reading the day before the seam (an archive day with no file); Bybit carries that step alone, then both again.
  const rows = new Map<string, OiBar[]>([['binance:BTCUSDT', [[NOW - 3 * P, 70, 70, 70, 70]]], ['bybit:BTCUSDT', bars(NOW - 3 * P, 3, P, i => [35, 40, 45][i]!)]]);
  const c = oiLongChain(rows, P, { t: NOW, level: 300, at });
  const l1 = 300 * 45 / 50, l2 = l1 * 40 / 45;
  assert.deepEqual(c.venues, [['bybit:BTCUSDT'], ['bybit:BTCUSDT'], ['bybit:BTCUSDT']], 'Binance is not read at both ends of any step');
  assert.deepEqual(c.bars.map(b => b[4]), [l2 * 35 / 40, l2, l1]);
  // A bar whose period ends after the seam is not drawn before it.
  assert.equal(oiLongChain(new Map([['bybit:BTCUSDT', [[NOW - P / 2, 1, 1, 1, 1]]]]), P, { t: NOW, level: 300, at }).bars.length, 0);
});
