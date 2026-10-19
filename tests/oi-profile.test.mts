import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { FootprintRecorder } from '../src/shared/footprint.ts';
import { inverseOiId, oiInstrument, oiIntervals, oiProfileOf, parseOiProfile } from '../src/shared/oi-profile.ts';
import type { OiBar } from '../src/shared/series.ts';

const T0 = 1_800_000_000_000, MIN = 60_000;
/** A bar of one reading: [minute, open, high, low, close] all at `oi`. */
const bar = (minute: number, oi: number): OiBar => [T0 + minute * MIN, oi, oi, oi, oi];

/** A recorder with trades of `id` at these [minute, price, usd]. */
function recorderWith(trades: [string, number, number, number][]): FootprintRecorder {
  const recorder = new FootprintRecorder(null, () => T0 + 120 * MIN);
  recorder.ingest(trades.map(([id, minute, price, usd], i) => ({ instrumentId: id, tradeId: `${id}${i}`, side: i % 2 ? 'sell' : 'buy', price, notionalUsd: usd, sourceTimestamp: T0 + minute * MIN + 1_000 + i })));
  return recorder;
}

test('a change between two readings came about in the minutes after the first up to the end of the second; a flat open interest is no change', () => {
  const { intervals, skipped } = oiIntervals([bar(0, 100), bar(1, 100), bar(2, 104), bar(7, 101)], T0, T0 + 10 * MIN);
  assert.deepEqual(intervals, [{ from: T0 + 2 * MIN, to: T0 + 3 * MIN, amount: 4 }, { from: T0 + 3 * MIN, to: T0 + 8 * MIN, amount: -3 }]);
  assert.equal(skipped, 0);
  assert.deepEqual(oiIntervals([bar(0, 100), bar(1, 100), bar(2, 100)], T0, T0 + 10 * MIN).intervals, [], 'the price moving while the level stays is nothing');
});

test('a change across a gap or past the window is not placed: it is what is skipped', () => {
  const gap = oiIntervals([bar(0, 100), bar(90, 130)], T0, T0 + 120 * MIN);
  assert.deepEqual(gap.intervals, []); assert.equal(gap.skipped, 30, 'readings 90 minutes apart: no one change to spread');
  const edge = oiIntervals([bar(0, 100), bar(2, 110), bar(3, 115)], T0 + 2 * MIN, T0 + 10 * MIN);
  assert.deepEqual(edge.intervals, [{ from: T0 + 3 * MIN, to: T0 + 4 * MIN, amount: 5 }]);
  assert.equal(edge.skipped, 10, 'the change into the window from before it reaches past its start');
});

test('spreading puts each change over the prices that traded in its minutes and makes or loses nothing', () => {
  const recorder = recorderWith([['x:BTC', 2, 80_005, 3_000], ['x:BTC', 2, 80_105, 1_000], ['x:BTC', 4, 80_205, 2_000]]);
  const fine = recorder.step('x:BTC')!;
  const usd = recorder.spread('x:BTC', 100, [{ from: T0 + 2 * MIN, to: T0 + 3 * MIN, amount: 400 }, { from: T0 + 4 * MIN, to: T0 + 5 * MIN, amount: -50 }, { from: T0 + 6 * MIN, to: T0 + 7 * MIN, amount: 7 }], false, 0);
  const up = usd.rows.reduce((a, r) => a + r[1], 0), down = usd.rows.reduce((a, r) => a + r[2], 0);
  assert.ok(Math.abs(up - down + usd.unplaced - (400 - 50 + 7)) < 1e-9, 'increases − decreases + unplaced = the changes');
  assert.equal(usd.unplaced, 7, 'a change whose minutes traded nothing is not placed');
  assert.deepEqual(usd.rows.map(r => [r[0], Math.round(r[1]), Math.round(r[2])]), [[80_000, 300, 0], [80_100, 100, 0], [80_200, 0, 50]], 'by each price\'s share of the volume');
  // In coins each part is valued at its own row's price.
  const coins = recorder.spread('x:BTC', 100, [{ from: T0 + 2 * MIN, to: T0 + 3 * MIN, amount: 4 }], true, 80_000);
  const row = coins.rows.find(r => r[0] === 80_000)!;
  assert.ok(Math.abs(row[1] - 4 * 0.75 * (Math.floor(80_005 / fine) + 0.5) * fine) < 1e-6);
});

test('each venue is spread on its own: an increase on one and a decrease on the other both show though the total did not move', () => {
  const recorder = recorderWith([['binance:BTCUSDT', 2, 80_005, 1_000], ['bybit:BTCUSDT', 2, 80_005, 1_000]]);
  const answer = oiProfileOf(recorder, [
    { id: 'binance:BTCUSDT', coins: false, price: 80_000, bars: [bar(1, 1_000), bar(2, 1_100)] },
    { id: 'bybit:BTCUSDT', coins: false, price: 80_000, bars: [bar(1, 900), bar(2, 800)] },
  ], T0, T0 + 10 * MIN, 100);
  const rows = Object.fromEntries(answer.instruments.map(i => [i.id, i.rows]));
  assert.deepEqual(rows['binance:BTCUSDT'], [[80_000, 100, 0]]);
  assert.deepEqual(rows['bybit:BTCUSDT'], [[80_000, 0, 100]]);
  assert.equal(answer.unplaced, 0);
  assert.deepEqual(parseOiProfile(JSON.parse(JSON.stringify(answer)), ['binance:BTCUSDT', 'bybit:BTCUSDT']), answer, 'it survives the wire');
});

test('the server answers the change by price from its stored readings and its footprint, and refuses what it cannot answer', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ history, quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, now = Math.floor(Date.now() / MIN) * MIN, id = 'binance:BTCUSDT';
    // Readings a minute apart: +10 coins into minute -9, then −4 into minute -8; trades in those minutes at two prices.
    for (const [minute, base] of [[-11, 1_000], [-10, 1_000], [-9, 1_010], [-8, 1_006]] as const) history.recordOi({ kind: 'openInterest', instrumentId: id, sourceTimestamp: now + minute * MIN + 30_000, receivedAt: now + minute * MIN + 30_000, base, quality: 'native' });
    v2.footprint.ingest([
      { instrumentId: id, tradeId: '1', side: 'buy', price: 80_005, notionalUsd: 30_000, sourceTimestamp: now - 9 * MIN + 1_000 },
      { instrumentId: id, tradeId: '2', side: 'sell', price: 80_105, notionalUsd: 10_000, sourceTimestamp: now - 9 * MIN + 2_000 },
      { instrumentId: id, tradeId: '3', side: 'sell', price: 80_205, notionalUsd: 5_000, sourceTimestamp: now - 8 * MIN + 1_000 },
    ]);
    const r = await fetch(`${base}/api/v2/oi-profile?inst=${id},coinbase:BTC-USD&from=${now - 30 * MIN}&to=${now}&step=100`);
    assert.equal(r.status, 200);
    const answer = parseOiProfile(await r.json(), [id, 'coinbase:BTC-USD'])!;
    assert.deepEqual(answer.instruments.map(i => i.id), [id], 'only the perpetual: a spot market has no open interest');
    const rows = answer.instruments[0]!.rows.map(([price, up, down]) => [price, Math.round(up / 1_000), Math.round(down / 1_000)]);
    // 10 coins three to one over 80,0xx and 80,1xx, valued at each row's price; 4 coins all at 80,2xx.
    assert.deepEqual(rows, [[80_000, 600, 0], [80_100, 200, 0], [80_200, 0, 321]]);
    assert.equal(answer.unplaced, 0);
    const refuse = async (query: string) => { const x = await fetch(`${base}/api/v2/oi-profile?${query}`); assert.equal(x.status, 400, query); };
    await refuse(`inst=${id}&from=${now - MIN}&to=${now}&step=0`); await refuse(`from=${now - MIN}&to=${now}&step=100`); await refuse(`inst=${id}&from=0&to=${9 * 86_400_000}&step=100`);
  } finally { v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
});

test('which markets have an open interest, and which count it in USD', () => {
  assert.equal(oiInstrument('binance:BTCUSDT'), true);
  assert.equal(oiInstrument('hyperliquid:BTC-PERP'), true);
  assert.equal(oiInstrument('binance:BTCUSDT:spot'), false, 'a spot market of a perpetual venue has none');
  assert.equal(oiInstrument('coinbase:BTC-USD'), false);
  assert.equal(inverseOiId('deribit:BTC-PERPETUAL'), true);
  assert.equal(inverseOiId('deribit:BTC_USDC-PERPETUAL'), false);
  assert.equal(inverseOiId('bybit:BTCUSD'), true);
  assert.equal(inverseOiId('bybit:BTCUSDT'), false);
});
