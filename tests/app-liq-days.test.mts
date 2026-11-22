import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidationDays } from '../src/app/liq-days.ts';
import { DAY_MS } from '../src/app/panes/bar-stats.ts';
import { LIQUIDATIONS_PER_ANSWER, type Liquidation } from '../src/shared/liquidations.ts';

// The liquidations by UTC day, one loader for the Bar stats and the Flow history (liq-days.ts): a day is asked once however many panes
// need it, kept while any of them still does, and a pane that stops asking lets its days go after two minutes.

const D0 = Date.UTC(2026, 10, 20);
/** A fake source whose answers wait until `answer` is called, with the days it was asked for. */
function source() {
  const asked: number[] = [], waiting: { from: number; resolve: (rows: Liquidation[]) => void; reject: (e: Error) => void }[] = [];
  return {
    asked, waiting,
    hub: { source: { liquidations: (from: number, _to: number) => new Promise<Liquidation[]>((resolve, reject) => { asked.push(from); waiting.push({ from, resolve, reject }); }) } } as never,
    /** Answer every question waiting, `rows` liquidations each (a full day of the cap when `rows` reaches it). */
    async answer(rows = 3): Promise<void> {
      for (const w of waiting.splice(0)) w.resolve(Array.from({ length: rows }, () => ({ id: 'x', t: w.from, side: 'long', usd: 100 }) as unknown as Liquidation));
      await new Promise(r => setTimeout(r, 0));
    },
  };
}
const withClock = async (t: number, fn: () => Promise<void> | void): Promise<void> => { const real = Date.now; Date.now = () => t; try { await fn(); } finally { Date.now = real; } };

test('two panes needing different stretches share the days, two questions at a time, the newest first', async () => {
  const s = source(), days = new LiquidationDays(s.hub);
  let heard = 0; days.listen(() => heard++);
  await withClock(D0 + 12 * 3_600_000, async () => {
    days.ensure('bars', 'a,b', D0, D0 + DAY_MS);
    days.ensure('sizes', 'a,b', D0 - 3 * DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS], 'today once (both want it), then the day before; two at a time');
    await s.answer();
    days.ensure('sizes', 'a,b', D0 - 3 * DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked.slice(2), [D0 - 2 * DAY_MS, D0 - 3 * DAY_MS]);
    await s.answer();
    // The Bar stats ask for their narrow stretch again: the Flow history's older days are not let go.
    days.ensure('bars', 'a,b', D0, D0 + DAY_MS);
    assert.deepEqual([...days.days.keys()].sort((a, b) => a - b), [D0 - 3 * DAY_MS, D0 - 2 * DAY_MS, D0 - DAY_MS, D0]);
  });
  assert.equal(heard, 4, 'every answer tells the panes');
  assert.ok(days.version >= 4);
});

test('a pane that stops asking lets its days go after two minutes; a day answered to its end is not asked again', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + DAY_MS + 3_600_000;
  await withClock(now, async () => { days.ensure('sizes', 'a', D0 - 2 * DAY_MS, D0 + DAY_MS); await s.answer(); days.ensure('sizes', 'a', D0 - 2 * DAY_MS, D0 + DAY_MS); await s.answer(); });
  assert.equal(days.days.size, 3);
  await withClock(now + 60_000, () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); });
  assert.ok(days.days.has(D0 - 2 * DAY_MS), 'a minute later the Flow history still holds its days');
  const before = s.asked.length;
  await withClock(now + 3 * 60_000, () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); });
  assert.equal(days.days.has(D0 - 2 * DAY_MS), false, 'three minutes later they are let go');
  assert.ok(s.asked.slice(before).every(day => day >= D0 + DAY_MS), 'and nothing older is asked for the Bar stats');
});

test('other markets start again: the days held are dropped and an answer still out for the old ones is not taken', async () => {
  const s = source(), days = new LiquidationDays(s.hub);
  await withClock(D0 + 3_600_000, async () => {
    days.ensure('bars', 'a', D0, D0 + DAY_MS);
    const v = days.version;
    days.ensure('bars', 'b', D0, D0 + DAY_MS);
    assert.ok(days.version > v); assert.equal(days.ids, 'b');
    await s.answer();
    assert.equal(days.days.size, 0, 'the answer for "a" is dropped');
    days.ensure('bars', 'b', D0, D0 + DAY_MS);
    await s.answer(LIQUIDATIONS_PER_ANSWER);
    assert.equal(days.days.get(D0)?.cut, true, 'a day of 5,000 is said to be cut');
  });
});

// The Flow history's warm-up (2026-11-22, size-history/warm.ts): the days held before any pane asks, one question at a time, the newest
// first, nothing on the clock; the first pane to show them asks only for what changed since (the day under way).
test('the warm-up holds the days before any pane asks: one at a time, the newest first, and the day under way not asked again', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + 12 * 3_600_000, from = D0 - 2 * DAY_MS, to = D0 + 6 * 3_600_000;
  await withClock(now, async () => {
    assert.equal(days.warm('a', from, to), 'asked');
    assert.deepEqual(s.asked, [D0], 'today first, alone');
    assert.equal(days.warm('a', from, to), 'waiting');
    assert.deepEqual(s.asked, [D0], 'nothing more while it is out');
    await s.answer();
    days.warm('a', from, to);
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS]);
    await s.answer();
    days.warm('a', from, to);
    await s.answer();
    assert.equal(days.warm('a', from, to), 'done', 'every day of the stretch held');
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS, D0 - 2 * DAY_MS]);
  });
  await withClock(now + 10 * 60_000, async () => {
    assert.equal(days.warm('a', from, to), 'done');
    assert.equal(s.asked.length, 3, 'ten minutes on, the warm-up has not asked the day under way again');
    // The Flow history opens on the same stretch: it draws the days held and asks for the day under way alone.
    days.ensure('sizes', 'a', from, to);
    assert.deepEqual(s.asked.slice(3), [D0], 'only the day under way, half a minute old and more');
  });
});

test('the warm-up\x27s days outlive a pane\x27s two minutes, and go once its half hour is past and no pane needs them', async () => {
  // Days the warm-up alone holds (more than a day from the Bar stats' stretch, whose neighbours are kept with it).
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + DAY_MS + 3_600_000, from = D0 - 3 * DAY_MS, to = D0 - DAY_MS;
  await withClock(now, async () => {
    for (let i = 0; i < 3; i++) { days.warm('a', from, to); await s.answer(); }
    assert.equal(days.warm('a', from, to), 'done');
    assert.deepEqual(s.asked, [D0 - 2 * DAY_MS, D0 - 3 * DAY_MS]);
  });
  // The Bar stats ask for today alone, three minutes later: the warm-up's days stay.
  await withClock(now + 3 * 60_000, async () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); await s.answer(); });
  assert.ok(days.days.has(D0 - 3 * DAY_MS) && days.days.has(D0 - 2 * DAY_MS), 'past a pane\x27s two minutes, the warm-up still holds its days');
  await withClock(now + 31 * 60_000, () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); });
  assert.equal(days.days.has(D0 - 3 * DAY_MS) || days.days.has(D0 - 2 * DAY_MS), false, 'past its half hour they go');
});

test('a pane that opens while a warm day is out takes it rather than asking it twice, and other markets drop the warm-up\x27s days', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + 12 * 3_600_000;
  await withClock(now, async () => {
    days.warm('a', D0 - DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked, [D0]);
    days.ensure('sizes', 'a', D0 - DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS], 'the pane asks the day the warm-up has not, not the one out');
    await s.answer();
    assert.deepEqual([...days.days.keys()].sort((x, y) => x - y), [D0 - DAY_MS, D0]);
    days.warm('b', D0 - DAY_MS, D0 + DAY_MS);
    assert.equal(days.ids, 'b');
    assert.equal(days.days.size, 0, 'other markets: what was held is not theirs');
  });
});

test('the warm-up of a source without liquidations is done at once, and a warm day whose question failed is asked again after its pause', async () => {
  const none = new LiquidationDays({ source: {} } as never);
  await withClock(D0, () => { assert.equal(none.warm('a', D0 - DAY_MS, D0 + DAY_MS), 'done'); });
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + 12 * 3_600_000, from = D0 - DAY_MS, to = D0 + 6 * 3_600_000;
  await withClock(now, async () => {
    days.warm('a', from, to);
    s.waiting.splice(0).forEach(w => w.reject(new Error('down')));
    await new Promise(r => setTimeout(r, 0));
    days.warm('a', from, to);
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS], 'today failed: the day before meanwhile');
    await s.answer();
    assert.equal(days.warm('a', from, to), 'waiting', 'today is still missing, in its pause: nothing to send');
    assert.equal(s.asked.length, 2, 'and not asked again before its pause');
  });
  await withClock(now + 16_000, async () => {
    assert.equal(days.warm('a', from, to), 'asked');
    assert.deepEqual(s.asked.slice(2), [D0], 'after its pause today is asked again');
    await s.answer();
    assert.equal(days.warm('a', from, to), 'done');
  });
});

test('the days count their answers and failures, the markets asked only: an answer for the old ones is dropped uncounted', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + 12 * 3_600_000;
  assert.deepEqual(days.tally, { answers: 0, failures: 0 });
  await withClock(now, async () => {
    days.warm('a', D0 - DAY_MS, D0 + 6 * 3_600_000);
    s.waiting.splice(0).forEach(w => w.reject(new Error('down')));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(days.tally, { answers: 0, failures: 1 }, 'today failed');
    days.warm('a', D0 - DAY_MS, D0 + 6 * 3_600_000);
    await s.answer();
    assert.deepEqual(days.tally, { answers: 1, failures: 1 }, 'the day before answered');
    days.ensure('bars', 'a', D0 - 3 * DAY_MS, D0 - 2 * DAY_MS);
    assert.equal(s.waiting.length, 1);
    days.ensure('bars', 'b', D0 - 3 * DAY_MS, D0 - 2 * DAY_MS);
    await s.answer();
    assert.deepEqual(days.tally, { answers: 1, failures: 1 }, 'the old markets\x27 answer is not counted');
    days.ensure('bars', 'b', D0 - 3 * DAY_MS, D0 - 2 * DAY_MS);
    s.waiting.splice(0).forEach(w => w.reject(new Error('down')));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(days.tally, { answers: 1, failures: 2 });
    days.ensure('bars', 'b', D0 - 5 * DAY_MS, D0 - 4 * DAY_MS);
    days.ensure('bars', 'c', D0 - 5 * DAY_MS, D0 - 4 * DAY_MS);
    s.waiting.splice(0).forEach(w => w.reject(new Error('down')));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(days.tally, { answers: 1, failures: 2 }, 'nor a failure for the old ones');
  });
});

test('a warm-up of another stretch lets the last one\x27s days go, but not those a pane still needs', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + 12 * 3_600_000, from = D0 - 8 * DAY_MS, to = D0 - 3 * DAY_MS;
  await withClock(now, async () => {
    for (let i = 0; i < 5; i++) { days.warm('a', from, to); await s.answer(); }
    assert.equal(days.warm('a', from, to), 'done', 'five days held, one at a time');
    // The Bar stats need the newest of them; the warm-up then moves to another stretch (another timeframe).
    days.ensure('bars', 'a', D0 - 4 * DAY_MS, D0 - 3 * DAY_MS);
    days.warm('a', D0 - DAY_MS, D0 + 6 * 3_600_000);
    assert.equal(days.days.has(D0 - 8 * DAY_MS) || days.days.has(D0 - 7 * DAY_MS), false, 'the last warm-up\x27s days no pane needs go');
    assert.ok(days.days.has(D0 - 4 * DAY_MS), 'the one the Bar stats need stays');
  });
});
