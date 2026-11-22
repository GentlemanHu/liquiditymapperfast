import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { binanceOiArchive, binanceOiArchiveDay, forgetOiArchive } from '../src/shared/oi-archive.ts';
import { aggregateOi } from '../src/shared/series.ts';

const M = 60_000, H = 3_600_000, D = 24 * H, DAY0 = Date.UTC(2026, 8, 1);
const HEAD = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';

/** A daily archive file as Binance publishes it (the Long/Short tests' fixture): one CSV in a deflated zip, an extra field in its local header. */
function archiveZip(csv: string): Uint8Array {
  const name = Buffer.from('BTCUSDT-metrics.csv'), extra = Buffer.alloc(9), raw = Buffer.from(csv), data = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + extra.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, name, extra, data, dir, name, end]));
}
/** Day d's file: rows 00:00 .. 23:55 in no order, the open interest saying which day and row it is (1000 x days since DAY0 + row). */
const dayFile = (day: number): Uint8Array => archiveZip([HEAD, ...Array.from({ length: 288 }, (_, i) => (i * 97) % 288)
  .map(i => `${new Date(day + i * 5 * M).toISOString().slice(0, 19).replace('T', ' ')},BTCUSDT,${1000 * (day - DAY0) / D + i + 1},1,2.0,3.0,1.5,1.0`)].join('\n'));
const fake = (missing: ReadonlySet<number> = new Set(), fail?: number) => {
  const asked: number[] = [];
  const get = async (url: string): Promise<unknown> => {
    const day = Date.parse(`${/metrics-(\d{4}-\d\d-\d\d)\.zip$/.exec(url)![1]}T00:00:00Z`);
    asked.push(day);
    if (day === fail) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    if (missing.has(day)) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return dayFile(day);
  };
  return { get, asked };
};

test('a day of Binance\'s archive: every reading at the API\'s time (row T read at T + 5 min), oldest first; no file is null', async () => {
  const { get } = fake(new Set([DAY0 + D]));
  const rows = (await binanceOiArchiveDay('BTCUSDT', DAY0, get))!;
  assert.equal(rows.length, 288);
  assert.equal(rows[0]!.sourceTimestamp, DAY0 + 5 * M, 'the 00:00 row is the reading at 00:05');
  assert.equal(rows[0]!.observationTimestamp, DAY0 + 5 * M - 1, 'a reading closes the bar that ends at it');
  assert.equal(rows.at(-1)!.sourceTimestamp, DAY0 + D, 'the 23:55 row is the next midnight\'s reading');
  assert.equal(rows.at(-1)!.base, 288);
  assert.equal(await binanceOiArchiveDay('BTCUSDT', DAY0 + D, get), null);
});

test('a window reads its days newest first, at most the cap, keeps them, and goes on past a day with no file', async () => {
  forgetOiArchive();
  const { get, asked } = fake(new Set([DAY0 + 3 * D]));
  const from = DAY0 + D, to = DAY0 + 6 * D;
  const rows = await binanceOiArchive('BTCUSDT', from, to, get);
  assert.ok(rows.every(r => Number(r.sourceTimestamp) >= from && Number(r.sourceTimestamp) <= to));
  // Daily bars from the readings: each day's bar closes with the next midnight's reading (the day's 23:55 row).
  const daily = aggregateOi(rows, D);
  // The window's first reading (midnight at its start, the day before's last row) closes the day before's bar.
  assert.deepEqual(daily.map(b => [b[0], b[4]]), [[DAY0, 288], [DAY0 + D, 1288], [DAY0 + 2 * D, 2288], [DAY0 + 4 * D, 4288], [DAY0 + 5 * D, 5288]], 'the missing day has no bar');
  const before = asked.length;
  await binanceOiArchive('BTCUSDT', from, to, get);
  assert.equal(asked.length, before, 'kept: nothing asked again');
  forgetOiArchive();
  const capped = fake();
  await binanceOiArchive('BTCUSDT', DAY0, DAY0 + 30 * D, capped.get, 5);
  assert.deepEqual([...new Set(capped.asked)].sort((a, b) => b - a), [29, 28, 27, 26, 25].map(d => DAY0 + d * D), 'the newest five days');
});

test('a day that fails is left out and asked again next time; every day failing throws', async () => {
  forgetOiArchive();
  const one = fake(new Set(), DAY0 + 2 * D);
  const rows = await binanceOiArchive('BTCUSDT', DAY0 + D, DAY0 + 3 * D, one.get);
  assert.ok(rows.length > 0 && rows.every(r => Math.floor((Number(r.sourceTimestamp) - 5 * M) / D) * D !== DAY0 + 2 * D));
  const asked = one.asked.length;
  await binanceOiArchive('BTCUSDT', DAY0 + D, DAY0 + 3 * D, one.get);
  assert.equal(one.asked.length - asked, 1, 'only the failed day is asked again');
  forgetOiArchive();
  const down = { get: async (): Promise<unknown> => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); } };
  await assert.rejects(binanceOiArchive('BTCUSDT', DAY0, DAY0 + 2 * D, down.get), /503/);
});

test('an outage stops the read after its first days: the long view asks again each minute, not the whole window each time', async () => {
  forgetOiArchive();
  let asked = 0;
  const down = async (): Promise<unknown> => { asked++; throw Object.assign(new Error('HTTP 503'), { status: 503 }); };
  await assert.rejects(binanceOiArchive('BTCUSDT', DAY0, DAY0 + 100 * D, down), /503/);
  assert.ok(asked <= 16, `one batch of days, not a hundred (${asked})`);
});
