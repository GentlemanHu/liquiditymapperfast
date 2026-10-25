import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { decodeLt, frameType, type LtFrame } from '../src/app/wire.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';

test('the live socket speaks every heartbeat even when nothing else changes, so a client can tell a quiet server from a dead connection', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20, heartbeatMs: 120 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const beats: number[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try { const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as { t?: string }; if (message.t === 'hb') beats.push(Date.now()); } catch { /* a binary levels frame */ }
  });
  try {
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (beats.length >= 3) { clearInterval(timer); resolve(); } }, 25); setTimeout(() => { clearInterval(timer); resolve(); }, 3_000); });
    assert.ok(beats.length >= 3, `three heartbeats within three seconds, got ${beats.length}`);
    assert.ok(beats[2]! - beats[0]! >= 150, 'they are spaced by the interval, not sent on every loop');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('an open-interest reading the reducer takes is pushed to the pages the moment it lands, and the newest one only', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const pushes: { instrumentId?: unknown; t?: unknown; base?: unknown }[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as { t?: string; items?: { instrumentId?: unknown; t?: unknown; base?: unknown }[] };
      if (message.t === 'oi' && Array.isArray(message.items)) pushes.push(...message.items);
    } catch { /* a binary levels frame */ }
  });
  try {
    // The fixture's rows are marked as seen on the first pass; only readings taken afterwards go out.
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    const t0 = Date.now();
    assert.notEqual(app.applyMessage({ kind: 'openInterest', instrumentId: 'bybit:BTCUSDT', sourceTimestamp: t0, receivedAt: t0, base: 12_345, quality: 'native' }, 'bybit'), false);
    assert.notEqual(app.applyMessage({ kind: 'openInterest', instrumentId: 'okx:BTC-USDT-SWAP', sourceTimestamp: t0 + 1, receivedAt: t0 + 1, base: 678, quality: 'native' }, 'okx'), false);
    const ready = async (): Promise<void> => { for (let i = 0; i < 100 && pushes.length < 2; i++) await new Promise<void>(resolve => setTimeout(resolve, 20)); };
    await ready();
    assert.equal(pushes.length, 2, `two readings, two pushes, got ${pushes.length}`);
    const bybit = pushes.find(p => p.instrumentId === 'bybit:BTCUSDT');
    const okx = pushes.find(p => p.instrumentId === 'okx:BTC-USDT-SWAP');
    assert.equal(bybit?.base, 12_345); assert.equal(bybit?.t, t0);
    assert.equal(okx?.base, 678);
    // The next pass has nothing new: no repeat, however many passes run.
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal(pushes.length, 2, 'a reading is pushed once');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('a socket reading and an older REST one landing in the same pass push the newer only, and never one older than what was sent', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const pushes: { instrumentId?: unknown; t?: unknown; base?: unknown }[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try {
      const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as { t?: string; items?: { instrumentId?: unknown; t?: unknown; base?: unknown }[] };
      if (message.t === 'oi' && Array.isArray(message.items)) pushes.push(...message.items);
    } catch { /* a binary levels frame */ }
  });
  const reading = (t: number, base: number) => ({ kind: 'openInterest' as const, instrumentId: 'bybit:BTCUSDT', sourceTimestamp: t, receivedAt: t, base, quality: 'native' as const });
  const wait = async (count: number): Promise<void> => { for (let i = 0; i < 100 && pushes.length < count; i++) await new Promise<void>(resolve => setTimeout(resolve, 20)); };
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    const t0 = Date.now();
    app.applyMessage(reading(t0 + 10, 200), 'bybit');
    app.applyMessage(reading(t0, 100), 'bybit');
    await wait(1); await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.deepEqual(pushes.map(p => [p.t, p.base]), [[t0 + 10, 200]], 'the newest of the pass only');
    app.applyMessage(reading(t0 + 5, 150), 'bybit');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal(pushes.length, 1, 'a reading older than one sent is not sent');
    app.applyMessage(reading(t0 + 20, 250), 'bybit');
    await wait(2);
    assert.deepEqual(pushes.map(p => [p.t, p.base]), [[t0 + 10, 200], [t0 + 20, 250]]);
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('the live socket says it answers long/short questions, and answers each by its id; a question it cannot ask says why', async () => {
  // A page asks them on the socket: its HTTP requests waited behind its history requests for one of six connections (2026-10-23).
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const texts: Record<string, unknown>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => { try { texts.push(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>); } catch { /* a binary levels frame */ } });
  const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 150 && !ok(); i++) await new Promise<void>(resolve => setTimeout(resolve, 20)); };
  try {
    await until(() => texts.some(m => m.t === 'hello'));
    assert.deepEqual(texts.find(m => m.t === 'hello'), { t: 'hello', ls: true, lt: true });
    const now = Date.now();
    // A venue that publishes no ratio: answered at once, no venue asked.
    socket.send(JSON.stringify({ t: 'ls', id: 7, inst: 'hyperliquid:BTC-PERP', metric: 'accounts', tf: '1h', from: now - 86_400_000, to: now, budget: 1500 }));
    socket.send(JSON.stringify({ t: 'ls', id: 8, inst: 'bybit:BTCUSDT', metric: 'everyone', tf: '1h', from: now - 1, to: now }));
    socket.send(JSON.stringify({ t: 'ls', id: 9, inst: 'bybit:BTCUSDT', metric: 'accounts', tf: '1h', from: now, to: now - 1 }));
    socket.send(JSON.stringify({ t: 'ls', id: 'x', inst: 'bybit:BTCUSDT', metric: 'accounts', tf: '1h', from: 1, to: 2 }));
    await until(() => texts.filter(m => m.t === 'ls').length >= 3);
    const answers = new Map(texts.filter(m => m.t === 'ls').map(m => [m.id, m]));
    assert.deepEqual((answers.get(7)!.series as { status: string; points: unknown[] }).status, 'unsupported');
    assert.match(String(answers.get(8)!.error), /metric must be one of/);
    assert.match(String(answers.get(9)!.error), /from and to/);
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal(answers.has('x'), false, 'a question with no id of its own is not answered');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('the live socket answers a tracker question in frames of a day, the newest first, the last marked done, and says why it refuses one it cannot answer', async () => {
  // The Liquidity Tracker lane: the tracker alone over the socket, where the page's HTTP requests wait behind its history ones (2026-10-24).
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const HOUR = 3_600_000, DAY = 24 * HOUR, MIN = 60_000;
  const end = Math.floor((Date.now() - HOUR) / HOUR) * HOUR, start = end - 50 * HOUR;
  // Fifty hours of minutes, each tracker a number that depends on its minute: an hour's mean is then known.
  const columns = [];
  for (let t = start; t < end; t += MIN) columns.push({ t, n: 4, bins: Int32Array.of(1), bid: Float32Array.of(1), ask: Float32Array.of(1), lt: new Float32Array(LT_LENGTH).fill(1000 + ((t / MIN) % 60)), ltN: 4 });
  v2.recorder.columns.set('seed:BTC', columns); v2.recorder.steps.set('seed:BTC', 20);
  const texts: Record<string, unknown>[] = [], frames: LtFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    // Text frames are JSON; the binary ones (the levels, the tracker's parts) are not.
    try { texts.push(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>); return; } catch { /* a binary frame */ }
    if (!Buffer.isBuffer(data)) return;
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (frameType(buffer) === 'lt') frames.push(decodeLt(buffer));
  });
  const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !ok(); i++) await new Promise<void>(resolve => setTimeout(resolve, 20)); };
  try {
    await until(() => texts.some(m => m.t === 'hello'));
    socket.send(JSON.stringify({ t: 'lt', id: 5, inst: ['seed:BTC', 'missing:X'], from: start, to: end, stepMs: HOUR, half: 2 }));
    await until(() => frames.some(f => f.done));
    assert.ok(frames.length >= 3, `fifty hours is at least three days' parts, got ${frames.length}`);
    assert.deepEqual(frames.map(f => f.done), frames.map((_, i) => i === frames.length - 1), 'the last, and only the last, is done');
    assert.equal(frames[0]!.to, end, 'the newest part first');
    for (let i = 1; i < frames.length; i++) assert.equal(frames[i]!.to, frames[i - 1]!.from, 'each part ends where the one before it began');
    assert.equal(frames.at(-1)!.from, start);
    assert.ok(frames.every(f => f.id === 5 && f.stepMs === HOUR && f.half === 2));
    const seed = frames.flatMap(f => f.instruments.filter(i => i.id === 'seed:BTC').map(i => i));
    assert.equal(seed.reduce((sum, i) => sum + i.times.length, 0), 50, 'fifty hours, a window each');
    for (const i of seed) for (const v of i.values) assert.equal(v, 1029.5, 'an hour of minutes 1000..1059: their mean');
    assert.ok(frames.every(f => f.instruments.find(i => i.id === 'missing:X')!.times.length === 0), 'a market it never recorded has no windows');
    // What it cannot answer is said, by the question's id.
    const bad = (extra: Record<string, unknown>) => socket.send(JSON.stringify({ t: 'lt', id: 9, inst: ['seed:BTC'], from: start, to: end, stepMs: HOUR, half: 2, ...extra }));
    bad({ half: 8 }); bad({ inst: [] }); bad({ from: end, to: start }); bad({ stepMs: 'x' });
    socket.send(JSON.stringify({ t: 'lt', id: 'x', inst: ['seed:BTC'], from: start, to: end, stepMs: HOUR, half: 2 }));
    await until(() => texts.filter(m => m.t === 'lt').length >= 4);
    const errors = texts.filter(m => m.t === 'lt');
    assert.equal(errors.length, 4, 'four refused, and the one with no id of its own is not answered');
    assert.ok(errors.every(m => m.id === 9 && typeof m.error === 'string'));
    assert.match(String(errors[0]!.error), /half-lives/);
    assert.equal(frames.length, frames.filter(f => f.id === 5).length, 'a refused question sends no frame');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('a socket runs four tracker questions at once: the fifth, a reused id and a question over a given-up one are told apart, and a cancel frees its slot at once', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const HOUR = 3_600_000, MIN = 60_000;
  const end = Math.floor((Date.now() - HOUR) / HOUR) * HOUR, start = end - 50 * HOUR;
  // Sixty-four markets of fifty hours: a question takes sixty-four turns of the loop for each of its days, long enough to still run when the next arrives.
  const columns = [];
  for (let t = start; t < end; t += MIN) columns.push({ t, n: 4, bins: Int32Array.of(1), bid: Float32Array.of(1), ask: Float32Array.of(1), lt: new Float32Array(LT_LENGTH).fill(1000), ltN: 4 });
  const ids = Array.from({ length: 64 }, (_, i) => `seed${i}:BTC`);
  for (const id of ids) { v2.recorder.columns.set(id, columns); v2.recorder.steps.set(id, 20); }
  // A market costs two milliseconds more, so a question runs for several turns of the loop (it lets go after sixty): still running when the next arrives, and when it is cancelled.
  const queryLt = v2.recorder.queryLt.bind(v2.recorder);
  v2.recorder.queryLt = (...args: Parameters<typeof queryLt>) => { const t = performance.now(); while (performance.now() - t < 2) { /* a slower store */ } return queryLt(...args); };
  const texts: Record<string, unknown>[] = [], frames: LtFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try { texts.push(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>); return; } catch { /* a binary frame */ }
    if (!Buffer.isBuffer(data)) return;
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (frameType(buffer) === 'lt') frames.push(decodeLt(buffer));
  });
  const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 300 && !ok(); i++) await new Promise<void>(resolve => setTimeout(resolve, 20)); };
  const ask = (id: number) => socket.send(JSON.stringify({ t: 'lt', id, inst: ids, from: start, to: end, stepMs: HOUR, half: 2 }));
  try {
    await until(() => texts.some(m => m.t === 'hello'));
    for (const id of [1, 2, 3, 4, 5]) ask(id);
    ask(2);
    await until(() => texts.filter(m => m.t === 'lt').length >= 2);
    const refused = new Map(texts.filter(m => m.t === 'lt').map(m => [m.id, String(m.error)]));
    assert.match(refused.get(5) ?? '', /too many tracker questions/, 'the fifth at once');
    assert.match(refused.get(2) ?? '', /question id in use/, 'an id still running is not taken again');
    // A cancel frees its slot at once: a new question is accepted before the cancelled one has stopped.
    socket.send(JSON.stringify({ t: 'lt', id: 1, cancel: true })); ask(6);
    await until(() => frames.some(f => f.id === 6));
    assert.ok(frames.some(f => f.id === 6), 'the sixth is answered');
    assert.equal(texts.filter(m => m.t === 'lt' && m.id === 6).length, 0, 'and not refused');
    // The cancelled question stops (it may have sent a frame before the cancel reached it, never a last one).
    await until(() => frames.some(f => f.id === 3 && f.done));
    assert.equal(frames.some(f => f.id === 1 && f.done), false, 'a cancelled question is not finished');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});
