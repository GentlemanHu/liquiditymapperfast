import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { normalizeBinanceOpenInterestHistory } from '../src/adapters/binance.mts';
import { aggregateOi, withLiveOi, type OiRow } from '../src/shared/series.ts';

const MIN = 60_000, FIVE = 5 * MIN, HOUR = 3_600_000;
// An hour boundary six hours back: inside the store's retention, and every reading is in the past.
const t0 = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR;
const oiAt = (t: number): number => 1_000 + (t - t0) / MIN; // open interest rising one coin a minute

/** What `/api/v2/oi` answers for one market (`oiBarsOf` in `server/v2/api.mts`): the stored bars and the live samples. */
function serverBars(app: ReturnType<typeof createLocalServer>, history: HistoryStore, id: string, tfMs: number): ReturnType<typeof aggregateOi> {
  const stored = history.listOi(id, { from: 0, to: Date.now() + HOUR, limit: 300_000 }) as OiRow[];
  const live = (app.state.oi ?? []).filter(s => s.instrumentId === id) as OiRow[];
  return aggregateOi(withLiveOi(stored, live), tfMs);
}

test("the feed manager's Binance history closes the bar that ends at each reading on the server too, not the bar after it", async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ filePath: ':memory:' }), history });
  try {
    const stamps = Array.from({ length: 25 }, (_, k) => t0 + k * FIVE); // two hours of five-minute rows
    const payload = stamps.map(t => ({ symbol: 'BTCUSDT', sumOpenInterest: String(oiAt(t)), sumOpenInterestValue: '1', timestamp: t }));
    const rows = normalizeBinanceOpenInterestHistory(payload, { receivedAt: Date.now() });
    for (const row of rows) app.applyMessage(row, 'binance');
    history.flushOiBars();
    const id = rows[0]!.instrumentId;
    for (const tf of [FIVE, 15 * MIN, HOUR]) {
      // Until 2026-11-10 the reducer set every sample's observation to its source time: each bar closed one reading (five minutes) early.
      const off = serverBars(app, history, id, tf).filter(b => b[0] >= t0 && b[0] + tf <= stamps.at(-1)!).map(b => b[4] - oiAt(b[0] + tf));
      assert.ok(off.length > 0, `bars at ${tf / MIN}m`);
      assert.deepEqual(off, off.map(() => 0), `each ${tf / MIN}m bar closes with the open interest at its end`);
    }
  } finally { await app.close(); }
});

test('a history reading fills only a minute no live sample is in, so another source a few coins off never replaces the live close', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ filePath: ':memory:' }), history });
  try {
    const id = 'binance:BTCUSDT', live = t0 + HOUR, end = live + HOUR;
    // Live samples every 5 s from `live` on, flat at 1000; the history reads 6 coins higher, every five minutes over the whole stretch.
    for (let t = live; t < end; t += 5_000) app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: t, receivedAt: t, base: 1_000, quality: 'native' }, 'binance');
    const payload = Array.from({ length: 25 }, (_, k) => t0 + k * FIVE).map(t => ({ symbol: 'BTCUSDT', sumOpenInterest: '1006', sumOpenInterestValue: '1', timestamp: t }));
    for (const row of normalizeBinanceOpenInterestHistory(payload, { receivedAt: Date.now() })) app.applyMessage(row, 'binance');
    history.flushOiBars();
    const stored = history.listOi(id, { from: 0, to: end + HOUR, limit: 10_000 }) as { start: number; close: number }[];
    const at = (t: number): number | undefined => stored.find(b => b.start === t)?.close;
    assert.equal(at(live + 4 * MIN), 1_000, 'the live minute keeps its live close where a reading at its end would have replaced it');
    assert.equal(at(live + 9 * MIN), 1_000);
    assert.equal(at(end - MIN), 1_000, 'the newest minute too, still waiting to be written when the reading at its end came');
    assert.equal(at(t0 + 4 * MIN), 1_006, 'before the live samples began the reading fills its minute');
    const minutes = serverBars(app, history, id, MIN).filter(b => b[0] >= live && b[0] < end);
    assert.equal(minutes.length, 60);
    assert.ok(minutes.every(b => b[4] === 1_000), 'the one-minute series is flat wherever it was recorded live: no rise and fall at each reading');
  } finally { await app.close(); }
});

test('a REST-only venue\'s read of a minute\'s close is filed in that minute when its answer comes after the minute ended (oi-close.ts)', async () => {
  // 2026-11-23: a reading filed at its arrival closed the minute it arrived in, so a close asked at second 57 and answered after the minute's end
  // would close the next minute; the sampler says which minute it closes (`closeOf`) and the reducer files it there.
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ filePath: ':memory:' }), history });
  try {
    const id = 'bitget:BTCUSDT', m = t0 + 30 * MIN;
    const sample = (receivedAt: number, base: number, closeOf?: number) => app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt, base, quality: 'sampled', ...(closeOf !== undefined ? { closeOf } : {}) }, 'bitget');
    sample(m - MIN + 57_300, 1_000, m - MIN);
    sample(m + 60_700, 1_200, m); // the close of m, answered 0.7 s after m ended
    sample(m + 2 * MIN + 57_200, 1_250, m + 2 * MIN); // m+1's close was missed: nothing in m+1
    sample(m + 3 * MIN + 30_000, 1_300); // no closeOf: at its arrival
    sample(m + 5 * MIN + 1_000, 1_400, m + 3 * MIN); // a closeOf two minutes stale is not taken: at its arrival
    // A reading its venue stamps is filed at the stamp, closeOf or not (it says when the figure was set), and so is any reading not sampled.
    app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: m + 7 * MIN + 2_000, receivedAt: m + 7 * MIN + 2_500, base: 1_500, quality: 'sampled', closeOf: m + 6 * MIN }, 'bitget');
    app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt: m + 9 * MIN + 1_000, base: 1_600, quality: 'native', closeOf: m + 8 * MIN }, 'bitget');
    // A first read asked at :55 answers after the minute ended, then the close queued behind it: both are filed in their minute, the close a
    // millisecond after the first read, so it is the minute's close (`close: false` on the first; they tied, Sol 6.2 round 2).
    app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt: m + 11 * MIN + 1_000, base: 1_700, quality: 'sampled', closeOf: m + 10 * MIN, close: false }, 'bitget');
    app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: null, receivedAt: m + 11 * MIN + 2_000, base: 1_750, quality: 'sampled', closeOf: m + 10 * MIN, close: true }, 'bitget');
    history.flushOiBars();
    const bars = serverBars(app, history, id, MIN).filter(b => b[0] >= m - MIN);
    assert.deepEqual(bars.map(b => [(b[0] - m) / MIN, b[4]]), [[-1, 1_000], [0, 1_200], [2, 1_250], [3, 1_300], [5, 1_400], [7, 1_500], [9, 1_600], [10, 1_750]]);
    const stored = (history.listOi(id, { from: m + 10 * MIN, to: m + 11 * MIN, limit: 10 }) as OiRow[]).map(r => Number(r.close));
    assert.deepEqual(stored, [1_750], 'the store keeps the close too');
    const observed = (app.state.oi ?? []).filter(s => s.instrumentId === id).map(s => Number(s.observationTimestamp) - m);
    assert.deepEqual(observed, [-MIN + 57_300, MIN - 1, 2 * MIN + 57_200, 3 * MIN + 30_000, 5 * MIN + 1_000, 7 * MIN + 2_000, 9 * MIN + 1_000, 11 * MIN - 2, 11 * MIN - 1]);
  } finally { await app.close(); }
});
