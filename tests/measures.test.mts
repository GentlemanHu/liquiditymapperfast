import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowBook } from '../src/app/flow-book.ts';
import { FlowCache, candleFlow, candleStarts, deltaCandles, resetKeys, unrecorded, type DeltaTrack } from '../src/app/delta/candles.ts';
import { deltaFlows } from '../src/app/delta/flows.ts';
import { oiChangeByTime, type OiPart } from '../src/app/oi-change.ts';
import { LAYOUT_KEYS, readSettings, type AppState, type OiBar } from '../src/app/store.ts';
import { readMeasureStrip } from '../src/app/measures/settings.ts';
import { barGeometry, deltaSeries, indexAt, oiScope, oiSeries, readingSpacing, scaleOf, stripBand, stripCaption, stripLines, STRIP_GAP } from '../src/app/measures/model.ts';
import { MeasureStrip, type StripPlace } from '../src/app/measures/strip.ts';
import { candleBody, footprintLayout } from '../src/app/panes/footprint.ts';
import { DEFAULT_HIGHLIGHT } from '../src/app/anomaly.ts';
import { PALETTES } from '../src/app/theme.ts';
import { View } from '../src/app/view.ts';

const MIN = 60_000, HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 19, 12);
const OFF = { ...DEFAULT_HIGHLIGHT, on: false };

/** A track whose running delta at second `s` is `f(s)` and whose gross volume grows a unit a second, holding seconds from `first`. */
const track = (first: number, f: (sec: number) => number, gross: (sec: number) => number = sec => sec): DeltaTrack => ({ first, cumDelta: f, cumGross: gross });

const MARKETS = [{ instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', quote: 'USDT', marketType: 'perpetual' }, { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', base: 'BTC', quote: 'USDT', marketType: 'perpetual' }];

/** The page's state as far as the strip reads it. */
function stateOf(patch: Partial<AppState> = {}): AppState {
  return { markets: MARKETS, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', disabledVenues: [], scope: 'all', levels: null, bookGone: {}, timeframe: '1m', highlight: OFF,
    measureStrip: { on: true, kind: 'delta' }, oi: [], oiParts: [], oiInstrument: '', show: { volume: true }, ...patch } as unknown as AppState;
}

/** A flow book holding two markets' seconds over [from, to): Binance buys 3 and sells 1 a second, Bybit buys 1 and sells 2, so each minute is +120 and −60. */
function bookOf(from: number, to: number): FlowBook {
  const flow = new FlowBook();
  for (let t = from; t < to; t += 1000) flow.apply([['binance:BTCUSDT', t, 3, 1, 100], ['bybit:BTCUSDT', t, 1, 2, 100]]);
  return flow;
}

/** A hub that holds `flow` and counts what it is asked to load. */
function hubOf(flow: FlowBook): { flow: FlowBook; asked: number; ensureFlow(): Promise<void>; ensureFlowMinutes(): Promise<void> } {
  const hub = { flow, asked: 0, ensureFlow: async (): Promise<void> => { hub.asked++; }, ensureFlowMinutes: async (): Promise<void> => { hub.asked++; } };
  return hub;
}

test('candles are whole buckets: a change lands in the candle that holds its bar, and a time on an edge belongs to the candle it starts', () => {
  const starts = candleStarts(T, T + 5 * MIN, T + 5 * MIN, MIN, 'none', 'UTC');
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5].map(i => T + i * MIN), 'whole minutes from the left edge to now');
  assert.deepEqual(candleStarts(T + 30_000, T + 150_000, T + 150_000, MIN, 'none', 'UTC'), [T, T + MIN, T + 2 * MIN], 'a view starting inside a candle takes the whole candle');
  const s = oiSeries(starts, new Map([[T + MIN, 5], [T + 3 * MIN, -2]]), MIN, OFF);
  assert.deepEqual([...s.values].map(v => Number.isNaN(v) ? null : v), [null, 5, null, -2, null, null]);
  assert.equal(indexAt(s, T + MIN), 1, 'on the edge: the candle it starts');
  assert.equal(indexAt(s, T + MIN - 1), 0, 'a millisecond before: the candle before');
  assert.equal(indexAt(s, T + 50 * MIN), 5, 'right of the newest: the newest, as a pane\'s readout does');
  assert.equal(indexAt(s, T - 1), -1, 'left of the first: none');
});

test('a candle with no data is not a zero: it has no value, says why, and does not count in the scale', () => {
  const s0 = T / 1000;
  // Volume grows except over [T + 2 min, T + 14 min): nothing then, so twelve minutes are taken as not recorded.
  const flat = (sec: number): number => sec < s0 + 120 ? sec : sec < s0 + 840 ? s0 + 119 : sec - 720;
  const k = track(s0 - 100, sec => (sec - s0) * 2, flat), starts = Array.from({ length: 16 }, (_, i) => T + i * MIN), now = T + 16 * MIN;
  const raw = starts.map(t => candleFlow([k], t, MIN, now)), s = deltaSeries(starts, raw, unrecorded(starts, raw, MIN, now), MIN, OFF);
  assert.equal(s.values[0], 120);
  assert.ok(Number.isNaN(s.values[5]!), 'inside the quiet stretch: no value');
  assert.equal(s.gaps[5], 'quietGap');
  const none = deltaSeries([T], [null], [null], MIN, OFF);
  assert.equal(none.gaps[0], 'notRecorded', 'no market held flow when it began');
  // A real zero (a quiet minute inside a short lull) stays a zero.
  const zero = deltaSeries([T], [{ delta: 0, low: 0, high: 0, gross: 0 }], [{ delta: 0, low: 0, high: 0, gross: 0 }], MIN, OFF);
  assert.equal(zero.values[0], 0); assert.equal(zero.gaps[0], null);
  const words = stripLines(s, 5, { timeframe: '1m', scope: () => '2 markets', coin: 'BTC', spacingMs: 0, now });
  assert.ok(words.some(l => l.text === 'no data'), 'the popup says no data');
  assert.ok(!words.some(l => /\$0\b/.test(l.text)), 'and never a zero');
  assert.ok(words.some(l => l.wrap && /ten minutes/.test(l.text)), 'and why');
  const oi = oiSeries(starts.slice(0, 4), new Map([[T + MIN, 0], [T + 3 * MIN, 4]]), MIN, OFF);
  assert.deepEqual(oi.gaps, ['noHistory', null, 'noReading', null], 'before the first change: no history; between readings: no reading');
  assert.equal(oi.values[1], 0, 'a reading that did not move is a zero');
  assert.equal(scaleOf(oi, T, T + 4 * MIN), 4, 'missing candles are left out of the scale');
});

test('the strip\'s delta is the Delta pane\'s, candle for candle', () => {
  const now = T + 90 * MIN, flow = bookOf(T - HOUR, now), hub = hubOf(flow), t0 = T + 30 * MIN, t1 = now;
  const strip = new MeasureStrip(), worked = strip.work(stateOf(), hub, t0, t1, now)!;
  // The pane's own path: its candles from the left edge, the same markets, its cache, its rule for quiet stretches, its candles.
  const starts = candleStarts(t0, t1, now, MIN, 'none', 'UTC'), ids = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
  const tracks = ids.map(id => flow.track(id)!), flows = unrecorded(starts, new FlowCache().get(`${ids.join(',')}|${MIN}|${flow.loads}`, tracks, starts, MIN, now), MIN, now);
  const pane = deltaCandles(starts, flows, resetKeys(starts, 'none', 'UTC'));
  assert.ok(pane.length > 50);
  for (const c of pane) assert.equal(worked.series.values[worked.series.starts.indexOf(c.t)], c.delta, `candle ${new Date(c.t).toISOString()}`);
  assert.equal(worked.series.values[worked.series.starts.indexOf(T + 40 * MIN)], 60, 'each whole minute: Binance +120, Bybit −60');
  assert.deepEqual(deltaFlows(new FlowCache(), flow, ids, starts, MIN, now).flows, flows, 'one function behind both');
  assert.match(worked.caption, /^Delta · 2 markets/);
  assert.ok(hub.asked > 0, 'it asks for the flow it needs, with the Delta pane hidden');
});

test('open interest: the sign is the change, the venues are named, and a coarse reading is said to be coarse', () => {
  // Two venues read every five minutes on a one-minute chart: Binance gains 10, Bybit loses 4 between readings.
  const bars = (step: number, from: number): OiBar[] => Array.from({ length: 6 }, (_, i) => [T + i * 5 * MIN, from + i * step, from + i * step, from + i * step, from + i * step]);
  const parts: OiPart[] = [{ id: 'binance:BTCUSDT', bars: bars(10, 1000) }, { id: 'bybit:BTCUSDT', bars: bars(-4, 500) }];
  const change = oiChangeByTime([], parts, MIN), starts = candleStarts(T, T + 25 * MIN, T + 26 * MIN, MIN, 'none', 'UTC');
  const s = oiSeries(starts, change, MIN, OFF);
  assert.equal(s.values[5], 6, 'the reading at 5 min: +10 and −4, each venue\'s own change');
  assert.ok(Number.isNaN(s.values[6]!), 'the minutes between readings have none');
  assert.equal(readingSpacing(parts.map(p => p.bars)), 5 * MIN);
  assert.equal(oiScope(2, undefined, ''), '2 venues added together');
  assert.equal(oiScope(2, 1, ''), '1 of 2 venues');
  assert.equal(oiScope(1, undefined, 'Binance BTCUSDT'), 'Binance BTCUSDT');
  assert.match(stripCaption('oi', '2 venues added together', 5 * MIN, MIN), /OI change · 2 venues added together · readings about every 5 min/);
  assert.doesNotMatch(stripCaption('oi', 'x', HOUR, HOUR), /readings/, 'readings as often as the candles: nothing to say');
  const lines = stripLines(s, 5, { timeframe: '1m', scope: () => '2 venues added together', coin: 'BTC', spacingMs: 5 * MIN, now: T + 26 * MIN });
  assert.ok(lines.some(l => l.label === 'OI change' && l.text === '+6.0 BTC' && l.color === 'below'), 'up in the bid colour, in coins');
  assert.ok(lines.some(l => /about every 5 min/.test(l.text)), 'a change that covers several candles says so');
  assert.ok(lines.every(l => !/\bbuys?\b/i.test(l.label ?? '')) && lines.some(l => /does not say who bought/.test(l.text)), 'never called buying');
  const between = stripLines(s, 6, { timeframe: '1m', scope: () => '', coin: 'BTC', spacingMs: 5 * MIN, now: T + 26 * MIN });
  assert.ok(between.some(l => /No new reading/.test(l.text)));
  // Through the strip: one market's own bars, named.
  const one: OiBar[] = bars(-3, 900), strip = new MeasureStrip();
  const worked = strip.work(stateOf({ timeframe: '5m', measureStrip: { on: true, kind: 'oi' }, oi: one, oiInstrument: 'binance:BTCUSDT' }), hubOf(new FlowBook()), T, T + 25 * MIN, T + 26 * MIN)!;
  assert.equal(worked.series.values[worked.series.starts.indexOf(T + 10 * MIN)], -3, 'down: positions closed, below zero');
  assert.match(worked.caption, /^OI change · Binance BTCUSDT$/);
});

test('what was worked out is kept for the same candles, and worked out again for other markets, another timeframe or new flow', () => {
  const now = T + 90 * MIN, flow = bookOf(T - HOUR, now), hub = hubOf(flow), strip = new MeasureStrip();
  const a = strip.work(stateOf(), hub, T + 30 * MIN, now, now)!;
  assert.equal(strip.work(stateOf(), hub, T + 30 * MIN + 20_000, now, now + 300), a, 'a pan inside the same candles and the same second: the same answer');
  const b = strip.work(stateOf({ disabledVenues: ['bybit'] }), hub, T + 30 * MIN, now, now)!;
  assert.notEqual(b, a); assert.equal(b.series.values[b.series.starts.indexOf(T + 40 * MIN)], 120, 'Bybit switched off: Binance alone');
  const c = strip.work(stateOf({ timeframe: '5m' }), hub, T + 30 * MIN, now, now)!;
  assert.equal(c.series.tfMs, 5 * MIN); assert.equal(c.series.values[c.series.starts.indexOf(T + 40 * MIN)], 300);
  const before = strip.work(stateOf(), hub, T + 30 * MIN, now, now)!;
  flow.invalidate();
  assert.notEqual(strip.work(stateOf(), hub, T + 30 * MIN, now, now), before, 'flow loaded again (loads): worked out again');
});

test('while it is off the strip works nothing out, asks for nothing and draws nothing', () => {
  const flow = bookOf(T - HOUR, T), hub = hubOf(flow), strip = new MeasureStrip();
  const untouchable = new Proxy({}, { get: () => { throw new Error('the canvas was used'); } }) as CanvasRenderingContext2D;
  let measured = 0;
  const place: StripPlace = { view: new View({ t0: T - HOUR, t1: T, p0: 1, p1: 2 }), pw: 800, ph: 600, palette: PALETTES.light!, narrowing: 0, legendBottom: 42, toolsBottom: () => { measured++; return 37; } };
  strip.paint(untouchable, stateOf({ measureStrip: { on: false, kind: 'delta' } }), hub, place);
  assert.equal(hub.asked, 0); assert.equal(measured, 0, 'not even the corner is measured');
  assert.equal(strip.readout(60, T - MIN, '1m'), null);
  assert.equal(strip.misplaced(56), false, 'off: nothing to place');
});

test('the band sits under the legend and the corner buttons, whichever reaches lower, and keeps clear of the volume strip', () => {
  assert.deepEqual(stripBand({ legendBottom: 42, toolsBottom: 37, ph: 600, volume: true }), { top: 42 + STRIP_GAP, height: 66 });
  assert.equal(stripBand({ legendBottom: 56, toolsBottom: 37, ph: 600, volume: true })!.top, 56 + STRIP_GAP, 'a legend with a note line pushes it down');
  assert.equal(stripBand({ legendBottom: 28, toolsBottom: 37, ph: 600, volume: true })!.top, 37 + STRIP_GAP, 'a short legend: under the buttons');
  assert.equal(stripBand({ legendBottom: 42, toolsBottom: 0, ph: 120, volume: true }), null, 'too short a map: none');
  for (const ph of [220, 300, 450, 900, 1400]) {
    const band = stripBand({ legendBottom: 56, toolsBottom: 37, ph, volume: true });
    if (band) assert.ok(band.top + band.height <= ph - Math.max(34, Math.min(ph * 0.17, 150)) - 6, `clear of the volume strip at ${ph}`);
    if (band) assert.ok(band.height <= Math.max(34, Math.min(ph * 0.17, 150)), 'no taller than the volume strip');
  }
  // The band is placed under the legend the last frame drew; a legend that changed asks for another frame.
  const strip = new MeasureStrip(), tiny: StripPlace = { view: new View({ t0: T - HOUR, t1: T, p0: 1, p1: 2 }), pw: 800, ph: 60, palette: PALETTES.light!, narrowing: 0, legendBottom: 42, toolsBottom: () => 37 };
  strip.paint(new Proxy({}, { get: () => { throw new Error('drawn'); } }) as CanvasRenderingContext2D, stateOf(), hubOf(new FlowBook()), tiny);
  assert.equal(strip.misplaced(42), false); assert.equal(strip.misplaced(56), true);
});

test('bars stand where the volume bars stand, under the candle as the footprint narrows it', () => {
  const v = new View({ t0: T, t1: T + 10 * MIN, p0: 1, p1: 2 }), pw = 1000, slot = pw / 10, xOf = (t: number): number => v.xOf(t, pw);
  assert.deepEqual(barGeometry(T, MIN, xOf, slot, 0), { x: 50, body: candleBody(slot) }, 'centred in its slot');
  const layout = footprintLayout(slot), narrowed = barGeometry(T, MIN, xOf, slot, 1);
  assert.equal(narrowed.x, layout.candleCenter); assert.equal(narrowed.body, Math.max(1, layout.body), 'with the footprint: under the candle at the slot\'s left');
});

test('the choice is saved and read back field by field; an older save, a layout or junk reads as off', () => {
  assert.deepEqual(readSettings({}).measureStrip, { on: false, kind: 'delta' });
  assert.deepEqual(readSettings({ measureStrip: { on: true, kind: 'oi' } }).measureStrip, { on: true, kind: 'oi' });
  assert.deepEqual(readMeasureStrip({ on: 'yes', kind: 'liquidations' }), { on: false, kind: 'delta' });
  assert.deepEqual(readMeasureStrip(null), { on: false, kind: 'delta' });
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('measureStrip'), 'layouts carry it, as they carry the other lamp features');
});
