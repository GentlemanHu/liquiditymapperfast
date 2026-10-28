import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlowBook } from '../src/app/flow-book.ts';
import { Asked } from '../src/app/measures/measure.ts';
import type { DeltaTrack } from '../src/app/delta/candles.ts';
import type { OiPart } from '../src/app/oi-change.ts';
import { LAYOUT_KEYS, readSettings, type AppState, type OiBar } from '../src/app/store.ts';
import { readLayouts, settingsToApply } from '../src/app/layouts/layouts.ts';
import { TRADED_DEFAULTS, readTraded } from '../src/app/traded/settings.ts';
import { tradedHeader, tradedLines, tradedRows } from '../src/app/traded.ts';
import { metricHeader, metricWords, timeWords, type ProfileMetric } from '../src/app/measures/registry.ts';
import { setFromLegacy } from '../src/app/traded/profiles.ts';
import { arrangeProfiles } from '../src/app/traded/arrange.ts';
import { BAND_GAP, BAND_H, BUCKETS_MS, bandCaption, bucketAt, bucketFor, bucketMs, bucketSpan, eventRows, flowRows, minuteFlowAt, oiRows, oiSpread, stripBand, timeLevels, timeLines, timeText, type OiMarket } from '../src/app/measures/model.ts';
import { TopBands, TopProfile, topMarks, topShown, type BandHub, type TopPlace } from '../src/app/measures/strip.ts';
import type { Liquidation } from '../src/app/liquidations.ts';
import type { AbsorptionMark } from '../src/app/absorption.ts';
import { PALETTES } from '../src/app/theme.ts';
import { View } from '../src/app/view.ts';
import { usd } from '../src/app/format.ts';
import { paintBand } from '../src/app/measures/paint.ts';
import { emphasisRamps } from '../src/app/traded/emphasis.ts';

const SEC = 1000, MIN = 60_000, HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 19, 12);

const MARKETS = [{ instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', quote: 'USDT', marketType: 'perpetual' }, { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC', quote: 'USDT', marketType: 'perpetual' }];

/** The page's state as far as the band reads it: the Volume profile on, its profile along the top showing `metric`. */
function stateOf(patch: Partial<AppState> = {}, metric: ProfileMetric = 'volume'): AppState {
  return { markets: MARKETS, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', disabledVenues: [], scope: 'all', levels: null, bookGone: {}, timeframe: '1m',
    oi: [], oiParts: [], oiInstrument: '', oiPrice: 0, candles: [], hover: null, mark: { price: 100, asOf: 0 }, show: { volume: true, traded: true }, liquidations: { on: false, minUsd: 1_000, side: 'both', scale: 1, labels: true },
    traded: { ...TRADED_DEFAULTS, placements: setFromLegacy(['volume'], { on: true, metric }) }, ...patch } as unknown as AppState;
}

/** The profile along the top as the saves before the places held it (traded/profiles.ts): its measure, and whether it is on. */
const topOf = (traded: AppState['traded']): { on: boolean; metric: string } => {
  const p = traded.placements.instances.find(x => x.placement === 'top');
  return { on: p?.enabled === true, metric: p?.metric ?? '' };
};

/** A flow book holding two markets' seconds over [from, to): Binance buys 3 and sells 1 a second, Bybit buys 1 and sells 2. */
function bookOf(from: number, to: number): FlowBook {
  const flow = new FlowBook();
  for (let t = from; t < to; t += SEC) flow.apply([['binance:BTCUSDT', t, 3, 1, 100], ['bybit:BTCUSDT', t, 1, 2, 100]]);
  return flow;
}

/** A hub that holds `flow`, answers the liquidations and minute open interest given, holds the absorption marks given, and counts what it is asked. */
function hubOf(flow: FlowBook, o: { liquidations?: Liquidation[]; marks?: AbsorptionMark[]; absorptionCut?: Map<string, number>; oi?: Record<string, OiBar[]>; floor?: number } = {}): BandHub & { asked: number; liquidationsAsked: [number, number][]; oiAsked: string[] } {
  const hub = {
    flow, asked: 0, liquidationsAsked: [] as [number, number][], oiAsked: [] as string[],
    ensureFlow: async (): Promise<void> => { hub.asked++; }, ensureFlowMinutes: async (): Promise<void> => { hub.asked++; },
    oiSeries: async (id: string, tf: string): Promise<{ bars: OiBar[] }> => { hub.oiAsked.push(`${id}|${tf}`); return { bars: o.oi?.[id] ?? [] }; },
    source: { liquidations: async (from: number, to: number): Promise<Liquidation[]> => { hub.liquidationsAsked.push([from, to]); return o.liquidations ?? []; } },
    absorption: { marks: (): AbsorptionMark[] => o.marks ?? [], version: 1, cover: { from: T - HOUR, to: Infinity }, floorIn: (): number | undefined => o.floor },
    absorptionCut: o.absorptionCut ?? new Map<string, number>(), absorptionState: 'ready' as const,
  };
  return hub;
}

const noAbsorption = (): { thresholds: Map<string, number | null> } => ({ thresholds: new Map() });
/** Let what was asked for come back. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));

test('a bucket is the round length nearest to three pixels wide, two at the least, never finer than the data, and says which set it', () => {
  assert.deepEqual(BUCKETS_MS, [SEC, 2 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC, MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
  for (let i = 1; i < BUCKETS_MS.length; i++) assert.ok(BUCKETS_MS[i]! / BUCKETS_MS[i - 1]! <= 2.5, 'no length more than two and a half times the one before');
  assert.equal(bucketMs(10 * MIN, 1200), 2 * SEC, 'ten minutes on 1,200 px: 2 s is 4 px, nearer to three than 1 s at 2 px');
  assert.equal(bucketMs(12 * MIN, 1200), 2 * SEC, 'twelve minutes: 2 s, 3.3 px (no fat 5 s bars)');
  assert.equal(bucketMs(HOUR, 1200), 10 * SEC, 'an hour: 9 s would be three pixels');
  assert.equal(bucketMs(6 * HOUR, 1200), MIN);
  assert.equal(bucketMs(24 * HOUR, 1200), 5 * MIN);
  assert.equal(bucketMs(3 * 24 * HOUR, 1200), 10 * MIN);
  assert.equal(bucketMs(400 * 24 * HOUR, 800), 24 * HOUR, 'zoomed out past a day a bucket: a day');
  assert.equal(bucketMs(1_240_000, 1200), 5 * SEC, '2 s is nearest to three pixels but would be 1.9 px, a sliver: the next length');
  assert.deepEqual(bucketFor(10 * MIN, 1200), { step: 2 * SEC, limit: null }, 'chosen by the zoom');
  assert.deepEqual(bucketFor(10 * MIN, 1200, MIN), { step: MIN, limit: 'data' }, 'set by the data, and said apart');
  assert.deepEqual(bucketFor(2 * MIN, 1200), { step: SEC, limit: 'finest' }, 'zoomed in past a second');
  assert.match(bandCaption(MIN, 'data', 'volume', 0), /^Bars of 1 min, the finest the flow is held at here$/);
  assert.match(bandCaption(MIN, 'data', 'oi', 5 * MIN), /^Bars of 1 min, the finest open interest is read at · readings about every 5 min$/);
  assert.equal(bandCaption(10 * SEC, null, 'volume', 0), 'Bars of 10 s');
  for (const span of [MIN, 7 * MIN, 25 * MIN, HOUR, 5 * HOUR, 2 * 24 * HOUR, 9 * 24 * HOUR]) {
    const b = bucketMs(span, 1000), px = (ms: number): number => ms / span * 1000;
    assert.ok(px(b) >= 2 || b === SEC, `${span}: ${px(b)} px`);
    // No other length at least two pixels wide is nearer to three.
    for (const other of BUCKETS_MS) if (px(other) >= 2) assert.ok(Math.abs(Math.log(px(b) / 3)) <= Math.abs(Math.log(px(other) / 3)) + 1e-9, `${span}: ${other} is nearer than ${b}`);
  }
  assert.equal(bucketMs(10 * MIN, 1200, MIN), MIN, 'a window reaching into the minutes: a minute at least');
});

test('traded volume: each bucket\'s buys and sells are the flow\'s, and the buckets add up to the per-second sums', () => {
  const now = T + 30 * MIN, flow = bookOf(T - HOUR, now), ids = ['binance:BTCUSDT', 'bybit:BTCUSDT'], tracks = ids.map(id => flow.track(id)!);
  const from = T, to = T + 20 * MIN + 30 * SEC, rows = flowRows(tracks, from, to, 5 * SEC, now);
  // Per second: Binance buys 3 and sells 1, Bybit buys 1 and sells 2, so each second is 4 bought and 3 sold.
  assert.equal(rows.buy.length, (20 * 60 + 30) / 5);
  for (let i = 0; i < rows.buy.length; i++) { assert.equal(rows.buy[i], 20); assert.equal(rows.sell[i], 15); assert.equal(rows.gaps[i], null); }
  const s = Math.floor(from / SEC), e = Math.floor(to / SEC) - 1, sum = (f: (k: DeltaTrack, sec: number) => number): number => tracks.reduce((a, k) => a + f(k, e) - f(k, s - 1), 0);
  const gross = sum((k, sec) => k.cumGross(sec)), delta = sum((k, sec) => k.cumDelta(sec));
  assert.equal(rows.total, gross, 'the buckets hold the whole gross volume');
  let buy = 0, sell = 0; for (let i = 0; i < rows.buy.length; i++) { buy += rows.buy[i]!; sell += rows.sell[i]!; }
  assert.equal(buy - sell, delta, 'and their difference is the delta over the same seconds');
  // A bucket at an edge counts only its part inside the window, so the totals are the column's whatever the bucket length.
  const coarse = flowRows(tracks, from + 20 * SEC, to, 15 * MIN, now);
  assert.equal(coarse.total, (to - from - 20 * SEC) / SEC * 7);
  assert.deepEqual(bucketSpan(coarse, 0), [from + 20 * SEC, from + 15 * MIN]);
  assert.equal(coarse.buy[0], (15 * 60 - 20) * 4);
});

test('traded volume: a market steps in only with a second before the bucket held, and the second under way is not counted', () => {
  // A market whose seconds start inside the window: the bucket of its first second leaves it out, the next ones count it.
  const late: DeltaTrack = { first: T / SEC + 7, cumDelta: sec => (sec - T / SEC - 6) * 2, cumGross: sec => (sec - T / SEC - 6) * 4 };
  const rows = flowRows([late], T, T + 20 * SEC, 5 * SEC, T + MIN);
  assert.deepEqual(rows.gaps.slice(0, 2), ['notRecorded', 'notRecorded'], 'no market held the second before: not recorded, not zero');
  assert.deepEqual([rows.buy[2], rows.sell[2]], [15, 5], 'gross 20 and delta 10: 15 bought and 5 sold');
  assert.equal(rows.recordedSince, T + 7 * SEC); assert.equal(rows.partial, true);
  const open = flowRows([late], T + 10 * SEC, T + MIN, 5 * SEC, T + 12 * SEC + 400);
  assert.equal(open.buy.length, 1, 'the stretch ends at now');
  assert.deepEqual([open.buy[0], open.sell[0], open.gaps[0]], [6, 2, null], 'seconds 10 and 11 whole (gross 8, delta 4), 12 under way');
});

test('traded volume: ten quiet minutes or more are not recorded, a short lull is a zero; minute flow makes a minute the finest bucket', () => {
  const s0 = T / SEC, flat = (sec: number): number => sec < s0 + 60 ? sec : sec < s0 + 720 ? s0 + 59 : sec - 660;
  const k: DeltaTrack = { first: s0 - 100, cumDelta: () => 0, cumGross: flat };
  const rows = flowRows([k], T, T + 15 * MIN, MIN, T + 15 * MIN);
  assert.equal(rows.gaps[0], null); assert.equal(rows.buy[0], 30);
  assert.ok(rows.gaps.slice(1, 12).every(g => g === 'quietGap'), 'eleven minutes with nothing on any market');
  assert.equal(rows.gaps[12], null);
  const lull = flowRows([{ first: s0 - 100, cumDelta: () => 0, cumGross: sec => sec < s0 + 60 ? sec : sec < s0 + 180 ? s0 + 59 : sec - 120 }], T, T + 5 * MIN, MIN, T + 5 * MIN);
  assert.deepEqual(lull.gaps, [null, null, null, null, null], 'two quiet minutes are quiet: zeros, no bar, no gap');
  assert.equal(lull.buy[1], 0);
  // A market held a minute at a time at the window's start (`settled` stops at the minute that is over).
  const minutes: DeltaTrack = { first: s0 - 3600, cumDelta: () => 0, cumGross: sec => sec, settled: sec => Math.floor((sec + 1) / 60) * 60 - 1 };
  assert.equal(minuteFlowAt([minutes], T), true);
  assert.equal(minuteFlowAt([{ ...minutes, settled: sec => sec }], T), false, 'seconds');
  assert.equal(minuteFlowAt([k], T), false, 'a track that is exact everywhere');
});

/** A market's flow as the OI spread reads it: `perSecond` traded each second from before T, at 100 plus one a minute after T. */
const flowTrack = (perSecond = 1, flat = false): { first: number; cumGross(sec: number): number; priceAt(sec: number): number } => ({
  first: T / SEC - 3600, cumGross: sec => flat ? 0 : (sec - (T / SEC - 3600)) * perSecond, priceAt: sec => 100 + Math.floor((sec - T / SEC) / 60),
});

test('open interest: the column\'s rule, each change spread over the minutes it came about in by their volume, valued at the prices that traded, never netted', () => {
  const minute = (i: number, oi: number): OiBar => [T + i * MIN, oi, oi, oi, oi];
  const markets: OiMarket[] = [
    // Read every minute: +10 coins, an unchanged reading, then −10.
    { id: 'binance:BTCUSDT', bars: [minute(0, 1000), minute(1, 1010), minute(2, 1010), minute(3, 1000)], track: flowTrack() },
    // An inverse market read every five minutes: −4 at its one price of $25, spread evenly over the five minutes that traded the same.
    { id: 'bybit:BTCUSD', bars: [minute(0, 500), minute(5, 496)], usdAt: 25, track: flowTrack() },
  ];
  const spread = oiSpread(markets, T, T + 10 * MIN, 77_000);
  assert.equal(spread.unplaced, 0);
  const rows = oiRows(spread.parts, spread.covered, T, T + 10 * MIN, MIN, spread.first);
  assert.equal(rows.buy[1], 10 * 101, 'the change came about in the minute after its first reading, at the price traded then');
  assert.equal(rows.sell[3], 10 * 103 + 20, 'a fall at that minute\'s price, beside the other market\'s share');
  assert.equal(rows.sell[1], 20, 'an increase on one market and a decrease on another both show');
  assert.deepEqual([rows.buy[2], rows.gaps[2]], [0, null], 'a reading that did not move is a zero, not a gap');
  assert.equal(rows.gaps[0], 'noHistory', 'before the first reading');
  assert.deepEqual(rows.gaps.slice(6), ['noReading', 'noReading', 'noReading', 'noReading'], 'after the last: no reading stands for these minutes');
  const words = metricWords('oi'), lines = timeLines(rows, 1, { metric: 'oi', words: timeWords('oi'), spacingMs: 5 * MIN, levels: null, now: T + HOUR });
  assert.ok(lines.some(l => l.label === words.buy && l.text === `$${usd(1010)}`) && lines.every(l => !/\bbuy|bought|sell|sold\b/i.test(l.label ?? '')), 'never called buying');
  assert.ok(lines.some(l => /spread over the minutes in between/.test(l.text)), 'how a change between readings five minutes apart is placed');
  assert.ok(timeLines(rows, 7, { metric: 'oi', words: timeWords('oi'), spacingMs: 5 * MIN, levels: null, now: T + HOUR }).some(l => /No open-interest reading/.test(l.text)));
});

test('open interest: a change across more than an hour, with nothing traded under it, or past the window is not placed, and the header says so', () => {
  const minute = (i: number, oi: number): OiBar => [T + i * MIN, oi, oi, oi, oi];
  const gap = oiSpread([{ id: 'binance:BTCUSDT', bars: [minute(0, 1000), minute(90, 1010)], track: flowTrack() }], T, T + 120 * MIN, 77_000);
  assert.deepEqual(gap.parts, [], 'readings 90 minutes apart: the column\'s gap rule (an hour), not the pane\'s two-hour hold');
  assert.equal(gap.unplaced, 10 * (100 + 119), 'valued at the market\'s last price, as the column values what it cannot place');
  const rows = oiRows(gap.parts, gap.covered, T, T + 120 * MIN, 5 * MIN, gap.first);
  assert.equal(rows.total, 0); assert.ok(rows.gaps.slice(1).every(g => g === 'noReading'), 'the gap is no reading, not growth');
  const head = metricHeader('oi', rows, { cut: false, incomplete: false, unplaced: gap.unplaced });
  assert.equal(head.warn, true); assert.match(head.sub, /not placed/);
  const quiet = oiSpread([{ id: 'binance:BTCUSDT', bars: [minute(0, 1000), minute(1, 1010)], track: flowTrack(1, true) }], T, T + 10 * MIN, 77_000);
  assert.deepEqual([quiet.parts.length, quiet.unplaced], [0, 10 * 109], 'nothing traded between the readings: not placed');
  const edge = oiSpread([{ id: 'binance:BTCUSDT', bars: [minute(-3, 1000), minute(1, 1010)], track: flowTrack() }], T, T + 10 * MIN, 77_000);
  assert.deepEqual([edge.parts.length, edge.unplaced], [0, 10 * 109], 'reaching back past the window\'s start: not placed');
});

test('open interest along the top is read by the minute whatever the chart\'s timeframe, and the chart\'s candles never price it', async () => {
  // Within one hour Binance adds 10 coins and takes 10 away: on an hourly chart the candle's change is zero; the minutes keep both.
  const minute = (i: number, oi: number): OiBar => [T + i * MIN, oi, oi, oi, oi];
  const oi = { 'binance:BTCUSDT': [minute(0, 100), minute(1, 110), minute(2, 100), minute(3, 100)] };
  const totals: number[] = [];
  for (const close of [50, 999]) {
    const hub = hubOf(bookOf(T - HOUR, T + 10 * MIN), { oi }), top = new TopProfile('oi'), state = stateOf({ timeframe: '1h', candles: [[T, 1, 1, 1, close, 1]] }, 'oi');
    let drawn = 0;
    top.work(state, hub, { from: T, to: T + 10 * MIN }, 10 * MIN, 1200, T + 10 * MIN, noAbsorption, () => drawn++);
    assert.deepEqual(hub.oiAsked, ['binance:BTCUSDT|1m', 'bybit:BTCUSDT|1m'], 'the columns\' perpetuals, by the minute, on an hourly chart');
    await settle();
    assert.equal(drawn, 1, 'the answer redraws the map');
    const w = top.work(state, hub, { from: T, to: T + 10 * MIN }, 10 * MIN, 1200, T + 10 * MIN, noAbsorption)!;
    assert.deepEqual([w.rows.step, w.limit], [MIN, 'data'], 'a minute at least: open interest is read no finer');
    assert.deepEqual([w.rows.buy[1], w.rows.sell[2]], [1000, 1000], '+10 then −10 coins at the $100 that traded: both, not zero');
    totals.push(w.rows.total);
  }
  assert.equal(totals[0], totals[1], 'the same readings and trades give the same dollars whatever the candles\' closes');
});

test('liquidations and absorption: the column\'s markets and thresholds, their two sides in its places, partial when the record is cut', async () => {
  const liq = (t: number, side: 'long' | 'short', usd: number, id = 'binance:BTCUSDT'): Liquidation => ({ t, id, side, price: 1, usd, reported: 1, kind: 'price' } as unknown as Liquidation);
  const flow = bookOf(T - MIN, T + 10 * MIN);
  const liquidations = [liq(T + 10 * SEC, 'short', 5_000), liq(T + 20 * SEC, 'long', 2_000), liq(T + 21 * SEC, 'long', 500), liq(T + 40 * SEC, 'short', 9_000, 'okx:BTC-USDT-SWAP')];
  const hub = hubOf(flow, { liquidations }), top = new TopProfile('liquidations'), win = { from: T, to: T + 10 * MIN };
  const before = top.work(stateOf({}, 'liquidations'), hub, win, 10 * MIN, 300, T + 10 * MIN, noAbsorption)!;
  assert.deepEqual(hub.liquidationsAsked, [[T, T + 10 * MIN]], 'asked for the column\'s window, with no smallest size (the diamonds\' does not count)');
  assert.ok(before.rows.gaps.every(g => g === 'notLoaded'), 'until they come: not loaded, not zero');
  await settle();
  const w = top.work(stateOf({}, 'liquidations'), hub, win, 10 * MIN, 300, T + 10 * MIN, noAbsorption)!;
  assert.equal(w.rows.step, 5 * SEC);
  assert.equal(w.rows.buy[2], 5_000, 'shorts liquidated: forced buys, the first side (bid colour)');
  assert.equal(w.rows.sell[4], 2_500, 'longs liquidated, every size: $2,000 and $500, as the column adds them');
  assert.equal(w.rows.total, 7_500, 'a market the columns do not count is left out');
  assert.equal(w.flags.cut, false);
  const many = hubOf(flow, { liquidations: Array.from({ length: 5_000 }, (_, i) => liq(T + i, 'long', 1)) }), cutTop = new TopProfile('liquidations');
  cutTop.work(stateOf({}, 'liquidations'), many, win, 10 * MIN, 300, T + 10 * MIN, noAbsorption); await settle();
  const cut = cutTop.work(stateOf({}, 'liquidations'), many, win, 10 * MIN, 300, T + 10 * MIN, noAbsorption)!;
  assert.deepEqual([metricHeader('liquidations', cut.rows, cut.flags).sub, metricHeader('liquidations', cut.rows, cut.flags).warn], ['the largest 5,000', true], 'an answer cut at its limit is said to be partial');
  // Absorption: the marks at their thresholds, on the markets the column judges; market sells resting buyers took first.
  const mark = (t: number, side: 'buy' | 'sell', usd: number): AbsorptionMark => ({ id: 'binance:BTCUSDT', side, price: 1, t0: t, t1: t, usd, fills: 1, peak: usd, threshold: 100 });
  let judged: readonly string[] = [];
  const ab = hubOf(flow, { marks: [mark(T + MIN, 'sell', 400), mark(T + MIN + SEC, 'buy', 300), mark(T - 2 * HOUR, 'buy', 1)], absorptionCut: new Map([['binance:BTCUSDT', 150]]) });
  const marks = ab.absorption.marks; ab.absorption.marks = (ids, ...rest) => { judged = ids; return marks(ids, ...rest); };
  const abs = (): { thresholds: Map<string, number | null> } => ({ thresholds: new Map<string, number | null>([['binance:BTCUSDT', 100], ['bybit:BTCUSDT', null], ['okx:BTC-USDT-SWAP', 100]]) });
  const a = new TopProfile('absorption').work(stateOf({}, 'absorption'), ab, win, 10 * MIN, 300, T + 10 * MIN, abs)!;
  assert.deepEqual(judged, ['binance:BTCUSDT'], 'the column\'s markets that have a threshold');
  assert.deepEqual([a.rows.buy[12], a.rows.sell[12], a.rows.total], [400, 300, 700]);
  assert.equal(a.flags.cut, true, 'a mark at or above the threshold may have been let go: partial');
  assert.equal(metricHeader('absorption', a.rows, a.flags).warn, true);
  // Outside what the page holds: not loaded, not zero.
  const held = eventRows([{ t: T + 30 * SEC, side: 0, usd: 1 }], T, T + 2 * MIN, MIN, { from: T + MIN, to: Infinity });
  assert.deepEqual(held.gaps, ['notLoaded', null]);
  assert.equal(held.total, 0, 'an event outside what is held is not counted');
  assert.ok(timeLines(held, 0, { metric: 'liquidations', words: timeWords('liquidations'), spacingMs: 0, levels: null, now: T + HOUR }).some(l => /Nothing is held/.test(l.text)));
  assert.ok(timeLines(held, 1, { metric: 'liquidations', words: timeWords('liquidations'), spacingMs: 0, levels: null, now: T + HOUR }).some(l => /No liquidation reported in this stretch/.test(l.text)), 'held and empty: nothing reported');
});

test('absorption: a busy minute that left out a marked group makes the band say "some minutes in part", by the column\'s rule', () => {
  const mark = (t: number, usd: number): AbsorptionMark => ({ id: 'binance:BTCUSDT', side: 'sell', price: 1, t0: t, t1: t, usd, fills: 1, peak: usd, threshold: 100_000 });
  const abs = (): { thresholds: Map<string, number | null> } => ({ thresholds: new Map<string, number | null>([['binance:BTCUSDT', 100_000]]) });
  const flagsAt = (floor: number | undefined): { incomplete: boolean; sub: string; warn: boolean } => {
    const hub = hubOf(bookOf(T - MIN, T + 10 * MIN), { marks: [mark(T + MIN, 300_000)], floor });
    const w = new TopProfile('absorption').work(stateOf({}, 'absorption'), hub, { from: T, to: T + 10 * MIN }, 10 * MIN, 300, T + 10 * MIN, abs)!;
    const head = metricHeader('absorption', w.rows, w.flags);
    return { incomplete: w.flags.incomplete, sub: head.sub, warn: head.warn };
  };
  assert.deepEqual(flagsAt(200_000), { incomplete: true, sub: 'some minutes in part', warn: true }, 'a $200K floor over a $100K threshold: a mark may have been left out');
  assert.equal(flagsAt(100_000).incomplete, false, 'a floor at the threshold with fewer groups than a minute keeps: complete');
  assert.equal(flagsAt(50_000).incomplete, false, 'under the threshold: nothing marked was left out');
  assert.equal(flagsAt(undefined).incomplete, false, 'no floors held');
});

/** A canvas that writes down what is drawn on it: each call with its arguments, and the style and alpha it was made with. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: { name: string; args: unknown[]; fill: unknown; stroke: unknown; alpha: unknown; dash: unknown }[] } {
  const calls: { name: string; args: unknown[]; fill: unknown; stroke: unknown; alpha: unknown; dash: unknown }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000' };
  let dash: number[] = [];
  const ctx = new Proxy(state, {
    get: (target, key: string) => key in target ? target[key] : key === 'measureText' ? (text: string) => ({ width: text.length * 6 })
      : (...args: unknown[]) => { if (key === 'setLineDash') dash = args[0] as number[]; calls.push({ name: key, args, fill: target.fillStyle, stroke: target.strokeStyle, alpha: target.globalAlpha, dash }); },
    set: (target, key: string, value) => { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

test('a stretch with no data is drawn as such: a dotted line where its bar would hang, never the blank of a reading that did not move', () => {
  const p = PALETTES.light!, band = { top: 50, height: 96 }, frame = { view: new View({ t0: T, t1: T + 10 * MIN, p0: 1, p1: 2 }), pw: 1000, ph: 600, palette: p };
  const draw = { bars: 'split' as const, emphasis: true, levels: null, head: 'OI', sub: '', warn: false, net: null, caption: '', hovered: -1, now: T + HOUR };
  const dotted = (rows: ReturnType<typeof oiRows>): number[][] => {
    const { ctx, calls } = recorder();
    paintBand(ctx, rows, band, frame, draw);
    return calls.filter(c => (c.name === 'moveTo' || c.name === 'lineTo') && c.args[1] === band.top + 2.5 && JSON.stringify(c.dash) === '[1,3]').map(c => c.args as number[]);
  };
  // Five-minute readings: minute 1 holds the change; with the gap rule broken at 3 minutes the minutes after have no reading.
  const minute = (i: number, oi: number): OiBar => [T + i * MIN, oi, oi, oi, oi];
  const gaps = oiSpread([{ id: 'binance:BTCUSDT', bars: [minute(0, 1000), minute(1, 1010), minute(70, 1010)], track: flowTrack() }], T, T + 10 * MIN);
  const holes = dotted(oiRows(gaps.parts, gaps.covered, T, T + 10 * MIN, MIN, gaps.first));
  assert.deepEqual(holes, [[0, 52.5], [100, 52.5], [200, 52.5], [1000, 52.5]], 'minute 0 (before the readings) and minutes 2 to 9 (none stands for them), one dotted run each');
  // The same change, then readings that did not move: zeros, recorded, with no line.
  const flat = oiSpread([{ id: 'binance:BTCUSDT', bars: [minute(0, 1000), minute(1, 1010), ...Array.from({ length: 9 }, (_, i) => minute(i + 2, 1010))], track: flowTrack() }], T, T + 10 * MIN);
  assert.deepEqual(dotted(oiRows(flat.parts, flat.covered, T, T + 10 * MIN, MIN, flat.first)), [[0, 52.5], [100, 52.5]], 'only the minute before the first reading');
});

test('split bars are drawn at the shared alphas, opaque for the stronger side and 0.35 for the weaker at full one-sidedness, in every painter', () => {
  const p = PALETTES.light!, band = { top: 50, height: 96 }, frame = { view: new View({ t0: T, t1: T + 10 * MIN, p0: 1, p1: 2 }), pw: 1000, ph: 600, palette: p };
  const rows = eventRows([{ t: T + 5 * SEC, side: 0, usd: 50e6 }, { t: T + 6 * SEC, side: 1, usd: 1e6 }], T, T + 10 * MIN, MIN, { from: -Infinity, to: Infinity });
  const { ctx, calls } = recorder();
  paintBand(ctx, rows, band, frame, { bars: 'split', emphasis: true, levels: null, head: '', sub: '', warn: false, net: null, caption: '', hovered: -1, now: T + HOUR });
  const bars = calls.filter(c => c.name === 'fillRect' && (c.args[1] as number) >= band.top + 1 && (c.args[1] as number) < band.top + band.height);
  const strong = bars.find(c => c.fill === emphasisRamps(p).bid[255]), weak = bars.find(c => c.fill === p.ask);
  assert.ok(strong && Math.abs((strong.alpha as number) - 1) < 1e-9, `the stronger side opaque (${strong?.alpha})`);
  assert.ok(weak && Math.abs((weak.alpha as number) - 0.35) < 1e-9, `the weaker side at 0.35 (${weak?.alpha})`);
  // The map's own painters (the columns, the profiles on the chart) call the shared function with its own alpha, never one of their own.
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'panes', 'heat-pane.ts'), 'utf8'), uses = [...source.matchAll(/splitStyles\(([^()]*)\)/g)];
  assert.equal(uses.length, 2, 'the columns and the profiles on the chart');
  for (const use of uses) assert.equal(use[1]!.split(',').length, 6, `no alpha of its own: splitStyles(${use[1]})`);
});

test('the point of control is the busiest bucket and the value area the run around it holding the share, read as the column reads prices', () => {
  const sizes = [1, 1, 5, 30, 10, 2, 40, 3, 1, 1, 1];
  const rows = eventRows(sizes.map((size, i) => ({ t: T + i * MIN, side: (i % 2) as 0 | 1, usd: size })), T, T + 11 * MIN, MIN, { from: -Infinity, to: Infinity });
  assert.equal(rows.poc, 6); assert.equal(rows.max, 40); assert.equal(rows.total, 95);
  const l = timeLevels(rows, 0.7)!;
  assert.equal(l.poc, 6);
  // From 40 out, the bigger neighbour first (3 after it, then 2 and 10 before it), until the run holds 66.5 of 95: 30 more makes 85.
  let inside = 0; for (let i = l.lo; i <= l.hi; i++) inside += sizes[i]!;
  assert.equal(inside, 85);
  assert.deepEqual([l.lo, l.hi], [3, 7]);
  const box = timeLines(rows, 3, { metric: 'volume', words: timeWords('volume'), spacingMs: 0, levels: l, now: T + HOUR });
  assert.ok(box.some(x => x.label === 'Profile' && x.text === 'In the value area'));
  assert.ok(timeLines(rows, 1, { metric: 'volume', words: timeWords('volume'), spacingMs: 0, levels: l, now: T + HOUR }).some(x => x.text === 'Before the value area'));
  assert.ok(timeLines(rows, 9, { metric: 'volume', words: timeWords('volume'), spacingMs: 0, levels: l, now: T + HOUR }).some(x => x.text === 'After the value area'));
  assert.equal(timeLevels(eventRows([], T, T + MIN, MIN, null), 0.7), null, 'nothing in it: no levels');
});

test('a bucket\'s box is a column row\'s box with its time span for its prices', () => {
  const rows = eventRows([{ t: T + 5 * SEC, side: 0, usd: 3_000 }, { t: T + 6 * SEC, side: 1, usd: 1_000 }], T, T + MIN, 15 * SEC, { from: -Infinity, to: Infinity });
  const box = timeLines(rows, 0, { metric: 'volume', words: timeWords('volume'), spacingMs: 0, levels: null, now: T + HOUR });
  assert.equal(box[0]!.text, `${timeText(T, 15 * SEC, T + HOUR)} – ${timeText(T + 15 * SEC, 15 * SEC, T + HOUR)}`);
  assert.match(box[0]!.text, /:00 – .*:15$/, 'to the second for buckets under a minute');
  // The same numbers on a row of the column say the same lines under the first.
  const column = tradedRows({ from: T, to: T + MIN, instruments: [{ id: 'x', step: 1, minutes: 0, first: null, earliest: T, rows: [[10, 3_000, 1_000]] }] }, 1, 0, 20);
  const row = tradedLines(column, 10);
  assert.deepEqual(box.slice(1).map(l => [l.label, l.text]), row.slice(1).map(l => [l.label, l.text]));
  assert.equal(bucketAt(rows, T + 16 * SEC), 1); assert.equal(bucketAt(rows, T + MIN), -1); assert.equal(bucketAt(rows, T - 1), -1);
  assert.deepEqual(tradedHeader(rows), [`TRADED ${usd(4_000)}`, `ROW MAX ${usd(4_000)}`], 'the column\'s header reads the rows unchanged');
});

test('what was worked out is kept for the same buckets and second, and worked out again for other markets or new flow', () => {
  const now = T + 90 * MIN, flow = bookOf(T - HOUR, now), hub = hubOf(flow), top = new TopProfile('volume'), span = 60 * MIN;
  const win = { from: T + 30 * MIN, to: now + MIN };
  const a = top.work(stateOf(), hub, win, span, 1200, now, noAbsorption)!;
  assert.equal(a.rows.step, 10 * SEC);
  assert.ok(hub.asked > 0, 'it asks for the flow it needs, with the Delta pane hidden');
  assert.equal(top.work(stateOf(), hub, win, span, 1200, now + 300, noAbsorption), a, 'the same second: the same answer');
  const b = top.work(stateOf({ disabledVenues: ['bybit'] }), hub, win, span, 1200, now, noAbsorption)!;
  assert.notEqual(b, a); assert.equal(b.rows.buy[b.rows.buy.length - 3], 30, 'Bybit switched off: Binance alone, 3 a second');
  flow.invalidate();
  assert.notEqual(top.work(stateOf(), hub, win, span, 1200, now, noAbsorption), a, 'flow loaded again (loads): worked out again');
});

test('while the Volume profile or its bands along the top are off, the bands work nothing out, ask for nothing and draw nothing', () => {
  const flow = bookOf(T - HOUR, T), hub = hubOf(flow), bands = new TopBands();
  const untouchable = new Proxy({}, { get: () => { throw new Error('the canvas was used'); } }) as CanvasRenderingContext2D;
  const place: TopPlace = { view: new View({ t0: T - HOUR, t1: T, p0: 1, p1: 2 }), pw: 800, ph: 600, palette: PALETTES.light!, legendBottom: 42, window: { from: T - HOUR, to: T }, absorption: noAbsorption, loaded: () => {} };
  const room = { sides: 4, maxBands: 3, band: { legendBottom: 42, toolsBottom: 37, ph: 600, volume: true } };
  const off = stateOf({ show: { volume: true, traded: false } } as Partial<AppState>), noBand = stateOf({ traded: { ...TRADED_DEFAULTS, placements: setFromLegacy(['volume'], { on: false, metric: 'volume' }) } });
  // The Volume profile off: a band handed over anyway is not drawn. Its band off: none is placed.
  bands.paint(untouchable, off, hub, place, arrangeProfiles(stateOf().traded.placements, room).top);
  assert.deepEqual(arrangeProfiles(noBand.traded.placements, room).top, []);
  bands.paint(untouchable, noBand, hub, place, arrangeProfiles(noBand.traded.placements, room).top);
  assert.equal(topShown(off), false); assert.equal(topShown(noBand), false);
  assert.equal(hub.asked, 0);
  assert.equal(bands.readout(400, 60, T - MIN), null); assert.equal(bands.onHeader(10, 60), false);
  assert.equal(bands.misplaced(56), false, 'off: nothing to place');
  const drawn = arrangeProfiles(stateOf({}, 'absorption').traded.placements, room).top;
  assert.equal(topMarks(stateOf({}, 'absorption'), drawn), true, 'showing absorption: the marks\' groups are loaded');
  assert.equal(topMarks(stateOf({ show: { volume: true, traded: false } } as Partial<AppState>, 'absorption'), drawn), false);
  assert.equal(topMarks(stateOf({}, 'absorption'), []), false, 'a band switched on with no room asks for nothing');
});

test('the band sits under the legend and the corner buttons, the column\'s width tall, and keeps clear of the volume strip', () => {
  assert.deepEqual(stripBand({ legendBottom: 42, toolsBottom: 37, ph: 800, volume: true }), { top: 42 + BAND_GAP, height: BAND_H });
  assert.equal(stripBand({ legendBottom: 56, toolsBottom: 37, ph: 800, volume: true })!.top, 56 + BAND_GAP, 'a legend with a note line pushes it down');
  assert.equal(stripBand({ legendBottom: 28, toolsBottom: 37, ph: 800, volume: true })!.top, 37 + BAND_GAP, 'a short legend: under the buttons');
  assert.equal(stripBand({ legendBottom: 42, toolsBottom: 0, ph: 120, volume: true }), null, 'too short a map: none');
  for (const ph of [220, 300, 450, 900, 1400]) {
    const band = stripBand({ legendBottom: 56, toolsBottom: 37, ph, volume: true });
    if (band) assert.ok(band.top + band.height <= ph - Math.max(34, Math.min(ph * 0.17, 150)) - 6, `clear of the volume strip at ${ph}`);
    if (band) assert.ok(band.height <= BAND_H && band.height <= Math.max(36, ph * 0.2), `scaled down on a short map at ${ph}`);
  }
  // Placed under the legend the last frame drew; a legend that changed asks for another frame. Too short a map places no band at all.
  const bands = new TopBands(), tiny: TopPlace = { view: new View({ t0: T - HOUR, t1: T, p0: 1, p1: 2 }), pw: 800, ph: 60, palette: PALETTES.light!, legendBottom: 42, window: { from: T - HOUR, to: T }, absorption: noAbsorption, loaded: () => {} };
  const placed = arrangeProfiles(stateOf().traded.placements, { sides: 4, maxBands: 3, band: { legendBottom: 42, toolsBottom: 37, ph: 60, volume: true } });
  assert.deepEqual([placed.top, placed.hidden.map(p => p.id)], [[], ['volume:top']], 'no room: none placed, and it is said to be hidden');
  bands.paint(new Proxy({}, { get: () => { throw new Error('drawn'); } }) as CanvasRenderingContext2D, stateOf(), hubOf(new FlowBook()), tiny, placed.top);
  assert.equal(bands.misplaced(42), false); assert.equal(bands.misplaced(56), true);
});

test('settings: the profile along the top is part of the Volume profile, off by default with traded volume ready, read field by field', () => {
  assert.deepEqual(topOf(TRADED_DEFAULTS), { on: false, metric: 'volume' }, 'off since 2026-10-28');
  assert.deepEqual(topOf(readTraded({})), { on: false, metric: 'volume' });
  assert.deepEqual(topOf(readTraded({ top: { on: false, metric: 'absorption' } })), { on: false, metric: 'absorption' });
  assert.deepEqual(topOf(readTraded({ top: { on: 'yes', metric: 'whales' } })), { on: true, metric: 'volume' }, 'junk: the defaults');
  assert.ok(!(LAYOUT_KEYS as readonly string[]).includes('measureStrip'), 'the strip has no key of its own any more: layouts carry it in traded');
});

test('a save or a layout holding the measure strip reads as the profile along the top, with the Volume profile on where the strip showed', () => {
  const show = { profile: true, traded: false, volume: true };
  const oi = readSettings({ show, measureStrip: { on: true, kind: 'oi' }, traded: { bars: 'delta' } } as never);
  assert.deepEqual([topOf(oi.traded), oi.show.traded, oi.traded.bars], [{ on: true, metric: 'oi' }, true, 'delta']);
  const delta = readSettings({ show, measureStrip: { on: true, kind: 'delta' }, traded: { bars: 'split' } } as never);
  assert.deepEqual([topOf(delta.traded), delta.traded.bars], [{ on: true, metric: 'volume' }, 'split'], 'delta is traded volume, the bars as they were chosen');
  const off = readSettings({ show, measureStrip: { on: false, kind: 'oi' } } as never);
  assert.deepEqual([topOf(off.traded), off.show.traded], [{ on: false, metric: 'oi' }, false], 'a strip that was off: off, and the Volume profile as it was');
  const newer = readSettings({ show, measureStrip: { on: true, kind: 'oi' }, traded: { top: { on: false, metric: 'liquidations' } } } as never);
  assert.deepEqual([topOf(newer.traded), newer.show.traded], [{ on: false, metric: 'liquidations' }, false], 'a save with the profile along the top already: the strip is not read');
  // A layout from a file or from storage, and one applied.
  const [layout] = readLayouts([{ name: 'Strip', panes: { order: [], heights: {}, sideW: 420, flowW: 300 }, settings: { show, measureStrip: { on: true, kind: 'oi' } } }]);
  assert.deepEqual([topOf(layout!.settings.traded!), layout!.settings.show!.traded], [{ on: true, metric: 'oi' }, true]);
  assert.ok(!('measureStrip' in layout!.settings), 'and nothing of the strip is kept');
  const applied = settingsToApply({ show, measureStrip: { on: true, kind: 'delta' } } as never, { vwap: { anchors: {} }, traded: { zone: 'UTC' } } as unknown as AppState);
  assert.deepEqual([topOf(applied.traded), applied.show.traded, applied.traded.zone], [{ on: true, metric: 'volume' }, true, 'UTC']);
});

test('the strip\'s own words are gone from every language pack', () => {
  const gone = ['Measure strip', 'Show the measure strip', 'One bar per candle along the top of the chart: above the zero line for more, below it for less.', 'What each candle\'s bar stands for.',
    'No flow is recorded for this candle.', 'No new reading in this candle: open interest is read about every {n} min here.', 'No open-interest reading in this candle.',
    'Up: positions were opened; down: positions were closed. It does not say who bought or sold.', 'No market is switched on.', 'Measure strip', 'The change since the reading before: open interest is read about every {n} min here, so one change can stand for several candles.',
    'The columns right of the chart show measures by price; this strip shows them by time, one bar per candle, as the volume bars along the bottom do. Its button switches it on or off, and its key chooses the measure.'];
  const dir = path.join(process.cwd(), 'src', 'app', 'i18n'), packs = fs.readdirSync(dir).filter(f => /^[a-z]{2}\.json$/.test(f));
  assert.equal(packs.length, 11);
  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    for (const key of gone) assert.ok(!(key in pack), `${file} still has "${key}"`);
    // The band's own switch and measure became cells of the places' grid (traded/placement-panel.ts).
    for (const key of ['Profile by time', 'Time profile (along the top)', 'Columns (by price)']) assert.ok(!(key in pack), `${file} still has "${key}"`);
    for (const key of ['Where each measure is drawn', 'Emphasise the bigger side', 'Before the value area', 'After the value area', 'VA start', 'VA end']) assert.ok(key in pack, `${file} lacks "${key}"`);
  }
});

test('a question whose end only creeps on with a running clock is asked again after its spacing, a widened one at once, and the answer says what it read', async () => {
  const real = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const held = new Asked<number>(), settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    let asked = 0;
    const load = async () => ++asked;
    held.ensure('', 1_000, 2_000, false, load, () => {}); await settle();
    assert.deepEqual(held.answered, { from: 1_000, to: 2_000 });
    for (let i = 1; i <= 30; i++) { clock += 33; held.ensure('', 1_000, 2_000 + i * 33, false, load, () => {}); await settle(); }
    assert.equal(asked, 1, 'thirty frames of a clock-cut end: one question');
    clock += 5_000; held.ensure('', 1_000, 2_000 + 31 * 33 + 5_000, false, load, () => {}); await settle();
    assert.equal(asked, 2, 'asked again once its spacing has passed');
    assert.equal(held.answered!.to, 2_000 + 31 * 33 + 5_000);
    held.ensure('', 1_000, 3_600_000, false, load, () => {}); await settle();
    assert.equal(asked, 3, 'widened by a zoom: asked at once');
    held.ensure('', 500, 3_600_000, false, load, () => {}); await settle();
    assert.equal(asked, 4, 'moved back: asked at once');
  } finally { Date.now = real; }
});
