import test from 'node:test';
import assert from 'node:assert/strict';
import { Delivery, LIMITS, type Outgoing, type Sender } from '../src/app/notify/delivery.ts';
import type { Outcome } from '../src/app/notify/channels.ts';

/** A clock that moves only when told, timers that fire as it passes them, and senders that answer at once or as told. */
function rig() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const d = new Delivery(() => now, (fn, ms) => { timers.push({ at: now + ms, fn }); });
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); now = next.at; next.fn(); await Promise.resolve(); await Promise.resolve();
    }
    now = end; await Promise.resolve(); await Promise.resolve();
  };
  return { d, advance, get now() { return now; } };
}
const msg = (i: number, at: number): Outgoing => ({ title: 'BTC alert', body: `alert ${i}`, url: '', key: `k${i}`, at });
function sender(answers: Outcome[] = []): Sender & { sent: string[] } {
  const sent: string[] = [];
  return { id: 'telegram', sent, send: m => { sent.push(m.body); return Promise.resolve(answers.shift() ?? { ok: true }); } };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('a lane sends a burst at once, then one every few seconds, and no more than its hour allows', async () => {
  const r = rig(), s = sender();
  for (let i = 0; i < LIMITS.burst + 2; i++) r.d.push(msg(i, r.now), [s]);
  await settle();
  assert.equal(s.sent.length, LIMITS.burst, 'the burst goes at once');
  await r.advance(LIMITS.everyMs);
  assert.equal(s.sent.length, LIMITS.burst + 1, 'then one a step');
  await r.advance(LIMITS.everyMs);
  assert.equal(s.sent.length, LIMITS.burst + 2);
  assert.deepEqual(r.d.log.map(e => e.outcome).filter(o => o !== 'sent'), []);
});

test('the hour\'s limit drops what waits beyond it, and a full queue lets its oldest go: both said in the log', async () => {
  const r = rig(), s = sender();
  for (let i = 0; i < LIMITS.perHour + 3; i++) { r.d.push(msg(i, r.now), [s]); await settle(); await r.advance(LIMITS.everyMs); }
  assert.equal(s.sent.length, LIMITS.perHour - LIMITS.bellReserve, 'never more than the hour allows panel alerts (the rest is kept for bells)');
  assert.ok(r.d.log.some(e => e.outcome === 'limited'));
  const q = rig(), slow: Sender = { id: 'ntfy', send: () => new Promise<Outcome>(() => {}) };
  for (let i = 0; i < LIMITS.queue + 3; i++) q.d.push(msg(i, q.now), [slow]);
  assert.equal(q.d.waiting('ntfy'), LIMITS.queue, 'one in flight, the queue full');
  assert.equal(q.d.log.filter(e => e.outcome === 'limited').length, 2, 'the oldest waiting went');
});

test('a failure that passes is tried once more after a wait; a wrong token is not; a message too old is dropped', async () => {
  const r = rig(), s = sender([{ ok: false, problem: 'network' }, { ok: true }]);
  r.d.push(msg(1, r.now), [s]); await settle();
  assert.equal(s.sent.length, 1);
  await r.advance(LIMITS.retryMs);
  assert.deepEqual(s.sent, ['alert 1', 'alert 1'], 'sent again after the wait');
  assert.deepEqual(r.d.log.map(e => e.outcome), ['sent']);
  const w = rig(), busy = sender([{ ok: false, problem: 'busy', retryAfterMs: 30_000 }]);
  w.d.push(msg(2, w.now), [busy]); await settle();
  await w.advance(29_000); assert.equal(busy.sent.length, 1, 'the service said when to come back');
  await w.advance(1_000); assert.equal(busy.sent.length, 2);
  const t = rig(), bad = sender([{ ok: false, problem: 'token' }]);
  t.d.push(msg(3, t.now), [bad]); await settle(); await t.advance(LIMITS.retryMs * 2);
  assert.equal(bad.sent.length, 1, 'a wrong token stays wrong');
  assert.deepEqual(t.d.log.map(e => [e.outcome, e.problem]), [['failed', 'token']]);
  const o = rig(), late = sender();
  o.d.push(msg(4, o.now - LIMITS.staleMs - 1), [late]); await settle();
  assert.deepEqual([late.sent.length, o.d.log[0]!.outcome], [0, 'late'], 'a price alert that late would say what is no longer so');
});

test('each push says whether any channel sent it: yes at the first send, no once every channel finished without one', async () => {
  const r = rig(), ok = sender(), bad: Sender & { sent: string[] } = { ...sender([{ ok: false, problem: 'token' }]), id: 'ntfy' };
  const both = r.d.push(msg(1, r.now), [ok, bad]);
  assert.deepEqual(both.channels, ['telegram', 'ntfy']);
  assert.equal(await both.done, true, 'one channel sent it');
  const r2 = rig(), failing = sender([{ ok: false, problem: 'token' }]);
  assert.equal(await r2.d.push(msg(2, r2.now), [failing]).done, false, 'every channel failed');
  const r3 = rig();
  assert.equal(await r3.d.push(msg(3, r3.now), []).done, false, 'no channel at all');
});

test('bells come first: a full queue lets go of a panel alert before a bell, and the hour keeps room for bells alone', async () => {
  const q = rig(), slow: Sender = { id: 'ntfy', send: () => new Promise<Outcome>(() => {}) };
  const bell = (i: number): Outgoing => ({ ...msg(i, q.now), sticky: true });
  q.d.push(msg(0, q.now), [slow]);                                       // in flight
  const first = q.d.push(bell(1), [slow]);
  for (let i = 2; i <= LIMITS.queue; i++) q.d.push(msg(i, q.now), [slow]);
  q.d.push(msg(99, q.now), [slow]);                                      // the queue is full: one must go
  assert.equal(q.d.log.at(-1)!.title, 'alert 2', 'the oldest panel alert went, not the bell before it');
  let settled = false; void first.done.then(() => { settled = true; }); await settle();
  assert.equal(settled, false, 'the bell still waits');
  const h = rig(), s = sender();
  for (let i = 0; i < LIMITS.perHour - LIMITS.bellReserve; i++) { h.d.push(msg(i, h.now), [s]); await settle(); await h.advance(LIMITS.everyMs); }
  const panel = h.d.push(msg(500, h.now), [s]); await settle();
  assert.equal(await panel.done, false, 'past what panels may use in an hour, a panel alert is not sent');
  const lateBell = h.d.push({ ...msg(501, h.now), sticky: true }, [s]); await settle(); await h.advance(LIMITS.everyMs);
  assert.equal(await lateBell.done, true, 'a bell still goes');
});

test('a channel cleared (its bot or topic taken away) sends nothing more of what waited', async () => {
  const r = rig(), slow: Sender & { sent: string[] } = { id: 'telegram', sent: [], send(m) { this.sent.push(m.body); return new Promise<Outcome>(() => {}); } };
  r.d.push(msg(1, r.now), [slow]);
  const waiting = r.d.push(msg(2, r.now), [slow]);
  r.d.clear('telegram');
  assert.equal(await waiting.done, false);
  assert.equal(r.d.waiting('telegram'), 0);
  assert.deepEqual(slow.sent, ['alert 1'], 'the one already on its way was the only one sent');
  const t = rig(), thrower: Sender = { id: 'discord', send: () => { throw new Error('boom'); } };
  const thrown = t.d.push(msg(3, t.now), [thrower]).done;
  await settle(); await t.advance(LIMITS.retryMs);
  assert.equal(await thrown, false, 'a sender that throws fails its message (after its one more try) instead of stopping the lane');
});

test('a lane cleared while a send is on its way never tries that message again; bells alone waiting turn a panel alert away', async () => {
  let fail: (o: Outcome) => void = () => {};
  const r = rig(), flaky: Sender = { id: 'telegram', send: () => new Promise<Outcome>(res => { fail = res; }) };
  const first = r.d.push(msg(1, r.now), [flaky]);
  r.d.clear('telegram');
  fail({ ok: false, problem: 'network' }); await settle();
  assert.equal(await first.done, false, 'ended, not queued again for a bot that was taken away');
  assert.equal(r.d.waiting('telegram'), 0);
  const q = rig(), slow: Sender = { id: 'ntfy', send: () => new Promise<Outcome>(() => {}) };
  q.d.push({ ...msg(0, q.now), sticky: true }, [slow]);
  for (let i = 1; i <= LIMITS.queue; i++) q.d.push({ ...msg(i, q.now), sticky: true }, [slow]);
  const panel = q.d.push(msg(99, q.now), [slow]);
  assert.equal(await panel.done, false, 'the panel alert is the one turned away');
  assert.equal(q.d.waiting('ntfy'), LIMITS.queue, 'every bell still waits');
});

test('a panel alert turned away by a queue of bells is not counted as taken', () => {
  const q = rig(), slow: Sender = { id: 'ntfy', send: () => new Promise<Outcome>(() => {}) };
  q.d.push({ ...msg(0, q.now), sticky: true }, [slow]);
  for (let i = 1; i <= LIMITS.queue; i++) q.d.push({ ...msg(i, q.now), sticky: true }, [slow]);
  assert.deepEqual(q.d.push(msg(99, q.now), [slow]).channels, [], 'no channel took it');
});
