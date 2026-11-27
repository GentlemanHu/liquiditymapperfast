import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/app/notify/transport.ts';

/** A worker that says it is ready only when told, and records what it was handed. */
class FakeWorker {
  static last: FakeWorker | null = null;
  posted: { id: number }[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWorker.last = this; }
  postMessage(message: { id: number }): void { this.posted.push(message); }
  terminate(): void {}
  ready(): void { this.onmessage?.({ data: { ready: true } }); }
  answer(id: number, status: number): void { this.onmessage?.({ data: { id, answer: { status, text: '' } } }); }
}

test('a request waits for the worker to say it is ready, and its time is counted only from then', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const saved = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  try {
    const t = new Transport();
    const asked = t.request({ url: 'https://ntfy.sh/', method: 'POST', body: '{}' });
    const w = FakeWorker.last!;
    mock.timers.tick(45_000);
    assert.equal(w.posted.length, 0, 'not handed over before the worker is ready, however long its script takes');
    w.ready();
    assert.equal(w.posted.length, 1, 'handed over once it is ready');
    mock.timers.tick(5_000);
    w.answer(w.posted[0]!.id, 200);
    assert.deepEqual(await asked, { status: 200, text: '' }, 'answered: 50 s after the request, but 5 s after the worker had it');
    const late = t.request({ url: 'https://ntfy.sh/', method: 'POST', body: '{}' });
    mock.timers.tick(20_000);
    assert.equal((await late).error, 'timeout', 'a ready worker that never answers is given up after its time');
    const t2 = new Transport();
    const never = t2.request({ url: 'https://ntfy.sh/', method: 'POST', body: '{}' });
    const first = FakeWorker.last!;
    mock.timers.tick(60_000);
    assert.equal((await never).error, 'network', 'a worker that never starts fails what waits');
    const next = t2.request({ url: 'https://ntfy.sh/', method: 'POST', body: '{}' });
    const second = FakeWorker.last!;
    assert.notEqual(second, first, 'the next request starts a new worker');
    first.onerror?.();
    second.ready(); second.answer(second.posted[0]!.id, 200);
    assert.deepEqual(await next, { status: 200, text: '' }, 'a late error of the worker replaced does not fail the new one\'s request');
  } finally {
    (globalThis as { Worker?: unknown }).Worker = saved;
    mock.timers.reset();
  }
});
