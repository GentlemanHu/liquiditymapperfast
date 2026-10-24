import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

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
    assert.deepEqual(texts.find(m => m.t === 'hello'), { t: 'hello', ls: true });
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
