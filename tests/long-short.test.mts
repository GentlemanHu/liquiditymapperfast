import test from 'node:test';
import assert from 'node:assert/strict';
import { LongShortCache, fetchLongShort, lsPeriodAtLeast, lsPeriodOf, lsReading, parseLsSeries, shareOfRatio } from '../src/shared/long-short.ts';
import { lsAt, lsCardLines, lsRange, stepEnd } from '../src/app/panes/ls-pane.ts';
import { fetchOiHistory, type Fetcher } from '../src/shared/history.ts';
import { LAYOUT_KEYS, readSettings, type CandleRow } from '../src/app/store.ts';
import { atOnePrice } from '../src/app/oi-change.ts';

const M = 60_000, H = 3_600_000, NOW = Date.UTC(2026, 9, 13, 18, 50);

/** A fake venue: answers by the URL's start, and keeps every URL it was asked. */
function fake(answers: Record<string, (url: URL) => unknown>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const get = (async (raw: string) => {
    asked.push(raw);
    const url = new URL(raw), hit = Object.keys(answers).find(prefix => raw.startsWith(prefix));
    if (!hit) throw new Error(`no answer for ${raw}`);
    return answers[hit]!(url);
  }) as Fetcher & { asked: string[] };
  get.asked = asked;
  return get;
}

test('a reading must add up: shares to 1 and the ratio to long over short, within the rounding; never a made-up 50 %', () => {
  assert.deepEqual(lsReading(1, 0.5564, 0.4436, 1.2543), { t: 1, long: 0.5564 }, "Binance's own numbers");
  assert.equal(lsReading(1, 0.6, 0.3), null, 'shares that do not add up to 1');
  assert.equal(lsReading(1, 0.6, 0.4, 2), null, 'a ratio that is not long over short');
  assert.equal(lsReading(1, NaN), null);
  assert.equal(lsReading(1, 1), null, 'all long is not a share a venue gives');
  assert.equal(lsReading(0, 0.5), null, 'no time');
  assert.ok(Math.abs(shareOfRatio(1.25) - 0.5556) < 1e-4, 'L/S 1.25 is 55.6 % long');
});

test("each venue's period: the longest no longer than the candle, five minutes at the finest", () => {
  assert.deepEqual([lsPeriodOf('binance', M), lsPeriodOf('binance', H), lsPeriodOf('bybit', 2 * H), lsPeriodOf('okx', 15 * M), lsPeriodOf('okx', 7 * 24 * H), lsPeriodOf('hyperliquid', H)],
    [5 * M, H, H, 5 * M, 24 * H, null]);
});

test("the venues' answers as they come (measured 2026-10-13): Binance pages back from endTime, Bybit newest first, OKX a ratio, Bitget its 30 periods", async () => {
  const row = (t: number) => ({ symbol: 'BTCUSDT', longAccount: '0.5564', longShortRatio: '1.2543', shortAccount: '0.4436', timestamp: t });
  const get = fake({
    'https://fapi.binance.com/futures/data/globalLongShortAccountRatio': url => {
      const end = Number(url.searchParams.get('endTime'));
      // Two full pages and a short one, oldest first as Binance sends them.
      const n = end > NOW - 1_000 * 5 * M ? 500 : 20;
      return Array.from({ length: n }, (_, i) => row(Math.floor(end / (5 * M)) * 5 * M - (n - 1 - i) * 5 * M));
    },
    'https://api.bybit.com/v5/market/account-ratio': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.594', sellRatio: '0.406', timestamp: String(NOW - 10 * M) }, { buyRatio: '0.5945', sellRatio: '0.4055', timestamp: String(NOW - 15 * M) }] } }),
    'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract': () => ({ code: '0', data: [[String(NOW - 10 * M), '1.2192867221330219'], [String(NOW - 15 * M), 'x']] }),
    'https://api.bitget.com/api/v2/mix/market/account-long-short': () => ({ code: '00000', data: [{ longAccountRatio: '0.6174', shortAccountRatio: '0.3826', longShortAccountRatio: '1.6136', ts: String(NOW - 10 * M) }] }),
  });
  const { points: binance } = await fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, get, NOW);
  assert.ok(binance.length > 500 && binance.every((p, i) => i === 0 || p.t > binance[i - 1]!.t), 'pages joined, oldest first, no repeats');
  assert.equal(get.asked.filter(u => u.includes('binance')).length, 2, 'until a page is short');
  assert.deepEqual((await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.5945, 0.594]);
  const { points: okx } = await fetchLongShort('okx', 'BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW, get, NOW);
  assert.equal(okx.length, 1, 'a ratio that is not a number is left out'); assert.ok(Math.abs(okx[0]!.long - 0.5494) < 1e-3);
  assert.deepEqual((await fetchLongShort('bitget', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.6174]);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW, get, NOW), /no such series/, "only Binance publishes its top traders'");
  // Binance keeps 30 days: nothing older is asked for.
  const old = fake({ 'https://fapi.binance.com/': () => [] });
  await fetchLongShort('binance', 'BTCUSDT', 'topAccounts', H, NOW - 60 * 24 * H, NOW - 40 * 24 * H, old, NOW);
  assert.equal(old.asked.length, 0);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 10001, retMsg: 'bad' }) }), NOW), /bybit/, 'a changed API fails, not empty');
});

test('the cache: one request per series at a time, the newest stretch again at most once a period, OKX server only in a page, failures reported', async () => {
  let now = NOW;
  const get = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 5 * M) }] } }) });
  const cache = new LongShortCache(get, true, () => now);
  const [a, b] = await Promise.all([cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW), cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)]);
  assert.equal(get.asked.length, 1, 'two questions at once share one request');
  assert.deepEqual([a.status, a.population, a.periodMs, a.points.length, b.points.length], ['ok', 'accounts', 5 * M, 1, 1]);
  now += 2 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 1, 'not due yet');
  now += 4 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 2, 'a period later, the newest stretch again');
  assert.equal((await cache.series('okx:BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW)).status, 'serverOnly');
  assert.equal((await cache.series('hyperliquid:BTC', 'accounts', 5 * M, NOW - H, NOW)).status, 'unsupported');
  const broken = new LongShortCache(fake({}), false, () => now);
  const failed = await broken.series('binance:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW);
  assert.deepEqual([failed.status, failed.population, failed.points], ['failed', 'topPositions', []]);
});

test('over the wire: a series of the wrong shape is an error, a reading out of range or order is dropped', () => {
  assert.throws(() => parseLsSeries({ id: 'x', status: 'great', population: null, periodMs: 0, points: [] }));
  const s = parseLsSeries({ id: 'binance:BTCUSDT', population: 'accounts', periodMs: 300_000, status: 'ok', points: [{ t: 2, long: 0.55 }, { t: 1, long: 0.56 }, { t: 3, long: 1.2 }, { t: 4, long: 0.57 }] });
  assert.deepEqual(s.points, [{ t: 2, long: 0.55 }, { t: 4, long: 0.57 }]);
});

test('a reading holds until the next, and for three periods after the newest; nothing before the first', () => {
  const points = [{ t: 0, long: 0.55 }, { t: 5 * M, long: 0.56 }];
  assert.deepEqual([lsAt(points, -1, 5 * M), lsAt(points, 3 * M, 5 * M)?.long, lsAt(points, 19 * M, 5 * M)?.long, lsAt(points, 20 * M, 5 * M)], [null, 0.55, 0.56, null]);
});

test('the Binance series is a saved setting and a layout setting: only the three it publishes, all accounts by default; the pane is off by default', () => {
  assert.deepEqual([readSettings({}).lsMetric, readSettings({ lsMetric: 'topPositions' }).lsMetric, readSettings({ lsMetric: 'whales' }).lsMetric], ['accounts', 'topPositions', 'accounts']);
  assert.equal(readSettings({}).show.ls, false);
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('lsMetric'));
});

test("Binance's top-trader choice is Binance's alone: the other venues still read their accounts", async () => {
  const get = fake({
    'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 5 * M) }] } }),
    'https://fapi.binance.com/futures/data/topLongShortPositionRatio': () => [{ longAccount: '0.61', shortAccount: '0.39', longShortRatio: '1.5641', timestamp: NOW - 5 * M }],
  });
  const cache = new LongShortCache(get, true, () => NOW);
  const bybit = await cache.series('bybit:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW), binance = await cache.series('binance:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW);
  assert.deepEqual([bybit.status, bybit.population, binance.status, binance.population], ['ok', 'accounts', 'ok', 'topPositions']);
});

test('open-interest history that answers an error fails, so the sampler tries again, instead of reading as none', async () => {
  const listing = { symbol: 'BTCUSDT', unit: 1 };
  await assert.rejects(fetchOiHistory('bybit:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 10006, retMsg: 'Too many visits' }) }), listing), /bybit/);
  await assert.rejects(fetchOiHistory('okx:BTC-USDT-SWAP', H, NOW - 24 * H, NOW, fake({ 'https://www.okx.com/': () => ({ code: '50011', msg: 'Too Many Requests', data: [] }) }), { symbol: 'BTC-USDT-SWAP', unit: 1 }), /okx/);
  await assert.rejects(fetchOiHistory('binance:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://fapi.binance.com/': () => ({ code: -1003, msg: 'Too many requests' }) }), listing), /binance/);
  assert.deepEqual(await fetchOiHistory('bybit:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [] } }) }), listing), [], 'an empty list is none');
});

test('a question for an older window asked while a newer one is read gets its window too, after waiting its turn', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const get = fake({ 'https://api.bybit.com/': async url => {
    const end = Number(url.searchParams.get('endTime'));
    if (end > NOW - H) await gate;
    // Five-minute readings, newest first, for the 24 periods (two hours) before `endTime`: a request for the newest stretch does not reach the older window.
    return { retCode: 0, result: { list: Array.from({ length: 24 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, true, () => NOW);
  const newer = cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  const older = cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 3 * H, NOW - 2 * H);
  release();
  const [a, b] = await Promise.all([newer, older]);
  assert.equal(a.status, 'ok');
  assert.deepEqual([b.status, b.points.length > 0], ['ok', true], 'the older window was read once the newer request was answered');
});

test('the scale and the readout follow the steps as drawn: a reading holds until the next, and past the newest the newest stands', () => {
  const s = { points: [{ t: 0, long: 0.6 }, { t: 15 * M, long: 0.62 }], periodMs: 5 * M };
  assert.deepEqual([stepEnd(s, 0), stepEnd(s, 1)], [15 * M, 20 * M], 'the first holds until the second (within three periods), the last one period');
});

test('a long window held only as far as its pages reached; a pane shown again after a pause reads the readings it missed', async () => {
  // A venue with a full page for every question: twelve pages of five-minute readings reach about 21 days back.
  const full = (end: number) => ({ retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } });
  const deep = await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 29 * 24 * H, NOW, fake({ 'https://api.bybit.com/': url => full(Number(url.searchParams.get('endTime'))) }), NOW);
  assert.ok(deep.from > NOW - 22 * 24 * H && deep.from < NOW - 20 * 24 * H, 'it says where its pages stopped');
  let now = NOW;
  const get = fake({ 'https://api.bybit.com/': url => { const end = Number(url.searchParams.get('endTime')); return { retCode: 0, result: { list: Array.from({ length: 30 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.min(Math.floor(end / (5 * M)), Math.floor(now / (5 * M))) * 5 * M - (i + 1) * 5 * M) })) } }; } });
  const cache = new LongShortCache(get, true, () => now);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  now = NOW + H; // the pane was hidden for an hour
  const after = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW + 50 * M, NOW + H);
  const gap = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW, NOW + H);
  assert.equal(after.status, 'ok');
  assert.ok(gap.points.some(p => p.t === NOW + 30 * M), 'the readings of the hour it was hidden are held');
});

test("the one price for an inverse market's coins can be the Range selection's own", () => {
  const candles: CandleRow[] = [[0, 0, 0, 0, 50_000, 0], [H, 0, 0, 0, 100_000, 0]];
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], candles, 50_000).map(b => b[4]), [20]);
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], candles).map(b => b[4]), [10]);
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], [], 50_000).map(b => b[4]), [20], 'no candles to convert by: as they are');
});

test('a window older than the cache holds gets its readings, and a changed answer fails rather than reading as empty', async () => {
  const full = (end: number) => ({ retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } });
  const cache = new LongShortCache(fake({ 'https://api.bybit.com/': url => full(Number(url.searchParams.get('endTime'))) }), false, () => NOW);
  const old = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW - 39 * 24 * H);
  assert.deepEqual([old.status, old.points.length], ['ok', 289], 'forty days back: a day of five-minute readings and the one before it, which holds at its start');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'ok', 'and the newest after it');
  const changed = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', time: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, changed, NOW), /unknown shape/);
});

test('a refresh that fails after a good answer says so, with the readings held from before', async () => {
  let now = NOW, failing = false;
  const get = fake({ 'https://api.bybit.com/': () => { if (failing) throw new Error('HTTP 503'); return { retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 10 * M) }] } }; } });
  const cache = new LongShortCache(get, true, () => now);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW + H)).status, 'ok');
  failing = true; now += 6 * M;
  const after = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW + H);
  assert.deepEqual([after.status, after.points.length], ['stale', 1]);
  assert.equal(parseLsSeries(after).status, 'stale', 'and the wire carries it');
});

test('a long window on a fine chart takes a coarser period: one question reaches across it and the series keeps all of it', async () => {
  const full = (url: URL) => { const end = Number(url.searchParams.get('endTime')), p = url.searchParams.get('period') === '1d' ? 24 * H : url.searchParams.get('period') === '1h' ? H : url.searchParams.get('period') === '30min' ? 30 * M : 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / p) * p - (i + 1) * p) })) } }; };
  const get = fake({ 'https://api.bybit.com/': full });
  const cache = new LongShortCache(get, false, () => NOW);
  const month = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW);
  assert.deepEqual([month.status, month.periodMs], ['ok', 24 * H], 'forty days use daily readings instead of 1,920 half-hourly readings');
  assert.ok(month.points[0]!.t <= NOW - 40 * 24 * H + 24 * H && month.points.length >= 40 && month.points.length <= 42, 'the whole daily window, oldest included');
  assert.equal(get.asked.length, 1, 'the history arrives in one page');
  assert.ok(Number(new URL(get.asked[0]!).searchParams.get('limit')) <= 42, 'only the daily readings needed are requested');
  const asked = get.asked.length;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW);
  assert.equal(get.asked.length, asked, 'asked again at once: nothing more to read');
  assert.equal(lsPeriodAtLeast('bybit', 28.8 * M), 30 * M);
});

test('a good answer after a failure clears it: readings read back after a failed try are not called stale', async () => {
  let now = NOW, failOlder = true;
  const get = fake({ 'https://api.bybit.com/': url => {
    const end = Number(url.searchParams.get('endTime'));
    if (end < NOW - 30 * M && failOlder) throw new Error('HTTP 503');
    return { retCode: 0, result: { list: Array.from({ length: 60 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'ok');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 4 * H, NOW - 3 * H)).status, 'failed');
  failOlder = false; now += 61_000;
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 4 * H, NOW - 3 * H)).status, 'ok');
});

test('a page that never answers fails its request at the deadline, so the series is never stuck: the questions after it are answered', async () => {
  // On the live server two series' one request never settled (2026-10-15): every later question for Bybit's and OKX's hourly BTC readings waited for good.
  let now = NOW, hang = true;
  const asked: string[] = [];
  const get: Fetcher = async raw => {
    asked.push(raw);
    if (hang) return new Promise<never>(() => {});
    return { retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 2 * H) }] } };
  };
  const cache = new LongShortCache(get, false, () => now, 48, 10_000, 30);
  const started = Date.now();
  const [a, b] = await Promise.all([cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H), cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H)]);
  assert.deepEqual([a.status, b.status, asked.length], ['failed', 'failed', 1], 'both questions answered, one request');
  assert.ok(Date.now() - started < 2_000, 'at the deadline, not never');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H)).status, 'failed', 'within a minute of the failure: answered at once');
  assert.equal(asked.length, 1);
  hang = false; now += 61_000;
  const after = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  assert.deepEqual([after.status, after.points.length, asked.length], ['ok', 1, 2], 'a minute on, read again');
});

test('a window inside the period under way is held: asked again at once, the venue is not', async () => {
  const get = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(NOW / H) * H - H) }] } }) });
  const cache = new LongShortCache(get, false, () => NOW);
  // A chart zoomed in on the last minutes: the window asked begins inside the hour under way.
  const from = Math.floor(NOW / H) * H;
  await cache.series('bybit:BTCUSDT', 'accounts', H, from, NOW + H);
  const first = get.asked.length;
  assert.equal(first, 1, 'one request for the first question');
  await Promise.all([1, 2, 3].map(() => cache.series('bybit:BTCUSDT', 'accounts', H, from, NOW + H)));
  assert.equal(get.asked.length, first, 'none for the next ones (each asked the venue again, twice, before)');
});

test('a reading published after an empty stretch was held is read by the next refresh, also for a window reaching back from it', async () => {
  // Hourly readings, each published once its hour is over; it is 18:50.
  let now = Date.UTC(2026, 9, 13, 18, 50);
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - H) / H) * H;
    return { retCode: 0, result: { list: Array.from({ length: 48 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * H) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 13, h, m);
  await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  const back = await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 30), at(18, 40));
  assert.ok(!back.points.some(p => p.t === at(18)), 'the 18:00 reading is not out yet');
  const asked = get.asked.length;
  now = at(19, 51);
  const later = await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 30), at(18, 40));
  assert.ok(later.points.some(p => p.t === at(18)), 'an hour on, the 18:00 reading is read and given');
  assert.ok(get.asked.length > asked);
});

test('a window inside or after the period under way claims nothing before it: a window reaching back from it reads what it needs', async () => {
  const now = Date.UTC(2026, 9, 13, 18, 50);
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 13, h, m);
  const venue = () => fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - H) / H) * H;
    return { retCode: 0, result: { list: Array.from({ length: 48 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * H) })) } };
  } });
  // A chart zoomed in on the live edge, then one a little further back: the 17:00 reading holds into its window.
  const live = new LongShortCache(venue(), false, () => now);
  await live.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  assert.ok((await live.series('bybit:BTCUSDT', 'accounts', H, at(17, 55), at(18, 50))).points.some(p => p.t === at(17)));
  // A view in the future (nothing to read), then one before it.
  const ahead = new LongShortCache(venue(), false, () => now);
  await ahead.series('bybit:BTCUSDT', 'accounts', H, at(20), at(21));
  assert.ok((await ahead.series('bybit:BTCUSDT', 'accounts', H, at(17, 55), at(18, 40))).points.some(p => p.t === at(17)));
  // Asked again, neither goes back to the venue.
  const get = venue(), again = new LongShortCache(get, false, () => now);
  await again.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  const asked = get.asked.length;
  await again.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  await again.series('bybit:BTCUSDT', 'accounts', H, at(20), at(21));
  assert.equal(get.asked.length, asked);
});

test('five questions at once for different windows each get their own window read', async () => {
  // Five-minute readings for years, full pages of 500 (about 42 hours) back from endTime, each answered a little later: every window two
  // days further back needs a request of its own.
  const get = fake({ 'https://api.bybit.com/': async url => {
    await new Promise(r => setTimeout(r, 2));
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW - 5 * M) / (5 * M)) * 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => NOW), D = 24 * H;
  const windows = [0, 2, 4, 6, 8].map(k => ({ from: NOW - (k + 1) * D, to: NOW - k * D }));
  const answers = await Promise.all(windows.map(w => cache.series('bybit:BTCUSDT', 'accounts', 5 * M, w.from, w.to)));
  answers.forEach((a, i) => assert.ok(a.status === 'ok' && a.points.some(p => p.t >= windows[i]!.from && p.t < windows[i]!.to), `window ${i + 1} read (it was answered empty without being read)`));
  // Past what a question waits for (64 requests), a window not read says it could not be read: never "no readings".
  const many = new LongShortCache(get, false, () => NOW);
  const far = Array.from({ length: 70 }, (_, k) => ({ from: NOW - (2 * k + 1) * D, to: NOW - 2 * k * D }));
  const got = await Promise.all(far.map(w => many.series('bybit:BTCUSDT', 'accounts', 5 * M, w.from, w.to)));
  assert.ok(got.every((a, i) => a.status === 'failed' || (a.status === 'ok' && a.points.some(p => p.t >= far[i]!.from && p.t < far[i]!.to))), 'read, or said to be unread');
  assert.ok(got.some(a => a.status === 'failed') && !got.some(a => a.status === 'empty'));
});

test('the pane draws nothing, and says why, when no step of the readings held is in view', () => {
  const s = { points: [{ t: 0, long: 0.6 }, { t: H, long: 0.62 }], periodMs: H };
  assert.deepEqual(lsRange([s], 0, 30 * M), { lo: 0.6, hi: 0.6 });
  assert.deepEqual(lsRange([s], 30 * M, 3 * H), { lo: 0.6, hi: 0.62 }, 'a step that began before the view and holds into it counts');
  assert.equal(lsRange([s], 10 * H, 20 * H), null, 'readings held for another time');
  assert.equal(lsRange([], 0, H), null);
});

test('a window that ended a little before the live edge is read on at once for one that reaches past it, not a period later', async () => {
  // Five-minute readings, each published once its five minutes are over; it is 18:51.
  const now = Date.UTC(2026, 9, 13, 18, 51), at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 13, h, m, s);
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - 5 * M) / (5 * M)) * 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 60 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(17, 50), at(18, 42, 30));
  const next = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(18, 46), at(18, 49));
  assert.ok(next.points.some(p => p.t === at(18, 45)), 'the 18:45 reading, out since 18:50, is given (it was "empty" until the next period)');
  const asked = get.asked.length;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(18, 46), at(18, 56));
  assert.equal(get.asked.length, asked, 'at the live edge, once a period still');
});

test('an answer that lost a field its readings are checked with fails as a changed API, rather than reading as none', async () => {
  const bybit = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRat: '0.4', timestamp: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, bybit, NOW), /unknown shape/);
  const binance = fake({ 'https://fapi.binance.com/': () => [{ longAccount: '0.6', shortAccount: '0.4', ratio: '1.5', timestamp: NOW - 5 * M }] });
  await assert.rejects(fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, binance, NOW), /unknown shape/);
  const bitget = fake({ 'https://api.bitget.com/': () => ({ code: '00000', data: [{ longAccountRatio: '0.6', longShortAccountRatio: '1.5', ts: String(NOW - 5 * M) }] }) });
  await assert.rejects(fetchLongShort('bitget', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, bitget, NOW), /unknown shape/);
});

test('a reading with no valid time in a full page does not end the paging: the older pages are still read', async () => {
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW) / (5 * M)) * 5 * M - 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: i === 250 ? '0' : String(last - i * 5 * M) })) } };
  } });
  const { points } = await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, get, NOW);
  assert.ok(points[0]!.t < NOW - 2 * 24 * H, 'the readings of the third day back were read (paging stopped at the bad row before)');
  const timeless = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: Array.from({ length: 500 }, () => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: 'x' })) } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, timeless, NOW), /no reading time/, 'a full page that cannot be paged on fails');
});

test('a read on past what is held whose pages run out before it leaves the hole unclaimed: a window in it is read', async () => {
  // Five-minute readings, 500 a page of which the oldest 100 carry no valid time: twelve pages reach about 16.7 days back.
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW) / (5 * M)) * 5 * M - 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: i >= 400 ? 'x' : String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => NOW), D = 24 * H;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 18 * D, NOW - 17.5 * D);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - D, NOW + 5 * M);
  const hole = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 17.4 * D, NOW - 17 * D);
  assert.deepEqual([hole.status, hole.points.some(p => p.t >= NOW - 17.4 * D && p.t < NOW - 17 * D)], ['ok', true], 'read (it answered "empty", the hole claimed as held)');
});

test('a failure pauses the series for a minute from when it failed, however long its pages took', async () => {
  let now = NOW, calls = 0;
  // Each page takes a minute and a quarter of the clock, and the second never answers.
  const get: Fetcher = async () => { calls++; now += 75_000; if (calls > 1) return new Promise<never>(() => {}); return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - (i + 1) * 5 * M) })) } }; };
  const cache = new LongShortCache(get, false, () => now, 48, 10_000, 30);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW)).status, 'failed');
  assert.equal(calls, 2, 'one request of two pages, not asked again at once though it began more than a minute before it failed');
});

test("the chart's period only where it fits the window, and an answer that lost its share fields fails", async () => {
  const get = fake({ 'https://www.okx.com/': url => ({ code: '0', data: Array.from({ length: 100 }, (_, i) => [String(Number(url.searchParams.get('end')) - (i + 1) * (url.searchParams.get('period') === '1H' ? H : 5 * M)), '1.2']) }) });
  const okx = await new LongShortCache(get, false, () => NOW).series('okx:BTC-USDT-SWAP', 'accounts', 30 * M, NOW - 15 * 24 * H, NOW);
  assert.equal(okx.periodMs, H, 'fifteen days on OKX: hourly (its five-minute readings would be 4,320, past what a question reaches)');
  const renamed = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ longShare: '0.6', timestamp: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, renamed, NOW), /unknown shape/);
});

test('a coin-margined market is read where its venue publishes it: Binance COIN-M by its pair, Bybit inverse by its category', async () => {
  const t = NOW - 10 * M;
  const get = fake({
    'https://dapi.binance.com/futures/data/topLongShortPositionRatio': () => [{ pair: 'BTCUSD', longPosition: '0.6811', shortPosition: '0.3189', longShortRatio: '2.1358', timestamp: t }],
    'https://api.bybit.com/v5/market/account-ratio': url => ({ retCode: 0, result: { list: url.searchParams.get('category') === 'inverse' ? [{ symbol: 'BTCUSD', buyRatio: '0.6547', sellRatio: '0.3453', timestamp: String(t) }] : [] } }),
  });
  const binance = await fetchLongShort('binance', 'BTCUSD_PERP', 'topPositions', 5 * M, t - H, t + M, get, NOW);
  assert.deepEqual(binance.points, [{ t, long: 0.6811 }]);
  assert.equal(new URL(get.asked[0]!).searchParams.get('pair'), 'BTCUSD');
  const bybit = await fetchLongShort('bybit', 'BTCUSD', 'accounts', 5 * M, t - H, t + M, get, NOW);
  assert.deepEqual(bybit.points, [{ t, long: 0.6547 }]);
});

test('the popup explains a ratio by who it counts: accounts, or the top traders\x27 position size', async () => {

  const point = [{ t: NOW - 5 * M, long: 0.6 }];
  const text = (series: Parameters<typeof lsCardLines>[0]) => lsCardLines(series, NOW, '5m').map(l => l.text).join('\n');
  const positions = text([{ id: 'binance:BTCUSDT', population: 'topPositions', periodMs: 5 * M, points: point, status: 'ok' }]);
  assert.match(positions, /position size/); assert.doesNotMatch(positions, /long accounts for each short one/);
  const accounts = text([{ id: 'bybit:BTCUSDT', population: 'accounts', periodMs: 5 * M, points: point, status: 'ok' }]);
  assert.match(accounts, /long accounts for each short one/); assert.doesNotMatch(accounts, /position size/);
});
