import test from 'node:test';
import assert from 'node:assert/strict';
import { candleUsd, joinRows, stripBars, stripHighlights, stripLines, type StripBar } from '../src/app/measures/volume-strip.ts';
import { ORDERS_CUT_REFRESH_MS, ORDERS_REST_MS, StripOrderCache, orderLines, stripOrdersOf, type StripOrders } from '../src/app/measures/strip-orders.ts';
import { aggregateCandles } from '../src/shared/series.ts';
import { fetchCandles, type Fetcher } from '../src/shared/history.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
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
  const split = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, s => [s, 100, 110, 90, 100, 10, 1, 2.5], false);
  assert.deepEqual([split[0]!.buy, split[0]!.sell, split[0]!.split, split[0]!.exact], [250, 750, true, undefined]);
  // Its quote volume and the part of it bought at market (Binance's): the candle's dollars and sides as reported, with its trades.
  const exact = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, s => [s, 100, 110, 90, 100, 10, 1, 7.5, 400, 1020, 765], false);
  assert.deepEqual([exact[0]!.buy, exact[0]!.sell, exact[0]!.exact, exact[0]!.trades], [765, 255, true, 400]);
  // The recording starting inside a candle: that bar is the recording's, partial.
  const half = rows(); half.buy[3] = 300; half.gaps[3] = null;   // the half hour after 3:30 recorded
  const inside = stripBars(candles, H, half, T + 4 * H - 1_800_000, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.equal(inside[3]!.source, 'partial'); assert.equal(inside[3]!.buy, 300, 'the recorded part only, never the candle added to it');
  // Nothing recorded: every bar a candle. In a replay, a candle not closed by then is left out.
  assert.ok(stripBars(candles, H, null, null, T + 8 * H, T, T + 8 * H, place, () => undefined, false).every(b => b.source === 'candle'));
  assert.equal(stripBars(candles, H, null, null, T + 5.5 * H, T, T + 8 * H, place, () => undefined, true).length, 5, 'replayed at 5:30: the five closed candles');
});

test('the strip\'s Highlights are worked out within each run of one source', () => {
  const bar = (source: StripBar['source'], v: number): StripBar => ({ t: 0, x: 0, w: 1, source, buy: v, sell: 0, split: true, i: 0, gap: null });
  // Fifteen quiet candles, then recorded bars where 1,000 is ordinary: the first recorded bar is not flagged for being bigger than the candles.
  const bars = [...Array.from({ length: 15 }, () => bar('candle', 100)), ...Array.from({ length: 15 }, (_, i) => bar('recorded', 1000 + (i % 3)))];
  const found = stripHighlights(bars, { length: 20, mult: 2 });
  assert.equal(found.flag[15], 0, 'no baseline across the seam');
  assert.ok(Number.isNaN(found.threshold[15]!), 'a new run warms up again');
  const spike = [...bars, bar('recorded', 50_000)];
  assert.equal(stripHighlights(spike, { length: 20, mult: 2 }).flag[30], 1, 'a spike within its own run stands out');
});

test('a strip bar\'s box: the recorded bucket\'s figures, or the candle\'s with where it comes from', () => {
  const r = rows(), bars = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, i => (i === T ? [T, 100, 110, 90, 100, 10, 1, 7.5] : undefined), false);
  const c = { rows: r, tf: H, now: T + 8 * H, market: 'Binance', tfName: '1h', reports: false, total: 2400 };
  const candle = stripLines(bars[0]!, c);
  assert.ok(candle.some(l => l.color === 'buy' && l.text === '$750 · 75.0 %') && candle.some(l => l.color === 'sell' && l.text === '$250 · 25.0 %'), 'its taker split with its shares');
  assert.ok(candle.some(l => l.text === '+$500 · +50.0 %'), 'its delta with its share');
  assert.ok(candle.at(-1)!.text.startsWith('≈'), 'an estimate where the candle gives no quote volume');
  assert.ok(candle.at(-1)!.text.includes('Binance') && candle.at(-1)!.color === 'muted', 'where it comes from, last');
  const grey = stripLines(bars[1]!, c);
  assert.ok(grey.some(l => l.text === '$1,000' || l.text === '$1K' || l.text.startsWith('$1')), 'its whole volume');
  assert.ok(!grey.some(l => l.color === 'buy' || l.color === 'sell'), 'no sides where the candle does not say');
  const recorded = stripLines(bars[4]!, c);
  assert.ok(recorded.some(l => l.color === 'buy') && recorded.some(l => l.color === 'sell'), 'the venues\' two sides');
  assert.ok(!recorded.some(l => l.label === 'Profile' || /value area|point of control/i.test(l.text)), 'no profile: no value area, no point of control');
  // Binance's quote volume and trades: as reported, with the trades and the average fill.
  const exact = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, s => [s, 100, 110, 90, 100, 10, 1, 7.5, 4, 1020, 765], false);
  const box = stripLines(exact[0]!, c);
  assert.ok(box.some(l => l.text === '4') && box.some(l => l.text === '$255'), 'trades and the average fill');
  assert.ok(!box.at(-1)!.text.startsWith('≈') && box.at(-1)!.text.includes('quote volume'), 'as the exchange reports it');
});

test('a recorded bar\'s box says its market orders: counts, averages from the orders\' own dollars, whale share, largest venues', () => {
  const r = rows(), bars = stripBars(candles, H, r, T + 4 * H, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  const orders: StripOrders = { buyN: 40, sellN: 10, buyUsd: 2000, sellUsd: 1000, whale: { buy: 900, sell: 300, exact: true }, minutes: 45, of: 60, venues: [{ id: 'binance:BTCUSDT', share: 0.5 }, { id: 'bybit:BTCUSDT', share: 0.3 }] };
  const box = stripLines(bars[4]!, { rows: r, tf: H, now: T + 8 * H, market: 'Binance', tfName: '1h', reports: true, total: 2400, orders, whaleUsd: 500_000 });
  const text = box.map(l => `${l.label ?? ''}=${l.text}`).join('\n');
  assert.match(text, /50 · 40 buys · 10 sells/);
  assert.match(text, /Average buy order=\$50/); assert.match(text, /Average sell order=\$100/); assert.match(text, /Average order=\$60/);
  assert.match(text, /from \$500K=40\.0 % · Δ \+\$600/, 'the whale share of the order dollars and its delta');
  assert.match(text, /Binance 50\.0 % · Bybit 30\.0 %/);
  assert.match(text, /counted for 45 of the 60 minutes/);
  const say = (o: Parameters<typeof orderLines>[0]) => orderLines(o, 500_000).map(l => l.text).join(' ');
  assert.match(say('loading'), /Reading/); assert.match(say('failed'), /could not be read/); assert.match(say(null), /without order statistics/);
  assert.equal(orderLines(undefined, 1).length, 0, 'nothing where they are not asked');
  assert.match(say({ ...orders, whale: { ...orders.whale, exact: false } }), /≈ 40\.0 %/, 'estimated from the size boxes: said so');
});

test('the orders of a footprint bar: the size boxes added up, the whale line where asked, else from the boxes; the venues\' shares', () => {
  const stats = { buyN: 3, sellN: 2, buy: [10, 20, 30, 40, 0, 0, 0, 0], sell: [5, 5, 0, 0, 0, 0, 0, 0] };
  const bar: Bar = { t: T, rows: [], buyUsd: 999, sellUsd: 999, minutes: 60, stats, over: [70, 0], parts: [[['binance:BTCUSDT', 60, 5], ['okx:BTC-USDT-SWAP', 40, 5]]] };
  const o = stripOrdersOf(bar, { size: 1e5, index: 0 }, H)!;
  assert.deepEqual([o.buyUsd, o.sellUsd, o.whale.buy, o.whale.exact, o.of], [100, 10, 70, true, 60], 'the orders\' dollars, never the bar\'s');
  assert.deepEqual(o.venues.map(v => [v.id, Math.round(v.share * 100)]), [['binance', 59], ['okx', 41]]);
  assert.equal(stripOrdersOf({ ...bar, stats: undefined }, { size: 1e5, index: 0 }, H), null, 'no statistics: none');
  assert.equal(stripOrdersOf({ ...bar, over: undefined }, { size: 1e5, index: -1 }, H)!.whale.exact !== undefined, true, 'from the boxes where the line was not asked');
});

test('the orders cache: asked once the pointer rests, one request a candle, kept, and a bar left in time asks nothing', async () => {
  const cache = new StripOrderCache(), asked: string[] = [], value: StripOrders = { buyN: 1, sellN: 1, buyUsd: 1, sellUsd: 1, whale: { buy: 0, sell: 0, exact: true }, minutes: 60, of: 60, venues: [] };
  let landed = 0;
  const rest = () => new Promise(r => setTimeout(r, ORDERS_REST_MS + 50));
  const load = (key: string) => (to: number) => { asked.push(`${key}@${to}`); return Promise.resolve(value); };
  const closed = { to: 100, open: false };
  assert.equal(cache.want('a', closed, load('a'), () => landed++), 'loading');
  assert.equal(cache.want('a', closed, load('a'), () => landed++), 'loading', 'the same bar again: no second request');
  cache.want('b', closed, load('b'), () => landed++);
  cache.rest();
  await rest();
  assert.deepEqual(asked, [], 'left before resting: nothing asked');
  cache.want('c', closed, load('c'), () => landed++);
  await rest();
  assert.deepEqual(asked, ['c@100']); assert.equal(landed, 1);
  assert.equal(cache.want('c', closed, load('c'), () => landed++), value, 'kept');
  // Pointing at another bar, even one held, drops the one waiting for its turn.
  cache.want('d', closed, load('d'), () => landed++);
  assert.equal(cache.want('c', closed, load('c'), () => landed++), value);
  await rest();
  assert.deepEqual(asked, ['c@100'], 'd was left for c before its turn');
  // A candle that can still change is read again after its time, shown as it was meanwhile; read while open, read once more once settled.
  const live = new StripOrderCache(), got: string[] = [];
  const liveLoad = (to: number) => { got.push(String(to)); return Promise.resolve(value); };
  live.want('e', { to: 100, open: true }, liveLoad, () => {});
  await rest();
  assert.equal(live.want('e', { to: 100, open: true }, liveLoad, () => {}), value);
  assert.equal(live.want('e', { to: 100, open: true }, liveLoad, () => {}, Date.now() + 60_000), value, 'its time passed: shown, read again');
  await rest();
  assert.equal(got.length, 2);
  live.want('e', { to: 100, open: false }, liveLoad, () => {});
  await rest();
  assert.equal(got.length, 3, 'settled: one more read, its answer final');
  live.want('e', { to: 100, open: false }, liveLoad, () => {}, Date.now() + 3_600_000);
  await rest();
  assert.equal(got.length, 3, 'final: kept');
  // A failure is said, and asked again later.
  const failing = new StripOrderCache();
  failing.want('x', closed, () => Promise.reject(new Error('down')), () => {});
  await rest();
  assert.equal(failing.want('x', closed, () => Promise.resolve(value), () => {}), 'failed');
});

test('the orders cache in a replay: a cut moving on is read again every few seconds, an answer cut later than asked is never shown', async () => {
  const cache = new StripOrderCache(), cuts: number[] = [], value: StripOrders = { buyN: 2, sellN: 0, buyUsd: 2, sellUsd: 0, whale: { buy: 0, sell: 0, exact: true }, minutes: 10, of: 60, venues: [] };
  const load = (to: number) => { cuts.push(to); return Promise.resolve(value); };
  const rest = () => new Promise(r => setTimeout(r, ORDERS_REST_MS + 50));
  cache.want('k', { to: 10, open: false }, load, () => {});
  await rest();
  assert.equal(cache.want('k', { to: 11, open: false }, load, () => {}), value, 'the minute after: the earlier cut shown');
  await rest();
  assert.deepEqual(cuts, [10], 'not read again within the refresh');
  cache.want('k', { to: 12, open: false }, load, () => {}, Date.now() + ORDERS_CUT_REFRESH_MS + 1);
  await rest();
  assert.deepEqual(cuts, [10, 12]);
  assert.equal(cache.want('k', { to: 11, open: false }, load, () => {}), 'loading', 'moved back: the later answer is not shown');
  await rest();
  assert.deepEqual(cuts, [10, 12, 11]);
});

test('the box: zero orders begun is said as such; venues are exchanges; a zero-volume Binance candle is exact', () => {
  const none: StripOrders = { buyN: 0, sellN: 0, buyUsd: 0, sellUsd: 0, whale: { buy: 0, sell: 0, exact: true }, minutes: 1, of: 1, venues: [] };
  assert.match(orderLines(none, 1).map(l => l.text).join(' '), /No market order began/);
  assert.doesNotMatch(orderLines(none, 1).map(l => l.text).join(' '), /without order statistics/);
  const stats = { buyN: 1, sellN: 1, buy: [10, 0, 0, 0, 0, 0, 0, 0], sell: [10, 0, 0, 0, 0, 0, 0, 0] };
  const bar: Bar = { t: T, rows: [], buyUsd: 20, sellUsd: 0, stats, parts: [[['binance:BTCUSDT', 60, 0], ['binance:BTCUSD_PERP', 30, 0], ['bybit:BTCUSDT', 10, 0]]] };
  assert.deepEqual(stripOrdersOf(bar, { size: 1e9, index: -1 }, H)!.venues.map(v => [v.id, Math.round(v.share * 100)]), [['binance', 90], ['bybit', 10]], 'one exchange\'s markets added together');
  const quiet = stripBars(candles, H, null, null, T + 8 * H, T, T + 8 * H, place, s => [s, 100, 100, 100, 100, 0, 1, 0, 0, 0, 0], false);
  assert.deepEqual([quiet[0]!.exact, quiet[0]!.trades, quiet[0]!.buy + quiet[0]!.sell], [true, 0, 0]);
});

test('Binance candles carry their trades and quote volumes, summed across minutes, never scaled by a listing\'s unit, all three or none', async () => {
  const minute = (t: number, trades?: number, quote?: number, buyQuote?: number) => ({ start: t, open: 100, high: 101, low: 99, close: 100, volume: 2, buy: 1, trades, quote, buyQuote });
  const two = aggregateCandles([minute(T, 10, 200, 120), minute(T + 60_000, 5, 100, 30)], 120_000, true);
  assert.deepEqual(two[0]!.slice(7), [2, 15, 300, 150]);
  assert.equal(aggregateCandles([minute(T, 10, 200, 120), minute(T + 60_000)], 120_000, true)[0]!.length, 8, 'a minute without them: none');
  // Binance's kline fields: 7 quote volume, 8 trades, 10 taker buy quote volume.
  const kline = (t: number) => [t, '100', '101', '99', '100', '2', t + 59_999, '200.5', 12, '1', '120.25', '0'];
  const get: Fetcher = async url => { const end = Number(new URL(url).searchParams.get('endTime')); return [kline(Math.floor(end / 60_000) * 60_000 - 60_000)]; };
  const got = await fetchCandles('binance:BTCUSDT', 60_000, T, T + 120_000, get, undefined, 1, { buy: true });
  assert.deepEqual(got.at(-1)!.slice(7), [1, 12, 200.5, 120.25]);
  // A quote volume or a count that is not a figure (null, '', false) leaves all three out: never read as 0.
  // The bought quote volume is '0' so that a quote volume read as 0 would pass its range check: only the figure check leaves them out.
  const broken = (field: 7 | 8, bad: unknown): Fetcher => async url => {
    const end = Number(new URL(url).searchParams.get('endTime')), k = kline(Math.floor(end / 60_000) * 60_000 - 60_000);
    k[field] = bad as never; if (field === 7) k[10] = '0';
    return [k];
  };
  for (const field of [7, 8] as const) for (const bad of [null, '', false]) {
    const got = await fetchCandles('binance:BTCUSDT', 60_000, T, T + 120_000, broken(field, bad), undefined, 1, { buy: true });
    assert.equal(got.at(-1)!.length, 8, `${field === 7 ? 'quote volume' : 'trades'} ${JSON.stringify(bad)}: none of the three`);
  }
});

test('the strip never borrows another bar: before the rows asked for, a bar is its candle; a bar the recording begins inside without its rows, too', () => {
  const r = rows(), late = { ...r, from: T + 5 * H, bin0: (T + 5 * H) / H, buy: r.buy.slice(5), sell: r.sell.slice(5), gaps: r.gaps.slice(5) };
  const bars = stripBars(candles, H, late, T + 2 * H, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.deepEqual(bars.slice(0, 5).map(b => [b.source, b.buy]), [['candle', 1000], ['candle', 1000], ['candle', 1000], ['candle', 1000], ['candle', 1000]], 'each its own candle, none reading the first bucket of the rows');
  const gapInside = stripBars(candles, H, r, T + 3 * H + 1_800_000, T + 8 * H, T, T + 8 * H, place, () => undefined, false);
  assert.equal(gapInside[3]!.source, 'candle', 'the recording began inside it and its rows hold nothing: the candle');
  const joined = joinRows({ ...r, to: T + 4 * H, buy: r.buy.slice(0, 4), sell: r.sell.slice(0, 4), gaps: r.gaps.slice(0, 4) }, { ...r, from: T + 4 * H, bin0: (T + 4 * H) / H, buy: r.buy.slice(4), sell: r.sell.slice(4), gaps: r.gaps.slice(4) });
  assert.deepEqual([joined.buy.length, joined.total, joined.to, joined.gaps[6]], [8, 2400, T + 8 * H, 'notRecorded'], 'the closed buckets and the one under way, as one');
  const c = { rows: r, tf: H, now: T + 8 * H, market: 'Binance', tfName: '1h', reports: true, total: 2400 };
  assert.ok(stripLines({ t: T, x: 0, w: 1, source: 'candle', buy: 1000, sell: 0, split: false, i: -1, gap: null }, c).some(l => l.text.includes('not loaded yet')), 'Binance: not loaded yet, never does not say');
});
